import { z } from 'zod';
import type {
  CrossReviewRound,
  CrossReviewVerdict,
  CrossReviewStopReason,
  ModelEgressManifest,
  ModelRouteResolution,
  PatchArtifact,
  PlanRevision,
  PlanStep,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  ReviewFinding,
  RunEventKind,
  RunStatus,
  TaskSpec,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import { CROSS_REVIEW_LIMITS } from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { EgressBlocked, InvocationFailed, ModelGateway } from './model/gateway';
import type {
  ContentBlock,
  ModelMessage,
  ModelResponse,
  StreamSignal,
  ToolSchema,
} from './model/types';
import {
  stopReasonAllowsToolExecution,
  stopReasonBlockLabel,
  textOf,
  toolUsesOf,
} from './model/types';
import type { MutationPolicy } from './mutation';
import { PLANNING_TOOLS, TOOLS, TOOLS_BY_NAME, type ToolContext, type ToolDefinition } from './tools';
import { summarizeShapes } from './repo';
import { compareVerification, runVerification, summarizeFailures, type CommandApprovalChecker } from './verify';
import type { MaterializedWorkspace } from './workspace';
import type { ModelDispatchAttempt } from './model/gateway';

export interface AgentHost {
  emit(kind: RunEventKind, summary: string, payload?: Record<string, unknown>): void;
  setStatus(status: RunStatus, reason: string | null): void;
  /** 阻塞直到用户对该计划作出决定；被取消时抛出 */
  awaitPlanApproval(plan: PlanRevision): Promise<
    'APPROVE' | 'REJECT' | { readonly decision: 'REVISE'; readonly note: string }
  >;
  beginToolCall(input: {
    toolName: string;
    risk: ToolRisk;
    argsSummary: string;
    argsDigest: string;
  }): string;
  endToolCall(
    toolCallId: string,
    resolution: import('@shared/domain').ToolCallResolution,
    reason: string | null,
    preview: string,
    previewTruncated: boolean,
    artifactRef: string | null,
    /**
     * 工具自报的结构化补充（ToolOutcome.meta）。可选而非必选：
     * 所有拒绝/取消路径都没有它，测试替身也不必一次性全改。
     * 目前唯一的消费者是 `meta.command` —— run_command 的终局判别联合。
     */
    meta?: Record<string, unknown>,
  ): void;
  /**
   * 模型正文的实时增量。可选：老的测试替身不实现它，那就退回一次性请求 ——
   * 有没有流不影响权威结果，只影响文本什么时候到界面。
   */
  streamText?(signal: StreamSignal): void;
  /** 在每次真实派发前持久化发送意图并消费一轮预算；失败必须阻止本次出站。 */
  reserveModelTurn(attempt: ModelDispatchAttempt): void;
  /** 为已经预留的派发补记 token；null 表示 provider 未回报，绝不折算成 0。 */
  settleModelTurn(inputTokens: number | null, outputTokens: number | null): void;
  chargeToolCall(): void;
  chargeSelfFixRound(): void;
  budgetExceeded(): { exceeded: boolean; reason: string };
}

/**
 * Agent Loop 只依赖"能发起一次受治理模型调用"这一个能力。
 * 生产用 ModelGateway；测试用确定性替身，从而在不接真实 API 的前提下
 * 对整条链路（规划→审批→工具→mutation→验证→封存）取机器证据。
 */
export type ModelInvoker = Pick<ModelGateway, 'invoke'>;

/** 出站前预算已经耗尽；与 provider/网络失败分开归因。 */
export class ModelDispatchBudgetExceeded extends Error {
  constructor(message: string, readonly modelInvocationDispatched = false) {
    super(message);
  }
}

/**
 * 外部作者（Codex / Claude CLI 当实现方）的编排接口。
 *
 * Loop 只看到这一个函数：给它一份简报，它回来的是**平台判定过的**结果 ——
 * candidate 被归一化采用（APPLIED，主线 generation 已前进）、没有变更、被拒绝、
 * 调用失败或取消。作者自己说了什么不在这个返回值里；那只是 authority 记进事件的备注。
 * 这样 runAgent 里"执行 → 验证 → 自修复 → 交叉审核整改"的循环对"谁在改"无知，
 * 与 reviewer 的 ReviewPassRunner 是同一个形状。
 */
export type ExternalAuthorOutcome =
  | { readonly kind: 'APPLIED'; readonly generation: number; readonly changedPaths: readonly string[] }
  | { readonly kind: 'NO_CHANGES' }
  | { readonly kind: 'REJECTED'; readonly reason: string; readonly detail: string }
  /** 调用层失败：BLOCKED / FAILED / TIMED_OUT —— candidate 已整笔丢弃 */
  | { readonly kind: 'FAILED'; readonly detail: string }
  | { readonly kind: 'CANCELLED' };

export type ExternalAuthorRunner = (input: {
  readonly phase: 'IMPLEMENT' | 'SELF_FIX' | 'REMEDIATE';
  readonly brief: string;
  readonly round: number;
}) => Promise<ExternalAuthorOutcome>;

/** 外部作者在整改/实现时调用失败或被拒 —— 交叉审核循环把它折叠成 ERROR 并转人工 */
export class ExternalAuthorFailed extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export interface AgentDeps {
  readonly task: TaskSpec;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  readonly workspace: MaterializedWorkspace;
  readonly gateway: ModelInvoker;
  readonly resolution: ModelRouteResolution;
  /** 独立规划 route；缺失保持旧任务由 implementer 规划的兼容语义。 */
  readonly plannerResolution?: ModelRouteResolution;
  /** 手动协作在失败验证之后、下一次实现方调用之前停靠。 */
  readonly checkpointBeforeSelfFix?: (input: {
    readonly round: number;
    readonly verification: VerificationRun;
  }) => Promise<void>;
  readonly mutationPolicy: MutationPolicy;
  readonly runId: string;
  readonly attemptId: string;
  readonly signal: AbortSignal;
  readonly host: AgentHost;
  /**
   * 可选：外部编码代理当作者。存在时，执行/自修复/整改阶段不再走内部模型的
   * executionTurns，而是调它；规划、审批、验证、封存、交叉审核全部不变。
   */
  readonly externalAuthor?: ExternalAuthorRunner;
  /**
   * 可选：用户对上一版补丁的修改要求（PRD-DIFF-003 的新 Attempt）。
   * 它进任务简报 —— 不带上这个，模型会把同样的改法原样再写一遍。
   */
  readonly changeRequest?: {
    readonly note: string;
    readonly previousAttemptNo: number;
    readonly previousPatchDiff: string;
  };
  /**
   * 可选：一次性精确命令批准的执行期闸门（Slice K）。不传 = 没有批准通道，
   * 高于 R1 的命令一律 SPAWN_ERROR —— 缺省是关的，这一点不能靠调用方记得传参。
   */
  readonly commandApprovals?: CommandApprovalChecker;
}

export interface AgentResult {
  readonly kind: 'PATCH_READY' | 'NO_CHANGES' | 'PLAN_REJECTED' | 'BLOCKED' | 'VERIFICATION_FAILED';
  readonly detail: string;
  readonly baseline: VerificationRun | null;
  readonly finalVerification: VerificationRun | null;
  readonly unverifiedItems: string[];
}

export class AgentCancelled extends Error {
  readonly modelInvocationDispatched: boolean;

  constructor(messageOrDispatched: string | boolean = false) {
    super(typeof messageOrDispatched === 'string' ? messageOrDispatched : 'Agent cancelled');
    this.modelInvocationDispatched = typeof messageOrDispatched === 'boolean' && messageOrDispatched;
  }
}

const planSchema = z.object({
  summary: z.string().min(1),
  steps: z
    .array(
      z.object({
        intent: z.string().min(1),
        targetPaths: z.array(z.string()).default([]),
        expectedEffect: z.string().default(''),
      }),
    )
    .min(1)
    .max(12),
  risks: z.array(z.string()).default([]),
});

const submitPlan: ToolDefinition<typeof planSchema> = {
  name: 'submit_plan',
  risk: 'R0',
  description: '提交你的修复计划供用户审批。在没有充分读取仓库之前不要调用。',
  schema: planSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '一句话说明根因和修复思路' },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            targetPaths: { type: 'array', items: { type: 'string' } },
            expectedEffect: { type: 'string' },
          },
          required: ['intent'],
          additionalProperties: false,
        },
      },
      risks: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'steps'],
    additionalProperties: false,
  },
  summarize: (a) => `提交计划：${a.summary.slice(0, 60)}`,
  async execute() {
    return { ok: true, modelText: '计划已提交', preview: '', previewTruncated: false, artifactRef: null };
  },
};

// ---------------------------------------------------------------------------

