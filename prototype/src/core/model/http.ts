import type { ModelSendState } from '@shared/domain';
import type { ModelCallErrorKind } from './types';

/**
 * 两个 wire、流式与非流式共用的 HTTP 失败判读。
 *
 * 单独成文件是为了断开循环依赖（`stream.ts` 与 `anthropic.ts` 互相需要），
 * 但更重要的理由是：**重试安全性只能有一套规则**。复制一份到流式路径上，
 * 迟早会出现"非流式认为不可重发、流式认为可以"的分歧 ——
 * 而那一侧的代价是重复计费并重复执行一次已经生效的调用。
 */

/**
 * 连接根本没建立起来的错误码 —— 请求确定没离开本机（NOT_SENT），重发是安全的。
 * 其余网络类失败（ECONNRESET / socket hang up / body 中断 / 超时）一律按
 * "发出去了但结局不明"处理：provider 可能已经执行并计费，默认不可重发。
 * 对应 TD model-invocation §4：BEFORE_BYTES 可重试，AFTER_BYTES_UNKNOWN 默认禁止。
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS 握手失败也没把请求发出去；能不能靠重试恢复由 retry 层另行判断
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function causeCode(err: unknown): string {
  const e = err as { cause?: { code?: unknown }; code?: unknown };
  const c = e?.cause?.code ?? e?.code;
  return typeof c === 'string' ? c : '';
}

export function sendStateForNetworkError(err: unknown): ModelSendState {
  return NOT_SENT_CODES.has(causeCode(err)) ? 'NOT_SENT' : 'SENT_OUTCOME_UNKNOWN';
}

export function httpErrorKind(status: number): ModelCallErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER';
  return 'BAD_REQUEST';
}

/** 只认秒数形式；HTTP-date 形式少见且时钟相关，解析不出就交给指数退避 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/** 只回传 provider 的错误摘要，不把整个请求体或 header 带出去 */
export function summarizeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 300);
    return (parsed.error?.message ?? parsed.message ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
