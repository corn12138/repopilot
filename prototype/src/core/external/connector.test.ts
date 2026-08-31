import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SameVendorReviewDenied,
  assertHeterogeneousVendor,
  connectorDescriptors,
  descriptorOfConnector,
  discoverConnectors,
  isolatedEnv,
  parseReviewOutput,
  probeConnector,
  runExternalCliReview,
  type ExternalConnectorProfile,
} from './connector';
import { parseExternalSubmission } from '../agent';

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

  it('PASS + findings 不是数组时归零，而不是把整个结论丢掉', () => {
    // PASS 时发现清单不驱动任何决定，归零是安全的。
    const r = parseReviewOutput('{"verdict":"PASS","findings":"none"}');
    expect(r?.verdict).toBe('PASS');
    expect(r?.findings).toEqual([]);
  });

  /*
   * 同样的归零在 verdict 不是 PASS 时会变成假绿灯：
   * `agent.ts` 判 REVIEWER_PASSED 的条件是 `verdict === 'PASS' || blocking.length === 0`，
   * 所以「要求整改 + 读不出来的 findings」会被当成"审核方没提意见"走完循环。
   * 审核方明说要改，平台却判通过 —— 这是静默通过，不是宽容。
   */
  it.each([
    ['findings 不是数组', '{"verdict":"CHANGES_REQUESTED","findings":"lots"}'],
    ['findings 里混了非对象项', '{"verdict":"CHANGES_REQUESTED","findings":[{"a":1},"oops"]}'],
    ['INCONCLUSIVE 同理', '{"verdict":"INCONCLUSIVE","findings":42}'],
  ])('非 PASS + %s → null，绝不降级成零条阻断', (_label, raw) => {
    const r = parseReviewOutput(raw);
    // 负向断言：任何带着 findings=[] 的非 PASS 结论都会在 agent 里变成 REVIEWER_PASSED。
    expect(r).toBeNull();
  });

  it('非 PASS + 完整可读的 findings 正常通过', () => {
    const r = parseReviewOutput(
      '{"verdict":"CHANGES_REQUESTED","findings":[{"title":"x","blocking":true}]}',
    );
    expect(r?.verdict).toBe('CHANGES_REQUESTED');
    expect(r?.findings).toHaveLength(1);
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
  it('每个连接器的 vendor 互异（否则交叉审核永远同厂商）', () => {
    /*
     * 断言的是**性质**而不是当时恰好有几家：连接器表是会长的（加一家 = 表里一条目），
     * 而"vendor 两两互异"是它必须一直成立的那条 —— 有两条同 vendor 的条目，
     * 用户选中它们做交叉审核就只会撞 SAME_VENDOR_REVIEW_DENIED，
     * 那不是保护，是把一个本该在表里就避免的错误推到运行时。
     */
    const all = discoverConnectors();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(new Set(all.map((c) => c.vendor)).size).toBe(all.length);
    // connectorId 也必须唯一 —— 它是 task.create 的选择键
    expect(new Set(all.map((c) => c.connectorId)).size).toBe(all.length);
  });

  it('没装的连接器报 NOT_INSTALLED 并给修复建议，不是静默消失', () => {
    const fake = descriptorOfConnector('codex-cli')!;
    const profile = probeConnector({
      ...fake,
      binaries: ['definitely-not-installed-xyz'],
      appBundles: [], // 本机真装了 ChatGPT.app，这里要的是"什么都没有"那一支
      bundledBinaryRelPaths: [],
    });
    expect(profile.state).toBe('NOT_INSTALLED');
    expect(profile.binaryPath).toBeNull();
    expect(profile.form).toBeNull();
    // 没装不是错误：如实告诉用户 API 才是更顺的路径
    expect(profile.remediation).toContain('API');
  });

  it('探测得到版本时给出身份摘要；版本变了摘要就变', () => {
    const bin = tempDir('repopilot-fakebin-');
    const exe = join(bin, 'fakecli');
    writeFileSync(exe, '#!/bin/sh\necho "fakecli 1.2.3"\n');
    chmodSync(exe, 0o755);

    const d = { ...descriptorOfConnector('codex-cli')!, binaries: [exe], appBundles: [] };
    const p1 = probeConnector(d);
    expect(p1.state).toBe('READY');
    expect(p1.version).toBe('fakecli 1.2.3');
    expect(p1.identityDigest).toMatch(/^sha256:/);

    writeFileSync(exe, '#!/bin/sh\necho "fakecli 9.9.9"\n');
    chmodSync(exe, 0o755);
    expect(probeConnector(d).identityDigest).not.toBe(p1.identityDigest);
  });

  it('只装了桌面应用 → PRESENT_NOT_AUTOMATABLE，并指向 API 而不是假装能用', () => {
    const appDir = tempDir('repopilot-fakeapp-');
    const bundle = join(appDir, 'ChatGPT.app');
    mkdirSync(bundle, { recursive: true });

    const p = probeConnector({
      ...descriptorOfConnector('codex-cli')!,
      binaries: ['definitely-not-installed-xyz'],
      appBundles: [bundle],
      bundledBinaryRelPaths: [],
    });
    expect(p.state).toBe('PRESENT_NOT_AUTOMATABLE');
    expect(p.form).toBe('DESKTOP_APP');
    expect(p.appPath).toBe(bundle);
    expect(p.binaryPath).toBeNull();
    // 必须说清楚"为什么用不了"和"那该用什么"
    expect(p.remediation).toContain('GUI');
    expect(p.remediation).toContain('API');
  });

  it('.app 内打包了 CLI → BUNDLED_CLI 可用，而不是判成"不可自动化"', () => {
    // 这条钉住一次真实的判断错误：早先版本只看 PATH，PATH 上没有就宣布
    // "只能 GUI 自动化"。而 ChatGPT.app 的 Contents/Resources/codex
    // 是一个完整的非交互 CLI —— 因为没装在常规位置就说它不存在，是错的。
    const appDir = tempDir('repopilot-bundled-');
    const bundle = join(appDir, 'ChatGPT.app');
    const res = join(bundle, 'Contents', 'Resources');
    mkdirSync(res, { recursive: true });
    const exe = join(res, 'codex');
    writeFileSync(exe, '#!/bin/sh\necho "codex-cli 0.147.0"\n');
    chmodSync(exe, 0o755);

    const p = probeConnector({
      ...descriptorOfConnector('codex-cli')!,
      binaries: ['definitely-not-installed-xyz'],
      appBundles: [bundle],
      bundledBinaryRelPaths: ['Contents/Resources/codex'],
    });
    expect(p.state).toBe('READY');
    expect(p.form).toBe('BUNDLED_CLI');
    expect(p.binaryPath).toBe(exe);
    expect(p.version).toBe('codex-cli 0.147.0');
    // 来源要能看出来：卸载/升级桌面应用会让它消失
    expect(p.detail).toContain('随桌面应用分发');
  });

  it('.app 存在但里面没有 CLI → 这才是真的不可自动化（Claude.app 实测如此）', () => {
    const appDir = tempDir('repopilot-noclibundle-');
    const bundle = join(appDir, 'Claude.app');
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });

    const p = probeConnector({
      ...descriptorOfConnector('claude-cli')!,
      binaries: ['definitely-not-installed-xyz'],
      appBundles: [bundle],
      bundledBinaryRelPaths: ['Contents/Resources/claude'],
    });
    expect(p.state).toBe('PRESENT_NOT_AUTOMATABLE');
    expect(p.form).toBe('DESKTOP_APP');
    expect(p.remediation).toContain('API');
  });

  it('独立 CLI 优先于 bundle 内的那份 —— 用户自己装的更可控', () => {
    const bin = tempDir('repopilot-standalone-');
    const exe = join(bin, 'standalonecli');
    writeFileSync(exe, '#!/bin/sh\necho "standalone 3.0"\n');
    chmodSync(exe, 0o755);
    const appDir = tempDir('repopilot-alsoapp-');
    const bundle = join(appDir, 'ChatGPT.app');
    const res = join(bundle, 'Contents', 'Resources');
    mkdirSync(res, { recursive: true });
    const bundled = join(res, 'codex');
    writeFileSync(bundled, '#!/bin/sh\necho "bundled 0.1"\n');
    chmodSync(bundled, 0o755);

    const p = probeConnector({
      ...descriptorOfConnector('codex-cli')!,
      binaries: [exe],
      appBundles: [bundle],
      bundledBinaryRelPaths: ['Contents/Resources/codex'],
    });
    expect(p.form).toBe('CLI');
    expect(p.binaryPath).toBe(exe);
  });

  it('CLI 与桌面应用同时存在时优先 CLI —— 可自动化的那个才是入口', () => {
    const bin = tempDir('repopilot-bothcli-');
    const exe = join(bin, 'bothcli');
    writeFileSync(exe, '#!/bin/sh\necho "both 1.0"\n');
    chmodSync(exe, 0o755);
    const appDir = tempDir('repopilot-bothapp-');
    const bundle = join(appDir, 'ChatGPT.app');
    mkdirSync(bundle, { recursive: true });

    const p = probeConnector({
      ...descriptorOfConnector('codex-cli')!,
      binaries: [exe],
      appBundles: [bundle],
      bundledBinaryRelPaths: [],
    });
    expect(p.state).toBe('READY');
    expect(p.form).toBe('CLI');
    expect(p.appPath).toBe(bundle); // 桌面应用照样如实记录
  });

  it('环境变量可覆盖路径 —— 装在非常规位置也能用，不逼用户改 PATH', () => {
    const bin = tempDir('repopilot-overridecli-');
    const exe = join(bin, 'weird-name');
    writeFileSync(exe, '#!/bin/sh\necho "weird 2.0"\n');
    chmodSync(exe, 0o755);
    const d = descriptorOfConnector('codex-cli')!;

    process.env[d.binaryPathEnv] = exe;
    try {
      const p = probeConnector({ ...d, binaries: ['nope-xyz'], appBundles: [] });
      expect(p.state).toBe('READY');
      expect(p.binaryPath).toBe(exe);
      expect(p.version).toBe('weird 2.0');
    } finally {
      delete process.env[d.binaryPathEnv];
    }
  });

  it('覆盖变量指向不存在的路径 → BLOCKED，不静默回落到 PATH', () => {
    const d = descriptorOfConnector('codex-cli')!;
    process.env[d.binaryPathEnv] = '/nonexistent/nope';
    try {
      const p = probeConnector({ ...d, binaries: ['sh'], appBundles: [] });
      expect(p.state).toBe('BLOCKED');
      expect(p.detail).toContain(d.binaryPathEnv);
    } finally {
      delete process.env[d.binaryPathEnv];
    }
  });

  it('二进制存在但探测失败 → BLOCKED，与"没装"区分开', () => {
    const bin = tempDir('repopilot-badbin-');
    const exe = join(bin, 'badcli');
    writeFileSync(exe, '#!/bin/sh\nexit 3\n');
    chmodSync(exe, 0o755);
    const p = probeConnector({
      ...descriptorOfConnector('codex-cli')!,
      binaries: [exe],
      appBundles: [],
    });
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
      form: 'CLI',
      appPath: null,
      binaryPath: exe,
      version: 'spy 1.0',
      identityDigest: 'sha256:spy',
      credentialEnvVar: 'OPENAI_API_KEY',
      authorAdmitted: true,
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
    /*
     * 证据必须**有界**，而且失败时要直接说出漏了什么。
     *
     * 上一版让 CLI 把整份 `env`（含值）带回来。两个问题：
     *   1. 宿主 PATH 在开发机上就有 ~3000 字节，而平台对 stdout 预览有 4000 字节
     *      上限，超了整份判为不可解析。于是这条用例的成败取决于"仓库检出到多深的
     *      目录" —— 实测同一份代码，深一层路径下 PATH 从 2996 涨到 3451 就必红，
     *      红成 `expected 'FAILED' to be 'SEALED'`，看着像隔离坏了。CI 的 PATH
     *      通常更长，这条迟早在那里炸，而且炸得让人查错方向。
     *   2. 更糟的是**真泄漏时也报截断**：一旦有人把宿主环境合并进来，
     *      dump 立刻撑爆上限，用例是红了，但红的理由是"输出被截断"，
     *      没有一个字提到泄漏。
     *
     * 现在改成让 CLI 自己算判据：**键的清单**（证明整份替换 —— 任何多出来的键
     * 都会现形）+ **逐项泄漏检查**（直接对值 grep，命中就点名）。
     * 两者都是有界的，且失败信息直接指向原因。
     */
    const spy = makeSpyCli(
      [
        // 只带键名：足以证明"没有别的东西漏进来"，且长度不随宿主 PATH 变化
        'KEYS=$(env | cut -d= -f1 | sort | tr "\\n" ",")',
        // 逐项对**值**检查，命中就点名 —— 泄漏时不会被别的失败盖过去
        'LEAKS=""',
        'env | grep -q "canary-must-not-leak" && LEAKS="${LEAKS}canary,"',
        'env | grep -q "ghp_must_not_leak" && LEAKS="${LEAKS}github-token,"',
        'printf \'{"verdict":"PASS","findings":[{"severity":"INFO","blocking":false,"evidence":"KEYS=%s|LEAKS=%s|HOME=%s|CWD=%s"}]}\' "$KEYS" "$LEAKS" "$HOME" "$(pwd)"',
      ].join('\n'),
    );
    const r = await call(spy);
    // 先看原因再看状态：SEALED 断言失败时，光看 'FAILED' 三个字查不出到底怎么了
    expect(r.manifest.failureDetail).toBeNull();
    expect(r.manifest.state).toBe('SEALED');
    const evidence = String(r.submission!.findings[0]!.evidence);

    // 关键负向断言：一个都不许漏，漏了直接在这一行看到漏的是哪个
    expect(evidence).toContain('|LEAKS=|');
    expect(evidence).not.toContain('REPOPILOT_SECRET_CANARY');
    expect(evidence).not.toContain('GITHUB_TOKEN');
    expect(evidence).not.toContain(realHomeMarker);

    // 正向：显式凭据在、PATH 在（否则 CLI 找不到自己的 node）、synthetic HOME 在
    expect(evidence).toContain('OPENAI_API_KEY');
    expect(evidence).toContain('PATH');
    expect(evidence).toMatch(/HOME=[^|]*repopilot-xagent-/);
    // cwd 是一次性目录，不是仓库 —— 审核方连坐标系都没有
    expect(evidence).toMatch(/CWD=[^|]*repopilot-xagent-/);

    /*
     * 整份替换的正面证据：键的数量就是 isolatedEnv 明确给出的那几个
     * （PATH/HOME/4×XDG/TMPDIR/LANG/CI/NO_COLOR/TERM/凭据），再加 shell 自己
     * 注入的少数几个。给一个宽松上界即可 —— 宿主环境一旦合并进来是几十上百个，
     * 差着数量级，不会误判。
     */
    const keys = /KEYS=([^|]*)\|/.exec(evidence)?.[1]?.split(',').filter(Boolean) ?? [];
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.length).toBeLessThan(20);
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
    form: 'CLI',
    appPath: null,
    binaryPath: '/bin/echo',
    version: '1',
    identityDigest: 'sha256:x',
    credentialEnvVar: 'OPENAI_API_KEY',
    authorAdmitted: true,
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
    const r = await call(
      profileOf({ state: 'NOT_INSTALLED', form: null, binaryPath: null, detail: '没装' }),
      'k',
    );
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

/*
 * "只换选手不换规则"的落点：外部 CLI 交回的发现，必须和模型 API 走
 * 同一套 schema 校验与同一套平台指纹。指纹是"多轮之间有没有进展"的判据 ——
 * 换个选手就能自报指纹，收敛判定立刻废掉。
 */
describe('外部 CLI 的发现与模型 API 走同一套归一化', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    severity: 'HIGH',
    confidence: 0.9,
    file: 'src/app.ts',
    startLine: 1,
    endLine: 2,
    evidence: '缺少空值检查',
    blocking: true,
    ...over,
  });

  it('合法结论被接受，指纹由平台计算', () => {
    const r = parseExternalSubmission('CHANGES_REQUESTED', [finding()]);
    expect(r?.verdict).toBe('CHANGES_REQUESTED');
    expect(r?.findings[0]!.fingerprint).toMatch(/^sha256:/);
    expect(r?.findings[0]!.range).toEqual([1, 2]);
  });

  it('CLI 自报的 fingerprint 被忽略 —— 被审方不能操纵进展判据', () => {
    const withFake = parseExternalSubmission('CHANGES_REQUESTED', [
      finding({ fingerprint: 'CLI_SUPPLIED_FAKE' }),
    ]);
    const without = parseExternalSubmission('CHANGES_REQUESTED', [finding()]);
    expect(withFake?.findings[0]!.fingerprint).not.toBe('CLI_SUPPLIED_FAKE');
    // 同样的事实 → 同样的指纹，与是谁报的、报没报指纹无关
    expect(withFake?.findings[0]!.fingerprint).toBe(without?.findings[0]!.fingerprint);
  });

  it('不合法的 finding 整条结论作废 → null，不吞掉坏项凑数', () => {
    expect(parseExternalSubmission('PASS', [finding({ severity: 'CATASTROPHIC' })])).toBeNull();
    expect(parseExternalSubmission('PASS', [finding({ evidence: 123 })])).toBeNull();
  });

  it('PASS + 空 findings 合法', () => {
    const r = parseExternalSubmission('PASS', []);
    expect(r?.verdict).toBe('PASS');
    expect(r?.findings).toEqual([]);
  });
});