export async function runAgent(deps: AgentDeps): Promise<AgentResult> {
  const { host, task, profile, workspace, signal } = deps;
  /**
   * 没有验证命令时，整个"基线 → 修复 → 重验 → 自修复"的循环失去意义，
   * 但这不该阻止用户使用 Agent。此时降级为 **未验证模式**：
   * 照常规划、审批、改代码、出补丁，只是补丁全程标为未验证，
   * 终态也只能是 ACCEPTED_UNVERIFIED。
   */
  const verificationEnabled = task.verificationCommandIds.length > 0;

  // ---- 0. 基线验证：先证明"改之前是什么状态" ----
  let baseline: VerificationRun | null = null;

  if (verificationEnabled) {
    /*
     * 基线验证是"验证"，不是"执行"。
     *
     * 之前这里报 EXECUTING，于是时间线上的相位读起来是「执行 → 规划 → 执行」——
     * 用户看到的第一个相位是执行，而那时一行代码都还没改。同时 VERIFYING
     * 在 RunStatus 里声明了却从来没有被任何生产代码设过（死状态），
     * 相位锚点里的"验证"永远不亮。两个问题是同一个：状态没照实报。
     */
    host.setStatus('VERIFYING', '正在建立验证基线');
    host.emit('VERIFICATION_STARTED', `基线验证：${task.verificationCommandIds.join(', ')}`, {
      phase: 'BASELINE',
    });
    baseline = await runVerification(
      deps.runId,
      deps.attemptId,
      'BASELINE',
      workspace,
      profile,
      task.verificationCommandIds,
      signal,
      host, // 平台自己发起的命令同样留 ToolCall、同样计入账本
      deps.commandApprovals ?? null,
    );
    throwIfCancelled(signal);
    host.emit(
      'VERIFICATION_FINISHED',
      `基线${baseline.passed ? '全部通过' : '存在失败'}：${baseline.commands.map((c) => `${c.commandId}=${c.outcome}`).join(' ')}`,
      { phase: 'BASELINE', verification: baseline },
    );

    if (baseline.passed) {
      return {
        kind: 'NO_CHANGES',
        detail: '基线验证已全部通过 —— 没有需要修复的失败。请确认任务描述或验证命令是否正确。',
        baseline,
        finalVerification: baseline,
        unverifiedItems: [],
      };
    }
  } else {
    /*
     * 未验证模式下这里**不报相位**：下一行就是 setStatus('PLANNING')，
     * 而在它之前报一次 EXECUTING 只会在时间线上凭空多一个"执行"锚点 ——
     * 那一刻既没在执行也没在验证，只是没有基线要建。事实由紧接着的 NOTE 交代。
     */
    host.emit('NOTE', '未验证模式：不跑基线、不跑重验、不做自修复，补丁全部标记为未验证');
  }

  // ---- 1. 规划阶段：平台强制 read-only ----
  host.setStatus('PLANNING', null);
  const planningConversation: ModelMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: buildTaskBrief(deps, baseline) }],
    },
  ];

  let plan = await generatePlan(deps, planningConversation);
  throwIfCancelled(signal);
  host.emit('PLAN_GENERATED', `计划已生成：${plan.summary}`, { plan });

  // ---- 2. 用户审批 ----
  for (;;) {
    host.setStatus('AWAITING_PLAN_APPROVAL', null);
    const outcome = await host.awaitPlanApproval(plan);
    const decision = typeof outcome === 'string' ? outcome : outcome.decision;
    host.emit(
      'PLAN_DECISION',
      `用户${decision === 'APPROVE' ? '批准' : decision === 'REVISE' ? '要求修改' : '拒绝'}了计划`,
      {
        planId: plan.planId,
        revision: plan.revision,
        decision,
        ...(typeof outcome === 'string' ? {} : { note: outcome.note }),
      },
    );
    if (decision === 'REJECT') {
      return {
        kind: 'PLAN_REJECTED',
        detail: '用户拒绝了计划，未产生任何副作用。',
        baseline,
        finalVerification: null,
        unverifiedItems: [],
      };
    }
    if (decision === 'APPROVE') break;

    const revisionNote = typeof outcome === 'string' ? '' : outcome.note.trim();
    pushUser(planningConversation, [{
      type: 'text',
      text: `用户要求修改上一版计划（revision ${plan.revision}）：${revisionNote}\n请重新检查并调用 submit_plan 提交修订版。`,
    }]);
    const previous = plan;
    host.setStatus('PLANNING', `正在按用户说明修订计划 revision ${previous.revision}`);
    plan = await generatePlan(deps, planningConversation, previous);
    throwIfCancelled(signal);
    host.emit('PLAN_GENERATED', `计划已修订为 revision ${plan.revision}：${plan.summary}`, {
      plan,
      parentPlanId: previous.planId,
    });
  }

  // ---- 3. 执行 + 有界自修复 ----
  host.setStatus('EXECUTING', null);
  /*
   * 规划方的聊天、探索结果和 receipt 都属于它的只读执行上下文。实施方从一份
   * 新会话开始，只接收用户批准的计划与任务事实；否则角色虽然换了 route，
   * 写者仍能直接复用规划方的读取授权，角色隔离只是界面标签。
   */
  const executionConversation: ModelMessage[] = [];
  if (!deps.externalAuthor) {
    pushUser(executionConversation, [
      {
        type: 'text',
        text:
          `${buildTaskBrief(deps, baseline)}\n\n` +
          `用户已批准以下计划，现在开始执行。\n\n${renderPlan(plan)}\n\n` +
          `执行规则：\n` +
          `- 修改现有文件前必须先用 fs_read 取得 receiptId。\n` +
          `- 用 workspace_mutate 提交改动；oldText 必须在文件中唯一命中。\n` +
          `- 不要修改 tsconfig/vite/vitest/eslint 配置、测试文件或验证脚本来让验证变绿：` +
          `平台会把这类改动标为 COVERAGE_WEAKENED，补丁将失去"已验证"资格。除非任务明确要求改它们。\n` +
          (verificationEnabled
            ? `- 改完后用 run_command 跑 ${task.verificationCommandIds.join(' / ')} 验证。\n` +
              `- 全部通过后，用一句话说明你做了什么，然后结束（不要再调用工具）。`
            : `- 本次任务没有配置验证命令，你无法证明改动是对的。因此要格外保守：\n` +
              `  只做计划里明确说过的改动，不要顺手重构。\n` +
              `- 改完后用一句话说明你做了什么、以及哪些地方你没有把握，然后结束。`),
      },
    ]);
  } else {
    host.emit('NOTE', '本次由外部编码代理当作者：它只在一次性 candidate 目录里改，平台把差异归一化后才进入主线', {
      externalAuthor: true,
    });
  }

  let finalVerification: VerificationRun | null = null;
  /** 最后一轮执行是怎么结束的 —— 供收尾时判断"是不是被预算掐断的" */
  let lastEnd: ExecutionEnd | null = null;
  let round = 0;
  const maxRounds = task.budget.maxSelfFixRounds;

  /**
   * 一轮"改代码"。内部模型走 executionTurns；外部作者走 runner。
   * 两条路对下游完全等价：之后都是 changedFilesVsBaseline → 验证 → 自修复判定。
   */
  const implementOnce = async (
    phase: 'IMPLEMENT' | 'SELF_FIX',
    failureSummary: string | null,
  ): Promise<{ end: ExecutionEnd } | { stop: AgentResult }> => {
    if (!deps.externalAuthor) return { end: await executionTurns(deps, executionConversation) };
    const outcome = await deps.externalAuthor({
      phase,
      brief: renderExternalAuthorBrief(deps, plan, baseline, failureSummary),
      round,
    });
    switch (outcome.kind) {
      case 'APPLIED':
        return { end: { kind: 'MODEL_ENDED_TURN' } };
      case 'NO_CHANGES':
        if (phase === 'SELF_FIX') {
          // 自修复轮没改任何东西：再验一遍只会得到同样的失败，直接如实停下
          return {
            stop: {
              kind: 'VERIFICATION_FAILED',
              detail: '外部作者在自修复轮没有产生任何文件变更，验证仍未通过。',
              baseline,
              finalVerification,
              unverifiedItems: [],
            },
          };
        }
        return { end: { kind: 'MODEL_ENDED_TURN' } }; // 下游按 changedFilesVsBaseline()==0 判 NO_CHANGES
      case 'CANCELLED':
        throw new AgentCancelled();
      case 'REJECTED':
        return {
          stop: {
            kind: 'BLOCKED',
            detail: `外部作者的改动未被采用（${outcome.reason}）：${outcome.detail}`,
            baseline,
            finalVerification,
            unverifiedItems: [],
          },
        };
      case 'FAILED':
        return {
          stop: {
            kind: 'BLOCKED',
            detail: `外部作者调用失败：${outcome.detail}`,
            baseline,
            finalVerification,
            unverifiedItems: [],
          },
        };
    }
  };

  for (;;) {
    throwIfCancelled(signal);
    const attempt = await implementOnce(
      round === 0 ? 'IMPLEMENT' : 'SELF_FIX',
      round === 0 || !finalVerification ? null : summarizeFailures(finalVerification),
    );
    if ('stop' in attempt) return attempt.stop;
    const ended = attempt.end;
    lastEnd = ended;
    throwIfCancelled(signal);

    if (workspace.changedFilesVsBaseline().length === 0) {
      return {
        kind: 'NO_CHANGES',
        detail: '模型结束了执行但没有产生任何文件变更。',
        baseline,
        finalVerification,
        unverifiedItems: [],
      };
    }

    // 未验证模式：改完就出补丁，没有重验也没有自修复
    if (!verificationEnabled) {
      const truncation = executionTruncationReason(ended);
      return {
        kind: 'PATCH_READY',
        detail:
          `产生了 ${workspace.changedFilesVsBaseline().length} 个文件变更（本次运行没有任何机器验证）。` +
          (truncation ? ` ⚠ 执行没跑完（${truncation}），改动很可能是半成品。` : ''),
        baseline: null,
        finalVerification: null,
        unverifiedItems: [
          ...(truncation ? [`⚠ 执行未跑完（${truncation}）—— 改动可能只做了一半`] : []),
          ...buildUnverifiedItems(task, profile, null),
        ],
      };
    }

    // 改后验证同样是"验证"相位：之前整段留在 EXECUTING 里，跑几十秒命令时
    // 界面上的相位仍写着"执行"，看不出球已经交给验证了。
    host.setStatus('VERIFYING', `正在验证 gen-${workspace.activeGeneration}`);
    host.emit('VERIFICATION_STARTED', `验证 gen-${workspace.activeGeneration}`, {
      phase: 'POST_MUTATION',
    });
    finalVerification = await runVerification(
      deps.runId,
      deps.attemptId,
      'POST_MUTATION',
      workspace,
      profile,
      task.verificationCommandIds,
      signal,
      host,
      deps.commandApprovals ?? null,
    );
    host.emit(
      'VERIFICATION_FINISHED',
      `验证${finalVerification.passed ? '通过' : '失败'}：${finalVerification.commands.map((c) => `${c.commandId}=${c.outcome}`).join(' ')}`,
      { phase: 'POST_MUTATION', verification: finalVerification },
    );

    if (finalVerification.passed) break;

    if (round >= maxRounds) {
      return {
        kind: 'VERIFICATION_FAILED',
        detail: `已用尽 ${maxRounds} 轮自修复，验证仍未通过。`,
        baseline,
        finalVerification,
        unverifiedItems: [],
      };
    }

    const budget = host.budgetExceeded();
    if (budget.exceeded) {
      return {
        kind: 'BLOCKED',
        detail: `预算耗尽，停止自修复：${budget.reason}`,
        baseline,
        finalVerification,
        unverifiedItems: [],
      };
    }

    const nextRound = round + 1;
    await deps.checkpointBeforeSelfFix?.({ round: nextRound, verification: finalVerification });
    throwIfCancelled(signal);
    round = nextRound;
    host.chargeSelfFixRound();
    // 验证跑完、要回去改代码了 —— 相位得跟着回到执行，否则会一直停在"验证中"
    host.setStatus('EXECUTING', `第 ${round}/${maxRounds} 轮自修复`);
    host.emit('SELF_FIX_ROUND', `进入第 ${round}/${maxRounds} 轮自修复`, { round });
    if (!deps.externalAuthor) {
      // 上一轮若以 BUDGET_EXHAUSTED 提前返回，末尾可能仍是 user —— 用 pushUser 合并
      pushUser(executionConversation, [
        {
          type: 'text',
          text:
            `验证仍未通过。这是第 ${round}/${maxRounds} 轮自修复，也是你最后的机会之一。\n\n` +
            `${summarizeFailures(finalVerification)}\n\n` +
            `请先判断这是不是与之前相同的失败。如果是同一个错误，说明上一次的改法不对，换一种思路。`,
        },
      ]);
    }
    // 外部作者：失败摘要在下一轮 implementOnce 的简报里带过去
  }

  const comparison = compareVerification(baseline!, finalVerification);
  // 拿成 const 才能让 TS 收窄；lastEnd 是 let，不能跨语句窄化
  const end = lastEnd;
  const truncationReason = executionTruncationReason(end);
  const unverified = composeUnverifiedItems(task, profile, comparison, truncationReason);

  return {
    kind: 'PATCH_READY',
    detail:
      `验证通过（修复 ${comparison.fixed.join(', ') || '无'}），共 ${workspace.changedFilesVsBaseline().length} 个文件变更。` +
      (truncationReason ? ' ⚠ 但执行过程没跑完就停了。' : ''),
    baseline,
    finalVerification,
    unverifiedItems: unverified,
  };
}

// ---------------------------------------------------------------------------
// 规划
// ---------------------------------------------------------------------------

