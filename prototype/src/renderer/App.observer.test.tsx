// @vitest-environment jsdom

/**
 * 观察面板在 App 壳里的接线（PRD-WKB-002 spike）：
 *   - 入口是 sidebar-foot 的观察按钮，打开后占用主区；
 *   - 与设置/证据互斥：任一开启，其余关闭 —— 12 处互斥点是脚本机械补齐的，这里逐条钉；
 *   - Esc 关层；打开项目/运行也会关掉观察（不能盖在 Run 详情上）；
 *   - ⌘K 里有它的命令。
 * 布局恒定（N12）：观察面板不新增 grid 列 —— `.app` 不因它带上 `ide`。
 */

import type { ProjectRef, RepositoryHarnessProfile, RepositorySnapshot } from '@shared/domain';
import type { ObserverBridge } from '@shared/observerProtocol';
import type { ImportOutcome, IpcResult, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { WorkbenchBridge } from '@shared/workbenchProtocol';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const NOW = '2026-09-05T00:00:00.000Z';

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function imported(projectId: string): ImportOutcome {
  const snapshot: RepositorySnapshot = {
    snapshotId: `snapshot-${projectId}`,
    projectId,
    baseSha: projectId.repeat(40).slice(0, 40),
    branch: 'main',
    baseKind: 'CLEAN_COMMIT',
    dirtyFileCount: 0,
    untrackedCount: 0,
    subPath: '',
    fileCount: 1,
    totalBytes: 1024,
    treeDigest: `sha256:${projectId.repeat(64).slice(0, 64)}`,
    excludedPaths: [],
    createdAt: NOW,
  };
  const profile: RepositoryHarnessProfile = {
    profileId: `profile-${projectId}`,
    snapshotId: snapshot.snapshotId,
    adapterId: 'vite-react-ts',
    adapterVersion: 'test',
    supportStatus: 'VERIFIED',
    detectedSignals: ['vite'],
    packageManager: 'pnpm',
    commands: {},
    protectedPaths: [],
    supportedTaskClasses: [],
    notes: [],
  };
  return { outcome: 'IMPORTED', snapshot, profile, candidates: [] };
}

function installBridges(): { observerRequest: ReturnType<typeof vi.fn> } {
  const p: ProjectRef = { projectId: 'p1', name: 'Observer Project', displayPath: '/p1', createdAt: NOW };
  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(async (method: RequestMethod) => {
      switch (method) {
        case 'core.getStatus':
          return ok({ status: 'READY', detail: 'ready', epoch: 1 });
        case 'doctor.run':
          return ok({ checks: [] });
        case 'project.list':
          return ok({ projects: [p] });
        case 'model.listProfiles':
          return ok({ profiles: [], secureStorage: true, credentialStore: 'OK', credentialStoreDetail: null });
        case 'run.list':
          return ok({ runs: [] });
        case 'project.import':
          return ok(imported('p1'));
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }) as RepoPilotBridge['request'],
    subscribe: () => () => { },
  } satisfies Partial<RepoPilotBridge> as RepoPilotBridge;

  const observerRequest = vi.fn(async (method: string) => {
    if (method === 'observer.status') return { ok: true, data: { granted: null, watching: [] } };
    if (method === 'observer.unwatch') return { ok: true, data: { ok: true } };
    return { ok: false, error: { code: 'BAD_REQUEST', message: `unexpected ${method}`, detail: null } };
  });
  window.repopilotObserver = {
    protocolVersion: 3,
    request: observerRequest as unknown as ObserverBridge['request'],
    subscribe: () => () => { },
  };
  return { observerRequest };
}

const observerButton = () => screen.getByRole('button', { name: /👁 观察/ });
const observerCopy = () => screen.queryByText(/本机代理会话观察/);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('观察面板的 App 接线', () => {
  it('底部按钮打开观察面板（第三全屏视图）；不新增 grid 列；再点设置则观察关闭', async () => {
    installBridges();
    render(<App />);
    await screen.findByLabelText('状态栏');

    expect(observerCopy()).toBeNull();
    fireEvent.click(observerButton());
    expect(await screen.findByText(/本机代理会话观察/)).toBeTruthy();
    expect(screen.getByText('选择项目目录并启用观察')).toBeTruthy();
    expect(document.querySelector('.app')!.className).not.toContain('ide');
    expect(screen.queryByText('环境自检')).toBeNull();

    // 互斥：设置打开 → 观察关闭
    fireEvent.click(screen.getByRole('button', { name: /⚙ 设置/ }));
    await screen.findByText('环境自检');
    expect(observerCopy()).toBeNull();

    // 互斥反向：观察打开 → 设置关闭
    fireEvent.click(observerButton());
    await screen.findByText(/本机代理会话观察/);
    expect(screen.queryByText('环境自检')).toBeNull();
  });

  it('与证据页互斥；Esc 关闭观察层', async () => {
    installBridges();
    render(<App />);
    await screen.findByLabelText('状态栏');

    fireEvent.click(observerButton());
    await screen.findByText(/本机代理会话观察/);
    fireEvent.click(screen.getByRole('button', { name: /📊 证据/ }));
    await waitFor(() => expect(observerCopy()).toBeNull());

    fireEvent.click(observerButton());
    await screen.findByText(/本机代理会话观察/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(observerCopy()).toBeNull());
  });

  it('打开项目会关掉观察 —— 观察面板不能盖在项目/运行视图上', async () => {
    installBridges();
    render(<App />);
    fireEvent.click(observerButton());
    await screen.findByText(/本机代理会话观察/);

    fireEvent.click(await screen.findByRole('button', { name: /Observer Project/ }));
    await waitFor(() => expect(observerCopy()).toBeNull());
    expect(await screen.findByText(/1 个文件/)).toBeTruthy();
  });

  it('关闭面板时通知 Main 停止监视（没人看的镜像不该继续产生 IO）', async () => {
    const { observerRequest } = installBridges();
    render(<App />);
    fireEvent.click(observerButton());
    await screen.findByText(/本机代理会话观察/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(observerRequest).toHaveBeenCalledWith('observer.unwatch', {}));
  });

  it('⌘K 命令面板里有「打开观察面板」', async () => {
    installBridges();
    render(<App />);
    await screen.findByLabelText('状态栏');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByLabelText('命令面板输入');
    fireEvent.change(input, { target: { value: '观察' } });
    expect(await screen.findByText('打开观察面板')).toBeTruthy();
  });
});

describe('双 Agent 工作台与其他主区视图互斥', () => {
  it.each([
    { name: /⚙ 设置/ },
    { name: /👁 观察/ },
    { name: /📊 证据/ },
  ])('打开工作台后点击 $name 会切换主区', async ({ name }) => {
    installBridges();
    window.repopilotWorkbench = {
      protocolVersion: 1,
      request: vi.fn(async (method) => {
        if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        return { ok: true, data: { sessions: [] } };
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };
    render(<App />);
    await screen.findByLabelText('状态栏');

    fireEvent.click(screen.getByRole('button', { name: /⇄ 双 Agent/ }));
    await screen.findByRole('region', { name: '双 Agent 工作台' });
    fireEvent.click(screen.getByRole('button', { name }));

    expect(screen.queryByRole('region', { name: '双 Agent 工作台' })).toBeNull();
  });
});
