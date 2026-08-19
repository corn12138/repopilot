// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** 可控 Promise 固定复现顺序：先让 B 拥有面板，再让 A 的旧请求完成。 */
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

function tree(runName: string, generation: number): TreeResponse {
  return {
    entries: [{ path: `${runName}.ts`, bytes: 12, changed: generation > 0 }],
    source: 'WORKSPACE',
    generation,
  };
}

function file(path: string, content: string, generation: number | null): FileResponse {
  return {
    path,
    content,
    bytes: content.length,
    truncated: false,
    binary: false,
    changed: generation !== null,
    source: generation === null ? 'SNAPSHOT' : 'WORKSPACE',
    generation,
  };
}

const baseProps = {
  snapshotId: 'snapshot-shared',
  refreshKey: 0,
  onClose: vi.fn(),
};

describe('FileTreePanel async ownership', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps Run B tree when Run A resolves late', async () => {
    const treeA = deferred<TreeResponse>();
    const treeB = deferred<TreeResponse>();
    requestMock.mockImplementation((method: string, payload: { runId?: string }) => {
      if (method !== 'files.tree') throw new Error(`unexpected ${method}`);
      return payload.runId === 'run-a' ? treeA.promise : treeB.promise;
    });

    const view = render(
      <FileTreePanel {...baseProps} runId="run-a" workspaceGeneration={1} />,
    );
    view.rerender(
      <FileTreePanel {...baseProps} runId="run-b" workspaceGeneration={7} />,
    );

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').textContent).toContain('正在读取当前文件树');

    await act(async () => treeB.resolve(tree('b', 8)));
    expect(screen.getByRole('button', { name: 'b.ts' })).toBeTruthy();
    expect(screen.getByText('工作区 gen-8')).toBeTruthy();

    await act(async () => treeA.resolve(tree('a', 2)));
    expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
    expect(screen.getByRole('button', { name: 'b.ts' })).toBeTruthy();
  });

  it('rejects a Run tree response that claims snapshot ownership before rendering entries', async () => {
    requestMock.mockResolvedValue({
      entries: [{ path: 'must-not-render.ts', bytes: 10, changed: false }],
      source: 'SNAPSHOT',
      generation: null,
    } satisfies TreeResponse);

    render(<FileTreePanel {...baseProps} runId="run-owned" workspaceGeneration={3} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('文件树响应归属不匹配');
    expect(alert.textContent).toContain('WORKSPACE/非负整数 generation');
    expect(screen.queryByRole('button', { name: 'must-not-render.ts' })).toBeNull();
  });

  it('keeps Run B file preview when Run A read resolves late', async () => {
    const fileA = deferred<FileResponse>();
    const fileB = deferred<FileResponse>();
    requestMock.mockImplementation(
      (method: string, payload: { runId?: string; path?: string }) => {
        if (method === 'files.tree') {
          return Promise.resolve(
            payload.runId === 'run-a' ? tree('a', 1) : tree('b', 4),
          );
        }
        if (method === 'files.read') {
          return payload.path === 'a.ts' ? fileA.promise : fileB.promise;
        }
        throw new Error(`unexpected ${method}`);
      },
    );

    const view = render(
      <FileTreePanel {...baseProps} runId="run-a" workspaceGeneration={1} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(screen.getByText('正在读取文件…')).toBeTruthy();

    view.rerender(
      <FileTreePanel {...baseProps} runId="run-b" workspaceGeneration={4} />,
    );
    expect(screen.queryByText('a.ts')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'b.ts' }));

    expect(requestMock).toHaveBeenCalledWith('files.read', {
      snapshotId: 'snapshot-shared',
      runId: 'run-a',
      path: 'a.ts',
      expectedGeneration: 1,
    });
    expect(requestMock).toHaveBeenCalledWith('files.read', {
      snapshotId: 'snapshot-shared',
      runId: 'run-b',
      path: 'b.ts',
      expectedGeneration: 4,
    });

    await act(async () => fileB.resolve(file('b.ts', 'B current content', 4)));
    expect(screen.getByText('B current content')).toBeTruthy();

    await act(async () => fileA.resolve(file('a.ts', 'A stale content', 1)));
    expect(screen.queryByText('A stale content')).toBeNull();
    expect(screen.getByText('B current content')).toBeTruthy();
  });

  it('rejects a latest file response whose source or generation does not match its tree owner', async () => {
    requestMock.mockImplementation(
      (method: string) =>
        method === 'files.tree'
          ? Promise.resolve(tree('owned', 3))
          : Promise.resolve(file('owned.ts', 'wrong generation', 4)),
    );

    render(<FileTreePanel {...baseProps} runId="run-owned" workspaceGeneration={3} />);
    fireEvent.click(await screen.findByRole('button', { name: 'owned.ts' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('文件响应归属不匹配');
    expect(alert.textContent).toContain('WORKSPACE/gen-3/owned.ts');
    expect(alert.textContent).toContain('WORKSPACE/gen-4/owned.ts');
    expect(screen.queryByText('wrong generation')).toBeNull();
  });

  it('renders error, empty and search-zero distinctly and clears an old error on success', async () => {
    const failed = deferred<TreeResponse>();
    const empty = deferred<TreeResponse>();
    const recovered = deferred<TreeResponse>();
    requestMock
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => empty.promise)
      .mockImplementationOnce(() => recovered.promise);

    render(<FileTreePanel {...baseProps} runId="run-a" workspaceGeneration={1} />);
    await act(async () => failed.reject(new Error('tree unavailable')));
    expect(screen.getByRole('alert').textContent).toContain('tree unavailable');
    expect(screen.getByText('工作区 gen-1 · 读取失败')).toBeTruthy();
    expect(screen.queryByText('没有文件')).toBeNull();

    fireEvent.click(screen.getByTitle('刷新'));
    await act(async () =>
      empty.resolve({ entries: [], source: 'WORKSPACE', generation: 1 }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('没有文件')).toBeTruthy();

    fireEvent.click(screen.getByTitle('刷新'));
    await act(async () => recovered.resolve(tree('visible', 1)));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('没有文件')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('过滤路径…'), {
      target: { value: 'missing' },
    });
    expect(screen.getByText('没有匹配“missing”的文件')).toBeTruthy();
    expect(screen.queryByText('没有文件')).toBeNull();
  });
});
