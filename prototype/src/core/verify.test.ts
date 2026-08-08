import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommandDefinition,
  CommandOutcome,
  RepositoryHarnessProfile,
  VerificationRun,
} from '@shared/domain';
import { digestOf } from '@shared/ids';
import { compareVerification, runVerification, summarizeFailures } from './verify';
import { listTree } from './workspace';
import type { MaterializedWorkspace } from './workspace';

/**
 * verify.ts 是整个产品"能不能声称成功"的判定点。
 *
 * 它一旦说谎，后面所有东西都在说谎：补丁会被标成 verified，终态会变成 SUCCEEDED，
 * 用户会把没验证过的改动 merge 进去。所以这里的测试重点不是"跑通了没"，
 * 而是三类具体的说谎方式：
 *   1. 什么都没跑却说通过（Array.every 对空数组返回 true 的经典陷阱）；
 *   2. 命令没找到 / 被取消 / 超时，却混成一句含糊的失败，让人以为是代码问题；
 *   3. 基线对比把"这次根本没跑"或"顺手弄坏的"算进"修好了"。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NODE = process.execPath;

/** 用当前 node 二进制跑一小段脚本：不依赖 shell、不依赖 PATH，跨机器稳定 */
function nodeArgv(script: string): string[] {
  return [NODE, '-e', script];
}

function cmd(commandId: string, argv: string[], timeoutMs = 15_000): CommandDefinition {
  return {
    commandId,
    label: commandId,
    argv,
    cwdRelative: '.',
    timeoutMs,
    risk: 'R1',
    source: 'DETECTED',
  };
}

function profileOf(defs: CommandDefinition[]): RepositoryHarnessProfile {
  return {
    profileId: 'prof_test',
    snapshotId: 'snap_test',
    adapterId: 'vite-react-ts',
    adapterVersion: '0.0.1-test',
    supportStatus: 'VERIFIED',
    detectedSignals: [],
    packageManager: 'pnpm',
    commands: Object.fromEntries(defs.map((d) => [d.commandId, d])),
    protectedPaths: [],
    supportedTaskClasses: ['BUILD_FAILURE_FIX'],
    notes: [],
  };
}

/**
 * runVerification 只读工作区的 activePath / activeGeneration 两个字段。
 * 用真的 MaterializedWorkspace.create() 会写进 ~/Library/.../RepoPilotPrototype，
 * 并行跑测试时会互相踩，所以这里注入一个只有这两个字段的替身 + mkdtemp 目录。
 */
function fakeWorkspace(activePath: string, activeGeneration = 0): MaterializedWorkspace {
  return { activePath, activeGeneration } as unknown as MaterializedWorkspace;
}

/** 工作区当前内容的指纹，用来证明"失败路径没有留下任何副作用" */
function treeFingerprint(dir: string): string {
  return digestOf(listTree(dir));
}

let ws: string;
let workspace: MaterializedWorkspace;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'repopilot-verify-'));
  workspace = fakeWorkspace(ws, 0);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// runVerification —— passed 的计算
// ---------------------------------------------------------------------------

