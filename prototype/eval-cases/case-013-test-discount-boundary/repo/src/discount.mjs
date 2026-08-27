// 规则（冻结）：满 100 九折，含 100 本身；负数金额非法
export function finalPrice(total) {
  if (total < 0) throw new Error('金额不能为负');
  if (total > 100) return total * 0.9;
  return total;
}
