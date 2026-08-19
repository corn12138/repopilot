import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, runDir, snapshotDir, workspaceDir } from './paths';
import { readJson, writeJsonAtomic } from './store';

/**
 * 本地数据保留与清理。
 *
 * 分类保留而不是一刀切，因为各类数据的成本和价值完全不同：
 *
 *   工作区   每个 Run 一份整仓克隆，最吃磁盘，且 Run 结束后只剩考古价值 → 终态后短期删
 *   快照     同一次导入可被多个 Run 共用 → 引用计数归零才删
 *   证据     事件日志 + 状态快照 + 补丁，是"可审计"承诺的载体 → 保留 30 天
 *   artifact 工具大输出，随 Run 一起走
 *
 * 删除语义（PRD-CONV-004）：
 *   - 每一项都产出**逐项结果**，不是一句"清理完成"
 *   - 任何一项失败、或被本轮上限截断，整体只能标 `INCOMPLETE`
 *   - 无法证明删干净时宁可说没删干净，也不谎报完成
 */

export const RETENTION_SCHEMA_VERSION = 1;

export interface RetentionPolicy {
  readonly schemaVersion: number;
  /** 证据（事件、状态快照、补丁、artifact）保留天数 */
  readonly evidenceDays: number;
  /** Run 进入终态后多久删掉它的工作区副本 */
  readonly workspaceGraceMinutes: number;
  /** 单轮清理的上限，避免一次扫描卡住主流程 */
  readonly maxItemsPerSweep: number;
  readonly maxDurationMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  schemaVersion: RETENTION_SCHEMA_VERSION,
  evidenceDays: 30,
  workspaceGraceMinutes: 60,
  maxItemsPerSweep: 200,
  maxDurationMs: 5_000,
};

export type PurgeDomain = 'WORKSPACE' | 'SNAPSHOT' | 'RUN_EVIDENCE' | 'ARTIFACT';

export interface PurgeItemResult {
  readonly domain: PurgeDomain;
  readonly target: string;
  /**
   * `WOULD_DELETE` 只出现在预演里，且**只**出现在预演里。
   * 用独立取值而不是复用 DELETED，是为了让"预演结果"在类型层面就不可能
   * 被下游当成"已经删完了"。
   */
  readonly outcome: 'DELETED' | 'WOULD_DELETE' | 'KEPT_REFERENCED' | 'KEPT_NOT_DUE' | 'FAILED';
  /** 实删时是已释放的字节；预演时是**将会**释放的字节。 */
  readonly bytesFreed: number;
  readonly reason: string | null;
}

export interface PurgeSummary {
  /** 这是一次预演还是一次真删。UI 绝不能把两者渲染成同一句话。 */
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly scanned: number;
  readonly deleted: number;
  readonly bytesFreed: number;
  /**
   * `COMPLETE` 只在**全部扫完且没有失败项**时给出。
   * 被上限截断、或有任何 FAILED，都只能是 `INCOMPLETE`。
   */
  readonly status: 'COMPLETE' | 'INCOMPLETE';
  readonly incompleteReason: string | null;
  readonly items: readonly PurgeItemResult[];
}

/** 清理时需要知道哪些东西还活着 —— 由 Core 提供，避免 retention 反向依赖 authority */
export interface LiveReferences {
  /**
   * runId → 该 Run 的终态信息与它引用的快照。
   *
   * snapshotId 是必要的：第 3 步要扣掉「刚在第 2 步被删掉证据的那些 Run」所独占的快照，
   * 否则它们要等下一轮（6 小时后）才回收 —— 而那时它们已经没有任何引用者了。
   */
  readonly runs: ReadonlyMap<
    string,
    { terminal: boolean; terminalAt: number | null; updatedAt: number; snapshotId: string | null }
  >;
  /** 仍被引用的 snapshotId */
  readonly snapshots: ReadonlySet<string>;
  /** 仍被引用的 artifact id（来自 toolCall.artifactRef、patch 文件名等） */
  readonly artifacts: ReadonlySet<string>;
}

const POLICY_PATH = join(PATHS.root, 'retention.json');
const LAST_SUMMARY_PATH = join(PATHS.root, 'last-purge.json');

export function loadPolicy(): RetentionPolicy {
  const stored = readJson<Partial<RetentionPolicy> | null>(POLICY_PATH, null);
  if (!stored || stored.schemaVersion !== RETENTION_SCHEMA_VERSION) return DEFAULT_RETENTION;
  return {
    ...DEFAULT_RETENTION,
    ...stored,
    // 夹紧到安全区间：0 天等于立刻删掉刚跑完的 Run，那是脚枪
    evidenceDays: clamp(stored.evidenceDays ?? DEFAULT_RETENTION.evidenceDays, 1, 365),
    workspaceGraceMinutes: clamp(
      stored.workspaceGraceMinutes ?? DEFAULT_RETENTION.workspaceGraceMinutes,
      0,
      60 * 24 * 30,
    ),
    schemaVersion: RETENTION_SCHEMA_VERSION,
  };
}

