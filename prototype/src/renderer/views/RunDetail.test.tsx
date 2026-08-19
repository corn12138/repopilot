// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  EMPTY_LEDGER,
  type CrossReviewRecord,
  type PatchArtifact,
  type RunStatus,
  type RunView,
} from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalActionController } from '../useApprovalAction';
import { RunDetail } from './RunDetail';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('../bridge', () => ({ call: requestMock }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 请求顺序是测试合同：新 owner 可见后，旧实体请求才被允许完成。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeRun(runId: string, status: RunStatus = 'SUCCEEDED'): RunView {
  return {
    runId,
    taskId: `task-${runId}`,
    projectId: 'project-1',
    snapshotId: 'snapshot-1',
    title: `Run ${runId}`,
    attemptId: `attempt-${runId}`,
    attemptNo: 1,
    status,
    statusReason: null,
    ledger: { ...EMPTY_LEDGER },
    limits: {
      maxModelTurns: 10,
      maxToolCalls: 20,
      maxSelfFixRounds: 2,
      maxWallClockMs: 60_000,
      maxTotalTokens: 10_000,
    },
    workspaceGeneration: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
    terminalFacts:
      status === 'SUCCEEDED'
        ? { verificationRunId: `verification-${runId}`, patchAcceptanceId: `accept-${runId}` }
        : null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function makePatch(patchId: string, runId: string): PatchArtifact {
  return {
    patchId,
    runId,
    attemptId: `attempt-${runId}`,
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    generation: 1,
    files: [
      {
        path: `${patchId}.ts`,
        changeKind: 'MODIFIED',
        addedLines: 1,
        removedLines: 1,
        diff: `--- a/${patchId}.ts\n+++ b/${patchId}.ts\n-old\n+new`,
        diffTruncated: false,
      },
    ],
    unifiedDiff: '',
    digest: `sha256:${patchId}`,
    sealedAt: '2026-08-13T00:00:01.000Z',
    verificationRunId: `verification-${runId}`,
    comparison: { fixed: ['typecheck'], stillFailing: [], newlyFailing: [], notRerun: [] },
    unverifiedItems: [],
    excludedGeneratedFiles: [],
  };
}

function makeCrossReview(): CrossReviewRecord {
  return {
    enabled: true,
    reviewerProfileId: 'reviewer-a',
    heterogeneous: true,
    rounds: [],
    reviewerInvocations: 1,
    remediations: 0,
    stopReason: 'ERROR',
    startedAt: '2026-08-13T00:00:00.000Z',
    finishedAt: '2026-08-13T00:00:01.000Z',
  };
}

function detail(run: RunView, patch: PatchArtifact | null = null) {
  const approvalAction = {
    ownerRunId: run.runId,
    pending: [],
    error: null,
    isPending: () => false,
    decide: vi.fn(async () => false),
    retry: vi.fn(async () => false),
    clearError: vi.fn(),
  } satisfies ApprovalActionController;
  return (
    <RunDetail
      run={run}
      events={[]}
      toolCalls={[]}
      approvals={[]}
      plan={null}
      patch={patch}
      verifications={[]}
      approvalAction={approvalAction}
      onError={vi.fn()}
      onRefresh={vi.fn()}
    />
  );
}

describe('RunDetail entity-owned local state', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('drops Run A cross-review after switching to B and exposes B read failure', async () => {
    const reviewA = deferred<{ crossReview: CrossReviewRecord | null }>();
    const reviewB = deferred<{ crossReview: CrossReviewRecord | null }>();
    const reviewC = deferred<{ crossReview: CrossReviewRecord | null }>();
    requestMock.mockImplementation((method: string, payload: { runId: string }) => {
      if (method !== 'crossreview.get') throw new Error(`unexpected ${method}`);
      if (payload.runId === 'run-a') return reviewA.promise;
      if (payload.runId === 'run-b') return reviewB.promise;
      return reviewC.promise;
    });

    const view = render(detail(makeRun('run-a')));
    view.rerender(detail(makeRun('run-b')));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    await act(async () => reviewB.resolve({ crossReview: null }));
    await act(async () => reviewA.resolve({ crossReview: makeCrossReview() }));
    expect(screen.queryByText('审核过程出错')).toBeNull();

    view.rerender(detail(makeRun('run-c')));
    await act(async () => reviewC.reject(new Error('review storage unavailable')));
    expect(screen.getByText(/交叉审核记录读取失败：review storage unavailable/)).toBeTruthy();
  });

  it('returns patch B to the first apply-confirmation step', async () => {
    requestMock.mockResolvedValue({ crossReview: null });
    const run = makeRun('run-1');
    const view = render(detail(run, makePatch('patch-a', run.runId)));

    fireEvent.click(screen.getByRole('button', { name: '应用到仓库…' }));
    expect(screen.getByRole('button', { name: '确认写入仓库' })).toBeTruthy();
    expect(screen.getByText('真的修改你的仓库文件')).toBeTruthy();

    view.rerender(detail(run, makePatch('patch-b', run.runId)));
    expect(screen.getByRole('button', { name: '应用到仓库…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认写入仓库' })).toBeNull();
    expect(screen.queryByText('真的修改你的仓库文件')).toBeNull();
  });
});

describe('RunDetail 取消动作的就地反馈', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('请求在途时按钮显示 busy 且不接受第二次点击', async () => {
    const cancelCall = deferred<unknown>();
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method === 'run.cancel') return cancelCall.promise;
      throw new Error(`unexpected ${method}`);
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    const busy = await screen.findByRole('button', { name: '取消中…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');

    fireEvent.click(busy);
    expect(requestMock.mock.calls.filter((c) => c[0] === 'run.cancel').length).toBe(1);

    await act(async () => cancelCall.resolve({}));
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('取消失败时在触发位置显示原因，并可原位重试', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let cancels = 0;
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method !== 'run.cancel') throw new Error(`unexpected ${method}`);
      cancels += 1;
      return cancels === 1 ? first.promise : second.promise;
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => first.reject(new Error('执行器已经不在了')));

    // 顶部通用错误条不是唯一反馈：失败必须留在按下按钮的那张卡片里。
    expect(screen.getByRole('alert').textContent).toContain('取消失败：执行器已经不在了');

    fireEvent.click(screen.getByRole('button', { name: '重试取消' }));
    expect(cancels).toBe(2);

    await act(async () => second.resolve({}));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('「收起」只清掉本地提示，不重发请求', async () => {
    const first = deferred<unknown>();
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method === 'run.cancel') return first.promise;
      throw new Error(`unexpected ${method}`);
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => first.reject(new Error('执行器已经不在了')));

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(requestMock.mock.calls.filter((c) => c[0] === 'run.cancel').length).toBe(1);
  });
});
