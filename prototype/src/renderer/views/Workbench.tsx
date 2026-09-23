import type { RunView } from '@shared/domain';
import type {
  WorkbenchAgentState,
  WorkbenchEngineCapability,
  WorkbenchEvent,
  WorkbenchSessionView,
  WorkbenchVendor,
} from '@shared/workbenchProtocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, Card } from '../components/common';
import type { ApprovalActionController } from '../useApprovalAction';
import type { RunDetailData } from '../useRendererOrchestration';
import { workbenchCall, workbenchSubscribe } from '../workbenchBridge';
import { RunDetail } from './RunDetail';

type PaneMessage = { readonly id: string; readonly role: 'USER' | 'AGENT' | 'SYSTEM'; readonly text: string };
type SequencedWorkbenchEvent = Exclude<WorkbenchEvent, { readonly kind: 'session.updated' }>;
type SummaryRow = { readonly projectId: string | null; readonly counts: Record<WorkbenchAgentState, number>; readonly needsAttention: number };

/** herdr 式 agent 状态的人读标签与徽标色。状态同时有文字，不只靠颜色（可访问性）。 */
const AGENT_STATE_LABEL: Record<WorkbenchAgentState, string> = {
  IDLE: '空闲',
  WORKING: '工作中',
  BLOCKED_APPROVAL: '等你批准',
  BLOCKED_INPUT: '等你输入',
  DONE: '本轮完成',
  DISCONNECTED: '已断开',
  ERROR: '出错',
};
const AGENT_STATE_TONE: Record<WorkbenchAgentState, 'default' | 'ok' | 'warn' | 'err'> = {
  IDLE: 'default',
  WORKING: 'ok',
  BLOCKED_APPROVAL: 'warn',
  BLOCKED_INPUT: 'warn',
  DONE: 'warn',
  DISCONNECTED: 'err',
  ERROR: 'err',
};
/** herdr 的“需要你处理” = blocked（等批准/等输入）+ done（本轮完成待查看）。 */
const NEEDS_ATTENTION: readonly WorkbenchAgentState[] = ['BLOCKED_APPROVAL', 'BLOCKED_INPUT', 'DONE'];

export function projectWorkbenchMessages(events: readonly SequencedWorkbenchEvent[]): readonly PaneMessage[] {
  const pane: PaneMessage[] = [];
  for (const event of [...events].sort((left, right) => left.eventSequence - right.eventSequence)) {
    if (event.kind === 'turn.input_accepted') {
      if (!pane.some((message) => message.id === `${event.requestId}:user`)) {
        pane.push({ id: `${event.requestId}:user`, role: 'USER', text: event.text });
      }
    } else if (event.kind === 'turn.text_delta') {
      const id = `${event.requestId}:agent`;
      const index = pane.findIndex((message) => message.id === id);
      if (index >= 0) pane[index] = { ...pane[index]!, text: `${pane[index]!.text}${event.text}` };
      else pane.push({ id, role: 'AGENT', text: event.text });
    } else if (event.kind === 'turn.activity') {
      pane.push({ id: `${event.requestId}:activity:${event.sequence}`, role: 'SYSTEM', text: event.label });
    } else if (event.kind === 'turn.waiting') {
      // herdr 式 blocked：只呈现“谁在等你答话”，不代答（应答发生在会话自己的工具里）
      pane.push({
        id: `${event.requestId}:waiting:${event.sequence}`,
        role: 'SYSTEM',
        text: `等待${event.reason === 'APPROVAL' ? '批准' : '输入'}：${event.label}`,
      });
    } else {
      pane.push({
        id: `${event.requestId}:finished`,
        role: 'SYSTEM',
        text: event.outcome === 'COMPLETED'
          ? '本轮已结束'
          : `本轮结束：${event.outcome}${event.reason ? ` · ${event.reason}` : ''}`,
      });
    }
  }
  return pane;
}

