import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 本机代理会话日志的**字段快照回归断言**（ASM-027 / TD-ASM-021 的验证器）。
 *
 * 背景：观察面板（PRD-WKB-002，P1/Deferred）要读两家的本机会话日志 ——
 * Claude Code 的 `~/.claude/projects/<项目>/<会话>.jsonl` 与
 * Codex 的 `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`。
 * 两个都是**未文档化内部格式**，随版本静默漂移（EVI-LOCAL-SESSION-JOURNAL-001）。
 * 面板还不存在，这个模块先存在：升级后跑一次对照，漂移在建面板之前就能看见；
 * 面板建成后，同一份判定让它在漂移时降级为「格式未知」而不是错读。
 * 先例：connector.ts 里 OpenCode stdin 行为的回归断言 —— 无合同保障的行为，
 * 就用断言钉住它，变了第一时间知道。
 *
 * 两层字段模型是本模块的核心取舍，为了防一个具体的误报陷阱：
 *
 *   **样本里没出现 ≠ 格式里被删掉。** 今天抓的会话可能恰好没有 `queue-operation`
 *   记录，不能因此断言 claude 删了这个 type。所以快照按 type 记两层：
 *   `required` = 该 type 的**每条**记录都有的键（基线词表里的必现键）；
 *   `optional` = 只在部分记录出现的键。
 *   对照时只有两种情况算破坏性漂移（都以基线的 required 为准）：
 *   MISSING —— 本次观测到该 type，但某必现键一条记录都没有；
 *   DEMOTED —— 本次观测到该 type，但某必现键只剩部分记录有。
 *   基线里有、本次完全没观测到的 type 只进 `unobservedTypes` 报数，不定罪。
 *
 * 快照文件只含**键名与 type 名**，不含任何记录值 —— 它们要提交进公开仓库，
 * 而日志内容是用户隐私（DEC-020：观察内容零出站，键名是 schema 元数据不是内容）。
 *
 * 用法（probe 是显式 opt-in，`pnpm test` 默认不读任何真实 HOME）：
 *   pnpm probe:journals                          # 对照本机日志与已提交快照
 *   REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals   # 重新生成快照（升级两家后跑）
 */

import type { JournalVendor } from '@shared/observerProtocol';

export type { JournalVendor };

