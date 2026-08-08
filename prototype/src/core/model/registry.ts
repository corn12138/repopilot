import { join } from 'node:path';
import { PATHS } from '../paths';
import { readJson, writeJsonAtomic } from '../store';

/**
 * Provider 注册表。
 *
 * 结构与合并策略参考 `temp/neovate-code`：
 *   - 描述符形状对应 `src/provider/providers/types.ts` 的 `Provider`
 *   - 「内置表 + 用户自定义合并，自定义覆盖内置」对应 `src/provider/model.ts:78-89` 的 `mergeProviders`
 *   - 「缺省走 OpenAI 协议」对应 `model.ts:274-310` 的 `normalizeProviders`
 *
 * 与 CLI 的差别只有一处：那边把 API key 一起写进配置，这里配置只存非机密字段，
 * 凭据由 Main 用系统钥匙串加密保管。
 */
export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  /** 完整 base URL，**包含版本路径**。适配器只在其后拼接端点。 */
  readonly api: string;
  /** 凭据环境变量，按顺序取第一个有值的 */
  readonly env: readonly string[];
  /** base URL 覆盖环境变量 */
  readonly apiEnv: readonly string[];
  readonly doc: string;
  /** 线上协议方言；缺省 openai */
  readonly wire: 'anthropic' | 'openai';
  readonly models: readonly string[];
  readonly defaultModel: string;
  /**
   * OFFICIAL —— 模型厂商自己的 API
   * RELAY    —— 第三方聚合/中转，你的代码会经过它
   * CUSTOM   —— 用户自己加的
   */
  readonly kind: 'OFFICIAL' | 'RELAY' | 'CUSTOM';
  readonly builtIn: boolean;
}

type BuiltIn = Omit<ProviderDescriptor, 'builtIn' | 'defaultModel' | 'wire' | 'kind'> & {
  wire?: 'anthropic' | 'openai';
  kind?: ProviderDescriptor['kind'];
  defaultModel?: string;
};

