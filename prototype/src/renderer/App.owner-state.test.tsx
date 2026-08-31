// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApprovalRequest,
  ModelConnectionProfile,
  PlanRevision,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEvent,
  RunView,
} from '@shared/domain';
import type {
  ImportOutcome,
  IpcResult,
  PushEvent,
  RepoPilotBridge,
  RequestMethod,
} from '@shared/protocol';
// 用真实常量而不是抄一份字面量：抄的那份每次协议升级都会悄悄过期。
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

const NOW = '2026-08-13T00:00:00.000Z';

function project(id: string, name: string): ProjectRef {
  return { projectId: id, name, displayPath: `/${id}`, createdAt: NOW };
}

function imported(projectId: string, fileCount: number): ImportOutcome {
  const snapshot: RepositorySnapshot = {
    snapshotId: `snapshot-${projectId}`,
    projectId,
    baseSha: projectId.repeat(40).slice(0, 40),
    branch: 'main',
    baseKind: 'CLEAN_COMMIT',
    dirtyFileCount: 0,
    untrackedCount: 0,
    subPath: '',
    fileCount,
    totalBytes: fileCount * 1024,
    treeDigest: `sha256:${projectId.repeat(64).slice(0, 64)}`,
    excludedPaths: [],
    createdAt: NOW,
  };
  const profile: RepositoryHarnessProfile = {
    profileId: `profile-${projectId}`,
    snapshotId: snapshot.snapshotId,
    adapterId: 'vite-react-ts',
    adapterVersion: 'test',
    supportStatus: 'VERIFIED',
    detectedSignals: ['vite'],
    packageManager: 'pnpm',
    commands: {},
    protectedPaths: [],
    supportedTaskClasses: [],
    notes: [],
  };
  return { outcome: 'IMPORTED', snapshot, profile, candidates: [] };
}

