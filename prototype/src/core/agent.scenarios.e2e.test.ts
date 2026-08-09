import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEventKind,
  RunStatus,
  PlanRevision,
  TaskSpec,
  ToolCallResolution,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { type AgentHost, type ModelInvoker, runAgent } from './agent';
import type { ModelResponse } from './model/types';
import { findWireViolation } from './model/types';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { sealPatch } from './patch';
import { ensureDataRoot, snapshotDir } from './paths';
import { importSnapshot, resolveProfile } from './repo';
import { compareVerification } from './verify';
import { MaterializedWorkspace } from './workspace';

/**
 * 端到端「非幸福路径」场景补充。
 *
 * agent.e2e.test.ts 证明的是"一切顺利时链路是通的"。真正会咬人的是另外四件事：
 *   1. 用户按下拒绝之后，平台有没有真的一个字节都没动；
 *   2. 模型提交了不合法的改动时，是不是**整笔**回退、并把可纠正的原因还给模型；
 *   3. 没有验证命令时，平台会不会悄悄把"没验证"说成"验证过了"；
 *   4. 自修复轮次是不是被真实的验证失败驱动的，而不是被 spawn 错误蒙对的。
 *
 * 这四条都是「产品承诺 vs 实现」最容易脱节的地方，所以每条都断言到**原因**，
 * 而不只是断言终态枚举值。
 *
 * 关于数据根：MaterializedWorkspace / importSnapshot 把路径硬编码在 DATA_ROOT 上，
 * 没有注入点。但 runId / snapshotId 都是 UUID 派生的，并行跑不可能撞名；
 * 每条用例结束时删掉自己那两棵子树。宿主 fixture 一律用 mkdtemp 副本。
 */

const FIXTURE_SOURCE = resolve(__dirname, '../../fixtures/vite-react-broken');

/** CartSummary.tsx 里把 DiscountResult 当 number 用的那一行（构建失败的根因） */
const BROKEN_LINE = '  const total = applyDiscount(subtotal, discountCode);';
/** 正确的修法：解构出 amount */
const FIXED_LINE = '  const { amount: total } = applyDiscount(subtotal, discountCode);';
/**
 * 一个"看起来像修好了、其实换了个错"的改法：类型标注成 number 仍然 TS2322。
 * 用它来制造第一轮自修复 —— 必须是真的类型错误，否则测不出自修复是被真实失败驱动的。
 */
const WRONG_FIX_LINE = '  const total: number = applyDiscount(subtotal, discountCode);';
/** 在 CartSummary.tsx 中恰好出现两次（小计行 + 合计行），用来触发 MULTIPLE_MATCH */
const AMBIGUOUS_OLD_TEXT = '<dd>{formatMoney(';

const CART_SUMMARY = 'src/components/CartSummary.tsx';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/**
 * 把 fixture 复制到临时目录，在**副本**里初始化 git。
 * 与 agent.e2e.test.ts 里是同一套做法，但刻意复制而不是 import：
 * 这两个文件会各自演化，共享夹具会让其中一个的改动无声地改变另一个的语义。
 */
function materializeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-scen-'));
  cpSync(FIXTURE_SOURCE, dir, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)$/.test(src),
  });
  symlinkSync(join(FIXTURE_SOURCE, 'node_modules'), join(dir, 'node_modules'), 'dir');

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    '-c',
    'user.email=fixture@local',
    '-c',
    'user.name=fixture',
    'commit',
    '-q',
    '-m',
    'cart: 引入 DiscountResult 重构（CartSummary 未同步更新，构建失败）',
  ]);
  return dir;
}

interface Harness {
  readonly hostPath: string;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  readonly workspace: MaterializedWorkspace;
  readonly task: TaskSpec;
  readonly runId: string;
  readonly attemptId: string;
  /** 运行前的工作区树摘要，用于断言失败路径"逐字节不变" */
  readonly treeDigestBefore: string;
  dispose(): void;
}

