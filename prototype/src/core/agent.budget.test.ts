import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 测试绝不碰真实数据根（~/Library/Application Support/RepoPilotPrototype）：
 * 并行的测试文件共享真根会互相踩（retention 的清扫会删掉别人的快照 ——
 * 528 全绿的套件曾因此随机红 3-4 条），而且会在用户机器上留垃圾，
 * 违反「自检和测试不能留下持久化改动」。vi.mock 提升到 import 之前，
 * 本文件模块图里的 paths 全部指向进程私有临时目录。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkdtempSync(j(tmpdir(), 'repopilot-test-data-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
  } as const;
  const ensure = () => {
    for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
      mkdirSync(d, { recursive: true });
    }
  };
  ensure();
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: ensure,
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import type {
  CommandDefinition,
  ModelRouteResolution,
  MutationReadReceipt,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEventKind,
  RunStatus,
  TaskSpec,
  ToolCallResolution,
  ToolRisk,
} from '@shared/domain';
import { digestOf, newId, nowIso, sha256 } from '@shared/ids';
import { AgentCancelled, PlanningFailed, type AgentHost, type ModelInvoker, runAgent } from './agent';
import type { ContentBlock, ModelMessage, ModelResponse } from './model/types';
import { findOrphanToolUse, findWireViolation, toolUsesOf } from './model/types';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { type MaterializedWorkspace, listTree, resolveManaged } from './workspace';

/**
 * Agent Loop 的**有界性**与降级路径。
 *
 * 这个文件刻意不跑真实构建、不接真实模型、不碰 DATA_ROOT：
 * 它要证明的不是"模型聪不聪明"，而是"当模型不配合时循环一定会停"。
 * 所以这里的模型替身全是**恶意/退化**的：永不提交计划、永远调工具、
 * 调不存在的工具、传垃圾参数、在半路让 signal 变成 aborted。
 *
 * 工作区用 StubWorkspace（真实临时目录 + 可观测的调用计数），
 * 目的是让"某次失败到底有没有真的执行"这件事可以被断言，
 * 而不是只能断言返回值。
 */

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

/**
 * 只实现 Agent Loop 与工具真正会碰到的那几个方法。
 *
 * 每个"有副作用"的入口都计数：失败用例可以断言它一次都没被调过，
 * 这比断言 `ok === false` 强得多 —— 后者在"执行了但结果为假"时也成立。
 */
class StubWorkspace {
  readonly runId = 'run_stub';
  readonly snapshotId = 'snap_stub';
  activeGeneration = 0;
  /** 由用例决定"模型到底改没改东西" */
  changed: string[] = [];
  readonly issueReceiptCalls: string[] = [];
  /** 任何 mutation 都必须先 stage()；用它证明写路径完全没被触发 */
  stageCalls = 0;
  /** 指定路径的读取抛异常，用来触发 dispatchTool 的 TOOL_EXCEPTION 分支 */
  throwOnRead: string | null = null;

  constructor(readonly activePath: string) {}

  changedFilesVsBaseline(): string[] {
    return [...this.changed];
  }

  changedVsBaseline(): { authored: string[]; generated: string[] } {
    return { authored: [...this.changed], generated: [] };
  }

  exists(rel: string): boolean {
    try {
      return existsSync(this.resolveInActive(rel));
    } catch {
      return false;
    }
  }

  readText(rel: string): string {
    return readFileSync(this.resolveInActive(rel), 'utf8');
  }

  resolveInActive(rel: string): string {
    return resolveManaged(this.activePath, rel);
  }

