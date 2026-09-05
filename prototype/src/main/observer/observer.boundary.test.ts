import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 观察面板的边界契约（源码级断言）。
 *
 * TD-DEC-022 与 DEC-020 的四条边界里，有几条是"结构上不可能违反"比"运行时没违反"
 * 更值钱的：Core 不知道观察面板存在、观察模块不碰 Core 契约、服务层没有任何写路径、
 * Renderer 拿到的桥只有两座。这些用 import 图和源码 token 钉住 —— 与
 * `styles.contract.test.ts` 同一取舍：断言的是"代码写了什么"，不是"运行时恰好没发生"。
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../..');
const read = (rel: string): string => readFileSync(join(src, rel), 'utf8');

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('观察面板边界契约', () => {
  it('Core 对观察面板一无所知：src/core 下没有任何文件 import main/observer 或 observerProtocol', () => {
    const offenders = listTsFiles(join(src, 'core')).filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /main\/observer|observerProtocol/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('Core 契约文件未被观察面板触碰：protocol.ts / ipcContract.ts 不含 observer 字样', () => {
    expect(read('shared/protocol.ts')).not.toMatch(/observer/i);
    expect(read('shared/ipcContract.ts')).not.toMatch(/observer/i);
  });

  it('观察模块只依赖 node 内建、zod、electron（仅 ipc 接线）、@shared/observerProtocol 与同目录文件', () => {
    const allowed = /^(node:|zod$|electron$|@shared\/observerProtocol$|\.\/)/;
    for (const rel of [
      'main/observer/observerService.ts',
      'main/observer/observerIpc.ts',
      'main/observer/observerSchema.ts',
      'main/observer/journalShape.ts',
    ]) {
      const specs = importSpecifiers(read(rel));
      const bad = specs.filter((s) => !allowed.test(s));
      expect(bad, `${rel} 越界 import：${bad.join(', ')}`).toEqual([]);
    }
    // 只有接线层可以碰 electron；服务与解析层必须能在纯 node 单测里跑
    expect(importSpecifiers(read('main/observer/observerService.ts'))).not.toContain('electron');
    expect(importSpecifiers(read('main/observer/journalShape.ts'))).not.toContain('electron');
  });

  it('服务层零写路径：源码里没有任何 fs 写/删/移操作', () => {
    const s = read('main/observer/observerService.ts');
    expect(s).not.toMatch(/\b(writeFileSync|writeFile|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rm\(|rename|mkdir|createWriteStream|truncate)\b/);
  });

  it('授权请求的 schema 结构上不收路径：observer.enable 的 payload 是严格空对象', () => {
    const s = read('main/observer/observerSchema.ts');
    expect(s).toMatch(/method: z\.literal\('observer\.enable'\), payload: empty/);
    expect(s).not.toMatch(/projectPath|hostPath/);
  });

  it('Preload 恰好暴露两座桥，且都不含通用 invoke(channel, …)', () => {
    const s = read('preload/index.ts');
    const exposed = [...s.matchAll(/exposeInMainWorld\('([^']+)'/g)].map((m) => m[1]);
    expect(exposed).toEqual(['repopilot', 'repopilotObserver']);
    // request(method, payload) 只允许打到写死的 channel 常量上
    expect(s).toMatch(/ipcRenderer\.invoke\(IPC_CHANNEL\.request/);
    expect(s).toMatch(/ipcRenderer\.invoke\(OBSERVER_CHANNEL\.request/);
    expect((s.match(/ipcRenderer\.invoke\(/g) ?? []).length).toBe(2);
  });

  it('Renderer 的观察视图只经 observerBridge 说话，不直接碰 Core 的 call/subscribe', () => {
    const specs = importSpecifiers(read('renderer/views/Observer.tsx'));
    expect(specs).toContain('../observerBridge');
    expect(specs).not.toContain('../bridge');
  });

  it('投影文本长度与行数有上限（省略要报数的前提是先有上限）', () => {
    const s = read('main/observer/observerService.ts');
    expect(s).toMatch(/MAX_PROJECTION_LINES = 200/);
    expect(s).toMatch(/MAX_LINE_TEXT = 600/);
    expect(s).toMatch(/MAX_READ_BYTES = 4_000_000/);
  });
});
