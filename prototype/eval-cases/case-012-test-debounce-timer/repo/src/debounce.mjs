// clock 由调用方注入（{setTimeout, clearTimeout}），便于确定性验证
export function debounce(fn, ms, clock) {
  let timer = null;
  const wrapped = (...args) => {
    timer = clock.setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {};
  return wrapped;
}
