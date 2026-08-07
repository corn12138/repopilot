import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Digest, MutationReadReceipt } from '@shared/domain';
import { digestOf, newId, nowIso, sha256 } from '@shared/ids';
import { snapshotDir, workspaceDir } from './paths';

const RECEIPT_TTL_MS = 15 * 60 * 1000;

/**
 * 每 Run 独立的可写工作区。
 *
 * 关键设计（ADR 007 / PRD-MUT-003）：
 *   - 宿主仓库**永远只读**。工作区是从 immutable snapshot 复制出来的独立副本。
 *   - 每次变更事务产生一个新的 generation 目录；旧 generation 保持完整可用。
 *   - 只有 staged generation 全部校验通过后，才 CAS 切换 active generation。
 *   - crash / 校验失败 → 丢弃 staged 目录，active 保持不变（要么完整旧的，要么完整新的）。
 *
 * 这不是性能最优实现（每代整目录 clone），但语义是对的：
 * 没有"部分提交"这个中间态。macOS 上用 APFS clonefile，实际成本接近元数据操作。
 */
export class MaterializedWorkspace {
  private active = 0;
  private readonly receipts = new Map<string, MutationReadReceipt>();

  private constructor(
    readonly runId: string,
    readonly snapshotId: string,
    readonly root: string,
    /** 宿主仓库路径，只用于只读复用已安装依赖；不用于任何写入 */
    private readonly hostRepoPath: string | null,
  ) {}

  static create(
    runId: string,
    snapshotId: string,
    hostRepoPath: string | null = null,
  ): MaterializedWorkspace {
    const root = workspaceDir(runId);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const ws = new MaterializedWorkspace(runId, snapshotId, root, hostRepoPath);
    cloneTree(snapshotDir(snapshotId), ws.generationPath(0));
    ws.linkDependencies(ws.generationPath(0));
    return ws;
  }