export function WorkbenchView({
  projectId = null,
  run = null,
  detail = null,
  approvalAction,
  onError,
  onRefresh,
  onOpenDiff,
  onSelectProject,
}: {
  projectId?: string | null;
  run?: RunView | null;
  detail?: RunDetailData | null;
  approvalAction?: ApprovalActionController;
  onError?: (error: unknown) => void;
  onRefresh?: () => void;
  onOpenDiff?: (file: { path: string; diff: string; truncated: boolean }) => void;
  /** 切换项目（herdr 侧栏点另一个 workspace）；不提供时跨项目汇总只读、不可点。 */
  onSelectProject?: (projectId: string | null) => void;
}) {
  const [capabilities, setCapabilities] = useState<readonly WorkbenchEngineCapability[]>([]);
  const [sessions, setSessions] = useState<readonly WorkbenchSessionView[]>([]);
  const [eventsByHandle, setEventsByHandle] = useState<Readonly<Record<string, readonly SequencedWorkbenchEvent[]>>>({});
  const [omittedByHandle, setOmittedByHandle] = useState<Readonly<Record<string, number>>>({});
  // 草稿按 handle 存（同一 vendor 可有多个会话），不再按 vendor 存
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [activeVendor, setActiveVendor] = useState<WorkbenchVendor>('CLAUDE');
  const [error, setError] = useState<string | null>(null);
  const [probeFinished, setProbeFinished] = useState(false);
  const [startingVendor, setStartingVendor] = useState<WorkbenchVendor | null>(null);
  const [summary, setSummary] = useState<readonly SummaryRow[]>([]);
  const ownedHandles = useRef(new Set<string>());
  const epochByHandle = useRef(new Map<string, number>());
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // 跨项目只读汇总：只取计数，不取内容（项目隔离不破）。失败或畸形响应都静默降级为空侧栏，
  // 绝不让一个意外的 shape 把整个主区渲染成白屏。
  const refreshSummary = useCallback(() => {
    workbenchCall('workbench.summary', {})
      .then((result) => setSummary(Array.isArray(result.projects) ? result.projects : []))
      .catch(() => setSummary([]));
  }, []);

  const acceptEvent = useCallback((event: WorkbenchEvent) => {
    if (event.kind === 'session.updated') {
      // 任何项目的会话状态变化都可能改动跨项目计数，先刷新汇总再按项目过滤
      refreshSummary();
      if (event.session.projectId !== projectId) return;
      if (event.session.status === 'CLOSED') {
        ownedHandles.current.delete(event.session.handle);
        epochByHandle.current.delete(event.session.handle);
      } else {
        ownedHandles.current.add(event.session.handle);
        epochByHandle.current.set(event.session.handle, event.session.connectionEpoch);
      }
      setSessions((current) => {
        const rest = current.filter((session) => session.handle !== event.session.handle);
        return event.session.status === 'CLOSED' ? rest : [...rest, event.session];
      });
      return;
    }
    if (!ownedHandles.current.has(event.handle)) return;
    if (epochByHandle.current.get(event.handle) !== event.connectionEpoch) return;
    setEventsByHandle((current) => {
      const existing = current[event.handle] ?? [];
      if (existing.some((item) => item.eventSequence === event.eventSequence)) return current;
      return {
        ...current,
        [event.handle]: [...existing, event].sort(
          (left, right) => left.eventSequence - right.eventSequence,
        ),
      };
    });
  }, [projectId, refreshSummary]);

  useEffect(() => {
    let active = true;
    setSessions([]);
    setEventsByHandle({});
    setOmittedByHandle({});
    setDrafts({});
    setError(null);
    setStartingVendor(null);
    ownedHandles.current.clear();
    epochByHandle.current.clear();
    refreshSummary();
    const unsubscribe = workbenchSubscribe((event: WorkbenchEvent) => {
      if (active) acceptEvent(event);
    });
    Promise.allSettled([
      workbenchCall('workbench.probe', {}),
      workbenchCall('workbench.list', { projectId }),
    ])
      .then(async ([probe, listed]) => {
        if (!active) return;
        const failures: string[] = [];
        if (probe.status === 'fulfilled') setCapabilities(probe.value.capabilities);
        else failures.push(`能力探测失败：${probe.reason instanceof Error ? probe.reason.message : String(probe.reason)}`);
        if (listed.status === 'fulfilled') {
          const ownedSessions = listed.value.sessions.filter((session) => session.projectId === projectId);
          ownedHandles.current = new Set(ownedSessions.map((session) => session.handle));
          epochByHandle.current = new Map(
            ownedSessions.map((session) => [session.handle, session.connectionEpoch]),
          );
          setSessions(ownedSessions);
          const restored = await Promise.allSettled(ownedSessions.map((session) => workbenchCall('workbench.reconnect', {
            handle: session.handle,
            connectionEpoch: session.connectionEpoch,
            projectId,
            afterEventSequence: 0,
          })));
          if (!active) return;
          restored.forEach((result) => {
            if (result.status === 'rejected') {
              failures.push(`会话恢复失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
              return;
            }
            acceptEvent({ kind: 'session.updated', session: result.value.session });
            result.value.events.forEach(acceptEvent);
            if (result.value.omitted > 0) {
              setOmittedByHandle((current) => ({
                ...current,
                [result.value.session.handle]: result.value.omitted,
              }));
            }
          });
        } else failures.push(`会话列表读取失败：${listed.reason instanceof Error ? listed.reason.message : String(listed.reason)}`);
        if (failures.length > 0) setError(failures.join('；'));
      })
      .finally(() => active && setProbeFinished(true));
    return () => { active = false; unsubscribe(); };
  }, [acceptEvent, refreshSummary]);

  // 同一 vendor 可有多个会话（herdr 的 N pane）；按 handle 渲染，不再每 vendor 只留一个
  const sessionsByVendor = useMemo(() => {
    const map: Record<WorkbenchVendor, WorkbenchSessionView[]> = { CODEX: [], CLAUDE: [] };
    for (const session of sessions) map[session.vendor].push(session);
    return map;
  }, [sessions]);

  const rollup = useMemo(() => {
    let working = 0;
    let attention = 0;
    let done = 0;
    for (const session of sessions) {
      if (session.agentState === 'WORKING') working += 1;
      if (session.agentState === 'DONE') done += 1;
      if (NEEDS_ATTENTION.includes(session.agentState)) attention += 1;
    }
    return { total: sessions.length, working, attention, done };
  }, [sessions]);

  const collaboration = run?.collaborationProjection ?? null;

  const start = async (vendor: WorkbenchVendor) => {
    setError(null);
    setStartingVendor(vendor);
    try {
      const { session } = await workbenchCall('workbench.start', { vendor, ...(projectId ? { projectId } : {}) });
      if (projectIdRef.current !== projectId || session.projectId !== projectId) return;
      ownedHandles.current.add(session.handle);
      epochByHandle.current.set(session.handle, session.connectionEpoch);
      setSessions((current) => [...current.filter((item) => item.handle !== session.handle), session]);
      setActiveVendor(vendor);
      refreshSummary();
    } catch (cause) {
      if (projectIdRef.current === projectId) setError((cause as Error).message);
    } finally {
      if (projectIdRef.current === projectId) setStartingVendor(null);
    }
  };

  const send = async (session: WorkbenchSessionView) => {
    const text = (drafts[session.handle] ?? '').trim();
    if (!text) return;
    const requestId = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setDrafts((current) => ({ ...current, [session.handle]: '' }));
    try {
      await workbenchCall('workbench.send', {
        handle: session.handle,
        connectionEpoch: session.connectionEpoch,
        projectId,
        requestId,
        text,
      });
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <section aria-label="双 Agent 工作台">
      <Card title="双 Agent 工作台" hint="herdr 式状态感知 · 新建受管会话 · Desktop 既有会话仍为只读观察">
        {error && <Banner tone="err">{error}</Banner>}

        {summary.length > 0 && (
          <div className="workbench-summary" aria-label="跨项目注意力汇总">
            {summary.map((row) => {
              const isCurrent = row.projectId === projectId;
              const label = row.projectId ?? '（未绑定项目）';
              const clickable = Boolean(!isCurrent && onSelectProject && row.projectId !== null);
              return (
                <button
                  key={row.projectId ?? '__unbound__'}
                  type="button"
                  className={`workbench-summary-chip${isCurrent ? ' current' : ''}`}
                  disabled={!clickable}
                  onClick={() => { if (clickable) onSelectProject?.(row.projectId); }}
                  title={isCurrent ? '当前项目' : clickable ? '切换到该项目' : '在左侧项目列表切换项目'}
                >
                  {label}
                  {row.needsAttention > 0 ? ` · ${row.needsAttention} 待处理` : ' · 无待处理'}
                  {` · 工作中 ${row.counts.WORKING}`}
                </button>
              );
            })}
          </div>
        )}

        {run && (
          <div className="workbench-context" aria-label="关联 Core 任务">
            <strong>{run.title}</strong>
            <span>{run.status} · Attempt {run.attemptNo} · gen-{run.workspaceGeneration}</span>
            <span>构建自修复 {run.ledger.selfFixRounds}/{run.limits.maxSelfFixRounds}</span>
            <span>
              本循环评审 {collaboration?.currentCycle.reviewerInvocations ?? 0}/2 ·
              整改 {collaboration?.currentCycle.remediations ?? 0}/1
            </span>
            <span>
              Task 累计：模型 {run.ledger.modelTurns}/{run.limits.maxModelTurns} ·
              工具 {run.ledger.toolCalls}/{run.limits.maxToolCalls} ·
              token {run.ledger.inputTokens + run.ledger.outputTokens}/{run.limits.maxTotalTokens} ·
              {Math.round(run.ledger.elapsedMs / 1000)}s
              {(run.ledger.unknownUsageTurns ?? 0) > 0 ? ` · ${run.ledger.unknownUsageTurns} 轮用量未知` : ''}
            </span>
            {collaboration && (
              <span>
                审核累计 {collaboration.taskTotals.reviewerInvocations} · 整改累计 {collaboration.taskTotals.remediations} ·
                cycle {collaboration.cycleId ?? '未知'}
              </span>
            )}
            {collaboration?.roles.map((role) => (
              <span key={role.role}>{role.role}：{role.label}（{role.executionKind}）</span>
            ))}
            {detail?.plan && <span>计划 r{detail.plan.revision}：{detail.plan.summary}</span>}
            {detail?.patch && <span>补丁 {detail.patch.patchId} · {detail.patch.files.length} 个文件</span>}
            {detail?.verifications.at(-1) && (
              <span>最近验证：{detail.verifications.at(-1)!.passed ? '通过' : '未通过'} · {detail.verifications.at(-1)!.verificationRunId}</span>
            )}
            <span>待批准 {detail?.approvals.length ?? 0} · 验收 {run.terminalFacts?.patchAcceptanceId ? '已接受' : '未接受'}</span>
            {run.pendingHandoff && <span>待交接：{run.pendingHandoff.nextPhase} → {run.pendingHandoff.toRole}</span>}
          </div>
        )}

        <div className="workbench-rollup" aria-label="本项目会话状态汇总">
          本项目 {rollup.total} 个会话 · 工作中 {rollup.working} · 等你处理 {rollup.attention} · 已完成 {rollup.done}
        </div>

        <div className="workbench-tabs" role="tablist" aria-label="选择工作位">
          {(['CLAUDE', 'CODEX'] as const).map((vendor) => (
            <button key={vendor} role="tab" aria-selected={activeVendor === vendor} onClick={() => setActiveVendor(vendor)}>
              {vendor === 'CLAUDE' ? 'Claude 工作位' : 'Codex 工作位'}
              {sessionsByVendor[vendor].length > 0 ? `（${sessionsByVendor[vendor].length}）` : ''}
            </button>
          ))}
        </div>

        <div className="workbench-grid">
          {(['CLAUDE', 'CODEX'] as const).map((vendor) => {
            const capability = capabilities.find((item) => item.vendor === vendor);
            const vendorSessions = sessionsByVendor[vendor];
            const canStart = capability?.versionSupported.verdict === 'SUPPORTED'
              && capability.credentialConfigured.verdict === 'SUPPORTED'
              && capability.createSession.verdict === 'SUPPORTED';
            const capabilityLabel = canStart
              ? '可新建受管会话'
              : capability?.credentialConfigured.verdict !== 'SUPPORTED' && capability?.installed.verdict === 'SUPPORTED'
                ? '已安装 · 未配置凭据'
                : capability?.transport.verdict === 'SUPPORTED'
                  ? '已安装 · 会话未验证'
                  : capability?.installed.verdict === 'SUPPORTED'
                    ? '已安装 · 传输未验证'
                    : '能力未知';
            const emptyDetail = capability
              ? canStart
                ? '已验证可创建隔离的受管新会话'
                : capability.credentialConfigured.reason ?? capability.createSession.reason ?? '会话创建能力尚未验证'
              : probeFinished
                ? '能力探测失败，请查看上方原因'
                : '正在检测本机引擎能力…';
            return (
              <article key={vendor} className={`workbench-pane ${activeVendor === vendor ? 'active' : ''}`} aria-label={`${vendor} 工作位`}>
                <header>
                  <strong>{vendor === 'CLAUDE' ? 'Claude 工作位' : 'Codex 工作位'}</strong>
                  <Badge tone={canStart ? 'ok' : capability?.installed.verdict === 'SUPPORTED' ? 'warn' : 'default'}>
                    {capabilityLabel}
                  </Badge>
                </header>
                {vendorSessions.length === 0 ? (
                  <div className="workbench-empty">
                    <p>{emptyDetail}</p>
                    <button className="primary" disabled={!canStart || startingVendor !== null} onClick={() => void start(vendor)}>
                      {startingVendor === vendor ? '创建中…' : '新建受管会话'}
                    </button>
                    <small>此动作不会接管、恢复或改名已有 Desktop 会话。</small>
                  </div>
                ) : (
                  <>
                    <div className="row">
                      <button disabled={!canStart || startingVendor !== null} onClick={() => void start(vendor)}>
                        {startingVendor === vendor ? '创建中…' : '新建受管会话'}
                      </button>
                    </div>
                    {vendorSessions.map((session) => (
                      <div className="workbench-session" key={session.handle} aria-label={`会话 ${session.displayName}`}>
                        <div className="workbench-session-head">
                          <strong>{session.displayName}</strong>
                          <Badge tone={AGENT_STATE_TONE[session.agentState]}>{AGENT_STATE_LABEL[session.agentState]}</Badge>
                          {session.activeRequestId && <Badge tone="info">轮次进行中</Badge>}
                        </div>
                        {session.error && <Banner tone="err">{session.error}</Banner>}
                        {NEEDS_ATTENTION.includes(session.agentState) && (
                          <Banner tone="warn">
                            {session.agentState === 'DONE'
                              ? '本轮已完成 —— 等你查看并决定下一步'
                              : `等待你在该会话自己的工具里应答（${AGENT_STATE_LABEL[session.agentState]}）；RepoPilot 不代答`}
                          </Banner>
                        )}
                        <div className="workbench-messages" aria-live="polite">
                          {(omittedByHandle[session.handle] ?? 0) > 0 && (
                            <p data-role="SYSTEM">
                              已省略 {omittedByHandle[session.handle]} 条较早事件（回放上限 500 条）；首条消息可能从中段开始
                            </p>
                          )}
                          {projectWorkbenchMessages(eventsByHandle[session.handle] ?? []).map((message) => <p key={message.id} data-role={message.role}>{message.text}</p>)}
                        </div>
                        <label>
                          <span className="sr-only">给 {session.displayName} 发送消息</span>
                          <textarea
                            value={drafts[session.handle] ?? ''}
                            disabled={session.status !== 'READY'}
                            onChange={(event) => setDrafts((current) => ({ ...current, [session.handle]: event.target.value }))}
                            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send(session); }}
                          />
                        </label>
                        <div className="row">
                          <button className="primary" disabled={session.status !== 'READY' || !(drafts[session.handle] ?? '').trim()} onClick={() => void send(session)}>发送</button>
                          <button disabled={!session.activeRequestId} onClick={() => session.activeRequestId && void workbenchCall('workbench.interrupt', { handle: session.handle, connectionEpoch: session.connectionEpoch, projectId, requestId: session.activeRequestId })}>请求中断</button>
                          <button onClick={() => void workbenchCall('workbench.dispose', { handle: session.handle, connectionEpoch: session.connectionEpoch, projectId }).catch((cause) => setError((cause as Error).message))}>停止会话</button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </article>
            );
          })}
        </div>
        {run && detail && approvalAction && onError && onRefresh && (
          <details className="workbench-task-detail">
            <summary>任务工件与 Core 当前动作</summary>
            <RunDetail
              run={run}
              events={detail.events}
              toolCalls={detail.toolCalls}
              approvals={detail.approvals}
              plan={detail.plan}
              patch={detail.patch}
              priorPatches={detail.priorPatches}
              verifications={detail.verifications}
              approvalAction={approvalAction}
              onError={onError}
              onRefresh={onRefresh}
              onOpenDiff={onOpenDiff}
            />
          </details>
        )}
      </Card>
    </section>
  );
}
