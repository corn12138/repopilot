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
  /**
   * 受治理读取 → 签发 receipt。
   *
   * `coverage` 由**调用方**声明：只有真的把全文交出去了才能是 `FULL_BLOB`。
   * fs_read 的预览被上限截断时必须签 `BYTE_RANGE`，否则模型只见开头也能整文件覆盖，
   * 尾部会被静默删掉（receipt 的 digest 只能证明文件没变，证明不了读者看过全文）。
   *
   * 这里自己再读一次文件来算 digest，而不是接受调用方给的字节 —— 受管根内 active
   * generation 在一次工具调用期间不可能被改写（mutation 落在新的 generation 目录，
   * 只在 CAS 提交那一刻切换），所以两次读到的是同一份内容，且 digest 的来源是磁盘而非调用方。
   */
  issueReceipt(
    relPath: string,
    coverage: MutationReadReceipt['coverage'],
    coveredBytes?: number,
  ): { content: string; receipt: MutationReadReceipt } {
    const abs = this.resolveInActive(relPath);
    const bytes = readFileSync(abs);
    const receipt: MutationReadReceipt = {
      receiptId: newId('rcpt'),
      generation: this.active,
      path: relPath,
      fileDigest: sha256(bytes),
      byteLength: bytes.byteLength,
      coverage,
      coveredBytes:
        coverage === 'FULL_BLOB' ? bytes.byteLength : Math.min(coveredBytes ?? 0, bytes.byteLength),
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
    // 代号算术对不代表目录还在：stage() → discard(n) → commit(n) 之前会把
    // active 切到一个已被删掉的目录，此后所有读写都在不存在的路径上
    if (!existsSync(this.generationPath(stagedGeneration))) return false;
    this.active = stagedGeneration;
    // 切代后此前的 receipt 全部作废：它们绑定的是旧 generation
    this.receipts.clear();
    return true;
  }

  discard(stagedGeneration: number): void {
    if (stagedGeneration <= this.active) return;
    rmSync(this.generationPath(stagedGeneration), { recursive: true, force: true });
  }

  /**
   * 把历史某一代的**内容**恢复成新的一代 —— 像 git revert，不像 reset。
   *
   * 存在的理由是交叉审核的整改路径：整改改完文件、验证反而失败时，封存补丁
   * （绑定整改前内容）和工作区（整改后内容）会脱节，文件树展示的是一个已被
   * 放弃的现场。恢复必须发生。
   *
   * 刻意**不做**"把 active 指回旧代"的倒退：generation 编号单调前进是 receipt
   * 失效判定和 stage() 目录分配的前提 —— 倒退后 stage() 会以 active+1 撞上
   * 残留目录，receipt 的"绑定旧代即作废"也会被"代号重复出现"搅浑。
   * 前进式恢复不动这两条不变式，代价只是一次 APFS clone。
   */
  restoreGeneration(sourceGen: number): { generation: number } {
    if (sourceGen > this.active) {
      throw new Error(`无法恢复 gen-${sourceGen}：它在 active（gen-${this.active}）之后`);
    }
    const sourcePath = this.generationPath(sourceGen);
    if (!existsSync(sourcePath)) {
      throw new Error(`无法恢复 gen-${sourceGen}：目录不存在`);
    }
    const next = this.active + 1;
    const path = this.generationPath(next);
    rmSync(path, { recursive: true, force: true });
    cloneTree(sourcePath, path);
    this.linkDependencies(path);
    if (!this.commit(next, this.active)) {
      // commit 的三个失败条件在单线程 Core 里都不该出现；出现即为内部不变式违规
      throw new Error(`恢复 gen-${sourceGen} 时 CAS 提交失败（active=${this.active}）`);
    }
    return { generation: next };
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
  changedVsBaseline(): { authored: string[]; generated: string[]; deleted: string[] } {
    const base = listTree(this.generationPath(0));
    const now = listTree(this.activePath);
    const baseMap = new Map(base.map((f) => [f.path, f.digest]));
    const nowSet = new Set(now.map((f) => f.path));
    const authored: string[] = [];
    const generated: string[] = [];
    const deleted: string[] = [];

    for (const f of now) {
      if (baseMap.get(f.path) === f.digest) continue;
      (isGeneratedPath(f.path) ? generated : authored).push(f.path);
    }
    // 只遍历"当前存在"的文件会让被删掉的文件在补丁里彻底消失且无任何说明 ——
    // 那正是本文件和 patch.ts 都声明过不允许的"静默省略"
    for (const f of base) {
      if (!nowSet.has(f.path) && !isGeneratedPath(f.path)) deleted.push(f.path);
    }
    return { authored: authored.sort(), generated: generated.sort(), deleted: deleted.sort() };
  }

  changedFilesVsBaseline(): string[] {
    return this.changedVsBaseline().authored;
  }

  /**
   * 把当前 active generation 的**内容**导出成一个一次性 candidate 目录，
   * 给外部编码代理（Codex / Claude CLI 当作者）在里面自由改。
   *
   * 这是 TD-DEC-016 写明的 candidate-to-canonical 边界的原型落点：
   *   - candidate 目录**不是** generation：它没有编号、不参与 stage()/commit() 的
   *     CAS、不能成为 active。外部作者改完之后，平台只拿它与导出时的 baseTree 做
   *     tree diff，再把差异**归一化成 MutationPlan** 走 applyMutationPlan —— 于是
   *     receipt、whole-file digest CAS、protected/allowed path、预算、失败零写入
   *     全部照旧生效。外部作者从头到尾碰不到主线 generation。
   *   - 目录放在工作区根下（`candidate-<id>`），cleanup() 会一并回收；
   *     正常路径由调用方在归一化完成后立刻 discardCandidate()。
   *   - 同 stage() 一样挂宿主 node_modules 的 symlink（作者可能要 tsc/vitest 自检）。
   *     残余风险与 linkDependencies 处注释相同，这里不额外放宽也不额外收紧。
   *   - baseTree 在导出**当下**计算并随返回值交给调用方：归一化时用它而不是
   *     重新读 active —— active 若在期间被别的事务推进，applyMutationPlan 的
   *     generation/receipt 校验会拒绝，这正是想要的。
   */
  exportCandidate(): {
    candidateId: string;
    path: string;
    baseGeneration: number;
    baseTree: TreeEntry[];
  } {
    const candidateId = newId('cand');
    const path = join(this.root, `candidate-${candidateId}`);
    rmSync(path, { recursive: true, force: true });
    cloneTree(this.activePath, path);
    this.linkDependencies(path);
    return {
      candidateId,
      path,
      baseGeneration: this.active,
      baseTree: listTree(this.activePath),
    };
  }

  /** 丢弃 candidate 目录。只接受本工作区根下的 candidate-* 路径，别的路径一律拒绝。 */
  discardCandidate(path: string): void {
    const rootResolved = resolve(this.root);
    const target = resolve(path);
    if (!target.startsWith(rootResolved + sep) || !relative(rootResolved, target).startsWith('candidate-')) {
      throw new Error(`拒绝删除非 candidate 路径：${path}`);
    }
    rmSync(target, { recursive: true, force: true });
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
  // 逐级检查：symlink 一律拒绝；请求拼写必须与磁盘真实条目逐字节一致
  let cursor = rootResolved;
  for (const part of relative(rootResolved, abs).split(sep).filter(Boolean)) {
    const parent = cursor;
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue; // 尚不存在（如 CREATE 的新末段）：留给上层判定
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new PathViolation(`拒绝 symlink: ${relPath}`, 'SYMLINK_REJECTED');
    }
    // 大小写 / Unicode 归一防绕过：macOS APFS 默认对大小写与 NFC/NFD 都不敏感，
    // 于是 existsSync('Package.json') 对 package.json 返回 true、写入会覆盖它，
    // 而受保护路径匹配（globMatch 编成大小写敏感正则）却对不上 —— 一条完整的越权。
    // 要求请求拼写与父目录里的真实条目逐字节相等，把这条通路堵死。
    if (!readdirSync(parent).includes(part)) {
      throw new PathViolation(
        `路径拼写与磁盘上的真实条目不一致（大小写/Unicode 归一绕过）: ${relPath}`,
        'PATH_CASE_MISMATCH',
      );
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
    readonly reason: 'PATH_ESCAPE' | 'SYMLINK_REJECTED' | 'PATH_CASE_MISMATCH',
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