  /**
   * 把宿主已安装的 node_modules 以 symlink 形式挂进工作区。
   *
   * 这是原型的显式取舍：tracked-only 快照里没有依赖，而 `npm install` 属于
   * R2（网络 + 依赖安装），首个切片不开放。所以改为**只读复用**宿主已装好的依赖。
   *
   * 安全边界：
   *   - 这是 symlink，不是复制；构建过程对它的写入会直接落到宿主 node_modules，
   *     所以这条路径在真实产品里必须换成容器内独立依赖树（ADR 007）。原型阶段
   *     接受这个残余风险，并在此明确标注。
   *   - listTree() 跳过 symlink，所以它不进入 treeDigest，也不会出现在 Patch 里。
   *   - resolveManaged() 逐级拒绝 symlink，所以模型无法通过 node_modules/... 写文件。
   */
  private linkDependencies(genPath: string): void {
    if (!this.hostRepoPath) return;
    const source = join(this.hostRepoPath, 'node_modules');
    if (!existsSync(source)) return;
    const target = join(genPath, 'node_modules');
    if (existsSync(target)) return;
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // 链接失败不阻断：后续 build 会以 EXIT_NONZERO 诚实失败，而不是假装成功
    }
  }

  get activeGeneration(): number {
    return this.active;
  }

  generationPath(gen: number): string {
    return join(this.root, `gen-${gen}`);
  }

  get activePath(): string {
    return this.generationPath(this.active);
  }

  /** 受管根内的路径解析：拒绝绝对路径、`..` 逃逸和 symlink */
  resolveInActive(relPath: string): string {
    return resolveManaged(this.activePath, relPath);
  }

  exists(relPath: string): boolean {
    try {
      return existsSync(this.resolveInActive(relPath));
    } catch {
      return false;
    }
  }

  readText(relPath: string): string {
    return readFileSync(this.resolveInActive(relPath), 'utf8');
  }

  /**
   * 受治理读取 → 产生 read receipt。
   *
   * Receipt 只记录"在 generation N 读到了 digest D 的这个文件"。
   * 它**不是**写权限凭据 —— apply 时会重新计算 digest 再比对一次。
   */
  issueReceipt(relPath: string): { content: string; receipt: MutationReadReceipt } {
    const abs = this.resolveInActive(relPath);
    const bytes = readFileSync(abs);
    const receipt: MutationReadReceipt = {
      receiptId: newId('rcpt'),
      generation: this.active,
      path: relPath,
      fileDigest: sha256(bytes),
      byteLength: bytes.byteLength,
      readAt: nowIso(),
      expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
    };
    this.receipts.set(receipt.receiptId, receipt);
    return { content: bytes.toString('utf8'), receipt };
  }

  getReceipt(receiptId: string): MutationReadReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  /** 建立下一代的暂存目录（当前代的完整克隆） */
  stage(): { generation: number; path: string } {
    const next = this.active + 1;
    const path = this.generationPath(next);
    rmSync(path, { recursive: true, force: true });
    cloneTree(this.activePath, path);
    this.linkDependencies(path);
    return { generation: next, path };
  }

  /** compare-and-swap：只有 active 仍等于 expected 才切换 */
  commit(stagedGeneration: number, expectedActive: number): boolean {
    if (this.active !== expectedActive) return false;
    if (stagedGeneration !== expectedActive + 1) return false;
    this.active = stagedGeneration;
    // 切代后此前的 receipt 全部作废：它们绑定的是旧 generation
    this.receipts.clear();
    return true;
  }

  discard(stagedGeneration: number): void {
    if (stagedGeneration <= this.active) return;
    rmSync(this.generationPath(stagedGeneration), { recursive: true, force: true });
  }

  /** 当前代整棵树的 digest，用于把 Patch 与验证输入绑定在同一棵树上 */
  treeDigest(): Digest {
    return digestOf(listTree(this.activePath));
  }

  /**
   * 基线到当前代的差异，按"人写的"和"命令生成的"分开。
   *
   * 分开是必要的：验证命令（vite build / tsc）会在工作区里产出 dist、缓存等文件，
   * 它们不是 Agent 的修改意图，不应进入 PatchArtifact。但也**不能静默丢掉** ——
   * 生成文件的数量和路径会随补丁一起展示（PRD-DIFF-001：任何省略都要说明）。
   */
  changedVsBaseline(): { authored: string[]; generated: string[] } {
    const base = listTree(this.generationPath(0));
    const now = listTree(this.activePath);
    const baseMap = new Map(base.map((f) => [f.path, f.digest]));
    const authored: string[] = [];
    const generated: string[] = [];
    for (const f of now) {
      if (baseMap.get(f.path) === f.digest) continue;
      (isGeneratedPath(f.path) ? generated : authored).push(f.path);
    }
    return { authored: authored.sort(), generated: generated.sort() };
  }

  changedFilesVsBaseline(): string[] {
    return this.changedVsBaseline().authored;
  }

  baselinePath(): string {
    return this.generationPath(0);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

export function resolveManaged(root: string, relPath: string): string {
  if (!relPath || relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new PathViolation(`拒绝绝对路径: ${relPath}`, 'PATH_ESCAPE');
  }
  if (relPath.split(/[\\/]/).includes('..')) {
    throw new PathViolation(`拒绝 .. 路径: ${relPath}`, 'PATH_ESCAPE');
  }
  const rootResolved = resolve(root);
  const abs = resolve(rootResolved, relPath);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new PathViolation(`路径逃逸受管根: ${relPath}`, 'PATH_ESCAPE');
  }
  // 逐级检查 symlink：任何一级是链接都拒绝
  let cursor = rootResolved;
  for (const part of relative(rootResolved, abs).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new PathViolation(`拒绝 symlink: ${relPath}`, 'SYMLINK_REJECTED');
    }
  }
  return abs;
}

/** 由构建/测试命令产出，而非 Agent 编辑意图的路径 */
export function isGeneratedPath(relPath: string): boolean {
  return /^(dist|build|out|coverage|\.vite|\.turbo|\.next|node_modules)(\/|$)/.test(relPath);
}

export class PathViolation extends Error {
  constructor(
    message: string,
    readonly reason: 'PATH_ESCAPE' | 'SYMLINK_REJECTED',
  ) {
    super(message);
  }
}

function cloneTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  if (process.platform === 'darwin') {
    try {
      // APFS clonefile：写时复制，几乎不占额外空间
      execFileSync('/bin/cp', ['-Rc', `${from}/.`, to], { stdio: 'ignore' });
      return;
    } catch {
      // 落回普通复制
    }
  }
  cpSync(from, to, { recursive: true, dereference: false });
}

export interface TreeEntry {
  path: string;
  digest: Digest;
  bytes: number;
}

export function listTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const bytes = readFileSync(abs);
        out.push({
          path: relative(root, abs).split(sep).join('/'),
          digest: sha256(bytes),
          bytes: bytes.byteLength,
        });
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

export function fileDigestAt(root: string, relPath: string): Digest | null {
  const abs = resolveManaged(root, relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return sha256(readFileSync(abs));
}