  issueReceipt(
    rel: string,
    coverage: MutationReadReceipt['coverage'] = 'FULL_BLOB',
    coveredBytes?: number,
  ): { content: string; receipt: MutationReadReceipt } {
    this.issueReceiptCalls.push(rel);
    if (this.throwOnRead === rel) throw new Error(`模拟 IO 故障: ${rel}`);
    const bytes = readFileSync(this.resolveInActive(rel));
    return {
      content: bytes.toString('utf8'),
      receipt: {
        receiptId: newId('rcpt'),
        generation: this.activeGeneration,
        path: rel,
        fileDigest: sha256(bytes),
        byteLength: bytes.byteLength,
        coverage,
        coveredBytes: coverage === 'FULL_BLOB' ? bytes.byteLength : (coveredBytes ?? 0),
        readAt: nowIso(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  }

  stage(): { generation: number; path: string } {
    this.stageCalls += 1;
    throw new Error('本文件的用例不应该真的进入 mutation 写路径');
  }

  /** 当前目录树的逐字节指纹，用于"失败无副作用"断言 */
  fingerprint(): string {
    return digestOf(listTree(this.activePath));
  }
}

function asWorkspace(w: StubWorkspace): MaterializedWorkspace {
  return w as unknown as MaterializedWorkspace;
}

interface RecordedToolCall {
  toolName: string;
  risk: ToolRisk;
  argsSummary: string;
  resolution: ToolCallResolution | null;
  reason: string | null;
  preview: string;
}

class TestHost implements AgentHost {
  /** payload 也要留：有些事实（截断报数、purpose 归属）只在 payload 里 */
  readonly events: Array<{ kind: RunEventKind; summary: string; payload: Record<string, unknown> }> = [];
  readonly statuses: Array<{ status: RunStatus; reason: string | null }> = [];
  readonly toolCalls: RecordedToolCall[] = [];
  readonly ledger = { modelTurns: 0, toolCalls: 0, selfFixRounds: 0 };
  planDecision: 'APPROVE' | 'REJECT' = 'APPROVE';
  planApprovals = 0;
  /** 模型轮次达到这个数就判定预算耗尽（模拟 authority 里的 ledger >= limit 语义） */
  budgetAfterModelTurns = Number.POSITIVE_INFINITY;

  emit(kind: RunEventKind, summary: string, payload: Record<string, unknown> = {}): void {
    this.events.push({ kind, summary, payload });
  }

  setStatus(status: RunStatus, reason: string | null): void {
    this.statuses.push({ status, reason });
  }

  async awaitPlanApproval(): Promise<'APPROVE' | 'REJECT'> {
    this.planApprovals += 1;
    return this.planDecision;
  }

  beginToolCall(input: { toolName: string; risk: ToolRisk; argsSummary: string }): string {
    this.toolCalls.push({
      toolName: input.toolName,
      risk: input.risk,
      argsSummary: input.argsSummary,
      resolution: null,
      reason: null,
      preview: '',
    });
    return `tc_${this.toolCalls.length - 1}`;
  }

  endToolCall(
    toolCallId: string,
    resolution: ToolCallResolution,
    reason: string | null,
    preview: string,
  ): void {
    const call = this.toolCalls[Number(toolCallId.slice(3))];
    if (!call) throw new Error(`未知的 toolCallId: ${toolCallId}`);
    if (call.resolution !== null) throw new Error('同一次工具调用被 resolve 了两次');
    call.resolution = resolution;
    call.reason = reason;
    call.preview = preview;
  }

  chargeModelTurn(): void {
    this.ledger.modelTurns += 1;
  }
  chargeToolCall(): void {
    this.ledger.toolCalls += 1;
  }
  chargeSelfFixRound(): void {
    this.ledger.selfFixRounds += 1;
  }

  budgetExceeded(): { exceeded: boolean; reason: string } {
    if (this.ledger.modelTurns >= this.budgetAfterModelTurns) {
      return { exceeded: true, reason: `模型轮次达上限 ${this.budgetAfterModelTurns}` };
    }
    return { exceeded: false, reason: '' };
  }

  kinds(): RunEventKind[] {
    return this.events.map((e) => e.kind);
  }
}

type InvokeInput = Parameters<ModelInvoker['invoke']>[0];

interface RecordedInvocation {
  purpose: string;
  system: string;
  messages: readonly ModelMessage[];
  /** 这一轮模型手上有哪些工具 —— 规划最后一轮的强制收窄就靠它可断言 */
  tools: readonly { name: string }[];
}

/** 按"第几次被调用"回应的确定性模型替身；同时留存请求内容供断言。 */
class ScriptedModel implements ModelInvoker {
  readonly calls: RecordedInvocation[] = [];

  constructor(private readonly script: (turn: number, input: InvokeInput) => ModelResponse) {}

  get callCount(): number {
    return this.calls.length;
  }

  /** 第 n 次调用（1-based）里最后一条消息的序列化文本 */
  lastMessageText(n: number): string {
    const call = this.calls[n - 1];
    if (!call) throw new Error(`第 ${n} 次模型调用不存在（实际只有 ${this.calls.length} 次）`);
    return JSON.stringify(call.messages[call.messages.length - 1]?.content ?? '');
  }

  async invoke(input: InvokeInput) {
    // conversation 数组会被 agent.ts 就地 push，必须拷一份快照
    this.calls.push({
      purpose: input.purpose,
      system: input.request.system,
      messages: [...input.request.messages],
      tools: input.request.tools.map((t) => ({ name: t.name })),
    });
    // 先快照再校验：抛在快照前的话，出问题的那一次调用反而查不到。
    // 真实 provider 会对孤儿 tool_use 返回 400，测试替身不会 —— 所以这里
    // 主动用与网关同一个校验器把关，否则这类回归在测试里是静默的。
    const orphan = findWireViolation(input.request.messages);
    if (orphan) {
      throw new Error(`第 ${this.calls.length} 次调用（${input.purpose}）收到非法消息序列：${orphan}`);
    }
    const response = this.script(this.calls.length, input);
    return {
      invocationId: `inv_stub_${this.calls.length}`,
      response,
      manifest: {
        invocationId: `inv_stub_${this.calls.length}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: input.resolution.providerId,
        origin: input.resolution.origin,
        modelId: 'TEST_ONLY_FAKE',
        sent: false,
        blockReason: 'TEST_ONLY_FAKE_NO_EGRESS',
        contextFileRefs: [] as readonly string[],
        inputTokens: 10,
        outputTokens: 5,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }
}

function toolUse(name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input }],
    stopReason: 'TOOL_USE',
    inputTokens: 10,
    outputTokens: 5,
  };
}

/** 一轮里点名多个工具 —— 真实模型经常这么干 */
function multiToolUse(...calls: Array<{ name: string; input: unknown }>): ModelResponse {
  return {
    content: calls.map((c) => ({
      type: 'tool_use' as const,
      id: `tu_${c.name}_${Math.random().toString(36).slice(2, 8)}`,
      name: c.name,
      input: c.input,
    })),
    stopReason: 'TOOL_USE',
    inputTokens: 10,
    outputTokens: 5,
  };
}

function endTurn(text: string): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'END_TURN',
    inputTokens: 10,
    outputTokens: 5,
  };
}

const VALID_PLAN = {
  summary: '把 CartSummary 里被当成 number 用的 DiscountResult 解构出来',
  steps: [
    { intent: '解构 applyDiscount 的返回值', targetPaths: ['src/a.ts'], expectedEffect: '类型错误消失' },
    { intent: '补一条回归断言', targetPaths: ['src/b.ts'], expectedEffect: '同类问题会被测出来' },
  ],
  risks: ['其它调用点可能有同样问题'],
};

// ---------------------------------------------------------------------------
// 固定装置
// ---------------------------------------------------------------------------

function cmd(commandId: string, argv: string[]): CommandDefinition {
  return {
    commandId,
    label: `测试命令 ${commandId}`,
    argv,
    cwdRelative: '.',
    timeoutMs: 10_000,
    risk: 'R1',
    source: 'DETECTED',
  };
}

const SNAPSHOT: RepositorySnapshot = {
  snapshotId: 'snap_stub',
  projectId: 'proj_stub',
  baseSha: 'a'.repeat(40),
  branch: 'main',
  baseKind: 'CLEAN_COMMIT',
  dirtyFileCount: 0,
  untrackedCount: 0,
  subPath: '',
  fileCount: 2,
  totalBytes: 42,
  treeDigest: digestOf({ stub: true }),
  excludedPaths: [],
  createdAt: nowIso(),
};

const RESOLUTION: ModelRouteResolution = {
  resolutionId: 'route_stub',
  profileId: 'profile_stub_fake',
  providerId: 'ANTHROPIC_OFFICIAL',
  origin: 'https://api.anthropic.com',
  modelId: 'TEST_ONLY_FAKE',
  frozenAt: nowIso(),
  digest: digestOf({ stub: true }),
};

let dir: string;
let sentinel: string;
let workspace: StubWorkspace;
let host: TestHost;
let profile: RepositoryHarnessProfile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repopilot-budget-'));
  sentinel = join(dir, '.ran');
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n', 'utf8');
  writeFileSync(join(dir, 'boom.txt'), 'unreadable\n', 'utf8');
  workspace = new StubWorkspace(dir);
  host = new TestHost();
  profile = {
    profileId: 'profile_stub',
    snapshotId: 'snap_stub',
    adapterId: 'vite-react-ts',
    adapterVersion: '0.0.0-test',
    supportStatus: 'VERIFIED',
    detectedSignals: ['vite', 'react', 'typescript'],
    packageManager: 'npm',
    commands: {
      // 跑一次就往 sentinel 追加一行 —— 让"这条命令到底被 spawn 了几次"可断言
      green: cmd('green', ['/bin/sh', '-c', `printf 'ran\\n' >> '${sentinel}'; exit 0`]),
      red: cmd('red', ['/bin/sh', '-c', `printf 'boom\\n' 1>&2; exit 3`]),
    },
    protectedPaths: ['package.json'],
    supportedTaskClasses: ['BUILD_FAILURE_FIX'],
    notes: [],
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** sentinel 里的行数 = green 命令被真实 spawn 的次数 */
function ranCount(): number {
  if (!existsSync(sentinel)) return 0;
  return readFileSync(sentinel, 'utf8').split('\n').filter(Boolean).length;
}

function makeTask(over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: 'task_stub',
    projectId: 'proj_stub',
    snapshotId: 'snap_stub',
    profileId: 'profile_stub',
    goal: '修复构建失败',
    taskClass: 'BUILD_FAILURE_FIX',
    allowedPaths: ['src/**'],
    protectedPaths: ['package.json'],
    nonGoals: [],
    acceptance: ['不改动 pricing.ts 的公开签名'],
    verificationCommandIds: [],
    budget: {
      maxModelTurns: 20,
      maxToolCalls: 30,
      maxSelfFixRounds: 2,
      maxWallClockMs: 60_000,
      maxTotalTokens: 100_000,
    },
    createdAt: nowIso(),
    ...over,
  };
}

function run(
  gateway: ScriptedModel,
  task: TaskSpec,
  signal: AbortSignal = new AbortController().signal,
) {
  return runAgent({
    task,
    snapshot: SNAPSHOT,
    profile,
    workspace: asWorkspace(workspace),
    gateway,
    resolution: RESOLUTION,
    mutationPolicy: {
      ...DEFAULT_MUTATION_POLICY,
      allowedPaths: task.allowedPaths,
      protectedPaths: task.protectedPaths,
    },
    runId: 'run_stub',
    attemptId: 'att_stub',
    signal,
    host,
  });
}

// ---------------------------------------------------------------------------
// 预算：循环的唯一硬上界
// ---------------------------------------------------------------------------

describe('预算耗尽必须让循环停下', () => {
  it('规划阶段一开始就超预算：抛 PlanningFailed，且一次模型都不调', async () => {
    // 预算检查在 callModel 之前。如果顺序反了，用户会为一次注定被丢弃的调用付费。
    host.budgetAfterModelTurns = 0;
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));

    await expect(run(gateway, makeTask())).rejects.toBeInstanceOf(PlanningFailed);
    await expect(run(gateway, makeTask())).rejects.toThrow(/预算耗尽/);

    expect(gateway.callCount).toBe(0);
    expect(host.planApprovals).toBe(0);
    expect(host.kinds()).not.toContain('PLAN_GENERATED');
  });

  it('执行阶段超预算：发出 BUDGET_EXHAUSTED，且此后不再有任何模型调用', async () => {
    // 这个模型永远不结束回合 —— 没有预算闸门的话 executionTurns 是死循环。
    // 用未注册的工具名，是为了让"循环有没有停"与"工具能不能跑"解耦。
    host.budgetAfterModelTurns = 3;
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : toolUse('never_ending_tool', { n }),
    );

    const result = await run(gateway, makeTask());

    // 规划 1 次 + 执行 2 次，第 3 次进循环前预算已达上限
    expect(gateway.callCount).toBe(3);
    expect(host.toolCalls).toHaveLength(2);

    const budgetEvents = host.events.filter((e) => e.kind === 'BUDGET_EXHAUSTED');
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]!.summary).toContain('模型轮次达上限 3');

    // 关键证据：BUDGET_EXHAUSTED 之后不能再有模型调用，否则"停下"是假的
    const at = host.events.findIndex((e) => e.kind === 'BUDGET_EXHAUSTED');
    expect(host.events.slice(at).filter((e) => e.kind === 'MODEL_INVOCATION')).toHaveLength(0);

    expect(result.kind).toBe('NO_CHANGES');
  });

  it(
    '【期望行为】预算把执行截断、但工作区已有改动时，结果应说明"被截断"而不是当成正常完工',
    async () => {
      // 现状：executionTurns 因预算返回后，runAgent 直接走 PATCH_READY，
      // detail 与 unverifiedItems 都不提"这次是被预算掐断的"。
      // authority 会把 PATCH_READY 变成 AWAITING_PATCH_REVIEW 交给用户，
      // 用户看到的是一份"看起来正常完成"的补丁。
      host.budgetAfterModelTurns = 2;
      workspace.changed = ['src/a.ts'];
      const gateway = new ScriptedModel((n) =>
        n === 1 ? toolUse('submit_plan', VALID_PLAN) : toolUse('never_ending_tool', {}),
      );

      const result = await run(gateway, makeTask());

      expect(result.kind).toBe('PATCH_READY');
      expect(host.kinds()).toContain('BUDGET_EXHAUSTED');
      expect(`${result.detail}${result.unverifiedItems.join('')}`).toContain('预算');
    },
  );
});

// ---------------------------------------------------------------------------
// 未验证模式
// ---------------------------------------------------------------------------

describe('未验证模式（verificationCommandIds 为空）', () => {
  it('跳过基线、跳过重验、不做自修复，直接产出 PATCH_READY', async () => {
    workspace.changed = ['src/a.ts', 'src/b.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('改完了，没有验证手段所以只动了计划里的两处。'),
    );

    const result = await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(result.kind).toBe('PATCH_READY');
    // baseline/final 必须是 null 而不是"空的通过记录"—— 后者会让下游误判为已验证
    expect(result.baseline).toBeNull();
    expect(result.finalVerification).toBeNull();
    expect(result.detail).toContain('没有任何机器验证');

    expect(host.kinds()).not.toContain('VERIFICATION_STARTED');
    expect(host.kinds()).not.toContain('VERIFICATION_FINISHED');
    expect(host.kinds()).not.toContain('SELF_FIX_ROUND');
    expect(host.ledger.selfFixRounds).toBe(0);

    // profile 里明明有可跑的命令，必须一条都没被 spawn
    expect(Object.keys(profile.commands).length).toBeGreaterThan(0);
    expect(ranCount()).toBe(0);

    expect(host.events.some((e) => e.kind === 'NOTE' && e.summary.includes('未验证模式'))).toBe(true);
  });

  it('给模型的执行指令里必须写明"你无法证明改动是对的"', async () => {
    // 未验证模式最大的风险是模型照常自信地宣称修好了。
    // 提示词里的这句保守指令是唯一的缓解手段，掉了就是静默降级。
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('完成'),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(gateway.lastMessageText(1)).toContain('没有配置任何验证命令');
    expect(gateway.lastMessageText(2)).toContain('没有配置验证命令');
    expect(gateway.lastMessageText(2)).not.toContain('全部通过后');
  });

  it('unverifiedItems 必须明确警示，并点名"其实有可用命令没被选上"', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('完成'),
    );

    const result = await run(gateway, makeTask({ verificationCommandIds: [] }));
    const items = result.unverifiedItems;

    expect(items[0]).toContain('没有执行任何验证命令');
    expect(items[0]).toContain('⚠');
    // 「一条命令都没有」和「有命令但你没选」是两回事，警示必须区分
    expect(items.some((i) => i.includes('green') && i.includes('red'))).toBe(true);
    // 人工验收条件不能被算作已验证
    expect(items.some((i) => i.includes('不改动 pricing.ts 的公开签名'))).toBe(true);
  });

  it('未验证模式下模型没改任何东西：返回 NO_CHANGES 而不是空补丁', async () => {
    workspace.changed = [];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('我看了一圈，觉得不用改。'),
    );

    const result = await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(result.kind).toBe('NO_CHANGES');
    expect(result.detail).toContain('没有产生任何文件变更');
    expect(result.unverifiedItems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

describe('基线决定这一趟要不要跑', () => {
  it('基线全绿：直接 NO_CHANGES，一次模型都不调（不白跑一趟）', async () => {
    const gateway = new ScriptedModel(() => {
      throw new Error('基线全绿时不应该调用模型');
    });

    const result = await run(gateway, makeTask({ verificationCommandIds: ['green'] }));

    expect(result.kind).toBe('NO_CHANGES');
    expect(gateway.callCount).toBe(0);
    expect(host.planApprovals).toBe(0);
    expect(host.kinds()).not.toContain('PLAN_GENERATED');

    // passed=true 必须来自"真的跑了一条命令且 exit 0"，不能来自"零条命令"
    expect(result.baseline!.commands).toHaveLength(1);
    expect(result.baseline!.commands[0]!.outcome).toBe('EXIT_ZERO');
    expect(result.baseline!.commands[0]!.exitCode).toBe(0);
    expect(result.baseline!.passed).toBe(true);
    expect(ranCount()).toBe(1);

    expect(result.finalVerification).toBe(result.baseline);
  });

  it('验证命令 id 未登记：记 SPAWN_ERROR 并如实告诉模型，不当成"构建失败"也不当成绿', async () => {
    // 这是最会说谎的一处：commandId 打错时，如果被当成通过就漏修，
    // 如果被含混地说成"构建失败"，模型会去找一个根本不存在的编译错误。
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));

    const result = await run(gateway, makeTask({ verificationCommandIds: ['nope'] }));

    const c = result.baseline!.commands[0]!;
    expect(c.outcome).toBe('SPAWN_ERROR');
    expect(c.exitCode).toBeNull();
    expect(c.stderrPreview).toContain('profile 中没有登记');
    expect(result.baseline!.passed).toBe(false);

    // 送给模型的任务简报里必须出现 SPAWN_ERROR 本身，而不是被抹成一句"失败"
    expect(gateway.lastMessageText(1)).toContain('SPAWN_ERROR');
    // 别的命令不能被"顺手"跑掉
    expect(ranCount()).toBe(0);
  });

  it('基线真实失败 + 用户拒绝计划：PLAN_REJECTED，基线保留，零工具副作用', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));

    const result = await run(gateway, makeTask({ verificationCommandIds: ['red'] }));

    // 失败原因必须是"真的跑了并且非零退出"，不是 spawn 不起来
    const c = result.baseline!.commands[0]!;
    expect(c.outcome).toBe('EXIT_NONZERO');
    expect(c.exitCode).toBe(3);
    expect(c.stderrPreview).toContain('boom');

    expect(result.kind).toBe('PLAN_REJECTED');
    expect(result.detail).toContain('未产生任何副作用');
    expect(result.finalVerification).toBeNull();
    // 拒绝后不能再有执行阶段的模型调用
    expect(gateway.callCount).toBe(1);
    /*
     * "零工具副作用"指的是**模型发起的**工具：一个都没有。
     * 基线验证本身是平台发起的命令，它现在照样留一条 ToolCall 记录并计入账本
     * （TD §9.4 同一 Gateway、同一账本）—— 时间线上看得见平台跑了什么，不再是隐形的。
     */
    const modelCalls = host.toolCalls.filter((t) => t.toolName !== 'verify_command');
    expect(modelCalls).toHaveLength(0);
    const verifyCalls = host.toolCalls.filter((t) => t.toolName === 'verify_command');
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]!.argsSummary).toContain('BASELINE red');
    expect(verifyCalls[0]!.resolution).toBe('FAILED');
    expect(host.ledger.toolCalls).toBe(1);
    expect(ranCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 规划阶段的轮次上界
// ---------------------------------------------------------------------------

describe('发给模型的消息序列必须合法', () => {
  // 这一组守的是两家 wire 共同的硬性要求：assistant 消息里的每个 tool_use，
  // 下一条消息必须回填对应的 tool_result。违反时 Anthropic 与 OpenAI 兼容端都返回 400，
  // 而且是**此后每一次请求**都失败 —— 坏消息永久留在 conversation 里。
  // 脚本化替身不校验序列，所以这类缺陷曾经在 389 个测试全绿的情况下存活。

  it('findOrphanToolUse 真的能抓到孤儿 —— 否则本组其余断言都是空的', () => {
    const orphan = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '干活' }] },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'submit_plan', input: {} }],
      },
      { role: 'user' as const, content: [{ type: 'text' as const, text: '用户已批准' }] },
    ];
    expect(findOrphanToolUse(orphan)).toContain('submit_plan(tu_1)');

    // 回填之后就合法
    const answered = [
      orphan[0]!,
      orphan[1]!,
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, toolUseId: 'tu_1', content: '已提交', isError: false },
        ],
      },
    ];
    expect(findOrphanToolUse(answered)).toBeNull();

    // 只回填了一半也算孤儿
    const half = [
      orphan[0]!,
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 'tu_1', name: 'fs_read', input: {} },
          { type: 'tool_use' as const, id: 'tu_2', name: 'submit_plan', input: {} },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, toolUseId: 'tu_1', content: 'ok', isError: false },
        ],
      },
    ];
    expect(findOrphanToolUse(half)).toContain('submit_plan(tu_2)');
  });

  it('计划获批后的第一次执行调用，历史里不能有孤儿 tool_use', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('改完了'),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    // 前提：确实发生了「规划提交 → 执行」的跨阶段历史复用，
    // 否则下面那句断言什么都没验证。
    const exec = gateway.calls.filter((c) => c.purpose === 'EXECUTION');
    expect(exec.length).toBeGreaterThan(0);
    const first = exec[0]!;
    expect(
      first.messages.some((m) => toolUsesOf(m.content).some((u) => u.name === 'submit_plan')),
    ).toBe(true);

    expect(findOrphanToolUse(first.messages)).toBeNull();
  });

  it('submit_plan 与别的工具同轮出现时，两个 id 都要被回填', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1
        ? multiToolUse(
            { name: 'fs_read', input: { path: 'src/a.ts' } },
            { name: 'submit_plan', input: VALID_PLAN },
          )
        : endTurn('改完了'),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    const exec = gateway.calls.filter((c) => c.purpose === 'EXECUTION');
    expect(exec.length).toBeGreaterThan(0);

    // 前提：那一轮确实有两个 tool_use
    const planTurn = exec[0]!.messages.find((m) => toolUsesOf(m.content).length === 2);
    expect(planTurn).toBeDefined();

    expect(findOrphanToolUse(exec[0]!.messages)).toBeNull();
  });

  it('每一次模型调用的历史都合法，不只是第一次', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      if (n === 2) return toolUse('fs_read', { path: 'src/a.ts' });
      if (n === 3) return toolUse('fs_list', { path: '.' });
      return endTurn('改完了');
    });

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(gateway.calls.length).toBeGreaterThan(3);
    for (const [i, call] of gateway.calls.entries()) {
      expect(findOrphanToolUse(call.messages), `第 ${i + 1} 次调用（${call.purpose}）`).toBeNull();
    }
  });
});

describe('规划阶段不会无限重试', () => {
  it('模型只回文本不调 submit_plan：每轮都被要求重提，用满轮次后抛 PlanningFailed', async () => {
    const gateway = new ScriptedModel(() => endTurn('我觉得这个 bug 挺简单的，直接改就行。'));
    const task = makeTask({
      budget: { ...makeTask().budget, maxModelTurns: 6 },
    });

    // 规划子预算 = 轮次预算的一半（6 → 3），见 generatePlan 里 maxPlanTurns 的注释
    await expect(run(gateway, task)).rejects.toThrow(/规划阶段用满 3 轮仍未提交计划/);

    expect(gateway.callCount).toBe(3);
    // 每次纯文本回复都要被顶回去，而不是静默重发同一段上下文
    expect(gateway.lastMessageText(2)).toContain('请调用 submit_plan 工具提交结构化计划');
    expect(gateway.lastMessageText(3)).toContain('请调用 submit_plan 工具提交结构化计划');

    expect(host.planApprovals).toBe(0);
    expect(host.kinds()).not.toContain('PLAN_GENERATED');
    expect(host.toolCalls).toHaveLength(0);
  });

  it('规划子预算从 Run 轮次预算派生，且永远吃不掉整个预算', async () => {
    /*
     * 守卫的**意图**不变：一个死活不提交计划的模型不能把整个预算烧在规划上。
     * 变的是它的来源 —— 以前是与用户预算无关的常数 12，这让"用户把预算调大"
     * 对规划完全无效。2026-08-28 实测（EVI-PLANNING-CAP-001）显示真实失败正是撞在
     * 那个常数上，而 token 36% / 工具 45% / 轮次 30% 三项预算都没用完。
     */
    const gateway = new ScriptedModel(() => endTurn('再想想。'));
    const task = makeTask({ budget: { ...makeTask().budget, maxModelTurns: 50 } });

    await expect(run(gateway, task)).rejects.toThrow(/用满 25 轮/);
    expect(gateway.callCount).toBe(25); // 派生：50 的一半
    expect(gateway.callCount).toBeLessThan(50); // 守卫仍在：吃不掉整个预算
  });

  it('规划触顶的文案如实报数，并指出"加预算没用"（最后一轮已经强制收窄过）', async () => {
    /*
     * 不变式 8「省略要报数」的应用：旧文案只说"用满 12 轮"，把最关键的事实藏了 ——
     * **其他预算根本没用完**。
     *
     * 而现在最后一轮平台已经把工具收窄到只剩 submit_plan，模型手上没有别的选择还是
     * 没提交 —— 那就不是探索时间不够。此时如果文案仍然建议"提高轮次预算"，
     * 就是把用户往一个已经被证伪的方向推。
     */
    const gateway = new ScriptedModel(() => endTurn('再想想。'));
    const task = makeTask({ budget: { ...makeTask().budget, maxModelTurns: 6 } });

    await expect(run(gateway, task)).rejects.toThrow(/尚未耗尽/);
    await expect(run(gateway, task)).rejects.toThrow(/轮次预算 6 轮的一半/);
    await expect(run(gateway, task)).rejects.toThrow(/最后一轮.*只剩 submit_plan/);
    await expect(run(gateway, task)).rejects.toThrow(/加预算大概率无效/);
  });

  it('submit_plan 参数不合法：把校验错误回灌给模型，允许改正而不是直接失败', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', { summary: '空计划', steps: [] }); // 违反 min(1)
      if (n === 2) {
        return toolUse('submit_plan', {
          summary: '步骤太多',
          steps: Array.from({ length: 13 }, (_, i) => ({ intent: `step ${i}` })), // 违反 max(12)
        });
      }
      return toolUse('submit_plan', VALID_PLAN);
    });

    const result = await run(gateway, makeTask());

    expect(gateway.callCount).toBe(3);
    expect(gateway.lastMessageText(2)).toContain('计划 schema 校验失败');
    expect(gateway.lastMessageText(2)).toContain('steps');
    expect(gateway.lastMessageText(3)).toContain('计划 schema 校验失败');

    // 只有合法的那次才产生计划事件
    expect(host.events.filter((e) => e.kind === 'PLAN_GENERATED')).toHaveLength(1);
    expect(result.kind).toBe('PLAN_REJECTED');
  });
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

describe('AbortSignal 取消', () => {
  it('起手就已取消（有验证）：抛 AgentCancelled，不 spawn 命令，也不伪造"基线完成"事件', async () => {
    const controller = new AbortController();
    controller.abort();
    const gateway = new ScriptedModel(() => {
      throw new Error('已取消时不应调用模型');
    });

    await expect(
      run(gateway, makeTask({ verificationCommandIds: ['green'] }), controller.signal),
    ).rejects.toBeInstanceOf(AgentCancelled);

    expect(ranCount()).toBe(0);
    expect(gateway.callCount).toBe(0);
    // STARTED 已经发出去了，但绝不能补一条 FINISHED 让审计以为基线跑完了
    expect(host.kinds()).toContain('VERIFICATION_STARTED');
    expect(host.kinds()).not.toContain('VERIFICATION_FINISHED');
  });

  it('规划中途取消恰好落在工具分发上：记 CANCELLED/RUN_CANCELLED，不计费，不执行', async () => {
    const controller = new AbortController();
    const gateway = new ScriptedModel(() => {
      controller.abort(); // 模型返回的同时用户按了取消
      return toolUse('fs_read', { path: 'hello.txt' });
    });

    await expect(run(gateway, makeTask(), controller.signal)).rejects.toBeInstanceOf(AgentCancelled);

    expect(host.toolCalls).toHaveLength(1);
    expect(host.toolCalls[0]!.resolution).toBe('CANCELLED');
    expect(host.toolCalls[0]!.reason).toBe('RUN_CANCELLED');
    // 取消掉的调用不能计费，也不能真的读文件
    expect(host.ledger.toolCalls).toBe(0);
    expect(workspace.issueReceiptCalls).toEqual([]);
  });

  it('执行阶段取消：在分发之前就停，一次工具都不开始', async () => {
    const controller = new AbortController();
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      controller.abort();
      return toolUse('fs_read', { path: 'hello.txt' });
    });

    await expect(run(gateway, makeTask(), controller.signal)).rejects.toBeInstanceOf(AgentCancelled);

    expect(gateway.callCount).toBe(2);
    expect(host.toolCalls).toHaveLength(0);
    expect(workspace.issueReceiptCalls).toEqual([]);
    expect(workspace.stageCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchTool
// ---------------------------------------------------------------------------

describe('dispatchTool 的拒绝路径', () => {
  it('未知工具名：DENIED/UNKNOWN_TOOL，不计费，回灌的错误里列出可用工具', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('shell_exec', { cmd: 'rm -rf /' }) : toolUse('submit_plan', VALID_PLAN),
    );

    await run(gateway, makeTask());

    expect(host.toolCalls).toHaveLength(1);
    expect(host.toolCalls[0]!.toolName).toBe('shell_exec');
    expect(host.toolCalls[0]!.resolution).toBe('DENIED');
    expect(host.toolCalls[0]!.reason).toBe('UNKNOWN_TOOL');
    expect(host.toolCalls[0]!.preview).toContain('未注册的工具');
    expect(host.ledger.toolCalls).toBe(0);

    // 错误必须可操作：告诉模型能用什么，否则它会一直猜工具名
    const feedback = gateway.lastMessageText(2);
    expect(feedback).toContain('不存在名为 shell_exec 的工具');
    expect(feedback).toContain('workspace_mutate');
    expect(feedback).toContain('"isError":true');
  });

  it('参数 schema 不合法：FAILED/SCHEMA_INVALID，且 execute 一次都没跑', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('fs_read', {}); // 缺 path
      if (n === 2) return toolUse('fs_read', { path: 'hello.txt' }); // 对照组：合法参数
      return toolUse('submit_plan', VALID_PLAN);
    });

    await run(gateway, makeTask());

    expect(host.toolCalls[0]!.resolution).toBe('FAILED');
    expect(host.toolCalls[0]!.reason).toBe('SCHEMA_INVALID');
    expect(host.toolCalls[0]!.argsSummary).toBe('参数不合法');
    expect(host.toolCalls[0]!.preview).toContain('path');

    // 对照组证明上面的"没执行"断言不是空的：合法那次确实执行并计费了
    expect(host.toolCalls[1]!.resolution).toBe('SUCCEEDED');
    expect(workspace.issueReceiptCalls).toEqual(['hello.txt']);
    expect(host.ledger.toolCalls).toBe(1);
  });

  it('写工具参数不合法：不进 stage，工作区逐字节不变', async () => {
    const before = workspace.fingerprint();
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      if (n === 2) return toolUse('workspace_mutate', { operations: [] }); // 违反 min(1)
      return endTurn('参数被拒了，我停手。');
    });

    const result = await run(gateway, makeTask());

    expect(host.toolCalls[0]!.toolName).toBe('workspace_mutate');
    expect(host.toolCalls[0]!.resolution).toBe('FAILED');
    expect(host.toolCalls[0]!.reason).toBe('SCHEMA_INVALID');
    expect(host.toolCalls[0]!.risk).toBe('R1');

    expect(workspace.stageCalls).toBe(0);
    expect(workspace.fingerprint()).toBe(before);
    expect(host.kinds()).not.toContain('MUTATION_APPLIED');
    expect(result.kind).toBe('NO_CHANGES');
  });

  it('工具 execute 抛异常：FAILED/TOOL_EXCEPTION，循环继续而不是炸掉整个 Run', async () => {
    workspace.throwOnRead = 'boom.txt';
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      if (n === 2) return toolUse('fs_read', { path: 'boom.txt' });
      return endTurn('读不出来，我不瞎改。');
    });

    const result = await run(gateway, makeTask());

    expect(host.toolCalls[0]!.resolution).toBe('FAILED');
    expect(host.toolCalls[0]!.reason).toBe('TOOL_EXCEPTION');
    expect(host.toolCalls[0]!.preview).toContain('模拟 IO 故障');
    // 异常发生在计费之后，账本不能因为异常而回退
    expect(host.ledger.toolCalls).toBe(1);
    expect(gateway.lastMessageText(3)).toContain('工具执行异常');
    // Run 本身没有被异常带走
    expect(result.kind).toBe('NO_CHANGES');
  });

  it('路径逃逸：FAILED，且不产生 receipt', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('fs_read', { path: '../../etc/passwd' }) : toolUse('submit_plan', VALID_PLAN),
    );

    await run(gateway, makeTask());

    expect(host.toolCalls[0]!.resolution).toBe('FAILED');
    expect(workspace.issueReceiptCalls).toEqual([]);
    expect(gateway.lastMessageText(2)).toContain('文件不存在');
  });

  it('【期望行为】规划阶段模型点名 R1 工具时应被拒绝，而不是照跑', async () => {
    // dispatchTool 查的是全局 TOOLS_BY_NAME，没有阶段概念。
    // PLANNING_TOOLS 只决定"给模型看哪些 schema"，属于提示层约束；
    // 模型只要吐出 run_command / workspace_mutate 这个名字，规划阶段就会真的执行。
    // 这与 tools.ts:393「规划阶段由平台强制 read-only —— 不是靠 prompt 自律」相矛盾。
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('run_command', { commandId: 'green' }) : toolUse('submit_plan', VALID_PLAN),
    );

    await run(gateway, makeTask());

    expect(host.toolCalls[0]!.resolution).toBe('DENIED');
    expect(ranCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 相位如实上报
// ---------------------------------------------------------------------------

describe('相位如实上报：验证阶段就报 VERIFYING', () => {
  /**
   * 背景：VERIFYING 在 RunStatus 里声明了，却**从来没有被任何生产代码设过** ——
   * 一个死状态。同时基线验证报的是 EXECUTING，于是时间线上的相位读起来是
   * 「执行 → 规划 → 执行」：用户看到的第一个相位是执行，而那时一行代码都没改。
   *
   * 这两件事是同一个问题：状态没照实报。相位是用户判断"现在轮到谁"的唯一依据，
   * 报错了比不报更糟。
   */
  const flow = () => host.statuses.map((s) => s.status);

  it('基线验证期间报 VERIFYING，不是 EXECUTING', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));

    await run(gateway, makeTask({ verificationCommandIds: ['red'] }));

    // 第一个相位必须是验证 —— 那时确实在跑命令，而不是在改代码
    expect(flow()[0]).toBe('VERIFYING');
    expect(host.statuses[0]!.reason).toContain('基线');
    // 规划在验证之后，而不是夹在两个"执行"中间
    expect(flow().slice(0, 3)).toEqual(['VERIFYING', 'PLANNING', 'AWAITING_PLAN_APPROVAL']);
  });

  it('基线全绿提前收尾时也只报过 VERIFYING —— 没执行过就不许说执行过', async () => {
    const gateway = new ScriptedModel(() => {
      throw new Error('基线全绿时不应该调用模型');
    });
    await run(gateway, makeTask({ verificationCommandIds: ['green'] }));
    expect(flow()).toEqual(['VERIFYING']);
  });

  it('改后验证同样报 VERIFYING，自修复回到 EXECUTING', async () => {
    /*
     * red 永远非零：第一轮改后验证失败 → 进第 1 轮自修复 → 再验一次 → 用尽轮次。
     * 相位应当来回摆：执行 → 验证 → 执行 → 验证，而不是整段停在"执行"。
     */
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('改完了'),
    );

    const result = await run(
      gateway,
      makeTask({ verificationCommandIds: ['red'], budget: { ...makeTask().budget, maxSelfFixRounds: 1 } }),
    );

    expect(result.kind).toBe('VERIFICATION_FAILED');
    expect(flow()).toEqual([
      'VERIFYING', // 基线
      'PLANNING',
      'AWAITING_PLAN_APPROVAL',
      'EXECUTING',
      'VERIFYING', // 改后验证
      'EXECUTING', // 第 1 轮自修复
      'VERIFYING', // 再验一次
    ]);
  });

  it('未验证模式不报凭空的 EXECUTING：第一个相位就是规划', async () => {
    /*
     * 这里既没在执行也没在验证，只是没有基线要建。之前会先报一次 EXECUTING，
     * 在时间线上凭空多一个"执行"锚点 —— 事实由紧接着的 NOTE 交代就够了。
     */
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('改完了'),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(flow()[0]).toBe('PLANNING');
    expect(flow()).not.toContain('VERIFYING');
    expect(host.events.some((e) => e.kind === 'NOTE' && e.summary.includes('未验证模式'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 模型说的话
// ---------------------------------------------------------------------------

describe('ASSISTANT_MESSAGE：模型说的话每一轮都记，且归属给模型', () => {
  /**
   * 之前只有模型**停止调用工具**的那一轮才取一次正文，截到 400 字、无披露，
   * 而且以 NOTE 发出去（时间线上署名"平台"）。后果有三层：
   *   1. 有工具调用的那些轮，模型写的东西整段丢弃 —— 参照物界面里"每组调用之间
   *      那句有结论的话"在这套数据里根本不存在；
   *   2. 唯一留下的那段被记在平台名下，界面上从来没出现过"AI"这个说话人；
   *   3. 截断不报数，正好在第 400 个字符处切在半句话上。
   */
  const says = () => host.events.filter((e) => e.kind === 'ASSISTANT_MESSAGE');

  /** 一轮里既说话又点名工具 —— 真实模型的常态，也正是此前被整段丢弃的那种 */
  function sayAndUse(text: string, name: string, input: unknown): ModelResponse {
    return {
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input },
      ],
      stopReason: 'TOOL_USE',
      inputTokens: 10,
      outputTokens: 5,
    };
  }

  it('有工具调用的那一轮也记 —— 这是此前整段丢弃的那一半', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      if (n === 2) return sayAndUse('我先看一眼 src/a.ts。', 'fs_read', { path: 'src/a.ts' });
      return endTurn('改完了：把返回值解构成 amount。');
    });

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    expect(says().map((e) => e.summary)).toEqual([
      '我先看一眼 src/a.ts。',
      '改完了：把返回值解构成 amount。',
    ]);
    // 不再借 NOTE 的名义发模型正文
    expect(host.events.some((e) => e.kind === 'NOTE' && e.summary.includes('改完了'))).toBe(false);
  });

  it('规划期的思考同样进时间线，不再被原样吞掉', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return sayAndUse('先读一下再定计划。', 'fs_read', { path: 'src/a.ts' });
      if (n === 2) return toolUse('submit_plan', VALID_PLAN);
      return endTurn('完成');
    });

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    const planning = says().filter((e) => e.payload.purpose === 'PLANNING');
    expect(planning.map((e) => e.summary)).toEqual(['先读一下再定计划。']);
  });

  it('只调工具不说话的那一轮不造空消息', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) => {
      if (n === 1) return toolUse('submit_plan', VALID_PLAN);
      if (n === 2) return toolUse('fs_read', { path: 'src/a.ts' });
      return endTurn('好了');
    });

    await run(gateway, makeTask({ verificationCommandIds: [] }));
    expect(says().map((e) => e.summary)).toEqual(['好了']);
  });

  it('超长正文截断，但如实报出原始长度 —— 不再是切在 400 字处一声不吭', async () => {
    workspace.changed = ['src/a.ts'];
    const long = '啊'.repeat(5000);
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn(long),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    const [said] = says();
    expect(said).toBeTruthy();
    expect(said!.payload.truncated).toBe(true);
    expect(said!.payload.fullLength).toBe(5000);
    expect(said!.summary).toHaveLength(4000);
  });

  it('没超长就不谎报截断', async () => {
    workspace.changed = ['src/a.ts'];
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('submit_plan', VALID_PLAN) : endTurn('短短一句。'),
    );

    await run(gateway, makeTask({ verificationCommandIds: [] }));

    const [said] = says();
    expect(said!.payload.truncated).toBe(false);
    expect(said!.payload.fullLength).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 规划收口
// ---------------------------------------------------------------------------

describe('规划必须收口：告诉模型有几轮，最后一轮结构上强制提交', () => {
  /**
   * 真实失败样本（用户 2026-08-31 实机）：任务「你能找出部分优化的点吗」，
   * 规划阶段跑满 20 轮、43 次只读调用、模型一个字都没说，然后 PLANNING → FAILED，
   * 整个 Run 作废。
   *
   * 根因不是"20 太小"（这个数刚从写死的 12 改成预算的一半，放宽过了还是撞墙）。
   * 根因是两条：
   *   1. **模型不知道有预算**。提示词说的是"读到足够的证据后"—— 一条没有终点的指令。
   *      模型按自己的"足够"探索，平台按 20 轮杀，两边不是同一把尺。
   *   2. **没有任何强制点**。第 20 轮和第 1 轮给模型看到的东西一模一样，
   *      它永远不会知道自己站在悬崖边。
   *
   * 所以修的是这两条，不是那个数字。
   */
  function planTurnsOf(maxModelTurns: number): number {
    return Math.max(2, Math.floor(maxModelTurns / 2));
  }

  it('系统提示词说出轮次预算，并预告最后一轮会被收窄', async () => {
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));
    host.planDecision = 'REJECT';

    await run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 12 } }));

    const system = gateway.calls[0]!.system;
    expect(system).toContain('规划的轮次预算是 **6 轮**');
    expect(system).toContain('最后一轮平台只会留下 submit_plan');
  });

  it('每一轮的工具结果后面挂倒计时 —— 模型据此自己收敛', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel((n) =>
      n === 1 ? toolUse('fs_read', { path: 'src/a.ts' }) : toolUse('submit_plan', VALID_PLAN),
    );

    await run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 8 } }));

    // 第 2 次调用看到的最后一条消息里带着"还剩 N 轮"
    expect(gateway.lastMessageText(2)).toContain('规划还剩 3 轮');
  });

  it('最后一轮：工具被收窄到只剩 submit_plan，且明说这是最后一轮', async () => {
    /*
     * 这是整条修复的关键。模型即使一直想读，最后一轮也**读不到** ——
     * 不是靠提示词请求它收手，是结构上没有别的工具可用。
     */
    host.planDecision = 'REJECT';
    const maxModelTurns = 6; // → 3 轮规划
    const gateway = new ScriptedModel((n) =>
      n < planTurnsOf(maxModelTurns)
        ? toolUse('fs_read', { path: 'src/a.ts' })
        : toolUse('submit_plan', VALID_PLAN),
    );

    await run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns } }));

    const planningCalls = gateway.calls.filter((c) => c.purpose === 'PLANNING');
    expect(planningCalls).toHaveLength(3);
    // 前两轮工具齐全，最后一轮只剩 submit_plan
    expect(planningCalls[0]!.tools.map((t) => t.name)).toContain('fs_read');
    expect(planningCalls[2]!.tools.map((t) => t.name)).toEqual(['submit_plan']);
    expect(gateway.lastMessageText(3)).toContain('最后一轮');
    // 并且告诉它没查完的怎么办 —— 否则它会为了凑完整而编
    expect(gateway.lastMessageText(3)).toContain('risks');
  });

  it('一直只读的模型现在能出计划了 —— 同一个剧本，旧逻辑下是全盘作废', async () => {
    /*
     * 剧本刻意复刻真实样本：模型只会读，从不主动提交。
     * 旧逻辑：用满全部轮次 → PlanningFailed → Run FAILED，探索全丢。
     * 新逻辑：最后一轮它手上只有 submit_plan，于是交出一份计划交给人判断。
     */
    host.planDecision = 'APPROVE';
    workspace.changed = ['src/a.ts'];
    let readCount = 0;
    const gateway = new ScriptedModel((_n, input) => {
      if (input.purpose !== 'PLANNING') return endTurn('改完了');
      // 只有 submit_plan 可用时才提交 —— 模拟"给什么用什么"的模型
      const only = input.request.tools.length === 1 && input.request.tools[0]!.name === 'submit_plan';
      if (only) return toolUse('submit_plan', VALID_PLAN);
      readCount += 1;
      return toolUse('fs_read', { path: 'src/a.ts' });
    });

    const result = await run(gateway, makeTask({ verificationCommandIds: [], budget: { ...makeTask().budget, maxModelTurns: 8 } }));

    expect(result.kind).toBe('PATCH_READY');
    expect(readCount).toBe(3); // 4 轮规划里前 3 轮在读，第 4 轮被强制收口
    expect(host.planApprovals).toBe(1);
  });

  it('没有验证命令时不让模型去找"根因" —— 那是一个不存在的东西', async () => {
    /*
     * 真实样本的任务是「你能找出部分优化的点吗」：未验证模式、没有失败、没有根因。
     * 而提示词写的是"把失败原因搞清楚""计划要说清根因"。
     * 模型被要求去找一个不存在的失败原因，于是它一直读下去。
     */
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));

    await run(gateway, makeTask({ verificationCommandIds: [] }));
    const system = gateway.calls[0]!.system;
    expect(system).toContain('没有失败可以复现');
    expect(system).not.toContain('把失败原因搞清楚');

    // 对照：有验证命令时仍然要求说清根因
    host.statuses.length = 0;
    const g2 = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));
    await run(g2, makeTask({ verificationCommandIds: ['red'] }));
    expect(g2.calls[0]!.system).toContain('把失败原因搞清楚');
  });
});

describe('规划触顶时封存探索账目：失败不等于这一趟白跑', () => {
  /**
   * 规划失败此前等于全盘作废：用户看到的只有一行红字，那几十次调用读到的东西
   * 全在折叠区里，要一条条展开才知道模型看过哪儿。
   *
   * 这份账目不回答"为什么失败"（那是 PlanningFailed 那条的事），它回答
   * **这一趟到底看了哪儿** —— 用户据此判断是模型找错了地方，还是任务本身太宽。
   *
   * 它是**平台汇总的事实**，一个字都不是模型的结论；也刻意不再调一次模型去写总结：
   * 一个刚拒绝收口的模型不是可信的总结者，而且那要在已经失败的 Run 上再花一次钱。
   */
  const digest = () =>
    host.events.find((e) => e.kind === 'NOTE' && e.summary.startsWith('规划没有收口'));

  /** 只读、从不提交的模型 —— 复刻真实样本 */
  const alwaysReads = (paths: string[]) =>
    new ScriptedModel((n) => toolUse('fs_read', { path: paths[(n - 1) % paths.length]! }));

  it('触顶时发出账目：轮数、调用数、读过哪些文件都如实报出', async () => {
    const gateway = alwaysReads(['src/a.ts', 'src/b.ts']);
    await expect(
      run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 6 } })),
    ).rejects.toThrow(/规划阶段用满/);

    const note = digest();
    expect(note).toBeTruthy();
    expect(note!.summary).toContain('3 轮规划');
    expect(note!.summary).toContain('读文件 ×2');
    expect(note!.summary).toContain('读取 src/a.ts');
    expect(note!.summary).toContain('读取 src/b.ts');
    // 结构化副本供将来的界面消费，正文供人读
    expect(note!.payload.planningDigest).toMatchObject({ turns: 3, spokenTurns: 0 });
  });

  it('同一个文件读了多次 → 去重并报出重复次数（省略要报数）', async () => {
    const gateway = alwaysReads(['src/a.ts']);
    await expect(
      run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 8 } })),
    ).rejects.toThrow(/规划阶段用满/);

    // 4 轮规划，最后一轮被平台拒 → 3 次读同一个文件，去重成 1 个目标
    expect(digest()!.summary).toContain('3 次只读调用：读文件 ×3');
    expect(digest()!.summary).toContain('去重后 1 个目标');
    /*
     * src/a.ts 在夹具里并不存在，三次都读失败。落空必须单独报出来 ——
     * 把读不到的路径列在"读过的文件"里而不加区分，就是把一次落空说成一次探索，
     * 而"它一直在读不存在的路径"恰恰是最有用的那条线索。
     */
    expect(digest()!.summary).toContain('其中 3 次调用失败，没有读到内容');
  });

  it('"模型全程没说过话"要被点名 —— 那是信号最强的一条', async () => {
    const gateway = alwaysReads(['src/a.ts']);
    await expect(run(gateway, makeTask())).rejects.toThrow(/规划阶段用满/);
    expect(digest()!.summary).toContain('全程没有输出任何文字');
  });

  it('说过话就报几轮说过，不谎称沉默', async () => {
    const gateway = new ScriptedModel(() => ({
      content: [
        { type: 'text', text: '我再看看这个文件。' },
        { type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2, 8)}`, name: 'fs_read', input: { path: 'src/a.ts' } },
      ],
      stopReason: 'TOOL_USE',
      inputTokens: 10,
      outputTokens: 5,
    }));
    await expect(
      run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 6 } })),
    ).rejects.toThrow(/规划阶段用满/);

    // 3 轮规划：前 2 轮读+说，最后一轮只剩 submit_plan（模型仍回了文本）
    expect(digest()!.summary).toMatch(/模型在 3\/3 轮里说过话/);
    expect(digest()!.summary).not.toContain('全程没有输出');
  });

  it('顺利提交计划时不发账目 —— 它是失败时的交代，不是每次都吵一遍', async () => {
    host.planDecision = 'REJECT';
    const gateway = new ScriptedModel(() => toolUse('submit_plan', VALID_PLAN));
    await run(gateway, makeTask());
    expect(digest()).toBeUndefined();
  });

  it('被阶段闸门拒掉的调用不算"看过" —— 它根本没执行', async () => {
    /*
     * 规划期点名 workspace_mutate 会被平台强制只读挡下。那次调用有记录、有报数，
     * 但它**什么都没读到**，混进"读过的文件"里就是把一次拒绝说成一次探索。
     */
    const gateway = new ScriptedModel((n) =>
      n % 2 === 1
        ? toolUse('workspace_mutate', {
            operations: [{ kind: 'CREATE_FILE', path: 'src/x.ts', newText: 'x' }],
          })
        : toolUse('fs_read', { path: 'src/a.ts' }),
    );
    await expect(
      run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 8 } })),
    ).rejects.toThrow(/规划阶段用满/);

    const note = digest()!;
    expect(note.summary).not.toContain('workspace_mutate');
    // 4 轮里：第 1、3 轮被拒，第 2 轮读到一次，第 4 轮只剩 submit_plan
    expect(note.payload.planningDigest).toMatchObject({ toolCalls: 1 });
  });
});

