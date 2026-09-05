import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { ObserverService } from './observerService';

/**
 * 观察面板的运行时取证（`pnpm selftest` 的一段）。
 *
 * 单测证明不了的事在这里证：
 *   - Preload 真的把第二座桥挂到了 window 上（不是类型里有，是运行时有）；
 *   - 未授权时 Renderer 发出的 listSessions/watch 真的被 Main 以 NOT_GRANTED 拒绝、
 *     未知方法真的被 BAD_REQUEST 拒绝 —— 走的是真实 ipcRenderer.invoke → ipcMain.handle；
 *   - 底部按钮真的能把观察视图渲染出来（真实 DOM + 真实样式）。
 *
 * 两个 opt-in 环境变量，默认都不设、默认什么也不读：
 *   REPOPILOT_SELFTEST_OBSERVE_PATH  用该绝对路径直接在服务层授权（不经对话框 —— 自检拿不到
 *                                     原生手势），读真实 HOME 里该项目的会话，驱动到投影为止。
 *                                     生产路径的授权仍只有对话框一条；这里调用的是服务内部 API。
 *   REPOPILOT_SELFTEST_CAPTURE_DIR   把各阶段的 capturePage() 截图写到该目录，供人眼与 AI 走查。
 */

export interface ObserverSelftestResult {
  readonly passes: string[];
  readonly failures: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForDom(webContents: WebContents, predicateJs: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = (await webContents.executeJavaScript(`(() => { try { return Boolean(${predicateJs}); } catch { return false; } })()`)) as boolean;
    if (hit) return true;
    await sleep(150);
  }
  return false;
}

async function capture(webContents: WebContents, dir: string | null, name: string, passes: string[]): Promise<void> {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // DOM 已更新 ≠ 已上屏：executeJavaScript 看到的是 DOM，capturePage 拿的是合成帧。
  // 2026-09-05 第一版没等重绘，"已授权态"的截图拍出来还是上一帧的未授权态。
  await sleep(300);
  const image = await webContents.capturePage();
  const file = join(dir, name);
  writeFileSync(file, image.toPNG());
  const size = image.getSize();
  passes.push(`截图 ${name}（${size.width}×${size.height}）→ ${file}`);
}

