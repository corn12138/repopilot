import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  DoctorCheck,
  ModelConnectionProfile,
  PatchArtifact,
  PlanRevision,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEvent,
  RunView,
  SubPackageCandidate,
  ToolCallView,
  VerificationRun,
} from '@shared/domain';
import { TERMINAL_RUN_STATUSES } from '@shared/domain';
import { RequestError, call, subscribe } from './bridge';
import { Badge, Banner, Card, DoctorBadge, RestoredBadge, RunStatusBadge } from './components/common';
import { Composer } from './views/TaskForm';
import { RunDetail } from './views/RunDetail';
import { FileTreePanel } from './views/FileTree';
import { SettingsView } from './views/Settings';

/**
 * 导入是一个有明确失败态的过程，不是"有结果 / 没结果"两态。
 * 用判别联合表达，UI 就不可能再退化成无限 spinner（PRD-DESK-002）。
 */
type ImportState =
  | { status: 'idle' }
  | { status: 'importing' }
  | {
      status: 'done';
      snapshot: RepositorySnapshot;
      profile: RepositoryHarnessProfile;
      candidates: readonly SubPackageCandidate[];
    }
  | {
      status: 'blocked';
      code: string;
      message: string;
      detail: string;
      candidates: readonly SubPackageCandidate[];
      /** 被阻断的那次请求用的范围，重试时原样带回去 */
      subPath: string;
    }
  | { status: 'failed'; message: string; detail: string | null };

interface ImportRequest {
  subPath?: string;
}