/**
 * 夹紧到安全区间。抽出来是为了让**预演**用上与保存完全相同的夹紧规则 ——
 * 否则预演的是一份用户填的原始数值，保存的是被夹过的另一份，两者会给出不同的结果。
 */
export function clampPolicy(policy: RetentionPolicy): RetentionPolicy {
  return {
    ...policy,
    schemaVersion: RETENTION_SCHEMA_VERSION,
    evidenceDays: clamp(policy.evidenceDays, 1, 365),
    workspaceGraceMinutes: clamp(policy.workspaceGraceMinutes, 0, 60 * 24 * 30),
  };
}

export function savePolicy(patch: Partial<RetentionPolicy>): RetentionPolicy {
  const clamped = clampPolicy({ ...loadPolicy(), ...patch, schemaVersion: RETENTION_SCHEMA_VERSION });
  writeJsonAtomic(POLICY_PATH, clamped);
  return clamped;
}

export function loadLastSummary(): PurgeSummary | null {
  return readJson<PurgeSummary | null>(LAST_SUMMARY_PATH, null);
}

/**
 * 跑一轮清理。
 *
 * 顺序是有讲究的：先删工作区（最占地方、最没争议），再删过期证据，
 * 最后按引用计数收快照和 artifact —— 因为删证据会让一批快照失去最后的引用者。
 */
export interface SweepOptions {
  /**
   * 预演：完整走一遍判定与体积统计，但**不调用 rmSync**。
   *
   * 这几乎是免费的 —— `remove()` 本来就在删除之前先算 `dirSize`，每个分支本来就产出
   * 一条 PurgeItemResult。没有它的时候，用户想知道"立即清理会删掉什么"的唯一办法
   * 就是真的删一次。
   */
  readonly dryRun?: boolean;
}

