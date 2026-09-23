import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalDecisionKind, ApprovalRequest } from '@shared/domain';
import type { ResponsePayload } from '@shared/protocol';
import { RequestError, call } from './bridge';

export interface ApprovalActionTarget {
  readonly approvalId: string;
  readonly decision: ApprovalDecisionKind;
}

export interface PendingApprovalAction extends ApprovalActionTarget {
  readonly ownerRunId: string;
}

export interface ApprovalActionError extends ApprovalActionTarget {
  readonly ownerRunId: string | null;
  readonly code: string;
  readonly message: string;
  readonly detail: string | null;
}

export type ApprovalDecisionInvoker = (
  approval: ApprovalRequest,
  decision: ApprovalDecisionKind,
  note?: string,
) => Promise<ResponsePayload<'approval.decide'>>;

interface ApprovalActionState {
  readonly ownerRunId: string | null;
  readonly pending: readonly PendingApprovalAction[];
  readonly error: ApprovalActionError | null;
}

interface ActionScope {
  readonly ownerRunId: string | null;
  readonly generation: number;
}

interface FailedAction {
  readonly scope: ActionScope;
  readonly approval: ApprovalRequest;
  readonly decision: ApprovalDecisionKind;
  readonly note: string;
}

interface InFlightAction {
  readonly scope: ActionScope;
  readonly target: ApprovalActionTarget;
  readonly promise: Promise<boolean>;
}

class ApprovalNotAcceptedError extends Error {
  readonly code = 'NOT_ACCEPTED';
}

const defaultInvoker: ApprovalDecisionInvoker = (approval, decision, note = '') =>
  call('approval.decide', {
    approvalId: approval.approvalId,
    decision,
    subjectDigest: approval.subjectDigest,
    note,
  });

function emptyState(ownerRunId: string | null): ApprovalActionState {
  return { ownerRunId, pending: [], error: null };
}

function failureFrom(
  error: unknown,
  ownerRunId: string | null,
  target: ApprovalActionTarget,
): ApprovalActionError {
  if (error instanceof RequestError) {
    return {
      ...target,
      ownerRunId,
      code: error.code,
      message: error.message,
      detail: error.detail,
    };
  }
  if (error instanceof ApprovalNotAcceptedError) {
    return {
      ...target,
      ownerRunId,
      code: error.code,
      message: error.message,
      detail: null,
    };
  }
  return {
    ...target,
    ownerRunId,
    code: 'REQUEST_FAILED',
    message: error instanceof Error ? error.message : '审批请求失败',
    detail: null,
  };
}

/**
 * 为一个 Run 提供共享的审批动作控制器。
 *
 * Dock 与详情卡必须消费同一个实例。请求以 approvalId 单航班执行，而 owner generation
 * 决定异步结果是否仍有资格更新界面；`retry` 只重放当前 Run 最近一次失败的原始决定。
 */
