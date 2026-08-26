import { useMemo, useState } from 'react';
import type { CommandOutcome, RunEvent, ToolCallView } from '@shared/domain';
import { Badge, DiffView, ResolutionBadge, RiskBadge, timeOf } from '../components/common';

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
  | { kind: 'phase'; seq: number; at: string; label: string; text: string }
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

/**
 * 一类没有在时间线上单独成行的事件。
 *
 * 分两级，因为它们对用户的意义不同：
 *   omitted —— 这条事件的信息在这个视图里看不到；
 *   merged  —— 事件本身没占一行，但它的内容已经体现在别的行/卡片上。
 *
 * 两级都要报数（不变式：任何截断、过滤、排除都显示数量和原因），但只有 omitted
 * 进主标题。否则每个 Run 都会挂上几十条 TOOL_CALL_RESOLVED 的"省略"提示，
 * 用户很快学会无视这块区域 —— 那时报数就等于没报。
 *
 * `recoverable` 再区分「折叠了，展开就能看」和「投影里根本没有正文」。
 */
interface Omission {
  readonly key: string;
  readonly count: number;
  readonly reason: string;
  readonly recoverable: boolean;
  readonly level: 'omitted' | 'merged';
}

interface Projection {
  readonly items: Item[];
  readonly omissions: Omission[];
}

/**
 * 相位锚点（交互评审 v0.1 #6 / v0.2 P2）：进入规划/执行/验证/交叉审核不再是
 * "被折叠的常规事件"，而是时间线的分组结构 —— 一条安静的分隔行，
 * 让人一眼看出"现在读到的是哪个阶段"。原始 summary 收进 title。
 */
const PHASE_LABEL: Record<string, string> = {
  PLANNING: '规划',
  EXECUTING: '执行',
  VERIFYING: '验证',
  CROSS_REVIEWING: '交叉审核',
};

/**
 * 这些事件不单独成行，但内容在同一个 Run 视图里有归宿：
 * 工具调用的解析结果画在那一行的徽标与预览上，审批在审批卡与停靠条上，
 * 验证开始由验证结束那一行代表，交叉审核由 CrossReviewPanel 呈现。
 */
const MERGED_KINDS = new Set<string>([
  'TOOL_CALL_RESOLVED',
  'TOOL_CALL_APPROVAL_REQUIRED',
  'VERIFICATION_STARTED',
  'CROSS_REVIEW_STARTED',
  'CROSS_REVIEW_ROUND',
  'CROSS_REVIEW_FINISHED',
  // 每一次执行都在 verify_command 那条工具调用行上，这里再列一遍是重复
  'COMMAND_APPROVAL_USED',
]);

export function Transcript({
  events,
  toolCalls,
}: {
  events: readonly RunEvent[];
  toolCalls: readonly ToolCallView[];
}) {
  const { items, omissions } = useMemo(() => build(events, toolCalls), [events, toolCalls]);

  if (items.length === 0 && omissions.length === 0) {
    return <div className="empty">还没有内容。任务开始后这里会实时出现。</div>;
  }

  return (
    <div className="transcript">
      {items.map((item) => (
        <Row key={`${item.kind}-${item.seq}`} item={item} />
      ))}
      <OmissionNotice omissions={omissions} />
    </div>
  );
}

/**
 * 省略披露。
 *
 * 刻意放在时间线末尾而不是折叠进某一行：用户需要在读完之后仍然知道
 * 「我没看到的是哪些、有多少、为什么」，而不是靠发现某个小三角才知道有东西被藏了。
 */
