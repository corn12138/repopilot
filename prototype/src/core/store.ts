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

/** 日志**写入**失败的故障态。一旦进入，本实例拒绝继续 append。 */
export interface EventStoreWriteFailure {
  readonly reason: string;
  readonly at: string;
}

/**
 * 事件日志已不可写。
 *
 * 必须是可识别的独立类型，不能就用裸 Error：authority 的收尾要据此**跳过状态快照落盘、
 * 直接定终态**。两个理由 ——
 *   - 日志写不成时再写 state.json，快照水位会超前于日志，重启后那个只看单向的
 *     一致性检查会把"丢了事件"判成 `INTACT`；
 *   - 抢救封存路径自己也会 emit，锁定时它会二次抛出并逃出 `void` 调用的 execute，
 *     变成 unhandled rejection，Run 既拿不到终态也跑不到清理。
 *
 * 其他运行时异常仍走既有的抢救封存路径，两者不能混。
 */
export class EventLogUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`事件日志不可写：${reason}`);
    this.name = 'EventLogUnavailable';
  }
}

export class EventStore {
  private readonly file: string;
  private cache: RunEvent[] = [];
  private loaded = false;
  private damage: EventStoreDamage | null = null;
  /** 磁盘上见过的最大 seq —— 包括坏行之后那些仍然读得出来的事件。 */
  private maxSeqSeen = 0;
  /** 写盘失败后进入故障锁定态；非 null 时本实例拒绝继续 append。 */
  private failure: EventStoreWriteFailure | null = null;
  /** 锁定之后被拒绝的 append 次数 —— 省略要报数（不变式 8）。 */
  private refusedAppends = 0;

  constructor(private readonly runId: string) {
    const dir = runDir(runId);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'events.jsonl');
  }

  /**
   * 日志是否已进入故障锁定态。null = 仍然可写。
   *
   * authority 的收尾用它做判据（而不是靠捕获异常类型）：异常可能在很深的地方被
   * 折叠成别的错误，但"这个 Run 的事件日志已经写不下去了"是一个**持续为真的状态**，
   * 任何时刻都能查。
   */
  writeFailure(): EventStoreWriteFailure | null {
    return this.failure;
  }

  /** 锁定后被拒绝的 append 次数。配合 writeFailure 一起报给用户：丢了几个要说几个。 */
  refusedAppendCount(): number {
    return this.refusedAppends;
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
    if (this.failure) {
      this.refusedAppends += 1;
      throw new EventLogUnavailable(this.failure.reason);
    }
    /*
     * seq 必须从**磁盘上见过的最大 seq**推，不能用 cache.length。
     * 日志里有坏行时 cache 比实际短，用长度推会把新事件写成一个已经用过的 seq ——
     * 于是 `after(afterSeq)` 的游标语义失效，Renderer 会漏掉或重复一段时间线。
     */
    const seq = this.maxSeqSeen + 1;
    const event: RunEvent = {
      seq,
      runId: this.runId,
      attemptId,
      kind,
      at: nowIso(),
      summary,
      payload,
    };
    /*
     * **先落盘，成功了才推进内存。**
     *
     * 顺序反了（此前就是反的）会在写失败时留下幻影事件：cache 与 maxSeqSeen 都已前进，
     * 磁盘上却没有这一条。后果是复合的 ——
     *   1. `after(afterSeq)` 的游标会把这条幻影交给 Renderer，而它重启后就不存在了；
     *   2. authority.persist() 用 lastSeq() 当 eventHighWatermark 写进 state.json，
     *      于是快照水位**超前**于日志；重启后 rehydrate 只检查"事件是否比状态新"
     *      这一个方向（见 rehydrateRuns），日志更短反而判 `INTACT` ——
     *      把"丢了事件"说成"证据完好"；
     *   3. 抢救封存路径自己也会 emit，锁定时它抛 EventLogUnavailable、被自己的 catch
     *      接住、catch 里再 emit 又抛一次，异常就此逃出 execute 的 catch-all ——
     *      而 execute 是 `void` 调用的，那会变成 unhandled rejection，
     *      Run 既拿不到终态也跑不到清理。
     *
     * 注意这**不是**不变式 3（失败时零写入）的问题：sealPatch 对工作区是只读的
     * （changedVsBaseline + `git diff --no-index`），失败路径从来没有写过用户的副本。
     * 真正被破坏的是证据完整性与收口的可达性。
     *
     * 失败后本实例进入锁定态，不再接受 append：maxSeqSeen 没推进意味着重试会用
     * **同一个 seq**，而 ENOSPC 这类失败可能已经落了半截字节，重试就接在撕裂行后面。
     * 按 errno 区分"一个字节都没写"和"写了半截"太脆弱，一律锁定更诚实。
     */
    try {
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      this.failure = { reason: (err as Error).message, at: nowIso() };
      throw new EventLogUnavailable(this.failure.reason);
    }
    this.maxSeqSeen = seq;
    this.cache.push(event);
    return event;
  }

  /** cursor 语义：返回 seq > afterSeq 的事件 */
  after(afterSeq: number): RunEvent[] {
    this.load();
    return this.cache.filter((e) => e.seq > afterSeq);
  }

  /**
   * 事件流最高水位。状态快照用它判断自己是否落后于事件。
   *
   * 返回 `maxSeqSeen` 而不是 cache 末元素的 seq —— 后者是"文件末行"，日志一旦乱序
   * （坏行被跳过、外部工具改写过、或上面那个幻影 seq）两者就会分叉，而快照水位
   * 必须是**真正见过的最高 seq**，否则新事件会复用一个已经用过的号。
   */
  lastSeq(): number {
    this.load();
    return this.maxSeqSeen;
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
