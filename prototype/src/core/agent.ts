import { z } from 'zod';
import type {
  ModelRouteResolution,
  PlanRevision,
  PlanStep,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEventKind,
  RunStatus,
  TaskSpec,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { EgressBlocked, InvocationFailed, ModelGateway } from './model/gateway';
import type { ContentBlock, ModelMessage, ToolSchema } from './model/types';
import { textOf, toolUsesOf } from './model/types';
import type { MutationPolicy } from './mutation';
import { PLANNING_TOOLS, TOOLS, TOOLS_BY_NAME, type ToolContext, type ToolDefinition } from './tools';
import { compareVerification, runVerification, summarizeFailures } from './verify';
import type { MaterializedWorkspace } from './workspace';

export interface AgentHost {
  emit(kind: RunEventKind, summary: string, payload?: Record<string, unknown>): void;
  setStatus(status: RunStatus, reason: string | null): void;
  /** 阻塞直到用户对该计划作出决定；被取消时抛出 */
  awaitPlanApproval(plan: PlanRevision): Promise<'APPROVE' | 'REJECT'>;
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
  ): void;
  chargeModelTurn(inputTokens: number, outputTokens: number): void;
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

export interface AgentDeps {
  readonly task: TaskSpec;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  readonly workspace: MaterializedWorkspace;
  readonly gateway: ModelInvoker;
  readonly resolution: ModelRouteResolution;
  readonly mutationPolicy: MutationPolicy;
  readonly runId: string;
  readonly attemptId: string;
  readonly signal: AbortSignal;
  readonly host: AgentHost;
}

export interface AgentResult {
  readonly kind: 'PATCH_READY' | 'NO_CHANGES' | 'PLAN_REJECTED' | 'BLOCKED' | 'VERIFICATION_FAILED';
  readonly detail: string;
  readonly baseline: VerificationRun | null;
  readonly finalVerification: VerificationRun | null;
  readonly unverifiedItems: string[];
}

export class AgentCancelled extends Error {}

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
    host.setStatus('EXECUTING', '正在建立验证基线');
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
    host.setStatus('EXECUTING', '未选择验证命令，本次以未验证模式运行');
    host.emit('NOTE', '未验证模式：不跑基线、不跑重验、不做自修复，补丁全部标记为未验证');
  }

  // ---- 1. 规划阶段：平台强制 read-only ----
  host.setStatus('PLANNING', null);
  const conversation: ModelMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: buildTaskBrief(deps, baseline) }],
    },
  ];

  const plan = await generatePlan(deps, conversation);
  throwIfCancelled(signal);
  host.emit('PLAN_GENERATED', `计划已生成：${plan.summary}`, { plan });

  // ---- 2. 用户审批 ----
  host.setStatus('AWAITING_PLAN_APPROVAL', null);
  const decision = await host.awaitPlanApproval(plan);
  host.emit('PLAN_DECISION', `用户${decision === 'APPROVE' ? '批准' : '拒绝'}了计划`, {
    planId: plan.planId,
    decision,
  });
  if (decision === 'REJECT') {
    return {
      kind: 'PLAN_REJECTED',
      detail: '用户拒绝了计划，未产生任何副作用。',
      baseline,
      finalVerification: null,
      unverifiedItems: [],
    };
  }

  // ---- 3. 执行 + 有界自修复 ----
  host.setStatus('EXECUTING', null);
  conversation.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `用户已批准以下计划，现在开始执行。\n\n${renderPlan(plan)}\n\n` +
          `执行规则：\n` +
          `- 修改现有文件前必须先用 fs_read 取得 receiptId。\n` +
          `- 用 workspace_mutate 提交改动；oldText 必须在文件中唯一命中。\n` +
          (verificationEnabled
            ? `- 改完后用 run_command 跑 ${task.verificationCommandIds.join(' / ')} 验证。\n` +
              `- 全部通过后，用一句话说明你做了什么，然后结束（不要再调用工具）。`
            : `- 本次任务没有配置验证命令，你无法证明改动是对的。因此要格外保守：\n` +
              `  只做计划里明确说过的改动，不要顺手重构。\n` +
              `- 改完后用一句话说明你做了什么、以及哪些地方你没有把握，然后结束。`),
      },
    ],
  });

  let finalVerification: VerificationRun | null = null;
  let round = 0;
  const maxRounds = task.budget.maxSelfFixRounds;

  for (;;) {
    throwIfCancelled(signal);
    await executionTurns(deps, conversation);
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
      return {
        kind: 'PATCH_READY',
        detail: `产生了 ${workspace.changedFilesVsBaseline().length} 个文件变更（本次运行没有任何机器验证）。`,
        baseline: null,
        finalVerification: null,
        unverifiedItems: buildUnverifiedItems(task, profile, null),
      };
    }

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

    round += 1;
    host.chargeSelfFixRound();
    host.emit('SELF_FIX_ROUND', `进入第 ${round}/${maxRounds} 轮自修复`, { round });
    conversation.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `验证仍未通过。这是第 ${round}/${maxRounds} 轮自修复，也是你最后的机会之一。\n\n` +
            `${summarizeFailures(finalVerification)}\n\n` +
            `请先判断这是不是与之前相同的失败。如果是同一个错误，说明上一次的改法不对，换一种思路。`,
        },
      ],
    });
  }

  const comparison = compareVerification(baseline!, finalVerification);
  const unverified = buildUnverifiedItems(task, profile, comparison);

  return {
    kind: 'PATCH_READY',
    detail: `验证通过（修复 ${comparison.fixed.join(', ') || '无'}），共 ${workspace.changedFilesVsBaseline().length} 个文件变更。`,
    baseline,
    finalVerification,
    unverifiedItems: unverified,
  };
}

