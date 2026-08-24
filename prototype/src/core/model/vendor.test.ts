import { describe, expect, it } from 'vitest';
import { inferModelVendor, knownVendorSide, vendorParityOf } from './vendor';

/**
 * 厂商推断与三态判定。
 *
 * 这组用例守的是 A2A 评审 §4.4 点名的洞：异构断言此前只认 'anthropic'/'openai'
 * 两个 providerId 字符串，中转路由一律"推不出 → 跳过"，绑定处还把 heterogeneous
 * 硬编码 true。负向用例是主体 —— 重点不是"认得出多少家"，而是：
 *   1. 能证明的必须证明出来（中转站上的 claude 就是 Anthropic 的）；
 *   2. 证明不了的必须停在 UNKNOWN / UNVERIFIABLE，绝不折成任何一边。
 */

describe('inferModelVendor：证据优先级 = 命名空间 > 家族名 > 单一厂商官方 provider', () => {
  it.each([
    // [providerId, kind, modelId, 期望厂商] —— 全部取自内置注册表里的真实条目
    ['openrouter', 'RELAY', 'anthropic/claude-sonnet-4.5', 'ANTHROPIC'],
    ['openrouter', 'RELAY', 'openai/gpt-5.1', 'OPENAI'],
    ['siliconflow', 'RELAY', 'deepseek-ai/DeepSeek-V3.1', 'DEEPSEEK'],
    ['siliconflow', 'RELAY', 'zai-org/GLM-4.5', 'ZHIPU'],
    ['modelscope', 'RELAY', 'ZhipuAI/GLM-4.6', 'ZHIPU'],
    ['siliconflow', 'RELAY', 'Qwen/Qwen3-Coder-480B-A35B-Instruct', 'ALIBABA'],
    ['siliconflow', 'RELAY', 'moonshotai/Kimi-K2-Instruct-0905', 'MOONSHOT'],
  ] as const)('命名空间证据：%s 上的 %s → %s', (providerId, kind, modelId, vendor) => {
    const r = inferModelVendor({ providerId, providerKind: kind as 'RELAY', modelId });
    expect(r).toMatchObject({ kind: 'KNOWN', vendor });
  });

  it.each([
    // aihubmix 的模型 id 没有命名空间，只能靠家族名
    ['aihubmix', 'claude-sonnet-4-5', 'ANTHROPIC'],
    ['aihubmix', 'gpt-5.1', 'OPENAI'],
    ['aihubmix', 'DeepSeek-V3', 'DEEPSEEK'],
    ['aihubmix', 'gemini-2.5-pro', 'GOOGLE'],
    ['some-relay', 'o4-mini', 'OPENAI'],
    ['some-relay', 'kimi-k2-thinking', 'MOONSHOT'],
    ['some-relay', 'glm-4.6', 'ZHIPU'],
    ['some-relay', 'grok-code-fast-1', 'XAI'],
  ] as const)('家族名证据（大小写不敏感）：%s 的 %s → %s', (providerId, modelId, vendor) => {
    const r = inferModelVendor({ providerId, providerKind: 'RELAY', modelId });
    expect(r).toMatchObject({ kind: 'KNOWN', vendor });
  });

  it('家族名优先于 provider 归属：火山方舟（字节官方）托管的 deepseek/kimi 归 DeepSeek/Moonshot，不归字节', () => {
    expect(
      inferModelVendor({ providerId: 'volcengine', providerKind: 'OFFICIAL', modelId: 'deepseek-v3-1-250821' }),
    ).toMatchObject({ kind: 'KNOWN', vendor: 'DEEPSEEK' });
    expect(
      inferModelVendor({ providerId: 'volcengine', providerKind: 'OFFICIAL', modelId: 'kimi-k2-250905' }),
    ).toMatchObject({ kind: 'KNOWN', vendor: 'MOONSHOT' });
    expect(
      inferModelVendor({ providerId: 'volcengine', providerKind: 'OFFICIAL', modelId: 'doubao-seed-1-6-250615' }),
    ).toMatchObject({ kind: 'KNOWN', vendor: 'BYTEDANCE' });
  });

  it('单一厂商官方 provider 兜底：anthropic 官方上叫不出家族的 id 仍归 Anthropic', () => {
    expect(
      inferModelVendor({ providerId: 'anthropic', providerKind: 'OFFICIAL', modelId: 'some-future-model' }),
    ).toMatchObject({ kind: 'KNOWN', vendor: 'ANTHROPIC' });
  });

  it('多厂商官方站（火山方舟）没有兜底：认不出家族就是 UNKNOWN，不猜"归托管方"', () => {
    const r = inferModelVendor({ providerId: 'volcengine', providerKind: 'OFFICIAL', modelId: 'mystery-model-1' });
    expect(r.kind).toBe('UNKNOWN');
  });

  it.each([
    ['中转 + 无家族名', 'openrouter', 'RELAY', 'openrouter/auto'],
    ['自定义 provider', 'acme', 'CUSTOM', 'frontier-x'],
    ['provider 已删（kind 取不到）', 'ghost', null, 'workhorse-1'],
    ['o 系列边界：oscar 不是 o1/o3/o4', 'some-relay', 'RELAY', 'oscar-7'],
    ['gpt 边界：gato 不是 gpt', 'some-relay', 'RELAY', 'gato-2'],
  ] as const)('%s → UNKNOWN，原因点名 provider 与模型', (_label, providerId, kind, modelId) => {
    const r = inferModelVendor({ providerId, providerKind: kind as 'RELAY' | 'CUSTOM' | null, modelId });
    expect(r.kind).toBe('UNKNOWN');
    if (r.kind === 'UNKNOWN') {
      expect(r.reason).toContain(providerId);
      expect(r.reason).toContain(modelId);
    }
  });

  it('kind 取不到（null）时不做官方兜底：官方才有"只服务自家"的前提', () => {
    const r = inferModelVendor({ providerId: 'anthropic', providerKind: null, modelId: 'some-future-model' });
    expect(r.kind).toBe('UNKNOWN');
  });
});

