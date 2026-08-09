import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PausableDeadline } from './authority';

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