describe('extraEnv：描述符可以给非密变量，但覆盖不了隔离本身', () => {
  /**
   * 为什么要有 extraEnv：隔离环境是整份替换的，CLI 拿不到任何宿主环境。
   * 但有些 CLI 需要几个**非机密**变量才能在这种环境里正常工作 ——
   * 关掉自动更新与远端目录拉取、用 inline 形式下发权限配置。
   * 这些是平台的决定，属于描述符，不属于运行时输入。
   *
   * 而它必须**覆盖不了隔离键**：描述符里一行 `HOME: '/Users/…'` 就能把
   * synthetic HOME 指回真实 HOME，整套隔离（读不到 ~/.claude、读不到登录态）
   * 一句配置就没了。这一条由赋值顺序保证 —— 黑名单会漏，顺序不会。
   */
  it('非密变量原样注入', () => {
    const env = isolatedEnv({
      pathValue: '/usr/bin',
      home: '/tmp/h',
      extraEnv: { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: '{"a":1}' },
    });
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"a":1}');
  });

  it('覆盖不了 HOME / PATH / XDG —— 一行配置不能把隔离指回真实 HOME', () => {
    const env = isolatedEnv({
      pathValue: '/usr/bin',
      home: '/tmp/synthetic',
      extraEnv: {
        HOME: '/Users/victim',
        PATH: '/evil/bin',
        XDG_CONFIG_HOME: '/Users/victim/.config',
        TMPDIR: '/Users/victim/tmp',
      },
    });
    expect(env.HOME).toBe('/tmp/synthetic');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/synthetic/.config');
    expect(env.TMPDIR).toBe('/tmp/synthetic/tmp');
  });

  it('覆盖不了凭据变量 —— 描述符不能把 key 换成自己写死的值', () => {
    const env = isolatedEnv({
      pathValue: '/usr/bin',
      home: '/tmp/h',
      credential: { name: 'DEEPSEEK_API_KEY', value: 'sk-real' },
      extraEnv: { DEEPSEEK_API_KEY: 'sk-planted' },
    });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-real');
  });

  it('内置表里的 extraEnv 一律不含凭据字面量（不变式 7：凭据不落别处）', () => {
    /*
     * 这条守的是形状纪律：extraEnv 的值是编译期字面量，所以它**结构上**装不下
     * 运行时的 key。但人可能手滑把一个测试用的 sk-… 粘进表里，那就等于
     * 把凭据写进了源码。这里逐条扫一遍，不靠自觉。
     */
    for (const d of connectorDescriptors()) {
      for (const [k, v] of Object.entries(d.extraEnv ?? {})) {
        expect(`${k}=${v}`).not.toMatch(/sk-[A-Za-z0-9]|Bearer\s|api[_-]?key["'\s]*[:=]\s*["'][^"']/i);
        // 凭据变量本身也不该出现在 extraEnv 里 —— 它只有 credential 一条路
        expect(k).not.toBe(d.credentialEnvVar);
      }
    }
  });
});

