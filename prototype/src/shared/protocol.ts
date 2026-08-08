/**
 * Renderer ⇄ Preload ⇄ Main ⇄ Core 的版本化通道契约。
 *
 * 边界规则（TD 不变式 #7 / overlay §3）：
 *   - Renderer 只提交意图，只接收安全投影；不持有 Node / FS / shell / secret。
 *   - Preload 只暴露白名单方法，做 shape / size 校验。
 *   - Main 校验 sender + schema + epoch，然后转交 Core；Main 不先写业务事实。
 *   - Core 是 Task / Run / Approval / Patch 的唯一权威。
 *
 * 因此这里**只有** method 名字的联合类型，没有通用 invoke(channel, ...args)。
 */

import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  DoctorCheck,
  FileTreeEntry,
  ModelConnectionProfile,
  PatchArtifact,
  PatchDecisionKind,
  PlanRevision,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEvent,
  RunView,
  SubPackageCandidate,
  TaskClass,
  TaskSpec,
  ToolCallView,
  VerificationRun,
} from './domain';

export const PROTOCOL_VERSION = '0.2.0';

export type ImportOutcome =
  | {
      readonly outcome: 'IMPORTED';
      readonly snapshot: RepositorySnapshot;
      readonly profile: RepositoryHarnessProfile;
      readonly candidates: readonly SubPackageCandidate[];
    }
  /**
   * 只有物理上做不到时才会出现：目录读不了、没有可用文件、超出容量。
   * 仓库脏不脏、是不是 git、是不是 Vite 都不会走到这里。
   */
  | {
      readonly outcome: 'BLOCKED';
      readonly code: string;
      readonly message: string;
      readonly detail: string;
      readonly candidates: readonly SubPackageCandidate[];
    };

/** 通道名固定为这三个；不存在动态注册的特权 channel */
export const IPC_CHANNEL = {
  request: 'repopilot:request',
  event: 'repopilot:event',
} as const;

// ---------------------------------------------------------------------------
// 请求 / 响应
// ---------------------------------------------------------------------------

export interface RequestMap {
  'doctor.run': { req: Record<string, never>; res: { checks: DoctorCheck[] } };

  'project.pick': { req: Record<string, never>; res: { project: ProjectRef | null } };
  'project.list': { req: Record<string, never>; res: { projects: ProjectRef[] } };
  /**
   * 导入结果是**判别联合**而不是"成功或抛错"。
   *
   * 被阻断是一个正常的、要展示给用户的终态，不是异常。这样 UI 拿到的永远是
   * 一个可渲染的结论（含子包候选和能否越过），不会退化成转不完的圈。
   */
  'project.import': {
    req: { projectId: string; subPath?: string };
    res: ImportOutcome;
  };

  'model.listProfiles': {
    req: Record<string, never>;
    res: { profiles: ModelConnectionProfile[]; secureStorage: boolean };
  };
  'model.testProfile': {
    req: { profileId: string };
    res: { ok: boolean; detail: string; latencyMs: number | null };
  };
  /**
   * 应用内保存 API Key，不需要重启。
   *
   * `apiKey` 只从 Renderer 走到 Main 就被 safeStorage 加密落盘，然后经私有 IPC
   * 注入 Core 内存。它不会写进任何日志、事件或配置文件，也不会再被回读到 Renderer。
   * 传空字符串等于删除。
   */
  'model.setKey': {
    req: { profileId: string; apiKey: string };
    res: { profiles: ModelConnectionProfile[] };
  };
  /** 修改模型 / 自定义 API 地址。这两项不是机密，会落盘。 */
  'model.updateProfile': {
    req: { profileId: string; modelId?: string; baseUrlOverride?: string };
    res: { profiles: ModelConnectionProfile[] };
  };
  /**
   * 新增一个自定义 provider（任意 OpenAI / Anthropic 兼容端点）。
   * 同 id 时覆盖内置项 —— 与参考 CLI 的 config-wins 合并策略一致。
   */
  'model.addProvider': {
    req: {
      id: string;
      name: string;
      api: string;
      wire?: 'anthropic' | 'openai';
      models?: string[];
      doc?: string;
    };
    res: { profiles: ModelConnectionProfile[] };
  };
  'model.removeProvider': {
    req: { providerId: string };
    res: { profiles: ModelConnectionProfile[] };
  };

  'task.create': {
    req: {
      projectId: string;
      snapshotId: string;
      profileId: string;
      modelProfileId: string;
      goal: string;
      taskClass: TaskClass;
      allowedPaths: string[];
      acceptance: string[];
      /** 可以为空数组：此时以未验证模式运行，终态只能是 ACCEPTED_UNVERIFIED */
      verificationCommandIds: string[];
      /** 用户手填的验证命令；检测不出命令的项目靠这个也能跑完整闭环 */
      customCommands?: Array<{ label: string; argv: string[] }>;
    };
    res: { task: TaskSpec; run: RunView };
  };

  'run.get': { req: { runId: string }; res: { run: RunView | null } };
  'run.list': { req: Record<string, never>; res: { runs: RunView[] } };
  /** 用 cursor 恢复，Renderer 重载后不丢事实（PRD-DESK-003） */
  'run.events': { req: { runId: string; afterSeq: number }; res: { events: RunEvent[] } };
  'run.toolCalls': { req: { runId: string }; res: { toolCalls: ToolCallView[] } };
  'run.cancel': { req: { runId: string; reason: string }; res: { run: RunView } };

  'plan.get': { req: { runId: string }; res: { plan: PlanRevision | null } };
  'approval.pending': { req: { runId: string }; res: { approvals: ApprovalRequest[] } };
  'approval.decide': {
    req: {
      approvalId: string;
      decision: ApprovalDecisionKind;
      /** 必须回传请求时的 digest；不匹配即失效（PRD-APPR-002） */
      subjectDigest: string;
      note: string;
    };
    res: { accepted: boolean; reason: string | null };
  };

