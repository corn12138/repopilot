import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  PatchArtifact,
  PlanRevision,
  ProjectRef,
  RunEvent,
  ToolCallView,
  VerificationRun,
} from '@shared/domain';
import type { ImportOutcome } from '@shared/protocol';
import { RequestError, call } from './bridge';
import {
  OWNED_ASYNC_IDLE,
  createLatestRequestGuard,
  type OwnedAsyncState,
  type RequestIdentity,
} from './ownedAsync';

export interface RendererFailure {
  readonly message: string;
  readonly detail: string | null;
}

function rendererFailure(error: unknown, fallback: string): RendererFailure {
  if (error instanceof RequestError) return { message: error.message, detail: error.detail };
  return { message: error instanceof Error ? error.message : fallback, detail: null };
}

export interface ProjectImportRequest {
  readonly project: ProjectRef;
  readonly subPath?: string;
}

export interface ProjectImportData {
  readonly requestedSubPath: string;
  readonly outcome: ImportOutcome;
}

export type ProjectImportState = OwnedAsyncState<string, ProjectImportData, RendererFailure>;
export type ProjectImportLoader = (request: ProjectImportRequest) => Promise<ImportOutcome>;

const defaultProjectImportLoader: ProjectImportLoader = ({ project, subPath }) =>
  call('project.import', {
    projectId: project.projectId,
    ...(subPath ? { subPath } : {}),
  });

export function useProjectImport(loader: ProjectImportLoader = defaultProjectImportLoader) {
  const guardRef = useRef<ReturnType<typeof createLatestRequestGuard<string>> | null>(null);
  if (guardRef.current === null) guardRef.current = createLatestRequestGuard<string>();
  const [state, setState] = useState<ProjectImportState>(OWNED_ASYNC_IDLE);

  const start = useCallback(
    async (request: ProjectImportRequest) => {
      const identity = guardRef.current!.begin(request.project.projectId);
      setState({ status: 'loading', ...identity });
      try {
        const outcome = await loader(request);
        if (!guardRef.current!.isLatest(identity)) return;
        setState({
          status: 'ready',
          ...identity,
          data: { requestedSubPath: request.subPath ?? '', outcome },
        });
      } catch (error) {
        if (!guardRef.current!.isLatest(identity)) return;
        setState({ status: 'error', ...identity, error: rendererFailure(error, '导入失败') });
      }
    },
    [loader],
  );

  const reset = useCallback(() => {
    guardRef.current!.invalidate();
    setState(OWNED_ASYNC_IDLE);
  }, []);

  useEffect(
    () => () => {
      guardRef.current!.invalidate();
    },
    [],
  );

  return { state, start, reset } as const;
}

export interface RunDetailData {
  readonly events: RunEvent[];
  readonly toolCalls: ToolCallView[];
  readonly approvals: ApprovalRequest[];
  readonly plan: PlanRevision | null;
  readonly patch: PatchArtifact | null;
  readonly verifications: VerificationRun[];
}

export type RunDetailState = OwnedAsyncState<string, RunDetailData, RendererFailure>;
export type RunDetailLoader = (runId: string) => Promise<RunDetailData>;

const defaultRunDetailLoader: RunDetailLoader = async (runId) => {
  const [eventResult, toolResult, approvalResult, planResult, patchResult, verificationResult] =
    await Promise.all([
      call('run.events', { runId, afterSeq: 0 }),
      call('run.toolCalls', { runId }),
      call('approval.pending', { runId }),
      call('plan.get', { runId }),
      call('patch.get', { runId }),
      call('verification.list', { runId }),
    ]);
  return {
    events: eventResult.events,
    toolCalls: toolResult.toolCalls,
    approvals: approvalResult.approvals,
    plan: planResult.plan,
    patch: patchResult.patch,
    verifications: verificationResult.verifications,
  };
};

type RunDetailUpdate =
  | { readonly type: 'event'; readonly event: RunEvent }
  | { readonly type: 'toolCall'; readonly toolCall: ToolCallView }
  | { readonly type: 'approvals'; readonly approvals: ApprovalRequest[] };

