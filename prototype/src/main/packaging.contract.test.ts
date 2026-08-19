import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 打包合同：Core 的运行时依赖必须全部在 asar 之外。
 *
 * 这条测试的由来：Main 与 Core 开始共享受管数据根的解析后，rollup 把它提成了
 * `out/main/chunks/*.js`。当时 `asarUnpack` 只写了 `out/main/core.js` ——
 * 于是 core.js 被解包、它 import 的 chunk 还在 asar 里。开发模式、`pnpm build`、
 * 全部单测都不会失败，只有**打包后启动 Core 的那一刻**才炸。
 *
 * 边界：这里断言的是配置与构建产物的一致性，不是"安装包真的能跑"。
 * 后者需要真正出包并在干净机器上启动，属于发行阶段的证据，本仓库尚未具备。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const builderConfig = readFileSync(join(projectRoot, 'electron-builder.yml'), 'utf8');
const mainOutDir = join(projectRoot, 'out/main');

function asarUnpackPatterns(): string[] {
  const section = /^asarUnpack:\n((?:\s+-\s+.*\n)+)/m.exec(builderConfig);
  if (!section) return [];
  return [...section[1]!.matchAll(/^\s+-\s+(.*)$/gm)].map((m) => m[1]!.trim());
}

/** core.js 里所有相对 import 的目标路径（ESM 产物用的是静态 import）。 */
function relativeImportsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/from\s*"(\.[^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(specifiers)];
}

describe('打包合同', () => {
  it('asarUnpack 覆盖整个 out/main，而不是只点名 core.js', () => {
    const patterns = asarUnpackPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    /*
     * 只允许目录级通配。写死单个文件意味着"core.js 恰好没有共享依赖"这个前提
     * 被藏进了配置里；它一旦不再成立，没有任何东西会提醒你。
     */
    expect(patterns).toContain('out/main/**');
  });

  it('构建产物里 core.js 的相对依赖都落在 out/main 内且真实存在', () => {
    const coreEntry = join(mainOutDir, 'core.js');
    if (!existsSync(coreEntry)) {
      // 干净检出下没有构建产物；这一条只能由 `pnpm build` 之后的运行来证明。
      expect(existsSync(mainOutDir), '未构建：跳过产物断言（先跑 pnpm build 再验证这一条）').toBe(
        false,
      );
      return;
    }

    for (const specifier of relativeImportsOf(coreEntry)) {
      const target = resolve(mainOutDir, specifier);
      expect(target.startsWith(mainOutDir), `${specifier} 指向了 out/main 之外`).toBe(true);
      expect(existsSync(target), `${specifier} 在产物里不存在`).toBe(true);
    }
  });
});
