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
  CommandApproval,
  ToolRisk,
  DataEgressDisclosure,
  ApprovalDecisionKind,
  ApprovalRequest,
  CrossReviewRecord,
  CollaborationHandoff,
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

/*
 * 0.4.0：信封增加 Core 代次（epoch），逐方法运行时校验开始拒绝未知字段。
 * 旧端不得静默兼容 —— 一个不带 epoch 的旧 Renderer 必须被明确拒绝，
 * 而不是被当成"恰好来自当前这一代"。
 *
 * 0.5.0：新增 `retention.preview`；`model.listProfiles` 增加 credentialStore 状态；
 * `PurgeSummaryView` 增加 `dryRun`、`PurgeItemView.outcome` 增加 `WOULD_DELETE`；
 * `ModelConnectionProfile` 增加 fallbackSource/fallbackEnvVar；
 * `RepositorySnapshot` 增加 untrackedCount；`RunView` 增加 snapshotId；
 * `retention.update` 的取值区间收紧到 Core 实际接受的范围。
 *
 * 0.6.0：新增事件种类 `ASSISTANT_MESSAGE`（模型自己写的话，与平台的 NOTE 分开归属）；
 * `ToolCallView` 增加 `commandResult`（命令终局的判别联合投影，不含正文）。
 * 两者都是加法：旧 Renderer 读不到新字段，但不会因为多出来的东西被拒 ——
 * 事件是 append-only 且禁止回填，所以**旧 Run 的日志里没有 ASSISTANT_MESSAGE**，
 * 它们的模型正文仍会以 NOTE 的形态显示成"平台"。这一层只对新 Run 生效。
 */
