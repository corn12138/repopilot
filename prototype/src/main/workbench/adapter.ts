import type {
  WorkbenchEngineCapability,
  WorkbenchEvent,
  WorkbenchSessionView,
  WorkbenchVendor,
} from '@shared/workbenchProtocol';

export type AdapterEvent =
  | { readonly kind: 'text'; readonly turnId: string; readonly sequence: number; readonly text: string }
  | { readonly kind: 'activity'; readonly turnId: string; readonly sequence: number; readonly label: string }
  | {
    /**
     * 引擎在等待用户处理（herdr 的 blocked）：请求权限/批准，或等待输入/提问。
     * 本轮**未结束**（与 finished 区分）；service 据此把 agentState 置 BLOCKED_*，不清 activeRequestId。
     * 诚实边界：两家受管会话当前都在刻意隔离下（Claude conversation-only tools=[]、
     * Codex approvalPolicy=never+read-only），真实引擎不会产出该信号；映射已接线并由
     * 确定性替身测试覆盖，真实产出待引擎模式验收（见 claudeAdapter/codexAdapter 注释）。
     */
    readonly kind: 'waiting';
    readonly turnId: string;
    readonly sequence: number;
    readonly reason: 'APPROVAL' | 'INPUT';
    readonly label: string;
  }
  | {
    readonly kind: 'finished';
    readonly turnId: string;
    readonly sequence: number;
    readonly outcome: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'UNKNOWN';
    readonly reason: string | null;
  }
  | { readonly kind: 'disconnected'; readonly turnId: string; readonly sequence: number; readonly reason: string };

export interface ManagedEngineSession {
  readonly vendorSessionId: string;
  send(input: {
    readonly requestId: string;
    readonly text: string;
    readonly onEvent: (event: AdapterEvent) => void;
  }): Promise<void>;
  interrupt(requestId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkbenchAgentAdapter {
  readonly vendor: WorkbenchVendor;
  probe(): Promise<WorkbenchEngineCapability>;
  start(input: { readonly projectId: string | null }): Promise<ManagedEngineSession>;
}

export interface WorkbenchSessionRecord {
  view: WorkbenchSessionView;
  readonly adapter: WorkbenchAgentAdapter;
  readonly session: ManagedEngineSession;
  readonly seenRequests: Set<string>;
  readonly sequenceByRequest: Map<string, number>;
  readonly eventBuffer: Array<Exclude<WorkbenchEvent, { readonly kind: 'session.updated' }>>;
  nextEventSequence: number;
  omittedEventCount: number;
}
