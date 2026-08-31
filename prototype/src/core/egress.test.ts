import { describe, expect, it } from 'vitest';
import type { ModelConnectionProfile, ModelRouteResolution } from '@shared/domain';
import { buildDisclosure, consentedResolutionDigests } from './egress';
import type { ExternalConnectorProfile } from './external/connector';

/**
 * 披露是用户同意的对象，所以它必须：确定性（同输入同 digest）、对"送给谁"敏感
 * （路由/审核方/作者/快照任一变化 digest 就变）、并且把"不知道对方政策"写成 UNKNOWN 而不是省略。
 */

const profile = (id: string, relay = false): ModelConnectionProfile => ({
  profileId: `profile_${id}`,
  providerId: id,
  label: id.toUpperCase(),
  kind: relay ? 'RELAY' : 'OFFICIAL',
  builtIn: true,
  wire: 'openai',
  origin: `https://api.${id}.example/v1`,
  officialOrigin: `https://api.${id}.example/v1`,
  baseUrlOverride: '',
  isRelay: relay,
  modelId: `${id}-model`,
  availableModels: [`${id}-model`],
  credentialEnvVar: `${id.toUpperCase()}_API_KEY`,
  credentialEnvVars: [`${id.toUpperCase()}_API_KEY`],
  credentialSource: 'ENV',
  fallbackSource: 'NONE',
  fallbackEnvVar: null,
  credentialHint: null,
  docUrl: '',
  enabled: true,
  routeSwitchPolicy: 'MANUAL_ONLY',
  automaticFallback: 'DENY',
});
const resolution = (id: string, digest = `sha256:route-${id}`): ModelRouteResolution => ({
  resolutionId: `res_${id}`,
  profileId: `profile_${id}`,
  providerId: id,
  origin: `https://api.${id}.example/v1`,
  modelId: `${id}-model`,
  frozenAt: '2026-08-19T00:00:00.000Z',
  digest,
});
const connector = (kind: 'CODEX_CLI' | 'CLAUDE_CLI'): ExternalConnectorProfile => ({
  connectorId: kind === 'CODEX_CLI' ? 'codex-cli' : 'claude-cli',
  kind,
  vendor: kind === 'CODEX_CLI' ? 'OPENAI' : 'ANTHROPIC',
  label: kind === 'CODEX_CLI' ? 'Codex' : 'Claude Code',
  state: 'READY',
  form: 'CLI',
  appPath: null,
  binaryPath: '/x',
  version: '1.0',
  identityDigest: 'sha256:id',
  credentialEnvVar: 'X',
  authorAdmitted: true,
  detail: '',
  remediation: null,
});

const base = {
  snapshotId: 'snap_1',
  snapshotFileCount: 12,
  implementer: { profile: profile('deepseek'), resolution: resolution('deepseek') },
  reviewer: null,
  reviewerParity: null,
  author: null,
};