function setupHarness(verificationCommandIds: string[]): Harness {
  if (!existsSync(join(FIXTURE_SOURCE, 'node_modules'))) {
    throw new Error(
      'fixture 依赖未安装。先执行：cd prototype/fixtures/vite-react-broken && npm install',
    );
  }
  ensureDataRoot();

  const hostPath = materializeFixture();
  const snapshot = importSnapshot('proj_scen', hostPath);
  const profile = resolveProfile(snapshot);
  const runId = newId('run');
  const attemptId = newId('att');
  const workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId, hostPath);

  const task: TaskSpec = {
    taskId: newId('task'),
    projectId: 'proj_scen',
    snapshotId: snapshot.snapshotId,
    profileId: profile.profileId,
    goal: '修复 npm run build 失败：CartSummary 把 DiscountResult 当成 number 用了',
    taskClass: 'BUILD_FAILURE_FIX',
    allowedPaths: ['src/**'],
    protectedPaths: profile.protectedPaths,
    nonGoals: [],
    acceptance: ['不修改 pricing.ts 的公开签名'],
    verificationCommandIds,
    budget: {
      maxModelTurns: 20,
      maxToolCalls: 30,
      maxSelfFixRounds: 2,
      maxWallClockMs: 10 * 60 * 1000,
      maxTotalTokens: 100_000,
    },
    createdAt: nowIso(),
  };

  return {
    hostPath,
    snapshot,
    profile,
    workspace,
    task,
    runId,
    attemptId,
    treeDigestBefore: workspace.treeDigest(),
    dispose() {
      workspace.cleanup();
      rmSync(snapshotDir(snapshot.snapshotId), { recursive: true, force: true });
      rmSync(hostPath, { recursive: true, force: true });
    },
  };
}

function drive(h: Harness, gateway: ModelInvoker, host: AgentHost) {
  return runAgent({
    task: h.task,
    snapshot: h.snapshot,
    profile: h.profile,
    workspace: h.workspace,
    gateway,
    resolution: {
      resolutionId: 'route_test',
      profileId: 'profile_test_only_fake',
      providerId: 'ANTHROPIC_OFFICIAL',
      origin: 'https://api.anthropic.com',
      modelId: 'TEST_ONLY_FAKE',
      frozenAt: nowIso(),
      digest: digestOf({ test: true }),
    },
    mutationPolicy: {
      ...DEFAULT_MUTATION_POLICY,
      allowedPaths: h.task.allowedPaths,
      protectedPaths: h.task.protectedPaths,
    },
    runId: h.runId,
    attemptId: h.attemptId,
    signal: new AbortController().signal,
    host,
  });
}

/** 宿主仓库自始至终只读 —— 每条用例都必须过这一关 */
function expectHostUntouched(hostPath: string): void {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: hostPath,
    encoding: 'utf8',
  }).trim();
  expect(status).toBe('');
}

// ---------------------------------------------------------------------------

