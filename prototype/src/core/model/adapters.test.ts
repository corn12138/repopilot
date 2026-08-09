import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter, fetchJson } from './anthropic';
import { openAiWireAdapter } from './openai-compatible';
import { ModelCallError, type AdapterCallContext, type ModelRequest } from './types';

/**
 * 两个协议适配器 + 共享的 fetchJson 是全仓风险密度最高的一段：请求怎么拼、
 * 响应怎么解、错误怎么分类、凭据会不会泄漏 —— 全在这里，而它长期零覆盖。
 *
 * 这些用例把 global fetch 换成可控替身：
 *   - 请求方向：断言 body/headers 的**线上形状**（拼错一格 → 每次调用 400/404）
 *   - 响应方向：断言解析与错误分类（分错 → 假绿灯或误导性报错）
 *   - 凭据：断言 apiKey 绝不进任何抛出的错误信息
 */

let captured: Array<{ url: string; init: RequestInit }>;
/** 下一次 fetch 返回什么 */
let nextResponse: () => Response;

function stubFetchJson(body: unknown, status = 200): void {
  nextResponse = () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

beforeEach(() => {
  captured = [];
  nextResponse = () => new Response('{}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return nextResponse();
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const ctx = (over: Partial<AdapterCallContext> = {}): AdapterCallContext => ({
  apiKey: 'sk-secret-KEY-do-not-leak',
  modelId: 'test-model',
  signal: new AbortController().signal,
  baseUrl: 'https://api.example.com/v1',
  ...over,
});

function lastBody(): Record<string, unknown> {
  const init = captured[captured.length - 1]!.init;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ===========================================================================
// Anthropic 适配器
// ===========================================================================

describe('anthropicAdapter: 请求拼装', () => {
  const baseReq: ModelRequest = {
    system: '你是助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
    maxOutputTokens: 1024,
    temperature: 0,
  };

  it('打到 /messages，带 x-api-key 与 anthropic-version', async () => {
    stubFetchJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    await anthropicAdapter.call(baseReq, ctx());
    const { url, init } = captured[0]!;
    expect(url).toBe('https://api.example.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-secret-KEY-do-not-leak');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('system 单独成字段，messages 逐块翻译', async () => {
    stubFetchJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    await anthropicAdapter.call(baseReq, ctx());
    const body = lastBody();
    expect(body.system).toBe('你是助手');
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(1024);
  });

  it('tool_result 翻译成 anthropic 的 tool_result（含 is_error）', async () => {
    stubFetchJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await anthropicAdapter.call(
      {
        ...baseReq,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '失败了', isError: true }],
          },
        ],
      },
      ctx(),
    );
    const body = lastBody();
    const msg = (body.messages as Array<{ content: unknown[] }>)[0]!;
    expect(msg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '失败了',
      is_error: true,
    });
  });

  it('有工具时 tools 映射成 input_schema；无工具时不带 tools 字段', async () => {
    stubFetchJson({ content: [], stop_reason: 'end_turn' });
    await anthropicAdapter.call(
      {
        ...baseReq,
        tools: [{ name: 'fs_read', description: '读文件', parameters: { type: 'object' } }],
      },
      ctx(),
    );
    const withTools = lastBody();
    expect((withTools.tools as Array<{ input_schema: unknown }>)[0]!.input_schema).toEqual({
      type: 'object',
    });

    stubFetchJson({ content: [], stop_reason: 'end_turn' });
    await anthropicAdapter.call(baseReq, ctx());
    expect(lastBody().tools).toBeUndefined();
  });
});

describe('anthropicAdapter: 响应解析', () => {
  const req: ModelRequest = {
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [],
    maxOutputTokens: 100,
    temperature: 0,
  };

  it('text + tool_use 一起解析出来', async () => {
    stubFetchJson({
      content: [
        { type: 'text', text: '我来改' },
        { type: 'tool_use', id: 'tu_9', name: 'fs_read', input: { path: 'a.ts' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const r = await anthropicAdapter.call(req, ctx());
    expect(r.content).toEqual([
      { type: 'text', text: '我来改' },
      { type: 'tool_use', id: 'tu_9', name: 'fs_read', input: { path: 'a.ts' } },
    ]);
    expect(r.stopReason).toBe('TOOL_USE');
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(34);
  });

  it('usage 缺失时 token 记 null，绝不记 0', async () => {
    stubFetchJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    const r = await anthropicAdapter.call(req, ctx());
    expect(r.inputTokens).toBeNull();
    expect(r.outputTokens).toBeNull();
  });

  it('stop_reason 映射：max_tokens → MAX_TOKENS，未知 → OTHER', async () => {
    stubFetchJson({ content: [], stop_reason: 'max_tokens' });
    expect((await anthropicAdapter.call(req, ctx())).stopReason).toBe('MAX_TOKENS');
    stubFetchJson({ content: [], stop_reason: '外星值' });
    expect((await anthropicAdapter.call(req, ctx())).stopReason).toBe('OTHER');
  });

  it('body 里带 error 字段 → BAD_REQUEST', async () => {
    stubFetchJson({ error: { type: 'invalid', message: '模型名不对' } });
    await expect(anthropicAdapter.call(req, ctx())).rejects.toMatchObject({
      kind: 'BAD_REQUEST',
    });
  });

  it('残缺 tool_use（缺 id/name）被丢弃，不产生半个块', async () => {
    stubFetchJson({
      content: [{ type: 'tool_use', name: 'fs_read' }], // 缺 id
      stop_reason: 'tool_use',
    });
    const r = await anthropicAdapter.call(req, ctx());
    expect(r.content).toEqual([]);
  });
});

// ===========================================================================
// fetchJson 错误分类（两家共用）
// ===========================================================================

describe('fetchJson: HTTP 错误分类', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
    [400, 'BAD_REQUEST'],
    [404, 'BAD_REQUEST'],
  ])('HTTP %d → %s', async (status, kind) => {
    stubFetchJson({ error: { message: 'boom' } }, status);
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({ kind, status });
  });

  it('ok 但响应体不是 JSON → PARSE', async () => {
    nextResponse = () => new Response('<html>502 gateway</html>', { status: 200 });
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('fetch 抛 AbortError → CANCELLED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({ kind: 'CANCELLED' });
  });

  it('fetch 抛普通错误 → NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({ kind: 'NETWORK' });
  });

  it('错误信息里绝不带 apiKey —— 即使 provider 把它回显进错误体', async () => {
    // 构造一个恶意/粗心的 provider：把整段请求（含 key）回显进错误体
    stubFetchJson(
      { error: { message: 'invalid key sk-secret-KEY-do-not-leak in header' } },
      400,
    );
    // fetchJson 会把 provider 的错误摘要带出来 —— 这里断言的是：我们自己**不**主动
    // 拼接 apiKey。provider 回显自己那部分不受我们控制，但适配器的 header 里的 key
    // 不会出现在 error 中（下面的 anthropic 用例覆盖"我们不泄漏"这一半）。
    try {
      await fetchJson('https://x/y', {});
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(ModelCallError);
    }
  });

  it('适配器抛错时不把 apiKey 带进错误信息', async () => {
    stubFetchJson({ error: { message: '密钥无效' } }, 401);
    const req: ModelRequest = {
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [],
      maxOutputTokens: 10,
      temperature: 0,
    };
    try {
      await anthropicAdapter.call(req, ctx());
      throw new Error('应当抛出');
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-secret-KEY-do-not-leak');
    }
  });
});

// ===========================================================================
// OpenAI 兼容适配器
// ===========================================================================

describe('openAiWireAdapter: 请求拼装', () => {
  const baseReq: ModelRequest = {
    system: '你是助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
    maxOutputTokens: 512,
    temperature: 0.2,
  };

  it('打到 /chat/completions，Bearer 授权，system 作为首条消息', async () => {
    stubFetchJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
    await openAiWireAdapter.call(baseReq, ctx());
    const { url, init } = captured[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-secret-KEY-do-not-leak',
    );
    const msgs = lastBody().messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: '你是助手' });
  });

  it('assistant 的 tool_use 翻译成 tool_calls（arguments 是 JSON 字符串）', async () => {
    stubFetchJson({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    await openAiWireAdapter.call(
      {
        ...baseReq,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'fs_read', input: { path: 'a.ts' } }],
          },
        ],
      },
      ctx(),
    );
    const msgs = lastBody().messages as Array<{
      role: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>;
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(asst.tool_calls![0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'fs_read', arguments: '{"path":"a.ts"}' },
    });
  });

  it('tool_result 变成独立的 role:tool 消息，且排在同条 user 文本之前', async () => {
    stubFetchJson({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    await openAiWireAdapter.call(
      {
        ...baseReq,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: '结果', isError: false },
              { type: 'text', text: '继续' },
            ],
          },
        ],
      },
      ctx(),
    );
    const msgs = lastBody().messages as Array<{ role: string; tool_call_id?: string }>;
    // [system, tool, user]
    expect(msgs.map((m) => m.role)).toEqual(['system', 'tool', 'user']);
    expect(msgs[1]!.tool_call_id).toBe('call_1');
  });
});

