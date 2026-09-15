import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OBSERVER_MAX_MIRRORS,
  type ObserverHandoffArtifact,
  type ObserverProjection,
  type ObserverSessionEntry,
  type ObserverSweepCounts,
} from '@shared/observerProtocol';
import { observerCall, observerSubscribe } from '../observerBridge';
import { Badge, Banner, Card, relativeTime } from '../components/common';

const SESSION_REFRESH_MS = 3_000;
const ATTENTION_QUEUE_LIMIT = 8;

/**
 * 观察与交接面板（PRD-WKB-002/003/004）：本机 Claude / Codex 会话的只读镜像。
 *
 * 视图层只做四件事：发起授权手势（真正的目录选择在 Main 的原生对话框里）、
 * 列会话、汇总待输入导航、渲染 Main 推来的 volatile 投影。四条信任边界（DEC-020）里它负责说人话：
 * 登录态属用户、只读、零出站、可随时关闭。所有计数如实展示 —— 省略要报数。
 *
 * 双镜像（2026-09-05）：最多 OBSERVER_MAX_MIRRORS 个会话并排镜像，这是"甲乙对照"的最小形态。
 * 并排是**视图内部排版**：观察视图本身是主栏里的全屏视图（与设置/证据同级），不新增 grid 列、
 * 不动三栏任何宽度 —— N12「布局恒定」不受影响（交互评审 v0.2 §5.2 补注）。
 * 槽位序由 Main 的 observer.state 推送决定（先选在左），Renderer 不自己维护第二份真值。
 *
 * 镜像本身不进 Run/Approval/Verification；人冻结交接包后仍要经正常任务、出站披露、
 * 验证与补丁接受链，观察通道不会获得 Core 权威。
 * 等待队列同样只消费机器结束字段，不会自动交接或把启发式状态上移成任何判定。
 */
