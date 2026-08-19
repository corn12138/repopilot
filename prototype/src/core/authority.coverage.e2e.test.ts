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
  const root = mkTemp(j(tmp(), 'repopilot-coverage-e2e-'));
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
 * 验证覆盖不能被静默放宽（Slice G）的权威层端到端。
 *
 * 08-17 审计里全仓最短的 false-green 路径：改一下验证输入（这里是验证脚本 check.mjs 本身），
 * 基线失败的命令在 POST_MUTATION 变绿 → 补丁绑一次 passed 的验证 → 接受 → SUCCEEDED。
 * 这两条用例分别用外部作者（黑盒）和内部模型走这条路，断言同一件事：
 * 补丁被标 COVERAGE_WEAKENED，接受后只能是 ACCEPTED_UNVERIFIED，导出文件头写 NO。
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
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-coverage-repo-'));
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


/** 内部模型路径用：fs_read / workspace_mutate 的 wire 构造 */
function lastReceipt(bodyText: string): string {
  const matches = [...bodyText.matchAll(/receiptId=(rcpt_[a-z0-9]+)/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) throw new Error(`脚本期望上下文里有 receiptId，但没有：${bodyText.slice(-500)}`);
  return last;
}
function oaText(text: string): unknown {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  };
}

describe('Slice G：补丁动了验证输入，"验证通过"就不能再证明修复', () => {
  it(
    '外部作者把验证脚本改成恒通过、源码仍 broken → 验证"通过" → COVERAGE_WEAKENED → 接受只能 ACCEPTED_UNVERIFIED，导出头 verified: NO',
    async () => {
      installFakeCodex(`printf "console.log('ok');\\n" > check.mjs`);
      harness.script(IMPL, [() => planCall()]);
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
      await harness.approvePlan(runId);
      const awaiting = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      expect(awaiting.failureClass ?? null).toBeNull();

      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      // 验证确实"通过"了 —— 这正是 false green 的形态
      expect(patch.verificationRunId).not.toBeNull();
      expect(patch.comparison?.fixed).toContain('user1');
      // 但补丁被如实标注：动了验证输入
      expect(patch.verificationInputsTouched).toEqual(['check.mjs']);
      expect(patch.unverifiedItems[0]).toContain('COVERAGE_WEAKENED');
      expect(patch.unverifiedItems[0]).toContain('check.mjs');
      expect(patch.files.map((f) => f.path)).toEqual(['check.mjs']);

      const decided = await harness.call<{ run: RunView }>('patch.decide', {
        runId,
        patchId: patch.patchId,
        decision: 'ACCEPT',
        patchDigest: patch.digest,
        note: '',
      });
      expect(decided.run.status).toBe('ACCEPTED_UNVERIFIED');
      expect(decided.run.statusReason).toContain('验证输入');
      expect(decided.run.terminalFacts?.verificationRunId).toBeNull();
      expect(decided.run.terminalFacts?.patchAcceptanceId).toBeTruthy();

      const exported = await harness.call<{ content: string }>('__patch.content', { runId, patchId: patch.patchId });
      const verifiedLine = exported.content.split('\n').find((l) => l.startsWith('# verified:'));
      expect(verifiedLine).toContain('NO');
      expect(verifiedLine).toContain('check.mjs');
      expect(verifiedLine).not.toMatch(/^# verified:\s+yes/);
    },
    30_000,
  );

  it(
    '内部模型走同一条路（用 workspace_mutate 改验证脚本）→ 同样 COVERAGE_WEAKENED / ACCEPTED_UNVERIFIED',
    async () => {
      harness.script(IMPL, [
        () => planCall(),
        () => oaToolCall('fs_read', { path: 'check.mjs' }),
        (body?: string) =>
          oaToolCall('workspace_mutate', {
            operations: [
              {
                kind: 'REPLACE_WHOLE_FILE',
                path: 'check.mjs',
                receiptId: lastReceipt(body ?? ''),
                newText: "console.log('ok');\n",
              },
            ],
          }),
        () => oaText('改好了。'),
      ]);
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({ hostPath });
      await harness.approvePlan(runId);
      await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.verificationInputsTouched).toEqual(['check.mjs']);
      expect(patch.unverifiedItems[0]).toContain('COVERAGE_WEAKENED');
      const decided = await harness.call<{ run: RunView }>('patch.decide', {
        runId,
        patchId: patch.patchId,
        decision: 'ACCEPT',
        patchDigest: patch.digest,
        note: '',
      });
      expect(decided.run.status).toBe('ACCEPTED_UNVERIFIED');
    },
    30_000,
  );

  it('对照：只改源码不碰验证输入 → verificationInputsTouched 为空、接受后 SUCCEEDED（规则没有误伤）', async () => {
    installFakeCodex(`printf "export const STATUS = 'fixed';\\n" > src/app.js`);
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
    const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
    expect(patch.verificationInputsTouched).toEqual([]);
    expect(patch.unverifiedItems.some((u) => u.includes('COVERAGE_WEAKENED'))).toBe(false);
    const decided = await harness.call<{ run: RunView }>('patch.decide', {
      runId,
      patchId: patch.patchId,
      decision: 'ACCEPT',
      patchDigest: patch.digest,
      note: '',
    });
    expect(decided.run.status).toBe('SUCCEEDED');
  }, 30_000);
});

