import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  CommandDefinition,
  CommandResult,
  DataEgressConsent,
  DataEgressDisclosure,
  CommandApproval,
  PatchExportGrant,
  CrossReviewerIdentity,
  VendorParity,
  FailureClass,
  ModelConnectionProfile,
  LedgerCharge,
  CrossReviewRecord,
  CrossReviewRound,
  CrossReviewStopReason,
  CollaborationHandoff,
  CollaborationHandoffDecision,
  DoctorCheck,
  FileTreeEntry,
  ModelRouteResolution,
  PatchArtifact,
  PatchDecisionKind,
  PlanRevision,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEventKind,
  RunStatus,
  RunView,
  SubPackageCandidate,
  TaskSpec,
  ToolCallResolution,
  ToolCallView,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import {
  CROSS_REVIEW_LIMITS,
  EMPTY_LEDGER,
  applyLedgerCharge,
  isTerminal,
  legacyReviewerProfileId,
} from '@shared/domain';
import { sha256 } from '@shared/ids';
import type {
  ImportOutcome,
  PatchExportResult,
  PlatformError,
  PushEvent,
  ReviewerOption,
} from '@shared/protocol';
import { digestOf, newId, nowIso } from '@shared/ids';
import {
  AgentCancelled,
  ModelDispatchBudgetExceeded,
  PlanningFailed,
  composeUnverifiedItems,
  parseExternalSubmission,
  renderReviewBrief,
  runAgent,
  runCrossReviewCycle,
  runReviewPass,
  type AgentDeps,
  type ReviewPassRunner,
  type ExternalAuthorRunner,
  type ModelInvoker,
} from './agent';
import { EgressBlocked, InvocationFailed, ModelGateway } from './model/gateway';
import type { StreamSignal } from './model/types';
import { DEFAULT_MUTATION_POLICY, type MutationPolicy } from './mutation';
import { applyPatchWithGit, sealPatch } from './patch';
import {
  type ImportOptions,
  RepositoryImportError,
  findSubPackages,
  importSnapshot,
  resolveProfile,
  summarizeShapes,
} from './repo';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { buildChildEnv, resolveBinary } from './command';
import {
  SameVendorReviewDenied,
  assertHeterogeneousVendor,
  descriptorOfConnector,
  discoverConnectors,
  probeConnector,
  runExternalCliReview,
  type ExternalConnectorProfile,
} from './external/connector';
import {
  inferModelVendor,
  knownVendorSide,
  vendorParityOf,
  type VendorInference,
  type VendorSide,
} from './model/vendor';
import { runExternalCliAuthor } from './external/author';
import { verificationInputsFromCommands } from './coverage';
import { describeDlpHits, scanSegments } from './dlp';
import { commandArgvDigest, isApprovableCause, classifyUserCommand, userCommandAdmission } from './commandRisk';
import { buildDisclosure, consentedResolutionDigests, type DisclosureInput } from './egress';
import { buildEvidenceSummary, readEgressLog } from './evidence';
import { applyCandidate } from './external/normalize';
import {
  HANDOFF_DECISION_TTL_MS,
  HandoffConsumeError,
  HandoffLedger,
  sealHandoff,
} from './collaboration/handoff';
import { deriveFindingDispositions } from './collaboration/findingLifecycle';
import { EventStore, readJson, writeJsonAtomic } from './store';
import {
  RUN_STATE_SCHEMA_VERSION,
  listPersistedRunIds,
  readRunState,
  writeRunState,
} from './persistence';
import {
  type LiveReferences,
  type PurgeSummary,
  type RetentionPolicy,
  clampPolicy,
  diskUsage,
  loadLastSummary,
  loadPolicy,
  savePolicy,
  sweep,
} from './retention';
import { PATHS, ensureDataRoot, snapshotDir, workspaceDir } from './paths';
import { compareVerification, runVerification, type CommandApprovalChecker } from './verify';
import {
  MaterializedWorkspace,
  fileDigestAt,
  isGeneratedPath,
  listTree,
  resolveManaged,
} from './workspace';

/** 单个文件预览上限；超出只给前面这些字节 */
const MAX_VIEW_BYTES = 400_000;

const APPROVAL_TTL_MS = 30 * 60 * 1000;

interface ProjectRecord {
  readonly ref: ProjectRef;
  /** 宿主绝对路径只存在于这里，永不出现在任何投影里 */
  readonly hostPath: string;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  /** 兑现审批：内部会清理超时定时器、abort 监听，并恢复墙钟 deadline */
  readonly resolve: (decision: ApprovalDecisionKind, note?: string) => void;
}

/**
 * 可暂停的墙钟 deadline。
 *
 * 存在的理由：等待**人工审批**的时间不该算进 Run 的计算预算 —— 用户花 25 分钟
 * 审一个计划，不该导致 Run 被判 TIMED_OUT。所以进入审批等待时 pause()，
 * 用户决定后 resume()。审批期间模型并没有在跑，计算时间仍然是有界的。
 *
 * 之前是一个从 execute 开始就一直在走的 setTimeout，它覆盖了审批等待时间，
 * 且到点只 abort + setStatus，不兑现 awaitPlanApproval 的 Promise —— 于是
 * runAgent 永远挂在 await 上，execute 的 finally（清理 + CLEANUP_SUMMARY）永不执行。
 */
export class PausableDeadline {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private startedAt = 0;
  private done = false;
  /** 已经"真正在跑"的毫秒数：暂停期间不计入。是墙钟预算的唯一口径来源。 */
  private consumed = 0;

  /**
   * `priorConsumedMs`：本 Run 之前的 Attempt 已经用掉的净运行时长。
   * 墙钟预算是 **Task 级聚合**的（PRD-DIFF-003：新 Attempt 继续消耗同一份预算），
   * 所以新 Attempt 不能拿到一整份新的时间 —— 否则"要求修改"就成了无限续杯。
   */
  constructor(
    totalMs: number,
    private readonly onFire: () => void,
    priorConsumedMs = 0,
  ) {
    this.consumed = priorConsumedMs;
    this.remaining = Math.max(0, totalMs - priorConsumedMs);
    this.arm();
  }

  private arm(): void {
    if (this.done || this.handle) return;
    this.startedAt = Date.now();
    this.handle = setTimeout(() => {
      this.bank();
      this.handle = null;
      this.done = true;
      this.onFire();
    }, Math.max(0, this.remaining));
    this.handle.unref?.();
  }

  /** 把当前这段运行时间记入 consumed / 扣出 remaining。只在有活动计时器时有意义。 */
  private bank(): void {
    if (!this.handle) return;
    const ran = Date.now() - this.startedAt;
    this.consumed += ran;
    this.remaining -= ran;
    this.startedAt = Date.now();
  }

  pause(): void {
    if (this.done || !this.handle) return;
    this.bank();
    clearTimeout(this.handle);
    this.handle = null;
  }

  resume(): void {
    this.arm();
  }

  clear(): void {
    this.bank();
    this.done = true;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  /**
   * 净运行时长（排除暂停区间）。
   *
   * budgetExceeded 与账本的 elapsedMs 都必须从这里取，而不是各自 `Date.now() - startedAt`：
   * 之前正是两套口径 —— deadline 把审批等待排除在 TIMED_OUT 之外，账本却把它算进
   * 计算预算 —— 导致用户审批久一点、批准后第一轮 budgetExceeded 立刻命中，
   * 终态还被归因成 NO_CHANGES。一个 Run 只能有一种"用了多久"。
   */
  elapsedMs(): number {
    return this.consumed + (this.handle ? Date.now() - this.startedAt : 0);
  }
}

/**
 * 外部 CLI 单次审核超时。给得比模型 API 宽 —— CLI 有进程冷启动，
 * 内部可能自己重试。防的是挂死，不是延迟 SLA。
 */
const EXTERNAL_REVIEW_TIMEOUT_MS = 300_000;
/** 外部作者单次调用上限：改代码比审代码慢得多，但仍受任务墙钟预算收口 */
const EXTERNAL_AUTHOR_TIMEOUT_MS = 900_000;
/** 导出授权有效期：够用户在保存对话框里挑个位置，不够拿去以后重放 */
const EXPORT_GRANT_TTL_MS = 5 * 60 * 1000;
/**
 * 命令批准有效期：够用户批完把任务填完提交，不够让它变成"上周批的今天还在用"。
 * 批准和使用之间隔着一个表单，所以比导出授权宽一些。
 */
const COMMAND_APPROVAL_TTL_MS = 15 * 60 * 1000;

/** 审核方绑定：模型 API 与外部 CLI 两种选手，规则完全相同 */
/**
 * 外部作者绑定：本机 Codex / Claude CLI 当实现方。与 reviewer 的 EXTERNAL_CLI 分支同形，
 * 但角色不同 —— 它会在一次性 candidate 目录里写文件（见 external/author.ts）。
 * 没有 MODEL_API 分支：用模型 API 当作者就是 RepoPilot 自己的 Agent Loop，不需要绑定。
 */
export interface AuthorBinding {
  readonly connector: ExternalConnectorProfile;
  readonly apiKey: string;
  readonly label: string;
}

export type ReviewerBinding =
  | {
      readonly kind: 'MODEL_API';
      readonly resolution: ModelRouteResolution;
      /** 写审双方厂商同异的三态判定（写方 = 外部作者在场时是作者，否则是实现方模型） */
      readonly parity: VendorParity;
      readonly label: string;
    }
  | {
      readonly kind: 'EXTERNAL_CLI';
      readonly connector: ExternalConnectorProfile;
      readonly apiKey: string;
      readonly parity: VendorParity;
      readonly label: string;
    };

interface RunRecord {
  view: RunView;
  readonly task: TaskSpec;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  /**
   * 从磁盘恢复的 Run 没有活工作区（目录可能还在，也可能已被清理），
   * 所以这里可空。所有摸它的地方都必须显式处理 null，不能让它抛未分类异常。
   *
   * 非 readonly 的唯一理由：REQUEST_CHANGES 开新 Attempt 时要从同一快照重新物化一份
   * （TD §11.1「不能续用旧 workspace/lease」）。除那一处外没有别的赋值点。
   */
  workspace: MaterializedWorkspace | null;
  /** 依赖复用根（子包导入时是子包目录）。新 Attempt 重建工作区要用同一个 */
  readonly depsRoot: string | null;
  readonly events: EventStore;
  /** 同上：每个 Attempt 一个独立的取消信号，旧的不复用 */
  abort: AbortController;
  /** 运行期墙钟 deadline；审批等待时暂停。恢复态与非执行期为 null */
  deadline: PausableDeadline | null;
  readonly toolCalls: Map<string, ToolCallView>;
  readonly verifications: VerificationRun[];
  readonly approvals: Map<string, PendingApproval>;
  plan: PlanRevision | null;
  patch: PatchArtifact | null;
  /** 被 REQUEST_CHANGES 掉的历史补丁，按发生顺序；当前那份在 patch 里 */
  priorPatches: PatchArtifact[];
  /** 用户对上一版补丁的修改要求；下一次 runAgent 会把它写进任务简报，用完即清 */
  changeRequest: { note: string; previousPatchDigest: string; previousAttemptNo: number } | null;
  /**
   * 交叉审核方。null = 本任务不做交叉审核（未请求或降级）。
   * 与 implementer 严格分离 —— 绝不共用。
   *
   * 两种选手共存：模型 API profile（冻结 route）与外部 CLI 连接器。
   * 循环编排对此无知 —— 它只拿到一个 ReviewPassRunner。
   */
  reviewer: ReviewerBinding | null;
  /** 外部作者。null = 由 RepoPilot 自己的 Agent Loop 实现（默认） */
  author: AuthorBinding | null;
  /** 用户对本任务 DataEgressDisclosure 的同意；恢复态的旧 Run 可能没有（null） */
  consent: DataEgressConsent | null;
  /** 交叉审核聚合记录；跑过才有 */
  crossReview: CrossReviewRecord | null;
  pendingHandoff: CollaborationHandoff | null;
  handoffContinuation: { handoffId: string; resolve: () => void } | null;
  /** 交接等待独立于暂停的任务墙钟；每个 Run 同时最多一个。 */
  handoffExpiryTimer: ReturnType<typeof setTimeout> | null;
  collaborationMode: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO' | null;
  /** 同一 Attempt 的自修复、首审、整改和复审共享一个循环身份。 */
  collaborationCycleId: string | null;
  stopAfterStepRequested: boolean;
  /** 实现方冻结路由 + 执行起点。交叉审核续期（crossreview.continue）复用；恢复态没有 */
  implementerResolution?: ModelRouteResolution | null;
  plannerResolution?: ModelRouteResolution | null;
  executionStartedAt?: number | null;
}

/**
 * 「补丁能否写回宿主仓库」的门禁判定 —— 抽成纯函数，因为它是整个原型里
 * 唯一会写用户文件的动作的最后一道闸，必须能被单测直接打穿，而不依赖
 * 起一整个 RunAuthority + git 仓库。
 *
 * 两条规则：
 *   1. 必须先被接受（terminalFacts.patchAcceptanceId 存在）。REJECT / REQUEST_CHANGES
 *      走 BLOCKED、terminalFacts 为 null，被这条挡住。
 *   2. 请求里的 digest 必须与实际补丁一致；未提供一律拒绝 —— 写宿主仓库不接受"就地信任"。
 */
export type PatchApplyGate = { ok: true } | { ok: false; reason: string; detail: string };

export function checkPatchApplyGate(input: {
  status: RunStatus;
  patchAcceptanceId: string | null;
  actualDigest: string;
  requestedDigest: string | undefined;
}): PatchApplyGate {
  if (!input.patchAcceptanceId) {
    return {
      ok: false,
      reason: 'NOT_ACCEPTED',
      detail: `补丁尚未被接受（当前状态 ${input.status}）。请先在补丁审查里接受，再写回仓库。`,
    };
  }
  if (input.requestedDigest === undefined) {
    return {
      ok: false,
      reason: 'DIGEST_REQUIRED',
      detail: '写回宿主仓库必须携带补丁 digest 以校验一致性',
    };
  }
  if (input.actualDigest !== input.requestedDigest) {
    return { ok: false, reason: 'PATCH_CHANGED', detail: '补丁已变化，请刷新后重新确认' };
  }
  return { ok: true };
}

/**
 * 写回前的实体归属链复核。
 *
 * `git apply --check` 只能证明补丁在某个目录里能干净应用，不能证明那个目录就是
 * 产生补丁的项目。这里故意重复任务创建时的归属校验，并把 Run / Attempt / base / generation
 * 一并绑定；即使持久化证据损坏或内存记录被错误拼接，也必须在接触宿主仓库前 fail-closed。
 */
export function checkPatchApplyOwnership(input: {
  requestedRunId: string;
  projectId: string;
  view: Pick<RunView, 'runId' | 'taskId' | 'projectId' | 'attemptId' | 'workspaceGeneration'>;
  task: Pick<TaskSpec, 'taskId' | 'projectId' | 'snapshotId' | 'profileId'>;
  snapshot: Pick<RepositorySnapshot, 'snapshotId' | 'projectId' | 'baseSha'>;
  profile: Pick<RepositoryHarnessProfile, 'profileId' | 'snapshotId'>;
  patch: Pick<PatchArtifact, 'runId' | 'attemptId' | 'baseSha' | 'generation'>;
}): PatchApplyGate {
  const mismatches: Array<[valid: boolean, detail: string]> = [
    [input.view.runId === input.requestedRunId, 'Run 索引与 Run 记录不一致'],
    [input.task.taskId === input.view.taskId, 'Task 与 Run 记录不一致'],
    [input.task.projectId === input.view.projectId, 'Task 与 Run 的项目归属不一致'],
    [input.projectId === input.task.projectId, '宿主项目与 Task 的项目归属不一致'],
    [input.snapshot.projectId === input.task.projectId, 'Snapshot 与 Task 的项目归属不一致'],
    [input.task.snapshotId === input.snapshot.snapshotId, 'Task 与 Snapshot 记录不一致'],
    [input.task.profileId === input.profile.profileId, 'Task 与 Profile 记录不一致'],
    [input.profile.snapshotId === input.snapshot.snapshotId, 'Profile 与 Snapshot 归属不一致'],
    [input.patch.runId === input.view.runId, 'Patch 与 Run 归属不一致'],
    [input.patch.attemptId === input.view.attemptId, 'Patch 与 Attempt 归属不一致'],
    [input.patch.baseSha === input.snapshot.baseSha, 'Patch base 与 Snapshot base 不一致'],
    [input.patch.generation === input.view.workspaceGeneration, 'Patch 与 Run 的 workspace generation 不一致'],
  ];
  const mismatch = mismatches.find(([valid]) => !valid);
  return mismatch
    ? {
        ok: false,
        reason: 'OWNERSHIP_MISMATCH',
        detail: `实体归属校验失败，已拒绝写回宿主仓库：${mismatch[1]}`,
      }
    : { ok: true };
}

export class RunAuthority {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly profiles = new Map<string, RepositoryHarnessProfile>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly gateway = new ModelGateway();
  private readonly handoffs = new HandoffLedger();
  private readonly coreEpoch = Date.now();

  private readonly backgroundRetention: boolean;

  /**
   * `backgroundRetention` 默认开：产品里一个进程只有一个 RunAuthority，
   * 启动扫一次 + 每 6 小时一次是它该做的事。
   *
   * 只有测试需要关掉它。原因不是"清理有 bug"，而是测试里**多个 Authority 共用同一个
   * 受管数据根**（`vi.mock('./paths')` 整个文件一个 root，每个 Harness 一个 Authority）——
   * 每个实例都会在 +5s 时对这个共享根跑一遍 sweep，把**别的用例**正跑着的工作区、快照、
   * artifact 按"孤儿 / 已终态过宽限期"删掉。表现是随机的 `文件不存在: src/app.js`、
   * 模型脚本对不上、spawn 失败 —— 看起来像 flake，其实是真删。
   *
   * 关掉的是**调度**，不是 sweep 本身：retention 的行为仍由 retention.test.ts 直接测。
   */
  constructor(
    private readonly push: (event: PushEvent) => void,
    options: { backgroundRetention?: boolean } = {},
  ) {
    ensureDataRoot();
    for (const rec of readJson<ProjectRecord[]>(PATHS.projects, [])) {
      this.projects.set(rec.ref.projectId, rec);
    }
    this.rehydrateRuns();
    this.backgroundRetention = options.backgroundRetention ?? true;
    if (this.backgroundRetention) this.startRetentionSchedule();
  }

  // -------------------------------------------------------------------------
  // 持久化与恢复
  // -------------------------------------------------------------------------

  /**
   * 把 Run 的当前状态快照写盘。
   *
   * 调用约定：**先 append 事件，再调这个**。事件流是流水账，状态快照是结算结果；
   * 顺序反了会在崩溃窗口里产生"状态说成功、时间线停在半路"的说谎方式。
   */
  /**
   * 未消费的导出授权（PRD-DIFF-004）。一次性 + TTL：
   * 消费即删除，过期即无效。进程重启后全部作废 —— 授权不该跨重启存活。
   */
  private readonly exportGrants = new Map<string, PatchExportGrant>();

  /**
   * 未过期的命令批准（Slice K）。与导出授权同构：内存态、进程重启即作废。
   *
   * 批准**不写盘**是刻意的 —— 一旦持久化，它就会在下一次启动后继续生效，
   * 那正好又回到审计要打掉的"填一次即永久授权"。想再用一次就再批一次，
   * 代价是一次点击，换来的是这个授权不会在你不记得的时候还活着。
   */
  private readonly commandApprovals = new Map<string, CommandApproval>();

  private persist(record: RunRecord, required = false): void {
    try {
      writeRunState({
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        view: record.view,
        task: record.task,
        snapshot: record.snapshot,
        profile: record.profile,
        toolCalls: [...record.toolCalls.values()],
        verifications: record.verifications,
        plan: record.plan,
        patch: record.patch,
        priorPatches: record.priorPatches,
        crossReview: record.crossReview,
        eventHighWatermark: record.events.lastSeq(),
        persistedAt: nowIso(),
      });
    } catch (err) {
      // 普通快照失败留痕并继续；出站预留失败必须同步抛出，让调用在网络边界前停下。
      console.error('[core] 持久化 Run 状态失败', record.view.runId, err);
      if (required) throw err;
    }
  }

  /**
   * 启动时把磁盘上的 Run 读回来。
   *
   * 恢复出来的都是**只读**的：没有 Agent Loop、没有工作区，不能续跑。
   * 唯一的例外是 `AWAITING_PATCH_REVIEW` —— 补丁已封存、验证已完成，
   * 接受与否是纯粹的状态转换，不需要活的执行器。所以这个状态**可以跨重启存活**，
   * 用户第二天回来照样能接受并导出补丁。
   *
   * 其余非终态一律落成 `INTERRUPTED`：它们等的是一个已经不存在的执行器，
   * 假装还能继续才是真正的谎言。
   */
  private rehydrateRuns(): void {
    for (const runId of listPersistedRunIds()) {
      const loaded = readRunState(runId);
      const events = new EventStore(runId);

      if (!loaded.ok) {
        // 读不出来也要留在列表里，标明损坏 —— 不能让一个 Run 凭空消失
        const damaged = this.damagedRecord(runId, events, loaded.reason);
        if (damaged) this.runs.set(runId, damaged);
        continue;
      }

      const s = loaded.state;
      const collaborationProjection = s.view.collaborationProjection ?? (s.task.collaboration
        ? {
            roles: [
              s.task.collaboration.planner,
              s.task.collaboration.implementer,
              s.task.collaboration.reviewer,
            ].map(({ role, executionKind, label }) => ({ role, executionKind, label })),
            cycleId: null,
            currentCycle: { reviewerInvocations: 0, remediations: 0 },
            taskTotals: {
              reviewerInvocations: s.crossReview?.reviewerInvocations ?? 0,
              remediations: s.crossReview?.remediations ?? 0,
            },
          }
        : null);
      // 事件比状态新 = 崩溃发生在两次写之间。如实标注，不假装一致
      const eventsAhead = events.lastSeq() > s.eventHighWatermark;
      /*
       * 日志本身有读不出来的行，是比"状态落后"更硬的损坏：时间线中间缺了东西，
       * 而缺口在界面上与"这个 Run 本来就只跑到这里"无法区分。它优先于 EVENTS_AHEAD。
       */
      const logDamage = events.damageReport();

      const record: RunRecord = {
        view: {
          ...s.view,
          /*
           * 旧状态文件里没有 snapshotId 这个字段。回填成持久化状态里那份 snapshot 的 id ——
           * 它就是这个 Run 真正的坐标系，不是推测。留着 undefined 会让 Renderer 侧的
           * "不可知"与"旧格式"混成一种表现。
           */
          snapshotId: s.view.snapshotId ?? s.snapshot?.snapshotId ?? null,
          collaborationProjection,
          pendingHandoff: null,
          restored: true,
          evidence: logDamage ? 'DAMAGED' : eventsAhead ? 'EVENTS_AHEAD' : 'INTACT',
          evidenceDetail: logDamage
            ? `events.jsonl 第 ${logDamage.firstBadLine} 行起共 ${logDamage.unparseableLines} 行无法解析：` +
              '时间线在这些位置有缺口，其余事件仍已读出'
            : eventsAhead
              ? `事件流已到 seq ${events.lastSeq()}，状态快照停在 seq ${s.eventHighWatermark} —— 末尾若干事件未反映在状态里`
              : null,
        },
        task: s.task,
        snapshot: s.snapshot,
        profile: s.profile,
        workspace: null, // 恢复态没有活工作区
        events,
        abort: abortedController(),
        deadline: null,
        toolCalls: new Map(s.toolCalls.map((t) => [t.toolCallId, t])),
        verifications: [...s.verifications],
        approvals: new Map(),
        plan: s.plan,
        patch: s.patch,
        priorPatches: [...(s.priorPatches ?? [])],
        changeRequest: null,
        depsRoot: null, // 恢复态不续跑，也就不会再建工作区
        // 恢复态不再续跑，reviewer route 不重建；但已完成的审核记录要留着展示
        reviewer: null,
        author: null,
        consent: null,
        crossReview: s.crossReview ?? null,
        pendingHandoff: null,
        handoffContinuation: null,
        handoffExpiryTimer: null,
        collaborationMode: s.view.collaborationControl?.mode ?? s.task.collaboration?.mode ?? null,
        collaborationCycleId: null,
        stopAfterStepRequested: false,
        plannerResolution: null,
      };

      this.runs.set(runId, record);
      this.snapshots.set(s.snapshot.snapshotId, s.snapshot);
      this.profiles.set(s.profile.profileId, s.profile);

      this.closeInterruptedRun(record);
    }
  }

