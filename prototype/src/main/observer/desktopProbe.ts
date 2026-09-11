import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Desktop 应用集成面探针（只读、只取形状）。
 *
 * ## 为什么需要它
 *
 * 2026-09-11 的侦察推翻了「观察 Claude/Codex desktop」的原始设想：两家 desktop 都是
 * Electron/Chromium 应用，会话状态在 profile 的 IndexedDB（LevelDB）里，正被应用进程持有 ——
 * 无跨进程读契约、无 schema 合同、每次发版都可能变。那条路是死的。
 *
 * 但同一次侦察发现了**另一个集成面**：Claude desktop 内嵌了一个完整的 Claude Code CLI
 * （`Application Support/Claude/claude-code/<version>/`，且同时存在多个版本），
 * 以及一个跑 cowork 的本地 VM（`vm_bundles/`）。而近 7 天的 journal 全部落在
 * `~/.claude/projects/` —— 也就是观察面板**已经会读**的那棵树，
 * `Application Support/Claude/` 下没有任何 journal。
 *
 * 于是问题从「观察不到」变成「观察得到但**分不清是谁**」：内嵌 CLI 的会话可能与用户
 * 自己 CLI 的会话混在同一棵树里。这个探针要回答的就是归属问题，而不是再去看 LevelDB。
 *
 * ## 纪律
 *
 * - **只读**。不写任何文件、不挂载 VM 镜像、不打开 LevelDB。
 * - **只取形状**。journal 只读前若干行、只收集**键名**；唯一例外是版本类字段的**值**
 *   （版本号不是会话内容，且观察面板本来就在跟踪它）。
 * - **opt-in**。`REPOPILOT_PROBE_DESKTOP` 不设置时测试整体跳过 —— 单测不读真实 HOME。
 * - **零出站**。报告只打印到控制台。
 */

export interface BundledCli {
  /** 内嵌 CLI 的根目录 */
  readonly root: string;
  /** 发现的版本目录名，按名字排序 */
  readonly versions: readonly string[];
  /** 可执行文件路径（若存在） */
  readonly binaries: readonly string[];
}

export interface FsArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface LevelDbPresence {
  readonly dir: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly newestMtimeMs: number;
  readonly hasManifest: boolean;
}

export interface JournalProvenance {
  readonly journalPath: string;
  /** 前若干行里出现过的顶层键名（去重、排序） */
  readonly topLevelKeys: readonly string[];
  /** 归属元数据字段的取值（去重、排序）—— 唯一被允许取的值，见 METADATA_VALUE_KEYS */
  readonly metadataValues: readonly string[];
  /** 读了多少行 */
  readonly linesRead: number;
}

export interface DesktopProbeReport {
  readonly vendor: 'CLAUDE_DESKTOP' | 'CODEX_DESKTOP';
  /** 应用数据根是否存在 */
  readonly appSupportExists: boolean;
  readonly appSupportPath: string;
  readonly bundledCli: BundledCli | null;
  readonly vmArtifacts: readonly FsArtifact[];
  readonly indexedDb: readonly LevelDbPresence[];
  readonly journalProvenance: readonly JournalProvenance[];
}

/**
 * 元数据字段：只有这些键的**值**会被收集，其余一律只记键名。
 *
 * 探针首跑（2026-09-11）发现 journal 顶层键里带 `entrypoint` / `userType` / `origin` ——
 * 这正是回答「这条会话是谁产生的」所需的归属字段，而它们属于元数据，不是会话内容。
 * 版本系键同理：观察面板本来就在跟踪 CLI 版本。
 */
const METADATA_VALUE_KEYS = new Set([
  'version',
  'claudeCodeVersion',
  'claude_code_version',
  'cliVersion',
  'appVersion',
  'entrypoint',
  'userType',
  'origin',
  'client_platform',
]);

