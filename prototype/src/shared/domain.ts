/**
 * RepoPilot 原型 — 领域模型
 *
 * 这里的类型是文档里逻辑不变式的代码投影。以下几条是**故意**在类型层强制的，
 * 改动前请回到 PRD/TD 对应条款：
 *
 *  1. Run 的 SUCCEEDED 必须同时绑定通过的 Verification 和用户接受的 Patch。
 *     → RunTerminalFacts 把两者做成必填，无法只凭其一进入终态。（PRD-DIFF-002）
 *  2. ToolCall 一旦开始处理，永远有且只有一个 resolution。（PRD-RUN-002）
 *  3. Mutation 必须消费 MutationReadReceipt；Receipt 只证明读过，不授予写权限。（PRD-MUT-002）
 *  4. 每次模型调用都要声明 purpose 并冻结 route，辅助调用不例外。（PRD-MODEL-005）
 *  5. 预算账本单调递增，不因 retry / deny / cancel 回减。（PRD-RUN-007）
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

/** 内容寻址摘要，格式 `sha256:<hex>` */
export type Digest = string;

export type Iso8601 = string;

export interface ActorRef {
  /** 不可直接识别个人的本地操作者引用（PRD-DESK-006） */
  readonly actorId: string;
  readonly sessionId: string;
  readonly appInstanceId: string;
}

// ---------------------------------------------------------------------------
// 项目 / 快照 / Profile
// ---------------------------------------------------------------------------

export interface ProjectRef {
  readonly projectId: string;
  readonly name: string;
  /** 宿主绝对路径只存在于 Core，永不投影到 Renderer；此处是安全展示值 */
  readonly displayPath: string;
  readonly createdAt: Iso8601;
}

/**
 * 快照的基线性质。
 *
 * `CLEAN_COMMIT` —— 内容等于某个 commit，base 可命名，补丁可被别人复现。
 * `DIRTY_WORKTREE` —— 内容是当时磁盘上的 tracked 文件，base 只是"最近的 commit + 本地改动"。
 *
 * 后者仍然是不可变、内容寻址的快照，验证基线依然成立；
 * 失去的只是"base 可被他人重建"这一点。所以它不该被禁止，而该被**如实标注**。
 */
export type SnapshotBaseKind = 'CLEAN_COMMIT' | 'DIRTY_WORKTREE' | 'NO_VCS';

export interface RepositorySnapshot {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly baseKind: SnapshotBaseKind;
  /** `DIRTY_WORKTREE` 时为被本地改动覆盖的文件数；否则为 0 */
  readonly dirtyFileCount: number;
  /** 仅快照仓库的这个子目录（monorepo 子包）；整仓为 '' */
  readonly subPath: string;
  /** tracked-only；untracked 文件永远不进快照 */
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly treeDigest: Digest;
  readonly excludedPaths: readonly ExclusionEntry[];
  readonly createdAt: Iso8601;
}

/** monorepo 里可以单独作为项目根导入的子包 */
export interface SubPackageCandidate {
  /** 相对仓库根的路径，如 apps/web */
  readonly subPath: string;
  readonly name: string;
  readonly hasVite: boolean;
  readonly hasReact: boolean;
  readonly hasTypescript: boolean;
  readonly scripts: readonly string[];
}

export interface ExclusionEntry {
  readonly path: string;
  readonly reason:
    | 'GIT_INTERNAL'
    | 'DEPENDENCY_DIR'
    | 'BUILD_OUTPUT'
    | 'BINARY'
    | 'OVERSIZE'
    | 'SECRET_SUSPECT';
  readonly bytes: number;
}

export type ProfileSupportStatus = 'VERIFIED' | 'PREVIEW' | 'AMBIGUOUS' | 'UNSUPPORTED';

/**
 * snapshot-bound 的仓库能力描述。
 * 不变式：Profile 只能描述或**收窄**能力，永远不能授权。（TD 不变式 #8 / #22）
 */
