import { WORKBENCH_CHANNEL, type WorkbenchEvent, type WorkbenchResult } from '@shared/workbenchProtocol';
import { ipcMain, type BrowserWindow } from 'electron';
import { ClaudeAgentSdkAdapter } from './claudeAdapter';
import { CodexAppServerAdapter } from './codexAdapter';
import { workbenchEnvelopeSchema } from './workbenchSchema';
import { WorkbenchError, WorkbenchService } from './workbenchService';

export function registerWorkbenchIpc(
  getWindow: () => BrowserWindow | null,
  credentialFor: (vendor: 'CODEX' | 'CLAUDE') => string | null = () => null,
): WorkbenchService {
  const service = new WorkbenchService(
    [
      new CodexAppServerAdapter(undefined, undefined, () => credentialFor('CODEX')),
      new ClaudeAgentSdkAdapter(undefined, undefined, () => credentialFor('CLAUDE')),
    ],
    (event: WorkbenchEvent) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send(WORKBENCH_CHANNEL.event, event);
    },
  );
  ipcMain.handle(WORKBENCH_CHANNEL.request, async (event, raw: unknown): Promise<WorkbenchResult<unknown>> => {
    try {
      const window = getWindow();
      if (!window || event.sender !== window.webContents) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: '未授权的发送方', detail: null } };
      }
      const parsed = workbenchEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: '请求不合工作位契约', detail: parsed.error.issues[0]?.message ?? null } };
      }
      const request = parsed.data;
      switch (request.method) {
        case 'workbench.probe': return { ok: true, data: { capabilities: await service.probe(request.payload.vendor) } };
        case 'workbench.start': return { ok: true, data: { session: await service.start(request.payload.vendor, request.payload.projectId ?? null) } };
        case 'workbench.send':
          await service.send(request.payload);
          return { ok: true, data: { accepted: true, requestId: request.payload.requestId } };
        case 'workbench.interrupt':
          await service.interrupt(request.payload.handle, request.payload.connectionEpoch, request.payload.projectId, request.payload.requestId);
          return { ok: true, data: { requested: true } };
        case 'workbench.dispose':
          await service.dispose(request.payload.handle, request.payload.connectionEpoch, request.payload.projectId);
          return { ok: true, data: { closed: true } };
        case 'workbench.reconnect': return { ok: true, data: service.reconnect(request.payload) };
        case 'workbench.list': return { ok: true, data: { sessions: service.list(request.payload.projectId) } };
        case 'workbench.summary': return { ok: true, data: { projects: service.summary() } };
      }
    } catch (error) {
      if (error instanceof WorkbenchError) {
        return { ok: false, error: { code: error.code, message: error.message, detail: null } };
      }
      return { ok: false, error: { code: 'INTERNAL', message: '工作位请求失败', detail: (error as Error).message.slice(0, 300) } };
    }
  });
  return service;
}