export function App() {
  const [coreStatus, setCoreStatus] = useState<'READY' | 'RESTARTING' | 'DOWN'>('RESTARTING');
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [modelProfiles, setModelProfiles] = useState<ModelConnectionProfile[]>([]);
  const [secureStorage, setSecureStorage] = useState(true);
  const [runs, setRuns] = useState<RunView[]>([]);

  const [selectedProject, setSelectedProject] = useState<ProjectRef | null>(null);
  const [importState, setImportState] = useState<ImportState>({ status: 'idle' });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);

  // Run 详情
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [plan, setPlan] = useState<PlanRevision | null>(null);
  const [patch, setPatch] = useState<PatchArtifact | null>(null);
  const [verifications, setVerifications] = useState<VerificationRun[]>([]);

  /** 右侧文件树开关 + 刷新令牌（Agent 改完文件后自增，让树重新拉取） */
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesKey, setFilesKey] = useState(0);
  /** 设置页作为一个独立视图，而不是"没选项目时的兜底" */
  const [showSettings, setShowSettings] = useState(false);

  const selectedRunRef = useRef<string | null>(null);
  selectedRunRef.current = selectedRunId;
  /** 放进 ref 而不是 effect 依赖：否则每次它重建都会重订阅事件流 */
  const loadRunDetailRef = useRef<((runId: string) => Promise<void>) | null>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const report = useCallback((err: unknown) => {
    if (err instanceof RequestError) setError({ message: err.message, detail: err.detail });
    else setError({ message: (err as Error).message ?? '未知错误', detail: null });
  }, []);

  // ---- 启动加载 ----
  const bootstrap = useCallback(async () => {
    try {
      const [d, p, m, r] = await Promise.all([
        call('doctor.run', {}),
        call('project.list', {}),
        call('model.listProfiles', {}),
        call('run.list', {}),
      ]);
      setChecks(d.checks);
      setProjects(p.projects);
      setModelProfiles(m.profiles);
      setSecureStorage(m.secureStorage);
      setRuns(r.runs);
    } catch (err) {
      report(err);
    }
  }, [report]);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'core.status':
          setCoreStatus(event.status);
          if (event.status === 'READY') {
            void bootstrap();
            // 断线窗口里的事件不会补发。selectedRunId 没变，详情 effect 也不会重跑，
            // 所以这里必须主动补一次，否则时间线会缺一段且用户不知道。
            const runId = selectedRunRef.current;
            if (runId) void loadRunDetailRef.current?.(runId);
          }
          break;
        case 'run.updated':
          setRuns((prev) => {
            const idx = prev.findIndex((r) => r.runId === event.run.runId);
            if (idx < 0) return [event.run, ...prev];
            const next = [...prev];
            next[idx] = event.run;
            return next;
          });
          break;
        case 'run.event':
          if (event.runId === selectedRunRef.current) {
            setEvents((prev) =>
              prev.some((e) => e.seq === event.event.seq) ? prev : [...prev, event.event],
            );
          }
          break;
        case 'toolcall.updated':
          if (event.toolCall.runId === selectedRunRef.current) {
            setToolCalls((prev) => {
              const idx = prev.findIndex((t) => t.toolCallId === event.toolCall.toolCallId);
              if (idx < 0) return [...prev, event.toolCall];
              const next = [...prev];
              next[idx] = event.toolCall;
              return next;
            });
            // 文件被改动了就刷新文件树，让改动实时可见
            if (event.toolCall.toolName === 'workspace_mutate' && event.toolCall.resolution === 'SUCCEEDED') {
              setFilesKey((k) => k + 1);
            }
          }
          break;
        case 'approval.updated':
          if (event.runId === selectedRunRef.current) setApprovals(event.approvals);
          break;
      }
    });
    void bootstrap();
    return unsubscribe;
  }, [bootstrap]);

  // ---- 切换 Run 时全量拉取（不依赖内存中的残留） ----
  const loadRunDetail = useCallback(
    async (runId: string) => {
      try {
        const [e, t, a, p, pa, v] = await Promise.all([
          call('run.events', { runId, afterSeq: 0 }),
          call('run.toolCalls', { runId }),
          call('approval.pending', { runId }),
          call('plan.get', { runId }),
          call('patch.get', { runId }),
          call('verification.list', { runId }),
        ]);
        setEvents(e.events);
        setToolCalls(t.toolCalls);
        setApprovals(a.approvals);
        setPlan(p.plan);
        setPatch(pa.patch);
        setVerifications(v.verifications);
      } catch (err) {
        report(err);
      }
    },
    [report],
  );

  loadRunDetailRef.current = loadRunDetail;

  useEffect(() => {
    if (!selectedRunId) return;
    void loadRunDetail(selectedRunId);
  }, [selectedRunId, loadRunDetail]);

  // 状态推进到需要新数据的节点时补拉一次
  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    if (selectedRun.status === 'AWAITING_PLAN_APPROVAL' && !plan) void loadRunDetail(selectedRunId);
    if (selectedRun.status === 'AWAITING_PATCH_REVIEW' && !patch) void loadRunDetail(selectedRunId);
  }, [selectedRun, selectedRunId, plan, patch, loadRunDetail]);

  // ---- 动作 ----
  const importProject = useCallback(async (project: ProjectRef, req: ImportRequest = {}) => {
    setError(null);
    setImportState({ status: 'importing' });
    try {
      const outcome = await call('project.import', {
        projectId: project.projectId,
        ...(req.subPath ? { subPath: req.subPath } : {}),
      });
      // 被阻断是终态，不是异常 —— 直接渲染，并带上可以怎么继续
      setImportState(
        outcome.outcome === 'IMPORTED'
          ? {
              status: 'done',
              snapshot: outcome.snapshot,
              profile: outcome.profile,
              candidates: outcome.candidates,
            }
          : {
              status: 'blocked',
              code: outcome.code,
              message: outcome.message,
              detail: outcome.detail,
              candidates: outcome.candidates,
              subPath: req.subPath ?? '',
            },
      );
    } catch (err) {
      setImportState({
        status: 'failed',
        message: err instanceof RequestError ? err.message : ((err as Error).message ?? '导入失败'),
        detail: err instanceof RequestError ? err.detail : null,
      });
    }
  }, []);

  const openProject = useCallback(
    (project: ProjectRef) => {
      setShowSettings(false);
      setSelectedProject(project);
      setSelectedRunId(null);
      void importProject(project);
    },
    [importProject],
  );

  /**
   * 点击某个运行。
   *
   * 运行可能属于当前没选中的项目，所以要先把项目切过去并重新导入快照 ——
   * 否则文件树和"新建任务"会指向错误的仓库。
   */
  const openRun = useCallback(
    (run: RunView) => {
      setShowSettings(false);
      setError(null);
      setSelectedRunId(run.runId);
      if (selectedProject?.projectId !== run.projectId) {
        const project = projects.find((p) => p.projectId === run.projectId);
        if (project) {
          setSelectedProject(project);
          void importProject(project);
        }
      }
    },
    [projects, selectedProject, importProject],
  );

  const pickProject = async () => {
    try {
      const { project } = await call('project.pick', {});
      if (!project) return;
      setProjects((prev) =>
        prev.some((p) => p.projectId === project.projectId) ? prev : [...prev, project],
      );
      // 之前这里漏了这一步 —— 选完目录什么都不会发生
      openProject(project);
    } catch (err) {
      report(err);
    }
  };

  // 运行按项目分组，让侧栏读起来是「项目 → 这个项目下的多轮对话」
  const runsByProject = useMemo(() => {
    const map = new Map<string, RunView[]>();
    for (const r of runs) {
      const list = map.get(r.projectId);
      if (list) list.push(r);
      else map.set(r.projectId, [r]);
    }
    return map;
  }, [runs]);

  const enabledModelCount = modelProfiles.filter((m) => m.enabled).length;
  const snapshotId = importState.status === 'done' ? importState.snapshot.snapshotId : null;
  const canShowFiles = Boolean(snapshotId);

  /** 当前项目下、除正看着的这个之外还在进行中的运行 —— composer 用它提示，防止"以为没反应"再建一个 */
  const activeProjectRun = useMemo(() => {
    if (!selectedProject) return null;
    return (
      runs.find(
        (r) =>
          r.projectId === selectedProject.projectId &&
          r.runId !== selectedRunId &&
          !TERMINAL_RUN_STATUSES.includes(r.status),
      ) ?? null
    );
  }, [runs, selectedProject, selectedRunId]);

  return (
    <div className={`app ${filesOpen && canShowFiles ? 'with-files' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>RepoPilot</h1>
          <div className="sub">
            prototype ·{' '}
            {coreStatus === 'READY' ? 'Agent Core 就绪' : coreStatus === 'DOWN' ? 'Core 已退出' : 'Core 启动中'}
          </div>
        </div>

        <div className="sidebar-scroll">
          {projects.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 11.5, padding: '10px 8px' }}>
              还没有项目
            </div>
          )}

          {projects.map((p) => {
            const projectRuns = runsByProject.get(p.projectId) ?? [];
            const isCurrent = selectedProject?.projectId === p.projectId;
            return (
              <div key={p.projectId} className="project-group">
                <button
                  className={`list-item ${isCurrent && !selectedRunId && !showSettings ? 'active' : ''}`}
                  onClick={() => openProject(p)}
                >
                  <div className="name">{p.name}</div>
                  <div className="meta">{p.displayPath}</div>
                </button>
                {projectRuns.map((r) => (
                  <button
                    key={r.runId}
                    className={`run-item ${selectedRunId === r.runId ? 'active' : ''}`}
                    onClick={() => openRun(r)}
                    title={r.title}
                  >
                    <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                      <RunStatusBadge status={r.status} />
                      <RestoredBadge run={r} />
                    </div>
                    <div className="title">{r.title || r.runId}</div>
                  </button>
                ))}
              </div>
            );
          })}

          <button className="list-item" onClick={pickProject} style={{ color: 'var(--accent)' }}>
            <div className="name">+ 授权本地仓库…</div>
          </button>
        </div>

        <div className="sidebar-foot">
          <button
            className={showSettings ? 'primary' : ''}
            onClick={() => {
              setShowSettings(true);
              setError(null);
            }}
          >
            ⚙ 设置 · API
            {enabledModelCount === 0 && <span style={{ color: 'var(--warn)' }}> ⚠</span>}
          </button>
          <button
            disabled={!canShowFiles}
            className={filesOpen && canShowFiles ? 'primary' : ''}
            onClick={() => setFilesOpen((v) => !v)}
            title={canShowFiles ? '文件树' : '先导入一个项目'}
          >
            🗂 文件
          </button>
        </div>
      </aside>

      <main className="main">
        {!showSettings && selectedRun && <ChatHead run={selectedRun} events={events} />}

        <div className="chat-scroll">
          <div className="chat-scroll-inner">
            {error && (
              <Banner tone="err">
                <strong>{error.message}</strong>
                {error.detail && (
                  <pre className="output" style={{ marginTop: 8, maxHeight: 160 }}>
                    {error.detail}
                  </pre>
                )}
              </Banner>
            )}

            {coreStatus !== 'READY' && (
              <Banner tone="warn">Agent Core {coreStatus === 'DOWN' ? '已退出' : '正在启动'}，操作暂不可用。</Banner>
            )}

            {showSettings ? (
              <SettingsView
                checks={checks}
                profiles={modelProfiles}
                secureStorage={secureStorage}
                onProfilesChanged={setModelProfiles}
                onRefresh={bootstrap}
                onError={report}
              />
            ) : selectedRunId && selectedRun ? (
              <RunDetail
                run={selectedRun}
                events={events}
                toolCalls={toolCalls}
                approvals={approvals}
                plan={plan}
                patch={patch}
                verifications={verifications}
                onError={report}
                onRefresh={() => void loadRunDetail(selectedRunId)}
              />
            ) : selectedProject ? (
              <SnapshotPanel
                project={selectedProject}
                state={importState}
                onImport={(req) => void importProject(selectedProject, req)}
              />
            ) : (
              <WelcomeView
                checks={checks}
                enabledModelCount={enabledModelCount}
                onPick={pickProject}
                onSettings={() => setShowSettings(true)}
              />
            )}
          </div>
        </div>

        {/* 审批停靠条：等用户的决定永远压在可视区，不随时间线滚走 */}
        {!showSettings && selectedRun && (
          <ApprovalDock
            run={selectedRun}
            plan={plan}
            approvals={approvals}
            patch={patch}
            onError={report}
          />
        )}

        {!showSettings && selectedProject && importState.status === 'done' && (
          <Composer
            project={selectedProject}
            snapshot={importState.snapshot}
            profile={importState.profile}
            modelProfiles={modelProfiles}
            activeRun={activeProjectRun}
            onCreated={(run) => {
              setRuns((prev) => [run, ...prev]);
              setSelectedRunId(run.runId);
            }}
            onOpenRun={openRun}
            onOpenSettings={() => setShowSettings(true)}
            onError={report}
          />
        )}
      </main>

      {filesOpen && snapshotId && (
        <FileTreePanel
          snapshotId={snapshotId}
          runId={selectedRunId}
          refreshKey={filesKey}
          onClose={() => setFilesOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 会话顶栏：标题 + 状态 + 用量。
 * 状态徽章说人话（「待你审批」而不是 AWAITING_PLAN_APPROVAL），
 * 用量面板只画有真实上限的维度 —— 没有的（BYOK 套餐余量）不假装知道。
 */
function ChatHead({ run, events }: { run: RunView; events: RunEvent[] }) {
  const [usageOpen, setUsageOpen] = useState(false);
  const tokens = run.ledger.inputTokens + run.ledger.outputTokens;
  return (
    <div className="chat-head">
      <RunStatusBadge status={run.status} />
      <span className="chat-head-title" title={run.runId}>
        {run.title || run.runId}
      </span>
      <span className="spacer" />
      <div className="usage-wrap">
        <button className={`usage-chip ${usageOpen ? 'open' : ''}`} onClick={() => setUsageOpen((v) => !v)}>
          ▦ 用量 · {run.ledger.modelTurns}/{run.limits.maxModelTurns} 轮 ·{' '}
          {tokens > 0 ? `${(tokens / 1000).toFixed(1)}k tok` : '0 tok'}
        </button>
        {usageOpen && <UsagePanel run={run} events={events} />}
      </div>
    </div>
  );
}

function UsageBar({ label, used, max, unit }: { label: string; used: number; max: number; unit?: string }) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const tone = ratio >= 0.9 ? 'var(--err)' : ratio >= 0.7 ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="usage-row">
      <span className="usage-label">{label}</span>
      <span className="usage-value">
        {used}
        {unit ?? ''} / {max}
        {unit ?? ''}
      </span>
      <div className="usage-track">
        <div className="usage-fill" style={{ width: `${ratio * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

function UsagePanel({ run, events }: { run: RunView; events: RunEvent[] }) {
  // 最近一次真实出站的上下文大小：来自 MODEL_INVOCATION 事件里的 egress manifest。
  // provider 没回 usage 时是 null —— 显示「未知」，不填 0（null 表示无法证明，不等于 0）。
  const lastContext = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.kind !== 'MODEL_INVOCATION') continue;
      const manifest = (e.payload as { manifest?: { inputTokens?: number | null } } | null)?.manifest;
      if (manifest === undefined) continue;
      return manifest.inputTokens ?? null;
    }
    return undefined; // 还没有任何出站
  }, [events]);

  return (
    <div className="usage-pop">
      <UsageBar label="模型轮次" used={run.ledger.modelTurns} max={run.limits.maxModelTurns} />
      <UsageBar label="工具调用" used={run.ledger.toolCalls} max={run.limits.maxToolCalls} />
      <UsageBar label="自修复轮" used={run.ledger.selfFixRounds} max={run.limits.maxSelfFixRounds} />
      <UsageBar
        label="token 总量"
        used={run.ledger.inputTokens + run.ledger.outputTokens}
        max={run.limits.maxTotalTokens}
      />
      <UsageBar
        label="墙钟"
        used={Math.round(run.ledger.elapsedMs / 1000)}
        max={Math.round(run.limits.maxWallClockMs / 1000)}
        unit="s"
      />
      <div className="usage-row">
        <span className="usage-label">最近上下文</span>
        <span className="usage-value">
          {lastContext === undefined ? '尚无出站' : lastContext === null ? '未知（provider 未回报）' : `${lastContext} tok (in)`}
        </span>
      </div>
      <div className="usage-note">
        以上是本次 Run 的预算账本（超限即停，不重置）。BYOK 模式下你的套餐余量在供应商侧，
        这里不猜。
      </div>
    </div>
  );
}

