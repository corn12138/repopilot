import type { ModelVendor, VendorParity } from '@shared/domain';

/**
 * 厂商推断：回答"这条模型路由背后的模型出自谁家"。
 *
 * 动机（A2A 评审 §4.4 点名的洞）：异构断言此前只认得 providerId 为 'anthropic' /
 * 'openai' 的两个字符串，走中转（openrouter / aihubmix / …）时一律"推不出 → 跳过"，
 * 于是 openrouter 上的 claude 模型配 Claude CLI 审核这种**可以证明**的同厂商组合
 * 被静默放行，绑定处还把 heterogeneous 硬编码成 true —— 把"没查"写成了"已证异构"。
 *
 * 证据优先级（高 → 低）：
 *   1. 模型 id 的命名空间前缀（`anthropic/claude-…` 的 `anthropic`）—— 中转站的
 *      路由标识，就是它们自己声明的上游厂商；
 *   2. 模型名的家族前缀（`claude-…` / `gpt-…` / `kimi-…`）—— 家族名是厂商的商标性
 *      命名，跨托管方稳定。它排在 provider 归属之前：火山方舟（BYTEDANCE）上托管的
 *      `deepseek-v3` 属 DeepSeek 家族，不属字节；
 *   3. **单一厂商**官方 provider 的归属（anthropic 官方只服务自家模型）。多厂商官方
 *      站（火山方舟、阿里百炼托管第三方模型）不在此表 —— 它们只能靠 1/2 给证据。
 *
 * 三条都给不出证据就是 UNKNOWN，带原因返回。判定处拿到 UNKNOWN 必须落成
 * UNVERIFIABLE 如实披露，不许折成任何一边。
 */
export type VendorInference =
  | { readonly kind: 'KNOWN'; readonly vendor: ModelVendor; readonly evidence: string }
  | { readonly kind: 'UNKNOWN'; readonly reason: string };

/** 推断的一侧：label 由调用方带角色写全（"实现方 …"/"外部作者 …"/"审核方 …"） */
export interface VendorSide {
  readonly label: string;
  readonly inference: VendorInference;
}

const VENDOR_LABEL: Readonly<Record<ModelVendor, string>> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
  GOOGLE: 'Google',
  META: 'Meta',
  MISTRAL: 'Mistral',
  XAI: 'xAI',
  DEEPSEEK: 'DeepSeek',
  MOONSHOT: 'Moonshot',
  ZHIPU: '智谱',
  ALIBABA: '阿里（通义）',
  BYTEDANCE: '字节（豆包）',
  MINIMAX: 'MiniMax',
};

export function vendorLabel(v: ModelVendor): string {
  return VENDOR_LABEL[v];
}

/**
 * 模型 id 命名空间 → 厂商。键是各中转站实际在用的路由前缀（内置注册表里都出现过），
 * 全小写比对。收录标准：前缀无歧义地属于一家 —— 拿不准的不进表，走 UNKNOWN。
 */
const NAMESPACE_VENDOR: Readonly<Record<string, ModelVendor>> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  google: 'GOOGLE',
  'meta-llama': 'META',
  mistralai: 'MISTRAL',
  'x-ai': 'XAI',
  xai: 'XAI',
  deepseek: 'DEEPSEEK',
  'deepseek-ai': 'DEEPSEEK',
  moonshot: 'MOONSHOT',
  moonshotai: 'MOONSHOT',
  zhipuai: 'ZHIPU',
  'zai-org': 'ZHIPU',
  thudm: 'ZHIPU',
  qwen: 'ALIBABA',
  bytedance: 'BYTEDANCE',
  minimax: 'MINIMAX',
  minimaxai: 'MINIMAX',
};

/** 模型名的家族前缀 → 厂商。对 id 的最后一段（去掉命名空间后）做前缀匹配 */
const FAMILY_PATTERNS: readonly { readonly re: RegExp; readonly vendor: ModelVendor }[] = [
  { re: /^claude([.\-_]|\d|$)/, vendor: 'ANTHROPIC' },
  { re: /^(gpt|chatgpt|codex|davinci)([.\-_]|\d|$)/, vendor: 'OPENAI' },
  // o 系列单独收窄：只认 o+一位数字 开头（o1 / o3 / o4-mini），避免把任意 o 开头的名字吃进来
  { re: /^o[0-9]([.\-_]|$)/, vendor: 'OPENAI' },
  { re: /^(gemini|gemma)([.\-_]|\d|$)/, vendor: 'GOOGLE' },
  { re: /^llama([.\-_]|\d|$)/, vendor: 'META' },
  { re: /^(mistral|ministral|codestral|magistral|devstral|pixtral)([.\-_]|\d|$)/, vendor: 'MISTRAL' },
  { re: /^grok([.\-_]|\d|$)/, vendor: 'XAI' },
  { re: /^deepseek([.\-_]|\d|$)/, vendor: 'DEEPSEEK' },
  { re: /^kimi([.\-_]|\d|$)/, vendor: 'MOONSHOT' },
  { re: /^(glm|chatglm)([.\-_]|\d|$)/, vendor: 'ZHIPU' },
  { re: /^(qwen|qwq|qvq)([.\-_]|\d|$)/, vendor: 'ALIBABA' },
  { re: /^doubao([.\-_]|\d|$)/, vendor: 'BYTEDANCE' },
  { re: /^(minimax|abab)([.\-_]|\d|$)/, vendor: 'MINIMAX' },
];

