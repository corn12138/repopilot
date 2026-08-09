import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ModelGateway 是全仓风险密度最高、却长期零覆盖的模块：它同时管凭据解析、
 * 出站门禁、egress 记账、以及未来双 route 的并存。这个文件先补 A7 的安全断言
 * （baseUrl 强制 https、testProfile 不经 http 送 key、每次探针都留 egress 痕迹），
 * 后续 A2 再扩到协议适配与错误分类。
 *
 * 把 `../paths` 换成一次性 mkdtemp 目录 —— 不是跳过落盘，而是把数据根注入成临时的，
 * 让 writeJsonAtomic / appendFileSync 的真实行为仍被真刀真枪地测到。
 */
vi.mock('../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkdtempSync(j(tmpdir(), 'repopilot-gateway-'));
  return {
    DATA_ROOT: root,
    PATHS: {
      root,
      projects: j(root, 'projects.json'),
      runs: j(root, 'runs'),
      snapshots: j(root, 'snapshots'),
      workspaces: j(root, 'workspaces'),
      artifacts: j(root, 'artifacts'),
      egressLog: j(root, 'egress.jsonl'),
    },
    ensureDataRoot: () => {},
    runDir: (id: string) => j(root, 'runs', id),
    workspaceDir: (id: string) => j(root, 'workspaces', id),
    snapshotDir: (id: string) => j(root, 'snapshots', id),
  };
});

import type { ModelEgressManifest } from '@shared/domain';
import { ModelGateway, profileIdOf } from './gateway';
import { PATHS } from '../paths';

// 每个用例后清掉可能被设置的凭据/地址环境变量，避免相互污染
const TOUCHED_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_API_BASE',
  'DEEPSEEK_BASE_URL',
];
function clearEnv(): void {
  for (const k of TOUCHED_ENV) delete process.env[k];
}

function readEgress(): ModelEgressManifest[] {
  if (!existsSync(PATHS.egressLog)) return [];
  return readFileSync(PATHS.egressLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ModelEgressManifest);
}

describe('updateProfile: baseUrlOverride 必须是 https', () => {
  let gw: ModelGateway;
  beforeEach(() => {
    clearEnv();
    gw = new ModelGateway();
  });
  afterEach(clearEnv);

  it('http:// 覆盖地址被拒绝，且不落盘', () => {
    expect(() =>
      gw.updateProfile(profileIdOf('deepseek'), { baseUrlOverride: 'http://attacker.example' }),
    ).toThrow(/https/);
    // 拒绝要发生在写盘之前
    expect(existsSync(PATHS.root + '/model-profiles.json')).toBe(false);
  });

  it('不是合法 URL 的覆盖地址被拒绝', () => {
    expect(() =>
      gw.updateProfile(profileIdOf('deepseek'), { baseUrlOverride: '这不是地址' }),
    ).toThrow(/不是合法 URL|https/);
  });

  it('https:// 覆盖地址被接受并生效', () => {
    const p = gw.updateProfile(profileIdOf('deepseek'), {
      baseUrlOverride: 'https://relay.example/v1',
    });
    expect(p.origin).toBe('https://relay.example/v1');
  });

  it('空串表示清除覆盖，回落到默认官方地址', () => {
    gw.updateProfile(profileIdOf('deepseek'), { baseUrlOverride: 'https://relay.example/v1' });
    const p = gw.updateProfile(profileIdOf('deepseek'), { baseUrlOverride: '' });
    expect(p.origin).toBe('https://api.deepseek.com/v1');
  });
});

describe('testProfile: 不经 http 送 key，且每次都留 egress 痕迹', () => {
  let gw: ModelGateway;
  beforeEach(() => {
    clearEnv();
    gw = new ModelGateway();
  });
  afterEach(clearEnv);

  it('凭据缺失：不发送，记一条 CREDENTIAL_MISSING manifest', async () => {
    const r = await gw.testProfile(profileIdOf('deepseek'), new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未配置凭据');

    const log = readEgress();
    expect(log).toHaveLength(1);
    expect(log[0]!.sent).toBe(false);
    expect(log[0]!.blockReason).toBe('CREDENTIAL_MISSING');
    expect(log[0]!.purpose).toBe('CONNECTIVITY_TEST');
  });

  it('origin 是 http（经环境变量注入）：即使有 key 也拒绝发送，记 INSECURE_ORIGIN', async () => {
    // 环境变量能绕过 updateProfile 的校验，所以 testProfile 必须自己再挡一道 ——
    // 这正是本条修复的核心：明文 HTTP 会暴露 API Key。
    process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak';
    process.env.DEEPSEEK_API_BASE = 'http://attacker.example';
    const gw2 = new ModelGateway();

    const r = await gw2.testProfile(profileIdOf('deepseek'), new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('https');

    const log = readEgress();
    const last = log[log.length - 1]!;
    expect(last.sent).toBe(false);
    expect(last.blockReason).toBe('INSECURE_ORIGIN');
    // manifest 里绝不能出现明文 key
    expect(JSON.stringify(log)).not.toContain('sk-should-not-leak');
  });
});