  /** 非终态且不是待补丁审查的，落成 INTERRUPTED 并补一条清理说明 */
  private closeInterruptedRun(record: RunRecord): void {
    const status = record.view.status;
    if (isTerminal(status) || status === 'AWAITING_PATCH_REVIEW') return;

    const previous = status;
    record.view = {
      ...record.view,
      status: 'INTERRUPTED',
      statusReason: `进程退出时该 Run 处于 ${previous}，重启后无法续跑`,
      failureClass: 'INTERRUPTED',
      updatedAt: nowIso(),
    };
    record.events.append(record.view.attemptId, 'STATUS_CHANGED', `${previous} → INTERRUPTED（进程退出）`, {
      from: previous,
      to: 'INTERRUPTED',
      reason: 'PROCESS_EXIT',
    });

    const wsDir = workspaceDir(record.view.runId);
    const workspaceRetained = existsSync(wsDir);
    /*
     * 子进程的去向只能如实分两种说：
     *   - 上一个进程走了正常退出路径（shutdown 追加过 PROCESS_EXIT_SIGNAL）：SIGTERM 已发，终止未确认；
     *   - 没有那条事件（崩溃 / 强杀 / 老版本）：一无所知，detached 进程组可能仍在跑。
     * 模型流是进程内 fetch，随进程退出必然释放，这一条可以确定地说。
     * 之前的措辞对两种情况都写"子进程已释放"—— 那是一条伪造的清理事实。
     */
    const signalled = record.events
      .all()
      .some((e) => e.kind === 'NOTE' && (e.payload as { kind?: unknown } | undefined)?.kind === 'PROCESS_EXIT_SIGNAL');
    const childProcesses: 'SIGTERM_SENT_UNCONFIRMED' | 'UNKNOWN' = signalled ? 'SIGTERM_SENT_UNCONFIRMED' : 'UNKNOWN';
    const childText = signalled
      ? '子进程：退出时已向命令进程组发送 SIGTERM，但未确认终止'
      : '子进程：状态未知（进程未经正常退出路径，运行中的命令可能仍在执行）';
    record.events.append(
      record.view.attemptId,
      'CLEANUP_SUMMARY',
      `模型流已随进程退出释放；${childText}；工作区 ${workspaceRetained ? `仍在磁盘上（gen-${record.view.workspaceGeneration}）` : '已不存在'}`,
      { workspaceRetained, reason: 'PROCESS_EXIT', modelStream: 'RELEASED', childProcesses },
    );
    this.persist(record);
  }

  /** 状态快照坏了，但目录还在 —— 用事件流能捞多少算多少，剩下的标明未知 */
  private damagedRecord(runId: string, events: EventStore, reason: string): RunRecord | null {
    const all = events.all();
    if (all.length === 0) return null; // 连事件都没有，不构成一个可展示的 Run
    const first = all[0]!;
    const last = all[all.length - 1]!;

    return {
      view: {
        runId,
        taskId: String(first.payload.taskId ?? 'unknown'),
        projectId: '',
        // 状态快照读不出来 = 快照归属不可知。写 null，而不是猜一个。
        snapshotId: null,
        title: first.summary.replace(/^任务已创建：/, '') || runId,
        attemptId: first.attemptId,
        attemptNo: 1,
        status: 'INTERRUPTED',
        statusReason: '状态快照损坏，仅能展示事件流',
        failureClass: 'INTERRUPTED',
        ledger: EMPTY_LEDGER,
        limits: {
          maxModelTurns: 0,
          maxToolCalls: 0,
          maxSelfFixRounds: 0,
          maxWallClockMs: 0,
          maxTotalTokens: 0,
        },
        workspaceGeneration: 0,
        createdAt: first.at,
        updatedAt: last.at,
        terminalFacts: null,
        restored: true,
        evidence: 'DAMAGED',
        evidenceDetail: reason,
      },
      task: null as unknown as TaskSpec,
      snapshot: null as unknown as RepositorySnapshot,
      profile: null as unknown as RepositoryHarnessProfile,
      workspace: null,
      events,
      abort: abortedController(),
      deadline: null,
      toolCalls: new Map(),
      verifications: [],
      approvals: new Map(),
      plan: null,
      patch: null,
      priorPatches: [],
      changeRequest: null,
      depsRoot: null,
      reviewer: null,
      author: null,
      consent: null,
      crossReview: null,
      pendingHandoff: null,
      handoffContinuation: null,
      handoffExpiryTimer: null,
      collaborationMode: null,
      collaborationCycleId: null,
      stopAfterStepRequested: false,
    };
  }

  // -------------------------------------------------------------------------
  // 请求分发
  // -------------------------------------------------------------------------

  async handle(method: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'doctor.run':
        return { checks: this.doctor() };

      case '__project.register':
        return { project: this.registerProject(String(payload.hostPath)) };

      case 'project.list':
        return { projects: [...this.projects.values()].map((p) => p.ref) };

      case 'project.import':
        return this.importProject(String(payload.projectId), {
          subPath: payload.subPath ? String(payload.subPath) : undefined,
        });

      case 'model.listProfiles':
        return { profiles: this.gateway.listProfiles(), secureStorage: true };

      // Main 解密后注入；Core 只在内存持有，绝不落盘
      case '__credentials.sync':
        this.gateway.syncCredentials(payload.keys as Record<string, string>);
        return { profiles: this.gateway.listProfiles() };

      case 'model.addProvider': {
        try {
          this.gateway.addCustomProvider({
            id: String(payload.id),
            name: String(payload.name ?? ''),
            api: String(payload.api),
            ...(payload.wire ? { wire: payload.wire as 'anthropic' | 'openai' } : {}),
            ...(Array.isArray(payload.models) ? { models: payload.models as string[] } : {}),
            ...(payload.doc ? { doc: String(payload.doc) } : {}),
          });
        } catch (err) {
          throw platformError('BAD_REQUEST', (err as Error).message);
        }
        return { profiles: this.gateway.listProfiles() };
      }

      case 'model.removeProvider':
        this.gateway.removeCustomProvider(String(payload.providerId));
        return { profiles: this.gateway.listProfiles() };

      case 'model.updateProfile': {
        this.gateway.updateProfile(String(payload.profileId), {
          ...(payload.modelId !== undefined ? { modelId: String(payload.modelId) } : {}),
          ...(payload.baseUrlOverride !== undefined
            ? { baseUrlOverride: String(payload.baseUrlOverride) }
            : {}),
        });
        return { profiles: this.gateway.listProfiles() };
      }

      case 'model.testProfile': {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        try {
          return await this.gateway.testProfile(String(payload.profileId), ac.signal);
        } finally {
          clearTimeout(timer);
        }
      }

      case 'task.create':
        return this.createTask(payload as never);

      case 'run.get':
        return { run: this.runs.get(String(payload.runId))?.view ?? null };

      case 'run.list':
        return {
          runs: [...this.runs.values()]
            .map((r) => r.view)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        };

      case 'run.events': {
        const rec = this.require(String(payload.runId));
        return { events: rec.events.after(Number(payload.afterSeq ?? 0)) };
      }

      case 'evidence.summary':
        // 全部输入都是平台已持有的事实（内存态 Run + egress.jsonl），只读聚合
        return {
          summary: buildEvidenceSummary(
            [...this.runs.values()].map((r) => ({
              view: r.view,
              verifications: r.verifications,
              crossReview: r.crossReview,
              patch: r.patch,
              priorPatches: r.priorPatches,
              events: r.events.all(),
            })),
            readEgressLog(),
          ),
        };

      case 'run.toolCalls': {
        const rec = this.require(String(payload.runId));
        return { toolCalls: [...rec.toolCalls.values()] };
      }

      case 'run.cancel':
        return { run: this.cancel(String(payload.runId), String(payload.reason ?? '用户取消')) };

      case 'plan.get':
        return { plan: this.runs.get(String(payload.runId))?.plan ?? null };

      case 'approval.pending': {
        const rec = this.require(String(payload.runId));
        return { approvals: [...rec.approvals.values()].map((a) => a.request) };
      }

      case 'approval.decide':
        return this.decideApproval(payload as never);

      case 'patch.get':
      {
        const rec = this.runs.get(String(payload.runId));
        return { patch: rec?.patch ?? null, priorPatches: rec?.priorPatches ?? [] };
      }

      case 'crossreview.get':
        return { crossReview: this.runs.get(String(payload.runId))?.crossReview ?? null };

      case 'crossreview.reviewers':
        return { reviewers: this.listReviewers() };

      case 'egress.disclosure':
        return { disclosure: this.disclosureFor(payload as never) };

      case 'crossreview.continue':
        return this.continueCrossReview(String(payload.runId));

      case 'collaboration.getHandoff':
        return { handoff: this.runs.get(String(payload.runId))?.pendingHandoff ?? null };

      case 'collaboration.continue':
        return this.continueCollaboration(payload as never);

      case 'collaboration.control':
        return this.updateCollaborationControl(payload as never);

      case 'patch.decide':
        return this.decidePatch(payload as never);

      case 'verification.list': {
        const rec = this.require(String(payload.runId));
        return { verifications: rec.verifications };
      }

      case 'retention.get':
        return {
          policy: loadPolicy(),
          usage: diskUsage(),
          lastSummary: loadLastSummary(),
        };

      case 'retention.update':
        return {
          policy: savePolicy({
            ...(payload.evidenceDays !== undefined ? { evidenceDays: Number(payload.evidenceDays) } : {}),
            ...(payload.workspaceGraceMinutes !== undefined
              ? { workspaceGraceMinutes: Number(payload.workspaceGraceMinutes) }
              : {}),
          }),
          usage: diskUsage(),
          lastSummary: loadLastSummary(),
        };

      case 'retention.sweepNow': {
        const summary = this.runSweep('manual');
        return { summary, usage: diskUsage(), policy: loadPolicy() };
      }

      /*
       * 预演。走的是与真删**完全相同**的判定路径（同一个 sweep、同一份 liveReferences），
       * 只跳过 rmSync —— 所以它给出的不是估算，是"按当前事实，这一次会删掉这些"。
       * 传入的策略只用于本次预演，不写盘：预览一个还没决定要不要保存的策略，
       * 不该产生任何持久化后果。
       */
      case 'retention.preview': {
        const previewPolicy = clampPolicy({
          ...loadPolicy(),
          ...(payload.evidenceDays !== undefined ? { evidenceDays: Number(payload.evidenceDays) } : {}),
          ...(payload.workspaceGraceMinutes !== undefined
            ? { workspaceGraceMinutes: Number(payload.workspaceGraceMinutes) }
            : {}),
        });
        const summary = sweep(this.liveReferences(), previewPolicy, Date.now(), { dryRun: true });
        return { summary, policy: previewPolicy };
      }

      case 'files.tree':
        return this.fileTree(
          String(payload.snapshotId),
          payload.runId === undefined ? null : String(payload.runId),
        );

      case 'files.read':
        return this.readFile(
          String(payload.snapshotId),
          String(payload.path),
          payload.runId === undefined ? null : String(payload.runId),
          parseExpectedGeneration(payload.expectedGeneration),
        );

      // Main 需要补丁正文来存文件 / 写剪贴板；这两件事是原生能力，由 Main 做
      case 'command.classify':
        return this.classifyCommand((payload.argv as string[]) ?? []);

      case 'command.requestApproval':
        return this.requestCommandApproval((payload.argv as string[]) ?? []);

      case '__patch.exportGrant':
        return this.issueExportGrant(String(payload.runId), String(payload.patchId));

      case '__patch.exportResult':
        return this.settleExportGrant(payload as never);

      case '__patch.applyToRepo':
        return this.applyPatchToRepo(
          String(payload.runId),
          String(payload.patchId),
          payload.patchDigest === undefined ? undefined : String(payload.patchDigest),
        );

      default:
        throw platformError('BAD_REQUEST', `未知方法: ${method}`);
    }
  }

  // -------------------------------------------------------------------------
  // 环境自检
  // -------------------------------------------------------------------------

  private doctor(): DoctorCheck[] {
    const checks: DoctorCheck[] = [
      {
        checkId: 'node',
        label: 'Node 运行时',
        status: 'READY',
        detail: `${process.version} / ${process.platform}-${process.arch}`,
        remediation: null,
      },
      {
        checkId: 'dataRoot',
        label: '本地数据根',
        status: 'READY',
        detail: PATHS.root,
        remediation: null,
      },
    ];

    try {
      const v = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
      checks.push({ checkId: 'git', label: 'Git', status: 'READY', detail: v, remediation: null });
    } catch {
      checks.push({
        checkId: 'git',
        label: 'Git',
        status: 'BLOCKED',
        detail: '未找到 git 可执行文件',
        remediation: '安装 Xcode Command Line Tools: xcode-select --install',
      });
    }

    /*
     * 验证命令用的工具链。
     *
     * 这条检查是打包之后才补的：从 Finder 启动的 .app 拿到的是 launchd 的 PATH，
     * 不是登录 shell 的。`/usr/bin/git` 是系统 shim 所以上面那条一直绿，
     * 但 nvm / Homebrew 装的 node、npm、pnpm 全都不在 GUI 的 PATH 里，
     * 于是每条验证命令都以 SPAWN_ERROR 收场，而自检看上去毫无问题。
     * 检查的是**子进程真正会拿到的那份 PATH**（buildChildEnv），不是 Core 自己的。
     */
    {
      const childEnv = buildChildEnv().env;
      const found: string[] = [];
      const missing: string[] = [];
      for (const bin of ['node', 'npm', 'npx', 'pnpm', 'yarn']) {
        (resolveBinary(bin, childEnv) ? found : missing).push(bin);
      }
      // node + 至少一个包管理器才算能跑 `<runner> run build` / `npx tsc`
      const runnable = found.includes('node') && found.some((b) => b !== 'node');
      checks.push({
        checkId: 'toolchain',
        label: '验证命令工具链',
        status: runnable ? 'READY' : 'BLOCKED',
        detail: runnable
          ? `可用: ${found.join(' / ')}${missing.length ? `（缺 ${missing.join(' / ')}）` : ''}`
          : `在验证命令的 PATH 里找不到 ${missing.join(' / ')}`,
        remediation: runnable
          ? null
          : '从 Finder 启动的应用继承的是 launchd 的 PATH，不含 nvm / Homebrew。' +
            '改从终端启动，或执行 `sudo launchctl config user path "$PATH"` 后重启。',
      });
    }

    /*
     * 外部编码代理（本机的 Claude / Codex）。三条道分开报，因为它们能力不同：
     *   API      —— 推荐路径：不依赖用户装了什么、路由可冻结、用量可记账、异构随便配
     *   CLI      —— 装了就能用的补充
     *   桌面应用 —— 检测得到但**不可自动化**（驱动它只能靠 GUI 自动化，合同禁止）
     *
     * 状态取 DEGRADED 而非 BLOCKED：交叉审核本来就是可选项，缺它不影响主链路，
     * 说成"阻断"是虚报严重度。
     */
    {
      const connectors = discoverConnectors();
      const apiVendors = this.gateway
        .listProfiles()
        .filter((p) => p.enabled)
        .map((p) => p.providerId);
      const cliReady = connectors.filter((c) => c.state === 'READY');
      const appOnly = connectors.filter((c) => c.state === 'PRESENT_NOT_AUTOMATABLE');

      // 能不能做异构一写一审：至少两个不同厂商的可用出口（API 已启用的 profile 各算一个）
      const usableVendors = new Set<string>([
        ...apiVendors,
        ...cliReady.map((c) => `cli:${c.vendor}`),
      ]);
      const parts = [
        `API 已启用 ${apiVendors.length} 个 provider`,
        cliReady.length > 0
          ? `CLI 可用：${cliReady.map((c) => `${c.label} ${c.version ?? ''}`.trim()).join(' / ')}`
          : 'CLI 无可用',
        ...(appOnly.length > 0
          ? [`桌面应用 ${appOnly.map((c) => c.label).join(' / ')}（检测到但不可自动化）`]
          : []),
      ];
      const canCrossReview = usableVendors.size >= 2;
      checks.push({
        checkId: 'externalAgents',
        label: '交叉审核可用出口',
        status: canCrossReview ? 'READY' : 'DEGRADED',
        detail: parts.join('；'),
        remediation: canCrossReview
          ? null
          : '一写一审需要两个不同来源。最省事的做法是再配一个供应商的 API Key' +
            (appOnly.length > 0
              ? '；桌面应用只能人工使用，驱动它需要 GUI 自动化，本产品不做'
              : ''),
      });
    }

    const profiles = this.gateway.listProfiles();
    const enabled = profiles.filter((p) => p.enabled);
    checks.push({
      checkId: 'modelProfile',
      label: '模型连接（BYOK）',
      status: enabled.length > 0 ? 'READY' : 'BLOCKED',
      detail:
        enabled.length > 0
          ? `已启用 ${enabled.length} 个: ${enabled.map((p) => `${p.label}(${p.modelId})`).join(', ')}`
          : '没有可用的模型 Profile',
      remediation:
        enabled.length > 0
          ? null
          : `设置以下任一环境变量后重启应用: ${profiles.map((p) => p.credentialEnvVar).join(' / ')}`,
    });

    return checks;
  }

  // -------------------------------------------------------------------------
  // 项目 / 导入
  // -------------------------------------------------------------------------

  private registerProject(hostPath: string): ProjectRef {
    for (const rec of this.projects.values()) {
      if (rec.hostPath === hostPath) return rec.ref;
    }
    const ref: ProjectRef = {
      projectId: newId('proj'),
      name: basename(hostPath),
      displayPath: shortenPath(hostPath),
      createdAt: nowIso(),
    };
    this.projects.set(ref.projectId, { ref, hostPath });
    writeJsonAtomic(PATHS.projects, [...this.projects.values()]);
    return ref;
  }

  /**
   * 把用户手填的验证命令并入 profile。
   *
   * 这是「任何仓库都能用」的关键：检测不出命令时，用户可以自己说明怎么验证。
   * 命令仍然是结构化 argv，不是自由 shell 字符串 —— 模型依旧只能按 id 引用，
   * 无法构造新命令。
   */
  private withUserCommands(
    profile: RepositoryHarnessProfile,
    custom: ReadonlyArray<{ label: string; argv: string[] }>,
    approvals: readonly CommandApproval[] = [],
    /** 出参：commandId ← approvalId，供 Run 创建后落账绑定 */
    usedApprovals?: Map<string, string>,
  ): RepositoryHarnessProfile {
    if (custom.length === 0) return profile;
    const commands = { ...profile.commands };
    const byDigest = new Map(approvals.map((a) => [a.argvDigest, a]));
    custom.forEach((c, i) => {
      const argv = c.argv.map((a) => a.trim()).filter(Boolean);
      if (argv.length === 0) return;
      /*
       * 风险分级发生在登记之前（Slice I-1）。登记即意味着：计划批准前作为基线跑一次、
       * 之后模型还能在预算内重复调用 —— 所以默认只有 R1 能进来；R3/R4 本就 deny。
       * 硬编码 'R1' 等于"填一次即永久授权"。
       *
       * Slice K 开了唯一一道口子：`UNKNOWN_BINARY` 这一类 R2 可以凭一张**这次请求里
       * 带过来的**一次性精确批准登记进来（见 commandRisk.ts 的说明）。批准绑整条 argv，
       * 所以这里用 digest 去认，而不是"用户批过某个可执行名"。
       */
      const admission = userCommandAdmission(argv, new Set(byDigest.keys()));
      if (!admission.ok) {
        throw platformError(
          'BAD_REQUEST',
          admission.message,
          admission.approvable
            ? '这条命令不在已知工具白名单内。可以逐条批准它（一次性、只对本次运行有效），或改用 node / pnpm 等已知入口包装。'
            : '验证命令只接受构建/测试/类型检查/lint/本地脚本（node、tsc、vitest、pnpm build…）',
        );
      }
      const commandId = `user${i + 1}`;
      const approval = admission.viaApproval ? byDigest.get(commandArgvDigest(argv))! : null;
      if (approval) usedApprovals?.set(approval.approvalId, commandId);
      commands[commandId] = {
        commandId,
        label: c.label.trim() || argv.join(' '),
        argv,
        cwdRelative: '.',
        timeoutMs: 600_000,
        risk: admission.verdict.risk,
        source: 'USER',
        approvalId: approval?.approvalId ?? null,
      };
    });
    return { ...profile, profileId: newId('prof'), commands };
  }

  private importProject(projectId: string, options: ImportOptions): ImportOutcome {
    const project = this.projects.get(projectId);
    if (!project) throw platformError('NOT_FOUND', '项目不存在');

    // 子包候选与导入是否成功无关：即使被阻断，用户也需要看到"可以换成哪个子包"
    let candidates: SubPackageCandidate[] = [];
    try {
      candidates = findSubPackages(project.hostPath);
    } catch {
      candidates = [];
    }

    let snapshot: RepositorySnapshot;
    try {
      snapshot = importSnapshot(projectId, project.hostPath, options);
    } catch (err) {
      if (err instanceof RepositoryImportError) {
        // 被阻断是正常终态，作为数据返回，不作为异常抛出
        return {
          outcome: 'BLOCKED',
          code: err.code,
          message: err.message,
          detail: err.detail,
          candidates,
        };
      }
      throw err;
    }

    const profile = resolveProfile(snapshot);
    this.snapshots.set(snapshot.snapshotId, snapshot);
    this.profiles.set(profile.profileId, profile);
    return { outcome: 'IMPORTED', snapshot, profile, candidates };
  }

  // -------------------------------------------------------------------------
  // 任务 / Run
  // -------------------------------------------------------------------------

