// 已迁移的新合同：onSelect 拿到整个 project 对象（不再是 onOpen(id)）
export function makeCard(project, onSelect) {
  return { click: () => onSelect(project) };
}
