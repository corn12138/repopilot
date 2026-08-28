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
    /** DeepSeek / SiliconFlow 口径（DeepSeek 官方：hit + miss == prompt_tokens） */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** OpenAI / 智谱 / 百炼 / 火山方舟 / xAI / OpenRouter / SiliconFlow 口径 */
    prompt_tokens_details?: {
      cached_tokens?: number;
      /** OpenAI 与 OpenRouter 才有；官方措辞是"未按计费系数调整的原始 token 数" */
      cache_write_tokens?: number;
    };
    /** Moonshot / Kimi：唯一一家把命中数放在 usage **顶层** */
    cached_tokens?: number;
    /** 阿里百炼显式缓存（我方目前不发 cache_control，留作将来） */
    cache_creation?: {
      cache_creation_input_tokens?: number;
      ephemeral_5m_input_tokens?: number;
    };
    /** 中转商原样透传 Anthropic 口径时的防御位（AIHubMix 官方承认不做归一化） */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
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
      /*
       * 注意与 anthropic.ts 的**非对称性**：这里的 prompt_tokens 本来就是含缓存的
       * 总输入（DeepSeek 官方：hit + miss == prompt_tokens；OpenAI：cached ⊂ prompt），
       * 所以**不能**照搬 Anthropic 那边的求和 —— 那边的 input_tokens 明确不含缓存。
       * 同理 cache_write 在这一侧是子集（OpenAI 官方算式
       * ordinary = input − cached − cache_write），也不参与任何求和。
       */
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheReadTokens: reportedTokens(
        data.usage?.prompt_cache_hit_tokens, // DeepSeek / SiliconFlow
        data.usage?.prompt_tokens_details?.cached_tokens, // OpenAI / 智谱 / 百炼 / 方舟 / xAI / OpenRouter
        data.usage?.cached_tokens, // Moonshot：放在 usage 顶层，只认前两个会把它漏成"未回报"
        data.usage?.cache_read_input_tokens, // 中转透传 Anthropic 口径的防御位
      ),
      cacheWriteTokens: reportedTokens(
        data.usage?.prompt_tokens_details?.cache_write_tokens, // OpenAI / OpenRouter
        data.usage?.cache_creation?.cache_creation_input_tokens, // 百炼显式缓存
        data.usage?.cache_creation?.ephemeral_5m_input_tokens,
        data.usage?.cache_creation_input_tokens, // 中转透传
      ),
    };
  },
};

/**
 * 从多个候选字段里取"provider 真的回报了的那个数"。
 *
 * 两条纪律都落在这个函数里：
 *
 * 1. **只有所有候选整体缺席才返回 null**。真实回报的 `0` 必须保留成 `0` ——
 *    "确实 0 命中"和"没告诉我们"是两件事，把前者显示成"未回报"同样是撒谎。
 *
 * 2. **取最大值而不是取第一个非空**。SiliconFlow 是唯一同时声明两套字段的
 *    provider（`prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens`
 *    并存），其中一套可能是未接上游的占位 0；用 `??` 会被这个 0 截断，
 *    于是把真实命中显示成"0 命中"。两套都是真 0 时取 max 仍是 0，不影响正确情形。
 *    ⚠️ SiliconFlow 官方文档没有说明哪套字段对哪些模型有效 —— 取 max 是我方的
 *    防御选择，不是文档背书。
 */
function reportedTokens(...candidates: Array<number | undefined | null>): number | null {
  const reported = candidates.filter((v): v is number => typeof v === 'number');
  return reported.length === 0 ? null : Math.max(...reported);
}

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