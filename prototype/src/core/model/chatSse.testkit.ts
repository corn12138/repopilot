/**
 * 测试用：把一份**非流式** chat.completion JSON 拆成等价的 SSE 帧序列。
 *
 * 为什么需要它：Agent Loop 现在默认走流式（`AgentHost.streamText` 一存在，
 * Gateway 就用 `adapter.stream`）。各个 e2e 线束原本脚本化的是一次性 JSON 响应 ——
 * 如果放着不管，它们喂给流式解析器的就是一份"没有任何 SSE 帧"的正文，
 * 于是每一轮都解析成空回复。**那不是测试环境的问题，是这些测试不再覆盖真实路径。**
 *
 * 所以这里不是"绕过流式"，而是让 e2e 的线上形态与生产一致。脚本作者仍然按
 * 好写好读的 JSON 形态描述模型这一轮说什么，转换在这一层完成。
 *
 * 正文刻意**拆成两帧**：真实 provider 从不会把一句话装进一帧，而"跨帧拼接"
 * 正是最容易写错、又最难在事后发现的地方 —— 让每一条 e2e 都顺带压一次这条路径。
 */

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }>;
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chatCompletionToSse(wire: unknown): string {
  const data = wire as ChatCompletion;

  // 错误体不是 SSE：provider 会用一个非 2xx 的普通 JSON 回你，交给调用方原样返回
  if (data.error) return '';

  const choice = data.choices?.[0];
  const out: string[] = [];

  const text = choice?.message?.content;
  if (typeof text === 'string' && text.length > 0) {
    const cut = Math.max(1, Math.floor(text.length / 2));
    for (const part of [text.slice(0, cut), text.slice(cut)]) {
      if (part) out.push(frame({ choices: [{ delta: { content: part }, finish_reason: null }] }));
    }
  }

  (choice?.message?.tool_calls ?? []).forEach((call, index) => {
    /*
     * 名字与参数分两帧给：OpenAI 系真实的流就是这样（第一帧带 id + name，
     * 之后若干帧只带 arguments 分片）。合成流照做，否则"函数名只来一次"
     * 这条累积规则在 e2e 里根本不会被走到。
     */
    out.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index, id: call.id ?? `call_${index}`, function: { name: call.function?.name ?? '', arguments: '' } },
              ],
            },
          },
        ],
      }),
    );
    const args = call.function?.arguments ?? '';
    if (args) {
      out.push(
        frame({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] }),
      );
    }
  });

  out.push(frame({ choices: [{ delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }] }));
  // usage 单独一帧、choices 为空 —— 与 stream_options.include_usage 的真实形态一致
  if (data.usage) out.push(frame({ choices: [], usage: data.usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

/**
 * 直接给出一个可被流式适配器读取的响应。
 *
 * 错误体（`{error:{...}}`）原样按 JSON 返回：那条路径本来就不走 SSE，
 * `openSse` 会在读正文之前按状态码判级。
 */
export function chatCompletionResponse(wire: unknown, status = 200): Response {
  const sse = chatCompletionToSse(wire);
  if (!sse) {
    return new Response(JSON.stringify(wire), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(sse, { status, headers: { 'content-type': 'text/event-stream' } });
}