function run(runId: string, projectId: string, title: string): RunView {
  return {
    runId,
    taskId: `task-${runId}`,
    projectId,
    snapshotId: `snapshot-${projectId}`,
    title,
    attemptId: `attempt-${runId}`,
    attemptNo: 1,
    status: 'AWAITING_PLAN_APPROVAL',
    statusReason: null,
    ledger: {
      modelTurns: 1,
      toolCalls: 0,
      selfFixRounds: 0,
      elapsedMs: 10,
      inputTokens: 10,
      outputTokens: 10,
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
    updatedAt: NOW,
    terminalFacts: null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function plan(
  runId: string,
  summary: string,
  snapshotId = 'snapshot-project-runs',
): PlanRevision {
  return {
    planId: `plan-${runId}`,
    runId,
    revision: 1,
    parentPlanId: null,
    snapshotId,
    summary,
    steps: [
      {
        index: 1,
        intent: `执行 ${summary}`,
        targetPaths: [],
        toolNames: [],
        expectedEffect: summary,
      },
    ],
    risks: [],
    verificationCommandIds: [],
    digest: `sha256:${runId}`,
    generatedBy: { invocationId: `inv-${runId}`, purpose: 'PLANNING', resolutionId: 'route-test' },
    createdAt: NOW,
  };
}

function approval(runId: string): ApprovalRequest {
  return {
    approvalId: `approval-${runId}`,
    runId,
    attemptId: `attempt-${runId}`,
    kind: 'PLAN',
    risk: 'R1',
    title: `批准 ${runId}`,
    detail: runId,
    subjectDigest: `sha256:${runId}`,
    requestedAt: NOW,
    expiresAt: '2026-08-14T00:00:00.000Z',
  };
}

function event(runId: string, summary: string): RunEvent {
  return {
    seq: 1,
    runId,
    attemptId: `attempt-${runId}`,
    kind: 'NOTE',
    at: NOW,
    summary,
    payload: {},
  };
}

function enabledModel(): ModelConnectionProfile {
  return {
    profileId: 'profile-test',
    providerId: 'provider-test',
    label: 'Test Model',
    kind: 'CUSTOM',
    builtIn: false,
    wire: 'openai',
    origin: 'https://example.test/v1',
    officialOrigin: 'https://example.test/v1',
    baseUrlOverride: '',
    isRelay: false,
    modelId: 'test-model',
    availableModels: ['test-model'],
    credentialEnvVar: 'REPOPILOT_TEST_KEY',
    credentialEnvVars: ['REPOPILOT_TEST_KEY'],
    credentialSource: 'APP',
    fallbackSource: 'NONE',
    fallbackEnvVar: null,
    credentialHint: '…test',
    docUrl: 'https://example.test/docs',
    enabled: true,
    routeSwitchPolicy: 'MANUAL_ONLY',
    automaticFallback: 'DENY',
  };
}

type RequestHandler = (method: RequestMethod, payload: unknown) => Promise<IpcResult<unknown>>;

function installBridge(handler: RequestHandler): { push(event: PushEvent): void } {
  let subscriber: ((event: PushEvent) => void) | null = null;
  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(handler) as RepoPilotBridge['request'],
    subscribe(next) {
      subscriber = next;
      return () => {
        subscriber = null;
      };
    },
  };
  return {
    push(event) {
      if (!subscriber) throw new Error('Renderer 尚未订阅 bridge');
      subscriber(event);
    },
  };
}

function bootstrapResponse(
  method: RequestMethod,
  projects: ProjectRef[],
  runs: RunView[],
  profiles: ModelConnectionProfile[] = [],
  coreStatus: 'READY' | 'RESTARTING' | 'DOWN' = 'RESTARTING',
) {
  switch (method) {
    case 'core.getStatus':
      return ok({ status: coreStatus, detail: `handshake ${coreStatus}`, epoch: 1 });
    case 'doctor.run':
      return ok({ checks: [] });
    case 'project.list':
      return ok({ projects });
    case 'model.listProfiles':
      return ok({ profiles, secureStorage: true });
    case 'run.list':
      return ok({ runs });
    default:
      return null;
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App owner-bound async rendering', () => {
  it('订阅建立后的状态握手可恢复早于 React effect 发出的 READY', async () => {
    const currentProject = project('cold-start', 'Cold Start Project');
    installBridge(async (method) => {
      const response = bootstrapResponse(method, [currentProject], [], [], 'READY');
      if (response) return response;
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);

    const projectButton = await screen.findByRole('button', { name: /Cold Start Project/ });
    expect((projectButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Agent Core 就绪/)).toBeTruthy();
    expect(screen.queryByText(/操作暂不可用/)).toBeNull();
  });

  it('状态握手查询期间收到新 push 时以 push 为准', async () => {
    const handshake = deferred<
      IpcResult<{ status: 'READY' | 'RESTARTING' | 'DOWN'; detail: string }>
    >();
    let bootstrapReads = 0;
    const bridge = installBridge(async (method) => {
      if (method === 'core.getStatus') return handshake.promise;
      bootstrapReads += 1;
      const response = bootstrapResponse(method, [], []);
      if (response) return response;
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'DOWN', detail: 'crashed', epoch: 1 }));
    await act(async () => handshake.resolve(ok({ status: 'READY', detail: 'stale ready', epoch: 1 })));

    expect(screen.getAllByText(/Core 已退出/)).toHaveLength(2);
    expect(screen.getByText(/操作暂不可用/)).toBeTruthy();
    expect(bootstrapReads).toBe(0);
  });

  it('project A 迟到时仍保留 B 的 loading 身份，最终只渲染 B 快照', async () => {
    const projectA = project('a', 'Project A');
    const projectB = project('b', 'Project B');
    const importA = deferred<IpcResult<ImportOutcome>>();
    const importB = deferred<IpcResult<ImportOutcome>>();
    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [projectA, projectB], []);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') {
        return (payload as { projectId: string }).projectId === projectA.projectId
          ? importA.promise
          : importB.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: /Project A/ }));
    fireEvent.click(screen.getByRole('button', { name: /Project B/ }));

    await act(async () => importA.resolve(ok(imported(projectA.projectId, 11))));
    expect(screen.getByText('正在导入快照…')).toBeTruthy();
    expect(screen.queryByText('11 个文件')).toBeNull();

    await act(async () => importB.resolve(ok(imported(projectB.projectId, 22))));
    expect(await screen.findByText('22 个文件')).toBeTruthy();
    expect(screen.queryByText('11 个文件')).toBeNull();
  });

  it('同一 project 的成功重试会替换旧导入 error', async () => {
    const currentProject = project('import-retry', 'Import Retry Project');
    let attempts = 0;
    const bridge = installBridge(async (method) => {
      const bootstrap = bootstrapResponse(method, [currentProject], []);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') {
        attempts += 1;
        return attempts === 1
          ? {
              ok: false,
              error: {
                code: 'CORE_UNAVAILABLE',
                message: 'temporary import failure',
                detail: 'retry is safe',
              },
            }
          : ok(imported(currentProject.projectId, 6));
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: /Import Retry Project/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('temporary import failure');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('6 个文件')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(attempts).toBe(2);
  });

  it('project / snapshot owner 切换会重建 Composer，不继承旧任务草稿', async () => {
    const projectA = project('composer-a', 'Composer Project A');
    const projectB = project('composer-b', 'Composer Project B');
    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [projectA, projectB], [], [enabledModel()]);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') {
        const projectId = (payload as { projectId: string }).projectId;
        return ok(imported(projectId, projectId === projectA.projectId ? 3 : 4));
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: /Composer Project A/ }));
    const oldComposer = await screen.findByPlaceholderText(/描述要修的问题/);
    fireEvent.change(oldComposer, { target: { value: '只属于项目 A 的草稿' } });
    expect((oldComposer as HTMLTextAreaElement).value).toBe('只属于项目 A 的草稿');

    fireEvent.click(screen.getByRole('button', { name: /Composer Project B/ }));
    await screen.findByText('4 个文件');
    const newComposer = screen.getByPlaceholderText(/描述要修的问题/);
    expect((newComposer as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByDisplayValue('只属于项目 A 的草稿')).toBeNull();
  });

  it('Run A→B loading 立即移除 A 审批能力，迟到 A 不能覆盖 B', async () => {
    const ownerProject = project('project-runs', 'Run Project');
    const runA = run('run-a', ownerProject.projectId, 'Run A');
    const runB = run('run-b', ownerProject.projectId, 'Run B');
    const lateAEvents = deferred<IpcResult<{ events: RunEvent[] }>>();
    const pendingBEvents = deferred<IpcResult<{ events: RunEvent[] }>>();
    let runAEventReads = 0;
    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [ownerProject], [runA, runB]);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') return ok(imported(ownerProject.projectId, 2));

      const runId = (payload as { runId: string }).runId;
      if (method === 'run.events') {
        if (runId === runA.runId) {
          runAEventReads += 1;
          return runAEventReads === 1
            ? ok({ events: [event(runId, 'A initial event')] })
            : lateAEvents.promise;
        }
        return pendingBEvents.promise;
      }
      if (method === 'run.toolCalls') return ok({ toolCalls: [] });
      if (method === 'approval.pending') return ok({ approvals: [approval(runId)] });
      if (method === 'plan.get') {
        return ok({ plan: plan(runId, runId === runA.runId ? 'A secret plan' : 'B owned plan') });
      }
      if (method === 'patch.get') return ok({ patch: null, priorPatches: [] });
      if (method === 'verification.list') return ok({ verifications: [] });
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByTitle(/｜Run A$/));
    expect(await screen.findByText('A secret plan')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '批准并执行' }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(screen.getByTitle(/｜Run B$/));

    const loading = await screen.findByRole('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('A secret plan')).toBeNull();
    expect(screen.queryByRole('button', { name: '批准并执行' })).toBeNull();

    await act(async () => lateAEvents.resolve(ok({ events: [event(runA.runId, 'A late event')] })));
    expect(screen.getByText('正在读取该运行的时间线与审批事实…')).toBeTruthy();
    expect(screen.queryByText('A late event')).toBeNull();
    expect(screen.queryByRole('button', { name: '批准并执行' })).toBeNull();

    await act(async () =>
      pendingBEvents.resolve(ok({ events: [event(runB.runId, 'B current event')] })),
    );
    await waitFor(() => expect(screen.getByText('B owned plan')).toBeTruthy());
    expect(screen.queryByText('A secret plan')).toBeNull();
    expect(screen.queryByText('A late event')).toBeNull();
    expect(screen.getAllByRole('button', { name: '批准并执行' }).length).toBeGreaterThan(0);
  });

  it('Run 文件树使用 Run 自己携带的 snapshot，不与当前项目新导入 snapshot 拼接', async () => {
    const ownerProject = project('project-file-owner', 'File Owner Project');
    const runSnapshotId = 'snapshot-used-to-create-run';
    /*
     * 归属事实来自 RunView.snapshotId（Slice C），不再从 plan 推导。
     * 这里刻意让它不同于 `imported()` 产生的 `snapshot-project-file-owner`，
     * 否则"用的是 Run 的快照还是当前导入的快照"两种实现都会通过。
     */
    const currentRun: RunView = {
      ...run('run-file-owner', ownerProject.projectId, 'File Owner Run'),
      snapshotId: runSnapshotId,
    };
    const treePayloads: unknown[] = [];
    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [ownerProject], [currentRun]);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') return ok(imported(ownerProject.projectId, 9));

      const runId = (payload as { runId?: string }).runId ?? currentRun.runId;
      if (method === 'run.events') return ok({ events: [] });
      if (method === 'run.toolCalls') return ok({ toolCalls: [] });
      if (method === 'approval.pending') return ok({ approvals: [approval(runId)] });
      // plan 刻意报一个**不同**的 snapshotId：它不该再是文件树的依据。
      if (method === 'plan.get') {
        return ok({ plan: plan(runId, '历史快照计划', 'snapshot-from-plan-should-be-ignored') });
      }
      if (method === 'patch.get') return ok({ patch: null, priorPatches: [] });
      if (method === 'verification.list') return ok({ verifications: [] });
      if (method === 'crossreview.get') return ok({ crossReview: null });
      if (method === 'files.tree') {
        treePayloads.push(payload);
        return ok({ entries: [], source: 'WORKSPACE' as const, generation: 0 });
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByTitle(/｜File Owner Run$/));
    expect(await screen.findByText('历史快照计划')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /文件/ }));

    await waitFor(() => expect(treePayloads).toHaveLength(1));
    expect(treePayloads[0]).toEqual({
      snapshotId: runSnapshotId,
      runId: currentRun.runId,
    });
    expect(runSnapshotId).not.toBe(`snapshot-${ownerProject.projectId}`);
  });

  it('真实 Dock 与详情卡共享同一审批 pending 和单航班请求', async () => {
    const ownerProject = project('project-approval', 'Approval Project');
    const currentRun = run('run-approval', ownerProject.projectId, 'Approval Run');
    const decision = deferred<IpcResult<{ accepted: boolean; reason: string | null }>>();
    let decisionCalls = 0;
    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [ownerProject], [currentRun]);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') return ok(imported(ownerProject.projectId, 2));

      const runId = (payload as { runId?: string }).runId ?? currentRun.runId;
      if (method === 'run.events') return ok({ events: [] });
      if (method === 'run.toolCalls') return ok({ toolCalls: [] });
      if (method === 'approval.pending') return ok({ approvals: [approval(runId)] });
      if (method === 'plan.get') return ok({ plan: plan(runId, '共享审批计划') });
      if (method === 'patch.get') return ok({ patch: null, priorPatches: [] });
      if (method === 'verification.list') return ok({ verifications: [] });
      if (method === 'crossreview.get') return ok({ crossReview: null });
      if (method === 'approval.decide') {
        decisionCalls += 1;
        return decision.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByTitle(/｜Approval Run$/));
    expect(await screen.findByText('共享审批计划')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '批准并执行' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: '批准并执行' })[0]!);
    const sharedPending = screen.getAllByRole('button', { name: '批准中…' });
    expect(sharedPending).toHaveLength(2);
    expect(sharedPending.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(decisionCalls).toBe(1);

    await act(async () => decision.resolve(ok({ accepted: true, reason: null })));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '批准并执行' })).toHaveLength(2),
    );
    expect(decisionCalls).toBe(1);
  });
});

