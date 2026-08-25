// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { relativeTime, runStatusText, runStatusTone } from './common';

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
