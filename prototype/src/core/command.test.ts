import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandDefinition, CommandOutcome } from '@shared/domain';
import { buildChildEnv, runCommand } from './command';
import { PREVIEW_MAX_BYTES } from './tools';

/**
 * 进程执行层。这一层是整个验证链路的"事实来源"——上游所有 passed/failed 判断
 * 都建立在它返回的 outcome 上。所以这里测的重点不是"命令能跑通"，而是：
 *
 *   1. 五种失败模式（非零退出 / 信号 / 超时 / 取消 / spawn 失败）**互相不能混淆**。
 *      任何一种被误判成 EXIT_ZERO，或者互相串味，上层的"构建修好了"就是假的。
 *   2. 超时和取消必须真的把**进程树**杀掉，而不只是让 Promise resolve。
 *      只 resolve 不杀进程 = 留下孤儿构建进程占着端口和 CPU，肉眼看不出来。
 *   3. 输出预览必须保留**尾部**。构建/测试的错误摘要永远在最后几行，
 *      截错方向等于把唯一有用的信息扔了，而且扔得悄无声息。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let cwd: string;
/** 测试自己起的、必须在用例结束时回收的进程（防止 it.fails 用例漏出孤儿进程） */
let strayPids: number[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'repopilot-cmd-'));
  strayPids = [];
});

afterEach(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经死了，正是我们想要的 */
    }
  }
  rmSync(cwd, { recursive: true, force: true });
});

function def(argv: readonly string[], timeoutMs = 15_000): CommandDefinition {
  return {
    commandId: 'cmd:test',
    label: 'test command',
    argv,
    cwdRelative: '.',
    timeoutMs,
    risk: 'R2',
    source: 'USER',
  };
}

/** 用真实 shell 构造各种退出情形；注意 shell 本身是 argv[0]，不是靠字符串拼接 */
function sh(script: string, timeoutMs = 15_000): CommandDefinition {
  return def(['/bin/sh', '-c', script], timeoutMs);
}

/** 写一个 node 脚本到 cwd 里，用真实 node 产生精确可控的字节流 */
function nodeScript(source: string, timeoutMs = 15_000): CommandDefinition {
  writeFileSync(join(cwd, 'gen.js'), source, 'utf8');
  return def([process.execPath, 'gen.js'], timeoutMs);
}

