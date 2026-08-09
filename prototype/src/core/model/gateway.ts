import type {
  ModelConnectionProfile,
  ModelEgressManifest,
  ModelInvocationPurpose,
  ModelRouteResolution,
  ProviderId,
} from '@shared/domain';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digestOf, newId, nowIso } from '@shared/ids';
import { PATHS } from '../paths';
import { readJson, writeJsonAtomic } from '../store';
import { anthropicAdapter } from './anthropic';
import { openAiWireAdapter } from './openai-compatible';
import {
  type CustomProviderInput,
  allProviders,
  descriptorOf,
  isRelay,
  loadCustomProviders,
  removeCustomProvider,
  resolveKey,
  resolveKeySource,
  resolveOrigin,
  saveCustomProvider,
} from './registry';
import {
  findWireViolation,
  ModelCallError,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
} from './types';

/** 按线上协议方言选适配器，不按 provider —— 对应 CLI 的 `apiFormat` 分派 */
const ADAPTERS: Record<'anthropic' | 'openai', ModelAdapter> = {
  anthropic: anthropicAdapter,
  openai: openAiWireAdapter,
};

/**
 * 把不属于任何 Run 的出站清单追加到全局 egress 日志。
 *
 * Run 内的调用清单进各自的事件流；设置页的连通性测试没有 Run 归属，
 * 但同样带真实凭据出站，必须留痕。写盘失败只记录不抛 —— 记账失败不该
 * 让「测试连接」这个动作本身崩掉，但也绝不能静默当作没发生。
 */
export function appendEgress(manifest: ModelEgressManifest): void {
  try {
    mkdirSync(dirname(PATHS.egressLog), { recursive: true });
    appendFileSync(PATHS.egressLog, `${JSON.stringify(manifest)}\n`, 'utf8');
  } catch (err) {
    console.error('[core] 写 egress 日志失败', err);
  }
}

const SETTINGS_PATH = join(PATHS.root, 'model-profiles.json');

export function profileIdOf(providerId: ProviderId): string {
  return `profile_${providerId}`;
}

export function providerIdOfProfile(profileId: string): string {
  return profileId.replace(/^profile_/, '');
}

export interface InvocationInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly purpose: ModelInvocationPurpose;
  readonly resolution: ModelRouteResolution;
  readonly request: ModelRequest;
  /** 被送进上下文的仓库文件引用，写入 egress manifest 供用户查询 */
  readonly contextFileRefs: readonly string[];
  readonly signal: AbortSignal;
}

export interface InvocationOutput {
  readonly invocationId: string;
  readonly response: ModelResponse;
  readonly manifest: ModelEgressManifest;
}

/**
 * 所有外部模型调用的唯一出口。
 *
 * 强制的几条（PRD-MODEL-001..005）：
 *   - 只能用已登记的命名 adapter，origin 由 adapter 固定，不接受运行时注入的 baseURL。
 *   - 每次调用必须声明 purpose；planning / execution / self-fix 都走同一条链路，
 *     没有"辅助调用免计费"的旁路。
 *   - 每次调用（包括被阻断的）都产出一条 ModelEgressManifest；manifest 里不含
 *     raw secret、请求正文和 header。
 *   - 凭据只在 request-local 内存中存在，不写日志、不进事件、不投影到 Renderer。
 *   - automaticFallback=DENY：调用失败就是失败，不会自动换供应商或换模型。
 */
/** 用户在应用里改过的、**非机密**的 profile 设置。落盘的只有这些。 */
interface ProfileSettings {
  modelId: string;
  baseUrlOverride: string;
}

export class ModelGateway {
  /**
   * 应用内录入的 API key，由 Main 通过私有 IPC 注入。
   *
   * 只存在于**内存**：不写 SQLite、不写配置文件、不进事件、不投影到 Renderer。
   * 落盘那份由 Main 用 Electron safeStorage（背后是 macOS Keychain）加密保管。
   * 这里刻意不照抄 CLI 的做法 —— 它把 key 明文写进全局 JSON 配置。
   */
  private readonly appKeys = new Map<ProviderId, string>();
  private settings: Record<string, ProfileSettings> = {};

