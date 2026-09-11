import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from './anthropic';
import { openAiWireAdapter } from './openai-compatible';
import { ModelCallError, type ModelRequest, type StreamSignal } from './types';

/**
 * 流式适配器：SSE 解析与重试安全性。
 *
 * **诚实边界（要先说清楚）**：这里喂的是按各家**文档所述帧格式**构造的合成流，
 * 不是真实 provider 的回放。它能证明的是"给定这些帧，我们拼得对、判得对"，
 * 证明不了"真实 provider 就是这么发的"。这个环境里没有任何模型 key，
 * 拿不到更强的证据 —— 所以不假装有。
 *
 * 覆盖的都是会**静默出错**的地方：
 *   - 工具参数跨帧拼接（半截 JSON 会被当成畸形参数，把正常调用记成失败）；
 *   - usage 收尾（漏了就整轮记成"未知用量轮"，预算止损失灵）；
 *   - 中途断流的 sendState（判错就会重复计费并重复执行一次已生效的调用）；
 *   - 分帧本身（CRLF、心跳注释、多行 data、尾帧没有空行）。
 */

const REQUEST: ModelRequest = {
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxOutputTokens: 100,
  temperature: 0,
};

const CTX = {
  apiKey: 'k',
  modelId: 'm',
  signal: new AbortController().signal,
  baseUrl: 'https://example.invalid/v1',
};

/** 把若干帧文本变成一个可读流响应；`chunks` 的切分点刻意跨帧，模拟真实分包 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 读到一半就断：模拟 provider 中途掉线。
 *
 * 必须用 `pull` 分两次给：在 `start` 里 enqueue 完立刻 error，消费方还没读到
 * 第一块就先拿到异常 —— 那测的是"一个字节都没到就断"，不是"断在中途"。
 */
function brokenResponse(prefix: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(prefix));
        return;
      }
      controller.error(new Error('socket hang up'));
    },
  });
  return new Response(body, { status: 200 });
}

function collect(): { signals: StreamSignal[]; listener: (s: StreamSignal) => void } {
  const signals: StreamSignal[] = [];
  return { signals, listener: (s) => signals.push(s) };
}

function textOf(signals: StreamSignal[]): string {
  return signals
    .filter((s): s is Extract<StreamSignal, { kind: 'delta' }> => s.kind === 'delta')
    .map((s) => s.text)
    .join('');
}

afterEach(() => vi.unstubAllGlobals());

