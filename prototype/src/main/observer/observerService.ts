import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';
import type {
  JournalVendor,
  ObserverProjection,
  ObserverProjectionLine,
  ObserverPushEvent,
  ObserverSessionEntry,
  ObserverStateSnapshot,
  ObserverSweepCounts,
} from '@shared/observerProtocol';
import {
  discoverJournalFiles,
  parseSnapshot,
  readJournalLines,
  recordShapeViolations,
  type JournalShapeSnapshot,
} from './journalShape';
import claudeBaselineRaw from './claude-journal.shape.json';
import codexBaselineRaw from './codex-rollout.shape.json';

/**
 * 观察面板的 Main 侧服务（PRD-WKB-002 的可丢弃 spike 子集，不是合同实现）。
 *
 * 定位按 TD-DEC-022：读点在体验侧（Main），产出全部 volatile、不落任何持久化、
 * 从不经过 Core。信任边界四条（DEC-020）在实现层的着落：
 *   - 显式授权：`enable(projectPath)` 的 projectPath 只能来自 Main 自己的原生
 *     目录选择对话框（observerIpc.ts），Renderer 递不进来 —— 它连方法参数里都没有。
 *   - 只读：本文件只有 lstat/open/read，没有任何写路径。
 *   - 零出站：投影只经 emit 回调（→ Renderer 渲染）；不进模型上下文、遥测、证据。
 *   - 可撤销：`disable()` 同步清掉授权、监视、缓存，并推送空状态。
 *
 * 降级语义（ASM-027）：任一记录违反已提交字段快照基线的必现键 → 整个会话
 * FORMAT_UNKNOWN，正文清空只留计数与违规键名 —— 错读比不读更糟。
 * 授权与监视都只活在内存里：应用重启即消失，重新观察需要重新授权。
 * 这不是偷懒 —— 授权持久化的粒度/保留是 Q-027 未决问题，未决就不落盘。
 */

const MAX_SESSIONS_PER_VENDOR = 30;
/** codex rollout 是全局池，按 session_meta.cwd 过滤前先有界扫描 */
const MAX_CODEX_SCAN_FILES = 400;
/**
 * 读 rollout 首行识别 cwd 的分块与上限。session_meta 恒为首行，但它带着整段
 * base_instructions —— 2026-09-05 实测 20 个最新 rollout 的首行 19–49KB（中位 46KB），
 * 此前 16KB 的一次性探测让 400/400 个文件"首行读不出"。改为按块读到第一个换行为止。
 */
const CODEX_HEAD_CHUNK_BYTES = 65_536;
const CODEX_HEAD_MAX_BYTES = 2_000_000;
/** claude 会话目录只看顶层（深度 1）：subagents/ 子目录里是子代理记录，不是会话 */
const CLAUDE_SESSION_MAX_DEPTH = 1;
/** 单文件读取上限：超出只读尾部并如实报数 */
const MAX_READ_BYTES = 4_000_000;
const MAX_PROJECTION_LINES = 200;
const MAX_LINE_TEXT = 600;
const MAX_BREAKING_REPORTED = 8;
/** mtime 距今小于该值 → 徽标显示「活跃」。启发式，仅导航（PRD-WKB-004） */
const ACTIVE_WINDOW_MS = 20_000;

export class ObserverError extends Error {
  constructor(
    readonly code: 'NOT_GRANTED' | 'UNKNOWN_SESSION' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message);
  }
}

/** Claude Code 的项目目录 munge：每个非字母数字字符 → '-'（实测逐字核对过） */
export function mungeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

interface SessionRecord extends ObserverSessionEntry {
  readonly path: string;
}

interface WatchState {
  readonly sessionId: string;
  lastSize: number;
  lastMtimeMs: number;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 控制字符剥离 + 长度封顶。Renderer 按纯文本渲染，这里是纵深的第二道 */
function sanitizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return clean.length > MAX_LINE_TEXT ? `${clean.slice(0, MAX_LINE_TEXT)}…（截断）` : clean;
}

