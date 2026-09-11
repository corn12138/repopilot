import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 把受管数据根重定向到进程私有的临时目录 —— 与其他 core 测试同一手法。
 *
 * 不这么做的话 EventStore 会写进真实数据根
 * （~/Library/Application Support/RepoPilotPrototype），并行测试互相踩，
 * 而且在用户机器上留垃圾，违反 AGENTS.md「自检和测试不能留下持久化改动」。
 * vi.mock 会被提升到 import 之前，所以 store.ts 里的 runDir 拿到的就是这份。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-store-data-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
  } as const;
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: () => {
      for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
        mkDir(d, { recursive: true });
      }
    },
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import { EventLogUnavailable, EventStore } from './store';
import { PATHS, ensureDataRoot, runDir } from './paths';

/**
 * 事件日志的写入语义。
 *
 * 这个文件此前**不存在** —— EventStore 是 Run 事实的唯一持久化载体
 * （Renderer 重载与 Core 重启都从这里恢复时间线），却从来没有自己的测试，
 * 只有 persistence.test.ts 从外面间接碰到它。
 *
 * 守的是三件事：
 *   1. **先落盘，再推进内存。** 顺序反了会在写失败时留下幻影事件：cache 与水位都前进了，
 *      磁盘上没有这条 —— 于是 persist() 把幻影 seq 写进 eventHighWatermark，
 *      重载后日志比快照短，一致性检查反而判"完好"。
 *   2. **写失败之后不再写。** 半截行已经在文件里了，继续 append 会接在它后面，
 *      把一条坏行变成两条；重试同一个 seq 更糟，游标语义直接失效。
 *   3. **水位是"见过的最高 seq"，不是"文件末行"。** 日志里有坏行或乱序时两者会分叉。
 *
 * 故障注入用**真实 syscall**（chmod 0o444 让 appendFileSync 撞 EACCES），不 mock fs ——
 * 要测的就是"真的写不进去时怎么办"，mock 出来的失败证明不了 syscall 层的行为。
 */

/**
 * 只读位是否真的能挡住写入。
 *
 * 以 root 运行时 chmod 0o444 **不会**让写入失败，那时这些用例必须显式跳过 ——
 * 让它们"绿"过去等于什么都没验，正是 AGENTS.md 说的「缺隔离时写入型用例直接 BLOCKED」。
 */