/* 0.7.0：观察交接可选字段进入 task.create/egress.disclosure；披露升级为 v3。 */
/* 0.8.0：双角色协作加入独立 planner、协作模式与 AWAITING_HANDOFF 状态投影。 */
export const PROTOCOL_VERSION = '0.8.0';

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
  /** Main 持有的进程状态快照；Renderer 订阅后用它补齐可能早于监听器发出的首个 push。 */
  'core.getStatus': {
    req: Record<string, never>;
    res: {
      status: 'READY' | 'RESTARTING' | 'DOWN';
      detail: string;
      /** 当前 Core 实例代次；后续每个请求都要带回来。 */
      epoch: number;
    };
  };
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
    res: {
      profiles: ModelConnectionProfile[];
      secureStorage: boolean;
      /**
       * 应用内凭据文件的可读性。
       *
       * `ABSENT`（没配过）与 `UNREADABLE`（配过但解不开）必须分开：两者都会让
       * 所有 profile 显示成"没有可用凭据"，但一个要你去填，另一个是你填过的东西
       * 现在读不出来 —— 处置完全不同。
       */
      credentialStore: 'ABSENT' | 'OK' | 'UNREADABLE';
      credentialStoreDetail: string | null;
    };
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
      /** 显式协作任务的独立规划方；缺失时保持旧单路由任务。 */
      plannerModelProfileId?: string;
      collaborationMode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
      goal: string;
      taskClass: TaskClass;
      allowedPaths: string[];
      acceptance: string[];
      /** 可以为空数组：此时以未验证模式运行，终态只能是 ACCEPTED_UNVERIFIED */
      verificationCommandIds: string[];
      /** 用户手填的验证命令；检测不出命令的项目靠这个也能跑完整闭环 */
      customCommands?: Array<{ label: string; argv: string[] }>;
      /**
       * 可选：第二个模型 profile，用于对封存的补丁做只读交叉审核（PRD-XAGENT-003）。
       * 每任务显式勾选。未填 = 不做交叉审核；填了但没配凭据 = 降级为不审核，
       * **绝不**回落到 implementer 的 route（那就成了自审）。
       */
      reviewerModelProfileId?: string;
      /**
       * 可选：用本机的外部编码代理 CLI 当只读审核方（与 reviewerModelProfileId 二选一）。
       * 同厂商会被拒绝 —— 异构是硬不变式。
       */
      reviewerConnectorId?: string;
      /**
       * 可选：用本机的外部编码代理 CLI 当**作者**（在一次性 candidate 目录里改代码，
       * 平台把差异归一化成 MutationPlan 后才进主线）。与审核方必须异构；绑定失败
       * 直接拒绝创建任务，不降级成内部模型去写（那等于换了作者）。
       */
      authorConnectorId?: string;
      /** 观察面冻结的交接正文；两项必须同时出现，Core 会重算摘要。 */
      handoffPayload?: string;
      handoffDigest?: string;
      /**
       * 用户同意的 DataEgressDisclosure digest（PRD-DATA-001）。先用 `egress.disclosure`
       * 取披露、给用户看、用户确认后把 digest 带回；Core 重算比对，缺失/过期一律拒绝创建。
       */
      egressConsentDigest?: string;
      /**
       * 用户逐条批准过的 R2 命令（`command.requestApproval` 签发）。批准绑整条 argv、
       * 有 TTL、一张只能进一个 Run —— 不带就等于没批过，Core 会照常拒绝登记。
       */
      commandApprovalIds?: readonly string[];
    };
    res: { task: TaskSpec; run: RunView };
  };

  /**
   * 只判级、不签发（Slice K）。界面据此决定是"不支持"还是"可以批准"。
   *
   * 与 `requestApproval` 分开是有意的：判级要能在用户每敲一次键时跑，而**签发是一个
   * 手势**。合在一起会让每次输入都在 Core 里堆一张票，那时"一次性"就只是名义上的。
   */
  'command.classify': {
    req: { argv: readonly string[] };
    res: {
      risk: ToolRisk;
      cause: string;
      reason: string;
      /** 能否用一次性精确批准放行；false = 界面不该给"我了解风险"的复选框 */
      approvable: boolean;
      /** 不可批准时给出的下一步（不是道歉，是别的走法） */
      remediation: string | null;
    };
  };

  /**
   * 为一条 R2 命令签发一次性精确批准（Slice K）。
   *
   * 只签"不在已知工具白名单内"的那一类；联网/装依赖/容器、未知 git 子命令、R3/R4
   * 一律 `POLICY_DENIED` —— 界面不该给它们一个"我了解风险"的复选框。
   */
  'command.requestApproval': {
    req: { argv: readonly string[] };
    res: CommandApproval;
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

  /**
   * 当前待决定的补丁；`priorPatches` 是被 REQUEST_CHANGES 掉的历史版本（按发生顺序）。
   * 历史版本自带完整 diff —— 用户否掉的那一版是"为什么不接受"的证据，不能只剩事件里的一行 digest。
   */
  'patch.get': {
    req: { runId: string };
    res: { patch: PatchArtifact | null; priorPatches: readonly PatchArtifact[] };
  };
  /** 交叉审核记录（第二个模型的只读发现）；没启用或没跑过为 null */
  'crossreview.get': { req: { runId: string }; res: { crossReview: CrossReviewRecord | null } };
  /**
   * 跨 Run 证据摘要（PRD §11 里平台事实撑得住的子集）。
   * 只聚合已观察到的事实；算不出的指标在 notComputable 里点名原因。
   */
  'evidence.summary': { req: Record<string, never>; res: { summary: EvidenceSummary } };
  /**
   * 用户显式授权再跑一轮交叉审核循环（2 审 + 1 改）。
   * 只在 AWAITING_PATCH_REVIEW 且上一循环以 COUNTER_EXHAUSTED / NO_PROGRESS /
   * NO_DELTA 收场时可用；恢复态（无活执行器）与时间预算耗尽会被拒。
   * accepted=false 时 reason 说明为什么 —— 拒绝不是异常，是决定。
   */
  /**
   * 可选审核方清单：模型 API profile + 本机检测到的外部 CLI 连接器。
   * 界面据此给建议；不可用的也返回，带上原因，不静默消失。
   */
  'crossreview.reviewers': {
    req: Record<string, never>;
    res: { reviewers: readonly ReviewerOption[] };
  };
  /**
   * 数据出站披露：这次任务会把哪些类别的数据送给谁（官方/中转、精确 origin、模型、
   * 经 ModelGateway 还是本机外部 CLI 自行出站），以及政策 UNKNOWN 字段。
   * 与 task.create 的重算是同一个函数、同一套输入；用户确认的是返回的 digest。
   */
  'egress.disclosure': {
    req: {
      snapshotId: string;
      modelProfileId: string;
      plannerModelProfileId?: string;
      collaborationMode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO';
      reviewerModelProfileId?: string;
      reviewerConnectorId?: string;
      authorConnectorId?: string;
      handoffDigest?: string;
    };
    res: { disclosure: DataEgressDisclosure };
  };
  'crossreview.continue': {
    req: { runId: string };
    res: { run: RunView; accepted: boolean; reason: string | null };
  };
  'collaboration.getHandoff': {
    req: { runId: string };
    res: { handoff: CollaborationHandoff | null };
  };
  'collaboration.continue': {
    req: { runId: string; handoffId: string; handoffDigest: string; decisionId: string };
    res: { run: RunView; accepted: boolean; reason: string | null };
  };
  'collaboration.control': {
    req: { runId: string; mode?: 'MANUAL_HANDOFF' | 'BOUNDED_AUTO'; stopAfterStep?: boolean };
    res: { run: RunView; accepted: boolean; reason: string | null };
  };
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
  /**
   * 清理预演：完整走一遍判定与体积统计，但一个字节都不删。
   *
   * 存在的理由很简单 —— 在此之前，想知道「立即清理」会删掉什么的唯一办法是**真的删一次**。
   * 传入策略即可预演"如果我把保留期改成这样，会删掉什么"，不改变已保存的策略。
   * 返回的 summary 带 `dryRun: true`，条目是 `WOULD_DELETE`，两者都无法被误当成已执行。
   */
  'retention.preview': {
    req: { evidenceDays?: number; workspaceGraceMinutes?: number };
    res: { summary: PurgeSummaryView; policy: RetentionPolicyView };
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
    req: {
      snapshotId: string;
      path: string;
      runId?: string;
      /** null 只代表快照；工作区必须携带最后一次 tree 响应确认的 generation。 */
      expectedGeneration: number | null;
    };
    res: {
      path: string;
      content: string;
      bytes: number;
      truncated: boolean;
      binary: boolean;
      changed: boolean;
      /** 与请求 owner 共同校验，防止内容在 generation/source 变化后被旧预览接收。 */
      source: 'SNAPSHOT' | 'WORKSPACE';
      generation: number | null;
    };
  };

  /**
   * 把补丁交付出去。
   *
   * `SAVE_FILE` / `COPY` 不碰你的仓库；`APPLY_TO_REPO` 会真的写入宿主仓库，
   * 所以它先跑 `git apply --check`，任何冲突都整笔拒绝，不做部分应用。
   *
   * `patchDigest` 是调用方看到的补丁摘要。写宿主仓库这条路径**必须**带上它，
   * 由 Core 侧比对（与 `patch.decide` 同一道校验）—— 「被应用的东西」必须等于
   * 「被审查/接受的东西」。SAVE_FILE / COPY 不写仓库，可以不带。
   */
  'patch.export': {
    req: {
      runId: string;
      patchId: string;
      mode: 'SAVE_FILE' | 'COPY' | 'APPLY_TO_REPO';
      patchDigest?: string;
    };
    res: PatchExportResult;
  };
}