export async function runObserverSelftest(
  webContents: WebContents,
  service: ObserverService,
  opts: { observePath: string | null; captureDir: string | null },
): Promise<ObserverSelftestResult> {
  const passes: string[] = [];
  const failures: string[] = [];
  const js = <T>(code: string): Promise<T> => webContents.executeJavaScript(code) as Promise<T>;

  try {
    // 1. 桥在运行时真的存在
    const bridge = await js<{ present: boolean; version: unknown }>(
      `({ present: typeof window.repopilotObserver === 'object' && typeof window.repopilotObserver.request === 'function', version: window.repopilotObserver && window.repopilotObserver.protocolVersion })`,
    );
    if (bridge.present) passes.push(`观察桥已挂到 window（protocolVersion=${String(bridge.version)}）`);
    else {
      failures.push('window.repopilotObserver 不存在 —— Preload 没把第二座桥挂上');
      return { passes, failures };
    }

    // 2. 真实 IPC 的负向路径：未授权与未知方法都必须被结构化拒绝
    const negatives = await js<Array<{ label: string; ok: boolean; code: string | null }>>(`(async () => {
      const out = [];
      const probe = async (label, method, payload) => {
        const r = await window.repopilotObserver.request(method, payload);
        out.push({ label, ok: r.ok, code: r.ok ? null : r.error.code });
      };
      await probe('listSessions 未授权', 'observer.listSessions', {});
      await probe('watch 未授权', 'observer.watch', { sessionId: 'CLAUDE_JOURNAL:x.jsonl' });
      await probe('未知方法', 'observer.nope', {});
      await probe('payload 多余字段', 'observer.status', { extra: 1 });
      await probe('status 未授权', 'observer.status', {});
      return out;
    })()`);
    const expectCode = (label: string, code: string): void => {
      const hit = negatives.find((n) => n.label === label);
      if (hit && !hit.ok && hit.code === code) passes.push(`IPC ${label} → ${code}`);
      else failures.push(`IPC ${label} 应为 ${code}，实际 ${JSON.stringify(hit)}`);
    };
    expectCode('listSessions 未授权', 'NOT_GRANTED');
    expectCode('watch 未授权', 'NOT_GRANTED');
    expectCode('未知方法', 'BAD_REQUEST');
    expectCode('payload 多余字段', 'BAD_REQUEST');
    const status = negatives.find((n) => n.label === 'status 未授权');
    if (status?.ok) passes.push('IPC status 未授权 → ok（granted=null 是合法状态，不是错误）');
    else failures.push(`IPC status 应成功返回，实际 ${JSON.stringify(status)}`);

    // 3. 真实 DOM：底部按钮打开观察视图
    await capture(webContents, opts.captureDir, '01-before-observer.png', passes);
    const clicked = await js<boolean>(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('观察')); if (!b) return false; b.click(); return true; })()`,
    );
    if (!clicked) {
      failures.push('侧栏底部找不到「观察」按钮');
      return { passes, failures };
    }
    const opened = await waitForDom(webContents, `document.body.innerText.includes('选择项目目录并启用观察')`, 3000);
    if (opened) passes.push('点击「👁 观察」后渲染出未授权态（启用按钮 + 信任边界文案）');
    else failures.push('点击「👁 观察」后 3s 内未渲染出未授权态');
    await capture(webContents, opts.captureDir, '02-observer-unauthorized.png', passes);

    // 4. opt-in：服务层直接授权真实项目，驱动到投影
    if (opts.observePath) {
      const display = opts.observePath.startsWith(homedir())
        ? `~${opts.observePath.slice(homedir().length)}`
        : opts.observePath;
      const listed = service.enable(opts.observePath, display);
      passes.push(
        `服务层授权 ${display}：会话 ${listed.sessions.length}（claude ${listed.counts.claudeMatched}，codex ${listed.counts.codexMatched}/${listed.counts.codexScanned}）`,
      );
      const granted = await waitForDom(webContents, `document.body.innerText.includes('已授权')`, 3000);
      if (granted) passes.push('状态推送到达 Renderer：视图切到已授权态');
      else failures.push('授权后 3s 内 Renderer 未显示已授权态（observer.state 推送没到或视图没订到）');
      await capture(webContents, opts.captureDir, '03-observer-granted.png', passes);

      if (listed.sessions.length > 0) {
        const picked = await js<boolean>(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => /^(CLAUDE_JOURNAL|CODEX_ROLLOUT):/.test(x.title || '')); if (!b) return false; b.click(); return true; })()`,
        );
        if (!picked) failures.push('已授权态下找不到任何会话按钮');
        const projected = await waitForDom(
          webContents,
          `document.body.innerText.includes('会话镜像 ·') && /记录 \\d+/.test(document.body.innerText)`,
          6000,
        );
        if (projected) {
          const summary = await js<string>(
            `(() => { const m = document.body.innerText.match(/记录 \\d+[^\\n]*/); return m ? m[0] : ''; })()`,
          );
          passes.push(`点选会话后投影到达并渲染：${summary}`);
          // 截图要拍到断言所指的东西：把镜像卡滚进视口，别让"文字过了、画面没有"再发生
          await js<void>(`(() => { const pre = document.querySelector('pre.output'); if (pre) pre.scrollIntoView({ block: 'center' }); })()`);
        } else {
          failures.push('点选会话后 6s 内没有渲染出投影');
        }
        await capture(webContents, opts.captureDir, '04-observer-projection.png', passes);
      }

      service.disable();
      const cleared = await waitForDom(webContents, `document.body.innerText.includes('选择项目目录并启用观察')`, 3000);
      if (cleared) passes.push('服务层撤销后 Renderer 回到未授权态（撤销即清除，两侧同步）');
      else failures.push('撤销后 3s 内 Renderer 未回到未授权态');
      await capture(webContents, opts.captureDir, '05-observer-revoked.png', passes);
    }
  } catch (err) {
    failures.push(`观察面板取证中断：${(err as Error).message}`);
  }
  return { passes, failures };
}
