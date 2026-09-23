/**
 * 用户工作位的版本化白名单通道。它只控制 RepoPilot 自己创建的引擎会话；既有 Desktop
 * 会话继续留在只读 observer 通道，避免把 resume/fork 误报成 live attach。
 */
export const WORKBENCH_PROTOCOL_VERSION = 4;

export const WORKBENCH_CHANNEL = {
  request: 'repopilot:workbench:request',
  event: 'repopilot:workbench:event',
} as const;

export type WorkbenchVendor = 'CODEX' | 'CLAUDE';
export type CapabilityVerdict = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

export interface WorkbenchCapabilityEvidence {
  readonly verdict: CapabilityVerdict;
  readonly checkedAt: string;
  readonly evidence: readonly string[];
  readonly reason: string | null;
}

export interface WorkbenchEngineCapability {
  readonly vendor: WorkbenchVendor;
  readonly installed: WorkbenchCapabilityEvidence;
  readonly versionSupported: WorkbenchCapabilityEvidence;
  readonly transport: WorkbenchCapabilityEvidence;
  readonly credentialConfigured: WorkbenchCapabilityEvidence;
  readonly authenticated: WorkbenchCapabilityEvidence;
  readonly createSession: WorkbenchCapabilityEvidence;
  readonly readStoredHistory: WorkbenchCapabilityEvidence;
  readonly attachLive: WorkbenchCapabilityEvidence;
  readonly interrupt: WorkbenchCapabilityEvidence;
  readonly readOnlyReviewIsolation: WorkbenchCapabilityEvidence;
  readonly version: string | null;
  readonly source: 'APP_BUNDLE' | 'PATH' | 'CONFIGURED_SDK' | 'NOT_FOUND';
}

export type WorkbenchSessionStatus =
  | 'STARTING'
  | 'READY'
  | 'RUNNING'
  | 'INTERRUPT_REQUESTED'
  | 'DISCONNECTED'
  | 'CLOSED'
  | 'ERROR';

/**
 * Agent 注意力状态（herdr 式 working/blocked/idle/done），与连接生命周期 `WorkbenchSessionStatus`
 * 是**两条独立的轴**：连接可能 READY，但 agent 正 BLOCKED 等你在它自己的工具里应答。
 * 由 Main 从结构化引擎事件派生并随 `session.updated` 下发；Renderer 不自行推断权威态。
 *   - IDLE             会话就绪、无进行中的轮次
 *   - WORKING          有轮次在跑（正在流出 text/activity）
 *   - BLOCKED_APPROVAL 引擎请求权限/批准（Claude SDK 权限回调）；本轮未结束
 *   - BLOCKED_INPUT    引擎等待用户输入/提问；本轮未结束
 *   - DONE             上一轮 COMPLETED，等待用户下一步（herdr 的 done）
 *   - DISCONNECTED     传输断开、结果未对账
 *   - ERROR            轮次 FAILED/UNKNOWN
 */
export type WorkbenchAgentState =
  | 'IDLE'
  | 'WORKING'
  | 'BLOCKED_APPROVAL'
  | 'BLOCKED_INPUT'
  | 'DONE'
  | 'DISCONNECTED'
  | 'ERROR';

export interface WorkbenchSessionView {
  /** Main 生成的不透明句柄；Renderer 不能提交厂商 session/thread id。 */
  readonly handle: string;
  readonly vendor: WorkbenchVendor;
  readonly source: 'MANAGED_NEW_SESSION';
  readonly displayName: string;
  readonly projectId: string | null;
  readonly status: WorkbenchSessionStatus;
  /** herdr 式注意力状态，独立于连接态；见 WorkbenchAgentState。 */
  readonly agentState: WorkbenchAgentState;
  readonly connectionEpoch: number;
  readonly activeRequestId: string | null;
  readonly vendorSessionIdKnown: boolean;
  readonly lastEventSequence: number;
  readonly error: string | null;
}

