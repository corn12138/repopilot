import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter, fetchJson } from './anthropic';
import { parseRetryAfterMs } from './http';
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

  it('input_tokens 归一化：Anthropic 是相加口径，不归一化会让预算止损失灵', async () => {
    /*
     * 官方文档（platform.claude.com/.../prompt-caching）逐字：
     *   input_tokens = "tokens which were **not** read from or used to create a cache"
     *   total_input_tokens = cache_read + cache_creation + input_tokens
     * 下面直接用文档给的那个例子：100000 读 + 0 新建 + 50 用户消息 = 100050。
     *
     * 照搬 input_tokens 会把 100050 记成 50 —— 而它直接进预算账本，
     * 那是一个永远花不完的预算，Run 不会因超限而停。
     */
    stubFetchJson({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 50,
        output_tokens: 7,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
      },
    });
    const r = await anthropicAdapter.call(req, ctx());
    expect(r.inputTokens).toBe(100_050); // 不是 50
    expect(r.cacheReadTokens).toBe(100_000);
    // 命中占总输入的比例应当接近 100%，而不是荒谬的 200000%
    expect(r.cacheReadTokens! / r.inputTokens!).toBeCloseTo(0.9995, 3);
  });

  it('缓存构成：命中/写入分别解析；缺失记 null 而不是 0', async () => {
    /*
     * 多轮循环每一轮都重发整段历史，命中前缀缓存的输入按远低于常规输入计价。
     * 只报一个 inputTokens 总数会让账本看起来比实际更贵 —— 少报事实与
     * 把未知折算成 0 是同一类问题（实测 run_074bde20… 12 轮累计输入 218453 tok）。
     */
    stubFetchJson({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    const hit = await anthropicAdapter.call(req, ctx());
    expect(hit.cacheReadTokens).toBe(80);
    expect(hit.cacheWriteTokens).toBe(20);

    // 没发 cache_control 时这两个字段根本不出现 —— 那是"未回报"，不是"命中 0"
    stubFetchJson({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    const miss = await anthropicAdapter.call(req, ctx());
    // 求和把缺失按 0 计（没有缓存活动就没有这部分 token），但对外仍报 null ——
    // "求和用的 0" 与 "展示用的未知" 是两件事，不能混
    expect(miss.cacheReadTokens).toBeNull();
    expect(miss.cacheWriteTokens).toBeNull();
    expect(miss.inputTokens).toBe(100);
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

/*
 * 重试安全性的判据来源：sendState 说的是"失败发生在请求生命周期的哪一段"。
 * 分错方向的代价不对称 —— 把"发出去了"错标成 NOT_SENT 会导致重发、可能重复执行
 * 重复计费；把"没发出去"错标成结局不明只是少一次重试。所以宁可保守。
 */
describe('fetchJson: sendState 与 Retry-After（重试安全性的判据）', () => {
  const rejectWith = (err: unknown): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw err;
      }),
    );
  };

  it('连接被拒（cause.code=ECONNREFUSED）→ NOT_SENT：请求没离开过本机，可安全重发', async () => {
    rejectWith(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({
      kind: 'NETWORK',
      sendState: 'NOT_SENT',
    });
  });

  it('DNS 解析失败（ENOTFOUND）→ NOT_SENT', async () => {
    rejectWith(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({ sendState: 'NOT_SENT' });
  });

  it('连接中途被重置（ECONNRESET）→ SENT_OUTCOME_UNKNOWN：可能已执行，不可重发', async () => {
    rejectWith(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({
      kind: 'NETWORK',
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  });

  it('没有 cause.code 的网络错误 → 保守判为 SENT_OUTCOME_UNKNOWN', async () => {
    rejectWith(new Error('socket hang up'));
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  });

  it('HTTP 状态码错误 → RESPONDED：对端明确回了话', async () => {
    stubFetchJson({ error: { message: 'boom' } }, 503);
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({
      kind: 'SERVER',
      sendState: 'RESPONDED',
    });
  });

  it('429 的 Retry-After 秒数被换算成毫秒带出', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '2' },
      });
    await expect(fetchJson('https://x/y', {})).rejects.toMatchObject({
      kind: 'RATE_LIMIT',
      retryAfterMs: 2000,
    });
  });

  it('信号 reason 是 TimeoutError → TIMEOUT，且结局不明', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('per-attempt timeout', 'TimeoutError'));
    rejectWith(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(fetchJson('https://x/y', { signal: controller.signal })).rejects.toMatchObject({
      kind: 'TIMEOUT',
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  });

  it('parseRetryAfterMs：秒数合法则换算，其余一律 null（交给指数退避）', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('1.5')).toBe(1500);
    expect(parseRetryAfterMs('abc')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    // HTTP-date 形式刻意不解析 —— 时钟相关，解析错比不解析更糟
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
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

  it('Moonshot：cached_tokens 在 usage 顶层 —— 不认它就等于把已回报的数当未回报', async () => {
    /*
     * 2026-08-28 逐家核实官方文档时抓到的真错：Kimi 把命中数放在 usage **顶层**，
     * 既不叫 prompt_cache_hit_tokens，也不在 prompt_tokens_details 下。
     * 只认前两个字段的话，Kimi **每次都回报了**而我们**每次都显示"未回报"** ——
     * 这是纪律的反向违反：不是把未知当已知，是把已知当未知。
     */
    stubFetchJson({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 21, total_tokens: 40, cached_tokens: 10 },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBe(10);
  });

  it('SiliconFlow：两套字段并存时不被占位 0 截断', async () => {
    /*
     * SiliconFlow 是唯一同时声明两套字段的 provider。若其中一套是未接上游的占位 0，
     * `??` 会在 0 处停下（?? 只对 null/undefined 下坠），把真实命中显示成"0 命中" ——
     * 正是我们明令禁止的那一格。所以取 max 而不是取第一个非空。
     */
    stubFetchJson({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 0, // 占位
        prompt_tokens_details: { cached_tokens: 800 }, // 真值
      },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBe(800);
  });

  it('真实回报的 0 保留成 0，字段整体缺席才是 null', async () => {
    // "确实 0 命中"与"没告诉我们"是两件事，不能都塌缩成一个显示
    stubFetchJson({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, prompt_tokens_details: { cached_tokens: 0 } },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBe(0);

    stubFetchJson({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19 },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBeNull();
  });

  it('openai wire 的 cache_write 是子集，绝不能加进 inputTokens', async () => {
    /*
     * 与 anthropic wire 的非对称性：那边 cache_creation 是额外项、要相加；
     * 这边 OpenAI 官方算式是 ordinary = input − cached − cache_write，是子集。
     * 照搬求和会把总输入重复计一遍。
     */
    stubFetchJson({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
      },
    });
    const r = await openAiWireAdapter.call(req, ctx());
    expect(r.inputTokens).toBe(1000); // 不是 1300
    expect(r.cacheWriteTokens).toBe(300); // 此前被硬编码成 null，真实数据被丢弃
  });

  it('缓存构成：认 DeepSeek 与 OpenAI 两种口径；都没有则记 null', async () => {
    // DeepSeek 口径
    stubFetchJson({
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64 },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBe(64);

    // OpenAI 标准口径
    stubFetchJson({
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 32 } },
    });
    expect((await openAiWireAdapter.call(req, ctx())).cacheReadTokens).toBe(32);

    // 两种都没有 —— provider 可能没有前缀缓存，也可能有但没告诉我们，都不是"命中 0"
    stubFetchJson({
      choices: [{ message: { content: 'a' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
    const none = await openAiWireAdapter.call(req, ctx());
    expect(none.cacheReadTokens).toBeNull();
    expect(none.cacheWriteTokens).toBeNull();
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
