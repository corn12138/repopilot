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
  /**
   * 被本地改动覆盖的 **tracked** 文件数。
   *
   * 只数 tracked：untracked 文件根本不在快照里，把它算作"改动"等于说
   * "你的新文件在里面并且被改过了" —— 两句都不成立。它由 `untrackedCount` 单独报。
   */
  readonly dirtyFileCount: number;
  /**
   * 导入范围内的 untracked 文件数 —— 它们**一个都没进快照**。
   *
   * 这是一次真正的排除，必须报数：只加了新文件的仓库，快照内容与 HEAD 逐字节相同，
   * 而用户以为自己那个新文件正在被修。此前这个数被并进 dirtyFileCount，
   * 于是"完全没进来"被显示成了"进来了而且是改动过的"。
   */
  readonly untrackedCount: number;
  /** 仅快照仓库的这个子目录（monorepo 子包）；整仓为 '' */
  readonly subPath: string;
  /** tracked-only；untracked 文件永远不进快照（数量见 untrackedCount） */
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
    | 'SECRET_SUSPECT'
    /** 软链接不跟随：以前被误记成 BINARY，那是分类撒谎，不是省略报数。 */
    | 'SYMLINK'
    /** 存在但读不了（EACCES/ELOOP/竞态删除）。与"不存在"必须可区分。 */
    | 'UNREADABLE'
    /**
     * Git LFS 指针：磁盘上是一段 ~130 字节的 `version https://git-lfs...` 文本，不是真内容。
     *
     * 必须与 BINARY / UNREADABLE 分开，因为它的危险方式独一无二：把指针当源码收进快照，
     * 模型会对指针本身生成补丁，而这个补丁在宿主上 `git apply --check` 会**通过** ——
     * 于是"应用到仓库"把用户真正的 LFS 指针覆盖成模型写的文本，大文件与仓库的关联就断了。
     * 排除是唯一安全的处理：模型看不见它，就不可能改它。
     */
    | 'LFS_POINTER'
    /** 子模块（gitlink，mode 160000）：它是另一个仓库的引用，不是本仓库的文件 */
    | 'SUBMODULE'
    /**
     * 索引里有、工作区没有（sparse checkout / 未 checkout）。
     * 与 UNREADABLE 分开：那是"读不了"，这是"根本没检出"，用户的下一步完全不同。
     */
    | 'NOT_CHECKED_OUT'
    /**
     * 只有大小写不同的多个索引条目，在当前文件系统上指向同一个 inode。
     * 收进来会让快照声称有两个文件、而磁盘只有一个 —— 对其中一个做整文件替换会静默改掉另一个。
     * 无法无歧义寻址，所以整组一起排除。
     */
    | 'CASE_COLLISION'
    /** 枚举本身被上限截断；`path` 是被截断的目录，`bytes` 为 0。 */
    | 'ENUMERATION_TRUNCATED';
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

/**
 * 一次命令执行的发起者与用途（TD §9.4「同一 Gateway、同一账本」）。
 *
 * 平台自己发起的验证不是"免账"的特权路径：它同样产生 ToolCall 记录、同样计入账本、
 * 同样过风险闸门，只是审批来源是 VerificationPolicy 而不是模型。
 */
export type CommandRole = 'MODEL_PROPOSED' | 'BASELINE' | 'VERIFICATION';

export interface CommandDefinition {
  readonly commandId: string;
  readonly label: string;
  readonly argv: readonly string[];
  readonly cwdRelative: string;
  readonly timeoutMs: number;
  readonly risk: ToolRisk;
  /** DETECTED = 从 package.json 解析；USER = 用户在本次任务里手填 */
  readonly source: 'DETECTED' | 'USER';
  /**
   * 这条命令高于 R1 却仍被登记时，凭据是哪一张 `CommandApproval`。
   *
   * 只有 `risk === 'R2' && cause === 'UNKNOWN_BINARY'` 会走到这里。null = 不需要批准
   * （R1）。旧数据里没有这个字段，读出来是 undefined —— 按旧语义（R1，无批准）处理。
   */
  readonly approvalId?: string | null;
}

/**
 * 一次性精确命令批准（PRD-CMD-002 / 08-17 审计 D3 的后半段）。
 *
 * 审计打掉的是"填一次即永久授权"。这里给出的替代不是"永远拒绝"，而是把那个决定
 * **收窄到一次、绑死到一条 argv、限定在一个 Run 里、并且全程记账**：
 *
 * | 维度 | 约束 |
 * |---|---|
 * | 精确 | 绑 `argvDigest`（整个 argv 数组，不是可执行名，也不是前缀） |
 * | 一次性 | `maxBindings` 次绑定，默认 1 —— 一张票只能进一个 Run |
 * | 时效 | `expiresAt` 之后作废；批准了不用，过期就得重批 |
 * | 身份 | 只对 BASELINE / VERIFICATION 生效，**模型提出的命令永远不能用它** |
 * | 记账 | 绑定与每一次执行都进事件流，`executions` 计数 |
 *
 * **为什么不限制执行次数**：PRD 的措辞是 "max uses"，这里落成 max *bindings*。
 * 一条验证命令在一个 Run 里本来就要跑很多次（基线 1 次、终验 1 次、每轮自修复重验 1 次、
 * 交叉审核整改后再 1 次，而续期可以让轮次继续增加）。给执行次数设上限，等于让一次
 * 合法的重验变成 SPAWN_ERROR —— 那是**假红**。要限的是"这次授权能扩散多远"，
 * 不是"这条命令跑了几遍"，所以次数照记不照拦。这是与 PRD 措辞的一处显式偏离。
 */
