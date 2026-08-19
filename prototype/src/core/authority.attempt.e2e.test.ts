import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 受管数据根重定向到进程私有临时目录（与 authority.e2e.test.ts 同一手法）
vi.mock('./paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-attempt-e2e-'));
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

import type { ApprovalRequest, PatchArtifact, RunEvent, RunView } from '@shared/domain';
import type { PushEvent } from '@shared/protocol';
import { RunAuthority } from './authority';
import { PATHS } from './paths';

/**
 * REQUEST_CHANGES 开新 Attempt（PRD-DIFF-003 / PRD §9：它不是 Run 终态）的权威层端到端。
 *
 * 08-17 审计：`REQUEST_CHANGES` 被做成了终态（BLOCKED + "原型暂未实现新 Attempt"），
 * attemptId 全仓只有一个生成点，加上 setStatus 的"终态不可逆"守卫，这个 Run 之后再也无法推进。
 * 这里钉：新 Attempt 真的开起来、编号递增、旧补丁进历史、预算接着用不重置、
 * 用户反馈与上一版 diff 进了模型简报、工作区回到快照、最终能被接受。
 *
 * （以下 harness 与 authority.external-author.e2e.test.ts 同源）
 *
 * 规划仍由 RepoPilot 自己的模型（fetch 被脚本化）完成并经用户审批；
 * 执行阶段换成一个**真子进程**假 Codex CLI —— 它在 candidate 目录里改文件、
 * 按 stdin 里的简报决定改成什么。验证是真跑 `node check.mjs`。
 *
 * 每条用例钉的都是同一条边界：外部作者只能在 candidate 里写，主线只因 applyMutationPlan 前进；
 * 它写了什么不算数，tree diff + 验证才算数。
 */

const APP_FILE = 'src/app.js';
const fixtureRepos = new Set<string>();
const tempDirs = new Set<string>();

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-attempt-repo-'));
  fixtureRepos.add(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, APP_FILE), "export const STATUS = 'broken';\n");
  writeFileSync(
    join(dir, 'check.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      "const s = readFileSync('src/app.js', 'utf8');\n" +
      "if (!s.includes('fixed')) { console.error('still broken'); process.exit(1); }\n" +
      "console.log('ok');\n",
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', ...args], { cwd: dir, stdio: 'ignore' });
  git('init');
  git('add', '.');
  git('commit', '-m', 'broken baseline');
  return dir;
}

/**
 * 假 Codex CLI：shell 脚本，cwd 就是 candidate 目录，stdin 是平台给的 prompt。
 * 它把 stdin 存进 candidate 外的一个文件（供断言"简报里有什么"），然后执行 body。
 */
function installFakeCodex(body: string): { promptLog: string } {
  const bin = mkdtempSync(join(tmpdir(), 'repopilot-fakecodex-'));
  tempDirs.add(bin);
  const promptLog = join(bin, 'prompts.log');
  const exe = join(bin, 'codex');
  writeFileSync(
    exe,
    `#!/bin/sh\n` +
      // --version 探测：只回版本
      `for a in "$@"; do if [ "$a" = "--version" ]; then echo "fakecodex 0.0.1"; exit 0; fi; done\n` +
      `PROMPT=$(cat)\n` +
      `printf '%s\\n=====\\n' "$PROMPT" >> "${promptLog}"\n` +
      `${body}\n`,
  );
  chmodSync(exe, 0o755);
  process.env.REPOPILOT_CODEX_CLI_PATH = exe;
  return { promptLog };
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
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  };
}
const planCall = (): unknown =>
  oaToolCall('submit_plan', {
    summary: 'src/app.js 的 STATUS 是 broken，check.mjs 因此退出 1。把它改成 fixed。',
    steps: [{ intent: '将 src/app.js 的 STATUS 改为 fixed', targetPaths: [APP_FILE], expectedEffect: 'node check.mjs 退出 0' }],
    risks: [],
  });