describe('Anthropic 流式', () => {
  it('文本分帧到达时边推增量边拼，最终 content 与非流式同构', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我读"}}\n\n',
          // 刻意把一帧拆成两个网络包 —— 分帧靠空行，不能靠"一包一帧"
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"del',
          'ta":{"type":"text_delta","text":"完了。"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    );

    const { signals, listener } = collect();
    const res = await anthropicAdapter.stream(REQUEST, CTX, listener);

    expect(textOf(signals)).toBe('我读完了。');
    expect(res.content).toEqual([{ type: 'text', text: '我读完了。' }]);
    expect(res.stopReason).toBe('END_TURN');
    // 输入口径归一化与非流式同一条：input_tokens 不含缓存，必须加回来
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(7);
    expect(res.cacheReadTokens).toBe(90);
  });

  it('缺 message_delta 帧 → stopReason 落 OTHER，即使 tool_use 已完整拼出', async () => {
    /*
     * 已识别的盲区，刻意钉住而不是"修掉"。
     *
     * Anthropic 的 stop_reason 只在 message_delta 帧里给。流若在它之前就结束
     * （连接被中间层掐断、或某家兼容端根本不发这一帧），adapter 手上是 undefined，
     * mapStop 落到 default → OTHER。
     *
     * 而 OTHER 会被 agent.ts 的响应完整性门禁拦下 —— 未知不是默认成功，这是有意的
     * fail-closed。代价是：若真有一家 provider 在**完整**响应上也不发 message_delta，
     * 那条 Run 会带着"结束原因未知"停下，看起来像平台过度保守。届时第一现场就是这里，
     * 修法是给那一家加一条**有契约测试钉住**的归一化规则，而不是放宽通用层的判据。
     *
     * 12 家 provider 本机一把 key 都没有，这条路径无法实证，只能先把行为钉死。
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fs_read"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/a.ts\\"}"}}\n\n',
          // 刻意不给 message_delta：没有 message_stop 也算，重点是 stop_reason 无从得知
        ]),
      ),
    );

    const { listener } = collect();
    const res = await anthropicAdapter.stream(REQUEST, CTX, listener);

    expect(res.stopReason).toBe('OTHER');
    // 内容照旧解析出来：门禁拦的是执行，不是记录
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'fs_read', input: { path: 'src/a.ts' } },
    ]);
  });

  it('工具参数跨帧拼接后再解析 —— 半截 JSON 不能被当成畸形参数', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fs_read"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"src/a.ts\\"}"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
        ]),
      ),
    );

    const { signals, listener } = collect();
    const res = await anthropicAdapter.stream(REQUEST, CTX, listener);

    expect(res.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'fs_read', input: { path: 'src/a.ts' } },
    ]);
    expect(res.stopReason).toBe('TOOL_USE');
    // 工具参数不是给人看的正文，不推增量
    expect(textOf(signals)).toBe('');
  });

  it('拼完仍不是合法 JSON → 原样上报畸形参数，不修复也不 fallback 成 {}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fs_read"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}\n\n',
        ]),
      ),
    );

    const res = await anthropicAdapter.stream(REQUEST, CTX, collect().listener);
    expect(res.content[0]).toMatchObject({
      type: 'tool_use',
      input: { __malformed_arguments__: '{not json' },
    });
  });

  it('流中返回 error 帧 → 抛错且记 SENT_OUTCOME_UNKNOWN（已经在生成，可能已计费）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
        ]),
      ),
    );

    await expect(anthropicAdapter.stream(REQUEST, CTX, collect().listener)).rejects.toMatchObject({
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  });
});

describe('OpenAI 兼容流式', () => {
  it('增量文本与 usage 收尾；[DONE] 之后不再解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"改"},"finish_reason":null}]}\n\n',
          ': ping\n\n', // 心跳注释：跳过，不能当成坏帧
          'data: {"choices":[{"delta":{"content":"完了"},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":9,"prompt_cache_hit_tokens":100}}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const { signals, listener } = collect();
    const res = await openAiWireAdapter.stream(REQUEST, CTX, listener);

    expect(textOf(signals)).toBe('改完了');
    expect(res.content).toEqual([{ type: 'text', text: '改完了' }]);
    expect(res.stopReason).toBe('END_TURN');
    // 这一侧 prompt_tokens 本来就含缓存 —— 不能照搬 Anthropic 的求和
    expect(res.inputTokens).toBe(120);
    expect(res.outputTokens).toBe(9);
    expect(res.cacheReadTokens).toBe(100);
  });

  it('请求体带 stream_options.include_usage —— 不带的话整轮没有账本数字', async () => {
    // 显式标注入参，否则 mock.calls 的元组类型是空的，取不到 init.body
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await openAiWireAdapter.stream(REQUEST, CTX, collect().listener);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('tool_calls 按 index 累积：函数名只来一次，arguments 分帧拼', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"src/a.ts\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const res = await openAiWireAdapter.stream(REQUEST, CTX, collect().listener);
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'fs_read', input: { path: 'src/a.ts' } },
    ]);
    expect(res.stopReason).toBe('TOOL_USE');
  });

  it('同一帧里多个 index 的工具调用各归各的，不串行拼成一个', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"fs_read","arguments":"{\\"path\\":\\"x\\"}"}},{"index":1,"id":"b","function":{"name":"fs_grep","arguments":"{\\"pattern\\":\\"y\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const res = await openAiWireAdapter.stream(REQUEST, CTX, collect().listener);
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'fs_read', input: { path: 'x' } },
      { type: 'tool_use', id: 'b', name: 'fs_grep', input: { pattern: 'y' } },
    ]);
  });

  it('没有函数名的槽位不硬造成一次调用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const res = await openAiWireAdapter.stream(REQUEST, CTX, collect().listener);
    expect(res.content).toEqual([]);
  });
});

describe('分帧与失败判读', () => {
  it('CRLF 分帧、多行 data、以及结尾没有空行的最后一帧都认', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n',
          // 多行 data 按 SSE 规范用 \n 连接后仍是一段合法 JSON
          'data: {"choices":[{"delta":\ndata: {"content":"b"}}]}\n\n',
          // 最后一帧没有收尾空行
          'data: {"choices":[{"delta":{"content":"c"},"finish_reason":"stop"}]}',
        ]),
      ),
    );

    const { signals, listener } = collect();
    await openAiWireAdapter.stream(REQUEST, CTX, listener);
    expect(textOf(signals)).toBe('abc');
  });

  it('HTTP 错误在读正文之前判定，按常规规则分级（此时还没有字节落地）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })),
    );
    await expect(openAiWireAdapter.stream(REQUEST, CTX, collect().listener)).rejects.toMatchObject({
      kind: 'AUTH',
      status: 401,
    });
  });

  it('已经拿到 200 之后正文中断 → SENT_OUTCOME_UNKNOWN，默认不可重发', async () => {
    /*
     * 这条是整个流式路径最要命的一处：判成 NOT_SENT 就会重发一次
     * provider 已经执行并计费的调用。200 已经到手 = 请求确定送达。
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => brokenResponse('data: {"choices":[{"delta":{"content":"半"}}]}\n\n')),
    );

    const { signals, listener } = collect();
    const err = await openAiWireAdapter.stream(REQUEST, CTX, listener).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).sendState).toBe('SENT_OUTCOME_UNKNOWN');
    // 断之前推出去的增量确实到过界面 —— 撤回由 gateway 的 reset 负责，不在这一层
    expect(textOf(signals)).toBe('半');
  });

  it('监听方抛错不影响这次调用 —— 界面画不出来是界面的事', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const res = await openAiWireAdapter.stream(REQUEST, CTX, () => {
      throw new Error('renderer blew up');
    });
    expect(res.content).toEqual([{ type: 'text', text: 'x' }]);
  });
});
