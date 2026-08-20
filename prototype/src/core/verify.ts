import type {
  CommandDefinition,
  CommandOutcome,
  CommandRole,
  RepositoryHarnessProfile,
  ToolCallResolution,
  VerificationComparison,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { runCommand } from './command';
import type { MaterializedWorkspace } from './workspace';

/**
 * 验证命令的记账口（TD §9.4 的「同一 Gateway、同一账本」）。
 *
 * 结构上是 `AgentHost` 的子集，所以 agent 与 authority 直接把各自的 host 传进来即可。
 * 传 null 表示"这次不记账" —— 只允许在**没有 Run 语境**的单测里出现；产品路径上
 * 三个调用点（baseline / post-mutation / 整改后重验）全部传 host。
 *
 * 08-17 审计：此前 runVerification 直接调 runCommand，绕过 dispatchTool ——
 * 没有 ToolCall 记录、没有风险闸门、不计预算。用户在时间线上看不到平台跑了什么。
 */
export interface VerificationRecorder {
  beginToolCall(input: {
    toolName: string;
    risk: CommandDefinition['risk'];
    argsSummary: string;
    argsDigest: string;
  }): string;
  endToolCall(
    toolCallId: string,
    resolution: ToolCallResolution,
    reason: string | null,
    preview: string,
    previewTruncated: boolean,
    artifactRef: string | null,
  ): void;
  chargeToolCall(): void;
}

/** 命令结果 → ToolCall resolution。判别联合不能在这里被压成布尔 */
function resolutionOf(outcome: CommandOutcome['outcome']): ToolCallResolution {
  if (outcome === 'EXIT_ZERO') return 'SUCCEEDED';
  if (outcome === 'CANCELLED') return 'CANCELLED';
  return 'FAILED';
}

/**
 * 在指定工作区跑一组验证命令。
 *
 * 不变式（PRD-VER-001/002）：
 *   - 修改前必须先跑一次 baseline，否则无法区分"历史就失败"和"这次改坏了"。
 *   - 命令不存在时**不是**跳过成功，而是记为 SPAWN_ERROR。
 *   - passed 只在所有命令都 EXIT_ZERO 时为真。
 */
/**
 * 执行期的一次性批准闸门（Slice K）。
 *
 * 只有 `risk !== 'R1'` 的命令才会问到它。返回 `ok: false` 时命令记 SPAWN_ERROR ——
 * **不跑 ≠ 通过**，验证不会 passed。
 */
export interface CommandApprovalChecker {
  consume(
    def: Pick<CommandDefinition, 'commandId' | 'argv' | 'risk' | 'approvalId'>,
    role: CommandRole,
  ): { ok: true } | { ok: false; reason: string };
}

export async function runVerification(
  runId: string,
  attemptId: string,
  phase: VerificationRun['phase'],
  workspace: MaterializedWorkspace,
  profile: RepositoryHarnessProfile,
  commandIds: readonly string[],
  signal: AbortSignal,
  recorder: VerificationRecorder | null = null,
  approvals: CommandApprovalChecker | null = null,
): Promise<VerificationRun> {
  const startedAt = nowIso();
  const outcomes: CommandOutcome[] = [];
  const role: CommandRole = phase === 'BASELINE' ? 'BASELINE' : 'VERIFICATION';

  /** 每条命令都留一条 ToolCall 记录 —— 包括没跑成的那些 */
  const record = (
    def: Pick<CommandDefinition, 'commandId' | 'argv' | 'risk'>,
    run: () => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> => {
    if (!recorder) return run();
    const toolCallId = recorder.beginToolCall({
      toolName: 'verify_command',
      risk: def.risk,
      argsSummary: `${role} ${def.commandId}: ${def.argv.join(' ') || '(未登记)'}`,
      argsDigest: digestOf({ role, commandId: def.commandId, argv: def.argv }),
    });
    return run().then((outcome) => {
      // 计费在执行之后：DENIED / 未登记的命令不该占用户的预算
      if (outcome.outcome !== 'CANCELLED') recorder.chargeToolCall();
      recorder.endToolCall(
        toolCallId,
        resolutionOf(outcome.outcome),
        outcome.outcome === 'EXIT_ZERO' ? null : outcome.outcome,
        `${outcome.outcome}${outcome.exitCode !== null ? ` exit=${outcome.exitCode}` : ''}\n${
          outcome.stderrPreview || outcome.stdoutPreview
        }`.slice(0, 2_000),
        outcome.outputTruncated,
        null,
      );
      return outcome;
    });
  };

  for (const id of commandIds) {
    // hasOwnProperty 而不是直接取值：commandId 来自模型，'constructor' 之类的
    // key 会取到原型上的成员（truthy），随后 def.argv 为 undefined 直接抛 TypeError，
    // 让整个 runVerification reject —— 违反本模块"命令不存在时记为 SPAWN_ERROR"的不变式
    const def = Object.prototype.hasOwnProperty.call(profile.commands, id)
      ? profile.commands[id]
      : undefined;
    if (!def) {
      outcomes.push(
        await record({ commandId: id, argv: [], risk: 'R1' }, async () => ({
          commandId: id,
          argv: [],
          outcome: 'SPAWN_ERROR' as const,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdoutPreview: '',
          stderrPreview: `profile 中没有登记 command "${id}"`,
          outputTruncated: false,
        })),
      );
      continue;
    }
    /*
     * 风险闸门（纵深防御）：验证默认只跑 R1。用户手填的命令在登记时就分过一次级
     * （commandRisk.ts），这里在**每一次执行前**再查一遍 —— 万一将来有别的路径往
     * profile 里塞命令，它也不能借"验证"这个身份绕过分级。
     *
     * 唯一的例外是拿着一次性精确批准的 R2（`CommandApproval`，Slice K）：由 checker
     * 逐次校验并计数。没有 checker、或 checker 说不行 —— 一律 SPAWN_ERROR。
     * 不跑 ≠ 通过：验证不会 passed。
     */
    if (def.risk !== 'R1') {
      const verdict = approvals?.consume(def, role) ?? {
        ok: false as const,
        reason: '本次运行没有命令批准通道',
      };
      if (!verdict.ok) {
        outcomes.push(
          await record(def, async () => ({
            commandId: def.commandId,
            argv: def.argv,
            outcome: 'SPAWN_ERROR' as const,
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdoutPreview: '',
            stderrPreview: `command "${def.commandId}" 的风险等级是 ${def.risk}，拒绝执行：${verdict.reason}`,
            outputTruncated: false,
          })),
        );
        continue;
      }
    }
    if (signal.aborted) {
      // 取消掉的命令同样留一条记录：用户要能看出"这一步没跑"，而不是它凭空消失。不计账。
      outcomes.push(
        await record(def, async () => ({
          commandId: id,
          argv: def.argv,
          outcome: 'CANCELLED' as const,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdoutPreview: '',
          stderrPreview: '在执行前已被取消',
          outputTruncated: false,
        })),
      );
      continue;
    }
    outcomes.push(await record(def, () => runCommand(def, workspace.activePath, signal)));
  }

  return {
    verificationRunId: newId('ver'),
    runId,
    attemptId,
    phase,
    generation: workspace.activeGeneration,
    commands: outcomes,
    passed: outcomes.length > 0 && outcomes.every((o) => o.outcome === 'EXIT_ZERO'),
    startedAt,
    finishedAt: nowIso(),
  };
}

/** 基线对比：把「修好的 / 仍然失败的 / 新弄坏的」分开，不允许混成一句"构建通过" */
export function compareVerification(
  baseline: VerificationRun,
  current: VerificationRun,
): VerificationComparison {
  const baseFailed = new Set(
    baseline.commands.filter((c) => c.outcome !== 'EXIT_ZERO').map((c) => c.commandId),
  );
  const nowFailed = new Set(
    current.commands.filter((c) => c.outcome !== 'EXIT_ZERO').map((c) => c.commandId),
  );

  // 只在两次都跑过的命令上做 fixed/stillFailing 分类。
  // 否则"这次压根没跑"会因为不在当前失败集合里而被算成 fixed —— 一句没有证据的谎话。
  const currentIds = new Set(current.commands.map((c) => c.commandId));

  const fixed: string[] = [];
  const stillFailing: string[] = [];
  const newlyFailing: string[] = [];
  const notRerun: string[] = [];

  for (const id of baseFailed) {
    if (!currentIds.has(id)) notRerun.push(id);
    else if (nowFailed.has(id)) stillFailing.push(id);
    else fixed.push(id);
  }
  for (const id of nowFailed) {
    if (!baseFailed.has(id)) newlyFailing.push(id);
  }

  return {
    fixed: fixed.sort(),
    stillFailing: stillFailing.sort(),
    newlyFailing: newlyFailing.sort(),
    notRerun: notRerun.sort(),
  };
}

/** 给模型看的失败摘要：只保留有用部分，避免把整份构建日志塞回上下文 */
export function summarizeFailures(run: VerificationRun): string {
  // 一条都没跑过时说"全部通过"，与 runVerification 里 `outcomes.length > 0` 的
  // passed 判定自相矛盾 —— 同一个 run，passed=false 摘要却说通过。
  // 这段文字既进模型上下文也展示给用户，等于零证据下声称成功。
  if (run.commands.length === 0) {
    return '本次没有执行任何验证命令 —— 没有任何证据支持或否定这次改动。';
  }
  const failed = run.commands.filter((c) => c.outcome !== 'EXIT_ZERO');
  if (failed.length === 0) return '全部验证命令通过。';
  return failed
    .map((c) => {
      const detail = [c.stderrPreview, c.stdoutPreview].filter(Boolean).join('\n').trim();
      return `命令 ${c.commandId} 失败（${c.outcome}, exitCode=${c.exitCode ?? 'null'}）:\n${detail || '（无输出）'}`;
    })
    .join('\n\n');
}
