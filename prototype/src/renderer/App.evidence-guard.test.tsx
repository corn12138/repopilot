// @vitest-environment jsdom

/**
 * 交互评审 v0.2 N1 的回归测试：证据页是全屏视图。
 *
 * 曾经的守卫只判 `!showSettings`，于是打开证据页时，上一个选中 Run 的
 * ChatHead / 审批停靠条 / Composer 仍然渲染在证据内容上下 ——
 * 在证据页里能发任务、能批准计划。这里钉住"让位"与"回来"两个方向。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import type { ImportOutcome, IpcResult, PushEvent, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

const NOW = '2026-08-26T00:00:00.000Z';

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function project(id: string, name: string): ProjectRef {
  return { projectId: id, name, displayPath: `/${id}`, createdAt: NOW };
}

function imported(projectId: string): ImportOutcome {
  const snapshot: RepositorySnapshot = {
    snapshotId: `snapshot-${projectId}`,
    projectId,
    baseSha: projectId.repeat(40).slice(0, 40),
    branch: 'main',
    baseKind: 'CLEAN_COMMIT',
    dirtyFileCount: 0,
    untrackedCount: 0,
    subPath: '',
    fileCount: 3,
    totalBytes: 3 * 1024,
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

function plan(runId: string, snapshotId: string): PlanRevision {
  return {
    planId: `plan-${runId}`,
    runId,
    revision: 1,
    parentPlanId: null,
    snapshotId,
    summary: '修一个类型错误',
    steps: [
      { index: 1, intent: '改 App.tsx', targetPaths: [], toolNames: [], expectedEffect: '类型对齐' },
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
    expiresAt: '2026-08-27T00:00:00.000Z',
  };
}

function event(runId: string): RunEvent {
  return {
    seq: 1,
    runId,
    attemptId: `attempt-${runId}`,
    kind: 'NOTE',
    at: NOW,
    summary: '开始规划',
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

function installBridge(handler: (method: RequestMethod, payload: unknown) => Promise<IpcResult<unknown>>): void {
  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(handler) as RepoPilotBridge['request'],
    subscribe: () => () => {},
  } satisfies Partial<RepoPilotBridge> as RepoPilotBridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('证据页作为全屏视图（N1 守卫）', () => {
  it('打开证据页时 ChatHead / 审批停靠条 / Composer 让位，回到 Run 时恢复', async () => {
    const p = project('p1', 'Guard Project');
    const r = run('run-guard', 'p1', '修复构建');
    installBridge(async (method) => {
      switch (method) {
        case 'core.getStatus':
          return ok({ status: 'READY', detail: 'ready', epoch: 1 });
        case 'doctor.run':
          return ok({ checks: [] });
        case 'project.list':
          return ok({ projects: [p] });
        case 'model.listProfiles':
          return ok({ profiles: [enabledModel()], secureStorage: true });
        case 'run.list':
          return ok({ runs: [r] });
        case 'project.import':
          return ok(imported('p1'));
        case 'run.events':
          return ok({ events: [event(r.runId)] });
        case 'run.toolCalls':
          return ok({ toolCalls: [] });
        case 'approval.pending':
          return ok({ approvals: [approval(r.runId)] });
        case 'plan.get':
          return ok({ plan: plan(r.runId, 'snapshot-p1') });
        case 'patch.get':
          return ok({ patch: null, priorPatches: [] });
        case 'verification.list':
          return ok({ verifications: [] });
        case 'evidence.summary':
          // 永不 resolve：测试只关心证据视图已接管主栏，不关心聚合结果
          return new Promise(() => {});
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    });

    render(<App />);

    // 选中 Run：停靠条、Composer、ChatHead 全部就位
    fireEvent.click(await screen.findByRole('button', { name: /修复构建/ }));
    await screen.findByText(/计划在等你审批/);
    expect(screen.getByPlaceholderText(/描述要修的问题/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /用量/ })).toBeTruthy();

    // 打开证据页：三者一律让位 —— 证据页里不允许发任务、批准计划
    fireEvent.click(screen.getByRole('button', { name: /证据/ }));
    await screen.findByText(/正在聚合证据/);
    expect(screen.queryByText(/计划在等你审批/)).toBeNull();
    expect(screen.queryByPlaceholderText(/描述要修的问题/)).toBeNull();
    expect(screen.queryByRole('button', { name: /用量/ })).toBeNull();

    // 从侧栏点回 Run：证据页关闭，三者恢复
    fireEvent.click(screen.getByRole('button', { name: /修复构建/ }));
    await screen.findByText(/计划在等你审批/);
    expect(screen.queryByText(/正在聚合证据/)).toBeNull();
    expect(screen.getByPlaceholderText(/描述要修的问题/)).toBeTruthy();
  });
});
