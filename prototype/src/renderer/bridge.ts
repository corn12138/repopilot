import type {
  PushEvent,
  RepoPilotBridge,
  RequestMethod,
  RequestPayload,
  ResponsePayload,
} from '@shared/protocol';

declare global {
  interface Window {
    repopilot: RepoPilotBridge;
  }
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail: string | null,
  ) {
    super(message);
  }
}

/**
 * Renderer 当前认为自己在对话的 Core 代次。
 *
 * 放在模块级而不是 React state：请求可能由任意深处的回调发出，让每个调用点自己
 * 传 epoch 只会漏。它由 `core.status` push 与 `core.getStatus` 握手统一更新 ——
 * 两者都来自 Main 的同一个快照函数，不存在第二个真值源。
 *
 * 初始为 undefined（"还不知道"）。这不是宽松：Main 侧只有 `core.getStatus` 豁免代次校验，
 * 其余方法在 epoch 缺失时同样被拒。
 */
let knownCoreEpoch: number | undefined;

export function setCoreEpoch(epoch: number): void {
  knownCoreEpoch = epoch;
}

export function currentCoreEpoch(): number | undefined {
  return knownCoreEpoch;
}

/** 抛错版本：调用点只处理成功路径，失败统一走 catch */
export async function call<M extends RequestMethod>(
  method: M,
  payload: RequestPayload<M>,
): Promise<ResponsePayload<M>> {
  const result = await window.repopilot.request(method, payload, knownCoreEpoch);
  if (!result.ok) {
    throw new RequestError(result.error.message, result.error.code, result.error.detail);
  }
  return result.data;
}

export function subscribe(handler: (event: PushEvent) => void): () => void {
  return window.repopilot.subscribe(handler);
}
