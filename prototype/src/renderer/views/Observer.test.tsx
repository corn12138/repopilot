// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserverProjection, ObserverPushEvent } from '@shared/observerProtocol';

const observerCallMock = vi.fn();
const clipboardWriteMock = vi.fn();
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
  source: 'DESKTOP_LOCAL_AGENT' as const,
  sourceEvidence: ['entrypoint=claude-desktop'],
  completion: { state: 'READY_TO_HANDOFF' as const, evidence: ['message.stop_reason=end_turn'] },
  attentionEventId: 'sha256:completion-1',
};
const COUNTS = {
  claudeMatched: 1,
  claudeSkippedByCap: 0,
  claudeNestedSkipped: 0,
  codexScanned: 3,
  codexMatched: 0,
  codexSkippedByCap: 0,
  codexUnreadable: 0,
};

function projection(over: Partial<ObserverProjection> = {}): ObserverProjection {
  return {
    sessionId: SESSION.sessionId,
    vendor: 'CLAUDE_JOURNAL',
    source: 'DESKTOP_LOCAL_AGENT',
    sourceEvidence: ['entrypoint=claude-desktop'],
    status: 'OK',
    breaking: [],
    driftNotes: [],
    lines: [{ seq: 0, kind: 'assistant', text: '你好，这是镜像正文', collapsed: 1 }],
    counts: { records: 3, shownLines: 1, omittedLines: 0, unparseableLines: 0, blankLines: 1, headBytesSkipped: 0 },
    fileUpdatedAt: new Date().toISOString(),
    active: true,
    completion: { state: 'READY_TO_HANDOFF', evidence: ['message.stop_reason=end_turn'] },
    ...over,
  };
}

const push = (e: ObserverPushEvent): void => {
  for (const h of pushHandlers) h(e);
};

