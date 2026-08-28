import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  DoctorCheck,
  ExclusionEntry,
  ModelConnectionProfile,
  PatchArtifact,
  PlanRevision,
  ProjectRef,
  RunEvent,
  RunView,
  SubPackageCandidate,
} from '@shared/domain';
import { TERMINAL_RUN_STATUSES } from '@shared/domain';
import { RequestError, call, setCoreEpoch, subscribe } from './bridge';
import {
  Badge,
  Banner,
  Card,
  DoctorBadge,
  RestoredBadge,
  RunStatusBadge,
  relativeTime,
  runStatusText,
  runStatusTone,
} from './components/common';
import { isTerminal } from '@shared/domain';
import { isOwnedReady } from './ownedAsync';
import { useApprovalAction, type ApprovalActionController } from './useApprovalAction';
import { useStickToBottom } from './useStickToBottom';
import {
  useProjectImport,
  useRunDetail,
  type ProjectImportState,
  type RunDetailState,
} from './useRendererOrchestration';
import { Composer } from './views/TaskForm';
import { CommandPalette, type PaletteCommand } from './views/CommandPalette';
import { RunDetail } from './views/RunDetail';
import { FileTreePanel } from './views/FileTree';
import { EditorPane, type EditorTab } from './views/Editor';
import { SettingsView } from './views/Settings';
import { EvidenceView } from './views/Evidence';

interface ImportRequest {
  subPath?: string;
}

/** 编辑器列可缩到的下限 / 对话列必须保住的下限（与 styles.css 的 minmax 一致） */
const EDITOR_MIN_WIDTH = 360;
const CHAT_MIN_WIDTH = 400;

