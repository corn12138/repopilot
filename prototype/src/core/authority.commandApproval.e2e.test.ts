import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 受管数据根重定向到进程私有临时目录（与其余权威层 e2e 同一手法）
vi.mock('./paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-capp-e2e-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
  } as const;
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: () => {
      for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
        mkDir(d, { recursive: true });
      }
    },
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import type { ApprovalRequest, CommandApproval, RunEvent, RunView } from '@shared/domain';
import type { PushEvent } from '@shared/protocol';
import { RunAuthority } from './authority';

/**
 * 一次性精确命令批准的权威层端到端（Slice K）。
 *
 * 08-17 审计 D3 的后半段：用户手填的命令此前一律硬编码 R1（"填一次即永久授权"），
 * Slice I-1 改成了先分级、非 R1 一律拒绝 —— 代价是**任何不在白名单里的语言栈都用不了**
 * （`bash scripts/test.sh`、`just ci`、`bazel test` 全被挡在门外），而这道白名单
 * 本来就不是一堵墙：`node -e "…"` 是 R1，它能干的事不比 `bash test.sh` 少。
 *
 * 这里落的是第三态：**未知二进制**可以被逐条批准，批准绑整条 argv、有 TTL、
 * 一张只能进一个 Run、每次执行都记账；而**已知危险**的 R2（装依赖/联网/容器）
 * 连批准通道都没有 —— 工作区的 node_modules 是指向宿主仓库的 symlink。
 */

const fixtureRepos = new Set<string>();

/** 验证命令是 `bash check.sh` —— bash 不在白名单里，所以它是 R2/UNKNOWN_BINARY */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-capp-repo-'));
  fixtureRepos.add(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.js'), "export const STATUS = 'broken';\n");
  const script = join(dir, 'check.sh');
  writeFileSync(script, '#!/bin/sh\ngrep -q fixed src/app.js || { echo "still broken" >&2; exit 1; }\necho ok\n');
  chmodSync(script, 0o755);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', ...args], { cwd: dir, stdio: 'ignore' });
  git('init');
  git('add', '.');
  git('commit', '-m', 'broken baseline');
  return dir;
}

function oaToolCall(name: string, input: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: `call_${name}_1`, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}
const planCall = (): unknown =>
  oaToolCall('submit_plan', {
    summary: '把 src/app.js 的 STATUS 改成 fixed',
    steps: [{ intent: '改 STATUS', targetPaths: ['src/app.js'], expectedEffect: 'bash check.sh 退出 0' }],
    risks: [],
  });

class Harness {
  readonly pushes: PushEvent[] = [];
  readonly authority: RunAuthority;
  private readonly queues = new Map<string, Array<(body?: string) => unknown>>();

