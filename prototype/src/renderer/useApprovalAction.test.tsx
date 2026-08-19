// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ApprovalDecisionKind, ApprovalRequest } from '@shared/domain';
import type { ResponsePayload } from '@shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from './bridge';
import {
  useApprovalAction,
  type ApprovalDecisionInvoker,
} from './useApprovalAction';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 可控 Promise 让审批完成顺序不再依赖测试机器调度。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type DecisionResponse = ResponsePayload<'approval.decide'>;

function approval(runId: string, approvalId: string): ApprovalRequest {
  return {
    approvalId,
    runId,
    attemptId: `attempt-${runId}`,
    kind: 'PLAN',
    risk: 'R1',
    title: `Plan for ${runId}`,
    detail: 'test approval',
    subjectDigest: `digest-${approvalId}`,
    requestedAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-08-13T01:00:00.000Z',
  };
}

function DualEntryHarness({
  ownerRunId,
  request,
  invoke,
}: {
  ownerRunId: string;
  request: ApprovalRequest;
  invoke: ApprovalDecisionInvoker;
}) {
  const action = useApprovalAction(ownerRunId, invoke);
  const decide = (decision: ApprovalDecisionKind) => void action.decide(request, decision);

  return (
    <>
      {/* 两个入口故意都保持可点击，以证明 ref 单航班而非 disabled/state 偶然挡住重复调用。 */}
      <button onClick={() => decide('APPROVE')}>Dock approve</button>
      <button onClick={() => decide('APPROVE')}>Card approve</button>
      <output data-testid="pending">
        {action.pending.map((item) => `${item.approvalId}:${item.decision}`).join(',')}
      </output>
      {action.error && <div role="alert">{action.error.message}</div>}
    </>
  );
}

afterEach(() => cleanup());

describe('useApprovalAction', () => {
  it('Dock 与详情卡同时提交同一 approval 时只 invoke 一次并共享 pending', async () => {
    const response = deferred<DecisionResponse>();
    const invoke = vi.fn<ApprovalDecisionInvoker>(() => response.promise);
    const request = approval('run-a', 'approval-a');
    render(<DualEntryHarness ownerRunId="run-a" request={request} invoke={invoke} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dock approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card approve' }));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(request, 'APPROVE');
    expect(screen.getByTestId('pending').textContent).toBe('approval-a:APPROVE');

    await act(async () => response.resolve({ accepted: true, reason: null }));
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe(''));
  });

  it('切换到 Run B 会立刻清空 A 动作，A 的迟到失败不能覆盖 B', async () => {
    const responseA = deferred<DecisionResponse>();
    const responseB = deferred<DecisionResponse>();
    const invoke = vi.fn<ApprovalDecisionInvoker>((request) =>
      request.runId === 'run-a' ? responseA.promise : responseB.promise,
    );
    const view = renderHook(
      ({ ownerRunId }) => useApprovalAction(ownerRunId, invoke),
      { initialProps: { ownerRunId: 'run-a' } },
    );

    let oldDecision!: Promise<boolean>;
    act(() => {
      oldDecision = view.result.current.decide(approval('run-a', 'approval-a'), 'APPROVE');
    });
    expect(view.result.current.pending).toMatchObject([
      { ownerRunId: 'run-a', approvalId: 'approval-a', decision: 'APPROVE' },
    ]);

    view.rerender({ ownerRunId: 'run-b' });
    expect(view.result.current.pending).toEqual([]);
    expect(view.result.current.error).toBeNull();

    let currentDecision!: Promise<boolean>;
    act(() => {
      currentDecision = view.result.current.decide(approval('run-b', 'approval-b'), 'REJECT');
    });
    await act(async () => {
      responseA.resolve({ accepted: true, reason: null });
      // A 在 Core 成功也已经失去 UI 所有权，不能诱导调用方刷新当前 B。
      expect(await oldDecision).toBe(false);
    });

    expect(view.result.current.error).toBeNull();
    expect(view.result.current.pending).toMatchObject([
      { ownerRunId: 'run-b', approvalId: 'approval-b', decision: 'REJECT' },
    ]);

    await act(async () => {
      responseB.resolve({ accepted: true, reason: null });
      expect(await currentDecision).toBe(true);
    });
    expect(view.result.current.pending).toEqual([]);
  });

  it('请求拒绝会保留 target 化 inline error，并可在原位置 retry', async () => {
    const invoke = vi
      .fn<ApprovalDecisionInvoker>()
      .mockRejectedValueOnce(new RequestError('Core 暂时不可用', 'CORE_UNAVAILABLE', '请稍后重试'))
      .mockResolvedValueOnce({ accepted: true, reason: null });
    const request = approval('run-a', 'approval-a');
    const view = renderHook(() => useApprovalAction('run-a', invoke));

    await act(async () => {
      expect(await view.result.current.decide(request, 'APPROVE')).toBe(false);
    });
    expect(view.result.current.error).toEqual({
      ownerRunId: 'run-a',
      approvalId: 'approval-a',
      decision: 'APPROVE',
      code: 'CORE_UNAVAILABLE',
      message: 'Core 暂时不可用',
      detail: '请稍后重试',
    });

    await act(async () => {
      expect(await view.result.current.retry()).toBe(true);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(request, 'APPROVE');
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.pending).toEqual([]);
  });

  it('approval.runId 与 owner 不匹配时 fail-closed，且 clearError 不提供错误重试', async () => {
    const invoke = vi.fn<ApprovalDecisionInvoker>();
    const view = renderHook(() => useApprovalAction('run-a', invoke));

    await act(async () => {
      expect(await view.result.current.decide(approval('run-b', 'approval-b'), 'REJECT')).toBe(false);
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(view.result.current.error).toMatchObject({
      ownerRunId: 'run-a',
      approvalId: 'approval-b',
      decision: 'REJECT',
      code: 'OWNER_MISMATCH',
    });

    act(() => view.result.current.clearError());
    expect(view.result.current.error).toBeNull();
    await expect(view.result.current.retry()).resolves.toBe(false);
  });

  it('Core 返回 accepted=false 时保持明确拒绝原因', async () => {
    const invoke = vi.fn<ApprovalDecisionInvoker>().mockResolvedValue({
      accepted: false,
      reason: '审批已过期',
    });
    const view = renderHook(() => useApprovalAction('run-a', invoke));

    await act(async () => {
      expect(
        await view.result.current.decide(approval('run-a', 'approval-a'), 'APPROVE'),
      ).toBe(false);
    });
    expect(view.result.current.error).toMatchObject({
      approvalId: 'approval-a',
      decision: 'APPROVE',
      code: 'NOT_ACCEPTED',
      message: '审批已过期',
    });
  });

  it('invoker 同步抛错也会释放单航班 pending', async () => {
    const invoke = vi.fn<ApprovalDecisionInvoker>(() => {
      throw new Error('synchronous bridge failure');
    });
    const view = renderHook(() => useApprovalAction('run-a', invoke));

    await act(async () => {
      expect(
        await view.result.current.decide(approval('run-a', 'approval-a'), 'APPROVE'),
      ).toBe(false);
    });
    expect(view.result.current.pending).toEqual([]);
    expect(view.result.current.error).toMatchObject({
      approvalId: 'approval-a',
      code: 'REQUEST_FAILED',
      message: 'synchronous bridge failure',
    });
  });
});
