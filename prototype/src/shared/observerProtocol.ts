/**
 * 观察面板的旁路通道契约（PRD-WKB-002/003/004 的产品种子实现）。
 *
 * 为什么不进 `protocol.ts`：TD-DEC-022 (a) —— 工位/观察是**用户能力面**，
 * 不进 authority 链。这条通道 Renderer ⇄ Main 直连，从不经过 Core：
 * 没有 Core 代次（Core 重启不影响观察）、没有 Run/Approval 语义、
 * 日志投影全部 volatile；只有人明确交接且 Core 复核 digest 后，交接内容才进入任务链。
 *
 * 信任边界（DEC-020，四条缺一不可）：
 *   - **显式授权**：启用观察 = 一次原生目录选择手势（与 `project.pick` 同构）。
 *     Renderer 递不了路径 —— 宿主绝对路径永不投影到 Renderer（domain.ts ProjectRef），
 *     所以授权只能由 OS 手势构成，Main 从对话框拿路径。
 *   - **只读**：Main 只 lstat/read，不写、不移、不锁任何日志文件。
 *   - **零出站**：投影只进 Renderer 本地渲染；不进模型上下文、不进遥测、不进证据。
 *   - **可撤销**：disable 即停止读取并清除全部投影缓存。
 *
 * 本文件刻意零依赖（不引 zod）：Preload 会打包它拿 channel 常量，
 * 校验 schema 放在 main/observer/observerSchema.ts，不进 Preload 包。
 */

export const OBSERVER_PROTOCOL_VERSION = 4;

/** 独立通道名 —— 刻意不与 `repopilot:request/event`（Core 契约）共用 */
export const OBSERVER_CHANNEL = {
  request: 'repopilot:observer:request',
  event: 'repopilot:observer:event',
} as const;

/**
 * 日志厂商标识。定义在 shared 而不是 main/observer/journalShape：
 * tsconfig.web 不含 src/main，shared 反向引用 main 会让 web 侧编译失败；
 * journalShape 从这里取用，方向永远是 main → shared。
 */
export type JournalVendor = 'CLAUDE_JOURNAL' | 'CODEX_ROLLOUT';

/** 会话从哪里启动。没有明确元数据或元数据互相冲突时必须落 UNKNOWN。 */
export type ObserverSessionSource =
  | 'USER_CLI'
  | 'DESKTOP_LOCAL_AGENT'
  | 'SPAWNED_BY_US'
  | 'UNKNOWN';

export type ObserverCompletionState = 'RUNNING' | 'READY_TO_HANDOFF' | 'UNKNOWN';

export interface ObserverCompletion {
  readonly state: ObserverCompletionState;
  /** 只记录机器字段，不采用模型正文里的“已完成”陈述。 */
  readonly evidence: readonly string[];
}

/** 会话条目。sessionId 是不透明句柄（vendor:basename），不携带宿主路径 */
export interface ObserverSessionEntry {
  readonly sessionId: string;
  readonly vendor: JournalVendor;
  /** 展示名（文件 basename 去扩展名），不是宿主路径 */
  readonly label: string;
  /** 本地显示名的依据；永不调用供应商改名接口。旧条目没有该字段时按 FILE_FALLBACK 展示。 */
  readonly labelSource?: 'LOCAL_ALIAS' | 'OFFICIAL_TITLE' | 'FIRST_USER_REQUEST' | 'UNNAMED' | 'FILE_FALLBACK';
  readonly labelOmissions?: {
    readonly recordsScanned: number;
    /** 命中记录上限时只能证明至少还省略一条；不能把未知总数伪装成精确值。 */
    readonly recordsOmittedAtLeast: number;
    readonly bytesOmitted: number;
    /** 最终标题因 72 字符展示上限删掉的 Unicode 字符数。 */
    readonly labelCharactersOmitted: number;
    readonly reason: string | null;
  };
  /** 产生当前 READY_TO_HANDOFF 的稳定机器事件身份；后续仅 mtime 变化不会改变。 */
  readonly attentionEventId?: string | null;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly source: ObserverSessionSource;
  /** 用于解释来源判定的有限元数据，不含会话正文或宿主路径。 */
  readonly sourceEvidence: readonly string[];
  /** 会话列表与等待队列共享同一份机器字段判定；只能用于导航提示。 */
  readonly completion: ObserverCompletion;
}

/** 会话发现的扫描账目 —— 省略要报数：扫了多少、按什么被跳过 */
export interface ObserverSweepCounts {
  readonly claudeMatched: number;
  readonly claudeSkippedByCap: number;
  /** 项目目录下更深层的 .jsonl（subagents/ 子代理记录、各会话的 journal.jsonl）—— 不列为会话，但报数 */
  readonly claudeNestedSkipped: number;
  readonly codexScanned: number;
  readonly codexMatched: number;
  readonly codexSkippedByCap: number;
  readonly codexUnreadable: number;
}

export interface ObserverProjectionLine {
  readonly seq: number;
  /** user / assistant / message / 或 `[标签]` 型种类名 */
  readonly kind: string;
  readonly text: string;
  /** 连续同类标签行折叠后的条数（≥1）；文本行恒为 1 */
  readonly collapsed: number;
}

/**
 * 一个被观察会话的 volatile 投影。整份替换式推送（不做增量 diff）——
 * 数据量有界（行数/字节都封顶），换简单正确。
 */