function run(d: CommandDefinition, signal = new AbortController().signal, at = cwd) {
  return runCommand(d, at, signal);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

// ---------------------------------------------------------------------------

describe('outcome 判别联合：五种失败模式必须彼此可区分', () => {
  it('退出码 0 → EXIT_ZERO，且 exitCode/signal 是确定值而不是 undefined', async () => {
    const r = await run(sh('exit 0'));
    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
  });

  it('退出码非零绝不能被当成成功，且原始退出码要原样保留', async () => {
    // 42 而不是 1：验证退出码是透传的，没有被压成布尔再还原成 1
    const r = await run(sh('exit 42'));
    expect(r.outcome).toBe('EXIT_NONZERO');
    expect(r.exitCode).toBe(42);
    expect(r.signal).toBeNull();
  });

  it('退出码 255 / 1 都落在 EXIT_NONZERO，不会因为边界值滑进 EXIT_ZERO', async () => {
    for (const code of [1, 2, 127, 255]) {
      const r = await run(sh(`exit ${code}`));
      expect(r.outcome).toBe('EXIT_NONZERO');
      expect(r.exitCode).toBe(code);
    }
  });

  it('shell 报 127（命令找不到）是 EXIT_NONZERO，spawn 自己失败才是 SPAWN_ERROR —— 两者必须分得开', async () => {
    // 这是最容易说谎的一对：都"没跑成"，但含义完全不同。
    // 127 = 命令跑起来了、shell 告诉我们它找不到目标；SPAWN_ERROR = 我们连进程都没起来，
    // 后者说明的是 profile/环境配错了，不该被报告成"构建失败"。
    const viaShell = await run(sh('definitely-not-a-real-binary-xyz-9f2'));
    const viaSpawn = await run(def(['/definitely/not/a/real/binary-xyz-9f2']));

    expect(viaShell.outcome).toBe('EXIT_NONZERO');
    expect(viaShell.exitCode).toBe(127);

    expect(viaSpawn.outcome).toBe('SPAWN_ERROR');
    expect(viaSpawn.exitCode).toBeNull();
    expect(viaSpawn.outcome).not.toBe(viaShell.outcome);
  });

  it('被信号杀死 → SIGNAL 且信号名精确，不能退化成 EXIT_NONZERO', async () => {
    const term = await run(sh('kill -TERM $$'));
    expect(term.outcome).toBe('SIGNAL');
    expect(term.signal).toBe('SIGTERM');
    // exitCode 必须是 null：如果这里冒出个数字，上层就会拿它当退出码解释
    expect(term.exitCode).toBeNull();

    const kill = await run(sh('kill -KILL $$'));
    expect(kill.outcome).toBe('SIGNAL');
    expect(kill.signal).toBe('SIGKILL');
  });

  it('先输出再非零退出：输出和退出码同时保住，不会因为进程已退出就丢掉 stderr', async () => {
    // 真实构建失败长这样——有错误正文 + 非零码。任何一半丢了这条 outcome 都没有诊断价值。
    const r = await run(sh('echo "TS2345: bad arg" >&2; exit 2'));
    expect(r.outcome).toBe('EXIT_NONZERO');
    expect(r.exitCode).toBe(2);
    expect(r.stderrPreview).toContain('TS2345: bad arg');
  });
});

describe('spawn 失败：还没跑起来 ≠ 跑起来失败了', () => {
  it('argv 为空 → SPAWN_ERROR，原因写在 stderr 里而不是静默返回', async () => {
    const r = await run(def([]));
    expect(r.outcome).toBe('SPAWN_ERROR');
    expect(r.stderrPreview).toBe('argv 为空');
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
  });

  it('可执行文件不存在 → SPAWN_ERROR，且 stderr 带上 ENOENT 这类可定位的底层原因', async () => {
    const r = await run(def([join(cwd, 'no-such-bin')]));
    expect(r.outcome).toBe('SPAWN_ERROR');
    // 只说"失败了"没用，得能看出是找不到文件还是没权限
    expect(r.stderrPreview).toContain('[spawn error]');
    expect(r.stderrPreview).toContain('ENOENT');
  });

  it('argv[0] 指向目录（不可执行）→ SPAWN_ERROR，而不是被当成退出码异常', async () => {
    const r = await run(def([cwd]));
    expect(r.outcome).toBe('SPAWN_ERROR');
    expect(r.stderrPreview).toContain('[spawn error]');
  });

  it('cwd 不存在 → SPAWN_ERROR，不能伪装成"命令执行失败"', async () => {
    // 工作区没准备好和构建真的挂了，是两类完全不同的故障，混淆会让 Agent 去改代码修环境问题
    const r = await run(sh('exit 0'), undefined, join(cwd, 'not-created'));
    expect(r.outcome).toBe('SPAWN_ERROR');
    expect(r.exitCode).toBeNull();
  });

  it('argv 不经过 shell 解释：参数里的 `;` 不会变成第二条命令', async () => {
    // 模块注释承诺"只有 argv 数组、不做字符串拼接"。这条守的是命令注入面。
    const r = await run(def(['/bin/echo', 'hi; touch pwned.txt']));
    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.stdoutPreview).toBe('hi; touch pwned.txt');
    expect(existsSync(join(cwd, 'pwned.txt'))).toBe(false);
  });
});