/**
 * 审批停靠条 —— 修的是一个真实摔过的坑：待审批卡片按时间序排在时间线里，
 * 自动滚动到底后它在视口上方，用户"根本看不到"，以为没反应又建了一个任务。
 * 等用户决定的东西必须压在固定位置，不随滚动走。
 */
function ApprovalDock({
  run,
  plan,
  approvals,
  patch,
  onError,
}: {
  run: RunView;
  plan: PlanRevision | null;
  approvals: ApprovalRequest[];
  patch: PatchArtifact | null;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);

  // 刻意不用 smooth：容器里若有未结束的平滑滚动，smooth 的 scrollIntoView 会被静默吞掉
  // （实测于 Chromium）。这个按钮的全部意义是"一定能找到审批卡"，可靠性 > 动画。
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'center' });

  if (run.status === 'AWAITING_PLAN_APPROVAL' && plan && approvals.length > 0) {
    const approval = approvals[0]!;
    const decide = async (decision: 'APPROVE' | 'REJECT') => {
      setBusy(true);
      try {
        const r = await call('approval.decide', {
          approvalId: approval.approvalId,
          decision,
          subjectDigest: approval.subjectDigest,
          note: '',
        });
        if (!r.accepted) onError(new Error(r.reason ?? '审批未被接受'));
      } catch (err) {
        onError(err);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="dock dock-plan">
        <div className="dock-text">
          <strong>计划在等你审批</strong>
          <span className="dock-sub">
            {plan.steps.length} 步 · {plan.summary.slice(0, 80)}
            {plan.summary.length > 80 ? '…' : ''}
          </span>
        </div>
        <button onClick={() => jumpTo('plan-approval-card')}>看完整计划</button>
        <button className="danger" disabled={busy} onClick={() => void decide('REJECT')}>
          拒绝
        </button>
        <button className="primary" disabled={busy} onClick={() => void decide('APPROVE')}>
          批准并执行
        </button>
      </div>
    );
  }

  if (run.status === 'AWAITING_PATCH_REVIEW' && patch) {
    const added = patch.files.reduce((n, f) => n + f.addedLines, 0);
    const removed = patch.files.reduce((n, f) => n + f.removedLines, 0);
    return (
      <div className="dock dock-patch">
        <div className="dock-text">
          <strong>补丁在等你审查</strong>
          <span className="dock-sub">
            {patch.files.length} 个文件 · +{added}/-{removed} ·
            接受与否由你决定，审核方"通过"不算数
          </span>
        </div>
        <button className="primary" onClick={() => jumpTo('patch-review-card')}>
          审查补丁
        </button>
      </div>
    );
  }

  return null;
}

