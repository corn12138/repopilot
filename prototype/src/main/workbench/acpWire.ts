import type { AdapterEvent } from './adapter';

/**
 * ACP（Zed Agent Client Protocol）v1 入站消息 → 本仓内部 `AdapterEvent` 的**纯翻译接缝**。
 *
 * 定位见 docs/contracts/acp-agent-client-protocol.md：这是 `SEED_SEAM_ONLY`，
 * 不重接 codexAdapter/claudeAdapter 的活线方言。本模块**不 spawn、不读写盘、
 * 不构造任何 JSON-RPC 响应** —— 结构上就是一条"只能呈现、不能代答/放行"的单向翻译。
 *
 * 三条硬边界（都由 acpWire.test.ts 负向钉住）：
 *   1. 会话自述的 `end_turn` 只投影成"本轮结束"，永远投影不出 `SUCCEEDED`（不变式 #1）；
 *   2. `session/request_permission` 只发 `waiting` 呈现，绝不生成批准响应（不变式 #1/#6）；
 *   3. 任何未知/未支持项**计数并报因**，不静默吞、不 fold 成"没事"（不变式 #8/#10）。
 */

/** 一条被省略/丢弃的入站项：原因码 + 人读细节。省略必须报数。 */
export interface AcpOmission {
    readonly reason: string;
    readonly detail: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/**
 * ACP `session/prompt` 响应的 `stopReason` → 本仓 `finished.outcome`。
 *
 * 判据只有一份、且与 `model/types.ts` 的 `stopReasonAllowsToolExecution` 同 spirit：
 * **只有正常收尾（end_turn）算 COMPLETED**；撞长度上限（max_tokens）、拒绝（refusal）、
 * 用满轮次（max_turn_requests）都是"话没说完/非正常收尾"，绝不折成成功；未知/缺失落 UNKNOWN。
 * 导出以便单测直接钉映射表。
 */
type FinishedOutcome = Extract<AdapterEvent, { readonly kind: 'finished' }>['outcome'];

export function mapAcpStopReason(
    raw: unknown,
): { readonly outcome: FinishedOutcome; readonly reason: string | null } {
    switch (raw) {
        case 'end_turn':
            return { outcome: 'COMPLETED', reason: 'end_turn' };
        case 'cancelled':
            return { outcome: 'INTERRUPTED', reason: 'cancelled' };
        case 'max_tokens':
            return { outcome: 'FAILED', reason: 'max_tokens：输出撞长度上限被截断，意图没有说完' };
        case 'refusal':
            return { outcome: 'FAILED', reason: 'refusal：Agent 拒绝继续' };
        case 'max_turn_requests':
            return { outcome: 'FAILED', reason: 'max_turn_requests：用满轮次上限，未正常收尾' };
        default:
            // 未知/缺失绝不默认成功 —— 与"未知结束原因不是默认绿灯"同一条纪律。
            return { outcome: 'UNKNOWN', reason: typeof raw === 'string' ? `未知 stopReason：${raw.slice(0, 100)}` : '缺少 stopReason' };
    }
}

/**
 * 有状态的 ACP 入站翻译器：一个会话轮对应一个实例。
 * 负责把 Agent → Client 方向的通知/请求翻译成 `AdapterEvent`，并累计省略报数。
 */
export class AcpWireTranslator {
    private sequence = 0;
    private readonly omissionList: AcpOmission[] = [];

    constructor(private readonly turnId: string) { }

    /** 已省略项的只读快照（供上层"省略要报数"呈现）。 */
    get omissions(): readonly AcpOmission[] {
        return this.omissionList;
    }

    private next(): number {
        this.sequence += 1;
        return this.sequence;
    }

    private omit(reason: string, detail: unknown): void {
        this.omissionList.push({ reason, detail: typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail ?? null)?.slice(0, 200) ?? '' });
    }