/** 每个 journal 最多读多少行（够看到首条 meta 记录即可） */
const MAX_LINES_PER_JOURNAL = 24;
/** 最多抽样多少个 journal */
const MAX_JOURNAL_SAMPLE = 12;

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(path: string): FsArtifact | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    return { path, bytes: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** 在目录树里找内嵌 CLI：版本目录 + 可执行文件 */
export function findBundledCli(appSupport: string, vendor: 'claude' | 'codex'): BundledCli | null {
  const root = vendor === 'claude' ? join(appSupport, 'claude-code') : join(appSupport, 'codex-cli');
  if (!existsSync(root)) return null;
  const versions = safeReaddir(root)
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .sort();
  const binaries: string[] = [];
  for (const v of versions) {
    for (const cand of [
      join(root, v, 'claude.app', 'Contents', 'MacOS', 'claude'),
      join(root, v, 'bin', 'claude'),
      join(root, v, 'codex'),
    ]) {
      if (safeStat(cand)) binaries.push(cand);
    }
  }
  return { root, versions, binaries };
}

/** VM 工件：只报存在性/大小/mtime，绝不挂载 */
export function findVmArtifacts(appSupport: string): FsArtifact[] {
  const vmRoot = join(appSupport, 'vm_bundles');
  if (!existsSync(vmRoot)) return [];
  const out: FsArtifact[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      const asFile = safeStat(p);
      if (asFile) {
        // 只关心镜像/内核这类大件，避免把整个 bundle 列出来
        if (/\.(img|zst|vmlinuz|initrd)$/.test(name) || asFile.bytes > 1024 * 1024) out.push(asFile);
        continue;
      }
      try {
        if (statSync(p).isDirectory()) visit(p, depth + 1);
      } catch {
        /* 忽略 */
      }
    }
  };
  visit(vmRoot, 0);
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** IndexedDB / LevelDB 的存在性与活跃度（文件级，不打开数据库） */
export function findLevelDbDirs(appSupport: string): LevelDbPresence[] {
  const out: LevelDbPresence[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    const names = safeReaddir(dir);
    if (names.some((n) => /^MANIFEST-\d+/.test(n)) && names.some((n) => n.endsWith('.ldb') || n.endsWith('.log'))) {
      const files = names.map((n) => safeStat(join(dir, n))).filter((f): f is FsArtifact => f !== null);
      out.push({
        dir,
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.bytes, 0),
        newestMtimeMs: files.reduce((n, f) => Math.max(n, f.mtimeMs), 0),
        hasManifest: names.some((n) => /^MANIFEST-\d+/.test(n)),
      });
      return; // 不再下钻
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory()) visit(p, depth + 1);
      } catch {
        /* 忽略 */
      }
    }
  };
  visit(appSupport, 0);
  return out;
}

/**
 * journal 归属探针：这些会话是谁产生的？
 *
 * 只读前 MAX_LINES_PER_JOURNAL 行、只收集顶层键名；版本类键的值是唯一被取的值。
 * 不读正文、不读 prompt、不读工具输出。
 */
export function probeJournalProvenance(journalPaths: readonly string[]): JournalProvenance[] {
  const out: JournalProvenance[] = [];
  for (const path of journalPaths.slice(0, MAX_JOURNAL_SAMPLE)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const keys = new Set<string>();
    const metaValues = new Set<string>();
    let linesRead = 0;
    for (const line of raw.split('\n')) {
      if (linesRead >= MAX_LINES_PER_JOURNAL) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      linesRead += 1;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
      for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
        keys.add(k);
        if (METADATA_VALUE_KEYS.has(k) && typeof v === 'string') metaValues.add(v);
      }
    }
    out.push({
      journalPath: path,
      topLevelKeys: [...keys].sort(),
      metadataValues: [...metaValues].sort(),
      linesRead,
    });
  }
  return out;
}

export function desktopAppSupportPath(vendor: 'claude' | 'codex'): string {
  const name = vendor === 'claude' ? 'Claude' : 'Codex';
  return join(homedir(), 'Library', 'Application Support', name);
}

/**
 * 「本地 agent 模式」的审计日志。
 *
 * 探针首跑（2026-09-11）推翻了侦察结论：Claude desktop 的 Application Support 下
 * **有** journal —— `local-agent-mode-sessions/<uuid>/<uuid>/<uuid>/audit.jsonl`。
 * 侦察当时漏掉它是因为 `find … -mtime -7 | head -10` 的截断。
 *
 * 如果这是一份刻意写出的、结构稳定的审计 Artifact，它才是 desktop 的观察面 ——
 * 而不是 profile 里那个活着的 LevelDB。这里只报存在性与活跃度，形状由调用方按需取。
 */
export function findLocalAgentModeAudits(appSupport: string): FsArtifact[] {
  const root = join(appSupport, 'local-agent-mode-sessions');
  if (!existsSync(root)) return [];
  const out: FsArtifact[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5) return;
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      if (name === 'audit.jsonl') {
        const f = safeStat(p);
        if (f) out.push(f);
        continue;
      }
      try {
        if (statSync(p).isDirectory()) visit(p, depth + 1);
      } catch {
        /* 忽略 */
      }
    }
  };
  visit(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 用户自己 CLI 的 journal 根 —— 归属问题的对照组 */
export function userCliJournalRoot(vendor: 'claude' | 'codex'): string {
  return vendor === 'claude'
    ? join(homedir(), '.claude', 'projects')
    : join(homedir(), '.codex', 'sessions');
}
