import { describeDlpHits, scanText } from '@shared/dlp';
import type {
  WorkbenchAgentState,
  WorkbenchEngineCapability,
  WorkbenchEvent,
  WorkbenchSessionView,
  WorkbenchVendor,
} from '@shared/workbenchProtocol';
import { randomUUID } from 'node:crypto';
import type { AdapterEvent, WorkbenchAgentAdapter, WorkbenchSessionRecord } from './adapter';

const MAX_REPLAY_EVENTS = 500;
type BufferedWorkbenchEvent = Exclude<WorkbenchEvent, { readonly kind: 'session.updated' }>;
type UnsequencedWorkbenchEvent = BufferedWorkbenchEvent extends infer Event
  ? Event extends BufferedWorkbenchEvent
  ? Omit<Event, 'eventSequence' | 'replayed'>
  : never
  : never;

export class WorkbenchError extends Error {
  constructor(
    readonly code:
      | 'CAPABILITY_UNAVAILABLE'
      | 'UNKNOWN_SESSION'
      | 'PROJECT_MISMATCH'
      | 'STALE_EPOCH'
      | 'DUPLICATE_REQUEST'
      | 'SESSION_BUSY'
      | 'OUTCOME_UNKNOWN'
      | 'DATA_EGRESS_BLOCKED',
    message: string,
  ) {
    super(message);
  }
}

export class WorkbenchService {
  private readonly adapters = new Map<WorkbenchVendor, WorkbenchAgentAdapter>();
  private readonly sessions = new Map<string, WorkbenchSessionRecord>();

