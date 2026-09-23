import type { BrowserWindow, WebContents } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkbenchSelftestResult {
  readonly passes: string[];
  readonly failures: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDom(
  webContents: WebContents,
  predicate: string,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await webContents.executeJavaScript(
      `(() => { try { return Boolean(${predicate}); } catch { return false; } })()`,
    ) as boolean;
    if (found) return true;
    await sleep(150);
  }
  return false;
}

/** 只验证工作位桥、白名单 IPC 与真实 DOM；能力探针仍保持零模型消息。 */
export async function runWorkbenchSelftest(
  window: BrowserWindow,
  captureDir: string | null,
): Promise<WorkbenchSelftestResult> {
  const passes: string[] = [];
  const failures: string[] = [];
  const webContents = window.webContents;
  const js = <T>(code: string): Promise<T> => webContents.executeJavaScript(code) as Promise<T>;

  window.setSize(1440, 1024);
  await sleep(200);
  const wideSize = window.getSize();
  if (wideSize[0] === 1440 && wideSize[1] === 1024) passes.push('宽屏窗口已切到 1440×1024');
  else failures.push(`宽屏窗口尺寸异常：${wideSize.join('×')}`);

  const bridge = await js<{ present: boolean; version: unknown }>(
    `({ present: typeof window.repopilotWorkbench === 'object' && typeof window.repopilotWorkbench.request === 'function', version: window.repopilotWorkbench && window.repopilotWorkbench.protocolVersion })`,
  );
  if (!bridge.present) {
    failures.push('window.repopilotWorkbench 不存在');
    return { passes, failures };
  }
  passes.push(`工作位桥已挂到 window（protocolVersion=${String(bridge.version)}）`);

  const ipc = await js<{
    listOk: boolean;
    sessionCount: number | null;
    summaryOk: boolean;
    summaryIsArray: boolean;
    unknownCode: string | null;
    extraCode: string | null;
  }>(`(async () => {
    const list = await window.repopilotWorkbench.request('workbench.list', { projectId: null });
    const summary = await window.repopilotWorkbench.request('workbench.summary', {});
    const unknown = await window.repopilotWorkbench.request('workbench.nope', {});
    const extra = await window.repopilotWorkbench.request('workbench.list', { extra: 1 });
    return {
      listOk: list.ok,
      sessionCount: list.ok ? list.data.sessions.length : null,
      summaryOk: summary.ok,
      summaryIsArray: summary.ok ? Array.isArray(summary.data.projects) : false,
      unknownCode: unknown.ok ? null : unknown.error.code,
      extraCode: extra.ok ? null : extra.error.code,
    };
  })()`);
  if (ipc.listOk && ipc.sessionCount === 0) passes.push('IPC list → 0 个受管会话');
  else failures.push(`IPC list 异常：${JSON.stringify(ipc)}`);
  if (ipc.summaryOk && ipc.summaryIsArray) passes.push('IPC summary → 跨项目状态汇总（只读计数）可用');
  else failures.push(`IPC summary 异常：${JSON.stringify(ipc)}`);
  if (ipc.unknownCode === 'BAD_REQUEST') passes.push('IPC 未知方法 → BAD_REQUEST');
  else failures.push(`IPC 未知方法应拒绝，实际 ${String(ipc.unknownCode)}`);
  if (ipc.extraCode === 'BAD_REQUEST') passes.push('IPC 多余字段 → BAD_REQUEST');
  else failures.push(`IPC 多余字段应拒绝，实际 ${String(ipc.extraCode)}`);

  await js<void>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('双 Agent'));
    if (!button) throw new Error('找不到双 Agent 入口');
    button.click();
  })()`);
  const rendered = await waitForDom(
    webContents,
    `document.querySelector('[aria-label="双 Agent 工作台"]') && document.querySelector('[aria-label="CLAUDE 工作位"]') && document.querySelector('[aria-label="CODEX 工作位"]')`,
    20_000,
  );
  if (rendered) passes.push('双 Agent 页面已渲染，Claude/Codex 两个工作位均存在');
  else failures.push('双 Agent 页面或两个工作位未在 20 秒内渲染');

  const capabilitiesSettled = rendered && await waitForDom(
    webContents,
    `!document.querySelector('[aria-label="双 Agent 工作台"]')?.textContent?.includes('正在检测本机引擎能力')`,
    25_000,
  );
  if (capabilitiesSettled) passes.push('两家本机能力探针已收口后再取页面证据');
  else if (rendered) failures.push('本机能力探针未在 25 秒内收口');

  if (capabilitiesSettled && captureDir) {
    mkdirSync(captureDir, { recursive: true });
    await sleep(300);
    const image = await webContents.capturePage();
    const file = join(captureDir, 'workbench-1440x1024.png');
    writeFileSync(file, image.toPNG());
    const size = image.getSize();
    passes.push(`截图 workbench-1440x1024.png（${size.width}×${size.height}）→ ${file}`);
  }

  if (capabilitiesSettled) {
    window.setSize(760, 900);
    await sleep(300);
    const narrow = await js<{
      tabDisplay: string;
      visiblePanes: number;
      hiddenPanes: number;
      bodyOverflow: boolean;
    }>(`(() => {
      const panes = [...document.querySelectorAll('.workbench-pane')];
      return {
        tabDisplay: getComputedStyle(document.querySelector('.workbench-tabs')).display,
        visiblePanes: panes.filter((item) => getComputedStyle(item).display !== 'none').length,
        hiddenPanes: panes.filter((item) => getComputedStyle(item).display === 'none').length,
        bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    if (
      narrow.tabDisplay === 'flex' &&
      narrow.visiblePanes === 1 &&
      narrow.hiddenPanes === 1 &&
      !narrow.bodyOverflow
    ) {
      passes.push('窄窗显示角色标签与单个活动工作位，页面无横向溢出');
    } else {
      failures.push(`窄窗布局异常：${JSON.stringify(narrow)}`);
    }
    if (captureDir) {
      const image = await webContents.capturePage();
      const file = join(captureDir, 'workbench-narrow.png');
      writeFileSync(file, image.toPNG());
      const size = image.getSize();
      passes.push(`截图 workbench-narrow.png（${size.width}×${size.height}）→ ${file}`);
    }
  }
  window.setSize(1440, 940);
  return { passes, failures };
}
