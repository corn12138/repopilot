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
