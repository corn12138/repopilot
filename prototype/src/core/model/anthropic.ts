import {
  type AdapterCallContext,
  type ContentBlock,
  ModelCallError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type StreamListener,
} from './types';
import { causeCode, httpErrorKind, parseRetryAfterMs, sendStateForNetworkError, summarizeError } from './http';
import { emitDelta, openSse, parseJsonFrame, readSse } from './stream';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** 显式 cache_control 命中时才出现 */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

/** 请求体。流式与非流式只差一个 `stream` 开关，其余逐字段相同 —— 分开写必漂。 */
function requestBody(request: ModelRequest, ctx: AdapterCallContext, stream: boolean): unknown {
  return {
    model: ctx.modelId,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    system: request.system,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content.map(toAnthropicBlock),
    })),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function headersFor(ctx: AdapterCallContext, stream: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': ctx.apiKey,
    'anthropic-version': '2023-06-01',
    ...(stream ? { accept: 'text/event-stream' } : {}),
  };
}

export const anthropicAdapter: ModelAdapter = {
  wire: 'anthropic',

  async call(request: ModelRequest, ctx: AdapterCallContext): Promise<ModelResponse> {
    const res = await fetchJson(`${ctx.baseUrl}/messages`, {
      method: 'POST',
      headers: headersFor(ctx, false),
      body: JSON.stringify(requestBody(request, ctx, false)),
      signal: ctx.signal,
    });

    const data = res as AnthropicResponse;
    if (data.error) {
      throw new ModelCallError(data.error.message ?? 'Anthropic 返回错误', 'BAD_REQUEST');
    }

    const content: ContentBlock[] = (data.content ?? []).flatMap((b): ContentBlock[] => {
      if (b.type === 'text' && typeof b.text === 'string') return [{ type: 'text', text: b.text }];
      if (b.type === 'tool_use' && b.id && b.name) {
        return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }];
      }
      return [];
    });

    /*
     * ⚠️ Anthropic 的 input_tokens 与 OpenAI 的 prompt_tokens **语义相反**。
     *
     * 官方文档（platform.claude.com/docs/en/build-with-claude/prompt-caching）逐字：
     *   input_tokens: "Number of input tokens which were **not** read from or used to
     *                  create a cache (that is, tokens after the last cache breakpoint)"
     *   total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
     * 文档给的例子：缓存读 100000 + 新建 0 + 用户消息 50 → 总输入 **100050**。
     *
     * 也就是说 Anthropic 是**相加**，OpenAI 兼容侧的 prompt_tokens 是**含缓存的总数**。
     * 如果照搬 input_tokens 当"本轮输入"，缓存一生效就会把 100050 记成 50 ——
     * 而这个数直接进预算账本（agent.ts 的 chargeModelTurn），
     * 那是一个**会失灵的止损**：预算永远花不完，Run 不会因超限而停。
     *
     * 今天我们不发 cache_control 所以两个缓存字段恒为 0/缺失、总数等于 input_tokens；
     * 但中转商可以替我们开启，将来我们自己也可能开 —— 所以在适配器边界就归一化：
     * **对外的 inputTokens 一律是"本轮处理的输入总量（含缓存读）"**，
     * 两个 wire 从此同义，上层不必知道各家口径。
     *
     * 求和时把缺失的缓存字段按 0 计：在 Anthropic 的契约里它们报告的是缓存活动，
     * 没有活动就没有这部分 token。但**对外报告的 cacheReadTokens 仍保留 null**
     * （未回报 ≠ 命中 0）—— 求和用的 0 和展示用的"未知"是两件事。
     */
    return {
      content,
      stopReason: mapStop(data.stop_reason),
      ...normalizeUsage(data.usage),
    };
  },

  async stream(
    request: ModelRequest,
    ctx: AdapterCallContext,
    onSignal: StreamListener,
  ): Promise<ModelResponse> {
    const res = await openSse(`${ctx.baseUrl}/messages`, {
      method: 'POST',
      headers: headersFor(ctx, true),
      body: JSON.stringify(requestBody(request, ctx, true)),
      signal: ctx.signal,
    });

    /*
     * 按 index 重建内容块。Anthropic 的流是「块开始 → 若干增量 → 块结束」，
     * 工具参数以 `input_json_delta.partial_json` 分片到达，必须**拼完整**再解析：
     * 半截 JSON 解析失败就当成畸形参数上报，那会把一次本来正常的调用记成失败。
     */
    const blocks = new Map<number, { type: string; id?: string; name?: string; text: string; json: string }>();
    let stopReason: string | undefined;
    const usage: NonNullable<AnthropicResponse['usage']> = {};
    let sawError: string | null = null;

    for await (const chunk of readSse(res)) {
      const frame = parseJsonFrame(chunk);
      if (!frame) continue;
      const type = String(frame.type ?? chunk.event ?? '');

      if (type === 'error') {
        const err = frame.error as { message?: string } | undefined;
        sawError = err?.message ?? 'Anthropic 流中返回错误';
        break;
      }

      if (type === 'message_start') {
        const message = frame.message as { usage?: AnthropicResponse['usage'] } | undefined;
        Object.assign(usage, message?.usage ?? {});
        continue;
      }

      if (type === 'content_block_start') {
        const index = Number(frame.index ?? 0);
        const block = frame.content_block as AnthropicBlock | undefined;
        blocks.set(index, {
          type: String(block?.type ?? 'text'),
          ...(block?.id ? { id: block.id } : {}),
          ...(block?.name ? { name: block.name } : {}),
          text: typeof block?.text === 'string' ? block.text : '',
          json: '',
        });
        continue;
      }

      if (type === 'content_block_delta') {
        const index = Number(frame.index ?? 0);
        const slot = blocks.get(index);
        if (!slot) continue;
        const delta = frame.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          slot.text += delta.text;
          emitDelta(onSignal, delta.text);
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          slot.json += delta.partial_json;
        }
        continue;
      }

      if (type === 'message_delta') {
        const delta = frame.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        // 输出 token 只在这一帧给出；输入 token 在 message_start
        Object.assign(usage, (frame.usage as AnthropicResponse['usage']) ?? {});
        continue;
      }
    }

    if (sawError) throw new ModelCallError(sawError, 'BAD_REQUEST', null, { sendState: 'SENT_OUTCOME_UNKNOWN' });

    const content: ContentBlock[] = [];
    for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
      const slot = blocks.get(index)!;
      if (slot.type === 'text') {
        if (slot.text) content.push({ type: 'text', text: slot.text });
      } else if (slot.type === 'tool_use' && slot.id && slot.name) {
        content.push({ type: 'tool_use', id: slot.id, name: slot.name, input: parseToolInput(slot.json) });
      }
    }

    return { content, stopReason: mapStop(stopReason), ...normalizeUsage(usage) };
  },
};

