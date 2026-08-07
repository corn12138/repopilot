import { useMemo } from 'react';
import type { CommandOutcome, RunEvent, ToolCallView } from '@shared/domain';
import { Badge, DiffView, RiskBadge, timeOf } from '../components/common';

/**
 * 把持久化事件和工具调用合并成一条按时间排列的对话流。
 *
 * 数据源仍然是 Core 的事件日志 —— 这里只做投影，不产生任何新事实。
 * 一次工具调用的"提出"和"结束"是两条事件，在这里合并成一个块，
 * 命令类调用额外渲染成终端样式。
 */

type Item =
  | { kind: 'text'; seq: number; at: string; role: 'user' | 'agent' | 'system'; text: string }
  | { kind: 'plan'; seq: number; at: string; summary: string; steps: string[]; risks: string[] }
  | { kind: 'tool'; seq: number; at: string; call: ToolCallView }
  | { kind: 'command'; seq: number; at: string; call: ToolCallView; outcome: CommandOutcome | null }
  | { kind: 'verify'; seq: number; at: string; phase: string; passed: boolean; commands: CommandOutcome[] }
  | { kind: 'model'; seq: number; at: string; text: string }
  | { kind: 'status'; seq: number; at: string; text: string; tone: 'ok' | 'err' | 'warn' | 'info' };

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

      case 'MODEL_INVOCATION':
        items.push({ kind: 'model', seq: e.seq, at: e.at, text: e.summary });
        break;

      case 'TOOL_CALL_PROPOSED': {
        const id = String(e.payload.toolCallId ?? '');
        const call = byId.get(id);
        if (!call || seenTool.has(id)) break;
        seenTool.add(id);
        items.push(
          call.toolName === 'run_command'
            ? { kind: 'command', seq: e.seq, at: e.at, call, outcome: null }
            : { kind: 'tool', seq: e.seq, at: e.at, call },
        );
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
        items.push({ kind: 'text', seq: e.seq, at: e.at, role: 'agent', text: e.summary });
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
            {item.role === 'user' ? '你' : item.role === 'agent' ? 'AI' : ''}
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

    case 'model':
      return (
        <div className="trace-line">
          <span>{item.text}</span>
          <span className="msg-time">{timeOf(item.at)}</span>
        </div>
      );

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