describe('超时', () => {
  it('超时 → TIMEOUT，而不是 SIGNAL/EXIT_NONZERO，并且没有真的等满命令时长', async () => {
    // 被杀的进程 close 时会带 SIGTERM，如果 settled 守卫失效就会报成 SIGNAL —— 那样上层
    // 会以为"是外部把构建杀了"，而不是"我们自己判超时"，重试策略会完全跑偏。
    const r = await run(sh('sleep 30', 400));
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
    expect(r.durationMs).toBeGreaterThanOrEqual(300);
    expect(r.durationMs).toBeLessThan(10_000); // 证明 Promise 不是等 sleep 30 自然结束
  });

  it('超时杀的是整棵进程树：后台孙进程也必须一起死', async () => {
    // 只 kill 直接子进程的话，`sleep 30 &` 会被 init 收养、继续跑满 30 秒。
    // 这正是"只让 Promise resolve"和"真的终止"的区别，而且从返回值上完全看不出来。
    const r = await run(sh('sleep 30 & echo $! > gc.pid; wait', 500));
    expect(r.outcome).toBe('TIMEOUT');

    const gcPid = Number(readFileSync(join(cwd, 'gc.pid'), 'utf8').trim());
    expect(Number.isInteger(gcPid)).toBe(true);
    strayPids.push(gcPid);

    expect(await waitUntil(() => !isAlive(gcPid), 3000)).toBe(true);
  });

  it('超时之前已经产生的输出不能丢', async () => {
    // 卡死的构建里，超时前打出来的那几行往往是唯一线索
    const r = await run(sh('echo early-marker; sleep 30', 500));
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.stdoutPreview).toContain('early-marker');
  });

  it('timeoutMs = 0 不能被当成"不限时"', async () => {
    // 0 在很多 API 里表示"无超时"，这里必须是"立刻超时"，否则一个配置失误就能让 Run 永久挂住
    const r = await run(sh('sleep 20', 0));
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it('在超时窗口内正常失败的命令仍然是 EXIT_NONZERO，定时器不能误伤', async () => {
    const r = await run(sh('sleep 0.2; exit 3', 5_000));
    expect(r.outcome).toBe('EXIT_NONZERO');
    expect(r.exitCode).toBe(3);
  });

  it('忽略 SIGTERM 的进程必须被 SIGKILL 兜底杀掉（升级判据用 childClosed，不能复用 settled）', async () => {
    // killTree() 里那个 3 秒后的 SIGKILL 检查 `if (settled) return`，
    // 但 finish() 在 killTree() 之后立刻把 settled 置 true，所以升级永远不会发生。
    // 后果：任何屏蔽 SIGTERM 的构建工具（不少 watch/daemon 会这么干）在超时后继续活着。
    const pidFile = join(cwd, 'stubborn.pid');
    const d = nodeScript(
      `process.on('SIGTERM', () => {});
       require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setTimeout(() => {}, 60000);`,
      600,
    );

    const r = await run(d);
    expect(r.outcome).toBe('TIMEOUT');

    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    strayPids.push(pid);
    // 3 秒 SIGKILL + 余量
    expect(await waitUntil(() => !isAlive(pid), 6000)).toBe(true);
  });
});

describe('取消（AbortSignal）', () => {
  it('取消 → CANCELLED，既不是 TIMEOUT 也不是 SIGNAL，且立刻返回', async () => {
    // 用户主动取消 vs 命令自己超时，在审计记录里是两件事，不能同名
    const ac = new AbortController();
    const p = run(sh('sleep 30', 20_000), ac.signal);
    setTimeout(() => ac.abort(), 200);

    const r = await p;
    expect(r.outcome).toBe('CANCELLED');
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('取消同样杀整棵进程树', async () => {
    const ac = new AbortController();
    const p = run(sh('sleep 30 & echo $! > gc.pid; wait', 20_000), ac.signal);
    setTimeout(() => ac.abort(), 400);

    const r = await p;
    expect(r.outcome).toBe('CANCELLED');

    const gcPid = Number(readFileSync(join(cwd, 'gc.pid'), 'utf8').trim());
    strayPids.push(gcPid);
    expect(await waitUntil(() => !isAlive(gcPid), 3000)).toBe(true);
  });

  it('已经 abort 的 signal 必须直接拒绝执行，不能再产生副作用', async () => {
    // 现状：只 addEventListener('abort')，对"进来时就已经 aborted"的 signal 完全无感，
    // 命令照跑。取消一个任务之后，队列里剩下的命令还会挨个执行一遍。
    const ac = new AbortController();
    ac.abort();

    const r = await run(sh('touch side-effect.txt'), ac.signal);
    expect(r.outcome).toBe('CANCELLED');
    expect(existsSync(join(cwd, 'side-effect.txt'))).toBe(false);
  });

  it('命令结束后不残留 abort 监听器（一个 Run 会用同一个 signal 跑几十条命令）', async () => {
    const ac = new AbortController();
    const outcomes: CommandOutcome[] = [];
    for (let i = 0; i < 6; i += 1) {
      outcomes.push(await run(sh(`exit ${i % 2}`), ac.signal));
      // 每轮结束都必须清零；累积的话既是内存泄漏，也会在最终 abort 时对早已退出的
      // pid 反复 kill（-pid 可能已被复用）
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    }
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'EXIT_ZERO',
      'EXIT_NONZERO',
      'EXIT_ZERO',
      'EXIT_NONZERO',
      'EXIT_ZERO',
      'EXIT_NONZERO',
    ]);
  });
});

describe('输出捕获与 tailPreview', () => {
  it('stdout / stderr 不串台', async () => {
    const r = await run(sh('echo OUT; echo ERR >&2'));
    expect(r.stdoutPreview).toBe('OUT');
    expect(r.stderrPreview).toBe('ERR');
    expect(r.stdoutPreview).not.toContain('ERR');
  });

  it('无输出时预览是空串而不是 undefined，尾随换行被裁掉', async () => {
    // 预览会被写进 artifact 并参与跨 attempt 比较，尾随空白必须稳定
    const empty = await run(sh('exit 0'));
    expect(empty.stdoutPreview).toBe('');
    expect(empty.stderrPreview).toBe('');
    expect(empty.outputTruncated).toBe(false);

    const one = await run(sh('printf "hello\\n\\n\\n"'));
    expect(one.stdoutPreview).toBe('hello');
  });

  it('超长输出保留的是尾部而不是开头，且切在行边界上', async () => {
    // 这条是整个文件里最要紧的一条：编译器/测试框架的结论在最后几行。
    // 如果保留的是开头，预览里全是无用的 "> tsc --noEmit" 之类噪音。
    const d = nodeScript(
      `const lines = [];
       lines.push('HEAD-MARKER-LINE');
       for (let i = 0; i < 400; i += 1) lines.push('filler-' + String(i).padStart(4, '0') + '-' + 'x'.repeat(40));
       lines.push('FINAL-ERROR-MARKER: 3 tests failed');
       process.stdout.write(lines.join('\\n') + '\\n');`,
    );
    const r = await run(d);

    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.stdoutPreview).toContain('FINAL-ERROR-MARKER: 3 tests failed');
    expect(r.stdoutPreview).not.toContain('HEAD-MARKER-LINE');
    expect(r.stdoutPreview.startsWith('…[前段已省略]\n')).toBe(true);
    expect(r.outputTruncated).toBe(true);

    // 切在换行边界：省略标记之后的每一行都得是完整行，不能是半截 filler
    const body = r.stdoutPreview.split('\n').slice(1);
    for (const line of body.slice(0, -1)) {
      expect(line).toMatch(/^filler-\d{4}-x{40}$/);
    }
    expect(body.at(-1)).toBe('FINAL-ERROR-MARKER: 3 tests failed');
  });

  it('输出超过 MAX_CAPTURE_BYTES 时不在内存里无界拼接，并标记 outputTruncated', async () => {
    const d = nodeScript(
      `const line = 'noise-'.repeat(9) + 'noise';   // 60 字节左右
       const chunk = new Array(200).fill(line).join('\\n') + '\\n';
       for (let i = 0; i < 60; i += 1) process.stdout.write(chunk);  // ≈ 720KB > 512KB 上限
       process.stdout.write('FINAL-ERROR-MARKER\\n');`,
      20_000,
    );
    const r = await run(d);

    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.outputTruncated).toBe(true);
    // 返回值本身必须小：这个对象会被 JSON 化走 IPC 并落盘
    expect(Buffer.byteLength(r.stdoutPreview, 'utf8')).toBeLessThan(PREVIEW_MAX_BYTES * 2);
  });

  it('输出超过 MAX_CAPTURE_BYTES 时，真正的末尾错误行仍应可见', async () => {
    // 捕获层到 512KB 就停止累积，保留的是**开头** 512KB；tailPreview 再从这 512KB 里取尾巴。
    // 结果是：输出越大（webpack/tsc 大仓库很容易过 512KB），越是拿不到最后那句结论，
    // 方向恰好和 tailPreview 的设计意图相反，而且 outputTruncated=true 无法区分
    // "掐掉的是开头"还是"掐掉的是结尾"。
    const d = nodeScript(
      `const line = 'noise-'.repeat(9) + 'noise';
       const chunk = new Array(200).fill(line).join('\\n') + '\\n';
       for (let i = 0; i < 60; i += 1) process.stdout.write(chunk);
       process.stdout.write('FINAL-ERROR-MARKER\\n');`,
      20_000,
    );
    const r = await run(d);
    expect(r.stdoutPreview).toContain('FINAL-ERROR-MARKER');
  });

  it('预览被截断时 outputTruncated 必须为 true', async () => {
    // 现状：outputTruncated = truncated || (stdout.length + stderr.length > PREVIEW_MAX_BYTES * 2)。
    // 单条流输出 6KB 时，预览确实被 tailPreview 砍掉了 2KB，但 6000 < 8000，标志位报 false。
    // 下游据此认为"这就是全部输出"，于是把一段被腰斩的日志当完整证据用。
    const d = nodeScript(`process.stdout.write('a'.repeat(6000) + '\\n');`);
    const r = await run(d);

    expect(Buffer.byteLength(r.stdoutPreview, 'utf8')).toBeLessThan(6000); // 前提：确实截了
    expect(r.outputTruncated).toBe(true);
  });

  it('跨 chunk 的多字节字符不能被解码成乱码', async () => {
    // chunk.toString('utf8') 逐块解码，没有用 StringDecoder 跨块缓存。
    // 一个 UTF-8 字符被拆到两次 data 事件里，就会各产出一个 U+FFFD。
    // 中文/emoji 的错误信息（很多国内工具链的报错、以及测试名）会被悄悄糊掉。
    const d = nodeScript(
      `const buf = Buffer.from('中'.repeat(10), 'utf8');   // 30 字节
       process.stdout.write(buf.subarray(0, 16));          // 第 6 个字符被从中间切开
       setTimeout(() => process.stdout.write(buf.subarray(16)), 120);`,
    );
    const r = await run(d);

    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.stdoutPreview).toBe('中'.repeat(10));
  });

  it('预览的字节预算不能被多字节字符撑破', async () => {
    // tailPreview 用 slice(-PREVIEW_MAX_BYTES) 按**字符**切，却用 byteLength 判断阈值。
    // 全中文输出时，返回的预览实际是 3 倍预算（≈12KB），而调用方是按 4KB 规划 IPC/提示词的。
    const d = nodeScript(`process.stdout.write('中'.repeat(5000));`);
    const r = await run(d);

    expect(Buffer.byteLength(r.stdoutPreview, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX_BYTES + 64);
  });
});

