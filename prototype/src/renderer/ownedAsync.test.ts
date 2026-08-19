import { describe, expect, it } from 'vitest';
import { createLatestRequestGuard } from './ownedAsync';

describe('latest request guard', () => {
  it('同一 owner 连续刷新时只承认较新的 requestId', () => {
    const guard = createLatestRequestGuard<string>();
    const first = guard.begin('run-a');
    const second = guard.begin('run-a');

    expect(second.requestId).toBeGreaterThan(first.requestId);
    expect(guard.isLatest(first)).toBe(false);
    expect(guard.isLatest(second)).toBe(true);
  });

  it('跨 owner 切换后拒绝前一个 owner 的迟到结果', () => {
    const guard = createLatestRequestGuard<string>();
    const projectA = guard.begin('project-a');
    const projectB = guard.begin('project-b');

    expect(guard.latest()).toEqual(projectB);
    expect(guard.isLatest(projectA)).toBe(false);
    expect(guard.isLatest(projectB)).toBe(true);
  });

  it('invalidate 后所有在途身份都失去提交资格', () => {
    const guard = createLatestRequestGuard<string>();
    const request = guard.begin('run-a');

    guard.invalidate();

    expect(guard.latest()).toBeNull();
    expect(guard.isLatest(request)).toBe(false);
  });
});
