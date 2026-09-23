import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, PROTOCOL_VERSION, type PushEvent, type RepoPilotBridge } from '@shared/protocol';
import {
  OBSERVER_CHANNEL,
  OBSERVER_PROTOCOL_VERSION,
  type ObserverBridge,
  type ObserverPushEvent,
} from '@shared/observerProtocol';
import {
  WORKBENCH_CHANNEL,
  WORKBENCH_PROTOCOL_VERSION,
  type WorkbenchBridge,
  type WorkbenchEvent,
} from '@shared/workbenchProtocol';

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

  request(method, payload, epoch) {
    return ipcRenderer.invoke(IPC_CHANNEL.request, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
      // 由 Renderer 提供而不是 Preload 缓存：代次是界面事实的一部分，
      // Preload 自己记一份就等于在这里多出一个可能与界面不同步的真值源。
      ...(epoch === undefined ? {} : { epoch }),
    });
  },

  subscribe(handler: (event: PushEvent) => void) {
    const listener = (_e: unknown, event: PushEvent): void => handler(event);
    ipcRenderer.on(IPC_CHANNEL.event, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNEL.event, listener);
  },
};

contextBridge.exposeInMainWorld('repopilot', bridge);

/**
 * 观察通道的桥（TD-DEC-022 (a)：独立通道，不与 Core 契约共用）。
 * 同样只有 request + 只读订阅；没有 epoch —— 观察状态活在 Main，与 Core 代次无关。
 */
const observerBridge: ObserverBridge = {
  protocolVersion: OBSERVER_PROTOCOL_VERSION,

  request(method, payload) {
    return ipcRenderer.invoke(OBSERVER_CHANNEL.request, { method, payload });
  },

  subscribe(handler: (event: ObserverPushEvent) => void) {
    const listener = (_e: unknown, event: ObserverPushEvent): void => handler(event);
    ipcRenderer.on(OBSERVER_CHANNEL.event, listener);
    return () => ipcRenderer.removeListener(OBSERVER_CHANNEL.event, listener);
  },
};

contextBridge.exposeInMainWorld('repopilotObserver', observerBridge);

const workbenchBridge: WorkbenchBridge = {
  protocolVersion: WORKBENCH_PROTOCOL_VERSION,
  request(method, payload) {
    return ipcRenderer.invoke(WORKBENCH_CHANNEL.request, { method, payload });
  },
  subscribe(handler: (event: WorkbenchEvent) => void) {
    const listener = (_e: unknown, event: WorkbenchEvent): void => handler(event);
    ipcRenderer.on(WORKBENCH_CHANNEL.event, listener);
    return () => ipcRenderer.removeListener(WORKBENCH_CHANNEL.event, listener);
  },
};

contextBridge.exposeInMainWorld('repopilotWorkbench', workbenchBridge);