describe('buildChildEnv 白名单', () => {
  it('放行 PATH/HOME 等基础变量，注入 CI 三件套', () => {
    const { env } = buildChildEnv({ PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'test' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.CI).toBe('1');
    expect(env.NO_COLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.NODE_ENV).toBe('test');
  });

  it('丢弃凭据类变量，并如实回报被丢弃的名字（只报名字不报值）', () => {
    const { env, droppedKeys } = buildChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'gho_secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NPM_TOKEN: 'npm-secret',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(droppedKeys).toEqual(
      ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN'].sort(),
    );
    // 回报的是名字，值绝不能出现在里面
    expect(JSON.stringify(droppedKeys)).not.toContain('secret');
  });

  it('LC_* 前缀族整体放行（否则子进程 locale 报错）', () => {
    const { env } = buildChildEnv({ PATH: '/usr/bin', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'C' });
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.LC_CTYPE).toBe('C');
  });

  it('强制项覆盖同名透传值：父进程的 CI=0 不能翻掉我们的 CI=1', () => {
    const { env } = buildChildEnv({ PATH: '/usr/bin', CI: '0', NO_COLOR: '0' });
    expect(env.CI).toBe('1');
    expect(env.NO_COLOR).toBe('1');
  });

  it('返回的 env 是 null 原型对象：constructor/toString 这类 key 不会命中原型', () => {
    const { env } = buildChildEnv({ PATH: '/usr/bin' });
    expect(Object.getPrototypeOf(env)).toBeNull();
  });
});