describe('最后一轮的收窄是平台闸门，不只是"少给几个 schema"', () => {
  /**
   * 规划期只读闸门当年栽过一次：`PLANNING_TOOLS` 决定的是模型**看得见**什么，
   * 而 `dispatchTool` 查的是全局 `TOOLS_BY_NAME` —— 模型凭记忆点名一个没给它的
   * 工具，之前就会真的执行。
   *
   * 最后一轮的强制收口有同样的陷阱：只把 schema 列表收窄成 [submit_plan]，
   * 一个不听话的模型照样能接着 fs_read 到超时，而"强制收口"就成了纸面上的。
   * 所以这一条钉的是**平台真的拒了**，不是"模型没看见"。
   */
  it('模型在最后一轮凭记忆点名 fs_read → 平台 DENIED，且留下记录', async () => {
    // 全程只会 fs_read，从不理会平台给了哪些工具
    // hello.txt 是夹具里真实存在的文件 —— 第一轮必须真的读成功，否则测不出"第二轮才被拒"
    const gateway = new ScriptedModel(() => toolUse('fs_read', { path: 'hello.txt' }));

    await expect(
      run(gateway, makeTask({ budget: { ...makeTask().budget, maxModelTurns: 4 } })),
    ).rejects.toThrow(/规划阶段用满/);

    // 2 轮规划：第 1 轮真的读了，第 2 轮（最后一轮）被平台拒
    const reads = host.toolCalls.filter((t) => t.toolName === 'fs_read');
    expect(reads).toHaveLength(2);
    expect(reads[0]!.resolution).toBe('SUCCEEDED');
    expect(reads[1]!.resolution).toBe('DENIED');
    expect(reads[1]!.reason).toBe('TURN_TOOL_RESTRICTED');

    // 拒绝要说清楚"现在该干什么"，否则模型只会换个工具名再试一次
    expect(gateway.lastMessageText(2)).toContain('submit_plan');
    expect(gateway.lastMessageText(2)).toContain('risks');

    // 被拒的那次不算"看过"——它什么都没读到
    const note = host.events.find((e) => e.kind === 'NOTE' && e.summary.startsWith('规划没有收口'));
    expect(note!.payload.planningDigest).toMatchObject({ toolCalls: 1 });
  });
});
