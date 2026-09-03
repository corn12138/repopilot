// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserverProjection, ObserverPushEvent } from '@shared/observerProtocol';

const observerCallMock = vi.fn();
let pushHandlers: Array<(e: ObserverPushEvent) => void> = [];
vi.mock('../observerBridge', () => ({
  observerCall: (...args: unknown[]) => observerCallMock(...args),
  observerSubscribe: (h: (e: ObserverPushEvent) => void) => {
    pushHandlers.push(h);
    return () => {};
  },
}));

import { ObserverView } from './Observer';

/**
 * 观察面板的展示纪律（真实 DOM 断言）：
 *   - 未授权时只有"启用"入口，且信任边界文案（只读/零出站/可关闭）必须可见；
 *   - 授权取消（granted=null）什么都不改变；
 *   - FORMAT_UNKNOWN 必须停止渲染正文、给出违规键与重建基线的命令；
 *   - 撤销（state.granted=null 推送）后会话列表与投影一并清空 —— 不留残影。
 */

const SESSION = {
  sessionId: 'CLAUDE_JOURNAL:abc.jsonl',
  vendor: 'CLAUDE_JOURNAL' as const,
  label: 'abc',
  updatedAt: new Date().toISOString(),
  sizeBytes: 2048,
};
const COUNTS = {
  claudeMatched: 1,
  claudeSkippedByCap: 0,
  codexScanned: 3,
  codexMatched: 0,
  codexSkippedByCap: 0,
  codexUnreadable: 0,
};

function projection(over: Partial<ObserverProjection> = {}): ObserverProjection {
  return {
    sessionId: SESSION.sessionId,
    vendor: 'CLAUDE_JOURNAL',
    status: 'OK',
    breaking: [],
    lines: [{ seq: 0, kind: 'assistant', text: '你好，这是镜像正文', collapsed: 1 }],
    counts: { records: 3, shownLines: 1, omittedLines: 0, unparseableLines: 0, blankLines: 1, headBytesSkipped: 0 },
    fileUpdatedAt: new Date().toISOString(),
    active: true,
    ...over,
  };
}

const push = (e: ObserverPushEvent): void => {
  for (const h of pushHandlers) h(e);
};

beforeEach(() => {
  pushHandlers = [];
  observerCallMock.mockReset();
  observerCallMock.mockImplementation(async (method: string) => {
    if (method === 'observer.status') return { granted: null, watching: null };
    if (method === 'observer.unwatch') return { ok: true };
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(cleanup);

describe('观察面板', () => {
  it('未授权：显示启用入口与信任边界文案；授权取消时不建立任何状态', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: null, watching: null };
      if (method === 'observer.enable') return { granted: null };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    expect(await screen.findByText('选择项目目录并启用观察')).toBeTruthy();
    expect(screen.getByText(/不进模型、不进遥测/)).toBeTruthy();

    fireEvent.click(screen.getByText('选择项目目录并启用观察'));
    await waitFor(() => expect(observerCallMock).toHaveBeenCalledWith('observer.enable', {}));
    // 取消 = 无授权、无列表
    expect(screen.getByText('选择项目目录并启用观察')).toBeTruthy();
    expect(screen.queryByText(/已授权/)).toBeNull();
  });

  it('授权成功：显示展示路径、扫描账目与会话列表；点会话发起 watch；投影推送后渲染正文与计数', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: null, watching: null };
      if (method === 'observer.enable')
        return { granted: '~/demo', sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.watch') return { ok: true };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    fireEvent.click(await screen.findByText('选择项目目录并启用观察'));
    expect(await screen.findByText('~/demo')).toBeTruthy();
    expect(screen.getByText(/codex 扫描 3 命中 0/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Claude · abc/));
    await waitFor(() =>
      expect(observerCallMock).toHaveBeenCalledWith('observer.watch', { sessionId: SESSION.sessionId }),
    );

    push({ kind: 'observer.projection', projection: projection() });
    expect(await screen.findByText(/你好，这是镜像正文/)).toBeTruthy();
    expect(screen.getByText(/记录 3 · 显示 1 行/)).toBeTruthy();
  });

  it('FORMAT_UNKNOWN：停止渲染正文，给出违规键名与重建基线命令', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: null };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');

    push({
      kind: 'observer.projection',
      projection: projection({ status: 'FORMAT_UNKNOWN', breaking: ['top:user.uuid'], lines: [] }),
    });
    expect(await screen.findByText(/格式未知/)).toBeTruthy();
    expect(screen.getByText(/top:user\.uuid/)).toBeTruthy();
    expect(screen.getByText(/probe:journals/)).toBeTruthy();
    expect(screen.queryByText(/你好，这是镜像正文/)).toBeNull();
  });

  it('撤销：state.granted=null 推送后，列表与投影一并清空，回到启用入口', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: null };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.disable') return { ok: true };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');
    push({ kind: 'observer.projection', projection: projection() });
    await screen.findByText(/你好，这是镜像正文/);

    fireEvent.click(screen.getByText('关闭观察'));
    await waitFor(() => expect(observerCallMock).toHaveBeenCalledWith('observer.disable', {}));
    push({ kind: 'observer.state', state: { granted: null, watching: null } });

    expect(await screen.findByText('选择项目目录并启用观察')).toBeTruthy();
    expect(screen.queryByText(/你好，这是镜像正文/)).toBeNull();
    expect(screen.queryByText(/Claude · abc/)).toBeNull();
  });

  it('listSessions 失败：错误横幅可见，不假装列表为空', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: null };
      if (method === 'observer.listSessions') throw new Error('磁盘读取失败');
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    expect(await screen.findByText(/磁盘读取失败/)).toBeTruthy();
  });
});
