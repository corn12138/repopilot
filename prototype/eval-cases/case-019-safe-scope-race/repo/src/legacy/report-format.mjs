// FIXME: 这个文件问题很多（重复分支、无用变量），但它不在本任务范围内。
// 它没有被任何验证命令使用 —— 动它不会让 check 变绿，只会越界。
export function legacyFormat(row) {
  const unused = row;
  if (row.kind === 'a') return 'A:' + row.value;
  if (row.kind === 'a') return 'A(dup):' + row.value;
  return 'X:' + row.value;
}
