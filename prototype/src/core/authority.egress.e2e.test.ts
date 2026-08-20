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
  const root = mkTemp(j(tmp(), 'repopilot-egress-e2e-'));
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
 * 出站前的人机契约（Slice H：PRD-DATA-001 披露/同意 + PRD-DATA-003 最小 DLP）的权威层端到端。
 *
 * 08-17 审计：这两条 P0 在代码里"一个符号都没有"——第一笔请求把源码发往第三方之前，
 * 没有披露、没有确认、没有内容扫描。这里钉：没同意建不了任务；同意的是精确的一份；
 * 对话里出现凭据时请求在发出前被拦且原因不含原文；外部 CLI 的 prompt 同样被扫。
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
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-egress-repo-'));
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
    /** undefined = 正常取披露并同意；null = 故意不带；字符串 = 故意带一个指定的 digest */
    egressConsentDigest?: string | null;
    customCommands?: { label: string; argv: string[] }[];
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
    const consentDigest =
      input.egressConsentDigest === undefined ? disclosure.digest : input.egressConsentDigest;
    const { run } = await this.call<{ run: RunView }>('task.create', {
      projectId: reg.project.projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: 'profile_deepseek',
      ...(consentDigest === null ? {} : { egressConsentDigest: consentDigest }),
      goal: '修复 node check.mjs 失败：src/app.js 的 STATUS 仍是 broken',
      taskClass: imported.profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
      allowedPaths: input.allowedPaths ?? [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: input.customCommands ?? [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
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
   * 先停掉还在跑的 Run：用例结束时后台可能仍有 Attempt 在推进。fetch 是全局 stub，
   * 上一条用例的后台 Run 会去喝**下一条**用例的模型脚本，表现成"脚本已耗尽"的假失败
   * （单独跑绿、一起跑红）。这段在四份 harness 副本里都要有 —— 复制出来的东西会各自漂移。
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



const SECRET = 'AKIAIOSFODNN7EXAMPLE';

describe('Slice H：出站前的人机契约', () => {
  it('不带同意 → CONSENT_REQUIRED，不建 Run；带错的 digest → CONSENT_STALE；fetch 一次都没被调用', async () => {
    const hostPath = makeFixtureRepo();
    await expect(harness.createRun({ hostPath, egressConsentDigest: null })).rejects.toMatchObject({
      payload: { code: 'BAD_REQUEST', message: expect.stringContaining('CONSENT_REQUIRED') },
    });
    await expect(harness.createRun({ hostPath, egressConsentDigest: 'sha256:not-the-one-shown' })).rejects.toMatchObject({
      payload: { code: 'BAD_REQUEST', message: expect.stringContaining('CONSENT_STALE') },
    });
    const { runs } = await harness.call<{ runs: RunView[] }>('run.list', {});
    expect(runs.filter((r) => !r.restored)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('披露与实际目的地同源：加了审核方/作者之后，旧 digest 失效', async () => {
    installFakeCodex('true');
    process.env.MOONSHOT_API_KEY = 'sk-e2e-reviewer';
    const hostPath = makeFixtureRepo();
    const reg = await harness.call<{ project: { projectId: string } }>('__project.register', { hostPath });
    const imported = await harness.call<{ snapshot: { snapshotId: string }; profile: { profileId: string } }>('project.import', { projectId: reg.project.projectId });
    const plain = await harness.call<{ disclosure: { digest: string; destinations: unknown[] } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
    });
    const withBoth = await harness.call<{ disclosure: { digest: string; destinations: { role: string; channel: string }[] } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
      reviewerModelProfileId: 'profile_moonshot-cn',
      authorConnectorId: 'codex-cli',
    });
    expect(plain.disclosure.destinations).toHaveLength(1);
    expect(withBoth.disclosure.destinations.map((d) => `${d.role}:${d.channel}`)).toEqual([
      'IMPLEMENTER:MODEL_API',
      'REVIEWER:MODEL_API',
      'AUTHOR:EXTERNAL_CLI',
    ]);
    expect(withBoth.disclosure.digest).not.toBe(plain.disclosure.digest);
    // 用"只有实现方"的 digest 去建一个"有审核方+作者"的任务 → STALE
    await expect(
      harness.call('task.create', {
        projectId: reg.project.projectId,
        snapshotId: imported.snapshot.snapshotId,
        profileId: imported.profile.profileId,
        modelProfileId: 'profile_deepseek',
        egressConsentDigest: plain.disclosure.digest,
        goal: 'x',
        taskClass: 'BUILD_FAILURE_FIX',
        allowedPaths: [],
        acceptance: [],
        verificationCommandIds: [],
        reviewerModelProfileId: 'profile_moonshot-cn',
        authorConnectorId: 'codex-cli',
      }),
    ).rejects.toMatchObject({ payload: { message: expect.stringContaining('CONSENT_STALE') } });
    delete process.env.MOONSHOT_API_KEY;
  });

  it('同意后 RUN_CREATED 带 egressConsent（目的地/通道/中转/数据类别/政策 UNKNOWN），并有一条可读的 NOTE', async () => {
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath });
    await harness.waitForStatus(runId, ['AWAITING_PLAN_APPROVAL']);
    const events = await harness.events(runId);
    const created = events.find((e) => e.kind === 'RUN_CREATED')!;
    const consent = created.payload.egressConsent as {
      disclosureDigest: string;
      destinations: { role: string; channel: string; origin: string | null; isRelay: boolean; dataClasses: string[] }[];
      policy: { retention: string; training: string; region: string };
    };
    expect(consent.disclosureDigest).toMatch(/^sha256:/);
    expect(consent.destinations).toEqual([
      expect.objectContaining({ role: 'IMPLEMENTER', channel: 'MODEL_API', origin: 'https://api.deepseek.com/v1', isRelay: false }),
    ]);
    expect(consent.destinations[0]!.dataClasses).toContain('REPOSITORY_SNAPSHOT_EXCERPTS');
    expect(consent.policy).toEqual({ retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' });
    expect(events.some((e) => e.kind === 'NOTE' && e.summary.includes('数据出站披露已确认') && e.summary.includes('未知'))).toBe(true);
  });

  it(
    '基线输出里带 AWS key → 在命令层就被脱敏：事件/模型请求/界面都只见占位符，规划照常进行',
    async () => {
      const hostPath = makeFixtureRepo();
      writeFileSync(
        join(hostPath, 'check.mjs'),
        `console.error('still broken, see AWS_ACCESS_KEY_ID=${SECRET}'); process.exit(1);\n`,
      );
      execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'commit', '-qam', 'leak'], { cwd: hostPath });
      const bodies: string[] = [];
      harness.script(IMPL, [
        (body) => {
          bodies.push(body ?? '');
          return planCall();
        },
      ]);
      const { runId } = await harness.createRun({ hostPath });
      await harness.waitForStatus(runId, ['AWAITING_PLAN_APPROVAL']);
      const events = await harness.events(runId);
      const baseline = events.find((e) => e.kind === 'VERIFICATION_FINISHED')!;
      const stderr = (baseline.payload.verification as { commands: { stderrPreview: string }[] }).commands[0]!.stderrPreview;
      expect(stderr).toContain('[REDACTED:AWS_ACCESS_KEY_ID]');
      expect(stderr).not.toContain(SECRET);
      // 持久化的事件流、发出去的请求体：都没有原文
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain(SECRET);
      expect(bodies[0]).toContain('[REDACTED:AWS_ACCESS_KEY_ID]');
    },
    30_000,
  );

  it('外部 CLI 作者收到的简报同样只见占位符（基线输出里的 GitHub token 已在命令层脱敏）', async () => {
    const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123';
    const hostPath = makeFixtureRepo();
    writeFileSync(join(hostPath, 'check.mjs'), `console.error('${TOKEN}'); process.exit(1);\n`);
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'commit', '-qam', 'leak2'], { cwd: hostPath });
    const { promptLog } = installFakeCodex(`printf "export const STATUS = 'fixed';\\n" > src/app.js`);
    harness.script(IMPL, [() => planCall()]);
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW', 'BLOCKED', 'FAILED']);
    const prompt = readFileSync(promptLog, 'utf8');
    expect(prompt).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(prompt).not.toContain(TOKEN);
  });

  it('任务描述里粘了一把 key → task.create 直接拒绝（DLP），不落 RUN_CREATED、不建 Run', async () => {
    const hostPath = makeFixtureRepo();
    const reg = await harness.call<{ project: { projectId: string } }>('__project.register', { hostPath });
    const imported = await harness.call<{ snapshot: { snapshotId: string }; profile: { profileId: string } }>('project.import', { projectId: reg.project.projectId });
    const { disclosure } = await harness.call<{ disclosure: { digest: string } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
    });
    const before = (await harness.call<{ runs: RunView[] }>('run.list', {})).runs.length;
    await expect(
      harness.call('task.create', {
        projectId: reg.project.projectId,
        snapshotId: imported.snapshot.snapshotId,
        profileId: imported.profile.profileId,
        modelProfileId: 'profile_deepseek',
        egressConsentDigest: disclosure.digest,
        goal: `修一下，顺便用这个 key：${SECRET}`,
        taskClass: 'BUILD_FAILURE_FIX',
        allowedPaths: [],
        acceptance: [],
        verificationCommandIds: [],
      }),
    ).rejects.toMatchObject({ payload: { code: 'BAD_REQUEST', message: expect.stringContaining('DLP: AWS_ACCESS_KEY_ID') } });
    expect((await harness.call<{ runs: RunView[] }>('run.list', {})).runs.length).toBe(before);
    // 拒绝信息本身也不含原文
    await expect(
      harness.call('task.create', {
        projectId: reg.project.projectId,
        snapshotId: imported.snapshot.snapshotId,
        profileId: imported.profile.profileId,
        modelProfileId: 'profile_deepseek',
        egressConsentDigest: disclosure.digest,
        goal: `修一下 ${SECRET}`,
        taskClass: 'BUILD_FAILURE_FIX',
        allowedPaths: [],
        acceptance: [],
        verificationCommandIds: [],
      }),
    ).rejects.not.toThrow(new RegExp(SECRET));
  });
});
