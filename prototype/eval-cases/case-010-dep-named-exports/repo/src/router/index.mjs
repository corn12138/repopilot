// v6 风格 API：Routes(defs) 返回解析器；Navigate(to) 表达跳转。
// 旧版的 Switch / Redirect 已在本版本移除。
export function Routes(defs) {
  return {
    resolve(path) {
      for (const d of defs) {
        if (d.path === path) return d.view;
      }
      const fallback = defs.find((d) => d.path === '*');
      return fallback ? fallback.view : null;
    },
  };
}

export function Navigate(to) {
  return 'navigate:' + to;
}