describe('vendorParityOf：两侧都有证据才允许下结论', () => {
  const known = (label: string, vendor: 'ANTHROPIC' | 'OPENAI') =>
    knownVendorSide({ label, vendor, evidence: `测试给定 ${vendor}` });
  const unknown = (label: string, reason: string) =>
    ({ label, inference: { kind: 'UNKNOWN', reason } }) as const;

  it('KNOWN 同厂商 → SAME_VENDOR，detail 写明双方与证据', () => {
    const p = vendorParityOf(known('实现方 a', 'ANTHROPIC'), known('审核方 b', 'ANTHROPIC'));
    expect(p.kind).toBe('SAME_VENDOR');
    expect(p.detail).toContain('实现方 a');
    expect(p.detail).toContain('审核方 b');
    expect(p.detail).toContain('Anthropic');
  });

  it('KNOWN 异厂商 → HETEROGENEOUS', () => {
    const p = vendorParityOf(known('实现方 a', 'ANTHROPIC'), known('审核方 b', 'OPENAI'));
    expect(p.kind).toBe('HETEROGENEOUS');
  });

  it('任一侧 UNKNOWN → UNVERIFIABLE，原因原样进 detail —— 绝不折成异构或同源', () => {
    const p = vendorParityOf(unknown('实现方 a', '中转 provider x 无法证明'), known('审核方 b', 'ANTHROPIC'));
    expect(p.kind).toBe('UNVERIFIABLE');
    expect(p.detail).toContain('中转 provider x 无法证明');
  });

  it('两侧都 UNKNOWN → UNVERIFIABLE，两条原因都在', () => {
    const p = vendorParityOf(unknown('写方', '原因甲'), unknown('审方', '原因乙'));
    expect(p.kind).toBe('UNVERIFIABLE');
    expect(p.detail).toContain('原因甲');
    expect(p.detail).toContain('原因乙');
  });
});
