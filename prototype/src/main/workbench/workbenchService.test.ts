import type { WorkbenchEngineCapability, WorkbenchEvent } from '@shared/workbenchProtocol';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterEvent, ManagedEngineSession, WorkbenchAgentAdapter } from './adapter';
import { WorkbenchError, WorkbenchService } from './workbenchService';

const evidence = (verdict: 'SUPPORTED' | 'UNKNOWN', reason: string | null = null) => ({
  verdict,
  checkedAt: '2026-09-15T00:00:00.000Z',
  evidence: verdict === 'SUPPORTED' ? ['fixture transport'] : [],
  reason,
});

function capability(): WorkbenchEngineCapability {
  return {
    vendor: 'CODEX',
    installed: evidence('SUPPORTED'),
    versionSupported: evidence('SUPPORTED'),
    transport: evidence('SUPPORTED'),
    credentialConfigured: evidence('SUPPORTED'),
    authenticated: evidence('UNKNOWN', 'fixture 不验证认证'),
    createSession: evidence('SUPPORTED'),
    readStoredHistory: evidence('UNKNOWN'),
    attachLive: evidence('UNKNOWN', '新建会话不证明 Desktop attach'),
    interrupt: evidence('SUPPORTED'),
    readOnlyReviewIsolation: evidence('UNKNOWN'),
    version: 'fixture-1',
    source: 'PATH',
  };
}

function setup(sendImpl?: (onEvent: (event: AdapterEvent) => void) => Promise<void>) {
  const events: WorkbenchEvent[] = [];
  const session: ManagedEngineSession = {
    vendorSessionId: 'vendor-session-1',
    send: vi.fn(async ({ onEvent }) => {
      if (sendImpl) return sendImpl(onEvent);
      onEvent({ kind: 'text', turnId: 'turn-1', sequence: 1, text: '你' });
      onEvent({ kind: 'text', turnId: 'turn-1', sequence: 2, text: '好' });
      onEvent({ kind: 'finished', turnId: 'turn-1', sequence: 3, outcome: 'COMPLETED', reason: null });
    }),
    interrupt: vi.fn(async () => { }),
    dispose: vi.fn(async () => { }),
  };
  const adapter: WorkbenchAgentAdapter = {
    vendor: 'CODEX',
    probe: vi.fn(async () => capability()),
    start: vi.fn(async () => session),
  };
  return { events, session, service: new WorkbenchService([adapter], (event) => events.push(event)) };
}