  constructor(
    adapters: readonly WorkbenchAgentAdapter[],
    private readonly emit: (event: WorkbenchEvent) => void,
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.vendor, adapter);
  }

  async probe(vendor?: WorkbenchVendor): Promise<readonly WorkbenchEngineCapability[]> {
    const selected = vendor ? [this.adapters.get(vendor)].filter(Boolean) : [...this.adapters.values()];
    return Promise.all(selected.map((adapter) => adapter!.probe()));
  }

  async start(vendor: WorkbenchVendor, projectId: string | null): Promise<WorkbenchSessionView> {
    const adapter = this.adapters.get(vendor);
    if (!adapter) throw new WorkbenchError('CAPABILITY_UNAVAILABLE', `${vendor} 工作位未注册`);
    const capability = await adapter.probe();
    if (capability.credentialConfigured.verdict !== 'SUPPORTED') {
      throw new WorkbenchError(
        'CAPABILITY_UNAVAILABLE',
        capability.credentialConfigured.reason ?? `${vendor} 未配置工作位凭据`,
      );
    }
    if (capability.versionSupported.verdict !== 'SUPPORTED') {
      throw new WorkbenchError(
        'CAPABILITY_UNAVAILABLE',
        capability.versionSupported.reason ?? `${vendor} 版本尚未通过兼容性验证`,
      );
    }
    if (capability.createSession.verdict !== 'SUPPORTED') {
      throw new WorkbenchError(
        'CAPABILITY_UNAVAILABLE',
        capability.createSession.reason ?? `${vendor} 新会话能力尚未验证`,
      );
    }
    const session = await adapter.start({ projectId });
    const handle = `wkb_${randomUUID()}`;
    const view: WorkbenchSessionView = {
      handle,
      vendor,
      source: 'MANAGED_NEW_SESSION',
      displayName: `${vendor === 'CODEX' ? 'Codex' : 'Claude'} · 新建受管会话`,
      projectId,
      status: 'READY',
      agentState: 'IDLE',
      connectionEpoch: 1,
      activeRequestId: null,
      vendorSessionIdKnown: session.vendorSessionId.length > 0,
      lastEventSequence: 0,
      error: null,
    };
    this.sessions.set(handle, {
      view,
      adapter,
      session,
      seenRequests: new Set(),
      sequenceByRequest: new Map(),
      eventBuffer: [],
      nextEventSequence: 0,
      omittedEventCount: 0,
    });
    this.emit({ kind: 'session.updated', session: view });
    return view;
  }

  list(projectId: string | null): readonly WorkbenchSessionView[] {
    return [...this.sessions.values()]
      .map((record) => record.view)
      .filter((view) => view.projectId === projectId);
  }

  /**
   * 跨项目的只读状态汇总（herdr 侧栏的“哪个 workspace 需要你处理”）。
   * 只回计数，不回 handle 之外的内容/事件 —— 跨项目只汇总数字，不串内容（项目隔离不破）。
   * needsAttention = BLOCKED_APPROVAL + BLOCKED_INPUT + DONE（herdr 的 blocked + done）。
   */
  summary(): ReadonlyArray<{
    projectId: string | null;
    counts: Record<WorkbenchAgentState, number>;
    needsAttention: number;
  }> {
    const byProject = new Map<string | null, Record<WorkbenchAgentState, number>>();
    for (const record of this.sessions.values()) {
      const pid = record.view.projectId;
      let counts = byProject.get(pid);
      if (!counts) {
        counts = { IDLE: 0, WORKING: 0, BLOCKED_APPROVAL: 0, BLOCKED_INPUT: 0, DONE: 0, DISCONNECTED: 0, ERROR: 0 };
        byProject.set(pid, counts);
      }
      counts[record.view.agentState] += 1;
    }
    return [...byProject.entries()].map(([projectId, counts]) => ({
      projectId,
      counts,
      needsAttention: counts.BLOCKED_APPROVAL + counts.BLOCKED_INPUT + counts.DONE,
    }));
  }

  reconnect(input: {
    handle: string;
    connectionEpoch: number;
    projectId: string | null;
    afterEventSequence: number;
  }): { session: WorkbenchSessionView; events: readonly WorkbenchEvent[]; omitted: number } {
    const record = this.require(input.handle, input.connectionEpoch, input.projectId);
    const nextEpoch = record.view.connectionEpoch + 1;
    record.view = { ...record.view, connectionEpoch: nextEpoch };
    const firstRetained = record.eventBuffer[0]?.eventSequence ?? record.nextEventSequence + 1;
    const omitted = Math.max(0, firstRetained - input.afterEventSequence - 1);
    const events = record.eventBuffer
      .filter((event) => event.eventSequence > input.afterEventSequence)
      .map((event) => ({ ...event, connectionEpoch: nextEpoch, replayed: true }));
    this.emit({ kind: 'session.updated', session: record.view });
    return { session: record.view, events, omitted };
  }

  async send(input: {
    handle: string;
    connectionEpoch: number;
    projectId: string | null;
    requestId: string;
    text: string;
  }): Promise<void> {
    const record = this.require(input.handle, input.connectionEpoch, input.projectId);
    if (record.view.status !== 'READY') {
      const blocked = record.view.agentState === 'BLOCKED_APPROVAL' || record.view.agentState === 'BLOCKED_INPUT';
      throw new WorkbenchError(
        record.view.status === 'RUNNING' || record.view.status === 'INTERRUPT_REQUESTED'
          ? 'SESSION_BUSY'
          : 'OUTCOME_UNKNOWN',
        record.view.status === 'ERROR' || record.view.status === 'DISCONNECTED'
          ? '上一轮结果尚未对账；请停止该会话并重新建立连接'
          : blocked
            ? '该会话正等待你在它自己的工具里应答（BLOCKED），本轮未结束，不能发新轮'
            : `该工作位当前不可发送（${record.view.status}）`,
      );
    }
    if (record.seenRequests.has(input.requestId)) {
      throw new WorkbenchError('DUPLICATE_REQUEST', '该 requestId 已提交，平台不会自动重发');
    }
    if (record.view.activeRequestId !== null) {
      throw new WorkbenchError('SESSION_BUSY', '该工作位仍有一轮未对账');
    }
    /*
     * 用户工作位不是 Core Task consent 的延伸，但正文仍会离开本机。沿用同一套
     * 高置信度凭据扫描，在 adapter 接收任何字节之前整笔拒绝，且错误不回显原文。
     */
    const dlpHits = scanText(input.text, 'workbench.input');
    if (dlpHits.length > 0) {
      throw new WorkbenchError('DATA_EGRESS_BLOCKED', describeDlpHits(dlpHits));
    }
    record.seenRequests.add(input.requestId);
    record.sequenceByRequest.set(input.requestId, 0);
    this.update(record, { status: 'RUNNING', agentState: 'WORKING', activeRequestId: input.requestId, error: null });
    this.publish(record, {
      kind: 'turn.input_accepted',
      handle: record.view.handle,
      connectionEpoch: record.view.connectionEpoch,
      requestId: input.requestId,
      text: input.text,
    });
    try {
      // Adapter 的 Promise 只确认输入已被该受管会话接受；正文与终态继续走 onEvent。
      await record.session.send({
        requestId: input.requestId,
        text: input.text,
        onEvent: (event) => this.acceptAdapterEvent(record, input.requestId, event),
      });
    } catch (error) {
      // send 抛错时不能知道字节是否已经离开子进程边界，因此保持 unknown，禁止重发。
      this.update(record, {
        status: 'ERROR',
        agentState: 'ERROR',
        activeRequestId: null,
        error: `发送结果未知：${(error as Error).message}`,
      });
      throw new WorkbenchError('OUTCOME_UNKNOWN', '发送结果未知；请先重新连接并对账');
    }
  }

  async interrupt(handle: string, epoch: number, projectId: string | null, requestId: string): Promise<void> {
    const record = this.require(handle, epoch, projectId);
    if (record.view.activeRequestId !== requestId) {
      throw new WorkbenchError('OUTCOME_UNKNOWN', '中断目标不是当前活动请求');
    }
    this.update(record, { status: 'INTERRUPT_REQUESTED' });
    await record.session.interrupt(requestId);
    // interrupt 的返回只表示请求已送达；最终状态只能由 finished/退出事件确认。
  }

  async dispose(handle: string, epoch: number, projectId: string | null): Promise<void> {
    const record = this.require(handle, epoch, projectId);
    await record.session.dispose();
    this.update(record, { status: 'CLOSED', activeRequestId: null });
    this.sessions.delete(handle);
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((record) => record.session.dispose()));
    this.sessions.clear();
  }

  private acceptAdapterEvent(
    record: WorkbenchSessionRecord,
    requestId: string,
    event: AdapterEvent,
  ): void {
    if (record.view.activeRequestId !== requestId) return;
    const last = record.sequenceByRequest.get(requestId) ?? 0;
    if (event.sequence <= last) return;
    if (event.sequence !== last + 1) {
      this.update(record, {
        status: 'ERROR',
        agentState: 'ERROR',
        activeRequestId: null,
        error: `事件序列缺口：期望 ${last + 1}，收到 ${event.sequence}`,
      });
      return;
    }
    record.sequenceByRequest.set(requestId, event.sequence);
    if (event.kind === 'disconnected') {
      this.update(record, { status: 'DISCONNECTED', agentState: 'DISCONNECTED', activeRequestId: null, error: event.reason });
      return;
    }
    const common = {
      handle: record.view.handle,
      connectionEpoch: record.view.connectionEpoch,
      requestId,
      turnId: event.turnId,
      sequence: event.sequence,
    } as const;
    if (event.kind === 'text') {
      this.publish(record, { kind: 'turn.text_delta', ...common, text: event.text });
      if (record.view.agentState !== 'WORKING') this.update(record, { agentState: 'WORKING' });
    } else if (event.kind === 'activity') {
      this.publish(record, { kind: 'turn.activity', ...common, label: event.label });
      if (record.view.agentState !== 'WORKING') this.update(record, { agentState: 'WORKING' });
    } else if (event.kind === 'waiting') {
      /*
       * herdr 式 blocked：本轮**未结束** —— 不清 activeRequestId、不置 READY（与 finished 区分）。
       * 只呈现“谁在等你答话”，不代答；用户在会话自己的工具里应答后，引擎恢复流出 text/activity
       * 会把状态带回 WORKING（见上面两个分支）。
       */
      this.publish(record, { kind: 'turn.waiting', ...common, reason: event.reason, label: event.label });
      this.update(record, { agentState: event.reason === 'APPROVAL' ? 'BLOCKED_APPROVAL' : 'BLOCKED_INPUT' });
    } else {
      this.publish(record, { kind: 'turn.finished', ...common, outcome: event.outcome, reason: event.reason });
      const failed = event.outcome === 'FAILED' || event.outcome === 'UNKNOWN';
      this.update(record, {
        status: failed ? 'ERROR' : 'READY',
        // COMPLETED → DONE（等用户下一步）；INTERRUPTED → IDLE；FAILED/UNKNOWN → ERROR
        agentState: failed ? 'ERROR' : event.outcome === 'COMPLETED' ? 'DONE' : 'IDLE',
        activeRequestId: null,
        error: failed ? event.reason : null,
      });
    }
  }

  private require(handle: string, epoch: number, projectId: string | null): WorkbenchSessionRecord {
    const record = this.sessions.get(handle);
    if (!record) throw new WorkbenchError('UNKNOWN_SESSION', '工作位会话不存在或已经关闭');
    if (record.view.projectId !== projectId) {
      throw new WorkbenchError('PROJECT_MISMATCH', '工作位会话不属于当前项目');
    }
    if (record.view.connectionEpoch !== epoch) throw new WorkbenchError('STALE_EPOCH', '工作位连接代次已变化');
    return record;
  }

  private update(record: WorkbenchSessionRecord, patch: Partial<WorkbenchSessionView>): void {
    record.view = { ...record.view, ...patch };
    this.emit({ kind: 'session.updated', session: record.view });
  }

  private publish(
    record: WorkbenchSessionRecord,
    input: UnsequencedWorkbenchEvent,
  ): void {
    const event = {
      ...input,
      eventSequence: ++record.nextEventSequence,
      replayed: false,
    } as BufferedWorkbenchEvent;
    record.eventBuffer.push(event);
    if (record.eventBuffer.length > MAX_REPLAY_EVENTS) {
      const removed = record.eventBuffer.splice(0, record.eventBuffer.length - MAX_REPLAY_EVENTS);
      record.omittedEventCount += removed.length;
    }
    record.view = { ...record.view, lastEventSequence: event.eventSequence };
    this.emit(event);
  }
}