async function generatePlan(
  deps: AgentDeps,
  conversation: ModelMessage[],
  previous: PlanRevision | null = null,
): Promise<PlanRevision> {
  const { host } = deps;
  const tools = [...PLANNING_TOOLS, submitPlan as unknown as ToolDefinition];
  /*
   * 规划阶段的轮次子预算。
   *
   * 这里曾经是 `Math.min(12, …)` —— 一个没有任何文档依据的硬编码。它的后果是
   * **用户的预算选择对规划完全无效**：把 Run 调到 40 轮，规划仍然只有 12 轮。
   *
   * 2026-08-28 实测（EVI-PLANNING-CAP-001）：真实失败正是撞在这条线上 ——
   * `run_074bde20…` 终止时 token 218453/600000（36%）、工具 36/80（45%）、
   * 轮次 12/40（30%），三项预算都远未耗尽，末轮上下文也只有 32k。
   * 也就是说它不是"资源不够"，是被一个常数掐断的。
   *
   * 现在从 Run 自己的轮次预算派生一半：上限仍然存在（规划不能吃光整个 Run，
   * 执行与自修复要留一半），但它跟随用户的选择。执行阶段本来就没有子上限，
   * 只靠同一个 `budgetExceeded()` 守卫，所以这里放宽不会饿死后面的阶段。
   *
   * **比例本身仍是开放问题（Q-026）**：没有模型 key 就做不了对照实验，
   * 所以这次只做"派生 + 如实报数"，不声称"这样更好用"。
   */
  const maxPlanTurns = planningTurnBudget(deps.task);

  /*
   * 规划期的探索账目。规划失败此前等于全盘作废 —— 这份账目让"这一趟看了哪儿"
   * 在失败之后仍然读得到，用户据此判断是模型找错地方，还是任务本身太宽。
   */
  const calls: Array<{ name: string; summary: string; ok: boolean }> = [];
  let spokenTurns = 0;
  let turnsRun = 0;

  for (let turn = 0; turn < maxPlanTurns; turn += 1) {
    throwIfCancelled(deps.signal);
    const budget = host.budgetExceeded();
    if (budget.exceeded) {
      emitPlanningDigest(host, { turns: turnsRun, calls, spokenTurns });
      throw new PlanningFailed(`预算耗尽：${budget.reason}`);
    }

    /*
     * 最后一轮：把工具收窄到只剩 submit_plan，并明说这是最后一轮。
     *
     * 为什么必须**结构上**收窄，而不是只在提示词里请求：真实的失败样本
     * （20 轮 / 43 次只读调用 / 一个字都没说 / 全盘作废）说明模型不会自己收口。
     * 它一直在读，是因为平台一直允许它读，而且从没告诉过它有个头。
     * 一份带着诚实风险声明的计划，比"探索了 20 轮然后什么都没有"有用得多 ——
     * 计划仍然要经用户批准，不确定的部分写在 risks 里由人来判断。
     */
    const isFinalTurn = turn === maxPlanTurns - 1;
    if (isFinalTurn) {
      pushUser(conversation, [{ type: 'text', text: finalPlanTurnDirective(maxPlanTurns) }]);
    }

    let invocation: Awaited<ReturnType<typeof callModel>>;
    try {
      invocation = await callModel(
        deps,
        conversation,
        isFinalTurn ? [submitPlan as unknown as ToolDefinition] : tools,
        'PLANNING',
        deps.plannerResolution,
      );
    } catch (error) {
      if (error instanceof ModelDispatchBudgetExceeded) {
        emitPlanningDigest(host, { turns: turnsRun, calls, spokenTurns });
        throw new PlanningFailed(`预算耗尽：${error.message}`);
      }
      throw error;
    }
    const { response } = invocation;
    const uses = toolUsesOf(response.content);
    turnsRun += 1;
    // 规划期模型的思考同样进时间线：之前这一段被原样吞掉，用户只看得见最后那份计划
    if (sayIfAny(host, 'PLANNING', response.content)) spokenTurns += 1;

    /*
     * 截断的响应里就算凑巧解析出一份完整、合法的 submit_plan，也不能进审批 ——
     * 那是模型没说完的话，不是它的完整意图。submit_plan 是下面内联解析的，
     * **绕过 dispatchTool**，所以门禁只能设在这里，设在工具分发里拦不住它。
     */
    const incomplete = findIncompleteResponse(response);
    if (incomplete) {
      host.emit(
        'MODEL_INVOCATION',
        `规划轮响应不完整：${incomplete} —— ${uses.length} 个工具调用一律未执行，本轮不接受计划`,
        { purpose: 'PLANNING', stopReason: response.stopReason, unexecutedToolCalls: uses.length },
      );
      conversation.push({ role: 'assistant', content: response.content });
      pushUser(conversation, [
        ...unexecutedToolResults(uses, incomplete),
        {
          type: 'text',
          text:
            `上一轮输出不完整，平台没有据此执行任何工具调用，也没有接受其中的计划。` +
            `请缩短篇幅后重新提交。${planTurnsLeftNotice(turn, maxPlanTurns)}`,
        },
      ]);
      continue;
    }

    if (uses.length === 0) {
      // 没有调用 submit_plan 就想结束 —— 明确要求它提交结构化计划
      conversation.push({ role: 'assistant', content: response.content });
      pushUser(conversation, [
        {
          type: 'text',
          text:
            '请调用 submit_plan 工具提交结构化计划。纯文字回复不能进入审批流程。' +
            planTurnsLeftNotice(turn, maxPlanTurns),
        },
      ]);
      continue;
    }

    conversation.push({ role: 'assistant', content: response.content });
    const results: ContentBlock[] = [];
    /**
     * 本轮 submit_plan 解析出的计划。
     *
     * 拿到之后**不能立刻 return** —— 必须先把本轮全部 tool_use 的 tool_result 写回历史。
     * 同一规划会话的下一轮仍要求每个 tool_use 都有 tool_result；不能因为已经拿到
     * 结构化计划，就留下一个会被两家 wire 拒绝的孤儿调用。
     */
    let submitted: PlanRevision | null = null;

    for (const use of uses) {
      if (submitted) {
        // 计划已在本轮提交，剩余工具不再执行 —— 但 id 仍要回填，否则它们就是孤儿
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: '本轮已提交计划，该工具调用未执行。请在计划获批后的执行阶段再调用。',
          isError: true,
        });
        continue;
      }
      if (use.name === 'submit_plan') {
        const parsed = planSchema.safeParse(use.input);
        if (!parsed.success) {
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: `计划 schema 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            isError: true,
          });
          continue;
        }
        const steps: PlanStep[] = parsed.data.steps.map((s, i) => ({
          index: i + 1,
          intent: s.intent,
          targetPaths: s.targetPaths,
          toolNames: ['fs_read', 'workspace_mutate', 'run_command'],
          expectedEffect: s.expectedEffect,
        }));
        const revision = (previous?.revision ?? 0) + 1;
        const parentPlanId = previous?.planId ?? null;
        const core = {
          runId: deps.runId,
          snapshotId: deps.snapshot.snapshotId,
          revision,
          parentPlanId,
          summary: parsed.data.summary,
          steps,
          risks: parsed.data.risks,
          verificationCommandIds: deps.task.verificationCommandIds,
        };
        submitted = {
          planId: newId('plan'),
          runId: deps.runId,
          revision,
          parentPlanId,
          snapshotId: deps.snapshot.snapshotId,
          summary: parsed.data.summary,
          steps,
          risks: parsed.data.risks,
          verificationCommandIds: deps.task.verificationCommandIds,
          digest: digestOf(core),
          generatedBy: {
            invocationId: invocation.invocationId,
            purpose: 'PLANNING',
            resolutionId: invocation.manifest.resolutionId,
          },
          createdAt: nowIso(),
        };
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: '计划已提交，等待用户审批。',
          isError: false,
        });
        continue;
      }

      const outcome = await dispatchTool(
        deps,
        use.name,
        use.input,
        'PLANNING',
        isFinalTurn ? FINAL_TURN_TOOLS : undefined,
      );
      // 只记真的派发出去的那些：被阶段闸门/风险门拒掉的没有摘要，也不代表"看过"
      if (outcome.summary !== undefined) {
        calls.push({ name: use.name, summary: outcome.summary, ok: outcome.ok });
      }
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: outcome.text,
        isError: !outcome.ok,
      });
    }

    /*
     * 倒计时跟着工具结果一起回去。
     *
     * 混合 block 的 user 消息两个 wire 都合法：OpenAI 侧 toWireMessages 把
     * tool_result 拆成独立的 role:'tool' 再跟一条 user 文本，Anthropic 侧本来就
     * 要求 tool_result 排在前面。findWireViolation 只管 tool_use 有没有被回填，
     * 末尾多一条文本不影响它。
     */
    if (!submitted && !isFinalTurn) {
      results.push({ type: 'text', text: planTurnsLeftNotice(turn, maxPlanTurns).trim() });
    }

    // 先写回历史，再决定是否返回 —— 顺序反了就是这个 bug 本身
    pushUser(conversation, results);
    if (submitted) return submitted;
  }

  /*
   * 触顶文案必须报数（不变式 8）。旧文案只说"用满 12 轮"，把最关键的事实藏了起来：
   * **其他预算根本没用完**。用户看不到这一点，就无从判断该放宽预算还是该收窄任务 ——
   * 这正是 EVI-PLANNING-CAP-001 里那三个 Run 的处境。
   */
  /*
   * 走到这里意味着**连最后一轮的强制收口都没提交计划** —— 那一轮模型手上只有
   * submit_plan 这一个工具，还是没用。这与旧世界的"用满 N 轮探索"不是同一件事，
   * 文案必须区分开，否则用户会误以为只要加预算就能过（加了也没用）。
   */
  emitPlanningDigest(host, { turns: turnsRun, calls, spokenTurns });
  const remaining = host.budgetExceeded();
  throw new PlanningFailed(
    `规划阶段用满 ${maxPlanTurns} 轮仍未提交计划（规划子预算 = 本任务模型轮次预算 ` +
      `${deps.task.budget.maxModelTurns} 轮的一半）。最后一轮平台已经把工具收窄到只剩 ` +
      `submit_plan，模型仍然没有提交 —— 所以这**不是探索时间不够**。` +
      (remaining.exceeded
        ? `此时 Run 预算也已耗尽：${remaining.reason}。`
        : `此时 token 与工具调用预算尚未耗尽。加预算大概率无效；` +
          `更可能是任务描述过宽或过于开放，先收窄成一件具体的事。`),
  );
}

/**
 * 规划阶段的轮次子预算。
 *
 * 从 Run 自己的轮次预算派生一半：上限仍然存在（规划不能吃光整个 Run，
 * 执行与自修复要留一半），但它跟随用户的选择。
 *
 * **一处定义，两处消费** —— 循环用它当上界，提示词用它告诉模型「你有几轮」。
 * 分开写就会漂，而漂的后果是：平台按一个数杀，模型按另一个数规划。
 */
export function planningTurnBudget(task: TaskSpec): number {
  return Math.max(2, Math.floor(task.budget.maxModelTurns / 2));
}

/**
 * 每一轮回给模型的倒计时。
 *
 * 真实失败样本里模型用满 20 轮只读调用、一个字没说、全盘作废 —— 它不是不肯收口，
 * 是**从来没被告知有个头**。提示词说的是"读到足够的证据后"，那是一条没有终点的指令：
 * 模型按自己的"足够"探索，平台按 20 轮杀，两边用的不是同一把尺。
 */
function planTurnsLeftNotice(turn: number, maxPlanTurns: number): string {
  const left = maxPlanTurns - turn - 1;
  if (left <= 0) return '';
  return (
    `\n\n（规划还剩 ${left} 轮。用不完不必用完 —— 证据够了就提交；` +
    `最后一轮平台只会留下 submit_plan，那时读不了文件了。）`
  );
}

/**
 * 最后一轮的收口指令。与"把工具收窄到只剩 submit_plan"配套：
 * 结构上做不到再读，语义上也说清为什么，并且给出**怎么处理没查完的部分**——
 * 否则模型会为了凑一份"完整"的计划去编它没验证过的东西。
 */
function finalPlanTurnDirective(maxPlanTurns: number): string {
  return (
    `这是**最后一轮规划**（共 ${maxPlanTurns} 轮）。平台已经把工具收窄为只有 submit_plan，` +
    `现在读不了文件了。\n` +
    `请用已经掌握的信息提交计划：已经确认的写进 steps；还没来得及核实的写进 risks，` +
    `逐条写明"我没有验证过什么"。\n` +
    `不要为了让计划看起来完整而编造你没读到的内容 —— ` +
    `一份带着诚实风险声明的计划仍然要由用户批准，而一份编出来的计划会让人批准错的东西。`
  );
}

/**
 * 规划触顶/预算耗尽时，把**已经发生的事实**汇总成一份账目。
 *
 * 为什么需要：规划失败此前等于全盘作废 —— 用户看到的只有一行红字，而那 43 次
 * 调用读到的东西全在折叠区里，要一条条展开才知道模型看过哪儿。这一条不解决
 * "为什么失败"（那是上面那条 PlanningFailed 的事），它回答另一个问题：
 * **这一趟到底看了哪儿** —— 用户据此才判断得出"它找错地方了"还是"这仓库确实太大"。
 *
 * 三条纪律：
 *   1. **只汇总，不推断。** 这里一个字都不是模型的结论，全是平台记下的事实。
 *      也刻意不再调一次模型去写总结：一个刚刚拒绝收口的模型，不是可信的总结者，
 *      而且那要在一个已经失败的 Run 上再花一次钱。
 *   2. **省略要报数**（不变式 8）：路径去重、列举截断，都如实写出数量。
 *   3. 走 NOTE 而不是新事件种类 —— 这是平台的如实标注，与 ASSISTANT_MESSAGE
 *      分属两个说话人，不能混。
 */
const DIGEST_LIST_MAX = 12;

/** 规划最后一轮平台唯一放行的工具 —— 由 dispatchTool 强制，不只是少给几个 schema */
const FINAL_TURN_TOOLS: ReadonlySet<string> = new Set(['submit_plan']);

interface PlanningTrace {
  /** 已经跑完的规划轮数 */
  readonly turns: number;
  /**
   * 派发出去的只读调用：工具名 + 参数摘要（摘要由工具自己算，不含宿主绝对路径）+ 成败。
   *
   * 失败的也要留：模型反复去读一个不存在的路径，本身就是"它找错地方了"的直接证据。
   * 但**不能混进"读过的文件"里当成读到了** —— 那是把一次落空说成一次探索。
   */
  readonly calls: ReadonlyArray<{ name: string; summary: string; ok: boolean }>;
  /** 其中有多少轮模型真的说了话 */
  readonly spokenTurns: number;
}

function renderNameList(items: readonly string[]): string {
  const shown = items.slice(0, DIGEST_LIST_MAX);
  const rest = items.length - shown.length;
  // 截断要报数：省略的条数说出来，而不是让列表看起来就是全部
  return shown.join('、') + (rest > 0 ? `（另有 ${rest} 个未列出，完整记录在上方调用里）` : '');
}

function emitPlanningDigest(host: AgentHost, trace: PlanningTrace): void {
  const lines: string[] = [
    '规划没有收口。下面是这一趟**已经发生的事实**（平台汇总，不是模型的结论）：',
    '',
  ];

  if (trace.calls.length === 0) {
    lines.push(`- ${trace.turns} 轮规划，**一次工具都没调用过**`);
  } else {
    // 按工具分类只报数量，具体目标进下面那条列表 —— 摘要本身已经自带动词
    const counts = new Map<string, number>();
    for (const c of trace.calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const shape = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]) => `${toolLabel(name)} ×${n}`)
      .join('、');
    lines.push(`- ${trace.turns} 轮规划，${trace.calls.length} 次只读调用：${shape}`);

    const unique = [...new Set(trace.calls.map((c) => c.summary))];
    const failed = trace.calls.filter((c) => !c.ok).length;
    lines.push(
      `- 去重后 ${unique.length} 个目标` +
        (failed > 0 ? `（其中 ${failed} 次调用失败，没有读到内容）` : '') +
        `：${renderNameList(unique)}`,
    );
  }

  /*
   * "一个字都没说"是这份账目里信号最强的一条：模型在读，但没有边读边收敛。
   * 真实样本里 20 轮全程无输出，正是这个形态。它不是修辞，是可核对的计数。
   */
  lines.push(
    trace.spokenTurns === 0
      ? '- 模型**全程没有输出任何文字** —— 它一直在读，但没有边读边总结'
      : `- 模型在 ${trace.spokenTurns}/${trace.turns} 轮里说过话（正文在上方时间线里）`,
  );

  host.emit('NOTE', lines.join('\n'), {
    planningDigest: {
      turns: trace.turns,
      toolCalls: trace.calls.length,
      spokenTurns: trace.spokenTurns,
    },
  });
}

/** 工具名的中文说法。与 Renderer 那份词典同源同义，但 Core 不依赖 Renderer。 */
function toolLabel(name: string): string {
  switch (name) {
    case 'fs_read':
      return '读文件';
    case 'fs_grep':
      return '搜内容';
    case 'fs_glob':
      return '匹配路径';
    case 'fs_list':
      return '列目录';
    default:
      return name;
  }
}

export class PlanningFailed extends Error {}

/**
 * 追加一条 user 消息；**末尾已经是 user 消息时合并进去**，不新起一条。
 *
 * 因为 Anthropic 要求 role 严格交替（连续两条 user 返回
 * `roles must alternate between "user" and "assistant"`，同样是 400），
 * 而在 OpenAI 兼容端这个坏序列压根不成立 —— toWireMessages 按块类型拆，
 * 纯 tool_result 的那条会变成 role:'tool'，所以那边看到的是合法的
 * assistant → tool → user。只在一家上炸的错误最容易漏。
 *
 * 这个坑是修孤儿 tool_use 时自己造出来的：规划期提交计划后先回填 tool_result（user），
 * 紧接着 runAgent 又 push 审批通知（user）。合并对两家都合法：
 * Anthropic 允许一条 user 消息里同时有 tool_result 和 text 块；
 * OpenAI 适配器的 toWireMessages 会把它们拆成 role:'tool' + role:'user' 两条。
 */
function pushUser(conversation: ModelMessage[], blocks: readonly ContentBlock[]): void {
  const last = conversation[conversation.length - 1];
  if (last?.role === 'user') {
    conversation[conversation.length - 1] = { role: 'user', content: [...last.content, ...blocks] };
    return;
  }
  conversation.push({ role: 'user', content: [...blocks] });
}

/**
 * 这次模型响应是否完整到可以据此行动。返回 null 表示可以，否则返回可直接展示的原因。
 *
 * 判据只有一份（`stopReasonAllowsToolExecution`），三条路径共用 —— 规划、执行、交叉审核
 * 提取工具的边界各不相同，但"半截输出不代表模型的完整意图"是同一条规则。写成三处就会漂。
 *
 * 这道门禁拦的是**执行**，不是**记录**：响应照样进历史、正文照样进时间线，
 * 只是不据它派发工具。
 */
function findIncompleteResponse(response: ModelResponse): string | null {
  return stopReasonAllowsToolExecution(response.stopReason)
    ? null
    : stopReasonBlockLabel(response.stopReason);
}

/**
 * 把这批工具调用如实回填成"未执行"。
 *
 * 响应不完整时**不能**把 tool_use 从历史里抹掉了事：assistant 消息已经 push 进
 * conversation，每一个 toolUseId 都必须有对应的 tool_result，否则两家 wire 都以 400
 * 拒绝**此后每一次**请求，而不只是产生它的那一次（见 findOrphanToolUse）。
 * 所以"拦住执行"和"保住 wire 合法"必须同时做到。
 */
function unexecutedToolResults(
  uses: ReturnType<typeof toolUsesOf>,
  reason: string,
): ContentBlock[] {
  return uses.map((use) => ({
    type: 'tool_result',
    toolUseId: use.id,
    content: `该工具调用未执行：${reason}。`,
    isError: true,
  }));
}

// ---------------------------------------------------------------------------
// 交叉审核（只读的第二个模型；PRD-XAGENT-003）
// ---------------------------------------------------------------------------

const reviewFindingSchema = z.object({
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
  confidence: z.number().min(0).max(1),
  file: z.string().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  evidence: z.string().min(1),
  reproduction: z.string().nullable().optional(),
  suggestedRemediation: z.string().nullable().optional(),
  blocking: z.boolean(),
});

/**
 * 把审核方交上来的原始 finding 归一化成平台事实。
 *
 * **谁来审都走这一个函数** —— 模型 API 走 submit_review 工具，外部 CLI 走
 * stdout 里的 JSON，但校验与指纹计算必须是同一套。指纹由平台按
 * (severity, file, range, evidence) 计算，绝不采信审核方自报的那个：
 * 它是"多轮之间有没有进展"的判据，让被审方能操纵它，收敛判定就废了。
 * 这也是"只换选手不换规则"的落点。
 */
export function normalizeFindings(
  raw: readonly z.infer<typeof reviewSchema>['findings'][number][],
): ReviewFinding[] {
  return raw.map((f) => {
    const range: readonly [number, number] | null =
      f.startLine != null && f.endLine != null ? [f.startLine, f.endLine] : null;
    return {
      severity: f.severity,
      confidence: f.confidence,
      file: f.file ?? null,
      range,
      evidence: f.evidence,
      reproduction: f.reproduction ?? null,
      suggestedRemediation: f.suggestedRemediation ?? null,
      blocking: f.blocking,
      fingerprint: digestOf({
        severity: f.severity,
        file: f.file ?? null,
        range,
        evidence: f.evidence.trim().slice(0, 400),
      }),
    };
  });
}

/**
 * 校验外部 CLI 吐回来的审核结论。
 *
 * 与模型 API 路径共用 reviewSchema —— 换了选手不等于放宽校验。
 * 校验不过返回 null，由调用方记 INCONCLUSIVE：宁可"这轮没有结论"，
 * 也不把半个不合法的对象当成发现。
 */
export function parseExternalSubmission(
  verdict: CrossReviewVerdict,
  rawFindings: readonly Record<string, unknown>[],
  resolvedFindingFingerprints: readonly string[] = [],
): {
  verdict: CrossReviewVerdict;
  findings: ReviewFinding[];
  resolvedFindingFingerprints: readonly string[];
} | null {
  const parsed = reviewSchema.safeParse({ verdict, findings: rawFindings, resolvedFindingFingerprints });
  if (!parsed.success) return null;
  return {
    verdict: parsed.data.verdict,
    findings: normalizeFindings(parsed.data.findings),
    resolvedFindingFingerprints: parsed.data.resolvedFindingFingerprints,
  };
}

const reviewSchema = z.object({
  verdict: z.enum(['PASS', 'CHANGES_REQUESTED', 'INCONCLUSIVE']),
  findings: z.array(reviewFindingSchema),
  resolvedFindingFingerprints: z.array(z.string().min(1)).optional().default([]),
});

export interface ReviewPassInput {
  readonly reviewerResolution: ModelRouteResolution;
  readonly patch: PatchArtifact;
  readonly finalVerification: VerificationRun | null;
  /** 第几次 reviewer invocation（1-based），用于日志与记录 */
  readonly round: number;
  readonly priorFindings?: readonly ReviewFinding[];
}

/**
 * 跑一次只读交叉审核。
 *
 * 审核方拿到的是**已封存补丁的全文** + 任务目标/验收 + 验证结果，工具被平台强制为
 * 只读（REVIEW phase，只有 R0）。它只能通过 submit_review 产出结构化 findings ——
 * 不能改工作区、不能跑命令、不能批准补丁。这与"审核方通过 ≠ SUCCEEDED"是同一件事的
 * 两个面：能力上做不到，语义上也不承认。
 *
 * 返回一次 CrossReviewRound。findings 的 fingerprint 由平台按 (severity,file,range,evidence)
 * 计算，不信任模型自报 —— 指纹是判定"多轮之间有没有进展"的依据，不能让被审方操纵。
 */
export async function runReviewPass(
  deps: AgentDeps,
  input: ReviewPassInput,
): Promise<CrossReviewRound> {
  const startedAt = nowIso();
  const { host } = deps;
  const reviewTools = TOOLS.filter((t) => t.risk === 'R0'); // 只读子集
  const system = reviewSystemPrompt(deps);

  const conversation: ModelMessage[] = [
    {
      role: 'user',
      content: [{
        type: 'text',
        text: renderReviewBrief(deps.task, input.patch, input.finalVerification, input.priorFindings ?? []),
      }],
    },
  ];

  const maxReviewTurns = 8;
  for (let turn = 0; turn < maxReviewTurns; turn += 1) {
    throwIfCancelled(deps.signal);
    const { response } = await callModel(
      deps,
      conversation,
      reviewTools,
      'CROSS_REVIEW',
      input.reviewerResolution,
      system,
    );
    const uses = toolUsesOf(response.content);
    // 审核方说的话也归审核方：它是"第二意见"的正文，不该只剩一份结构化 findings
    sayIfAny(host, 'CROSS_REVIEW', response.content);

    /*
     * 截断的审核结论不是审核结论。submit_review 也是下面内联解析、绕过 dispatchTool 的，
     * 所以门禁同样只能设在这里。不接受 submitted 就意味着：用满轮次后落到本函数末尾
     * 既有的 INCONCLUSIVE 分支 —— 正是"没给出结论 ≠ 通过"那条规则，不另造一个终态。
     */
    const incomplete = findIncompleteResponse(response);
    if (incomplete) {
      /*
       * 用 MODEL_INVOCATION 而不是 CROSS_REVIEW_ROUND：后者在 Transcript 的 MERGED_KINDS 里
       * （由 CrossReviewPanel 代表），而那个面板读的是结构化 crossReview 记录、不读事件 ——
       * 这条事实会被合并掉，用户在时间线上根本看不见。省略要报数（不变式 8）。
       */
      host.emit(
        'MODEL_INVOCATION',
        `第 ${input.round} 轮审核响应不完整：${incomplete} —— ${uses.length} 个工具调用一律未执行，本轮不接受结论`,
        {
          purpose: 'CROSS_REVIEW',
          round: input.round,
          stopReason: response.stopReason,
          unexecutedToolCalls: uses.length,
        },
      );
      conversation.push({ role: 'assistant', content: response.content });
      pushUser(conversation, [
        ...unexecutedToolResults(uses, incomplete),
        {
          type: 'text',
          text:
            '上一轮输出不完整，平台没有据此执行任何工具调用，也没有接受其中的审核结论。' +
            '请缩短篇幅后重新调用 submit_review 提交结论。',
        },
      ]);
      continue;
    }

    if (uses.length === 0) {
      // 只回了文本没提交结论 —— 要求它用 submit_review
      conversation.push({ role: 'assistant', content: response.content });
      pushUser(conversation, [
        {
          type: 'text',
          text: '请调用 submit_review 工具提交结构化审核结论（verdict + findings）。纯文字不计入审核记录。',
        },
      ]);
      continue;
    }

    conversation.push({ role: 'assistant', content: response.content });
    const results: ContentBlock[] = [];
    let submitted: z.infer<typeof reviewSchema> | null = null;

    for (const use of uses) {
      if (submitted) {
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: '本轮已提交审核结论，其余调用未执行。',
          isError: true,
        });
        continue;
      }
      if (use.name === 'submit_review') {
        const parsed = reviewSchema.safeParse(use.input);
        if (!parsed.success) {
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: `审核结论 schema 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            isError: true,
          });
          continue;
        }
        submitted = parsed.data;
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: '审核结论已收到。',
          isError: false,
        });
        continue;
      }
      // 只读工具（fs_read/fs_grep/...）；REVIEW phase 会挡掉任何非 R0
      const outcome = await dispatchTool(deps, use.name, use.input, 'REVIEW');
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: outcome.text,
        isError: !outcome.ok,
      });
    }

    pushUser(conversation, results);

    if (submitted) {
      const findings = normalizeFindings(submitted.findings);
      host.emit(
        'CROSS_REVIEW_ROUND',
        `第 ${input.round} 轮交叉审核：${submitted.verdict}，${findings.length} 条发现（阻断 ${findings.filter((x) => x.blocking).length}）`,
        { round: input.round, verdict: submitted.verdict, findingCount: findings.length },
      );
      return {
        round: input.round,
        reviewedPatchDigest: input.patch.digest,
        reviewerResolutionId: input.reviewerResolution.resolutionId,
        verdict: submitted.verdict,
        findings,
        resolvedFindingFingerprints: submitted.resolvedFindingFingerprints,
        startedAt,
        finishedAt: nowIso(),
      };
    }
  }

  // 用满轮次还没提交：记为 INCONCLUSIVE，不编造发现
  host.emit('CROSS_REVIEW_ROUND', `第 ${input.round} 轮交叉审核用满 ${maxReviewTurns} 轮未提交结论`, {
    round: input.round,
    verdict: 'INCONCLUSIVE',
  });
  return {
    round: input.round,
    reviewedPatchDigest: input.patch.digest,
    reviewerResolutionId: input.reviewerResolution.resolutionId,
    verdict: 'INCONCLUSIVE',
    findings: [],
    startedAt,
    finishedAt: nowIso(),
  };
}

