// @vitest-environment jsdom

/**
 * ⌘K 命令面板（交互评审 v0.1 #10 / v0.2 P2）：
 * 打开/过滤/回车执行/Esc 关闭；文件项按需拉取并以预览标签打开。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef, RepositoryHarnessProfile, RepositorySnapshot } from '@shared/domain';
import type { ImportOutcome, IpcResult, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

const NOW = '2026-08-26T00:00:00.000Z';

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
    fileCount: 2,
    totalBytes: 2048,
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

function installBridge(): void {
  const p: ProjectRef = { projectId: 'p1', name: 'Palette Project', displayPath: '/p1', createdAt: NOW };
  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(async (method: RequestMethod, payload?: unknown) => {
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
        case 'files.tree':
          return ok({
            entries: [
              { path: 'src/app.ts', bytes: 20, changed: false },
              { path: 'src/util.ts', bytes: 8, changed: false },
            ],
            source: 'SNAPSHOT',
            generation: null,
          });
        case 'files.read':
          return ok({
            path: String((payload as { path?: string } | undefined)?.path ?? ''),
            content: 'const a = 1;',
            bytes: 12,
            truncated: false,
            binary: false,
            changed: false,
            source: 'SNAPSHOT',
            generation: null,
          });
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }) as RepoPilotBridge['request'],
    subscribe: () => () => {},
  } satisfies Partial<RepoPilotBridge> as RepoPilotBridge;
}

function openPalette(): HTMLInputElement {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.getByLabelText('命令面板输入') as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('⌘K 命令面板', () => {
  it('打开即聚焦输入框；过滤 + 回车执行动作；Esc 关闭', async () => {
    installBridge();
    render(<App />);
    await screen.findByText(/Agent Core 就绪/);

    const input = openPalette();
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '设置' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('命令面板输入')).toBeNull();
    expect(await screen.findByText('环境自检')).toBeTruthy();

    // Esc 只关面板，不动主视图
    const again = openPalette();
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByLabelText('命令面板输入')).toBeNull();
    expect(screen.getByText('环境自检')).toBeTruthy();
  });

  it('项目条目可切换；导入后文件条目出现并以预览标签打开', async () => {
    installBridge();
    render(<App />);
    await screen.findByText(/Agent Core 就绪/);

    // 未导入项目：没有文件来源，但项目条目在
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'Palette' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 执行"打开项目"后主栏出现导入摘要
    expect(await screen.findByText(/2 个文件/)).toBeTruthy();

    // 再开面板：文件树按需拉取，文件条目可过滤
    const input2 = openPalette();
    await screen.findByText('app.ts');
    fireEvent.change(input2, { target: { value: 'util' } });
    await waitFor(() => expect(screen.getByText('util.ts')).toBeTruthy());
    fireEvent.keyDown(input2, { key: 'Enter' });

    // 以预览标签（斜体）打开
    await screen.findByLabelText('代码编辑器（只读）');
    const tab = screen.getByRole('tab', { name: /util.ts/ });
    expect(tab.className).toContain('preview');
  });
});