beforeEach(() => {
  window.localStorage.clear();
  pushHandlers = [];
  observerCallMock.mockReset();
  clipboardWriteMock.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteMock },
  });
  observerCallMock.mockImplementation(async (method: string) => {
    if (method === 'observer.status') return { granted: null, watching: [] };
    if (method === 'observer.unwatch') return { ok: true };
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('观察面板', () => {
  it('本地别名优先展示并只写 Renderer 本地存储', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);

    const input = await screen.findByRole('textbox', { name: 'abc 的本地别名' });
    fireEvent.change(input, { target: { value: '登录修复复核' } });
    fireEvent.click(screen.getByRole('button', { name: '保存别名' }));

    const list = screen.getByLabelText('可观察的会话列表');
    expect(within(list).getByText(/Claude · 登录修复复核/)).toBeTruthy();
    expect(within(list).getByText(/标题来源 LOCAL_ALIAS/)).toBeTruthy();
    const stored = window.localStorage.getItem('repopilot.observer.aliases.v1');
    expect(stored).toContain('登录修复复核');
    expect(stored).toContain('~/demo:CLAUDE_JOURNAL:abc.jsonl');
    expect(observerCallMock).not.toHaveBeenCalledWith(expect.stringMatching(/alias/i), expect.anything());
  });

  it('别名与注意处置按授权项目隔离，同名 sessionId 不跨项目复用', async () => {
    window.localStorage.setItem('repopilot.observer.aliases.v1', JSON.stringify({
      '~/other:CLAUDE_JOURNAL:abc.jsonl': '另一个项目的别名',
    }));
    window.localStorage.setItem('repopilot.observer.attention.v1', JSON.stringify({
      '~/other:CLAUDE_JOURNAL:abc.jsonl:sha256:completion-1': 'SEEN',
    }));
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    render(<ObserverView />);

    expect((await screen.findByRole('textbox', { name: 'abc 的本地别名' }) as HTMLInputElement).value).toBe('');
    expect(within(screen.getByRole('region', { name: '会话注意队列' })).getByText('Claude / abc')).toBeTruthy();
    expect(screen.queryByText('另一个项目的别名')).toBeNull();
  });

  it('未授权：显示启用入口与信任边界文案；授权取消时不建立任何状态', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: null, watching: [] };
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
      if (method === 'observer.status') return { granted: null, watching: [] };
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
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');

    push({
      kind: 'observer.projection',
      projection: projection({
        status: 'FORMAT_UNKNOWN',
        breaking: ['consumed:user.message 不是对象'],
        lines: [],
      }),
    });
    expect(await screen.findByText(/格式未知/)).toBeTruthy();
    expect(screen.getByText(/消费键契约/)).toBeTruthy();
    expect(screen.getByText(/consumed:user\.message 不是对象/)).toBeTruthy();
    // 消费契约违规不是基线问题 —— 这里不该引导用户去重建基线
    expect(screen.queryByText(/probe:journals/)).toBeNull();
    expect(screen.queryByText(/你好，这是镜像正文/)).toBeNull();
  });

  it('撤销：state.granted=null 推送后，列表与投影一并清空，回到启用入口', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
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
    push({ kind: 'observer.state', state: { granted: null, watching: [] } });

    expect(await screen.findByText('选择项目目录并启用观察')).toBeTruthy();
    expect(screen.queryByText(/你好，这是镜像正文/)).toBeNull();
    expect(screen.queryByText(/Claude · abc/)).toBeNull();
  });

  it('撤销与列表刷新竞态：旧授权的迟到响应不能把已清除会话重新填回', async () => {
    let resolveList!: (value: { sessions: readonly [typeof SESSION]; counts: typeof COUNTS }) => void;
    const pendingList = new Promise<{ sessions: readonly [typeof SESSION]; counts: typeof COUNTS }>((resolve) => {
      resolveList = resolve;
    });
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return pendingList;
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');

    push({ kind: 'observer.state', state: { granted: null, watching: [] } });
    expect(await screen.findByText('选择项目目录并启用观察')).toBeTruthy();
    await act(async () => {
      resolveList({ sessions: [SESSION], counts: COUNTS });
      await pendingList;
    });

    expect(screen.queryByText(/Claude · abc/)).toBeNull();
    expect(screen.queryByRole('region', { name: '会话注意队列' })).toBeNull();
  });

  it('授权来自 Main 侧推送（非本视图发起）时也会去拉会话列表 —— selftest 截图抓到的空档', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: null, watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('选择项目目录并启用观察');

    push({ kind: 'observer.state', state: { granted: '~/pushed', watching: [] } });
    expect(await screen.findByText('~/pushed')).toBeTruthy();
    expect(await screen.findByText(/Claude · abc/)).toBeTruthy();
    expect(observerCallMock).toHaveBeenCalledWith('observer.listSessions', {});
  });

  it('基线出入只提示不阻断：正文照常渲染，附一行出入说明与重建命令', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');
    push({
      kind: 'observer.projection',
      projection: projection({ driftNotes: ['top:bridge-session.ownerAccountUuid'] }),
    });
    expect(await screen.findByText(/你好，这是镜像正文/)).toBeTruthy();
    expect(screen.getByText(/字段基线有 1 处出入（面板依赖键完好，仍可读）/)).toBeTruthy();
    expect(screen.getByText(/bridge-session\.ownerAccountUuid/)).toBeTruthy();
    expect(screen.queryByText(/格式未知/)).toBeNull();
  });

  it('双镜像：两个会话并排各一张镜像卡（槽位序来自 Main 推送）；关闭一个只发那一个的 unwatch', async () => {
    const second = { ...SESSION, sessionId: 'CODEX_ROLLOUT:2026/09/05/rollout-x.jsonl', vendor: 'CODEX_ROLLOUT' as const, label: 'rollout-x' };
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION, second], counts: COUNTS };
      if (method === 'observer.watch') return { ok: true };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    await screen.findByText('~/demo');

    fireEvent.click(screen.getByText(/Claude · abc/));
    fireEvent.click(screen.getByText(/Codex · rollout-x/));
    push({ kind: 'observer.state', state: { granted: '~/demo', watching: [SESSION.sessionId, second.sessionId] } });
    push({ kind: 'observer.projection', projection: projection() });
    push({
      kind: 'observer.projection',
      projection: projection({
        sessionId: second.sessionId,
        vendor: 'CODEX_ROLLOUT',
        lines: [{ seq: 0, kind: 'assistant', text: '这是 codex 那一格', collapsed: 1 }],
      }),
    });
    expect(await screen.findByText(/你好，这是镜像正文/)).toBeTruthy();
    expect(screen.getByText(/这是 codex 那一格/)).toBeTruthy();
    expect(screen.getAllByText('关闭镜像')).toHaveLength(2);
    expect(within(screen.getByLabelText('可观察的会话列表')).getAllByText(/镜像中/)).toHaveLength(2);

    fireEvent.click(screen.getAllByText('关闭镜像')[0]!);
    await waitFor(() =>
      expect(observerCallMock).toHaveBeenCalledWith('observer.unwatch', { sessionId: SESSION.sessionId }),
    );
    // 槛位以 Main 为准：推送新的 watching 后，被关掉那格连投影一起消失
    push({ kind: 'observer.state', state: { granted: '~/demo', watching: [second.sessionId] } });
    await waitFor(() => expect(screen.queryByText(/你好，这是镜像正文/)).toBeNull());
    expect(screen.getByText(/这是 codex 那一格/)).toBeTruthy();
    expect(screen.getAllByText('关闭镜像')).toHaveLength(1);
  });

  it('listSessions 失败：错误横幅可见，不假装列表为空', async () => {
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') throw new Error('磁盘读取失败');
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);
    expect(await screen.findByText(/磁盘读取失败/)).toBeTruthy();
  });

  it('Desktop 会话按来源分组；机器结束后先冻结交接包，再由用户送入有界审核', async () => {
    const onUse = vi.fn();
    const artifact = {
      handoffId: 'handoff_1',
      sessionId: SESSION.sessionId,
      projectDisplayPath: '~/demo',
      vendor: 'CLAUDE_JOURNAL' as const,
      source: 'DESKTOP_LOCAL_AGENT' as const,
      sourceEvidence: ['entrypoint=claude-desktop'],
      completion: { state: 'READY_TO_HANDOFF' as const, evidence: ['message.stop_reason=end_turn'] },
      sourceUpdatedAt: '2026-09-14T00:00:00.000Z',
      preparedAt: '2026-09-14T00:00:01.000Z',
      payload: '来源：Claude Desktop',
      digest: 'sha256:1234567890abcdef',
      includedLines: 1,
      omittedLines: 2,
      suggestedGoal: '审核 Claude 的工作结果',
    };
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION], counts: COUNTS };
      if (method === 'observer.prepareHandoff') return { artifact };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView reviewProjectDisplayPath="~/demo" onUseAsReviewTask={onUse} />);
    await screen.findByText('~/demo');
    expect(screen.getByRole('region', { name: 'Desktop 会话' })).toBeTruthy();
    push({ kind: 'observer.projection', projection: projection({ fileUpdatedAt: artifact.sourceUpdatedAt }) });
    fireEvent.click(await screen.findByText('准备交给另一边审核'));
    expect(await screen.findByText(/交接包已冻结/)).toBeTruthy();
    expect(screen.getByText(/省略 2 行/)).toBeTruthy();
    fireEvent.click(screen.getByText('复制给另一个 Desktop'));
    await waitFor(() =>
      expect(clipboardWriteMock).toHaveBeenCalledWith(`[RepoPilot 交接包 ${artifact.digest}]\n${artifact.payload}`),
    );
    expect(await screen.findByText('已复制')).toBeTruthy();
    fireEvent.click(screen.getByText('进入 RepoPilot 有界审核'));
    expect(onUse).toHaveBeenCalledWith(artifact);
  });

  it('注意队列只收机器结束会话；点击只打开镜像，UNKNOWN 数量单独披露', async () => {
    const running = {
      ...SESSION,
      sessionId: 'CLAUDE_JOURNAL:running.jsonl',
      label: 'running',
      completion: { state: 'RUNNING' as const, evidence: ['最后一个意图记录为 user'] },
    };
    const unknown = {
      ...SESSION,
      sessionId: 'CODEX_ROLLOUT:unknown.jsonl',
      vendor: 'CODEX_ROLLOUT' as const,
      label: 'unknown',
      completion: { state: 'UNKNOWN' as const, evidence: ['有限尾部没有发现机器结束字段'] },
    };
    const later = {
      ...SESSION,
      sessionId: 'CLAUDE_JOURNAL:later.jsonl',
      label: 'later',
    };
    observerCallMock.mockImplementation(async (method: string) => {
      if (method === 'observer.status') return { granted: '~/demo', watching: [] };
      if (method === 'observer.listSessions') return { sessions: [SESSION, later, running, unknown], counts: COUNTS };
      if (method === 'observer.watch') return { ok: true };
      if (method === 'observer.unwatch') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<ObserverView />);

    const queue = await screen.findByRole('region', { name: '会话注意队列' });
    expect(within(queue).getByText(/明确待答 0 · 待批准 0/)).toBeTruthy();
    expect(within(queue).getByText('Claude / abc')).toBeTruthy();
    expect(within(queue).getByText('Claude / later')).toBeTruthy();
    expect(within(queue).queryByText(/running/)).toBeNull();
    expect(within(queue).getByText(/另有 1 个会话结束状态未知/)).toBeTruthy();

    fireEvent.click(within(queue).getByText('Claude / abc'));
    await waitFor(() =>
      expect(observerCallMock).toHaveBeenCalledWith('observer.watch', { sessionId: SESSION.sessionId }),
    );
    push({ kind: 'observer.state', state: { granted: '~/demo', watching: [SESSION.sessionId] } });
    push({ kind: 'observer.projection', projection: projection() });
    await waitFor(() => expect(within(queue).queryByText('Claude / abc')).toBeNull());
    expect(within(queue).getByText(/已看过 1 个/)).toBeTruthy();
    expect(screen.getByText(/你好，这是镜像正文/)).toBeTruthy();

    fireEvent.click(within(queue).getByText('暂缓'));
    expect(within(queue).queryByText('Claude / later')).toBeNull();
    expect(within(queue).getByText(/暂缓 1 个/)).toBeTruthy();
  });
});
