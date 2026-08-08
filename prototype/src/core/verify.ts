import type {
  CommandOutcome,
  RepositoryHarnessProfile,
  VerificationComparison,
  VerificationRun,
} from '@shared/domain';
import { newId, nowIso } from '@shared/ids';
import { runCommand } from './command';
import type { MaterializedWorkspace } from './workspace';

/**
 * 在指定工作区跑一组验证命令。
 *
 * 不变式（PRD-VER-001/002）：
 *   - 修改前必须先跑一次 baseline，否则无法区分"历史就失败"和"这次改坏了"。
 *   - 命令不存在时**不是**跳过成功，而是记为 SPAWN_ERROR。
 *   - passed 只在所有命令都 EXIT_ZERO 时为真。
 */
export async function runVerification(
  runId: string,
  attemptId: string,
  phase: VerificationRun['phase'],
  workspace: MaterializedWorkspace,
  profile: RepositoryHarnessProfile,
  commandIds: readonly string[],
  signal: AbortSignal,
): Promise<VerificationRun> {
  const startedAt = nowIso();
  const outcomes: CommandOutcome[] = [];

  for (const id of commandIds) {
    // hasOwnProperty 而不是直接取值：commandId 来自模型，'constructor' 之类的
    // key 会取到原型上的成员（truthy），随后 def.argv 为 undefined 直接抛 TypeError，
    // 让整个 runVerification reject —— 违反本模块"命令不存在时记为 SPAWN_ERROR"的不变式
    const def = Object.prototype.hasOwnProperty.call(profile.commands, id)
      ? profile.commands[id]
      : undefined;
    if (!def) {
      outcomes.push({
        commandId: id,
        argv: [],
        outcome: 'SPAWN_ERROR',
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdoutPreview: '',
        stderrPreview: `profile 中没有登记 command "${id}"`,
        outputTruncated: false,
      });
      continue;
    }
    if (signal.aborted) {
      outcomes.push({
        commandId: id,
        argv: def.argv,
        outcome: 'CANCELLED',
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdoutPreview: '',
        stderrPreview: '在执行前已被取消',
        outputTruncated: false,
      });
      continue;
    }
    outcomes.push(await runCommand(def, workspace.activePath, signal));
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
