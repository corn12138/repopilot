// 更新是排队后统一 flush 的（模拟批量状态更新）；updater 以当前值为入参
export function createCounter(limit = 5) {
  const state = { value: 0 };
  const queue = [];
  return {
    increment() {
      const snapshot = state.value;
      queue.push(() => Math.min(limit, snapshot + 1));
    },
    reset() {
      queue.push(() => 0);
    },
    flush() {
      for (const updater of queue.splice(0)) state.value = updater(state.value);
    },
    value: () => state.value,
  };
}