function OmissionNotice({ omissions }: { omissions: readonly Omission[] }) {
  const omitted = omissions.filter((o) => o.level === 'omitted');
  const merged = omissions.filter((o) => o.level === 'merged');
  const omittedTotal = omitted.reduce((sum, o) => sum + o.count, 0);
  const mergedTotal = merged.reduce((sum, o) => sum + o.count, 0);
  if (omittedTotal === 0 && mergedTotal === 0) return null;

  return (
    <div className="transcript-omissions">
      <div className="transcript-omissions-head">
        <span>{omittedTotal > 0 ? `时间线省略了 ${omittedTotal} 条事件` : '没有事件被省略'}</span>
        <span className="spacer" />
      </div>
      {/*
        报数常驻一行，分类明细收进展开层（交互评审 v0.2 N5）——
        解释"省略了什么"的文字不应该比被省略的内容更占注意力。
      */}
      {(omitted.length > 0 || mergedTotal > 0) && (
        <details className="transcript-omissions-detail">
          <summary>省略明细</summary>
          {omitted.length > 0 && (
            <ul className="transcript-omissions-list">
              {omitted.map((o) => (
                <li key={o.key}>
                  {o.count} 条 · {o.reason}
                  {!o.recoverable && <span className="transcript-omissions-hard">（正文不可恢复）</span>}
                </li>
              ))}
            </ul>
          )}
          {mergedTotal > 0 && (
            <div className="transcript-omissions-merged">
              另有 {mergedTotal} 条事件没有单独成行，但内容已并入对应的行或卡片：
              {merged.map((o) => o.reason).join('；')}
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function build(events: readonly RunEvent[], toolCalls: readonly ToolCallView[]): Projection {
  const byId = new Map(toolCalls.map((t) => [t.toolCallId, t]));
  const items: Item[] = [];
  const seenTool = new Set<string>();
  let currentTurn: Extract<Item, { kind: 'turn' }> | null = null;
  let turnIndex = 0;

  // 省略计数：每一个 `break` 掉的事件都必须落到某个计数器里，不允许静默丢弃。
  let unmatchedTool = 0;
  let duplicateTool = 0;
  /** 平台自己发起的验证命令：有 ToolCall 记录，但正文由验证块呈现，这里只报数 */
  let verifyCommandTool = 0;
  let malformedVerification = 0;
  const unprojectedKinds = new Map<string, number>();
  const mergedKinds = new Map<string, number>();

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

      case 'COMMAND_APPROVAL_BOUND':
        /*
         * 逐条批准过的 R2 命令要有自己的一行。它改变了"这个 Run 允许跑什么"——
         * 混进"省略了 N 条"里，等于把一次授权藏进折叠区。
         */
        items.push({ kind: 'text', seq: e.seq, at: e.at, role: 'platform', text: e.summary });
        break;

      case 'ATTEMPT_STARTED': {
        // Attempt 边界是用户能理解的分隔：从这里往下是"带着你的反馈重做的那一次"
        items.push({
          kind: 'text',
          seq: e.seq,
          at: e.at,
          role: 'platform',
          text: e.summary,
        });
        currentTurn = null; // 新 Attempt 的工具调用不该挂到上一次的模型轮次下
        break;
      }

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
        if (seenTool.has(id)) {
          duplicateTool += 1;
          break;
        }
        if (!call) {
          // 事件是真的，只是 ToolCallView 还没回填或已随进程结束丢失。
          unmatchedTool += 1;
          break;
        }
        seenTool.add(id);
        /*
         * 平台发起的验证命令（verify_command）现在也有 ToolCall 记录（TD §9.4 同一账本）。
         * 但它的结果已经由下面的 VERIFICATION_FINISHED 块逐条呈现 —— 再画一行等于同一件事说两遍。
         * 所以这里合并、报数、在省略说明里点名，而不是静默丢掉，也不是重复展示。
         */
        if (call.toolName === 'verify_command') {
          verifyCommandTool += 1;
          break;
        }
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
        if (!v) {
          malformedVerification += 1;
          break;
        }
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
        // 进入某个工作相位 → 分组锚点；终态与待决状态仍是完整的状态行
        if (PHASE_LABEL[to]) {
          items.push({ kind: 'phase', seq: e.seq, at: e.at, label: PHASE_LABEL[to], text: e.summary });
          break;
        }
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
        /*
         * 时间线只投影了一部分事件种类。哪一类都要落账，但要分清
         * 「内容在别的行上」和「这个视图里真的看不到」——把两者混成一句
         * "省略了 N 条"，等于每个 Run 都拉响一次不需要处理的警报。
         */
        if (MERGED_KINDS.has(e.kind)) {
          mergedKinds.set(e.kind, (mergedKinds.get(e.kind) ?? 0) + 1);
        } else {
          unprojectedKinds.set(e.kind, (unprojectedKinds.get(e.kind) ?? 0) + 1);
        }
        break;
    }
  }

  const omissions: Omission[] = [];
  if (unmatchedTool > 0) {
    omissions.push({
      key: 'unmatched-tool',
      count: unmatchedTool,
      reason: '工具调用事件存在，但对应的调用详情尚未回填或已随进程结束丢失',
      recoverable: false,
      level: 'omitted',
    });
  }
  if (duplicateTool > 0) {
    omissions.push({
      key: 'duplicate-tool',
      count: duplicateTool,
      reason: '同一次工具调用的重复事件引用，只保留首次出现的位置',
      recoverable: false,
      level: 'omitted',
    });
  }
  if (verifyCommandTool > 0) {
    omissions.push({
      key: 'verify-command-tool',
      count: verifyCommandTool,
      reason: '平台发起的验证命令调用（已计入预算账本），结果由下方验证块逐条呈现',
      recoverable: false,
      level: 'merged',
    });
  }
  if (malformedVerification > 0) {
    omissions.push({
      key: 'malformed-verification',
      count: malformedVerification,
      reason: '验证完成事件缺少 verification 正文，无法确定阶段与命令结果',
      recoverable: false,
      level: 'omitted',
    });
  }
  if (unprojectedKinds.size > 0) {
    const kinds = countedKinds(unprojectedKinds);
    omissions.push({
      key: 'unprojected-kinds',
      count: kinds.total,
      reason: `未投影到时间线、且这个视图里没有其他呈现的事件种类：${kinds.text}`,
      recoverable: false,
      level: 'omitted',
    });
  }
  if (mergedKinds.size > 0) {
    const kinds = countedKinds(mergedKinds);
    omissions.push({
      key: 'merged-kinds',
      count: kinds.total,
      reason: kinds.text,
      recoverable: false,
      level: 'merged',
    });
  }

  return { items, omissions };
}

function countedKinds(counts: Map<string, number>): { total: number; text: string } {
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    total: sorted.reduce((sum, [, count]) => sum + count, 0),
    text: sorted.map(([kind, count]) => `${kind}×${count}`).join('、'),
  };
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
              <div style={{ color: 'var(--state-warning-fg)', fontSize: 11.5, marginTop: 6 }}>
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

    case 'phase':
      // 相位锚点：分组结构，不是又一条消息 —— 安静的分隔行，原文在 title
      return (
        <div className="phase-anchor" role="separator" title={item.text} aria-label={`进入${item.label}阶段`}>
          <span className="phase-anchor-label">{item.label}</span>
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
            <span title={item.phase}>
              <Badge tone={item.phase === 'BASELINE' ? 'default' : 'info'}>
                {item.phase === 'BASELINE' ? '基线验证' : item.phase === 'POST_MUTATION' ? '改后验证' : item.phase}
              </Badge>
            </span>
            <span title={item.passed ? 'PASSED' : 'FAILED'}>
              <Badge tone={item.passed ? 'ok' : 'err'}>{item.passed ? '通过' : '未通过'}</Badge>
            </span>
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

  // 「deepseek-v4-pro (in=12938 out=1485)」：行上留模型名，per-call token 计量
  // 进 title（交互评审 v0.2 N5）—— 总量在用量面板，逐笔在数据出站，这里不再第三遍。
  // 括号必须同时接受全角与半角：Core 的真实 summary 用的是全角（in=…），
  // 只匹配半角曾让这条降噪在真机上从未生效 —— 测试也用半角，恰好互相印证成假绿
  const meter = /^(.*?)\s*[（(](in=.*?)[)）]\s*$/.exec(item.detail);
  const detailText = meter ? meter[1]! : item.detail;
  const detailTitle = meter ? `${meter[1]!} · ${meter[2]!}` : undefined;

  return (
    <details className="turn" open={failed > 0}>
      <summary className="turn-head">
        <span className="turn-index">#{item.index}</span>
        <span className="turn-purpose">{item.purpose}</span>
        <span className="turn-detail" title={detailTitle}>{detailText}</span>
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

/**
 * 终端输出的行数上限（交互评审 v0.1 #6 / v0.2 N10）。
 * 真机实测单块可达 ~1900px，是详情页滚动成本的主源。折叠 + 报数 = 合规省略：
 * 默认前 N 行，剩余行数如实报出，一键展开、可收回 —— 完整输出永远可达。
 * 少量超出（不足 CLAMP+SLACK）不值得折：为省两行放一个按钮，比两行更吵。
 */
const TERM_CLAMP_LINES = 14;
const TERM_CLAMP_SLACK = 4;

function TermOutput({ text, dim = false }: { text: string; dim?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split('\n');
  const clampable = lines.length > TERM_CLAMP_LINES + TERM_CLAMP_SLACK;
  const shown = clampable && !showAll ? lines.slice(0, TERM_CLAMP_LINES).join('\n') : text;
  return (
    <>
      <pre className={`term-body ${dim ? 'dim' : ''}`}>{shown}</pre>
      {clampable && (
        <button className="term-expand" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? `收起到前 ${TERM_CLAMP_LINES} 行` : `还有 ${lines.length - TERM_CLAMP_LINES} 行 —— 展开全部`}
        </button>
      )}
    </>
  );
}

function TerminalBlock({ call, at }: { call: ToolCallView; at: string }) {
  const outcome = (call.preview ?? '').trim();
  return (
    <div className="term">
      <div className="term-head">
        <RiskBadge risk={call.risk} />
        <code>{call.argsSummary}</code>
        <span className="spacer" />
        {call.durationMs !== null && <span className="msg-time">{call.durationMs}ms</span>}
        <ResolutionBadge resolution={call.resolution} />
        <span className="msg-time">{timeOf(at)}</span>
      </div>
      {outcome ? (
        <TermOutput text={outcome} />
      ) : (
        <pre className="term-body dim">{call.resolution ? '（无输出）' : '执行中…'}</pre>
      )}
      <PreviewFooter call={call} />
    </div>
  );
}

/**
 * 预览截断的如实交代。
 *
 * 之前只在 ToolBlock 里显示 artifactRef，而 `previewTruncated` 从来没有出现在界面上 ——
 * 于是「这就是全部输出」和「这是被砍过的开头」看起来一模一样。命令输出尤其危险：
 * 用户会据此判断构建到底失败在哪一步。
 */
function PreviewFooter({ call }: { call: ToolCallView }) {
  if (!call.previewTruncated && !call.artifactRef) return null;
  return (
    <div className="preview-footer">
      {call.previewTruncated && <span>上面只是预览，正文已被截断。</span>}
      {call.artifactRef ? (
        <span>
          完整输出见 artifact <code>{call.artifactRef}</code>
        </span>
      ) : (
        call.previewTruncated && <span>这次调用没有封存完整 artifact，被截掉的部分无法找回。</span>
      )}
    </div>
  );
}

/** 命令终局的词典（判别联合的六个终态说人话，raw 进 title —— v0.2 N7 同一红线） */
const COMMAND_OUTCOME_TEXT: Record<string, string> = {
  EXIT_ZERO: '退出 0',
  EXIT_NONZERO: '非零退出',
  SIGNAL: '被信号终止',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
  SPAWN_ERROR: '无法启动',
};

function CommandOutput({ outcome }: { outcome: CommandOutcome }) {
  const body = [outcome.stderrPreview, outcome.stdoutPreview].filter(Boolean).join('\n').trim();
  return (
    <>
      <div className="term-cmd">
        <span className="term-prompt">$</span> {outcome.argv.join(' ') || outcome.commandId}
        <span className="spacer" />
        <span className={outcome.outcome === 'EXIT_ZERO' ? 'ok' : 'err'} title={outcome.outcome}>
          {COMMAND_OUTCOME_TEXT[outcome.outcome] ?? outcome.outcome} · {outcome.durationMs}ms
        </span>
      </div>
      {body && <TermOutput text={body} />}
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
        <span style={{ color: 'var(--text-secondary)' }}>{call.argsSummary}</span>
        <span className="spacer" />
        {call.durationMs !== null && <span className="msg-time">{call.durationMs}ms</span>}
        <ResolutionBadge resolution={call.resolution} />
        <span className="msg-time">{timeOf(at)}</span>
      </summary>
      <div className="toolrow-body">
        {call.resolutionReason && <div className="toolrow-error">{call.resolutionReason}</div>}
        {call.preview &&
          (call.preview.includes('\n@@') || call.preview.startsWith('@@') ? (
            <DiffView diff={call.preview} />
          ) : (
            <TermOutput text={call.preview} />
          ))}
        <PreviewFooter call={call} />
      </div>
    </details>
  );
}
