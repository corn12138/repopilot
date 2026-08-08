import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  issueReceipt(rel: string): { content: string; receipt: MutationReadReceipt } {
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
  readonly events: Array<{ kind: RunEventKind; summary: string }> = [];
  readonly statuses: Array<{ status: RunStatus; reason: string | null }> = [];
  readonly toolCalls: RecordedToolCall[] = [];
  readonly ledger = { modelTurns: 0, toolCalls: 0, selfFixRounds: 0 };
  planDecision: 'APPROVE' | 'REJECT' = 'APPROVE';
  planApprovals = 0;
  /** 模型轮次达到这个数就判定预算耗尽（模拟 authority 里的 ledger >= limit 语义） */
  budgetAfterModelTurns = Number.POSITIVE_INFINITY;

  emit(kind: RunEventKind, summary: string): void {
    this.events.push({ kind, summary });
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
    });
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
    expect(host.toolCalls).toHaveLength(0);
    expect(host.ledger.toolCalls).toBe(0);
    expect(ranCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 规划阶段的轮次上界
// ---------------------------------------------------------------------------

describe('规划阶段不会无限重试', () => {
  it('模型只回文本不调 submit_plan：每轮都被要求重提，用满轮次后抛 PlanningFailed', async () => {
    const gateway = new ScriptedModel(() => endTurn('我觉得这个 bug 挺简单的，直接改就行。'));
    const task = makeTask({
      budget: { ...makeTask().budget, maxModelTurns: 3 },
    });

    await expect(run(gateway, task)).rejects.toThrow(/规划阶段用满 3 轮仍未提交计划/);

    expect(gateway.callCount).toBe(3);
    // 每次纯文本回复都要被顶回去，而不是静默重发同一段上下文
    expect(gateway.lastMessageText(2)).toContain('请调用 submit_plan 工具提交结构化计划');
    expect(gateway.lastMessageText(3)).toContain('请调用 submit_plan 工具提交结构化计划');

    expect(host.planApprovals).toBe(0);
    expect(host.kinds()).not.toContain('PLAN_GENERATED');
    expect(host.toolCalls).toHaveLength(0);
  });

  it('规划轮次还有一道与预算无关的硬上限 12', async () => {
    // maxModelTurns 给到 50，规划仍然只能用 12 轮 —— 否则一个死活不提交计划的模型
    // 可以把整个 token 预算烧在规划上。
    const gateway = new ScriptedModel(() => endTurn('再想想。'));
    const task = makeTask({ budget: { ...makeTask().budget, maxModelTurns: 50 } });

    await expect(run(gateway, task)).rejects.toThrow(/用满 12 轮/);
    expect(gateway.callCount).toBe(12);
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
