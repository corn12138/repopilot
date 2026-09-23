// @vitest-environment jsdom
import type { RunView } from '@shared/domain';
import type { WorkbenchBridge, WorkbenchEvent, WorkbenchSessionView } from '@shared/workbenchProtocol';
import { WORKBENCH_PROTOCOL_VERSION } from '@shared/workbenchProtocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectWorkbenchMessages, WorkbenchView } from './Workbench';

afterEach(cleanup);

/** 构造一个合法的 WorkbenchSessionView（agentState 现在是必填，缺省 IDLE）。 */
function sessionView(input: Partial<WorkbenchSessionView> & {
  handle: string;
  vendor: 'CODEX' | 'CLAUDE';
  projectId: string | null;
  displayName: string;
}): WorkbenchSessionView {
  return {
    source: 'MANAGED_NEW_SESSION',
    status: 'READY',
    agentState: 'IDLE',
    connectionEpoch: 1,
    activeRequestId: null,
    vendorSessionIdKnown: true,
    lastEventSequence: 0,
    error: null,
    ...input,
  };
}

const EMPTY_COUNTS = { IDLE: 0, WORKING: 0, BLOCKED_APPROVAL: 0, BLOCKED_INPUT: 0, DONE: 0, DISCONNECTED: 0, ERROR: 0 };