export function useApprovalAction(
  ownerRunId: string | null,
  invoke: ApprovalDecisionInvoker = defaultInvoker,
) {
  const scopeRef = useRef<ActionScope>({ ownerRunId, generation: 0 });
  const inFlightRef = useRef(new Map<string, InFlightAction>());
  const failedRef = useRef<FailedAction | null>(null);
  const [state, setState] = useState<ApprovalActionState>(() => emptyState(ownerRunId));

  useLayoutEffect(() => {
    const scope: ActionScope = {
      ownerRunId,
      generation: scopeRef.current.generation + 1,
    };
    scopeRef.current = scope;
    inFlightRef.current.clear();
    failedRef.current = null;
    setState(emptyState(ownerRunId));

    return () => {
      if (scopeRef.current !== scope) return;
      // Promise 无法撤回，但失效 generation 会剥夺旧响应提交 pending/error 的资格。
      scopeRef.current = { ownerRunId: null, generation: scope.generation + 1 };
      inFlightRef.current.clear();
      failedRef.current = null;
    };
  }, [ownerRunId]);

  const decide = useCallback(
    (approval: ApprovalRequest, decision: ApprovalDecisionKind, note = ''): Promise<boolean> => {
      const scope = scopeRef.current;
      const target: ApprovalActionTarget = { approvalId: approval.approvalId, decision };

      // 旧树遗留的事件 handler 也可能被调用；scope 不再属于该闭包时必须静默失效。
      if (scope.ownerRunId !== ownerRunId) return Promise.resolve(false);

      if (ownerRunId === null || approval.runId !== ownerRunId) {
        const error: ApprovalActionError = {
          ...target,
          ownerRunId,
          code: 'OWNER_MISMATCH',
          message: '审批不属于当前 Run，已拒绝提交',
          detail: `当前 Run：${ownerRunId ?? '未选择'}；审批 Run：${approval.runId}`,
        };
        failedRef.current = null;
        setState((previous) =>
          previous.ownerRunId === ownerRunId ? { ...previous, error } : previous,
        );
        return Promise.resolve(false);
      }

      /*
       * React state 只负责展示，不能充当互斥锁：Dock 与卡片可能在下一次 render 前都读到
       * pending=false。Promise 放在 ref Map 后，第二个入口会直接复用第一次调用的结果。
       * key 刻意不含 decision，避免“批准”和“拒绝”竞争写同一个 approval。
       */
      const existing = inFlightRef.current.get(approval.approvalId);
      if (existing?.scope === scope) return existing.promise;

      const pending: PendingApprovalAction = { ...target, ownerRunId };
      if (failedRef.current?.approval.approvalId === approval.approvalId) {
        failedRef.current = null;
      }
      setState((previous) =>
        previous.ownerRunId === ownerRunId
          ? {
              ...previous,
              pending: [
                ...previous.pending.filter((item) => item.approvalId !== approval.approvalId),
                pending,
              ],
              error:
                previous.error?.approvalId === approval.approvalId ? null : previous.error,
            }
          : previous,
      );

      /*
       * bridge 通常返回 Promise，但测试替身或将来的包装器仍可能同步 throw。先把它
       * 归一成 rejected Promise，后续 await 会让 operation 进入 Map 后才运行 finally，
       * 不会留下一个永远 pending 的幽灵动作。
       */
      let invocation: Promise<ResponsePayload<'approval.decide'>>;
      try {
        invocation = Promise.resolve(
          note.length > 0 ? invoke(approval, decision, note) : invoke(approval, decision),
        );
      } catch (caught) {
        invocation = Promise.reject(caught);
      }
      let operation!: InFlightAction;
      const promise = (async () => {
        try {
          const result = await invocation;
          // 调用方可能根据布尔结果触发 refresh；旧 owner 即使服务端成功也不能驱动新 Run。
          if (scopeRef.current !== scope) return false;
          if (!result.accepted) {
            throw new ApprovalNotAcceptedError(result.reason ?? '审批未被接受');
          }
          return true;
        } catch (caught) {
          if (scopeRef.current !== scope) return false;
          const error = failureFrom(caught, ownerRunId, target);
          failedRef.current = { scope, approval, decision, note };
          setState((previous) =>
            previous.ownerRunId === ownerRunId ? { ...previous, error } : previous,
          );
          return false;
        } finally {
          if (
            scopeRef.current === scope &&
            inFlightRef.current.get(approval.approvalId) === operation
          ) {
            inFlightRef.current.delete(approval.approvalId);
            setState((previous) =>
              previous.ownerRunId === ownerRunId
                ? {
                    ...previous,
                    pending: previous.pending.filter(
                      (item) => item.approvalId !== approval.approvalId,
                    ),
                  }
                : previous,
            );
          }
        }
      })();
      operation = { scope, target, promise };
      inFlightRef.current.set(approval.approvalId, operation);
      return promise;
    },
    [invoke, ownerRunId],
  );

  const retry = useCallback((): Promise<boolean> => {
    const failed = failedRef.current;
    if (failed === null || failed.scope !== scopeRef.current) return Promise.resolve(false);
    return decide(failed.approval, failed.decision, failed.note);
  }, [decide]);

  const clearError = useCallback(() => {
    failedRef.current = null;
    setState((previous) =>
      previous.ownerRunId === ownerRunId ? { ...previous, error: null } : previous,
    );
  }, [ownerRunId]);

  // owner 改变后的首帧也不暴露旧动作；layout effect 会在绘制前完成物理清理与失效。
  const visible = state.ownerRunId === ownerRunId ? state : emptyState(ownerRunId);
  const isPending = useCallback(
    (approvalId: string, decision?: ApprovalDecisionKind) =>
      visible.pending.some(
        (item) =>
          item.approvalId === approvalId &&
          (decision === undefined || item.decision === decision),
      ),
    [visible.pending],
  );

  return {
    ownerRunId,
    pending: visible.pending,
    error: visible.error,
    isPending,
    decide,
    retry,
    clearError,
  } as const;
}

/** App 为当前 Run 持有唯一实例，所有审批入口共享这一个控制器。 */
export type ApprovalActionController = ReturnType<typeof useApprovalAction>;
