// @vitest-environment jsdom

/**
 * 模型正文的实时缓冲：它的生命周期，不是它的样子。
 *
 * 这个缓冲是**易失**的 —— 它不来自事件流，也永远不会被写下来。持久事实是那条
 * `ASSISTANT_MESSAGE` 事件。所以它只有三条规矩，而三条都很容易在改动中被破坏：
 *
 *   1. `delta` 追加；
 *   2. `reset` 清空 —— 那一次尝试作废了（同 route 重试或最终失败），
 *      半截文本不许留在界面上冒充模型说过的话；
 *   3. `MODEL_INVOCATION` 落地就清空 —— 这一轮结束了，持久记录正在接手。
 *      不清的话，同一段话会先以缓冲、再以事件出现**两遍**。
 *
 * 第 3 条是最容易漏的：它不在 stream 分支里，而在 run.event 分支里。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef, RunEvent, RunView } from '@shared/domain';
import type { IpcResult, PushEvent, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

const NOW = '2026-08-31T00:00:00.000Z';
const RUN_ID = 'run-live-1';
const WAIT = { timeout: 10_000 };

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

const project: ProjectRef = {
  projectId: 'p1',
  name: 'Live Project',
  displayPath: '/p1',
  createdAt: NOW,
};

const run: RunView = {
  runId: RUN_ID,
  taskId: 'task-1',
  projectId: 'p1',
  snapshotId: 'snapshot-p1',
  title: '修一下构建',
  attemptId: 'attempt-1',
  attemptNo: 1,
  status: 'EXECUTING',
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

function runEvent(seq: number, kind: RunEvent['kind'], summary: string, payload = {}): RunEvent {
  return { seq, runId: RUN_ID, attemptId: 'attempt-1', kind, at: NOW, summary, payload };
}

function installBridge(): { push: (event: PushEvent) => void } {
  let listener: ((event: PushEvent) => void) | null = null;
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
          return ok({ profiles: [], secureStorage: true, credentialStore: 'OK', credentialStoreDetail: null });
        case 'run.list':
          return ok({ runs: [run] });
        case 'run.events':
          // 注意：Transcript 会剥掉「任务已创建：」前缀，所以正文是后半段
          return ok({ events: [runEvent(1, 'RUN_CREATED', '任务已创建：把 STATUS 改成 fixed')] });
        case 'run.toolCalls':
          return ok({ toolCalls: [] });
        case 'approval.pending':
          return ok({ approvals: [] });
        case 'plan.get':
          return ok({ plan: null });
        case 'patch.get':
          return ok({ patch: null, priorPatches: [] });
        case 'verification.list':
          return ok({ verifications: [] });
        case 'crossreview.get':
          return ok({ crossReview: null });
        case 'project.import':
          // 打开 Run 会顺带导入它所属的项目；失败会把主栏换成错误面板
          return ok({
            outcome: 'IMPORTED',
            snapshot: {
              snapshotId: 'snapshot-p1',
              projectId: 'p1',
              baseSha: '0123456789abcdef0123456789abcdef01234567',
              branch: 'main',
              baseKind: 'CLEAN_COMMIT',
              dirtyFileCount: 0,
              untrackedCount: 0,
              subPath: '',
              fileCount: 1,
              totalBytes: 10,
              treeDigest: 'sha256:tree',
              excludedPaths: [],
              createdAt: NOW,
            },
            profile: {
              profileId: 'profile-p1',
              snapshotId: 'snapshot-p1',
              adapterId: 'vite-react-ts',
              adapterVersion: 'test',
              supportStatus: 'VERIFIED',
              detectedSignals: ['vite'],
              packageManager: 'pnpm',
              commands: {},
              protectedPaths: [],
              supportedTaskClasses: [],
              notes: [],
            },
            candidates: [],
          });
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

  return {
    push: (event) => {
      if (!listener) throw new Error('还没有订阅者');
      act(() => listener!(event));
    },
  };
}

function delta(text: string): PushEvent {
  return { type: 'run.stream', runId: RUN_ID, attemptId: 'attempt-1', signal: { kind: 'delta', text } };
}

async function openTheRun(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /修一下构建/ }, WAIT));
  await screen.findByText('把 STATUS 改成 fixed', undefined, WAIT);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('模型正文的实时缓冲', () => {
  it('delta 逐段追加', async () => {
    const { push } = installBridge();
    render(<App />);
    await openTheRun();

    push(delta('我先读'));
    push(delta('一下配置。'));

    await waitFor(() => expect(screen.getByText('我先读一下配置。')).toBeTruthy(), WAIT);
  });

  it('reset 清空 —— 作废的尝试不许把半截话留在界面上', async () => {
    const { push } = installBridge();
    render(<App />);
    await openTheRun();

    push(delta('这半句会被撤回'));
    await waitFor(() => expect(screen.getByText('这半句会被撤回')).toBeTruthy(), WAIT);

    push({
      type: 'run.stream',
      runId: RUN_ID,
      attemptId: 'attempt-1',
      signal: { kind: 'reset', reason: '连接被拒，重试' },
    });

    await waitFor(() => expect(screen.queryByText('这半句会被撤回')).toBeNull(), WAIT);
  });

  it('MODEL_INVOCATION 落地就清空：同一段话不许显示两遍', async () => {
    const { push } = installBridge();
    render(<App />);
    await openTheRun();

    push(delta('改完了。'));
    await waitFor(() => expect(screen.getByText('改完了。')).toBeTruthy(), WAIT);

    // 这一轮结束了 —— 持久记录正在接手
    push({ type: 'run.event', runId: RUN_ID, event: runEvent(2, 'MODEL_INVOCATION', 'EXECUTION 调用 m') });
    push({
      type: 'run.event',
      runId: RUN_ID,
      event: runEvent(3, 'ASSISTANT_MESSAGE', '改完了。', {
        purpose: 'EXECUTION',
        truncated: false,
        fullLength: 4,
      }),
    });

    // 只剩一处，而且是署名 AI 的那条记录（缓冲那条没有署名行）
    await waitFor(() => expect(screen.getAllByText('改完了。')).toHaveLength(1), WAIT);
    expect(document.querySelector('.msg.agent.live')).toBeNull();
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('别的 Run 的增量不串台', async () => {
    const { push } = installBridge();
    render(<App />);
    await openTheRun();

    push({
      type: 'run.stream',
      runId: 'some-other-run',
      attemptId: 'x',
      signal: { kind: 'delta', text: '不该出现在这里' },
    });

    await waitFor(() => expect(screen.queryByText('不该出现在这里')).toBeNull(), WAIT);
  });
});