  private createTask(input: {
    projectId: string;
    snapshotId: string;
    profileId: string;
    modelProfileId: string;
    plannerModelProfileId?: string;
    collaborationMode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
    goal: string;
    taskClass: TaskSpec['taskClass'];
    allowedPaths: string[];
    acceptance: string[];
    verificationCommandIds: string[];
    customCommands?: Array<{ label: string; argv: string[] }>;
    reviewerModelProfileId?: string;
    reviewerConnectorId?: string;
    /** 可选：用本机外部 CLI 当作者（Codex 写 / Claude 审，或反过来）。与审核方必须异构 */
    authorConnectorId?: string;
    handoffPayload?: string;
    handoffDigest?: string;
    /**
     * 用户同意的 DataEgressDisclosure digest（PRD-DATA-001）。Core 用同一输入重算披露并比对：
     * 缺失 → CONSENT_REQUIRED；对不上（路由/审核方/作者/快照任一不同）→ CONSENT_STALE。
     */
    egressConsentDigest?: string;
    /**
     * 用户在本次提交里逐条批准过的 R2 命令（Slice K）。批准由 `command.requestApproval`
     * 签发，只在内存里活着、有 TTL、绑整条 argv、一张只能进一个 Run。
     */
    commandApprovalIds?: readonly string[];
  }): { task: TaskSpec; run: RunView } {
    const project = this.projects.get(input.projectId);
    const snapshot = this.snapshots.get(input.snapshotId);
    const profile = this.profiles.get(input.profileId);
    if (!project || !snapshot || !profile) throw platformError('NOT_FOUND', '项目/快照/Profile 不存在');

    /*
     * 三个 ID 都来自 Renderer，分别“存在”不等于属于同一条实体链。这个检查必须早于
     * withUserCommands、route freeze、workspace 创建、Run/event 落盘和异步命令启动；
     * 否则迟到响应或被篡改的 IPC 可以把 A 的快照与 B 的宿主仓库拼成一个合法外观的 Run。
     */
    if (project.ref.projectId !== input.projectId || snapshot.projectId !== input.projectId) {
      throw platformError(
        'CONFLICT',
        '快照与所选项目的归属不一致，已拒绝创建任务',
        '请重新打开项目并等待该项目的导入完成后再创建任务。',
      );
    }
    if (profile.snapshotId !== input.snapshotId) {
      throw platformError(
        'CONFLICT',
        'Profile 与所选快照的归属不一致，已拒绝创建任务',
        '请重新导入当前项目，使用同一次导入返回的 Snapshot 与 Profile。',
      );
    }

    const hasHandoffPayload = typeof input.handoffPayload === 'string';
    const hasHandoffDigest = typeof input.handoffDigest === 'string';
    if (hasHandoffPayload !== hasHandoffDigest) {
      throw platformError('BAD_REQUEST', 'HANDOFF_INCOMPLETE：交接正文与摘要必须同时提交');
    }
    if (hasHandoffPayload && sha256(input.handoffPayload!) !== input.handoffDigest) {
      throw platformError(
        'CONFLICT',
        'HANDOFF_STALE：交接正文与冻结摘要不一致，已拒绝创建任务',
        '请回到观察面板重新生成交接包；平台不会采用被修改或过期的交接内容。',
      );
    }
    const effectiveGoal = hasHandoffPayload
      ? `${input.goal}\n\n[本机会话交接 ${input.handoffDigest}]\n${input.handoffPayload}`
      : input.goal;
    if (effectiveGoal.length > 20_000) {
      throw platformError('BAD_REQUEST', '任务描述与交接内容合计超过 20000 字符，请缩短任务描述');
    }

    /*
     * 这里**不再有 profile 门禁**。任何导入进来的项目都可以创建任务。
     *
     * 唯一还成立的约束不是"能不能跑"，而是"能不能声称成功"：
     * 没有验证命令时 Run 仍然照常执行、照常产出补丁，只是终态只能是
     * `ACCEPTED_UNVERIFIED` 而不是 `SUCCEEDED`。约束在终态处强制，不在入口处拦人。
     */
    /*
     * 任务文本是第一类出站数据，也会原样进 RUN_CREATED 事件落盘。用户把一把 key 粘进任务描述
     * 时，拒绝创建并说清楚 —— 而不是先落盘再靠网关那一道去拦（那时事件日志里已经有它了）。
     */
    const taskTextHits = scanSegments([
      { text: input.goal, where: '任务描述' },
      ...(hasHandoffPayload ? [{ text: input.handoffPayload!, where: '本机会话交接' }] : []),
      ...input.acceptance.map((a, i) => ({ text: a, where: `验收条件 ${i + 1}` })),
      ...(input.customCommands ?? []).map((c, i) => ({ text: `${c.label} ${c.argv.join(' ')}`, where: `自定义命令 ${i + 1}` })),
    ]);
    if (taskTextHits.length > 0) {
      throw platformError(
        'BAD_REQUEST',
        `任务文本含高置信度凭据（${describeDlpHits(taskTextHits)}），已拒绝创建`,
        '请把凭据从任务描述/验收条件/自定义命令里移除后再试；平台不会把它存进事件日志或发给模型',
      );
    }

    const usedApprovals = new Map<string, string>();
    const effectiveProfile = this.withUserCommands(
      profile,
      input.customCommands ?? [],
      this.liveApprovals(input.commandApprovalIds ?? []),
      usedApprovals,
    );
    const unknownCommands = input.verificationCommandIds.filter(
      // hasOwnProperty：否则 'constructor' 这类 id 能通过这道校验，一路走到运行时崩溃
      (id) => !Object.prototype.hasOwnProperty.call(effectiveProfile.commands, id),
    );
    if (unknownCommands.length > 0) {
      throw platformError('BAD_REQUEST', `未登记的验证命令: ${unknownCommands.join(', ')}`);
    }
    this.profiles.set(effectiveProfile.profileId, effectiveProfile);

    const resolution = this.gateway.freezeRoute(input.modelProfileId);
    const plannerResolution = input.plannerModelProfileId
      ? this.gateway.freezeRoute(input.plannerModelProfileId)
      : null;

    // 交叉审核方 route：每任务显式勾选，凭据缺失时降级为不审核，
    // 绝不回落到 implementer 的 route（那就成了自审）。
    let reviewer: ReviewerBinding | null = null;
    let reviewerDegradeNote: string | null = null;
    if (input.reviewerConnectorId) {
      // ---- 外部 CLI 审核方 ----
      try {
        reviewer = this.bindCliReviewer(input.reviewerConnectorId, resolution);
      } catch (err) {
        reviewerDegradeNote =
          err instanceof SameVendorReviewDenied
            ? `已请求外部 CLI 审核，但${err.message} —— 本次降级为不审核`
            : `已请求外部 CLI 审核，但连接器不可用（${(err as Error).message}）—— 本次降级为不审核`;
      }
    } else if (input.reviewerModelProfileId) {
      if (input.reviewerModelProfileId === input.modelProfileId) {
        // 同一个 profile 一写一审没有独立第二意见的价值，如实降级
        reviewerDegradeNote = '交叉审核方与实现方是同一个 profile —— 无法提供独立第二意见，已跳过交叉审核';
      } else {
        try {
          const reviewerResolution = this.gateway.freezeRoute(input.reviewerModelProfileId);
          /*
           * 同异按**厂商**判，不按 providerId：anthropic 官方与 openrouter 上的 claude
           * 是两个 provider、同一个厂商 —— 此前按 providerId 会把它标成"异构"。
           * 模型对模型的同厂商是披露项不是拦截项（硬拦只对外部代理，合同如此），
           * 但披露必须如实：证明同源写同源，证明不了写无法判定。
           */
          reviewer = {
            kind: 'MODEL_API',
            resolution: reviewerResolution,
            parity: vendorParityOf(
              this.routeSide('实现方', resolution),
              this.routeSide('审核方', reviewerResolution),
            ),
            label: `${reviewerResolution.providerId}/${reviewerResolution.modelId}`,
          };
        } catch (err) {
          // 审核方没配凭据：降级，不阻断任务创建，也不偷偷改用 implementer 的 key
          reviewerDegradeNote = `已请求交叉审核，但审核方 route 不可用（${(err as Error).message}）—— 本次降级为不审核`;
        }
      }
    }

    // 外部作者：绑定失败不降级 —— 用户点名要外部 CLI 写代码，悄悄换成内部模型去写等于换了作者
    let author: AuthorBinding | null = null;
    if (input.authorConnectorId) {
      author = this.bindCliAuthor(input.authorConnectorId, reviewer);
      // 外部作者在场时"写的一方"是作者不是实现方模型 —— 厂商同异按真正动手写的那一方重算
      if (reviewer) {
        reviewer = {
          ...reviewer,
          parity: vendorParityOf(
            this.connectorSide('外部作者', author.connector),
            this.reviewerSideOf(reviewer),
          ),
        };
      }
    }

    /*
     * 出站同意（PRD-DATA-001 / DEC-008）：第一笔模型出站之前，用户必须对"送什么、送给谁"
     * 的精确披露点过头。披露由 Core 以同一输入重算 —— 路由、审核方、作者、快照任一与界面
     * 展示时不同，digest 就对不上，旧同意自动作废。这里不做"缺了就当同意"的兜底。
     */
    const disclosure = buildDisclosure({
      snapshotId: snapshot.snapshotId,
      snapshotFileCount: snapshot.fileCount,
      implementer: { profile: this.requireProfile(input.modelProfileId), resolution },
      planner: plannerResolution
        ? { profile: this.requireProfile(plannerResolution.profileId), resolution: plannerResolution }
        : null,
      reviewer:
        reviewer === null
          ? null
          : reviewer.kind === 'MODEL_API'
            ? { kind: 'MODEL_API', profile: this.requireProfile(reviewer.resolution.profileId), resolution: reviewer.resolution }
            : { kind: 'EXTERNAL_CLI', connector: reviewer.connector },
      reviewerParity: reviewer?.parity ?? null,
      author: author ? { connector: author.connector } : null,
      handoffDigest: input.handoffDigest ?? null,
    });
    if (!input.egressConsentDigest) {
      throw platformError(
        'BAD_REQUEST',
        'CONSENT_REQUIRED：创建任务前必须确认数据出站披露',
        `本任务会向 ${disclosure.destinations.map((d) => d.label).join('、')} 发送数据；请先在任务选项里查看披露并确认`,
      );
    }
    if (input.egressConsentDigest !== disclosure.digest) {
      throw platformError(
        'BAD_REQUEST',
        'CONSENT_STALE：你确认的披露与本次任务的实际出站目的地不一致',
        '路由、审核方、作者或快照在确认之后变了；请重新查看披露并确认',
      );
    }
    const consent: DataEgressConsent = {
      consentId: newId('consent'),
      disclosureDigest: disclosure.digest,
      resolutionDigests: consentedResolutionDigests(disclosure),
      acceptedAt: nowIso(),
    };

    if (input.collaborationMode) {
      if (!plannerResolution) {
        throw platformError('BAD_REQUEST', '双 Agent 协作任务必须明确选择计划方');
      }
      if (!reviewer || reviewer.parity.kind !== 'HETEROGENEOUS') {
        throw platformError(
          'BAD_REQUEST',
          '双 Agent 协作要求实施方与审核方可证明异构',
          reviewer?.parity.detail ?? reviewerDegradeNote ?? '没有可用审核方',
        );
      }
      if (author && !author.connector.identityDigest) {
        throw platformError('BAD_REQUEST', '外部实施方身份无法冻结，不能进入双 Agent 协作');
      }
      if (reviewer.kind === 'EXTERNAL_CLI' && !reviewer.connector.identityDigest) {
        throw platformError('BAD_REQUEST', '外部审核方身份无法冻结，不能进入双 Agent 协作');
      }
      if (author || reviewer.kind === 'EXTERNAL_CLI') {
        throw platformError(
          'BAD_REQUEST',
          '原生引擎自动角色尚未通过 Core 工具治理准入',
          '当前外部 CLI 只具备一次性候选副本边界，尚无逐工具权限、命令分级和逐次账本证据；请改用已治理的模型 API 角色',
        );
      }
    }
    const collaboration = input.collaborationMode && plannerResolution && reviewer
      ? (() => {
          const planner = {
            role: 'PLANNER' as const,
            executionKind: 'MODEL_API' as const,
            profileId: plannerResolution.profileId,
            connectorId: null,
            identityDigest: plannerResolution.digest,
            label: `${plannerResolution.providerId}/${plannerResolution.modelId}`,
          };
          const implementer = author
            ? {
                role: 'IMPLEMENTER' as const,
                executionKind: 'MANAGED_ENGINE' as const,
                profileId: null,
                connectorId: author.connector.connectorId,
                identityDigest: author.connector.identityDigest!,
                label: author.label,
              }
            : {
                role: 'IMPLEMENTER' as const,
                executionKind: 'MODEL_API' as const,
                profileId: resolution.profileId,
                connectorId: null,
                identityDigest: resolution.digest,
                label: `${resolution.providerId}/${resolution.modelId}`,
              };
          const review = reviewer.kind === 'MODEL_API'
            ? {
                role: 'REVIEWER' as const,
                executionKind: 'MODEL_API' as const,
                profileId: reviewer.resolution.profileId,
                connectorId: null,
                identityDigest: reviewer.resolution.digest,
                label: reviewer.label,
              }
            : {
                role: 'REVIEWER' as const,
                executionKind: 'MANAGED_ENGINE' as const,
                profileId: null,
                connectorId: reviewer.connector.connectorId,
                identityDigest: reviewer.connector.identityDigest!,
                label: reviewer.label,
              };
          return {
            mode: input.collaborationMode!,
            planner,
            implementer,
            reviewer: review,
            roleBindingDigest: digestOf({ planner, implementer, reviewer: review }),
          };
        })()
      : undefined;

    const task: TaskSpec = {
      taskId: newId('task'),
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      profileId: effectiveProfile.profileId,
      goal: effectiveGoal,
      ...(input.handoffDigest ? { handoffDigest: input.handoffDigest } : {}),
      ...(collaboration ? { collaboration } : {}),
      taskClass: input.taskClass,
      // 不再默认收窄到 src/**：用户信任的是整个项目
      allowedPaths: input.allowedPaths.length ? input.allowedPaths : ['**'],
      protectedPaths: effectiveProfile.protectedPaths,
      nonGoals: [],
      acceptance: input.acceptance,
      verificationCommandIds: input.verificationCommandIds,
      budget: {
        maxModelTurns: 40,
        maxToolCalls: 80,
        maxSelfFixRounds: 2,
        maxWallClockMs: 20 * 60 * 1000,
        maxTotalTokens: 600_000,
      },
      createdAt: nowIso(),
    };

    /*
     * 快照目录必须还在磁盘上。
     *
     * 内存里的 snapshots map 有它、磁盘上却没有，是一个真实会发生的组合：
     * 保留策略的清理会回收"无 Run 引用"的快照，而刚导入还没建任务的快照
     * 恰好就是这个状态。之前这里不校验，直接进 cloneTree，抛出的是
     * 带宿主绝对路径的裸 ENOENT，一路冒泡成 `[core] unhandled` ——
     * 用户看到的是一个没有原因、也不知道怎么办的失败。
     * 悬空引用要在入口处判死，并且告诉用户下一步做什么。
     */
    if (!existsSync(snapshotDir(snapshot.snapshotId))) {
      throw platformError(
        'CONFLICT',
        '这个快照已不在磁盘上（多半是被数据保留清理回收了），无法用它创建任务',
        '点项目名重新导入一次即可 —— 重新导入会生成新的快照。',
      );
    }

    const runId = newId('run');
    const attemptId = newId('att');
    // 依赖复用要指向快照对应的那个目录：子包导入时是子包自己的 node_modules
    const depsRoot = snapshot.subPath ? join(project.hostPath, snapshot.subPath) : project.hostPath;
    const workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId, depsRoot);

    const collaborationCycleId = task.collaboration ? newId('cycle') : null;
    const view: RunView = {
      runId,
      taskId: task.taskId,
      projectId: input.projectId,
      snapshotId: snapshot.snapshotId,
      title: task.goal.length > 60 ? `${task.goal.slice(0, 60)}…` : task.goal,
      attemptId,
      attemptNo: 1,
      status: 'CREATED',
      statusReason: null,
      ledger: EMPTY_LEDGER,
      limits: task.budget,
      workspaceGeneration: workspace.activeGeneration,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      terminalFacts: null,
      collaborationControl: task.collaboration
        ? { mode: task.collaboration.mode, stopAfterStepRequested: false }
        : null,
      collaborationProjection: task.collaboration
        ? {
            roles: [
              task.collaboration.planner,
              task.collaboration.implementer,
              task.collaboration.reviewer,
            ].map(({ role, executionKind, label }) => ({ role, executionKind, label })),
            cycleId: collaborationCycleId,
            currentCycle: { reviewerInvocations: 0, remediations: 0 },
            taskTotals: { reviewerInvocations: 0, remediations: 0 },
          }
        : null,
      restored: false,
      evidence: 'INTACT',
      evidenceDetail: null,
    };

    const record: RunRecord = {
      view,
      task,
      snapshot,
      profile: effectiveProfile,
      workspace,
      events: new EventStore(runId),
      abort: new AbortController(),
      deadline: null,
      toolCalls: new Map(),
      verifications: [],
      approvals: new Map(),
      plan: null,
      patch: null,
      priorPatches: [],
      changeRequest: null,
      depsRoot,
      reviewer,
      author,
      consent,
      crossReview: null,
      pendingHandoff: null,
      handoffContinuation: null,
      handoffExpiryTimer: null,
      collaborationMode: task.collaboration?.mode ?? null,
      collaborationCycleId,
      stopAfterStepRequested: false,
      plannerResolution,
    };
    this.runs.set(runId, record);

    this.emit(record, 'RUN_CREATED', `任务已创建：${task.goal}`, {
      taskId: task.taskId,
      snapshotId: snapshot.snapshotId,
      route: { providerId: resolution.providerId, modelId: resolution.modelId, origin: resolution.origin },
      ...(plannerResolution
        ? { plannerRoute: { providerId: plannerResolution.providerId, modelId: plannerResolution.modelId, origin: plannerResolution.origin } }
        : {}),
      // 越过默认门禁的事实必须留在事件里，不能只存在于当时那次点击
      baseKind: snapshot.baseKind,
      dirtyFileCount: snapshot.dirtyFileCount,
      untrackedCount: snapshot.untrackedCount,
      excludedCount: snapshot.excludedPaths.length,
      subPath: snapshot.subPath || null,
      profileSupportStatus: effectiveProfile.supportStatus,
      verificationCommands: input.verificationCommandIds,
      userDefinedCommands: (input.customCommands ?? []).length,
      handoffDigest: input.handoffDigest ?? null,
      // 逐条批准过的 R2 命令数：它改变了"这个 Run 允许跑什么"，必须在 RUN_CREATED 里
      approvedCommands: usedApprovals.size,
      // 用户同意了什么：披露 digest + 目的地清单（标签/通道/是否中转/数据类别）。不含 actor 身份
      egressConsent: {
        consentId: consent.consentId,
        disclosureDigest: consent.disclosureDigest,
        destinations: disclosure.destinations.map((d) => ({
          role: d.role,
          channel: d.channel,
          label: d.label,
          origin: d.origin,
          isRelay: d.isRelay,
          dataClasses: d.dataClasses,
        })),
        policy: disclosure.policy,
      },
    });
    // 绑定要紧跟 RUN_CREATED：Run 存在之前批准无处可落，Run 开跑之前它必须已在账上
    this.bindApprovals(record, usedApprovals);
    this.emit(
      record,
      'NOTE',
      `数据出站披露已确认（${consent.disclosureDigest.slice(0, 16)}）：${disclosure.destinations
        .map((d) => `${d.role === 'IMPLEMENTER' ? '实现方' : d.role === 'REVIEWER' ? '审核方' : '作者'} ${d.label}${d.isRelay ? '（中转）' : ''}`)
        .join('；')}；保留/训练/地域政策：未知`,
      { egressConsent: { disclosureDigest: consent.disclosureDigest } },
    );

    // 这些不是拦截，是**如实标注**：任何影响"成功意味着什么"的事实都进事件
    if (snapshot.baseKind === 'DIRTY_WORKTREE') {
      this.emit(
        record,
        'NOTE',
        `基线是工作区快照而非干净 commit（${snapshot.dirtyFileCount} 项本地改动）：补丁的 base 无法被他人从 ${snapshot.baseSha.slice(0, 12)} 重建`,
      );
    }
    if (snapshot.baseKind === 'NO_VCS') {
      this.emit(record, 'NOTE', '该项目不在版本控制下：基线是导入当时的目录内容，没有可回溯的 commit');
    }
    /*
     * untracked 文件的缺席是个**独立**事实，必须与 dirty 分开说。
     * 只新建了文件的仓库现在是 CLEAN_COMMIT 基线，如果这条 NOTE 不发，
     * 用户与模型都会以为那些新文件在快照里。
     */
    /*
     * 形态层面的缺席（LFS / 子模块 / 未检出 / 大小写碰撞）各发一条 NOTE：
     * 它们与 dirty/untracked 一样，都是"影响成功意味着什么"的事实，而且每一种的下一步都不同。
     */
    for (const shape of summarizeShapes(snapshot.excludedPaths)) {
      this.emit(
        record,
        'NOTE',
        `仓库形态：${shape.count} 项因「${
          shape.kind === 'LFS_POINTER'
            ? 'Git LFS 指针'
            : shape.kind === 'SUBMODULE'
              ? '子模块'
              : shape.kind === 'NOT_CHECKED_OUT'
                ? '未检出'
                : '大小写碰撞'
        }」未进入快照（例如 ${shape.samples.join('、')}）。${shape.advice}`,
        { shape: shape.kind, count: shape.count, samples: shape.samples },
      );
    }
    if (snapshot.untrackedCount > 0) {
      this.emit(
        record,
        'NOTE',
        `导入范围内有 ${snapshot.untrackedCount} 个未跟踪文件，它们没有进入快照：` +
          `快照只含 tracked 文件，因此这些文件对 Agent 不可见，补丁也不会包含它们`,
      );
    }
    if (snapshot.excludedPaths.some((e) => e.reason === 'ENUMERATION_TRUNCATED')) {
      this.emit(
        record,
        'NOTE',
        '文件枚举在上限处被截断：这份快照不完整，文件数与 tree digest 只反映被收进来的那一部分',
      );
    }
    const unreadable = snapshot.excludedPaths.filter((e) => e.reason === 'UNREADABLE').length;
    if (unreadable > 0) {
      this.emit(
        record,
        'NOTE',
        `${unreadable} 个路径存在但读不了（权限或竞态），没有进入快照 —— 与"不存在"不同，这里是读取失败`,
      );
    }
    if (input.verificationCommandIds.length === 0) {
      this.emit(
        record,
        'NOTE',
        '本次任务没有选择任何验证命令：改动不会被机器验证，接受后终态为 ACCEPTED_UNVERIFIED 而不是 SUCCEEDED',
      );
    }
    if (reviewerDegradeNote) {
      this.emit(record, 'NOTE', reviewerDegradeNote);
    } else if (reviewer) {
      // 审核方 route 的事实进事件，供审计。厂商同异三态如实写：无法判定不折成任何一边
      this.emit(
        record,
        'NOTE',
        `已启用交叉审核：审核方 ${reviewer.label}（${reviewer.kind === 'EXTERNAL_CLI' ? '外部 CLI' : '模型 API'}）` +
          (reviewer.parity.kind === 'HETEROGENEOUS'
            ? '，写审双方厂商异构'
            : reviewer.parity.kind === 'SAME_VENDOR'
              ? `，写审双方同厂商，第二意见价值有限 —— ${reviewer.parity.detail}`
              : `，写审双方厂商同异无法判定 —— ${reviewer.parity.detail}`),
        {
          reviewerKind: reviewer.kind,
          reviewerLabel: reviewer.label,
          heterogeneous: reviewer.parity.kind === 'HETEROGENEOUS',
          vendorParity: reviewer.parity,
          ...(reviewer.kind === 'MODEL_API'
            ? { reviewerRoute: { providerId: reviewer.resolution.providerId, modelId: reviewer.resolution.modelId } }
            : { connectorId: reviewer.connector.connectorId, identityDigest: reviewer.connector.identityDigest }),
        },
      );
    }

    if (author) {
      this.emit(
        record,
        'NOTE',
        `本任务由外部编码代理当作者：${author.label}（只在一次性 candidate 目录里改，差异归一化后才进主线；规划/审批/验证/封存仍由平台执行）`,
        { authorConnectorId: author.connector.connectorId, identityDigest: author.connector.identityDigest },
      );
    }

    // 异步启动，不阻塞 IPC 响应
    void this.execute(record, resolution);

