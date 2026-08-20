import type { RequestMethod } from './protocol';

/**
 * Main ↔ Renderer 的逐方法运行时合同。
 *
 * 为什么需要它：TypeScript 的 `RequestMap` 在编译期就被擦掉了，运行时 Main 只看到
 * 一个 `unknown`。此前的校验只有三道 —— 协议版本、方法白名单、总字节数 —— 于是
 * 一个方法名正确但 payload 是 `null`、数组、错类型或超深嵌套的请求，会被原样转交给
 * Core，由 Core 用 `String(payload.x)` 之类的强转去"猜"调用者的意思。
 *
 * 这张表把「允许哪些方法」「每个方法收哪些字段」「等多久算超时」合并成**一个**事实源。
 * 之前 `ALLOWED_METHODS` 是手工维护的独立 Set，加方法时很容易只改一处。
 *
 * 校验是 fail-closed 且**拒绝未知字段**的：多出来的键一律拒绝，而不是忽略。
 * 忽略未知字段等于允许调用方悄悄试探 Core 的内部参数。
 *
 * 为什么不用仓库里已有的 zod：分两层是有意的。`inspectPayloadShape` 必须先用**显式栈**
 * 走完结构，才能在不递归的前提下挡住超深嵌套与循环引用；任何基于递归下降的校验器
 * （包括 zod）在拿到一个两万层深的 payload 时，会先把自己的调用栈打爆。
 * 结构过关之后字段校验才开始，那部分逻辑简单到不值得为它把一个依赖引进 `shared/`。
 */

export type FieldSpec =
  | { readonly kind: 'string'; readonly optional?: boolean; readonly maxLength?: number; readonly allowEmpty?: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly optional?: boolean }
  | {
      readonly kind: 'integer';
      readonly optional?: boolean;
      readonly nullable?: boolean;
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: 'stringArray';
      readonly optional?: boolean;
      readonly maxItems?: number;
      readonly maxLength?: number;
      readonly allowEmpty?: boolean;
    }
  /** 结构受限的对象数组；只用于 task.create 的自定义命令。 */
  | {
      readonly kind: 'objectArray';
      readonly optional?: boolean;
      readonly maxItems: number;
      readonly fields: Readonly<Record<string, FieldSpec>>;
    };

export interface MethodContract {
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /**
   * Main 等 Core 回应的上限。Core 活着但某个请求永不回应时，调用方必须拿到明确失败，
   * 而不是一个永远 pending 的 Promise —— 后者在 UI 上表现为"点了没反应"，
   * 与"正在处理"无法区分。
   */
  readonly timeoutMs: number;
  /** 由 Main 自己应答，不转发 Core（原生能力或进程监督事实）。 */
  readonly handledByMain?: boolean;
  /** 免除 epoch 校验：这些方法本身就是用来（重新）获取 epoch 的。 */
  readonly epochExempt?: boolean;
}

const NONE = {} as const;

/** 常规只读查询：Core 单写者下这些都是内存读或小文件读。 */
const QUICK = 10_000;
/** 涉及真实文件系统遍历、git、子进程或网络的调用。 */
const SLOW = 120_000;

const ID: FieldSpec = { kind: 'string', maxLength: 200 };
const OPTIONAL_ID: FieldSpec = { kind: 'string', maxLength: 200, optional: true };
const DIGEST: FieldSpec = { kind: 'string', maxLength: 200 };
/** 说明性文本；允许为空，但不允许无界。 */
const NOTE: FieldSpec = { kind: 'string', maxLength: 4_000, allowEmpty: true };