describe('runVerification / passed 的计算', () => {
  it('空命令列表不能判 passed=true —— Array.every 对空数组返回 true 的陷阱', async () => {
    // 这是本模块最危险的一行：outcomes.every(...) 单独用会让"一条都没跑"变成"全部通过"，
    // 于是没有任何验证的补丁会被标成 verified。必须由 length > 0 兜住。
    const before = treeFingerprint(ws);
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([]),
      [],
      freshSignal(),
    );

    expect(run.commands).toEqual([]);
    expect(run.passed).toBe(false);
    // 什么都没跑，工作区也不该被碰
    expect(treeFingerprint(ws)).toBe(before);
  });

  it('对照组：唯一一条命令成功时 passed 必须为 true（证明上一条不是"永远 false"）', async () => {
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([cmd('ok', nodeArgv('process.exit(0)'))]),
      ['ok'],
      freshSignal(),
    );

    expect(run.commands.map((c) => c.outcome)).toEqual(['EXIT_ZERO']);
    expect(run.passed).toBe(true);
  });

  it('一成功一失败 → passed=false，且成功那条的结论不被失败污染', async () => {
    // 反过来也要成立：整体失败不代表每条都失败，自修复提示需要知道"哪条还活着"。
    const run = await runVerification(
      'run_1',
      'att_1',
      'POST_MUTATION',
      workspace,
      profileOf([
        cmd('ok', nodeArgv('process.exit(0)')),
        cmd('bad', nodeArgv('process.exit(3)')),
      ]),
      ['ok', 'bad'],
      freshSignal(),
    );

    expect(run.passed).toBe(false);
    expect(run.commands[0]).toMatchObject({ commandId: 'ok', outcome: 'EXIT_ZERO', exitCode: 0 });
    expect(run.commands[1]).toMatchObject({ commandId: 'bad', outcome: 'EXIT_NONZERO', exitCode: 3 });
  });

  it('非零退出记为 EXIT_NONZERO 并带上真实 exitCode，而不是笼统的失败', async () => {
    // 只断言 passed=false 是不够的：spawn 失败、超时、被取消都会让 passed=false，
    // 但只有 EXIT_NONZERO 才意味着"代码真的有问题、值得让模型去修"。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([cmd('build', nodeArgv('process.stderr.write("tsc: 2 errors\\n");process.exit(2)'))]),
      ['build'],
      freshSignal(),
    );

    const o = run.commands[0]!;
    expect(o.outcome).toBe('EXIT_NONZERO');
    expect(o.exitCode).toBe(2);
    expect(o.signal).toBeNull();
    expect(o.stderrPreview).toContain('tsc: 2 errors');
    expect(run.passed).toBe(false);
  });

  it('超时记为 TIMEOUT，不能被当成 EXIT_NONZERO', async () => {
    // 混淆这两者会让模型去"修"一个其实是构建太慢的问题，白烧几轮自修复预算。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([cmd('slow', nodeArgv('setTimeout(() => {}, 30000)'), 250)]),
      ['slow'],
      freshSignal(),
    );

    const o = run.commands[0]!;
    expect(o.outcome).toBe('TIMEOUT');
    expect(o.exitCode).toBeNull();
    expect(run.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runVerification —— 未登记的 commandId
// ---------------------------------------------------------------------------

describe('runVerification / profile 里没登记的 commandId', () => {
  it('未登记 → SPAWN_ERROR，绝不静默跳过（跳过会让缺失的验证变成"通过"）', async () => {
    const before = treeFingerprint(ws);
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([]),
      ['ghost'],
      freshSignal(),
    );

    // 输出条目数必须等于请求数：少一条就说明有命令被悄悄吞掉了
    expect(run.commands).toHaveLength(1);
    const o = run.commands[0]!;
    expect(o.commandId).toBe('ghost');
    expect(o.outcome).toBe('SPAWN_ERROR');
    expect(o.stderrPreview).toContain('ghost');
    expect(run.passed).toBe(false);

    // 没登记就根本不该起进程：argv 空、耗时 0、工作区逐字节不变
    expect(o.argv).toEqual([]);
    expect(o.durationMs).toBe(0);
    expect(treeFingerprint(ws)).toBe(before);
  });

  it('未登记的命令不阻断后面的命令，且顺序与入参一致', async () => {
    // continue 而不是 return：一次跑完才能一次性把所有问题告诉用户。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([cmd('ok', nodeArgv('process.exit(0)'))]),
      ['ghost', 'ok', 'ghost2'],
      freshSignal(),
    );

    expect(run.commands.map((c) => c.commandId)).toEqual(['ghost', 'ok', 'ghost2']);
    expect(run.commands.map((c) => c.outcome)).toEqual(['SPAWN_ERROR', 'EXIT_ZERO', 'SPAWN_ERROR']);
    expect(run.passed).toBe(false);
  });

  it('三种 SPAWN_ERROR 的原因彼此可区分：配置漏登记 / 二进制不存在 / argv 为空', async () => {
    // 这三件事的修法完全不同（改 profile / 装依赖 / 修 adapter），
    // 摘要里只写一句 SPAWN_ERROR 等于什么都没说。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([
        cmd('nobin', ['repopilot-definitely-not-a-real-binary']),
        cmd('emptyargv', []),
      ]),
      ['unregistered', 'nobin', 'emptyargv'],
      freshSignal(),
    );

    expect(run.commands.map((c) => c.outcome)).toEqual([
      'SPAWN_ERROR',
      'SPAWN_ERROR',
      'SPAWN_ERROR',
    ]);

    const [unregistered, nobin, emptyargv] = run.commands as [
      CommandOutcome,
      CommandOutcome,
      CommandOutcome,
    ];
    expect(unregistered.stderrPreview).toContain('没有登记');
    expect(unregistered.argv).toEqual([]);

    expect(nobin.stderrPreview).toContain('spawn error');
    // 有 argv 说明确实尝试过启动，和"根本没登记"是两回事
    expect(nobin.argv).toEqual(['repopilot-definitely-not-a-real-binary']);

    expect(emptyargv.stderrPreview).toContain('argv 为空');
  });

  it('原型链上的 key（constructor/toString）应判为未登记，而不是让整个 Run 崩掉', async () => {
    // profile.commands 是普通对象字面量，commands['constructor'] 取到 Object 构造函数（truthy），
    // 于是 !def 为 false，runCommand 拿到一个没有 argv 的"命令定义"并抛 TypeError，
    // runVerification 整个 reject —— 违反了本文件顶部写明的"命令不存在时记为 SPAWN_ERROR"。
    // 期望行为：和其它未登记 id 一样，产出一条 SPAWN_ERROR。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([]),
      ['constructor'],
      freshSignal(),
    );
    expect(run.commands[0]?.outcome).toBe('SPAWN_ERROR');
  });
});