    return { task, run: view };
  }

  private async execute(record: RunRecord, resolution: ReturnType<ModelGateway['freezeRoute']>): Promise<void> {
    const startedAt = Date.now();
    // 恢复态的 Run 没有活工作区，永远不该走到执行路径。真走到了就明确停住，
    // 而不是让一个 null 在深处炸成未分类异常。
    const workspace = record.workspace;
    if (!workspace) {
      this.setStatus(record, 'INTERRUPTED', '内部不变式违规：尝试执行一个没有工作区的 Run', 'INVARIANT_VIOLATION');
      return;
    }

    record.implementerResolution = resolution;
    record.executionStartedAt = startedAt;
    /*
     * 用户的修改要求只服务于**这一次** Attempt 的简报：取出来就清掉，
     * 免得下一次（例如交叉审核整改后再来一轮）把一份过期的反馈又讲一遍。
     * 上一版 diff 从 priorPatches 的最后一份取 —— 它就是被要求修改的那一版。
     */
    const cr = record.changeRequest;
    record.changeRequest = null;
    const changeRequest = cr
      ? {
          note: cr.note,
          previousAttemptNo: cr.previousAttemptNo,
          previousPatchDiff:
            record.priorPatches.find((p) => p.digest === cr.previousPatchDigest)?.unifiedDiff ?? '',
        }
      : null;

    /*
     * 墙钟带着**本 Run 已用掉的时间**起算：新 Attempt（REQUEST_CHANGES）与旧的共用
     * 同一份 Task 预算，不是每次要求修改就白送一份完整时长。
     */
    const deadline = new PausableDeadline(
      record.task.budget.maxWallClockMs,
      () => {
        if (!isTerminal(record.view.status)) {
          record.abort.abort();
          // 防御性：正常情况下审批期间 deadline 是暂停的，不会在这里撞上待审批；
          // 但万一撞上，也要兑现 Promise 让 runAgent 解开、finally 得以执行。
          this.cleanupPendingApprovals(record);
          this.setStatus(record, 'TIMED_OUT', '超过任务时间预算', 'TIMEOUT');
        }
      },
      record.view.ledger.elapsedMs,
    );
    record.deadline = deadline;

    const mutationPolicy = {
      ...DEFAULT_MUTATION_POLICY,
      allowedPaths: record.task.allowedPaths,
      protectedPaths: record.task.protectedPaths,
    };
    try {
      const result = await runAgent({
        task: record.task,
        snapshot: record.snapshot,
        profile: record.profile,
        workspace,
        gateway: this.consentBoundGateway(record),
        resolution,
        ...(record.plannerResolution ? { plannerResolution: record.plannerResolution } : {}),
        mutationPolicy,
        runId: record.view.runId,
        attemptId: record.view.attemptId,
        signal: record.abort.signal,
        host: this.hostFor(record, deadline),
        commandApprovals: this.approvalCheckerFor(record),
        ...(record.task.collaboration
          ? {
              checkpointBeforeSelfFix: async (checkpoint: {
                round: number;
                verification: VerificationRun;
              }) => {
                if (!record.verifications.some(
                  (item) => item.verificationRunId === checkpoint.verification.verificationRunId,
                )) {
                  record.verifications.push(checkpoint.verification);
                }
                this.createCollaborationHandoff(
                  record,
                  workspace,
                  null,
                  checkpoint.verification,
                  {
                    fromRole: 'IMPLEMENTER',
                    toRole: 'IMPLEMENTER',
                    nextPhase: 'SELF_FIX',
                  },
                );
                await this.awaitCollaborationBoundary(
                  record,
                  deadline,
                  `验证失败，等待你确认开始第 ${checkpoint.round}/${record.task.budget.maxSelfFixRounds} 轮自修复`,
                  'EXECUTING',
                  `用户已确认，实施方开始第 ${checkpoint.round}/${record.task.budget.maxSelfFixRounds} 轮自修复`,
                );
              },
            }
          : {}),
        ...(record.author
          ? { externalAuthor: this.authorRunnerFor(record, record.author, workspace, mutationPolicy, deadline) }
          : {}),
        ...(changeRequest ? { changeRequest } : {}),
      });

      for (const v of [result.baseline, result.finalVerification]) {
        if (v && !record.verifications.some((x) => x.verificationRunId === v.verificationRunId)) {
          record.verifications.push(v);
        }
      }

      switch (result.kind) {
        case 'PATCH_READY': {
          const comparison =
            result.baseline && result.finalVerification
              ? compareVerification(result.baseline, result.finalVerification)
              : null;
          const patch = sealPatch(
            workspace,
            record.view.runId,
            record.view.attemptId,
            record.snapshot.baseSha,
            result.finalVerification,
            comparison,
            result.unverifiedItems,
            this.commandReferencedInputs(record, workspace),
          );
          record.patch = patch;
          this.emit(
            record,
            'PATCH_SEALED',
            `补丁已封存：${patch.files.length} 个文件，+${patch.files.reduce((n, f) => n + f.addedLines, 0)}/-${patch.files.reduce((n, f) => n + f.removedLines, 0)}`,
            { patchId: patch.patchId, digest: patch.digest, files: patch.files.map((f) => f.path) },
          );

          // 补丁封存后、交回人手之前：如果启用了交叉审核，先让第二个模型只读审一遍；
          // 有阻断发现时由实现方 route 自动整改一次（重验 + 重封存），再审一轮。
          // 审核结论只是给人的第二意见，绝不改变"接受与否"仍由人决定这件事。
          if (record.reviewer) {
            if (record.task.collaboration) {
              this.createCollaborationHandoff(record, workspace, patch, result.finalVerification);
              await this.awaitCollaborationBoundary(
                record,
                deadline,
                '实现阶段完成，等待你确认交给审核方',
                'CROSS_REVIEWING',
                '交接已确认，审核方开始只读审核',
              );
            }
            await this.runCrossReview(
              record,
              workspace,
              startedAt,
              deadline,
              patch,
              result.finalVerification,
              result.baseline,
              resolution,
            );
          }

          this.setStatus(record, 'AWAITING_PATCH_REVIEW', result.detail);
          break;
        }
        case 'PLAN_REJECTED':
          this.setStatus(record, 'BLOCKED', result.detail, 'PLAN_REJECTED');
          break;
        case 'NO_CHANGES':
          this.setStatus(record, 'FAILED', result.detail, 'NO_CHANGES');
          break;
        case 'VERIFICATION_FAILED':
          this.sealSalvagePatch(record, workspace, {
            marker: `验证失败 —— ${result.detail}`,
            baseline: result.baseline,
            finalVerification: result.finalVerification,
          });
          this.setStatus(record, 'FAILED', result.detail, 'VERIFICATION_FAILED');
          break;
        case 'BLOCKED':
          this.sealSalvagePatch(record, workspace, {
            marker: `执行被阻断 —— ${result.detail}`,
            baseline: result.baseline,
            finalVerification: result.finalVerification,
          });
          this.setStatus(record, 'BLOCKED', result.detail, 'BUDGET_EXHAUSTED');
          break;
      }
    } catch (err) {
      /*
       * 事件日志写不下去 → **跳过状态快照落盘，直接定终态**。
       *
       * 这个检查必须排在所有分支之前，有两个理由：
       *   1. 日志写不成时再走 `persist`，state.json 的 eventHighWatermark 会**超前**于
       *      日志；重启后 rehydrateRuns 只检查"事件是否比状态新"这一个方向，
       *      日志更短反而判 `INTACT` —— 把"丢了事件"说成"证据完好"；
       *   2. `sealSalvagePatch` 自己也会 emit（`:2862` 与它 catch 里的 `:2869`）。
       *      日志锁定时第一处抛 EventLogUnavailable、被它自己的 catch 接住、
       *      catch 里再 emit 又抛一次 —— 异常就此逃出本 catch 块，而 execute 是
       *      `void` 调用的，那会变成 unhandled rejection，Run 拿不到终态也跑不到清理。
       *
       * 注意这**不是**不变式 3 的问题：sealPatch 对工作区是只读的
       * （changedVsBaseline + `git diff --no-index`），失败路径从来没有写过用户的副本。
       * 被破坏的是证据完整性与收口的可达性。
       */
      const journalFailure = record.events.writeFailure();
      if (journalFailure) {
        // 丢掉的是「触发锁定的那一条」+「此后被拒绝的每一条」—— 省略要报数（不变式 8）
        const lost = 1 + record.events.refusedAppendCount();
        this.setStatus(
          record,
          'FAILED',
          `事件日志写入失败（${journalFailure.reason}）：已停止落盘 —— ` +
            `未生成抢救补丁、状态快照未更新；共 ${lost} 条事件未能记录。` +
            `重启后该 Run 会按上一份完好的快照恢复`,
          'RUNTIME_ERROR',
        );
        return;
      }
      // 异常路径同样先抢救现场再定终态；PlanningFailed 时规划是只读的、
      // 工作区必然零改动，helper 会自然空转，无需特判
      if (err instanceof AgentCancelled || record.abort.signal.aborted) {
        if (!isTerminal(record.view.status)) {
          this.sealSalvagePatch(record, workspace, { marker: '用户取消时的执行现场' });
          this.setStatus(record, 'CANCELLED', '已取消', 'USER_CANCELLED');
        }
      } else if (err instanceof EgressBlocked) {
        this.sealSalvagePatch(record, workspace, { marker: `模型出站被阻断（${err.reason}）时的执行现场` });
        this.setStatus(record, 'BLOCKED', `模型出站被阻断：${err.reason}`, 'EGRESS_BLOCKED');
      } else if (err instanceof InvocationFailed) {
        this.sealSalvagePatch(record, workspace, {
          marker: `模型调用失败（${err.cause.kind}）时的执行现场`,
        });
        this.setStatus(record, 'FAILED', `模型调用失败：${err.cause.kind} — ${err.message}`, 'MODEL_INVOCATION_FAILED');
      } else if (err instanceof PlanningFailed) {
        this.setStatus(record, 'FAILED', `规划失败：${err.message}`, 'PLANNING_FAILED');
      } else {
        this.sealSalvagePatch(record, workspace, { marker: '运行时异常时的执行现场' });
        this.setStatus(record, 'FAILED', `运行时异常：${(err as Error).message}`, 'RUNTIME_ERROR');
      }
    } finally {
      deadline.clear();
      record.deadline = null;
      this.cleanupPendingApprovals(record);
      /*
       * 日志锁定时这条 emit 会抛 —— 而在 finally 里抛出会覆盖 catch 块的正常返回、
       * 逃出 execute（它是 `void` 调用的）变成 unhandled rejection。
       * 清理动作本身只动内存与推送（deadline.clear / cleanupPendingApprovals），照常执行；
       * 少记一条 CLEANUP_SUMMARY 已经由 setStatus 的 statusReason 报过数了。
       */
      if (
        !record.events.writeFailure() &&
        isTerminal(record.view.status) &&
        record.view.status !== 'AWAITING_PATCH_REVIEW'
      ) {
        /*
         * 终态只证明本轮 loop 与审批等待已经结束。本路径不持有脱离进程组的派生进程句柄，
         * 因此取消只能报告已发 SIGTERM，其他终态只能报告 UNKNOWN，不能推断进程已经退出。
         */
        const aborted = record.abort.signal.aborted;
        this.emit(
          record,
          'CLEANUP_SUMMARY',
          `审批等待已释放；模型流随本次 loop 结束释放；` +
            (aborted
              ? '子进程：取消时已向命令进程组发送 SIGTERM，但未确认终止'
              : '子进程：状态未知（命令可能派生过脱离进程组的子进程，本路径不追踪）'),
          {
            workspaceRetained: record.view.status === 'SUCCEEDED',
            reason: 'RUN_TERMINAL',
            modelStream: 'RELEASED',
            childProcesses: aborted ? 'SIGTERM_SENT_UNCONFIRMED' : 'UNKNOWN',
          },
        );
      }
    }
  }

  /**
   * 补丁封存后的交叉审核收敛闭环（PRD-XAGENT-003/004 的诚实子集）。
   *
   * 审核 →（有阻断）实现方整改 → 重验 → 重封存 → 第二轮审核，硬上限
   * 2 次审核 + 1 次整改（CROSS_REVIEW_LIMITS）。收敛语义在
   * agent.runCrossReviewCycle 里；这里只提供机制：重验怎么跑、补丁怎么重新
   * 封存、工作区怎么恢复。无论哪种 stopReason，终点都是 AWAITING_PATCH_REVIEW ——
   *   - 绝不自动接受补丁（审核"通过" ≠ SUCCEEDED，那需要机器验证 + 人工接受）
   *   - 出错 / 取消 / 审核方不可用都吞进 stopReason，不让交叉审核的失败拖垮主 Run
   *   - 整改后验证失败时工作区**恢复到整改前内容**：封存补丁和文件树必须指同一棵树
   */
  /**
   * 绑定外部 CLI 审核方。
   *
   * 三道门，缺一不可 —— 任何一道不过都抛错并降级为不审核，绝不"先跑起来再说"：
   *   1. 连接器现场探测必须 READY（有可自动化的非交互入口）；
   *   2. vendor 必须与实现方异构 —— 这是硬不变式，不是披露项；
   *   3. 必须有该 vendor 的显式凭据。**不复用实现方的 key**（audience 不同），
   *      也绝不让外部 CLI 用宿主登录态跑（那会静默消耗用户订阅）。
   */
  /**
   * 列出所有可选审核方：模型 API profile + 本机检测到的外部 CLI。
   * **不可用的也返回**，带上原因 —— 静默从清单里消失，用户只会以为"没这个功能"。
   */
  private listReviewers(): ReviewerOption[] {
    const out: ReviewerOption[] = [];
    for (const p of this.gateway.listProfiles()) {
      out.push({
        id: p.profileId,
        kind: 'MODEL_API',
        label: `${p.label} · ${p.modelId}`,
        detail: p.enabled ? `已配置凭据（${p.credentialSource === 'APP' ? '应用内' : '环境变量'}）` : '未配置凭据',
        available: p.enabled,
        reason: p.enabled ? null : `在「设置 · API」里填 ${p.label} 的 Key，或设置 ${p.credentialEnvVar}`,
      });
    }
    for (const c of discoverConnectors()) {
      const hasKey = Boolean(this.gateway.credentialForVendor(c.credentialEnvVar));
      const usable = c.state === 'READY' && hasKey;
      out.push({
        id: c.connectorId,
        kind: 'EXTERNAL_CLI',
        label: `${c.label}${c.version ? ` · ${c.version}` : ''}`,
        detail: c.detail,
        available: usable,
        reason: usable
          ? null
          : c.state !== 'READY'
            ? (c.remediation ?? c.detail)
            : `缺少 ${c.credentialEnvVar}：外部 CLI 只用你显式配置的 Key，不借用宿主登录态`,
      });
    }
    return out;
  }

  /**
   * 模型路由的厂商推断。证据优先级在 model/vendor.ts：模型命名空间 > 模型家族名 >
   * 单一厂商官方 provider。此前这里只认 providerId 为 'anthropic'/'openai' 两个字符串，
   * 走中转（openrouter / aihubmix / …）一律推不出 —— openrouter 上的 claude 模型配
   * Claude CLI 审核这种**可以证明**的同厂商组合被静默放行（A2A 评审 §4.4 点名的洞）。
   */
  private routeVendor(resolution: ModelRouteResolution): VendorInference {
    const profile = this.gateway.getProfile(resolution.profileId);
    return inferModelVendor({
      providerId: resolution.providerId,
      providerKind: profile?.kind ?? null,
      modelId: resolution.modelId,
    });
  }

  private routeSide(role: string, resolution: ModelRouteResolution): VendorSide {
    return {
      label: `${role} ${resolution.providerId}/${resolution.modelId}`,
      inference: this.routeVendor(resolution),
    };
  }

  /** 本机 CLI 的厂商来自静态描述符 —— 身份确定，不需要推断 */
  private connectorSide(role: string, connector: ExternalConnectorProfile): VendorSide {
    return knownVendorSide({
      label: `${role} ${connector.label}`,
      vendor: connector.vendor,
      evidence: `本机连接器 ${connector.connectorId}`,
    });
  }

  private reviewerSideOf(reviewer: ReviewerBinding): VendorSide {
    return reviewer.kind === 'EXTERNAL_CLI'
      ? this.connectorSide('审核方', reviewer.connector)
      : this.routeSide('审核方', reviewer.resolution);
  }

  private bindCliReviewer(
    connectorId: string,
    implementer: ModelRouteResolution,
  ): ReviewerBinding {
    const d = descriptorOfConnector(connectorId);
    if (!d) throw new Error(`未知的外部连接器：${connectorId}`);
    const connector = probeConnector(d);
    if (connector.state !== 'READY') throw new Error(connector.detail);

    /*
     * 证明同厂商才拦；证明不了**不是放行两个字能带过的** —— 必须落成 UNVERIFIABLE
     * 如实进披露与记录。此前这里推不出厂商时跳过断言、还把 heterogeneous 硬编码 true，
     * 等于把"没查"写成"已证异构"：静默过滤和静默通过是同一类问题。
     */
    const implementerSide = this.routeSide('实现方', implementer);
    if (implementerSide.inference.kind === 'KNOWN') {
      assertHeterogeneousVendor(implementerSide.inference.vendor, connector.vendor);
    }
    const parity = vendorParityOf(implementerSide, this.connectorSide('审核方', connector));

    const apiKey = this.gateway.credentialForVendor(connector.credentialEnvVar);
    if (!apiKey) {
      throw new Error(
        `缺少 ${connector.credentialEnvVar}：拒绝让外部 CLI 用宿主登录态运行，请先配置该供应商的 Key`,
      );
    }
    return {
      kind: 'EXTERNAL_CLI',
      connector,
      apiKey,
      parity,
      label: `${connector.label} ${connector.version ?? ''}`.trim(),
    };
  }

  private requireProfile(profileId: string): ModelConnectionProfile {
    const p = this.gateway.getProfile(profileId);
    if (!p) throw platformError('NOT_FOUND', `模型 profile 不存在：${profileId}`);
    return p;
  }

  /**
   * 给 Renderer 的披露：与 createTask 里重算的那份**同一个函数、同一套输入**。
   * 这里不绑定任何东西（不 freezeRoute 到 record、不签发 consent）—— 只是算给人看。
   */
  private disclosureFor(input: {
    snapshotId: string;
    modelProfileId: string;
    plannerModelProfileId?: string;
    collaborationMode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
    reviewerModelProfileId?: string;
    reviewerConnectorId?: string;
    authorConnectorId?: string;
    handoffDigest?: string;
  }): DataEgressDisclosure {
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot) throw platformError('NOT_FOUND', `快照不存在：${input.snapshotId}`);
    const implementer = { profile: this.requireProfile(input.modelProfileId), resolution: this.gateway.freezeRoute(input.modelProfileId) };
    const planner = input.plannerModelProfileId
      ? { profile: this.requireProfile(input.plannerModelProfileId), resolution: this.gateway.freezeRoute(input.plannerModelProfileId) }
      : null;
    let reviewer: DisclosureInput['reviewer'] = null;
    if (input.reviewerConnectorId) {
      const d = descriptorOfConnector(input.reviewerConnectorId);
      if (!d) throw platformError('BAD_REQUEST', `未知的外部连接器：${input.reviewerConnectorId}`);
      const connector = probeConnector(d);
      /*
       * 与 createTask 的 bindCliReviewer 降级判定逐条对齐：连接器不可用、缺该厂商凭据、
       * 或与实现方**证明**同厂商（SAME_VENDOR_REVIEW_DENIED）时，createTask 会把审核方
       * 降级为不审核 —— 披露必须按降级后的事实算。否则用户确认的是"含审核方"的 digest，
       * createTask 重算的是"无审核方"的 digest，CONSENT_STALE 会永远对不上。
       * Renderer 侧负责把"选了但不在披露里"这件事说给用户听，这里不静默。
       */
      const implementerInference = this.routeVendor(implementer.resolution);
      const denied =
        connector.state !== 'READY' ||
        !this.gateway.credentialForVendor(connector.credentialEnvVar) ||
        (implementerInference.kind === 'KNOWN' && implementerInference.vendor === connector.vendor);
      reviewer = denied ? null : { kind: 'EXTERNAL_CLI', connector };
    } else if (input.reviewerModelProfileId && input.reviewerModelProfileId !== input.modelProfileId) {
      try {
        reviewer = {
          kind: 'MODEL_API',
          profile: this.requireProfile(input.reviewerModelProfileId),
          resolution: this.gateway.freezeRoute(input.reviewerModelProfileId),
        };
      } catch {
        // 审核方 route 不可用时 createTask 会降级为不审核 —— 披露也按"不审核"算，两边一致
        reviewer = null;
      }
    }
    let author: DisclosureInput['author'] = null;
    if (input.authorConnectorId) {
      const d = descriptorOfConnector(input.authorConnectorId);
      if (!d) throw platformError('BAD_REQUEST', `未知的外部连接器：${input.authorConnectorId}`);
      author = { connector: probeConnector(d) };
    }
    // 厂商同异判定与 createTask 同一套输入、同一个函数 —— 展示的与校验的只可能因输入不同而不同
    let reviewerParity: VendorParity | null = null;
    if (reviewer) {
      reviewerParity = vendorParityOf(
        author
          ? this.connectorSide('外部作者', author.connector)
          : this.routeSide('实现方', implementer.resolution),
        reviewer.kind === 'EXTERNAL_CLI'
          ? this.connectorSide('审核方', reviewer.connector)
          : this.routeSide('审核方', reviewer.resolution),
      );
    }
    return buildDisclosure({
      snapshotId: snapshot.snapshotId,
      snapshotFileCount: snapshot.fileCount,
      implementer,
      planner,
      reviewer,
      reviewerParity,
      author,
      handoffDigest: input.handoffDigest ?? null,
    });
  }

  /** Loop 拿到的 gateway 只多一件事：每次 invoke 自动带上本 Run 的同意 —— 忘带就是 CONSENT_MISSING */
  private consentBoundGateway(record: RunRecord): ModelInvoker {
    const consent = record.consent
      ? { disclosureDigest: record.consent.disclosureDigest, resolutionDigests: record.consent.resolutionDigests }
      : null;
    return { invoke: (i) => this.gateway.invoke({ ...i, consent }) };
  }

  private bindCliAuthor(connectorId: string, reviewer: ReviewerBinding | null): AuthorBinding {
    const d = descriptorOfConnector(connectorId);
    if (!d) throw platformError('BAD_REQUEST', `未知的外部连接器：${connectorId}`);
    const connector = probeConnector(d);
    if (connector.state !== 'READY') {
      throw platformError('BAD_REQUEST', `外部作者 ${d.label} 不可用：${connector.detail}`, connector.remediation ?? undefined);
    }
    /*
     * 异构不变式对"作者 vs 审核方"同样成立：Codex 写就不能 Codex 审。
     * 审核方是模型 API 时厂商走同一套推断 —— 此前只认官方 providerId，
     * aihubmix 上的 gpt-5.1 审 Codex 写的代码这种可证明的同厂商组合会被静默放行。
     */
    if (reviewer) {
      const reviewerSide = this.reviewerSideOf(reviewer);
      if (reviewerSide.inference.kind === 'KNOWN') {
        try {
          assertHeterogeneousVendor(connector.vendor, reviewerSide.inference.vendor);
        } catch (err) {
          throw platformError('BAD_REQUEST', (err as Error).message, '换一个不同厂商的审核方，或不启用交叉审核');
        }
      }
    }
    const apiKey = this.gateway.credentialForVendor(connector.credentialEnvVar);
    if (!apiKey) {
      throw platformError(
        'BAD_REQUEST',
        `缺少 ${connector.credentialEnvVar}：拒绝让外部 CLI 用宿主登录态运行，请先配置该供应商的 Key`,
      );
    }
    return { connector, apiKey, label: `${connector.label} ${connector.version ?? ''}`.trim() };
  }

  /**
   * 造一个外部作者执行器。Loop 拿到的只是这个函数；它负责 candidate 的完整生命周期：
   * exportCandidate → 调用 CLI → 退出即封存 → applyCandidate（归一化 + CAS）→ discardCandidate。
   * 无论成败，candidate 目录都在 finally 里丢弃；主线 generation 只会因 applyMutationPlan 前进。
   */
  /**
   * 外部 CLI 出站的**运行期**同意闸门。
   *
   * ModelGateway 那条路上早就有这道检查（gateway.ts 的 preflight：CONSENT_MISSING /
   * CONSENT_STALE / ROUTE_DRIFT）。外部 CLI 完全不经 gateway，它的 PREFLIGHT 只查
   * 连接器状态、apiKey 非空与 prompt DLP —— 也就是说 task.create 那一次比对之后，
   * 到真正 spawn 之间的一切变化都无人过问。
   *
   * 两件事在这里被挡住：
   *   1. 根本没有同意（恢复态 Run、或披露里压根没列这个选手）→ 不出站。
   *   2. **身份漂移**：identityDigest = digestOf({binaryPath, version})。用户在
   *      task.create 之后升级了 Codex、或 PATH 指到了另一个二进制，我们就会把整仓副本
   *      交给一个用户从未在披露上看见过的东西。这与 gateway 的 ROUTE_DRIFT 同形。
   *
   * 现在才做得成，是因为披露里的 EXTERNAL_CLI 目的地此前 `resolutionDigest` 硬编码
   * 为 null（见 egress.ts），外部选手对同意覆盖集合的贡献是 0。
   */
  private assertExternalEgressConsent(
    record: RunRecord,
    connector: ExternalConnectorProfile,
    role: 'AUTHOR' | 'REVIEWER',
  ): void {
    const label = role === 'AUTHOR' ? '外部作者' : '外部审核方';
    const consent = record.consent;
    if (!consent) {
      throw platformError(
        'POLICY_DENIED',
        `${label} ${connector.label} 没有出站同意记录，已阻断调用`,
        '请重新创建任务：出站披露必须在调用之前由你确认。',
      );
    }
    /*
     * 现场重算身份，不用绑定时那份。绑定时的 profile 是 task.create 当下的快照；
     * 要挡的恰恰是"从那时到现在变了什么"，拿旧快照去比等于自己跟自己比。
     */
    const descriptor = descriptorOfConnector(connector.connectorId);
    if (!descriptor) {
      throw platformError('POLICY_DENIED', `未知连接器 ${connector.connectorId}，已阻断调用`);
    }
    const now = probeConnector(descriptor);
    if (now.state !== 'READY' || !now.identityDigest) {
      throw platformError(
        'POLICY_DENIED',
        `${label} ${connector.label} 当前不可用（${now.state}），已阻断调用`,
        now.remediation ?? '请在设置里重新检测该连接器。',
      );
    }
    if (!consent.resolutionDigests.includes(now.identityDigest)) {
      throw platformError(
        'POLICY_DENIED',
        `${label} ${connector.label} 与你同意的那份披露不一致（可执行文件路径或版本已变），已阻断调用`,
        '这台机器上的该 CLI 在你确认披露之后被改动过。请重新创建任务并确认新的出站披露。',
      );
    }
  }

  private authorRunnerFor(
    record: RunRecord,
    author: AuthorBinding,
    workspace: MaterializedWorkspace,
    policy: MutationPolicy,
    deadline: PausableDeadline,
  ): ExternalAuthorRunner {
    return async (i) => {
      // 出站前置：先过运行期同意与身份漂移，再动工作区 —— 拦下来的时候一个 candidate 都别建
      this.assertExternalEgressConsent(record, author.connector, 'AUTHOR');
      const candidate = workspace.exportCandidate();
      this.emit(
        record,
        'NOTE',
        `外部作者 ${author.label} 开始 ${i.phase}：candidate ${candidate.candidateId} 基于 gen-${candidate.baseGeneration}`,
        { phase: i.phase, candidateId: candidate.candidateId, baseGeneration: candidate.baseGeneration },
      );
      try {
        // 作者超时受任务墙钟收口：剩余时间不够 15 分钟就只给剩余时间（至少 30s 让它能诚实失败）
        const remaining = record.task.budget.maxWallClockMs - deadline.elapsedMs();
        const timeoutMs = Math.max(30_000, Math.min(EXTERNAL_AUTHOR_TIMEOUT_MS, remaining));
        const budget = this.modelBudgetExceeded(record, deadline);
        if (budget.exceeded) throw new ModelDispatchBudgetExceeded(budget.reason);
        this.emit(
          record,
          'MODEL_INVOCATION',
          `${i.phase} 外部 CLI 作者调用准备派发给 ${author.label}`,
          { phase: 'DISPATCH_INTENT', connectorId: author.connector.connectorId },
        );
        this.charge(record, deadline, { modelTurns: 1, inputTokens: null, outputTokens: null }, true);
        const result = await runExternalCliAuthor({
          connector: author.connector,
          apiKey: author.apiKey,
          brief: i.brief,
          phase: i.phase,
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          timeoutMs,
          signal: record.abort.signal,
          candidate,
        });
        // 与 reviewer 同样平行记录终态：外部 CLI 调用不伪装成模型 API 出站
        this.emit(
          record,
          'MODEL_INVOCATION',
          `${i.phase} 调用外部 CLI 作者 ${author.label}（${result.manifest.state}${
            result.manifest.exitCode !== null ? ` exit=${result.manifest.exitCode}` : ''
          }${result.manifest.changedCount !== null ? ` changed=${result.manifest.changedCount}` : ''}）`,
          { externalInvocation: result.manifest },
        );
        if (result.manifest.state === 'CANCELLED') return { kind: 'CANCELLED' };
        if (result.manifest.state !== 'SEALED' || !result.seal) {
          return { kind: 'FAILED', detail: result.manifest.failureDetail ?? result.manifest.state };
        }
        if (result.seal.authorNote) {
          this.emit(record, 'NOTE', `作者备注（untrusted，不驱动判定）：${result.seal.authorNote.summary ?? '（无摘要）'}`, {
            authorNote: result.seal.authorNote,
          });
        }

        const applied = applyCandidate(workspace, result.seal, candidate.path, record.view.runId, policy);
        switch (applied.kind) {
          case 'APPLIED': {
            const skipped =
              applied.skippedGenerated.length > 0 ? `；另有 ${applied.skippedGenerated.length} 个命令产物路径被跳过` : '';
            this.emit(
              record,
              'MUTATION_APPLIED',
              `外部作者的 candidate 已归一化采用：gen-${applied.outputGeneration}，${applied.changedPaths.length} 个文件${skipped}`,
              {
                source: 'EXTERNAL_AUTHOR',
                candidateId: candidate.candidateId,
                outputGeneration: applied.outputGeneration,
                treeDigest: applied.treeDigest,
                paths: applied.changedPaths,
                skippedGenerated: applied.skippedGenerated,
              },
            );
            // 刷新 view.workspaceGeneration（charge 顺带做了，但 APPLIED 之后再同步一次更稳）
            this.charge(record, deadline, {});
            return { kind: 'APPLIED', generation: applied.outputGeneration, changedPaths: applied.changedPaths };
          }
          case 'NO_CHANGES':
            this.emit(
              record,
              'NOTE',
              `外部作者退出但没有可采用的源码变更${
                applied.skippedGenerated.length > 0 ? `（只动了 ${applied.skippedGenerated.length} 个命令产物路径）` : ''
              }`,
              { candidateId: candidate.candidateId, skippedGenerated: applied.skippedGenerated },
            );
            return { kind: 'NO_CHANGES' };
          case 'REJECTED':
            this.emit(
              record,
              'NOTE',
              `外部作者的 candidate 被拒绝（${applied.reason}）：${applied.detail}；主线零写入`,
              { candidateId: candidate.candidateId, reason: applied.reason, paths: applied.paths },
            );
            return { kind: 'REJECTED', reason: applied.reason, detail: applied.detail };
        }
      } finally {
        workspace.discardCandidate(candidate.path);
      }
    };
  }

  /**
   * 造一个审核执行器。**两种选手，同一套规则** ——
   * 都产出 CrossReviewRound、都用平台算的指纹、都受同一个循环的收敛约束。
   * 循环编排拿到的只是这个函数，它不知道背后是模型 API 还是本机的 CLI。
   */
  private reviewerRunnerFor(
    record: RunRecord,
    reviewer: ReviewerBinding,
    deps: AgentDeps,
    deadline: PausableDeadline,
  ): ReviewPassRunner {
    const cycleId = record.collaborationCycleId ?? record.view.attemptId;
    const identifyRound = (round: CrossReviewRound): CrossReviewRound => ({
      ...round,
      cycleId,
      reviewId: `${cycleId}:review:${round.round}`,
    });
    if (reviewer.kind === 'MODEL_API') {
      return async (i) => identifyRound(
        await runReviewPass(deps, { ...i, reviewerResolution: reviewer.resolution }),
      );
    }
    return async (i) => {
      this.assertExternalEgressConsent(record, reviewer.connector, 'REVIEWER');
      const startedAt = nowIso();
      const budget = this.modelBudgetExceeded(record, deadline);
      if (budget.exceeded) throw new ModelDispatchBudgetExceeded(budget.reason);
      this.emit(
        record,
        'MODEL_INVOCATION',
        `CROSS_REVIEW 外部 CLI 审核调用准备派发给 ${reviewer.label}`,
        { phase: 'DISPATCH_INTENT', connectorId: reviewer.connector.connectorId },
      );
      this.charge(record, deadline, { modelTurns: 1, inputTokens: null, outputTokens: null }, true);
      const result = await runExternalCliReview({
        connector: reviewer.connector,
        apiKey: reviewer.apiKey,
        brief: renderReviewBrief(record.task, i.patch, i.finalVerification, i.priorFindings ?? []),
        runId: record.view.runId,
        attemptId: record.view.attemptId,
        timeoutMs: EXTERNAL_REVIEW_TIMEOUT_MS,
        signal: record.abort.signal,
      });

      // CLI 调用的凭证与模型出站清单平行落账 —— 合同要求两条路径不得互相伪装
      this.emit(
        record,
        'MODEL_INVOCATION',
        `CROSS_REVIEW 调用外部 CLI ${reviewer.label}（${result.manifest.state}${
          result.manifest.exitCode !== null ? ` exit=${result.manifest.exitCode}` : ''
        }）`,
        { externalInvocation: result.manifest },
      );

      const round = {
        round: i.round,
        reviewedPatchDigest: i.patch.digest,
        // 前缀形式只由 legacyReviewerProfileId 一处派生，这里不再手拼字符串
        reviewerResolutionId: legacyReviewerProfileId({
          kind: 'EXTERNAL_CLI',
          connectorId: reviewer.connector.connectorId,
        }),
        startedAt,
        finishedAt: nowIso(),
      };
      if (!result.submission) {
        // 拿不到结论就是拿不到 —— 记 INCONCLUSIVE，绝不当作"没有发现"
        this.emit(
          record,
          'NOTE',
          `外部审核方未产出可用结论（${result.manifest.failureDetail ?? result.manifest.state}）：本轮记为 INCONCLUSIVE`,
        );
        return identifyRound({ ...round, verdict: 'INCONCLUSIVE' as const, findings: [] });
      }
      const normalized = parseExternalSubmission(
        result.submission.verdict,
        result.submission.findings,
        result.submission.resolvedFindingFingerprints,
      );
      if (!normalized) {
        this.emit(record, 'NOTE', '外部审核方的结论未通过 schema 校验：本轮记为 INCONCLUSIVE');
        return identifyRound({ ...round, verdict: 'INCONCLUSIVE' as const, findings: [] });
      }
      this.emit(
        record,
        'CROSS_REVIEW_ROUND',
        `第 ${i.round} 轮交叉审核（外部 CLI）：${normalized.verdict}，${normalized.findings.length} 条发现` +
          `（阻断 ${normalized.findings.filter((f) => f.blocking).length}）`,
        { round: i.round, verdict: normalized.verdict, findingCount: normalized.findings.length },
      );
      return identifyRound({
        ...round,
        verdict: normalized.verdict,
        findings: normalized.findings,
        resolvedFindingFingerprints: normalized.resolvedFindingFingerprints,
      });
    };
  }

  private async runCrossReview(
    record: RunRecord,
    workspace: MaterializedWorkspace,
    startedAt: number,
    deadline: PausableDeadline,
    patch: PatchArtifact,
    finalVerification: VerificationRun | null,
    baseline: VerificationRun | null,
    implementerResolution: ModelRouteResolution,
    isContinuation = false,
  ): Promise<void> {
    const reviewer = record.reviewer;
    if (!reviewer) return;

    const prior = record.crossReview;
    if (record.view.collaborationProjection) {
      record.view = {
        ...record.view,
        collaborationProjection: {
          ...record.view.collaborationProjection,
          cycleId: record.collaborationCycleId,
          currentCycle: { reviewerInvocations: 0, remediations: 0 },
          taskTotals: {
            reviewerInvocations: prior?.reviewerInvocations ?? 0,
            remediations: prior?.remediations ?? 0,
          },
        },
      };
    }
    this.setStatus(
      record,
      'CROSS_REVIEWING',
      isContinuation ? '用户授权续期：第二个模型再次只读交叉审核' : '第二个模型正在只读交叉审核',
    );
    const crStart = nowIso();
    this.emit(record, 'CROSS_REVIEW_STARTED', `交叉审核开始：${reviewer.label}`, {
      reviewerKind: reviewer.kind,
      reviewerLabel: reviewer.label,
      heterogeneous: reviewer.parity.kind === 'HETEROGENEOUS',
      vendorParity: reviewer.parity,
      limits: CROSS_REVIEW_LIMITS,
      ...(isContinuation ? { continuation: (prior?.userContinuations ?? 0) + 1 } : {}),
    });

    const crossReviewPolicy: MutationPolicy = {
      ...DEFAULT_MUTATION_POLICY,
      allowedPaths: record.task.allowedPaths,
      protectedPaths: record.task.protectedPaths,
    };
    const deps: AgentDeps = {
      task: record.task,
      snapshot: record.snapshot,
      profile: record.profile,
      workspace,
      gateway: this.consentBoundGateway(record),
      // 整改要以实现方身份改文件；审核调用走注入的 review 执行器，不经这里
      resolution: implementerResolution,
      mutationPolicy: crossReviewPolicy,
      runId: record.view.runId,
      attemptId: record.view.attemptId,
      signal: record.abort.signal,
      host: this.hostFor(record, deadline),
      commandApprovals: this.approvalCheckerFor(record),
      // 外部作者任务：整改也由同一个外部作者执行（同一 candidate → 归一化 → CAS 路径），不换成内部模型
      ...(record.author
        ? { externalAuthor: this.authorRunnerFor(record, record.author, workspace, crossReviewPolicy, deadline) }
        : {}),
    };

    // 进入循环时的那一代 —— 第 1 轮审核是平台强制只读的，代号不会在审核中漂移
    const preGen = workspace.activeGeneration;
    const verificationEnabled = record.task.verificationCommandIds.length > 0;

    let rounds: readonly CrossReviewRound[] = [];
    let reviewerInvocations = 0;
    let remediations = 0;
    let stopReason: CrossReviewStopReason;
    try {
      const unresolvedPriorFindings = isContinuation
        ? (prior?.findingDispositions ?? [])
            .filter(
              (finding) =>
                finding.disposition !== 'RESOLVED' && finding.disposition !== 'USER_ACCEPTED',
            )
            .map((finding) =>
              [...(prior?.rounds ?? [])]
                .reverse()
                .flatMap((round) => round.findings)
                .find((candidate) => candidate.fingerprint === finding.fingerprint),
            )
            .filter((finding): finding is import('@shared/domain').ReviewFinding => Boolean(finding))
        : [];
      const outcome = await runCrossReviewCycle(
        deps,
        {
          review: this.reviewerRunnerFor(record, reviewer, deps, deadline),
          patch,
          finalVerification,
          priorFindings: unresolvedPriorFindings,
        },
        {
          reverify: verificationEnabled
            ? async () => {
                this.setStatus(record, 'CROSS_REVIEWING', '整改完成，正在重新验证');
                this.emit(record, 'VERIFICATION_STARTED', `验证 gen-${workspace.activeGeneration}（整改后）`, {
                  phase: 'POST_MUTATION',
                });
                const v = await runVerification(
                  record.view.runId,
                  record.view.attemptId,
                  'POST_MUTATION',
                  workspace,
                  record.profile,
                  record.task.verificationCommandIds,
                  record.abort.signal,
                  deps.host, // 整改后的重验也进 ToolCall 与账本
                  deps.commandApprovals ?? null,
                );
                record.verifications.push(v);
                this.emit(
                  record,
                  'VERIFICATION_FINISHED',
                  `验证${v.passed ? '通过' : '失败'}：${v.commands.map((c) => `${c.commandId}=${c.outcome}`).join(' ')}`,
                  { phase: 'POST_MUTATION', verification: v },
                );
                return v;
              }
            : null,
          reseal: (verification, truncationReason) => {
            const comparison =
              baseline && verification ? compareVerification(baseline, verification) : null;
            return sealPatch(
              workspace,
              record.view.runId,
              record.view.attemptId,
              record.snapshot.baseSha,
              verification,
              comparison,
              composeUnverifiedItems(record.task, record.profile, comparison, truncationReason),
              this.commandReferencedInputs(record, workspace),
            );
          },
          adoptPatch: (p) => {
            record.patch = p;
            this.emit(
              record,
              'PATCH_SEALED',
              `整改后补丁已重新封存：${p.files.length} 个文件，+${p.files.reduce((n, f) => n + f.addedLines, 0)}/-${p.files.reduce((n, f) => n + f.removedLines, 0)}`,
              { patchId: p.patchId, digest: p.digest, files: p.files.map((f) => f.path), remediated: true },
            );
          },
          restoreWorkspace: () => {
            const r = workspace.restoreGeneration(preGen);
            this.emit(
              record,
              'NOTE',
              `工作区已恢复：gen-${r.generation} 复制自整改前的 gen-${preGen}，封存补丁与文件树重新一致`,
            );
          },
          ...(record.task.collaboration
            ? {
                checkpoint: async (checkpoint: {
                  phase: 'REMEDIATE' | 'SECOND_REVIEW';
                  patch: PatchArtifact;
                  findings: readonly import('@shared/domain').ReviewFinding[];
                  reviewerInvocations: number;
                  remediations: number;
                  reviewId: string;
                }) => {
                  if (record.view.collaborationProjection) {
                    record.view = {
                      ...record.view,
                      collaborationProjection: {
                        ...record.view.collaborationProjection,
                        currentCycle: {
                          reviewerInvocations: checkpoint.reviewerInvocations,
                          remediations: checkpoint.remediations,
                        },
                        taskTotals: {
                          reviewerInvocations: (prior?.reviewerInvocations ?? 0) + checkpoint.reviewerInvocations,
                          remediations: (prior?.remediations ?? 0) + checkpoint.remediations,
                        },
                      },
                    };
                  }
                  const verification = [...record.verifications].reverse().find((item) => item.phase === 'POST_MUTATION') ?? null;
                  this.createCollaborationHandoff(record, workspace, checkpoint.patch, verification, {
                    fromRole: checkpoint.phase === 'REMEDIATE' ? 'REVIEWER' : 'IMPLEMENTER',
                    toRole: checkpoint.phase === 'REMEDIATE' ? 'IMPLEMENTER' : 'REVIEWER',
                    nextPhase: checkpoint.phase,
                    findings: checkpoint.findings,
                    reviewerInvocations: checkpoint.reviewerInvocations,
                    remediations: checkpoint.remediations,
                    reviewId: checkpoint.reviewId,
                  });
                  await this.awaitCollaborationBoundary(
                    record,
                    deadline,
                    checkpoint.phase === 'REMEDIATE'
                      ? '审核发现已冻结，等待你交给实施方整改'
                      : '整改工件已冻结，等待你交给审核方复审',
                    'CROSS_REVIEWING',
                    checkpoint.phase === 'REMEDIATE'
                      ? '交接已确认，实施方正在整改'
                      : '交接已确认，审核方正在复审',
                  );
                },
              }
            : {}),
        },
      );
      rounds = outcome.rounds;
      reviewerInvocations = outcome.reviewerInvocations;
      remediations = outcome.remediations;
      stopReason = outcome.stopReason;
    } catch (err) {
      // 循环是全函数，能走到这里的只剩机制层异常（封存 IO、恢复 CAS 等）
      if (err instanceof AgentCancelled || record.abort.signal.aborted) {
        stopReason = 'CANCELLED';
      } else {
        stopReason = 'ERROR';
        this.emit(record, 'NOTE', `交叉审核机制异常（不影响已封存补丁）：${(err as Error).message}`);
      }
    }

    // 续期时累计而非覆盖：counter 只增不清（PRD-XAGENT-004），轮次跨循环连续编号
    const priorRounds = prior?.rounds ?? [];
    const renumbered = rounds.map((r, i) => ({ ...r, round: priorRounds.length + i + 1 }));
    // 身份是判别联合；reviewerProfileId 只是它的遗留展示派生，前缀约定不再散落
    const reviewerIdentity: CrossReviewerIdentity =
      reviewer.kind === 'MODEL_API'
        ? { kind: 'MODEL_API', profileId: reviewer.resolution.profileId }
        : { kind: 'EXTERNAL_CLI', connectorId: reviewer.connector.connectorId };
    const allRounds = [...priorRounds, ...renumbered];
    const findingDispositions = deriveFindingDispositions(
      allRounds,
      record.collaborationCycleId ?? record.view.attemptId,
    );
    const cr: CrossReviewRecord = {
      enabled: true,
      reviewerIdentity,
      reviewerProfileId: legacyReviewerProfileId(reviewerIdentity),
      heterogeneous: reviewer.parity.kind === 'HETEROGENEOUS',
      vendorParity: reviewer.parity,
      rounds: allRounds,
      reviewerInvocations: (prior?.reviewerInvocations ?? 0) + reviewerInvocations,
      remediations: (prior?.remediations ?? 0) + remediations,
      findingDispositions,
      userContinuations: (prior?.userContinuations ?? 0) + (isContinuation ? 1 : 0),
      stopReason,
      startedAt: prior?.startedAt ?? crStart,
      finishedAt: nowIso(),
    };
    record.crossReview = cr;
    if (record.view.collaborationProjection) {
      record.view = {
        ...record.view,
        collaborationProjection: {
          ...record.view.collaborationProjection,
          currentCycle: { reviewerInvocations, remediations },
          taskTotals: {
            reviewerInvocations: cr.reviewerInvocations,
            remediations: cr.remediations,
          },
        },
      };
    }

    const blockingTotal = cr.rounds.flatMap((r) => r.findings).filter((f) => f.blocking).length;
    const findingTotal = cr.rounds.flatMap((r) => r.findings).length;
    this.emit(
      record,
      'CROSS_REVIEW_FINISHED',
      `交叉审核结束（${stopReason}）：${cr.reviewerInvocations} 轮审核 + ${cr.remediations} 次整改，${findingTotal} 条发现（阻断 ${blockingTotal}）`,
      {
        stopReason,
        reviewerInvocations: cr.reviewerInvocations,
        remediations: cr.remediations,
        userContinuations: cr.userContinuations ?? 0,
        blockingTotal,
        findingTotal,
      },
    );
    // 补丁审查阶段会读到 record.crossReview，把发现摆在用户面前再让其决定
  }

  /**
   * 任务选用的验证命令在 argv 里点名的仓库文件（如 `node check.mjs` 的 check.mjs）。
   * 模式匹配的验证输入（tsconfig/vite/vitest/测试文件…）不需要这里提供，sealPatch 自己判。
   */
  private commandReferencedInputs(
    record: RunRecord,
    workspace: MaterializedWorkspace,
  ): { path: string; commandId: string }[] {
    const commands = record.task.verificationCommandIds
      .map((id) => record.profile.commands[id])
      .filter((c): c is CommandDefinition => Boolean(c));
    const baseline = workspace.baselinePath();
    return verificationInputsFromCommands(commands, (rel) => {
      try {
        return statSync(join(baseline, rel)).isFile();
      } catch {
        return false;
      }
    });
  }

  private hostFor(record: RunRecord, deadline: PausableDeadline) {
    return {
      emit: (kind: RunEventKind, summary: string, payload: Record<string, unknown> = {}) =>
        this.emit(record, kind, summary, payload),

      setStatus: (status: RunStatus, reason: string | null) => this.setStatus(record, status, reason),

      awaitPlanApproval: (
        plan: PlanRevision,
      ): Promise<'APPROVE' | 'REJECT' | { decision: 'REVISE'; note: string }> => {
        record.plan = plan;
        const approvalSubjectDigest = digestOf({
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          projectId: record.task.projectId,
          snapshotId: record.task.snapshotId,
          planDigest: plan.digest,
          roleBindingDigest: record.task.collaboration?.roleBindingDigest ?? null,
          collaborationMode: record.task.collaboration?.mode ?? null,
          budget: record.task.budget,
          allowedPaths: record.task.allowedPaths,
          protectedPaths: record.task.protectedPaths,
          verificationCommandIds: record.task.verificationCommandIds,
        });
        const request: ApprovalRequest = {
          approvalId: newId('appr'),
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          kind: 'PLAN',
          risk: 'R1',
          title: '批准执行计划',
          /*
           * 批准的不只是"计划摘要"，还有它能写到哪：用户没填限定路径时 allowedPaths 兜底为
           * `**`，这件事必须在批准时看得见，而不是只藏在 TaskForm 的占位符里（08-17 审计 G-3）。
           */
          detail:
            `${plan.summary}\n` +
            `允许改动范围：${
              record.task.allowedPaths.length === 0 || (record.task.allowedPaths.length === 1 && record.task.allowedPaths[0] === '**')
                ? '整个仓库（未限定路径；仅受保护路径除外）'
                : record.task.allowedPaths.join(', ')
            }；受保护路径：${record.task.protectedPaths.join(', ') || '（无）'}` +
            `\n协作模式：${record.task.collaboration?.mode ?? '普通任务'}；预算：模型 ${record.task.budget.maxModelTurns} 轮 / 工具 ${record.task.budget.maxToolCalls} 次 / 自修复 ${record.task.budget.maxSelfFixRounds} 轮` +
            (record.author ? `\n实现方：外部 CLI ${record.author.label}（只在一次性副本里改，差异归一化后进主线）` : ''),
          subjectDigest: approvalSubjectDigest,
          requestedAt: nowIso(),
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        };

        // 人工审批不消耗计算预算：暂停墙钟，用户决定后再恢复。
        deadline.pause();

        return new Promise<'APPROVE' | 'REJECT' | { decision: 'REVISE'; note: string }>((resolve, reject) => {
          // 已被取消就别挂起了，否则 runAgent 永远等不到（addEventListener 对已 abort
          // 的 signal 不会再触发）。正常路径上 runAgent 在调用本函数前刚 throwIfCancelled 过。
          if (record.abort.signal.aborted) {
            deadline.resume();
            reject(new AgentCancelled('审批开始前已取消'));
            return;
          }

          const cleanup = (): void => {
            clearTimeout(expiry);
            record.abort.signal.removeEventListener('abort', onAbort);
            record.approvals.delete(request.approvalId);
            this.pushApprovals(record);
          };

          // 取消 / 超时（deadline 兜底）→ abort：兑现 Promise，让 runAgent 解开、finally 执行。
          const onAbort = (): void => {
            cleanup();
            reject(new AgentCancelled('审批等待期间被中止'));
          };

          // 审批自身的过期（30 分钟未决定）→ BLOCKED，与「计算超时 TIMED_OUT」区分。
          // 之前这条只能被"用户回来点按钮"惰性触发，且那条分支只 delete 不 resolve，
          // 于是 Promise 永久泄漏、CLEANUP_SUMMARY 永远发不出来。
          const expiry = setTimeout(() => {
            if (!record.approvals.has(request.approvalId)) return;
            this.emit(record, 'NOTE', '计划审批已过期（超过 30 分钟未决定），已停止');
            this.setStatus(record, 'BLOCKED', '计划审批已过期（超过 30 分钟未决定）', 'APPROVAL_EXPIRED');
            record.abort.abort(); // 触发 onAbort → cleanup + reject
          }, APPROVAL_TTL_MS);
          expiry.unref?.();

          record.approvals.set(request.approvalId, {
            request,
            resolve: (decision: ApprovalDecisionKind, note = '') => {
              cleanup();
              deadline.resume(); // 决定完成，计算预算继续计时
              resolve(decision === 'REVISE' ? { decision, note } : decision);
            },
          });
          record.abort.signal.addEventListener('abort', onAbort, { once: true });
          this.pushApprovals(record);
        });
      },

      beginToolCall: (input: {
        toolName: string;
        risk: ToolRisk;
        argsSummary: string;
        argsDigest: string;
      }): string => {
        const view: ToolCallView = {
          toolCallId: newId('tc'),
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          toolName: input.toolName,
          risk: input.risk,
          argsSummary: input.argsSummary,
          argsDigest: input.argsDigest,
          resolution: null,
          resolutionReason: null,
          preview: null,
          previewTruncated: false,
          artifactRef: null,
          // 还没跑完，终局自然还不存在 —— null 是"没有这份事实"，不是"通过了"
          commandResult: null,
          startedAt: nowIso(),
          resolvedAt: null,
          durationMs: null,
        };
        record.toolCalls.set(view.toolCallId, view);
        this.emit(record, 'TOOL_CALL_PROPOSED', `${input.toolName}: ${input.argsSummary}`, {
          toolCallId: view.toolCallId,
          risk: input.risk,
        });
        this.push({ type: 'toolcall.updated', toolCall: view });
        return view.toolCallId;
      },

      endToolCall: (
        toolCallId: string,
        resolution: ToolCallResolution,
        reason: string | null,
        preview: string,
        previewTruncated: boolean,
        artifactRef: string | null,
        meta?: Record<string, unknown>,
      ): void => {
        const prev = record.toolCalls.get(toolCallId);
        if (!prev) return;
        /*
         * 命令终局的判别联合（不变式 5）。之前只有平台发起的验证命令留下
         * CommandOutcome，模型发起的 run_command 到界面上只剩 SUCCEEDED/FAILED ——
         * "退出码 1"、"被信号杀掉"、"超时"、"没起来"看起来一模一样。
         * 认不出形状就当没有：宁可显示"未知"，也不能把它默认成某一种终局。
         */
        const commandResult = readCommandResult(meta?.outcome);
        const updated: ToolCallView = {
          ...prev,
          resolution,
          resolutionReason: reason,
          preview,
          previewTruncated,
          artifactRef,
          commandResult,
          resolvedAt: nowIso(),
          durationMs: Date.now() - Date.parse(prev.startedAt),
        };
        record.toolCalls.set(toolCallId, updated);
        this.emit(record, 'TOOL_CALL_RESOLVED', `${prev.toolName} → ${resolution}`, {
          toolCallId,
          resolution,
          reason,
          ...(commandResult ? { command: commandResult } : {}),
        });
        this.persist(record);
        this.push({ type: 'toolcall.updated', toolCall: updated });
      },

      /*
       * 模型正文的实时增量：**只推，不落盘**。
       *
       * 持久事实是那条 ASSISTANT_MESSAGE 事件。增量只是"先看一眼"——
       * 流断了、重试了、进程没了，重新打开这个 Run 应该看到同一份记录，
       * 而不是一堆半截文本。所以这里不 emit、不 persist、不动 eventHighWatermark，
       * 证据核对（evidence.ts 按事件流比对状态快照）也就不受流的影响。
       */
      streamText: (signal: StreamSignal): void => {
        this.push({
          type: 'run.stream',
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          signal,
        });
      },

      reserveModelTurn: () => this.charge(record, deadline, { modelTurns: 1 }, true),

      settleModelTurn: (inputTokens: number | null, outputTokens: number | null) =>
        this.charge(record, deadline, { inputTokens, outputTokens }),

      chargeToolCall: () => this.charge(record, deadline, { toolCalls: 1 }),

      chargeSelfFixRound: () => this.charge(record, deadline, { selfFixRounds: 1 }),

      budgetExceeded: () => this.modelBudgetExceeded(record, deadline),
    };
  }

  private modelBudgetExceeded(
    record: RunRecord,
    deadline: PausableDeadline,
  ): { exceeded: boolean; reason: string } {
    const l = record.view.ledger;
    const lim = record.task.budget;
    if (l.modelTurns >= lim.maxModelTurns) return { exceeded: true, reason: `模型轮次达上限 ${lim.maxModelTurns}` };
    if (l.toolCalls >= lim.maxToolCalls) return { exceeded: true, reason: `工具调用达上限 ${lim.maxToolCalls}` };
    if (l.inputTokens + l.outputTokens >= lim.maxTotalTokens) {
      return { exceeded: true, reason: `token 达上限 ${lim.maxTotalTokens}` };
    }
    if (deadline.elapsedMs() >= lim.maxWallClockMs) return { exceeded: true, reason: '超过时间预算' };
    return { exceeded: false, reason: '' };
  }

  /** 账本只增不减 —— retry / deny / cancel 都不回退已消耗量 */
  private charge(
    record: RunRecord,
    deadline: PausableDeadline,
    delta: LedgerCharge,
    requirePersistence = false,
  ): void {
    const previousView = record.view;
    record.view = {
      ...record.view,
      // null/undefined 的三态语义在 applyLedgerCharge：null 计入未知轮次，不折算成 0
      // elapsedMs 与 TIMED_OUT 判定同源：审批等待不计入
      ledger: applyLedgerCharge(record.view.ledger, delta, deadline.elapsedMs()),
      workspaceGeneration: record.workspace?.activeGeneration ?? record.view.workspaceGeneration,
      updatedAt: nowIso(),
    };
    // 模型派发预留依赖这次同步持久化；写失败会在 gateway 进入 adapter 前抛出。
    try {
      this.persist(record, requirePersistence);
    } catch (error) {
      record.view = previousView;
      throw error;
    }
    this.push({ type: 'run.updated', run: record.view });
  }

  // -------------------------------------------------------------------------
  // 审批
  // -------------------------------------------------------------------------

  private decideApproval(input: {
    approvalId: string;
    decision: ApprovalDecisionKind;
    subjectDigest: string;
    note: string;
  }): { accepted: boolean; reason: string | null } {
    for (const record of this.runs.values()) {
      const pending = record.approvals.get(input.approvalId);
      if (!pending) continue;
      if (record.view.restored) {
        return { accepted: false, reason: '该 Run 已从磁盘恢复，没有在等待这个审批的执行器' };
      }

      // 已进入终态的 Run 不再接受审批决定 —— 否则会往一个 TIMED_OUT/CANCELLED 的
      // Run 上追加一条"用户批准了计划"的假审计记录，然后什么都不执行。
      if (isTerminal(record.view.status)) {
        return { accepted: false, reason: `当前状态 ${record.view.status} 不再接受审批决定` };
      }

      // digest 不匹配 = 审批对象已变化，旧审批失效（PRD-APPR-002）
      if (pending.request.subjectDigest !== input.subjectDigest) {
        return { accepted: false, reason: '审批对象已变化，请重新查看后再决定' };
      }
      if (Date.parse(pending.request.expiresAt) < Date.now()) {
        // 与代理超时定时器同样处理：置 BLOCKED 并 abort（→ onAbort 兑现 Promise 并清理）。
        // 绝不能只 delete 不 resolve —— 那正是之前 Promise 永久泄漏、CLEANUP_SUMMARY
        // 永远发不出来的根因。
        this.setStatus(record, 'BLOCKED', '计划审批已过期', 'APPROVAL_EXPIRED');
        record.abort.abort();
        return { accepted: false, reason: '审批已过期' };
      }

      if (input.decision === 'REVISE' && pending.request.kind !== 'PLAN') {
        return { accepted: false, reason: '只有计划审批可以要求修订' };
      }
      if (input.decision === 'REVISE' && input.note.trim().length === 0) {
        return { accepted: false, reason: '请填写计划修改要求' };
      }

      // pending.resolve 内部会清理定时器/监听、恢复墙钟、并从 map 删除
      pending.resolve(input.decision, input.note);
      return { accepted: true, reason: null };
    }
    return { accepted: false, reason: '审批请求不存在或已被处理' };
  }

  private pushApprovals(record: RunRecord): void {
    this.push({
      type: 'approval.updated',
      runId: record.view.runId,
      approvals: [...record.approvals.values()].map((a) => a.request),
    });
  }

  private cleanupPendingApprovals(record: RunRecord): void {
    // 先快照：pending.resolve 内部会从 record.approvals 删除自己，
    // 边遍历边删原 map 容易漏项。
    const pendings = [...record.approvals.values()];
    for (const pending of pendings) {
      pending.resolve('REJECT'); // 内部 cleanup：清定时器/监听、从 map 删除、恢复墙钟（已 clear 时为 no-op）
    }
    record.approvals.clear();
    this.pushApprovals(record);
  }

  // -------------------------------------------------------------------------
  // 补丁决定 —— 唯一能进入 SUCCEEDED 的入口
  // -------------------------------------------------------------------------

  /**
   * 续期只对"上一循环没收敛"的收场开放；其余没有可续的东西。
   *
   * REVIEWER_INCONCLUSIVE 在这里 —— 审核方压根没给出结论，"再跑一轮"正是它的下一步。
   * 此前它被折进 REVIEWER_PASSED，于是用户不但看到假的"通过"，还连重跑的入口都没有。
   */
  private static readonly CONTINUABLE_STOP_REASONS: ReadonlySet<string> = new Set([
    'COUNTER_EXHAUSTED',
    'NO_PROGRESS',
    'NO_DELTA',
    'REVIEWER_INCONCLUSIVE',
  ]);

  /**
   * 用户显式授权再跑一轮交叉审核循环（2 审 + 1 改）。
   *
   * 防死循环的完整设计是两半：自动轮次每循环硬上限（CROSS_REVIEW_LIMITS，
   * 结构上走不满），跨循环只能由人推进 —— 平台绝不自己"再试一次"。
   * 每次续期落一条授权事件，累计计数只增不清；拒绝走 accepted=false + reason，
   * 拒绝是决定，不是异常。
   */
  private continueCrossReview(runId: string): { run: RunView; accepted: boolean; reason: string | null } {
    const record = this.require(runId);
    const deny = (reason: string) => ({ run: record.view, accepted: false, reason });

    if (record.view.restored || !record.workspace) {
      return deny('该 Run 已从磁盘恢复，没有活的执行器，无法续期');
    }
    if (record.view.status !== 'AWAITING_PATCH_REVIEW') {
      return deny(`当前状态 ${record.view.status} 不能续期交叉审核`);
    }
    if (!record.reviewer) return deny('本任务未启用交叉审核');
    if (!record.patch) return deny('没有已封存的补丁可审');
    const cr = record.crossReview;
    if (!cr || !cr.stopReason) return deny('尚未完成过一轮交叉审核');
    if (!RunAuthority.CONTINUABLE_STOP_REASONS.has(cr.stopReason)) {
      return deny(`上一循环以 ${cr.stopReason} 收场，没有可续期的东西`);
    }
    const resolution = record.implementerResolution;
    const startedAt = record.executionStartedAt;
    if (!resolution || startedAt === undefined || startedAt === null) {
      return deny('实现方执行上下文不可用，无法续期');
    }
    const remainingMs = record.task.budget.maxWallClockMs - record.view.ledger.elapsedMs;
    if (remainingMs <= 0) return deny('任务时间预算已耗尽，无法续期');

    const continuation = (cr.userContinuations ?? 0) + 1;
    const previousCycleId = record.collaborationCycleId;
    const previousProjection = record.view.collaborationProjection;
    record.collaborationCycleId = newId('cycle');
    if (record.view.collaborationProjection) {
      record.view = {
        ...record.view,
        collaborationProjection: {
          ...record.view.collaborationProjection,
          cycleId: record.collaborationCycleId,
          currentCycle: { reviewerInvocations: 0, remediations: 0 },
          taskTotals: {
            reviewerInvocations: cr.reviewerInvocations,
            remediations: cr.remediations,
          },
        },
      };
    }
    try {
      this.emit(
        record,
        'NOTE',
        `用户授权继续交叉审核循环（第 ${continuation} 次续期）：再跑最多 ${CROSS_REVIEW_LIMITS.maxReviewerInvocations} 轮审核 + ${CROSS_REVIEW_LIMITS.maxRemediations} 次整改`,
        {
          kind: 'CROSS_REVIEW_CONTINUATION',
          continuation,
          previousCycleId,
          cycleId: record.collaborationCycleId,
        },
      );
    } catch (error) {
      record.collaborationCycleId = previousCycleId;
      record.view = { ...record.view, collaborationProjection: previousProjection };
      throw error;
    }

    const workspace = record.workspace;
    const patch = record.patch;
    const baseline = record.verifications.find((v) => v.phase === 'BASELINE') ?? null;
    const finalVerification =
      [...record.verifications].reverse().find((v) => v.phase === 'POST_MUTATION') ?? null;

    const deadline = new PausableDeadline(record.task.budget.maxWallClockMs, () => {
      if (!isTerminal(record.view.status)) {
        record.abort.abort();
        this.cleanupPendingApprovals(record);
        this.setStatus(record, 'TIMED_OUT', '超过任务时间预算', 'TIMEOUT');
      }
    }, record.view.ledger.elapsedMs);
    record.deadline = deadline;

    // 与 execute 的收尾同构：循环语义全函数，出错折叠进 stopReason，终点仍是人工审查
    void (async () => {
      try {
        await this.runCrossReview(
          record,
          workspace,
          startedAt,
          deadline,
          patch,
          finalVerification,
          baseline,
          resolution,
          true,
        );
        if (!isTerminal(record.view.status)) {
          this.setStatus(record, 'AWAITING_PATCH_REVIEW', '续期的交叉审核已结束，等待你审查补丁');
        }
      } catch (err) {
        this.emit(record, 'NOTE', `续期交叉审核异常（补丁不受影响）：${(err as Error).message}`);
        if (!isTerminal(record.view.status)) {
          this.setStatus(record, 'AWAITING_PATCH_REVIEW', '续期的交叉审核异常结束，补丁仍可审查');
        }
      } finally {
        deadline.clear();
        record.deadline = null;
      }
    })();

    // runCrossReview 的开头在 spawn 的同步段里已把状态置为 CROSS_REVIEWING
    return { run: record.view, accepted: true, reason: null };
  }

  private createCollaborationHandoff(
    record: RunRecord,
    workspace: MaterializedWorkspace,
    patch: PatchArtifact | null,
    verification: VerificationRun | null,
    stage: {
      fromRole: 'IMPLEMENTER' | 'REVIEWER';
      toRole: 'IMPLEMENTER' | 'REVIEWER';
      nextPhase: 'SELF_FIX' | 'FIRST_REVIEW' | 'REMEDIATE' | 'SECOND_REVIEW';
      findings?: readonly import('@shared/domain').ReviewFinding[];
      reviewerInvocations?: number;
      remediations?: number;
      reviewId?: string;
    } = { fromRole: 'IMPLEMENTER', toRole: 'REVIEWER', nextPhase: 'FIRST_REVIEW' },
  ): void {
    const collaboration = record.task.collaboration;
    const plan = record.plan;
    const cycleId = record.collaborationCycleId;
    if (!collaboration || !plan || !record.consent || !cycleId) {
      throw new Error('协作交接缺少已冻结的计划、角色或披露事实');
    }
    const now = Date.now();
    const handoff = sealHandoff({
      schemaVersion: 1,
      handoffId: newId('handoff'),
      taskId: record.task.taskId,
      runId: record.view.runId,
      attemptId: record.view.attemptId,
      cycleId,
      fromRole: stage.fromRole,
      toRole: stage.toRole,
      nextPhase: stage.nextPhase,
      plan: { planId: plan.planId, revision: plan.revision, digest: plan.digest },
      snapshotId: record.snapshot.snapshotId,
      baseTreeDigest: record.snapshot.treeDigest,
      generation: workspace.activeGeneration,
      treeDigest: workspace.treeDigest(),
      roleBindingDigest: collaboration.roleBindingDigest,
      patch: patch ? { patchId: patch.patchId, digest: patch.digest } : null,
      changedPaths: patch
        ? patch.files.map((file) => file.path)
        : workspace.changedFilesVsBaseline(),
      verificationIds: verification ? [verification.verificationRunId] : [],
      /*
       * treeDigest 已绑定本代全部文件内容；再把冻结命令定义和本次验证引用纳入摘要，
       * 才能表达“这次验证究竟基于什么”。被触碰的文件名列表只描述覆盖弱化，
       * 不能冒充验证输入内容摘要。
       */
      verificationInputDigest: verification
        ? digestOf({
            treeDigest: workspace.treeDigest(),
            verificationRunId: verification.verificationRunId,
            commands: record.task.verificationCommandIds.map((commandId) => ({
              commandId,
              definition: record.profile.commands[commandId] ?? null,
            })),
          })
        : null,
      verificationEligible: Boolean(
        verification?.passed &&
        (!patch || patch.verificationRunId === verification.verificationRunId) &&
        !(patch?.verificationInputsTouched?.length),
      ),
      findings: (stage.findings ?? []).map((finding) => ({
        findingId: finding.fingerprint,
        fingerprint: finding.fingerprint,
        reviewId: stage.reviewId ?? `${cycleId}:review:${stage.reviewerInvocations ?? 1}`,
        blocking: finding.blocking,
        evidenceRefs: finding.file ? [finding.file] : [],
        disposition: stage.nextPhase === 'SECOND_REVIEW'
          ? 'REMEDIATED_PENDING_REVIEW' as const
          : 'OPEN' as const,
      })),
      context: {
        goal: record.task.goal,
        acceptance: record.task.acceptance,
        allowedPaths: record.task.allowedPaths,
        planSummary: plan.summary,
        provenance: [
          record.snapshot.snapshotId,
          ...(patch ? [patch.patchId] : []),
          ...(verification ? [verification.verificationRunId] : []),
        ],
      },
      disclosureDigest: record.consent.disclosureDigest,
      recipientIdentityDigest: stage.toRole === 'REVIEWER'
        ? collaboration.reviewer.identityDigest
        : collaboration.implementer.identityDigest,
      dataClasses: [
        'TASK_TEXT',
        ...(patch ? ['PATCH_DIFF' as const] : []),
        ...(verification ? ['COMMAND_OUTPUT' as const] : []),
        ...(stage.findings?.length ? ['REVIEW_FINDINGS' as const] : []),
      ],
      counts: {
        included: 2 + (patch?.files.length ?? 0) + (verification ? 1 : 0) + (stage.findings?.length ?? 0),
        excluded: 0,
        truncated: patch?.files.filter((file) => file.diffTruncated).length ?? 0,
        reasons: ['included 按 goal、plan、patch file、verification summary、finding 条目计数'],
      },
      budget: {
        modelTurnsRemaining: Math.max(0, record.task.budget.maxModelTurns - record.view.ledger.modelTurns),
        toolCallsRemaining: Math.max(0, record.task.budget.maxToolCalls - record.view.ledger.toolCalls),
        reviewerInvocations: stage.reviewerInvocations ?? record.crossReview?.reviewerInvocations ?? 0,
        remediations: stage.remediations ?? record.crossReview?.remediations ?? 0,
      },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + HANDOFF_DECISION_TTL_MS).toISOString(),
      coreEpoch: this.coreEpoch,
    });
    record.pendingHandoff = handoff;
    this.clearHandoffExpiry(record);
    const expiryDelay = Math.max(0, Date.parse(handoff.expiresAt) - Date.now());
    record.handoffExpiryTimer = setTimeout(() => {
      this.expireCollaborationHandoff(record, handoff, '交接决定已过期（超过 30 分钟未处理）');
    }, expiryDelay);
    record.handoffExpiryTimer.unref?.();
    record.view = {
      ...record.view,
      pendingHandoff: {
        handoffId: handoff.handoffId,
        digest: handoff.digest,
        nextPhase: handoff.nextPhase,
        toRole: handoff.toRole,
        expiresAt: handoff.expiresAt,
      },
    };
    this.emit(
      record,
      'HANDOFF_CREATED',
      `${stage.fromRole === 'REVIEWER' ? '审核发现' : stage.nextPhase === 'SECOND_REVIEW' ? '整改工件' : stage.nextPhase === 'SELF_FIX' ? '失败验证与当前工作区' : '实施工件'}已冻结，等待人工交给${stage.toRole === 'REVIEWER' ? '审核方' : '实施方'}`,
      {
      handoffId: handoff.handoffId,
      digest: handoff.digest,
      nextPhase: handoff.nextPhase,
      expiresAt: handoff.expiresAt,
      },
    );
  }

  private async awaitCollaborationBoundary(
    record: RunRecord,
    deadline: PausableDeadline,
    waitingReason: string,
    resumeStatus: 'EXECUTING' | 'CROSS_REVIEWING',
    resumeReason: string,
  ): Promise<void> {
    const handoff = record.pendingHandoff;
    if (!handoff) throw new Error('协作边界缺少已冻结的交接工件');
    const requiresUser = record.collaborationMode === 'MANUAL_HANDOFF' || record.stopAfterStepRequested;
    if (record.stopAfterStepRequested) {
      record.stopAfterStepRequested = false;
      record.view = {
        ...record.view,
        collaborationControl: record.collaborationMode
          ? { mode: record.collaborationMode, stopAfterStepRequested: false }
          : null,
      };
    }

    this.setStatus(
      record,
      'AWAITING_HANDOFF',
      requiresUser ? waitingReason : '有界自动正在校验并消费已冻结交接工件',
    );
    deadline.pause();
    const wait = new Promise<void>((resolve) => {
      record.handoffContinuation = { handoffId: handoff.handoffId, resolve };
    });

    if (!requiresUser) {
      try {
        const result = this.continueCollaboration({
          runId: record.view.runId,
          handoffId: handoff.handoffId,
          handoffDigest: handoff.digest,
          decisionId: `auto_${newId('decision')}`,
        });
        if (!result.accepted) {
          this.emit(record, 'NOTE', `自动交接未被消费，已停留给用户处理：${result.reason ?? '未知原因'}`);
        }
      } catch (error) {
        this.emit(record, 'NOTE', `自动交接落账失败，已停留给用户处理：${(error as Error).message}`);
      }
    }

    await wait;
    record.handoffContinuation = null;
    if (record.abort.signal.aborted) throw new AgentCancelled();
    deadline.resume();
    this.setStatus(record, resumeStatus, resumeReason);
  }

  private continueCollaboration(input: {
    runId: string;
    handoffId: string;
    handoffDigest: string;
    decisionId: string;
  }): { run: RunView; accepted: boolean; reason: string | null } {
    const record = this.require(input.runId);
    const deny = (reason: string) => ({ run: record.view, accepted: false, reason });
    const handoff = record.pendingHandoff;
    const collaboration = record.task.collaboration;
    const workspace = record.workspace;
    if (record.view.status !== 'AWAITING_HANDOFF' || !handoff || !collaboration || !workspace) {
      return deny('当前 Run 没有可消费的活跃交接工件');
    }
    const resolution = record.implementerResolution;
    const startedAt = record.executionStartedAt;
    const continuation = record.handoffContinuation;
    const resumesWaitingPhase = continuation?.handoffId === handoff.handoffId;
    if (!resolution || startedAt == null || (!resumesWaitingPhase && !record.patch)) {
      return deny('执行上下文已失效，无法继续协作阶段');
    }
    const decision: CollaborationHandoffDecision = {
      decisionId: input.decisionId,
      handoffId: input.handoffId,
      handoffDigest: input.handoffDigest,
      action: 'CONTINUE',
      decidedAt: nowIso(),
    };
    const verification = handoff.verificationIds.length === 1
      ? record.verifications.find((item) => item.verificationRunId === handoff.verificationIds[0]) ?? null
      : null;
    const verificationInputDigest = verification
      ? digestOf({
          treeDigest: workspace.treeDigest(),
          verificationRunId: verification.verificationRunId,
          commands: record.task.verificationCommandIds.map((commandId) => ({
            commandId,
            definition: record.profile.commands[commandId] ?? null,
          })),
        })
      : null;
    const recipientIdentityDigest = handoff.toRole === 'REVIEWER'
      ? collaboration.reviewer.identityDigest
      : collaboration.implementer.identityDigest;
    try {
      this.handoffs.consume(handoff, decision, {
        runId: record.view.runId,
        attemptId: record.view.attemptId,
        coreEpoch: this.coreEpoch,
        generation: workspace.activeGeneration,
        roleBindingDigest: collaboration.roleBindingDigest,
        planDigest: record.plan?.digest ?? '',
        snapshotId: record.snapshot.snapshotId,
        baseTreeDigest: record.snapshot.treeDigest,
        treeDigest: workspace.treeDigest(),
        patchDigest: record.patch?.digest ?? null,
        verificationInputDigest,
        verificationEligible: Boolean(
          verification?.passed &&
          (!record.patch || record.patch.verificationRunId === verification.verificationRunId) &&
          !(record.patch?.verificationInputsTouched?.length),
        ),
        disclosureDigest: record.consent?.disclosureDigest ?? '',
        recipientIdentityDigest,
        contextDigest: digestOf({
          goal: record.task.goal,
          acceptance: record.task.acceptance,
          allowedPaths: record.task.allowedPaths,
          planSummary: record.plan?.summary ?? '',
          provenance: [
            record.snapshot.snapshotId,
            ...(record.patch ? [record.patch.patchId] : []),
            ...(verification ? [verification.verificationRunId] : []),
          ],
        }),
        nowMs: Date.now(),
      });
    } catch (error) {
      if (error instanceof HandoffConsumeError && error.code === 'HANDOFF_EXPIRED') {
        this.expireCollaborationHandoff(record, handoff, error.message);
      }
      return deny((error as Error).message);
    }
    record.pendingHandoff = null;
    record.view = { ...record.view, pendingHandoff: null };
    try {
      const automatic = decision.decisionId.startsWith('auto_');
      this.emit(record, 'HANDOFF_DECIDED', `${automatic ? 'Core 自动确认' : '用户确认'}交给${handoff.toRole === 'REVIEWER' ? '审核方' : '实施方'}`, {
        decisionId: decision.decisionId,
        handoffId: decision.handoffId,
        handoffDigest: decision.handoffDigest,
        automatic,
      });
      this.clearHandoffExpiry(record);
    } catch (error) {
      // 决定没有进入持久化事件流时，保留原交接边界，不能唤醒下一角色。
      this.handoffs.rollback(decision);
      record.pendingHandoff = handoff;
      record.view = {
        ...record.view,
        pendingHandoff: {
          handoffId: handoff.handoffId,
          digest: handoff.digest,
          nextPhase: handoff.nextPhase,
          toRole: handoff.toRole,
          expiresAt: handoff.expiresAt,
        },
      };
      throw error;
    }

    if (resumesWaitingPhase) {
      continuation.resolve();
      return { run: record.view, accepted: true, reason: null };
    }

    const deadline = record.deadline ?? new PausableDeadline(
      record.task.budget.maxWallClockMs,
      () => record.abort.abort(),
      record.view.ledger.elapsedMs,
    );
    record.deadline = deadline;
    void (async () => {
      try {
        const finalVerification = [...record.verifications].reverse().find((item) => item.phase === 'POST_MUTATION') ?? null;
        const baseline = record.verifications.find((item) => item.phase === 'BASELINE') ?? null;
        await this.runCrossReview(record, workspace, startedAt, deadline, record.patch!, finalVerification, baseline, resolution);
        if (!isTerminal(record.view.status)) this.setStatus(record, 'AWAITING_PATCH_REVIEW', '交叉审核已结束，等待你审查补丁');
      } catch (error) {
        this.emit(record, 'NOTE', `交叉审核异常（补丁不受影响）：${(error as Error).message}`);
        if (!isTerminal(record.view.status)) this.setStatus(record, 'AWAITING_PATCH_REVIEW', '交叉审核异常结束，补丁仍可审查');
      } finally {
        deadline.clear();
        record.deadline = null;
      }
    })();
    return { run: record.view, accepted: true, reason: null };
  }

  private updateCollaborationControl(input: {
    runId: string;
    mode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
    stopAfterStep?: boolean;
  }): { run: RunView; accepted: boolean; reason: string | null } {
    const record = this.require(input.runId);
    if (!record.task.collaboration || !record.collaborationMode) {
      return { run: record.view, accepted: false, reason: '该 Run 未启用双 Agent 协作' };
    }
    if (record.view.restored || isTerminal(record.view.status)) {
      return { run: record.view, accepted: false, reason: '该 Run 已没有可控制的活动执行器' };
    }
    if (input.mode === undefined && input.stopAfterStep === undefined) {
      return { run: record.view, accepted: false, reason: '没有提交协作控制变更' };
    }
    if (input.mode) record.collaborationMode = input.mode;
    if (input.stopAfterStep !== undefined) record.stopAfterStepRequested = input.stopAfterStep;
    record.view = {
      ...record.view,
      collaborationControl: {
        mode: record.collaborationMode,
        stopAfterStepRequested: record.stopAfterStepRequested,
      },
      updatedAt: nowIso(),
    };
    this.emit(
      record,
      'NOTE',
      `协作控制已更新：${record.collaborationMode === 'MANUAL_HANDOFF' ? '逐步交接' : '有界自动'}${record.stopAfterStepRequested ? '，将在下一安全边界停靠' : ''}`,
      {
        mode: record.collaborationMode,
        stopAfterStepRequested: record.stopAfterStepRequested,
      },
    );
    return { run: record.view, accepted: true, reason: null };
  }

  /**
   * 任务墙钟在人工交接时暂停，因此交接 TTL 必须由独立 timer 驱动。过期会终止
   * 当前活执行器并释放等待 Promise；先落 BLOCKED，异步栈随后醒来时不得把它复活。
   */
  private expireCollaborationHandoff(
    record: RunRecord,
    handoff: CollaborationHandoff,
    reason: string,
  ): void {
    if (
      record.pendingHandoff?.handoffId !== handoff.handoffId ||
      record.view.status !== 'AWAITING_HANDOFF'
    ) {
      return;
    }
    this.clearHandoffExpiry(record);
    record.pendingHandoff = null;
    record.view = { ...record.view, pendingHandoff: null };
    record.abort.abort();
    record.handoffContinuation?.resolve();
    record.handoffContinuation = null;
    this.cleanupPendingApprovals(record);
    this.setStatus(record, 'BLOCKED', reason, 'APPROVAL_EXPIRED');
  }

  private clearHandoffExpiry(record: RunRecord): void {
    if (record.handoffExpiryTimer) clearTimeout(record.handoffExpiryTimer);
    record.handoffExpiryTimer = null;
  }

  /**
   * 失败 / 中止现场的挽救封存。
   *
   * 「工作区不是最终事实；Patch、Verification 和 Evidence 才是交付事实」（PRD §4.2）。
   * Run 失败时工作区里往往有真实改动 —— 不封存的话，用户投入的全部 token 与时间
   * 只剩一个 FAILED 徽章，改动躺在一个没有任何界面出口的目录里。
   *
   * 挽救补丁与正式补丁走同一个 sealPatch（同一坐标系、同一诚实规则），差别只在：
   *   - unverifiedItems 头部有显式挽救标记，UI 靠它给出"不能接受"的横幅；
   *   - 它永远无法被接受：decidePatch 只认 AWAITING_PATCH_REVIEW，
   *     applyPatchToRepo 只认接受态 —— 两道既有门禁都在终态前面，
   *     所以挽救补丁只能被检视 / 复制 / 存盘（导出授权无接受态门禁，这是有意的）。
   *   - 封存自身失败绝不掩盖原始失败：包在 try/catch 里降级为 NOTE。
   *
   * 已知不做的：TIMED_OUT 路径（deadline 回调先把终态定了，之后补 patch 不会
   * 进那次 run.updated 推送，也赶不上那次落盘）—— 如实放弃，记录在案。
   */
  private sealSalvagePatch(
    record: RunRecord,
    workspace: MaterializedWorkspace,
    opts: {
      marker: string;
      baseline?: VerificationRun | null;
      finalVerification?: VerificationRun | null;
    },
  ): void {
    try {
      if (record.patch) return; // 防御：已有补丁的路径不该走到这里
      if (workspace.changedFilesVsBaseline().length === 0) return;
      const baseline = opts.baseline ?? null;
      const final = opts.finalVerification ?? null;
      const comparison = baseline && final ? compareVerification(baseline, final) : null;
      const patch = sealPatch(
        workspace,
        record.view.runId,
        record.view.attemptId,
        record.snapshot.baseSha,
        final,
        comparison,
        [
          `⚠ 挽救封存：${opts.marker}。此补丁未被证明正确，仅供检视与手工挽救，不能被接受为成功`,
        ],
        this.commandReferencedInputs(record, workspace),
      );
      record.patch = patch;
      this.emit(
        record,
        'PATCH_SEALED',
        `失败现场已封存为挽救补丁：${patch.files.length} 个文件，+${patch.files.reduce((n, f) => n + f.addedLines, 0)}/-${patch.files.reduce((n, f) => n + f.removedLines, 0)}（不可接受，仅供导出检视）`,
        { patchId: patch.patchId, digest: patch.digest, files: patch.files.map((f) => f.path), salvage: true },
      );
    } catch (err) {
      this.emit(record, 'NOTE', `挽救封存失败（不影响 Run 终态判定）：${(err as Error).message}`);
    }
  }

  private decidePatch(input: {
    runId: string;
    patchId: string;
    decision: PatchDecisionKind;
    patchDigest: string;
    note: string;
  }): { run: RunView; reason: string | null } {
    const record = this.require(input.runId);
    if (!record.patch) throw platformError('CONFLICT', '当前 Run 没有可决定的补丁');
    if (record.patch.patchId !== input.patchId || record.patch.digest !== input.patchDigest) {
      return { run: record.view, reason: '补丁已变化，请刷新后重新决定' };
    }
    if (record.view.status !== 'AWAITING_PATCH_REVIEW') {
      return { run: record.view, reason: `当前状态 ${record.view.status} 不接受补丁决定` };
    }

    const unresolvedFindings = record.crossReview?.findingDispositions?.filter(
      (finding) => finding.disposition === 'OPEN' || finding.disposition === 'REMEDIATED_PENDING_REVIEW',
    ) ?? [];
    if (input.decision === 'ACCEPT' && unresolvedFindings.length > 0 && input.note.trim().length === 0) {
      return {
        run: record.view,
        reason: `仍有 ${unresolvedFindings.length} 条审核发现未被复审确认解决；接受即表示用户显式忽略，必须填写理由`,
      };
    }

    const acceptanceId = newId('acc');
    this.emit(record, 'PATCH_DECISION', `用户决定：${input.decision}`, {
      patchId: record.patch.patchId,
      decision: input.decision,
      note: input.note,
      acceptanceId,
    });

    if (input.decision === 'ACCEPT') {
      if (record.crossReview && unresolvedFindings.length > 0) {
        const unresolvedFingerprints = new Set(unresolvedFindings.map((finding) => finding.fingerprint));
        record.crossReview = {
          ...record.crossReview,
          findingDispositions: record.crossReview.findingDispositions?.map((finding) =>
            unresolvedFingerprints.has(finding.fingerprint)
              ? {
                  ...finding,
                  disposition: 'USER_ACCEPTED' as const,
                  reason: input.note.trim(),
                  patchDigest: record.patch!.digest,
                }
              : finding,
          ),
        };
      }
      /*
       * 这是整套设计里最后一条不肯让步的规则：
       *   有通过的验证 + 用户接受 → SUCCEEDED
       *   只有用户接受            → ACCEPTED_UNVERIFIED
       *
       * 两者都是"接受了补丁"，但只有前者能说"这是被证明过的"。
       * 门禁全部放开之后，正是这条区分让 SUCCEEDED 还剩下意义。
       */
      const verificationPassed =
        record.patch.verificationRunId !== null &&
        record.verifications.some(
          (v) => v.verificationRunId === record.patch!.verificationRunId && v.passed,
        );
      /*
       * 第三条不肯让步的规则（Slice G）：补丁自己动过验证输入（配置/测试/验证脚本），
       * 那次"通过"就不能再证明修复正确。验证照样跑、照样展示，但它不构成 SUCCEEDED 的依据。
       * 旧快照没有 verificationInputsTouched 字段 → undefined → 按空处理，不追溯改写旧终态。
       */
      const coverageTouched = record.patch.verificationInputsTouched ?? [];
      const verified = verificationPassed && coverageTouched.length === 0;

      record.view = {
        ...record.view,
        terminalFacts: {
          verificationRunId: verified ? record.patch.verificationRunId : null,
          patchAcceptanceId: acceptanceId,
        },
      };
      this.setStatus(
        record,
        verified ? 'SUCCEEDED' : 'ACCEPTED_UNVERIFIED',
        verified
          ? '验证通过且用户已接受补丁（补丁未写回宿主仓库，需另行导出）'
          : verificationPassed
            ? `用户已接受补丁；验证虽通过，但补丁修改了验证输入（${coverageTouched.slice(0, 5).join(', ')}${coverageTouched.length > 5 ? ' 等' : ''}），该结果不能证明修复正确 —— 正确性仅由人工判断`
            : '用户已接受补丁，但没有通过的机器验证支撑 —— 正确性仅由人工判断',
      );
    } else if (input.decision === 'REJECT') {
      this.setStatus(record, 'BLOCKED', `用户拒绝了补丁：${input.note || '未填写原因'}`, 'PATCH_REJECTED');
    } else if (input.decision === 'REQUEST_CHANGES') {
      return { run: this.startChangeRequestAttempt(record, input.note), reason: null };
    } else {
      // PatchDecisionKind 是封闭枚举，走到这里说明有人加了新值却没接线 —— 明确停住，不静默接受
      this.setStatus(record, 'BLOCKED', `未知的补丁决定：${String(input.decision)}`, 'INVARIANT_VIOLATION');
    }

    return { run: record.view, reason: null };
  }

  // -------------------------------------------------------------------------
  // 保留期与清理
  // -------------------------------------------------------------------------

  /**
   * 当前还活着的引用。清理器据此决定什么能删。
   *
   * 之所以由权威层提供而不是让 retention 自己扫：只有这里知道 Run 的终态、
   * 以及 toolCall/patch 引用了哪些 artifact。让清理器反向依赖 authority 会绕成环。
   */
  private liveReferences(): LiveReferences {
    const runs = new Map<
      string,
      { terminal: boolean; terminalAt: number | null; updatedAt: number; snapshotId: string | null }
    >();
    const snapshots = new Set<string>();
    const artifacts = new Set<string>();

    for (const [runId, record] of this.runs) {
      const terminal = isTerminal(record.view.status);
      runs.set(runId, {
        terminal,
        terminalAt: terminal ? Date.parse(record.view.updatedAt) : null,
        updatedAt: Date.parse(record.view.updatedAt),
        // 供清理器扣减「本轮刚被删掉证据的 Run」所独占的快照
        snapshotId: record.snapshot?.snapshotId ?? null,
      });
      if (record.snapshot?.snapshotId) snapshots.add(record.snapshot.snapshotId);
      for (const tc of record.toolCalls.values()) {
        if (tc.artifactRef) artifacts.add(tc.artifactRef);
      }
      if (record.patch) artifacts.add(record.patch.patchId);
    }
    return { runs, snapshots, artifacts };
  }

  /**
   * 跑一轮清理，并把结果写进相关 Run 的事件流。
   *
   * 被清理掉的 Run 要从内存里一并移除 —— 否则 UI 上还挂着一个已经没有任何
   * 磁盘数据支撑的条目，那是另一种形式的说谎。
   */
  private runSweep(trigger: string): PurgeSummary {
    const summary = sweep(this.liveReferences());

    for (const item of summary.items) {
      if (item.outcome !== 'DELETED') continue;
      if (item.domain === 'RUN_EVIDENCE') {
        this.runs.delete(item.target);
      } else if (item.domain === 'WORKSPACE') {
        const record = this.runs.get(item.target);
        if (record) {
          // 工作区没了，但 Run 记录还在：如实记一笔，别让用户以为文件树只是加载失败
          record.events.append(
            record.view.attemptId,
            'CLEANUP_SUMMARY',
            `工作区副本已按保留策略回收（释放 ${formatBytes(item.bytesFreed)}）`,
            { domain: 'WORKSPACE', trigger },
          );
        }
      }
    }

    if (summary.deleted > 0 || summary.status === 'INCOMPLETE') {
      console.log(
        `[core] 清理(${trigger}): 扫描 ${summary.scanned} 项，删除 ${summary.deleted} 项，` +
          `释放 ${formatBytes(summary.bytesFreed)}，结果 ${summary.status}` +
          `${summary.incompleteReason ? ` —— ${summary.incompleteReason}` : ''}`,
      );
    }
    this.push({ type: 'retention.swept', summary });
    return summary;
  }

  /** 启动时跑一次，之后每 6 小时一次。不做高频轮询。 */
  private startRetentionSchedule(): void {
    // 启动时延后一点，别和 rehydrate、首屏加载抢 I/O
    setTimeout(() => this.runSweep('startup'), 5_000).unref?.();
    const timer = setInterval(() => this.runSweep('scheduled'), 6 * 60 * 60 * 1000);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // 文件浏览（只读）
  // -------------------------------------------------------------------------

  /** 选定读取根；显式 runId 是强 owner，任何缺失或错配都不得降级成快照读取。 */
  private browseRoot(
    snapshotId: string,
    runId: string | null,
  ): { root: string; baselineRoot: string | null; source: 'SNAPSHOT' | 'WORKSPACE'; generation: number | null } {
    if (runId !== null) {
      const record = this.runs.get(runId);
      if (!record) {
        throw platformError(
          'NOT_FOUND',
          `Run 不存在: ${runId}`,
          '请求明确指定了 Run，Core 不会静默回退到快照',
        );
      }
      // 文件浏览重新证明持久化实体链，不能只相信 record 内恰好有同名 snapshot 字段。
      if (
        record.view.evidence === 'DAMAGED' ||
        !record.task ||
        !record.snapshot ||
        record.view.runId !== runId ||
        record.view.taskId !== record.task.taskId ||
        record.task.snapshotId !== record.snapshot.snapshotId ||
        record.task.projectId !== record.snapshot.projectId ||
        record.view.projectId !== record.snapshot.projectId ||
        record.snapshot.snapshotId !== snapshotId
      ) {
        throw platformError(
          'CONFLICT',
          'Run 与请求快照的归属不一致，已拒绝读取文件',
          `requestedRunId=${runId}, actualRunId=${record.view.runId}, ` +
            `requestedSnapshotId=${snapshotId}, taskSnapshotId=${record.task?.snapshotId ?? 'unknown'}, ` +
            `actualSnapshotId=${record.snapshot?.snapshotId ?? 'unknown'}, ` +
            `viewProjectId=${record.view.projectId || 'unknown'}, ` +
            `taskProjectId=${record.task?.projectId ?? 'unknown'}, ` +
            `snapshotProjectId=${record.snapshot?.projectId ?? 'unknown'}`,
        );
      }
      if (!record.workspace) {
        throw platformError(
          'CONFLICT',
          '该 Run 已从磁盘恢复，工作区不再可用',
          '只能查看导入时的快照原貌；补丁内容仍可在「补丁审查」里查看和导出',
        );
      }
      return {
        root: record.workspace.activePath,
        baselineRoot: record.workspace.baselinePath(),
        source: 'WORKSPACE',
        generation: record.workspace.activeGeneration,
      };
    }
    if (!this.snapshots.has(snapshotId)) throw platformError('NOT_FOUND', '快照不存在');
    return { root: snapshotDir(snapshotId), baselineRoot: null, source: 'SNAPSHOT', generation: null };
  }

  private fileTree(snapshotId: string, runId: string | null) {
    const { root, baselineRoot, source, generation } = this.browseRoot(snapshotId, runId);
    const baseline = baselineRoot
      ? new Map(listTree(baselineRoot).map((f) => [f.path, f.digest]))
      : null;

    const entries: FileTreeEntry[] = listTree(root)
      .filter((f) => !isGeneratedPath(f.path))
      .map((f) => ({
        path: f.path,
        bytes: f.bytes,
        changed: baseline ? baseline.get(f.path) !== f.digest : false,
      }));

    return { entries, source, generation };
  }

  private readFile(
    snapshotId: string,
    path: string,
    runId: string | null,
    expectedGeneration: number | null,
  ) {
    const { root, baselineRoot, source, generation } = this.browseRoot(snapshotId, runId);
    // Core 单写者下这段检查到同步 readFileSync 之间没有 await；错代请求会在触碰文件前失败。
    if (expectedGeneration !== generation) {
      throw platformError(
        'CONFLICT',
        '文件来源 generation 已变化，请刷新文件树后重试',
        `source=${source}, expectedGeneration=${String(expectedGeneration)}, actualGeneration=${String(generation)}`,
      );
    }
    let abs: string;
    try {
      abs = resolveManaged(root, path); // 拒绝绝对路径 / `..` / symlink
    } catch (err) {
      throw platformError('POLICY_DENIED', (err as Error).message);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw platformError('NOT_FOUND', `文件不存在: ${path}`);
    }

    const raw = readFileSync(abs);
    // 含 NUL 字节就当二进制处理，不往 Renderer 塞乱码
    const binary = raw.subarray(0, 8000).includes(0);
    const truncated = raw.byteLength > MAX_VIEW_BYTES;
    const changed = baselineRoot
      ? (fileDigestAt(baselineRoot, path) ?? null) !== sha256(raw)
      : false;

    return {
      path,
      content: binary ? '' : raw.subarray(0, MAX_VIEW_BYTES).toString('utf8'),
      bytes: raw.byteLength,
      truncated,
      binary,
      changed,
      source,
      generation,
    };
  }

  // -------------------------------------------------------------------------
  // 补丁交付
  // -------------------------------------------------------------------------

  /**
   * 把补丁真正应用回宿主仓库。
   *
   * 这是整个原型里**唯一**会写用户仓库的路径，因此：
   *   - 只有被**接受过**的补丁才能写：门禁必须在 Core，而不是只靠 Renderer 藏起按钮。
   *     （之前唯一的门禁是 RunDetail.tsx 里一个决定按钮显不显示的布尔量，任何一次
   *     重放 / 渲染 bug / 直接走 IPC 都能把**被拒绝的**补丁写进用户仓库。）
   *   - digest 必须与调用方看到的一致：「被应用的东西」= 「被接受的东西」。
   *   - 交给 `git apply` 做，不自己实现 patch 应用逻辑。
   *   - 先 `--check` 干跑一遍；有任何一处冲突就整笔拒绝，不做部分应用。
   *   - 子包导入时用 `--directory` 把坐标系还原回仓库根。
   *   - 结果如实回报，失败时原样带出 git 的错误。
   */
  private applyPatchToRepo(
    runId: string,
    patchId: string,
    patchDigest: string | undefined,
  ): PatchExportResult {
    const record = this.require(runId);
    if (!record.patch || record.patch.patchId !== patchId) {
      return { ok: false, reason: 'PATCH_CHANGED', detail: '补丁不存在或已变化，请刷新' };
    }

    // 接受态 + digest 双重门禁，抽成纯函数以便单测（见 checkPatchApplyGate）
    const gate = checkPatchApplyGate({
      status: record.view.status,
      patchAcceptanceId: record.view.terminalFacts?.patchAcceptanceId ?? null,
      actualDigest: record.patch.digest,
      requestedDigest: patchDigest,
    });
    if (!gate.ok) return gate;
    if (record.view.evidence === 'DAMAGED' || !record.snapshot || !record.task || !record.profile) {
      return {
        ok: false,
        reason: 'EVIDENCE_DAMAGED',
        detail: '该 Run 的状态快照已损坏，无法确定补丁的实体归属与坐标系，拒绝应用',
      };
    }
    const project = this.projects.get(record.task.projectId);
    if (!project) return { ok: false, reason: 'PROJECT_MISSING', detail: '项目不存在' };

    // acceptance/digest 证明“用户接受了眼前这份补丁”；归属复核证明“写入的是它所属的项目”。
    const ownership = checkPatchApplyOwnership({
      requestedRunId: runId,
      projectId: project.ref.projectId,
      view: record.view,
      task: record.task,
      snapshot: record.snapshot,
      profile: record.profile,
      patch: record.patch,
    });
    if (!ownership.ok) return ownership;

    if (record.snapshot.baseKind === 'NO_VCS') {
      return {
        ok: false,
        reason: 'NOT_A_GIT_REPO',
        detail: '该项目不在 git 管理下，无法用 git apply 安全应用。请改用「保存为文件」。',
      };
    }
    if (record.patch.files.length === 0) {
      return { ok: false, reason: 'EMPTY_PATCH', detail: '补丁为空' };
    }
    if (record.patch.files.some((f) => f.diffTruncated)) {
      return {
        ok: false,
        reason: 'PATCH_TRUNCATED',
        detail: '补丁中有被截断的 diff，应用会产生不完整结果。请改用「保存为文件」后手工处理。',
      };
    }

    const paths = record.patch.files.map((f) => f.path);
    const result = applyPatchWithGit(
      project.hostPath,
      record.snapshot.subPath,
      record.patch.unifiedDiff,
      join(PATHS.artifacts, `${record.patch.patchId}.diff`),
      paths,
    );

    if (!result.ok) {
      this.emit(record, 'NOTE', `补丁应用被拒绝（${result.stage}）：${result.detail.slice(0, 300)}`);
      return result.stage === 'CHECK'
        ? {
            ok: false,
            reason: 'APPLY_CONFLICT',
            detail: `git 认为这个补丁无法干净应用，已整笔拒绝、未改动任何文件：\n\n${result.detail}`,
          }
        : {
            ok: false,
            reason: 'APPLY_FAILED',
            detail: `--check 通过但实际应用失败（文件可能在这期间被改动）：\n\n${result.detail}`,
          };
    }

    this.emit(record, 'NOTE', `补丁已应用到宿主仓库：${paths.join(', ')}`, {
      applied: paths,
      subPath: record.snapshot.subPath || null,
    });
    return {
      ok: true,
      mode: 'APPLY_TO_REPO',
      detail: `已写入 ${paths.length} 个文件。改动尚未 commit，你可以用 git diff 复核，或 git checkout -- . 撤销。`,
      target: project.ref.displayPath,
    };
  }

  // -------------------------------------------------------------------------
  // 通用
  // -------------------------------------------------------------------------

  /**
   * 进程退出前的尽力清理：向所有活动 Run 发 abort，让每个正在运行的验证/工具命令
   * 的进程组同步收到 SIGTERM（runCommand 的 abort 监听里 `process.kill(-pid)` 是同步的）。
   *
   * 这里刻意**不**改 Run 状态：应用退出不是用户取消，重启后由 closeInterruptedRun
   * 落成 INTERRUPTED 才是事实。但要同步追加一条持久化事件，让重启后的清理说明能区分
   * 「正常退出路径、已发过 SIGTERM」与「崩溃/强杀、什么都没来得及做」—— 之前的说明
   * 无论哪种情况都写死"子进程已随进程退出释放"，而 detached 进程组并不会随父进程死。
   *
   * 已知不做的：不等待 SIGKILL 升级（那是 runCommand 里的定时器，进程马上就退了），
   * 所以这里只能承诺"发过 SIGTERM"，不能承诺"已终止"。说明文字必须照此措辞。
   */
  shutdown(reason: string): { signalledRuns: number } {
    let signalledRuns = 0;
    for (const record of this.runs.values()) {
      if (isTerminal(record.view.status) || record.view.restored) continue;
      if (record.abort.signal.aborted) continue;
      record.events.append(
        record.view.attemptId,
        'NOTE',
        `进程收到退出信号（${reason}）：已向该 Run 运行中的命令进程组发送 SIGTERM，不等待终止确认`,
        { kind: 'PROCESS_EXIT_SIGNAL', reason },
      );
      record.abort.abort();
      signalledRuns += 1;
    }
    return { signalledRuns };
  }

  private cancel(runId: string, reason: string): RunView {
    const record = this.require(runId);
    if (isTerminal(record.view.status)) return record.view;
    if (record.view.restored) {
      // 恢复态唯一可能的非终态是 AWAITING_PATCH_REVIEW，那里没有进程可停
      this.setStatus(record, 'BLOCKED', `${reason}（该 Run 已从磁盘恢复，无运行中的进程）`, 'USER_CANCELLED');
      return record.view;
    }
    record.abort.abort();
    this.clearHandoffExpiry(record);
    record.handoffContinuation?.resolve();
    record.handoffContinuation = null;
    record.pendingHandoff = null;
    record.view = { ...record.view, pendingHandoff: null };
    this.cleanupPendingApprovals(record);
    this.setStatus(record, 'CANCELLED', reason, 'USER_CANCELLED');
    return record.view;
  }

  /**
   * REQUEST_CHANGES：**开新 Attempt，不是终态**（PRD-DIFF-003 / PRD §9）。
   *
   * 语义（TD §11.1）：
   *   - 旧 Attempt 的全部事实原样保留（事件、工具调用、验证、补丁进 priorPatches）；
   *   - 旧的 Plan/Tool/Patch 审批一律失效 —— 新 Attempt 重新规划、重新批准；
   *   - **不续用旧 workspace/lease**：从同一个 immutable snapshot 重新物化一份；
   *   - 预算是 Task 级聚合的：账本继续累加，墙钟带着已用时间起算。余额不够就不开，
   *     而不是开一个必然立刻超预算的 Attempt。
   *   - 用户的反馈进下一次任务简报（连同上一版 diff），否则模型只会把同样的改法再写一遍。
   *
   * 开不了新 Attempt 时（预算耗尽 / 恢复态没有执行器 / 路由丢失）落 BLOCKED 并说清楚是哪一种，
   * 而不是笼统一句"暂未实现"。
   */
  private startChangeRequestAttempt(record: RunRecord, note: string): RunView {
    const previous = record.patch!;
    const previousAttemptNo = record.view.attemptNo;

    const stop = (reason: string): RunView => {
      this.setStatus(record, 'BLOCKED', `用户要求修改，但无法创建新 Attempt：${reason}`, 'CHANGES_REQUESTED');
      return record.view;
    };

    // 恢复态的 Run 没有活的执行器与工作区：它能接受/拒绝补丁，但开不了新 Attempt
    if (record.view.restored || !record.workspace) {
      return stop('这个 Run 是从磁盘恢复的，没有活的执行器（可以接受或拒绝，但不能续跑）');
    }
    const resolution = record.implementerResolution;
    if (!resolution) {
      return stop('缺少本 Run 冻结的模型路由');
    }
    // 预算是 Task 级聚合：先看余额，再决定开不开
    const l = record.view.ledger;
    const lim = record.task.budget;
    const exhausted =
      l.modelTurns >= lim.maxModelTurns
        ? `模型轮次已达上限 ${lim.maxModelTurns}`
        : l.toolCalls >= lim.maxToolCalls
          ? `工具调用已达上限 ${lim.maxToolCalls}`
          : l.inputTokens + l.outputTokens >= lim.maxTotalTokens
            ? `token 已达上限 ${lim.maxTotalTokens}`
            : l.elapsedMs >= lim.maxWallClockMs
              ? `时间预算已用尽（${Math.round(l.elapsedMs / 1000)}s / ${Math.round(lim.maxWallClockMs / 1000)}s）`
              : null;
    if (exhausted) return stop(`${exhausted} —— 新 Attempt 与旧的共用同一份任务预算`);

    // ---- 旧 Attempt 收尾：事实保留，授权作废 ----
    record.priorPatches.push(previous);
    record.patch = null;
    record.plan = null;
    record.collaborationCycleId = record.task.collaboration ? newId('cycle') : null;
    if (record.view.collaborationProjection) {
      record.view = {
        ...record.view,
        collaborationProjection: {
          ...record.view.collaborationProjection,
          cycleId: record.collaborationCycleId,
          currentCycle: { reviewerInvocations: 0, remediations: 0 },
        },
      };
    }
    this.cleanupPendingApprovals(record); // 旧审批一律失效（正常此时已无 pending）
    record.approvals.clear();
    record.deadline?.clear();

    // ---- 新 Attempt ----
    const attemptId = newId('att');
    const attemptNo = previousAttemptNo + 1;
    record.abort = new AbortController();
    record.changeRequest = { note, previousPatchDigest: previous.digest, previousAttemptNo };
    /*
     * 新工作区：MaterializedWorkspace.create 以 runId 为目录键，会先删掉旧目录再从快照重建 ——
     * 于是"不续用旧 workspace"是结构上的，不靠调用方自觉。旧 Attempt 的改动就此消失，
     * 但它已经封存在 priorPatches 里（补丁自带完整 diff），证据不丢。
     */
    try {
      record.workspace = MaterializedWorkspace.create(
        record.view.runId,
        record.snapshot.snapshotId,
        record.depsRoot,
      );
    } catch (err) {
      record.changeRequest = null;
      return stop(`重新物化工作区失败：${(err as Error).message}`);
    }

    record.view = {
      ...record.view,
      attemptId,
      attemptNo,
      status: 'CREATED',
      statusReason: null,
      failureClass: null,
      workspaceGeneration: record.workspace.activeGeneration,
      updatedAt: nowIso(),
    };
    this.emit(
      record,
      'ATTEMPT_STARTED',
      `用户要求修改 → 开始第 ${attemptNo} 次尝试（上一版补丁 ${previous.digest.slice(0, 16)} 已封存为历史）`,
      {
        attemptNo,
        previousAttemptNo,
        previousPatchDigest: previous.digest,
        note,
        // 预算是接着用的，不是重置 —— 把起点如实写进事件
        ledgerAtStart: { ...l },
      },
    );
    this.persist(record);
    this.push({ type: 'run.updated', run: record.view });

    void this.execute(record, resolution);
    return record.view;
  }

  /**
   * 签发一次性导出授权。
   *
   * 三件事在这里做，因为只有 Core 知道：补丁是不是当前那一份（digest）、
   * 哪些目录绝对不能写（项目仓库 / 受管数据根 / 活动工作区）、以及要导出的字节里
   * 有没有高置信度凭据（导出是 DLP 的 `PATCH_EXPORT` 阶段，与出站那道同源）。
   *
   * 内容与授权一起返回：分两次调用会在中间留一个"补丁已经变了但票还有效"的窗口。
   */
  // -------------------------------------------------------------------------
  // 一次性精确命令批准
  // -------------------------------------------------------------------------

  /**
   * 为一条命令签发批准（`command.requestApproval`）。
   *
   * 只签"我们不认识它"的那一类。已知危险的 R2（联网/装依赖/容器/未知 git 子命令）在这里
   * 直接 `POLICY_DENIED` —— 界面不该给它一个"我了解风险"的复选框，因为工作区的
   * `node_modules` 是指向宿主仓库的 symlink，`pnpm install` 会写进用户真实的依赖树，
   * 那不是一次点击能授权的东西。R3/R4 同样在这里止步。
   */
  /**
   * 只判级、不签发。界面每敲一次键都可以问，问多少次都不会在 Core 里留下东西。
   */
  private classifyCommand(argv: readonly string[]): {
    risk: ToolRisk;
    cause: string;
    reason: string;
    approvable: boolean;
    remediation: string | null;
  } {
    const clean = argv.map((a) => a.trim()).filter(Boolean);
    const verdict = classifyUserCommand(clean);
    const approvable = isApprovableCause(verdict);
    return {
      risk: verdict.risk,
      cause: verdict.cause,
      reason: verdict.reason,
      approvable,
      remediation:
        verdict.risk === 'R1' || approvable
          ? null
          : verdict.cause === 'NETWORK_OR_DEPS'
            ? '请先在你自己的仓库里装好依赖，RepoPilot 会只读复用它 —— 工作区的 node_modules 是指向你仓库的 symlink，在这里装依赖会写进你真实的依赖树。'
            : '这一类命令没有批准通道。可以改用 node / pnpm 等已知入口包装你要跑的脚本。',
    };
  }

  private requestCommandApproval(argv: readonly string[]): CommandApproval {
    const clean = argv.map((a) => a.trim()).filter(Boolean);
    if (clean.length === 0) throw platformError('BAD_REQUEST', '空命令');
    const verdict = classifyUserCommand(clean);
    if (verdict.risk === 'R1') {
      throw platformError('BAD_REQUEST', `「${clean.join(' ')}」是 R1，不需要批准`);
    }
    if (!isApprovableCause(verdict)) {
      throw platformError(
        'POLICY_DENIED',
        `「${clean.join(' ')}」不可批准（${verdict.risk}）：${verdict.reason}`,
        verdict.cause === 'NETWORK_OR_DEPS'
          ? '工作区的 node_modules 是指向你仓库的 symlink，装依赖会写进你真实的依赖树 —— 请先在仓库里装好依赖，再让 RepoPilot 只读复用。'
          : '这一类命令原型不提供批准通道。可以改用 node / pnpm 等已知入口包装你要跑的脚本。',
      );
    }
    /*
     * 凭据扫描：批准过的 argv 会原样进事件流落盘（事后要能复核"我当时批的是什么"）。
     * 与任务文本同一条规矩 —— 先拦，不要先落盘再靠别处兜。
     */
    const hits = scanSegments([{ text: clean.join(' '), where: '待批准命令' }]);
    if (hits.length > 0) {
      throw platformError(
        'BAD_REQUEST',
        `命令含高置信度凭据（${describeDlpHits(hits)}），已拒绝批准`,
        '批准过的命令会原样写进事件日志；请改用环境变量或配置文件，不要把凭据写在 argv 里',
      );
    }
    const approval: CommandApproval = {
      approvalId: newId('capp'),
      argv: clean,
      argvDigest: commandArgvDigest(clean),
      reason: verdict.reason,
      grantedAt: nowIso(),
      expiresAt: new Date(Date.now() + COMMAND_APPROVAL_TTL_MS).toISOString(),
      maxBindings: 1,
      bindings: 0,
      boundRunIds: [],
      executions: 0,
    };
    this.commandApprovals.set(approval.approvalId, approval);
    return approval;
  }

  /** 取出仍然可用（未过期、未用尽绑定）的批准；其余一律当作不存在 */
  private liveApprovals(approvalIds: readonly string[]): CommandApproval[] {
    const now = Date.now();
    const out: CommandApproval[] = [];
    for (const id of approvalIds) {
      const a = this.commandApprovals.get(id);
      if (!a) continue;
      if (Date.parse(a.expiresAt) < now) continue;
      if (a.bindings >= a.maxBindings) continue;
      out.push(a);
    }
    return out;
  }

  /**
   * 把批准绑定到刚创建的 Run，并把绑定这件事写进事件流。
   *
   * 绑定发生在 Run 存在之后（批准本身早于 Run，所以签发时无事件可发）。
   * 只绑**真的被用上**的那些：批了却没有对应命令的票不消耗绑定次数，也不落账 ——
   * 落一条"批准了 X"而 X 根本没进 profile，是在事件流里制造不存在的事实。
   */
  private bindApprovals(record: RunRecord, used: ReadonlyMap<string, string>): void {
    for (const [approvalId, commandId] of used) {
      const a = this.commandApprovals.get(approvalId);
      if (!a) continue;
      this.commandApprovals.set(approvalId, {
        ...a,
        bindings: a.bindings + 1,
        boundRunIds: [...a.boundRunIds, record.view.runId],
      });
      this.emit(
        record,
        'COMMAND_APPROVAL_BOUND',
        `你逐条批准了 R2 命令「${a.argv.join(' ')}」作为 ${commandId}（一次性，只对本次运行有效）`,
        {
          approvalId,
          commandId,
          argv: a.argv,
          argvDigest: a.argvDigest,
          reason: a.reason,
          grantedAt: a.grantedAt,
          expiresAt: a.expiresAt,
          scope: 'BASELINE_AND_VERIFICATION',
        },
      );
    }
  }

  /**
   * 执行期的批准校验（传给 `runVerification` 的闸门）。
   *
   * 这是纵深防御的第二道：登记时已经查过一次，这里在**每一次执行前**再查
   * —— 命令定义有可能被别的路径塞进 profile，它不能靠"验证命令"这个身份绕过分级。
   *
   * 拒绝的四种情形都要说清是哪一种，因为它们的下一步完全不同：没批过、批的不是这条、
   * 票过期了、这个角色用不了这张票。
   */
  private approvalCheckerFor(record: RunRecord): CommandApprovalChecker {
    return {
      consume: (def, role) => {
        if (role === 'MODEL_PROPOSED') {
          // 用户批的是"我的验证命令"，不是"模型可以调用的工具"。这条界线不能由角色自己跨。
          return { ok: false, reason: '用户批准的命令只对基线/验证生效，模型提出的调用不能借用' };
        }
        const approvalId = def.approvalId ?? null;
        if (!approvalId) return { ok: false, reason: '这条命令高于 R1 且没有批准记录' };
        const a = this.commandApprovals.get(approvalId);
        if (!a) return { ok: false, reason: '批准记录已不存在（进程重启后批准一律作废）' };
        if (a.argvDigest !== commandArgvDigest(def.argv)) {
          // 批准绑的是整条 argv：命令定义被改过一个字，这张票就不再对应它
          return { ok: false, reason: '命令与批准时的 argv 不一致（批准绑定整条命令，不是可执行名）' };
        }
        if (!a.boundRunIds.includes(record.view.runId)) {
          return { ok: false, reason: '这张批准没有绑定到本次运行' };
        }
        this.commandApprovals.set(approvalId, { ...a, executions: a.executions + 1 });
        this.emit(
          record,
          'COMMAND_APPROVAL_USED',
          `按批准执行 R2 命令「${a.argv.join(' ')}」（${role}，第 ${a.executions + 1} 次）`,
          { approvalId, commandId: def.commandId, role, executions: a.executions + 1 },
        );
        return { ok: true };
      },
    };
  }

  private issueExportGrant(
    runId: string,
    patchId: string,
  ): { grant: PatchExportGrant; content: string } {
    const record = this.require(runId);
    if (!record.patch || record.patch.patchId !== patchId) {
      throw platformError('NOT_FOUND', '补丁不存在或已变化');
    }
    const content = renderPatchFile(record);
    /*
     * 导出期 DLP：补丁正文会离开应用落到用户磁盘上。fs_read 那道闸挡住了"含凭据的文件
     * 进入模型上下文"，但 diff 的上下文行仍可能带出邻近的凭据 —— 这是最后一道。
     * 与出站一样 fail-closed，没有"仍然导出"。
     */
    const hits = scanSegments([{ text: content, where: `patch:${patchId}` }]);
    if (hits.length > 0) {
      this.emit(record, 'PATCH_EXPORTED', `导出被拒绝：${describeDlpHits(hits)}`, {
        patchId,
        outcome: 'BLOCKED_DLP',
      });
      throw platformError(
        'POLICY_DENIED',
        `补丁内容含高置信度凭据（${describeDlpHits(hits)}），已拒绝导出`,
        '请先把凭据从仓库里移除并重新导入；导出会把这些字节写到你的磁盘上',
      );
    }

    const project = this.projects.get(record.view.projectId);
    const forbiddenRoots = [
      // 项目仓库本身：把 .patch 存进正在被修的仓库，下一次导入就会把它当源码收进快照
      ...(project ? [project.hostPath] : []),
      // 受管数据根（快照/工作区/证据/凭据都在里面）：保留策略会把陌生文件当垃圾清掉
      PATHS.root,
    ];
    const grant: PatchExportGrant = {
      grantId: newId('xgrant'),
      runId,
      patchId,
      patchDigest: record.patch.digest,
      contentDigest: digestOf({ content }),
      filename: suggestPatchFilename(record),
      byteLength: Buffer.byteLength(content, 'utf8'),
      forbiddenRoots,
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + EXPORT_GRANT_TTL_MS).toISOString(),
    };
    this.exportGrants.set(grant.grantId, grant);
    return { grant, content };
  }

  /**
   * 消费一张导出授权并记账。
   *
   * 一次性：无论成功、被拒还是取消，票据都在这里作废 —— 想再导一次就得再要一张。
   * 这样"选完路径之后又改主意"和"重放同一张票写第二个地方"都不可能。
   */
  private settleExportGrant(input: {
    grantId: string;
    outcome: 'WRITTEN' | 'CANCELLED' | 'REJECTED' | 'FAILED';
    detail?: string;
    targetName?: string;
    bytes?: number;
    overwrote?: boolean;
    contentDigest?: string;
  }): { accepted: boolean; reason: string | null } {
    const grant = this.exportGrants.get(input.grantId);
    if (!grant) {
      // 票不存在 = 已经用过或已过期。这不是异常，是"这次导出不算数"
      return { accepted: false, reason: '导出授权不存在、已使用或已过期' };
    }
    this.exportGrants.delete(input.grantId);
    const record = this.runs.get(grant.runId);
    if (!record) return { accepted: false, reason: 'Run 不存在' };

    if (Date.parse(grant.expiresAt) < Date.now()) {
      this.emit(record, 'PATCH_EXPORTED', '导出授权已过期，本次导出不计入', {
        patchId: grant.patchId,
        outcome: 'EXPIRED',
      });
      return { accepted: false, reason: '导出授权已过期' };
    }
    if (input.outcome === 'WRITTEN' && input.contentDigest !== grant.contentDigest) {
      this.emit(record, 'PATCH_EXPORTED', '导出内容与授权的 digest 不一致，已记为无效', {
        patchId: grant.patchId,
        outcome: 'DIGEST_MISMATCH',
      });
      return { accepted: false, reason: '导出内容与授权不一致' };
    }
    this.emit(
      record,
      'PATCH_EXPORTED',
      input.outcome === 'WRITTEN'
        ? `补丁已导出到 ${input.targetName ?? '(未记录文件名)'}（${input.bytes ?? 0} 字节${input.overwrote ? '，覆盖了同名文件' : ''}）`
        : `导出未完成（${input.outcome}）：${input.detail ?? ''}`,
      {
        patchId: grant.patchId,
        patchDigest: grant.patchDigest,
        // 只记文件名，不记宿主绝对路径 —— 事件流是要给人看、也要能导出的
        targetName: input.targetName ?? null,
        outcome: input.outcome,
        bytes: input.bytes ?? null,
        overwrote: input.overwrote ?? null,
        detail: input.detail ?? null,
      },
    );
    return { accepted: input.outcome === 'WRITTEN', reason: null };
  }

  private setStatus(
    record: RunRecord,
    status: RunStatus,
    reason: string | null,
    failureClass: FailureClass | null = null,
  ): void {
    if (isTerminal(record.view.status)) return; // 终态不可逆
    const facts = record.view.terminalFacts;
    if (status === 'SUCCEEDED' && !(facts?.verificationRunId && facts.patchAcceptanceId)) {
      throw new Error('内部不变式违规：SUCCEEDED 必须同时绑定通过的 verification 与 patch acceptance');
    }
    if (status === 'ACCEPTED_UNVERIFIED' && !facts?.patchAcceptanceId) {
      throw new Error('内部不变式违规：ACCEPTED_UNVERIFIED 必须绑定 patch acceptance');
    }
    const previous = record.view.status;
    record.view = {
      ...record.view,
      status,
      statusReason: reason,
      // 归类只随非成功终态落定；中间态转换传 null，不残留上一次的值
      failureClass,
      workspaceGeneration: record.workspace?.activeGeneration ?? record.view.workspaceGeneration,
      updatedAt: nowIso(),
    };
    /*
     * 事件日志已经写不下去时：**不落盘、不发事件，只更新内存并推送。**
     *
     * 上面两条不变式检查仍然已经跑过了 —— 日志死了不等于终态门禁可以放松，
     * SUCCEEDED 照样要求 verification + acceptance 同时绑定。
     *
     * 跳过 persist 的理由是它会造出一个会说假话的一致性检查：persist 把
     * `eventHighWatermark: events.lastSeq()` 写进 state.json，而 rehydrate 只检查
     * "事件是否比状态新"这一个方向（见 rehydrateRuns）。日志写失败时快照水位会
     * **超前**于日志，那个单向检查于是判 `INTACT` —— 把丢事件说成完好。
     * 宁可不写快照：重启后该 Run 会按旧快照恢复并如实落成 INTERRUPTED。
     */
    if (!record.events.writeFailure()) {
      this.emit(record, 'STATUS_CHANGED', `${previous} → ${status}${reason ? `（${reason}）` : ''}`, {
        from: previous,
        to: status,
        reason,
        failureClass,
      });
      this.persist(record); // 事件已 append，此刻状态快照才允许追上
    }
    this.push({ type: 'run.updated', run: record.view });

    // Run 刚终态，它的工作区通常是最大的一块 —— 过了宽限期就该回收
    if (isTerminal(status) && this.backgroundRetention) {
      setTimeout(() => this.runSweep('run-terminal'), 30_000).unref?.();
    }
  }

  private emit(
    record: RunRecord,
    kind: RunEventKind,
    summary: string,
    payload: Record<string, unknown> = {},
  ): void {
    const event = record.events.append(record.view.attemptId, kind, summary, payload);
    this.push({ type: 'run.event', runId: record.view.runId, event });
  }

  private require(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw platformError('NOT_FOUND', `Run 不存在: ${runId}`);
    return record;
  }
}

