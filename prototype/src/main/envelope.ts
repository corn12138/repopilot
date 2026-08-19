import { PROTOCOL_VERSION, type PlatformError, type RequestMethod } from '@shared/protocol';
import { IPC_CONTRACT, isRequestMethod, validateRequestPayload } from '@shared/ipcContract';

/**
 * Renderer 请求信封的准入判定。
 *
 * 抽成纯函数是为了让它可测。此前这一整段判定长在 `ipcMain.handle` 里，而
 * `main/index.ts` 一被 import 就会拉起 Electron —— 于是最该被负向测试覆盖的一层
 * （协议版本、方法白名单、代次、payload 合同）恰恰是唯一没有测试的一层。
 * `ipcContract.ts` 有测试不等于**接线**有测试：漏调一次 `validateRequestPayload`、
 * 把代次判定写成 `!==` 之外的任何东西，合同测试都照样全绿。
 *
 * 这里只做判定，不做任何副作用；调用方拿到 accept 之后才去 dialog / 钥匙串 / Core。
 */

export type EnvelopeDecision =
  | { readonly kind: 'accept'; readonly method: RequestMethod; readonly payload: Record<string, unknown> }
  | { readonly kind: 'reject'; readonly error: PlatformError };

function reject(code: PlatformError['code'], message: string, detail: string | null): EnvelopeDecision {
  return { kind: 'reject', error: { code, message, detail } };
}

export function classifyEnvelope(raw: unknown, coreEpoch: number): EnvelopeDecision {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject(
      'BAD_REQUEST',
      '请求信封必须是对象',
      `收到 ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`,
    );
  }

  const envelope = raw as {
    protocolVersion?: unknown;
    method?: unknown;
    payload?: unknown;
    epoch?: unknown;
  };

  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return reject(
      'BAD_REQUEST',
      '协议版本不匹配',
      `期望 ${PROTOCOL_VERSION}，收到 ${String(envelope.protocolVersion)}`,
    );
  }

  if (!isRequestMethod(envelope.method)) {
    return reject('POLICY_DENIED', `方法不在白名单内: ${String(envelope.method)}`, null);
  }
  const method: RequestMethod = envelope.method;

  /*
   * 代次校验。Renderer 只在握手时不知道 epoch，其余每一次调用都必须证明自己
   * 说的是当前这一代 Core —— 上一代的工作区、活 Run 和内存审批都已经不存在了。
   * 顺序在 payload 校验之前：代次不对时，payload 长什么样已经无关紧要。
   */
  if (!IPC_CONTRACT[method].epochExempt && envelope.epoch !== coreEpoch) {
    return reject(
      'CORE_EPOCH_MISMATCH',
      'Agent Core 已经重启，请求所依据的界面事实已过期',
      `当前代次 ${coreEpoch}，请求代次 ${String(envelope.epoch)}；请重新读取当前状态后再操作`,
    );
  }

  const validated = validateRequestPayload(method, envelope.payload);
  if (!validated.ok) {
    return reject(validated.code, `${method}: ${validated.message}`, validated.detail);
  }

  return { kind: 'accept', method, payload: validated.payload };
}
