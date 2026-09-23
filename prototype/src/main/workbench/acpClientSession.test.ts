import { describe, expect, it } from 'vitest';
import {
    CONVERSATION_ONLY_CLIENT_CAPABILITIES,
    openAcpSession,
    type AcpInboundMessage,
    type AcpTransport,
} from './acpClientSession';
import type { AdapterEvent } from './adapter';
import { JsonRpcProcess } from './jsonRpcProcess';

/**
 * ACP 会话驱动的负向测试：钉的是"就算对端把危险动作摆到面前，驱动也不越界"。
 * 全部走确定性假传输，不碰真进程 —— 真实 ACP Agent 端到端仍属后续（能力诚实标 UNKNOWN）。
 */

class FakeAcpTransport implements AcpTransport {
    readonly requests: { method: string; params: Record<string, unknown> }[] = [];
    readonly notifications: { method: string; params: Record<string, unknown> }[] = [];
    readonly responses: { id: string | number; result: unknown }[] = [];
    readonly errors: { id: string | number; code: number; message: string }[] = [];
    stopped = false;
    private listener: ((message: AcpInboundMessage) => void) | null = null;
    private readonly resultQueue: Record<string, unknown>[] = [];

    /** 让 prompt 请求在处理时先投递入站消息，再返回 stopReason（可异步以便测并发）。 */
    promptHook: ((emit: (message: AcpInboundMessage) => void) => Record<string, unknown> | Promise<Record<string, unknown>>) | null = null;

    queueResult(result: Record<string, unknown>): void { this.resultQueue.push(result); }
    emit(message: AcpInboundMessage): void { this.listener?.(message); }

    async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.requests.push({ method, params });
        if (method === 'session/prompt' && this.promptHook) {
            return this.promptHook((message) => this.emit(message));
        }
        return this.resultQueue.shift() ?? {};
    }
    notify(method: string, params: Record<string, unknown>): void { this.notifications.push({ method, params }); }
    respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
    respondError(id: string | number, code: number, message: string): void { this.errors.push({ id, code, message }); }
    subscribe(listener: (message: AcpInboundMessage) => void): () => void {
        this.listener = listener;
        return () => { this.listener = null; };
    }
    async stop(): Promise<void> { this.stopped = true; }
}

const update = (sessionUpdate: Record<string, unknown>): AcpInboundMessage => ({
    method: 'session/update',
    params: { sessionId: 'sess-1', update: sessionUpdate },
});

async function openSession(transport: FakeAcpTransport) {
    transport.queueResult({ protocolVersion: 1, agentCapabilities: {} });
    transport.queueResult({ sessionId: 'sess-1' });
    return openAcpSession(transport, '/repo');
}

describe('openAcpSession：握手与只读隔离', () => {
    it('initialize 只 advertise 只读能力（fs/terminal 全 false）+ session/new 不带 mcpServers', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        expect(session.vendorSessionId).toBe('sess-1');
        const init = t.requests.find((r) => r.method === 'initialize');
        expect(init?.params.protocolVersion).toBe(1);
        expect(init?.params.clientCapabilities).toEqual(CONVERSATION_ONLY_CLIENT_CAPABILITIES);
        expect(JSON.stringify(init?.params.clientCapabilities)).not.toContain('true');
        const newSession = t.requests.find((r) => r.method === 'session/new');
        expect(newSession?.params.mcpServers).toEqual([]);
    });

    it('Agent 回不支持的协议版本 → 抛错，不降级不猜', async () => {
        const t = new FakeAcpTransport();
        t.queueResult({ protocolVersion: 0, agentCapabilities: {} });
        await expect(openAcpSession(t, '/repo')).rejects.toThrow(/版本协商失败/);
    });

    it('session/new 缺 sessionId → 抛错', async () => {
        const t = new FakeAcpTransport();
        t.queueResult({ protocolVersion: 1, agentCapabilities: {} });
        t.queueResult({});
        await expect(openAcpSession(t, '/repo')).rejects.toThrow(/sessionId/);
    });
});

describe('AcpSession.send：正文流转与结束判别联合', () => {
    it('agent 文本块 → text；end_turn → finished/COMPLETED', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        const events: AdapterEvent[] = [];
        t.promptHook = (emit) => {
            emit(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } }));
            return { stopReason: 'end_turn' };
        };
        await session.send({ requestId: 'req-1', text: 'hi', onEvent: (e) => events.push(e) });
        expect(events.map((e) => e.kind)).toEqual(['text', 'finished']);
        expect((events[1] as { outcome: string }).outcome).toBe('COMPLETED');
    });

    it('max_tokens → finished/FAILED，绝不折成 COMPLETED（#10）', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        const events: AdapterEvent[] = [];
        t.promptHook = () => ({ stopReason: 'max_tokens' });
        await session.send({ requestId: 'req-2', text: 'hi', onEvent: (e) => events.push(e) });
        expect((events[0] as { outcome: string }).outcome).toBe('FAILED');
    });

    it('缺少 stopReason → finished/UNKNOWN，不默认成功', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        const events: AdapterEvent[] = [];
        t.promptHook = () => ({});
        await session.send({ requestId: 'req-3', text: 'hi', onEvent: (e) => events.push(e) });
        expect((events[0] as { outcome: string }).outcome).toBe('UNKNOWN');
    });

    it('同一会话不允许并发轮次', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        let release: (r: Record<string, unknown>) => void = () => { };
        t.promptHook = () => new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
        const first = session.send({ requestId: 'a', text: 'x', onEvent: () => { } });
        await expect(session.send({ requestId: 'b', text: 'y', onEvent: () => { } })).rejects.toThrow(/already active/);
        release({ stopReason: 'end_turn' });
        await first;
    });
});

