import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
export class EventStore {
  private readonly file: string;
  private cache: RunEvent[] = [];
  private loaded = false;

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
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.cache.push(JSON.parse(trimmed) as RunEvent);
      } catch {
        // 尾部损坏只丢弃最后一条，不破坏已有 lineage
        break;
      }
    }
  }

  append(
    attemptId: string,
    kind: RunEventKind,
    summary: string,
    payload: Record<string, unknown> = {},
  ): RunEvent {
    this.load();
    const event: RunEvent = {
      seq: this.cache.length + 1,
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

  all(): RunEvent[] {
    this.load();
    return [...this.cache];
  }
}

/** 小型 JSON 状态文件：write-temp → rename，避免半写状态 */
export function writeJsonAtomic(path: string, value: unknown): void {
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