const BUILT_IN: BuiltIn[] = [
  {
    id: 'anthropic',
    name: 'Anthropic 官方',
    api: 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEY'],
    apiEnv: ['ANTHROPIC_API_BASE', 'ANTHROPIC_BASE_URL'],
    doc: 'https://console.anthropic.com/settings/keys',
    wire: 'anthropic',
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    api: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    apiEnv: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    doc: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o3', 'o4-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    api: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    apiEnv: ['DEEPSEEK_API_BASE', 'DEEPSEEK_BASE_URL'],
    doc: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'moonshot-cn',
    name: 'Moonshot / Kimi',
    api: 'https://api.moonshot.cn/v1',
    env: ['MOONSHOT_API_KEY'],
    apiEnv: ['MOONSHOT_API_BASE'],
    doc: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
      'kimi-k2-thinking',
      'kimi-latest',
    ],
  },
  {
    id: 'zhipuai',
    name: '智谱 AI (GLM)',
    api: 'https://open.bigmodel.cn/api/paas/v4',
    env: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'],
    apiEnv: ['ZHIPU_API_BASE'],
    doc: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'],
  },
  {
    id: 'dashscope',
    name: '阿里百炼 (通义)',
    api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: ['DASHSCOPE_API_KEY'],
    apiEnv: ['DASHSCOPE_API_BASE'],
    doc: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    models: ['qwen3-coder-plus', 'qwen3-max', 'qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'volcengine',
    name: '火山方舟 (豆包)',
    api: 'https://ark.cn-beijing.volces.com/api/v3',
    env: ['VOLCENGINE_API_KEY', 'ARK_API_KEY'],
    apiEnv: ['VOLCENGINE_API_BASE'],
    doc: 'https://console.volcengine.com/ark',
    models: ['doubao-seed-1-6-250615', 'deepseek-v3-1-250821', 'kimi-k2-250905'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    api: 'https://api.siliconflow.cn/v1',
    env: ['SILICONFLOW_API_KEY'],
    apiEnv: ['SILICONFLOW_API_BASE'],
    doc: 'https://cloud.siliconflow.cn/account/ak',
    kind: 'RELAY',
    models: [
      'deepseek-ai/DeepSeek-V3.1',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'moonshotai/Kimi-K2-Instruct-0905',
      'zai-org/GLM-4.5',
    ],
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    api: 'https://api-inference.modelscope.cn/v1',
    env: ['MODELSCOPE_API_KEY'],
    apiEnv: ['MODELSCOPE_API_BASE'],
    doc: 'https://modelscope.cn/my/myaccesstoken',
    kind: 'RELAY',
    models: [
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'deepseek-ai/DeepSeek-V3.2',
      'ZhipuAI/GLM-4.6',
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY'],
    apiEnv: ['OPENROUTER_API_BASE'],
    doc: 'https://openrouter.ai/keys',
    kind: 'RELAY',
    models: [
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.5',
      'openai/gpt-5.1',
      'deepseek/deepseek-chat-v3.1',
      'moonshotai/kimi-k2',
    ],
  },
  {
    id: 'aihubmix',
    name: 'AIHubMix',
    api: 'https://aihubmix.com/v1',
    env: ['AIHUBMIX_API_KEY'],
    apiEnv: ['AIHUBMIX_API_BASE'],
    doc: 'https://aihubmix.com/token',
    kind: 'RELAY',
    models: ['claude-sonnet-4-5', 'gpt-5.1', 'DeepSeek-V3', 'gemini-2.5-pro'],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    api: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    apiEnv: ['XAI_API_BASE'],
    doc: 'https://console.x.ai/',
    models: ['grok-4', 'grok-4-fast', 'grok-code-fast-1'],
  },
];

/** 用户自定义 provider；只存非机密字段 */
export interface CustomProviderInput {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly wire?: 'anthropic' | 'openai';
  readonly models?: readonly string[];
  readonly doc?: string;
}

const CUSTOM_PATH = join(PATHS.root, 'custom-providers.json');

function normalizeBuiltIn(b: BuiltIn): ProviderDescriptor {
  return {
    ...b,
    // 与 CLI `normalizeProviders` 一致：没写 apiFormat 就当 OpenAI
    wire: b.wire ?? 'openai',
    kind: b.kind ?? 'OFFICIAL',
    defaultModel: b.defaultModel ?? b.models[0] ?? '',
    builtIn: true,
  };
}

function normalizeCustom(c: CustomProviderInput): ProviderDescriptor {
  const models = (c.models ?? []).filter((m) => m.trim());
  return {
    id: c.id,
    name: c.name || c.id,
    api: normalizeBaseUrl(c.api),
    env: [],
    apiEnv: [],
    doc: c.doc ?? '',
    wire: c.wire ?? 'openai',
    models,
    defaultModel: models[0] ?? '',
    kind: 'CUSTOM',
    builtIn: false,
  };
}

export function loadCustomProviders(): CustomProviderInput[] {
  // readJson 只在"文件不存在"或"parse 抛错"时降级。合法 JSON 但不是数组
  // （`{}`、`null`、手工编辑过）会原样返回，随后 for...of 抛 "not iterable"，
  // 把整个 provider 列表打崩。这里显式守住形状。
  const v = readJson<unknown>(CUSTOM_PATH, []);
  return Array.isArray(v) ? (v as CustomProviderInput[]) : [];
}

export function saveCustomProvider(input: CustomProviderInput): void {
  const id = slugify(input.id);
  if (!id) throw new Error('provider id 不能为空');
  if (BUILT_IN.some((b) => b.id === id)) throw new Error(`${id} 与内置 provider 重名`);
  // 前缀正则会放过字符串 'https://' 本身，normalizeBaseUrl 随后把它变成 'https:'
  // 存进配置，之后每次调用都拼出一个无效地址。用 URL 解析真正校验。
  let parsed: URL;
  try {
    parsed = new URL(input.api.trim());
  } catch {
    throw new Error('API 地址不是合法 URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.host) {
    throw new Error('API 地址必须是带主机名的 https:// 地址');
  }

  const list = loadCustomProviders().filter((c) => c.id !== id);
  list.push({ ...input, id, api: normalizeBaseUrl(input.api) });
  writeJsonAtomic(CUSTOM_PATH, list);
}

export function removeCustomProvider(id: string): void {
  writeJsonAtomic(
    CUSTOM_PATH,
    loadCustomProviders().filter((c) => c.id !== id),
  );
}

/** 内置 + 自定义。同 id 时自定义覆盖内置（与 CLI `mergeProviders` 的 config-wins 一致） */
export function allProviders(): ProviderDescriptor[] {
  const map = new Map<string, ProviderDescriptor>();
  for (const b of BUILT_IN) map.set(b.id, normalizeBuiltIn(b));
  for (const c of loadCustomProviders()) map.set(c.id, normalizeCustom(c));
  return [...map.values()];
}

export function descriptorOf(providerId: string): ProviderDescriptor {
  const found = allProviders().find((p) => p.id === providerId);
  if (!found) throw new Error(`未知 provider: ${providerId}`);
  return found;
}

/** base URL 解析优先级：用户覆盖 > 环境变量 > 描述符默认。对应 CLI `getProviderBaseURL` */
export function resolveOrigin(d: ProviderDescriptor, override: string): string {
  if (override.trim()) return normalizeBaseUrl(override);
  for (const key of d.apiEnv) {
    const v = process.env[key]?.trim();
    if (v) return normalizeBaseUrl(v);
  }
  return d.api;
}

/** 凭据优先级：应用内录入 > 环境变量。对应 CLI `getProviderApiKey` */
export function resolveKeySource(
  d: ProviderDescriptor,
  appKey: string | undefined,
): { source: 'APP' | 'ENV' | 'NONE'; envVar: string | null } {
  if (appKey?.trim()) return { source: 'APP', envVar: null };
  for (const key of d.env) {
    if (process.env[key]?.trim()) return { source: 'ENV', envVar: key };
  }
  return { source: 'NONE', envVar: null };
}

export function resolveKey(d: ProviderDescriptor, appKey: string | undefined): string | null {
  if (appKey?.trim()) return appKey.trim();
  for (const key of d.env) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return null;
}

/**
 * 规范化 base URL。
 *
 * 只补一种情况：用户只填了域名（没有路径）时补 `/v1` —— 绝大多数中转站是这个形状。
 * 带路径的一律原样保留，因为智谱是 `/api/paas/v4`、火山是 `/api/v3`，猜不得。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    // 非特殊协议下 URL.origin 是字符串 "null"：'localhost:3000' 会被拼成 'null3000'。
    // 这种输入按"非法 URL"原样返回，与 catch 分支保持一致
    if (url.origin === 'null' || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return trimmed;
    }
    if (url.pathname === '' || url.pathname === '/') return `${url.origin}/v1`;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

/** 数据会不会经过第三方：中转站，或用户把官方地址改掉了 */
export function isRelay(d: ProviderDescriptor, origin: string): boolean {
  return d.kind !== 'OFFICIAL' || origin !== d.api;
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