export interface ObserverProjection {
  readonly sessionId: string;
  readonly vendor: JournalVendor;
  readonly source: ObserverSessionSource;
  readonly sourceEvidence: readonly string[];
  /**
   * FORMAT_UNKNOWN = 记录违反了**面板消费键契约**（type/message/content/payload 的形状），
   * 即面板真的读不了：此时 lines 为空 —— 错读比不读更糟，只报计数与违规明细。
   * 与已提交字段快照基线的出入**不**触发降级（2026-09-05 实测：基线 required 层会因
   * 样本过拟合误报），只进 driftNotes 作提示。
   */
  readonly status: 'OK' | 'FORMAT_UNKNOWN';
  /** 消费契约违规明细（最多 8 条），只在 FORMAT_UNKNOWN 时非空 */
  readonly breaking: readonly string[];
  /** 与字段快照基线的出入（`top:type.key` / `payload:type.key`，最多 8 条）；仅提示 */
  readonly driftNotes: readonly string[];
  readonly lines: readonly ObserverProjectionLine[];
  readonly counts: {
    readonly records: number;
    readonly shownLines: number;
    readonly omittedLines: number;
    readonly unparseableLines: number;
    readonly blankLines: number;
    /** 文件超过读取上限时跳过的头部字节数 */
    readonly headBytesSkipped: number;
  };
  readonly fileUpdatedAt: string;
  /** 启发式（mtime 距今 < 20s）。只用于导航徽标，不驱动任何判定 */
  readonly active: boolean;
  readonly completion: ObserverCompletion;
}

/**
 * 人工交接前的只读快照。payload 与 digest 一起进入 task.create；Core 会重算并拒绝不一致。
 * 这份对象只活在 Main/Renderer 内存里，未点击交接时不会进入 Run 或模型上下文。
 */
export interface ObserverHandoffArtifact {
  readonly handoffId: string;
  readonly sessionId: string;
  readonly projectDisplayPath: string;
  readonly vendor: JournalVendor;
  readonly source: ObserverSessionSource;
  readonly sourceEvidence: readonly string[];
  readonly completion: ObserverCompletion;
  readonly sourceUpdatedAt: string;
  readonly preparedAt: string;
  readonly payload: string;
  readonly digest: string;
  readonly includedLines: number;
  readonly omittedLines: number;
  readonly suggestedGoal: string;
}

/**
 * 同屏镜像上限。双镜像是"甲乙对照"的最小形态；也是 IO 上限 —— 每个镜像一份轮询。
 * 放在 shared：Renderer 要用它写"最多同屏 N 个"的文案，Main 用它做槛。
 */
export const OBSERVER_MAX_MIRRORS = 2;

export interface ObserverStateSnapshot {
  /** 已授权项目的展示路径（home 缩写为 ~）；未授权为 null */
  readonly granted: string | null;
  /** 正在监视的会话，**有序**（先选的在前 = 左槽）；满槛再选会顶掉最早的一个 */
  readonly watching: readonly string[];
}

// ---- 请求 / 响应 ----

export interface ObserverRequestMap {
  'observer.status': { payload: Record<string, never>; response: ObserverStateSnapshot };
  /** 打开原生目录选择器完成授权；用户取消时 granted=null 且不建立任何状态 */
  'observer.enable': {
    payload: Record<string, never>;
    response:
      | { granted: string; sessions: readonly ObserverSessionEntry[]; counts: ObserverSweepCounts }
      | { granted: null };
  };
  'observer.disable': { payload: Record<string, never>; response: { ok: true } };
  'observer.listSessions': {
    payload: Record<string, never>;
    response: { sessions: readonly ObserverSessionEntry[]; counts: ObserverSweepCounts };
  };
  /** 加入一个镜像槽；已满则顶掉最早的；状态推送随后到达（含新的有序 watching） */
  'observer.watch': { payload: { sessionId: string }; response: { ok: true } };
  /** 不带 sessionId = 全部停止（关面板时用）；带 = 只关那一个镜像 */
  'observer.unwatch': { payload: { sessionId?: string }; response: { ok: true } };
  /** 只接受已发现会话；重新读取文件并用机器结束字段判定，不能拿陈旧投影交接。 */
  'observer.prepareHandoff': {
    payload: { sessionId: string };
    response: { artifact: ObserverHandoffArtifact };
  };
}

export type ObserverMethod = keyof ObserverRequestMap;
export type ObserverPayload<M extends ObserverMethod> = ObserverRequestMap[M]['payload'];
export type ObserverResponse<M extends ObserverMethod> = ObserverRequestMap[M]['response'];

export interface ObserverErrorShape {
  readonly code:
    | 'NOT_GRANTED'
    | 'UNKNOWN_SESSION'
    | 'BAD_REQUEST'
    | 'POLICY_DENIED'
    | 'INTERNAL';
  readonly message: string;
  readonly detail: string | null;
}

export type ObserverResult<T> = { ok: true; data: T } | { ok: false; error: ObserverErrorShape };

// ---- 推送 ----

export type ObserverPushEvent =
  | { readonly kind: 'observer.projection'; readonly projection: ObserverProjection }
  | { readonly kind: 'observer.state'; readonly state: ObserverStateSnapshot };

// ---- Preload 桥 ----

export interface ObserverBridge {
  readonly protocolVersion: number;
  request<M extends ObserverMethod>(
    method: M,
    payload: ObserverPayload<M>,
  ): Promise<ObserverResult<ObserverResponse<M>>>;
  subscribe(handler: (event: ObserverPushEvent) => void): () => void;
}