/**
 * jsdom 没有布局：`scrollHeight` / `clientHeight` 恒为 0，`scrollTop` 的 setter 是空操作。
 * 装上可控度量后，「有没有抢用户的滚动位置」才是可断言的事实而不是观感。
 */
function installScrollMetrics(
  element: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number },
) {
  const box = { ...initial, scrollTop: 0 };
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => box.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => box.clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value;
    },
  });
  return box;
}

function seqEvent(runId: string, seq: number, summary: string): RunEvent {
  return { ...event(runId, summary), seq };
}

describe('App 时间线跟随', () => {
  /**
   * 这里有两处刻意的选择，都是为了消掉一条真实抓到过的随机红。
   *
   * 失败签名有两个："↓ 2 条新事件"按钮从未出现，和 `expected 800 to be 1100`。
   * 查下来是同一个原因：**用例在一次仍在飞行的补拉中间做了同步断言**。
   *
   * 补拉从哪来：App 有个"状态推进到需要新数据时补拉一次"的 effect —— 
   * `AWAITING_PLAN_APPROVAL` 且 `plan` 为 null 就会回源（run.updated 只带 view、
   * 不带计划/补丁本体）。原来的 fixture 正好是这个状态、而 `plan.get` 回 null，
   * 于是每次挂载都会发**第二次** `run.events`（加计数实测：同一条用例里两次）。
   * 那次补拉把 runDetail 置为 loading，`selectedRunDetail` 暂时为 null，
   * itemCount 归 0；机器不忙时它在 act() 内就 settle 了，忙起来就没有 ——
   * 断言于是撞在空窗上。
   *
   * 两处修法：
   *   1. Run 状态改成 EXECUTING —— 它不满足任何 needsRefresh 条件，补拉不再发生。
   *      这条用例测的是**跟随**，补拉是无关的异步源，不该混进来。
   *   2. `run.events` 返回**累积的**事件而不是永远那一条。真实 Core 持有全部事件，
   *      重拉一定是超集；静态 mock 会让任何一次回源都变成"回退到更旧的事实"。
   *      现在没有补拉了这条用不上，但线束不该对 Core 撒谎 —— 下一个人加个
   *      需要回源的用例时，不该再踩一遍。
   *
   * 刻意**没有**做的：给断言加 waitFor 或重试。那样红会消失，但消失的理由是
   * "等久一点"，而不是"这里本来就不该有第二个异步源"。
   */
  async function mountRunWithTranscript() {
    const ownerProject = project('project-follow', 'Follow Project');
    const followRun: RunView = {
      ...run('run-follow', ownerProject.projectId, 'Follow Run'),
      // 见上：AWAITING_* / FAILED / BLOCKED / CANCELLED 都会触发补拉
      status: 'EXECUTING',
    };
    // Core 侧的事实：推送过的事件同样留在事件流里，重拉必然拿得到
    const durable: RunEvent[] = [seqEvent(followRun.runId, 1, '第一条事件')];

    const bridge = installBridge(async (method, payload) => {
      const bootstrap = bootstrapResponse(method, [ownerProject], [followRun]);
      if (bootstrap) return bootstrap;
      if (method === 'project.import') return ok(imported(ownerProject.projectId, 2));
      if (method === 'run.events') return ok({ events: [...durable] });
      if (method === 'run.toolCalls') return ok({ toolCalls: [] });
      if (method === 'approval.pending') return ok({ approvals: [] });
      if (method === 'plan.get') return ok({ plan: null });
      if (method === 'patch.get') return ok({ patch: null, priorPatches: [] });
      if (method === 'verification.list') return ok({ verifications: [] });
      if (method === 'crossreview.get') return ok({ crossReview: null });
      throw new Error(`Unexpected request: ${method}`);
    });

    render(<App />);
    act(() => bridge.push({ type: 'core.status', status: 'READY', detail: 'ready', epoch: 1 }));
    fireEvent.click(await screen.findByTitle(/｜Follow Run$/));
    await screen.findByText('第一条事件');

    const scroller = document.querySelector('.chat-scroll');
    if (!(scroller instanceof HTMLElement)) throw new Error('找不到滚动容器');
    const box = installScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 });

    /** 发一条新事件：先落进 Core 的事件流，再推给 Renderer —— 与真实顺序一致 */
    const emit = (seq: number, summary: string) => {
      const e = seqEvent(followRun.runId, seq, summary);
      durable.push(e);
      bridge.push({ type: 'run.event', runId: followRun.runId, event: e });
    };

    return { bridge, box, scroller, runId: followRun.runId, emit };
  }

  it('用户向上阅读时不被抢滚动，计数准确且可点击回到底部', async () => {
    const { box, scroller, emit } = await mountRunWithTranscript();

    box.scrollTop = 40; // 距底 760px，远超阈值
    fireEvent.scroll(scroller);

    act(() => {
      emit(2, '第二条事件');
      emit(3, '第三条事件');
    });

    /*
     * 显式放宽等待上限：按 role 查询要在 jsdom 里遍历整个可达树，满负载并行跑全量
     * 用例时一次查询就可能上百毫秒，默认 1000ms 会随机超时（第一次全量运行抓到过）。
     * 放宽的只是"愿意等多久"，不是被测行为 —— 提示仍然必须真的出现。
     */
    const nudge = await screen.findByRole('button', { name: '↓ 2 条新事件' }, { timeout: 5_000 });
    expect(box.scrollTop).toBe(40);
    // 提示本身要能被辅助技术播报，而不是只有视觉上冒出来一个气泡。
    expect(nudge.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');

    box.scrollHeight = 1200;
    fireEvent.click(nudge);
    expect(box.scrollTop).toBe(1200);
    await waitFor(() => expect(screen.queryByRole('button', { name: /条新事件/ })).toBeNull(), {
      timeout: 5_000,
    });
  });

  it('用户在底部时直接跟随，不显示未读提示', async () => {
    const { box, scroller, emit } = await mountRunWithTranscript();

    box.scrollTop = 800; // 1000 - 800 - 200 = 0
    fireEvent.scroll(scroller);

    box.scrollHeight = 1100;
    act(() => {
      emit(2, '第二条事件');
    });

    expect(box.scrollTop).toBe(1100);
    expect(screen.queryByRole('button', { name: /条新事件/ })).toBeNull();
  });
});