export interface TypeShape {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface JournalShapeSnapshot {
  readonly vendor: JournalVendor;
  /** 仅出处元数据，diff 不比较 */
  readonly capturedAt: string;
  readonly files: number;
  readonly records: number;
  /** 非空但解析不出对象的行 —— 计数，绝不抛（观察者不能被日志垃圾弄崩） */
  readonly unparseableLines: number;
  readonly blankLines: number;
  /** 超出单文件行数上限被跳过的行 —— 省略要报数 */
  readonly truncatedLines: number;
  /** 超出 distinct type 上限被丢弃的记录数 */
  readonly droppedForTypeCap: number;
  readonly types: Readonly<Record<string, TypeShape>>;
  /** CODEX_ROLLOUT 才有：按 payload.type 的第二层形状；CLAUDE 为 null */
  readonly payloadTypes: Readonly<Record<string, TypeShape>> | null;
}

export interface ShapeDriftReport {
  readonly verdict: 'MATCH' | 'ADDITIVE_DRIFT' | 'BREAKING_DRIFT';
  /** MISSING / DEMOTED 两类，键名级定位；非空即 BREAKING_DRIFT */
  readonly breaking: readonly string[];
  /** 新 type / 新键 —— 观察面板可以照常工作，但词表该更新了 */
  readonly additive: readonly string[];
  /** 基线有、本次未观测 —— 无信号，只报数 */
  readonly unobservedTypes: readonly string[];
  readonly unobservedPayloadTypes: readonly string[];
}

/** 单文件行数上限：超出跳过并计入 truncatedLines。观察这份日志不需要无界读取 */
export const MAX_LINES_PER_FILE = 20_000;
/** 每层 distinct type 上限：损坏/敌意日志不该把快照撑成无界枚举 */
export const MAX_DISTINCT_TYPES = 200;
/** 单条记录键数上限：超出按 unparseable 计（退化记录，不参与交集运算） */
export const MAX_KEYS_PER_RECORD = 500;
/** type 值超长截断（防把整段文本当 type 名收进快照） */
const MAX_TYPE_NAME = 100;
const UNTYPED = 'UNTYPED';

interface LevelAcc {
  readonly union: Map<string, Set<string>>;
  readonly inter: Map<string, Set<string>>;
  dropped: number;
}

function newLevelAcc(): LevelAcc {
  return { union: new Map(), inter: new Map(), dropped: 0 };
}

function feedLevel(acc: LevelAcc, typeName: string, keys: readonly string[]): void {
  const existingUnion = acc.union.get(typeName);
  if (!existingUnion) {
    if (acc.union.size >= MAX_DISTINCT_TYPES) {
      acc.dropped += 1;
      return;
    }
    acc.union.set(typeName, new Set(keys));
    acc.inter.set(typeName, new Set(keys));
    return;
  }
  for (const k of keys) existingUnion.add(k);
  const inter = acc.inter.get(typeName);
  if (!inter) return; // union 有则 inter 必有；防御分支不参与判定
  const keySet = new Set(keys);
  for (const k of [...inter]) {
    if (!keySet.has(k)) inter.delete(k);
  }
}

function finishLevel(acc: LevelAcc): Record<string, TypeShape> {
  const out: Record<string, TypeShape> = {};
  for (const typeName of [...acc.union.keys()].sort()) {
    const union = acc.union.get(typeName) ?? new Set<string>();
    const inter = acc.inter.get(typeName) ?? new Set<string>();
    const required = [...inter].sort();
    const optional = [...union].filter((k) => !inter.has(k)).sort();
    out[typeName] = { required, optional };
  }
  return out;
}

function typeNameOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TYPE_NAME) : UNTYPED;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从若干文件的原始行聚合出字段快照。不做任何 IO —— IO 归 discover/read 系列。
 *
 * 入参是 **Iterable**（数组或生成器）而不是数组的数组：2026-09-05 把基线扫描从 40 个
 * 文件扩到 200 个时，先把全部文件读进内存再归纳直接撞了 heap OOM。惰性迭代让内存里
 * 任何时刻只有一个文件的行 —— 调用方用生成器逐个读，归纳完即丢。
 */
export function captureShape(
  vendor: JournalVendor,
  fileLines: Iterable<readonly string[]>,
): JournalShapeSnapshot {
  const top = newLevelAcc();
  const payload = newLevelAcc();
  let files = 0;
  let records = 0;
  let unparseableLines = 0;
  let blankLines = 0;
  let truncatedLines = 0;

  for (const allLines of fileLines) {
    files += 1;
    const lines = allLines.slice(0, MAX_LINES_PER_FILE);
    truncatedLines += allLines.length - lines.length;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') {
        blankLines += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unparseableLines += 1;
        continue;
      }
      if (!isPlainRecord(parsed)) {
        unparseableLines += 1;
        continue;
      }
      const keys = Object.keys(parsed);
      if (keys.length > MAX_KEYS_PER_RECORD) {
        unparseableLines += 1;
        continue;
      }
      records += 1;
      feedLevel(top, typeNameOf(parsed.type), keys.sort());
      if (vendor === 'CODEX_ROLLOUT' && isPlainRecord(parsed.payload)) {
        const payloadKeys = Object.keys(parsed.payload);
        if (payloadKeys.length <= MAX_KEYS_PER_RECORD) {
          feedLevel(payload, typeNameOf(parsed.payload.type), payloadKeys.sort());
        }
      }
    }
  }

  return {
    vendor,
    capturedAt: new Date().toISOString(),
    files,
    records,
    unparseableLines,
    blankLines,
    truncatedLines,
    droppedForTypeCap: top.dropped + payload.dropped,
    types: finishLevel(top),
    payloadTypes: vendor === 'CODEX_ROLLOUT' ? finishLevel(payload) : null,
  };
}

