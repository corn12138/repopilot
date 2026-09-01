/**
 * 路径 glob 匹配。**全仓唯一一份实现。**
 *
 * 住在 `shared/` 而不是 `core/mutation.ts` 里，是因为消费方跨了进程边界：
 *   - Core：mutation 的 allowedPaths / protectedPaths 门禁、coverage 的验证输入
 *     判定、fs_glob / fs_grep 的路径过滤 —— 这些是**决定放不放行**的判据；
 *   - Renderer：任务输入区对「允许修改的路径」做事前命中数试算。
 *
 * 为什么不在 Renderer 里另写一份：那样界面说"这条 glob 匹配 3 个文件"，
 * 而 Core 用另一套规则判定，两边迟早对不上 —— 到时候用户看到的是
 * "明明提示匹配上了，跑起来却 PATH_NOT_ALLOWED"。规则漂移比没有提示更糟。
 *
 * 语义（与 Core 的门禁逐字一致，改这里等于改门禁，务必同步看 mutation.test.ts）：
 *   - `**` 单独出现匹配一切；
 *   - `**​/` 匹配零或多级目录；
 *   - `*` 只匹配单级内的任意字符（不跨 `/`）；
 *   - 其余字符字面匹配，正则元字符转义。
 *
 * ⚠️ 大小写敏感。`core/workspace.ts` 有一条相关记录：macOS 的 APFS 默认对
 * 大小写不敏感，而这里编出来的正则是敏感的 —— 两者不一致曾构成一条越权路径，
 * 所以受保护路径的判定不能只靠这一个函数。
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if ('.+^${}()|[]\\?'.includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}