/** 允许路径的提示词渲染：['**'] / 空 = 没有额外限制，别让模型看到光秃秃的 "**" */
function renderAllowedPaths(paths: readonly string[]): string {
  if (paths.length === 0 || (paths.length === 1 && paths[0] === '**')) {
    return '整个仓库（仅受保护路径禁止）';
  }
  return paths.join(', ');
}

export function renderReviewBrief(
  task: TaskSpec,
  patch: PatchArtifact,
  verification: VerificationRun | null,
  priorFindings: readonly ReviewFinding[] = [],
): string {
  const verifyLine = verification
    ? `验证结果：${verification.passed ? '通过' : '未通过'}（${verification.commands.map((c) => `${c.commandId}=${c.outcome}`).join(' ')}）`
    : '本次没有机器验证 —— 你的审核是唯一的第二意见，请格外仔细。';
  const acc = task.acceptance.length ? task.acceptance.map((a) => `  - ${a}`).join('\n') : '  （无）';
  const nonGoals = task.nonGoals.length ? task.nonGoals.map((g) => `  - ${g}`).join('\n') : '  （无）';
  return `请审核下面这个**已封存**的补丁。你是独立的第二个模型，只读。

任务目标：${task.goal}
验收标准：
${acc}
明确的非目标（改了这些属于范围蔓延，应报为发现）：
${nonGoals}
允许改动的路径：${renderAllowedPaths(task.allowedPaths)}
${verifyLine}

补丁 digest：${patch.digest}
改动文件：${patch.files.map((f) => `${f.path}(${f.changeKind})`).join(', ')}
${patch.unverifiedItems.length ? `实现方声明未覆盖：${patch.unverifiedItems.join('；')}` : ''}

统一 diff：
\`\`\`diff
${patch.unifiedDiff.slice(0, 24_000)}
\`\`\`
${patch.unifiedDiff.length > 24_000 ? '（diff 过长已截断，可用 fs_read 读取完整文件核对）' : ''}

${priorFindings.length > 0
  ? `上一轮待复核问题：\n${priorFindings.map((finding) => `- ${finding.fingerprint}：${finding.evidence}`).join('\n')}\n复审时，只有你逐项确认已解决的问题才能把 fingerprint 放进 resolvedFindingFingerprints；没有再提及不等于已解决。`
  : ''}

请核对：正确性、是否真的满足验收、有没有范围蔓延、安全与边界、以及验证覆盖不到的地方。
需要时用只读工具读取补丁后的文件。核对完调用 submit_review 提交：
- verdict：PASS（无阻断发现）/ CHANGES_REQUESTED（有阻断发现）/ INCONCLUSIVE（信息不足下结论）
- findings：每条给 severity/confidence/file/range/evidence/blocking，尽量给 reproduction 与 suggestedRemediation。
- resolvedFindingFingerprints：复审时逐项列出已确认修复的上一轮 finding 指纹；首审传空数组。
不要臆造发现；没有阻断问题就如实 PASS。`;
}