function diffLevel(
  level: string,
  baseline: Readonly<Record<string, TypeShape>>,
  current: Readonly<Record<string, TypeShape>>,
  breaking: string[],
  additive: string[],
  unobserved: string[],
): void {
  for (const [typeName, cur] of Object.entries(current)) {
    const base = baseline[typeName];
    if (!base) {
      additive.push(`${level} 新 type：${typeName}（${cur.required.length + cur.optional.length} 键）`);
      continue;
    }
    const curAll = new Set([...cur.required, ...cur.optional]);
    const curRequired = new Set(cur.required);
    for (const k of base.required) {
      if (!curAll.has(k)) {
        breaking.push(`${level} MISSING：${typeName}.${k}（基线必现，本次一条记录都没有）`);
      } else if (!curRequired.has(k)) {
        breaking.push(`${level} DEMOTED：${typeName}.${k}（基线必现，本次仅部分记录含）`);
      }
    }
    const baseAll = new Set([...base.required, ...base.optional]);
    for (const k of [...curAll].sort()) {
      if (!baseAll.has(k)) additive.push(`${level} 新键：${typeName}.${k}`);
    }
  }
  for (const typeName of Object.keys(baseline)) {
    if (!(typeName in current)) unobserved.push(`${level}:${typeName}`);
  }
}

/**
 * 基线 vs 本次观测。只有「基线必现键在本次缺席/降级」算破坏；
 * 整个 type 未观测不定罪（样本没出现 ≠ 格式删掉了），进 unobserved 报数。
 */
export function diffShape(
  baseline: JournalShapeSnapshot,
  current: JournalShapeSnapshot,
): ShapeDriftReport {
  if (baseline.vendor !== current.vendor) {
    throw new Error(`不同 vendor 的快照不可对照：${baseline.vendor} vs ${current.vendor}`);
  }
  const breaking: string[] = [];
  const additive: string[] = [];
  const unobservedTypes: string[] = [];
  const unobservedPayloadTypes: string[] = [];

  diffLevel('top', baseline.types, current.types, breaking, additive, unobservedTypes);
  if (baseline.payloadTypes || current.payloadTypes) {
    diffLevel(
      'payload',
      baseline.payloadTypes ?? {},
      current.payloadTypes ?? {},
      breaking,
      additive,
      unobservedPayloadTypes,
    );
  }

  return {
    verdict: breaking.length > 0 ? 'BREAKING_DRIFT' : additive.length > 0 ? 'ADDITIVE_DRIFT' : 'MATCH',
    breaking,
    additive,
    unobservedTypes,
    unobservedPayloadTypes,
  };
}

/**
 * 单条记录 vs 基线的必现键检查 —— 观察面板逐条调用的守卫。
 *
 * 语义与 diffShape 的 MISSING 一致但粒度更细：某条记录的 type 在基线里存在、
 * 却缺了基线必现键 → 返回违规（`top:type.key` / `payload:type.key`）。
 * 基线不认识的 type 不算违规（增量漂移不定罪）。调用方拿到非空返回时应当
 * 把整个会话降级为「格式未知」—— 错读比不读更糟。
 */
export function recordShapeViolations(
  baseline: JournalShapeSnapshot,
  record: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const check = (
    level: string,
    shapes: Readonly<Record<string, TypeShape>>,
    typeName: string,
    keys: readonly string[],
  ): void => {
    const base = shapes[typeName];
    if (!base) return;
    const keySet = new Set(keys);
    for (const k of base.required) {
      if (!keySet.has(k)) out.push(`${level}:${typeName}.${k}`);
    }
  };
  check('top', baseline.types, typeNameOf(record.type), Object.keys(record));
  if (baseline.payloadTypes && isPlainRecord(record.payload)) {
    check(
      'payload',
      baseline.payloadTypes,
      typeNameOf(record.payload.type),
      Object.keys(record.payload),
    );
  }
  return out;
}