// ---------------------------------------------------------------------------
// 规划
// ---------------------------------------------------------------------------

async function generatePlan(deps: AgentDeps, conversation: ModelMessage[]): Promise<PlanRevision> {
  const { host } = deps;
  const tools = [...PLANNING_TOOLS, submitPlan as unknown as ToolDefinition];
  const maxPlanTurns = Math.min(12, deps.task.budget.maxModelTurns);

  for (let turn = 0; turn < maxPlanTurns; turn += 1) {
    throwIfCancelled(deps.signal);
    const budget = host.budgetExceeded();
    if (budget.exceeded) throw new PlanningFailed(`预算耗尽：${budget.reason}`);

    const response = await callModel(deps, conversation, tools, 'PLANNING');
    const uses = toolUsesOf(response.content);

    if (uses.length === 0) {
      // 没有调用 submit_plan 就想结束 —— 明确要求它提交结构化计划
      conversation.push({ role: 'assistant', content: response.content });
      conversation.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请调用 submit_plan 工具提交结构化计划。纯文字回复不能进入审批流程。',
          },
        ],
      });
      continue;
    }

    conversation.push({ role: 'assistant', content: response.content });
    const results: ContentBlock[] = [];

    for (const use of uses) {
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
        const core = {
          runId: deps.runId,
          snapshotId: deps.snapshot.snapshotId,
          summary: parsed.data.summary,
          steps,
          risks: parsed.data.risks,
        };
        return {
          planId: newId('plan'),
          runId: deps.runId,
          revision: 1,
          parentPlanId: null,
          snapshotId: deps.snapshot.snapshotId,
          summary: parsed.data.summary,
          steps,
          risks: parsed.data.risks,
          verificationCommandIds: deps.task.verificationCommandIds,
          digest: digestOf(core),
          generatedBy: {
            invocationId: newId('inv'),
            purpose: 'PLANNING',
            resolutionId: deps.resolution.resolutionId,
          },
          createdAt: nowIso(),
        };
      }

      const outcome = await dispatchTool(deps, use.name, use.input);
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: outcome.text,
        isError: !outcome.ok,
      });
    }

    conversation.push({ role: 'user', content: results });
  }

  throw new PlanningFailed(`规划阶段用满 ${maxPlanTurns} 轮仍未提交计划`);
}

export class PlanningFailed extends Error {}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