const readOnlyEffective: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-store-probe-'));
  const probe = join(dir, 'probe.txt');
  try {
    writeFileSync(probe, 'x', 'utf8');
    chmodSync(probe, 0o444);
    try {
      appendFileSync(probe, 'y', 'utf8');
      return false; // 写进去了 = 只读位无效（root）
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(probe, 0o644);
    } catch {
      /* 探测本身失败就不必还原 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
})();

let runId: string;
let journal: string;

beforeEach(() => {
  ensureDataRoot();
  runId = `run_store_${Math.random().toString(36).slice(2, 10)}`;
  mkdirSync(runDir(runId), { recursive: true });
  journal = join(runDir(runId), 'events.jsonl');
});

afterAll(() => {
  // 只删自己 mock 出来的临时根；万一 mock 没生效，这里就不会误删真实数据根
  if (PATHS.root.startsWith(tmpdir()) || PATHS.root.startsWith('/private')) {
    rmSync(PATHS.root, { recursive: true, force: true });
  }
});

/** 把日志文件改成只读，制造真实的 EACCES。调用方负责在 finally 里还原。 */
function makeJournalReadOnly(): void {
  chmodSync(journal, 0o444);
}

function restoreJournal(): void {
  try {
    chmodSync(journal, 0o644);
  } catch {
    /* 文件可能根本没被创建出来 */
  }
}

function readJournalLines(): string[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

describe('EventStore: 正常写入', () => {
  it('append 之后 cache、水位、文件三者一致', () => {
    const store = new EventStore(runId);

    const first = store.append('att_1', 'NOTE', '第一条');
    const second = store.append('att_1', 'NOTE', '第二条');

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(store.all().map((e) => e.summary)).toEqual(['第一条', '第二条']);
    expect(store.lastSeq()).toBe(2);
    expect(readJournalLines()).toHaveLength(2);
    // 游标语义：after(1) 只返回 seq > 1 的
    expect(store.after(1).map((e) => e.seq)).toEqual([2]);
  });

  it('跨实例读回：第二个 EventStore 接着上一个的 seq 往下写', () => {
    const a = new EventStore(runId);
    a.append('att_1', 'NOTE', '一');
    a.append('att_1', 'NOTE', '二');

    const b = new EventStore(runId);
    expect(b.lastSeq()).toBe(2);
    expect(b.append('att_1', 'NOTE', '三').seq).toBe(3);
    expect(readJournalLines()).toHaveLength(3);
  });
});

describe('EventStore: 写盘失败时不得留下幻影事件', () => {
  it.skipIf(!readOnlyEffective)('写失败：cache 与水位都不前进，且本实例进入故障锁定态', () => {
    const store = new EventStore(runId);
    store.append('att_1', 'NOTE', '落盘成功的第一条');
    expect(store.lastSeq()).toBe(1);

    makeJournalReadOnly();
    try {
      expect(() => store.append('att_1', 'NOTE', '这条写不进去')).toThrow();

      // 内存里不得出现这条 —— 它从未落盘，记下来就是幻影
      expect(store.all().map((e) => e.summary)).toEqual(['落盘成功的第一条']);
      expect(store.lastSeq()).toBe(1);
      expect(readJournalLines()).toHaveLength(1);

      /*
       * 故障锁定：此后一律拒绝，**即使文件系统已经恢复可写**。
       *
       * 为什么不重试：EACCES 这类失败 open 就没成功、一个字节都没写，重试是干净的；
       * 但 ENOSPC 下 open 可能已成功、部分字节已落盘，重试会接在撕裂行后面，
       * 把一条坏行变成两条 —— 而 maxSeqSeen 没推进，意味着重试用的是**同一个 seq**。
       * 按 errno 区分这两者太脆弱（各家文件系统与中间层行为不一致），
       * 所以一律锁定本实例：Run 停下、原因如实报给用户、重启后 rehydrate 读盘上真实的内容。
       */
      restoreJournal();
      expect(() => store.append('att_1', 'NOTE', '恢复后也不写')).toThrow();
      expect(readJournalLines()).toHaveLength(1);
      expect(store.all()).toHaveLength(1);
      expect(store.lastSeq()).toBe(1);
    } finally {
      restoreJournal();
    }
  });

  it.skipIf(!readOnlyEffective)('写失败时磁盘上不留半截 JSON', () => {
    const store = new EventStore(runId);
    store.append('att_1', 'NOTE', 'ok');

    makeJournalReadOnly();
    try {
      expect(() => store.append('att_1', 'NOTE', '写不进去')).toThrow();
    } finally {
      restoreJournal();
    }

    // 每一行都必须能解析 —— 撕裂的尾行会让下次 load 报损坏，
    // 而那个损坏是平台自己造成的，不是用户的日志坏了
    for (const [i, line] of readJournalLines().entries()) {
      expect(() => JSON.parse(line), `第 ${i + 1} 行不可解析`).not.toThrow();
    }
  });
});

describe('EventStore: 故障锁定态必须可被上层查询', () => {
  it.skipIf(!readOnlyEffective)('writeFailure 在失败前是 null、失败后带原因；拒绝次数如实报数', () => {
    const store = new EventStore(runId);
    expect(store.writeFailure()).toBeNull();
    expect(store.refusedAppendCount()).toBe(0);

    store.append('att_1', 'NOTE', 'ok');
    expect(store.writeFailure()).toBeNull();

    makeJournalReadOnly();
    try {
      // 第一次失败：把 store 推进锁定态
      expect(() => store.append('att_1', 'NOTE', '写不进去')).toThrow(EventLogUnavailable);

      const failure = store.writeFailure();
      expect(failure).not.toBeNull();
      expect(failure!.reason.length).toBeGreaterThan(0);
      expect(typeof failure!.at).toBe('string');
      // 第一次是"写入失败"，不计入"被拒绝"
      expect(store.refusedAppendCount()).toBe(0);

      // 之后每一次都被拒绝，且**每一次都要计数** —— 省略要报数（不变式 8）：
      // 上层收尾时要能说出"日志死了之后还有 N 条事件没记下来"，而不是静默丢弃
      expect(() => store.append('att_1', 'NOTE', '第二条')).toThrow(EventLogUnavailable);
      expect(() => store.append('att_1', 'NOTE', '第三条')).toThrow(EventLogUnavailable);
      expect(store.refusedAppendCount()).toBe(2);
      expect(store.writeFailure()).toBe(failure); // 故障态不被后续拒绝覆盖
    } finally {
      restoreJournal();
    }
  });

  it.skipIf(!readOnlyEffective)('抛的是 EventLogUnavailable，不是裸 Error', () => {
    /*
     * 类型必须可识别：authority 的收尾要据此**跳过状态快照落盘、直接定终态**，
     * 而其他运行时异常仍走抢救封存。两者混在一起，要么该停的没停
     * （快照水位超前于日志 → 重启后判 INTACT），要么不该停的也停了
     * （丢掉本可以挽救的现场）。
     */
    const store = new EventStore(runId);
    store.append('att_1', 'NOTE', 'ok');

    makeJournalReadOnly();
    try {
      const err = (() => {
        try {
          store.append('att_1', 'NOTE', '写不进去');
          return null;
        } catch (e) {
          return e as unknown;
        }
      })();
      expect(err).toBeInstanceOf(EventLogUnavailable);
      expect((err as EventLogUnavailable).reason.length).toBeGreaterThan(0);
      // 原因里不得带宿主绝对路径之外的东西；至少要能让人看懂是哪一类失败
      expect((err as Error).message).toContain('事件日志不可写');
    } finally {
      restoreJournal();
    }
  });
});

describe('EventStore: 水位是"见过的最高 seq"，不是"文件末行"', () => {
  it('日志乱序时 lastSeq 返回最高 seq', () => {
    /*
     * 这条钉的是 lastSeq() 与它自己的文档矛盾：注释写「事件流最高水位」，
     * 实现返回的却是 cache 末元素的 seq（= 文件末行）。日志完好时两者相等，
     * 一旦出现乱序（坏行被跳过、外部工具改写过、或上面那个幻影 seq 被烧掉）
     * 就会分叉 —— 而 persist() 正是拿 lastSeq() 当 eventHighWatermark 写进快照的。
     */
    const ev = (seq: number, summary: string) =>
      JSON.stringify({
        seq,
        runId,
        attemptId: 'att_1',
        kind: 'NOTE',
        at: '2026-09-11T00:00:00.000Z',
        summary,
        payload: {},
      });
    // 末行是 seq 3，但日志里出现过 seq 7
    writeFileSync(journal, `${ev(7, '高水位')}\n${ev(3, '末行')}\n`, 'utf8');

    const store = new EventStore(runId);
    expect(store.all()).toHaveLength(2);
    expect(store.lastSeq()).toBe(7);
    // 新事件必须从最高水位往后排，绝不能复用已经出现过的 seq
    expect(store.append('att_1', 'NOTE', '新的一条').seq).toBe(8);
  });

  it('坏行照旧计数并报出首条坏行行号，且不影响水位', () => {
    const ev = (seq: number) =>
      JSON.stringify({
        seq,
        runId,
        attemptId: 'att_1',
        kind: 'NOTE',
        at: '2026-09-11T00:00:00.000Z',
        summary: `s${seq}`,
        payload: {},
      });
    writeFileSync(journal, `${ev(1)}\n{这不是 JSON\n${ev(2)}\n`, 'utf8');

    const store = new EventStore(runId);
    // 既有行为：中部坏行不截断后续，但要报数（不变式 8）
    expect(store.damageReport()).toEqual({ unparseableLines: 1, firstBadLine: 2 });
    expect(store.all().map((e) => e.seq)).toEqual([1, 2]);
    expect(store.lastSeq()).toBe(2);
    expect(store.append('att_1', 'NOTE', 'new').seq).toBe(3);
  });

  it('日志完好时 damageReport 返回 null', () => {
    const store = new EventStore(runId);
    store.append('att_1', 'NOTE', 'ok');
    expect(new EventStore(runId).damageReport()).toBeNull();
  });
});
