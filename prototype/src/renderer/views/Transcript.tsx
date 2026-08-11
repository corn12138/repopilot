import { useMemo } from 'react';
import type { CommandOutcome, RunEvent, ToolCallView } from '@shared/domain';
import { Badge, DiffView, RiskBadge, timeOf } from '../components/common';

/**
 * 把持久化事件和工具调用合并成一条按时间排列的对话流。
 *
 * 数据源仍然是 Core 的事件日志 —— 这里只做投影，不产生任何新事实。
 *
 * 读得懂的前提是**分清谁在说话**，所以只有四类角色，视觉上互不混淆：
 *   你   —— 用户的输入与决定（创建任务、批准/拒绝）
 *   AI   —— 模型自己的产出（计划、结论文本）
 *   平台 —— RepoPilot 自己的如实标注（基线性质、未验证模式、状态流转、
 *           验证结果、补丁封存）。**这些不是模型说的**，早先版本把 NOTE
 *           标成 "AI"，等于把平台的诚实标注记在模型名下 —— 那是归属错误。
 *   工具 —— 模型请求、平台执行的调用。它们不是独立发言，而是**某一轮模型
 *           思考的产物**，所以折叠进那一轮里，而不是平铺成几十行。
 */

type Item =
  | { kind: 'text'; seq: number; at: string; role: 'user' | 'agent' | 'platform'; text: string }
  | { kind: 'plan'; seq: number; at: string; summary: string; steps: string[]; risks: string[] }
  | { kind: 'tool'; seq: number; at: string; call: ToolCallView }
  | { kind: 'command'; seq: number; at: string; call: ToolCallView; outcome: CommandOutcome | null }
  | { kind: 'verify'; seq: number; at: string; phase: string; passed: boolean; commands: CommandOutcome[] }
  | { kind: 'status'; seq: number; at: string; text: string; tone: 'ok' | 'err' | 'warn' | 'info' }
  /** 一轮模型思考 + 它引发的全部工具调用 */
  | {
      kind: 'turn';
      seq: number;
      at: string;
      index: number;
      purpose: string;
      detail: string;
      children: Item[];
    };

export function Transcript({
  events,
  toolCalls,
}: {
  events: readonly RunEvent[];
  toolCalls: readonly ToolCallView[];
}) {
  const items = useMemo(() => build(events, toolCalls), [events, toolCalls]);

  if (items.length === 0) {
    return <div className="empty">还没有内容。任务开始后这里会实时出现。</div>;
  }

  return (
    <div className="transcript">
      {items.map((item) => (
        <Row key={`${item.kind}-${item.seq}`} item={item} />
      ))}
    </div>
  );
}