export interface CommandApproval {
  readonly approvalId: string;
  /** 用户看到并批准的那一条 argv，原样留存 —— 事后要能复核"我当时批的到底是什么" */
  readonly argv: readonly string[];
  readonly argvDigest: string;
  /** 它为什么需要批准（分级给出的原因），不是用户填的备注 */
  readonly reason: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly maxBindings: number;
  /** 已经绑定到几个 Run */
  readonly bindings: number;
  /** 绑定到的 Run（按绑定顺序），用于事后追溯 */
  readonly boundRunIds: readonly string[];
  /** 实际执行了几次 —— 只计数、不设上限，理由见上 */
  readonly executions: number;
}

/**
 * 任务类型：**自由文本**，不是封闭枚举。
 *
 * 它是纯描述性元数据 —— 不设任何门禁，也不进系统提示词。用三个值把用户限死，
 * 换不到任何东西："文档站构建挂了"、"e2e 偶发失败" 这类真实场景一个都装不下。
 * 封闭枚举留给**平台自己判定**的东西（RunStatus、failureClass、命令 outcome）；
 * 用户描述自己的任务，该用用户自己的话。
 */
export type TaskClass = string;

/** 常见任务类型，仅作输入建议，不构成约束 */
export const COMMON_TASK_CLASSES = [
  'BUILD_FAILURE_FIX',
  'TEST_FAILURE_FIX',
  'TYPE_ERROR_FIX',
] as const;

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export interface TaskSpec {
  readonly taskId: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly profileId: string;
  readonly goal: string;
  /** 来自观察面的人为交接；只在 Core 重算 payload 摘要一致后写入。 */
  readonly handoffDigest?: Digest;
  /** 缺失表示历史/普通任务；只有显式配置才启用双角色协作门禁。 */
  readonly collaboration?: {
    readonly mode: CollaborationMode;
    readonly planner: CollaborationRoleBinding;
    readonly implementer: CollaborationRoleBinding;
    readonly reviewer: CollaborationRoleBinding;
    readonly roleBindingDigest: Digest;
  };
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
  /**
   * provider 未回报用量的模型轮次数。
   *
   * inputTokens/outputTokens 的加和只包含**已知**数字 —— null 绝不折算成 0
   * （null 表示无法证明，不等于 0）。这个计数器让"上面的 token 数少算了几轮"
   * 这件事本身可见。可选：旧版状态快照没有此字段，含义是"当时未统计"，
   * 与 0（统计了、全都回报了）不同。
   */
  readonly unknownUsageTurns?: number;
}

export const EMPTY_LEDGER: BudgetLedger = {
  modelTurns: 0,
  toolCalls: 0,
  selfFixRounds: 0,
  elapsedMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownUsageTurns: 0,
};

/**
 * 一次记账。token 字段三态：
 *   number    —— 已知用量，计入加和；
 *   null      —— 涉及 token 但 provider 未回报（计入 unknownUsageTurns，不进加和）；
 *   undefined —— 此次记账不涉及 token（工具调用、自修复轮）。
 */
