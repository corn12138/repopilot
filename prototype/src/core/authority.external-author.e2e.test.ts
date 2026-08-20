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
  const root = mkTemp(j(tmp(), 'repopilot-xauthor-e2e-'));
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
 * 外部作者（Codex/Claude CLI 当实现方）的权威层端到端。
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
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-xauthor-repo-'));
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
  private readonly queues = new Map<string, Array<() => unknown>>();

  constructor() {
    this.authority = new RunAuthority((e) => this.pushes.push(e), { backgroundRetention: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const host = new URL(String(url)).host;
        const queue = this.queues.get(host);
        if (!queue || queue.length === 0) throw new Error(`${host} 的模型脚本已耗尽`);
        return new Response(JSON.stringify(queue.shift()!()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }
  script(host: string, responders: Array<() => unknown>): void {
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

describe('外部作者 e2e：Codex 写、平台归一化、真验证、人收口', () => {
  it(
    '黄金路径：规划(内部模型) → 审批 → 假 Codex 在 candidate 里修好 → 归一化进主线 → 真验证通过 → 接受 SUCCEEDED',
    async () => {
      const { promptLog } = installFakeCodex(
        `printf "export const STATUS = 'fixed';\\n" > src/app.js\n` +
          `printf '{"summary":"把 STATUS 改成 fixed","changedFiles":["src/app.js"],"gaveUp":false}'`,
      );
      harness.script(IMPL, [() => planCall()]);
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
      await harness.approvePlan(runId);

      const awaiting = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      expect(awaiting.failureClass ?? null).toBeNull();
      expect(awaiting.workspaceGeneration).toBe(1);
      // 账本：1 轮规划（已知用量）+ 1 轮外部作者（token 未知，记未知轮，不折算 0）
      expect(awaiting.ledger.modelTurns).toBe(2);
      expect(awaiting.ledger.unknownUsageTurns).toBe(1);
      expect(awaiting.ledger.inputTokens).toBe(120);

      const events = await harness.events(runId);
      const inv = events.find((e) => e.kind === 'MODEL_INVOCATION' && (e.payload.externalInvocation as { role?: string } | undefined)?.role === 'CANDIDATE_AUTHOR');
      expect(inv).toBeDefined();
      expect((inv!.payload.externalInvocation as { state: string; phase: string; changedCount: number }).state).toBe('SEALED');
      expect((inv!.payload.externalInvocation as { phase: string }).phase).toBe('IMPLEMENT');
      const applied = events.find((e) => e.kind === 'MUTATION_APPLIED' && e.payload.source === 'EXTERNAL_AUTHOR');
      expect(applied).toBeDefined();
      expect(applied!.payload.paths).toEqual([APP_FILE]);
      expect(applied!.payload.outputGeneration).toBe(1);
      // 作者备注被记录但标明 untrusted
      expect(events.some((e) => e.kind === 'NOTE' && e.summary.includes('作者备注（untrusted'))).toBe(true);
      // 简报里有用户批准的计划与基线失败；没有内部工具规则
      const prompt = readFileSync(promptLog, 'utf8');
      expect(prompt).toContain('用户已批准的计划');
      expect(prompt).toContain('基线验证结果');
      expect(prompt).not.toContain('fs_read');
      // candidate 目录已丢弃
      expect(candidateDirsUnder(runId)).toEqual([]);

      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.files.map((f) => f.path)).toEqual([APP_FILE]);
      expect(patch.unifiedDiff).toContain("+export const STATUS = 'fixed';");
      expect(patch.verificationRunId).not.toBeNull();
      expect(patch.comparison?.fixed).toContain('user1');

      const decided = await harness.call<{ run: RunView }>('patch.decide', {
        runId,
        patchId: patch.patchId,
        decision: 'ACCEPT',
        patchDigest: patch.digest,
        note: '',
      });
      expect(decided.run.status).toBe('SUCCEEDED');
    },
    30_000,
  );

  it(
    '自修复：第一版没修对 → 验证失败 → 第二次调用的简报带上失败摘要 → 修对 → 通过',
    async () => {
      installFakeCodex(
        // 简报里出现"上一版改动之后的验证结果"才修对；第一次故意写错
        `if printf '%s' "$PROMPT" | grep -q '上一版改动之后的验证结果'; then\n` +
          `  printf "export const STATUS = 'fixed';\\n" > src/app.js\n` +
          `else\n` +
          `  printf "export const STATUS = 'still-broken';\\n" > src/app.js\n` +
          `fi`,
      );
      harness.script(IMPL, [() => planCall()]);
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
      await harness.approvePlan(runId);
      const awaiting = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      expect(awaiting.workspaceGeneration).toBe(2);
      const events = await harness.events(runId);
      expect(events.filter((e) => e.kind === 'SELF_FIX_ROUND').length).toBe(1);
      const phases = events
        .filter((e) => e.kind === 'MODEL_INVOCATION' && (e.payload.externalInvocation as { role?: string } | undefined)?.role === 'CANDIDATE_AUTHOR')
        .map((e) => (e.payload.externalInvocation as { phase: string }).phase);
      expect(phases).toEqual(['IMPLEMENT', 'SELF_FIX']);
      expect(candidateDirsUnder(runId)).toEqual([]);
    },
    30_000,
  );

  it(
    '双审闭环：Codex 写 → 平台验证 → Moonshot 审出阻断 → Codex 整改（REMEDIATE 简报）→ 重验 → 第二轮 PASS',
    async () => {
      installFakeCodex(
        // 整改简报里有"阻断发现"才加注释；首次只修 STATUS
        `if printf '%s' "$PROMPT" | grep -q '阻断发现'; then\n` +
          `  printf "export const STATUS = 'fixed'; // reviewed\\n" > src/app.js\n` +
          `else\n` +
          `  printf "export const STATUS = 'fixed';\\n" > src/app.js\n` +
          `fi`,
      );
      process.env.MOONSHOT_API_KEY = 'sk-e2e-reviewer';
      harness.script(IMPL, [() => planCall()]);
      harness.script('api.moonshot.cn', [
        () =>
          oaToolCall('submit_review', {
            verdict: 'CHANGES_REQUESTED',
            findings: [
              {
                severity: 'HIGH',
                confidence: 0.9,
                file: APP_FILE,
                startLine: 1,
                endLine: 1,
                evidence: '修复缺少说明注释，无法审计意图',
                blocking: true,
              },
            ],
          }),
        () => oaToolCall('submit_review', { verdict: 'PASS', findings: [] }),
      ]);
      const hostPath = makeFixtureRepo();
      const { runId } = await harness.createRun({
        hostPath,
        authorConnectorId: 'codex-cli',
        reviewerModelProfileId: 'profile_moonshot-cn',
      });
      await harness.approvePlan(runId);
      await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW'], 30_000);

      const { crossReview } = await harness.call<{
        crossReview: { reviewerInvocations: number; remediations: number; stopReason: string } | null;
      }>('crossreview.get', { runId });
      expect(crossReview).not.toBeNull();
      if (crossReview!.stopReason !== 'REVIEWER_PASSED') {
        const ev = await harness.events(runId);
        throw new Error('stopReason=' + crossReview!.stopReason + '\n' + ev.slice(-12).map((e) => `${e.kind} ${e.summary}`).join('\n'));
      }
      expect(crossReview!.stopReason).toBe('REVIEWER_PASSED');
      expect(crossReview!.reviewerInvocations).toBe(2);
      expect(crossReview!.remediations).toBe(1);

      const events = await harness.events(runId);
      const phases = events
        .filter((e) => e.kind === 'MODEL_INVOCATION' && (e.payload.externalInvocation as { role?: string } | undefined)?.role === 'CANDIDATE_AUTHOR')
        .map((e) => (e.payload.externalInvocation as { phase: string }).phase);
      expect(phases).toEqual(['IMPLEMENT', 'REMEDIATE']);
      const sealed = events.filter((e) => e.kind === 'PATCH_SEALED');
      expect(sealed).toHaveLength(2);
      expect(sealed[1]!.payload.remediated).toBe(true);
      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.unifiedDiff).toContain('// reviewed');
      expect(candidateDirsUnder(runId)).toEqual([]);
      delete process.env.MOONSHOT_API_KEY;
    },
    40_000,
  );

  it('作者什么都没改 → NO_CHANGES，终态 FAILED/NO_CHANGES，主线 gen 仍是 0', async () => {
    installFakeCodex(`printf '{"summary":"我没改","changedFiles":[],"gaveUp":true}'`);
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    const done = await harness.waitForStatus(runId, ['FAILED', 'BLOCKED']);
    expect(done.status).toBe('FAILED');
    expect(done.failureClass).toBe('NO_CHANGES');
    expect(done.workspaceGeneration).toBe(0);
    expect(candidateDirsUnder(runId)).toEqual([]);
  });

  it('作者触碰受保护路径（.github/**）→ candidate 被整笔拒绝，主线零写入，Run BLOCKED', async () => {
    installFakeCodex(
      `printf "export const STATUS = 'fixed';\\n" > src/app.js\n` +
        `mkdir -p .github/workflows && printf "on: push\\n" > .github/workflows/ci.yml`,
    );
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    const done = await harness.waitForStatus(runId, ['BLOCKED', 'FAILED']);
    expect(done.status).toBe('BLOCKED');
    expect(done.statusReason).toContain('PROTECTED_PATH');
    expect(done.workspaceGeneration).toBe(0);
    const events = await harness.events(runId);
    expect(events.some((e) => e.kind === 'NOTE' && e.summary.includes('candidate 被拒绝') && e.summary.includes('主线零写入'))).toBe(true);
    expect(events.some((e) => e.kind === 'MUTATION_APPLIED')).toBe(false);
    const { patch } = await harness.call<{ patch: PatchArtifact | null }>('patch.get', { runId });
    expect(patch).toBeNull();
    expect(candidateDirsUnder(runId)).toEqual([]);
  });

  it('作者退出非零 → 调用 FAILED，candidate 不读不采用，Run BLOCKED', async () => {
    installFakeCodex(`printf "export const STATUS = 'fixed';\\n" > src/app.js\necho "rate limited" >&2\nexit 2`);
    harness.script(IMPL, [() => planCall()]);
    const hostPath = makeFixtureRepo();
    const { runId } = await harness.createRun({ hostPath, authorConnectorId: 'codex-cli' });
    await harness.approvePlan(runId);
    const done = await harness.waitForStatus(runId, ['BLOCKED', 'FAILED']);
    expect(done.status).toBe('BLOCKED');
    expect(done.statusReason).toContain('外部作者调用失败');
    expect(done.workspaceGeneration).toBe(0);
    const events = await harness.events(runId);
    const inv = events.find((e) => e.kind === 'MODEL_INVOCATION' && (e.payload.externalInvocation as { role?: string } | undefined)?.role === 'CANDIDATE_AUTHOR');
    expect((inv!.payload.externalInvocation as { state: string; exitCode: number }).state).toBe('FAILED');
    expect((inv!.payload.externalInvocation as { exitCode: number }).exitCode).toBe(2);
    expect(candidateDirsUnder(runId)).toEqual([]);
  });

  it('作者与审核方同厂商 → task.create 直接拒绝（异构是不变式，作者侧同样成立）', async () => {
    installFakeCodex('true');
    const hostPath = makeFixtureRepo();
    // 审核方选 OpenAI API profile（与 Codex 同为 OPENAI）
    process.env.OPENAI_API_KEY = 'sk-openai';
    await expect(
      harness.createRun({ hostPath, authorConnectorId: 'codex-cli', reviewerModelProfileId: 'profile_openai' }),
    ).rejects.toThrow(/同为 OPENAI|异构/);
  });

  it('连接器不可用时 task.create 拒绝，而不是悄悄换成内部模型去写', async () => {
    process.env.REPOPILOT_CODEX_CLI_PATH = '/nonexistent/codex';
    const hostPath = makeFixtureRepo();
    await expect(harness.createRun({ hostPath, authorConnectorId: 'codex-cli' })).rejects.toThrow(/外部作者.*不可用|没有可执行文件/);
  });
});