export interface RepositoryHarnessProfile {
  readonly profileId: string;
  readonly snapshotId: string;
  readonly adapterId: 'vite-react-ts';
  readonly adapterVersion: string;
  readonly supportStatus: ProfileSupportStatus;
  readonly detectedSignals: readonly string[];
  readonly packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  /** 稳定 command id → 结构化 argv，模型只能引用 id，不能自由拼 shell */
  readonly commands: Readonly<Record<string, CommandDefinition>>;
  readonly protectedPaths: readonly string[];
  readonly supportedTaskClasses: readonly TaskClass[];
  readonly notes: readonly string[];
}

export interface CommandDefinition {
  readonly commandId: string;
  readonly label: string;
  readonly argv: readonly string[];
  readonly cwdRelative: string;
  readonly timeoutMs: number;
  readonly risk: ToolRisk;
  /** DETECTED = 从 package.json 解析；USER = 用户在本次任务里手填 */
  readonly source: 'DETECTED' | 'USER';
}

export type TaskClass = 'BUILD_FAILURE_FIX' | 'TEST_FAILURE_FIX' | 'TYPE_ERROR_FIX';

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export interface TaskSpec {
  readonly taskId: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly profileId: string;
  readonly goal: string;
  readonly taskClass: TaskClass;
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptance: readonly string[];
  /** 引用 profile.commands 的 id，不是自由字符串 */
  readonly verificationCommandIds: readonly string[];
  readonly budget: BudgetLimits;
  readonly createdAt: Iso8601;
}

export interface BudgetLimits {
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly maxSelfFixRounds: number;
  readonly maxWallClockMs: number;
  readonly maxTotalTokens: number;
}