/**
 * 工具参数按分片拼回来之后再解析。
 *
 * 与非流式同一条底线：**不做 JSON 修复、不 fallback 成 `{}`** —— 畸形参数原样上报，
 * 由 Tool Gateway 的 schema 校验判成 FAILED（PRD-RUN-002）。悄悄补成空对象
 * 会让一次参数错误变成一次"参数为空的正常调用"。
 */
function parseToolInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { __malformed_arguments__: json.slice(0, 500) };
  }
}

/*
 * ⚠️ Anthropic 的 input_tokens 与 OpenAI 的 prompt_tokens **语义相反** ——
 * 详见 call() 里那段长注释。归一化只有这一处实现：流式与非流式共用，
 * 复制一份就会漂，而漂的后果是预算止损失灵。
 */
function normalizeUsage(usage: AnthropicResponse['usage']): Pick<
  ModelResponse,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
> {
  const cacheRead = usage?.cache_read_input_tokens ?? null;
  const cacheWrite = usage?.cache_creation_input_tokens ?? null;
  const rawInput = usage?.input_tokens ?? null;
  return {
    inputTokens: rawInput === null ? null : rawInput + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: usage?.output_tokens ?? null,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function toAnthropicBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'TOOL_USE';
    case 'end_turn':
    case 'stop_sequence':
      return 'END_TURN';
    case 'max_tokens':
      return 'MAX_TOKENS';
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------

/**
 * 连接根本没建立起来的错误码 —— 请求确定没离开本机（NOT_SENT），重发是安全的。
 * 其余网络类失败（ECONNRESET / socket hang up / body 中断 / 超时）一律按
 * "发出去了但结局不明"处理：provider 可能已经执行并计费，默认不可重发。
 * 对应 TD model-invocation §4：BEFORE_BYTES 可重试，AFTER_BYTES_UNKNOWN 默认禁止。
 */
export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const e = err as Error;
    // AbortSignal.timeout 的 reason 是 name=TimeoutError 的 DOMException；
    // 不同 undici 版本可能把 reason 原样抛出，也可能包成 AbortError —— 两种都认。
    const signalReason = (init.signal as AbortSignal | null | undefined)?.reason as
      | { name?: string }
      | undefined;
    if (e.name === 'TimeoutError' || signalReason?.name === 'TimeoutError') {
      throw new ModelCallError('单次调用超时（结局不明，不可重发）', 'TIMEOUT', null, {
        sendState: 'SENT_OUTCOME_UNKNOWN',
      });
    }
    if (e.name === 'AbortError') throw new ModelCallError('调用已取消', 'CANCELLED');
    const code = causeCode(err);
    throw new ModelCallError(
      `网络错误: ${e.message}${code ? ` (${code})` : ''}`,
      'NETWORK',
      null,
      { sendState: sendStateForNetworkError(err) },
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // 头都收到了正文断了 —— 请求早已送达，结局不明
    throw new ModelCallError(`读取响应失败: ${(err as Error).message}`, 'NETWORK', null, {
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  }

  if (!res.ok) {
    throw new ModelCallError(
      `HTTP ${res.status}: ${summarizeError(text)}`,
      httpErrorKind(res.status),
      res.status,
      { retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')) },
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ModelCallError('响应不是合法 JSON', 'PARSE', res.status);
  }
}