describe('AcpSession：blocked 只呈现、越界请求一律不放行', () => {
    it('session/request_permission → 呈现 waiting{APPROVAL} 且回 cancelled，绝不选 allow_*', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        const events: AdapterEvent[] = [];
        t.promptHook = (emit) => {
            emit({ id: 5, method: 'session/request_permission', params: { toolCall: { title: '写文件' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }] } });
            return { stopReason: 'end_turn' };
        };
        await session.send({ requestId: 'req-4', text: 'hi', onEvent: (e) => events.push(e) });
        const waiting = events.find((e) => e.kind === 'waiting');
        expect(waiting).toBeDefined();
        expect((waiting as { reason: string }).reason).toBe('APPROVAL');
        // 结构上只拒绝、不放行：应答 outcome=cancelled，且整条会话从未回填任何 allow optionId。
        expect(t.responses).toEqual([{ id: 5, result: { outcome: { outcome: 'cancelled' } } }]);
        expect(JSON.stringify(t.responses)).not.toContain('allow-once');
    });

    it('未 advertise 的 fs/write_text_file 请求 → 回 Method not found（-32601），不落盘', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        const events: AdapterEvent[] = [];
        t.promptHook = (emit) => {
            emit({ id: 7, method: 'fs/write_text_file', params: { path: '/etc/passwd', content: 'pwn' } });
            return { stopReason: 'end_turn' };
        };
        await session.send({ requestId: 'req-5', text: 'hi', onEvent: (e) => events.push(e) });
        expect(t.errors).toHaveLength(1);
        expect(t.errors[0]).toMatchObject({ id: 7, code: -32601 });
        // 越界请求不产生任何正文/放行事件，只可能留下"本轮结束"。
        expect(events.every((e) => e.kind === 'finished')).toBe(true);
    });
});

describe('AcpSession 生命周期', () => {
    it('interrupt → 发 session/cancel 通知', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        await session.interrupt('req-x');
        expect(t.notifications).toContainEqual({ method: 'session/cancel', params: { sessionId: 'sess-1' } });
    });

    it('dispose → 停止传输', async () => {
        const t = new FakeAcpTransport();
        const session = await openSession(t);
        await session.dispose();
        expect(t.stopped).toBe(true);
    });
});

/*
 * 端到端（真子进程）：把 AcpSession 跑在真 JsonRpcProcess 上，用一个假 ACP Agent 脚本
 * 在 prompt 期间发来一条入站请求。这一步同时验证 jsonRpcProcess 新加的 respond/respondError：
 * 若客户端错选了 allow_*，脚本会回 refusal → finished/FAILED（测发红的）；
 * 若客户端正确拒绝/回 -32601，脚本才回 end_turn → finished/COMPLETED。
 */

/** 造一个假 ACP Agent 子进程脚本：握手/建会话/在 prompt 时投递一条入站请求，收到应答后才收尾。 */
function fakeAcpAgentScript(inbound: AcpInboundMessage): string {
    const inboundJson = JSON.stringify(inbound);
    return String.raw`
    process.on('SIGTERM', () => {});
    process.stdin.setEncoding('utf8');
    let buf = '';
    let promptId = null;
    const inboundId = ${JSON.stringify(inbound.id)};
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'sess-1' } });
        else if (m.method === 'session/prompt') { promptId = m.id; send(${inboundJson}); }
        else if (m.id === inboundId) {
          const sel = m.result && m.result.outcome;
          send({ id: promptId, result: { stopReason: sel && sel.outcome === 'selected' ? 'refusal' : 'end_turn' } });
        }
      }
    });
  `;
}

describe('AcpSession × 真 JsonRpcProcess（端到端、覆盖 respond/respondError）', () => {
    it('入站 session/request_permission → 呈现 waiting 并回 cancelled（真传输）', async () => {
        const rpc = new JsonRpcProcess(
            process.execPath,
            ['-e', fakeAcpAgentScript({ id: 'perm-1', method: 'session/request_permission', params: { toolCall: { title: '写文件' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }] } })],
            process.env,
            50,
        );
        const events: AdapterEvent[] = [];
        try {
            const session = await openAcpSession(rpc, '/repo');
            await session.send({ requestId: 'req-e2e-1', text: 'hi', onEvent: (e) => events.push(e) });
            expect(events.map((e) => e.kind)).toEqual(['waiting', 'finished']);
            expect((events[0] as { reason: string }).reason).toBe('APPROVAL');
            // 客户端正确拒绝 → 脚本才回 end_turn；若曾自动 allow 会是 FAILED。
            expect((events[1] as { outcome: string }).outcome).toBe('COMPLETED');
        } finally {
            await rpc.stop();
        }
    }, 15_000);

    it('未 advertise 的入站 fs/write_text_file → 回 -32601（真传输）', async () => {
        const rpc = new JsonRpcProcess(
            process.execPath,
            ['-e', fakeAcpAgentScript({ id: 'fs-1', method: 'fs/write_text_file', params: { path: '/etc/passwd', content: 'pwn' } })],
            process.env,
            50,
        );
        const events: AdapterEvent[] = [];
        try {
            const session = await openAcpSession(rpc, '/repo');
            await session.send({ requestId: 'req-e2e-2', text: 'hi', onEvent: (e) => events.push(e) });
            // 越界请求不产生 waiting/text，只有本轮结束。
            expect(events.map((e) => e.kind)).toEqual(['finished']);
            expect((events[0] as { outcome: string }).outcome).toBe('COMPLETED');
        } finally {
            await rpc.stop();
        }
    }, 15_000);
});
