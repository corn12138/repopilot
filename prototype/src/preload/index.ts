import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, PROTOCOL_VERSION, type PushEvent, type RepoPilotBridge } from '@shared/protocol';

/**
 * Typed Preload Bridge。
 *
 * 只暴露两个能力：一个受版本约束的 request，一个只读事件订阅。
 * 明确**不**暴露：ipcRenderer 本体、通用 invoke(channel,...)、Node API、路径解析、fs。
 *
 * Renderer 侧因此不可能"发一个没见过的 channel"——它连 channel 名字都拿不到。
 */
const bridge: RepoPilotBridge = {
  protocolVersion: PROTOCOL_VERSION,

  request(method, payload) {
    return ipcRenderer.invoke(IPC_CHANNEL.request, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
    });
  },

  subscribe(handler: (event: PushEvent) => void) {
    const listener = (_e: unknown, event: PushEvent): void => handler(event);
    ipcRenderer.on(IPC_CHANNEL.event, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNEL.event, listener);
  },
};

contextBridge.exposeInMainWorld('repopilot', bridge);
