import { describe, expect, it } from 'vitest';
import { EMPTY_LEDGER, applyLedgerCharge } from './domain';

/**
 * 账本的诚实性。核心是 token 字段的三态：
 *   number    → 计入加和
 *   null      → provider 未回报：计入 unknownUsageTurns，**绝不**折算成 0 进加和
 *   undefined → 此次记账不涉及 token：既不进加和，也不算"未知"
 *
 * 之前的实现是 `manifest.inputTokens ?? 0` —— null 被静默记成 0，
 * "上面的 token 数少算了几轮"这件事本身不可见。
 */
describe('applyLedgerCharge：null 不是 0，undefined 不是 null', () => {
  it('已知用量：数字进加和，unknownUsageTurns 不动', () => {
    const l = applyLedgerCharge(EMPTY_LEDGER, { modelTurns: 1, inputTokens: 120, outputTokens: 30 }, 1000);
    expect(l.modelTurns).toBe(1);
    expect(l.inputTokens).toBe(120);
    expect(l.outputTokens).toBe(30);
    expect(l.unknownUsageTurns).toBe(0);
    expect(l.elapsedMs).toBe(1000);
  });

  it('provider 未回报（null）：不进加和，未知轮次 +1', () => {
    const l = applyLedgerCharge(EMPTY_LEDGER, { modelTurns: 1, inputTokens: null, outputTokens: null }, 1000);
    expect(l.modelTurns).toBe(1);
    expect(l.inputTokens).toBe(0); // 没有把 null 折算成任何数字加进去
    expect(l.outputTokens).toBe(0);
    expect(l.unknownUsageTurns).toBe(1);
  });

  it('单侧 null（只回报了 output）：已知的那侧照常入账，轮次仍算未知', () => {
    const l = applyLedgerCharge(EMPTY_LEDGER, { modelTurns: 1, inputTokens: null, outputTokens: 55 }, 1000);
    expect(l.outputTokens).toBe(55);
    expect(l.inputTokens).toBe(0);
    expect(l.unknownUsageTurns).toBe(1);
  });

  it('不涉及 token 的记账（undefined）：不算未知 —— 工具调用不该污染这个计数', () => {
    const l = applyLedgerCharge(EMPTY_LEDGER, { toolCalls: 1 }, 1000);
    expect(l.toolCalls).toBe(1);
    expect(l.unknownUsageTurns).toBe(0);
  });

  it('累计：未知轮次跨多次记账单调递增', () => {
    let l = applyLedgerCharge(EMPTY_LEDGER, { modelTurns: 1, inputTokens: 10, outputTokens: 5 }, 100);
    l = applyLedgerCharge(l, { modelTurns: 1, inputTokens: null, outputTokens: null }, 200);
    l = applyLedgerCharge(l, { modelTurns: 1, inputTokens: 20, outputTokens: 8 }, 300);
    l = applyLedgerCharge(l, { modelTurns: 1, inputTokens: null, outputTokens: 3 }, 400);
    expect(l.modelTurns).toBe(4);
    expect(l.inputTokens).toBe(30);
    expect(l.outputTokens).toBe(16);
    expect(l.unknownUsageTurns).toBe(2);
    expect(l.elapsedMs).toBe(400);
  });

  it('旧账本没有 unknownUsageTurns 字段：从 0 起算，不是 NaN', () => {
    const legacy = { modelTurns: 3, toolCalls: 7, selfFixRounds: 0, elapsedMs: 50, inputTokens: 100, outputTokens: 40 };
    const l = applyLedgerCharge(legacy, { modelTurns: 1, inputTokens: null, outputTokens: null }, 60);
    expect(l.unknownUsageTurns).toBe(1);
    expect(Number.isNaN(l.inputTokens)).toBe(false);
  });
});
