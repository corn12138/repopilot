import type { ProviderId } from '@shared/domain';

/** 供应商中立的内容块。适配器负责翻译成各家线上格式。 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ContentBlock[];
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSchema[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export type StopReason = 'TOOL_USE' | 'END_TURN' | 'MAX_TOKENS' | 'OTHER';

export interface ModelResponse {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'AUTH'
      | 'RATE_LIMIT'
      | 'BAD_REQUEST'
      | 'SERVER'
      | 'NETWORK'
      | 'CANCELLED'
      | 'PARSE',
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * 适配器按**线上协议方言**划分，而不是按 provider —— 一个 openai 适配器服务
 * 所有 OpenAI 兼容端点。这与参考 CLI 的 `apiFormat` 分派同构
 * （`src/provider/providers/utils.ts:144-188`）。
 *
 * 去哪由 Gateway 解析后通过 `ctx.baseUrl` 传入，适配器自己不决定目标地址。
 */
export interface ModelAdapter {
  readonly wire: 'anthropic' | 'openai';
  call(request: ModelRequest, ctx: AdapterCallContext): Promise<ModelResponse>;
}

export interface AdapterCallContext {
  readonly apiKey: string;
  readonly modelId: string;
  readonly signal: AbortSignal;
  /**
   * 本次调用的完整 base URL（含版本路径），例如
   * `https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4`。
   *
   * 来自 Gateway 解析（用户覆盖 > 环境变量 > 描述符默认）；已冻结的 Attempt
   * 用的是**冻结当时**的值。适配器只在其后拼端点，不自己决定去哪。
   */
  readonly baseUrl: string;
}

export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function toolUsesOf(
  content: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  return content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

/**
 * 检查消息序列是否满足两家 wire 共同的硬性要求：
 * **每条含 tool_use 的 assistant 消息，下一条消息必须回填全部 toolUseId。**
 *
 * Anthropic 返回 `tool_use ids were found without tool_result blocks immediately after`，
 * OpenAI 兼容端返回 `An assistant message with 'tool_calls' must be followed by tool messages`。
 * 两者都是 400，且**在整个 conversation 上检查** —— 一条历史遗留的孤儿会让此后
 * 每一次请求都失败，而不只是产生它的那一次。
 *
 * 所以这不是"发出去再看"的事情，得在出站前拦住：provider 的 400 只会被归类成
 * BAD_REQUEST 加一句供应商原文，定位不到是我们自己拼错了历史。
 *
 * 返回 null 表示合法，否则返回可直接展示的原因。
 */
export function findOrphanToolUse(messages: readonly ModelMessage[]): string | null {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const uses = toolUsesOf(msg.content);
    if (uses.length === 0) continue;

    const next = messages[i + 1];
    const answered = new Set(
      (next?.content ?? [])
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.toolUseId),
    );
    const orphans = uses.filter((u) => !answered.has(u.id));
    if (orphans.length === 0) continue;

    const which = orphans.map((u) => `${u.name}(${u.id})`).join(', ');
    return next
      ? `messages[${i}] 的 tool_use 未被 messages[${i + 1}] 回填：${which}`
      : `messages[${i}] 的 tool_use 后没有任何消息：${which}`;
  }
  return null;
}
