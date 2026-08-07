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

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new ModelCallError('调用已取消', 'CANCELLED');
    throw new ModelCallError(`网络错误: ${e.message}`, 'NETWORK');
  }

  const text = await res.text();

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
    throw new ModelCallError(`HTTP ${res.status}: ${summarizeError(text)}`, kind, res.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ModelCallError('响应不是合法 JSON', 'PARSE', res.status);
  }
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