async function executionTurns(deps: AgentDeps, conversation: ModelMessage[]): Promise<void> {
  const { host } = deps;
  const tools = TOOLS;

  for (;;) {
    throwIfCancelled(deps.signal);
    const budget = host.budgetExceeded();
    if (budget.exceeded) {
      host.emit('BUDGET_EXHAUSTED', budget.reason);
      return;
    }

    const response = await callModel(deps, conversation, tools, 'EXECUTION');
    const uses = toolUsesOf(response.content);
    conversation.push({ role: 'assistant', content: response.content });

    if (uses.length === 0) {
      const said = textOf(response.content);
      if (said) host.emit('NOTE', said.slice(0, 400));
      return; // 模型主动结束本轮
    }

    const results: ContentBlock[] = [];
    for (const use of uses) {
      throwIfCancelled(deps.signal);
      const outcome = await dispatchTool(deps, use.name, use.input);
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: outcome.text,
        isError: !outcome.ok,
      });
    }
    conversation.push({ role: 'user', content: results });
  }
}

// ---------------------------------------------------------------------------
// 工具分发 —— 每次调用都有且只有一个 resolution
// ---------------------------------------------------------------------------

async function dispatchTool(
  deps: AgentDeps,
  toolName: string,
  rawInput: unknown,
): Promise<{ ok: boolean; text: string }> {
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
    );
    if (def.name === 'workspace_mutate' && outcome.ok) {
      host.emit('MUTATION_APPLIED', outcome.preview, outcome.meta ?? {});
    }
    return { ok: outcome.ok, text: outcome.modelText };
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
  purpose: 'PLANNING' | 'EXECUTION',
) {
  const schemas: ToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.jsonSchema,
  }));

  try {
    const { response, manifest } = await deps.gateway.invoke({
      runId: deps.runId,
      attemptId: deps.attemptId,
      purpose,
      resolution: deps.resolution,
      request: {
        system: systemPrompt(deps, purpose),
        messages: conversation,
        tools: schemas,
        maxOutputTokens: 8000,
        temperature: 0,
      },
      contextFileRefs: [],
      signal: deps.signal,
    });

    deps.host.chargeModelTurn(manifest.inputTokens ?? 0, manifest.outputTokens ?? 0);
    deps.host.emit(
      'MODEL_INVOCATION',
      `${purpose} 调用 ${manifest.modelId}（in=${manifest.inputTokens ?? '?'} out=${manifest.outputTokens ?? '?'}）`,
      { manifest },
    );
    return response;
  } catch (err) {
    if (err instanceof EgressBlocked) {
      deps.host.emit('MODEL_INVOCATION', `模型出站被阻断：${err.reason}`, { manifest: err.manifest });
      throw err;
    }
    if (err instanceof InvocationFailed) {
      deps.host.emit('MODEL_INVOCATION', `模型调用失败：${err.cause.kind} ${err.message}`, {
        manifest: err.manifest,
      });
      if (err.cause.kind === 'CANCELLED') throw new AgentCancelled();
      throw err;
    }
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
- 允许修改的路径: ${task.allowedPaths.join(', ')}
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
    return `${common}

当前阶段：**规划**。平台已经把你限制为只读工具，你现在**无法**修改任何文件。
先用 fs_read / fs_grep / fs_glob / fs_list 把失败原因搞清楚，读到足够的证据后，调用 submit_plan 提交计划。
计划要说清根因，而不只是"修复报错"。`;
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

  const header = `仓库信息：
- base: ${base}
- 快照文件数: ${deps.snapshot.fileCount}
- 检测到的技术栈信号: ${deps.profile.detectedSignals.join(', ') || '（无）'}`;

  if (!baseline) {
    return `请完成以下任务。

${header}

注意：本次任务**没有配置任何验证命令**，你无法用运行结果证明改动是对的。
因此请只做任务明确要求的改动，读够上下文再动手，并在最后说明哪些地方你没有把握。

请先了解相关代码，再提交计划。`;
  }

  return `请修复以下仓库中的失败。

${header}

基线验证结果（修改前的真实状态）：
${summarizeFailures(baseline)}

请先定位根因，再提交计划。`;
}

function renderPlan(plan: PlanRevision): string {
  const steps = plan.steps
    .map((s) => `${s.index}. ${s.intent}${s.targetPaths.length ? ` [${s.targetPaths.join(', ')}]` : ''}`)
    .join('\n');
  return `计划摘要: ${plan.summary}\n${steps}${plan.risks.length ? `\n风险: ${plan.risks.join('; ')}` : ''}`;
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

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentCancelled();
}