// ---------------------------------------------------------------------------
// runVerification —— 取消
// ---------------------------------------------------------------------------

describe('runVerification / 取消', () => {
  it('signal 已 abort → 全部记为 CANCELLED，且一个进程都没起（工作区逐字节不变）', async () => {
    // 取消最容易出的错是"当成通过"或"当成失败"。它两者都不是：
    // 用户按了停止，我们对代码质量没有任何新信息。
    const controller = new AbortController();
    controller.abort();

    const before = treeFingerprint(ws);
    const run = await runVerification(
      'run_1',
      'att_1',
      'POST_MUTATION',
      workspace,
      profileOf([
        cmd('w1', nodeArgv('require("fs").writeFileSync("side-effect-1.txt","x")')),
        cmd('w2', nodeArgv('require("fs").writeFileSync("side-effect-2.txt","x")')),
      ]),
      ['w1', 'w2'],
      controller.signal,
    );

    expect(run.commands.map((c) => c.outcome)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(run.commands.every((c) => c.durationMs === 0)).toBe(true);
    expect(run.commands[0]!.stderrPreview).toContain('执行前已被取消');
    expect(run.passed).toBe(false);

    // 关键：这两条命令要是真跑了就会各留下一个文件。目录必须和取消前完全一致。
    expect(treeFingerprint(ws)).toBe(before);
    expect(listTree(ws)).toEqual([]);
  });

  it('已取消时未登记的 id 仍报 SPAWN_ERROR —— 配置错误不该被取消掩盖', async () => {
    // 检查顺序（先 !def 再 signal.aborted）是有意义的：用户下次重跑还会撞上同一个漏登记，
    // 现在就告诉他，比让他以为"只是被我取消了"要好。
    const controller = new AbortController();
    controller.abort();

    const run = await runVerification(
      'run_1',
      'att_1',
      'POST_MUTATION',
      workspace,
      profileOf([cmd('ok', nodeArgv('process.exit(0)'))]),
      ['ghost', 'ok'],
      controller.signal,
    );

    expect(run.commands.map((c) => c.outcome)).toEqual(['SPAWN_ERROR', 'CANCELLED']);
  });

  it('执行途中 abort → 当前命令被真的杀掉，后续命令根本不启动', async () => {
    const controller = new AbortController();
    const before = treeFingerprint(ws);
    setTimeout(() => controller.abort(), 200);

    const run = await runVerification(
      'run_1',
      'att_1',
      'POST_MUTATION',
      workspace,
      profileOf([
        cmd('slow', nodeArgv('setTimeout(() => require("fs").writeFileSync("slow.txt","x"), 30000)')),
        cmd('after', nodeArgv('require("fs").writeFileSync("after.txt","x")')),
      ]),
      ['slow', 'after'],
      controller.signal,
    );

    expect(run.commands.map((c) => c.outcome)).toEqual(['CANCELLED', 'CANCELLED']);

    // durationMs 区分了"跑起来后被杀"和"压根没启动"：
    // 前者应该约等于 abort 的延迟，后者是硬编码的 0。
    expect(run.commands[0]!.durationMs).toBeGreaterThan(50);
    expect(run.commands[1]!.durationMs).toBe(0);
    expect(run.commands[1]!.stderrPreview).toContain('执行前已被取消');

    // 取消后不留任何产物
    expect(treeFingerprint(ws)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// runVerification —— 执行上下文
// ---------------------------------------------------------------------------

describe('runVerification / 执行上下文', () => {
  it('命令跑在工作区 activePath 里，而不是宿主仓库或测试进程的 cwd', async () => {
    // 跑错目录是最隐蔽的假验证：命令在宿主仓库里跑绿了，而工作区里的改动根本没被检验。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([cmd('pwd', nodeArgv('process.stdout.write(process.cwd())'))]),
      ['pwd'],
      freshSignal(),
    );

    expect(run.commands[0]!.stdoutPreview).toBe(realpathSync(ws));
    expect(run.commands[0]!.stdoutPreview).not.toBe(process.cwd());
  });

  it('命令串行执行：后一条能看到前一条写下的文件', async () => {
    // 并发跑验证命令会让 tsc/vite 抢同一份缓存目录，产生无法复现的失败。
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([
        cmd('writer', nodeArgv('require("fs").writeFileSync("stamp.txt","1")')),
        cmd('reader', nodeArgv('process.exit(require("fs").existsSync("stamp.txt") ? 0 : 9)')),
      ]),
      ['writer', 'reader'],
      freshSignal(),
    );

    expect(run.commands.map((c) => c.outcome)).toEqual(['EXIT_ZERO', 'EXIT_ZERO']);
  });

  it('串行判据的负控：顺序反过来时 reader 必须失败（否则上一条测不出任何东西）', async () => {
    const run = await runVerification(
      'run_1',
      'att_1',
      'BASELINE',
      workspace,
      profileOf([
        cmd('writer', nodeArgv('require("fs").writeFileSync("stamp.txt","1")')),
        cmd('reader', nodeArgv('process.exit(require("fs").existsSync("stamp.txt") ? 0 : 9)')),
      ]),
      ['reader', 'writer'],
      freshSignal(),
    );

    expect(run.commands[0]).toMatchObject({ commandId: 'reader', outcome: 'EXIT_NONZERO', exitCode: 9 });
    expect(run.passed).toBe(false);
  });

  it('generation 取自工作区当前代，不是硬编码的 0', async () => {
    // 补丁要和"在哪一代上验证的"绑定；写死 0 会让自修复第 N 轮的验证结果挂到基线代上。
    const run = await runVerification(
      'run_1',
      'att_9',
      'POST_MUTATION',
      fakeWorkspace(ws, 7),
      profileOf([cmd('ok', nodeArgv('process.exit(0)'))]),
      ['ok'],
      freshSignal(),
    );

    expect(run.generation).toBe(7);
    expect(run.runId).toBe('run_1');
    expect(run.attemptId).toBe('att_9');
    expect(run.phase).toBe('POST_MUTATION');
    expect(run.verificationRunId.startsWith('ver_')).toBe(true);
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
  });
});

// ---------------------------------------------------------------------------
// compareVerification
// ---------------------------------------------------------------------------

function outcomeOf(commandId: string, kind: CommandOutcome['outcome']): CommandOutcome {
  return {
    commandId,
    argv: ['x'],
    outcome: kind,
    exitCode: kind === 'EXIT_ZERO' ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdoutPreview: '',
    stderrPreview: '',
    outputTruncated: false,
  };
}

function runOf(
  phase: VerificationRun['phase'],
  outcomes: readonly CommandOutcome[],
): VerificationRun {
  return {
    verificationRunId: `ver_${phase}`,
    runId: 'run_1',
    attemptId: 'att_1',
    phase,
    generation: phase === 'BASELINE' ? 0 : 1,
    commands: outcomes,
    passed: outcomes.length > 0 && outcomes.every((o) => o.outcome === 'EXIT_ZERO'),
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  };
}

const pass = (id: string): CommandOutcome => outcomeOf(id, 'EXIT_ZERO');
const fail = (id: string): CommandOutcome => outcomeOf(id, 'EXIT_NONZERO');

describe('compareVerification / 三分类', () => {
  it('基线全绿、现在全绿 → 三类都空，不能凭空报个"修好了"', () => {
    const cmp = compareVerification(
      runOf('BASELINE', [pass('build'), pass('test')]),
      runOf('POST_MUTATION', [pass('build'), pass('test')]),
    );
    expect(cmp).toEqual({ fixed: [], stillFailing: [], newlyFailing: [], notRerun: [] });
  });

  it('修好了 A 但弄坏了 B —— 必须同时报 fixed 和 newlyFailing，不能只说"修好了 A"', () => {
    // 这是产品存在的理由：只报 fixed 会让用户以为净收益为正，
    // 而实际上他刚把一个原本绿的命令改红了。
    const cmp = compareVerification(
      runOf('BASELINE', [fail('build'), pass('test')]),
      runOf('POST_MUTATION', [pass('build'), fail('test')]),
    );

    expect(cmp.fixed).toEqual(['build']);
    expect(cmp.newlyFailing).toEqual(['test']);
    expect(cmp.stillFailing).toEqual([]);
  });

  it('三类同时出现时互不吞并', () => {
    const cmp = compareVerification(
      runOf('BASELINE', [fail('a'), fail('b'), pass('c')]),
      runOf('POST_MUTATION', [pass('a'), fail('b'), fail('c')]),
    );

    expect(cmp).toEqual({ fixed: ['a'], stillFailing: ['b'], newlyFailing: ['c'], notRerun: [] });
  });

  it('EXIT_ZERO 之外的每一种结局都算失败 —— 尤其 current 里的 CANCELLED 不能算 fixed', () => {
    // "被取消"和"修好了"在 passed 上都不是 true，但含义相反。
    // 若比较器只认 EXIT_NONZERO 为失败，取消/超时/没起来都会被当成修复成功。
    const kinds: CommandOutcome['outcome'][] = [
      'EXIT_NONZERO',
      'SIGNAL',
      'TIMEOUT',
      'CANCELLED',
      'SPAWN_ERROR',
    ];

    for (const kind of kinds) {
      const cmp = compareVerification(
        runOf('BASELINE', [outcomeOf('build', kind)]),
        runOf('POST_MUTATION', [outcomeOf('build', kind)]),
      );
      expect(cmp.stillFailing, `baseline+current 都是 ${kind}`).toEqual(['build']);
      expect(cmp.fixed, `baseline+current 都是 ${kind}`).toEqual([]);

      const regressed = compareVerification(
        runOf('BASELINE', [pass('build')]),
        runOf('POST_MUTATION', [outcomeOf('build', kind)]),
      );
      expect(regressed.newlyFailing, `基线绿 → ${kind}`).toEqual(['build']);
    }
  });

  it('基线绿而现在被取消：算 newlyFailing，绝不能算 fixed', () => {
    const cmp = compareVerification(
      runOf('BASELINE', [fail('a'), pass('b')]),
      runOf('POST_MUTATION', [outcomeOf('a', 'CANCELLED'), outcomeOf('b', 'CANCELLED')]),
    );

    expect(cmp.fixed).toEqual([]);
    expect(cmp.stillFailing).toEqual(['a']);
    expect(cmp.newlyFailing).toEqual(['b']);
  });

  it('输出按 id 排序，结果与命令书写顺序无关（否则摘要在两次运行间会抖）', () => {
    const cmp = compareVerification(
      runOf('BASELINE', [fail('zeta'), fail('alpha'), fail('mid')]),
      runOf('POST_MUTATION', [pass('zeta'), pass('alpha'), pass('mid')]),
    );
    expect(cmp.fixed).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('同一个 commandId 出现多次时不重复计数', () => {
    // verificationCommandIds 里出现重复 id 时 runVerification 会跑两遍，
    // 比较结果不该因此把同一条命令报两次。
    const cmp = compareVerification(
      runOf('BASELINE', [fail('build'), fail('build')]),
      runOf('POST_MUTATION', [pass('build'), pass('build')]),
    );
    expect(cmp.fixed).toEqual(['build']);
  });

  it('同一 id 一次成功一次失败时，按失败处理（不能挑好看的那次）', () => {
    const cmp = compareVerification(
      runOf('BASELINE', [pass('flaky')]),
      runOf('POST_MUTATION', [pass('flaky'), fail('flaky')]),
    );
    expect(cmp.newlyFailing).toEqual(['flaky']);
    expect(cmp.fixed).toEqual([]);
  });

  it('基线一条命令都没有时，现在的失败算 newlyFailing 而不是被忽略', () => {
    const cmp = compareVerification(
      runOf('BASELINE', []),
      runOf('POST_MUTATION', [fail('build')]),
    );
    expect(cmp).toEqual({ fixed: [], stillFailing: [], newlyFailing: ['build'], notRerun: [] });
  });

  it('比较是纯函数：两个入参对象在调用前后逐字节相同', () => {
    // baseline 会被写进 Run 记录并回放给用户，比较过程若就地排序/改写它就是伪造证据。
    const baseline = runOf('BASELINE', [fail('b'), pass('a')]);
    const current = runOf('POST_MUTATION', [pass('b'), fail('a')]);
    const beforeBaseline = digestOf(baseline);
    const beforeCurrent = digestOf(current);

    compareVerification(baseline, current);

    expect(digestOf(baseline)).toBe(beforeBaseline);
    expect(digestOf(current)).toBe(beforeCurrent);
  });

  it('基线失败的命令在本次压根没跑时，不该被算成 fixed', () => {
    // 当前实现只看"是否出现在 current 的失败集合里"，没跑过的命令自然不在，于是被判 fixed。
    // 这是一句谎话：没跑过就没有任何证据说它被修好了。
    // 现有两个调用点（agent.ts）基线和终验都传同一组 commandIds，所以暂不可达，
    // 但比较器本身应当对输入不做这个假设。
    const cmp = compareVerification(
      runOf('BASELINE', [fail('build'), fail('test')]),
      runOf('POST_MUTATION', [pass('build')]), // test 这次没跑
    );
    expect(cmp.fixed).toEqual(['build']);
  });
});

// ---------------------------------------------------------------------------
// summarizeFailures
// ---------------------------------------------------------------------------

function outcomeWithOutput(
  commandId: string,
  kind: CommandOutcome['outcome'],
  exitCode: number | null,
  stdoutPreview: string,
  stderrPreview: string,
): CommandOutcome {
  return {
    commandId,
    argv: ['x'],
    outcome: kind,
    exitCode,
    signal: null,
    durationMs: 1,
    stdoutPreview,
    stderrPreview,
    outputTruncated: false,
  };
}

describe('summarizeFailures', () => {
  it('全部通过时给出明确文案，而不是空字符串', () => {
    const text = summarizeFailures(runOf('BASELINE', [pass('build'), pass('test')]));
    expect(text).toBe('全部验证命令通过。');
  });

  it('只输出失败项：成功命令的 id 和它的输出都不能泄漏进摘要', () => {
    // 这段摘要会原样进模型上下文。把成功命令的几千行日志也塞进去，
    // 既烧 token 又会诱导模型去"修"一个根本没坏的地方。
    const text = summarizeFailures(
      runOf('POST_MUTATION', [
        outcomeWithOutput('lint', 'EXIT_ZERO', 0, 'LINT-CLEAN-MARKER', ''),
        outcomeWithOutput('build', 'EXIT_NONZERO', 1, '', 'TS2345: 类型不匹配'),
      ]),
    );

    expect(text).toContain('build');
    expect(text).toContain('TS2345: 类型不匹配');
    expect(text).not.toContain('lint');
    expect(text).not.toContain('LINT-CLEAN-MARKER');
  });

  it('带上 outcome 和 exitCode —— 让模型能区分"代码错了"和"命令没跑起来"', () => {
    const text = summarizeFailures(
      runOf('POST_MUTATION', [outcomeWithOutput('build', 'TIMEOUT', null, '', '')]),
    );
    expect(text).toContain('TIMEOUT');
    expect(text).toContain('exitCode=null');
  });

  it('失败但完全没有输出时明确写"（无输出）"，不能留一段空白让人以为日志丢了', () => {
    const text = summarizeFailures(
      runOf('POST_MUTATION', [outcomeWithOutput('build', 'SPAWN_ERROR', null, '', '')]),
    );
    expect(text).toContain('（无输出）');
  });

  it('多条失败全部列出并彼此分隔，不能只报第一条', () => {
    const text = summarizeFailures(
      runOf('POST_MUTATION', [
        outcomeWithOutput('build', 'EXIT_NONZERO', 1, '', 'ERR-BUILD'),
        outcomeWithOutput('test', 'EXIT_NONZERO', 1, 'ERR-TEST', ''),
      ]),
    );

    expect(text).toContain('ERR-BUILD');
    expect(text).toContain('ERR-TEST');
    expect(text).toContain('\n\n');
    // stderr 在前、stdout 在后地拼接，两条记录之间不能糊在一起
    expect(text.split('命令 ').length - 1).toBe(2);
  });

  it('一条命令都没跑过的 run 不该被摘要成"全部验证命令通过"', () => {
    // runVerification 对空 commands 给出 passed=false，摘要却说"全部通过" —— 两者自相矛盾。
    // 这段文字是要发给模型和用户看的，说"通过"就是在没有证据的情况下声称成功。
    const text = summarizeFailures(runOf('BASELINE', []));
    expect(text).not.toContain('通过');
  });
});