export const IPC_CONTRACT: Readonly<Record<RequestMethod, MethodContract>> = {
  'core.getStatus': { fields: NONE, timeoutMs: QUICK, handledByMain: true, epochExempt: true },
  'doctor.run': { fields: NONE, timeoutMs: SLOW },

  'project.pick': { fields: NONE, timeoutMs: SLOW, handledByMain: true },
  'project.list': { fields: NONE, timeoutMs: QUICK },
  'project.import': {
    fields: { projectId: ID, subPath: { kind: 'string', maxLength: 1_000, optional: true, allowEmpty: true } },
    timeoutMs: SLOW,
  },

  'model.listProfiles': { fields: NONE, timeoutMs: QUICK, handledByMain: true },
  'model.testProfile': { fields: { profileId: ID }, timeoutMs: SLOW },
  'model.setKey': {
    // apiKey 允许为空字符串 —— 那是"删除凭据"的语义，不是缺参数。
    fields: { profileId: ID, apiKey: { kind: 'string', maxLength: 8_000, allowEmpty: true } },
    timeoutMs: QUICK,
    handledByMain: true,
  },
  'model.updateProfile': {
    fields: {
      profileId: ID,
      modelId: { kind: 'string', maxLength: 300, optional: true, allowEmpty: true },
      baseUrlOverride: { kind: 'string', maxLength: 2_000, optional: true, allowEmpty: true },
    },
    timeoutMs: QUICK,
  },
  'model.addProvider': {
    fields: {
      id: ID,
      name: { kind: 'string', maxLength: 300 },
      api: { kind: 'string', maxLength: 2_000 },
      wire: { kind: 'enum', values: ['anthropic', 'openai'], optional: true },
      models: { kind: 'stringArray', optional: true, maxItems: 200, maxLength: 300 },
      doc: { kind: 'string', maxLength: 2_000, optional: true, allowEmpty: true },
    },
    timeoutMs: QUICK,
  },
  'model.removeProvider': { fields: { providerId: ID }, timeoutMs: QUICK },

  'task.create': {
    fields: {
      projectId: ID,
      snapshotId: ID,
      profileId: ID,
      modelProfileId: ID,
      goal: { kind: 'string', maxLength: 20_000 },
      // TaskClass 是自由文本元数据（不设门禁、不进提示词），所以只限长度。
      taskClass: { kind: 'string', maxLength: 200, allowEmpty: true },
      allowedPaths: { kind: 'stringArray', maxItems: 500, maxLength: 1_000, allowEmpty: true },
      acceptance: { kind: 'stringArray', maxItems: 200, maxLength: 4_000, allowEmpty: true },
      verificationCommandIds: { kind: 'stringArray', maxItems: 50, maxLength: 200, allowEmpty: true },
      customCommands: {
        kind: 'objectArray',
        optional: true,
        maxItems: 20,
        fields: {
          label: { kind: 'string', maxLength: 300 },
          argv: { kind: 'stringArray', maxItems: 100, maxLength: 1_000 },
        },
      },
      reviewerModelProfileId: OPTIONAL_ID,
      reviewerConnectorId: OPTIONAL_ID,
      authorConnectorId: OPTIONAL_ID,
      // 合同层可选、Core 必填：缺了由 Core 以 CONSENT_REQUIRED 拒绝（带可读的修复建议），不在 IPC 层吞成"字段缺失"
      egressConsentDigest: { kind: 'string', optional: true, maxLength: 200 },
      // 批准 id 与命令一一对应，所以上限跟着 customCommands 的 maxItems 走
      commandApprovalIds: { kind: 'stringArray', optional: true, maxItems: 20, maxLength: 200 },
    },
    timeoutMs: SLOW,
  },
  'command.classify': {
    fields: { argv: { kind: 'stringArray', maxItems: 100, maxLength: 1_000 } },
    timeoutMs: QUICK,
  },
  'command.requestApproval': {
    fields: { argv: { kind: 'stringArray', maxItems: 100, maxLength: 1_000 } },
    timeoutMs: QUICK,
  },
  'egress.disclosure': {
    fields: {
      snapshotId: ID,
      modelProfileId: ID,
      reviewerModelProfileId: OPTIONAL_ID,
      reviewerConnectorId: OPTIONAL_ID,
      authorConnectorId: OPTIONAL_ID,
    },
    timeoutMs: QUICK,
  },

  'run.get': { fields: { runId: ID }, timeoutMs: QUICK },
  'run.list': { fields: NONE, timeoutMs: QUICK },
  'run.events': {
    fields: { runId: ID, afterSeq: { kind: 'integer', min: 0 } },
    timeoutMs: QUICK,
  },
  'run.toolCalls': { fields: { runId: ID }, timeoutMs: QUICK },
  'run.cancel': { fields: { runId: ID, reason: NOTE }, timeoutMs: SLOW },

  'plan.get': { fields: { runId: ID }, timeoutMs: QUICK },
  'approval.pending': { fields: { runId: ID }, timeoutMs: QUICK },
  'approval.decide': {
    fields: {
      approvalId: ID,
      decision: { kind: 'enum', values: ['APPROVE', 'REJECT'] },
      subjectDigest: DIGEST,
      note: NOTE,
    },
    timeoutMs: QUICK,
  },

  'patch.get': { fields: { runId: ID }, timeoutMs: QUICK },
  'crossreview.get': { fields: { runId: ID }, timeoutMs: QUICK },
  'crossreview.reviewers': { fields: NONE, timeoutMs: SLOW },
  'crossreview.continue': { fields: { runId: ID }, timeoutMs: SLOW },
  'patch.decide': {
    fields: {
      runId: ID,
      patchId: ID,
      decision: { kind: 'enum', values: ['ACCEPT', 'REJECT', 'REQUEST_CHANGES'] },
      patchDigest: DIGEST,
      note: NOTE,
    },
    timeoutMs: SLOW,
  },

  'verification.list': { fields: { runId: ID }, timeoutMs: QUICK },

  'retention.get': { fields: NONE, timeoutMs: SLOW },
  /*
   * 区间与 Core 的 `clampPolicy` 保持一致（证据 1–365 天、工作区 0–30 天）。
   * 以前合同放行到 3650 天 / 525600 分钟，Core 再默默夹回去 —— 线上接受一个
   * 会被悄悄改小的值，就是在鼓励调用方以为自己设置生效了。宁可在门口拒绝。
   */
  'retention.update': {
    fields: {
      evidenceDays: { kind: 'integer', optional: true, min: 1, max: 365 },
      workspaceGraceMinutes: { kind: 'integer', optional: true, min: 0, max: 43_200 },
    },
    timeoutMs: SLOW,
  },
  'retention.preview': {
    fields: {
      evidenceDays: { kind: 'integer', optional: true, min: 1, max: 365 },
      workspaceGraceMinutes: { kind: 'integer', optional: true, min: 0, max: 43_200 },
    },
    timeoutMs: SLOW,
  },
  'retention.sweepNow': { fields: NONE, timeoutMs: SLOW },

  'files.tree': { fields: { snapshotId: ID, runId: OPTIONAL_ID }, timeoutMs: SLOW },
  'files.read': {
    fields: {
      snapshotId: ID,
      path: { kind: 'string', maxLength: 4_000 },
      runId: OPTIONAL_ID,
      // nullable 而不是 optional：缺失与"明确读快照"是两回事，不能靠 undefined 表达。
      expectedGeneration: { kind: 'integer', nullable: true, min: 0 },
    },
    timeoutMs: SLOW,
  },

  'patch.export': {
    fields: {
      runId: ID,
      patchId: ID,
      mode: { kind: 'enum', values: ['SAVE_FILE', 'COPY', 'APPLY_TO_REPO'] },
      patchDigest: { kind: 'string', maxLength: 200, optional: true },
    },
    timeoutMs: SLOW,
    handledByMain: true,
  },
};