  constructor() {
    this.settings = readJson<Record<string, ProfileSettings>>(SETTINGS_PATH, {});
  }

  /** Main 在启动时和用户改动后调用；替换整份，不做增量合并 */
  syncCredentials(keys: Partial<Record<ProviderId, string>>): void {
    this.appKeys.clear();
    for (const [id, key] of Object.entries(keys)) {
      if (key?.trim()) this.appKeys.set(id as ProviderId, key.trim());
    }
  }

  private settingsOf(providerId: ProviderId): ProfileSettings {
    const d = descriptorOf(providerId);
    const stored = this.settings[providerId];
    return {
      modelId: stored?.modelId?.trim() || d.defaultModel,
      baseUrlOverride: stored?.baseUrlOverride ?? '',
    };
  }

  private buildProfile(providerId: ProviderId): ModelConnectionProfile {
    const d = descriptorOf(providerId);
    const s = this.settingsOf(providerId);
    const appKey = this.appKeys.get(providerId);
    const { source, envVar } = resolveKeySource(d, appKey);
    const origin = resolveOrigin(d, s.baseUrlOverride);
    const effectiveKey = resolveKey(d, appKey);

    return {
      profileId: profileIdOf(providerId),
      providerId,
      label: d.name,
      kind: d.kind,
      builtIn: d.builtIn,
      wire: d.wire,
      origin,
      officialOrigin: d.api,
      baseUrlOverride: s.baseUrlOverride,
      isRelay: isRelay(d, origin),
      modelId: s.modelId,
      availableModels: d.models,
      credentialEnvVar: d.env[0] ?? '',
      credentialSource: source,
      credentialHint: effectiveKey ? `…${effectiveKey.slice(-4)}` : null,
      docUrl: d.doc,
      // 有 key 就算启用；应用内录入和环境变量都算
      enabled: source !== 'NONE',
      routeSwitchPolicy: 'MANUAL_ONLY',
      automaticFallback: 'DENY',
      ...(envVar ? {} : {}),
    };
  }