/** 单调递增，绝不回减（PRD-RUN-007） */
export interface BudgetLedger {
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly selfFixRounds: number;
  readonly elapsedMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const EMPTY_LEDGER: BudgetLedger = {
  modelTurns: 0,
  toolCalls: 0,
  selfFixRounds: 0,
  elapsedMs: 0,
  inputTokens: 0,
  outputTokens: 0,
};

// ---------------------------------------------------------------------------
// Run / Attempt 状态机
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'AWAITING_PATCH_REVIEW'
  | 'SUCCEEDED'
  /** 用户接受了补丁，但没有任何机器验证支撑 —— 与 SUCCEEDED 严格区分 */
  | 'ACCEPTED_UNVERIFIED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  /**
   * 进程退出时该 Run 还在执行中，重启后无法续跑。
   *
   * 与 CANCELLED / FAILED 严格区分：那两者是**在运行中做出的决定**，
   * 这个是"没来得及有结论"。混用会让事后审计分不清"用户取消了"和"应用被关了"。
   */
  | 'INTERRUPTED';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'SUCCEEDED',
  'ACCEPTED_UNVERIFIED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
  'INTERRUPTED',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * 进入接受态的凭据。
 *
 * `SUCCEEDED` 要求两个字段都非空 —— 模型声明完成、build 单项通过都构造不出来。
 * 没有验证时 `verificationRunId` 为 null，终态只能是 `ACCEPTED_UNVERIFIED`。
 * 这个区分由 Core 在状态转换处强制，不靠调用方自觉。
 */
export interface RunTerminalFacts {
  readonly verificationRunId: string | null;
  readonly patchAcceptanceId: string;
}

export interface RunView {
  readonly runId: string;
  readonly taskId: string;
  /** 让侧栏能把运行挂到所属项目下 */
  readonly projectId: string;
  /** 供列表展示的短标题，取自 TaskSpec.goal */
  readonly title: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly status: RunStatus;
  readonly statusReason: string | null;
  readonly ledger: BudgetLedger;
  readonly limits: BudgetLimits;
  readonly workspaceGeneration: number;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
  readonly terminalFacts: RunTerminalFacts | null;
  /**
   * 该 Run 是从磁盘恢复的，不是本次进程创建的。
   *
   * 恢复出来的 Run 没有活的 Agent Loop 和工作区，因此**不能续跑**；
   * 但历史、补丁、验证记录都是真的，可以查看和导出。
   */
  readonly restored: boolean;
  /**
   * 证据完整性。
   *
   * `DAMAGED` 表示状态快照读不出来 —— 这个 Run 仍然留在列表里并标明损坏，
   * 而不是当作从未存在过。
   */
  readonly evidence: 'INTACT' | 'DAMAGED' | 'EVENTS_AHEAD';
  readonly evidenceDetail: string | null;
}

// ---------------------------------------------------------------------------
// 事件（append-only，Renderer 重载后从这里恢复，不从 UI 内存猜）
// ---------------------------------------------------------------------------

export type RunEventKind =
  | 'RUN_CREATED'
  | 'STATUS_CHANGED'
  | 'PLAN_GENERATED'
  | 'PLAN_DECISION'
  | 'MODEL_INVOCATION'
  | 'TOOL_CALL_PROPOSED'
  | 'TOOL_CALL_APPROVAL_REQUIRED'
  | 'TOOL_CALL_RESOLVED'
  | 'MUTATION_APPLIED'
  | 'VERIFICATION_STARTED'
  | 'VERIFICATION_FINISHED'
  | 'PATCH_SEALED'
  | 'PATCH_DECISION'
  | 'SELF_FIX_ROUND'
  | 'BUDGET_EXHAUSTED'
  | 'CLEANUP_SUMMARY'
  | 'NOTE';

export interface RunEvent {
  readonly seq: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: RunEventKind;
  readonly at: Iso8601;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 工具与审批
// ---------------------------------------------------------------------------

/**
 * R0 读/搜索           — 自动允许，仍受 scope/输出限制
 * R1 工作区写/构建/测试 — Plan 批准后允许
 * R2 依赖安装/受限网络  — 需一次性精确审批（原型内暂未开放）
 * R3 删除/CI/迁移等     — hard deny
 * R4 push/merge/部署/明文 secret — always deny
 */
export type ToolRisk = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export type ToolCallResolution =
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'UNKNOWN_RECONCILING';

export interface ToolCallView {
  readonly toolCallId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly toolName: string;
  readonly risk: ToolRisk;
  /** 安全参数摘要，不含宿主绝对路径 */
  readonly argsSummary: string;
  readonly argsDigest: Digest;
  readonly resolution: ToolCallResolution | null;
  readonly resolutionReason: string | null;
  /** 有界预览；完整输出在 artifact 里，事件只存引用 */
  readonly preview: string | null;
  readonly previewTruncated: boolean;
  readonly artifactRef: string | null;
  readonly startedAt: Iso8601;
  readonly resolvedAt: Iso8601 | null;
  readonly durationMs: number | null;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: 'PLAN' | 'TOOL_CALL';
  readonly risk: ToolRisk;
  readonly title: string;
  readonly detail: string;
  /** 参数或计划的 digest；变化即失效（PRD-APPR-002） */
  readonly subjectDigest: Digest;
  readonly requestedAt: Iso8601;
  readonly expiresAt: Iso8601;
}

export type ApprovalDecisionKind = 'APPROVE' | 'REJECT';

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

export interface PlanStep {
  readonly index: number;
  readonly intent: string;
  readonly targetPaths: readonly string[];
  readonly toolNames: readonly string[];
  readonly expectedEffect: string;
}

export interface PlanRevision {
  readonly planId: string;
  readonly runId: string;
  readonly revision: number;
  readonly parentPlanId: string | null;
  readonly snapshotId: string;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
  readonly risks: readonly string[];
  readonly verificationCommandIds: readonly string[];
  readonly digest: Digest;
  readonly generatedBy: ModelInvocationRef;
  readonly createdAt: Iso8601;
}

// ---------------------------------------------------------------------------
// 精确变更
// ---------------------------------------------------------------------------

/**
 * 由受治理读取产生。只证明「在某个 generation 下读到了这段字节」，
 * **不授予任何写权限**。Executor 在 apply 时仍会重验全部 digest。
 */
export interface MutationReadReceipt {
  readonly receiptId: string;
  readonly generation: number;
  readonly path: string;
  readonly fileDigest: Digest;
  readonly byteLength: number;
  readonly readAt: Iso8601;
  readonly expiresAt: Iso8601;
}

export type MutationOperationKind =
  | 'REPLACE_EXACT_TEXT_SPAN'
  | 'REPLACE_WHOLE_FILE'
  | 'CREATE_FILE';

export interface MutationOperation {
  readonly kind: MutationOperationKind;
  readonly path: string;
  /** REPLACE_EXACT_TEXT_SPAN 必填：必须在文件中**恰好命中一次** */
  readonly oldText?: string;
  readonly newText: string;
  /** CREATE_FILE 之外必填 */
  readonly receiptId?: string;
}

export interface MutationPlan {
  readonly planId: string;
  readonly runId: string;
  readonly inputGeneration: number;
  readonly operations: readonly MutationOperation[];
}

export type MutationBlockReason =
  | 'STALE_GENERATION'
  | 'STALE_FILE_DIGEST'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_EXPIRED'
  | 'ZERO_MATCH'
  | 'MULTIPLE_MATCH'
  | 'PATH_ESCAPE'
  | 'PATH_NOT_ALLOWED'
  | 'PROTECTED_PATH'
  | 'TARGET_EXISTS'
  | 'TARGET_ABSENT'
  | 'BUDGET_EXCEEDED'
  | 'SYMLINK_REJECTED';

export interface MutationOperationResult {
  readonly path: string;
  readonly kind: MutationOperationKind;
  readonly beforeDigest: Digest | null;
  readonly afterDigest: Digest;
  readonly bytesDelta: number;
}

export type MutationResult =
  | {
      readonly ok: true;
      readonly outputGeneration: number;
      readonly operations: readonly MutationOperationResult[];
      readonly treeDigest: Digest;
    }
  | {
      readonly ok: false;
      /** 整笔不提交 —— 没有部分成功（PRD-MUT-003） */
      readonly reason: MutationBlockReason;
      readonly detail: string;
      readonly rolledBackToGeneration: number;
    };

// ---------------------------------------------------------------------------
// 验证与补丁
// ---------------------------------------------------------------------------

export interface CommandOutcome {
  readonly commandId: string;
  readonly argv: readonly string[];
  /** exit-code / signal / timeout / cancel / spawn-error 判别联合，非零绝不算成功 */
  readonly outcome: 'EXIT_ZERO' | 'EXIT_NONZERO' | 'SIGNAL' | 'TIMEOUT' | 'CANCELLED' | 'SPAWN_ERROR';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly outputTruncated: boolean;
}

export interface VerificationRun {
  readonly verificationRunId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly phase: 'BASELINE' | 'POST_MUTATION';
  readonly generation: number;
  readonly commands: readonly CommandOutcome[];
  readonly passed: boolean;
  readonly startedAt: Iso8601;
  readonly finishedAt: Iso8601;
}

export interface VerificationComparison {
  readonly fixed: readonly string[];
  readonly stillFailing: readonly string[];
  readonly newlyFailing: readonly string[];
}

export interface PatchFileEntry {
  readonly path: string;
  readonly changeKind: 'MODIFIED' | 'ADDED';
  readonly addedLines: number;
  readonly removedLines: number;
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export interface PatchArtifact {
  readonly patchId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly baseSha: string;
  readonly generation: number;
  readonly files: readonly PatchFileEntry[];
  readonly unifiedDiff: string;
  readonly digest: Digest;
  readonly sealedAt: Iso8601;
  /** 未验证模式下为 null —— 这样"有没有验证"在类型上就是可区分的 */
  readonly verificationRunId: string | null;
  readonly comparison: VerificationComparison | null;
  /** 明确未被验证覆盖的项，必须展示给用户 */
  readonly unverifiedItems: readonly string[];
  /**
   * 被验证命令生成、因而未纳入补丁的文件（dist/ 等）。
   * 列出来是为了让"补丁里为什么没有它们"可解释，而不是静默省略。
   */
  readonly excludedGeneratedFiles: readonly string[];
}

export type PatchDecisionKind = 'ACCEPT' | 'REJECT' | 'REQUEST_CHANGES';

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/**
 * Provider 标识。内置的形如 `anthropic` / `zhipuai` / `openrouter`，
 * 用户自定义的用自己的 slug —— 所以这里是开放字符串而不是固定枚举。
 */
export type ProviderId = string;

/** OFFICIAL=厂商自家 API，RELAY=第三方聚合/中转，CUSTOM=用户自己加的 */
export type ProviderKind = 'OFFICIAL' | 'RELAY' | 'CUSTOM';

export type ModelInvocationPurpose =
  | 'PLANNING'
  | 'EXECUTION'
  | 'SELF_FIX'
  | 'COMPACTION'
  | 'TITLE_SUMMARY';

/** 凭据从哪来。应用内录入优先于环境变量。 */
export type CredentialSource = 'APP' | 'ENV' | 'NONE';

export interface ModelConnectionProfile {
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly builtIn: boolean;
  /** 线上协议方言 */
  readonly wire: 'anthropic' | 'openai';
  /** 实际生效的 base URL（含版本路径）：用户覆盖 > 环境变量 > 描述符默认 */
  readonly origin: string;
  /** 描述符里的默认地址，用于对比出"是不是被改过" */
  readonly officialOrigin: string;
  /** 用户填的覆盖地址；空表示用官方 */
  readonly baseUrlOverride: string;
  /** origin ≠ 官方 origin 时为 true —— 数据流向变了，必须显式告知 */
  readonly isRelay: boolean;
  readonly modelId: string;
  /** 可选模型清单，让 UI 给下拉而不是逼用户手打 id */
  readonly availableModels: readonly string[];
  readonly credentialEnvVar: string;
  readonly credentialSource: CredentialSource;
  /** 凭据尾部若干位，用于确认"配的是哪把 key"；永远不回传完整值 */
  readonly credentialHint: string | null;
  readonly docUrl: string;
  readonly enabled: boolean;
  /** 首版固定 MANUAL_ONLY，禁止自动 fallback */
  readonly routeSwitchPolicy: 'MANUAL_ONLY';
  readonly automaticFallback: 'DENY';
}

/** 每个 Attempt 冻结一条，运行中漂移必须阻断而不是自动换路由 */
export interface ModelRouteResolution {
  readonly resolutionId: string;
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly origin: string;
  readonly modelId: string;
  readonly frozenAt: Iso8601;
  readonly digest: Digest;
}

export interface ModelInvocationRef {
  readonly invocationId: string;
  readonly purpose: ModelInvocationPurpose;
  readonly resolutionId: string;
}

/** 每次实际或被阻断的出站都有一条；不含 raw secret 与请求正文 */
export interface ModelEgressManifest {
  readonly invocationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly purpose: ModelInvocationPurpose;
  readonly resolutionId: string;
  readonly providerId: ProviderId;
  readonly origin: string;
  readonly modelId: string;
  readonly sent: boolean;
  readonly blockReason: string | null;
  readonly contextFileRefs: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requestedAt: Iso8601;
  readonly settledAt: Iso8601 | null;
  readonly errorKind: string | null;
}

// ---------------------------------------------------------------------------
// 环境自检
// ---------------------------------------------------------------------------

/** 文件树条目；`source` 说明你看到的是快照原貌还是 Agent 改过的工作区 */
export interface FileTreeEntry {
  readonly path: string;
  readonly bytes: number;
  /** 相对 gen-0 是否被改动过；只有 WORKSPACE 视图才有意义 */
  readonly changed: boolean;
}

export type DoctorStatus = 'READY' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export interface DoctorCheck {
  readonly checkId: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly remediation: string | null;
}