function reviewSystemPrompt(deps: AgentDeps): string {
  return `你是 RepoPilot 的**交叉审核方**：一个独立的第二个模型，审核另一个模型写出并已封存的补丁。

硬性约束（由平台强制，不是自律）：
- 你是**只读**的。不能改文件、不能运行命令、不能批准补丁。任何写操作都会被拒绝。
- 你的"通过"**不等于**验证通过，也不等于任务成功 —— 那需要机器验证和人工接受。你只提供第二意见。
- 只通过 submit_review 输出结构化发现，不要在自由文本里下最终结论。

仓库：${deps.profile.adapterId}（${deps.profile.packageManager}），工作区是补丁应用后的只读副本。
判断要基于证据：能指到具体文件与行、能说清怎么触发的发现才有价值。不确定就降低 confidence 或标 INCONCLUSIVE，不要凑数。`;
}

// ---------------------------------------------------------------------------
// 交叉审核：整改与多轮编排（PRD-XAGENT-004 的收敛闭环）
// ---------------------------------------------------------------------------

export interface RemediationPassInput {
  /** 审核所针对的补丁 —— 整改方需要看到自己交付了什么 */
  readonly patch: PatchArtifact;
  /** 只喂阻断项。提示性发现不驱动整改，避免整改被引去做范围外的"顺手优化" */
  readonly findings: readonly ReviewFinding[];
}

export interface RemediationPassResult {
  /** 工作区 generation 是否真的前进了 —— "模型说改了"不算 */
  readonly mutated: boolean;
  readonly truncationReason: string | null;
}

/**
 * 一次自动整改：**实现方**（deps.resolution 必须是实现方 route）在同一工作区里
 * 修复审核方给出的阻断发现。走标准执行通道（executionTurns），也就是说：
 * mutation 依旧要 receipt + exact-span、依旧整笔失败零写入、依旧计入同一个预算账本。
 * 整改没有任何专属特权。
 */
export async function runRemediationPass(
  deps: AgentDeps,
  input: RemediationPassInput,
): Promise<RemediationPassResult> {
  const before = deps.workspace.activeGeneration;
  if (deps.externalAuthor) {
    // 外部作者整改：同一份简报（去掉内部工具规则），同一个 candidate → 归一化 → CAS 路径。
    // 调用失败/被拒不伪装成"没改"：抛出让循环记 ERROR 并转人工，NO_CHANGES 才是 NO_DELTA。
    const outcome = await deps.externalAuthor({
      phase: 'REMEDIATE',
      brief: renderRemediationBrief(deps.task, input.patch, input.findings, 'EXTERNAL'),
      round: 0,
    });
    switch (outcome.kind) {
      case 'APPLIED':
        return { mutated: deps.workspace.activeGeneration !== before, truncationReason: null };
      case 'NO_CHANGES':
        return { mutated: false, truncationReason: null };
      case 'CANCELLED':
        throw new AgentCancelled();
      case 'REJECTED':
        throw new ExternalAuthorFailed(`整改改动未被采用（${outcome.reason}）：${outcome.detail}`);
      case 'FAILED':
        throw new ExternalAuthorFailed(`外部作者整改调用失败：${outcome.detail}`);
    }
  }
  const conversation: ModelMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: renderRemediationBrief(deps.task, input.patch, input.findings, 'INTERNAL') }],
    },
  ];
  const ended = await executionTurns(deps, conversation);
  return {
    mutated: deps.workspace.activeGeneration !== before,
    // 整改轮被截断也要如实带出去：它经 hooks.reseal 进重新封存的补丁未验证清单。
    // 漏掉的后果是新补丁看起来比实际更干净 —— 而那只是少写了一行。
    truncationReason: executionTruncationReason(ended),
  };
}

function renderRemediationBrief(
  task: TaskSpec,
  patch: PatchArtifact,
  findings: readonly ReviewFinding[],
  mode: 'INTERNAL' | 'EXTERNAL',
): string {
  const list = findings
    .map((f, i) => {
      const where = f.file ? `${f.file}${f.range ? `:${f.range[0]}-${f.range[1]}` : ''}` : '（未定位）';
      return (
        `${i + 1}. [${f.severity}] ${where}\n` +
        `   证据：${f.evidence}\n` +
        (f.reproduction ? `   复现：${f.reproduction}\n` : '') +
        (f.suggestedRemediation ? `   审核方建议：${f.suggestedRemediation}\n` : '')
      );
    })
    .join('\n');
  return `你之前提交的补丁经独立模型交叉审核，发现 ${findings.length} 条**阻断性**问题。请整改。

任务目标（不变）：${task.goal}
允许改动的路径（不变）：${renderAllowedPaths(task.allowedPaths)}

阻断发现：
${list}
被审核的补丁（你当前工作区已包含这些改动）：
\`\`\`diff
${patch.unifiedDiff.slice(0, 24_000)}
\`\`\`
${patch.unifiedDiff.length > 24_000 ? '（diff 过长已截断，可用 fs_read 读取完整文件）' : ''}

规则：
- **只**修复上面列出的阻断项。不要顺手重构、不要扩大范围 —— 范围蔓延本身就是审核要抓的问题。
- 认为某条发现不成立时，不改它即可（下一轮审核与人工都会看到你的取舍），不要为了"响应"而乱改。
${mode === 'INTERNAL' ? '- 修改文件前先 fs_read 拿 receipt。改完直接结束回合，无需汇报。' : '- 直接在当前目录修改文件；改完按平台要求输出 JSON 备注即可。'}`;
}

/**
 * 跑一轮审核并交回结果。**审核方是谁由调用方决定** —— 模型 API profile
 * 走 runReviewPass，外部 CLI 走连接器；循环本身不关心，它只管收敛语义。
 * 这就是"只换选手不换规则"在编排层的形状。
 */
export type ReviewPassRunner = (input: {
  readonly patch: PatchArtifact;
  readonly finalVerification: VerificationRun | null;
  readonly round: number;
  readonly priorFindings?: readonly ReviewFinding[];
}) => Promise<CrossReviewRound>;

export interface CrossReviewCycleInput {
  /** 审核方执行器。默认实现（模型 API）见 authority.modelApiReviewer */
  readonly review: ReviewPassRunner;
  readonly patch: PatchArtifact;
  readonly finalVerification: VerificationRun | null;
  /** 上一循环仍未关闭的发现；续期首审必须逐项复核。 */
  readonly priorFindings?: readonly ReviewFinding[];
}

/**
 * 循环需要但不属于循环的机制，由调用方（authority）注入。
 * 这样收敛语义（何时整改、何时早停、counter 怎么走）可以在测试里用替身钉死，
 * 而封存/验证/恢复的真实实现仍然只有一份。
 */
export interface CrossReviewCycleHooks {
  /** 整改产生变更后重跑验证。未验证模式传 null —— 循环会跳过验证、按原模式重新封存 */
  readonly reverify: (() => Promise<VerificationRun>) | null;
  /** 用给定验证结果重新封存当前工作区（不改 record，不发事件 —— 是否采用由循环决定） */
  readonly reseal: (verification: VerificationRun | null, truncationReason: string | null) => PatchArtifact;
  /** 循环确认新补丁有实质变化后调用：替换 record.patch 并发 PATCH_SEALED */
  readonly adoptPatch: (patch: PatchArtifact) => void;
  /** 把工作区内容恢复到进入循环时的那一代（整改失败/中断时保证补丁与工作区一致） */
  readonly restoreWorkspace: () => void;
  readonly checkpoint?: (input: {
    phase: 'REMEDIATE' | 'SECOND_REVIEW';
    patch: PatchArtifact;
    findings: readonly ReviewFinding[];
    reviewerInvocations: number;
    remediations: number;
    reviewId: string;
  }) => Promise<void>;
}

export interface CrossReviewCycleOutcome {
  readonly rounds: readonly CrossReviewRound[];
  /** 已进入派发的审核调用数；失败/取消/未知也占用，预检拒绝不占用。 */
  readonly reviewerInvocations: number;
  readonly remediations: number;
  readonly stopReason: CrossReviewStopReason;
}

/**
 * 一轮审核该怎么收场 —— 只在"没有阻断项"时才轮到 verdict 说话。
 *
 * 两条规则，都指向同一个原则：**平台能数的东西优先于模型的自评**。
 *
 * 1. 有阻断项就整改，不管 verdict 写的是什么。verdict 是模型对自己这轮的一句总结，
 *    findings 是它逐条列出来的证据；`PASS` + 一条 CRITICAL 阻断项时，可信的是后者。
 *    此前 `verdict === 'PASS'` 会短路掉整个 findings 数组。
 * 2. 零阻断项时区分两种成因：`INCONCLUSIVE` 是"没看成"，不是"看过了没问题"。
 *    这两种此前都折成 REVIEWER_PASSED，而界面把它渲染成"审核方未发现阻断问题" ——
 *    外部审核方输出不可解析、schema 不过、用满轮次未提交（authority.ts / agent.ts
 *    三处都返回 `{verdict:'INCONCLUSIVE', findings:[]}`）全都走这条路，于是
 *    "拿不到结论"被显示成"通过"。
 */
function verdictOutcome(
  round: CrossReviewRound,
  blocking: readonly ReviewFinding[],
): 'REMEDIATE' | 'REVIEWER_PASSED' | 'REVIEWER_INCONCLUSIVE' {
  if (blocking.length > 0) return 'REMEDIATE';
  return round.verdict === 'INCONCLUSIVE' ? 'REVIEWER_INCONCLUSIVE' : 'REVIEWER_PASSED';
}

/**
 * 交叉审核收敛循环：审核 →（有阻断）整改 → 重验 → 重封存 → 再审 → 终止判定。
 *
 * 硬上限来自 CROSS_REVIEW_LIMITS（2 次审核 + 1 次整改，PRD-XAGENT-004），
 * 流程本身写成直线而不是 while —— 上限不是"循环恰好走不满"，是结构上走不满。
 *
 * 终止语义（全部转人工，绝不自动接受）：
 *   REVIEWER_PASSED    某轮无阻断发现，且审核方确实给出了结论
 *   REVIEWER_INCONCLUSIVE  审核方没给出可用结论（不可解析 / schema 不过 / 用满轮次未提交）
 *   NO_DELTA           整改没改出实质差异（没动文件，或 digest 与整改前相同）
 *   NO_PROGRESS        整改后验证反而失败（已恢复工作区），或第二轮阻断未减少/指纹重现
 *   COUNTER_EXHAUSTED  两轮审核 + 一次整改用满，仍有（减少了的）阻断
 *   BUDGET_EXHAUSTED   任务预算耗尽（整改与主执行同一个账本）
 *   CANCELLED / REVIEWER_UNAVAILABLE / ERROR  中断类，能定位到哪一侧就如实标注哪一侧
 *
 * 这个函数是全函数（total）：内部把可预期的异常折叠进 stopReason 并保留已完成的
 * rounds —— 第一轮审核已经真实发生、token 已经花掉，不能因为第二阶段炸了就把
 * 记录归零。只有真正意外的异常才继续往上抛。
 */
