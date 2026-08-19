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
  detail: '',
  remediation: null,
});

const base = {
  snapshotId: 'snap_1',
  snapshotFileCount: 12,
  implementer: { profile: profile('deepseek'), resolution: resolution('deepseek') },
  reviewer: null,
  author: null,
};

describe('buildDisclosure', () => {
  it('确定性：同输入同 digest；resolutionId/frozenAt 不同但路由 digest 相同也不影响', () => {
    const a = buildDisclosure(base);
    const b = buildDisclosure({ ...base, implementer: { ...base.implementer, resolution: { ...resolution('deepseek'), resolutionId: 'res_other', frozenAt: '2030-01-01T00:00:00.000Z' } } });
    expect(a.digest).toBe(b.digest);
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

  it('外部 CLI 作者：channel=EXTERNAL_CLI、origin=null（端点由 CLI 决定）、数据类别含整仓副本；不贡献路由 digest', () => {
    const d = buildDisclosure({ ...base, author: { connector: connector('CODEX_CLI') }, reviewer: { kind: 'EXTERNAL_CLI', connector: connector('CLAUDE_CLI') } });
    expect(d.destinations.map((x) => [x.role, x.channel, x.origin])).toEqual([
      ['IMPLEMENTER', 'MODEL_API', 'https://api.deepseek.example/v1'],
      ['REVIEWER', 'EXTERNAL_CLI', null],
      ['AUTHOR', 'EXTERNAL_CLI', null],
    ]);
    expect(d.destinations[2]!.dataClasses).toContain('REPOSITORY_FULL_COPY_VIA_CLI');
    // 同意覆盖的 ModelGateway 路由只有实现方那一条；外部 CLI 不经网关
    expect(consentedResolutionDigests(d)).toEqual(['sha256:route-deepseek']);
  });

  it('模型 API 审核方：同意覆盖实现方与审核方两条路由', () => {
    const d = buildDisclosure({ ...base, reviewer: { kind: 'MODEL_API', profile: profile('moonshot'), resolution: resolution('moonshot') } });
    expect(consentedResolutionDigests(d)).toEqual(['sha256:route-deepseek', 'sha256:route-moonshot']);
    expect(d.destinations[1]!.dataClasses).toEqual(['TASK_TEXT', 'PATCH_DIFF', 'COMMAND_OUTPUT']);
  });
});
