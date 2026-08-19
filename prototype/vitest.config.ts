import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    // Renderer regression tests opt into jsdom per file; Core stays in the faster Node environment.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
