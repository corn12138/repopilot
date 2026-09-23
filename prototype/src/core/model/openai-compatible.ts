import { fetchJson } from './anthropic';
import type { StopReason } from '@shared/domain';
import {
  type AdapterCallContext,
  type ContentBlock,
  ModelCallError,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type StreamListener,
} from './types';
import { emitDelta, isDone, openSse, parseJsonFrame, readSse } from './stream';

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
    const raw = await fetchJson(`${ctx.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(ctx, false),
      body: JSON.stringify(requestBody(request, ctx, false)),
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
      ...normalizeUsage(data.usage),
    };
  },

  async stream(
    request: ModelRequest,
    ctx: AdapterCallContext,
    onSignal: StreamListener,
  ): Promise<ModelResponse> {
    const res = await openSse(`${ctx.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(ctx, true),
      // stream_options 让 OpenAI 系在最后一帧补上 usage —— 不要的话整轮没有账本数字
      body: JSON.stringify(requestBody(request, ctx, true)),
      signal: ctx.signal,
    });

    let text = '';
    let finish: string | undefined;
    let usage: ChatResponse['usage'];
    /*
     * tool_calls 按 `index` 累积：函数名通常只在第一帧出现，
     * `arguments` 分很多帧到达，必须拼完整再解析 —— 半截 JSON 会被当成畸形参数，
     * 把一次本来正常的调用记成失败。
     */
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of readSse(res)) {
      if (isDone(chunk)) break;
      const frame = parseJsonFrame(chunk);
      if (!frame) continue;

      const err = frame.error as { message?: string } | undefined;
      if (err) {
        throw new ModelCallError(err.message ?? '流中返回错误', 'BAD_REQUEST', null, {
          sendState: 'SENT_OUTCOME_UNKNOWN',
        });
      }

      // usage 可能出现在任意一帧（多数在最后一帧，choices 为空）
      if (frame.usage) usage = frame.usage as ChatResponse['usage'];

      const choice = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;

      const delta = choice.delta as
        | { content?: string | null; tool_calls?: Array<Record<string, unknown>> }
        | undefined;
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content;
        emitDelta(onSignal, delta.content);
      }
      for (const raw of delta?.tool_calls ?? []) {
        const index = typeof raw.index === 'number' ? raw.index : 0;
        const fn = raw.function as { name?: string; arguments?: string } | undefined;
        const slot = calls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof raw.id === 'string' && raw.id) slot.id = raw.id;
        if (fn?.name) slot.name = fn.name;
        if (typeof fn?.arguments === 'string') slot.args += fn.arguments;
        calls.set(index, slot);
      }
    }

    const content: ContentBlock[] = [];
    if (text.trim()) content.push({ type: 'text', text });
    for (const index of [...calls.keys()].sort((a, b) => a - b)) {
      const slot = calls.get(index)!;
      // 没有函数名的槽位不是工具调用，是没拼完的噪声 —— 不硬造一个调用出来
      if (!slot.name) continue;
      content.push({
        type: 'tool_use',
        id: slot.id || `call_${index}`,
        name: slot.name,
        input: parseToolArguments(slot.args),
      });
    }

    return { content, stopReason: mapStop(finish, content), ...normalizeUsage(usage) };
  },
};

/** 请求体。流式与非流式只差 `stream`/`stream_options`，其余逐字段相同 —— 分开写必漂。 */
function requestBody(request: ModelRequest, ctx: AdapterCallContext, stream: boolean): unknown {
  const messages: WireMessage[] = [{ role: 'system', content: request.system }];
  for (const m of request.messages) messages.push(...toWireMessages(m));
  return {
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
    /*
     * `include_usage` 不加的话，OpenAI 系流式**整轮都不回报 usage** ——
     * 账本会把每一轮都记成"未知用量轮"，预算止损随之失灵。
     * 不认识这个字段的兼容端会忽略它（它在 stream_options 下，不是顶层未知字段）。
     */
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

function headersFor(ctx: AdapterCallContext, stream: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${ctx.apiKey}`,
    ...(stream ? { accept: 'text/event-stream' } : {}),
  };
}

/**
 * 工具参数解析。与非流式同一条底线：**不做 JSON 修复、不 fallback 成 `{}`** ——
 * 畸形参数原样上报，由 Tool Gateway 的 schema 校验判成 FAILED（PRD-RUN-002）。
 */
function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __malformed_arguments__: raw.slice(0, 500) };
  }
}

/*
 * 缓存口径的归一化。流式与非流式共用这一份 —— 复制会漂，而漂的后果是
 * 账本少报或多报实际计费构成。
 *
 * 注意与 anthropic.ts 的**非对称性**：这里的 prompt_tokens 本来就是含缓存的
 * 总输入（DeepSeek 官方：hit + miss == prompt_tokens；OpenAI：cached ⊂ prompt），
 * 所以**不能**照搬 Anthropic 那边的求和 —— 那边的 input_tokens 明确不含缓存。
 * 同理 cache_write 在这一侧是子集（OpenAI 官方算式
 * ordinary = input − cached − cache_write），也不参与任何求和。
 */
function normalizeUsage(usage: ChatResponse['usage']): Pick<
  ModelResponse,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
> {
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    cacheReadTokens: reportedTokens(
      usage?.prompt_cache_hit_tokens, // DeepSeek / SiliconFlow
      usage?.prompt_tokens_details?.cached_tokens, // OpenAI / 智谱 / 百炼 / 方舟 / xAI / OpenRouter
      usage?.cached_tokens, // Moonshot：放在 usage 顶层，只认前两个会把它漏成"未回报"
      usage?.cache_read_input_tokens, // 中转透传 Anthropic 口径的防御位
    ),
    cacheWriteTokens: reportedTokens(
      usage?.prompt_tokens_details?.cache_write_tokens, // OpenAI / OpenRouter
      usage?.cache_creation?.cache_creation_input_tokens, // 百炼显式缓存
      usage?.cache_creation?.ephemeral_5m_input_tokens,
      usage?.cache_creation_input_tokens, // 中转透传
    ),
  };
}

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

// 内容推断仅兼容已知的 stop + tool_calls；未知、缺失或截断的结束原因不能证明意图完整。
// 保留解析出的工具供上层回填“未执行”，但不能因此把停止原因升级为可执行。
function mapStop(reason: string | undefined, content: readonly ContentBlock[]): StopReason {
  if (reason === 'length') return 'MAX_TOKENS';
  switch (reason) {
    case 'tool_calls':
      return 'TOOL_USE';
    case 'stop':
      return content.some((b) => b.type === 'tool_use') ? 'TOOL_USE' : 'END_TURN';
    default:
      return 'OTHER';
  }
}