  listProfiles(): ModelConnectionProfile[] {
    return allProviders()
      .map((d) => this.buildProfile(d.id))
      // 已配好的排前面，其次官方，最后中转和自定义
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const rank = (k: string) => (k === 'OFFICIAL' ? 0 : k === 'RELAY' ? 1 : 2);
        return rank(a.kind) - rank(b.kind);
      });
  }

  getProfile(profileId: string): ModelConnectionProfile | undefined {
    const providerId = providerIdOfProfile(profileId);
    return allProviders().some((d) => d.id === providerId)
      ? this.buildProfile(providerId)
      : undefined;
  }

  /** 保存用户选的模型 / 覆盖地址。这两项都不是机密，可以落盘。 */
  updateProfile(
    profileId: string,
    patch: { modelId?: string; baseUrlOverride?: string },
  ): ModelConnectionProfile {
    const providerId = providerIdOfProfile(profileId);
    if (!allProviders().some((d) => d.id === providerId)) {
      throw new ModelCallError(`未知 profile: ${profileId}`, 'BAD_REQUEST');
    }
    const current = this.settingsOf(providerId);
    const nextOverride =
      patch.baseUrlOverride === undefined ? current.baseUrlOverride : patch.baseUrlOverride.trim();

    // 非空覆盖地址必须是带主机名的 https —— 与 saveCustomProvider 同一道校验。
    // 之前这里只 trim，normalizeBaseUrl 又放行 http:，于是 http://attacker 能被存进配置，
    // 之后「测试连接」把 API key 明文发出去。空串表示清除覆盖，回落到环境变量/默认地址。
    if (nextOverride) {
      let parsed: URL;
      try {
        parsed = new URL(nextOverride);
      } catch {
        throw new ModelCallError('API 地址不是合法 URL', 'BAD_REQUEST');
      }
      if (parsed.protocol !== 'https:' || !parsed.host) {
        throw new ModelCallError('API 地址必须是带主机名的 https:// 地址', 'BAD_REQUEST');
      }
    }

    this.settings[providerId] = {
      modelId: patch.modelId?.trim() || current.modelId,
      baseUrlOverride: nextOverride,
    };
    writeJsonAtomic(SETTINGS_PATH, this.settings);
    return this.buildProfile(providerId);
  }

  /** 新增/覆盖一个自定义 provider。只存非机密字段，key 仍走钥匙串。 */
  addCustomProvider(input: CustomProviderInput): void {
    saveCustomProvider(input);
  }

  removeCustomProvider(providerId: string): void {
    removeCustomProvider(providerId);
    delete this.settings[providerId];
    writeJsonAtomic(SETTINGS_PATH, this.settings);
  }

  listCustomProviders(): CustomProviderInput[] {
    return loadCustomProviders();
  }

  adapterFor(wire: 'anthropic' | 'openai'): ModelAdapter {
    return ADAPTERS[wire];
  }

  /** 为一个 Attempt 冻结路由；运行期间任何漂移都会导致阻断而不是自动切换 */
  freezeRoute(profileId: string): ModelRouteResolution {
    const profile = this.getProfile(profileId);
    if (!profile) throw new ModelCallError(`未知 profile: ${profileId}`, 'BAD_REQUEST');
    if (!profile.enabled) {
      throw new ModelCallError(
        `${profile.label} 未配置凭据：在「设置 · API」里填入 API Key，或设置环境变量 ${profile.credentialEnvVar}`,
        'AUTH',
      );
    }
    const core = {
      profileId: profile.profileId,
      providerId: profile.providerId,
      origin: profile.origin,
      modelId: profile.modelId,
    };
    return { resolutionId: newId('route'), ...core, frozenAt: nowIso(), digest: digestOf(core) };
  }

  async testProfile(
    profileId: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; detail: string; latencyMs: number | null }> {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, detail: '未知 profile', latencyMs: null };

    // 连通性探针不属于任何 Run，但同样带真实凭据出站 —— 每一种结局（含被阻断）
    // 都产出一条 ModelEgressManifest 追加到全局 egress 日志。gateway 类注释写明：
    // 没有"辅助调用免记账"的旁路。
    const requestedAt = nowIso();
    const baseManifest = {
      invocationId: newId('inv'),
      runId: 'connectivity-test',
      attemptId: 'connectivity-test',
      purpose: 'CONNECTIVITY_TEST' as const,
      resolutionId: 'connectivity-test',
      providerId: profile.providerId,
      origin: profile.origin,
      modelId: profile.modelId,
      contextFileRefs: [] as readonly string[],
      requestedAt,
    };
    const record = (m: ModelEgressManifest): void => appendEgress(m);

    const apiKey = this.keyFor(profile.providerId);
    if (!apiKey) {
      record({
        ...baseManifest,
        sent: false,
        blockReason: 'CREDENTIAL_MISSING',
        inputTokens: null,
        outputTokens: null,
        settledAt: nowIso(),
        errorKind: null,
      });
      return {
        ok: false,
        detail: `未配置凭据（应用内未填，环境变量 ${profile.credentialEnvVar} 也没有）`,
        latencyMs: null,
      };
    }

    // 明文出站前拦住：即使 origin 来自环境变量（绕过 updateProfile 的校验），
    // 也不能把 key 通过 http 发出去。testProfile 之前完全不过这道门。
    if (!profile.origin.startsWith('https://')) {
      record({
        ...baseManifest,
        sent: false,
        blockReason: 'INSECURE_ORIGIN',
        inputTokens: null,
        outputTokens: null,
        settledAt: nowIso(),
        errorKind: null,
      });
      return {
        ok: false,
        detail: `拒绝测试：地址不是 https（${profile.origin}）。明文 HTTP 会暴露 API Key。`,
        latencyMs: null,
      };
    }

    const started = Date.now();
    try {
      const response = await this.adapterFor(profile.wire).call(
        {
          system: 'You are a connectivity probe. Reply with exactly: ok',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          tools: [],
          maxOutputTokens: 16,
          temperature: 0,
        },
        { apiKey, modelId: profile.modelId, signal, baseUrl: profile.origin },
      );
      record({
        ...baseManifest,
        sent: true,
        blockReason: null,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        settledAt: nowIso(),
        errorKind: null,
      });
      return {
        ok: true,
        detail: `${profile.modelId} @ ${profile.origin} 连接正常（凭据来自${profile.credentialSource === 'APP' ? '应用内' : '环境变量'}）`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const e = err as ModelCallError;
      record({
        ...baseManifest,
        sent: true, // 请求确实发出去了，只是没成功
        blockReason: null,
        inputTokens: null,
        outputTokens: null,
        settledAt: nowIso(),
        errorKind: e.kind ?? 'UNKNOWN',
      });
      return { ok: false, detail: `${e.kind}: ${e.message}`, latencyMs: Date.now() - started };
    }
  }

  private keyFor(providerId: ProviderId): string | null {
    return resolveKey(descriptorOf(providerId), this.appKeys.get(providerId));
  }

  async invoke(input: InvocationInput): Promise<InvocationOutput> {
    const invocationId = newId('inv');
    const { resolution } = input;
    const profile = this.getProfile(resolution.profileId);

    const base = {
      invocationId,
      runId: input.runId,
      attemptId: input.attemptId,
      purpose: input.purpose,
      resolutionId: resolution.resolutionId,
      providerId: resolution.providerId,
      origin: resolution.origin,
      modelId: resolution.modelId,
      contextFileRefs: input.contextFileRefs,
      requestedAt: nowIso(),
    };

    // ---- 出站前置检查：不满足就是 NOT_SENT，不会先发再说 ----
    const blockReason = this.preflight(profile, resolution, input.request.messages);
    if (blockReason) {
      const manifest: ModelEgressManifest = {
        ...base,
        sent: false,
        blockReason,
        inputTokens: null,
        outputTokens: null,
        settledAt: nowIso(),
        errorKind: null,
      };
      throw new EgressBlocked(blockReason, manifest);
    }

    const apiKey = this.keyFor(resolution.providerId)!;
    const adapter = this.adapterFor(profile!.wire);

    try {
      const response = await adapter.call(input.request, {
        apiKey, // 只在这一层展开，调用结束即离开作用域
        modelId: resolution.modelId,
        signal: input.signal,
        // 用**冻结时**的地址，而不是当前配置 —— 运行中改设置不能改变已在飞的 Attempt
        baseUrl: resolution.origin,
      });
      const manifest: ModelEgressManifest = {
        ...base,
        sent: true,
        blockReason: null,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        settledAt: nowIso(),
        errorKind: null,
      };
      return { invocationId, response, manifest };
    } catch (err) {
      const e = err as ModelCallError;
      const manifest: ModelEgressManifest = {
        ...base,
        sent: true, // 请求确实发出去了，只是没成功 —— 不能记成 NOT_SENT
        blockReason: null,
        inputTokens: null,
        outputTokens: null,
        settledAt: nowIso(),
        errorKind: e.kind ?? 'UNKNOWN',
      };
      throw new InvocationFailed(e, manifest);
    }
  }

  private preflight(
    profile: ModelConnectionProfile | undefined,
    resolution: ModelRouteResolution,
    messages: readonly ModelMessage[],
  ): string | null {
    if (!profile) return 'PROFILE_NOT_FOUND';
    if (!profile.enabled) return 'PROFILE_DISABLED';
    if (!this.keyFor(profile.providerId)) return 'CREDENTIAL_MISSING';
    // route 漂移检测：profile 在冻结之后被改动过就必须阻断，而不是静默改走新配置
    const current = digestOf({
      profileId: profile.profileId,
      providerId: profile.providerId,
      origin: profile.origin,
      modelId: profile.modelId,
    });
    if (current !== resolution.digest) return 'ROUTE_DRIFT';
    if (!resolution.origin.startsWith('https://')) return 'INSECURE_ORIGIN';
    // 我们自己拼错的历史，不要花一次真实请求去换供应商的一句 400。
    // 详见 findOrphanToolUse 的注释：孤儿会污染此后每一次请求，不只是这一次。
    const violation = findWireViolation(messages);
    if (violation) return `MALFORMED_CONVERSATION: ${violation}`;
    return null;
  }
}

export class EgressBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly manifest: ModelEgressManifest,
  ) {
    super(`模型出站被阻断: ${reason}`);
  }
}

export class InvocationFailed extends Error {
  constructor(
    readonly cause: ModelCallError,
    readonly manifest: ModelEgressManifest,
  ) {
    super(cause.message);
  }
}