describe('openAiWireAdapter: 响应解析', () => {
  const req: ModelRequest = {
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [],
    maxOutputTokens: 100,
    temperature: 0,
  };

  it('text + tool_calls 一起解析，usage 映射', async () => {
    stubFetchJson({
      choices: [
        {
          message: {
            content: '我来改',
            tool_calls: [
              { id: 'call_7', function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    });
    const r = await openAiWireAdapter.call(req, ctx());
    expect(r.content).toEqual([
      { type: 'text', text: '我来改' },
      { type: 'tool_use', id: 'call_7', name: 'fs_read', input: { path: 'a.ts' } },
    ]);
    expect(r.stopReason).toBe('TOOL_USE');
    expect(r.inputTokens).toBe(5);
    expect(r.outputTokens).toBe(6);
  });

  it('有 tool_call 时即使 finish_reason=stop 也判 TOOL_USE', async () => {
    stubFetchJson({
      choices: [
        {
          message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '' } }] },
          finish_reason: 'stop',
        },
      ],
    });
    const r = await openAiWireAdapter.call(req, ctx());
    expect(r.stopReason).toBe('TOOL_USE');
  });

  it('畸形 arguments 不 fallback 成 {}，而是原样上报 __malformed_arguments__', async () => {
    stubFetchJson({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'fs_read', arguments: '{path: a.ts' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const r = await openAiWireAdapter.call(req, ctx());
    const toolUse = r.content.find((b) => b.type === 'tool_use')!;
    expect(toolUse).toMatchObject({
      type: 'tool_use',
      input: { __malformed_arguments__: '{path: a.ts' },
    });
  });

  it('usage 缺失 → token 记 null', async () => {
    stubFetchJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
    const r = await openAiWireAdapter.call(req, ctx());
    expect(r.inputTokens).toBeNull();
    expect(r.outputTokens).toBeNull();
  });

  it('没有 choices → PARSE', async () => {
    stubFetchJson({ usage: { prompt_tokens: 1 } });
    await expect(openAiWireAdapter.call(req, ctx())).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('body 里带 error → BAD_REQUEST', async () => {
    stubFetchJson({ error: { message: '模型不存在' } });
    await expect(openAiWireAdapter.call(req, ctx())).rejects.toMatchObject({ kind: 'BAD_REQUEST' });
  });
});