export async function runCrossReviewCycle(
  deps: AgentDeps,
  input: CrossReviewCycleInput,
  hooks: CrossReviewCycleHooks,
): Promise<CrossReviewCycleOutcome> {
  const { host } = deps;
  const rounds: CrossReviewRound[] = [];
  let reviewerInvocations = 0;
  let remediations = 0;
  const done = (stopReason: CrossReviewStopReason): CrossReviewCycleOutcome => ({
    rounds: [...rounds],
    reviewerInvocations,
    remediations,
    stopReason,
  });

  // ---- 第 1 轮审核 ----
  let round1: CrossReviewRound;
  try {
    round1 = await input.review({
      patch: input.patch,
      finalVerification: input.finalVerification,
      round: 1,
      priorFindings: input.priorFindings ?? [],
    });
    reviewerInvocations += 1;
  } catch (err) {
    if (reviewAttemptWasDispatched(err)) reviewerInvocations += 1;
    return done(mapReviewFailure(err, host, deps.signal));
  }
  rounds.push(round1);
  const priorFindingFingerprints = new Set(
    (input.priorFindings ?? []).map((finding) => finding.fingerprint),
  );
  const repeatedPriorFingerprints = new Set(
    round1.findings
      .filter((finding) => priorFindingFingerprints.has(finding.fingerprint))
      .map((finding) => finding.fingerprint),
  );
  const explicitlyResolvedPrior = new Set(round1.resolvedFindingFingerprints ?? []);
  const unconfirmedPrior = (input.priorFindings ?? []).filter(
    (finding) =>
      !repeatedPriorFingerprints.has(finding.fingerprint) &&
      !explicitlyResolvedPrior.has(finding.fingerprint),
  );
  if (unconfirmedPrior.length > 0) {
    host.emit(
      'NOTE',
      `续期首审未逐项确认 ${unconfirmedPrior.length} 条既有问题，保持待复核并转人工`,
      { unconfirmedFindingFingerprints: unconfirmedPrior.map((finding) => finding.fingerprint) },
    );
    return done('REVIEWER_INCONCLUSIVE');
  }
  const blocking1 = round1.findings.filter((f) => f.blocking);
  const outcome1 = verdictOutcome(round1, blocking1);
  if (outcome1 !== 'REMEDIATE') return done(outcome1);
  try {
    await hooks.checkpoint?.({
      phase: 'REMEDIATE',
      patch: input.patch,
      findings: blocking1,
      reviewerInvocations,
      remediations,
      reviewId: round1.reviewId ?? `${round1.cycleId ?? 'legacy'}:review:${round1.round}`,
    });
  } catch (err) {
    return done(mapCheckpointFailure(err, host, deps.signal));
  }

  // ---- 整改（1/1）----
  if (remediations >= CROSS_REVIEW_LIMITS.maxRemediations) return done('COUNTER_EXHAUSTED');
  {
    const b = host.budgetExceeded();
    if (b.exceeded) {
      host.emit('NOTE', `预算耗尽，跳过自动整改：${b.reason}`);
      return done('BUDGET_EXHAUSTED');
    }
  }

  host.emit(
    'NOTE',
    `交叉审核发现 ${blocking1.length} 条阻断 → 自动整改（1/${CROSS_REVIEW_LIMITS.maxRemediations}），由实现方执行（${deps.externalAuthor ? '外部作者，candidate → 归一化 → CAS' : '实现方 route'}）`,
    { blocking: blocking1.length },
  );
  remediations += 1;
  const genBefore = deps.workspace.activeGeneration;
  let rem: RemediationPassResult;
  try {
    rem = await runRemediationPass(deps, { patch: input.patch, findings: blocking1 });
  } catch (err) {
    // 整改中断时工作区可能已经前进了几代 —— 恢复，让封存补丁和工作区重新一致
    if (deps.workspace.activeGeneration !== genBefore) {
      hooks.restoreWorkspace();
      host.emit('NOTE', '整改中断，已把工作区恢复到整改前内容');
    }
    if (err instanceof AgentCancelled || deps.signal.aborted) return done('CANCELLED');
    if (err instanceof EgressBlocked) {
      host.emit('NOTE', `整改被出站策略阻断（实现方 route）：${err.reason} —— 转人工`);
      return done('ERROR');
    }
    if (err instanceof InvocationFailed) {
      host.emit('NOTE', `整改的模型调用失败（实现方 route）：${err.message} —— 转人工`);
      return done('ERROR');
    }
    host.emit('NOTE', `整改过程异常：${(err as Error).message} —— 转人工`);
    return done('ERROR');
  }

  if (!rem.mutated) {
    host.emit('NOTE', '整改没有产生任何文件变更 —— 补丁维持原样，转人工');
    return done('NO_DELTA');
  }

  // ---- 整改后重验：补丁必须绑定它自己的验证，不能挂着整改前的旧结果 ----
  let nextVerification: VerificationRun | null = null;
  if (hooks.reverify) {
    nextVerification = await hooks.reverify();
    if (deps.signal.aborted) {
      hooks.restoreWorkspace();
      return done('CANCELLED');
    }
    if (!nextVerification.passed) {
      hooks.restoreWorkspace();
      host.emit(
        'NOTE',
        '整改后验证未通过 —— 已把工作区恢复到整改前内容，补丁维持整改前版本，转人工',
      );
      return done('NO_PROGRESS');
    }
  }

  const resealed = hooks.reseal(nextVerification, rem.truncationReason);
  if (resealed.digest === input.patch.digest) {
    host.emit('NOTE', '整改后的补丁与整改前逐字节相同 —— 无实质变化，转人工');
    return done('NO_DELTA');
  }
  hooks.adoptPatch(resealed);
  try {
    await hooks.checkpoint?.({
      phase: 'SECOND_REVIEW',
      patch: resealed,
      findings: blocking1,
      reviewerInvocations,
      remediations,
      reviewId: round1.reviewId ?? `${round1.cycleId ?? 'legacy'}:review:${round1.round}`,
    });
  } catch (err) {
    return done(mapCheckpointFailure(err, host, deps.signal));
  }

  // ---- 第 2 轮审核（2/2）----
  if (reviewerInvocations >= CROSS_REVIEW_LIMITS.maxReviewerInvocations) return done('COUNTER_EXHAUSTED');
  {
    const b = host.budgetExceeded();
    if (b.exceeded) {
      host.emit('NOTE', `预算耗尽，整改后的补丁未经第二轮审核：${b.reason}`);
      return done('BUDGET_EXHAUSTED');
    }
  }

  let round2: CrossReviewRound;
  try {
    round2 = await input.review({
      patch: resealed,
      finalVerification: nextVerification,
      round: 2,
      priorFindings: blocking1,
    });
    reviewerInvocations += 1;
  } catch (err) {
    if (reviewAttemptWasDispatched(err)) reviewerInvocations += 1;
    return done(mapReviewFailure(err, host, deps.signal));
  }
  rounds.push(round2);
  const blocking2 = round2.findings.filter((f) => f.blocking);
  const repeatedFingerprints = new Set(blocking2.map((finding) => finding.fingerprint));
  const resolvedFingerprints = new Set(round2.resolvedFindingFingerprints ?? []);
  const unconfirmed = blocking1.filter(
    (finding) => !repeatedFingerprints.has(finding.fingerprint) && !resolvedFingerprints.has(finding.fingerprint),
  );
  const outcome2 = verdictOutcome(round2, blocking2);
  if (outcome2 !== 'REMEDIATE') {
    if (unconfirmed.length > 0) {
      host.emit(
        'NOTE',
        `复审未逐项确认 ${unconfirmed.length} 条首审阻断问题，保持待复核并转人工`,
        { unconfirmedFindingFingerprints: unconfirmed.map((finding) => finding.fingerprint) },
      );
      return done('REVIEWER_INCONCLUSIVE');
    }
    return done(outcome2);
  }

  // 进展判定用平台算的指纹，不用模型的自我评价
  const seen = new Set(blocking1.map((f) => f.fingerprint));
  const repeated = blocking2.filter((f) => seen.has(f.fingerprint)).length;
  if (blocking2.length >= blocking1.length || repeated > 0) {
    host.emit(
      'NOTE',
      `第二轮审核：阻断 ${blocking1.length} → ${blocking2.length}，指纹重现 ${repeated} 条 —— 判定无进展，转人工`,
    );
    return done('NO_PROGRESS');
  }
  return done('COUNTER_EXHAUSTED');
}

/** 审核调用失败的归因：审核方 route 出不去 ≠ 泛化的 ERROR，要能对症排查 */
function mapReviewFailure(err: unknown, host: AgentHost, signal: AbortSignal): CrossReviewStopReason {
  if (err instanceof ModelDispatchBudgetExceeded) {
    host.emit('BUDGET_EXHAUSTED', err.message);
    return 'BUDGET_EXHAUSTED';
  }
  if (err instanceof AgentCancelled || signal.aborted) return 'CANCELLED';
  if (err instanceof EgressBlocked) {
    host.emit('NOTE', `审核方出站被阻断：${err.reason}`);
    return 'REVIEWER_UNAVAILABLE';
  }
  if (err instanceof InvocationFailed) {
    host.emit('NOTE', `审核方模型调用失败：${err.message}`);
    return 'REVIEWER_UNAVAILABLE';
  }
  host.emit('NOTE', `交叉审核异常：${(err as Error).message}`);
  return 'ERROR';
}

function reviewAttemptWasDispatched(err: unknown): boolean {
  if (err instanceof InvocationFailed) return true;
  if (err instanceof ModelDispatchBudgetExceeded) return err.modelInvocationDispatched;
  return err instanceof AgentCancelled && err.modelInvocationDispatched;
}

/**
 * 交接等待属于 Core 编排，不是审核方调用。它失败时仍须返回已经完成的 rounds，
 * 但不能把持久化、过期或取消错误误报成“审核方不可用”。
 */
