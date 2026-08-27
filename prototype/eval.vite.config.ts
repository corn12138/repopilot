import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * SPK-010 实验执行器的构建配置（`pnpm eval:spk010`）。
 *
 * 为什么要单独一份：执行器是无头 Node 程序（不进 Electron、不进测试集），
 * 但它复用 core 的 runner/authority，需要 `@shared` 别名与 TS 转译 ——
 * vite 的 SSR 构建恰好给这两样，且依赖全部外置（zod 等从 node_modules 现取）。
 * 产物落在 eval-out/.build（gitignored），不混进应用的 out/。
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  build: {
    ssr: 'src/core/eval/run-experiment.ts',
    outDir: 'eval-out/.build',
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    sourcemap: true,
  },
});
