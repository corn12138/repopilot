import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunEvent, RunEventKind } from '@shared/domain';
import { nowIso } from '@shared/ids';
import { runDir } from './paths';

/**
 * 追加事件日志。
 *
 * 这是 Run 事实的持久化载体：Renderer 重载、Core 重启后都从这里恢复时间线，
 * 而不是从 UI 内存或模型总结重建（PRD-RUN-001 / PRD-DESK-003）。
 *
 * 原型用 JSONL；overlay 的目标是 SQLite WAL 单 writer。接口保持一致，
 * 换存储时只改这一个文件。
 *
 * 注意这里**没有**采纳 Neovate 的做法：不逐 chunk 同步重写整份日志，
 * 不把配置变更写成整文件 rewrite（见 overlay §7.2 Reject 行）。
 */
/** 日志读取时发现的损坏。null = 完好。 */
export interface EventStoreDamage {
  /** 无法解析的行数。 */
  readonly unparseableLines: number;
  /** 第一条坏行的行号（1 起）。 */
  readonly firstBadLine: number;
}

export class EventStore {
  private readonly file: string;
  private cache: RunEvent[] = [];
  private loaded = false;
  private damage: EventStoreDamage | null = null;
  /** 磁盘上见过的最大 seq —— 包括坏行之后那些仍然读得出来的事件。 */
  private maxSeqSeen = 0;

  constructor(private readonly runId: string) {
    const dir = runDir(runId);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'events.jsonl');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8');
    let unparseable = 0;
    let firstBadLine = 0;
    let lineNo = 0;

    for (const line of raw.split('\n')) {
      lineNo += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: RunEvent;
      try {
        event = JSON.parse(trimmed) as RunEvent;
      } catch {
        /*
         * 以前这里是 `break`，注释写着"尾部损坏只丢弃最后一条"。
         * 崩在写一半时确实只坏最后一行，但**中间**坏一行时 `break` 会把它之后
         * 全部完好的事件一起扔掉，而且一个数都不报 —— 时间线短了一截，
         * 界面上与"这个 Run 本来就只跑到这里"完全无法区分。
         * 现在继续读，把坏行计数留下来，由 authority 投影成 evidence 损坏。
         */
        unparseable += 1;
        if (firstBadLine === 0) firstBadLine = lineNo;
        continue;
      }
      this.cache.push(event);
      if (typeof event.seq === 'number' && event.seq > this.maxSeqSeen) this.maxSeqSeen = event.seq;
    }

    if (unparseable > 0) this.damage = { unparseableLines: unparseable, firstBadLine };
  }

  /** 供 authority 投影成 RunView.evidence；调用前会确保日志已读。 */
  damageReport(): EventStoreDamage | null {
    this.load();
    return this.damage;
  }

  append(
    attemptId: string,
    kind: RunEventKind,
    summary: string,
    payload: Record<string, unknown> = {},
  ): RunEvent {
    this.load();
    /*
     * seq 必须从**磁盘上见过的最大 seq**推，不能用 cache.length。
     * 日志里有坏行时 cache 比实际短，用长度推会把新事件写成一个已经用过的 seq ——
     * 于是 `after(afterSeq)` 的游标语义失效，Renderer 会漏掉或重复一段时间线。
     */
    this.maxSeqSeen += 1;
    const event: RunEvent = {
      seq: this.maxSeqSeen,
      runId: this.runId,
      attemptId,
      kind,
      at: nowIso(),
      summary,
      payload,
    };
    this.cache.push(event);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  /** cursor 语义：返回 seq > afterSeq 的事件 */
  after(afterSeq: number): RunEvent[] {
    this.load();
    return this.cache.filter((e) => e.seq > afterSeq);
  }

  /** 事件流最高水位。状态快照用它判断自己是否落后于事件。 */
  lastSeq(): number {
    this.load();
    return this.cache.length === 0 ? 0 : this.cache[this.cache.length - 1]!.seq;
  }

  all(): RunEvent[] {
    this.load();
    return [...this.cache];
  }
}

/**
 * 小型 JSON 状态文件：write-temp → rename，避免半写状态。
 *
 * 自己保证父目录存在 —— 不依赖"调用前某个别的东西已经建过目录"这种隐式耦合。
 * （这条是被测试抓出来的：writeRunState 原本靠 EventStore 构造函数顺手建目录，
 * 生产路径上碰巧成立，单独调用就 ENOENT。）
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