export function ObserverView({
  reviewProjectDisplayPath = null,
  onUseAsReviewTask,
}: {
  /** 当前已导入项目；只有它与观察授权一致时，交接才能进入正常任务链。 */
  reviewProjectDisplayPath?: string | null;
  onUseAsReviewTask?: (artifact: ObserverHandoffArtifact) => void;
}) {
  const [granted, setGranted] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly ObserverSessionEntry[]>([]);
  const [counts, setCounts] = useState<ObserverSweepCounts | null>(null);
  const [watching, setWatching] = useState<readonly string[]>([]);
  const [projections, setProjections] = useState<Readonly<Record<string, ObserverProjection>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<ObserverHandoffArtifact | null>(null);
  const [copied, setCopied] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const activeRef = useRef(true);
  const grantedRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const mirrorRefs = useRef(new Map<string, HTMLDivElement>());

  const report = useCallback((err: unknown) => {
    if (activeRef.current) setError((err as Error).message ?? '未知错误');
  }, []);

  const refreshSessions = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    const expectedGrant = grantedRef.current;
    if (expectedGrant === null) return;
    refreshInFlightRef.current = true;
    try {
      const r = await observerCall('observer.listSessions', {});
      // 撤销或换项目后，旧 IPC 响应不能把已清除的会话重新塞回 Renderer。
      if (!activeRef.current || grantedRef.current !== expectedGrant) return;
      setSessions(r.sessions);
      setCounts(r.counts);
      setPrepared((current) => {
        if (!current) return null;
        const latest = r.sessions.find((session) => session.sessionId === current.sessionId);
        return latest?.updatedAt === current.sourceUpdatedAt ? current : null;
      });
      setError(null);
    } catch (err) {
      if (grantedRef.current === expectedGrant) report(err);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [report]);

  useEffect(() => {
    activeRef.current = true;
    const unsubscribe = observerSubscribe((event) => {
      if (!activeRef.current) return;
      if (event.kind === 'observer.projection') {
        const id = event.projection.sessionId;
        setPrepared((current) =>
          current?.sessionId === id && current.sourceUpdatedAt !== event.projection.fileUpdatedAt ? null : current,
        );
        setProjections((prev) => ({ ...prev, [id]: event.projection }));
        // Main 推来投影 = 它在镜像中；状态推送通常先到，这里只是补位，不改槽位序
        setWatching((prev) => (prev.includes(id) ? prev : [...prev, id]));
        return;
      }
      grantedRef.current = event.state.granted;
      setGranted(event.state.granted);
      setWatching(event.state.watching);
      // 被顶掉/被关闭的镜像，其投影一并丢弃 —— 槽位以 Main 为准，不留残影
      setProjections((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => event.state.watching.includes(id))),
      );
      if (event.state.granted === null) {
        // 撤销即清除：Main 清缓存，这里清列表 —— 两边都不留残影
        setSessions([]);
        setCounts(null);
        setPrepared(null);
      } else {
        /*
         * 授权可能不是本视图发起的（selftest 直接在服务层授权；将来任何 Main 侧的授权入口
         * 都一样）：state 推送只说"已授权"，会话列表得自己去拉。2026-09-05 的 selftest
         * 截图抓到的就是这个空档 —— 视图显示已授权，列表却是空的。
         */
        void refreshSessions();
      }
    });
    void observerCall('observer.status', {})
      .then((s) => {
        if (!activeRef.current) return;
        grantedRef.current = s.granted;
        setGranted(s.granted);
        setWatching(s.watching);
        if (s.granted !== null) void refreshSessions();
      })
      .catch(report);
    return () => {
      activeRef.current = false;
      unsubscribe();
      // 关闭面板就停止全部监视：没人看的镜像不该继续产生 IO
      void observerCall('observer.unwatch', {}).catch(() => {});
    };
  }, [refreshSessions, report]);

  useEffect(() => {
    if (granted === null) return;
    // 等待队列要跟得上 Desktop 新轮次，但文件未变时 Main 会复用元数据缓存。
    const timer = window.setInterval(() => void refreshSessions(), SESSION_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [granted, refreshSessions]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await observerCall('observer.enable', {});
      if (!activeRef.current) return;
      if (r.granted === null) return; // 用户取消了目录选择 —— 什么都没发生
      grantedRef.current = r.granted;
      setGranted(r.granted);
      setSessions(r.sessions);
      setCounts(r.counts);
    } catch (err) {
      report(err);
    } finally {
      if (activeRef.current) setBusy(false);
    }
  };

  const disable = async () => {
    try {
      await observerCall('observer.disable', {});
    } catch (err) {
      report(err);
    }
  };

  /** 加入镜像槽。槽位序与顶替由 Main 决定并经 state 推送回来 */
  const watch = async (sessionId: string): Promise<boolean> => {
    setError(null);
    try {
      await observerCall('observer.watch', { sessionId });
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  };

  const focusFromQueue = async (sessionId: string) => {
    setFocusTarget(sessionId);
    if (!(await watch(sessionId))) setFocusTarget(null);
  };

  const unwatchOne = async (sessionId: string) => {
    try {
      await observerCall('observer.unwatch', { sessionId });
    } catch (err) {
      report(err);
    }
  };

  const prepareHandoff = async (sessionId: string) => {
    setHandoffBusy(sessionId);
    setCopied(false);
    setError(null);
    try {
      const { artifact } = await observerCall('observer.prepareHandoff', { sessionId });
      if (activeRef.current) setPrepared(artifact);
    } catch (err) {
      report(err);
    } finally {
      if (activeRef.current) setHandoffBusy(null);
    }
  };

  const copyPrepared = async () => {
    if (!prepared) return;
    try {
      await navigator.clipboard.writeText(`[RepoPilot 交接包 ${prepared.digest}]\n${prepared.payload}`);
      setCopied(true);
    } catch (err) {
      report(err);
    }
  };

  const vendorLabel = (v: ObserverSessionEntry['vendor']) =>
    v === 'CLAUDE_JOURNAL' ? 'Claude' : 'Codex';
  const labelOf = (sessionId: string) =>
    sessions.find((s) => s.sessionId === sessionId)?.label ?? sessionId.replace(/^[A-Z_]+:/, '');
  const compactLabel = (label: string) =>
    label.length <= 18 ? label : `${label.slice(0, 8)}…${label.slice(-8)}`;
  const sourceLabel = (source: ObserverSessionEntry['source']) =>
    source === 'DESKTOP_LOCAL_AGENT'
      ? 'Desktop'
      : source === 'USER_CLI'
        ? 'CLI'
        : source === 'SPAWNED_BY_US'
          ? '平台启动'
          : '来源未知';
  const groupedSessions = [
    'DESKTOP_LOCAL_AGENT',
    'USER_CLI',
    'SPAWNED_BY_US',
    'UNKNOWN',
  ] as const;
  const waitingSessions = sessions.filter((session) => session.completion.state === 'READY_TO_HANDOFF');
  const visibleWaitingSessions = waitingSessions.slice(0, ATTENTION_QUEUE_LIMIT);
  const omittedWaitingSessions = waitingSessions.length - visibleWaitingSessions.length;
  const unknownCompletionCount = sessions.filter((session) => session.completion.state === 'UNKNOWN').length;
  const completionLabel = (session: ObserverSessionEntry) =>
    session.completion.state === 'READY_TO_HANDOFF'
      ? '待你决定'
      : session.completion.state === 'RUNNING'
        ? '本轮进行中'
        : '结束状态未知';
  const canUsePreparedAsTask =
    prepared !== null &&
    onUseAsReviewTask !== undefined &&
    granted !== null &&
    reviewProjectDisplayPath === granted;

  useEffect(() => {
    if (!focusTarget || !projections[focusTarget]) return;
    const mirror = mirrorRefs.current.get(focusTarget);
    if (!mirror) return;
    mirror.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    mirror.focus({ preventScroll: true });
    setFocusTarget(null);
  }, [focusTarget, projections]);

  return (
    <>
      <Card
        title="本机代理会话观察"
        hint="只读 · 零出站"
        right={
          granted !== null ? (
            <>
              <button onClick={() => void refreshSessions()}>刷新会话</button>
              <button onClick={() => void disable()}>关闭观察</button>
            </>
          ) : undefined
        }
      >
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          镜像本机 Claude Code / Codex 留在磁盘上的会话日志（包括桌面应用里跑的会话）。
          登录态属于你；平台只读取、只在本地展示 —— 内容不进模型、不进遥测、不进证据。
          可随时关闭，关闭即清除。这里的一切不构成任何运行事实：改动要进主线，仍走正常任务流程。
        </div>
        {error && (
          <div style={{ marginTop: 8 }}>
            <Banner tone="err">{error}</Banner>
          </div>
        )}
        {granted === null ? (
          <div style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy} onClick={() => void enable()}>
              {busy ? '等待目录选择…' : '选择项目目录并启用观察'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
              授权是一次系统目录选择手势 —— 只观察你选中的那个项目的会话。
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12 }}>
              已授权：<code>{granted}</code>
            </div>
            {counts && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                claude 命中 {counts.claudeMatched}
                {counts.claudeSkippedByCap > 0 ? `（上限跳过 ${counts.claudeSkippedByCap}）` : ''}
                {counts.claudeNestedSkipped > 0 ? `（子代理/子文件 ${counts.claudeNestedSkipped} 个未列）` : ''} · codex
                扫描 {counts.codexScanned} 命中 {counts.codexMatched}
                {counts.codexSkippedByCap > 0 ? `（上限跳过 ${counts.codexSkippedByCap}）` : ''}
                {counts.codexUnreadable > 0 ? ` · 首行读不出 ${counts.codexUnreadable}` : ''}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              点会话加入镜像，最多同屏 {OBSERVER_MAX_MIRRORS} 个；满了会替换最早的一个。
            </div>
            {sessions.length > 0 && (
              <section
                aria-label="待你输入队列"
                style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}
              >
                <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 12 }}>待你输入 / 决定 · {waitingSessions.length}</strong>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>只用于导航</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  机器字段只说明本轮已经结束；不会自动交接，也不会改变任务、审批或成功状态。
                </div>
                {visibleWaitingSessions.length > 0 ? (
                  <div className="row wrap" style={{ marginTop: 7 }}>
                    {visibleWaitingSessions.map((session) => (
                      <button
                        key={session.sessionId}
                        onClick={() => void focusFromQueue(session.sessionId)}
                        title={`${session.sessionId}\n结束依据：${session.completion.evidence.join('；')}`}
                      >
                        {vendorLabel(session.vendor)} / {compactLabel(session.label)}
                        {watching.includes(session.sessionId) ? ' · 镜像中' : ''}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                    暂无机器字段显示本轮结束的会话。
                  </div>
                )}
                {(omittedWaitingSessions > 0 || unknownCompletionCount > 0) && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                    {omittedWaitingSessions > 0 ? `更早的 ${omittedWaitingSessions} 个待决定会话未在队列展开。` : ''}
                    {unknownCompletionCount > 0 ? `另有 ${unknownCompletionCount} 个会话结束状态未知。` : ''}
                  </div>
                )}
              </section>
            )}
            {sessions.length === 0 ? (
              <div className="empty" style={{ marginTop: 8 }}>
                该目录下没有发现本机代理会话日志。
              </div>
            ) : (
              /*
               * 列表限高可滚：真实项目一列 28 个会话时，镜像卡会被推到首屏之外
               * （2026-09-05 selftest 截图 04 抓到的）。列表是入口，镜像才是主体。
               */
              <div
                style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto' }}
                aria-label="可观察的会话列表"
              >
                {groupedSessions.map((source) => {
                  const group = sessions.filter((session) => session.source === source);
                  if (group.length === 0) return null;
                  return (
                    <section key={source} aria-label={`${sourceLabel(source)} 会话`}>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 3 }}>
                        {sourceLabel(source)} · {group.length}
                      </div>
                      {group.map((s) => {
                        const mirrored = watching.includes(s.sessionId);
                        return (
                          <button
                            key={s.sessionId}
                            className={`list-item ${mirrored ? 'active' : ''}`}
                            onClick={() => void watch(s.sessionId)}
                            title={`${s.sessionId}\n${s.sourceEvidence.join('；')}`}
                            aria-pressed={mirrored}
                          >
                            <div className="name">
                              {vendorLabel(s.vendor)} · {s.label}
                              {mirrored ? '　镜像中' : ''}
                            </div>
                            <div className="meta">
                              {sourceLabel(s.source)} · {completionLabel(s)} · {relativeTime(s.updatedAt)} ·{' '}
                              {(s.sizeBytes / 1024).toFixed(0)}KB
                            </div>
                          </button>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {watching.length > 0 && (
        <div
          aria-label="会话镜像"
          style={{
            display: 'grid',
            gridTemplateColumns: watching.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
            gap: 12,
            alignItems: 'start',
          }}
        >
          {watching.map((sessionId) => {
            const projection = projections[sessionId];
            const vendor = projection?.vendor ?? sessions.find((s) => s.sessionId === sessionId)?.vendor;
            return (
              <div
                key={sessionId}
                ref={(node) => {
                  if (node) mirrorRefs.current.set(sessionId, node);
                  else mirrorRefs.current.delete(sessionId);
                }}
                tabIndex={-1}
              >
                <Card
                  title={`会话镜像 · ${vendor ? vendorLabel(vendor) : ''} ${compactLabel(labelOf(sessionId))}`}
                  hint={
                    projection
                      ? projection.active
                        ? '活跃（启发式，仅导航提示）'
                        : `最后更新 ${relativeTime(projection.fileUpdatedAt)}`
                      : '读取中…'
                  }
                  right={<button onClick={() => void unwatchOne(sessionId)}>关闭镜像</button>}
                >
                {!projection ? (
                  <div className="empty">正在读取该会话的日志…</div>
                ) : projection.status === 'FORMAT_UNKNOWN' ? (
                  <Banner tone="err">
                    <strong>格式未知 —— 已停止解读正文。</strong>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      记录不满足面板的消费键契约（宁可不读，不可错读）：{projection.breaking.join('、')}。
                      这通常意味着该工具的日志格式已变，需要更新面板的解析器。
                    </div>
                  </Banner>
                ) : (
                  <pre className="output" style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {projection.lines
                      .map(
                        (l) =>
                          `${l.kind}${l.collapsed > 1 ? ` ×${l.collapsed}` : ''}${l.text ? `：${l.text}` : ''}`,
                      )
                      .join('\n')}
                  </pre>
                )}
                {projection && projection.driftNotes.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                    字段基线有 {projection.driftNotes.length} 处出入（面板依赖键完好，仍可读）：
                    {projection.driftNotes.join('、')}。可用
                    <code> REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals </code>重建基线。
                  </div>
                )}
                {projection && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                    记录 {projection.counts.records} · 显示 {projection.counts.shownLines} 行
                    {projection.counts.omittedLines > 0 ? `（更早的 ${projection.counts.omittedLines} 行未显示）` : ''}
                    {projection.counts.unparseableLines > 0 ? ` · 坏行 ${projection.counts.unparseableLines}` : ''}
                    {projection.counts.headBytesSkipped > 0
                      ? ` · 文件过大，跳过头部 ${projection.counts.headBytesSkipped} 字节`
                      : ''}
                  </div>
                )}
                {projection && projection.status === 'OK' && (
                  <div style={{ marginTop: 10 }}>
                    <div className="row wrap">
                      <Badge tone={projection.source === 'UNKNOWN' ? 'warn' : 'info'}>
                        {sourceLabel(projection.source)}
                      </Badge>
                      <Badge tone={projection.completion.state === 'READY_TO_HANDOFF' ? 'ok' : 'warn'}>
                        {projection.completion.state === 'READY_TO_HANDOFF'
                          ? '机器记录显示本轮结束'
                          : projection.completion.state === 'RUNNING'
                            ? '仍在运行或等待结果'
                            : '结束状态未知'}
                      </Badge>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                      来源依据：{projection.sourceEvidence.join('；')} · 结束依据：
                      {projection.completion.evidence.join('；')}
                    </div>
                    <button
                      style={{ marginTop: 8 }}
                      disabled={projection.completion.state !== 'READY_TO_HANDOFF' || handoffBusy !== null}
                      onClick={() => void prepareHandoff(sessionId)}
                    >
                      {handoffBusy === sessionId ? '正在生成交接包…' : '准备交给另一边审核'}
                    </button>
                  </div>
                )}
                {prepared?.sessionId === sessionId && (
                  <div style={{ marginTop: 10 }}>
                    <Banner tone="info">
                      <strong>交接包已冻结，尚未发送。</strong>
                      <div style={{ fontSize: 12, marginTop: 5 }}>
                        摘要 <code>{prepared.digest.slice(0, 24)}…</code> · 纳入 {prepared.includedLines} 行
                        {prepared.omittedLines > 0 ? `，省略 ${prepared.omittedLines} 行` : ''}。
                      </div>
                    </Banner>
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <button onClick={() => void copyPrepared()}>{copied ? '已复制' : '复制给另一个 Desktop'}</button>
                      <button
                        className="primary"
                        disabled={!canUsePreparedAsTask}
                        onClick={() => prepared && onUseAsReviewTask?.(prepared)}
                      >
                        进入 RepoPilot 有界审核
                      </button>
                    </div>
                    {!canUsePreparedAsTask && (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                        要进入有界审核，请先在左侧选择并导入与观察授权相同的项目。
                      </div>
                    )}
                  </div>
                )}
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
