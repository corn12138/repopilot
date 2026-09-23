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
import { EgressBlocked, InvocationFailed, ModelGateway, profileIdOf } from './gateway';
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
    const resolution = gw.freezeRoute(profileIdOf('deepseek'));
    return {
      runId: 'run-retry',
      attemptId: 'attempt-retry',
      purpose: 'EXECUTION' as const,
      resolution,
      // 出站同意覆盖这条冻结路由（PRD-DATA-001）；缺失/不覆盖的负向用例见下面的 describe
      consent: { disclosureDigest: 'sha256:test-disclosure', resolutionDigests: [resolution.digest] },
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
    const dispatched: number[] = [];
    const out = await gw.invoke({
      ...makeInput(gw),
      onDispatch: (attempt) => dispatched.push(attempt.sendAttempt),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([1, 2]);
    expect(out.response.inputTokens).toBe(3);
    expect(out.manifest.sendAttempt).toBe(2);
    expect(out.manifest.sendState).toBe('RESPONDED');
    // 拿到响应才有结束原因可记
    expect(out.manifest.stopReason).toBe('END_TURN');

    const mid = readEgress().filter((m) => m.runId === 'run-retry');
    expect(mid).toHaveLength(1);
    expect(mid[0]!.sendAttempt).toBe(1);
    expect(mid[0]!.sent).toBe(false); // 连接都没建立，不能记成已出站
    expect(mid[0]!.sendState).toBe('NOT_SENT');
    expect(mid[0]!.errorKind).toBe('NETWORK');
    // 没有响应就没有结束原因 —— 留空，补成任何值都是编造
    expect(mid[0]!.stopReason).toBeUndefined();
    // 中间尝试与最终结果共享同一 invocationId —— 是同一次调用的多次发送
    expect(mid[0]!.invocationId).toBe(out.invocationId);
  });

  it('派发前持久化回调失败：一次请求都不发送，也不包装成可重试网络错误', async () => {
    const fetchMock = scriptFetch([ok()]);
    const gw = new ModelGateway(FAST);
    const failure = new Error('state persistence failed');

    const error = await gw.invoke({
      ...makeInput(gw),
      onDispatch: () => { throw failure; },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * 截断也要如实落账。
   *
   * 放在这个 describe 里是因为 makeInput / scriptFetch 装置在此（与"消息序列合法性"
   * 那组住在 budget 测试里同一个道理）—— 主题上它属于出站账本，不属于重试。
   *
   * 落点要说准：Run 内的调用清单**不进**全局 egress.jsonl，而是随 MODEL_INVOCATION
   * 事件的 payload 进该 Run 自己的事件流（见 gateway.ts 对 appendEgress 的说明）；
   * 全局那份只收无 Run 归属的连通性测试与中间失败尝试。所以这里断言的是返回给
   * 调用方的 manifest —— 它就是随后被写进 Run 事件流的那一份。
   *
   * 没有这个字段，一次被截断的调用和一次干净的 END_TURN 在事件流里长得一模一样，
   * 事后无从统计截断率 —— 而截断率是判断"该不该调 maxOutputTokens、该不该收窄任务"
   * 的唯一依据。
   */
  it('finish_reason=length → manifest 记 MAX_TOKENS，不美化成 END_TURN', async () => {
    const lengthBody = JSON.stringify({
      choices: [{ message: { content: '我改了一半，接下来' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 16 },
    });
    scriptFetch([
      new Response(lengthBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const gw = new ModelGateway(FAST);
    const out = await gw.invoke(makeInput(gw));

    expect(out.manifest.sendState).toBe('RESPONDED');
    expect(out.manifest.stopReason).toBe('MAX_TOKENS');
    // 响应正文照旧返回：门禁拦的是执行，不是记录
    expect(out.response.stopReason).toBe('MAX_TOKENS');
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

  /**
   * 流式路径的重试语义。
   *
   * 这里钉的不是"能不能流"，是**一次尝试作废时界面上那半截文本会怎样**：
   * 不撤回的话，重试成功后新旧两段会首尾相接，而前一段是模型没有完成的输出；
   * 最终失败时更糟 —— 界面留着半句话，看起来像模型说过。
   */
  describe('流式：作废的尝试必须撤回已推出去的增量', () => {
    const sse = (body: string): Response =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const SSE_OK =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n' +
      'data: [DONE]\n\n';

    it('给了 onStream 就走流式，增量按序到达，权威结果与非流式同构', async () => {
      scriptFetch([sse(SSE_OK)]);
      const gw = new ModelGateway(FAST);
      const signals: Array<{ kind: string; text?: string; reason?: string }> = [];

      const out = await gw.invoke({ ...makeInput(gw), onStream: (s) => signals.push(s) });

      expect(signals).toEqual([{ kind: 'delta', text: 'ok' }]);
      expect(out.response.content).toEqual([{ type: 'text', text: 'ok' }]);
      // 账本数字照常 —— 流式不能把每一轮都变成"未知用量轮"
      expect(out.manifest.inputTokens).toBe(3);
      expect(out.manifest.outputTokens).toBe(5);
    });

    it('第一次连接被拒 → 重试前先 reset，第二次的增量不会接在废文本后面', async () => {
      scriptFetch([connRefused(), sse(SSE_OK)]);
      const gw = new ModelGateway(FAST);
      const signals: Array<{ kind: string; text?: string; reason?: string }> = [];

      await gw.invoke({ ...makeInput(gw), onStream: (s) => signals.push(s) });

      expect(signals.map((s) => s.kind)).toEqual(['reset', 'delta']);
    });

    it('最终失败也 reset —— 半截文本不许留在界面上冒充模型说过的话', async () => {
      scriptFetch([http(503)]);
      const gw = new ModelGateway(FAST);
      const signals: Array<{ kind: string; reason?: string }> = [];

      await gw.invoke({ ...makeInput(gw), onStream: (s) => signals.push(s) }).catch(() => {});

      expect(signals.every((s) => s.kind === 'reset')).toBe(true);
      expect(signals.length).toBeGreaterThan(0);
    });

    it('不给 onStream 就不走流式：请求体里没有 stream 开关', async () => {
      const fetchMock = scriptFetch([ok()]);
      const gw = new ModelGateway(FAST);
      await gw.invoke(makeInput(gw));
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
      expect(body.stream).toBeUndefined();
    });
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


describe('invoke: 出站同意与最小 DLP 在发送前阻断（PRD-DATA-001/003）', () => {
  function gatewayWithKey(): ModelGateway {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test-key-for-consent';
    return new ModelGateway();
  }
  function input(gw: ModelGateway, overrides: Record<string, unknown> = {}) {
    const resolution = gw.freezeRoute(profileIdOf('deepseek'));
    return {
      runId: 'run-consent',
      attemptId: 'attempt-consent',
      purpose: 'PLANNING' as const,
      resolution,
      consent: { disclosureDigest: 'sha256:d', resolutionDigests: [resolution.digest] },
      request: {
        system: 's',
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
        tools: [],
        maxOutputTokens: 16,
        temperature: 0,
      },
      contextFileRefs: [],
      signal: new AbortController().signal,
      ...overrides,
    };
  }
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    vi.unstubAllGlobals();
  });

  it('没有 consent → CONSENT_MISSING，NOT_SENT，fetch 一次都没被调用', async () => {
    const gw = gatewayWithKey();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await gw.invoke(input(gw, { consent: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlocked);
    expect((err as EgressBlocked).reason).toBe('CONSENT_MISSING');
    expect((err as EgressBlocked).manifest.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('consent 不覆盖这条冻结路由 → CONSENT_STALE（同意过别的路由不算）', async () => {
    const gw = gatewayWithKey();
    vi.stubGlobal('fetch', vi.fn());
    const err = await gw
      .invoke(input(gw, { consent: { disclosureDigest: 'sha256:d', resolutionDigests: ['sha256:some-other-route'] } }))
      .catch((e: unknown) => e);
    expect((err as EgressBlocked).reason).toBe('CONSENT_STALE');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('CONNECTIVITY_TEST 不要求 consent（披露在设置页本身），其他 purpose 都要求', async () => {
    const gw = gatewayWithKey();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const out = await gw.invoke(input(gw, { purpose: 'CONNECTIVITY_TEST', consent: null }));
    expect(out.manifest.sent).toBe(true);
    for (const purpose of ['EXECUTION', 'SELF_FIX', 'CROSS_REVIEW', 'COMPACTION', 'TITLE_SUMMARY'] as const) {
      const err = await gw.invoke(input(gw, { purpose, consent: null })).catch((e: unknown) => e);
      expect((err as EgressBlocked).reason).toBe('CONSENT_MISSING');
    }
  });

  it('对话里出现高置信度凭据（AWS key / 私钥头 / Bearer）→ DLP 阻断，原因只含种类与位置、不含原文', async () => {
    const gw = gatewayWithKey();
    vi.stubGlobal('fetch', vi.fn());
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const err = await gw
      .invoke(
        input(gw, {
          request: {
            system: 's',
            messages: [
              { role: 'user' as const, content: [{ type: 'text' as const, text: 'please read config' }] },
              { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'tu1', name: 'fs_read', input: { path: 'config.ts' } }] },
              {
                role: 'user' as const,
                content: [{ type: 'tool_result' as const, toolUseId: 'tu1', content: `AWS_ACCESS_KEY_ID=${secret}\n-----BEGIN RSA PRIVATE KEY-----\nabc`, isError: false }],
              },
            ],
            tools: [],
            maxOutputTokens: 16,
            temperature: 0,
          },
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlocked);
    const reason = (err as EgressBlocked).reason;
    expect(reason).toContain('DLP: AWS_ACCESS_KEY_ID, PRIVATE_KEY_BLOCK');
    expect(reason).toContain('message[2].tool_result');
    expect(reason).not.toContain(secret);
    expect(JSON.stringify((err as EgressBlocked).manifest)).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('普通代码文本（含 "password" 字样、短 token 占位符）不触发 DLP —— 只做高置信度', async () => {
    const gw = gatewayWithKey();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const out = await gw.invoke(
      input(gw, {
        request: {
          system: 's',
          messages: [
            {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: 'const password = process.env.PASSWORD; const token = "sk-test"; // AKIA placeholder: AKIA...' }],
            },
          ],
          tools: [],
          maxOutputTokens: 16,
          temperature: 0,
        },
      }),
    );
    expect(out.manifest.sent).toBe(true);
  });
});
