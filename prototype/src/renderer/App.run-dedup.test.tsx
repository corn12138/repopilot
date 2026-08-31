// @vitest-environment jsdom

/**
 * 侧栏不允许同一个 runId 出现两行。
 *
 * 这条回归钉的是一个真实缺陷：Core 的 `task.create` 响应**不是**这个 Run 的第一手
 * 消息。createTask 在 `return` 之前先 `void execute()`，execute → runAgent 在自己的
 * 第一个 await 之前就 `setStatus('EXECUTING')`，而 setStatus 尾部会 push 一条
 * `run.updated`；push 与 response 走同一个 port，所以 **push 必然先到 Renderer**。
 * Authority 级 e2e 实测：响应里的 status 是 CREATED，同一次 task.create 期间已经
 * push 出去的 run.updated 是 EXECUTING —— 两个不同的对象，同一个 runId。
 *
 * 于是 Renderer 有两条互不知情的入列路径：
 *   1. run.updated 的「找不到就前插」兜底（别的窗口建的 Run 靠它进列表，不能删）；
 *   2. onCreated 的前插。
 * 两条都跑一遍就是两行。而后续 run.updated 用 findIndex 只命中下标 0 那条，
 * 另一条永远冻在 EXECUTING —— 非终态，于是被排进"进行中"区压在真行上面，
 * 时间还停在更早的一刻，并把状态栏的"运行中 N"垫高一格。
 *
 * 所以这里的替身刻意复刻真实时序：task.create 在 resolve 之前先推 run.updated。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
} from '@shared/domain';
import type { ImportOutcome, IpcResult, PushEvent, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

const NOW = '2026-08-31T00:00:00.000Z';
const LATER = '2026-08-31T00:05:00.000Z';
const RUN_ID = 'run-dup-1';

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

const project: ProjectRef = {
  projectId: 'p1',
  name: 'Dedup Project',
  displayPath: '/p1',
  createdAt: NOW,
};

const snapshot: RepositorySnapshot = {
  snapshotId: 'snapshot-p1',
  projectId: 'p1',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  branch: 'main',
  baseKind: 'CLEAN_COMMIT',
  dirtyFileCount: 0,
  untrackedCount: 0,
  subPath: '',
  fileCount: 3,
  totalBytes: 1024,
  treeDigest: 'sha256:tree',
  excludedPaths: [],
  createdAt: NOW,
};

const harnessProfile: RepositoryHarnessProfile = {
  profileId: 'profile-p1',
  snapshotId: snapshot.snapshotId,
  adapterId: 'vite-react-ts',
  adapterVersion: 'test',
  supportStatus: 'VERIFIED',
  detectedSignals: ['vite.config.ts'],
  packageManager: 'pnpm',
  commands: {},
  protectedPaths: [],
  supportedTaskClasses: [],
  notes: [],
};

const modelProfile: ModelConnectionProfile = {
  profileId: 'model-1',
  providerId: 'deepseek',
  label: 'DeepSeek',
  kind: 'OFFICIAL',
  builtIn: true,
  wire: 'openai',
  origin: 'https://api.deepseek.com',
  officialOrigin: 'https://api.deepseek.com',
  baseUrlOverride: '',
  isRelay: false,
  modelId: 'deepseek-chat',
  availableModels: ['deepseek-chat'],
  credentialEnvVar: 'DEEPSEEK_API_KEY',
  credentialEnvVars: ['DEEPSEEK_API_KEY'],
  credentialSource: 'APP',
  fallbackSource: 'NONE',
  fallbackEnvVar: null,
  credentialHint: '…abcd',
  docUrl: 'https://example.invalid',
  enabled: true,
  routeSwitchPolicy: 'MANUAL_ONLY',
  automaticFallback: 'DENY',
};

const importOutcome: ImportOutcome = {
  outcome: 'IMPORTED',
  snapshot,
  profile: harnessProfile,
  candidates: [],
};

const disclosure = {
  disclosureVersion: 2,
  snapshotId: snapshot.snapshotId,
  snapshotFileCount: 3,
  destinations: [
    {
      role: 'IMPLEMENTER',
      channel: 'MODEL_API',
      label: 'DeepSeek · deepseek-chat',
      providerId: 'deepseek',
      origin: 'https://api.deepseek.com',
      isRelay: false,
      modelId: 'deepseek-chat',
      resolutionDigest: 'sha256:r1',
      dataClasses: ['TASK_TEXT', 'REPOSITORY_SNAPSHOT_EXCERPTS'],
    },
  ],
  crossReviewParity: null,
  policy: { retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' },
  digest: 'sha256:disclosure-1',
};

/** 同一个 runId 的两份 view：响应携带创建那一刻的，push 携带更新过的 */
function runView(status: RunView['status'], updatedAt: string): RunView {
  return {
    runId: RUN_ID,
    taskId: 'task-1',
    projectId: 'p1',
    snapshotId: snapshot.snapshotId,
    title: '先熟悉一下项目',
    attemptId: 'attempt-1',
    attemptNo: 1,
    status,
    statusReason: null,
    ledger: {
      modelTurns: 0,
      toolCalls: 0,
      selfFixRounds: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsageTurns: 0,
    },
    limits: {
      maxModelTurns: 8,
      maxToolCalls: 20,
      maxSelfFixRounds: 2,
      maxWallClockMs: 60_000,
      maxTotalTokens: 10_000,
    },
    workspaceGeneration: 0,
    createdAt: NOW,
    updatedAt,
    terminalFacts: null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function installBridge(): { push: (event: PushEvent) => void } {
  let listener: ((event: PushEvent) => void) | null = null;
  const push = (event: PushEvent) => {
    if (listener) listener(event);
  };

  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(async (method: RequestMethod) => {
      switch (method) {
        case 'core.getStatus':
          return ok({ status: 'READY', detail: 'ready', epoch: 1 });
        case 'doctor.run':
          return ok({ checks: [] });
        case 'project.list':
          return ok({ projects: [project] });
        case 'model.listProfiles':
          return ok({
            profiles: [modelProfile],
            secureStorage: true,
            credentialStore: 'OK',
            credentialStoreDetail: null,
          });
        case 'run.list':
          return ok({ runs: [] });
        case 'project.import':
          return ok(importOutcome);
        case 'crossreview.reviewers':
          return ok({ reviewers: [] });
        case 'egress.disclosure':
          return ok({ disclosure });
        case 'task.create':
          /*
           * 真实时序：Core 在响应出去之前已经把 run.updated 推出来了。
           * 这一行就是整个缺陷的成因，不能为了让测试好写而挪到 resolve 之后。
           */
          push({ type: 'run.updated', run: runView('EXECUTING', LATER) });
          return ok({ run: runView('CREATED', NOW) });
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }) as RepoPilotBridge['request'],
    subscribe: (fn: (event: PushEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  } satisfies Partial<RepoPilotBridge> as RepoPilotBridge;

  return { push };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/*
 * 整个 App 的 bootstrap 是异步的（doctor / project.list / model.listProfiles /
 * run.list 四个并发请求），而 findBy* 默认只等 1000ms。单文件跑得过，全量跑机器
 * 一忙就超时 —— 那是环境慢，不是断言错。等待窗口显式放宽，别让这条回归变成
 * 看心情红的噪声。
 */
const WAIT = { timeout: 10_000 };

describe('侧栏：同一个 runId 只占一行', () => {
  it('task.create 先推 run.updated 再返回时，列表里仍然只有一行', async () => {
    installBridge();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Dedup Project/ }, WAIT));

    const goal = await screen.findByPlaceholderText(/描述要修的问题/, undefined, WAIT);
    fireEvent.change(goal, { target: { value: '先熟悉一下项目' } });

    const consent = (await screen.findByRole(
      'checkbox',
      { name: /我确认：本任务会把数据发往/ },
      WAIT,
    )) as HTMLInputElement;
    fireEvent.click(consent);
    await waitFor(
      () => expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(false),
      WAIT,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始' }));
    });

    const sidebar = document.querySelector('.sidebar');
    if (!(sidebar instanceof HTMLElement)) throw new Error('sidebar not rendered');
    await waitFor(
      () => expect(within(sidebar).getAllByRole('button', { name: /先熟悉一下项目/ }).length).toBeGreaterThan(0),
      WAIT,
    );

    // 一行，不是两行
    expect(within(sidebar).getAllByRole('button', { name: /先熟悉一下项目/ })).toHaveLength(1);

    /*
     * 而且留下的必须是**更新过的那份**：响应里的 CREATED 是创建那一刻的旧快照，
     * 拿它盖掉 push 来的 EXECUTING 等于让列表倒退一拍。
     */
    expect(
      within(sidebar).getByRole('button', { name: /先熟悉一下项目/ }).getAttribute('aria-label'),
    ).toContain('执行中');

    // 状态栏的"运行中 N"数的是非终态 Run —— 幽灵行会把它垫成 2
    expect(screen.getByText('运行中 1')).toBeTruthy();
  });
});