export function sweep(
  refs: LiveReferences,
  policy = loadPolicy(),
  now = Date.now(),
  options: SweepOptions = {},
): PurgeSummary {
  const dryRun = options.dryRun === true;
  const remove = (
    domain: PurgeDomain,
    target: string,
    path: string,
    reason: string,
  ): PurgeItemResult => removeOrPreview(domain, target, path, reason, dryRun);
  const startedAt = new Date(now).toISOString();
  const t0 = Date.now();
  const items: PurgeItemResult[] = [];
  let scanned = 0;
  let truncated: string | null = null;

  const budgetLeft = (): boolean => {
    if (items.length >= policy.maxItemsPerSweep) {
      truncated = `本轮处理数达上限 ${policy.maxItemsPerSweep}`;
      return false;
    }
    if (Date.now() - t0 >= policy.maxDurationMs) {
      truncated = `本轮耗时达上限 ${policy.maxDurationMs}ms`;
      return false;
    }
    return true;
  };

  const evidenceCutoff = now - policy.evidenceDays * 24 * 60 * 60 * 1000;
  const workspaceGrace = policy.workspaceGraceMinutes * 60 * 1000;

  // ---- 1. 工作区：Run 已终态且过了宽限期 ----
  const workspaceDirs = enumerate(PATHS.workspaces, 'dir');
  if (workspaceDirs.error) items.push(unreadable('WORKSPACE', PATHS.workspaces, workspaceDirs.error));
  for (const runId of workspaceDirs.names) {
    if (!budgetLeft()) break;
    scanned += 1;
    const info = refs.runs.get(runId);

    // 不认识的目录 = 孤儿（Run 记录已被删掉），直接回收
    if (!info) {
      items.push(remove('WORKSPACE', runId, workspaceDir(runId), '孤儿工作区，无对应 Run'));
      continue;
    }
    if (!info.terminal) {
      items.push(keep('WORKSPACE', runId, 'KEPT_REFERENCED', 'Run 尚未进入终态'));
      continue;
    }
    const due = (info.terminalAt ?? info.updatedAt) + workspaceGrace;
    if (now < due) {
      items.push(keep('WORKSPACE', runId, 'KEPT_NOT_DUE', `终态后宽限期未过（还剩 ${Math.ceil((due - now) / 60000)} 分钟）`));
      continue;
    }
    items.push(remove('WORKSPACE', runId, workspaceDir(runId), '终态且过宽限期'));
  }

  // ---- 2. 证据：超过保留天数 ----
  const purgedRuns = new Set<string>();
  const runDirs = enumerate(PATHS.runs, 'dir');
  if (runDirs.error) items.push(unreadable('RUN_EVIDENCE', PATHS.runs, runDirs.error));
  for (const runId of runDirs.names) {
    if (!budgetLeft()) break;
    scanned += 1;
    const info = refs.runs.get(runId);
    const stamp = info?.updatedAt ?? dirMtime(runDir(runId));

    if (info && !info.terminal) {
      items.push(keep('RUN_EVIDENCE', runId, 'KEPT_REFERENCED', 'Run 尚未进入终态'));
      continue;
    }
    if (stamp >= evidenceCutoff) {
      const days = Math.ceil((stamp - evidenceCutoff) / (24 * 60 * 60 * 1000));
      items.push(keep('RUN_EVIDENCE', runId, 'KEPT_NOT_DUE', `还剩约 ${days} 天到期`));
      continue;
    }
    const r = remove('RUN_EVIDENCE', runId, runDir(runId), `超过保留期 ${policy.evidenceDays} 天`);
    items.push(r);
    /*
     * 预演里这条是 WOULD_DELETE，也必须记进 purgedRuns。
     * 第 3 步靠它扣减「本轮刚失去最后一个引用者」的快照；只认 DELETED 的话，
     * 预演会把那些快照报成 KEPT_REFERENCED —— 于是预览说删 3 项、真跑删 4 项。
     * 一个会少报的预览比没有预览更糟：用户是照着它按下确认的。
     */
    if (r.outcome === 'DELETED' || r.outcome === 'WOULD_DELETE') purgedRuns.add(runId);
  }

  // ---- 3. 快照：引用计数归零，且要扣掉第 2 步刚删掉证据的那些 Run ----
  // refs 是 sweep 开始前算好的，里面还算着刚在第 2 步被删掉证据的 Run。
  // 不扣的话，只被它们引用的快照本轮判 KEPT_REFERENCED，要等下一轮（6 小时后）
  // 才回收 —— 而那时它们已经没有任何引用者了。
  // 只做**扣减**、不重算：refs.snapshots 里可能有不来自 refs.runs 的引用来源，
  // 重算会把那些误删。
  const liveSnapshots = new Set(refs.snapshots);
  if (purgedRuns.size > 0) {
    const stillReferenced = new Set<string>();
    for (const [runId, info] of refs.runs) {
      if (purgedRuns.has(runId)) continue;
      if (info.snapshotId) stillReferenced.add(info.snapshotId);
    }
    for (const runId of purgedRuns) {
      const sid = refs.runs.get(runId)?.snapshotId;
      // 只有「没有任何存活 Run 还引用它」时才摘掉
      if (sid && !stillReferenced.has(sid)) liveSnapshots.delete(sid);
    }
  }
  /*
   * 快照同样要有宽限期。
   *
   * "无 Run 引用"并不等于"没人要"：刚导入、还没创建任务的快照天然就是这个状态，
   * 而那恰恰是用户正盯着界面准备开工的时刻。之前这里直接删，结果是清理一跑，
   * 界面里攥着的 snapshotId 就成了悬空引用，点「开始」时 cloneTree 抛 ENOENT。
   * 复用工作区那条宽限期：新鲜的快照一律留着。
   */
  const snapshotDirs = enumerate(PATHS.snapshots, 'dir');
  if (snapshotDirs.error) items.push(unreadable('SNAPSHOT', PATHS.snapshots, snapshotDirs.error));
  for (const snapshotId of snapshotDirs.names) {
    if (!budgetLeft()) break;
    scanned += 1;
    if (liveSnapshots.has(snapshotId)) {
      items.push(keep('SNAPSHOT', snapshotId, 'KEPT_REFERENCED', '仍被至少一个 Run 引用'));
      continue;
    }
    const createdAt = dirMtime(snapshotDir(snapshotId));
    const due = createdAt + workspaceGrace;
    if (createdAt > 0 && now < due) {
      items.push(
        keep(
          'SNAPSHOT',
          snapshotId,
          'KEPT_NOT_DUE',
          `刚导入、宽限期未过（还剩 ${Math.ceil((due - now) / 60000)} 分钟）—— 可能正要用它建任务`,
        ),
      );
      continue;
    }
    items.push(remove('SNAPSHOT', snapshotId, snapshotDir(snapshotId), '无 Run 引用且过了宽限期'));
  }

  // ---- 4. artifact：无引用的孤儿 ----
  const artifactFiles = enumerate(PATHS.artifacts, 'file');
  if (artifactFiles.error) items.push(unreadable('ARTIFACT', PATHS.artifacts, artifactFiles.error));
  for (const name of artifactFiles.names) {
    if (!budgetLeft()) break;
    scanned += 1;
    const id = name.replace(/\.(txt|diff)$/, '');
    if (refs.artifacts.has(id)) {
      items.push(keep('ARTIFACT', name, 'KEPT_REFERENCED', '仍被工具调用或补丁引用'));
      continue;
    }
    items.push(remove('ARTIFACT', name, join(PATHS.artifacts, name), '无引用'));
  }

  const failed = items.filter((i) => i.outcome === 'FAILED');
  // 预演里 deleted 计的是"将会删掉的项"；`dryRun` 字段负责让调用方分清这一点。
  const deleted = items.filter((i) => i.outcome === (dryRun ? 'WOULD_DELETE' : 'DELETED'));
  const incompleteReason =
    failed.length > 0
      ? `${failed.length} 项删除失败：${failed.map((f) => f.target).join(', ').slice(0, 200)}`
      : truncated;

  const summary: PurgeSummary = {
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    scanned,
    deleted: deleted.length,
    bytesFreed: deleted.reduce((n, d) => n + d.bytesFreed, 0),
    // 有失败或被截断，一律 INCOMPLETE —— 无法证明删干净就不说删干净
    status: incompleteReason ? 'INCOMPLETE' : 'COMPLETE',
    incompleteReason,
    items,
  };

  /*
   * 预演绝不写盘。这里曾经是无条件写：于是"预览一下会删什么"会把**上一次真实清理**的
   * 记录覆盖成一份什么都没做的预演 —— 既是预演的副作用，也销毁了真实证据。
   * 一个号称无副作用的操作，唯一能被信任的方式就是它真的没有副作用。
   */
  if (!dryRun) {
    try {
      writeJsonAtomic(LAST_SUMMARY_PATH, summary);
    } catch {
      // 写不下汇总不影响清理本身已经发生的事实
    }
  }
  return summary;
}