/** content 数组（两家同构：带 .text 的块）→ 文本 + 非文本块标签 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  const extras = new Map<string, number>();
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
      continue;
    }
    const label = typeof block.type === 'string' ? block.type : 'block';
    extras.set(label, (extras.get(label) ?? 0) + 1);
  }
  const extraNote = [...extras.entries()]
    .map(([label, n]) => `[${label}${n > 1 ? ` ×${n}` : ''}]`)
    .join(' ');
  return [parts.join('\n').trim(), extraNote].filter((s) => s.length > 0).join(' ');
}

/** 一条记录 → 展示行。文本行有正文；标签行只有 `[种类]`，可被折叠。导出给单测钉提取语义 */
export function projectionLineOf(
  vendor: JournalVendor,
  rec: Record<string, unknown>,
): { kind: string; text: string } {
  if (vendor === 'CLAUDE_JOURNAL') {
    const t = typeof rec.type === 'string' ? rec.type : 'UNTYPED';
    if (t === 'user' || t === 'assistant') {
      const message = isPlainRecord(rec.message) ? rec.message : null;
      const text = textFromContent(message?.content);
      return { kind: t, text: sanitizeText(text) };
    }
    return { kind: `[${t}]`, text: '' };
  }
  const p = isPlainRecord(rec.payload) ? rec.payload : null;
  const pt = p && typeof p.type === 'string' ? p.type : null;
  if (p && pt) {
    if (pt === 'agent_message') return { kind: 'assistant', text: sanitizeText(textFromContent(p.content)) };
    if (pt === 'message') {
      const kind = p.role === 'user' ? 'user' : 'message';
      return { kind, text: sanitizeText(textFromContent(p.content)) };
    }
    if (pt === 'user_message') {
      const text = typeof p.message === 'string' ? p.message : textFromContent(p.content);
      return { kind: 'user', text: sanitizeText(text) };
    }
    if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'tool_search_call') {
      const name = typeof p.name === 'string' ? ` ${p.name}` : '';
      return { kind: `[工具${name}]`, text: '' };
    }
    if (pt === 'reasoning') return { kind: '[思考]', text: '' };
    return { kind: `[${pt}]`, text: '' };
  }
  const t = typeof rec.type === 'string' ? rec.type : 'UNTYPED';
  return { kind: `[${t}]`, text: '' };
}

/**
 * 面板**消费键**契约 —— 运行时降级的唯一判据。
 *
 * 2026-09-05 的实测教训：用「基线必现键」当降级判据，三天后 claude 版本没变，
 * 却因为一个罕见 type（bridge-session）上两个面板根本不读的键在新窗口里不再必现，
 * 整个会话被判成「格式未知」。基线的 required 层是对样本的经验归纳，
 * 一条反例分不清是「格式变了」还是「样本太小」—— 它适合做离线对照（probe），
 * 不适合决定面板能不能读。
 *
 * 面板真正依赖的只有这些：`type` 是字符串；claude 的 user/assistant 有对象 `message`
 * 且 `content` 是字符串或数组；codex 的 `payload` 若存在必须是对象，三种正文 type 的
 * `content`/`message` 形状可读。违反其中任一条 = 真的读不了 = FORMAT_UNKNOWN。
 * 其余基线出入只进 driftNotes 作为提示，不阻断展示。
 */
export function consumedContractViolations(
  vendor: JournalVendor,
  rec: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  if (typeof rec.type !== 'string') {
    out.push('consumed:type 不是字符串');
    return out;
  }
  const contentReadable = (c: unknown): boolean =>
    c === undefined || typeof c === 'string' || Array.isArray(c);
  if (vendor === 'CLAUDE_JOURNAL') {
    if (rec.type === 'user' || rec.type === 'assistant') {
      if (!isPlainRecord(rec.message)) out.push(`consumed:${rec.type}.message 不是对象`);
      else if (!contentReadable(rec.message.content)) {
        out.push(`consumed:${rec.type}.message.content 既不是字符串也不是数组`);
      }
    }
    return out;
  }
  if (rec.payload !== undefined && !isPlainRecord(rec.payload)) {
    out.push('consumed:payload 不是对象');
    return out;
  }
  if (isPlainRecord(rec.payload) && typeof rec.payload.type === 'string') {
    const pt = rec.payload.type;
    if (pt === 'agent_message' || pt === 'message') {
      if (!contentReadable(rec.payload.content)) out.push(`consumed:payload.${pt}.content 不可读`);
    } else if (pt === 'user_message') {
      const m = rec.payload.message;
      if (m !== undefined && typeof m !== 'string' && !contentReadable(rec.payload.content)) {
        out.push('consumed:payload.user_message 正文不可读');
      }
    }
  }
  return out;
}