export const ALLOWED_METHODS: ReadonlySet<string> = new Set(Object.keys(IPC_CONTRACT));

export function isRequestMethod(value: unknown): value is RequestMethod {
  return typeof value === 'string' && ALLOWED_METHODS.has(value);
}

export function methodTimeoutMs(method: RequestMethod): number {
  return IPC_CONTRACT[method].timeoutMs;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  readonly ok: false;
  readonly code: 'BAD_REQUEST' | 'POLICY_DENIED';
  readonly message: string;
  readonly detail: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | ValidationFailure;

/** 结构上限。超过任一项都是拒绝，不是截断 —— 截断会让调用方以为自己发出去的东西生效了。 */
export const PAYLOAD_LIMITS = {
  maxBytes: 256 * 1024,
  maxDepth: 8,
  maxNodes: 20_000,
} as const;

function fail(message: string, detail: string): ValidationFailure {
  return { ok: false, code: 'BAD_REQUEST', message, detail };
}

/**
 * 结构体检：深度、节点数、循环引用、不可序列化值。
 *
 * 刻意用显式栈而不是递归：一个一万层深的 payload 会把递归校验器自己的栈打爆，
 * 于是"校验超深嵌套"的代码反倒成了那个崩溃点。
 *
 * 也刻意不先 `JSON.stringify` 再量长度：structured clone 允许循环引用，
 * `JSON.stringify` 遇到循环会直接抛异常，让 ipcMain.handle 变成一个 rejected invoke，
 * Renderer 那边只看到一句无来源的报错。
 */
export function inspectPayloadShape(payload: unknown): ValidationResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('请求体必须是对象', `实际类型：${payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload}`);
  }

  const seen = new Set<object>();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 1 }];
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > PAYLOAD_LIMITS.maxNodes) {
      return fail('请求体节点数超出上限', `上限 ${PAYLOAD_LIMITS.maxNodes} 个节点`);
    }
    if (depth > PAYLOAD_LIMITS.maxDepth) {
      return fail('请求体嵌套过深', `上限 ${PAYLOAD_LIMITS.maxDepth} 层`);
    }

    if (node === null) continue;
    switch (typeof node) {
      case 'string':
        bytes += node.length * 2;
        break;
      case 'number':
      case 'boolean':
        bytes += 8;
        break;
      case 'object': {
        if (seen.has(node as object)) {
          return fail('请求体包含循环引用', '结构化克隆允许环，但受管合同不允许');
        }
        seen.add(node as object);
        const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
        if (!Array.isArray(node)) bytes += Object.keys(node as object).length * 16;
        for (const value of values) stack.push({ node: value, depth: depth + 1 });
        break;
      }
      default:
        // undefined / function / symbol / bigint：受管合同里没有它们的位置。
        return fail('请求体包含不受支持的值类型', `类型：${typeof node}`);
    }
    if (bytes > PAYLOAD_LIMITS.maxBytes) {
      return fail('请求体过大', `上限 ${PAYLOAD_LIMITS.maxBytes} 字节`);
    }
  }

  return { ok: true, payload: payload as Record<string, unknown> };
}

