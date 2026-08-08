import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PatchArtifact,
  PlanRevision,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
  TaskSpec,
  ToolCallView,
  VerificationRun,
} from '@shared/domain';
import { PATHS, runDir } from './paths';
import { writeJsonAtomic } from './store';

/**
 * Run 状态快照的落盘格式。
 *
 * 为什么需要它：`events.jsonl` 记的是**发生过什么**，但从事件流重建不出
 * 可交付的补丁 —— `PATCH_SEALED` 事件的 payload 里只有 patchId / digest / 文件名，
 * `unifiedDiff` 正文不在里面。所以状态快照和事件日志是两份互补的东西，
 * 缺哪份都做不到"重启后历史可读"。
 *
 * 与事件日志的一致性约定：**永远先 append 事件，再写状态快照**。
 * 这样崩溃窗口只会产生"事件比状态新"，不会产生"状态说成功、时间线停在半路"
 * 这种更危险的方向。rehydrate 时会检查这一点并如实标注。
 */
export const RUN_STATE_SCHEMA_VERSION = 1;

export interface PersistedRunState {
  readonly schemaVersion: number;
  readonly view: RunView;
  readonly task: TaskSpec;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  readonly toolCalls: readonly ToolCallView[];
  readonly verifications: readonly VerificationRun[];
  readonly plan: PlanRevision | null;
  readonly patch: PatchArtifact | null;
  /** 写这份快照时事件流的最高 seq，用于 rehydrate 时判断两者是否同步 */
  readonly eventHighWatermark: number;
  readonly persistedAt: string;
}

export type LoadResult =
  | { readonly ok: true; readonly state: PersistedRunState }
  /**
   * 读不出来是一种**要展示的结果**，不是"当作没有"。
   *
   * 现有的 model-profiles.json / custom-providers.json 都是读失败静默 fallback 成空，
   * 后果是"配置损坏"长得跟"从未配过"一模一样。证据文件不能重蹈覆辙 ——
   * 一个损坏的 Run 必须留在列表里并标明损坏，而不是凭空消失。
   */
  | { readonly ok: false; readonly reason: string };

function statePath(runId: string): string {
  return join(runDir(runId), 'state.json');
}

export function writeRunState(state: PersistedRunState): void {
  writeJsonAtomic(statePath(state.view.runId), state);
}

export function readRunState(runId: string): LoadResult {
  const path = statePath(runId);
  if (!existsSync(path)) return { ok: false, reason: '缺少 state.json（可能是旧版本创建的 Run）' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `state.json 解析失败：${(err as Error).message}` };
  }

  const state = parsed as Partial<PersistedRunState>;
  if (typeof state.schemaVersion !== 'number') {
    return { ok: false, reason: 'state.json 缺少 schemaVersion' };
  }
  if (state.schemaVersion > RUN_STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `state.json 版本 ${state.schemaVersion} 高于本程序支持的 ${RUN_STATE_SCHEMA_VERSION}`,
    };
  }
  if (!state.view?.runId || !state.task || !state.snapshot || !state.profile) {
    return { ok: false, reason: 'state.json 缺少必需字段（view / task / snapshot / profile）' };
  }

  return { ok: true, state: state as PersistedRunState };
}

/** 扫描数据根下所有 Run 目录。目录存在即视为有过这个 Run，哪怕内容坏了。 */
export function listPersistedRunIds(): string[] {
  if (!existsSync(PATHS.runs)) return [];
  try {
    return readdirSync(PATHS.runs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('run_'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