/** 有界读取：超上限只保留尾部，丢掉第一个（可能不完整的）行，字节数如实上报 */
function readTailLines(path: string): { lines: readonly string[]; headBytesSkipped: number } | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.size <= MAX_READ_BYTES) {
    const lines = readJournalLines(path);
    return lines === null ? null : { lines, headBytesSkipped: 0 };
  }
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const read = readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      const text = buf.subarray(0, read).toString('utf8');
      const firstNewline = text.indexOf('\n');
      const usable = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      return {
        lines: usable.split('\n'),
        headBytesSkipped: stat.size - MAX_READ_BYTES + (firstNewline >= 0 ? firstNewline + 1 : usable.length),
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export class ObserverService {
  private readonly claudeProjectsRoot: string;
  private readonly codexSessionsRoot: string;
  private readonly emit: (event: ObserverPushEvent) => void;
  private readonly now: () => number;
  private readonly baselines: Readonly<Record<JournalVendor, JournalShapeSnapshot>>;

  private grantedPath: string | null = null;
  private grantedDisplay: string | null = null;
  private sessions = new Map<string, SessionRecord>();
  private watch_: WatchState | null = null;

  constructor(opts: {
    claudeProjectsRoot: string;
    codexSessionsRoot: string;
    emit: (event: ObserverPushEvent) => void;
    now?: () => number;
  }) {
    this.claudeProjectsRoot = opts.claudeProjectsRoot;
    this.codexSessionsRoot = opts.codexSessionsRoot;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
    // 打包进 bundle 的基线也要过 parseSnapshot 自检 —— 烂基线必须当场炸，不能安静地放行漂移
    this.baselines = {
      CLAUDE_JOURNAL: parseSnapshot(JSON.stringify(claudeBaselineRaw)),
      CODEX_ROLLOUT: parseSnapshot(JSON.stringify(codexBaselineRaw)),
    };
  }

  status(): ObserverStateSnapshot {
    return { granted: this.grantedDisplay, watching: this.watch_?.sessionId ?? null };
  }

  /** projectPath 只能来自 Main 的原生目录选择对话框（见文件头）。重复授权 = 换项目 */
  enable(
    projectPath: string,
    display: string,
  ): { sessions: readonly ObserverSessionEntry[]; counts: ObserverSweepCounts } {
    /*
     * 只接受绝对路径。空串会让 munge 出空目录名 → join 回日志根 → 递归扫到**所有项目**
     * 的会话，"按项目授权"就名存实亡；相对路径则让 codex 的 cwd 精确匹配永远不成立。
     * 对话框不会给出这两种值，但这条边界不能靠"对话框不会"来守。
     */
    if (!isAbsolute(projectPath) || projectPath !== normalize(projectPath)) {
      throw new ObserverError('BAD_REQUEST', `项目路径必须是规范化的绝对路径：${projectPath || '(空)'}`);
    }
    this.disableInternal(false);
    this.grantedPath = projectPath;
    this.grantedDisplay = display;
    const listed = this.refreshSessions();
    this.emit({ kind: 'observer.state', state: this.status() });
    return listed;
  }

  disable(): void {
    this.disableInternal(true);
  }

  private disableInternal(emitState: boolean): void {
    // 撤销即清除：授权、会话映射（含宿主路径）、监视游标一并清空，无残留缓存
    this.grantedPath = null;
    this.grantedDisplay = null;
    this.sessions = new Map();
    this.watch_ = null;
    if (emitState) this.emit({ kind: 'observer.state', state: this.status() });
  }

  listSessions(): { sessions: readonly ObserverSessionEntry[]; counts: ObserverSweepCounts } {
    if (this.grantedPath === null) {
      throw new ObserverError('NOT_GRANTED', '尚未授权观察任何项目');
    }
    return this.refreshSessions();
  }

  watch(sessionId: string): void {
    if (this.grantedPath === null) {
      throw new ObserverError('NOT_GRANTED', '尚未授权观察任何项目');
    }
    if (!this.sessions.has(sessionId)) {
      throw new ObserverError('UNKNOWN_SESSION', `未知会话：${sessionId}（先 listSessions）`);
    }
    this.watch_ = { sessionId, lastSize: -1, lastMtimeMs: -1 };
    this.pollOnce();
  }

  unwatch(): void {
    this.watch_ = null;
  }

  /** 由外层定时器（或测试）驱动。文件没变就不读不推 */
  pollOnce(): void {
    const w = this.watch_;
    if (!w) return;
    const session = this.sessions.get(w.sessionId);
    if (!session) return;
    let stat;
    try {
      stat = lstatSync(session.path);
    } catch {
      return; // 文件消失（归档/迁移）：保留上一份投影，下次 listSessions 会如实少它
    }
    if (stat.size === w.lastSize && stat.mtimeMs === w.lastMtimeMs) return;
    w.lastSize = stat.size;
    w.lastMtimeMs = stat.mtimeMs;
    const projection = this.project(session, stat.mtimeMs);
    if (projection) this.emit({ kind: 'observer.projection', projection });
  }

  private project(session: SessionRecord, mtimeMs: number): ObserverProjection | null {
    const read = readTailLines(session.path);
    if (read === null) return null;

    const baseline = this.baselines[session.vendor];
    const breaking = new Set<string>();
    const driftNotes = new Set<string>();
    let records = 0;
    let unparseable = 0;
    let blank = 0;
    const produced: { kind: string; text: string }[] = [];

    for (const rawLine of read.lines) {
      // 首行可能带 UTF-8 BOM；\r 由 trim 吃掉（CRLF 日志同样可读）
      const line = rawLine.replace(/^\uFEFF/, '').trim();
      if (line === '') {
        blank += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unparseable += 1;
        continue;
      }
      if (!isPlainRecord(parsed)) {
        unparseable += 1;
        continue;
      }
      records += 1;
      // 降级只看消费契约；基线出入只作提示（见 consumedContractViolations 的注释）
      for (const v of consumedContractViolations(session.vendor, parsed)) {
        if (breaking.size < MAX_BREAKING_REPORTED) breaking.add(v);
      }
      for (const v of recordShapeViolations(baseline, parsed)) {
        if (driftNotes.size < MAX_BREAKING_REPORTED) driftNotes.add(v);
      }
      produced.push(projectionLineOf(session.vendor, parsed));
    }

    const formatUnknown = breaking.size > 0;
    // 连续同类标签行折叠（[token_count] ×19 不该占 19 行）；文本行不折叠
    const collapsed: ObserverProjectionLine[] = [];
    if (!formatUnknown) {
      for (const item of produced) {
        const prev = collapsed[collapsed.length - 1];
        const isLabelOnly = item.text === '' && item.kind.startsWith('[');
        if (prev && isLabelOnly && prev.kind === item.kind && prev.text === '') {
          collapsed[collapsed.length - 1] = { ...prev, collapsed: prev.collapsed + 1 };
          continue;
        }
        collapsed.push({ seq: collapsed.length, kind: item.kind, text: item.text, collapsed: 1 });
      }
    }
    const shown = collapsed.slice(-MAX_PROJECTION_LINES).map((l, i) => ({ ...l, seq: i }));

    return {
      sessionId: session.sessionId,
      vendor: session.vendor,
      status: formatUnknown ? 'FORMAT_UNKNOWN' : 'OK',
      breaking: [...breaking].sort(),
      driftNotes: [...driftNotes].sort(),
      lines: shown,
      counts: {
        records,
        shownLines: shown.length,
        omittedLines: collapsed.length - shown.length,
        unparseableLines: unparseable,
        blankLines: blank,
        headBytesSkipped: read.headBytesSkipped,
      },
      fileUpdatedAt: new Date(mtimeMs).toISOString(),
      active: this.now() - mtimeMs < ACTIVE_WINDOW_MS,
    };
  }

  private refreshSessions(): {
    sessions: readonly ObserverSessionEntry[];
    counts: ObserverSweepCounts;
  } {
    const projectPath = this.grantedPath;
    if (projectPath === null) throw new ObserverError('NOT_GRANTED', '尚未授权观察任何项目');

    const next = new Map<string, SessionRecord>();
    /*
     * sessionId = vendor + 相对扫描根的路径。只用 basename 会撞：claude 项目目录下
     * 多个会话各有一份 journal.jsonl，同名即互相覆盖（2026-09-05 实测 30 命中只列出 29）。
     * 相对路径不含宿主绝对路径，仍不泄露位置。
     */
    const entryOf = (vendor: JournalVendor, scanRoot: string, path: string): SessionRecord | null => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return null;
      }
      const base = basename(path);
      const sessionId = `${vendor}:${relative(scanRoot, path)}`;
      return {
        sessionId,
        vendor,
        label: base.replace(/\.jsonl$/, ''),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        sizeBytes: stat.size,
        path,
      };
    };

    // claude：项目专属目录，目录名由路径 munge 而来；只看顶层会话文件
    const claudeDir = join(this.claudeProjectsRoot, mungeClaudeProjectDir(projectPath));
    const claudeSweep = discoverJournalFiles(claudeDir, {
      maxFiles: MAX_SESSIONS_PER_VENDOR,
      maxDepth: CLAUDE_SESSION_MAX_DEPTH,
    });
    for (const f of claudeSweep.files) {
      const e = entryOf('CLAUDE_JOURNAL', claudeDir, f);
      if (e) next.set(e.sessionId, e);
    }

    // codex：全局池按 session_meta.cwd 过滤 —— 首行探测，只读头部有界字节
    const codexSweep = discoverJournalFiles(this.codexSessionsRoot, {
      maxFiles: MAX_CODEX_SCAN_FILES,
      fileNameFilter: (name) => name.startsWith('rollout-'),
    });
    let codexMatched = 0;
    let codexUnreadable = 0;
    for (const f of codexSweep.files) {
      if (codexMatched >= MAX_SESSIONS_PER_VENDOR) break;
      const cwd = readCodexSessionCwd(f);
      if (cwd === null) {
        codexUnreadable += 1;
        continue;
      }
      if (cwd !== projectPath) continue;
      const e = entryOf('CODEX_ROLLOUT', this.codexSessionsRoot, f);
      if (e) {
        next.set(e.sessionId, e);
        codexMatched += 1;
      }
    }

    // 换届后旧 watch 若仍指向存在的会话则保留游标语义（id 不变即同一文件）
    if (this.watch_ && !next.has(this.watch_.sessionId)) this.watch_ = null;
    this.sessions = next;

    const sessions = [...next.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(({ path: _path, ...pub }) => pub);
    return {
      sessions,
      counts: {
        claudeMatched: claudeSweep.files.length,
        claudeSkippedByCap: claudeSweep.skippedFiles,
        claudeNestedSkipped: claudeSweep.skippedByDepth,
        codexScanned: codexSweep.files.length,
        codexMatched,
        codexSkippedByCap: codexSweep.skippedFiles,
        codexUnreadable,
      },
    };
  }
}

