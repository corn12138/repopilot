import type { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSdkAdapter } from './claudeAdapter';

const found = () => ({ vendor: 'CLAUDE' as const, binaryPath: '/bin/echo', source: 'PATH' as const, checkedPaths: [], omittedCandidates: 0, reason: null });

describe('ClaudeAgentSdkAdapter', () => {
  it('只在 SDK 给出 session_id 后续接第二轮', async () => {
    const resumes: unknown[] = [];
    let invocation = 0;
    const fakeQuery = ((input: { options?: Record<string, unknown> }) => {
      resumes.push(input.options?.resume);
      invocation += 1;
      const current = invocation;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
        yield { type: 'result', subtype: 'success', session_id: 'sdk-session', is_error: false, result: `done-${current}` };
      })();
    }) as unknown as typeof query;
    const session = await new ClaudeAgentSdkAdapter(fakeQuery, found, () => 'sk-test').start();
    const send = (requestId: string) => new Promise<void>((resolve) => {
      void session.send({ requestId, text: 'hello', onEvent: (event) => { if (event.kind === 'finished') resolve(); } });
    });
    await send('first');
    await send('second');
    expect(resumes).toEqual([undefined, 'sdk-session']);
    await session.dispose();
  });

  it('空流以 UNKNOWN 收口，并把隔离环境和禁用扩展传给 SDK', async () => {
    let options: Record<string, unknown> | undefined;
    const fakeQuery = ((input: { options?: Record<string, unknown> }) => {
      options = input.options;
      return (async function* () { })();
    }) as unknown as typeof query;
    const adapter = new ClaudeAgentSdkAdapter(fakeQuery, found, () => 'sk-test');
    const session = await adapter.start();
    expect(session.vendorSessionId).toBe('');
    const finished = new Promise<string>((resolve) => {
      void session.send({
        requestId: 'req', text: 'hello', onEvent: (event) => {
          if (event.kind === 'finished') resolve(event.outcome);
        }
      });
    });
    expect(await finished).toBe('UNKNOWN');
    expect(options).toMatchObject({
      tools: [],
      settingSources: [],
      plugins: [],
      mcpServers: {},
      includePartialMessages: true,
    });
    expect((options?.env as Record<string, string>).HOME).toContain('repopilot-claude-workbench-');
    await session.dispose();
  });

  it('消费 stream_event 文本增量，并避免随后完整 assistant 消息重复输出', async () => {
    const fakeQuery = (() => (async function* () {
      yield {
        type: 'stream_event',
        session_id: 'sdk-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '增量' } },
      };
      yield {
        type: 'assistant',
        session_id: 'sdk-session',
        message: { content: [{ type: 'text', text: '增量' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-session', is_error: false };
    })()) as unknown as typeof query;
    const session = await new ClaudeAgentSdkAdapter(fakeQuery, found, () => 'sk-test').start();
    const text: string[] = [];
    const finished = new Promise<void>((resolve) => {
      void session.send({
        requestId: 'req-stream',
        text: 'hello',
        onEvent: (event) => {
          if (event.kind === 'text') text.push(event.text);
          if (event.kind === 'finished') resolve();
        },
      });
    });
    await finished;
    expect(text).toEqual(['增量']);
    await session.dispose();
  });

  it('把 SDK 权限/控制请求映射成 waiting/APPROVAL（只呈现，不代答）', async () => {
    const fakeQuery = (() => (async function* () {
      yield { type: 'control_request', session_id: 'sdk-session', request: { subtype: 'can_use_tool' } };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-session', is_error: false };
    })()) as unknown as typeof query;
    const session = await new ClaudeAgentSdkAdapter(fakeQuery, found, () => 'sk-test').start();
    const waiting: unknown[] = [];
    const finished = new Promise<void>((resolve) => {
      void session.send({
        requestId: 'req-approval',
        text: 'hello',
        onEvent: (event) => {
          if (event.kind === 'waiting') waiting.push(event);
          if (event.kind === 'finished') resolve();
        },
      });
    });
    await finished;
    // 映射到 waiting/APPROVAL，本轮仍以 result 收口（waiting 不是终态）
    expect(waiting).toEqual([
      expect.objectContaining({ kind: 'waiting', reason: 'APPROVAL', turnId: 'req-approval' }),
    ]);
    await session.dispose();
  });

  it('dispose 会关闭活动 query，并等消费循环终止后再返回', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const close = vi.fn(() => release());
    const fakeQuery = (() => {
      const stream = (async function* () {
        try {
          await gate;
        } finally {
          settled = true;
        }
      })();
      return Object.assign(stream, { close });
    }) as unknown as typeof query;
    const session = await new ClaudeAgentSdkAdapter(fakeQuery, found, () => 'sk-test').start();
    await session.send({ requestId: 'req-dispose', text: 'hello', onEvent: () => { } });
    await session.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });
});