  'patch.get': { req: { runId: string }; res: { patch: PatchArtifact | null } };
  'patch.decide': {
    req: {
      runId: string;
      patchId: string;
      decision: PatchDecisionKind;
      patchDigest: string;
      note: string;
    };
    res: { run: RunView; reason: string | null };
  };

  'verification.list': { req: { runId: string }; res: { verifications: VerificationRun[] } };

  /**
   * 文件树与文件内容。
   *
   * 传 `runId` 时读的是该 Run 工作区的**当前 generation** —— 也就是 Agent 改过之后的样子；
   * 不传则读导入时的快照原貌。两者都只读，且都在受管根内解析路径。
   */
  /**
   * 本地数据保留策略与清理。
   *
   * 分类保留：工作区在 Run 终态后短期回收，证据（事件/状态/补丁）保留 N 天。
   * 清理结果是**逐项**的，任何一项失败或被上限截断，整体只能是 INCOMPLETE。
   */
  'retention.get': {
    req: Record<string, never>;
    res: { policy: RetentionPolicyView; usage: DiskUsage; lastSummary: PurgeSummaryView | null };
  };
  'retention.update': {
    req: { evidenceDays?: number; workspaceGraceMinutes?: number };
    res: { policy: RetentionPolicyView; usage: DiskUsage; lastSummary: PurgeSummaryView | null };
  };
  'retention.sweepNow': {
    req: Record<string, never>;
    res: { summary: PurgeSummaryView; usage: DiskUsage; policy: RetentionPolicyView };
  };

  'files.tree': {
    req: { snapshotId: string; runId?: string };
    res: {
      entries: FileTreeEntry[];
      source: 'SNAPSHOT' | 'WORKSPACE';
      generation: number | null;
    };
  };
  'files.read': {
    req: { snapshotId: string; path: string; runId?: string };
    res: {
      path: string;
      content: string;
      bytes: number;
      truncated: boolean;
      binary: boolean;
      changed: boolean;
    };
  };

  /**
   * 把补丁交付出去。
   *
   * `SAVE_FILE` / `COPY` 不碰你的仓库；`APPLY_TO_REPO` 会真的写入宿主仓库，
   * 所以它先跑 `git apply --check`，任何冲突都整笔拒绝，不做部分应用。
   */
  'patch.export': {
    req: { runId: string; patchId: string; mode: 'SAVE_FILE' | 'COPY' | 'APPLY_TO_REPO' };
    res: PatchExportResult;
  };
}

export interface RetentionPolicyView {
  readonly schemaVersion: number;
  readonly evidenceDays: number;
  readonly workspaceGraceMinutes: number;
  readonly maxItemsPerSweep: number;
  readonly maxDurationMs: number;
}

export type DiskUsage = Record<string, { bytes: number; entries: number }>;

export interface PurgeItemView {
  readonly domain: 'WORKSPACE' | 'SNAPSHOT' | 'RUN_EVIDENCE' | 'ARTIFACT';
  readonly target: string;
  readonly outcome: 'DELETED' | 'KEPT_REFERENCED' | 'KEPT_NOT_DUE' | 'FAILED';
  readonly bytesFreed: number;
  readonly reason: string | null;
}

export interface PurgeSummaryView {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly scanned: number;
  readonly deleted: number;
  readonly bytesFreed: number;
  readonly status: 'COMPLETE' | 'INCOMPLETE';
  readonly incompleteReason: string | null;
  readonly items: readonly PurgeItemView[];
}

export type PatchExportResult =
  | { readonly ok: true; readonly mode: string; readonly detail: string; readonly target: string | null }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export type RequestMethod = keyof RequestMap;
export type RequestPayload<M extends RequestMethod> = RequestMap[M]['req'];
export type ResponsePayload<M extends RequestMethod> = RequestMap[M]['res'];

export interface IpcEnvelope<M extends RequestMethod = RequestMethod> {
  readonly protocolVersion: string;
  readonly requestId: string;
  readonly method: M;
  readonly payload: RequestPayload<M>;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: PlatformError };

/** 安全错误投影：不含 stack、raw request、secret、宿主路径 */
export interface PlatformError {
  readonly code:
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'POLICY_DENIED'
    | 'BLOCKED'
    | 'CORE_UNAVAILABLE'
    | 'INTERNAL';
  readonly message: string;
  readonly detail: string | null;
}

// ---------------------------------------------------------------------------
// 事件推送
// ---------------------------------------------------------------------------

export type PushEvent =
  | { readonly type: 'run.event'; readonly runId: string; readonly event: RunEvent }
  | { readonly type: 'run.updated'; readonly run: RunView }
  | { readonly type: 'toolcall.updated'; readonly toolCall: ToolCallView }
  | { readonly type: 'approval.updated'; readonly runId: string; readonly approvals: ApprovalRequest[] }
  | { readonly type: 'retention.swept'; readonly summary: PurgeSummaryView }
  | { readonly type: 'core.status'; readonly status: 'READY' | 'RESTARTING' | 'DOWN'; readonly detail: string };

// ---------------------------------------------------------------------------
// Preload 暴露给 Renderer 的唯一 API 面
// ---------------------------------------------------------------------------

export interface RepoPilotBridge {
  readonly protocolVersion: string;
  request<M extends RequestMethod>(
    method: M,
    payload: RequestPayload<M>,
  ): Promise<IpcResult<ResponsePayload<M>>>;
  subscribe(handler: (event: PushEvent) => void): () => void;
}
