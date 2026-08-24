// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callMock = vi.fn();
vi.mock('../bridge', () => ({
  call: (...args: unknown[]) => callMock(...args),
  RequestError: class RequestError extends Error {},
}));
// CodeMirror 依赖真实布局测量，jsdom 里打桩成纯文本 —— 这组测试锁的是标签逻辑与诚实展示，不是高亮
vi.mock('./CodeView', () => ({
  CodeView: ({ path, content }: { path: string; content: string }) => (
    <pre data-testid="codeview-stub" data-path={path}>
      {content}
    </pre>
  ),
}));

import { EditorPane } from './Editor';

/**
 * 编辑器面板：只读查看器的三条纪律 ——
 * generation 冲突自动重试一次（不无限重试）、二进制/截断如实展示、
 * 标签懒加载且关闭行为交回外层。
 */

interface FilePayload {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  changed: boolean;
  source: 'SNAPSHOT' | 'WORKSPACE';
  generation: number | null;
}

const filePayload = (path: string, over: Partial<FilePayload> = {}): FilePayload => ({
  path,
  content: `// content of ${path}\n`,
  bytes: 20,
  truncated: false,
  binary: false,
  changed: false,
  source: 'SNAPSHOT',
  generation: null,
  ...over,
});

/** 按方法路由的 call 桩；files.read 可注入一次性的失败 */
function routeCalls(input: { files: Record<string, FilePayload>; generation?: number | null; failReadOnce?: string }) {
  let pendingFailure = input.failReadOnce ?? null;
  callMock.mockImplementation(async (method: string, payload: Record<string, unknown>) => {
    if (method === 'files.tree') {
      return { entries: [], source: 'SNAPSHOT', generation: input.generation ?? null };
    }
    if (method === 'files.read') {
      if (pendingFailure) {
        const msg = pendingFailure;
        pendingFailure = null;
        throw new Error(msg);
      }
      const f = input.files[String(payload.path)];
      if (!f) throw new Error(`文件不存在: ${String(payload.path)}`);
      return f;
    }
    throw new Error(`未预期的方法 ${method}`);
  });
}

const baseProps = {
  snapshotId: 'snap_1',
  runId: null,
  refreshKey: 0,
  onActivate: vi.fn(),
  onClose: vi.fn(),
};

afterEach(() => {
  cleanup();
  callMock.mockReset();
});

describe('EditorPane', () => {
  it('加载活动标签：tree → read，内容与来源徽章可见', async () => {
    routeCalls({ files: { 'src/a.ts': filePayload('src/a.ts') } });
    render(<EditorPane {...baseProps} tabs={['src/a.ts']} active="src/a.ts" />);
    await waitFor(() => expect(screen.getByTestId('codeview-stub').textContent).toContain('content of src/a.ts'));
    expect(screen.getByText('快照')).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith('files.tree', expect.objectContaining({ snapshotId: 'snap_1' }));
    expect(callMock).toHaveBeenCalledWith(
      'files.read',
      expect.objectContaining({ path: 'src/a.ts', expectedGeneration: null }),
    );
  });

  it('generation 冲突自动重试一次并成功；不做无限重试', async () => {
    routeCalls({
      files: { 'src/a.ts': filePayload('src/a.ts', { source: 'WORKSPACE', generation: 2, changed: true }) },
      generation: 2,
      failReadOnce: '文件来源 generation 已变化，请刷新文件树后重试',
    });
    render(<EditorPane {...baseProps} runId="run_1" tabs={['src/a.ts']} active="src/a.ts" />);
    await waitFor(() => expect(screen.getByTestId('codeview-stub')).toBeTruthy());
    // 重试 = 第二轮 tree + read
    expect(callMock.mock.calls.filter(([m]) => m === 'files.tree')).toHaveLength(2);
    expect(screen.getByText('工作区 gen-2')).toBeTruthy();
    expect(screen.getByText('已改动')).toBeTruthy();
  });

  it('非 generation 类错误不重试，as-is 展示', async () => {
    routeCalls({ files: {}, failReadOnce: 'POLICY_DENIED: 路径越界' });
    render(<EditorPane {...baseProps} tabs={['x.ts']} active="x.ts" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('路径越界'));
    expect(callMock.mock.calls.filter(([m]) => m === 'files.tree')).toHaveLength(1);
  });

  it('二进制不显示内容；截断有显式横幅 —— 与文件树预览同一套诚实规则', async () => {
    routeCalls({
      files: {
        'a.png': filePayload('a.png', { binary: true, bytes: 5000 }),
        'big.ts': filePayload('big.ts', { truncated: true, bytes: 999999, content: 'partial' }),
      },
    });
    const { rerender } = render(<EditorPane {...baseProps} tabs={['a.png', 'big.ts']} active="a.png" />);
    await waitFor(() => expect(screen.getByText(/二进制文件（5000 B），不显示内容/)).toBeTruthy());
    expect(screen.queryByTestId('codeview-stub')).toBeNull();

    rerender(<EditorPane {...baseProps} tabs={['a.png', 'big.ts']} active="big.ts" />);
    await waitFor(() => expect(screen.getByText(/已截断/)).toBeTruthy());
    expect(screen.getByTestId('codeview-stub').textContent).toBe('partial');
  });

  it('标签点击回调 onActivate；✕ 回调 onClose 且不触发激活', async () => {
    routeCalls({ files: { 'a.ts': filePayload('a.ts'), 'b.ts': filePayload('b.ts') } });
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorPane {...baseProps} tabs={['a.ts', 'b.ts']} active="a.ts" onActivate={onActivate} onClose={onClose} />,
    );
    await waitFor(() => expect(screen.getByTestId('codeview-stub')).toBeTruthy());
    fireEvent.click(screen.getByText('b.ts'));
    expect(onActivate).toHaveBeenCalledWith('b.ts');
    fireEvent.click(screen.getByLabelText('关闭 b.ts'));
    expect(onClose).toHaveBeenCalledWith('b.ts');
    expect(onActivate).toHaveBeenCalledTimes(1); // 关闭不冒泡成激活
  });

  it('refreshKey 变化（Agent 改动落地）→ 内容作废重读', async () => {
    routeCalls({ files: { 'a.ts': filePayload('a.ts') } });
    const { rerender } = render(<EditorPane {...baseProps} tabs={['a.ts']} active="a.ts" />);
    await waitFor(() => expect(screen.getByTestId('codeview-stub')).toBeTruthy());
    const readsBefore = callMock.mock.calls.filter(([m]) => m === 'files.read').length;
    rerender(<EditorPane {...baseProps} refreshKey={1} tabs={['a.ts']} active="a.ts" />);
    await waitFor(() =>
      expect(callMock.mock.calls.filter(([m]) => m === 'files.read').length).toBe(readsBefore + 1),
    );
  });
});