// ---------------------------------------------------------------------------

export class CoreError extends Error {
  constructor(readonly payload: PlatformError) {
    super(payload.message);
  }
}

export function platformError(
  code: PlatformError['code'],
  message: string,
  detail: string | null = null,
): CoreError {
  return new CoreError({ code, message, detail });
}

const COMMAND_OUTCOME_KINDS = new Set<CommandResult['outcome']>([
  'EXIT_ZERO',
  'EXIT_NONZERO',
  'SIGNAL',
  'TIMEOUT',
  'CANCELLED',
  'SPAWN_ERROR',
]);

/**
 * 把 run_command 的 `meta.outcome`（完整 CommandOutcome）投影成不含正文的
 * CommandResult：正文已经在 preview / artifactRef 里，原样进事件 payload 会让
 * 每条 TOOL_CALL_RESOLVED 背上完整的命令输出。
 *
 * `ToolOutcome.meta` 是 `Record<string, unknown>`，形状由各个工具自己决定。
 * 这里只认得出 run_command 那一种，认不出就返回 null —— **不猜**：
 * 把一个形状不对的对象强转成 CommandResult，等于让界面显示一个编出来的终局。
 */
function readCommandResult(value: unknown): CommandResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const outcome = v.outcome;
  if (typeof outcome !== 'string' || !COMMAND_OUTCOME_KINDS.has(outcome as CommandResult['outcome'])) {
    return null;
  }
  return {
    outcome: outcome as CommandResult['outcome'],
    exitCode: typeof v.exitCode === 'number' ? v.exitCode : null,
    signal: typeof v.signal === 'string' ? v.signal : null,
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : 0,
  };
}

