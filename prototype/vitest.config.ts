import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    // Renderer regression tests opt into jsdom per file; Core stays in the faster Node environment.
    include: ['src/**/*.test.{ts,tsx}'],
    // testing-library 的 findBy/waitFor 默认只等 1s —— 全量跑时那是环境慢，不是断言错
    setupFiles: ['src/testSetup.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
