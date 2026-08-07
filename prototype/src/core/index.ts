/**
 * Desktop Agent Core —— 在 Electron utilityProcess 中运行的唯一业务权威。
 *
 * 这个进程持有：Run/Approval/Patch 状态、Agent Loop、Tool Gateway、Model Gateway、
 * Mutation 引擎、工作区。Main 和 Renderer 都拿不到这些权威。
 *
 * 它**不**监听任何端口 —— 唯一入口是 Main 通过 parentPort 传来的私有消息通道
 * （overlay §2.1「唯一网络面」）。
 */
import type { PushEvent } from '@shared/protocol';
import { CoreError, RunAuthority } from './authority';

interface CoreRequest {
  kind: 'request';
  requestId: string;
  method: string;
  payload: Record<string, unknown>;
}

type CoreOutbound =
  | { kind: 'response'; requestId: string; ok: true; data: unknown }
  | { kind: 'response'; requestId: string; ok: false; error: unknown }
  | { kind: 'push'; event: PushEvent }
  | { kind: 'ready' };

const port = process.parentPort;

function send(message: CoreOutbound): void {
  port.postMessage(message);
}

const authority = new RunAuthority((event) => send({ kind: 'push', event }));

port.on('message', (message) => {
  const data = message.data as CoreRequest | undefined;
  if (!data || data.kind !== 'request') return;

  void (async () => {
    try {
      const result = await authority.handle(data.method, data.payload ?? {});
      send({ kind: 'response', requestId: data.requestId, ok: true, data: result });
    } catch (err) {
      if (err instanceof CoreError) {
        send({ kind: 'response', requestId: data.requestId, ok: false, error: err.payload });
        return;
      }
      // 内部异常只投影安全信息：不回传 stack、路径或请求正文
      send({
        kind: 'response',
        requestId: data.requestId,
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'Core 内部错误',
          detail: (err as Error).message?.slice(0, 300) ?? null,
        },
      });
      // 同时打到 Core 自己的 stderr，便于开发期排查
      console.error('[core] unhandled', err);
    }
  })();
});

process.on('uncaughtException', (err) => {
  console.error('[core] uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[core] unhandledRejection', err);
});

send({ kind: 'ready' });