function mapCheckpointFailure(err: unknown, host: AgentHost, signal: AbortSignal): CrossReviewStopReason {
  if (err instanceof AgentCancelled || signal.aborted) return 'CANCELLED';
  host.emit('NOTE', `交接等待失败：${(err as Error).message}`);
  return 'ERROR';
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 执行阶段的一轮循环。
 *
 * 返回值必须区分"模型自己说完了"、"预算把它掐断了"和"模型输出被截断了" —— 之前前两者
 * 用同一个 return，上游看到的都是"executionTurns 结束了"，于是被预算截断的执行会被当成
 * 正常完工，补丁照发、文案照写"已完成"。输出截断是同一个形状的坑：模型的话没说完，
 * 但循环确实返回了。
 */
type ExecutionEnd =
  | { kind: 'MODEL_ENDED_TURN' }
  | { kind: 'BUDGET_EXHAUSTED'; reason: string }
  | { kind: 'RESPONSE_TRUNCATED'; reason: string };

/**
 * 这一轮执行是不是**没跑完**。预算掐断与输出截断都算，两者都不能当正常完工。
 *
 * 判据收成一处：未验证模式分支、PATCH_READY 收尾、交叉审核整改路径三个消费点共用。
 * 分开写就会漂 —— 而漂的后果是同一个 Run 在补丁详情里说"被截断"、在未验证清单里不说。
 *
 * 返回值自带成因类别，因为上层文案统一说"没跑完"、不猜成因：
 * - 预算那一路的 reason 来自 `budgetExceeded()`，只说"模型轮次达上限 2"，
 *   不点明这是预算问题，所以这里补前缀；
 * - 输出截断那一路的 reason 由 `stopReasonBlockLabel` 产出，本身已点明成因，
 *   再叠前缀就成了"模型输出被截断：模型输出达到长度上限被截断"。
 */
function executionTruncationReason(end: ExecutionEnd | null): string | null {
  if (!end) return null;
  if (end.kind === 'BUDGET_EXHAUSTED') return `预算耗尽：${end.reason}`;
  if (end.kind === 'RESPONSE_TRUNCATED') return end.reason;
  return null;
}

/**
 * 模型正文的长度上限。
 *
 * 上一版是 400 字**且不报数** —— 真机上一段项目分析正好在第 400 个字符处被切断，
 * 界面显示到半句话就没了，用户无从知道后面还有内容。这既违反"省略要报数"，
 * 又让最该读的那段话变得读不完。
 *
 * 4000 字能装下模型的一段完整结论（实测一般 200–2000 字），同时给事件日志一个上界：
 * 20 轮 × 4000 字 ≈ 80KB，不至于让 JSONL 失控。超出的部分如实报长度。
 */
const ASSISTANT_MESSAGE_MAX_CHARS = 4000;

/**
 * 把模型这一轮说的话记进事件流。
 *
 * 空文本不发事件：模型经常只调工具不说话，为它凭空造一条空消息只会让时间线更吵。
 * 截断必须报数（不变式 8）—— payload 带 truncated 与原始长度，界面据此明说"还有多少"。
 */
function sayIfAny(host: AgentHost, purpose: string, content: readonly ContentBlock[]): boolean {
  const said = textOf(content).trim();
  if (!said) return false;
  const truncated = said.length > ASSISTANT_MESSAGE_MAX_CHARS;
  host.emit('ASSISTANT_MESSAGE', truncated ? said.slice(0, ASSISTANT_MESSAGE_MAX_CHARS) : said, {
    purpose,
    truncated,
    fullLength: said.length,
  });
  return true;
}

async function executionTurns(
  deps: AgentDeps,
  conversation: ModelMessage[],
): Promise<ExecutionEnd> {
  const { host } = deps;
  const tools = TOOLS;

  for (;;) {
    throwIfCancelled(deps.signal);
    const budget = host.budgetExceeded();
    if (budget.exceeded) {
      host.emit('BUDGET_EXHAUSTED', budget.reason);
      return { kind: 'BUDGET_EXHAUSTED', reason: budget.reason };
    }

    let response: ModelResponse;
    try {
      ({ response } = await callModel(deps, conversation, tools, 'EXECUTION'));
    } catch (error) {
      if (error instanceof ModelDispatchBudgetExceeded) {
        host.emit('BUDGET_EXHAUSTED', error.message);
        return { kind: 'BUDGET_EXHAUSTED', reason: error.message };
      }
      throw error;
    }
    const uses = toolUsesOf(response.content);
    conversation.push({ role: 'assistant', content: response.content });

    /*
     * 每一轮都把模型说的话记下来 —— 不只是它停手的那一轮。
     *
     * 之前这一句在 `uses.length === 0` 分支里面，意思是：**有工具调用的那些轮，
     * 模型写的东西整段丢弃**。那正是"每组工具调用之间那句有结论的话"消失的地方，
     * 而它恰好是整条时间线里信息密度最高的东西。
     */
    sayIfAny(host, 'EXECUTION', response.content);

    /*
     * 响应不完整就到此为止：这一轮的工具一个都不派发。
     *
     * 必须判在提取 uses 之后、派发之前 —— 判在 dispatchTool 里不够（规划与审核的
     * 结构化提交绕过它），而且纯文本的截断响应根本没有工具可拦，却同样不能报成
     * "模型说完了"：那会让上游把半截执行当正常完工。
     */
    const incomplete = findIncompleteResponse(response);
    if (incomplete) {
      host.emit(
        'MODEL_INVOCATION',
        `执行轮响应不完整：${incomplete} —— 本轮 ${uses.length} 个工具调用一律未执行`,
        { purpose: 'EXECUTION', stopReason: response.stopReason, unexecutedToolCalls: uses.length },
      );
      if (uses.length > 0) pushUser(conversation, unexecutedToolResults(uses, incomplete));
      return { kind: 'RESPONSE_TRUNCATED', reason: incomplete };
    }

    if (uses.length === 0) return { kind: 'MODEL_ENDED_TURN' };

    const results: ContentBlock[] = [];
    try {
      for (const use of uses) {
        throwIfCancelled(deps.signal);
        const outcome = await dispatchTool(deps, use.name, use.input, 'EXECUTION');
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: outcome.text,
          isError: !outcome.ok,
        });
      }
    } finally {
      // 正常跑完、被取消、或 dispatchTool 抛错，都必须把本轮**全部** tool_use 回填。
      // 半截的历史一旦被复用（重启续跑、交叉审核复读），两家 wire 都会返回 400，
      // 而且是此后每一次请求都失败 —— 见 findOrphanToolUse。
      for (const use of uses.slice(results.length)) {
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: '该工具调用未完成（执行被中断）。',
          isError: true,
        });
      }
      pushUser(conversation, results);
    }
  }
}

// ---------------------------------------------------------------------------
// 工具分发 —— 每次调用都有且只有一个 resolution
// ---------------------------------------------------------------------------

type Phase = 'PLANNING' | 'EXECUTION' | 'REVIEW';

async function dispatchTool(
  deps: AgentDeps,
  toolName: string,
  rawInput: unknown,
  phase: Phase,
  /**
   * 本轮**只允许**这些工具（不传 = 不额外收窄）。
   *
   * 为什么要在这一层而不是只把 schema 列表收窄：`dispatchTool` 查的是全局
   * `TOOLS_BY_NAME`，模型只要凭记忆点名一个没给它的工具就会真的执行 ——
   * 规划期只读闸门当年就是栽在这上面。少给几个 schema 只是"模型看不见"，
   * 不是"平台不让"。规划最后一轮的强制收口必须是后者，否则一个不听话的模型
   * 照样能接着读到超时。
   */
  allowOnly?: ReadonlySet<string>,
  /** 真的派发出去时回报参数摘要 —— 摘要由工具自己算（不含宿主绝对路径），调用方不该自己拼 */
): Promise<{ ok: boolean; text: string; summary?: string }> {
  const { host } = deps;
  const def = TOOLS_BY_NAME.get(toolName);

  if (!def) {
    const id = host.beginToolCall({
      toolName,
      risk: 'R0',
      argsSummary: '未知工具',
      argsDigest: digestOf(rawInput),
    });
    host.endToolCall(id, 'DENIED', 'UNKNOWN_TOOL', `未注册的工具: ${toolName}`, false, null);
    return { ok: false, text: `错误：不存在名为 ${toolName} 的工具。可用工具：${[...TOOLS_BY_NAME.keys()].join(', ')}` };
  }

  // 决策前的 runtime schema 校验 —— 不做 JSON 修复，不 fallback 成 {}
  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    const id = host.beginToolCall({
      toolName,
      risk: def.risk,
      argsSummary: '参数不合法',
      argsDigest: digestOf(rawInput),
    });
    host.endToolCall(id, 'FAILED', 'SCHEMA_INVALID', detail, false, null);
    return { ok: false, text: `参数 schema 校验失败：${detail}` };
  }

  const args = parsed.data;
  const toolCallId = host.beginToolCall({
    toolName,
    risk: def.risk,
    argsSummary: def.summarize(args),
    argsDigest: digestOf(args),
  });

  /*
   * 阶段闸门：规划期只允许 R0。
   *
   * 这一道必须在**平台侧**，不能只靠"给模型少看几个 schema"。
   * PLANNING_TOOLS 决定的是模型看得见什么，但 dispatchTool 查的是全局
   * TOOLS_BY_NAME —— 模型只要凭记忆点名 workspace_mutate，之前就会真的执行。
   * PRD-PLAN-001 要求的是 capability envelope 强制，不是 prompt 自律。
   */
  if (allowOnly && !allowOnly.has(def.name)) {
    host.endToolCall(
      toolCallId,
      'DENIED',
      'TURN_TOOL_RESTRICTED',
      `本轮平台只允许 ${[...allowOnly].join(' / ')}`,
      false,
      null,
    );
    return {
      ok: false,
      text:
        `工具 ${toolName} 在这一轮不可用 —— 平台只留下了 ${[...allowOnly].join(' / ')}。` +
        `这是最后一轮规划，请用已经掌握的信息调用 submit_plan，没核实的写进 risks。`,
    };
  }

  if ((phase === 'PLANNING' || phase === 'REVIEW') && def.risk !== 'R0') {
    const label = phase === 'PLANNING' ? '规划阶段' : '交叉审核阶段';
    host.endToolCall(
      toolCallId,
      'DENIED',
      'PHASE_READONLY',
      `${label}被平台强制为只读，${def.risk} 工具不可用`,
      false,
      null,
    );
    return {
      ok: false,
      text:
        phase === 'PLANNING'
          ? `工具 ${toolName} 在规划阶段不可用 —— 这一阶段由平台强制为只读，` +
            `不是提示词约束。请先用只读工具把问题看清楚，再调用 submit_plan 提交计划；` +
            `用户批准后才会进入可以修改文件的执行阶段。`
          : `工具 ${toolName} 在交叉审核阶段不可用 —— 审核方由平台强制为只读，` +
            `不能改动工作区、不能运行命令。请只用只读工具核对补丁，然后调用 submit_review 提交发现。`,
    };
  }

  // 风险门：R3/R4 在首个切片直接拒绝，不提供"逐项审批后继续"的入口
  if (def.risk === 'R3' || def.risk === 'R4') {
    host.endToolCall(toolCallId, 'DENIED', 'RISK_HARD_DENY', `${def.risk} 在首个切片硬拒绝`, false, null);
    return { ok: false, text: `该操作风险等级 ${def.risk}，在当前版本被硬性拒绝。` };
  }

  if (deps.signal.aborted) {
    host.endToolCall(toolCallId, 'CANCELLED', 'RUN_CANCELLED', '', false, null);
    throw new AgentCancelled();
  }

  host.chargeToolCall();

  try {
    const ctx: ToolContext = {
      runId: deps.runId,
      attemptId: deps.attemptId,
      workspace: deps.workspace,
      profile: deps.profile,
      mutationPolicy: deps.mutationPolicy,
      signal: deps.signal,
    };
    const outcome = await def.execute(args, ctx);
    host.endToolCall(
      toolCallId,
      outcome.ok ? 'SUCCEEDED' : 'FAILED',
      outcome.failureReason ?? null,
      outcome.preview,
      outcome.previewTruncated,
      outcome.artifactRef,
      outcome.meta,
    );
    if (def.name === 'workspace_mutate' && outcome.ok) {
      host.emit('MUTATION_APPLIED', outcome.preview, outcome.meta ?? {});
    }
    return { ok: outcome.ok, text: outcome.modelText, summary: def.summarize(args) };
  } catch (err) {
    if (err instanceof AgentCancelled || deps.signal.aborted) {
      host.endToolCall(toolCallId, 'CANCELLED', 'RUN_CANCELLED', '', false, null);
      throw new AgentCancelled();
    }
    const message = (err as Error).message ?? String(err);
    host.endToolCall(toolCallId, 'FAILED', 'TOOL_EXCEPTION', message, false, null);
    return { ok: false, text: `工具执行异常：${message}` };
  }
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

async function callModel(
  deps: AgentDeps,
  conversation: readonly ModelMessage[],
  tools: readonly ToolDefinition[],
  purpose: 'PLANNING' | 'EXECUTION' | 'CROSS_REVIEW',
  /** 交叉审核走审核方的 route，其余走 implementer 的 route */
  resolutionOverride?: ModelRouteResolution,
  systemOverride?: string,
): Promise<{ response: ModelResponse; invocationId: string; manifest: ModelEgressManifest }> {
  const schemas: ToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.jsonSchema,
  }));
  const unsettledDispatches: ModelDispatchAttempt[] = [];
  const settleDispatches = (
    finalUsage: { inputTokens: number | null; outputTokens: number | null } | null,
  ): void => {
    while (unsettledDispatches.length > 0) {
      const attempt = unsettledDispatches.shift()!;
      const isFinalSuccessfulAttempt = finalUsage !== null && unsettledDispatches.length === 0;
      deps.host.settleModelTurn(
        isFinalSuccessfulAttempt ? finalUsage.inputTokens : null,
        isFinalSuccessfulAttempt ? finalUsage.outputTokens : null,
      );
      deps.host.emit(
        'MODEL_INVOCATION',
        `${purpose} 第 ${attempt.sendAttempt} 次派发已结算（in=${isFinalSuccessfulAttempt ? finalUsage.inputTokens ?? '?' : '?'} out=${isFinalSuccessfulAttempt ? finalUsage.outputTokens ?? '?' : '?'}）`,
        {
          phase: 'DISPATCH_SETTLED',
          invocationId: attempt.invocationId,
          sendAttempt: attempt.sendAttempt,
          usageKnown: isFinalSuccessfulAttempt && finalUsage.inputTokens !== null && finalUsage.outputTokens !== null,
        },
      );
    }
  };

  try {
    const { response, manifest, invocationId } = await deps.gateway.invoke({
      runId: deps.runId,
      attemptId: deps.attemptId,
      purpose,
      resolution: resolutionOverride ?? deps.resolution,
      request: {
        system: systemOverride ?? systemPrompt(deps, purpose as 'PLANNING' | 'EXECUTION'),
        messages: conversation,
        tools: schemas,
        maxOutputTokens: 8000,
        temperature: 0,
      },
      contextFileRefs: [],
      signal: deps.signal,
      onDispatch: (attempt) => {
        const budget = deps.host.budgetExceeded();
        if (budget.exceeded) {
          throw new ModelDispatchBudgetExceeded(budget.reason, unsettledDispatches.length > 0);
        }
        /*
         * 先写派发意图，再把预算预留进 Run 快照。两份证据都成功后才进入 adapter；
         * 任一步失败都不会发请求，也不会把未派发的尝试计进预算。
         */
        deps.host.emit(
          'MODEL_INVOCATION',
          `${purpose} 第 ${attempt.sendAttempt} 次调用准备派发 ${attempt.modelId}`,
          { phase: 'DISPATCH_INTENT', ...attempt },
        );
        deps.host.reserveModelTurn(attempt);
        unsettledDispatches.push(attempt);
      },
      /*
       * 有人接增量才走流式。host 不实现 streamText（老的测试替身、headless 场景）
       * 就退回一次性请求 —— 有没有流不影响权威结果，只影响文本什么时候到界面。
       */
      ...(deps.host.streamText ? { onStream: (sig: StreamSignal) => deps.host.streamText!(sig) } : {}),
    });

    settleDispatches({
      inputTokens: manifest.inputTokens,
      outputTokens: manifest.outputTokens,
    });
    deps.host.emit(
      'MODEL_INVOCATION',
      `${purpose} 调用 ${manifest.modelId}（in=${manifest.inputTokens ?? '?'} out=${manifest.outputTokens ?? '?'}）`,
      { manifest },
    );
    return { response, invocationId, manifest };
  } catch (err) {
    settleDispatches(null);
    if (err instanceof EgressBlocked) {
      deps.host.emit('MODEL_INVOCATION', `模型出站被阻断：${err.reason}`, { manifest: err.manifest });
      throw err;
    }
    if (err instanceof InvocationFailed) {
      deps.host.emit('MODEL_INVOCATION', `模型调用失败：${err.cause.kind} ${err.message}`, {
        manifest: err.manifest,
      });
      if (err.cause.kind === 'CANCELLED') throw new AgentCancelled(true);
      throw err;
    }
    if (err instanceof ModelDispatchBudgetExceeded) throw err;
    throw err;
  }
}