  constructor() {
    this.authority = new RunAuthority((e) => this.pushes.push(e), { backgroundRetention: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const host = new URL(String(url)).host;
        const queue = this.queues.get(host);
        if (!queue || queue.length === 0) throw new Error(`${host} 的模型脚本已耗尽`);
        return new Response(JSON.stringify(queue.shift()!(String(init?.body ?? ''))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }
  script(host: string, responders: Array<(body?: string) => unknown>): void {
    this.queues.set(host, responders);
  }
  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    return (await this.authority.handle(method, payload)) as T;
  }
  latestRun(runId: string): RunView | null {
    for (let i = this.pushes.length - 1; i >= 0; i -= 1) {
      const p = this.pushes[i]!;
      if (p.type === 'run.updated' && p.run.runId === runId) return p.run;
    }
    return null;
  }
  async waitForStatus(runId: string, statuses: readonly string[], timeoutMs = 20_000): Promise<RunView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = this.latestRun(runId);
      if (view && statuses.includes(view.status)) return view;
      if (Date.now() > deadline) {
        const { events } = await this.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
        throw new Error(
          `等待 ${statuses.join('/')} 超时，当前 ${view?.status}（${view?.statusReason}）。最近事件：\n` +
            events.slice(-10).map((e) => `${e.kind} ${e.summary}`).join('\n'),
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  async events(runId: string): Promise<RunEvent[]> {
    return (await this.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 })).events;
  }
  /** 注册 + 导入，返回创建任务需要的三个 id 与出站同意 digest */
  async prepare(hostPath: string): Promise<{
    projectId: string;
    snapshotId: string;
    profileId: string;
    consentDigest: string;
  }> {
    const reg = await this.call<{ project: { projectId: string } }>('__project.register', { hostPath });
    const imported = await this.call<{
      outcome: string;
      snapshot: { snapshotId: string };
      profile: { profileId: string };
    }>('project.import', { projectId: reg.project.projectId });
    expect(imported.outcome).toBe('IMPORTED');
    const { disclosure } = await this.call<{ disclosure: { digest: string } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
    });
    return {
      projectId: reg.project.projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      consentDigest: disclosure.digest,
    };
  }
  createTask(
    ids: { projectId: string; snapshotId: string; profileId: string; consentDigest: string },
    argv: readonly string[],
    approvalIds?: readonly string[],
  ): Promise<{ run: RunView }> {
    return this.call<{ run: RunView }>('task.create', {
      projectId: ids.projectId,
      snapshotId: ids.snapshotId,
      profileId: ids.profileId,
      modelProfileId: 'profile_deepseek',
      egressConsentDigest: ids.consentDigest,
      goal: '修复 check.sh 失败',
      taskClass: 'BUILD_FAILURE_FIX',
      allowedPaths: [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: [{ label: argv.join(' '), argv: [...argv] }],
      ...(approvalIds ? { commandApprovalIds: [...approvalIds] } : {}),
    });
  }
}

let harness: Harness;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-e2e-planner';
  harness = new Harness();
});

afterEach(() => {
  /*
   * 先停掉还在跑的 Run：用例结束时后台可能仍有 Attempt 在推进。fetch 是全局 stub，
   * 上一条用例的后台 Run 会去喝**下一条**用例的模型脚本，表现成"脚本已耗尽"的假失败。
   */
  harness.authority.shutdown('test-teardown');
  delete process.env.DEEPSEEK_API_KEY;
  vi.unstubAllGlobals();
  for (const d of fixtureRepos) rmSync(d, { recursive: true, force: true });
  fixtureRepos.clear();
});

describe('一次性精确命令批准：未知二进制可以批，已知危险的批不了', () => {
  it('未批准 → task.create 拒绝，但话术是"需要你逐条批准"并给出批准这条路', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    await expect(harness.createTask(ids, ['bash', 'check.sh'])).rejects.toThrow(/逐条批准/);
  });

  it('classify 只判级不签发：问一万次也不会在 Core 里留下一张票', async () => {
    const before = await harness.call<{ risk: string; cause: string; approvable: boolean }>('command.classify', {
      argv: ['bash', 'check.sh'],
    });
    expect(before).toMatchObject({ risk: 'R2', cause: 'UNKNOWN_BINARY', approvable: true });

    // 判级过 N 次之后，仍然必须显式签发才能用
    for (let i = 0; i < 5; i += 1) await harness.call('command.classify', { argv: ['bash', 'check.sh'] });
    const ids = await harness.prepare(makeFixtureRepo());
    await expect(harness.createTask(ids, ['bash', 'check.sh'])).rejects.toThrow(/逐条批准/);
  });

  it('装依赖/联网这一类连批准通道都没有：classify 给 remediation，requestApproval 直接 POLICY_DENIED', async () => {
    const c = await harness.call<{ approvable: boolean; remediation: string | null }>('command.classify', {
      argv: ['pnpm', 'install'],
    });
    expect(c.approvable).toBe(false);
    // 不是一句"不支持"，要说清为什么与下一步
    expect(c.remediation).toContain('node_modules');

    await expect(harness.call('command.requestApproval', { argv: ['pnpm', 'install'] })).rejects.toThrow(/不可批准/);
    await expect(harness.call('command.requestApproval', { argv: ['rm', '-rf', 'dist'] })).rejects.toThrow(/不可批准/);
    await expect(harness.call('command.requestApproval', { argv: ['git', 'push'] })).rejects.toThrow(/不可批准/);
  });

  it('R1 不需要批准：请求一张票会被明确拒绝，而不是发一张没用的', async () => {
    await expect(harness.call('command.requestApproval', { argv: ['node', 'check.mjs'] })).rejects.toThrow(
      /不需要批准/,
    );
  });

  it('批准过的命令登记成功，但风险等级如实留在 profile 里 —— 不被洗白成 R1', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    expect(approval.maxBindings).toBe(1);
    expect(approval.bindings).toBe(0);

    harness.script('api.deepseek.com', [planCall]);
    const { run } = await harness.createTask(ids, ['bash', 'check.sh'], [approval.approvalId]);

    /*
     * 命令定义看 Run 自己冻结的那份 profile：withUserCommands 会另发一个 profileId
     * （用户手填的命令属于这个任务，不该回写到导入时的检测结果上）。
     */
    const profile = (harness.authority as unknown as {
      runs: Map<string, { profile: { commands: Record<string, { risk: string; approvalId?: string | null }> } }>;
    }).runs.get(run.runId)!.profile;
    expect(profile.commands.user1!.risk, '批准是"允许它跑"，不是"把它变成 R1"').toBe('R2');
    expect(profile.commands.user1!.approvalId).toBe(approval.approvalId);

    const events = await harness.events(run.runId);
    const bound = events.find((e) => e.kind === 'COMMAND_APPROVAL_BOUND');
    expect(bound, '绑定必须进事件流：它改变了这个 Run 允许跑什么').toBeTruthy();
    expect(bound!.payload.argv).toEqual(['bash', 'check.sh']);
    expect(bound!.payload.argvDigest).toBe(approval.argvDigest);
    expect(events.find((e) => e.kind === 'RUN_CREATED')!.payload.approvedCommands).toBe(1);
  });

