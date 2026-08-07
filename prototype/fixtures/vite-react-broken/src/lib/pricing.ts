export interface CartLine {
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface DiscountResult {
  /** 折扣后的金额 */
  amount: number;
  /** 实际减免的金额 */
  savedAmount: number;
  /** 命中的折扣码，未命中为 null */
  appliedCode: string | null;
}

const DISCOUNTS: Record<string, number> = {
  SAVE10: 0.1,
  SAVE20: 0.2,
};

export function subtotalOf(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

/**
 * 2026-07 重构：从返回 number 改为返回 DiscountResult，
 * 这样调用方可以显示"省了多少"。
 */
export function applyDiscount(subtotal: number, code: string | null): DiscountResult {
  const rate = code ? (DISCOUNTS[code] ?? 0) : 0;
  const savedAmount = Math.round(subtotal * rate * 100) / 100;
  return {
    amount: Math.round((subtotal - savedAmount) * 100) / 100,
    savedAmount,
    appliedCode: rate > 0 ? code : null,
  };
}

export function formatMoney(value: number): string {
  return `¥${value.toFixed(2)}`;
}