function applyRunDetailUpdate(data: RunDetailData, update: RunDetailUpdate): RunDetailData {
  switch (update.type) {
    case 'event':
      return data.events.some((event) => event.seq === update.event.seq)
        ? data
        : { ...data, events: [...data.events, update.event].sort((a, b) => a.seq - b.seq) };
    case 'toolCall': {
      const index = data.toolCalls.findIndex(
        (toolCall) => toolCall.toolCallId === update.toolCall.toolCallId,
      );
      if (index < 0) return { ...data, toolCalls: [...data.toolCalls, update.toolCall] };
      const toolCalls = [...data.toolCalls];
      toolCalls[index] = update.toolCall;
      return { ...data, toolCalls };
    }
    case 'approvals':
      return { ...data, approvals: update.approvals };
  }
}

/**
 * Run 详情读取与增量事件的唯一归属点。
 *
 * 全量读取期间收到的 push 会暂存到同一个 requestId，读取完成后再合并；否则某个端点
 * 较慢时，已经推到 Renderer 的新事件仍可能被较早的全量快照盖掉。
 */
export function useRunDetail(loader: RunDetailLoader = defaultRunDetailLoader) {
  const guardRef = useRef<ReturnType<typeof createLatestRequestGuard<string>> | null>(null);
  if (guardRef.current === null) guardRef.current = createLatestRequestGuard<string>();
  const pendingRef = useRef(new Map<number, RunDetailUpdate[]>());
  const [state, setState] = useState<RunDetailState>(OWNED_ASYNC_IDLE);

  const start = useCallback(
    async (runId: string) => {
      const identity = guardRef.current!.begin(runId);
      // 旧 loader 可能永远不 settle；它已失去界面所有权，buffer 也不应继续占内存。
      pendingRef.current.clear();
      pendingRef.current.set(identity.requestId, []);
      setState({ status: 'loading', ...identity });
      try {
        let data = await loader(runId);
        if (!guardRef.current!.isLatest(identity)) return;
        for (const update of pendingRef.current.get(identity.requestId) ?? []) {
          data = applyRunDetailUpdate(data, update);
        }
        setState({ status: 'ready', ...identity, data });
      } catch (error) {
        if (!guardRef.current!.isLatest(identity)) return;
        setState({ status: 'error', ...identity, error: rendererFailure(error, '运行详情加载失败') });
      } finally {
        pendingRef.current.delete(identity.requestId);
      }
    },
    [loader],
  );

  const applyUpdate = useCallback((runId: string, update: RunDetailUpdate) => {
    const current = guardRef.current!.latest();
    if (current === null || current.ownerId !== runId) return;

    const pending = pendingRef.current.get(current.requestId);
    if (pending) pending.push(update);
    setState((previous) =>
      previous.status === 'ready' &&
      previous.ownerId === runId &&
      previous.requestId === current.requestId
        ? { ...previous, data: applyRunDetailUpdate(previous.data, update) }
        : previous,
    );
  }, []);

  const reset = useCallback(() => {
    guardRef.current!.invalidate();
    pendingRef.current.clear();
    setState(OWNED_ASYNC_IDLE);
  }, []);

  useEffect(
    () => () => {
      guardRef.current!.invalidate();
      pendingRef.current.clear();
    },
    [],
  );

  const appendEvent = useCallback(
    (runId: string, event: RunEvent) => applyUpdate(runId, { type: 'event', event }),
    [applyUpdate],
  );
  const upsertToolCall = useCallback(
    (runId: string, toolCall: ToolCallView) =>
      applyUpdate(runId, { type: 'toolCall', toolCall }),
    [applyUpdate],
  );
  const replaceApprovals = useCallback(
    (runId: string, approvals: ApprovalRequest[]) =>
      applyUpdate(runId, { type: 'approvals', approvals }),
    [applyUpdate],
  );

  return {
    state,
    start,
    reset,
    appendEvent,
    upsertToolCall,
    replaceApprovals,
  } as const;
}

export function matchesRequestOwner<OwnerId>(
  identity: RequestIdentity<OwnerId> | { readonly ownerId: null },
  ownerId: OwnerId,
): boolean {
  return identity.ownerId === ownerId;
}
