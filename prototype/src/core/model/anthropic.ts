import {
  type AdapterCallContext,
  type ContentBlock,
  ModelCallError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
} from './types';

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
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export const anthropicAdapter: ModelAdapter = {
  wire: 'anthropic',

  async call(request: ModelRequest, ctx: AdapterCallContext): Promise<ModelResponse> {
    const body = {
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
    };

    const res = await fetchJson(`${ctx.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
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

    return {
      content,
      stopReason: mapStop(data.stop_reason),
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    };
  },
};

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
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS 握手失败也没把请求发出去；能不能靠重试恢复由 retry 层另行判断
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeCode(err: unknown): string {
  const e = err as { cause?: { code?: unknown }; code?: unknown };
  const c = e?.cause?.code ?? e?.code;
  return typeof c === 'string' ? c : '';
}

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
    const sendState = NOT_SENT_CODES.has(code) ? 'NOT_SENT' : 'SENT_OUTCOME_UNKNOWN';
    throw new ModelCallError(
      `网络错误: ${e.message}${code ? ` (${code})` : ''}`,
      'NETWORK',
      null,
      { sendState },
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
    const kind =
      res.status === 401 || res.status === 403
        ? 'AUTH'
        : res.status === 429
          ? 'RATE_LIMIT'
          : res.status >= 500
            ? 'SERVER'
            : 'BAD_REQUEST';
    // 只回传状态与 provider 的错误摘要，不把整个请求体或 header 带出去
    throw new ModelCallError(`HTTP ${res.status}: ${summarizeError(text)}`, kind, res.status, {
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ModelCallError('响应不是合法 JSON', 'PARSE', res.status);
  }
}

/** 只认秒数形式；HTTP-date 形式少见且时钟相关，解析不出就交给指数退避 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function summarizeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 300);
    return (parsed.error?.message ?? parsed.message ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