describe('WorkbenchView', () => {
  it('按 eventSequence 合并先到的活事件与后到的历史回放', () => {
    const base = {
      handle: 'session-1',
      connectionEpoch: 2,
      requestId: 'request-1',
      turnId: 'turn-1',
      replayed: false,
    } as const;
    const live = {
      ...base,
      kind: 'turn.text_delta',
      sequence: 2,
      eventSequence: 3,
      text: 'B',
    } satisfies Exclude<WorkbenchEvent, { kind: 'session.updated' }>;
    const replay = {
      ...base,
      kind: 'turn.text_delta',
      sequence: 1,
      eventSequence: 2,
      text: 'A',
      replayed: true,
    } satisfies Exclude<WorkbenchEvent, { kind: 'session.updated' }>;

    expect(projectWorkbenchMessages([live, replay])).toEqual([
      { id: 'request-1:agent', role: 'AGENT', text: 'AB' },
    ]);
  });

  it('turn.waiting 投影成“等待批准/输入”系统消息', () => {
    const waiting = {
      handle: 'session-1',
      connectionEpoch: 1,
      requestId: 'request-1',
      turnId: 'turn-1',
      sequence: 1,
      eventSequence: 1,
      kind: 'turn.waiting',
      reason: 'APPROVAL',
      label: '需要批准 X',
      replayed: false,
    } satisfies Exclude<WorkbenchEvent, { kind: 'session.updated' }>;
    expect(projectWorkbenchMessages([waiting])).toEqual([
      { id: 'request-1:waiting:1', role: 'SYSTEM', text: '等待批准：需要批准 X' },
    ]);
  });

  it('shows both roles and distinguishes transport from verified session creation', async () => {
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        if (method === 'workbench.probe') {
          const capability = (vendor: 'CODEX' | 'CLAUDE') => ({
            vendor,
            installed: { verdict: 'SUPPORTED' as const, checkedAt: 't', evidence: ['bundle'], reason: null },
            versionSupported: vendor === 'CODEX'
              ? { verdict: 'SUPPORTED' as const, checkedAt: 't', evidence: ['pinned'], reason: null }
              : { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未探测' },
            transport: { verdict: 'SUPPORTED' as const, checkedAt: 't', evidence: ['stdio'], reason: null },
            credentialConfigured: { verdict: 'SUPPORTED' as const, checkedAt: 't', evidence: ['fixture credential'], reason: null },
            authenticated: { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未探测' },
            createSession: vendor === 'CODEX'
              ? { verdict: 'SUPPORTED' as const, checkedAt: 't', evidence: ['thread/start'], reason: null }
              : { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未发起真实 query' },
            readStoredHistory: { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未探测' },
            attachLive: { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '新建不证明接管' },
            interrupt: { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未探测' },
            readOnlyReviewIsolation: { verdict: 'UNKNOWN' as const, checkedAt: 't', evidence: [], reason: '未探测' },
            version: null,
            source: 'APP_BUNDLE' as const,
          });
          return { ok: true, data: { capabilities: [capability('CLAUDE'), capability('CODEX')] } };
        }
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };
    render(<WorkbenchView />);
    expect(screen.getByRole('article', { name: 'CLAUDE 工作位' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'CODEX 工作位' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('已安装 · 会话未验证')).toBeTruthy());
    expect(screen.getByText('可新建受管会话')).toBeTruthy();
    expect(screen.getByText('已验证可创建隔离的受管新会话')).toBeTruthy();
    const startButtons = screen.getAllByRole('button', { name: '新建受管会话' }) as HTMLButtonElement[];
    expect(startButtons.filter((button) => button.disabled)).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex 工作位' }));
    expect(screen.getByRole('tab', { name: 'Codex 工作位' }).getAttribute('aria-selected')).toBe('true');
  });

  it('ends the loading state when capability probing fails but session listing succeeds', async () => {
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        if (method === 'workbench.probe') {
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '工作位请求失败', detail: 'probe crashed' },
          };
        }
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };

    render(<WorkbenchView />);
    await waitFor(() => expect(screen.getByText(/能力探测失败：工作位请求失败/)).toBeTruthy());
    expect(screen.getAllByText('能力探测失败，请查看上方原因')).toHaveLength(2);
    expect(screen.queryByText('正在检测本机引擎能力…')).toBeNull();
  });

  it('rejects a foreign project session from list and late session.updated events', async () => {
    const foreign = sessionView({ handle: 'handle-a', vendor: 'CODEX', projectId: 'project-a', displayName: 'A Codex' });
    let listener: ((event: WorkbenchEvent) => void) | null = null;
    const request = vi.fn(async (method) => {
      if (method === 'workbench.list') return { ok: true, data: { sessions: [foreign] } };
      if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
      if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
      throw new Error(`unexpected ${method}`);
    }) as WorkbenchBridge['request'];
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request,
      subscribe: (handler) => { listener = handler; return () => { }; },
    };

    render(<WorkbenchView projectId="project-b" />);
    await waitFor(() => expect(request).toHaveBeenCalledWith('workbench.list', { projectId: 'project-b' }));

    // 外项目会话既不渲染输入框，也不渲染它的名字
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('A Codex')).toBeNull();
    expect(request).not.toHaveBeenCalledWith('workbench.reconnect', expect.anything());
    act(() => listener?.({ kind: 'session.updated', session: foreign }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('A Codex')).toBeNull();
  });

  it('渲染同项目 N 个会话 pane、各自 agentState 徽标与本项目汇总', async () => {
    const s1 = sessionView({ handle: 'h1', vendor: 'CODEX', projectId: 'p', displayName: 'Codex 一', agentState: 'WORKING', status: 'RUNNING', activeRequestId: 'r1' });
    const s2 = sessionView({ handle: 'h2', vendor: 'CODEX', projectId: 'p', displayName: 'Codex 二', agentState: 'DONE' });
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method, payload) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [s1, s2] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
        if (method === 'workbench.reconnect') {
          const session = (payload as { handle: string }).handle === 'h1' ? s1 : s2;
          return { ok: true, data: { session, events: [], omitted: 0 } };
        }
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };

    render(<WorkbenchView projectId="p" />);
    await waitFor(() => expect(screen.getByText('Codex 一')).toBeTruthy());
    // 同 vendor 的两个会话都渲染（不再是每 vendor 只留一个）
    expect(screen.getByText('Codex 二')).toBeTruthy();
    expect(screen.getByText('工作中')).toBeTruthy();
    expect(screen.getByText('本轮完成')).toBeTruthy();
    // DONE 属于“等你处理”，出提示条
    expect(screen.getByText(/本轮已完成 —— 等你查看并决定下一步/)).toBeTruthy();
    expect(screen.getByText(/本项目 2 个会话 · 工作中 1 · 等你处理 1 · 已完成 1/)).toBeTruthy();
  });

  it('turn.waiting 事件渲染“等待批准”并声明不代答', async () => {
    const s1 = sessionView({ handle: 'h1', vendor: 'CLAUDE', projectId: 'p', displayName: 'Claude 一', agentState: 'BLOCKED_APPROVAL', status: 'RUNNING', activeRequestId: 'r1' });
    let listener: ((event: WorkbenchEvent) => void) | null = null;
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [s1] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
        if (method === 'workbench.reconnect') return { ok: true, data: { session: s1, events: [], omitted: 0 } };
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: (handler) => { listener = handler; return () => { }; },
    };

    render(<WorkbenchView projectId="p" />);
    await waitFor(() => expect(screen.getByText('Claude 一')).toBeTruthy());
    expect(screen.getByText('等你批准')).toBeTruthy();
    expect(screen.getByText(/RepoPilot 不代答/)).toBeTruthy();
    // BLOCKED 时输入框禁用（不能发新轮）
    expect((screen.getByRole('textbox', { name: '给 Claude 一 发送消息' }) as HTMLTextAreaElement).disabled).toBe(true);

    act(() => listener?.({
      kind: 'turn.waiting', handle: 'h1', connectionEpoch: 1, requestId: 'r1', turnId: 't1',
      sequence: 1, eventSequence: 1, reason: 'APPROVAL', label: '需要批准 X', replayed: false,
    }));
    await waitFor(() => expect(screen.getByText(/等待批准：需要批准 X/)).toBeTruthy());
  });

  it('跨项目注意力汇总：显示各项目待处理数，点非当前项目触发 onSelectProject', async () => {
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [] } };
        if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
        if (method === 'workbench.summary') {
          return {
            ok: true,
            data: {
              projects: [
                { projectId: 'p', counts: { ...EMPTY_COUNTS }, needsAttention: 0 },
                { projectId: 'other', counts: { ...EMPTY_COUNTS, WORKING: 1, BLOCKED_APPROVAL: 1, DONE: 1 }, needsAttention: 2 },
              ],
            },
          };
        }
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };
    const onSelectProject = vi.fn();
    render(<WorkbenchView projectId="p" onSelectProject={onSelectProject} />);

    const otherChip = await screen.findByRole('button', { name: /other · 2 待处理/ });
    expect(otherChip).toBeTruthy();
    // 当前项目 chip 不可点（disabled），不触发切换
    const currentChip = screen.getByRole('button', { name: /^p · 无待处理/ });
    expect((currentChip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(otherChip);
    expect(onSelectProject).toHaveBeenCalledWith('other');
  });

  it('renders Core role and budget projections plus managed-session failure detail', async () => {
    const failedSession = sessionView({
      handle: 'handle-b',
      vendor: 'CODEX',
      projectId: 'project-b',
      displayName: 'B Codex',
      status: 'ERROR',
      agentState: 'ERROR',
      connectionEpoch: 2,
      error: 'transport disconnected: socket closed',
    });
    window.repopilotWorkbench = {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      request: vi.fn(async (method) => {
        if (method === 'workbench.list') return { ok: true, data: { sessions: [failedSession] } };
        if (method === 'workbench.summary') return { ok: true, data: { projects: [] } };
        if (method === 'workbench.probe') return { ok: true, data: { capabilities: [] } };
        if (method === 'workbench.reconnect') {
          return { ok: true, data: { session: failedSession, events: [], omitted: 0 } };
        }
        throw new Error(`unexpected ${method}`);
      }) as WorkbenchBridge['request'],
      subscribe: () => () => { },
    };
    const run: RunView = {
      runId: 'run-b',
      taskId: 'task-b',
      projectId: 'project-b',
      snapshotId: 'snap-b',
      title: '修复构建失败',
      attemptId: 'attempt-b',
      attemptNo: 2,
      status: 'CROSS_REVIEWING',
      statusReason: null,
      ledger: {
        modelTurns: 5,
        toolCalls: 7,
        selfFixRounds: 1,
        elapsedMs: 12_400,
        inputTokens: 120,
        outputTokens: 30,
        unknownUsageTurns: 2,
      },
      limits: {
        maxModelTurns: 12,
        maxToolCalls: 20,
        maxSelfFixRounds: 2,
        maxWallClockMs: 60_000,
        maxTotalTokens: 1_000,
      },
      workspaceGeneration: 3,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:10.000Z',
      terminalFacts: null,
      collaborationProjection: {
        roles: [
          { role: 'PLANNER', executionKind: 'MODEL_API', label: 'Planner A' },
          { role: 'IMPLEMENTER', executionKind: 'MODEL_API', label: 'Implementer A' },
          { role: 'REVIEWER', executionKind: 'MANAGED_ENGINE', label: 'Reviewer B' },
        ],
        cycleId: 'cycle-2',
        currentCycle: { reviewerInvocations: 1, remediations: 0 },
        taskTotals: { reviewerInvocations: 3, remediations: 1 },
      },
      restored: false,
      evidence: 'INTACT',
      evidenceDetail: null,
    };

    render(
      <WorkbenchView
        projectId="project-b"
        run={run}
        detail={{ events: [], toolCalls: [], approvals: [], plan: null, patch: null, priorPatches: [], verifications: [] }}
        approvalAction={{} as never}
        onError={() => { }}
        onRefresh={() => { }}
      />,
    );

    expect(await screen.findByText('transport disconnected: socket closed')).toBeTruthy();
    expect(screen.getByText('构建自修复 1/2')).toBeTruthy();
    expect(screen.getByText(/本循环评审 1\/2/)).toBeTruthy();
    expect(screen.getByText(/Task 累计：模型 5\/12/)).toBeTruthy();
    expect(screen.getByText(/2 轮用量未知/)).toBeTruthy();
    expect(screen.getByText(/审核累计 3 · 整改累计 1 · cycle cycle-2/)).toBeTruthy();
    expect(screen.getByText('REVIEWER：Reviewer B（MANAGED_ENGINE）')).toBeTruthy();
    expect(screen.getByText('任务工件与 Core 当前动作')).toBeTruthy();
  });
});
