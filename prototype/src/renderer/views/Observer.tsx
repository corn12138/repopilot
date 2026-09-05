import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ObserverProjection,
  ObserverSessionEntry,
  ObserverSweepCounts,
} from '@shared/observerProtocol';
import { observerCall, observerSubscribe } from '../observerBridge';
import { Banner, Card, relativeTime } from '../components/common';

/**
 * 观察面板（PRD-WKB-002 的可丢弃 spike 子集）：本机 Claude Code / Codex 会话的只读镜像。
 *
 * 视图层只做三件事：发起授权手势（真正的目录选择在 Main 的原生对话框里）、
 * 列会话、渲染 Main 推来的 volatile 投影。四条信任边界（DEC-020）里它负责说人话：
 * 登录态属用户、只读、零出站、可随时关闭。所有计数如实展示 —— 省略要报数。
 *
 * 这里的一切都不进 Run/Approval/Verification：徽标只是导航，正文只是镜像，
 * 改动要进主线仍走正常任务流程（PRD-WKB-003 采纳桥是另一条未开工的路）。
 */
export function ObserverView() {
  const [granted, setGranted] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly ObserverSessionEntry[]>([]);
  const [counts, setCounts] = useState<ObserverSweepCounts | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [projection, setProjection] = useState<ObserverProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(true);

  const report = useCallback((err: unknown) => {
    if (activeRef.current) setError((err as Error).message ?? '未知错误');
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await observerCall('observer.listSessions', {});
      if (!activeRef.current) return;
      setSessions(r.sessions);
      setCounts(r.counts);
      setError(null);
    } catch (err) {
      report(err);
    }
  }, [report]);

  useEffect(() => {
    activeRef.current = true;
    const unsubscribe = observerSubscribe((event) => {
      if (!activeRef.current) return;
      if (event.kind === 'observer.projection') {
        setProjection(event.projection);
        return;
      }
      setGranted(event.state.granted);
      setWatching(event.state.watching);
      if (event.state.granted === null) {
        // 撤销即清除：Main 清缓存，这里清投影 —— 两边都不留残影
        setSessions([]);
        setCounts(null);
        setProjection(null);
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
        setGranted(s.granted);
        setWatching(s.watching);
        if (s.granted !== null) void refreshSessions();
      })
      .catch(report);
    return () => {
      activeRef.current = false;
      unsubscribe();
      // 关闭面板就停止监视：没人看的镜像不该继续产生 IO
      void observerCall('observer.unwatch', {}).catch(() => {});
    };
  }, [refreshSessions, report]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await observerCall('observer.enable', {});
      if (!activeRef.current) return;
      if (r.granted === null) return; // 用户取消了目录选择 —— 什么都没发生
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

  const watch = async (sessionId: string) => {
    setError(null);
    try {
      await observerCall('observer.watch', { sessionId });
      if (activeRef.current) setWatching(sessionId);
    } catch (err) {
      report(err);
    }
  };

  const vendorLabel = (v: ObserverSessionEntry['vendor']) =>
    v === 'CLAUDE_JOURNAL' ? 'Claude' : 'Codex';

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
                style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 280, overflow: 'auto' }}
                aria-label="可观察的会话列表"
              >
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    className={`list-item ${watching === s.sessionId ? 'active' : ''}`}
                    onClick={() => void watch(s.sessionId)}
                    title={s.sessionId}
                  >
                    <div className="name">
                      {vendorLabel(s.vendor)} · {s.label}
                    </div>
                    <div className="meta">
                      {relativeTime(s.updatedAt)} · {(s.sizeBytes / 1024).toFixed(0)}KB
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {projection && (
        <Card
          title={`会话镜像 · ${vendorLabel(projection.vendor)}`}
          hint={
            projection.active
              ? '活跃（启发式，仅导航提示）'
              : `最后更新 ${relativeTime(projection.fileUpdatedAt)}`
          }
        >
          {projection.status === 'FORMAT_UNKNOWN' ? (
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
          {projection.driftNotes.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
              字段基线有 {projection.driftNotes.length} 处出入（面板依赖键完好，仍可读）：
              {projection.driftNotes.join('、')}。可用
              <code> REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals </code>重建基线。
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
            记录 {projection.counts.records} · 显示 {projection.counts.shownLines} 行
            {projection.counts.omittedLines > 0 ? `（更早的 ${projection.counts.omittedLines} 行未显示）` : ''}
            {projection.counts.unparseableLines > 0 ? ` · 坏行 ${projection.counts.unparseableLines}` : ''}
            {projection.counts.headBytesSkipped > 0
              ? ` · 文件过大，跳过头部 ${projection.counts.headBytesSkipped} 字节`
              : ''}
          </div>
        </Card>
      )}
    </>
  );
}