/** 一个可选（或不可选）的审核方 */
export interface ReviewerOption {
  /** 传给 task.create 的值：模型 API 用 profileId，CLI 用 connectorId */
  readonly id: string;
  readonly kind: 'MODEL_API' | 'EXTERNAL_CLI';
  readonly label: string;
  readonly detail: string;
  readonly available: boolean;
  /** 不可用的原因 / 修复建议；可用时为 null */
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// 证据聚合（evidence.summary）—— PRD §11 指标里平台事实撑得住的那个子集
// ---------------------------------------------------------------------------

/**
 * 跨 Run 证据摘要。每个数字都来自平台观察到的事实（账本 / append-only 事件 /
 * 封存记录），**不从模型或审核方的自报计算**（PRD §11.2 交叉审核行的纪律）。
 *
 * 两条结构性约束（PRD §11.1）：
 *   1. 北极星必须与漏斗同时发布 —— 不得只展示接受率而隐藏前置阶段的失败；
 *   2. 算不出来的指标必须点名并给原因（notComputable），而不是从清单里消失。
 */
export interface EvidenceFunnel {
  readonly runsCreated: number;
  readonly plansGenerated: number;
  readonly attemptsStarted: number;
  /** 进入过 EXECUTING 的 Attempt 数 —— 北极星的分母（PRD §11.1） */
  readonly attemptsEnteredExecuting: number;
  readonly patchesSealed: number;
  readonly decisions: { readonly ACCEPT: number; readonly REJECT: number; readonly REQUEST_CHANGES: number };
}

export interface EvidenceNorthStar {
  /** SUCCEEDED：接受 + 验证通过 + 验证输入未被触碰（setStatus 不变式强制） */
  readonly acceptedVerified: number;
  readonly acceptedUnverified: number;
  readonly executingAttempts: number;
  /** 分母为 0 时为 null —— 不写 0% 也不写 100% */
  readonly rate: number | null;
}

export interface EvidenceReviewerGroup {
  /** 展示用 key：legacy reviewerProfileId（模型 profileId / external:connectorId） */
  readonly reviewerKey: string;
  /** 旧持久化记录没有判别联合身份时为 LEGACY_UNKNOWN —— 不做前缀猜测 */
  readonly reviewerKind: 'MODEL_API' | 'EXTERNAL_CLI' | 'LEGACY_UNKNOWN';
  /** 旧记录只有布尔 heterogeneous 时为 LEGACY_BOOLEAN */
  readonly parity: 'HETEROGENEOUS' | 'SAME_VENDOR' | 'UNVERIFIABLE' | 'LEGACY_BOOLEAN';
  readonly runs: number;
  readonly rounds: number;
  /** INCONCLUSIVE 与 PASS 分列 —— "没看成"永远不折进"没问题" */
  readonly verdicts: { readonly PASS: number; readonly CHANGES_REQUESTED: number; readonly INCONCLUSIVE: number };
  readonly findings: number;
  readonly blockingFindings: number;
  readonly remediations: number;
  readonly userContinuations: number;
  /** 同一指纹在多轮重复出现的 Run 数 —— no-progress 的观察信号（指纹是平台算的） */
  readonly runsWithRepeatedFingerprint: number;
  readonly stopReasons: Readonly<Record<string, number>>;
  /** 审后 Run 的现状分布（人工接管之后去了哪）：status 计数 */
  readonly outcomes: Readonly<Record<string, number>>;
}

export interface EvidencePurposeCost {
  readonly manifests: number;
  readonly sent: number;
  /** 出站前被闸门拦下（blockReason 非空） */
  readonly blocked: number;
  /** 连接都没建立（非阻断、未发出） */
  readonly failedBeforeSend: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 已发出但用量未知的清单数 —— 未知就是未知，不折成 0 */
  readonly usageUnknown: number;
}

export interface EvidenceCost {
  readonly ledger: {
    readonly modelTurns: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly unknownUsageTurns: number;
    readonly elapsedMs: number;
  };
  /** 按 ModelInvocationPurpose 拆分（来源 egress.jsonl 逐笔清单；外部 CLI 不经网关，不在此列） */
  readonly byPurpose: Readonly<Record<string, EvidencePurposeCost>>;
  readonly egressLogUnparseableLines: number;
  readonly acceptedRuns: number;
  readonly acceptedAvgInputTokens: number | null;
  readonly acceptedAvgOutputTokens: number | null;
  readonly acceptedAvgElapsedMs: number | null;
  /** 均值样本里带未知用量轮次的 Run 数 —— 均值的可信度声明 */
  readonly acceptedRunsWithUnknownUsage: number;
}

export interface EvidenceNotComputable {
  readonly metric: string;
  readonly reason: string;
  readonly unblocks: string;
}

export interface EvidenceSummary {
  readonly generatedAt: string;
  readonly dataQuality: {
    readonly totalRuns: number;
    readonly intact: number;
    readonly eventsAhead: number;
    readonly damaged: number;
    readonly restored: number;
    /** 被排除出全部聚合的 Run 数（= damaged），排除必须报数 */
    readonly excludedFromMetrics: number;
  };
  readonly funnel: EvidenceFunnel;
  readonly northStar: EvidenceNorthStar;
  readonly outcomes: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byFailureClass: Readonly<Record<string, number>>;
  };
  readonly verification: {
    readonly baseline: { readonly passed: number; readonly failed: number };
    readonly postMutation: { readonly passed: number; readonly failed: number };
    /** verificationInputsTouched 非空的补丁数 —— 这些"验证通过"不构成修复证明 */
    readonly coverageWeakenedPatches: number;
  };
  readonly crossReview: {
    readonly runsWithReview: number;
    readonly groups: readonly EvidenceReviewerGroup[];
  };
  readonly cost: EvidenceCost;
  readonly notComputable: readonly EvidenceNotComputable[];
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
  /** `WOULD_DELETE` 只来自预演；它与 `DELETED` 分开，UI 不可能把两者写成同一句话。 */
  readonly outcome: 'DELETED' | 'WOULD_DELETE' | 'KEPT_REFERENCED' | 'KEPT_NOT_DUE' | 'FAILED';
  readonly bytesFreed: number;
  readonly reason: string | null;
}

