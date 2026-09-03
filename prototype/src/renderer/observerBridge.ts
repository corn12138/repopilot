import type {
  ObserverBridge,
  ObserverMethod,
  ObserverPayload,
  ObserverPushEvent,
  ObserverResponse,
} from '@shared/observerProtocol';
import { RequestError } from './bridge';

/**
 * 观察通道的 Renderer 侧封装。与 `bridge.ts` 平行但刻意独立：
 * 这条通道没有 Core 代次（观察状态活在 Main，Core 重启不影响它），
 * 也永远不该出现在任何 Run/Approval 流程里。
 */
declare global {
  interface Window {
    repopilotObserver: ObserverBridge;
  }
}

export async function observerCall<M extends ObserverMethod>(
  method: M,
  payload: ObserverPayload<M>,
): Promise<ObserverResponse<M>> {
  const result = await window.repopilotObserver.request(method, payload);
  if (!result.ok) {
    throw new RequestError(result.error.message, result.error.code, result.error.detail);
  }
  return result.data;
}

export function observerSubscribe(handler: (event: ObserverPushEvent) => void): () => void {
  return window.repopilotObserver.subscribe(handler);
}
