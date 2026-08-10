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
  readonly outcome: 'DELETED' | 'KEPT_REFERENCED' | 'KEPT_NOT_DUE' | 'FAILED';
  readonly bytesFreed: number;
  readonly reason: string | null;
}

export interface PurgeSummary {
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

export function savePolicy(patch: Partial<RetentionPolicy>): RetentionPolicy {
  const next: RetentionPolicy = {
    ...loadPolicy(),
    ...patch,
    schemaVersion: RETENTION_SCHEMA_VERSION,
  };
  const clamped: RetentionPolicy = {
    ...next,
    evidenceDays: clamp(next.evidenceDays, 1, 365),
    workspaceGraceMinutes: clamp(next.workspaceGraceMinutes, 0, 60 * 24 * 30),
  };
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
export function sweep(refs: LiveReferences, policy = loadPolicy(), now = Date.now()): PurgeSummary {
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
  for (const runId of listDirs(PATHS.workspaces)) {
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
  for (const runId of listDirs(PATHS.runs)) {
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
    if (r.outcome === 'DELETED') purgedRuns.add(runId);
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
  for (const snapshotId of listDirs(PATHS.snapshots)) {
    if (!budgetLeft()) break;
    scanned += 1;
    if (liveSnapshots.has(snapshotId)) {
      items.push(keep('SNAPSHOT', snapshotId, 'KEPT_REFERENCED', '仍被至少一个 Run 引用'));
      continue;
    }
    items.push(remove('SNAPSHOT', snapshotId, snapshotDir(snapshotId), '无 Run 引用'));
  }

  // ---- 4. artifact：无引用的孤儿 ----
  for (const name of listFiles(PATHS.artifacts)) {
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
  const deleted = items.filter((i) => i.outcome === 'DELETED');
  const incompleteReason =
    failed.length > 0
      ? `${failed.length} 项删除失败：${failed.map((f) => f.target).join(', ').slice(0, 200)}`
      : truncated;

  const summary: PurgeSummary = {
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

  try {
    writeJsonAtomic(LAST_SUMMARY_PATH, summary);
  } catch {
    // 写不下汇总不影响清理本身已经发生的事实
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

function remove(domain: PurgeDomain, target: string, path: string, reason: string): PurgeItemResult {
  const bytes = dirSize(path);
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

function keep(
  domain: PurgeDomain,
  target: string,
  outcome: 'KEPT_REFERENCED' | 'KEPT_NOT_DUE',
  reason: string,
): PurgeItemResult {
  return { domain, target, outcome, bytesFreed: 0, reason };
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
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
