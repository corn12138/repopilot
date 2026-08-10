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
import { InvocationFailed, ModelGateway, profileIdOf } from './gateway';
import { isRetryable, retryDelayMs } from './retry';
import { ModelCallError } from './types';
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

/*
 * 有界同 route 重试（TD model-invocation §4 的诚实子集）。
 * 这组测的是 invoke 层的重试判断与记账：什么失败会再试、什么失败一次都不多发、
 * 每次尝试是否独立落账。分类本身（sendState 怎么来）在 adapters.test.ts。
 */
describe('invoke: 有界同 route 重试 + 单次尝试超时', () => {
  const FAST = {
    maxSendAttempts: 3,
    baseDelayMs: 2,
    maxDelayMs: 4,
    retryAfterCapMs: 10,
    perAttemptTimeoutMs: 30_000,
  };

  const OK_BODY = JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  });
  const ok = (): Response =>
    new Response(OK_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
  const http = (status: number): Response =>
    new Response(JSON.stringify({ error: { message: 'boom' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const connRefused = (): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const connReset = (): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

  beforeEach(() => {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = 'sk-retry-test';
  });
  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
  });

  /** 每次调用按脚本出牌：元素是 Response 或要抛出的错误；越界则复读最后一张 */
  function scriptFetch(script: Array<Response | Error | (() => never)>): ReturnType<typeof vi.fn> {
    let i = 0;
    const fn = vi.fn(async () => {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      if (step instanceof Response) return step.clone();
      if (typeof step === 'function') return step();
      throw step;
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function makeInput(gw: ModelGateway, signal?: AbortSignal) {
    return {
      runId: 'run-retry',
      attemptId: 'attempt-retry',
      purpose: 'EXECUTION' as const,
      resolution: gw.freezeRoute(profileIdOf('deepseek')),
      request: {
        system: 's',
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
        tools: [],
        maxOutputTokens: 16,
        temperature: 0,
      },
      contextFileRefs: [],
      signal: signal ?? new AbortController().signal,
    };
  }

  it('连接被拒一次后成功：第 2 次尝试返回，第 1 次独立落账且如实 sent=false', async () => {
    const fetchMock = scriptFetch([connRefused(), ok()]);
    const gw = new ModelGateway(FAST);
    const out = await gw.invoke(makeInput(gw));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.inputTokens).toBe(3);
    expect(out.manifest.sendAttempt).toBe(2);
    expect(out.manifest.sendState).toBe('RESPONDED');

    const mid = readEgress().filter((m) => m.runId === 'run-retry');
    expect(mid).toHaveLength(1);
    expect(mid[0]!.sendAttempt).toBe(1);
    expect(mid[0]!.sent).toBe(false); // 连接都没建立，不能记成已出站
    expect(mid[0]!.sendState).toBe('NOT_SENT');
    expect(mid[0]!.errorKind).toBe('NETWORK');
    // 中间尝试与最终结果共享同一 invocationId —— 是同一次调用的多次发送
    expect(mid[0]!.invocationId).toBe(out.invocationId);
  });

  it('5xx 连续失败：用满 maxSendAttempts 后抛出，最终 manifest 记第 3 次', async () => {
    const fetchMock = scriptFetch([http(503)]);
    const gw = new ModelGateway(FAST);
    const err = await gw.invoke(makeInput(gw)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvocationFailed);
    const f = err as InvocationFailed;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(f.cause.kind).toBe('SERVER');
    expect(f.manifest.sendAttempt).toBe(3);
    expect(f.manifest.sent).toBe(true);
  });

  it('AUTH（401）不重试：一次都不多发', async () => {
    const fetchMock = scriptFetch([http(401)]);
    const gw = new ModelGateway(FAST);
    const err = await gw.invoke(makeInput(gw)).catch((e: unknown) => e);

    expect((err as InvocationFailed).cause.kind).toBe('AUTH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('发出去后连接被重置（结局不明）不重试 —— 重发可能重复执行、重复计费', async () => {
    const fetchMock = scriptFetch([connReset()]);
    const gw = new ModelGateway(FAST);
    const err = await gw.invoke(makeInput(gw)).catch((e: unknown) => e);

    const f = err as InvocationFailed;
    expect(f.cause.kind).toBe('NETWORK');
    expect(f.cause.sendState).toBe('SENT_OUTCOME_UNKNOWN');
    expect(f.manifest.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('单次尝试超时 → TIMEOUT，且不重试（超时后结局不明）', async () => {
    const fn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fn);
    const gw = new ModelGateway({ ...FAST, perAttemptTimeoutMs: 20 });

    const started = Date.now();
    const err = await gw.invoke(makeInput(gw)).catch((e: unknown) => e);
    const f = err as InvocationFailed;

    expect(f).toBeInstanceOf(InvocationFailed);
    expect(f.cause.kind).toBe('TIMEOUT');
    expect(f.manifest.sendAttempt).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5_000); // 没有等墙钟，是单次超时切断的
  });

  it('退避途中取消：立即 CANCELLED，下一次尝试不会发起且如实记 NOT_SENT', async () => {
    const fetchMock = scriptFetch([connRefused()]);
    const controller = new AbortController();
    const gw = new ModelGateway({ ...FAST, baseDelayMs: 5_000, maxDelayMs: 5_000 });

    const pending = gw.invoke(makeInput(gw, controller.signal)).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 10);
    const err = (await pending) as InvocationFailed;

    expect(err).toBeInstanceOf(InvocationFailed);
    expect(err.cause.kind).toBe('CANCELLED');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 第二次没发起
    expect(err.manifest.sendAttempt).toBe(2);
    expect(err.manifest.sent).toBe(false);
    expect(err.manifest.sendState).toBe('NOT_SENT');
  });

  it('外部取消永远优先：即使错误本身可重试，也直接 CANCELLED 不再试', async () => {
    let controller!: AbortController;
    const fn = vi.fn(async () => {
      controller.abort(); // 在请求处理中被用户取消
      throw connRefused(); // 而错误形状本来是可重试的
    });
    vi.stubGlobal('fetch', fn);
    const gw = new ModelGateway(FAST);
    controller = new AbortController();

    const err = (await gw
      .invoke(makeInput(gw, controller.signal))
      .catch((e: unknown) => e)) as InvocationFailed;
    expect(err.manifest.errorKind).toBe('CANCELLED');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('retry 策略纯函数：什么能重试、等多久', () => {
  const policy = {
    maxSendAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryAfterCapMs: 20_000,
    perAttemptTimeoutMs: 240_000,
  };
  const err = (
    kind: ConstructorParameters<typeof ModelCallError>[1],
    sendState?: 'NOT_SENT' | 'SENT_OUTCOME_UNKNOWN' | 'RESPONDED',
    retryAfterMs?: number | null,
  ) => new ModelCallError('x', kind, null, { sendState, retryAfterMs });

  it.each([
    ['RATE_LIMIT', undefined, true],
    ['SERVER', undefined, true],
    ['NETWORK', 'NOT_SENT', true],
    ['NETWORK', 'SENT_OUTCOME_UNKNOWN', false],
    ['TIMEOUT', 'SENT_OUTCOME_UNKNOWN', false],
    ['AUTH', undefined, false],
    ['BAD_REQUEST', undefined, false],
    ['PARSE', undefined, false],
    ['CANCELLED', undefined, false],
  ] as const)('%s + sendState=%s → 可重试=%s', (kind, sendState, expected) => {
    expect(isRetryable(err(kind, sendState))).toBe(expected);
  });

  it('Retry-After 优先于指数退避，且被封顶', () => {
    expect(retryDelayMs(err('RATE_LIMIT', 'RESPONDED', 2_000), 1, policy)).toBe(2_000);
    expect(retryDelayMs(err('RATE_LIMIT', 'RESPONDED', 60_000), 1, policy)).toBe(20_000);
  });

  it('指数退避有上限，抖动只向下不向上', () => {
    // random=1 → 全额；attempt 5 的全额 500*16=8000 恰好触顶
    expect(retryDelayMs(err('SERVER'), 5, policy, () => 1)).toBe(8_000);
    expect(retryDelayMs(err('SERVER'), 10, policy, () => 1)).toBe(8_000);
    // random=0 → 半额下界
    expect(retryDelayMs(err('SERVER'), 1, policy, () => 0)).toBe(250);
    expect(retryDelayMs(err('SERVER'), 1, policy, () => 1)).toBe(500);
  });
});