const IMPL = 'api.deepseek.com';

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
  async createRun(input: {
    hostPath: string;
    authorConnectorId?: string;
    reviewerModelProfileId?: string;
    reviewerConnectorId?: string;
    allowedPaths?: string[];
  }): Promise<{ runId: string }> {
    const reg = await this.call<{ project: { projectId: string } }>('__project.register', { hostPath: input.hostPath });
    const imported = await this.call<{
      outcome: string;
      snapshot: { snapshotId: string };
      profile: { profileId: string; supportedTaskClasses: string[] };
    }>('project.import', { projectId: reg.project.projectId });
    expect(imported.outcome).toBe('IMPORTED');
    const { disclosure } = await this.call<{ disclosure: { digest: string } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
      ...(input.authorConnectorId ? { authorConnectorId: input.authorConnectorId } : {}),
      ...(input.reviewerModelProfileId ? { reviewerModelProfileId: input.reviewerModelProfileId } : {}),
      ...(input.reviewerConnectorId ? { reviewerConnectorId: input.reviewerConnectorId } : {}),
    });
    const { run } = await this.call<{ run: RunView }>('task.create', {
      projectId: reg.project.projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: 'profile_deepseek',
      egressConsentDigest: disclosure.digest,
      goal: '修复 node check.mjs 失败：src/app.js 的 STATUS 仍是 broken',
      taskClass: imported.profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
      allowedPaths: input.allowedPaths ?? [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
      ...(input.authorConnectorId ? { authorConnectorId: input.authorConnectorId } : {}),
      ...(input.reviewerModelProfileId ? { reviewerModelProfileId: input.reviewerModelProfileId } : {}),
      ...(input.reviewerConnectorId ? { reviewerConnectorId: input.reviewerConnectorId } : {}),
    });
    return { runId: run.runId };
  }
  async approvePlan(runId: string): Promise<void> {
    await this.waitForStatus(runId, ['AWAITING_PLAN_APPROVAL']);
    const { approvals } = await this.call<{ approvals: ApprovalRequest[] }>('approval.pending', { runId });
    const r = await this.call<{ accepted: boolean }>('approval.decide', {
      approvalId: approvals[0]!.approvalId,
      decision: 'APPROVE',
      subjectDigest: approvals[0]!.subjectDigest,
      note: '',
    });
    expect(r.accepted).toBe(true);
  }
}

let harness: Harness;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-e2e-planner';
  process.env.OPENAI_API_KEY = 'sk-e2e-for-fake-codex';
  harness = new Harness();
});

afterEach(() => {
  /*
   * 先停掉还在跑的 Run：这个文件里的用例会开出**第二个 Attempt**，它在用例结束后
   * 仍在后台推进。fetch 是全局 stub，上一条用例的后台 Run 会去喝**下一条**用例的模型脚本，
   * 表现成"脚本已耗尽"的假失败（单独跑绿、一起跑红）。
   */
  harness.authority.shutdown('test-teardown');
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.REPOPILOT_CODEX_CLI_PATH;
  vi.unstubAllGlobals();
  for (const d of [...fixtureRepos, ...tempDirs]) rmSync(d, { recursive: true, force: true });
  fixtureRepos.clear();
  tempDirs.clear();
});

/** 工作区根下不允许残留 candidate-* 目录 */
function candidateDirsUnder(runId: string): string[] {
  const root = join(PATHS.workspaces, runId);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => n.startsWith('candidate-'));
}



function oaText(text: string): unknown {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  };
}

/** 记录每次发给实现方的请求体，用来断言"用户反馈确实进了简报" */
function scriptWithCapture(bodies: string[], responders: Array<(body: string) => unknown>): Array<(body?: string) => unknown> {
  return responders.map((r) => (body?: string) => {
    bodies.push(body ?? '');
    return r(body ?? '');
  });
}

