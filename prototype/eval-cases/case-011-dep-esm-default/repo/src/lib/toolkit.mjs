// 纯命名导出 —— 本库没有 default export
export function slugify(text) {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

export function unique(items) {
  return [...new Set(items)];
}