export function App() {
  const [coreStatus, setCoreStatus] = useState<'READY' | 'RESTARTING' | 'DOWN'>('RESTARTING');
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [modelProfiles, setModelProfiles] = useState<ModelConnectionProfile[]>([]);
  const [secureStorage, setSecureStorage] = useState(true);
  const [credentialStore, setCredentialStore] = useState<'ABSENT' | 'OK' | 'UNREADABLE'>('ABSENT');
  const [credentialStoreDetail, setCredentialStoreDetail] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);

  const [selectedProject, setSelectedProject] = useState<ProjectRef | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const { state: importState, start: startProjectImport } = useProjectImport();
  const {
    state: runDetailState,
    start: loadRunDetail,
    reset: resetRunDetail,
    appendEvent,
    upsertToolCall,
    replaceApprovals,
  } = useRunDetail();
  // Dock 与详情卡必须共享同一个 ref-backed controller，React state 不能充当双入口互斥锁。
  const approvalAction = useApprovalAction(selectedRunId);

  /**
   * 左栏 Activity：运行列表 ⇄ 文件树（交互评审 v0.2 P1）。
   * 文件树从"最右一列、还会换位"改为左栏的第二个关注点 —— 树的惯例位在左，
   * 编辑器恒在右舞台，对话恒居中，任何面板都不再跳列。
   */
  const [sidebarView, setSidebarView] = useState<'runs' | 'files'>('runs');
  /** 文件树刷新令牌（Agent 改完文件后自增，让树重新拉取） */
  const [filesKey, setFilesKey] = useState(0);
  /**
   * 编辑器标签页（只读查看器）。换快照/项目时整体作废。
   * 预览/固定模型（v0.1 #7）：树单击产生的预览标签全局至多一个、被下一次预览复用；
   * 双击（树里或标签上）把它固定下来。IDE 惯例 —— 预览是临时的，固定才是"我要留着"。
   * diff 标签（P2）：补丁文件的改动以 `diff:` 前缀 id 并排打开，内容自带、始终固定。
   */
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeEditorTab, setActiveEditorTab] = useState<string | null>(null);
  /** 编辑器显式收起：标签保留，右舞台让位给对话（v0.2 N12 的"显式开关"） */
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  /**
   * 编辑器列宽（px）。null = 用 CSS 默认比例。用户拖过就记住（localStorage，
   * 纯呈现偏好，不进事件、不进 Core）；拖拽、方向键、双击复位三条路等价。
   */
  const [editorWidth, setEditorWidth] = useState<number | null>(() => {
    try {
      const v = Number(window.localStorage.getItem('repopilot.ui.editorWidth'));
      return Number.isFinite(v) && v >= EDITOR_MIN_WIDTH ? v : null;
    } catch {
      return null;
    }
  });

  const persistEditorWidth = useCallback((w: number | null) => {
    setEditorWidth(w);
    try {
      if (w === null) window.localStorage.removeItem('repopilot.ui.editorWidth');
      else window.localStorage.setItem('repopilot.ui.editorWidth', String(Math.round(w)));
    } catch {
      /* 存不了就只在本次会话内生效 —— 宽度是偏好，不是事实 */
    }
  }, []);

  const clampEditorWidth = (w: number) =>
    Math.min(Math.max(w, EDITOR_MIN_WIDTH), Math.max(EDITOR_MIN_WIDTH, window.innerWidth - 264 - CHAT_MIN_WIDTH));

  const startDividerDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const onMove = (ev: PointerEvent) => {
        setEditorWidth(clampEditorWidth(window.innerWidth - ev.clientX));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        persistEditorWidth(clampEditorWidth(window.innerWidth - ev.clientX));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [persistEditorWidth],
  );
  /** 设置页作为一个独立视图，而不是"没选项目时的兜底" */
  const [showSettings, setShowSettings] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  /**
   * 打开设置页时要不要滚到某张卡。侧栏历史折叠里的"清理"入口跳的是数据保留卡
   * （交互评审 v0.2 N9：归档/删除走 retention，缺的是列表层的出口）；
   * 普通"设置"按钮进来则不滚 —— 所以每个入口都显式声明自己的意图。
   */
  const [settingsFocus, setSettingsFocus] = useState<'retention' | null>(null);
  // 设置与证据都是全屏视图：选中 Run 的顶栏/新事件提示/审批停靠条/Composer 一律让位。
  // 只判 showSettings 会让证据页下仍可发任务、批准计划（交互评审 v0.2 N1）。
  const fullScreenView = showSettings || showEvidence;
  /** ⌘K 命令面板（v0.1 #10）：动作/运行/项目/文件的统一入口 */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * 全局键盘（v0.1 #11 / PRD-NFR-ACC-001）：
   *   ⌘K 命令面板 · Esc 关层（全屏视图退回）· F6 / Shift+F6 面板间循环。
   * 面板自己的 Esc（命令面板、任务选项弹层）在各自层里处理并先于这里生效。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && !paletteOpen && (showSettings || showEvidence)) {
        // 设置/证据是"层"：Esc 退回之前的运行/项目视图（v0.1 病根 B 的"只进不出"）
        setShowSettings(false);
        setShowEvidence(false);
        return;
      }
      if (e.key === 'F6') {
        e.preventDefault();
        const regions = ['.sidebar', '.main', '.editorpane']
          .map((sel) => document.querySelector<HTMLElement>(sel))
          .filter((el): el is HTMLElement => el !== null);
        if (regions.length === 0) return;
        const current = regions.findIndex((r) => r.contains(document.activeElement));
        const step = e.shiftKey ? -1 : 1;
        const next = regions[(current + step + regions.length) % regions.length]!;
        next
          .querySelector<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
          )
          ?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, showSettings, showEvidence]);

  const coreStatusRef = useRef(coreStatus);
  coreStatusRef.current = coreStatus;
  const bootstrapRequestRef = useRef(0);
  const runRefreshMarkerRef = useRef<string | null>(null);
  const selectedRunRef = useRef<string | null>(null);
  selectedRunRef.current = selectedRunId;

  const selectedRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const selectedRunDetail =
    selectedRunId && isOwnedReady(runDetailState, selectedRunId) ? runDetailState.data : null;

  /*
   * 时间线跟随。owner 用「当前视图身份」而不是只用 runId：从 Run 切到设置页再切回来
   * 也应该回到底部，而不是继承上一次的未读计数。计数来源是 durable events 的数量 ——
   * 它对应时间线上真实存在的行，不是估算出来的进度。
   */
  const followOwnerKey = showSettings ? '__settings__' : showEvidence ? '__evidence__' : selectedRunId;
  const follow = useStickToBottom<HTMLDivElement>({
    ownerKey: followOwnerKey,
    itemCount: showSettings || showEvidence ? 0 : (selectedRunDetail?.events.length ?? 0),
  });

  const report = useCallback((err: unknown) => {
    if (err instanceof RequestError) setError({ message: err.message, detail: err.detail });
    else setError({ message: (err as Error).message ?? '未知错误', detail: null });
  }, []);

  // ---- 启动加载 ----
  const bootstrap = useCallback(async () => {
    if (coreStatusRef.current !== 'READY') return;
    bootstrapRequestRef.current += 1;
    const requestId = bootstrapRequestRef.current;
    try {
      const [d, p, m, r] = await Promise.all([
        call('doctor.run', {}),
        call('project.list', {}),
        call('model.listProfiles', {}),
        call('run.list', {}),
      ]);
      if (requestId !== bootstrapRequestRef.current || coreStatusRef.current !== 'READY') return;
      setChecks(d.checks);
      setProjects(p.projects);
      setModelProfiles(m.profiles);
      setSecureStorage(m.secureStorage);
      setCredentialStore(m.credentialStore);
      setCredentialStoreDetail(m.credentialStoreDetail);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      if (requestId === bootstrapRequestRef.current) report(err);
    }
  }, [report]);

  useEffect(() => {
    let active = true;
    let statusEventRevision = 0;

    /*
     * 代次必须在任何后续请求之前落地：bootstrap 就是"后续请求"。顺序写反的话，
     * Core 重启后的第一次 bootstrap 会带着旧 epoch 出去，然后被 Main 正确地拒绝，
     * 表现为一次莫名其妙的启动失败。
     */
    const applyCoreStatus = (status: 'READY' | 'RESTARTING' | 'DOWN', epoch: number) => {
      setCoreEpoch(epoch);
      coreStatusRef.current = status;
      setCoreStatus(status);
      if (status === 'READY') {
        void bootstrap();
      } else {
        // Core 断开后，在途 bootstrap 即使稍后返回也不再拥有当前界面。
        bootstrapRequestRef.current += 1;
      }
    };

    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'core.status':
          statusEventRevision += 1;
          applyCoreStatus(event.status, event.epoch);
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
            appendEvent(event.runId, event.event);
          }
          break;
        case 'toolcall.updated':
          if (event.toolCall.runId === selectedRunRef.current) {
            upsertToolCall(event.toolCall.runId, event.toolCall);
            // 文件被改动了就刷新文件树，让改动实时可见
            if (event.toolCall.toolName === 'workspace_mutate' && event.toolCall.resolution === 'SUCCEEDED') {
              setFilesKey((k) => k + 1);
            }
          }
          break;
        case 'approval.updated':
          if (event.runId === selectedRunRef.current) replaceApprovals(event.runId, event.approvals);
          break;
      }
    });

    /*
     * did-finish-load 的状态 push 可能早于 React effect。先同步建立监听，再取 Main 的当前
     * 快照；若查询期间已有新 push，revision 会让旧快照失去提交资格。
     */
    const handshakeRevision = statusEventRevision;
    void call('core.getStatus', {})
      .then((snapshot) => {
        if (!active || statusEventRevision !== handshakeRevision) return;
        applyCoreStatus(snapshot.status, snapshot.epoch);
      })
      .catch((err) => {
        if (active) report(err);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [appendEvent, bootstrap, replaceApprovals, report, upsertToolCall]);

  useEffect(() => {
    if (!selectedRunId) {
      runRefreshMarkerRef.current = null;
      resetRunDetail();
      return;
    }
    // 同一个 Run 在 Core 重连后也要重读；断线窗口的 push 不可假设会补发。
    if (coreStatus === 'READY') {
      runRefreshMarkerRef.current = selectedRunId;
      void loadRunDetail(selectedRunId);
    } else {
      runRefreshMarkerRef.current = null;
    }
  }, [coreStatus, loadRunDetail, resetRunDetail, selectedRunId]);

  // 状态推进到需要新数据的节点时，每个持久化 Run 版本最多补拉一次。
  useEffect(() => {
    if (coreStatus !== 'READY' || !selectedRunId || !selectedRun || !selectedRunDetail) return;
    const needsRefresh =
      (selectedRun.status === 'AWAITING_PLAN_APPROVAL' && !selectedRunDetail.plan) ||
      (selectedRun.status === 'AWAITING_PATCH_REVIEW' && !selectedRunDetail.patch) ||
      // 失败/中止也可能封存了挽救补丁 —— run.updated 只带 view，不带补丁本体。
      ((selectedRun.status === 'FAILED' ||
        selectedRun.status === 'BLOCKED' ||
        selectedRun.status === 'CANCELLED') &&
        !selectedRunDetail.patch);
    if (!needsRefresh) return;

    const marker = `${selectedRun.runId}:${selectedRun.status}:${selectedRun.updatedAt}`;
    if (runRefreshMarkerRef.current === marker) return;
    runRefreshMarkerRef.current = marker;
    void loadRunDetail(selectedRunId);
  }, [coreStatus, loadRunDetail, selectedRun, selectedRunDetail, selectedRunId]);

  // ---- 动作 ----
  const importProject = useCallback(
    (project: ProjectRef, req: ImportRequest = {}) => {
      setError(null);
      void startProjectImport({ project, ...(req.subPath ? { subPath: req.subPath } : {}) });
    },
    [startProjectImport],
  );

  const openProject = useCallback(
    (project: ProjectRef) => {
      setShowSettings(false);
      setShowEvidence(false);
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
      setShowEvidence(false);
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
  /** 状态栏用：还没到终态的 Run 数（全部项目） */
  const activeRunCount = useMemo(() => runs.filter((r) => !isTerminal(r.status)).length, [runs]);
  const selectedImportData =
    selectedProject && isOwnedReady(importState, selectedProject.projectId) ? importState.data : null;
  const importedProject =
    selectedImportData?.outcome.outcome === 'IMPORTED' ? selectedImportData.outcome : null;
  /*
   * Run 的工作区必须使用创建它的 snapshot，而不是“当前项目最近一次导入”的 snapshot ——
   * 同一项目重新导入后两者会不同。这份事实现在由 RunView 自己携带（Slice C），
   * 不再从 plan 推导：plan 要到规划完成才存在，而 PLANNING 阶段的 Run 也该能看文件树。
   * 证据损坏的 Run 其 snapshotId 为 null，入口如实关闭。
   */
  const fileSnapshotId = selectedRunId
    ? (selectedRun?.snapshotId ?? null)
    : (importedProject?.snapshot.snapshotId ?? null);
  const canShowFiles = Boolean(fileSnapshotId);
  const editorActive =
    editorTabs.length > 0 && !editorCollapsed && canShowFiles && coreStatus === 'READY';

  // 快照一换，旧标签指向的坐标系就没了 —— 整体关闭，不带着过期路径进新世界
  useEffect(() => {
    setEditorTabs([]);
    setActiveEditorTab(null);
  }, [fileSnapshotId]);

  const openFileInEditor = useCallback((path: string, opts?: { pin?: boolean }) => {
    const pin = opts?.pin ?? false;
    setEditorTabs((prev) => {
      const existing = prev.find((t) => t.id === path);
      if (existing) {
        // 已开着：双击把预览升级为固定；固定的不降级
        return pin && !existing.pinned
          ? prev.map((t) => (t.id === path ? { ...t, pinned: true } : t))
          : prev;
      }
      const tab: EditorTab = { id: path, kind: 'file', path, pinned: pin };
      if (pin) return [...prev, tab];
      // 预览位全局至多一个：有就原位复用，没有才新开
      const previewIdx = prev.findIndex((t) => !t.pinned);
      if (previewIdx < 0) return [...prev, tab];
      const next = [...prev];
      next[previewIdx] = tab;
      return next;
    });
    setActiveEditorTab(path);
    // 打开文件就是"我要看编辑器"的显式表达 —— 收起态随之解除
    setEditorCollapsed(false);
  }, []);

  /** 补丁文件的改动进编辑器（P2）：内容是封存补丁的拷贝，始终固定标签 */
  const openDiffInEditor = useCallback(
    (file: { path: string; diff: string; truncated: boolean }) => {
      const id = `diff:${file.path}`;
      setEditorTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, kind: 'diff', path: file.path, pinned: true, diff: file.diff, truncated: file.truncated }],
      );
      setActiveEditorTab(id);
      setEditorCollapsed(false);
    },
    [],
  );

  const pinEditorTab = useCallback((id: string) => {
    setEditorTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: true } : t)));
  }, []);

  const closeEditorTab = useCallback((id: string) => {
    setEditorTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveEditorTab((cur) => {
        if (cur !== id) return cur;
        const idx = prev.findIndex((t) => t.id === id);
        return next[Math.min(idx, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

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

  /*
   * 命令面板的条目。全部复用已有的状态切换与 IPC —— 面板只是入口的集合，
   * 不是新的权威。条目按"此刻做得到"过滤：没有项目就没有"新任务"。
   */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const actions: PaletteCommand[] = [];
    if (importedProject && selectedProject) {
      actions.push({
        id: 'act:new-task',
        group: '动作',
        label: '新任务',
        detail: `在 ${selectedProject.name} 上描述要修的问题`,
        run: () => {
          setShowSettings(false);
          setShowEvidence(false);
          // Composer 常驻主栏底部；等全屏视图退场后聚焦输入框
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 0);
        },
      });
    }
    actions.push({
      id: 'act:settings',
      group: '动作',
      label: '打开设置 · API',
      run: () => {
        setSettingsFocus(null);
        setShowSettings(true);
        setShowEvidence(false);
      },
    });
    actions.push({
      id: 'act:evidence',
      group: '动作',
      label: '打开证据页',
      run: () => {
        setShowEvidence(true);
        setShowSettings(false);
      },
    });
    actions.push({
      id: 'act:retention',
      group: '动作',
      label: '清理历史记录',
      detail: '设置 · 数据保留（预演后逐项报数）',
      run: () => {
        setSettingsFocus('retention');
        setShowSettings(true);
        setShowEvidence(false);
      },
    });
    if (canShowFiles && coreStatus === 'READY') {
      actions.push({
        id: 'act:files',
        group: '动作',
        label: sidebarView === 'files' ? '回到运行列表' : '打开文件树',
        run: () => setSidebarView((v) => (v === 'files' ? 'runs' : 'files')),
      });
    }
    if (editorTabs.length > 0) {
      actions.push({
        id: 'act:editor',
        group: '动作',
        label: editorCollapsed ? '展开编辑器' : '收起编辑器',
        detail: `${editorTabs.length} 个标签`,
        run: () => setEditorCollapsed((v) => !v),
      });
    }
    const projectName = (id: string) => projects.find((p) => p.projectId === id)?.name ?? '';
    return [
      ...actions,
      ...runs.map((r) => ({
        id: `run:${r.runId}`,
        group: '运行' as const,
        label: r.title || r.runId,
        detail: `${projectName(r.projectId)} · ${runStatusText(r.status)}`,
        run: () => openRun(r),
      })),
      ...projects.map((p) => ({
        id: `project:${p.projectId}`,
        group: '项目' as const,
        label: p.name,
        detail: p.displayPath,
        run: () => openProject(p),
      })),
    ];
  }, [
    importedProject,
    selectedProject,
    canShowFiles,
    coreStatus,
    sidebarView,
    editorTabs.length,
    editorCollapsed,
    projects,
    runs,
    openRun,
    openProject,
  ]);

  /** 列表方向键（v0.1 #11）：↑↓ 在可见行间移动焦点；折叠区里的行不参与 */
  const onListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')].filter(
      (r) => r.closest('details:not([open])') === null,
    );
    if (rows.length === 0) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) {
      rows[0]!.focus();
      return;
    }
    rows[e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)]!.focus();
  }, []);

  const paletteFileSource = useMemo(
    () =>
      canShowFiles && fileSnapshotId && coreStatus === 'READY'
        ? { snapshotId: fileSnapshotId, runId: selectedRun?.restored ? null : selectedRunId }
        : null,
    [canShowFiles, fileSnapshotId, coreStatus, selectedRun?.restored, selectedRunId],
  );

  return (
    // 布局恒定（v0.2 N12）：侧栏 264px 恒左，对话恒居中，编辑器恒右舞台。
    // 唯一的布局变化是编辑器列的出现/收起 —— 没有任何面板会换位或换宽。
    <div
      className={`app ${editorActive ? 'ide' : ''}`}
      style={
        editorActive && editorWidth !== null
          ? { gridTemplateColumns: `264px minmax(${CHAT_MIN_WIDTH}px, 1fr) ${editorWidth}px` }
          : undefined
      }
    >
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>RepoPilot</h1>
          {/* Core 状态的唯一主场是底部状态栏（v0.1 #9）—— 这里不再重复 */}
          <div className="sub">prototype · disposable spike</div>
        </div>

        <div className="sidebar-tabs">
          <button
            className={sidebarView === 'runs' ? 'active' : ''}
            aria-pressed={sidebarView === 'runs'}
            onClick={() => setSidebarView('runs')}
          >
            运行
          </button>
          <button
            className={sidebarView === 'files' ? 'active' : ''}
            aria-pressed={sidebarView === 'files'}
            disabled={!canShowFiles || coreStatus !== 'READY'}
            title={
              canShowFiles
                ? '工作区 / 快照文件树'
                : selectedRunId
                  ? '该 Run 的证据已损坏，快照归属不可知'
                  : '先导入一个项目'
            }
            onClick={() => setSidebarView('files')}
          >
            文件
          </button>
        </div>

        {sidebarView === 'files' && fileSnapshotId && coreStatus === 'READY' ? (
          <FileTreePanel
            snapshotId={fileSnapshotId}
            // 恢复的 Run 工作区已回收：读它必然失败。直接回落到快照原貌，
            // 面板里说明为什么 —— 设计内状态不渲染成错误（交互评审 v0.2 N6）
            runId={selectedRun?.restored ? null : selectedRunId}
            workspaceGeneration={selectedRun?.restored ? null : (selectedRun?.workspaceGeneration ?? null)}
            workspaceRecycled={Boolean(selectedRun?.restored)}
            refreshKey={filesKey}
            onClose={() => setSidebarView('runs')}
            onOpenFile={openFileInEditor}
          />
        ) : sidebarView === 'files' ? (
          <div className="sidebar-scroll">
            <div style={{ color: 'var(--text-tertiary)', fontSize: 11.5, padding: '10px 8px' }}>
              {selectedRunId ? '该 Run 的证据已损坏，快照归属不可知。' : '先导入一个项目，文件树才有内容。'}
            </div>
          </div>
        ) : (
        <div className="sidebar-scroll" onKeyDown={onListKeyDown}>
          {projects.length === 0 && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 11.5, padding: '10px 8px' }}>
              还没有项目
            </div>
          )}

          {projects.map((p) => {
            const projectRuns = runsByProject.get(p.projectId) ?? [];
            const isCurrent = selectedProject?.projectId === p.projectId;
            return (
              <div key={p.projectId} className="project-group">
                <button
                  disabled={coreStatus !== 'READY'}
                  className={`list-item ${isCurrent && !selectedRunId && !showSettings && !showEvidence ? 'active' : ''}`}
                  onClick={() => openProject(p)}
                >
                  <div className="name">{p.name}</div>
                  <div className="meta">{p.displayPath}</div>
                </button>
                {(() => {
                  /*
                   * 列表层降噪（交互评审 P0-#1）：一行 = 状态点 + 标题 + 相对时间。
                   * 证据徽章（状态落后于事件 / 损坏）移到详情页头部 —— 移动，不是删除；
                   * 行内保留在 title 提示与 aria-label 里，可及性不因降噪而降级。
                   * 待人决定的状态额外带文字 chip：等用户的东西不允许只靠颜色。
                   */
                  const runRow = (r: RunView) => {
                    const evidenceNote =
                      r.evidence === 'DAMAGED' ? '证据损坏' : r.evidence === 'EVENTS_AHEAD' ? '状态落后于事件' : null;
                    const awaiting = r.status === 'AWAITING_PLAN_APPROVAL' || r.status === 'AWAITING_PATCH_REVIEW';
                    const label = `${runStatusText(r.status)}${evidenceNote ? `｜${evidenceNote}` : ''}｜${r.title || r.runId}`;
                    return (
                      <button
                        key={r.runId}
                        disabled={coreStatus !== 'READY'}
                        className={`run-item ${selectedRunId === r.runId ? 'active' : ''}`}
                        onClick={() => openRun(r)}
                        title={label}
                        aria-label={label}
                      >
                        <span className={`run-dot ${runStatusTone(r.status)}`} aria-hidden="true" />
                        <span className="run-title">{r.title || r.runId}</span>
                        {awaiting && <span className="run-await">待你决定</span>}
                        <span className="run-time">{relativeTime(r.updatedAt)}</span>
                      </button>
                    );
                  };
                  const activeRuns = projectRuns.filter((r) => !isTerminal(r.status));
                  const doneRuns = projectRuns.filter((r) => isTerminal(r.status));
                  const recentDone = doneRuns.slice(0, 5);
                  const olderDone = doneRuns.slice(5);
                  return (
                    <>
                      {activeRuns.map(runRow)}
                      {recentDone.map(runRow)}
                      {olderDone.length > 0 && (
                        // 折叠 + 报数 = 合规省略：更早的终态 Run 收起，但数量如实
                        <details className="run-history">
                          <summary>更早的 {olderDone.length} 条</summary>
                          {olderDone.map(runRow)}
                          {/* 历史的真删除走保留策略（证据按天龄回收）—— 出口放在数据所在之处 */}
                          <button
                            className="linklike run-history-clean"
                            onClick={() => {
                              setSettingsFocus('retention');
                              setShowSettings(true);
                              setShowEvidence(false);
                              setError(null);
                            }}
                          >
                            清理历史记录 → 设置 · 数据保留
                          </button>
                        </details>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })}

          <button
            className="list-item"
            disabled={coreStatus !== 'READY'}
            onClick={pickProject}
            style={{ color: 'var(--accent-interactive)' }}
          >
            <div className="name">+ 授权本地仓库…</div>
          </button>
        </div>
        )}

        <div className="sidebar-foot">
          <button
            className={showSettings ? 'primary' : ''}
            onClick={() => {
              setSettingsFocus(null);
              setShowSettings(true);
              setShowEvidence(false);
              setError(null);
            }}
          >
            ⚙ 设置 · API
            {enabledModelCount === 0 && <span style={{ color: 'var(--state-warning-fg)' }}> ⚠</span>}
          </button>
          <button
            className={showEvidence ? 'primary' : ''}
            onClick={() => {
              setShowEvidence(true);
              setShowSettings(false);
              setError(null);
            }}
            title="跨 Run 证据聚合（观察性事实，不构成 A/B 结论）"
          >
            📊 证据
          </button>
        </div>
      </aside>

      <main className="main">
        {!fullScreenView && selectedRun && (
          <ChatHead
            key={`chat-${selectedRun.runId}`}
            run={selectedRun}
            events={selectedRunDetail?.events ?? []}
          />
        )}

        {/* 编辑器收起后标签仍在 —— 给一条可见的回程路，别让状态藏起来 */}
        {!fullScreenView && editorCollapsed && editorTabs.length > 0 && canShowFiles && (
          <button className="editor-restore" onClick={() => setEditorCollapsed(false)}>
            编辑器已收起 · {editorTabs.length} 个标签 —— 点击展开
          </button>
        )}

        <div className="chat-scroll" ref={follow.containerRef}>
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

            <fieldset
              disabled={coreStatus !== 'READY'}
              aria-disabled={coreStatus !== 'READY'}
              style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
            >
              {showEvidence ? (
                <EvidenceView onError={(message, detail) => setError({ message, detail })} />
              ) : showSettings ? (
                <SettingsView
                  checks={checks}
                  profiles={modelProfiles}
                  secureStorage={secureStorage}
                  credentialStore={credentialStore}
                  credentialStoreDetail={credentialStoreDetail}
                  onProfilesChanged={setModelProfiles}
                  onRefresh={bootstrap}
                  onError={report}
                  focusSection={settingsFocus}
                />
              ) : selectedRunId && selectedRun ? (
                selectedRunDetail ? (
                  <RunDetail
                    key={`detail-${selectedRun.runId}`}
                    run={selectedRun}
                    events={selectedRunDetail.events}
                    toolCalls={selectedRunDetail.toolCalls}
                    approvals={selectedRunDetail.approvals}
                    plan={selectedRunDetail.plan}
                    patch={selectedRunDetail.patch}
                    priorPatches={selectedRunDetail.priorPatches}
                    verifications={selectedRunDetail.verifications}
                    approvalAction={approvalAction}
                    onError={report}
                    onRefresh={() => void loadRunDetail(selectedRunId)}
                    onOpenDiff={openDiffInEditor}
                  />
                ) : (
                  <RunDetailRequestPanel
                    runId={selectedRunId}
                    state={runDetailState}
                    coreReady={coreStatus === 'READY'}
                    onRetry={() => void loadRunDetail(selectedRunId)}
                  />
                )
              ) : selectedProject ? (
                <SnapshotPanel
                  project={selectedProject}
                  state={importState}
                  onImport={(req) => importProject(selectedProject, req)}
                />
              ) : (
                <WelcomeView
                  checks={checks}
                  enabledModelCount={enabledModelCount}
                  onPick={pickProject}
                  onSettings={() => { setSettingsFocus(null); setShowSettings(true); }}
                />
              )}
            </fieldset>
          </div>
        </div>

        {/*
          离底阅读时不抢滚动，只告诉用户积压了多少条。role=status 让它被播报，
          按钮本身是真按钮，因此 Tab / Enter / Space 与点击是同一条路径。
        */}
        {!fullScreenView && selectedRun && follow.pendingCount > 0 && (
          <div className="follow-nudge" role="status" aria-live="polite">
            {/* 外层高度为 0，内层绝对定位 —— 提示出现和消失都不推动时间线或停靠条。 */}
            <div className="follow-nudge-inner">
              <button className="follow-nudge-button" onClick={follow.jumpToBottom}>
                ↓ {follow.pendingCount} 条新事件
              </button>
            </div>
          </div>
        )}

        {/* 审批停靠条：等用户的决定永远压在可视区，不随时间线滚走 */}
        {!fullScreenView && selectedRun && selectedRunDetail && coreStatus === 'READY' && (
          <ApprovalDock
            key={`dock-${selectedRun.runId}`}
            run={selectedRun}
            plan={selectedRunDetail.plan}
            approvals={selectedRunDetail.approvals}
            patch={selectedRunDetail.patch}
            approvalAction={approvalAction}
          />
        )}

        {!fullScreenView && selectedProject && importedProject && (
          <fieldset
            disabled={coreStatus !== 'READY'}
            aria-disabled={coreStatus !== 'READY'}
            style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
          >
            <Composer
              key={`${selectedProject.projectId}:${importedProject.snapshot.snapshotId}`}
              project={selectedProject}
              snapshot={importedProject.snapshot}
              profile={importedProject.profile}
              modelProfiles={modelProfiles}
              activeRun={activeProjectRun}
              onCreated={(run) => {
                setRuns((prev) => [run, ...prev]);
                setSelectedRunId(run.runId);
              }}
              onReimport={() => importProject(selectedProject)}
              onOpenRun={openRun}
              onOpenSettings={() => { setSettingsFocus(null); setShowSettings(true); }}
              onError={report}
            />
          </fieldset>
        )}
      </main>

      {editorActive && fileSnapshotId && (
        <EditorPane
          snapshotId={fileSnapshotId}
          runId={selectedRunId}
          refreshKey={filesKey}
          tabs={editorTabs}
          active={activeEditorTab}
          onActivate={setActiveEditorTab}
          onClose={closeEditorTab}
          onPin={pinEditorTab}
          onCollapse={() => setEditorCollapsed(true)}
        />
      )}

      {/* 对话 ↔ 编辑器的分隔线：拖拽 / 方向键（±32px）/ 双击复位，三条路等价 */}
      {editorActive && (
        <div
          className="pane-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整编辑器宽度（方向键微调，双击复位）"
          tabIndex={0}
          onPointerDown={startDividerDrag}
          onDoubleClick={() => persistEditorWidth(null)}
          onKeyDown={(e) => {
            const base = editorWidth ?? Math.round(window.innerWidth * 0.4);
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              persistEditorWidth(clampEditorWidth(base + 32));
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              persistEditorWidth(clampEditorWidth(base - 32));
            }
          }}
        />
      )}

      {/*
        底部状态栏（v0.1 #9）：全局状态的唯一权威位。
        此前 Core 状态在侧栏顶部小字、模型在 composer 右下、预算只在 Run 详情 ——
        散落三个角落。这里只放全局事实，Run 级细节仍在各自主场。
      */}
      <footer className="statusbar" aria-label="状态栏">
        <span
          className={`statusbar-dot ${coreStatus === 'READY' ? 'ok' : coreStatus === 'DOWN' ? 'err' : 'warn'}`}
          aria-hidden="true"
        />
        <span>
          {coreStatus === 'READY' ? 'Agent Core 就绪' : coreStatus === 'DOWN' ? 'Core 已退出' : 'Core 启动中'}
        </span>
        {selectedProject && (
          <>
            <span className="statusbar-sep" aria-hidden="true">·</span>
            <span className="statusbar-project" title={selectedProject.displayPath}>
              {selectedProject.name}
            </span>
          </>
        )}
        {activeRunCount > 0 && (
          <>
            <span className="statusbar-sep" aria-hidden="true">·</span>
            <span>运行中 {activeRunCount}</span>
          </>
        )}
        <span className="spacer" />
        {selectedRun && !isTerminal(selectedRun.status) && (() => {
          /*
           * 显示**真正绑定的那个**约束，而不是笼统的"预算 N%"。
           *
           * 2026-08-28 的实测教训（EVI-PLANNING-CAP-001）：一个 Run 死于轮次上限时，
           * 状态栏显示的是 token「预算 36%」—— 看着很宽裕，而真正掐死它的维度不可见。
           * 一个只报最舒服那个数字的仪表，比没有仪表更误导。
           */
          const binding = bindingBudget(selectedRun);
          if (!binding) return null;
          return (
            <span className={binding.ratio >= 0.9 ? 'statusbar-tight' : undefined} title={binding.detail}>
              {binding.label} {binding.used}/{binding.max}
            </span>
          );
        })()}
        <button
          className="statusbar-models"
          onClick={() => {
            setSettingsFocus(null);
            setShowSettings(true);
            setShowEvidence(false);
          }}
          title="模型连接在「设置 · API」里配置"
        >
          {enabledModelCount > 0 ? `${enabledModelCount} 个模型可用` : '未配置模型'}
        </button>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        fileSource={paletteFileSource}
        onOpenFile={(path) => {
          // 从面板开文件 = 想看代码：全屏视图退场，编辑器以预览标签打开
          setShowSettings(false);
          setShowEvidence(false);
          openFileInEditor(path);
        }}
      />
    </div>
  );
}

/**
 * 找出**离上限最近**的那个预算维度 —— 状态栏只有一格，就该给绑定约束。
 *
 * 四个维度都有硬上限、超限即停：轮次、工具调用、token、墙钟。
 * 挑比值最大的那个显示，并在 title 里把四个都列全（省略要报数）。
 * 不做百分比换算成"剩余额度"之类的推断 —— BYOK 下套餐余量在供应商侧，这里不猜。
 */
export function bindingBudget(
  run: RunView,
): { label: string; used: string; max: string; ratio: number; detail: string } | null {
  const l = run.ledger;
  const m = run.limits;
  const tokens = l.inputTokens + l.outputTokens;
  const dims = [
    { label: '轮次', used: l.modelTurns, max: m.maxModelTurns, fmt: (n: number) => String(n) },
    { label: '工具', used: l.toolCalls, max: m.maxToolCalls, fmt: (n: number) => String(n) },
    { label: 'token', used: tokens, max: m.maxTotalTokens, fmt: (n: number) => `${(n / 1000).toFixed(0)}k` },
    {
      label: '时长',
      used: l.elapsedMs,
      max: m.maxWallClockMs,
      fmt: (n: number) => `${Math.round(n / 1000)}s`,
    },
  ].filter((d) => d.max > 0);
  if (dims.length === 0) return null;

  const detail =
    dims.map((d) => `${d.label} ${d.fmt(d.used)}/${d.fmt(d.max)}`).join(' · ') +
    '（四项都是硬上限，任一触顶即停，不重置）';
  const top = dims.reduce((a, b) => (b.used / b.max > a.used / a.max ? b : a));
  return {
    label: top.label,
    used: top.fmt(top.used),
    max: top.fmt(top.max),
    ratio: top.used / top.max,
    detail,
  };
}

/** 排除原因的中文标签。分类必须来自数据，不能是一句写死的"依赖、产物、二进制、疑似 secret"。 */
const EXCLUSION_LABEL: Record<ExclusionEntry['reason'], string> = {
  GIT_INTERNAL: 'git 内部文件',
  DEPENDENCY_DIR: '依赖目录',
  BUILD_OUTPUT: '构建产物',
  BINARY: '二进制',
  OVERSIZE: '超过单文件上限',
  SECRET_SUSPECT: '疑似 secret',
  SYMLINK: '软链接（不跟随）',
  UNREADABLE: '存在但读不了',
  LFS_POINTER: 'Git LFS 指针（不是真内容）',
  SUBMODULE: '子模块（另一个仓库）',
  NOT_CHECKED_OUT: '索引里有、工作区没有（未检出）',
  CASE_COLLISION: '仅大小写不同、指向同一文件',
  ENUMERATION_TRUNCATED: '枚举被上限截断',
};

/**
 * 形态层面的缺席：每一种的下一步动作都不同，所以一种一条横幅、各说各的修复路径。
 */
const SHAPE_BANNERS: ReadonlyArray<{
  reason: ExclusionEntry['reason'];
  tone: 'warn' | 'err';
  text: string;
}> = [
  {
    reason: 'LFS_POINTER',
    tone: 'err',
    text:
      '磁盘上是一段引用文本、不是文件真内容。收进来的话模型会把指针当源码改，' +
      '而那个补丁在你的仓库上 git apply 会成功 —— 真正的指针就被覆盖了。' +
      '要让 Agent 看到真内容：git lfs install && git lfs pull，然后重新导入。',
  },
  {
    reason: 'SUBMODULE',
    tone: 'warn',
    text: '子模块是另一个仓库的引用。要改它里面的代码，请把那个仓库单独导入成一个项目。',
  },
  {
    reason: 'NOT_CHECKED_OUT',
    tone: 'warn',
    text:
      '索引里有、工作区没有（通常是 sparse checkout）。Agent 看不到这些路径；' +
      '要修的代码若在其中，先 git sparse-checkout disable 或调整范围，再重新导入。',
  },
  {
    reason: 'CASE_COLLISION',
    tone: 'warn',
    text: '这些路径只有大小写不同、在当前文件系统上指向同一个文件，无法无歧义寻址，整组都没进快照。',
  },
];

/**
 * 按原因分组报数。
 *
 * 之前这里是一句硬编码的括号说明，无论实际排除了什么都照念 ——
 * 于是一个 OVERSIZE 排除会被说成"依赖、产物、二进制、疑似 secret"之一，
 * 而新增的 UNREADABLE / SYMLINK / 截断根本无从表达。报数要报真的那一类。
 */
function ExcludedSummary({ excluded }: { excluded: readonly ExclusionEntry[] }) {
  const byReason = new Map<ExclusionEntry['reason'], number>();
  for (const entry of excluded) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  if (excluded.length === 0) return <>0 个</>;
  const parts = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${EXCLUSION_LABEL[reason]} ${count}`);
  return (
    <>
      {excluded.length} 个（{parts.join('、')}）
    </>
  );
}

function RunDetailRequestPanel({
  runId,
  state,
  coreReady,
  onRetry,
}: {
  runId: string;
  state: RunDetailState;
  coreReady: boolean;
  onRetry: () => void;
}) {
  const failure = state.status === 'error' && state.ownerId === runId ? state.error : null;
  if (failure) {
    return (
      <Card title="运行详情" hint={runId} right={<button onClick={onRetry}>重试</button>}>
        <div role="alert">
          <Banner tone="err">
            <strong>{failure.message}</strong>
          </Banner>
          {failure.detail && <pre className="output">{failure.detail}</pre>}
        </div>
      </Card>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <Card title="运行详情" hint={runId}>
        <div className="empty">
          {coreReady ? '正在读取该运行的时间线与审批事实…' : '等待 Agent Core 就绪后读取运行详情…'}
          <div style={{ fontSize: 11, marginTop: 6 }}>
            详情归属确认完成前，不会显示或开放其他运行的审批操作。
          </div>
        </div>
      </Card>
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
      {/* 证据状态从列表层移到这里 —— 详情页是它的层级归属（交互评审 P0-#1） */}
      <RestoredBadge run={run} />
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
  const tone = ratio >= 0.9 ? 'var(--state-failed-fg)' : ratio >= 0.7 ? 'var(--state-warning-fg)' : 'var(--accent-interactive)';
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

  /** 同一次出站里命中前缀缓存的输入 token；undefined=尚无出站，null=provider 未回报 */
  const cacheRead = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.kind !== 'MODEL_INVOCATION') continue;
      const manifest = (e.payload as { manifest?: { cacheReadTokens?: number | null } } | null)
        ?.manifest;
      if (manifest === undefined) continue;
      return manifest.cacheReadTokens ?? null;
    }
    return undefined;
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
      {(run.ledger.unknownUsageTurns ?? 0) > 0 && (
        <div className="usage-row">
          <span className="usage-label">用量未知</span>
          <span className="usage-value" style={{ color: 'var(--state-warning-fg)' }}>
            {run.ledger.unknownUsageTurns} 轮未回报，上面的 token 数不含它们
          </span>
        </div>
      )}
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
      {/*
        输入 token 的计费构成。多轮循环每轮重发整段历史，命中前缀缓存的部分
        按远低于常规输入的价格计费 —— 只报一个总数会让账本看起来比实际更贵。
        provider 没回报就写「未回报」，不猜、不折算成 0。
      */}
      <div className="usage-row">
        <span className="usage-label">其中缓存命中</span>
        <span className="usage-value">
          {cacheRead === undefined
            ? '尚无出站'
            : cacheRead === null
              ? '未回报（该 provider 没给缓存构成）'
              : `${cacheRead} tok · 本轮输入的 ${lastContext ? Math.round((cacheRead / lastContext) * 100) : 0}%`}
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
  approvalAction,
}: {
  run: RunView;
  plan: PlanRevision | null;
  approvals: ApprovalRequest[];
  patch: PatchArtifact | null;
  approvalAction: ApprovalActionController;
}) {
  // 刻意不用 smooth：容器里若有未结束的平滑滚动，smooth 的 scrollIntoView 会被静默吞掉
  // （实测于 Chromium）。这个按钮的全部意义是"一定能找到审批卡"，可靠性 > 动画。
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'center' });

  if (run.status === 'AWAITING_PLAN_APPROVAL' && plan && approvals.length > 0) {
    const approval = approvals[0]!;
    const busy = approvalAction.isPending(approval.approvalId);
    const pendingDecision = approvalAction.pending.find(
      (item) => item.approvalId === approval.approvalId,
    )?.decision;
    const error =
      approvalAction.error?.approvalId === approval.approvalId
        ? approvalAction.error
        : null;
    return (
      <div className="dock dock-plan rp-enter">
        <div className="dock-text">
          <strong>计划在等你审批</strong>
          <span className="dock-sub">
            {error
              ? `${error.message}${error.detail ? ` · ${error.detail}` : ''}`
              : `${plan.steps.length} 步 · ${plan.summary.slice(0, 80)}${plan.summary.length > 80 ? '…' : ''}`}
          </span>
        </div>
        <button onClick={() => jumpTo('plan-approval-card')}>看完整计划</button>
        {error && <button onClick={() => void approvalAction.retry()}>重试</button>}
        <button
          className="danger"
          disabled={busy}
          onClick={() => void approvalAction.decide(approval, 'REJECT')}
        >
          {pendingDecision === 'REJECT' ? '拒绝中…' : '拒绝'}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void approvalAction.decide(approval, 'APPROVE')}
        >
          {pendingDecision === 'APPROVE' ? '批准中…' : '批准并执行'}
        </button>
      </div>
    );
  }

  if (run.status === 'AWAITING_PATCH_REVIEW' && patch) {
    const added = patch.files.reduce((n, f) => n + f.addedLines, 0);
    const removed = patch.files.reduce((n, f) => n + f.removedLines, 0);
    return (
      <div className="dock dock-patch rp-enter">
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
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
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
  state: ProjectImportState;
  onImport: (req: ImportRequest) => void;
}) {
  const ownsProject = state.ownerId === project.projectId;
  if (state.status === 'idle' || !ownsProject || state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" aria-busy="true">
        <Card title={project.name} hint={project.displayPath}>
          <div className="empty">
            {state.status === 'idle' ? '等待导入快照…' : '正在导入快照…'}
            <div style={{ fontSize: 11, marginTop: 6 }}>
              读取 tracked 文件并逐个计算摘要，大仓库需要几秒。
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Card
        title={project.name}
        hint={project.displayPath}
        right={<button onClick={() => onImport({})}>重试</button>}
      >
        <div role="alert">
          <Banner tone="err">
            <strong>{state.error.message}</strong>
          </Banner>
          {state.error.detail && <pre className="output">{state.error.detail}</pre>}
        </div>
      </Card>
    );
  }

  const { outcome, requestedSubPath } = state.data;
  if (outcome.outcome === 'BLOCKED') {
    return (
      <Card
        title={project.name}
        hint={project.displayPath}
        right={<button onClick={() => onImport({ subPath: requestedSubPath })}>重试</button>}
      >
        <Banner tone="err">
          <strong>
            {outcome.message}（{outcome.code}）
          </strong>
        </Banner>
        {outcome.detail && (
          <pre className="output" style={{ maxHeight: 200 }}>
            {outcome.detail}
          </pre>
        )}
        <SubPackagePicker
          candidates={outcome.candidates}
          current={requestedSubPath}
          onPick={(subPath) => onImport({ subPath })}
        />
      </Card>
    );
  }

  const { snapshot, profile, candidates } = outcome;
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

      {/*
        首屏摘要化（交互评审 P0-#3/#4）：上面的徽章行回答"这是什么、能验证什么"；
        警示合并进「注意事项（N）」折叠条 —— 折叠 + 报数 = 合规省略，原文一字不少；
        含 err 级（LFS / 枚举截断）时默认展开：必须处理的事不许被收起来藏住。
        digest / 检测信号 / 排除清单 / 导入范围是导入审计报告，收进「导入详情」。
      */}
      {(() => {
        const notices: { key: string; tone: 'warn' | 'err'; body: React.ReactNode }[] = [];
        if (snapshot.untrackedCount > 0) {
          notices.push({
            key: 'untracked',
            tone: 'warn',
            body: (
              <>
                导入范围内有 {snapshot.untrackedCount} 个未跟踪文件，它们**没有**进入快照。
                如果你要修的改动在这些文件里，先 <code>git add</code> 再重新导入 —— 否则 Agent
                看不到它们，基于这份快照产生的补丁也不会包含它们。
              </>
            ),
          });
        }
        /*
          形态层面的缺席各自一条：LFS / 子模块 / 未检出 / 大小写碰撞的下一步动作完全不同，
          合并成一句"共排除 N 个"等于什么也没说。LFS 单独用 err 色 —— 它是唯一一条
          会破坏用户真实仓库的形态（指针被当源码改，补丁在宿主上 apply 会成功）。
        */
        for (const { reason, tone, text } of SHAPE_BANNERS) {
          const hits = snapshot.excludedPaths.filter((e) => e.reason === reason);
          if (hits.length === 0) continue;
          notices.push({
            key: reason,
            tone,
            body: (
              <>
                <b>{hits.length} 项</b>因「{EXCLUSION_LABEL[reason]}」未进入快照（例如{' '}
                <code>{hits.slice(0, 3).map((e) => e.path).join('、')}</code>
                {hits.length > 3 ? ' 等' : ''}）。{text}
              </>
            ),
          });
        }
        if (snapshot.excludedPaths.some((e) => e.reason === 'ENUMERATION_TRUNCATED')) {
          notices.push({
            key: 'truncated',
            tone: 'err',
            body: (
              <>
                文件枚举在上限处被截断，这份快照**不完整**。fileCount、tree digest
                与给模型的仓库信息都只反映被收进来的那一部分。
              </>
            ),
          });
        }
        if (snapshot.baseKind !== 'CLEAN_COMMIT') {
          notices.push({
            key: 'base',
            tone: 'warn',
            body: (
              <>
                {snapshot.baseKind === 'NO_VCS'
                  ? '该项目不在版本控制下：基线是导入当时的目录内容，没有可回溯的 commit。'
                  : `基线是工作区快照而非干净 commit。补丁依然可验证，但别人无法从 ${snapshot.baseSha.slice(0, 12)} 重建出同样的 base。`}
              </>
            ),
          });
        }
        if (notices.length === 0) return null;
        const hasErr = notices.some((n) => n.tone === 'err');
        return (
          <details className="notice-fold" open={hasErr} data-testid="snapshot-notices">
            <summary>
              注意事项（{notices.length}）
              {hasErr && <span className="notice-fold-err">含必须处理项</span>}
            </summary>
            {notices.map((n) => (
              <Banner key={n.key} tone={n.tone}>
                {n.body}
              </Banner>
            ))}
          </details>
        );
      })()}

      <details className="import-details" data-testid="import-details">
        <summary>
          导入详情 · base{' '}
          {snapshot.baseKind === 'NO_VCS' ? '（无 VCS）' : snapshot.baseSha.slice(0, 12)} ·{' '}
          {commandCount} 个命令
        </summary>
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
          <dd>
            <ExcludedSummary excluded={snapshot.excludedPaths} />
          </dd>
          <dt>未跟踪文件</dt>
          <dd>
            {snapshot.untrackedCount === 0
              ? '0 个'
              : `${snapshot.untrackedCount} 个 —— 一个都没进快照（快照只含 tracked 文件）`}
          </dd>
        </dl>
        <SubPackagePicker
          candidates={candidates}
          current={snapshot.subPath}
          onPick={(subPath) => onImport({ subPath })}
        />
      </details>
    </Card>
  );
}
