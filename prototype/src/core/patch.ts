import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PatchArtifact,
  PatchFileEntry,
  VerificationComparison,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { classifyVerificationInputs, describeCoverageWeakening } from './coverage';
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
  /** 验证命令 argv 点名的仓库文件（见 coverage.verificationInputsFromCommands）；模式匹配的那部分不需要调用方提供 */
  commandReferencedInputs: readonly { path: string; commandId: string }[] = [],
): PatchArtifact {
  const baselineRoot = workspace.baselinePath();
  const activeRoot = workspace.activePath;
  const { authored, generated, deleted } = workspace.changedVsBaseline();

  const files: PatchFileEntry[] = [];
  const chunks: string[] = [];

  // 被删除的文件也要进补丁。只遍历"当前存在"的文件会让它们彻底消失，
  // 那正是本函数 docblock 里说过不允许的静默省略。
  for (const rel of deleted) {
    const before = join(baselineRoot, rel);
    const raw = gitDiffNoIndex(before, '/dev/null', rel);
    files.push({
      path: rel,
      changeKind: 'DELETED',
      addedLines: 0,
      removedLines: countPrefix(raw, '-'),
      diff: raw,
      diffTruncated: false,
    });
    chunks.push(raw);
  }

  for (const rel of authored) {
    const before = join(baselineRoot, rel);
    const after = join(activeRoot, rel);
    const existedBefore = existsSync(before);
    const raw = gitDiffNoIndex(existedBefore ? before : '/dev/null', after, rel);
    // 按字节判、按字节切。原本是"按字节判阈值、按字符切片"，
    // 中文 diff 下 truncated 标 true 却一个字都没切掉 —— 上限失效，提示还是假的
    const truncated = Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES_PER_FILE;
    const diff = truncated
      ? `${headBytes(raw, MAX_DIFF_BYTES_PER_FILE)}\n… [diff 过大已截断，完整内容见工作区 gen-${workspace.activeGeneration}]`
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

  /*
   * 验证覆盖是否被补丁自己动过：配置/测试/验证脚本任一被改，这份补丁绑定的"验证通过"
   * 就不再能证明修复正确。这里只记录与告知；降级发生在接受时（authority.decidePatch）。
   * 放在 sealPatch 里而不是某个调用点，是为了让首次封存、整改后重封存、挽救封存三条路
   * 口径一致 —— 否则重封存的补丁会"看起来更干净"。
   */
  const touches = classifyVerificationInputs(
    [...deleted, ...authored],
    commandReferencedInputs,
  );
  const items = touches.length > 0 ? [describeCoverageWeakening(touches), ...unverifiedItems] : [...unverifiedItems];

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
    unverifiedItems: items,
    verificationInputsTouched: touches.map((t) => t.path),
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

/** 从头部按字节截断到最近的完整码点边界 */
function headBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  const decoder = new StringDecoder('utf8');
  return decoder.write(buf.subarray(0, maxBytes));
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

/**
 * 统一 diff 里「这一行是不是 hunk 边界」。
 *
 * `@@` 开启一个 hunk，`diff --git` 关掉上一个。判据只有这一份，
 * `normalizeHeaders` 与 `countPrefix` 共用 —— 它们必须对"什么算 hunk 内"有
 * **同一个**答案，而它们曾经没有：`countPrefix` 已经按 hunk 内外区分，
 * `normalizeHeaders` 还在无条件逐行改写，于是一条被删掉的 SQL/Lua/Haskell 注释
 * （内容 `-- 旧注释`，在 diff 里渲染成 `--- 旧注释`）被当成文件头改写成
 * `--- a/<path>`。后果不只是补丁损坏：宿主写回时 `git apply --check` 失败，
 * 被报成 `APPLY_CONFLICT`「目标文件已漂移」—— 而目标根本没有漂移。
 *
 * 收成一处之后，下次改其中一个函数，另一个不会悄悄漂掉。
 */
function hunkEdgeOf(line: string): 'OPEN' | 'CLOSE' | null {
  if (line.startsWith('@@')) return 'OPEN';
  if (line.startsWith('diff --git ')) return 'CLOSE';
  return null;
}

/** 把 diff 头里的宿主绝对路径换成仓库相对路径 —— 绝对路径不进入任何投影 */
function normalizeHeaders(diff: string, rel: string): string {
  let inHunk = false;
  return diff
    .split('\n')
    .map((line) => {
      const edge = hunkEdgeOf(line);
      if (edge === 'OPEN') inHunk = true;
      else if (edge === 'CLOSE') inHunk = false;

      if (line.startsWith('diff --git ')) return `diff --git a/${rel} b/${rel}`;
      /*
       * 只在 hunk **外**改写文件头。hunk 内的 `--- x` / `+++ x` 是内容行：
       * 被删掉的 `-- 注释` 与被加上的 `++ i`，改写成文件头就把用户的代码换掉了。
       */
      if (!inHunk && line.startsWith('--- ')) {
        return line.includes('/dev/null') ? '--- /dev/null' : `--- a/${rel}`;
      }
      if (!inHunk && line.startsWith('+++ ')) {
        return line.includes('/dev/null') ? '+++ /dev/null' : `+++ b/${rel}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * 统计增删行数。
 *
 * 只在 `@@` hunk 内计数，不用 `'+++'`/`'---'` 的形状去猜文件头 ——
 * 顶格的内容行会误命中：`-- 注释` 变成 `--- 注释`、`++i;` 变成 `+++i;`，
 * 于是一增一删的改动会被报成 0/0。SQL 注释、YAML 分隔符、C 风格自增都会触发。
 *
 * 边界判据与 `normalizeHeaders` 共用 `hunkEdgeOf` —— 这两个函数必须同口径，
 * 见那里的说明（它们曾经不同口径，代价是补丁被改坏）。
 */
function countPrefix(diff: string, prefix: '+' | '-'): number {
  let n = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const edge = hunkEdgeOf(line);
    if (edge) {
      inHunk = edge === 'OPEN';
      continue; // 边界行本身不是内容，不计数
    }
    if (inHunk && line.startsWith(prefix)) n += 1;
  }
  return n;
}
