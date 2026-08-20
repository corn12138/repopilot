import { closeSync, lstatSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * 补丁导出的目的地判定与原子落盘。
 *
 * 抽成纯逻辑 + 一个窄副作用函数，理由与 `envelope.ts` 相同：这一整段此前长在
 * `main/index.ts` 的 `exportPatch` 里（一句 `writeFileSync`），而 `main/index.ts`
 * 一被 import 就会拉起 Electron —— 于是最该被负向测试覆盖的一层恰恰没有测试。
 *
 * 这是原型里除「应用到仓库」之外**唯一会写用户磁盘**的路径，所以它要挡住四件事：
 *
 *   1. **写进受保护的根**：项目仓库本身、RepoPilot 的受管数据根、活动工作区。
 *      把 .patch 存进正在被修的仓库里，下一次导入就会把它当成源码收进快照；
 *      存进受管根则可能被保留策略当垃圾清掉。
 *   2. **跟随符号链接**：目标或它的父目录是链接时，"我以为存到桌面"可能落到任何地方。
 *   3. **TOCTOU**：对话框选路径与真正写入之间有一个窗口，路径可能被换成链接。
 *      所以判定要在**写之前**再跑一次，而不是只在选完之后跑一次。
 *   4. **半个文件**：直接往目标写，中途失败会留下一个被截断的 .patch，
 *      而它看起来和完整的一样。改成同目录临时文件 + rename。
 */

export type ExportDestinationReject =
  /** 落在受保护根内（项目仓库 / 受管数据根 / 活动工作区） */
  | 'FORBIDDEN_ROOT'
  /** 目标已存在且是符号链接 / 目录 / 其他非普通文件 */
  | 'NOT_A_REGULAR_FILE'
  /** 目标或其父目录无法解析（父目录不存在、无权限） */
  | 'UNRESOLVABLE';

export type ExportDestinationVerdict =
  | { readonly ok: true; readonly resolvedPath: string; readonly existing: boolean }
  | { readonly ok: false; readonly reason: ExportDestinationReject; readonly detail: string };

/**
 * `child` 是否落在 `root` 之内（含相等）。两边都必须已是 realpath —— 只比字符串
 * 会被 `~/tmp -> /repo` 这类链接绕过，而那正是这道检查要挡的东西。
 */
function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 判定一个导出目的地能不能写。
 *
 * `forbiddenRoots` 由 Core 给出（它才知道项目 hostPath / 数据根 / 工作区）；
 * 这里对**父目录**取 realpath 再比较 —— 只比字符串会被 `~/tmp -> /repo` 这种链接绕过。
 */
export function classifyExportDestination(
  targetPath: string,
  forbiddenRoots: readonly string[],
): ExportDestinationVerdict {
  const absolute = resolve(targetPath);
  let parentReal: string;
  try {
    parentReal = realpathSync(dirname(absolute));
  } catch (err) {
    return {
      ok: false,
      reason: 'UNRESOLVABLE',
      detail: `无法解析目标所在目录：${(err as Error).message}`,
    };
  }
  const resolved = join(parentReal, basenameOf(absolute));

  // 目标已存在时：只接受普通文件（覆盖由保存对话框向用户确认过）
  let existing = false;
  try {
    const st = lstatSync(resolved);
    existing = true;
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        reason: 'NOT_A_REGULAR_FILE',
        detail: '目标是一个符号链接：不跟随，也不覆盖 —— 它可能指向任何地方',
      };
    }
    if (!st.isFile()) {
      return { ok: false, reason: 'NOT_A_REGULAR_FILE', detail: '目标已存在且不是普通文件' };
    }
  } catch {
    existing = false; // 不存在是正常情况
  }

  for (const root of forbiddenRoots) {
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      continue; // 受保护根本身不存在（例如工作区已被清理）就无从冲突
    }
    if (isInside(resolved, rootReal)) {
      return {
        ok: false,
        reason: 'FORBIDDEN_ROOT',
        detail: `目标落在受保护目录内：${rootReal}`,
      };
    }
  }

  return { ok: true, resolvedPath: resolved, existing };
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf(sep);
  return i < 0 ? p : p.slice(i + 1);
}

export interface AtomicWriteResult {
  readonly bytes: number;
  readonly overwrote: boolean;
}

/**
 * 同目录临时文件 + rename 的原子落盘。
 *
 * 临时文件用 `wx` 打开（已存在即失败），写完 fsync 再 rename ——
 * rename 在同一文件系统上是原子的，所以目标要么是完整的旧内容，要么是完整的新内容，
 * 不存在"写了一半的补丁"。失败路径一律清掉临时文件，不留垃圾。
 *
 * 判定与写入之间会**再判定一次**（TOCTOU）：选完路径到真正写入之间，
 * 目标可能被换成一个符号链接。
 */
export function writeExportAtomically(
  targetPath: string,
  content: string,
  forbiddenRoots: readonly string[],
): AtomicWriteResult {
  const recheck = classifyExportDestination(targetPath, forbiddenRoots);
  if (!recheck.ok) {
    throw new ExportDestinationError(recheck.reason, recheck.detail);
  }
  const { resolvedPath, existing } = recheck;
  const dir = dirname(resolvedPath);
  const tmpDir = mkdtempSync(join(dir, '.repopilot-export-'));
  const tmpFile = join(tmpDir, 'patch.tmp');
  const bytes = Buffer.byteLength(content, 'utf8');
  try {
    const fd = openSync(tmpFile, 'wx', 0o600);
    try {
      writeSync(fd, content, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(tmpFile, resolvedPath);
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // 临时文件可能压根没建起来
    }
    throw err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { bytes, overwrote: existing };
}

export class ExportDestinationError extends Error {
  constructor(
    readonly reason: ExportDestinationReject,
    readonly detail: string,
  ) {
    super(detail);
  }
}