describe('分阶段准入：可以只准入审核方角色', () => {
  /**
   * 两个角色的证据门槛差得远：审核方只读一段 diff、cwd 是空目录，
   * "它能不能写文件"根本不影响结果；作者要在 candidate 目录里真的改代码，
   * 那条路上「工具白名单能不能压住 shell」是安全边界，必须有实测证据。
   *
   * 没有分阶段准入，选择就只剩「整家都不接」或「连没验过的作者角色一起接」——
   * 前者浪费掉已经站得住的那一半证据，后者拿安全边界赌文档。
   */
  it('authorArgv 为 null 的连接器，profile 上如实标注未准入作者角色', () => {
    const opencode = connectorDescriptors().find((d) => d.connectorId === 'opencode-deepseek');
    expect(opencode).toBeTruthy();
    expect(opencode!.authorArgv).toBeNull();
    expect(probeConnector(opencode!).authorAdmitted).toBe(false);

    // 对照：已准入作者角色的两家
    for (const id of ['claude-cli', 'codex-cli']) {
      const d = connectorDescriptors().find((x) => x.connectorId === id)!;
      expect(d.authorArgv).not.toBeNull();
      expect(probeConnector(d).authorAdmitted).toBe(true);
    }
  });

  it('OpenCode 的出站开关与只读权限配置在表里就钉死了', () => {
    const d = connectorDescriptors().find((x) => x.connectorId === 'opencode-deepseek')!;
    // 隔离环境里的出站要能向安全评审交代：两条启动期出站都关掉
    expect(d.extraEnv?.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
    expect(d.extraEnv?.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    /*
     * 权限走 inline（OPENCODE_CONFIG_CONTENT，precedence 6）而不是
     * OPENCODE_CONFIG（precedence 3）—— 后者低于目标仓库自带的 opencode.json（4），
     * 任何仓库都能用自己的配置把我们的 deny 盖掉。这是个真实的沙箱逃逸口。
     */
    expect(d.extraEnv?.OPENCODE_CONFIG).toBeUndefined();
    const perm = JSON.parse(d.extraEnv!.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, unknown>;
    };
    expect(perm.permission.bash).toEqual({ '*': 'deny' });
    expect(perm.permission.edit).toEqual({ '*': 'deny' });
    // 子代理是条未验证的旁路，一并堵死
    expect(perm.permission.task).toEqual({ '*': 'deny' });
  });

  it('prompt 不进 argv：审核入口的 argv 里没有 positional message，也没有 `-`', () => {
    /*
     * 硬需求：prompt 进 argv 会在进程列表里可见。OpenCode 判 stdin 是否 TTY，
     * 非 TTY 就整块读走当 prompt —— 所以 argv 里**必须什么都不放**。
     * 也不能写 `opencode run -`：源码里没有对 `-` 的特殊处理，它会被当成
     * 普通 message，把 prompt 污染成 `-\n<正文>`。
     */
    const d = connectorDescriptors().find((x) => x.connectorId === 'opencode-deepseek')!;
    expect(d.reviewArgv).toEqual(['run', '--model', 'deepseek/deepseek-chat']);
    expect(d.reviewArgv).not.toContain('-');
  });
});
