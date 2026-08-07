import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PatchArtifact,
  PatchFileEntry,
  VerificationComparison,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import type { MaterializedWorkspace } from './workspace';

const MAX_DIFF_BYTES_PER_FILE = 60_000;

/**
 * 把 gen-0（基线）到 active generation 的差异封存成 PatchArtifact。
 *
 * 交付语义（PRD-DIFF-004）：这是**交付物本身**，不是"已经写回仓库"。
 * 宿主仓库自始至终没有被写过；用户接受后可以导出，但那是独立的用户手势。
 *
 * 展示规则（PRD-DIFF-001）：所有 changed file 都必须出现在列表里。
 * 单个文件的 diff 过大时只截断**内容**，路径、行数统计和截断原因仍然展示，
 * 不允许静默把某个文件从列表里去掉。
 */
export function sealPatch(
  workspace: MaterializedWorkspace,
  runId: string,
  attemptId: string,
  baseSha: string,
  verification: VerificationRun | null,
  comparison: VerificationComparison | null,
  unverifiedItems: readonly string[],
): PatchArtifact {
  const baselineRoot = workspace.baselinePath();
  const activeRoot = workspace.activePath;
  const { authored, generated } = workspace.changedVsBaseline();

  const files: PatchFileEntry[] = [];
  const chunks: string[] = [];

  for (const rel of authored) {
    const before = join(baselineRoot, rel);
    const after = join(activeRoot, rel);
    const existedBefore = existsSync(before);
    const raw = gitDiffNoIndex(existedBefore ? before : '/dev/null', after, rel);
    const truncated = Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES_PER_FILE;
    const diff = truncated
      ? `${raw.slice(0, MAX_DIFF_BYTES_PER_FILE)}\n… [diff 过大已截断，完整内容见工作区 gen-${workspace.activeGeneration}]`
      : raw;

    files.push({
      path: rel,
      changeKind: existedBefore ? 'MODIFIED' : 'ADDED',
      addedLines: countPrefix(raw, '+'),
      removedLines: countPrefix(raw, '-'),
      diff,
      diffTruncated: truncated,
    });
    chunks.push(diff);
  }

  const unifiedDiff = chunks.join('\n');

  return {
    patchId: newId('patch'),
    runId,
    attemptId,
    baseSha,
    generation: workspace.activeGeneration,
    files,
    unifiedDiff,
    digest: digestOf({ baseSha, treeDigest: workspace.treeDigest(), files: files.map((f) => f.path) }),
    sealedAt: nowIso(),
    verificationRunId: verification?.verificationRunId ?? null,
    comparison,
    unverifiedItems,
    excludedGeneratedFiles: generated,
  };
}

export type ApplyResult =
  | { readonly ok: true; readonly appliedPaths: readonly string[] }
  | { readonly ok: false; readonly stage: 'CHECK' | 'APPLY'; readonly detail: string };

/**
 * 用 git 把统一 diff 应用回宿主仓库。
 *
 * 这是原型里唯一会写用户仓库的函数，所以刻意做得很窄：
 *   - 不自己实现 patch 应用，交给 `git apply`。
 *   - 先 `--check` 干跑；失败就整笔拒绝，此时**一个字节都没写**。
 *   - 子包导入时用 `--directory` 把坐标系还原回仓库根。
 *   - 不自动 commit、不 `--3way`、不 `--reject`：宁可干净失败，也不留半应用状态。
 */
export function applyPatchWithGit(
  hostPath: string,
  subPath: string,
  unifiedDiff: string,
  patchFilePath: string,
  appliedPaths: readonly string[],
): ApplyResult {
  writeFileSync(patchFilePath, unifiedDiff.endsWith('\n') ? unifiedDiff : `${unifiedDiff}\n`, 'utf8');

  const args = ['apply', '-p1'];
  if (subPath) args.push(`--directory=${subPath}`);

  const check = runGit(hostPath, [...args, '--check', '--verbose', patchFilePath]);
  if (!check.ok) return { ok: false, stage: 'CHECK', detail: check.detail };

  const applied = runGit(hostPath, [...args, patchFilePath]);
  if (!applied.ok) return { ok: false, stage: 'APPLY', detail: applied.detail };

  return { ok: true, appliedPaths };
}

function runGit(cwd: string, args: string[]): { ok: boolean; detail: string } {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, detail: '' };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, detail: (e.stderr || e.stdout || e.message || '').trim().slice(0, 2000) };
  }
}

function gitDiffNoIndex(before: string, after: string, label: string): string {
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', '--', before, after], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return ''; // exit 0 = 无差异
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // git diff --no-index 在有差异时以 1 退出，这是正常路径
    if (e.status === 1 && typeof e.stdout === 'string') {
      return normalizeHeaders(e.stdout, label);
    }
    return `# 无法生成 ${label} 的 diff: ${(e.stderr ?? '').slice(0, 200)}`;
  }
}

/** 把 diff 头里的宿主绝对路径换成仓库相对路径 —— 绝对路径不进入任何投影 */
function normalizeHeaders(diff: string, rel: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith('--- ')) return line.includes('/dev/null') ? '--- /dev/null' : `--- a/${rel}`;
      if (line.startsWith('+++ ')) return line.includes('/dev/null') ? '+++ /dev/null' : `+++ b/${rel}`;
      return line;
    })
    .join('\n');
}

function countPrefix(diff: string, prefix: '+' | '-'): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) n += 1;
  }
  return n;
}