/** IPC 仍是未知输入；generation 不能靠 `Number(...)` 把缺失、字符串或小数悄悄变成 owner。 */
function parseExpectedGeneration(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw platformError(
    'BAD_REQUEST',
    'expectedGeneration 必须是非负安全整数或 null',
  );
}

/** 恢复态 Run 用的 AbortController：一出生就是已取消，任何误用都会立刻停 */
function abortedController(): AbortController {
  const ac = new AbortController();
  ac.abort();
  return ac;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function suggestPatchFilename(record: RunRecord): string {
  const stamp = record.patch!.sealedAt.replace(/[:.]/g, '-').slice(0, 19);
  const scope = record.snapshot.subPath ? record.snapshot.subPath.replace(/\//g, '-') : 'repo';
  return `repopilot-${scope}-${stamp}.patch`;
}

/**
 * 补丁文件带头部元信息：光有 diff 没法说明它是基于什么、验证过没有。
 *
 * `verified` 一行必须与 decidePatch 用同一条判定 —— 看那次验证**是否通过**，
 * 而不是看 verificationRunId 是否非空。挽救封存的补丁恰恰带着一次失败的验证 id，
 * 只判非空会在导出文件里打出 `verified: yes`，那是离开应用之后最难追回的一句假话。
 */
function describePatchVerification(record: RunRecord): string {
  const p = record.patch!;
  if (p.verificationRunId === null) {
    return record.view.terminalFacts
      ? 'NO — accepted without machine verification'
      : 'NO — no machine verification was run';
  }
  const run = record.verifications.find((v) => v.verificationRunId === p.verificationRunId);
  if (!run) return `UNKNOWN — verification ${p.verificationRunId} not found in run evidence`;
  const touched = p.verificationInputsTouched ?? [];
  if (run.passed && touched.length > 0) {
    return `NO — verification ${p.verificationRunId} passed, but the patch modified verification inputs (${touched.join(', ')}); the pass does not prove the fix`;
  }
  if (run.passed) return `yes (${p.verificationRunId})`;
  return `NO — verification ${p.verificationRunId} FAILED (salvaged patch; not accepted as success)`;
}



function renderPatchFile(record: RunRecord): string {
  const p = record.patch!;
  const header = [
    `# RepoPilot patch`,
    `# patchId:     ${p.patchId}`,
    `# digest:      ${p.digest}`,
    `# sealedAt:    ${p.sealedAt}`,
    `# base:        ${record.snapshot.baseKind === 'NO_VCS' ? '(no vcs)' : p.baseSha}`,
    `# baseKind:    ${record.snapshot.baseKind}${
      record.snapshot.dirtyFileCount ? ` (${record.snapshot.dirtyFileCount} uncommitted changes at snapshot time)` : ''
    }`,
    `# scope:       ${record.snapshot.subPath || '(repository root)'}`,
    `# verified:    ${describePatchVerification(record)}`,
    `# task:        ${record.task.goal.replace(/\n/g, ' ')}`,
    `#`,
    `# apply with:  git apply -p1${record.snapshot.subPath ? ` --directory=${record.snapshot.subPath}` : ''} <this-file>`,
    `# revert with: git checkout -- ${p.files.map((f) => f.path).join(' ')}`,
    `#`,
    ...p.unverifiedItems.map((u) => `# unverified: ${u}`),
    '',
  ].join('\n');
  return `${header}${ensureTrailingNewline(p.unifiedDiff)}`;
}

function shortenPath(hostPath: string): string {
  const home = process.env.HOME ?? '';
  const shown = home && hostPath.startsWith(home) ? `~${hostPath.slice(home.length)}` : hostPath;
  const parts = shown.split('/');
  return parts.length <= 4 ? shown : `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

export { digestOf };
