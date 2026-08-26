// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { relativeTime, ResolutionBadge, RestoredBadge, RiskBadge, runStatusText, runStatusTone } from './common';

describe('relativeTime：列表层的"多久之前"', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  it.each([
    ['2026-08-25T11:59:30.000Z', '刚刚'],
    ['2026-08-25T11:45:00.000Z', '15 分钟前'],
    ['2026-08-25T09:00:00.000Z', '3 小时前'],
    ['2026-08-23T12:00:00.000Z', '2 天前'],
    ['2026-08-01T12:00:00.000Z', '08-01'], // 超过 7 天：给日期，不给"3 周前"这种要心算的
  ] as const)('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('未来时间戳（时钟漂移）按"刚刚"处理，不出现负数', () => {
    expect(relativeTime('2026-08-25T12:00:05.000Z', now)).toBe('刚刚');
  });

  it('解析不了的时间返回空串，不渲染 NaN', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('runStatusTone：与 RunStatusBadge 同一映射（一处定义两处消费）', () => {
  it.each([
    ['SUCCEEDED', 'ok'],
    ['ACCEPTED_UNVERIFIED', 'warn'], // 接受但未验证：必须与 SUCCEEDED 视觉区分
    ['FAILED', 'err'],
    ['TIMED_OUT', 'err'],
    ['BLOCKED', 'warn'],
    ['AWAITING_PATCH_REVIEW', 'purple'], // 待人决定
    ['EXECUTING', 'info'],
  ] as const)('%s → %s', (status, tone) => {
    expect(runStatusTone(status as never)).toBe(tone);
  });
});

describe('runStatusText', () => {
  it('未知状态原样返回，不静默替换成别的文案', () => {
    expect(runStatusText('SOME_FUTURE_STATUS' as never)).toBe('SOME_FUTURE_STATUS');
  });
});

describe('RestoredBadge：恢复 Run 的"落后一拍"不再常开黄牌（交互评审 v0.2 N4）', () => {
  afterEach(() => cleanup());

  it('restored + EVENTS_AHEAD → 信息级「已从磁盘恢复」，落后细节进 title', () => {
    render(<RestoredBadge run={{ restored: true, evidence: 'EVENTS_AHEAD' }} />);
    expect(screen.getByText('已从磁盘恢复')).toBeTruthy();
    expect(screen.queryByText('状态落后于事件')).toBeNull();
    expect(screen.getByTitle(/以时间线为准/)).toBeTruthy();
  });

  it('未恢复（可能还活着）的 EVENTS_AHEAD 仍是黄牌 —— 降级只给设计内常态', () => {
    render(<RestoredBadge run={{ restored: false, evidence: 'EVENTS_AHEAD' }} />);
    expect(screen.getByText('状态落后于事件')).toBeTruthy();
  });

  it('证据损坏永远是红牌，恢复与否都不降级', () => {
    render(<RestoredBadge run={{ restored: true, evidence: 'DAMAGED' }} />);
    expect(screen.getByText('证据损坏')).toBeTruthy();
    expect(screen.queryByText('已从磁盘恢复')).toBeNull();
  });
});

describe('徽章词典（交互评审 v0.2 N7）：说人话，raw 进 title', () => {
  afterEach(() => cleanup());

  it('ResolutionBadge：中文词 + raw title；对账中是紫色信号缺失，不是红色失败', () => {
    render(<ResolutionBadge resolution="SUCCEEDED" />);
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.queryByText('SUCCEEDED')).toBeNull();
    expect(screen.getByTitle('SUCCEEDED')).toBeTruthy();
    cleanup();

    render(<ResolutionBadge resolution="UNKNOWN_RECONCILING" />);
    expect(screen.getByText('结果未知 · 对账中')).toBeTruthy();
    expect(screen.getByTitle('UNKNOWN_RECONCILING')).toBeTruthy();
  });

  it('RiskBadge：代号保留，语义进 title', () => {
    render(<RiskBadge risk="R2" />);
    expect(screen.getByText('R2')).toBeTruthy();
    expect(screen.getByTitle(/一次性精确批准/)).toBeTruthy();
  });
});
