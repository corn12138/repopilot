import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// main 构建同时产出两个入口：
//   index.js — Electron Main（窗口、原生手势、Core 监督）
//   core.js  — Desktop Agent Core（utilityProcess 中运行的唯一业务权威）
// 两者物理分离是有意的：Main 永远不持有 Run/Approval/Patch 权威。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, 'src/core/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          format: 'es',
        },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
  },
});
