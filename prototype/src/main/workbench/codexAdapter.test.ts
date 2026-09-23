import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from './codexAdapter';

class FakeRpc {
  listener: ((message: Record<string, unknown>) => void) | null = null;
  readonly methods: string[] = [];
  stopped = false;

  async request(method: string, _params: Record<string, unknown>, _timeoutMs?: number): Promise<Record<string, unknown>> {
    this.methods.push(method);
    if (method === 'initialize') return {};
    if (method === 'account/login/start') return { type: 'apiKey' };
    if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      this.listener?.({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '早到' } });
      return { turn: { id: 'turn-1' } };
    }
    return {};
  }
  notify(_method: string, _params: Record<string, unknown>): void { }
  subscribe(listener: (message: Record<string, unknown>) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  async stop(): Promise<void> { this.stopped = true; }
}

/** 记录每次 request 的 params，用于断言隔离参数没被放宽。 */
class RecordingRpc {
  listener: ((message: Record<string, unknown>) => void) | null = null;
  readonly recorded: Array<{ method: string; params: Record<string, unknown> }> = [];
  stopped = false;
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.recorded.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'account/login/start') return { type: 'apiKey' };
    if (method === 'account/read') return { account: { type: 'apiKey' } };
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  notify(): void { }
  subscribe(listener: (message: Record<string, unknown>) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  async stop(): Promise<void> { this.stopped = true; }
}

describe('CodexAppServerAdapter', () => {
  it('保留 turn/start 响应前的通知，并支持 interrupt、disconnect 与清理', async () => {
    const rpc = new FakeRpc();
    const adapter = new CodexAppServerAdapter(
      () => rpc,
      () => ({ vendor: 'CODEX', binaryPath: '/bin/echo', source: 'PATH', checkedPaths: [], omittedCandidates: 0, reason: null }),
      () => 'sk-test',
      () => 'codex-cli 0.154.0-alpha.6.2',
    );
    const session = await adapter.start();
    const events: Array<{ kind: string; text?: string }> = [];
    await session.send({ requestId: 'req-1', text: 'hello', onEvent: (event) => events.push(event) });
    expect(events).toEqual([expect.objectContaining({ kind: 'text', text: '早到' })]);
    expect(rpc.methods.slice(0, 4)).toEqual([
      'initialize',
      'account/login/start',
      'account/read',
      'thread/start',
    ]);

    await session.interrupt('req-1');
    expect(rpc.methods).toContain('turn/interrupt');
    rpc.listener?.({ method: 'transport/disconnected', params: { reason: 'lost' } });
    expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'disconnected' }));

    await session.dispose();
    expect(rpc.stopped).toBe(true);
  });

  it('丢弃 foreign thread 或缺 turnId 的文本通知', async () => {
    const rpc = new FakeRpc();
    const adapter = new CodexAppServerAdapter(
      () => rpc,
      () => ({ vendor: 'CODEX', binaryPath: '/bin/echo', source: 'PATH', checkedPaths: [], omittedCandidates: 0, reason: null }),
      () => 'sk-test',
      () => 'codex-cli 0.154.0-alpha.6.2',
    );
    const session = await adapter.start();
    const events: Array<{ kind: string; text?: string }> = [];
    try {
      await session.send({ requestId: 'req-1', text: 'hello', onEvent: (event) => events.push(event) });
      events.length = 0;
      rpc.listener?.({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', delta: '串线' } });
      rpc.listener?.({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: '缺 turn' } });
      expect(events).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  it('未知版本在创建 app-server 客户端前拒绝准入', async () => {
    const createClient = () => {
      throw new Error('client must not start');
    };
    const adapter = new CodexAppServerAdapter(
      createClient,
      () => ({ vendor: 'CODEX', binaryPath: '/bin/echo', source: 'PATH', checkedPaths: [], omittedCandidates: 0, reason: null }),
      () => 'sk-test',
      () => 'codex-cli 9.9.9',
    );

    await expect(adapter.start()).rejects.toThrow(/版本未准入/);
  });

  it('未知版本探测只做 initialize，不绑定凭据也不创建 thread', async () => {
    const rpc = new FakeRpc();
    const adapter = new CodexAppServerAdapter(
      () => rpc,
      () => ({ vendor: 'CODEX', binaryPath: '/bin/echo', source: 'PATH', checkedPaths: [], omittedCandidates: 0, reason: null }),
      () => 'sk-test',
      () => 'codex-cli 9.9.9',
    );

    const capability = await adapter.probe();

    expect(capability.versionSupported.verdict).toBe('UNKNOWN');
    expect(capability.authenticated.verdict).toBe('UNKNOWN');
    expect(capability.createSession.verdict).toBe('UNKNOWN');
    expect(rpc.methods).toEqual(['initialize']);
    expect(rpc.stopped).toBe(true);
  });

  it('never-approve + read-only 隔离下不产出 waiting/blocked，且隔离参数没被放宽', async () => {
    const rpc = new RecordingRpc();
    const adapter = new CodexAppServerAdapter(
      () => rpc,
      () => ({ vendor: 'CODEX', binaryPath: '/bin/echo', source: 'PATH', checkedPaths: [], omittedCandidates: 0, reason: null }),
      () => 'sk-test',
      () => 'codex-cli 0.154.0-alpha.6.2',
    );
    const session = await adapter.start();
    const events: Array<{ kind: string }> = [];
    await session.send({ requestId: 'req-1', text: 'hello', onEvent: (event) => events.push(event) });
    rpc.listener?.({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'hi' } });
    rpc.listener?.({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } } });

    // 隔离参数没被放宽（放宽它去换 blocked 感知是另一个信任域决定，本轮不做）
    const threadStart = rpc.recorded.find((r) => r.method === 'thread/start')!.params;
    const turnStart = rpc.recorded.find((r) => r.method === 'turn/start')!.params;
    expect(threadStart).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    expect(turnStart).toMatchObject({ approvalPolicy: 'never' });
    // 正常轮次只有 text + finished，绝无 waiting/blocked
    expect(events.map((e) => e.kind)).toEqual(['text', 'finished']);
    expect(events.some((e) => e.kind === 'waiting')).toBe(false);
    await session.dispose();
  });
});