export type WorkbenchEvent =
  | { readonly kind: 'session.updated'; readonly session: WorkbenchSessionView }
  | {
    readonly kind: 'turn.input_accepted';
    readonly handle: string;
    readonly connectionEpoch: number;
    readonly requestId: string;
    readonly eventSequence: number;
    readonly text: string;
    readonly replayed: boolean;
  }
  | {
    readonly kind: 'turn.text_delta';
    readonly handle: string;
    readonly connectionEpoch: number;
    readonly requestId: string;
    readonly turnId: string;
    readonly sequence: number;
    readonly eventSequence: number;
    readonly text: string;
    readonly replayed: boolean;
  }
  | {
    readonly kind: 'turn.activity';
    readonly handle: string;
    readonly connectionEpoch: number;
    readonly requestId: string;
    readonly turnId: string;
    readonly sequence: number;
    readonly eventSequence: number;
    readonly label: string;
    readonly replayed: boolean;
  }
  | {
    readonly kind: 'turn.waiting';
    readonly handle: string;
    readonly connectionEpoch: number;
    readonly requestId: string;
    readonly turnId: string;
    readonly sequence: number;
    readonly eventSequence: number;
    readonly reason: 'APPROVAL' | 'INPUT';
    readonly label: string;
    readonly replayed: boolean;
  }
  | {
    readonly kind: 'turn.finished';
    readonly handle: string;
    readonly connectionEpoch: number;
    readonly requestId: string;
    readonly turnId: string;
    readonly sequence: number;
    readonly eventSequence: number;
    readonly outcome: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'UNKNOWN';
    readonly reason: string | null;
    readonly replayed: boolean;
  };

export interface WorkbenchRequestMap {
  'workbench.probe': {
    payload: { vendor?: WorkbenchVendor };
    response: { capabilities: readonly WorkbenchEngineCapability[] };
  };
  'workbench.start': {
    payload: { vendor: WorkbenchVendor; projectId?: string };
    response: { session: WorkbenchSessionView };
  };
  'workbench.send': {
    payload: { handle: string; connectionEpoch: number; projectId: string | null; requestId: string; text: string };
    response: { accepted: true; requestId: string };
  };
  'workbench.interrupt': {
    payload: { handle: string; connectionEpoch: number; projectId: string | null; requestId: string };
    response: { requested: true };
  };
  /** 解除显示订阅不停止进程；关闭自己创建的会话必须显式调用 dispose。 */
  'workbench.dispose': {
    payload: { handle: string; connectionEpoch: number; projectId: string | null };
    response: { closed: true };
  };
  'workbench.reconnect': {
    payload: { handle: string; connectionEpoch: number; projectId: string | null; afterEventSequence: number };
    response: { session: WorkbenchSessionView; events: readonly WorkbenchEvent[]; omitted: number };
  };
  'workbench.list': { payload: { projectId: string | null }; response: { sessions: readonly WorkbenchSessionView[] } };
  /**
   * 跨项目的**只读状态汇总**（herdr 侧栏的“哪个 workspace 需要你处理”）。
   * 只回计数，不回 handle 之外的任何内容/事件 —— 跨项目只汇总数字，不串内容（项目隔离不破）。
   * `needsAttention` = BLOCKED_APPROVAL + BLOCKED_INPUT + DONE 之和。
   */
  'workbench.summary': {
    payload: Record<string, never>;
    response: {
      projects: ReadonlyArray<{
        projectId: string | null;
        counts: Record<WorkbenchAgentState, number>;
        needsAttention: number;
      }>;
    };
  };
}

export type WorkbenchMethod = keyof WorkbenchRequestMap;
export type WorkbenchPayload<M extends WorkbenchMethod> = WorkbenchRequestMap[M]['payload'];
export type WorkbenchResponse<M extends WorkbenchMethod> = WorkbenchRequestMap[M]['response'];

export interface WorkbenchErrorShape {
  readonly code:
  | 'BAD_REQUEST'
  | 'CAPABILITY_UNAVAILABLE'
  | 'UNKNOWN_SESSION'
  | 'PROJECT_MISMATCH'
  | 'STALE_EPOCH'
  | 'DUPLICATE_REQUEST'
  | 'SESSION_BUSY'
  | 'OUTCOME_UNKNOWN'
  | 'DATA_EGRESS_BLOCKED'
  | 'INTERNAL';
  readonly message: string;
  readonly detail: string | null;
}

export type WorkbenchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: WorkbenchErrorShape };

export interface WorkbenchBridge {
  readonly protocolVersion: number;
  request<M extends WorkbenchMethod>(
    method: M,
    payload: WorkbenchPayload<M>,
  ): Promise<WorkbenchResult<WorkbenchResponse<M>>>;
  subscribe(handler: (event: WorkbenchEvent) => void): () => void;
}
