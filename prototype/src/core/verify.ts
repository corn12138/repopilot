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
    const def = profile.commands[id];
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

  const fixed: string[] = [];
  const stillFailing: string[] = [];
  const newlyFailing: string[] = [];

  for (const id of baseFailed) {
    if (nowFailed.has(id)) stillFailing.push(id);
    else fixed.push(id);
  }
  for (const id of nowFailed) {
    if (!baseFailed.has(id)) newlyFailing.push(id);
  }

  return { fixed: fixed.sort(), stillFailing: stillFailing.sort(), newlyFailing: newlyFailing.sort() };
}

/** 给模型看的失败摘要：只保留有用部分，避免把整份构建日志塞回上下文 */
export function summarizeFailures(run: VerificationRun): string {
  const failed = run.commands.filter((c) => c.outcome !== 'EXIT_ZERO');
  if (failed.length === 0) return '全部验证命令通过。';
  return failed
    .map((c) => {
      const detail = [c.stderrPreview, c.stdoutPreview].filter(Boolean).join('\n').trim();
      return `命令 ${c.commandId} 失败（${c.outcome}, exitCode=${c.exitCode ?? 'null'}）:\n${detail || '（无输出）'}`;
    })
    .join('\n\n');
}
