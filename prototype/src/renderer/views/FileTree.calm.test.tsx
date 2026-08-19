// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ResponsePayload } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreePanel } from './FileTree';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('../bridge', () => ({ call: requestMock }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type TreeResponse = ResponsePayload<'files.tree'>;
type FileResponse = ResponsePayload<'files.read'>;

function treeOf(paths: string[], generation: number): TreeResponse {
  return {
    entries: paths.map((path) => ({ path, bytes: 12, changed: false })),
    source: 'WORKSPACE',
    generation,
  };
}

function fileOf(path: string, content: string, generation: number): FileResponse {
  return {
    path,
    content,
    bytes: content.length,
    truncated: false,
    binary: false,
    changed: true,
    source: 'WORKSPACE',
    generation,
  };
}

const baseProps = {
  snapshotId: 'snapshot-1',
  runId: 'run-a',
  onClose: vi.fn(),
};

describe('FileTreePanel 同实体刷新的平静度', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('新一代加载期间保留上一代内容，但标明代次并禁止点击', async () => {
    const gen1 = deferred<TreeResponse>();
    const gen2 = deferred<TreeResponse>();
    requestMock.mockImplementation((method: string) => {
      if (method !== 'files.tree') throw new Error(`unexpected ${method}`);
      return requestMock.mock.calls.filter((c) => c[0] === 'files.tree').length === 1
        ? gen1.promise
        : gen2.promise;
    });

    const view = render(
      <FileTreePanel {...baseProps} workspaceGeneration={1} refreshKey={0} />,
    );
    await act(async () => gen1.resolve(treeOf(['src/app.ts'], 1)));
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.getByText('工作区 gen-1')).toBeTruthy();

    // Agent 写了个文件：generation 前进，树重新拉取。
    view.rerender(<FileTreePanel {...baseProps} workspaceGeneration={2} refreshKey={1} />);
    await waitFor(() =>
      expect(requestMock.mock.calls.filter((c) => c[0] === 'files.tree').length).toBe(2),
    );

    // 关键点：屏幕没有被清空，但它明确说了自己是上一代且不可操作。
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.queryByText('正在读取当前文件树…')).toBeNull();
    expect(screen.getByText(/上一代 gen-1 · 正在读取 gen-2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /app\.ts/ }).hasAttribute('disabled')).toBe(true);

    await act(async () => gen2.resolve(treeOf(['src/app.ts'], 2)));
    expect(screen.getByText('工作区 gen-2')).toBeTruthy();
    expect(screen.queryByText(/上一代 gen-1/)).toBeNull();
    expect(screen.getByRole('button', { name: /app\.ts/ }).hasAttribute('disabled')).toBe(false);
  });

  it('刷新后按新 generation 自动重读用户正在看的文件', async () => {
    requestMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'files.tree') {
        const calls = requestMock.mock.calls.filter((c) => c[0] === 'files.tree').length;
        return Promise.resolve(treeOf(['src/app.ts'], calls === 1 ? 1 : 2));
      }
      if (method === 'files.read') {
        const generation = payload.expectedGeneration as number;
        return Promise.resolve(fileOf('src/app.ts', `gen ${generation} 的内容`, generation));
      }
      throw new Error(`unexpected ${method}`);
    });

    const view = render(
      <FileTreePanel {...baseProps} workspaceGeneration={1} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('app.ts')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: /app\.ts/ }).click();
    });
    expect(screen.getByText('gen 1 的内容')).toBeTruthy();

    view.rerender(<FileTreePanel {...baseProps} workspaceGeneration={2} refreshKey={1} />);
    await waitFor(() => expect(screen.getByText('gen 2 的内容')).toBeTruthy());

    // 重读用的是新 generation，而不是把旧 expectedGeneration 再发一次。
    const reads = requestMock.mock.calls.filter((c) => c[0] === 'files.read');
    expect(reads.map((c) => (c[1] as { expectedGeneration: number }).expectedGeneration)).toEqual([
      1, 2,
    ]);
  });

  it('文件在新一代里消失时明确收起预览，不继续显示旧内容', async () => {
    requestMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'files.tree') {
        const calls = requestMock.mock.calls.filter((c) => c[0] === 'files.tree').length;
        return Promise.resolve(
          calls === 1 ? treeOf(['src/gone.ts'], 1) : treeOf(['src/kept.ts'], 2),
        );
      }
      if (method === 'files.read') {
        const generation = payload.expectedGeneration as number;
        return Promise.resolve(fileOf(String(payload.path), '删除前的内容', generation));
      }
      throw new Error(`unexpected ${method}`);
    });

    const view = render(
      <FileTreePanel {...baseProps} workspaceGeneration={1} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('gone.ts')).toBeTruthy());
    await act(async () => {
      screen.getByRole('button', { name: /gone\.ts/ }).click();
    });
    expect(screen.getByText('删除前的内容')).toBeTruthy();

    view.rerender(<FileTreePanel {...baseProps} workspaceGeneration={2} refreshKey={1} />);
    await waitFor(() => expect(screen.getByText('kept.ts')).toBeTruthy());

    expect(screen.queryByText('删除前的内容')).toBeNull();
    // 只读过第一代那一次；消失的文件不会被拿去撞新一代的 generation 门禁。
    expect(requestMock.mock.calls.filter((c) => c[0] === 'files.read').length).toBe(1);
  });

  it('换实体时不保留上一代画面，旧 Run 的内容一帧都不进入新 Run', async () => {
    const runA = deferred<TreeResponse>();
    const runB = deferred<TreeResponse>();
    requestMock.mockImplementation((method: string, payload: { runId?: string }) => {
      if (method !== 'files.tree') throw new Error(`unexpected ${method}`);
      return payload.runId === 'run-a' ? runA.promise : runB.promise;
    });

    const view = render(
      <FileTreePanel {...baseProps} workspaceGeneration={1} refreshKey={0} />,
    );
    await act(async () => runA.resolve(treeOf(['src/only-in-a.ts'], 1)));
    expect(screen.getByText('only-in-a.ts')).toBeTruthy();

    view.rerender(
      <FileTreePanel {...baseProps} runId="run-b" workspaceGeneration={1} refreshKey={0} />,
    );
    expect(screen.queryByText('only-in-a.ts')).toBeNull();
    expect(screen.getByText('正在读取当前文件树…')).toBeTruthy();

    await act(async () => runB.resolve(treeOf(['src/only-in-b.ts'], 1)));
    expect(screen.getByText('only-in-b.ts')).toBeTruthy();
  });
});
