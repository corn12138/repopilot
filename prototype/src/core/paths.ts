import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * 所有 RepoPilot 管理的数据都在这一个受管根下。
 * 原型阶段不做加密（用户明确把存储放到后续），但目录布局按 overlay §4 的分域设计，
 * 后面替换成 encrypted artifact root 时不需要改调用方。
 */
export const DATA_ROOT = join(
  homedir(),
  'Library',
  'Application Support',
  'RepoPilotPrototype',
);

export const PATHS = {
  root: DATA_ROOT,
  projects: join(DATA_ROOT, 'projects.json'),
  runs: join(DATA_ROOT, 'runs'),
  snapshots: join(DATA_ROOT, 'snapshots'),
  workspaces: join(DATA_ROOT, 'workspaces'),
  artifacts: join(DATA_ROOT, 'artifacts'),
} as const;

export function ensureDataRoot(): void {
  for (const dir of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function runDir(runId: string): string {
  return join(PATHS.runs, runId);
}

export function workspaceDir(runId: string): string {
  return join(PATHS.workspaces, runId);
}

export function snapshotDir(snapshotId: string): string {
  return join(PATHS.snapshots, snapshotId);
}