describe('端到端场景：拒绝 / 冲突 / 未验证 / 自修复', () => {
  it(
    '用户拒绝计划：结果是 PLAN_REJECTED，且工作区与宿主都零改动',
    async () => {
      const h = setupHarness(['build']);
      try {
        // 规划阶段只要读一次文件就提交计划；执行阶段的脚本**故意留空** ——
        // 一旦被拒绝之后还有模型调用，ScriptedModel 会直接抛错而不是静默继续。
        const model = new ScriptedModel([
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          () => submitPlanCall(),
        ]);
        const host = new Recorder('REJECT');

        const result = await drive(h, model, host);

        expect(result.kind).toBe('PLAN_REJECTED');
        expect(result.finalVerification).toBeNull();

        // 基线必须是"真的构建失败"。若这里是 SPAWN_ERROR，说明整条用例
        // 其实什么都没验证到 —— passed=false 会说谎，outcome 不会。
        const baselineBuild = result.baseline!.commands.find((c) => c.commandId === 'build')!;
        expect(baselineBuild.outcome).toBe('EXIT_NONZERO');
        expect(`${baselineBuild.stdoutPreview}${baselineBuild.stderrPreview}`).toContain('TS2345');

        // 审批确实走了流程：状态进过 AWAITING_PLAN_APPROVAL，且拿到的是结构化计划
        expect(host.statuses).toContain('AWAITING_PLAN_APPROVAL');
        expect(host.planSeen!.steps.length).toBeGreaterThan(0);
        expect(host.planSeen!.verificationCommandIds).toEqual(['build']);
        expect(host.events.some((e) => e.kind === 'PLAN_DECISION' && e.summary.includes('拒绝'))).toBe(
          true,
        );

        // 拒绝之后模型不该再被调用一次（脚本恰好用完 2 步）
        expect(model.consumed).toBe(2);

        // ---- 零副作用：三个独立角度各查一遍 ----
        // 1) 规划阶段被平台限制为只读，压根没有 R1 工具被派发
        expect(host.toolCalls.filter((t) => t.risk !== 'R0')).toHaveLength(0);
        // 2) generation 没推进，连 staged 目录都不存在
        expect(h.workspace.activeGeneration).toBe(0);
        expect(existsSync(h.workspace.generationPath(1))).toBe(false);
        // 3) 整棵树逐字节未变（跑过一次基线构建也不例外）
        expect(h.workspace.treeDigest()).toBe(h.treeDigestBefore);
        expect(h.workspace.changedVsBaseline()).toEqual({ authored: [], generated: [], deleted: [] });
        expect(h.workspace.readText(CART_SUMMARY)).toContain(BROKEN_LINE);

        expectHostUntouched(h.hostPath);
      } finally {
        h.dispose();
      }
    },
    600_000,
  );

  it(
    'oldText 命中多次：整笔 mutation 被拒，模型收到 MULTIPLE_MATCH，generation 不推进',
    async () => {
      const h = setupHarness(['build']);
      try {
        const model = new ScriptedModel([
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          () => submitPlanCall(),
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          // 只给了 `<dd>{formatMoney(` —— 在文件里出现两次。平台不该做模糊匹配，
          // 也不该"取第一处"，而应该整笔拒绝。
          (ctx) =>
            toolUse('workspace_mutate', {
              operations: [
                {
                  kind: 'REPLACE_EXACT_TEXT_SPAN',
                  path: CART_SUMMARY,
                  receiptId: requireReceipt(ctx.lastUserText),
                  oldText: AMBIGUOUS_OLD_TEXT,
                  newText: '<dd>{formatMoney(',
                },
              ],
            }),
          () => endTurn('oldText 不唯一，我这次不改了。'),
        ]);
        const host = new Recorder('APPROVE');

        const result = await drive(h, model, host);

        // 模型放弃后没有任何文件变更 → 平台如实报 NO_CHANGES，而不是硬造一个补丁
        expect(result.kind).toBe('NO_CHANGES');

        // 工具调用的判定必须是 FAILED + MULTIPLE_MATCH。
        // 只断言 ok=false 会说谎：schema 不合法、receipt 过期、路径越界都会 FAILED。
        const mutateCalls = host.toolCalls.filter((t) => t.toolName === 'workspace_mutate');
        expect(mutateCalls).toHaveLength(1);
        expect(mutateCalls[0]!.resolution).toBe('FAILED');
        expect(mutateCalls[0]!.reason).toBe('MULTIPLE_MATCH');

        // 模型必须真的收到可纠正的反馈：既知道原因，也知道"整笔未生效"。
        // 只把失败塞进事件流而不回给模型，模型会以为改成功了继续往下走。
        const feedback = model.seenUserTexts.find((t) => t.includes('MULTIPLE_MATCH'));
        expect(feedback).toBeDefined();
        expect(feedback!).toContain('整笔未生效');
        expect(feedback!).toContain('gen-0');

        // 失败不产生 MUTATION_APPLIED 事件 —— 事件流不能出现"改过了"的假证据
        expect(host.events.some((e) => e.kind === 'MUTATION_APPLIED')).toBe(false);

        // ---- 失败 = 零写入 ----
        expect(h.workspace.activeGeneration).toBe(0);
        // 校验在内存模拟阶段就失败了，staged 目录根本没被建出来
        expect(existsSync(h.workspace.generationPath(1))).toBe(false);
        expect(h.workspace.treeDigest()).toBe(h.treeDigestBefore);
        expect(h.workspace.readText(CART_SUMMARY)).toContain(BROKEN_LINE);

        expectHostUntouched(h.hostPath);
      } finally {
        h.dispose();
      }
    },
    600_000,
  );

  it(
    '未验证模式：baseline/finalVerification 均为 null，且补丁被标注为未验证',
    async () => {
      // verificationCommandIds 为空，但 profile 本身解析出了 build/test/typecheck ——
      // 这正是最危险的组合：平台有能力验证却没验证，必须把这件事说出来。
      const h = setupHarness([]);
      try {
        expect(Object.keys(h.profile.commands).sort()).toEqual(['build', 'test', 'typecheck']);

        const model = new ScriptedModel([
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          () => submitPlanCall(),
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          (ctx) => replaceLine(ctx.lastUserText, BROKEN_LINE, FIXED_LINE),
          () => endTurn('已解构 amount；没有验证命令，我无法证明构建通过。'),
        ]);
        const host = new Recorder('APPROVE');

        const result = await drive(h, model, host);

        expect(result.kind).toBe('PATCH_READY');
        // 关键：不能拿"改动前后都没跑过"的空对象冒充一次通过的验证
        expect(result.baseline).toBeNull();
        expect(result.finalVerification).toBeNull();
        expect(result.detail).toContain('没有任何机器验证');

        // 一次验证命令都不该被执行 —— 事件流和工具流两边都查
        expect(
          host.events.filter(
            (e) => e.kind === 'VERIFICATION_STARTED' || e.kind === 'VERIFICATION_FINISHED',
          ),
        ).toHaveLength(0);
        expect(host.toolCalls.some((t) => t.toolName === 'run_command')).toBe(false);
        expect(host.events.some((e) => e.kind === 'NOTE' && e.summary.includes('未验证模式'))).toBe(
          true,
        );

        // 警示项要说清两件事：这次没验证；以及"其实本来可以验证"
        expect(result.unverifiedItems.some((i) => i.includes('没有执行任何验证命令'))).toBe(true);
        const couldHave = result.unverifiedItems.find((i) => i.includes('可用命令'));
        expect(couldHave).toBeDefined();
        for (const id of ['build', 'test', 'typecheck']) {
          expect(couldHave!).toContain(id);
          expect(result.unverifiedItems.some((i) => i.includes(`命令 "${id}" 未被本次任务纳入`))).toBe(
            true,
          );
        }

        // 改动确实落了盘，但因为没跑命令，不该有任何构建产物
        expect(h.workspace.activeGeneration).toBe(1);
        expect(h.workspace.readText(CART_SUMMARY)).toContain(FIXED_LINE);
        expect(h.workspace.changedVsBaseline()).toEqual({ authored: [CART_SUMMARY], generated: [], deleted: [] });

        // 未验证的补丁也能封存，但必须自己承认没有验证依据
        const patch = sealPatch(
          h.workspace,
          h.runId,
          h.attemptId,
          h.snapshot.baseSha,
          null,
          null,
          result.unverifiedItems,
        );
        expect(patch.verificationRunId).toBeNull();
        expect(patch.comparison).toBeNull();
        expect(patch.files.map((f) => f.path)).toEqual([CART_SUMMARY]);
        expect(patch.excludedGeneratedFiles).toEqual([]);
        expect(patch.unverifiedItems.some((i) => i.includes('没有执行任何验证命令'))).toBe(true);

        expectHostUntouched(h.hostPath);
      } finally {
        h.dispose();
      }
    },
    600_000,
  );

  it(
    '自修复：第一次改动仍然构建失败，第二轮改对，SELF_FIX_ROUND 由真实失败驱动',
    async () => {
      const h = setupHarness(['build']);
      try {
        const model = new ScriptedModel([
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          () => submitPlanCall(),
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          // 第一次改动：换了个类型错误（TS2322），构建照样失败
          (ctx) => replaceLine(ctx.lastUserText, BROKEN_LINE, WRONG_FIX_LINE),
          () => endTurn('已加上 number 类型标注。'),
          // 提交后 receipt 随切代作废，第二轮必须重新读文件
          () => toolUse('fs_read', { path: CART_SUMMARY }),
          (ctx) => replaceLine(ctx.lastUserText, WRONG_FIX_LINE, FIXED_LINE),
          () => endTurn('改为解构 amount，这次类型对上了。'),
        ]);
        const host = new Recorder('APPROVE');

        const result = await drive(h, model, host);

        expect(result.kind).toBe('PATCH_READY');
        expect(model.consumed).toBe(8);

        // 恰好一轮自修复，且账本记了一次（预算是单调账本，不能漏记）
        const selfFix = host.events.filter((e) => e.kind === 'SELF_FIX_ROUND');
        expect(selfFix).toHaveLength(1);
        expect(selfFix[0]!.payload?.round).toBe(1);
        expect(host.ledger.selfFixRounds).toBe(1);

        // 这一轮必须是被**真实的类型错误**触发的。
        // 若第一次 POST_MUTATION 是 SPAWN_ERROR，自修复照样会发生，但那时
        // 测的就不是"模型改错了"而是"环境坏了" —— 所以断言卡在 outcome + 错误码上。
        const postRuns = host.events
          .filter((e) => e.kind === 'VERIFICATION_FINISHED' && e.payload?.phase === 'POST_MUTATION')
          .map((e) => e.payload!.verification as VerificationRun);
        expect(postRuns).toHaveLength(2);

        const firstAttempt = postRuns[0]!.commands.find((c) => c.commandId === 'build')!;
        expect(firstAttempt.outcome).toBe('EXIT_NONZERO');
        expect(`${firstAttempt.stdoutPreview}${firstAttempt.stderrPreview}`).toContain('TS2322');
        expect(postRuns[0]!.passed).toBe(false);
        expect(postRuns[0]!.generation).toBe(1);

        // 第二轮是真的 exit 0，而且跑在推进后的 generation 上
        const secondAttempt = postRuns[1]!.commands.find((c) => c.commandId === 'build')!;
        expect(secondAttempt.outcome).toBe('EXIT_ZERO');
        expect(secondAttempt.exitCode).toBe(0);
        expect(postRuns[1]!.generation).toBe(2);
        expect(result.finalVerification!.passed).toBe(true);
        expect(result.finalVerification!.verificationRunId).toBe(postRuns[1]!.verificationRunId);

        // 基线仍然是原始的 TS2345，没有被中途覆盖
        const baselineBuild = result.baseline!.commands.find((c) => c.commandId === 'build')!;
        expect(baselineBuild.outcome).toBe('EXIT_NONZERO');
        expect(`${baselineBuild.stdoutPreview}${baselineBuild.stderrPreview}`).toContain('TS2345');

        // 两次 mutation 都成功提交，工作区停在 gen-2
        const mutateCalls = host.toolCalls.filter((t) => t.toolName === 'workspace_mutate');
        expect(mutateCalls.map((t) => t.resolution)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
        expect(h.workspace.activeGeneration).toBe(2);
        expect(h.workspace.readText(CART_SUMMARY)).toContain(FIXED_LINE);
        // 中间那个错误改法不能有残留
        expect(h.workspace.readText(CART_SUMMARY)).not.toContain(WRONG_FIX_LINE);

        // 对比分类：修好了 build，没有新弄坏别的
        const comparison = compareVerification(result.baseline!, result.finalVerification!);
        expect(comparison.fixed).toEqual(['build']);
        expect(comparison.stillFailing).toEqual([]);
        expect(comparison.newlyFailing).toEqual([]);

        expectHostUntouched(h.hostPath);
      } finally {
        h.dispose();
      }
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// 确定性模型替身：按队列逐步回应，脚本用尽即抛错
// ---------------------------------------------------------------------------

interface ScriptContext {
  readonly lastUserText: string;
  readonly purpose: string;
}

type Responder = (ctx: ScriptContext) => ModelResponse;

/**
 * 与 agent.e2e.test.ts 里那个按内容嗅探的替身不同，这里用**显式步骤队列**。
 *
 * 理由：这几条用例要断言"模型被调用了几次"和"第几次收到了什么"。嗅探式替身
 * 在多跑或少跑一轮时会自我修复（继续返回同一个动作），把回归悄悄吃掉；
 * 队列式会在步数对不上时直接炸，并把当时的上下文打出来。
 */
class ScriptedModel implements ModelInvoker {
  readonly seenUserTexts: string[] = [];
  private index = 0;

  constructor(private readonly script: readonly Responder[]) {}

  get consumed(): number {
    return this.index;
  }

  async invoke(input: Parameters<ModelInvoker['invoke']>[0]) {
    // 真实 provider 会对孤儿 tool_use 返回 400，测试替身不会 —— 所以这里
    // 主动用与网关同一个校验器把关，否则这类回归在测试里是静默的。
    const orphan = findWireViolation(input.request.messages);
    if (orphan) throw new Error(`${input.purpose} 调用收到非法消息序列：${orphan}`);
    const messages = input.request.messages;
    const lastUserText = JSON.stringify(messages[messages.length - 1]?.content ?? '');
    this.seenUserTexts.push(lastUserText);

    const responder = this.script[this.index];
    if (!responder) {
      throw new Error(
        `模型脚本已耗尽：这是第 ${this.index + 1} 次调用（purpose=${input.purpose}），` +
          `但脚本只有 ${this.script.length} 步。最后收到的上下文：${lastUserText.slice(0, 500)}`,
      );
    }
    this.index += 1;
    const response = responder({ lastUserText, purpose: input.purpose });

    return {
      invocationId: `inv_fake_${this.index}`,
      response,
      manifest: {
        invocationId: `inv_fake_${this.index}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: input.resolution.providerId,
        origin: input.resolution.origin,
        modelId: 'TEST_ONLY_FAKE',
        sent: false,
        blockReason: 'TEST_ONLY_FAKE_NO_EGRESS',
        contextFileRefs: [],
        inputTokens: 100,
        outputTokens: 50,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }
}

let toolUseSeq = 0;

function toolUse(name: string, input: unknown): ModelResponse {
  toolUseSeq += 1;
  return {
    content: [{ type: 'tool_use', id: `tu_${name}_${toolUseSeq}`, name, input }],
    stopReason: 'TOOL_USE',
    inputTokens: 100,
    outputTokens: 50,
  };
}

function endTurn(text: string): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'END_TURN',
    inputTokens: 100,
    outputTokens: 20,
  };
}

function submitPlanCall(): ModelResponse {
  return toolUse('submit_plan', {
    summary:
      'applyDiscount 已改为返回 DiscountResult，但 CartSummary 仍把它当 number 传给 formatMoney。',
    steps: [
      {
        intent: '在 CartSummary 中解构 applyDiscount 的返回值，取 amount',
        targetPaths: [CART_SUMMARY],
        expectedEffect: 'tsc 类型错误消失，build 通过',
      },
    ],
    risks: ['若其他调用点也有同样问题，本次修改不覆盖'],
  });
}

function replaceLine(lastUserText: string, oldText: string, newText: string): ModelResponse {
  return toolUse('workspace_mutate', {
    operations: [
      {
        kind: 'REPLACE_EXACT_TEXT_SPAN',
        path: CART_SUMMARY,
        receiptId: requireReceipt(lastUserText),
        oldText,
        newText,
      },
    ],
  });
}

/**
 * 从上一条工具结果里取 receiptId。取不到就抛 —— 拿不到 receipt 却继续提交 mutation
 * 会让用例以 RECEIPT_MISSING 失败，那是个误导性的红灯。
 */
function requireReceipt(text: string): string {
  const m = /receiptId=(rcpt_[a-z0-9]+)/.exec(text);
  if (!m?.[1]) {
    throw new Error(`脚本期望上一步返回 receiptId，但上下文里没有：${text.slice(0, 300)}`);
  }
  return m[1];
}

// ---------------------------------------------------------------------------
// AgentHost 录音机
// ---------------------------------------------------------------------------

interface RecordedCall {
  toolName: string;
  risk: ToolRisk;
  argsSummary: string;
  resolution?: ToolCallResolution;
  reason?: string | null;
  preview?: string;
}

interface RecordedEvent {
  kind: RunEventKind;
  summary: string;
  payload?: Record<string, unknown>;
}

class Recorder implements AgentHost {
  readonly events: RecordedEvent[] = [];
  readonly toolCalls: RecordedCall[] = [];
  readonly statuses: RunStatus[] = [];
  readonly ledger = { modelTurns: 0, toolCalls: 0, selfFixRounds: 0 };
  planSeen: PlanRevision | null = null;

  constructor(private readonly decision: 'APPROVE' | 'REJECT') {}

  emit(kind: RunEventKind, summary: string, payload?: Record<string, unknown>): void {
    this.events.push({ kind, summary, payload });
  }

  setStatus(status: RunStatus): void {
    this.statuses.push(status);
  }

  async awaitPlanApproval(plan: PlanRevision): Promise<'APPROVE' | 'REJECT'> {
    this.planSeen = plan;
    return this.decision;
  }

  beginToolCall(input: { toolName: string; risk: ToolRisk; argsSummary: string }): string {
    const id = `tc_${this.toolCalls.length}`;
    this.toolCalls.push({
      toolName: input.toolName,
      risk: input.risk,
      argsSummary: input.argsSummary,
    });
    return id;
  }

  endToolCall(
    toolCallId: string,
    resolution: ToolCallResolution,
    reason: string | null,
    preview: string,
  ): void {
    const call = this.toolCalls[Number(toolCallId.split('_')[1])];
    if (call) {
      call.resolution = resolution;
      call.reason = reason;
      call.preview = preview;
    }
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
    if (this.ledger.modelTurns > 30) return { exceeded: true, reason: '测试上限' };
    return { exceeded: false, reason: '' };
  }
}
