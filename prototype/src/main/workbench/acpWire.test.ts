import { describe, expect, it } from 'vitest';
import { AcpWireTranslator, mapAcpStopReason } from './acpWire';

/**
 * ACP 翻译接缝的负向测试。它钉的不是"能不能翻出正文"，
 * 而是本仓立身的那几条边界在协议翻译这一层没有被悄悄放宽：
 *   - 会话自述的结束绝不等于成功；
 *   - 权限请求只呈现、结构上无代答通道；
 *   - 未知/未支持项一律计数并报因，绝不静默吞或折成"没事"；
 *   - 思考原文不外泄；工具调用/计划只呈现不执行。
 */

const textChunk = (text: string) => ({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

describe('mapAcpStopReason：只有正常收尾算成功', () => {
    it('end_turn → COMPLETED（唯一算 COMPLETED 的词）', () => {
        expect(mapAcpStopReason('end_turn').outcome).toBe('COMPLETED');
    });
    it('cancelled → INTERRUPTED（取消与失败分开，#5）', () => {
        expect(mapAcpStopReason('cancelled').outcome).toBe('INTERRUPTED');
    });
    it.each(['max_tokens', 'refusal', 'max_turn_requests'])('%s → FAILED，绝不折成成功（#10）', (raw) => {
        expect(mapAcpStopReason(raw).outcome).toBe('FAILED');
    });
    it.each([undefined, null, '', 'totally_new_reason'])('未知/缺失 stopReason(%s) → UNKNOWN，绝不默认成功', (raw) => {
        expect(mapAcpStopReason(raw).outcome).toBe('UNKNOWN');
    });
});

describe('AcpWireTranslator：正文与状态投影', () => {
    it('agent text chunk → text 事件，序号单调递增', () => {
        const t = new AcpWireTranslator('turn-1');
        const first = t.handle(textChunk('你'));
        const second = t.handle(textChunk('好'));
        expect(first).toEqual([{ kind: 'text', turnId: 'turn-1', sequence: 1, text: '你' }]);
        expect(second).toEqual([{ kind: 'text', turnId: 'turn-1', sequence: 2, text: '好' }]);
        expect(t.omissions).toHaveLength(0);
    });

    it('非文本内容块被计数，不假装展示（省略要报数 #8）', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '…' } } } });
        expect(events).toEqual([]);
        expect(t.omissions).toHaveLength(1);
        expect(t.omissions[0]?.reason).toBe('non_text_content_chunk');
    });

    it('思考块只给固定标签活动，绝不含思考原文（不外泄 CoT）', () => {
        const t = new AcpWireTranslator('turn-1');
        const secret = '这是我偷偷想的密钥 12345';
        const events = t.handle({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: secret } } } });
        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe('activity');
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('12345');
    });

    it('tool_call（含 edit）只呈现为 activity，不执行不落盘（#4/#5）', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: '编辑 src/a.ts', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/abs/a.ts', oldText: 'x', newText: 'y' }] } } });
        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe('activity');
        // 关键：翻译层里不存在"已应用/已写盘"这类事件，diff 原文也不进投影。
        expect(JSON.stringify(events)).not.toContain('"newText":"y"');
        expect((events[0] as { label: string }).label).toContain('未执行');
    });

    it('plan 按步数如实报数', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] } } });
        expect((events[0] as { label: string }).label).toBe('计划：3 步');
    });
});

describe('AcpWireTranslator：blocked 只呈现不代答', () => {
    it('session/request_permission → waiting{APPROVAL}，且没有任何批准/应答产出', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/request_permission', params: { toolCall: { title: '运行 rm -rf' }, options: [{ optionId: 'allow', name: '允许' }] } });
        expect(events).toHaveLength(1);
        const [only] = events;
        expect(only?.kind).toBe('waiting');
        expect((only as { reason: string }).reason).toBe('APPROVAL');
        expect((only as { label: string }).label).toContain('不代答');
        // 结构上杜绝放行：翻译器只暴露 handle/finish，返回类型恒为 AdapterEvent，
        // 无法构造 JSON-RPC 响应；这里进一步断言输出里不含任何被选中的 optionId。
        expect(JSON.stringify(events)).not.toContain('allow');
    });

    it('elicitation/create → waiting{INPUT}', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'elicitation/create', params: { message: '选哪个？' } });
        expect((events[0] as { reason: string }).reason).toBe('INPUT');
    });
});

describe('AcpWireTranslator：能力未 advertise 与未知项一律报数', () => {
    it.each(['fs/write_text_file', 'terminal/create', 'terminal/kill'])('%s 被计数，不落盘/不 spawn', (method) => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method, params: { path: '/etc/passwd' } });
        expect(events).toEqual([]);
        expect(t.omissions).toHaveLength(1);
        expect(t.omissions[0]?.reason).toBe('capability_not_advertised');
        expect(t.omissions[0]?.detail).toBe(method);
    });

    it('未知 method → unhandled_method 计数，不 fold 成没事', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'agent/someBrandNewMethod', params: {} });
        expect(events).toEqual([]);
        expect(t.omissions[0]?.reason).toBe('unhandled_method');
    });

    it('未知 session/update 变体 → 计数', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/update', params: { update: { sessionUpdate: 'quantum_flux' } } });
        expect(events).toEqual([]);
        expect(t.omissions[0]?.reason).toBe('unknown_session_update_variant');
    });

    it('畸形 session/update（update 非对象）→ 计数，不崩', () => {
        const t = new AcpWireTranslator('turn-1');
        const events = t.handle({ method: 'session/update', params: { update: 'not-an-object' } });
        expect(events).toEqual([]);
        expect(t.omissions[0]?.reason).toBe('malformed_session_update');
    });

    it('多条未知累加，省略数可查（不静默）', () => {
        const t = new AcpWireTranslator('turn-1');
        t.handle({ method: 'a/unknown1', params: {} });
        t.handle({ method: 'b/unknown2', params: {} });
        expect(t.omissions).toHaveLength(2);
    });
});

describe('AcpWireTranslator.finish', () => {
    it('end_turn → finished/COMPLETED，序号接在上文之后', () => {
        const t = new AcpWireTranslator('turn-9');
        t.handle(textChunk('正文'));
        const done = t.finish('end_turn');
        expect(done).toEqual({ kind: 'finished', turnId: 'turn-9', sequence: 2, outcome: 'COMPLETED', reason: 'end_turn' });
    });
    it('max_tokens → finished/FAILED（截断不算成功）', () => {
        const t = new AcpWireTranslator('turn-9');
        expect(t.finish('max_tokens').outcome).toBe('FAILED');
    });
});