function build(events: readonly RunEvent[], toolCalls: readonly ToolCallView[]): Item[] {
  const byId = new Map(toolCalls.map((t) => [t.toolCallId, t]));
  const items: Item[] = [];
  const seenTool = new Set<string>();
  let currentTurn: Extract<Item, { kind: 'turn' }> | null = null;
  let turnIndex = 0;

  for (const e of events) {
    switch (e.kind) {
      case 'RUN_CREATED':
        items.push({
          kind: 'text',
          seq: e.seq,
          at: e.at,
          role: 'user',
          text: e.summary.replace(/^任务已创建：/, ''),
        });
        break;

      case 'PLAN_GENERATED': {
        const plan = e.payload.plan as
          | { summary: string; steps: Array<{ index: number; intent: string }>; risks: string[] }
          | undefined;
        items.push({
          kind: 'plan',
          seq: e.seq,
          at: e.at,
          summary: plan?.summary ?? e.summary,
          steps: (plan?.steps ?? []).map((s) => `${s.index}. ${s.intent}`),
          risks: plan?.risks ?? [],
        });
        break;
      }

      case 'MODEL_INVOCATION': {
        // 开一轮新的：此后的工具调用都归到这一轮名下，直到下一次模型调用
        turnIndex += 1;
        const m = /^(\S+)\s+调用\s+(.*)$/.exec(e.summary);
        currentTurn = {
          kind: 'turn',
          seq: e.seq,
          at: e.at,
          index: turnIndex,
          purpose: m?.[1] ?? '模型',
          detail: m?.[2] ?? e.summary,
          children: [],
        };
        items.push(currentTurn);
        break;
      }

      case 'TOOL_CALL_PROPOSED': {
        const id = String(e.payload.toolCallId ?? '');
        const call = byId.get(id);
        if (!call || seenTool.has(id)) break;
        seenTool.add(id);
        const toolItem: Item =
          call.toolName === 'run_command'
            ? { kind: 'command', seq: e.seq, at: e.at, call, outcome: null }
            : { kind: 'tool', seq: e.seq, at: e.at, call };
        // 归到当前这一轮里；没有当前轮（理论上不该发生）就退回平铺，不丢事件
        (currentTurn?.children ?? items).push(toolItem);
        break;
      }

      case 'VERIFICATION_FINISHED': {
        const v = e.payload.verification as
          | { phase: string; passed: boolean; commands: CommandOutcome[] }
          | undefined;
        if (!v) break;
        items.push({
          kind: 'verify',
          seq: e.seq,
          at: e.at,
          phase: v.phase,
          passed: v.passed,
          commands: v.commands,
        });
        break;
      }

      case 'NOTE':
        // 平台的如实标注，不是模型说的话
        items.push({ kind: 'text', seq: e.seq, at: e.at, role: 'platform', text: e.summary });
        break;

      case 'MUTATION_APPLIED':
        items.push({ kind: 'status', seq: e.seq, at: e.at, text: e.summary, tone: 'ok' });
        break;

      case 'PLAN_DECISION':
      case 'PATCH_DECISION':
        items.push({ kind: 'text', seq: e.seq, at: e.at, role: 'user', text: e.summary });
        break;

      case 'PATCH_SEALED':
        items.push({ kind: 'status', seq: e.seq, at: e.at, text: e.summary, tone: 'ok' });
        break;

      case 'SELF_FIX_ROUND':
      case 'BUDGET_EXHAUSTED':
        items.push({ kind: 'status', seq: e.seq, at: e.at, text: e.summary, tone: 'warn' });
        break;

      case 'STATUS_CHANGED': {
        const to = String(e.payload.to ?? '');
        if (to === 'PLANNING' || to === 'EXECUTING' || to === 'VERIFYING') break; // 噪音
        items.push({
          kind: 'status',
          seq: e.seq,
          at: e.at,
          text: e.summary,
          tone:
            to === 'SUCCEEDED'
              ? 'ok'
              : to === 'FAILED' || to === 'TIMED_OUT'
                ? 'err'
                : to === 'ACCEPTED_UNVERIFIED' || to === 'BLOCKED' || to === 'CANCELLED'
                  ? 'warn'
                  : 'info',
        });
        break;
      }

      default:
        break;
    }
  }

  return items;
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case 'text':
      return (
        <div className={`msg ${item.role}`}>
          <div className="msg-gutter">
            {item.role === 'user' ? '你' : item.role === 'agent' ? 'AI' : '平台'}
          </div>
          <div className="msg-body">{item.text}</div>
          <div className="msg-time">{timeOf(item.at)}</div>
        </div>
      );

    case 'plan':
      return (
        <div className="msg agent">
          <div className="msg-gutter">计划</div>
          <div className="msg-body">
            <div style={{ marginBottom: 6 }}>{item.summary}</div>
            <ol className="plan-steps">
              {item.steps.map((s, i) => (
                <li key={i}>{s.replace(/^\d+\.\s*/, '')}</li>
              ))}
            </ol>
            {item.risks.length > 0 && (
              <div style={{ color: 'var(--warn)', fontSize: 11.5, marginTop: 6 }}>
                风险：{item.risks.join('；')}
              </div>
            )}
          </div>
          <div className="msg-time">{timeOf(item.at)}</div>
        </div>
      );

    case 'turn':
      return <TurnBlock item={item} />;

    case 'status':
      return (
        <div className={`trace-line ${item.tone}`}>
          <span>{item.text}</span>
          <span className="msg-time">{timeOf(item.at)}</span>
        </div>
      );

    case 'command':
      return <TerminalBlock call={item.call} at={item.at} />;

    case 'tool':
      return <ToolBlock call={item.call} at={item.at} />;

    case 'verify':
      return (
        <div className="term">
          <div className="term-head">
            <Badge tone={item.phase === 'BASELINE' ? 'default' : 'info'}>{item.phase}</Badge>
            <Badge tone={item.passed ? 'ok' : 'err'}>{item.passed ? 'PASSED' : 'FAILED'}</Badge>
            <span className="spacer" />
            <span className="msg-time">{timeOf(item.at)}</span>
          </div>
          {item.commands.map((c, i) => (
            <CommandOutput key={i} outcome={c} />
          ))}
        </div>
      );
  }
}

/** run_command 的调用：渲染成终端块 */
/**
 * 一轮模型思考及其工具调用。默认折叠成一行摘要 —— 平铺几十条 fs_read
 * 是"信息太杂"的主因；真正要看细节时再展开。
 * 有失败的调用时默认展开：失败不该藏在折叠层里。
 */
