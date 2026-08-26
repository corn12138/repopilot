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
              { path: 'app.ts', bytes: 20, changed: false },
              { path: 'util.ts', bytes: 8, changed: false },
            ],
            source: 'SNAPSHOT',
            generation: null,
          });
        case 'files.read':
          return ok({
            path: String((payload as { path?: string } | undefined)?.path ?? 'app.ts'),
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

describe('P1 预览通道合一：单击预览（复用）、双击固定', () => {
  it('单击开斜体预览标签；换文件复用同一位置；双击转正后预览位重新可用', async () => {
    installBridge();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Layout Project/ }));
    const filesTab = screen.getByRole('button', { name: '文件' });
    await waitFor(() => expect((filesTab as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(filesTab);

    // 树行与编辑器标签会同名 —— 一律用 tree-name 侧的节点驱动树交互
    const treeName = (name: string) => {
      const el = screen.getAllByText(name).find((n) => n.className.includes('tree-name'));
      if (!el) throw new Error(`tree node ${name} not found`);
      return el;
    };

    // 单击 = 预览标签（斜体），编辑器随之出现 —— 树内不再有内嵌预览
    await screen.findByText('app.ts');
    fireEvent.click(treeName('app.ts'));
    await screen.findByLabelText('代码编辑器（只读）');
    const tabOf = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
    expect(tabOf('app.ts').className).toContain('preview');
    expect(document.querySelector('.filepanel-viewer')).toBeNull();

    // 单击另一个文件：预览位被复用，标签总数仍是 1
    fireEvent.click(treeName('util.ts'));
    await waitFor(() => expect(tabOf('util.ts')).toBeTruthy());
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: /app.ts/ })).toBeNull();

    // 双击标签 → 固定（斜体消失）；再单击别的文件 → 新预览位，共 2 个标签
    fireEvent.doubleClick(tabOf('util.ts'));
    await waitFor(() => expect(tabOf('util.ts').className).not.toContain('preview'));
    fireEvent.click(treeName('app.ts'));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    expect(tabOf('app.ts').className).toContain('preview');

    // 树里双击 = 直接固定
    fireEvent.doubleClick(treeName('app.ts'));
    await waitFor(() => expect(tabOf('app.ts').className).not.toContain('preview'));
  });
});

describe('P1 分隔线：对话 ↔ 编辑器宽度可调且被记住', () => {
  afterEach(() => {
    window.localStorage.removeItem('repopilot.ui.editorWidth');
  });

  it('方向键调宽被记住（localStorage），双击复位回默认比例', async () => {
    installBridge();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Layout Project/ }));
    const filesTab = screen.getByRole('button', { name: '文件' });
    await waitFor(() => expect((filesTab as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(filesTab);
    const treeNode = () => {
      const el = screen.getAllByText('app.ts').find((n) => n.className.includes('tree-name'));
      if (!el) throw new Error('tree node not found');
      return el;
    };
    await screen.findByText('app.ts');
    fireEvent.doubleClick(treeNode());
    await screen.findByLabelText('代码编辑器（只读）');

    const divider = screen.getByRole('separator', { name: /调整编辑器宽度/ });
    // 默认：不写内联列宽，走 CSS 比例
    expect(appRoot().style.gridTemplateColumns).toBe('');

    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    const cols = appRoot().style.gridTemplateColumns;
    expect(cols).toMatch(/264px minmax\(400px, 1fr\) \d+px/);
    expect(window.localStorage.getItem('repopilot.ui.editorWidth')).toBeTruthy();

    // 双击复位：内联列宽清除、记忆清除
    fireEvent.doubleClick(divider);
    expect(appRoot().style.gridTemplateColumns).toBe('');
    expect(window.localStorage.getItem('repopilot.ui.editorWidth')).toBeNull();
  });
});