describe('执行环境与审计字段', () => {
  it('cwd 生效：命令看到的是传入的工作目录', async () => {
    writeFileSync(join(cwd, 'marker.txt'), 'in-workspace', 'utf8');
    const r = await run(sh('cat marker.txt'));
    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.stdoutPreview).toBe('in-workspace');
  });

  it('强制注入 CI/NO_COLOR/FORCE_COLOR，且 PATH 透传（构建能找到工具链）', async () => {
    // 不注入这三个，同一条命令在不同机器上会产出带 ANSI 转义、带交互提示的不同输出，
    // baseline 与 post-mutation 的对比就失去意义；PATH 必须透传，否则 node/npm 都找不到。
    const r = await run(sh('echo "$CI|$NO_COLOR|$FORCE_COLOR|${PATH:+has-path}"'));
    expect(r.stdoutPreview).toBe('1|1|0|has-path');
  });

  it('子进程看不到未列入白名单的父进程变量 —— BYOK 凭据不外泄给仓库脚本', async () => {
    // 这是一条安全断言：仓库自己的 build 脚本以完整宿主 env 运行时，
    // 一行 `curl -d "$ANTHROPIC_API_KEY"` 就能把 key 送走。
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    process.env.REPOPILOT_SECRET_PROBE = 'should-not-leak';
    try {
      const r = await run(sh('echo "[$ANTHROPIC_API_KEY][$REPOPILOT_SECRET_PROBE]"'));
      // 两个都不该出现在子进程环境里
      expect(r.stdoutPreview).toBe('[][]');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.REPOPILOT_SECRET_PROBE;
    }
  });

  it('stdin 被 ignore：读 stdin 的命令立刻拿到 EOF，不会一路挂到超时', async () => {
    // 交互式提示（"是否继续 [y/N]"）是构建卡死最常见的原因之一
    const r = await run(sh('cat; echo done', 3_000));
    expect(r.outcome).toBe('EXIT_ZERO');
    expect(r.stdoutPreview).toBe('done');
    expect(r.durationMs).toBeLessThan(2_500);
  });

  it('审计字段原样回填，durationMs 反映真实耗时', async () => {
    const d = sh('sleep 0.5');
    const r = await run(d);
    expect(r.commandId).toBe('cmd:test');
    expect(r.argv).toEqual(['/bin/sh', '-c', 'sleep 0.5']);
    expect(r.durationMs).toBeGreaterThanOrEqual(400);
    expect(r.durationMs).toBeLessThan(15_000);
  });
});