function TurnBlock({ item }: { item: Extract<Item, { kind: 'turn' }> }) {
  const calls = item.children.filter((c) => c.kind === 'tool' || c.kind === 'command');
  const failed = calls.filter(
    (c) =>
      (c.kind === 'tool' || c.kind === 'command') &&
      c.call.resolution !== null &&
      c.call.resolution !== 'SUCCEEDED',
  ).length;
  const names = calls
    .map((c) => (c.kind === 'tool' || c.kind === 'command' ? c.call.toolName : ''))
    .filter(Boolean);
  const summary = names.length > 0 ? [...new Set(names)].join(' / ') : '没有工具调用';

  return (
    <details className="turn" open={failed > 0}>
      <summary className="turn-head">
        <span className="turn-index">#{item.index}</span>
        <span className="turn-purpose">{item.purpose}</span>
        <span className="turn-detail">{item.detail}</span>
        <span className="spacer" />
        {calls.length > 0 && (
          <span className={`turn-count ${failed > 0 ? 'bad' : ''}`}>
            {calls.length} 次工具{failed > 0 ? ` · ${failed} 失败` : ''}
          </span>
        )}
        <span className="turn-tools">{summary}</span>
        <span className="msg-time">{timeOf(item.at)}</span>
      </summary>
      <div className="turn-body">
        {item.children.map((c) => (
          <Row key={`${c.kind}-${c.seq}`} item={c} />
        ))}
      </div>
    </details>
  );
}

function TerminalBlock({ call, at }: { call: ToolCallView; at: string }) {
  const outcome = (call.preview ?? '').trim();
  const failed = call.resolution === 'FAILED';
  return (
    <div className="term">
      <div className="term-head">
        <RiskBadge risk={call.risk} />
        <code>{call.argsSummary}</code>
        <span className="spacer" />
        {call.durationMs !== null && <span className="msg-time">{call.durationMs}ms</span>}
        <Badge tone={call.resolution === 'SUCCEEDED' ? 'ok' : failed ? 'err' : 'info'}>
          {call.resolution ?? '运行中'}
        </Badge>
        <span className="msg-time">{timeOf(at)}</span>
      </div>
      {outcome ? (
        <pre className="term-body">{outcome}</pre>
      ) : (
        <pre className="term-body dim">{call.resolution ? '（无输出）' : '执行中…'}</pre>
      )}
    </div>
  );
}

function CommandOutput({ outcome }: { outcome: CommandOutcome }) {
  const body = [outcome.stderrPreview, outcome.stdoutPreview].filter(Boolean).join('\n').trim();
  return (
    <>
      <div className="term-cmd">
        <span className="term-prompt">$</span> {outcome.argv.join(' ') || outcome.commandId}
        <span className="spacer" />
        <span className={outcome.outcome === 'EXIT_ZERO' ? 'ok' : 'err'}>
          {outcome.outcome} · {outcome.durationMs}ms
        </span>
      </div>
      {body && <pre className="term-body">{body}</pre>}
    </>
  );
}

/** 非命令类工具：折叠展示，默认只看一行 */
function ToolBlock({ call, at }: { call: ToolCallView; at: string }) {
  const isMutation = call.toolName === 'workspace_mutate';
  const failed = call.resolution === 'FAILED' || call.resolution === 'DENIED';
  return (
    <details className="toolrow" open={isMutation || failed}>
      <summary>
        <RiskBadge risk={call.risk} />
        <code>{call.toolName}</code>
        <span style={{ color: 'var(--text-dim)' }}>{call.argsSummary}</span>
        <span className="spacer" />
        {call.durationMs !== null && <span className="msg-time">{call.durationMs}ms</span>}
        <Badge tone={call.resolution === 'SUCCEEDED' ? 'ok' : failed ? 'err' : 'info'}>
          {call.resolution ?? '…'}
        </Badge>
        <span className="msg-time">{timeOf(at)}</span>
      </summary>
      <div className="toolrow-body">
        {call.resolutionReason && <div className="toolrow-error">{call.resolutionReason}</div>}
        {call.preview &&
          (call.preview.includes('\n@@') || call.preview.startsWith('@@') ? (
            <DiffView diff={call.preview} />
          ) : (
            <pre className="term-body">{call.preview}</pre>
          ))}
        {call.artifactRef && (
          <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 4 }}>
            完整输出 artifact {call.artifactRef}
          </div>
        )}
      </div>
    </details>
  );
}
