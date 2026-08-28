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
  /**
   * 本轮处理的**输入总量，含缓存读取的部分**。
   *
   * 这是适配器归一化之后的口径，两个 wire 同义 —— 因为两家原始语义相反：
   * OpenAI 的 `prompt_tokens` 本来就含缓存；Anthropic 的 `input_tokens` 明确
   * **不含**（`total = cache_read + cache_creation + input_tokens`）。
   * 不归一化的话，Anthropic 侧一开缓存就会把总量记成"缓存断点之后那几十个 token"，
   * 而这个数直接进预算账本 —— 止损会失灵。
   */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * 上面这个输入总量里**命中前缀缓存**的部分（provider 报什么记什么）。
   *
   * 为什么要单列：多轮 agent 循环每一轮都把整段历史重发一遍 —— 实测
   * `run_074bde20…` 12 轮累计输入 218453 token，绝大部分是重复前缀。
   * 这些 token 在支持前缀缓存的 provider（如 DeepSeek 自动缓存、Anthropic 显式
   * cache_control）上按远低于常规输入的价格计费。只报一个 `inputTokens` 总数，
   * 等于把"实际计费构成"抹平成一个看起来更贵的数 —— 对一个以诚实记账立身的产品，
   * 这是**少报事实**，和把未知折算成 0 是同一类问题。
   *
   * 字段缺失或 `null` 都读作"未回报"（**都不等于 0**）。绝不由本地估算填充。
   * 做成可选是为了让既有的测试替身与历史持久化记录保持兼容 —— 没写就是没报。
   */
  readonly cacheReadTokens?: number | null;
  /** 为写入缓存而付费的输入 token（Anthropic `cache_creation_input_tokens`）；null = 未回报 */
  readonly cacheWriteTokens?: number | null;
}

export type ModelCallErrorKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'NETWORK'
  | 'CANCELLED'
  /** 单次尝试超时（per-attempt deadline）。发出去之后超时结局不明，默认不可重发 */
  | 'TIMEOUT'
  | 'PARSE';

export class ModelCallError extends Error {
  /** 失败发生在请求生命周期的哪一段；重试安全性由它决定，见 retry.ts */
  readonly sendState: import('@shared/domain').ModelSendState | null;
  /** 429 响应头 Retry-After 换算的毫秒数；没有或解析不出为 null */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    readonly kind: ModelCallErrorKind,
    readonly status: number | null = null,
    opts: {
      sendState?: import('@shared/domain').ModelSendState | null;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    // 有 HTTP 状态码 = 对端确实回了话
    this.sendState = opts.sendState ?? (status !== null ? 'RESPONDED' : null);
    this.retryAfterMs = opts.retryAfterMs ?? null;
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
 * 检查 role 是否严格交替。
 *
 * Anthropic 明确要求 user / assistant 交替，连续两条同角色会返回
 * `roles must alternate between "user" and "assistant"`（同样是 400）。
 * OpenAI 兼容端对此宽容 —— 所以这条只在 Anthropic 上炸，更容易漏。
 *
 * 这个坑是补 tool_result 时自己造出来的：规划期提交计划后先回填 tool_result（user），
 * 紧接着又 push 审批通知（user）。修 A（孤儿 tool_use）顺手制造了 B。
 *
 * 返回 null 表示合法。
 */
export function findRoleAlternationViolation(messages: readonly ModelMessage[]): string | null {
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]!.role === messages[i - 1]!.role) {
      return `messages[${i - 1}] 与 messages[${i}] 都是 ${messages[i]!.role} —— role 必须交替`;
    }
  }
  return null;
}

/** 出站前的消息序列体检：孤儿 tool_use + role 交替。返回 null 表示合法。 */
export function findWireViolation(messages: readonly ModelMessage[]): string | null {
  return findOrphanToolUse(messages) ?? findRoleAlternationViolation(messages);
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