export interface PurgeSummaryView {
  /** true = 预演，什么都没删。 */
  readonly dryRun: boolean;
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
  /** Renderer 认为自己正在对话的 Core 代次；`core.getStatus` 之外都必须带。 */
  readonly epoch?: number;
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
    /**
     * 请求带的 Core 代次与当前实例不符：界面所依据的那一代 Core 已经不在了。
     * 与 CORE_UNAVAILABLE 分开，因为处置不同 —— 这个要重新读状态，那个要等进程回来。
     */
    | 'CORE_EPOCH_MISMATCH'
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
  /**
   * 模型正文的实时增量。**易失，不进事件流。**
   *
   * 存在的理由：模型调用是整个流程里最长的一段等待（几十秒），而在它返回之前
   * Core 一条持久事件都不发 —— 界面在这段时间里一个像素都不动。
   *
   * 为什么不落盘：持久事实是那条 `ASSISTANT_MESSAGE` 事件。增量只是"先看一眼"，
   * 流断了、重试了、进程没了，重新打开这个 Run 应该看到同一份记录，
   * 而不是一堆半截文本。所以它不进 JSONL、不进状态快照、不参与证据核对。
   *
   *   delta —— 追加这段文本
   *   reset —— **这一次尝试作废了**（同 route 重试或最终失败）：把已经显示的
   *            增量全部丢掉。少了这一条，界面会把模型没说完的半句话留在那儿。
   */
  | {
      readonly type: 'run.stream';
      readonly runId: string;
      readonly attemptId: string;
      readonly signal:
        | { readonly kind: 'delta'; readonly text: string }
        | { readonly kind: 'reset'; readonly reason: string };
    }
  | {
      readonly type: 'core.status';
      readonly status: 'READY' | 'RESTARTING' | 'DOWN';
      readonly detail: string;
      /** 与 `core.getStatus` 同源的代次；Renderer 据此更新后续请求要带的 epoch。 */
      readonly epoch: number;
    };

// ---------------------------------------------------------------------------
// Preload 暴露给 Renderer 的唯一 API 面
// ---------------------------------------------------------------------------

export interface RepoPilotBridge {
  readonly protocolVersion: string;
  request<M extends RequestMethod>(
    method: M,
    payload: RequestPayload<M>,
    /** Renderer 已知的 Core 代次；不传等同于"我还不知道"，只有握手方法能这样。 */
    epoch?: number,
  ): Promise<IpcResult<ResponsePayload<M>>>;
  subscribe(handler: (event: PushEvent) => void): () => void;
}