  it('一张票只能进一个 Run：第二次拿同一张票，照样被拒', async () => {
    const idsA = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    harness.script('api.deepseek.com', [planCall, planCall]);
    await harness.createTask(idsA, ['bash', 'check.sh'], [approval.approvalId]);

    const idsB = await harness.prepare(makeFixtureRepo());
    await expect(harness.createTask(idsB, ['bash', 'check.sh'], [approval.approvalId])).rejects.toThrow(/逐条批准/);
  });

  it('批准绑整条 argv：多一个参数就是另一条命令', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    await expect(harness.createTask(ids, ['bash', 'check.sh', '-x'], [approval.approvalId])).rejects.toThrow(
      /逐条批准/,
    );
  });

  it('过期的票等于没有票', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    // 直接把票改成已过期 —— 比在测试里等 15 分钟诚实，也比给生产代码开一个测试后门诚实
    const table = (harness.authority as unknown as { commandApprovals: Map<string, CommandApproval> })
      .commandApprovals;
    table.set(approval.approvalId, { ...approval, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(harness.createTask(ids, ['bash', 'check.sh'], [approval.approvalId])).rejects.toThrow(/逐条批准/);
  });

  it('批准过的 R2 命令在基线里**真的跑起来了**，并且每次执行都记账', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    harness.script('api.deepseek.com', [planCall]);
    const { run } = await harness.createTask(ids, ['bash', 'check.sh'], [approval.approvalId]);

    await harness.waitForStatus(run.runId, ['AWAITING_PLAN_APPROVAL']);
    const events = await harness.events(run.runId);
    const baseline = events.find((e) => e.kind === 'VERIFICATION_FINISHED' && e.payload.phase === 'BASELINE');
    expect(baseline, '批准过的命令必须真的执行，而不是被风险闸门挡成 SPAWN_ERROR').toBeTruthy();
    const outcome = (baseline!.payload.verification as { commands: Array<{ outcome: string }> }).commands[0]!;
    // 仓库是坏的，所以基线**失败**是对的 —— 关键是它 EXIT_NONZERO 而不是 SPAWN_ERROR
    expect(outcome.outcome).toBe('EXIT_NONZERO');

    const used = events.filter((e) => e.kind === 'COMMAND_APPROVAL_USED');
    expect(used.length).toBe(1);
    expect(used[0]!.payload.role).toBe('BASELINE');
    expect(used[0]!.payload.executions).toBe(1);

    // 平台自己发起的命令同样进账本（Slice I-2）
    const { toolCalls } = await harness.call<{ toolCalls: Array<{ toolName: string; risk: string }> }>(
      'run.toolCalls',
      { runId: run.runId },
    );
    const verifyCalls = toolCalls.filter((t) => t.toolName === 'verify_command');
    expect(verifyCalls.length).toBe(1);
    expect(verifyCalls[0]!.risk, '账本里记的是它真实的等级 R2，不是被批准后改写的 R1').toBe('R2');
  });

  it('票被撤走之后再执行：闸门自己再查一次，不因为登记时查过就放行', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    harness.script('api.deepseek.com', [planCall]);
    const { run } = await harness.createTask(ids, ['bash', 'check.sh'], [approval.approvalId]);
    await harness.waitForStatus(run.runId, ['AWAITING_PLAN_APPROVAL']);

    /*
     * 模拟"批准记录已不在"（进程重启后批准一律作废）。这里问的是**闸门本身**，
     * 不是去和后台 Run 抢时序 —— 那种写法要么偶发红，要么在赌基线还没跑完。
     * 「不跑 ≠ 通过」由 verify.test.ts 直接对 runVerification 断言。
     */
    const record = (harness.authority as unknown as { runs: Map<string, unknown> }).runs.get(run.runId)!;
    (harness.authority as unknown as { commandApprovals: Map<string, CommandApproval> }).commandApprovals.clear();
    const checker = (harness.authority as unknown as {
      approvalCheckerFor: (r: unknown) => {
        consume: (def: unknown, role: string) => { ok: boolean; reason?: string };
      };
    }).approvalCheckerFor(record);
    const verdict = checker.consume(
      { commandId: 'user1', argv: ['bash', 'check.sh'], risk: 'R2', approvalId: approval.approvalId },
      'VERIFICATION',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('批准记录已不存在');
  });

  it('用户批的是自己的验证命令，不是模型的工具：MODEL_PROPOSED 借不到这张票', async () => {
    const ids = await harness.prepare(makeFixtureRepo());
    const approval = await harness.call<CommandApproval>('command.requestApproval', { argv: ['bash', 'check.sh'] });
    harness.script('api.deepseek.com', [planCall]);
    const { run } = await harness.createTask(ids, ['bash', 'check.sh'], [approval.approvalId]);
    await harness.waitForStatus(run.runId, ['AWAITING_PLAN_APPROVAL']);

    // 直接问执行期闸门：同一条命令、同一张票，只有角色不同
    const record = (harness.authority as unknown as {
      runs: Map<string, { view: RunView }>;
    }).runs.get(run.runId)!;
    const checker = (harness.authority as unknown as {
      approvalCheckerFor: (r: unknown) => {
        consume: (def: unknown, role: string) => { ok: boolean; reason?: string };
      };
    }).approvalCheckerFor(record);
    const def = { commandId: 'user1', argv: ['bash', 'check.sh'], risk: 'R2', approvalId: approval.approvalId };
    expect(checker.consume(def, 'VERIFICATION').ok).toBe(true);
    const denied = checker.consume(def, 'MODEL_PROPOSED');
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('模型提出的调用不能借用');
  });

  it('批准过的命令也要过凭据扫描：argv 里带 key 的一律拒批（批准过的 argv 会原样进事件流）', async () => {
    await expect(
      harness.call('command.requestApproval', { argv: ['mytool', '--token', 'AKIAIOSFODNN7EXAMPLE'] }),
    ).rejects.toThrow(/凭据/);
  });
});
