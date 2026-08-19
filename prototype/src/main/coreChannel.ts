import type { IpcResult, PlatformError } from '@shared/protocol';

/**
 * Main → Core 的在途请求账本。
 *
 * 单独成文件而不是留在 `index.ts` 里，是为了让它能在没有 Electron 的情况下被测试：
 * 超时、迟到响应、进程退出这三条路径正是最容易写错、也最难在 GUI 里复现的部分。
 *
 * 它负责的唯一一件事：**每个请求都必须有明确结局**。
 * 成功、失败、超时、Core 退出 —— 四选一，不存在第五种"一直等着"。
 */

export interface CoreRequestMessage {
  readonly kind: 'request';
  readonly requestId: string;
  readonly method: string;
  readonly payload: unknown;
}

export interface BrokerDeps {
  readonly post: (message: CoreRequestMessage) => void;
  /** 注入以便测试用假时钟；默认用真实定时器。 */
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly timeoutMs: number;
  readonly resolve: (result: IpcResult<unknown>) => void;
  readonly timer: unknown;
}

function coreError(code: PlatformError['code'], message: string, detail: string | null): IpcResult<never> {
  return { ok: false, error: { code, message, detail } };
}

export class CoreRequestBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: BrokerDeps) {
    this.setTimer =
      deps.setTimer ??
      ((handler, ms) => {
        const timer = setTimeout(handler, ms);
        // 一个在途请求不该成为进程退出的理由。
        (timer as { unref?: () => void }).unref?.();
        return timer;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** 便于诊断：超时报错里带上"当时还有几个请求在等"，能区分单点卡死与整体失联。 */
  get inFlightMethods(): string[] {
    return [...this.pending.values()].map((p) => p.method);
  }

  request(method: string, payload: unknown, timeoutMs: number): Promise<IpcResult<unknown>> {
    this.sequence += 1;
    const requestId = `req_${this.sequence}`;
    return new Promise<IpcResult<unknown>>((resolve) => {
      const timer = this.setTimer(() => {
        /*
         * 超时后立刻把这一条从账本里摘掉。摘掉之后如果 Core 迟到地回来了，
         * `settle` 找不到条目就会丢弃它 —— 一个请求只允许结算一次，
         * 否则调用方会先收到 TIMEOUT，再被一个"其实成功了"的响应改写。
         */
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        entry.resolve(
          coreError(
            'CORE_UNAVAILABLE',
            `请求超时：${method}`,
            `Agent Core 在 ${timeoutMs}ms 内没有回应；当时另有 ${this.pending.size} 个请求在途`,
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, { method, timeoutMs, resolve, timer });
      try {
        this.deps.post({ kind: 'request', requestId, method, payload });
      } catch (err) {
        // postMessage 对着已死的通道会同步抛错；那也必须变成一个明确结局。
        this.settle(requestId, coreError('CORE_UNAVAILABLE', '无法把请求投递给 Agent Core', (err as Error).message));
      }
    });
  }

  /** Core 回应。未知 requestId（已超时或已被清空）直接丢弃。 */
  settle(requestId: string, result: IpcResult<unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    this.clearTimer(entry.timer);
    entry.resolve(result);
    return true;
  }

  /** Core 退出：所有在途请求立刻收到明确失败，不能挂在那里等一个不会来的进程。 */
  failAll(detail: string): number {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) {
      this.clearTimer(entry.timer);
      entry.resolve(coreError('CORE_UNAVAILABLE', 'Agent Core 已退出', detail));
    }
    return entries.length;
  }
}