function WelcomeView({
  checks,
  enabledModelCount,
  onPick,
  onSettings,
}: {
  checks: DoctorCheck[];
  enabledModelCount: number;
  onPick: () => void;
  onSettings: () => void;
}) {
  const blocked = checks.filter((c) => c.status === 'BLOCKED');
  return (
    <Card title="开始">
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 14 }}>
        授权一个本地目录即可开始。任何项目都能导入 —— git 或非 git、干净或有未提交改动、
        是不是 Vite 都可以。
      </div>

      {enabledModelCount === 0 && (
        <Banner tone="warn">
          还没有可用的模型连接。设置任意一个环境变量后重启应用：
          <code> ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code> / <code>DEEPSEEK_API_KEY</code>。
        </Banner>
      )}
      {blocked.length > 0 && (
        <Banner tone="err">
          环境自检有 {blocked.length} 项未通过：{blocked.map((c) => c.label).join('、')}
        </Banner>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button onClick={onSettings}>⚙ 打开设置</button>
        <span className="spacer" />
        <button className="primary" onClick={onPick}>
          授权本地仓库…
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function SubPackagePicker({
  candidates,
  current,
  onPick,
}: {
  candidates: readonly SubPackageCandidate[];
  current: string;
  onPick: (subPath: string) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
      <label>导入范围（monorepo 可只导入一个子包）</label>
      <div>
        <button
          type="button"
          className={`chip ${current === '' ? 'selected' : ''}`}
          onClick={() => onPick('')}
        >
          整个仓库
        </button>
        {candidates.map((c) => (
          <button
            key={c.subPath}
            type="button"
            className={`chip ${current === c.subPath ? 'selected' : ''}`}
            onClick={() => onPick(c.subPath)}
            title={`${c.hasVite ? 'vite ' : ''}${c.hasReact ? 'react ' : ''}${c.hasTypescript ? 'ts' : ''}`}
          >
            {c.subPath}
            {c.hasVite && c.hasReact && c.hasTypescript ? ' ✦' : ''}
          </button>
        ))}
      </div>
      <div className="help">带 ✦ 的子包同时具备 vite + react + typescript，是首个切片的目标形态。</div>
    </div>
  );
}

function SnapshotPanel({
  project,
  state,
  onImport,
}: {
  project: ProjectRef;
  state: ImportState;
  onImport: (req: ImportRequest) => void;
}) {
  if (state.status === 'importing' || state.status === 'idle') {
    return (
      <Card title={project.name} hint={project.displayPath}>
        <div className="empty">
          正在导入快照…
          <div style={{ fontSize: 11, marginTop: 6 }}>
            读取 tracked 文件并逐个计算摘要，大仓库需要几秒。
          </div>
        </div>
      </Card>
    );
  }

  if (state.status === 'failed') {
    return (
      <Card
        title={project.name}
        hint={project.displayPath}
        right={<button onClick={() => onImport({})}>重试</button>}
      >
        <Banner tone="err">
          <strong>{state.message}</strong>
        </Banner>
        {state.detail && <pre className="output">{state.detail}</pre>}
      </Card>
    );
  }

  if (state.status === 'blocked') {
    return (
      <Card
        title={project.name}
        hint={project.displayPath}
        right={<button onClick={() => onImport({ subPath: state.subPath })}>重试</button>}
      >
        <Banner tone="err">
          <strong>
            {state.message}（{state.code}）
          </strong>
        </Banner>
        {state.detail && (
          <pre className="output" style={{ maxHeight: 200 }}>
            {state.detail}
          </pre>
        )}
        <SubPackagePicker
          candidates={state.candidates}
          current={state.subPath}
          onPick={(subPath) => onImport({ subPath })}
        />
      </Card>
    );
  }

  const { snapshot, profile, candidates } = state;
  const baseTone =
    snapshot.baseKind === 'CLEAN_COMMIT' ? 'ok' : snapshot.baseKind === 'NO_VCS' ? 'err' : 'warn';
  const baseLabel =
    snapshot.baseKind === 'CLEAN_COMMIT'
      ? '干净 commit 基线'
      : snapshot.baseKind === 'NO_VCS'
        ? '无版本控制'
        : `工作区基线 · ${snapshot.dirtyFileCount} 项改动`;
  const commandCount = Object.keys(profile.commands).length;

  return (
    <Card
      title={project.name}
      hint={project.displayPath}
      right={<button onClick={() => onImport({ subPath: snapshot.subPath })}>重新导入</button>}
    >
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Badge tone="ok">已信任并导入</Badge>
        {snapshot.subPath && <Badge tone="info">{snapshot.subPath}</Badge>}
        <Badge tone={baseTone}>{baseLabel}</Badge>
        <Badge>{snapshot.fileCount} 个文件</Badge>
        <Badge>{(snapshot.totalBytes / 1024).toFixed(0)} KB</Badge>
        <Badge tone={commandCount > 0 ? 'info' : 'warn'}>
          {commandCount > 0 ? `${commandCount} 个可用命令` : '未检测到命令'}
        </Badge>
        {profile.supportStatus === 'VERIFIED' && <Badge tone="purple">首切片标准形态</Badge>}
      </div>

      <dl className="kv">
        <dt>base</dt>
        <dd>
          {snapshot.baseKind === 'NO_VCS'
            ? '（不在 git 管理下）'
            : `${snapshot.baseSha.slice(0, 12)} (${snapshot.branch})${
                snapshot.baseKind === 'DIRTY_WORKTREE' ? ' + 未提交改动' : ''
              }`}
        </dd>
        <dt>tree digest</dt>
        <dd>{snapshot.treeDigest.slice(0, 26)}…</dd>
        <dt>检测信号</dt>
        <dd>{profile.detectedSignals.join(', ') || '（无）'}</dd>
        <dt>可用命令</dt>
        <dd>
          {Object.values(profile.commands)
            .map((c) => `${c.commandId} → ${c.label}`)
            .join('  |  ') || '（无，可在创建任务时自己填）'}
        </dd>
        <dt>排除文件</dt>
        <dd>{snapshot.excludedPaths.length} 个（依赖、产物、二进制、疑似 secret）</dd>
      </dl>

      {snapshot.baseKind !== 'CLEAN_COMMIT' && (
        <Banner tone="warn">
          {snapshot.baseKind === 'NO_VCS'
            ? '该项目不在版本控制下：基线是导入当时的目录内容，没有可回溯的 commit。'
            : `基线是工作区快照而非干净 commit。补丁依然可验证，但别人无法从 ${snapshot.baseSha.slice(0, 12)} 重建出同样的 base。`}
        </Banner>
      )}

      <SubPackagePicker
        candidates={candidates}
        current={snapshot.subPath}
        onPick={(subPath) => onImport({ subPath })}
      />
    </Card>
  );
}
