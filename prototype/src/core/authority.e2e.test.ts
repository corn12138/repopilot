import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import type { PushEvent, ResponsePayload } from '@shared/protocol';
import { RunAuthority } from './authority';
import { PATHS } from './paths';

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
const fixtureRepos = new Set<string>();

/** 一个自带真实失败验证命令的 git 仓库：node check.mjs 在 app.js 含 'fixed' 前退出 1 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-e2e-repo-'));
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
    /*
     * 关掉后台清理调度：整个文件共用一个受管数据根，而每个 Harness 都是一个新的
     * Authority。开着的话它们会各自在 +5s 对这个共享根跑 sweep，把别的用例正在用的
     * 工作区/快照当"孤儿"删掉 —— 表现成随机的"文件不存在"，其实是真删。
     */
    this.authority = new RunAuthority((e) => this.pushes.push(e), { backgroundRetention: false });
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
    /** 缺省 node check.mjs；进程退出用例需要一条挂着不退的命令 */
    customCommands?: { label: string; argv: string[] }[];
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

    // 出站同意：先取披露再带 digest 回去 —— 与真实 UI 同一条路
    const { disclosure } = await this.call<{ disclosure: { digest: string } }>('egress.disclosure', {
      snapshotId: imported.snapshot.snapshotId,
      modelProfileId: 'profile_deepseek',
      ...(input.reviewerModelProfileId ? { reviewerModelProfileId: input.reviewerModelProfileId } : {}),
    });
    const { run } = await this.call<{ run: RunView }>('task.create', {
      projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: 'profile_deepseek',
      egressConsentDigest: disclosure.digest,
      goal: '修复 node check.mjs 失败：src/app.js 的 STATUS 仍是 broken',
      taskClass: imported.profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
      allowedPaths: input.allowedPaths ?? [],
      acceptance: [],
      verificationCommandIds: ['user1'],
      customCommands: input.customCommands ?? [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
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
  for (const repo of fixtureRepos) rmSync(repo, { recursive: true, force: true });
  fixtureRepos.clear();
});

// ---------------------------------------------------------------------------

interface ImportedFixture {
  projectId: string;
  snapshotId: string;
  profileId: string;
}

async function registerAndImport(hostPath: string): Promise<ImportedFixture> {
  const { project } = await harness.call<{ project: { projectId: string } }>('__project.register', {
    hostPath,
  });
  const imported = await harness.call<{
    outcome: string;
    snapshot: { snapshotId: string };
    profile: { profileId: string };
  }>('project.import', { projectId: project.projectId });
  expect(imported.outcome).toBe('IMPORTED');
  return {
    projectId: project.projectId,
    snapshotId: imported.snapshot.snapshotId,
    profileId: imported.profile.profileId,
  };
}

async function authorityFootprint() {
  const { runs } = await harness.call<{ runs: RunView[] }>('run.list', {});
  return {
    runIds: runs.map((r) => r.runId).sort(),
    // 目录名相同并不代表零写入；事件 JSONL/state 内容也纳入逐字节指纹。
    runEvidence: directoryFileFootprint(PATHS.runs),
    workspaceDirs: readdirSync(PATHS.workspaces).sort(),
    pushCount: harness.pushes.length,
  };
}

function directoryFileFootprint(root: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (relativeDir: string) => {
    const absoluteDir = join(root, relativeDir);
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      const content = readFileSync(join(root, relativePath));
      files.push({
        path: relativePath,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };
  visit('');
  return files;
}

function hostFootprint(hostPath: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (relativeDir: string) => {
    const absoluteDir = join(hostPath, relativeDir);
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      // Git 的内部账本会被只读命令触碰；宿主不变式关注的是仓库工作树的逐字节内容。
      if (entry.name === '.git') continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      const content = readFileSync(join(hostPath, relativePath));
      files.push({
        path: relativePath,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };
  visit('');
  return {
    files,
    status: execFileSync('git', ['status', '--porcelain'], { cwd: hostPath, encoding: 'utf8' }),
  };
}

function mismatchedTaskPayload(input: {
  projectId: string;
  snapshotId: string;
  profileId: string;
  commandMarker: string;
}) {
  return {
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    profileId: input.profileId,
    modelProfileId: 'profile_deepseek',
    goal: '这条任务必须在实体归属不一致时被拒绝',
    taskClass: 'BUILD_FAILURE_FIX',
    allowedPaths: [],
    acceptance: [],
    verificationCommandIds: ['user1'],
    customCommands: [
      {
        label: '归属门禁失败时绝不能运行',
        argv: [
          'node',
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(input.commandMarker)}, 'command-ran')`,
        ],
      },
    ],
  };
}

/**
 * 两个仓库的 tracked 内容刻意完全兼容：这样测试证明的是 Core 的实体归属门禁，
 * 不是依赖后续命令失败或 git apply 冲突“碰巧救场”。
 */
describe('authority e2e：project → snapshot → profile 归属门禁', () => {
  it('B project + A snapshot/profile → 首个副作用前 CONFLICT，零 Run/事件/工作区/命令', async () => {
    const repoA = makeFixtureRepo();
    const repoB = makeFixtureRepo();
    expect(hostFootprint(repoA).files).toEqual(hostFootprint(repoB).files);

    const a = await registerAndImport(repoA);
    const b = await registerAndImport(repoB);
    const commandMarker = join(repoB, '.ownership-command-ran');
    const before = await authorityFootprint();
    const hostBefore = [hostFootprint(repoA), hostFootprint(repoB)];

    await expect(
      harness.call(
        'task.create',
        mismatchedTaskPayload({
          projectId: b.projectId,
          snapshotId: a.snapshotId,
          profileId: a.profileId,
          commandMarker,
        }),
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'CONFLICT',
        message: '快照与所选项目的归属不一致，已拒绝创建任务',
      },
    });

    expect(await authorityFootprint()).toEqual(before);
    expect(existsSync(commandMarker)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect([hostFootprint(repoA), hostFootprint(repoB)]).toEqual(hostBefore);
  });

  it('A project/snapshot + B profile → 首个副作用前 CONFLICT，零 Run/事件/工作区/命令', async () => {
    const repoA = makeFixtureRepo();
    const repoB = makeFixtureRepo();
    expect(hostFootprint(repoA).files).toEqual(hostFootprint(repoB).files);

    const a = await registerAndImport(repoA);
    const b = await registerAndImport(repoB);
    const commandMarker = join(repoA, '.ownership-command-ran');
    const before = await authorityFootprint();
    const hostBefore = [hostFootprint(repoA), hostFootprint(repoB)];

    await expect(
      harness.call(
        'task.create',
        mismatchedTaskPayload({
          projectId: a.projectId,
          snapshotId: a.snapshotId,
          profileId: b.profileId,
          commandMarker,
        }),
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'CONFLICT',
        message: 'Profile 与所选快照的归属不一致，已拒绝创建任务',
      },
    });

    expect(await authorityFootprint()).toEqual(before);
    expect(existsSync(commandMarker)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect([hostFootprint(repoA), hostFootprint(repoB)]).toEqual(hostBefore);
  });
});

// ---------------------------------------------------------------------------

async function createBrowsingRun(imported: ImportedFixture): Promise<RunView> {
  harness.script(IMPL, [() => planCall()]);
  const { disclosure } = await harness.call<{ disclosure: { digest: string } }>('egress.disclosure', {
    snapshotId: imported.snapshotId,
    modelProfileId: 'profile_deepseek',
  });
  const { run } = await harness.call<{ run: RunView }>('task.create', {
    ...imported,
    modelProfileId: 'profile_deepseek',
    egressConsentDigest: disclosure.digest,
    goal: '读取处于待审批状态的 gen-0 工作区',
    taskClass: 'BUILD_FAILURE_FIX',
    allowedPaths: [],
    acceptance: [],
    verificationCommandIds: ['user1'],
    customCommands: [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
  });
  return harness.waitForStatus(run.runId, ['AWAITING_PLAN_APPROVAL']);
}

/**
 * files.read 的 owner/generation 是读取前门禁，不是 Renderer 事后自证。
 * 这些用例故意使用存在且内容兼容的快照与路径，避免 NOT_FOUND 偶然掩盖串线。
 */
describe('authority e2e：文件读取 owner 与 generation 合同', () => {
  it('快照 null generation 与 Run 当前 generation 均返回可核对的 source/generation', async () => {
    const repo = makeFixtureRepo();
    const imported = await registerAndImport(repo);

    const snapshotRead = await harness.call<ResponsePayload<'files.read'>>('files.read', {
      snapshotId: imported.snapshotId,
      path: APP_FILE,
      expectedGeneration: null,
    });
    expect(snapshotRead).toMatchObject({
      path: APP_FILE,
      source: 'SNAPSHOT',
      generation: null,
      changed: false,
    });
    expect(snapshotRead.content).toContain("STATUS = 'broken'");

    const run = await createBrowsingRun(imported);
    const tree = await harness.call<ResponsePayload<'files.tree'>>('files.tree', {
      snapshotId: imported.snapshotId,
      runId: run.runId,
    });
    expect(tree).toMatchObject({ source: 'WORKSPACE', generation: 0 });

    const workspaceRead = await harness.call<ResponsePayload<'files.read'>>('files.read', {
      snapshotId: imported.snapshotId,
      runId: run.runId,
      path: APP_FILE,
      expectedGeneration: tree.generation,
    });
    expect(workspaceRead).toMatchObject({
      path: APP_FILE,
      source: 'WORKSPACE',
      generation: 0,
      changed: false,
    });
    expect(workspaceRead.content).toContain("STATUS = 'broken'");
  });

  it('显式 runId 不存在或 snapshot 不归属该 Run 时拒绝，绝不回退快照', async () => {
    const repoA = makeFixtureRepo();
    const repoB = makeFixtureRepo();
    const a = await registerAndImport(repoA);
    const b = await registerAndImport(repoB);
    const runA = await createBrowsingRun(a);

    await expect(
      harness.call('files.read', {
        snapshotId: a.snapshotId,
        runId: 'run_missing',
        path: APP_FILE,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND', message: 'Run 不存在: run_missing' },
    });

    await expect(
      harness.call('files.tree', {
        snapshotId: a.snapshotId,
        runId: 'run_missing',
      }),
    ).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND', message: 'Run 不存在: run_missing' },
    });

    await expect(
      harness.call('files.tree', {
        snapshotId: a.snapshotId,
        runId: '',
      }),
    ).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND', message: 'Run 不存在: ' },
    });

    await expect(
      harness.call('files.read', {
        snapshotId: a.snapshotId,
        runId: null,
        path: APP_FILE,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND', message: 'Run 不存在: null' },
    });

    await expect(
      harness.call('files.read', {
        snapshotId: b.snapshotId,
        runId: runA.runId,
        path: APP_FILE,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'CONFLICT',
        message: 'Run 与请求快照的归属不一致，已拒绝读取文件',
      },
    });
  });

  it('Run 内嵌 task/view/snapshot 归属链任一处损坏都 fail closed', async () => {
    const repo = makeFixtureRepo();
    const imported = await registerAndImport(repo);
    const run = await createBrowsingRun(imported);
    const records = Reflect.get(harness.authority, 'runs') as Map<
      string,
      {
        task: { snapshotId: string; projectId: string };
        snapshot: { snapshotId: string; projectId: string };
        view: { projectId: string };
      }
    >;
    const record = records.get(run.runId)!;
    const original = {
      taskSnapshotId: record.task.snapshotId,
      taskProjectId: record.task.projectId,
      viewProjectId: record.view.projectId,
    };

    const assertRejected = async () => {
      await expect(
        harness.call('files.tree', {
          snapshotId: imported.snapshotId,
          runId: run.runId,
        }),
      ).rejects.toMatchObject({
        payload: {
          code: 'CONFLICT',
          message: 'Run 与请求快照的归属不一致，已拒绝读取文件',
        },
      });
    };

    try {
      record.task.snapshotId = 'snapshot_corrupted';
      await assertRejected();
      record.task.snapshotId = original.taskSnapshotId;

      record.task.projectId = 'project_corrupted';
      await assertRejected();
      record.task.projectId = original.taskProjectId;

      record.view.projectId = 'project_corrupted';
      await assertRejected();
    } finally {
      record.task.snapshotId = original.taskSnapshotId;
      record.task.projectId = original.taskProjectId;
      record.view.projectId = original.viewProjectId;
    }
  });

  it('expectedGeneration 错代或不是 number|null 时在解析路径/读取文件前 fail closed', async () => {
    const repo = makeFixtureRepo();
    const imported = await registerAndImport(repo);
    const run = await createBrowsingRun(imported);

    await expect(
      harness.call('files.read', {
        snapshotId: imported.snapshotId,
        runId: run.runId,
        // 即使 path 也非法，generation 门禁必须先命中，证明没有进入文件解析/读取。
        path: '../../../../etc/passwd',
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'CONFLICT',
        message: '文件来源 generation 已变化，请刷新文件树后重试',
      },
    });

    await expect(
      harness.call('files.read', {
        snapshotId: imported.snapshotId,
        path: APP_FILE,
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'BAD_REQUEST',
        message: 'expectedGeneration 必须是非负安全整数或 null',
      },
    });

    await expect(
      harness.call('files.read', {
        snapshotId: imported.snapshotId,
        path: APP_FILE,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'CONFLICT',
        message: '文件来源 generation 已变化，请刷新文件树后重试',
      },
    });
  });
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

      const hostPath = makeFixtureRepo();
      const wallStart = Date.now();
      const { runId } = await harness.createRun({ hostPath });
      /*
       * 刻意让"人"审批慢一点。审批等待不是计算时间：TIMED_OUT 判定与账本 elapsedMs
       * 必须同一口径地把它排除在外 —— 此前两套口径不一致，用户审得久一点，批准后
       * 第一轮 budgetExceeded 就命中，终态还被归因成 NO_CHANGES。
       */
      const APPROVAL_DELAY_MS = 1_500;
      await harness.waitForStatus(runId, ['AWAITING_PLAN_APPROVAL']);
      await new Promise((r) => setTimeout(r, APPROVAL_DELAY_MS));
      await harness.approvePlan(runId);

      const awaiting = await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      expect(awaiting.failureClass ?? null).toBeNull();

      // 账本：3 轮已知用量（120/45），1 轮未知 —— 未知不折算成 0
      expect(awaiting.ledger.modelTurns).toBe(4);
      expect(awaiting.ledger.inputTokens).toBe(360);
      expect(awaiting.ledger.outputTokens).toBe(135);
      expect(awaiting.ledger.unknownUsageTurns).toBe(1);
      // 账本的 elapsedMs 不含审批等待：它必须比"从建任务到现在"的墙钟至少少掉那段延迟
      const wallSoFar = Date.now() - wallStart;
      expect(awaiting.ledger.elapsedMs).toBeGreaterThan(0);
      expect(awaiting.ledger.elapsedMs).toBeLessThan(wallSoFar - APPROVAL_DELAY_MS + 200);

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

      // 正向对照：真正通过验证的补丁，导出文件头才允许说 yes，且点名那次验证
      const exported = await harness.call<{ filename: string; content: string; digest: string }>(
        '__patch.content',
        { runId, patchId: patch.patchId },
      );
      const verifiedLine = exported.content.split('\n').find((l) => l.startsWith('# verified:'));
      expect(verifiedLine).toBe(`# verified:    yes (${patch.verificationRunId})`);

      /*
       * 用新 Authority 从磁盘恢复后再写回：证明正常持久化记录里的 patch generation 与
       * view.workspaceGeneration 一致，并继续通过既有 acceptance、digest 与 git apply 门禁。
       */
      const restoredHarness = new Harness();
      const restored = await restoredHarness.call<{ run: RunView | null }>('run.get', { runId });
      expect(restored.run).toMatchObject({ status: 'SUCCEEDED', restored: true, evidence: 'INTACT' });
      const applied = await restoredHarness.call<{ ok: boolean; reason?: string }>(
        '__patch.applyToRepo',
        {
          runId,
          patchId: patch.patchId,
          patchDigest: patch.digest,
        },
      );
      expect(applied).toMatchObject({ ok: true });
      expect(readFileSync(join(hostPath, APP_FILE), 'utf8')).toContain("STATUS = 'fixed'");

      // 终态续期必须被拒 —— 拒绝是决定不是异常
      const cont = await harness.call<{ accepted: boolean; reason: string | null }>(
        'crossreview.continue',
        { runId },
      );
      expect(cont.accepted).toBe(false);
      expect(cont.reason).toContain('SUCCEEDED');
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

      /*
       * 导出文件头是唯一会离开应用的证据载体。挽救补丁绑定的是**失败的**那次验证，
       * 文件头必须说 NO/FAILED，绝不能因为 verificationRunId 非空就打出 `verified: yes`。
       */
      expect(patch!.verificationRunId).not.toBeNull();
      const exported = await harness.call<{ filename: string; content: string; digest: string }>(
        '__patch.content',
        { runId, patchId: patch!.patchId },
      );
      const verifiedLine = exported.content.split('\n').find((l) => l.startsWith('# verified:'));
      expect(verifiedLine).toBeDefined();
      expect(verifiedLine).not.toMatch(/verified:\s+yes/);
      expect(verifiedLine).toContain('FAILED');
      expect(verifiedLine).toContain(patch!.verificationRunId!);
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

      // REVIEWER_PASSED 之后没有可续期的东西
      const cont = await harness.call<{ accepted: boolean; reason: string | null }>(
        'crossreview.continue',
        { runId },
      );
      expect(cont.accepted).toBe(false);
      expect(cont.reason).toContain('REVIEWER_PASSED');
    },
    40_000,
  );

  it(
    '用户闸门：COUNTER_EXHAUSTED 后由用户授权续循环，续期那轮收敛通过',
    async () => {
      harness.script(IMPL, [
        () => planCall(),
        () => readApp(),
        mutateApp("export const STATUS = 'fixed';\n"),
        () => oaText('修复完成。'),
        // ---- 循环 1 的整改 ----
        () => readApp(),
        mutateApp("export const STATUS = 'fixed'; // v2\n"),
        () => oaText('整改完成。'),
        // ---- 用户续期后循环 2 的整改 ----
        () => readApp(),
        mutateApp("export const STATUS = 'fixed'; // v3 documented\n"),
        () => oaText('续期整改完成。'),
      ]);
      const blockingFinding = (line: number, evidence: string) => ({
        severity: 'HIGH',
        confidence: 0.9,
        file: APP_FILE,
        startLine: line,
        endLine: line,
        evidence,
        blocking: true,
      });
      harness.script(REVIEWER, [
        // 循环 1：两轮都有阻断，但阻断数 2→1 且指纹不同 = 有进展 → COUNTER_EXHAUSTED
        () =>
          oaToolCall('submit_review', {
            verdict: 'CHANGES_REQUESTED',
            findings: [blockingFinding(1, '缺少意图注释'), blockingFinding(1, '缺少变更说明')],
          }),
        () =>
          oaToolCall('submit_review', {
            verdict: 'CHANGES_REQUESTED',
            findings: [blockingFinding(2, 'v2 注释仍未说明为什么')],
          }),
        // 循环 2（用户续期）：一条阻断 → 整改 → 通过
        () =>
          oaToolCall('submit_review', {
            verdict: 'CHANGES_REQUESTED',
            findings: [blockingFinding(3, '还差文档化说明')],
          }),
        () => oaToolCall('submit_review', { verdict: 'PASS', findings: [] }),
      ]);

      const { runId } = await harness.createRun({
        hostPath: makeFixtureRepo(),
        reviewerModelProfileId: 'profile_moonshot-cn',
      });
      await harness.approvePlan(runId);
      await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);

      const first = await harness.call<{ crossReview: { stopReason: string } | null }>(
        'crossreview.get',
        { runId },
      );
      expect(first.crossReview?.stopReason).toBe('COUNTER_EXHAUSTED');

      // ---- 用户闸门：显式授权再来一轮 ----
      const cont = await harness.call<{ run: RunView; accepted: boolean; reason: string | null }>(
        'crossreview.continue',
        { runId },
      );
      expect(cont.accepted).toBe(true);
      expect(cont.run.status).toBe('CROSS_REVIEWING'); // 响应返回时已在审

      await harness.waitForStatus(runId, ['AWAITING_PATCH_REVIEW']);
      const { crossReview } = await harness.call<{
        crossReview: {
          stopReason: string;
          reviewerInvocations: number;
          remediations: number;
          userContinuations?: number;
          rounds: Array<{ round: number }>;
        } | null;
      }>('crossreview.get', { runId });

      // 累计只增不清：2 循环 = 4 轮审核 + 2 次整改 + 1 次用户续期，轮次连续编号
      expect(crossReview?.stopReason).toBe('REVIEWER_PASSED');
      expect(crossReview?.reviewerInvocations).toBe(4);
      expect(crossReview?.remediations).toBe(2);
      expect(crossReview?.userContinuations).toBe(1);
      expect(crossReview?.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4]);

      // 授权事件落账；终态补丁是续期整改后的那份
      const { events } = await harness.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
      expect(events.some((e) => e.payload?.kind === 'CROSS_REVIEW_CONTINUATION')).toBe(true);
      const { patch } = await harness.call<{ patch: PatchArtifact }>('patch.get', { runId });
      expect(patch.unifiedDiff).toContain('v3 documented');
    },
    40_000,
  );
});

/**
 * 进程退出路径。
 *
 * 验证命令以 detached 进程组启动，父进程死了它不会跟着死。之前 Core 对 SIGTERM 没有
 * 任何处理（Node 默认直接退出），vite/tsc 会变成以用户身份继续写工作区的孤儿；而重启后
 * closeInterruptedRun 却无条件写"子进程与模型流已随进程退出释放"—— 一条伪造的清理事实。
 * 这组用例用一条真的挂着不退的命令来证明两件事：shutdown 真的把它杀了；重启后的说明
 * 只说自己知道的。
 */
describe('进程退出：shutdown 真的发信号，重启后的清理说明只说自己知道的', () => {
  let harness: Harness;
  const fixtureRepos = new Set<string>();

  function makeHangingRepo(pidFile: string): string {
    const dir = makeFixtureRepo();
    fixtureRepos.add(dir);
    // 把自己的 pid 写进 pidFile，然后挂着不退（直到被信号杀掉）
    writeFileSync(
      join(dir, 'hang.mjs'),
      "import { writeFileSync } from 'node:fs';\n" +
        'writeFileSync(process.argv[2], String(process.pid));\n' +
        'setInterval(() => {}, 1000);\n',
    );
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'commit', '-m', 'hang'], {
      cwd: dir,
      stdio: 'ignore',
    });
    return dir;
  }

  async function waitForPid(pidFile: string, timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('挂起命令没有在预期时间内启动');
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitDead(pid: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive(pid)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`pid ${pid} 在 ${timeoutMs}ms 内没有退出`);
  }

  beforeEach(() => {
    harness = new Harness();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const dir of fixtureRepos) rmSync(dir, { recursive: true, force: true });
    fixtureRepos.clear();
  });

  it('shutdown() 同步向运行中的命令进程组发 SIGTERM：挂起的验证命令真的死了，并留下持久化事件', async () => {
    const pidFile = join(tmpdir(), `repopilot-hang-${process.pid}-${Date.now()}.pid`);
    const hostPath = makeHangingRepo(pidFile);
    const { runId } = await harness.createRun({
      hostPath,
      customCommands: [{ label: 'hang', argv: ['node', 'hang.mjs', pidFile] }],
    });

    const pid = await waitForPid(pidFile);
    expect(alive(pid)).toBe(true);

    const { signalledRuns } = harness.authority.shutdown('SIGTERM');
    expect(signalledRuns).toBe(1);

    await waitDead(pid); // 这是整组用例的核心断言：不是"发过信号"，是"进程没了"

    // 持久化的退出信号事件 —— 重启后的清理说明靠它区分"发过 SIGTERM"与"一无所知"
    const { events } = await harness.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
    const signalled = events.filter((e) => e.kind === 'NOTE' && e.payload.kind === 'PROCESS_EXIT_SIGNAL');
    expect(signalled).toHaveLength(1);
    expect(signalled[0]!.summary).toContain('SIGTERM');
    expect(signalled[0]!.summary).toContain('不等待终止确认');

    // 同一进程内 abort 的异步续段会把 Run 落成 CANCELLED（真实退出路径里进程已经没了，不会走到这）
    await harness.waitForStatus(runId, ['CANCELLED']);
    // 第二次 shutdown 什么都不做：已 abort 的 Run 不重复发
    expect(harness.authority.shutdown('SIGTERM').signalledRuns).toBe(0);
    rmSync(pidFile, { force: true });
  }, 30_000);

  it('正常退出路径 → 重启：说明写"已发 SIGTERM，未确认终止"，不写"已释放"', async () => {
    const pidFile = join(tmpdir(), `repopilot-hang-${process.pid}-${Date.now()}-b.pid`);
    const hostPath = makeHangingRepo(pidFile);
    const { runId } = await harness.createRun({
      hostPath,
      customCommands: [{ label: 'hang', argv: ['node', 'hang.mjs', pidFile] }],
    });
    const pid = await waitForPid(pidFile);

    /*
     * shutdown() 之后**不让出事件循环**就构造新 Authority：模拟真实时序 ——
     * 真进程在 shutdown 后立即 exit，abort 的异步续段（落 CANCELLED）永远跑不到，
     * 磁盘上的状态仍是非终态。这样新 Authority 才会走 closeInterruptedRun。
     */
    harness.authority.shutdown('SIGTERM');
    const restarted = new Harness();

    const { run } = await restarted.call<{ run: RunView | null }>('run.get', { runId });
    expect(run).toMatchObject({ status: 'INTERRUPTED', restored: true });

    const { events } = await restarted.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
    const summaries = events.filter((e) => e.kind === 'CLEANUP_SUMMARY');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const summary = summaries[summaries.length - 1]!;
    expect(summary.payload).toMatchObject({
      reason: 'PROCESS_EXIT',
      modelStream: 'RELEASED',
      childProcesses: 'SIGTERM_SENT_UNCONFIRMED',
    });
    expect(summary.summary).toContain('已向命令进程组发送 SIGTERM');
    expect(summary.summary).toContain('未确认终止');
    expect(summary.summary).not.toContain('子进程与模型流已随进程退出释放');

    await waitDead(pid);
    await harness.waitForStatus(runId, ['CANCELLED']);
    rmSync(pidFile, { force: true });
  }, 30_000);

  it('崩溃/强杀路径（没有 shutdown）→ 重启：说明写"子进程状态未知"，绝不宣称已释放', async () => {
    const pidFile = join(tmpdir(), `repopilot-hang-${process.pid}-${Date.now()}-c.pid`);
    const hostPath = makeHangingRepo(pidFile);
    const { runId } = await harness.createRun({
      hostPath,
      customCommands: [{ label: 'hang', argv: ['node', 'hang.mjs', pidFile] }],
    });
    const pid = await waitForPid(pidFile);
    expect(alive(pid)).toBe(true);

    // 没有任何退出处理，直接"重启"
    const restarted = new Harness();
    const { run } = await restarted.call<{ run: RunView | null }>('run.get', { runId });
    expect(run).toMatchObject({ status: 'INTERRUPTED', restored: true });

    const { events } = await restarted.call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
    const summary = events.filter((e) => e.kind === 'CLEANUP_SUMMARY').at(-1)!;
    expect(summary.payload).toMatchObject({ reason: 'PROCESS_EXIT', modelStream: 'RELEASED', childProcesses: 'UNKNOWN' });
    expect(summary.summary).toContain('状态未知');
    expect(summary.summary).toContain('可能仍在执行');
    expect(summary.summary).not.toContain('子进程与模型流已随进程退出释放');

    // 孤儿此刻确实还活着 —— 这正是说明必须写"未知"的原因
    expect(alive(pid)).toBe(true);

    // 收尾：由原 Authority 取消，把挂起进程真正杀掉，不给测试留孤儿
    await harness.call('run.cancel', { runId, reason: '测试收尾' });
    await waitDead(pid);
    rmSync(pidFile, { force: true });
  }, 30_000);
});