/** 读 rollout 首行的 session_meta.payload.cwd；读不出/形状不符/首行超上限返回 null（计数不抛） */
export function readCodexSessionCwd(path: string): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      // 按块读到第一个换行为止：首行常有几十 KB，一次性小缓冲会把 JSON 截成半截
      const chunks: Buffer[] = [];
      let total = 0;
      let newlineAt = -1;
      while (newlineAt < 0 && total < CODEX_HEAD_MAX_BYTES) {
        const buf = Buffer.alloc(CODEX_HEAD_CHUNK_BYTES);
        const read = readSync(fd, buf, 0, CODEX_HEAD_CHUNK_BYTES, total);
        if (read <= 0) break;
        const chunk = buf.subarray(0, read);
        const idx = chunk.indexOf(0x0a);
        if (idx >= 0) newlineAt = total + idx;
        chunks.push(chunk);
        total += read;
      }
      const head = Buffer.concat(chunks, total);
      if (newlineAt < 0 && total >= CODEX_HEAD_MAX_BYTES) return null; // 首行超上限：不猜
      const firstLine = head.subarray(0, newlineAt >= 0 ? newlineAt : total).toString('utf8');
      const parsed: unknown = JSON.parse(firstLine);
      if (!isPlainRecord(parsed) || parsed.type !== 'session_meta') return null;
      const payload = parsed.payload;
      if (!isPlainRecord(payload) || typeof payload.cwd !== 'string') return null;
      return payload.cwd;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
