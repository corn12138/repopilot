import { AcpWireTranslator } from './acpWire';
import type { AdapterEvent, ManagedEngineSession } from './adapter';

/**
 * ACP（Agent Client Protocol）v1 的**可驱动会话**。它把 `AcpWireTranslator` 接到一条
 * 传输上，满足 workbench 用的 `ManagedEngineSession` 接口 —— 证明这条接缝真的能驱动一轮，
 * 而不是只能翻一条消息。
 *
 * 现状（见 docs/contracts/acp-agent-client-protocol.md）：`SEED_SEAM_ONLY`。本会话**未注册进
 * 任何 vendor、未接进运行路径**；真实 ACP Agent 端到端尚未验证，全部由确定性假传输覆盖
 * （与 codexAdapter 用 FakeRpc 测、能力真实值仍标 UNKNOWN 是同一标准）。
 *
 * 三条硬不变式在驱动层的落点：
 *   1. 只读隔离：initialize 把 fs(read/write)+terminal 全部 advertise=false，Agent 无权向本客户端
 *      发起读盘/写盘/开终端（宿主只读 #4、权限边界不上移 #6）。
 *   2. 不代答：`session/request_permission` 先呈现 `waiting{APPROVAL}`，再**一律回 cancelled 拒绝**，
 *      结构上永不选 `allow_*` —— 拒绝是强制只读边界，不是"替用户批准"。
 *   3. 结束原因是判别联合：一轮的 `stopReason` 交 `AcpWireTranslator.finish` 映射，
 *      `max_tokens`/未知绝不折成 COMPLETED（#10）。
 */

/** ACP 客户端只会话级协议版本；不接受其它 MAJOR —— 版本不符即断开（见初始化协商）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** 一条入站 JSON-RPC 消息（通知无 id；Agent 发起的请求带 id）。 */
export type AcpInboundMessage = {
    readonly id?: string | number;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
};

/**
 * 传输契约。`JsonRpcProcess` 已能满足 request/notify/subscribe/stop；`respond`/`respondError`
 * 是"能应答 Agent 发起的请求"这条新能力 —— 接真机前需在 JsonRpcProcess 上补对应路径
 * （登记为契约 §6 的前置，本轮不静默跳过）。
 */
export interface AcpTransport {
    request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    notify(method: string, params: Record<string, unknown>): void;
    respond(id: string | number, result: unknown): void;
    respondError(id: string | number, code: number, message: string): void;
    subscribe(listener: (message: AcpInboundMessage) => void): () => void;
    stop(): Promise<void>;
}

/** 本仓 ACP 客户端**故意只读**：不申请 fs/terminal 任何能力。导出以便负向断言。 */
export const CONVERSATION_ONLY_CLIENT_CAPABILITIES = Object.freeze({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
});

type ActiveTurn = {
    readonly requestId: string;
    readonly translator: AcpWireTranslator;
    readonly onEvent: (event: AdapterEvent) => void;
};

/**
 * 打开一个 ACP 会话：完成 initialize 握手 + 版本协商 + session/new。
 * 版本不被支持时抛错（不降级、不猜）。
 */
export async function openAcpSession(
    transport: AcpTransport,
    cwd: string,
): Promise<AcpSession> {
    const init = await transport.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CONVERSATION_ONLY_CLIENT_CAPABILITIES,
        clientInfo: { name: 'RepoPilot', version: '0.0.1' },
    });
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`ACP 版本协商失败：客户端只支持 v${ACP_PROTOCOL_VERSION}，Agent 回了 ${String(init.protocolVersion)}`);
    }
    const created = await transport.request('session/new', { cwd, mcpServers: [] });
    if (typeof created.sessionId !== 'string') {
        throw new Error('session/new 响应缺少 sessionId');
    }
    return new AcpSession(transport, created.sessionId);
}

export class AcpSession implements ManagedEngineSession {
    readonly vendorSessionId: string;
    private active: ActiveTurn | null = null;
    private unsubscribe: (() => void) | null = null;
    private disposed = false;

    constructor(private readonly transport: AcpTransport, sessionId: string) {
        this.vendorSessionId = sessionId;
    }

    async send({ requestId, text, onEvent }: {
        readonly requestId: string;
        readonly text: string;
        readonly onEvent: (event: AdapterEvent) => void;
    }): Promise<void> {
        if (this.disposed) throw new Error('session disposed');
        if (this.active) throw new Error('turn already active');
        const translator = new AcpWireTranslator(requestId);
        this.active = { requestId, translator, onEvent };
        this.unsubscribe ??= this.transport.subscribe((message) => this.handleInbound(message));
        const response = await this.transport.request('session/prompt', {
            sessionId: this.vendorSessionId,
            prompt: [{ type: 'text', text }],
        });
        // 一轮结束：把 stopReason 交翻译器映射成 finished（判别联合，未知不折成成功）。
        if (this.active?.requestId === requestId) {
            onEvent(translator.finish(response.stopReason));
            this.finishTurn();
        }
    }

    async interrupt(_requestId: string): Promise<void> {
        // 取消：先发 session/cancel；对未决的 request_permission 回 cancelled（规范 MUST）。
        this.transport.notify('session/cancel', { sessionId: this.vendorSessionId });
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.active = null;
        await this.transport.stop();
    }

    private finishTurn(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.active = null;
    }

    private handleInbound(message: AcpInboundMessage): void {
        const active = this.active;
        if (!active || typeof message.method !== 'string') return; // 无 method 的是我方请求的响应，由传输内部处理
        const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

        if (message.method === 'session/update') {
            for (const event of active.translator.handle({ method: message.method, params })) active.onEvent(event);
            return;
        }

        // 以下都是 Agent 发起的**请求**（带 id），必须应答，否则对端挂起。
        if (message.id !== undefined) {
            if (message.method === 'session/request_permission') {
                // 先呈现（只读边界内不代答，但让人看见"谁在等批"），再一律拒绝。
                for (const event of active.translator.handle({ method: message.method, params })) active.onEvent(event);
                this.transport.respond(message.id, { outcome: { outcome: 'cancelled' } });
                return;
            }
            // 我们没 advertise elicitation/fs/terminal —— 收到即越界：如实报数并回 Method not found，绝不臆造应答。
            active.translator.handle({ method: message.method, params });
            this.transport.respondError(message.id, -32601, `ACP 客户端未 advertise 该能力：${message.method}`);
            return;
        }

        // 无 id 且非 session/update 的通知：交给翻译器统一计入省略。
        active.translator.handle({ method: message.method, params });
    }
}