/** 稳定序列化：结构在 capture 阶段已排序，这里只负责缩进与收尾换行 */
export function serializeSnapshot(snapshot: JournalShapeSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * 解析并自检已提交的快照。不合形状就抛 —— 仓库里的基线烂了必须当场知道，
 * 而不是在某次对照里安静地把漂移判成 MATCH。
 */
export function parseSnapshot(text: string): JournalShapeSnapshot {
  const raw: unknown = JSON.parse(text);
  if (!isPlainRecord(raw)) throw new Error('快照不是对象');
  const vendor = raw.vendor;
  if (vendor !== 'CLAUDE_JOURNAL' && vendor !== 'CODEX_ROLLOUT') {
    throw new Error(`快照 vendor 不合法：${String(vendor)}`);
  }
  const checkLevel = (level: unknown, where: string): Record<string, TypeShape> => {
    if (!isPlainRecord(level)) throw new Error(`快照 ${where} 不是对象`);
    const out: Record<string, TypeShape> = {};
    for (const [typeName, shapeRaw] of Object.entries(level)) {
      if (!isPlainRecord(shapeRaw)) throw new Error(`快照 ${where}.${typeName} 不是对象`);
      const required = shapeRaw.required;
      const optional = shapeRaw.optional;
      const isSortedStrings = (v: unknown): v is string[] =>
        Array.isArray(v) &&
        v.every((x) => typeof x === 'string') &&
        v.every((x, i) => i === 0 || String(v[i - 1]) < x);
      if (!isSortedStrings(required) || !isSortedStrings(optional)) {
        throw new Error(`快照 ${where}.${typeName} 的键列表必须是严格升序字符串数组`);
      }
      const overlap = required.filter((k) => optional.includes(k));
      if (overlap.length > 0) {
        throw new Error(`快照 ${where}.${typeName} 的 required 与 optional 重叠：${overlap.join(',')}`);
      }
      out[typeName] = { required, optional };
    }
    return out;
  };
  const types = checkLevel(raw.types, 'types');
  const payloadTypes =
    raw.payloadTypes === null || raw.payloadTypes === undefined
      ? null
      : checkLevel(raw.payloadTypes, 'payloadTypes');
  if (vendor === 'CODEX_ROLLOUT' && payloadTypes === null) {
    throw new Error('CODEX_ROLLOUT 快照缺 payloadTypes');
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    vendor,
    capturedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : '',
    files: num(raw.files),
    records: num(raw.records),
    unparseableLines: num(raw.unparseableLines),
    blankLines: num(raw.blankLines),
    truncatedLines: num(raw.truncatedLines),
    droppedForTypeCap: num(raw.droppedForTypeCap),
    types,
    payloadTypes,
  };
}

export interface JournalSweep {
  /** 按 mtime 取最新的这些文件（绝对路径） */
  readonly files: readonly string[];
  readonly totalMatched: number;
  /** totalMatched − files.length：被 maxFiles 上限跳过的数量 */
  readonly skippedFiles: number;
  /** 超过 maxDepth 的 .jsonl 文件数（例如 claude 会话目录下的 subagents/ 子代理记录） */
  readonly skippedByDepth: number;
  readonly unreadableDirs: number;
  readonly symlinksSkipped: number;
}

/**
 * 有界扫描一个日志根目录：递归收 `.jsonl`（可加名字过滤），按 mtime 降序取前
 * maxFiles 个。symlink 一律跳过（与 listTree 同一取舍），读不动的目录计数不抛。
 *
 * maxDepth（默认无限）：root 直属文件深度为 1。2026-09-05 实测 claude 的项目目录里
 * 166 个 .jsonl 只有 16 个是顶层会话，其余是 `<会话>/subagents/agent-*.jsonl` 与多份
 * 同名 `journal.jsonl` —— 不限深度会让"最新 N 个"被子代理文件挤占，还会撞同名。
 * 深层文件不是被忽略，是被**计数**（skippedByDepth）。
 */
export function discoverJournalFiles(
  root: string,
  opts: {
    readonly maxFiles: number;
    readonly fileNameFilter?: (name: string) => boolean;
    readonly maxDepth?: number;
  },
): JournalSweep {
  const matched: { path: string; mtimeMs: number }[] = [];
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  let unreadableDirs = 0;
  let symlinksSkipped = 0;
  let skippedByDepth = 0;
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs += 1;
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (opts.fileNameFilter && !opts.fileNameFilter(entry.name)) continue;
      if (depth > maxDepth) {
        skippedByDepth += 1;
        continue;
      }
      try {
        matched.push({ path: full, mtimeMs: lstatSync(full).mtimeMs });
      } catch {
        unreadableDirs += 1;
      }
    }
  };
  walk(root, 1);
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const files = matched.slice(0, Math.max(0, opts.maxFiles)).map((m) => m.path);
  return {
    files,
    totalMatched: matched.length,
    skippedFiles: matched.length - files.length,
    skippedByDepth,
    unreadableDirs,
    symlinksSkipped,
  };
}

/** 读一个文件的行；读不动返回 null，由调用方计数（观察者不抛） */
export function readJournalLines(path: string): readonly string[] | null {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
}
