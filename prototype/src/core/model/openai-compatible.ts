import { fetchJson } from './anthropic';
import {
  type AdapterCallContext,
  type ContentBlock,
  ModelCallError,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
} from './types';

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 自动前缀缓存的口径 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** OpenAI 标准口径 */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * OpenAI Chat Completions 协议族适配器。
 *
 * 一个实例服务**所有** OpenAI 兼容端点 —— 官方、国内厂商、中转站都走这里。
 * 它们共享协议实现，但不共享信任：origin、凭据 audience、数据处理方
 * 由各自的 profile 决定，每次调用由 `ctx.baseUrl` 指定去哪。
 */
export const openAiWireAdapter: ModelAdapter = {
  wire: 'openai',

  async call(request: ModelRequest, ctx: AdapterCallContext): Promise<ModelResponse> {
    const messages: WireMessage[] = [{ role: 'system', content: request.system }];
    for (const m of request.messages) messages.push(...toWireMessages(m));

    const body = {
      model: ctx.modelId,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    };

    const raw = await fetchJson(`${ctx.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });

    const data = raw as ChatResponse;
    if (data.error) throw new ModelCallError(data.error.message ?? '返回错误', 'BAD_REQUEST');

    const choice = data.choices?.[0];
    if (!choice) throw new ModelCallError('响应中没有 choices', 'PARSE');

    const content: ContentBlock[] = [];
    const text = choice.message?.content;
    if (typeof text === 'string' && text.trim()) content.push({ type: 'text', text });

    for (const call of choice.message?.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      let input: unknown = {};
      const rawArgs = call.function?.arguments ?? '';
      if (rawArgs.trim()) {
        try {
          input = JSON.parse(rawArgs);
        } catch {
          // 不做 JSON 修复、不 fallback 成 {}：把畸形参数原样上报，
          // 让 Tool Gateway 用 schema 校验判定为 FAILED（PRD-RUN-002）
          input = { __malformed_arguments__: rawArgs.slice(0, 500) };
        }
      }
      content.push({ type: 'tool_use', id: call.id ?? `call_${content.length}`, name, input });
    }

    return {
      content,
      stopReason: mapStop(choice.finish_reason, content),
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      /*
       * 两家口径都认：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用
       * prompt_tokens_details.cached_tokens。都没有 = 未回报(null)，不是 0 ——
       * 这个 provider 可能根本没有前缀缓存，也可能有但没告诉我们，两者都不该显示成"0 命中"。
       */
      cacheReadTokens:
        data.usage?.prompt_cache_hit_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens ?? null,
      // OpenAI 兼容侧没有"为写缓存付费"的概念，恒为未回报
      cacheWriteTokens: null,
    };
  },
};

function toWireMessages(m: ModelMessage): WireMessage[] {
  const out: WireMessage[] = [];
  const texts = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
  const toolUses = m.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
  const toolResults = m.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );

  if (m.role === 'assistant') {
    out.push({
      role: 'assistant',
      content: texts.length ? texts.map((t) => t.text).join('\n') : null,
      ...(toolUses.length
        ? {
            tool_calls: toolUses.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
            })),
          }
        : {}),
    });
    return out;
  }

  // user 侧：tool_result 必须变成独立的 role:'tool' 消息，且要排在文本之前
  for (const r of toolResults) {
    out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
  }
  if (texts.length) {
    out.push({ role: 'user', content: texts.map((t) => t.text).join('\n') });
  }
  return out;
}

function mapStop(reason: string | undefined, content: readonly ContentBlock[]): StopReason {
  if (content.some((b) => b.type === 'tool_use')) return 'TOOL_USE';
  switch (reason) {
    case 'tool_calls':
      return 'TOOL_USE';
    case 'stop':
      return 'END_TURN';
    case 'length':
      return 'MAX_TOKENS';
    default:
      return 'OTHER';
  }
}