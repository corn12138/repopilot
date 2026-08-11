import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 与 patch.test.ts 同一手法：把受管数据根重定向到进程私有临时目录，
 * 让快照/工作区/事件/状态的真实落盘行为都发生在可丢弃的地方。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-authority-e2e-'));
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

/**
 * Authority 级端到端：从 __project.register 一路走到终态。
 *
 * 与 agent.*.e2e 的差别：那些测试驱动的是 runAgent（gateway 是注入的替身），
 * 这里驱动的是**整个权威层** —— 真 ModelGateway、真协议适配器（fetch 被脚本化）、
 * 真 preflight、真 egress 记账、真命令执行（spawn node）、真事件/状态落盘。
 * 此前 README 里三条"接线靠 typecheck"的缺口（交叉审核、挽救封存、failureClass）
 * 由这里补上真证据。
 *
 * 模型脚本化在 HTTP 层：按 origin 分路（deepseek=实现方，moonshot=审核方），
 * 每个 origin 一个响应队列。脚本耗尽即抛错并带上最后的请求上下文 ——
 * 静默复读最后一条会把死循环伪装成通过。
 */

// ---------------------------------------------------------------------------
// OpenAI-wire 响应构造
// ---------------------------------------------------------------------------

let callSeq = 0;
const USAGE = { prompt_tokens: 120, completion_tokens: 45 };

type WireUsage = { prompt_tokens: number; completion_tokens: number } | undefined;