function checkField(path: string, spec: FieldSpec, value: unknown): ValidationFailure | null {
  if (value === undefined) {
    return spec.optional ? null : fail(`缺少必填字段 ${path}`, `期望 ${spec.kind}`);
  }

  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') return fail(`字段 ${path} 类型错误`, `期望 string，收到 ${describe(value)}`);
      if (!spec.allowEmpty && value.trim() === '') return fail(`字段 ${path} 不能为空`, '空字符串不是有效标识');
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return fail(`字段 ${path} 过长`, `上限 ${spec.maxLength} 字符，收到 ${value.length}`);
      }
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return fail(`字段 ${path} 不在允许取值内`, `允许 ${spec.values.join(' / ')}，收到 ${describe(value)}`);
      }
      return null;
    }
    case 'integer': {
      if (value === null) {
        return spec.nullable ? null : fail(`字段 ${path} 不允许为 null`, '期望整数');
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return fail(`字段 ${path} 必须是安全整数`, `收到 ${describe(value)}`);
      }
      if (spec.min !== undefined && value < spec.min) return fail(`字段 ${path} 小于下限`, `下限 ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return fail(`字段 ${path} 大于上限`, `上限 ${spec.max}`);
      return null;
    }
    case 'stringArray': {
      if (!Array.isArray(value)) return fail(`字段 ${path} 类型错误`, `期望数组，收到 ${describe(value)}`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        return fail(`字段 ${path} 元素过多`, `上限 ${spec.maxItems} 个，收到 ${value.length}`);
      }
      for (const [index, item] of value.entries()) {
        const failure = checkField(`${path}[${index}]`, {
          kind: 'string',
          maxLength: spec.maxLength,
          allowEmpty: spec.allowEmpty,
        }, item);
        if (failure) return failure;
      }
      return null;
    }
    case 'objectArray': {
      if (!Array.isArray(value)) return fail(`字段 ${path} 类型错误`, `期望数组，收到 ${describe(value)}`);
      if (value.length > spec.maxItems) {
        return fail(`字段 ${path} 元素过多`, `上限 ${spec.maxItems} 个，收到 ${value.length}`);
      }
      for (const [index, item] of value.entries()) {
        const failure = checkObject(`${path}[${index}]`, spec.fields, item);
        if (failure) return failure;
      }
      return null;
    }
  }
}

function checkObject(
  path: string,
  fields: Readonly<Record<string, FieldSpec>>,
  value: unknown,
): ValidationFailure | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`字段 ${path} 类型错误`, `期望对象，收到 ${describe(value)}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in fields)) {
      return fail(`字段 ${path}.${key} 不在合同内`, '未知字段一律拒绝，不静默忽略');
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    const failure = checkField(`${path}.${key}`, spec, record[key]);
    if (failure) return failure;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 完整校验一次 Renderer 请求的 payload。
 *
 * 顺序有意义：先证明结构可安全遍历，再按方法合同逐字段核对。反过来的话，
 * 一个超深或带环的 payload 会先把逐字段校验拖进它自己的陷阱里。
 */
export function validateRequestPayload(method: RequestMethod, rawPayload: unknown): ValidationResult {
  /*
   * 缺失与显式 null 是两回事，这里不把它们合并。
   *   undefined = 调用方没有 payload（零字段方法的正常形态）→ 当作 {}
   *   null      = 调用方明确送了一个 null → 畸形信封，拒绝
   * 合并成 `rawPayload ?? {}` 会让一个 `payload: null` 的畸形请求在零字段方法上通过。
   * 这条区分与 `files.read` 的 expectedGeneration 是同一个原则。
   */
  const shape = inspectPayloadShape(rawPayload === undefined ? {} : rawPayload);
  if (!shape.ok) return shape;

  const contract = IPC_CONTRACT[method];
  const failure = checkObject('payload', contract.fields, shape.payload);
  if (failure) return failure;
  return shape;
}
