import { ModelCallError, type StreamListener } from './types';
import { causeCode, httpErrorKind, parseRetryAfterMs, sendStateForNetworkError, summarizeError } from './http';

/**
 * 流式调用的共用底座：把一个 SSE 响应变成一串 `data:` 负载。
 *
 * 为什么要有流：模型调用是整个流程里最长的一段等待（几十秒），而在此之前
 * **Core 一条事件都不发** —— `MODEL_INVOCATION` 是在响应回来之后才 emit 的。
 * 界面在这段时间里一个像素都不动，用户分不清"在跑"和"卡死了"。
 *
 * 边界要说清楚：
 *   1. 流**只影响文本什么时候到界面**，不改变权威结果。`stream()` 返回的
 *      `ModelResponse` 与 `call()` 逐字段同义，下游（工具分发、账本、封存）
 *      对"这次是不是流式"完全无知。
 *   2. **第一个字节一落地，重试安全性就变了**。此后任何失败都是
 *      `SENT_OUTCOME_UNKNOWN`：provider 可能已经执行并计费，默认不可重发
 *      （TD model-invocation §4）。这条由 `readSse` 强制，不靠调用方自觉。
 *   3. 增量是**易失的**，不进事件流。持久事实仍然是那条 ASSISTANT_MESSAGE ——
 *      流断了、重试了、进程没了，重新打开这个 Run 看到的都是同一份记录。
 */

/** SSE 的一条 `data:` 负载（已去掉前缀、已按空行分帧） */
export interface SseChunk {
  readonly event: string | null;
  readonly data: string;
}

/**
 * 发起流式请求。**尚未读取正文** —— 状态码与鉴权失败在这里就地判定，
 * 那时还没有任何字节落地，仍然可以按常规规则重试。
 */
export async function openSse(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const e = err as Error;
    const signalReason = (init.signal as AbortSignal | null | undefined)?.reason as
      | { name?: string }
      | undefined;
    if (e.name === 'TimeoutError' || signalReason?.name === 'TimeoutError') {
      throw new ModelCallError('单次调用超时（结局不明，不可重发）', 'TIMEOUT', null, {
        sendState: 'SENT_OUTCOME_UNKNOWN',
      });
    }
    if (e.name === 'AbortError') throw new ModelCallError('调用已取消', 'CANCELLED');
    const code = causeCode(err);
    // 与 fetchJson 同一套判读（http.ts 一处定义）：连接没建立起来才算没发出去
    throw new ModelCallError(`网络错误: ${e.message}${code ? ` (${code})` : ''}`, 'NETWORK', null, {
      sendState: sendStateForNetworkError(err),
    });
  }

  if (!res.ok) {
    // 错误响应不是 SSE，是一份普通 JSON —— 按非流式的同一套规则判级
    const text = await res.text().catch(() => '');
    throw new ModelCallError(
      `HTTP ${res.status}: ${summarizeError(text)}`,
      httpErrorKind(res.status),
      res.status,
      { retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')) },
    );
  }

  if (!res.body) {
    // 没有可读流：这不是"空回复"，是我们**不知道** provider 回了什么
    throw new ModelCallError('流式响应没有正文，无法读取增量', 'PARSE', res.status, {
      sendState: 'SENT_OUTCOME_UNKNOWN',
    });
  }
  return res;
}

/**
 * 逐帧读 SSE。
 *
 * 分帧只认空行（`\n\n` / `\r\n\r\n`），行内只认 `event:` 与 `data:` ——
 * 注释行（`:` 开头，各家用来做心跳）与未知字段一律跳过，不当错误。
 * 多行 `data:` 按 SSE 规范用 `\n` 连接。
 *
 * 读到这里说明 `openSse` 已经拿到 200，请求确定送达了 provider：此后**任何**
 * 中断都记 `SENT_OUTCOME_UNKNOWN`（默认不可重发），因为它可能已经生成并计费。
 */
export async function* readSse(res: Response): AsyncGenerator<SseChunk> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (err) {
        const e = err as Error;
        if (e.name === 'AbortError') throw new ModelCallError('调用已取消', 'CANCELLED');
        /*
         * 走到这里意味着 openSse 已经拿到 200 —— 请求**确定**送达了 provider，
         * 而且它已经在生成（大概率已计费）。所以正文中断一律是"结局不明"，
         * 默认不可重发；一个字节都还没读到也一样，那只说明我们不知道它生成了多少。
         */
        throw new ModelCallError(`读取流失败: ${e.message}`, 'NETWORK', null, {
          sendState: 'SENT_OUTCOME_UNKNOWN',
        });
      }
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });

      for (;;) {
        const frame = takeFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        const chunk = parseFrame(frame.raw);
        if (chunk) yield chunk;
      }
    }
    // 流正常结束时缓冲区里可能还剩最后一帧（provider 没补空行）
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    /*
     * 提前 return（下游读到 [DONE] 就 break）时要释放连接，否则 socket 悬着。
     *
     * 但**不能等它完成**：cancel 的兑现时机取决于底层流的实现，某些流
     * （例如被 tee 过、另一支还没人读的）会让它一直挂着 —— 那就变成
     * "结果已经拼好了，函数却回不来"。我们要的是释放动作已经发出，
     * 不是它已经完成。
     */
    void reader.cancel().catch(() => {});
  }
}

function takeFrame(buffer: string): { raw: string; rest: string } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  const [at, width] = crlf >= 0 && (lf < 0 || crlf < lf) ? [crlf, 4] : [lf, 2];
  return { raw: buffer.slice(0, at), rest: buffer.slice(at + width) };
}

function parseFrame(raw: string): SseChunk | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // 空行与心跳注释
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
    // 其它字段（id / retry / 未知）与我们无关，跳过而不是报错
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** `data: [DONE]` 是 OpenAI 系的终止哨兵，不是 JSON */
export function isDone(chunk: SseChunk): boolean {
  return chunk.data.trim() === '[DONE]';
}

/**
 * 解析一帧的 JSON。
 *
 * 解析失败**不中断整个流**：各家偶尔会插入自定义帧，为一帧坏数据把已经收到的
 * 大半个回复扔掉是得不偿失的。返回 null 由调用方跳过；真正的畸形（缺 choices、
 * 缺 content）仍然由各适配器在收尾时判定。
 */
export function parseJsonFrame(chunk: SseChunk): Record<string, unknown> | null {
  try {
    const value = JSON.parse(chunk.data) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把文本增量交给监听方。
 *
 * 监听方是 UI 通道，出什么问题都不该影响这次模型调用 —— 界面画不出来是
 * 界面的事，不能让它把一次已经在计费的调用带崩。
 */
export function emitDelta(onSignal: StreamListener | undefined, text: string): void {
  if (!onSignal || !text) return;
  try {
    onSignal({ kind: 'delta', text });
  } catch {
    // 故意吞掉：见上
  }
}

/**
 * 撤回已经推给界面的增量。
 *
 * 与 emitDelta 同样吞掉监听方的异常：界面画不出来是界面的事，
 * 不能让它把一次已经在计费的调用带崩。
 */
export function resetStream(onSignal: StreamListener | undefined, reason: string): void {
  if (!onSignal) return;
  try {
    onSignal({ kind: 'reset', reason });
  } catch {
    // 故意吞掉：见上
  }
}
