// @vitest-environment jsdom

/**
 * 交互评审 v0.2 P1（骨架层）：布局恒定。
 *   - 左栏 Activity：运行 ⇄ 文件（文件树住侧栏，不再最右霸一列）
 *   - 对话恒居中，编辑器恒右舞台：唯一的布局变化是 `ide` 类的出现/消失
 *   - 编辑器显式收起：标签保留，主栏顶部有可见的回程条
 * 旧世界的 `with-files` 四栏形态已退役 —— 钉住它不再复活。
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

function installBridge(): void {
  const p: ProjectRef = { projectId: 'p1', name: 'Layout Project', displayPath: '/p1', createdAt: NOW };
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
        case 'files.tree':
          return ok({ entries: [{ path: 'app.ts', bytes: 20, changed: false }], source: 'SNAPSHOT', generation: null });
        case 'files.read':
          return ok({
            path: 'app.ts',
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

function appRoot(): HTMLElement {
  const el = document.querySelector('.app');
  if (!(el instanceof HTMLElement)) throw new Error('app root not rendered');
  return el;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P1 骨架：布局恒定与显式收起', () => {
  it('Activity 切换 · 编辑器出现在 ide 形态 · 收起有回程条 · with-files 不复活', async () => {
    installBridge();
    render(<App />);

    // 导入项目之前，「文件」标签禁用并说明原因
    const filesTab = await screen.findByRole('button', { name: '文件' });
    expect((filesTab as HTMLButtonElement).disabled).toBe(true);
    expect(filesTab.title).toContain('先导入一个项目');

    fireEvent.click(await screen.findByRole('button', { name: /Layout Project/ }));
    await waitFor(() => expect((filesTab as HTMLButtonElement).disabled).toBe(false));

    // 切到文件视图：树接管侧栏，运行列表让位
    fireEvent.click(filesTab);
    await screen.findByPlaceholderText('过滤路径…');
    expect(screen.queryByText('+ 授权本地仓库…')).toBeNull();
    // 树在侧栏里，不是独立 grid 列 —— 旧的 with-files 形态退役
    expect(appRoot().className).not.toContain('with-files');
    expect(appRoot().className).not.toContain('ide');

    // 双击文件 → 编辑器出现在右舞台（ide 形态），对话列不动
    fireEvent.doubleClick(await screen.findByText('app.ts'));
    await screen.findByLabelText('代码编辑器（只读）');
    expect(appRoot().className).toContain('ide');

    // 显式收起：编辑器让位，标签保留，主栏顶部出现回程条
    fireEvent.click(screen.getByRole('button', { name: '收起编辑器' }));
    expect(screen.queryByLabelText('代码编辑器（只读）')).toBeNull();
    expect(appRoot().className).not.toContain('ide');
    const restore = screen.getByRole('button', { name: /编辑器已收起 · 1 个标签/ });

    // 回程条展开：标签还在
    fireEvent.click(restore);
    await screen.findByLabelText('代码编辑器（只读）');
    expect(screen.queryByText(/编辑器已收起/)).toBeNull();

    // 切回运行视图：树让位，运行列表回来
    fireEvent.click(screen.getByRole('button', { name: '运行' }));
    expect(screen.queryByPlaceholderText('过滤路径…')).toBeNull();
    expect(await screen.findByText('+ 授权本地仓库…')).toBeTruthy();
  });
});

describe('P1 状态栏：全局状态的唯一权威位', () => {
  it('Core 状态只在状态栏出现一次；项目名入栏；未配置模型可点去设置', async () => {
    installBridge();
    render(<App />);

    const bar = await screen.findByLabelText('状态栏');
    expect(bar.textContent).toContain('Agent Core 就绪');
    // 唯一主场：侧栏顶部小字不再重复 Core 状态
    expect(screen.getAllByText(/Agent Core 就绪/)).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: /Layout Project/ }));
    await waitFor(() => expect(bar.textContent).toContain('Layout Project'));

    fireEvent.click(screen.getByRole('button', { name: '未配置模型' }));
    expect(await screen.findByText('环境自检')).toBeTruthy();
  });
});
