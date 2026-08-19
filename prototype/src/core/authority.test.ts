import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PausableDeadline, checkPatchApplyOwnership } from './authority';

/**
 * PausableDeadline 是 A6 的核心机制：等待人工审批的时间不该算进 Run 的计算预算。
 *
 * 这些用例用假定时器精确验证 pause/resume 的时间账 —— 因为真实场景里
 * 「用户审了 25 分钟」和「模型跑了 25 分钟」必须被区别对待。
 */
describe('PausableDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('从不暂停：到点触发一次', () => {
    const fire = vi.fn();
    new PausableDeadline(1000, fire);
    vi.advanceTimersByTime(999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('暂停期间无论过多久都不触发；恢复后按剩余时间继续', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);

    vi.advanceTimersByTime(400); // 已消耗 400，剩 600
    d.pause();
    vi.advanceTimersByTime(10 * 60 * 1000); // 暂停期间过了 10 分钟 —— 不该触发
    expect(fire).not.toHaveBeenCalled();

    d.resume();
    vi.advanceTimersByTime(599);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 补满剩余的 600
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('有效计算时间等于 totalMs，与暂停时长无关', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);

    // 三段计算 + 两段（很长的）审批等待
    vi.advanceTimersByTime(300);
    d.pause();
    vi.advanceTimersByTime(99999);
    d.resume();
    vi.advanceTimersByTime(300);
    d.pause();
    vi.advanceTimersByTime(88888);
    d.resume();
    vi.advanceTimersByTime(399);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 300+300+400 = 1000
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('clear() 之后永不触发', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);
    vi.advanceTimersByTime(500);
    d.clear();
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it('resume() 在 clear() 之后是 no-op（不会把已停的 deadline 复活）', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);
    d.clear();
    d.resume();
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it('触发后 pause/resume 均为 no-op，且只触发一次', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);

    d.pause();
    d.resume();
    vi.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('elapsedMs() 只计运行时间：暂停区间不计入，与 TIMED_OUT 判定同一口径', () => {
    const d = new PausableDeadline(20 * 60 * 1000, vi.fn());
    vi.advanceTimersByTime(2 * 60 * 1000); // 规划跑了 2 分钟
    expect(d.elapsedMs()).toBe(2 * 60 * 1000);

    d.pause(); // 进入审批等待
    vi.advanceTimersByTime(23 * 60 * 1000); // 用户审了 23 分钟 —— 比整个墙钟预算还长
    expect(d.elapsedMs()).toBe(2 * 60 * 1000); // 一毫秒都不该算进去

    d.resume();
    vi.advanceTimersByTime(60 * 1000);
    expect(d.elapsedMs()).toBe(3 * 60 * 1000); // 2 + 1，不是 26

    d.clear();
    vi.advanceTimersByTime(99_999);
    expect(d.elapsedMs()).toBe(3 * 60 * 1000); // clear 之后不再增长
  });

  it('elapsedMs() 在触发那一刻等于 totalMs（不多算也不少算）', () => {
    const d = new PausableDeadline(1000, vi.fn());
    vi.advanceTimersByTime(300);
    d.pause();
    vi.advanceTimersByTime(50_000);
    d.resume();
    vi.advanceTimersByTime(700);
    expect(d.elapsedMs()).toBe(1000);
    vi.advanceTimersByTime(5000);
    expect(d.elapsedMs()).toBe(1000);
  });

  it('重复 pause 不叠加扣时（第二次 pause 是 no-op）', () => {
    const fire = vi.fn();
    const d = new PausableDeadline(1000, fire);
    vi.advanceTimersByTime(200);
    d.pause();
    d.pause(); // 已暂停，再 pause 不应再扣任何时间
    vi.advanceTimersByTime(5000);
    d.resume();
    vi.advanceTimersByTime(799);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 剩余仍是 800
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

type ApplyOwnershipInput = Parameters<typeof checkPatchApplyOwnership>[0];

function coherentApplyOwnership(): ApplyOwnershipInput {
  return {
    requestedRunId: 'run_a',
    projectId: 'proj_a',
    view: {
      runId: 'run_a',
      taskId: 'task_a',
      projectId: 'proj_a',
      attemptId: 'att_a',
      workspaceGeneration: 2,
    },
    task: {
      taskId: 'task_a',
      projectId: 'proj_a',
      snapshotId: 'snap_a',
      profileId: 'prof_a',
    },
    snapshot: { snapshotId: 'snap_a', projectId: 'proj_a', baseSha: 'base_a' },
    profile: { profileId: 'prof_a', snapshotId: 'snap_a' },
    patch: { runId: 'run_a', attemptId: 'att_a', baseSha: 'base_a', generation: 2 },
  };
}

describe('checkPatchApplyOwnership', () => {
  it('完整实体链一致时允许继续走 acceptance / digest / git apply 门禁', () => {
    expect(checkPatchApplyOwnership(coherentApplyOwnership())).toEqual({ ok: true });
  });

  it.each([
    {
      name: '宿主 project 与 task 不一致',
      mutate: (i: ApplyOwnershipInput) => ({ ...i, projectId: 'proj_b' }),
    },
    {
      name: 'snapshot 与 task 的 project 不一致',
      mutate: (i: ApplyOwnershipInput) => ({
        ...i,
        snapshot: { ...i.snapshot, projectId: 'proj_b' },
      }),
    },
    {
      name: 'profile 与 snapshot 不一致',
      mutate: (i: ApplyOwnershipInput) => ({
        ...i,
        profile: { ...i.profile, snapshotId: 'snap_b' },
      }),
    },
    {
      name: 'patch 与 run 不一致',
      mutate: (i: ApplyOwnershipInput) => ({
        ...i,
        patch: { ...i.patch, runId: 'run_b' },
      }),
    },
    {
      name: 'patch base 与 snapshot base 不一致',
      mutate: (i: ApplyOwnershipInput) => ({
        ...i,
        patch: { ...i.patch, baseSha: 'base_b' },
      }),
    },
    {
      name: 'patch generation 与 run 不一致',
      mutate: (i: ApplyOwnershipInput) => ({
        ...i,
        patch: { ...i.patch, generation: 1 },
      }),
    },
  ])('$name → 在宿主写入前拒绝', ({ mutate }) => {
    /*
     * 这些组合都可能来自损坏的持久化证据或错误拼接的内存记录；即使 diff 内容
     * 恰好能通过 git apply --check，也不能把“能应用”误当成“属于这个项目”。
     */
    expect(checkPatchApplyOwnership(mutate(coherentApplyOwnership()))).toMatchObject({
      ok: false,
      reason: 'OWNERSHIP_MISMATCH',
    });
  });
});
