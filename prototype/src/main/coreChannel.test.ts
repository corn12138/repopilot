import { describe, expect, it, vi } from 'vitest';
import { CoreRequestBroker, type CoreRequestMessage } from './coreChannel';

/**
 * 在途请求账本的四条结局路径。
 *
 * 用假定时器而不是真等 —— 这里要断言的是「超时会不会发生、发生后会不会被迟到响应改写」，
 * 不是「120 秒到底有多长」。
 */
function harness(options: { post?: (message: CoreRequestMessage) => void } = {}) {
  const sent: CoreRequestMessage[] = [];
  const timers = new Map<number, { handler: () => void; ms: number }>();
  let nextTimer = 0;

  const broker = new CoreRequestBroker({
    post:
      options.post ??
      ((message) => {
        sent.push(message);
      }),
    setTimer: (handler, ms) => {
      nextTimer += 1;
      timers.set(nextTimer, { handler, ms });
      return nextTimer;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    broker,
    sent,
    get liveTimers() {
      return timers.size;
    },
    /** 触发全部到期定时器，模拟时间推进。 */
    fireTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.handler();
      }
    },
    timerDelays() {
      return [...timers.values()].map((t) => t.ms);
    },
  };
}

describe('CoreRequestBroker', () => {
  it('正常响应结算请求并清掉定时器', async () => {
    const h = harness();
    const promise = h.broker.request('run.list', {}, 10_000);
    expect(h.sent).toHaveLength(1);
    expect(h.broker.inFlight).toBe(1);

    h.broker.settle(h.sent[0]!.requestId, { ok: true, data: { runs: [] } });

    await expect(promise).resolves.toEqual({ ok: true, data: { runs: [] } });
    expect(h.broker.inFlight).toBe(0);
    // 定时器必须被回收，否则长会话里会攒下成千上万个待触发回调。
    expect(h.liveTimers).toBe(0);
  });

  it('Core 活着但不回应时，请求以明确超时结束而不是永远 pending', async () => {
    const h = harness();
    const promise = h.broker.request('files.tree', { snapshotId: 's' }, 120_000);
    expect(h.timerDelays()).toEqual([120_000]);

    h.fireTimers();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CORE_UNAVAILABLE');
      expect(result.error.message).toContain('请求超时：files.tree');
      expect(result.error.detail).toContain('120000ms');
    }
    expect(h.broker.inFlight).toBe(0);
  });

  it('超时之后迟到的响应被丢弃，不能把 TIMEOUT 改写成成功', async () => {
    const h = harness();
    const promise = h.broker.request('project.import', { projectId: 'p' }, 5_000);
    const requestId = h.sent[0]!.requestId;

    h.fireTimers();
    const result = await promise;
    expect(result.ok).toBe(false);

    // Core 终于回来了 —— 账本里已经没有这一条，必须原样丢弃。
    expect(h.broker.settle(requestId, { ok: true, data: { outcome: 'IMPORTED' } })).toBe(false);
    await expect(promise).resolves.toEqual(result);
  });

  it('Core 退出时所有在途请求立刻收到明确失败', async () => {
    const h = harness();
    const a = h.broker.request('run.get', { runId: 'a' }, 10_000);
    const b = h.broker.request('run.get', { runId: 'b' }, 10_000);
    expect(h.broker.inFlight).toBe(2);

    expect(h.broker.failAll('exit code 1')).toBe(2);

    for (const promise of [a, b]) {
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CORE_UNAVAILABLE');
        expect(result.error.message).toBe('Agent Core 已退出');
        expect(result.error.detail).toBe('exit code 1');
      }
    }
    expect(h.broker.inFlight).toBe(0);
    expect(h.liveTimers).toBe(0);
  });

  it('投递本身抛错也会变成明确失败，而不是一个悬空 Promise', async () => {
    const h = harness({
      post: () => {
        throw new Error('channel closed');
      },
    });
    const result = await h.broker.request('doctor.run', {}, 10_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CORE_UNAVAILABLE');
      expect(result.error.detail).toBe('channel closed');
    }
    expect(h.broker.inFlight).toBe(0);
    expect(h.liveTimers).toBe(0);
  });

  it('未知 requestId 的响应被安全丢弃', () => {
    const h = harness();
    expect(h.broker.settle('req_does_not_exist', { ok: true, data: null })).toBe(false);
  });

  it('每个请求用独立的超时上限，慢方法不会被快方法的上限误杀', () => {
    const h = harness();
    void h.broker.request('run.list', {}, 10_000);
    void h.broker.request('task.create', {}, 120_000);
    expect(h.timerDelays().sort((a, b) => a - b)).toEqual([10_000, 120_000]);
    expect(h.broker.inFlightMethods.sort()).toEqual(['run.list', 'task.create']);
  });

  it('超时诊断里带上同期在途请求数，用于区分单点卡死与整体失联', async () => {
    const h = harness();
    const slow = h.broker.request('files.tree', {}, 1_000);
    void h.broker.request('run.list', {}, 999_000);

    // 只触发第一个到期的：手动结算掉长的那个不现实，这里直接触发全部并读第一个的结果。
    const timers = h.timerDelays();
    expect(timers).toContain(1_000);
    h.fireTimers();

    const result = await slow;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/另有 \d+ 个请求在途/);
  });

  it('默认使用真实定时器，并且不阻止进程退出', () => {
    const post = vi.fn();
    const broker = new CoreRequestBroker({ post });
    void broker.request('run.list', {}, 60_000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(broker.inFlight).toBe(1);
    // unref 过的定时器不会让 vitest 进程挂住；显式收尾以免污染其他用例。
    broker.failAll('test cleanup');
    expect(broker.inFlight).toBe(0);
  });
});