/**
 * **单一厂商**官方 provider → 厂商。只收"这个官方站不托管别家模型"的：
 * dashscope / volcengine 托管第三方模型，故意不在表里。
 */
const SINGLE_VENDOR_OFFICIAL: Readonly<Record<string, ModelVendor>> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  deepseek: 'DEEPSEEK',
  'moonshot-cn': 'MOONSHOT',
  zhipuai: 'ZHIPU',
  xai: 'XAI',
};

export function inferModelVendor(input: {
  readonly providerId: string;
  /** ProviderDescriptor.kind；provider 已被删除等取不到时传 null（此时不做官方归属回落） */
  readonly providerKind: 'OFFICIAL' | 'RELAY' | 'CUSTOM' | null;
  readonly modelId: string;
}): VendorInference {
  const modelId = input.modelId.trim();
  const segments = modelId.split('/').filter((s) => s.length > 0);
  const namespace = segments.length > 1 ? segments[0]!.toLowerCase() : null;
  const name = (segments[segments.length - 1] ?? '').toLowerCase();

  if (namespace) {
    const byNamespace = NAMESPACE_VENDOR[namespace];
    if (byNamespace) {
      return {
        kind: 'KNOWN',
        vendor: byNamespace,
        evidence: `模型 ${modelId} 的命名空间 ${namespace} 属 ${vendorLabel(byNamespace)}`,
      };
    }
  }
  for (const p of FAMILY_PATTERNS) {
    if (p.re.test(name)) {
      return {
        kind: 'KNOWN',
        vendor: p.vendor,
        evidence: `模型名 ${name} 属 ${vendorLabel(p.vendor)} 家族`,
      };
    }
  }
  if (input.providerKind === 'OFFICIAL') {
    const byProvider = SINGLE_VENDOR_OFFICIAL[input.providerId];
    if (byProvider) {
      return {
        kind: 'KNOWN',
        vendor: byProvider,
        evidence: `官方 provider ${input.providerId} 只服务 ${vendorLabel(byProvider)} 自家模型`,
      };
    }
  }
  const kindLabel =
    input.providerKind === 'OFFICIAL'
      ? '官方'
      : input.providerKind === 'RELAY'
        ? '中转'
        : input.providerKind === 'CUSTOM'
          ? '自定义'
          : '类型未知的';
  return {
    kind: 'UNKNOWN',
    reason: `${kindLabel} provider ${input.providerId} 的模型 ${modelId || '（空）'} 不属于任何已知模型家族，厂商无法证明`,
  };
}

/** 本机 CLI 连接器这类身份确定的选手：厂商由静态描述符给出，不需要推断 */
export function knownVendorSide(input: {
  readonly label: string;
  readonly vendor: ModelVendor;
  readonly evidence: string;
}): VendorSide {
  return {
    label: input.label,
    inference: { kind: 'KNOWN', vendor: input.vendor, evidence: input.evidence },
  };
}

/**
 * 由写审两侧的推断结果得出三态判定。
 * 规则只有一条：**两侧都有证据才允许下同/异的结论**；任何一侧 UNKNOWN → UNVERIFIABLE，
 * 并把归不出来的原因原样写进 detail —— 披露"无法判定"也得说清为什么。
 */
export function vendorParityOf(writer: VendorSide, reviewer: VendorSide): VendorParity {
  if (writer.inference.kind === 'KNOWN' && reviewer.inference.kind === 'KNOWN') {
    if (writer.inference.vendor === reviewer.inference.vendor) {
      return {
        kind: 'SAME_VENDOR',
        detail:
          `${writer.label} 与 ${reviewer.label} 同属 ${vendorLabel(writer.inference.vendor)}` +
          `（${writer.inference.evidence}；${reviewer.inference.evidence}）`,
      };
    }
    return {
      kind: 'HETEROGENEOUS',
      detail:
        `${writer.label} 属 ${vendorLabel(writer.inference.vendor)}（${writer.inference.evidence}），` +
        `${reviewer.label} 属 ${vendorLabel(reviewer.inference.vendor)}（${reviewer.inference.evidence}）`,
    };
  }
  const gaps: string[] = [];
  if (writer.inference.kind === 'UNKNOWN') gaps.push(`${writer.label}：${writer.inference.reason}`);
  if (reviewer.inference.kind === 'UNKNOWN') gaps.push(`${reviewer.label}：${reviewer.inference.reason}`);
  return { kind: 'UNVERIFIABLE', detail: gaps.join('；') };
}
