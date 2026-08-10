import type { ModelCallError } from './types';

/**
 * 有界同 route 重试策略（TD model-invocation-stream-and-egress §4 的诚实子集）。
 *
 * TD 的完整要求是 max attempts / Retry-After 上限 / jitter / 预算都来自**签名的
 * adapter policy**；原型没有签名机制，这里用一份写死并有文档的保守默认值顶位，
 * 差距如实记录。三条底线与 TD 一致，不打折：
 *
 *   1. 只在**同一条冻结路由**上重试。任何 provider / model / origin 切换都不是
 *      重试，是新决策，必须回到用户手上（automaticFallback=DENY 不变）。
 *   2. 只重发**确定没离开本机**（NOT_SENT）或**对端明确回绝**（429/5xx）的请求。
 *      发出去了但结局不明的（连接中断、超时）默认禁止重发 —— 重发可能让 provider
 *      重复执行、重复计费。
 *   3. 每次尝试独立落账（egress manifest 带 sendAttempt），重试不覆盖前一次的记录。
 */
export interface RetryPolicy {
  /** 总发送次数上限（含第一次）。3 = 最多重试 2 次 */
  readonly maxSendAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** provider 的 Retry-After 超过这个值就不等了 —— 交互式应用不能陪它挂半天 */
  readonly retryAfterCapMs: number;
  /**
   * 单次尝试的超时。防的是"连接挂死到墙钟耗尽"，不是延迟 SLA ——
   * 大上下文 + 长输出的真实调用可以很慢，所以给得很宽。
   */
  readonly perAttemptTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxSendAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  retryAfterCapMs: 20_000,
  perAttemptTimeoutMs: 240_000,
};

/**
 * 这次失败能不能在同一条路由上再试一次。
 *
 * 判据是 (kind, sendState)，不是笼统的"网络错误就重试"：
 *   RATE_LIMIT / SERVER —— 对端明确回了 429/5xx，请求没有被执行的歧义，可重试。
 *   NETWORK + NOT_SENT  —— 连接根本没建立，请求确定没出去，可重试。
 *   NETWORK + 结局不明   —— 不可重试（可能已执行/已计费）。
 *   TIMEOUT             —— 超时时请求早已发出，结局不明，不可重试。
 *   AUTH / BAD_REQUEST / PARSE / CANCELLED —— 重试不会改变结果，不可重试。
 */
export function isRetryable(e: ModelCallError): boolean {
  if (e.kind === 'RATE_LIMIT' || e.kind === 'SERVER') return true;
  if (e.kind === 'NETWORK') return e.sendState === 'NOT_SENT';
  return false;
}

/** 退避时长：Retry-After 优先（封顶），否则指数退避 + 抖动（0.5x–1x） */
export function retryDelayMs(
  e: ModelCallError,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (e.retryAfterMs !== null) return Math.min(e.retryAfterMs, policy.retryAfterCapMs);
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.round(Math.min(policy.maxDelayMs, exponential) * (0.5 + random() * 0.5));
}

/** 可被 AbortSignal 提前叫醒的 sleep。被叫醒时正常 resolve，取消语义由调用方随后处理 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 组合"外部取消"与"单次尝试超时"成一个信号。
 * 用完必须 clear() —— AbortSignal.timeout 的定时器会拖住进程退出。
 */
export function attemptSignal(
  outer: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  if (outer.aborted) {
    controller.abort(outer.reason);
    return { signal: controller.signal, clear: () => {} };
  }
  const timer = setTimeout(() => {
    // 与 AbortSignal.timeout 同形的 reason，adapter 靠 name 区分"超时"与"取消"
    controller.abort(new DOMException('per-attempt timeout', 'TimeoutError'));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', onAbort);
    },
  };
}