describe('Slice I-1：用户手填的验证命令先分级再登记', () => {
  it('`git push origin main` / `rm -rf dist` / `npm install x` 作为验证命令 → task.create 拒绝（R4/R3/R2），不建 Run、不执行', async () => {
    const hostPath = makeFixtureRepo();
    const marker = join(hostPath, '.never-ran');
    const reg = await harness.call<{ project: { projectId: string } }>('__project.register', { hostPath });
    const imported = await harness.call<{ snapshot: { snapshotId: string }; profile: { profileId: string } }>('project.import', { projectId: reg.project.projectId });
    const { disclosure } = await harness.call<{ disclosure: { digest: string } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
    });
    const before = (await harness.call<{ runs: RunView[] }>('run.list', {})).runs.length;
    const attempt = (argv: string[]) =>
      harness.call('task.create', {
        projectId: reg.project.projectId,
        snapshotId: imported.snapshot.snapshotId,
        profileId: imported.profile.profileId,
        modelProfileId: 'profile_deepseek',
        egressConsentDigest: disclosure.digest,
        goal: 'x',
        taskClass: 'BUILD_FAILURE_FIX',
        allowedPaths: [],
        acceptance: [],
        verificationCommandIds: ['user1'],
        customCommands: [{ label: argv.join(' '), argv }],
      });
    await expect(attempt(['git', 'push', 'origin', 'main'])).rejects.toMatchObject({ payload: { code: 'BAD_REQUEST', message: expect.stringContaining('（R4）') } });
    await expect(attempt(['rm', '-rf', 'dist'])).rejects.toMatchObject({ payload: { message: expect.stringContaining('（R3）') } });
    await expect(attempt(['npm', 'install', 'some-pkg'])).rejects.toMatchObject({ payload: { message: expect.stringContaining('（R2）') } });
    await expect(attempt(['sh', '-c', `touch ${marker}`])).rejects.toMatchObject({ payload: { message: expect.stringContaining('（R2）') } });
    expect((await harness.call<{ runs: RunView[] }>('run.list', {})).runs.length).toBe(before);
    expect(existsSync(marker)).toBe(false);
    // 对照：R1 的本地脚本照常登记
    const ok = await harness.call<{ run: RunView }>('task.create', {
      projectId: reg.project.projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: 'profile_deepseek',
      egressConsentDigest: disclosure.digest,
      goal: 'x',
      taskClass: 'BUILD_FAILURE_FIX',
      allowedPaths: [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
    });
    expect(ok.run.runId).toBeTruthy();
  });
});