describe('REQUEST_CHANGES：开新 Attempt，不是终态', () => {
  it(
    '要求修改 → attemptNo 2、旧补丁进历史、工作区回到快照、反馈与上一版 diff 进简报 → 第二版被接受',
    async () => {
      const bodies: string[] = [];
      /*
       * 两版都能通过验证 —— 这正是 REQUEST_CHANGES 的典型场景：机器说通过了，
       * 但人看了实现方式不满意。（验证不通过的路径由 VERIFICATION_FAILED 覆盖，不走这里。）
       */
      installFakeCodex(
        `if printf '%s' "$PROMPT" | grep -q '要求修改'; then\n` +
          `  printf "export const STATUS = 'fixed'; // v2 按反馈重写\\n" > src/app.js\n` +
          `else\n` +
          `  printf "export const STATUS = 'fixed'; // v1 先凑合\\n" > src/app.js\n` +
          `fi`,
      );
      harness.script(IMPL, scriptWithCapture(bodies, [() => planCall(), () => planCall()]));
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
      await harness.approvePlan(runId);

      // ---- 第一版：验证失败，但仍会封存补丁供人审查 ----
      const first = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW', 'FAILED', 'BLOCKED']);
      expect(first.status).toBe('AWAITING_PATCH_REVIEW');
      expect(first.attemptNo).toBe(1);
      const firstAttemptId = first.attemptId;
      const { patch: p1 } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(p1.unifiedDiff).toContain('v1 先凑合');
      const ledgerBefore = { ...first.ledger };

      // ---- 用户要求修改 ----
      const decided = await harness.call<{ run: RunView; reason: string | null }>('patch.decide', {
        runId,
        patchId: p1.patchId,
        decision: 'REQUEST_CHANGES',
        patchDigest: p1.digest,
        note: '能过验证，但别用行内注释凑合，按项目风格重写',
      });
      expect(decided.reason).toBeNull();
      // 不是终态：Run 继续，attempt 递增，attemptId 换新
      expect(['CREATED', 'PLANNING', 'EXECUTING', 'AWAITING_PLAN_APPROVAL']).toContain(decided.run.status);
      expect(decided.run.attemptNo).toBe(2);
      expect(decided.run.attemptId).not.toBe(firstAttemptId);
      expect(decided.run.failureClass ?? null).toBeNull();
      // 工作区回到快照（不续用旧 workspace）
      expect(decided.run.workspaceGeneration).toBe(0);

      // 旧补丁进历史，当前补丁清空 —— 证据不丢，但不再是"待决定的那一份"
      const afterRc = await harness.call<{ patch: PatchArtifact | null; priorPatches: PatchArtifact[] }>('patch.get', { runId });
      expect(afterRc.patch).toBeNull();
      expect(afterRc.priorPatches).toHaveLength(1);
      expect(afterRc.priorPatches[0]!.digest).toBe(p1.digest);
      expect(afterRc.priorPatches[0]!.unifiedDiff).toContain('v1 先凑合');

      // ---- 第二次审批 → 第二版补丁 ----
      await harness.approvePlan(runId);
      const second = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW', 'FAILED', 'BLOCKED']);
      expect(second.status).toBe('AWAITING_PATCH_REVIEW');
      expect(second.attemptNo).toBe(2);

      // 反馈与上一版 diff 真的进了第二次规划的简报
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain('要求修改');
      expect(bodies[1]).toContain('别用行内注释凑合');
      expect(bodies[1]).toContain('v1 先凑合'); // 上一版 diff
      expect(bodies[1]).toContain('第 2 次尝试');
      expect(bodies[0]).not.toContain('要求修改');

      // 预算是接着用的，不是重置
      expect(second.ledger.modelTurns).toBeGreaterThan(ledgerBefore.modelTurns);
      expect(second.ledger.toolCalls).toBeGreaterThanOrEqual(ledgerBefore.toolCalls);

      // 事件：ATTEMPT_STARTED 带上编号、上一版 digest 与起始账本
      const events = await harness.events(runId);
      const started = events.find((e) => e.kind === 'ATTEMPT_STARTED')!;
      expect(started).toBeDefined();
      expect(started.payload.attemptNo).toBe(2);
      expect(started.payload.previousPatchDigest).toBe(p1.digest);
      expect((started.payload.ledgerAtStart as { modelTurns: number }).modelTurns).toBe(ledgerBefore.modelTurns);
      // 事件的 attemptId 分属两次尝试
      expect(new Set(events.map((e) => e.attemptId)).size).toBe(2);

      // ---- 接受第二版 ----
      const { patch: p2 } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(p2.digest).not.toBe(p1.digest);
      expect(p2.unifiedDiff).toContain('v2 按反馈重写');
      const accepted = await harness.call<{ run: RunView }>('patch.decide', {
        runId,
        patchId: p2.patchId,
        decision: 'ACCEPT',
        patchDigest: p2.digest,
        note: '',
      });
      expect(accepted.run.status).toBe('SUCCEEDED');
      expect(accepted.run.attemptNo).toBe(2);
    },
    45_000,
  );

  it('旧补丁的 digest 在新 Attempt 里不再可决定 —— 陈旧的界面点不动已被取代的补丁', async () => {
    installFakeCodex(`printf "export const STATUS = 'fixed'; // v1\\n" > src/app.js`);
    harness.script(IMPL, [() => planCall(), () => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
    const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
    await harness.call('patch.decide', {
      runId,
      patchId: patch.patchId,
      decision: 'REQUEST_CHANGES',
      patchDigest: patch.digest,
      note: '再改',
    });
    // 新 Attempt 已经在跑，旧补丁不再是"当前补丁"
    await expect(
      harness.call('patch.decide', {
        runId,
        patchId: patch.patchId,
        decision: 'ACCEPT',
        patchDigest: patch.digest,
        note: '',
      }),
    ).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
  }, 45_000);

  it('预算已耗尽时不开新 Attempt：BLOCKED + CHANGES_REQUESTED，理由点名是哪一项预算', async () => {
    installFakeCodex(`printf "export const STATUS = 'fixed'; // v1\\n" > src/app.js`);
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    const view = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
    const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });

    /*
     * 把账本推到模型轮次上限。任务预算在 createTask 里是写死的，没有对外入口能调小它 ——
     * 与其为了这条断言在产品里开一个 setter（那本身就是个绕过口），不如在测试里明说
     * 自己在戳内部状态。被测的仍然是产品逻辑：startChangeRequestAttempt 的余额判断。
     */
    const internals = harness.authority as unknown as { runs: Map<string, { view: RunView }> };
    const rec = internals.runs.get(runId)!;
    rec.view = { ...rec.view, ledger: { ...rec.view.ledger, modelTurns: view.limits.maxModelTurns } };

    const decided = await harness.call<{ run: RunView }>('patch.decide', {
      runId,
      patchId: patch.patchId,
      decision: 'REQUEST_CHANGES',
      patchDigest: patch.digest,
      note: '再改',
    });
    expect(decided.run.status).toBe('BLOCKED');
    expect(decided.run.failureClass).toBe('CHANGES_REQUESTED');
    expect(decided.run.statusReason).toContain('模型轮次已达上限');
    expect(decided.run.statusReason).toContain('共用同一份任务预算');
    expect(decided.run.attemptNo).toBe(1); // 没有开出新的
  }, 45_000);

  it('恢复态的 Run 可以接受/拒绝，但要求修改会被明确拒绝（没有活的执行器）', async () => {
    installFakeCodex(`printf "export const STATUS = 'fixed'; // v1\\n" > src/app.js`);
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
    const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });

    // 换一个 Authority 从磁盘恢复：AWAITING_PATCH_REVIEW 可跨重启存活
    const restored = new Harness();
    const got = await restored.call<{ run: RunView | null }>('run.get', { runId });
    expect(got.run).toMatchObject({ status: 'AWAITING_PATCH_REVIEW', restored: true });
    const decided = await restored.call<{ run: RunView }>('patch.decide', {
      runId,
      patchId: patch.patchId,
      decision: 'REQUEST_CHANGES',
      patchDigest: patch.digest,
      note: '再改',
    });
    expect(decided.run.status).toBe('BLOCKED');
    expect(decided.run.statusReason).toContain('从磁盘恢复');
    expect(decided.run.statusReason).toContain('可以接受或拒绝');
  }, 45_000);
});
