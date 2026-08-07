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
