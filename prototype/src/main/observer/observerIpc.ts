import { homedir } from 'node:os';
import { join } from 'node:path';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import {
  OBSERVER_CHANNEL,
  type ObserverPushEvent,
  type ObserverResult,
} from '@shared/observerProtocol';
import { observerEnvelopeSchema } from './observerSchema';
import { ObserverError, ObserverService } from './observerService';

/**
 * 观察通道的 Electron 接线（TD-DEC-022 (a)：独立通道，不复用 Core 的 request/event 契约）。
 *
 * 授权动作在这里而不在 Renderer：`observer.enable` 打开**原生目录选择对话框**，
 * 路径由对话框产生 —— 与 `project.pick` 同构的原生手势能力。Renderer 的请求里
 * 没有任何路径参数（schema 就不收），宿主绝对路径也从不回投 Renderer（返回 ~ 缩写展示值）。
 *
 * 轮询定时器只在真的有会话被监视时存在：面板关闭 / 未授权时零 IO。
 */
export function registerObserverIpc(getWindow: () => BrowserWindow | null): { service: ObserverService } {
  const service = new ObserverService({
    claudeProjectsRoot: join(homedir(), '.claude', 'projects'),
    codexSessionsRoot: join(homedir(), '.codex', 'sessions'),
    emit: (event: ObserverPushEvent) => {
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(OBSERVER_CHANNEL.event, event);
    },
  });

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const syncPollTimer = (): void => {
    const watching = service.status().watching.length > 0;
    if (watching && pollTimer === null) {
      pollTimer = setInterval(() => service.pollOnce(), 1500);
    } else if (!watching && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  ipcMain.handle(
    OBSERVER_CHANNEL.request,
    async (event, raw: unknown): Promise<ObserverResult<unknown>> => {
      try {
        const w = getWindow();
        // 与 Core 通道同一条纪律：只接受主窗口发来的请求
        if (!w || event.sender !== w.webContents) {
          return { ok: false, error: { code: 'POLICY_DENIED', message: '未授权的发送方', detail: null } };
        }
        const parsed = observerEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'BAD_REQUEST',
              message: '请求不合观察通道契约',
              detail: parsed.error.issues[0]?.message ?? null,
            },
          };
        }
        const req = parsed.data;
        switch (req.method) {
          case 'observer.status':
            return { ok: true, data: service.status() };
          case 'observer.enable': {
            const picked = await dialog.showOpenDialog(w, {
              title: '选择要只读观察的项目目录（本机代理会话）',
              properties: ['openDirectory'],
              buttonLabel: '授权只读观察',
            });
            const projectPath = picked.canceled ? null : (picked.filePaths[0] ?? null);
            if (projectPath === null) return { ok: true, data: { granted: null } };
            const display = projectPath.startsWith(homedir())
              ? `~${projectPath.slice(homedir().length)}`
              : projectPath;
            const listed = service.enable(projectPath, display);
            syncPollTimer();
            return { ok: true, data: { granted: display, ...listed } };
          }
          case 'observer.disable':
            service.disable();
            syncPollTimer();
            return { ok: true, data: { ok: true } };
          case 'observer.listSessions':
            return { ok: true, data: service.listSessions() };
          case 'observer.watch':
            service.watch(req.payload.sessionId);
            syncPollTimer();
            return { ok: true, data: { ok: true } };
          case 'observer.unwatch':
            service.unwatch(req.payload.sessionId);
            syncPollTimer();
            return { ok: true, data: { ok: true } };
          case 'observer.prepareHandoff':
            return { ok: true, data: { artifact: service.prepareHandoff(req.payload.sessionId) } };
        }
        return { ok: false, error: { code: 'BAD_REQUEST', message: '未知方法', detail: null } };
      } catch (err) {
        if (err instanceof ObserverError) {
          return { ok: false, error: { code: err.code, message: err.message, detail: null } };
        }
        console.error('[main] 观察通道处理请求时发生未预期错误', err);
        return {
          ok: false,
          error: {
            code: 'INTERNAL',
            message: '观察通道处理失败',
            detail: (err as Error).message?.slice(0, 300) ?? null,
          },
        };
      }
    },
  );

  // 只给自检用：让 selftest 能在不经对话框的前提下驱动真实服务（opt-in、只读）。
  // 生产路径的授权仍只有 observer.enable 的原生对话框一条。
  return { service };
}
