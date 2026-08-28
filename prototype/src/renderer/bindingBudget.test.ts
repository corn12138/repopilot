// @vitest-environment jsdom

/**
 * 状态栏只有一格，就该给**绑定约束**。
 *
 * 这个测试的存在理由是一次真实失败（EVI-PLANNING-CAP-001，2026-08-28）：
 * `run_074bde20cdec4d7dab29` 死于规划轮次上限时，状态栏显示的是 token「预算 36%」——
 * 看着很宽裕，而真正掐死它的维度完全不可见。**一个只报最舒服那个数字的仪表，
 * 比没有仪表更误导。** 下面第一条用例直接把那个 Run 的账本抄进来当回归钉。
 */

import { describe, expect, it } from 'vitest';
import type { RunView } from '@shared/domain';
import { bindingBudget } from './App';

function runWith(
  ledger: Partial<RunView['ledger']>,
  limits: Partial<RunView['limits']> = {},
): RunView {
  return {
    runId: 'run-x',
    taskId: 'task-x',
    projectId: 'p1',
    snapshotId: 's1',
    title: 't',
    attemptId: 'a1',
    attemptNo: 1,
    status: 'PLANNING',
    statusReason: null,
    ledger: {
      modelTurns: 0,
      toolCalls: 0,
      selfFixRounds: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsageTurns: 0,
      ...ledger,
    },
    limits: {
      maxModelTurns: 40,
      maxToolCalls: 80,
      maxSelfFixRounds: 2,
      maxWallClockMs: 1_200_000,
      maxTotalTokens: 600_000,
      ...limits,
    },
    workspaceGeneration: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    terminalFacts: null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

describe('bindingBudget：显示真正绑定的那个约束', () => {
  it('真实失败 Run 的账本：四项都不高，但挑出的是比值最大的那个，且 title 报全四项', () => {
    // run_074bde20cdec4d7dab29 终止时的真实数字
    const run = runWith({
      modelTurns: 12,
      toolCalls: 36,
      inputTokens: 218_453,
      outputTokens: 8_638,
      elapsedMs: 171_343,
    });
    const b = bindingBudget(run)!;

    // token 227091/600000 = 37.8%，高于 工具 45%？—— 不，工具 36/80 = 45% 才是最大的
    expect(b.label).toBe('工具');
    expect(b.used).toBe('36');
    expect(b.max).toBe('80');

    // 省略要报数：没被选中的三项必须在 title 里全列出来
    expect(b.detail).toContain('轮次 12/40');
    expect(b.detail).toContain('token 227k/600k');
    expect(b.detail).toContain('时长 171s/1200s');
    expect(b.detail).toContain('任一触顶即停');
  });

  it('轮次最紧时选轮次 —— 而不是永远显示 token', () => {
    const b = bindingBudget(runWith({ modelTurns: 38, toolCalls: 4, inputTokens: 1000 }))!;
    expect(b.label).toBe('轮次');
    expect(b.used).toBe('38');
    expect(b.ratio).toBeCloseTo(38 / 40, 5);
  });

  it('token 最紧时选 token，并按 k 缩写', () => {
    const b = bindingBudget(runWith({ modelTurns: 2, inputTokens: 500_000, outputTokens: 40_000 }))!;
    expect(b.label).toBe('token');
    expect(b.used).toBe('540k');
    expect(b.max).toBe('600k');
  });

  it('上限为 0 的维度被排除，不产生除零', () => {
    const b = bindingBudget(
      runWith({ modelTurns: 1 }, { maxTotalTokens: 0, maxWallClockMs: 0, maxToolCalls: 0 }),
    )!;
    expect(b.label).toBe('轮次');
    expect(b.detail).not.toContain('token');
  });

  it('所有维度都没有上限时返回 null —— 不编造一个百分比', () => {
    expect(
      bindingBudget(
        runWith({}, { maxModelTurns: 0, maxToolCalls: 0, maxTotalTokens: 0, maxWallClockMs: 0 }),
      ),
    ).toBeNull();
  });
});
