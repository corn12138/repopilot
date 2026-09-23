import type {
  WorkbenchBridge,
  WorkbenchEvent,
  WorkbenchMethod,
  WorkbenchPayload,
  WorkbenchResponse,
} from '@shared/workbenchProtocol';
import { RequestError } from './bridge';

declare global {
  interface Window {
    repopilotWorkbench: WorkbenchBridge;
  }
}

export async function workbenchCall<M extends WorkbenchMethod>(
  method: M,
  payload: WorkbenchPayload<M>,
): Promise<WorkbenchResponse<M>> {
  const result = await window.repopilotWorkbench.request(method, payload);
  if (!result.ok) throw new RequestError(result.error.message, result.error.code, result.error.detail);
  return result.data;
}

export function workbenchSubscribe(handler: (event: WorkbenchEvent) => void): () => void {
  return window.repopilotWorkbench.subscribe(handler);
}
