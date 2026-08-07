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

/** 抛错版本：调用点只处理成功路径，失败统一走 catch */
export async function call<M extends RequestMethod>(
  method: M,
  payload: RequestPayload<M>,
): Promise<ResponsePayload<M>> {
  const result = await window.repopilot.request(method, payload);
  if (!result.ok) {
    throw new RequestError(result.error.message, result.error.code, result.error.detail);
  }
  return result.data;
}

export function subscribe(handler: (event: PushEvent) => void): () => void {
  return window.repopilot.subscribe(handler);
}