function oaToolCall(name: string, input: unknown, usage: WireUsage = USAGE): unknown {
  callSeq += 1;
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: `call_${name}_${callSeq}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** usage 传 null 表示 provider 不回报（显式 undefined 会触发默认参数，是个 JS 陷阱） */
function oaText(text: string, usage: WireUsage | null = USAGE): unknown {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** 从请求体（含全部对话）里取**最后**出现的 receiptId —— 每轮 fs_read 会发新的 */
function lastReceipt(bodyText: string): string {
  const matches = [...bodyText.matchAll(/receiptId=(rcpt_[a-z0-9]+)/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) throw new Error(`脚本期望上下文里有 receiptId，但没有：${bodyText.slice(-500)}`);
  return last;
}

type Responder = (bodyText: string) => unknown;

// ---------------------------------------------------------------------------
// 夹具与线束
// ---------------------------------------------------------------------------

const APP_FILE = 'src/app.js';

/** 一个自带真实失败验证命令的 git 仓库：node check.mjs 在 app.js 含 'fixed' 前退出 1 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-e2e-repo-'));
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
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  git('init');
  git('add', '.');
  git('commit', '-m', 'broken baseline');
  return dir;
}

class Harness {
  readonly pushes: PushEvent[] = [];
  readonly authority: RunAuthority;
  private readonly queues = new Map<string, Responder[]>();

  constructor() {
    this.authority = new RunAuthority((e) => this.pushes.push(e));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const host = new URL(String(url)).host;
        const queue = this.queues.get(host);
        const bodyText = String(init?.body ?? '');
        if (!queue || queue.length === 0) {
          throw new Error(`${host} 的模型脚本已耗尽。最后请求：${bodyText.slice(-600)}`);
        }
        const wire = queue.shift()!(bodyText);
        return new Response(JSON.stringify(wire), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  script(host: string, responders: Responder[]): void {
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
          `等待 ${statuses.join('/')} 超时，当前 ${view?.status}（${view?.statusReason}）。` +
            `最近事件：\n${events.slice(-8).map((e) => `${e.kind} ${e.summary}`).join('\n')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** register → import → task.create，返回 runId。所有用例的公共开场 */
  async createRun(input: {
    hostPath: string;
    reviewerModelProfileId?: string;
    /** 缺省 []：零配置路径 —— 用户什么都没设置时不允许有任何暗中收窄 */
    allowedPaths?: string[];
  }): Promise<{ runId: string }> {
    const reg = await this.call<{ project: { projectId: string } }>('__project.register', {
      hostPath: input.hostPath,
    });
    const projectId = reg.project.projectId;
    const imported = await this.call<{
      outcome: string;
      snapshot: { snapshotId: string };
      profile: { profileId: string; supportedTaskClasses: string[] };
    }>('project.import', { projectId });
    expect(imported.outcome).toBe('IMPORTED');

    const { run } = await this.call<{ run: RunView }>('task.create', {
      projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: 'profile_deepseek',
      goal: '修复 node check.mjs 失败：src/app.js 的 STATUS 仍是 broken',
      taskClass: imported.profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
      allowedPaths: input.allowedPaths ?? [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
      ...(input.reviewerModelProfileId
        ? { reviewerModelProfileId: input.reviewerModelProfileId }
        : {}),
    });
    return { runId: run.runId };
  }

  async approvePlan(runId: string): Promise<void> {
    await this.waitForStatus(runId, ['AWAITING_PLAN_APPROVAL']);
    const { approvals } = await this.call<{ approvals: ApprovalRequest[] }>('approval.pending', {
      runId,
    });
    expect(approvals.length).toBeGreaterThan(0);
    const r = await this.call<{ accepted: boolean; reason: string | null }>('approval.decide', {
      approvalId: approvals[0]!.approvalId,
      decision: 'APPROVE',
      subjectDigest: approvals[0]!.subjectDigest,
      note: '',
    });
    expect(r.accepted).toBe(true);
  }
}

// 实现方（deepseek）与审核方（moonshot）的 origin host
const IMPL = 'api.deepseek.com';
const REVIEWER = 'api.moonshot.cn';

const planCall = (): unknown =>
  oaToolCall('submit_plan', {
    summary: 'src/app.js 的 STATUS 是 broken，check.mjs 因此退出 1。把它改成 fixed。',
    steps: [
      {
        intent: '将 src/app.js 的 STATUS 改为 fixed',
        targetPaths: [APP_FILE],
        expectedEffect: 'node check.mjs 退出 0',
      },
    ],
    risks: [],
  });

const readApp = (): unknown => oaToolCall('fs_read', { path: APP_FILE });

const mutateApp = (newText: string): Responder =>
  (body) =>
    oaToolCall('workspace_mutate', {
      operations: [
        { kind: 'REPLACE_WHOLE_FILE', path: APP_FILE, receiptId: lastReceipt(body), newText },
      ],
    });

let harness: Harness;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-e2e-implementer';
  process.env.MOONSHOT_API_KEY = 'sk-e2e-reviewer';
  harness = new Harness();
});

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('authority e2e：从注册到终态的完整权威层链路', () => {
  it(
    '黄金路径：导入 → 审批 → 修复 → 真验证通过 → 接受 → SUCCEEDED；账本与用量未知轮如实',
    async () => {
      harness.script(IMPL, [
        () => planCall(),
        () => readApp(),
        mutateApp("export const STATUS = 'fixed';\n"),
        // 最后一轮 provider 不回报 usage —— 账本必须记未知轮，而不是补 0
        () => oaText('修复完成。', null),
      ]);

      const { runId } = await harness.createRun({ hostPath: makeFixtureRepo() });
      await harness.approvePlan(runId);

      const awaiting = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      expect(awaiting.failureClass ?? null).toBeNull();

      // 账本：3 轮已知用量（120/45），1 轮未知 —— 未知不折算成 0
      expect(awaiting.ledger.modelTurns).toBe(4);
      expect(awaiting.ledger.inputTokens).toBe(360);
      expect(awaiting.ledger.outputTokens).toBe(135);
      expect(awaiting.ledger.unknownUsageTurns).toBe(1);

      // 补丁绑定通过的真实验证（node check.mjs 真的跑过且退出 0）
      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.files.map((f) => f.path)).toEqual([APP_FILE]);
      expect(patch.unifiedDiff).toContain("+export const STATUS = 'fixed';");
      expect(patch.verificationRunId).not.toBeNull();
      expect(patch.comparison?.fixed).toContain('user1');

      const decided = await harness.call<{ run: RunView; reason: string | null }>('patch.decide', {
        runId,
        patchId: patch.patchId,
        decision: 'ACCEPT',
        patchDigest: patch.digest,
        note: '',
      });
      expect(decided.reason).toBeNull();
      expect(decided.run.status).toBe('SUCCEEDED');
      expect(decided.run.terminalFacts?.verificationRunId).toBe(patch.verificationRunId);
    },
    30_000,
  );

  it(
    '验证失败路径：自修复用尽 → FAILED + failureClass + 挽救补丁封存且不可接受',
    async () => {
      // 模型三次都写入不含 'fixed' 的内容：初次 + 2 轮自修复，验证永远失败
      const wrongFix = (label: string): Responder[] => [
        () => readApp(),
        mutateApp(`export const STATUS = 'still-broken-${label}';\n`),
        () => oaText(`尝试 ${label} 完成。`),
      ];
      harness.script(IMPL, [() => planCall(), ...wrongFix('a'), ...wrongFix('b'), ...wrongFix('c')]);

      const { runId } = await harness.createRun({ hostPath: makeFixtureRepo() });
      await harness.approvePlan(runId);

      const failed = await harness.waitForStatus(runId, ['FAILED']);
      // failureClass 是封闭归类，不是靠 grep statusReason
      expect(failed.failureClass).toBe('VERIFICATION_FAILED');

      // 挽救补丁：失败现场被封存、带显式标记、绑定失败的那次验证
      const { patch } = await harness.call<{ patch: PatchArtifact | null }>('patch.get', { runId });
      expect(patch).not.toBeNull();
      expect(patch!.unverifiedItems.some((u) => u.includes('挽救封存'))).toBe(true);
      expect(patch!.unifiedDiff).toContain('still-broken-c');
      expect(patch!.comparison?.stillFailing).toContain('user1');

      // 永远不能被接受 —— 状态门禁在终态前面
      const decided = await harness.call<{ run: RunView; reason: string | null }>('patch.decide', {
        runId,
        patchId: patch!.patchId,
        decision: 'ACCEPT',
        patchDigest: patch!.digest,
        note: '',
      });
      expect(decided.reason).toContain('不接受补丁决定');
      expect(harness.latestRun(runId)!.status).toBe('FAILED');

      // 挽救封存事件如实标注
      const { events } = await harness.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
      const sealed = events.filter((e) => e.kind === 'PATCH_SEALED');
      expect(sealed).toHaveLength(1);
      expect(sealed[0]!.summary).toContain('挽救');
    },
    30_000,
  );

  it(
    '交叉审核整改闭环：阻断发现 → 实现方整改 → 重验 → 重封存 → 第二轮通过',
    async () => {
      harness.script(IMPL, [
        () => planCall(),
        () => readApp(),
        mutateApp("export const STATUS = 'fixed';\n"),
        () => oaText('修复完成。'),
        // ---- 整改（由审核方的阻断发现触发，实现方 route 执行）----
        () => readApp(),
        mutateApp("export const STATUS = 'fixed'; // reviewed\n"),
        () => oaText('整改完成。'),
      ]);
      harness.script(REVIEWER, [
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

      const { runId } = await harness.createRun({
        hostPath: makeFixtureRepo(),
        reviewerModelProfileId: 'profile_moonshot-cn',
        allowedPaths: ['src/**'], // 显式收窄的变体在这条覆盖；另两条走零配置路径
      });
      await harness.approvePlan(runId);

      await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);

      const { crossReview } = await harness.call<{
        crossReview: {
          reviewerInvocations: number;
          remediations: number;
          stopReason: string;
          rounds: unknown[];
          heterogeneous: boolean;
        } | null;
      }>('crossreview.get', { runId });
      expect(crossReview).not.toBeNull();
      expect(crossReview!.stopReason).toBe('REVIEWER_PASSED');
      expect(crossReview!.reviewerInvocations).toBe(2);
      expect(crossReview!.remediations).toBe(1);
      expect(crossReview!.rounds).toHaveLength(2);
      expect(crossReview!.heterogeneous).toBe(true);

      // 整改后重新封存：两次 PATCH_SEALED，digest 不同，第二次标注 remediated
      const { events } = await harness.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
      const sealed = events.filter((e) => e.kind === 'PATCH_SEALED');
      expect(sealed).toHaveLength(2);
      expect(sealed[0]!.payload.digest).not.toBe(sealed[1]!.payload.digest);
      expect(sealed[1]!.payload.remediated).toBe(true);

      // 最终补丁是整改后的那份
      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.unifiedDiff).toContain('// reviewed');
      expect(patch.digest).toBe(sealed[1]!.payload.digest);
    },
    40_000,
  );
});