    /**
     * 翻一条 ACP 入站消息（通知或 Agent 发起的请求）。
     * 返回本轮要下发的 `AdapterEvent`（可为空 —— 当且仅当该消息被计入省略）。
     * **从不**返回批准/应答；写盘与放行由别的信任域负责。
     */
    handle(message: { readonly method: string; readonly params?: unknown }): readonly AdapterEvent[] {
        const params = asRecord(message.params) ?? {};
        switch (message.method) {
            case 'session/update':
                return this.handleSessionUpdate(params.update);
            case 'session/request_permission':
                // herdr 式 blocked：只呈现"谁在等你批准"，不代答（应答发生在会话自己的工具里）。
                return [{
                    kind: 'waiting',
                    turnId: this.turnId,
                    sequence: this.next(),
                    reason: 'APPROVAL',
                    label: `引擎请求批准：${this.permissionTitle(params)} —— 请在该会话自己的工具里应答，RepoPilot 不代答`,
                }];
            case 'elicitation/create':
                return [{
                    kind: 'waiting',
                    turnId: this.turnId,
                    sequence: this.next(),
                    reason: 'INPUT',
                    label: '引擎等待用户输入/提问 —— 请在该会话自己的工具里应答',
                }];
            case 'fs/write_text_file':
            case 'terminal/create':
            case 'terminal/output':
            case 'terminal/release':
            case 'terminal/wait_for_exit':
            case 'terminal/kill':
                // 本仓客户端**故意不 advertise 写/终端能力**（宿主只读 #4、权限边界不上移 #6）。
                // 真到了这条分支说明对端假设了我们没给的能力：如实报数，绝不落盘、绝不 spawn。
                this.omit('capability_not_advertised', message.method);
                return [];
            default:
                // 含 fs/read_text_file（由客户端能力层单独应答，不进投影层）与一切未知 method。
                this.omit('unhandled_method', message.method);
                return [];
        }
    }

    /** 一轮结束：把 `session/prompt` 响应的 stopReason 翻成 `finished`。 */
    finish(stopReason: unknown): Extract<AdapterEvent, { readonly kind: 'finished' }> {
        const mapped = mapAcpStopReason(stopReason);
        return { kind: 'finished', turnId: this.turnId, sequence: this.next(), outcome: mapped.outcome, reason: mapped.reason };
    }

    private permissionTitle(params: JsonRecord): string {
        const toolCall = asRecord(params.toolCall);
        const title = toolCall && typeof toolCall.title === 'string' ? toolCall.title : '（未命名工具调用）';
        return title.slice(0, 200);
    }

    private handleSessionUpdate(rawUpdate: unknown): readonly AdapterEvent[] {
        const update = asRecord(rawUpdate);
        if (!update) {
            this.omit('malformed_session_update', rawUpdate);
            return [];
        }
        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = asRecord(update.content);
                if (content?.type === 'text' && typeof content.text === 'string') {
                    return [{ kind: 'text', turnId: this.turnId, sequence: this.next(), text: content.text }];
                }
                // 非文本内容块（image/resource/…）：省略并报数，不假装展示了。
                this.omit('non_text_content_chunk', typeof content?.type === 'string' ? content.type : 'unknown');
                return [];
            }
            case 'agent_thought_chunk':
                // 不暴露 raw chain-of-thought：只给一条固定标签的活动，绝不含思考原文。
                return [{ kind: 'activity', turnId: this.turnId, sequence: this.next(), label: 'Agent 正在思考（不展示思考原文）' }];
            case 'user_message_chunk':
                // 用户输入回显由本地发起时投影（turn.input_accepted），ACP 回声不重复渲染。
                this.omit('user_echo_dropped', 'session/update');
                return [];
            case 'tool_call':
            case 'tool_call_update':
                // 只呈现"它想调什么工具、到什么状态"，**不执行、不落盘**（副作用只走 Tool Gateway #5）。
                return [{ kind: 'activity', turnId: this.turnId, sequence: this.next(), label: this.toolCallLabel(update) }];
            case 'plan': {
                const entries = Array.isArray(update.entries) ? update.entries.length : 0;
                return [{ kind: 'activity', turnId: this.turnId, sequence: this.next(), label: `计划：${entries} 步` }];
            }
            case 'available_commands_update':
            case 'current_mode_update':
                this.omit('client_side_state_update', String(update.sessionUpdate));
                return [];
            default:
                // 未知 sessionUpdate 变体：判别联合不 fold 成"没事"，一律报数。
                this.omit('unknown_session_update_variant', update.sessionUpdate);
                return [];
        }
    }

    private toolCallLabel(update: JsonRecord): string {
        const title = typeof update.title === 'string' ? update.title.slice(0, 200) : '（未命名工具调用）';
        const kind = typeof update.kind === 'string' ? update.kind : 'other';
        const status = typeof update.status === 'string' ? update.status : 'unknown';
        const editHint = kind === 'edit' ? '（含改动，未执行）' : '';
        return `工具调用：${title} · ${kind} · ${status}${editHint}`;
    }
}