describe('WorkbenchService', () => {
  it('binds events to the opaque handle, request, turn and epoch', async () => {
    const { service, events } = setup();
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-1', text: 'hello' });
    expect(events.filter((event) => event.kind === 'turn.text_delta')).toEqual([
      expect.objectContaining({ requestId: 'request-1', turnId: 'turn-1', sequence: 1, text: '你' }),
      expect.objectContaining({ requestId: 'request-1', turnId: 'turn-1', sequence: 2, text: '好' }),
    ]);
    expect(service.list(null)[0]).toMatchObject({ status: 'READY', activeRequestId: null });
  });

  it('rejects duplicate requests and never invokes the adapter twice', async () => {
    const { service, session } = setup();
    const view = await service.start('CODEX', null);
    const input = { handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-1', text: 'hello' };
    await service.send(input);
    await expect(service.send(input)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('未知版本即使声明可建会话也不得启动 adapter', async () => {
    const events: WorkbenchEvent[] = [];
    const start = vi.fn();
    const unsupported: WorkbenchAgentAdapter = {
      vendor: 'CODEX',
      probe: vi.fn(async () => ({
        ...capability(),
        versionSupported: evidence('UNKNOWN', '版本未进入兼容配对'),
      })),
      start,
    };
    const service = new WorkbenchService([unsupported], (event) => events.push(event));

    await expect(service.start('CODEX', null)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails closed on gaps and ignores replayed or late events', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service, events } = setup(async (onEvent) => {
      emit = onEvent;
      onEvent({ kind: 'text', turnId: 'turn-gap', sequence: 2, text: 'out of order' });
    });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-gap', text: 'hello' });
    expect(service.list(null)[0]).toMatchObject({ status: 'ERROR', error: expect.stringContaining('事件序列缺口') });
    emit!({ kind: 'finished', turnId: 'turn-gap', sequence: 3, outcome: 'COMPLETED', reason: null });
    expect(events.some((event) => event.kind === 'turn.finished')).toBe(false);
  });

  it('separates interrupt acknowledgement from terminal interruption', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service } = setup(async (onEvent) => { emit = onEvent; });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-1', text: 'hello' });
    expect(service.list(null)[0]?.status).toBe('RUNNING');
    await service.interrupt(view.handle, 1, null, 'request-1');
    expect(service.list(null)[0]?.status).toBe('INTERRUPT_REQUESTED');
    emit!({ kind: 'finished', turnId: 'turn-1', sequence: 1, outcome: 'INTERRUPTED', reason: null });
    expect(service.list(null)[0]?.status).toBe('READY');
  });

  it('acknowledges send before streamed deltas and turn.finished arrive', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service, events } = setup(async (onEvent) => { emit = onEvent; });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-stream', text: 'hello' });
    expect(events.some((event) => event.kind === 'turn.finished')).toBe(false);
    expect(service.list(null)[0]?.status).toBe('RUNNING');
    emit!({ kind: 'text', turnId: 'turn-stream', sequence: 1, text: 'delta' });
    emit!({ kind: 'finished', turnId: 'turn-stream', sequence: 2, outcome: 'COMPLETED', reason: null });
    expect(events.some((event) => event.kind === 'turn.text_delta')).toBe(true);
    expect(events.some((event) => event.kind === 'turn.finished')).toBe(true);
  });

  it('marks adapter throw as unknown outcome and blocks stale epochs', async () => {
    const { service, session } = setup(async () => { throw new Error('pipe closed'); });
    const view = await service.start('CODEX', null);
    await expect(
      service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-1', text: 'hello' }),
    ).rejects.toBeInstanceOf(WorkbenchError);
    expect(session.send).toHaveBeenCalledTimes(1);
    await expect(
      service.send({ handle: view.handle, connectionEpoch: 0, projectId: null, requestId: 'request-2', text: 'retry' }),
    ).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await expect(
      service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-2', text: 'retry' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('blocks high-confidence credentials before the adapter receives input', async () => {
    const { service, session } = setup();
    const view = await service.start('CODEX', null);
    await expect(
      service.send({
        handle: view.handle,
        connectionEpoch: 1,
        projectId: null,
        requestId: 'request-secret',
        text: 'fixture AWS token AKIAIOSFODNN7EXAMPLE',
      }),
    ).rejects.toMatchObject({ code: 'DATA_EGRESS_BLOCKED' });
    expect(session.send).not.toHaveBeenCalled();
  });

  it('replays bounded conversation events under a new connection epoch', async () => {
    const { service } = setup();
    const view = await service.start('CODEX', 'project-1');
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: 'project-1', requestId: 'request-1', text: 'hello' });

    const replay = service.reconnect({ handle: view.handle, connectionEpoch: 1, projectId: 'project-1', afterEventSequence: 0 });
    expect(replay.session).toMatchObject({ connectionEpoch: 2, projectId: 'project-1', lastEventSequence: 4 });
    expect(replay.events.map((event) => event.kind)).toEqual([
      'turn.input_accepted',
      'turn.text_delta',
      'turn.text_delta',
      'turn.finished',
    ]);
    expect(replay.events.every((event) => event.kind === 'session.updated' || event.replayed)).toBe(true);
    await expect(
      service.send({ handle: view.handle, connectionEpoch: 1, projectId: 'project-1', requestId: 'stale', text: 'stale' }),
    ).rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });

  it('reports how many old events were omitted by the replay bound', async () => {
    const { service } = setup(async (onEvent) => {
      for (let sequence = 1; sequence <= 501; sequence += 1) {
        onEvent({ kind: 'text', turnId: 'turn-many', sequence, text: 'x' });
      }
      onEvent({ kind: 'finished', turnId: 'turn-many', sequence: 502, outcome: 'COMPLETED', reason: null });
    });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'request-many', text: 'hello' });

    const replay = service.reconnect({ handle: view.handle, connectionEpoch: 1, projectId: null, afterEventSequence: 0 });
    expect(replay.events).toHaveLength(500);
    expect(replay.omitted).toBe(3);
    expect(replay.events[0]).toMatchObject({ eventSequence: 4, replayed: true });
  });

  it('拒绝用项目 B 上下文发送到项目 A 的受管会话', async () => {
    const { service, session } = setup();
    const view = await service.start('CODEX', 'project-a');

    await expect(service.send({
      handle: view.handle,
      connectionEpoch: 1,
      projectId: 'project-b',
      requestId: 'cross-project',
      text: 'hello',
    })).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    expect(session.send).not.toHaveBeenCalled();
    expect(service.list('project-b')).toEqual([]);
    expect(service.list('project-a')).toHaveLength(1);
  });

  it('派生 herdr 式 agentState：IDLE→WORKING→BLOCKED→WORKING→DONE，blocked 期间拒发新轮', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service } = setup(async (onEvent) => { emit = onEvent; });
    const view = await service.start('CODEX', null);
    expect(service.list(null)[0]?.agentState).toBe('IDLE');

    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'r1', text: 'hello' });
    expect(service.list(null)[0]?.agentState).toBe('WORKING');

    // waiting：本轮未结束 —— 置 BLOCKED，但不清 activeRequestId、不置 READY
    emit!({ kind: 'waiting', turnId: 't1', sequence: 1, reason: 'APPROVAL', label: '需要批准' });
    expect(service.list(null)[0]).toMatchObject({ agentState: 'BLOCKED_APPROVAL', status: 'RUNNING', activeRequestId: 'r1' });

    // blocked 期间发新轮被拒（与待答请求打架）
    await expect(
      service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'r2', text: 'again' }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    // 用户在自己的工具里应答后，引擎恢复流出 text → 回到 WORKING
    emit!({ kind: 'text', turnId: 't1', sequence: 2, text: '继续' });
    expect(service.list(null)[0]?.agentState).toBe('WORKING');

    emit!({ kind: 'finished', turnId: 't1', sequence: 3, outcome: 'COMPLETED', reason: null });
    expect(service.list(null)[0]).toMatchObject({ agentState: 'DONE', status: 'READY', activeRequestId: null });
  });

  it('waiting=INPUT → BLOCKED_INPUT；FAILED → ERROR；断开 → DISCONNECTED', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service } = setup(async (onEvent) => { emit = onEvent; });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'r1', text: 'hello' });
    emit!({ kind: 'waiting', turnId: 't1', sequence: 1, reason: 'INPUT', label: '需要输入' });
    expect(service.list(null)[0]).toMatchObject({ agentState: 'BLOCKED_INPUT', activeRequestId: 'r1' });
    emit!({ kind: 'finished', turnId: 't1', sequence: 2, outcome: 'FAILED', reason: 'boom' });
    expect(service.list(null)[0]).toMatchObject({ agentState: 'ERROR', status: 'ERROR' });
  });

  it('INTERRUPTED 收尾回到 IDLE（不是 DONE）', async () => {
    let emit: ((event: AdapterEvent) => void) | null = null;
    const { service } = setup(async (onEvent) => { emit = onEvent; });
    const view = await service.start('CODEX', null);
    await service.send({ handle: view.handle, connectionEpoch: 1, projectId: null, requestId: 'r1', text: 'hello' });
    emit!({ kind: 'finished', turnId: 't1', sequence: 1, outcome: 'INTERRUPTED', reason: null });
    expect(service.list(null)[0]).toMatchObject({ agentState: 'IDLE', status: 'READY' });
  });

  it('同项目多会话各自独立记账，互不串扰（N pane）', async () => {
    const { service } = setup();
    const a = await service.start('CODEX', 'project-a');
    const b = await service.start('CODEX', 'project-a');
    expect(a.handle).not.toBe(b.handle);
    await service.send({ handle: a.handle, connectionEpoch: 1, projectId: 'project-a', requestId: 'ra', text: 'hi' });
    const listed = service.list('project-a');
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.handle === a.handle)?.agentState).toBe('DONE');
    expect(listed.find((s) => s.handle === b.handle)?.agentState).toBe('IDLE');
  });

  it('summary() 跨项目按 agentState 计数，needsAttention=blocked+done，且只回计数不回内容', async () => {
    const { service } = setup();
    const a = await service.start('CODEX', 'project-a');
    await service.start('CODEX', 'project-a');
    const bView = await service.start('CODEX', 'project-b');
    await service.send({ handle: a.handle, connectionEpoch: 1, projectId: 'project-a', requestId: 'ra', text: 'hi' });

    const summary = service.summary();
    const rowA = summary.find((row) => row.projectId === 'project-a')!;
    const rowB = summary.find((row) => row.projectId === 'project-b')!;
    expect(rowA.counts.DONE).toBe(1);
    expect(rowA.counts.IDLE).toBe(1);
    expect(rowA.needsAttention).toBe(1);
    expect(rowB.counts.IDLE).toBe(1);
    expect(rowB.needsAttention).toBe(0);
    // 只回计数：不含 handle / 文本 / 事件（跨项目不串内容）
    expect(Object.keys(rowA).sort()).toEqual(['counts', 'needsAttention', 'projectId']);
    expect(JSON.stringify(summary)).not.toContain(bView.handle);
  });
});