function systemPrompt(deps: AgentDeps, purpose: 'PLANNING' | 'EXECUTION'): string {
  const { task, profile } = deps;
  const commands = Object.values(profile.commands)
    .map((c) => `  - ${c.commandId}: ${c.label}`)
    .join('\n');

  const common = `你是 RepoPilot 的代码修复 Agent，工作在一个 ${profile.adapterId} 仓库的隔离工作区中。

工作区事实：
- 这是仓库固定 commit 的只读快照的可写副本。宿主仓库不会被写入。
- 当前 generation: gen-${deps.workspace.activeGeneration}
- 包管理器: ${profile.packageManager}
- 可用命令:
${commands || '  （无）'}

任务：
- 目标: ${task.goal}
- 允许修改的路径: ${renderAllowedPaths(task.allowedPaths)}
- 受保护路径（禁止修改）: ${task.protectedPaths.join(', ') || '（无）'}
- 验收条件:
${task.acceptance.map((a) => `  - ${a}`).join('\n') || '  （无）'}

平台约束（这些是硬性的，绕不过去）：
- 你没有 shell，没有文件系统写接口。所有改动只能通过 workspace_mutate。
- 修改现有文件前，必须先 fs_read 拿到 receiptId，并在 mutate 时传回去。
- REPLACE_EXACT_TEXT_SPAN 的 oldText 必须在文件中**恰好出现一次**。命中 0 次或多次都会整笔失败，不会做模糊匹配。所以要带足够多的上下文让它唯一。
- CREATE_FILE 的目标必须不存在。不存在"隐式覆盖"。
- 一次 workspace_mutate 是原子的：任何一个 operation 不合法，整笔都不生效。
- 你不能声称"修好了"，成功由 run_command 的真实退出码决定。`;

  if (purpose === 'PLANNING') {
    const planTurns = planningTurnBudget(task);
    /*
     * 有验证命令 = 基线真的失败过（全绿会在规划之前就以 NO_CHANGES 收尾），
     * 那时"找根因"才成立。没有验证命令时**根本没有失败可以复现** ——
     * 再让模型去"把失败原因搞清楚"，它就会一直读下去找一个不存在的东西。
     * 真实样本里那次 20 轮只读、一个字没说的规划，任务是"你能找出部分优化的点吗"。
     */
    const objective =
      task.verificationCommandIds.length > 0
        ? `先用 fs_read / fs_grep / fs_glob / fs_list 把失败原因搞清楚，读到足够的证据后，调用 submit_plan 提交计划。
计划要说清根因，而不只是"修复报错"。`
        : `本次任务**没有配置验证命令，也没有失败可以复现** —— 不要去找"根因"。
先用 fs_read / fs_grep / fs_glob / fs_list 把相关代码看清楚，然后调用 submit_plan 提交一份具体的改动计划：
改哪些文件、改成什么、为什么。看不准的地方写进 risks，不要用"进一步排查"占位。`;

    return `${common}

当前阶段：**规划**。平台已经把你限制为只读工具，你现在**无法**修改任何文件。

规划的轮次预算是 **${planTurns} 轮**（本任务模型轮次预算 ${task.budget.maxModelTurns} 轮的一半）。
每一轮的工具结果后面会告诉你还剩几轮；**最后一轮平台只会留下 submit_plan**，那时读不了文件了。
所以要边读边收敛：不要打算把仓库读完再动笔，够用就提交，没查清的写进 risks。

${objective}`;
  }

  return `${common}

当前阶段：**执行**。用户已批准计划，你现在可以修改文件并运行验证命令。
按计划执行，改完后一定要用 run_command 跑验证。全部通过后用一句话总结你的改动并结束。`;
}

function buildTaskBrief(deps: AgentDeps, baseline: VerificationRun | null): string {
  const base =
    deps.snapshot.baseKind === 'NO_VCS'
      ? '（该项目不在版本控制下，基线是导入当时的目录内容）'
      : `${deps.snapshot.baseSha.slice(0, 12)} (${deps.snapshot.branch})` +
        (deps.snapshot.baseKind === 'DIRTY_WORKTREE'
          ? ` + ${deps.snapshot.dirtyFileCount} 项未提交改动`
          : '');

  /*
   * 模型的世界就是这份快照。它没进来的东西，模型不该以为自己能改 ——
   * 否则模型会去"修"一个它看不见的文件，然后把失败归因到别处。
   */
  const absences: string[] = [];
  if (deps.snapshot.untrackedCount > 0) {
    absences.push(
      `- 未跟踪文件: ${deps.snapshot.untrackedCount} 个，**不在快照里**（快照只含 tracked 文件，它们对你不可见）`,
    );
  }
  const truncatedEnumeration = deps.snapshot.excludedPaths.some(
    (e) => e.reason === 'ENUMERATION_TRUNCATED',
  );
  if (truncatedEnumeration) {
    absences.push('- 注意: 文件枚举被上限截断，这份快照不完整，上面的文件数不是仓库全部');
  }
  const unreadable = deps.snapshot.excludedPaths.filter((e) => e.reason === 'UNREADABLE').length;
  if (unreadable > 0) {
    absences.push(`- 读取失败: ${unreadable} 个路径存在但读不了，不在快照里`);
  }
  /*
   * 仓库形态造成的缺席（LFS / 子模块 / 未检出 / 大小写碰撞）要点名说。
   * 模型的世界就是这份快照：不说清楚，它会去"修"一个它看不见的文件，然后把失败归因到别处。
   */
  for (const shape of summarizeShapes(deps.snapshot.excludedPaths)) {
    const label =
      shape.kind === 'LFS_POINTER'
        ? 'Git LFS 指针'
        : shape.kind === 'SUBMODULE'
          ? '子模块'
          : shape.kind === 'NOT_CHECKED_OUT'
            ? '索引里有但未检出'
            : '仅大小写不同的重名路径';
    absences.push(
      `- ${label}: ${shape.count} 项**不在快照里**（例如 ${shape.samples.join('、')}）—— 你看不到它们，也不要假设它们存在`,
    );
  }

  const header = `仓库信息：
- base: ${base}
- 快照文件数: ${deps.snapshot.fileCount}
- 检测到的技术栈信号: ${deps.profile.detectedSignals.join(', ') || '（无）'}${
    absences.length > 0 ? `\n${absences.join('\n')}` : ''
  }`;

  if (!baseline) {
    return `请完成以下任务。

${header}
${renderChangeRequest(deps)}

注意：本次任务**没有配置任何验证命令**，你无法用运行结果证明改动是对的。
因此请只做任务明确要求的改动，读够上下文再动手，并在最后说明哪些地方你没有把握。

请先了解相关代码，再提交计划。`;
  }

  return `请修复以下仓库中的失败。

${header}

基线验证结果（修改前的真实状态）：
${summarizeFailures(baseline)}
${renderChangeRequest(deps)}
请先定位根因，再提交计划。`;
}

/**
 * 用户要求修改时的追加简报。
 *
 * 工作区已经从快照重新物化，上一版改动**不在**里面 —— 所以要把上一版 diff 附上，
 * 否则模型既不知道自己上次做了什么，也无从判断哪里要改。同时明说"这是同一个任务的第 N 次尝试、
 * 预算是接着用的"，避免它以为可以从头挥霍。
 */
function renderChangeRequest(deps: AgentDeps): string {
  const cr = deps.changeRequest;
  if (!cr) return '';
  const diff = cr.previousPatchDiff.slice(0, 24_000);
  return `
用户审查了第 ${cr.previousAttemptNo} 次尝试的补丁，**要求修改**：
${cr.note.trim() || '（用户没有填写具体反馈）'}

上一版补丁（工作区已回到修改前的状态，下面的改动**不在**当前工作区里）：
\`\`\`diff
${diff}
\`\`\`${cr.previousPatchDiff.length > 24_000 ? '\n（diff 过长已截断）' : ''}

请针对用户的反馈重做：不要原样重复上一版的改法，也不要为了"显得不同"而扩大范围。
这是同一个任务的第 ${cr.previousAttemptNo + 1} 次尝试，预算与上一次共用同一份，没有重置。
`;
}

function renderPlan(plan: PlanRevision): string {
  const steps = plan.steps
    .map((s) => `${s.index}. ${s.intent}${s.targetPaths.length ? ` [${s.targetPaths.join(', ')}]` : ''}`)
    .join('\n');
  return `计划摘要: ${plan.summary}\n${steps}${plan.risks.length ? `\n风险: ${plan.risks.join('; ')}` : ''}`;
}

/**
 * 给外部作者的简报：目标、范围、受保护路径、验收、**用户批准的计划**、基线失败，
 * 以及自修复轮的上一次验证失败摘要。不含仓库地图 —— 它在 candidate 目录里自己看。
 */
function renderExternalAuthorBrief(
  deps: AgentDeps,
  plan: PlanRevision,
  baseline: VerificationRun | null,
  failureSummary: string | null,
): string {
  const { task } = deps;
  const acceptance = task.acceptance.length ? task.acceptance.map((a) => `- ${a}`).join('\n') : '（未填写）';
  return [
    `任务目标：${task.goal}`,
    `允许改动的路径：${renderAllowedPaths(task.allowedPaths)}`,
    `受保护路径（禁止改动）：${task.protectedPaths.join(', ') || '（无）'}`,
    `验证输入（tsconfig/vite/vitest/eslint 配置、测试文件、验证脚本）：不要为了让验证变绿而改它们 —— 平台会标为 COVERAGE_WEAKENED，补丁将失去"已验证"资格；除非任务明确要求`,
    `验收标准：\n${acceptance}`,
    `用户已批准的计划（按此执行，不要扩大范围）：\n${renderPlan(plan)}`,
    baseline ? `基线验证结果（修改前的真实状态）：\n${summarizeFailures(baseline)}` : '本次任务没有配置验证命令，请格外保守。',
    renderChangeRequest(deps).trim(),
    failureSummary ? `上一版改动之后的验证结果（仍未通过）：\n${failureSummary}\n请先判断是否与之前相同的失败；是同一个错误就换一种思路。` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildUnverifiedItems(
  task: TaskSpec,
  profile: RepositoryHarnessProfile,
  comparison: ReturnType<typeof compareVerification> | null,
): string[] {
  const items: string[] = [];

  if (task.verificationCommandIds.length === 0) {
    items.push('⚠ 本次运行没有执行任何验证命令 —— 全部改动都未经机器验证');
    const available = Object.keys(profile.commands);
    if (available.length > 0) {
      items.push(`该项目其实解析出了可用命令（${available.join(', ')}），下次可以选上`);
    }
  }

  for (const id of Object.keys(profile.commands)) {
    if (!task.verificationCommandIds.includes(id)) {
      items.push(`命令 "${id}" 未被本次任务纳入验证范围`);
    }
  }
  for (const a of task.acceptance) {
    items.push(`验收条件「${a}」由人工判断，没有对应的自动断言`);
  }
  if (comparison && comparison.stillFailing.length > 0) {
    items.push(`以下命令在基线和修复后都失败，未被本次修复覆盖：${comparison.stillFailing.join(', ')}`);
  }
  items.push('运行时行为、视觉表现和未被测试覆盖的分支均未验证');
  return items;
}

/**
 * 补丁封存时的完整"未验证清单"。runAgent 的 PATCH_READY 收尾和交叉审核整改后的
 * 重新封存走的是**同一个**函数 —— 两处口径不一致的话，重封存的补丁会看起来
 * 比第一次封存"更干净"，而那只是漏写了几行。
 */
export function composeUnverifiedItems(
  task: TaskSpec,
  profile: RepositoryHarnessProfile,
  comparison: ReturnType<typeof compareVerification> | null,
  truncationReason: string | null,
): string[] {
  return [
    ...(truncationReason ? [`⚠ 执行没跑完就停了（${truncationReason}）`] : []),
    ...(comparison && comparison.notRerun.length > 0
      ? [`以下基线失败的命令本次未重跑，状态未知：${comparison.notRerun.join(', ')}`]
      : []),
    ...buildUnverifiedItems(task, profile, comparison),
  ];
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentCancelled();
}
