/**
 * 观察面板的旁路通道契约（PRD-WKB-002 的可丢弃 spike 子集，不是合同实现）。
 *
 * 为什么不进 `protocol.ts`：TD-DEC-022 (a) —— 工位/观察是**用户能力面**，
 * 不进 authority 链。这条通道 Renderer ⇄ Main 直连，从不经过 Core：
 * 没有 Core 代次（Core 重启不影响观察）、没有 Run/Approval 语义、
 * 产出全部是 volatile 投影（先例：`run.stream` 易失不持久）。
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

export const OBSERVER_PROTOCOL_VERSION = 1;

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

/** 会话条目。sessionId 是不透明句柄（vendor:basename），不携带宿主路径 */
export interface ObserverSessionEntry {
  readonly sessionId: string;
  readonly vendor: JournalVendor;
  /** 展示名（文件 basename 去扩展名），不是宿主路径 */
  readonly label: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

/** 会话发现的扫描账目 —— 省略要报数：扫了多少、按什么被跳过 */
export interface ObserverSweepCounts {
  readonly claudeMatched: number;
  readonly claudeSkippedByCap: number;
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
  /**
   * FORMAT_UNKNOWN = 记录违反了已提交字段快照基线的必现键（ASM-027 的降级语义）：
   * 此时 lines 为空 —— 错读比不读更糟，只报计数与违规键名。
   */
  readonly status: 'OK' | 'FORMAT_UNKNOWN';
  /** 违规明细（键名级，最多 8 条），只在 FORMAT_UNKNOWN 时非空 */
  readonly breaking: readonly string[];
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
}

export interface ObserverStateSnapshot {
  /** 已授权项目的展示路径（home 缩写为 ~）；未授权为 null */
  readonly granted: string | null;
  readonly watching: string | null;
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
  'observer.watch': { payload: { sessionId: string }; response: { ok: true } };
  'observer.unwatch': { payload: Record<string, never>; response: { ok: true } };
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