describe('buildDisclosure', () => {
  it('确定性：同输入同 digest；resolutionId/frozenAt 不同但路由 digest 相同也不影响', () => {
    const a = buildDisclosure(base);
    const b = buildDisclosure({ ...base, implementer: { ...base.implementer, resolution: { ...resolution('deepseek'), resolutionId: 'res_other', frozenAt: '2030-01-01T00:00:00.000Z' } } });
    expect(a.digest).toBe(b.digest);
  });

  it('厂商同异判定进披露：parity 变化 → digest 变化；无审核方时强制为 null', () => {
    const withReviewer = {
      ...base,
      reviewer: { kind: 'MODEL_API' as const, profile: profile('moonshot'), resolution: resolution('moonshot') },
    };
    const parity = (kind: 'HETEROGENEOUS' | 'SAME_VENDOR' | 'UNVERIFIABLE') =>
      ({ kind, detail: `判定 ${kind}` }) as const;
    const a = buildDisclosure({ ...withReviewer, reviewerParity: parity('HETEROGENEOUS') });
    const b = buildDisclosure({ ...withReviewer, reviewerParity: parity('UNVERIFIABLE') });
    expect(a.crossReviewParity?.kind).toBe('HETEROGENEOUS');
    // 用户点头的对象包含这条判定 —— 判定变了，旧同意必须失效
    expect(a.digest).not.toBe(b.digest);
    // 没有审核方却传了 parity → 不进披露：判定只描述真实存在的写审关系
    const none = buildDisclosure({ ...base, reviewerParity: parity('SAME_VENDOR') });
    expect(none.crossReviewParity).toBeNull();
  });

  it('路由 / 审核方 / 作者 / 快照任一变化 → digest 变化', () => {
    const d0 = buildDisclosure(base).digest;
    expect(buildDisclosure({ ...base, implementer: { profile: profile('deepseek'), resolution: resolution('deepseek', 'sha256:route-changed') } }).digest).not.toBe(d0);
    expect(buildDisclosure({ ...base, reviewer: { kind: 'MODEL_API', profile: profile('moonshot'), resolution: resolution('moonshot') } }).digest).not.toBe(d0);
    expect(buildDisclosure({ ...base, reviewer: { kind: 'EXTERNAL_CLI', connector: connector('CLAUDE_CLI') } }).digest).not.toBe(d0);
    expect(buildDisclosure({ ...base, author: { connector: connector('CODEX_CLI') } }).digest).not.toBe(d0);
    expect(buildDisclosure({ ...base, snapshotId: 'snap_2' }).digest).not.toBe(d0);
  });

  it('目的地：实现方 MODEL_API 带精确 origin 与路由 digest；中转 profile 标 isRelay；政策三项都是 UNKNOWN', () => {
    const d = buildDisclosure({ ...base, implementer: { profile: profile('relayx', true), resolution: resolution('relayx') } });
    expect(d.destinations).toHaveLength(1);
    expect(d.destinations[0]).toMatchObject({
      role: 'IMPLEMENTER',
      channel: 'MODEL_API',
      origin: 'https://api.relayx.example/v1',
      isRelay: true,
      modelId: 'relayx-model',
      resolutionDigest: 'sha256:route-relayx',
    });
    expect(d.destinations[0]!.dataClasses).toEqual(['TASK_TEXT', 'REPOSITORY_SNAPSHOT_EXCERPTS', 'COMMAND_OUTPUT', 'REVIEW_FINDINGS']);
    expect(d.policy).toEqual({ retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' });
  });

  it('外部 CLI 作者：channel=EXTERNAL_CLI、origin=null（端点由 CLI 决定）、数据类别含整仓副本', () => {
    const d = buildDisclosure({ ...base, author: { connector: connector('CODEX_CLI') }, reviewer: { kind: 'EXTERNAL_CLI', connector: connector('CLAUDE_CLI') } });
    expect(d.destinations.map((x) => [x.role, x.channel, x.origin])).toEqual([
      ['IMPLEMENTER', 'MODEL_API', 'https://api.deepseek.example/v1'],
      ['REVIEWER', 'EXTERNAL_CLI', null],
      ['AUTHOR', 'EXTERNAL_CLI', null],
    ]);
    expect(d.destinations[2]!.dataClasses).toContain('REPOSITORY_FULL_COPY_VIA_CLI');
  });

  /*
   * 外部 CLI 不经 ModelGateway，但**同意仍然要覆盖它** —— 否则用户点头的那份披露
   * 对拿到整仓副本的那个选手没有任何运行期约束力。它没有网络 route，就用身份：
   * identityDigest = binaryPath + version。
   */
  it('外部 CLI 目的地贡献 identityDigest：同意覆盖集合里必须有它，否则运行期闸门无从比对', () => {
    const d = buildDisclosure({ ...base, author: { connector: connector('CODEX_CLI') }, reviewer: { kind: 'EXTERNAL_CLI', connector: connector('CLAUDE_CLI') } });
    expect(consentedResolutionDigests(d)).toEqual(['sha256:route-deepseek', 'sha256:id', 'sha256:id']);
  });

  it('升级 CLI 或换二进制 → identityDigest 变 → 披露 digest 变 → 旧同意自动失效', () => {
    const before = buildDisclosure({ ...base, author: { connector: connector('CODEX_CLI') } });
    const upgraded = { ...connector('CODEX_CLI'), version: '1.1', identityDigest: 'sha256:id-v1.1' };
    const after = buildDisclosure({ ...base, author: { connector: upgraded } });
    expect(after.digest).not.toBe(before.digest);
    expect(consentedResolutionDigests(before)).not.toContain('sha256:id-v1.1');
  });

  it('模型 API 审核方：同意覆盖实现方与审核方两条路由', () => {
    const d = buildDisclosure({ ...base, reviewer: { kind: 'MODEL_API', profile: profile('moonshot'), resolution: resolution('moonshot') } });
    expect(consentedResolutionDigests(d)).toEqual(['sha256:route-deepseek', 'sha256:route-moonshot']);
    expect(d.destinations[1]!.dataClasses).toEqual(['TASK_TEXT', 'PATCH_DIFF', 'COMMAND_OUTPUT']);
  });
});
