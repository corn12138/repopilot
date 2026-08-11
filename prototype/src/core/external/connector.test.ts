import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SameVendorReviewDenied,
  assertHeterogeneousVendor,
  descriptorOfConnector,
  discoverConnectors,
  isolatedEnv,
  parseReviewOutput,
  probeConnector,
  runExternalCliReview,
  type ExternalConnectorProfile,
} from './connector';

/**
 * 外部 CLI 连接器。
 *
 * 这一层的风险不在"能不能跑起来"，而在**跑起来的时候它能看到什么**。
 * 把本机装好的 Claude Code / Codex 拉起来当审核方，最坏情况是：
 * 它用你的登录态、读你的 ~/.claude 历史与 settings、顺手把宿主环境里的
 * GITHUB_TOKEN 一起带走。所以这些用例的主体是隔离的**负向断言**：
 * 真实 HOME 不可见、宿主凭据不可见、cwd 里没有仓库。
 *
 * 用真子进程验证，不是读代码确认 —— 隔离这种事，替身证明不了。
 */

const created: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

describe('isolatedEnv：整份替换，不是合并', () => {
  it('只包含明确给出的键 —— 宿主凭据一个都不在', () => {
    const env = isolatedEnv({ pathValue: '/usr/bin', home: '/tmp/fake-home' });
    expect(env.HOME).toBe('/tmp/fake-home');
    expect(env.PATH).toBe('/usr/bin');
    // XDG 全部指向 synthetic home 之内
    for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      expect(env[k]).toContain('/tmp/fake-home');
    }
    // 没给的就是没有
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('凭据只注入调用方显式指定的那一个变量', () => {
    const env = isolatedEnv({
      pathValue: '/usr/bin',
      home: '/tmp/h',
      credential: { name: 'ANTHROPIC_API_KEY', value: 'sk-scoped' },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-scoped');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('原型对象是 null：constructor 这类键不会命中 Object.prototype', () => {
    expect(Object.getPrototypeOf(isolatedEnv({ pathValue: '', home: '/tmp/h' }))).toBeNull();
  });
});

describe('parseReviewOutput：解析不出就是 null，绝不编造发现', () => {
  const ok = '{"verdict":"CHANGES_REQUESTED","findings":[{"severity":"HIGH","blocking":true}]}';

  it('纯 JSON', () => {
    const r = parseReviewOutput(ok);
    expect(r?.verdict).toBe('CHANGES_REQUESTED');
    expect(r?.findings).toHaveLength(1);
  });

  it('围栏包裹的 JSON', () => {
    expect(parseReviewOutput('好的，结论如下：\n```json\n' + ok + '\n```\n')?.verdict).toBe(
      'CHANGES_REQUESTED',
    );
  });

  it('前后带解释性文字的 JSON', () => {
    expect(parseReviewOutput(`我看了一下。\n${ok}\n以上。`)?.verdict).toBe('CHANGES_REQUESTED');
  });

  it('PASS + 空 findings 是合法结论', () => {
    const r = parseReviewOutput('{"verdict":"PASS","findings":[]}');
    expect(r?.verdict).toBe('PASS');
    expect(r?.findings).toEqual([]);
  });

  it.each([
    ['纯散文', '这个补丁看起来没问题。'],
    ['坏 JSON', '{"verdict":"PASS", findings:['],
    ['verdict 不在枚举内', '{"verdict":"LGTM","findings":[]}'],
    ['缺 verdict', '{"findings":[]}'],
    ['空输出', ''],
  ])('%s → null（由调用方记 INCONCLUSIVE，不是假绿灯）', (_label, raw) => {
    expect(parseReviewOutput(raw)).toBeNull();
  });

  it('findings 不是数组时归零，而不是把整个结论丢掉', () => {
    const r = parseReviewOutput('{"verdict":"PASS","findings":"none"}');
    expect(r?.verdict).toBe('PASS');
    expect(r?.findings).toEqual([]);
  });
});

describe('异构 vendor 是不变式，不是披露项', () => {
  it('同 vendor 直接拒绝', () => {
    expect(() => assertHeterogeneousVendor('ANTHROPIC', 'ANTHROPIC')).toThrow(SameVendorReviewDenied);
    try {
      assertHeterogeneousVendor('OPENAI', 'OPENAI');
    } catch (e) {
      expect((e as SameVendorReviewDenied).code).toBe('SAME_VENDOR_REVIEW_DENIED');
    }
  });

  it('异构放行', () => {
    expect(() => assertHeterogeneousVendor('ANTHROPIC', 'OPENAI')).not.toThrow();
  });
});

describe('连接器发现与身份探测', () => {
  it('内置两个连接器，vendor 互异（否则交叉审核永远同厂商）', () => {
    const all = discoverConnectors();
    expect(all.map((c) => c.connectorId).sort()).toEqual(['claude-cli', 'codex-cli']);
    expect(new Set(all.map((c) => c.vendor)).size).toBe(2);
  });

  it('没装的连接器报 NOT_INSTALLED 并给修复建议，不是静默消失', () => {
    const fake = descriptorOfConnector('codex-cli')!;
    const profile = probeConnector({ ...fake, binary: 'definitely-not-installed-xyz' });
    expect(profile.state).toBe('NOT_INSTALLED');
    expect(profile.binaryPath).toBeNull();
    expect(profile.remediation).toContain('PATH');
  });

  it('探测得到版本时给出身份摘要；版本变了摘要就变', () => {
    const bin = tempDir('repopilot-fakebin-');
    const exe = join(bin, 'fakecli');
    writeFileSync(exe, '#!/bin/sh\necho "fakecli 1.2.3"\n');
    chmodSync(exe, 0o755);

    const d = { ...descriptorOfConnector('codex-cli')!, binary: exe };
    const p1 = probeConnector(d);
    expect(p1.state).toBe('READY');
    expect(p1.version).toBe('fakecli 1.2.3');
    expect(p1.identityDigest).toMatch(/^sha256:/);

    writeFileSync(exe, '#!/bin/sh\necho "fakecli 9.9.9"\n');
    chmodSync(exe, 0o755);
    expect(probeConnector(d).identityDigest).not.toBe(p1.identityDigest);
  });

  it('二进制存在但探测失败 → BLOCKED，与"没装"区分开', () => {
    const bin = tempDir('repopilot-badbin-');
    const exe = join(bin, 'badcli');
    writeFileSync(exe, '#!/bin/sh\nexit 3\n');
    chmodSync(exe, 0o755);
    const p = probeConnector({ ...descriptorOfConnector('codex-cli')!, binary: exe });
    expect(p.state).toBe('BLOCKED');
    expect(p.binaryPath).toBe(exe);
  });
});

// ---------------------------------------------------------------------------
// 隔离：用真子进程验证它到底看得到什么
// ---------------------------------------------------------------------------

describe('runExternalCliReview：隔离的负向断言（真子进程）', () => {
  let realHomeMarker: string;

  /** 造一个假 CLI：把自己看到的环境和 cwd 原样吐出来，我们据此断言 */
  function makeSpyCli(body: string): ExternalConnectorProfile {
    const bin = tempDir('repopilot-spycli-');
    const exe = join(bin, 'spycli');
    writeFileSync(exe, `#!/bin/sh\n${body}\n`);
    chmodSync(exe, 0o755);
    return {
      connectorId: 'codex-cli',
      kind: 'CODEX_CLI',
      vendor: 'OPENAI',
      label: 'spy',
      state: 'READY',
      binaryPath: exe,
      version: 'spy 1.0',
      identityDigest: 'sha256:spy',
      credentialEnvVar: 'OPENAI_API_KEY',
      detail: 'spy',
      remediation: null,
    };
  }

  const call = (connector: ExternalConnectorProfile, apiKey = 'sk-scoped-for-review') =>
    runExternalCliReview({
      connector,
      apiKey,
      brief: '补丁摘要（测试）',
      runId: 'run_x',
      attemptId: 'att_x',
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    });

  beforeEach(() => {
    realHomeMarker = process.env.HOME ?? '';
    // 宿主环境里放一个"绝不能泄漏"的凭据
    process.env.REPOPILOT_SECRET_CANARY = 'canary-must-not-leak';
    process.env.GITHUB_TOKEN = 'ghp_must_not_leak';
  });

  afterEach(() => {
    delete process.env.REPOPILOT_SECRET_CANARY;
    delete process.env.GITHUB_TOKEN;
  });

  it('外部 CLI 看到的 HOME 不是你的真实 HOME，且 ~/.claude 那类真配置不可达', async () => {
    const spy = makeSpyCli(
      [
        // 在真实 HOME 下放过的东西，隔离后必须读不到：用是否存在来证明
        'SEES_REAL_CLAUDE_DIR=no',
        '[ -d "$HOME/.claude" ] && SEES_REAL_CLAUDE_DIR=yes',
        'printf \'{"verdict":"PASS","findings":[{"severity":"INFO","blocking":false,"evidence":"HOME=%s|realClaudeDir=%s"}]}\' "$HOME" "$SEES_REAL_CLAUDE_DIR"',
      ].join('\n'),
    );
    const r = await call(spy);
    expect(r.manifest.state).toBe('SEALED');

    const evidence = String(r.submission!.findings[0]!.evidence);
    const seenHome = /HOME=([^|]*)\|/.exec(evidence)?.[1] ?? '';
    expect(seenHome).not.toBe(realHomeMarker);
    expect(seenHome).toContain('repopilot-xagent-');
    // 宿主上确实有 ~/.claude 时，这条才真正有区分力；没有也不会假绿
    expect(evidence).toContain('realClaudeDir=no');
  });

  it('真实 HOME、宿主凭据、GITHUB_TOKEN 全都不在子进程环境里', async () => {
    // CLI 把整份 env 与 cwd 塞进 findings[0].evidence 带回来
    const spy = makeSpyCli(
      [
        'ENVDUMP=$(env | tr "\\n" ";")',
        'CWD=$(pwd)',
        'printf \'{"verdict":"PASS","findings":[{"severity":"INFO","blocking":false,"evidence":"%s|CWD=%s"}]}\' "$ENVDUMP" "$CWD"',
      ].join('\n'),
    );
    const r = await call(spy);
    expect(r.manifest.state).toBe('SEALED');
    const evidence = String(r.submission!.findings[0]!.evidence);

    // 关键负向断言
    expect(evidence).not.toContain('canary-must-not-leak');
    expect(evidence).not.toContain('ghp_must_not_leak');
    expect(evidence).not.toContain('REPOPILOT_SECRET_CANARY');
    expect(evidence).not.toContain(`HOME=${realHomeMarker};`);
    // 正向：显式凭据在，synthetic HOME 在，cwd 是一次性目录（不是仓库）
    expect(evidence).toContain('OPENAI_API_KEY=sk-scoped-for-review');
    expect(evidence).toContain('repopilot-xagent-');
    expect(evidence).toMatch(/CWD=.*repopilot-xagent-/);
  });

  it('调用结束后一次性 HOME 被删除，不在磁盘上留登录态残留', async () => {
    const spy = makeSpyCli(
      [
        'echo "$HOME" > /tmp/repopilot-xagent-home-path.txt',
        'printf \'{"verdict":"PASS","findings":[]}\'',
      ].join('\n'),
    );
    await call(spy);
    const { existsSync, readFileSync } = await import('node:fs');
    const used = readFileSync('/tmp/repopilot-xagent-home-path.txt', 'utf8').trim();
    rmSync('/tmp/repopilot-xagent-home-path.txt', { force: true });
    expect(used).toContain('repopilot-xagent-');
    expect(existsSync(used)).toBe(false);
  });

  it('prompt 走 stdin，不进 argv（避免长度上限与进程表泄漏）', async () => {
    const spy = makeSpyCli(
      [
        'STDIN=$(cat)',
        'LEN=${#STDIN}',
        'ARGS="$*"',
        'printf \'{"verdict":"PASS","findings":[{"severity":"INFO","blocking":false,"evidence":"len=%s|args=%s"}]}\' "$LEN" "$ARGS"',
      ].join('\n'),
    );
    const r = await call(spy);
    const evidence = String(r.submission!.findings[0]!.evidence);
    expect(evidence).toMatch(/len=[1-9]\d{2,}/); // prompt 确实从 stdin 收到了
    expect(evidence).not.toContain('补丁摘要'); // argv 里没有正文
  });
});

describe('runExternalCliReview：失败与拒绝路径都封存 manifest', () => {
  const profileOf = (over: Partial<ExternalConnectorProfile>): ExternalConnectorProfile => ({
    connectorId: 'codex-cli',
    kind: 'CODEX_CLI',
    vendor: 'OPENAI',
    label: 'x',
    state: 'READY',
    binaryPath: '/bin/echo',
    version: '1',
    identityDigest: 'sha256:x',
    credentialEnvVar: 'OPENAI_API_KEY',
    detail: '',
    remediation: null,
    ...over,
  });

  const call = (connector: ExternalConnectorProfile, apiKey: string) =>
    runExternalCliReview({
      connector,
      apiKey,
      brief: 'b',
      runId: 'r',
      attemptId: 'a',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

  it('连接器不 READY → PREFLIGHT 阶段 BLOCKED，根本不发起', async () => {
    const r = await call(profileOf({ state: 'NOT_INSTALLED', binaryPath: null, detail: '没装' }), 'k');
    expect(r.manifest.state).toBe('BLOCKED');
    expect(r.submission).toBeNull();
    expect(r.manifest.failureDetail).toContain('没装');
  });

  it('没有显式凭据 → BLOCKED：拒绝以宿主登录态运行外部 CLI', async () => {
    const r = await call(profileOf({}), '   ');
    expect(r.manifest.state).toBe('BLOCKED');
    expect(r.manifest.failureDetail).toContain('OPENAI_API_KEY');
  });

  it('非零退出 → FAILED，带上 exitCode，不当成"没有发现"', async () => {
    const bin = tempDir('repopilot-failcli-');
    const exe = join(bin, 'failcli');
    writeFileSync(exe, '#!/bin/sh\necho "boom" >&2\nexit 7\n');
    chmodSync(exe, 0o755);
    const r = await call(profileOf({ binaryPath: exe }), 'k');
    expect(r.manifest.state).toBe('FAILED');
    expect(r.manifest.exitCode).toBe(7);
    expect(r.submission).toBeNull();
  });

  it('退出 0 但输出不可解析 → FAILED 并写明"不编造发现"', async () => {
    const bin = tempDir('repopilot-prosecli-');
    const exe = join(bin, 'prosecli');
    writeFileSync(exe, '#!/bin/sh\necho "看起来挺好的"\n');
    chmodSync(exe, 0o755);
    const r = await call(profileOf({ binaryPath: exe }), 'k');
    expect(r.manifest.state).toBe('FAILED');
    expect(r.manifest.failureDetail).toContain('不编造发现');
    expect(r.submission).toBeNull();
  });

  it('manifest 不含 raw secret 与 prompt 正文，只留输入摘要', async () => {
    const r = await call(profileOf({}), 'sk-super-secret');
    expect(JSON.stringify(r.manifest)).not.toContain('sk-super-secret');
    expect(JSON.stringify(r.manifest)).not.toContain('只读审核');
    expect(r.manifest.inputDigest).toMatch(/^sha256:/);
  });
});