export interface LedgerCharge {
  readonly modelTurns?: number;
  readonly toolCalls?: number;
  readonly selfFixRounds?: number;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

/** 账本只加不减（PRD-RUN-007）。null 与 undefined 的区分见 LedgerCharge。 */
export function applyLedgerCharge(
  ledger: BudgetLedger,
  charge: LedgerCharge,
  elapsedMs: number,
): BudgetLedger {
  const usageUnknown = charge.inputTokens === null || charge.outputTokens === null;
  return {
    modelTurns: ledger.modelTurns + (charge.modelTurns ?? 0),
    toolCalls: ledger.toolCalls + (charge.toolCalls ?? 0),
    selfFixRounds: ledger.selfFixRounds + (charge.selfFixRounds ?? 0),
    elapsedMs,
    inputTokens: ledger.inputTokens + (charge.inputTokens ?? 0),
    outputTokens: ledger.outputTokens + (charge.outputTokens ?? 0),
    unknownUsageTurns: (ledger.unknownUsageTurns ?? 0) + (usageUnknown ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------
// Run / Attempt 状态机
// ---------------------------------------------------------------------------

/**
 * 非成功终态的失败归类（封闭枚举）。
 *
 * 与 RunStatus 的分工：status 说"停在了哪种终态"（FAILED/BLOCKED/…），
 * failureClass 说"**为什么**"。同一个 BLOCKED 可能是预算耗尽、计划被拒、
 * 审批过期 —— 事后统计与 eval 需要区分它们，而不是 grep statusReason 的中文。
 */
export type FailureClass =
  | 'VERIFICATION_FAILED' // 自修复用尽，验证仍未通过
  | 'NO_CHANGES' // 模型没有做出任何改动
  | 'MODEL_INVOCATION_FAILED' // 出站调用失败（含重试用尽）
  | 'PLANNING_FAILED'
  | 'RUNTIME_ERROR'
  | 'BUDGET_EXHAUSTED'
  | 'EGRESS_BLOCKED'
  | 'PLAN_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'PATCH_REJECTED'
  | 'CHANGES_REQUESTED'
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'INTERRUPTED' // 进程退出时仍在执行，没来得及有结论
  | 'INVARIANT_VIOLATION'; // 内部不变式违规（平台自己的错，不是任务的错）

export type RunStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  /**
   * 补丁已封存、验证已完成，正在由**第二个模型**只读交叉审核（PRD-XAGENT-003）。
   *
   * 非终态，介于 VERIFYING 与 AWAITING_PATCH_REVIEW 之间。审核方的"通过"绝不等于
   * SUCCEEDED —— 那需要机器验证。审核只产出 findings，最终仍由人在
   * AWAITING_PATCH_REVIEW 决定（即 PRD 的 HUMAN_REVIEW_REQUIRED）。
   * 不进可跨重启存活白名单：它需要活的执行器。
   */
  | 'CROSS_REVIEWING'
  /**
   * 当前阶段已完整落账，Core 正等待用户或有界自动策略消费下一份交接决定。
   *
   * 这是进程内安全边界，不是可恢复 checkpoint：应用重启后没有活执行器，必须转为
   * INTERRUPTED，不能从这项状态推导出上一条模型请求可安全重发。
   */
  | 'AWAITING_HANDOFF'
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
  /**
   * 创建这个 Run 的快照。
   *
   * 必须由 RunView 自己携带，不能让 Renderer 从 Plan 里推：Plan 要到规划完成才存在，
   * 而"这个 Run 属于哪份快照"从创建那一刻起就是确定的。之前靠 `plan.snapshotId` 推导，
   * 结果是 PLANNING 阶段的 Run 根本无法打开文件树。
   *
   * `null` 只出现在证据损坏的 Run 上 —— 那时快照归属确实不可知，必须如实说不知道，
   * 而不是拿"当前项目最近一次导入"顶上。
   */
  readonly snapshotId: string | null;
  /** 供列表展示的短标题，取自 TaskSpec.goal */
  readonly title: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly status: RunStatus;
  readonly statusReason: string | null;
  /**
   * 非成功终态的结构化归类。statusReason 是给人读的自由文本，这个是给
   * 统计、eval 和过滤用的封闭枚举 —— 「有多少 Run 是验证失败、多少是
   * 模型调用失败」不该靠 grep 中文句子回答。可选：旧状态快照没有此字段。
   */
  readonly failureClass?: FailureClass | null;
  readonly ledger: BudgetLedger;
  readonly limits: BudgetLimits;
  readonly workspaceGeneration: number;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
  readonly terminalFacts: RunTerminalFacts | null;
  readonly pendingHandoff?: Pick<CollaborationHandoff, 'handoffId' | 'digest' | 'nextPhase' | 'toRole' | 'expiresAt'> | null;
  readonly collaborationControl?: {
    readonly mode: CollaborationMode;
    readonly stopAfterStepRequested: boolean;
  } | null;
  /** Core 投影的角色与审核计数；Renderer 不从事件文案反推。 */
  readonly collaborationProjection?: {
    readonly roles: readonly Pick<CollaborationRoleBinding, 'role' | 'executionKind' | 'label'>[];
    readonly cycleId: string | null;
    readonly currentCycle: {
      readonly reviewerInvocations: number;
      readonly remediations: number;
    };
    readonly taskTotals: {
      readonly reviewerInvocations: number;
      readonly remediations: number;
    };
  } | null;
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
  /** 一次补丁导出的结果（成功/被拒/取消都记）—— 这是补丁离开应用的唯一出口 */
  | 'PATCH_EXPORTED'
  | 'COMMAND_APPROVAL_BOUND'
  | 'COMMAND_APPROVAL_USED'
  /** 用户 REQUEST_CHANGES 之后开始的新一次 Attempt（PRD-DIFF-003） */
  | 'ATTEMPT_STARTED'
  | 'SELF_FIX_ROUND'
  | 'BUDGET_EXHAUSTED'
  | 'CLEANUP_SUMMARY'
  /**
   * 模型自己写的话。
   *
   * 必须与 NOTE 分开：NOTE 是**平台**的如实标注（未验证模式、状态流转、整改结果），
   * 把模型正文塞进 NOTE 等于把它记在平台名下 —— 时间线上会显示成"平台"在说话，
   * 而界面上从来不会出现"AI"这个说话人。这正是之前发生的事。
   *
   * 之前更严重的一半是：只有模型**停止调用工具**的那一轮才取一次正文，且截到 400 字
   * 无披露；有工具调用的那些轮，模型写的东西整段丢弃。参照物界面里"每组工具调用后面
   * 那段有实质结论的自然语言"，在这套数据里根本不存在。
   *
   * payload: { purpose: 'PLANNING'|'EXECUTION'|'CROSS_REVIEW', truncated: boolean, fullLength: number }
   */
  | 'ASSISTANT_MESSAGE'
  /** 交叉审核开始（含 reviewer route 与是否异构） */
  | 'CROSS_REVIEW_STARTED'
  /** 一次 reviewer invocation 结束（verdict + 发现数） */
  | 'CROSS_REVIEW_ROUND'
  /** 交叉审核整体结束（stopReason） */
  | 'CROSS_REVIEW_FINISHED'
  | 'HANDOFF_CREATED'
  | 'HANDOFF_DECIDED'
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
  /**
   * 命令类工具（run_command）的终局判别联合。非命令工具为 null。
   *
   * 可选：旧状态快照里没有这个字段，读回来是 `undefined` —— 那不是"命令成功了"，
   * 是"这次记录里没有这份事实"，界面必须按未知处理而不是按通过处理。
   */
  readonly commandResult?: CommandResult | null;
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

export type ApprovalDecisionKind = 'APPROVE' | 'REJECT' | 'REVISE';

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
  /**
   * 这次读取**让读者看到了多少**（TD §9.12）。
   *
   * `FULL_BLOB` = 全文都给出去了；`BYTE_RANGE` = 只给了一段（例如 fs_read 的预览被上限截断）。
   * 这是 `REPLACE_WHOLE_FILE` 的准入条件：只见过开头就整文件覆盖，等于把没看过的尾部
   * 静默删掉。digest 相同只能证明"文件没变"，证明不了"读者看过全文"。
   */
  readonly coverage: 'FULL_BLOB' | 'BYTE_RANGE';
  /** 实际给出去的原始内容字节数；FULL_BLOB 时等于 byteLength */
  readonly coveredBytes: number;
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
  | 'SYMLINK_REJECTED'
  /** receipt 的覆盖范围不足以支撑该 operation（只读了一段就要整文件替换） */
  | 'RECEIPT_COVERAGE_INSUFFICIENT'
  /** 请求路径的拼写与磁盘上真实条目不一致（大小写/Unicode 归一绕过）：
   * 例如在 APFS 上用 'Package.json' 落到 'package.json'，绕过大小写敏感的受保护路径匹配 */
  | 'PATH_CASE_MISMATCH';

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

/**
 * 命令终局的判别联合投影 —— **不含正文**。
 *
 * 正文在 `ToolCallView.preview` / `artifactRef` 里，重复带一份既胀事件也胀状态快照。
 *
 * 为什么要单独有这个：不变式「命令结果是判别联合，不是布尔」对**平台发起**的验证命令
 * 一直成立（结果以 CommandOutcome 进 VERIFICATION_FINISHED），但对**模型发起**的
 * run_command 只留下 `resolution: SUCCEEDED | FAILED` —— 到了界面上，"退出码 1"、
 * "被信号杀掉"、"超时"、"根本没起来"长得一模一样。不变式说的是"无论由谁发起都走同一套"，
 * 这个字段就是把模型那一侧补齐。
 */
export interface CommandResult {
  readonly outcome: CommandOutcome['outcome'];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
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
  /**
   * 基线里失败过、但本次**根本没跑**的命令。
   *
   * 必须与 fixed 分开：没跑过就说"修好了"是一句没有证据的谎话，
   * 而 fixed 会直接进补丁摘要。
   */
  readonly notRerun: readonly string[];
}

export interface PatchFileEntry {
  readonly path: string;
  readonly changeKind: 'MODIFIED' | 'ADDED' | 'DELETED';
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
   * 补丁触碰到的**验证输入**（tsconfig/vite/vitest/eslint 配置、测试文件、验证命令点名的脚本）。
   * 非空表示这次"验证通过"不能证明修复正确：接受后终态只能是 ACCEPTED_UNVERIFIED，
   * 导出文件头写 NO。可选：旧快照没有此字段，读出 undefined 按空处理（旧语义）。
   */
  readonly verificationInputsTouched?: readonly string[];
  /**
   * 被验证命令生成、因而未纳入补丁的文件（dist/ 等）。
   * 列出来是为了让"补丁里为什么没有它们"可解释，而不是静默省略。
   */
  readonly excludedGeneratedFiles: readonly string[];
}

export type PatchDecisionKind = 'ACCEPT' | 'REJECT' | 'REQUEST_CHANGES';

/**
 * 一次性导出授权（PRD-DIFF-004 / TD §13 PatchExportGrant）。
 *
 * 导出是补丁**离开应用**的唯一出口，所以它不能是"随便调一次 IPC 就写盘"：
 * 授权绑定具体的补丁与内容 digest、带 TTL、只能用一次，并且由 Core 给出
 * 一份"绝对不能写进去"的目录清单（项目仓库、受管数据根、活动工作区）。
 * Main 持有原生能力（对话框与文件系统），但写哪儿这件事由这张票据约束。
 */
export interface PatchExportGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly patchId: string;
  /** 补丁本身的 digest：与用户看到/接受的那一份对不上就不该导出 */
  readonly patchDigest: Digest;
  /** 实际要写出去的字节的 digest（含文件头）；Main 写完回报，Core 核对 */
  readonly contentDigest: Digest;
  readonly filename: string;
  readonly byteLength: number;
  /** 绝对不能作为导出目的地的目录（realpath 由 Main 侧再解析一次） */
  readonly forbiddenRoots: readonly string[];
  readonly issuedAt: Iso8601;
  readonly expiresAt: Iso8601;
}

// ---------------------------------------------------------------------------
// 交叉审核（PRD-XAGENT-003/004 的诚实子集：第二个模型 API 只读交叉审核）
// ---------------------------------------------------------------------------
//
// 明确边界：这里用的是两个 `ModelConnectionProfile`，**不是** PRD 定义的
// `ExternalCodingAgentConnectorProfile`（那要求接官方 Codex CLI / Claude Code 的
// 非交互接口，含 binary identity、capability probe、ExternalCandidateWorkspace）。
// PRD 第 439 行要求这两个概念不得互相冒充：所以对外只能说"第二个模型 API 交叉审核"，
// 不能说"已接入 Codex / Claude Code"。

export type ReviewSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/**
 * 只读审核方产出的单条发现。形状对齐 TD §12.17 的 ReviewFindingArtifact：
 * severity / confidence / file / range / evidence / reproduction /
 * suggestedRemediation / blocking / fingerprint。
 *
 * 审核方**只能**产出这个 —— 不能改工作区、不能批准补丁、不能改 Run 终态。
 */
export interface ReviewFinding {
  readonly severity: ReviewSeverity;
  /** 0..1，审核方对这条判断的把握 */
  readonly confidence: number;
  readonly file: string | null;
  /** [startLine, endLine]，1-based；无法定位时为 null */
  readonly range: readonly [number, number] | null;
  readonly evidence: string;
  readonly reproduction: string | null;
  readonly suggestedRemediation: string | null;
  /** true = 阻断性缺陷，会驱动一次整改；false = 提示性 */
  readonly blocking: boolean;
  /**
   * 去重指纹。同一指纹在多轮里重复出现是"没有进展"的信号之一，
   * 会触发提前转人工（PRD-XAGENT-004）。
   */
  readonly fingerprint: string;
}

/** 单次审核调用的判定 —— "通过"仅指"没发现阻断项"，绝不是 Verification/SUCCEEDED */
export type CrossReviewVerdict = 'PASS' | 'CHANGES_REQUESTED' | 'INCONCLUSIVE';

/** 一次 reviewer invocation 的不可变记录 */
export interface CrossReviewRound {
  readonly round: number;
  /** 本轮所属的协作循环；旧持久化记录可能没有。 */
  readonly cycleId?: string;
  /** 本次审核调用的稳定身份；跨续期不能复用。 */
  readonly reviewId?: string;
  /** 审核所针对的补丁 digest —— 用来判定"整改后 digest 是否真的变了" */
  readonly reviewedPatchDigest: Digest;
  readonly reviewerResolutionId: string;
  readonly verdict: CrossReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  /** 复审明确确认已经解决的上一轮 finding 指纹；缺失表示当时未记录该合同。 */
  readonly resolvedFindingFingerprints?: readonly string[];
  readonly startedAt: Iso8601;
  readonly finishedAt: Iso8601;
}

/**
 * 为什么交叉审核结束、把控制权交回人手上。
 *
 * 除 REVIEWER_PASSED / COUNTER_EXHAUSTED 外，都是提前转人工的早停信号
 * （PRD-XAGENT-004）。无论哪种，终点都是 AWAITING_PATCH_REVIEW（= HUMAN_REVIEW_REQUIRED），
 * 绝不自动接受。
 */
export type CrossReviewStopReason =
  | 'REVIEWER_PASSED' // 审核方无阻断发现
  /**
   * 审核方**没有给出可用结论**（输出不可解析 / schema 不过 / 用满轮次未提交）。
   *
   * 它必须与 REVIEWER_PASSED 分开：两者的 findings 都是空的，但成因相反 ——
   * 一个是"看过了，没问题"，一个是"没看成"。此前它们折在同一个 stopReason 上，
   * 界面把"没看成"显示为"审核方未发现阻断问题"，正是本项目在
   * external/connector.ts 里花整段注释反对的那类归因错误。
   */
  | 'REVIEWER_INCONCLUSIVE'
  | 'COUNTER_EXHAUSTED' // 用满 2 次审核 + 1 次整改
  | 'NO_DELTA' // 整改后补丁 digest 没变
  | 'NO_PROGRESS' // 阻断项没减少或出现重复指纹
  | 'REVIEWER_UNAVAILABLE' // 只配了一家 key / 审核方 route 不可用
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'ERROR';

/**
 * 模型/代理的**厂商**（模型家族的所有者）。
 *
 * 与 provider 是两个维度：provider 回答"数据送到谁的服务器"，vendor 回答"模型出自谁家"。
 * 中转 provider（openrouter / aihubmix 等）承载多家 vendor 的模型；官方 provider 也可能
 * 托管别家模型（火山方舟上有 DeepSeek 与 Kimi）。异构审核不变式关心的是 vendor ——
 * 同家族模型共享盲区，写和审出自同一家时"第二意见"名不副实。
 */
export type ModelVendor =
  | 'ANTHROPIC'
  | 'OPENAI'
  | 'GOOGLE'
  | 'META'
  | 'MISTRAL'
  | 'XAI'
  | 'DEEPSEEK'
  | 'MOONSHOT'
  | 'ZHIPU'
  | 'ALIBABA'
  | 'BYTEDANCE'
  | 'MINIMAX';

/**
 * 「写的一方」与「审的一方」厂商同异的判定 —— 三态，不是布尔。
 *
 * 无法判定必须是独立状态：折成"异构"是谎报（此前 EXTERNAL_CLI 绑定在推不出实现方
 * 厂商时硬编码 heterogeneous=true，正是这个错），折成"同源"是误拦合法组合。
 * 与 INCONCLUSIVE ≠ PASS 是同一条原则：没证据的方向上不编造结论。
 */
export interface VendorParity {
  readonly kind: 'HETEROGENEOUS' | 'SAME_VENDOR' | 'UNVERIFIABLE';
  /** 人读的证据：双方各归入哪个家族依据什么，或为什么归不出来 */
  readonly detail: string;
}

/**
 * 审核方身份 —— 判别联合，不是字符串前缀约定。
 * 第三种选手类型（比如将来的远程审核方通道）= 新增一个分支，
 * 编译器会点名所有消费处；靠 `external:` 前缀只会长出第三个前缀。
 */
export type CrossReviewerIdentity =
  | { readonly kind: 'MODEL_API'; readonly profileId: string }
  | { readonly kind: 'EXTERNAL_CLI'; readonly connectorId: string };

/**
 * 旧字段 reviewerProfileId / 轮次 reviewerResolutionId 的派生规则。
 * `external:` 前缀约定只允许在这一处存在 —— 它已经降级为展示/追溯字符串，
 * 判定一律走 CrossReviewerIdentity 的判别分支。
 */
export function legacyReviewerProfileId(id: CrossReviewerIdentity): string {
  switch (id.kind) {
    case 'MODEL_API':
      return id.profileId;
    case 'EXTERNAL_CLI':
      return `external:${id.connectorId}`;
  }
}

/**
 * 整个交叉审核过程的聚合记录，挂在 Run 上、进 state.json。
 *
 * counter 是"任务级聚合"：换窗口、换模型、恢复 session 都不能重置它
 * （PRD-XAGENT-004）。
 */
export interface CrossReviewRecord {
  readonly enabled: boolean;
  /** 遗留展示字段，由 reviewerIdentity 经 legacyReviewerProfileId 派生；判定不要用它 */
  readonly reviewerProfileId: string;
  /** 审核方身份（判别联合）。可选：旧持久化记录只有 reviewerProfileId 字符串 */
  readonly reviewerIdentity?: CrossReviewerIdentity;
  /**
   * true 仅表示**已证明**写审双方厂商互异。无法判定时必须为 false，
   * 且 vendorParity.kind = 'UNVERIFIABLE' —— 不许把"不知道"写成"已异构"。
   */
  readonly heterogeneous: boolean;
  /** 厂商同异三态判定与证据。可选：旧持久化记录只有 heterogeneous 布尔 */
  readonly vendorParity?: VendorParity;
  readonly rounds: readonly CrossReviewRound[];
  /** 已消耗的 reviewer invocation 次数。累计值：跨用户续期只增不清 */
  readonly reviewerInvocations: number;
  /** 已消耗的 remediation 次数。累计值：跨用户续期只增不清 */
  readonly remediations: number;
  readonly findingDispositions?: readonly {
    readonly fingerprint: Digest;
    readonly disposition: CollaborationFindingRef['disposition'];
    readonly reviewId: string;
    /** USER_ACCEPTED 时必有；旧记录与模型处置为空。 */
    readonly reason?: string;
    /** USER_ACCEPTED 绑定用户当时实际看到的补丁，防止理由漂到后续 patch。 */
    readonly patchDigest?: Digest;
  }[];
  /**
   * 用户显式授权的续期次数。防死循环的闸门：自动轮次每循环硬上限
   * （CROSS_REVIEW_LIMITS），跨循环只能由人推进 —— 平台绝不自己"再试一次"。
   * PRD-XAGENT-004 的「counter 不重置」指平台不得自动重置；
   * 这里每一次续期都是一条带授权事件的用户决定，且累计数如实保留。
   * 可选：旧记录没有此字段。
   */
  readonly userContinuations?: number;
  readonly stopReason: CrossReviewStopReason | null;
  readonly startedAt: Iso8601;
  readonly finishedAt: Iso8601 | null;
}

/** 交叉审核的收敛硬上限 —— 不可放宽（PRD-XAGENT-004） */
export const CROSS_REVIEW_LIMITS = {
  maxReviewerInvocations: 2,
  maxRemediations: 1,
} as const;

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
  /** 第二个模型对已封存补丁的只读交叉审核（PRD-XAGENT-003） */
  | 'CROSS_REVIEW'
  | 'COMPACTION'
  | 'TITLE_SUMMARY'
  /** 设置页「测试连接」的连通性探针 —— 不属于任何 Run，但同样带真实凭据出站，
   * 因此同样要产出 ModelEgressManifest（没有"辅助调用免记账"的旁路）。 */
  | 'CONNECTIVITY_TEST';

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
  /**
   * 当前**实际生效**的环境变量名（source 为 ENV 时）；否则是第一个候选。
   *
   * 以前无条件取 `d.env[0]`，而 provider 常有别名（zhipu 有 ZHIPU_API_KEY 与
   * ZHIPUAI_API_KEY）。只设了第二个时，界面会点名第一个 —— 用户照着去 unset
   * 那个变量，什么也不会改变。
   */
  readonly credentialEnvVar: string;
  /** 该 provider 认得的**全部**环境变量名。"没有变量能接手"这句话必须把它们都列出来。 */
  readonly credentialEnvVars: readonly string[];
  readonly credentialSource: CredentialSource;
  /**
   * 删掉应用内凭据之后会接手的来源。
   *
   * 这是「删除」按钮唯一真正重要的事实：掉到 `ENV`（还能用，但换成另一把 key ——
   * 可能是另一个账号、另一份账单）还是掉到 `NONE`（这个 provider 直接不可用）。
   * 不给这个字段，界面就只能让用户点下去才知道结果。
   */
  readonly fallbackSource: 'ENV' | 'NONE';
  readonly fallbackEnvVar: string | null;
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

/**
 * 请求相对"离开本机"处在什么状态。这是重试安全性的判据来源：
 * 只有 NOT_SENT 的网络失败才可以重发（TD model-invocation §4 的 BEFORE_BYTES）；
 * SENT_OUTCOME_UNKNOWN（发出去了但结局不明）默认禁止重发 —— 重发可能重复执行、重复计费。
 */
export type ModelSendState = 'NOT_SENT' | 'SENT_OUTCOME_UNKNOWN' | 'RESPONDED';

/**
 * 模型这一轮为什么停下来 —— 由各家 adapter 从供应商原生 finish/stop reason 归一化而来。
 *
 * 住在 shared 而不是 `core/model` 是因为它一旦落进出站账本就是**记账词汇**，与上面的
 * `ModelSendState`、`ModelInvocationPurpose` 同类；shared 不能反向依赖 core。
 *
 * `OTHER` 是两家 mapper 的 default 分支（Anthropic 的 refusal / pause_turn、OpenAI 的
 * content_filter、流意外结束都落这里）。它**不是默认成功** —— 见
 * `stopReasonAllowsToolExecution`：只有 END_TURN / TOOL_USE 允许据此执行工具。
 */
export type StopReason = 'TOOL_USE' | 'END_TURN' | 'MAX_TOKENS' | 'OTHER';

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
  /**
   * 请求是否离开过本机。sent=false 有两种来源，靠 blockReason 区分：
   * 出站前置检查拦下的（blockReason 非空）和连接都没建起来的（blockReason 为空、
   * errorKind 非空、sendState=NOT_SENT）。后者以前被如实性更差的 `sent: true` 顶着。
   */
  readonly sent: boolean;
  readonly blockReason: string | null;
  readonly contextFileRefs: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * 输入 token 的**计费构成**:命中前缀缓存的部分。字段缺失或 null 都读作"未回报",
   * 都不等于 0 —— 历史记录里没有这两个字段是正常的(它们晚于那些记录出现)。
   */
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly requestedAt: Iso8601;
  readonly settledAt: Iso8601 | null;
  readonly errorKind: string | null;
  /** 第几次发送尝试（1-based）。有界同 route 重试的每次尝试各留一条 manifest，不覆盖 */
  readonly sendAttempt?: number;
  readonly sendState?: ModelSendState | null;
  /**
   * 模型这一轮的结束原因。**只有拿到响应的 manifest 才填** —— 被阻断的、失败的、
   * 退避途中取消的那些根本没有响应可报，留空才是诚实的。
   *
   * 字段缺失读作"当时未记录"（它晚于历史记录出现），不解释成 END_TURN，也不解释成截断。
   * 单列它的理由：没有这个字段，一次被截断的调用和一次干净的 END_TURN 在 egress.jsonl 里
   * 长得一模一样，跨 Run 证据聚合就数不出截断发生过。
   */
  readonly stopReason?: StopReason | null;
}

// ---------------------------------------------------------------------------
// 数据出站披露与同意（PRD-DATA-001 的原型子集）
// ---------------------------------------------------------------------------

/**
 * 一次任务会把哪些类别的数据送出本机。
 * 只分类别，不列具体内容 —— 具体内容在每次出站的 ModelEgressManifest 里逐笔可查。
 */
export type EgressDataClass =
  /** 任务描述、验收条件、用户填写的命令与路径 */
  | 'TASK_TEXT'
  /** 仓库快照里被模型读取的文件片段（fs_read / fs_grep 结果回填进对话） */
  | 'REPOSITORY_SNAPSHOT_EXCERPTS'
  /** 构建/测试/自定义命令的输出（stdout/stderr 预览） */
  | 'COMMAND_OUTPUT'
  /** 封存后的补丁 diff（交叉审核方会收到） */
  | 'PATCH_DIFF'
  /** 审核方的发现（整改时回给实现方） */
  | 'REVIEW_FINDINGS'
  /** 用户从只读观察面明确交接给任务的会话片段 */
  | 'OBSERVED_SESSION_HANDOFF'
  /** 外部 CLI 当作者时，它在一次性副本里可读取**整个仓库**并自行决定送什么给其供应商 */
  | 'REPOSITORY_FULL_COPY_VIA_CLI';

export type CollaborationRole = 'PLANNER' | 'IMPLEMENTER' | 'REVIEWER';

export type CollaborationExecutionKind = 'MODEL_API' | 'MANAGED_ENGINE';

/** 三个职责分别冻结；缺少该对象的历史任务继续沿用旧单路由语义。 */
export interface CollaborationRoleBinding {
  readonly role: CollaborationRole;
  readonly executionKind: CollaborationExecutionKind;
  readonly profileId: string | null;
  readonly connectorId: string | null;
  readonly identityDigest: Digest;
  readonly label: string;
}

export type CollaborationMode = 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
export type CollaborationPhase =
  | 'IMPLEMENT'
  | 'SELF_FIX'
  | 'FIRST_REVIEW'
  | 'REMEDIATE'
  | 'SECOND_REVIEW'
  | 'HUMAN_REVIEW';

export interface CollaborationFindingRef {
  readonly findingId: string;
  readonly fingerprint: Digest;
  readonly reviewId: string;
  readonly blocking: boolean;
  readonly evidenceRefs: readonly string[];
  readonly disposition: 'OPEN' | 'REMEDIATED_PENDING_REVIEW' | 'RESOLVED' | 'USER_ACCEPTED';
}

/**
 * Core 持有的阶段交接工件。正文只包含下一角色所需的最小上下文；聊天历史和工具权限
 * 不随角色继承。digest 由不含自身的规范化 payload 计算。
 */
export interface CollaborationHandoff {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly cycleId: string;
  readonly fromRole: CollaborationRole;
  readonly toRole: CollaborationRole | 'USER';
  readonly nextPhase: CollaborationPhase;
  readonly plan: { readonly planId: string; readonly revision: number; readonly digest: Digest };
  readonly snapshotId: string;
  readonly baseTreeDigest: Digest;
  readonly generation: number;
  readonly treeDigest: Digest;
  readonly roleBindingDigest: Digest;
  readonly patch: { readonly patchId: string; readonly digest: Digest } | null;
  readonly changedPaths: readonly string[];
  readonly verificationIds: readonly string[];
  readonly verificationInputDigest: Digest | null;
  readonly verificationEligible: boolean;
  readonly findings: readonly CollaborationFindingRef[];
  readonly context: {
    readonly goal: string;
    readonly acceptance: readonly string[];
    readonly allowedPaths: readonly string[];
    readonly planSummary: string;
    readonly provenance: readonly string[];
  };
  readonly disclosureDigest: Digest;
  readonly recipientIdentityDigest: Digest;
  readonly dataClasses: readonly EgressDataClass[];
  readonly counts: {
    readonly included: number;
    readonly excluded: number;
    readonly truncated: number;
    readonly reasons: readonly string[];
  };
  readonly budget: {
    readonly modelTurnsRemaining: number;
    readonly toolCallsRemaining: number;
    readonly reviewerInvocations: number;
    readonly remediations: number;
  };
  readonly createdAt: Iso8601;
  readonly expiresAt: Iso8601;
  readonly coreEpoch: number;
  readonly digest: Digest;
}

export interface CollaborationHandoffDecision {
  readonly decisionId: string;
  readonly handoffId: string;
  readonly handoffDigest: Digest;
  readonly action: 'CONTINUE' | 'PAUSE' | 'CANCEL';
  readonly decidedAt: Iso8601;
}

export interface EgressDestination {
  readonly role: 'PLANNER' | 'IMPLEMENTER' | 'REVIEWER' | 'AUTHOR';
  /** MODEL_API：RepoPilot 自己经 ModelGateway 出站；EXTERNAL_CLI：本机外部 CLI 自行出站 */
  readonly channel: 'MODEL_API' | 'EXTERNAL_CLI';
  readonly label: string;
  readonly providerId: string;
  /** MODEL_API 有精确 origin；EXTERNAL_CLI 的实际端点由该 CLI 决定，这里写 null 并在 UI 说明 */
  readonly origin: string | null;
  readonly isRelay: boolean;
  readonly modelId: string | null;
  /** 为 MODEL_API 记录冻结路由 digest，preflight 时对得上才放行 */
  readonly resolutionDigest: string | null;
  readonly dataClasses: readonly EgressDataClass[];
}

/**
 * 原型**不知道**各供应商的保留/训练/地域政策 —— 所以不编一个，显式写 UNKNOWN。
 * 这比"默认对方不训练"诚实；PRD 要求 unknown 字段必须出现在披露里而不是被省略。
 */
export interface EgressPolicyKnowledge {
  readonly retention: 'UNKNOWN';
  readonly training: 'UNKNOWN';
  readonly region: 'UNKNOWN';
}

/**
 * 第一笔模型出站前给用户看的披露。digest 覆盖全部字段；task.create 必须带回
 * 同一个 digest，Core 重算比对 —— 用户同意的是**这一份**，不是"同意出站"这个动作。
 */
export interface DataEgressDisclosure {
  /** v3：新增 handoffDigest，并把观察会话交接列为独立数据类别。 */
  readonly disclosureVersion: 3;
  readonly snapshotId: string;
  readonly snapshotFileCount: number;
  readonly destinations: readonly EgressDestination[];
  /**
   * 写审双方的厂商同异判定（无审核方时为 null）。
   * TD §9.14 要求"若供应商相同必须显式披露非异构审核"——判定属于披露的一部分，
   * 用户点头之前就该看见，而不是任务创建之后才在事件流里出现。
   */
  readonly crossReviewParity: VendorParity | null;
  readonly handoffDigest: Digest | null;
  readonly policy: EgressPolicyKnowledge;
  readonly digest: Digest;
}

/** 用户在 task.create 时给出的同意；只记 digest，不记 actor 可识别信息 */
export interface DataEgressConsent {
  readonly consentId: string;
  readonly disclosureDigest: Digest;
  /** 允许出站的冻结路由 digest（实现方 + 审核方）；外部 CLI 不经 ModelGateway，不在此列 */
  readonly resolutionDigests: readonly string[];
  readonly acceptedAt: Iso8601;
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