/** 数据根各域的磁盘占用，给 UI 用 */
export function diskUsage(): Record<string, { bytes: number; entries: number }> {
  const out: Record<string, { bytes: number; entries: number }> = {};
  for (const [name, dir] of Object.entries({
    runs: PATHS.runs,
    workspaces: PATHS.workspaces,
    snapshots: PATHS.snapshots,
    artifacts: PATHS.artifacts,
  })) {
    out[name] = { bytes: dirSize(dir), entries: listDirs(dir).length + listFiles(dir).length };
  }
  return out;
}

// ---------------------------------------------------------------------------

function removeOrPreview(
  domain: PurgeDomain,
  target: string,
  path: string,
  reason: string,
  dryRun: boolean,
): PurgeItemResult {
  const bytes = dirSize(path);
  // 预演到此为止：体积已经量到了，接下来的 rmSync 是唯一被跳过的那一步。
  if (dryRun) return { domain, target, outcome: 'WOULD_DELETE', bytesFreed: bytes, reason };
  try {
    rmSync(path, { recursive: true, force: true });
    // 删完再确认一次 —— rmSync 不抛不等于目录真的没了
    if (existsSync(path)) {
      return { domain, target, outcome: 'FAILED', bytesFreed: 0, reason: '删除后路径仍然存在' };
    }
    return { domain, target, outcome: 'DELETED', bytesFreed: bytes, reason };
  } catch (err) {
    return { domain, target, outcome: 'FAILED', bytesFreed: 0, reason: (err as Error).message };
  }
}

/** 整个域读不了：作为该域根目录上的一条 FAILED 落账，让 status 只能是 INCOMPLETE。 */
function unreadable(domain: PurgeDomain, root: string, code: string): PurgeItemResult {
  return { domain, target: root, outcome: 'FAILED', bytesFreed: 0, reason: `无法枚举该域（${code}），本轮一项都没检查` };
}

function keep(
  domain: PurgeDomain,
  target: string,
  outcome: 'KEPT_REFERENCED' | 'KEPT_NOT_DUE',
  reason: string,
): PurgeItemResult {
  return { domain, target, outcome, bytesFreed: 0, reason };
}

/**
 * 目录枚举结果必须把「读不了」和「是空的」分开：
 * 之前两个函数在 readdir 抛错时一律 `return []`，于是某个域一个字节都没被检查时，
 * 汇总照样给 COMPLETE + 已释放 X 字节 —— 这正是"无法证明删干净却声称删干净"。
 * `error` 非空时调用方必须把该域记为 FAILED，让 status 只能落 INCOMPLETE。
 */
interface Enumeration {
  readonly names: string[];
  readonly error: string | null;
}

function enumerate(dir: string, kind: 'dir' | 'file'): Enumeration {
  if (!existsSync(dir)) return { names: [], error: null };
  try {
    return {
      names: readdirSync(dir, { withFileTypes: true })
        .filter((e) => (kind === 'dir' ? e.isDirectory() : e.isFile()))
        .map((e) => e.name),
      error: null,
    };
  } catch (err) {
    return { names: [], error: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
}

function listDirs(dir: string): string[] {
  return enumerate(dir, 'dir').names;
}

function listFiles(dir: string): string[] {
  return enumerate(dir, 'file').names;
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // 不跟随，否则会把宿主 node_modules 算进来
      total += dirSize(join(path, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function dirMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
