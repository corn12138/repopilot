import { useMemo, useState } from 'react';
import type { CommandOutcome, RunEvent, RunStatus, ToolCallView } from '@shared/domain';
import { isTerminal } from '@shared/domain';
import {
  Badge,
  DiffView,
  ResolutionBadge,
  RiskBadge,
  commandOutcomeText,
  commandResultText,
  modelPurposeText,
  timeOf,
  toolFamily,
  toolNameText,
  type ToolFamily,
} from '../components/common';
import { Prose } from '../components/Prose';

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
  | { kind: 'text'; seq: number; at: string; role: 'user' | 'platform'; text: string }
  /**
   * 模型自己写的话。与 `text` 分开是因为它多背三件事：
   * 说这话的是哪个模型（并组之后仍要留得住归属）、是哪一段用途（规划/执行/审核）、
   * 以及**有没有被截断**（截断必须报数，不能像上一版那样切在第 400 个字符就没了）。
   */
  | {
      kind: 'say';
      seq: number;
      at: string;
      text: string;
      truncated: boolean;
      fullLength: number | null;
      turnIndex: number | null;
      model: string | null;
      purpose: string | null;
    }
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
    }
  /**
   * 若干**相邻**的、同族的、没有正文的模型轮次，并成一组可折叠的调用。
   *
   * 为什么要跨轮：轮次边界是实现细节，用户不关心"模型第几次开口"，只关心
   * "它读了些什么"。一轮一调用时按轮折叠等于没折 —— 每个调用反而多背一个
   * 轮次头。真机上 33 次调用铺成十几张卡片，主因就在这里。
   *
   * 为什么只并"没有正文"的轮次：模型说了话，那段话就是这一组的结论，
   * 必须成为分隔。Layer 2 让正文进时间线之后，这条规则会自动把
   * "读一批 → 说一句 → 再读一批"分成两组，不需要再改这里。
   */
  | {
      kind: 'toolgroup';
      seq: number;
      at: string;
      family: ToolFamily;
      /** 覆盖的轮次序号区间与模型名 —— 并组不能让"这是哪一轮、哪个模型"消失 */
      turnRange: [number, number];
      models: string[];
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
  runStatus = null,
  liveText = '',
}: {
  events: readonly RunEvent[];
  toolCalls: readonly ToolCallView[];
  /**
   * 当前 Run 的状态。非终态时时间线末尾要有活动指示 ——
   * 模型调用期间**一条事件都不发**（MODEL_INVOCATION 在响应回来之后才 emit），
   * 那是整个流程里最长的一段等待，而界面在这段时间里一个像素都不动。
   * 不传（比如证据页的只读投影）就退回纯静态呈现。
   */
  runStatus?: RunStatus | null;
  /**
   * 正在流进来的模型正文。**易失**：它不来自事件流，也不会被写下来 ——
   * 模型这一轮一返回，App 就清空它，同一段话改由 ASSISTANT_MESSAGE 事件接手。
   * 所以这里不会出现"缓冲与事件各显示一遍"。
   */
  liveText?: string;
}) {
  const { items, omissions } = useMemo(() => build(events, toolCalls), [events, toolCalls]);
  const activity = useMemo(
    () => (runStatus && !isTerminal(runStatus) ? describeActivity(runStatus, events, toolCalls) : null),
    [runStatus, events, toolCalls],
  );

  if (items.length === 0 && omissions.length === 0 && !activity && !liveText) {
    return <div className="empty">还没有内容。任务开始后这里会实时出现。</div>;
  }

  return (
    <div className="transcript">
      {items.map((item) => (
        <Row key={`${item.kind}-${item.seq}`} item={item} />
      ))}
      {/*
        正在流进来的这一段。刻意**不**署名 "AI" 的完整形态、也不带归属小字 ——
        它还没说完，也还没被写下来。等这一轮结束，同一段话会以 ASSISTANT_MESSAGE
        的身份重新出现在同一位置，那时才是记录。
      */}
      {liveText && (
        <div className="msg agent live" aria-live="polite">
          <div className="msg-gutter">AI</div>
          <div className="msg-body">
            <Prose text={liveText} />
          </div>
          <div className="msg-time">…</div>
        </div>
      )}
      {activity && <ActivityLine text={activity} />}
      <OmissionNotice omissions={omissions} />
    </div>
  );
}

/**
 * "现在在干什么"。
 *
 * 只从**已有事实**推断，不新造事实：最后一条事件是模型调用就是在等模型，
 * 有未 resolve 的工具调用就是在等那个调用。推不出来时说"进行中"，
 * 而不是编一个具体的动作 —— 界面宁可含糊，也不能替系统撒谎。
 */
function describeActivity(
  status: RunStatus,
  events: readonly RunEvent[],
  toolCalls: readonly ToolCallView[],
): string | null {
  // 等人做决定不是"进行中"：球在用户那边，审批卡自己会说话
  if (status === 'AWAITING_PLAN_APPROVAL' || status === 'AWAITING_PATCH_REVIEW') return null;

  const pending = toolCalls.find((t) => t.resolution === null);
  if (pending) return `正在${toolNameText(pending.toolName)}：${pending.argsSummary}`;

  const last = events[events.length - 1];
  if (last?.kind === 'MODEL_INVOCATION') return '模型正在思考…';
  if (status === 'VERIFYING') return '正在跑验证命令…';
  if (status === 'CROSS_REVIEWING') return '第二个模型正在审补丁…';
  if (status === 'PLANNING') return '模型正在规划…';
  return '进行中…';
}

/**
 * 活动指示只用文字与一个空心点，不做持续动画：
 * styles.css 的动效纪律是"只动 opacity/transform、reduced-motion 下关闭"，
 * 而一个永不停止的 spinner 在这条纪律下没有诚实的实现方式 ——
 * 它还会让"卡住了"和"在跑"长得一模一样。
 */
function ActivityLine({ text }: { text: string }) {
  return (
    <div className="transcript-activity" role="status" aria-live="polite">
      <span className="transcript-activity-dot" aria-hidden="true" />
      <span>{text}</span>
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

      case 'ASSISTANT_MESSAGE': {
        /*
         * 时间线上第一次真的出现"AI"这个说话人。
         *
         * 挂到当前轮次名下（而不是平铺）是为了保住归属：它是哪一轮、哪个模型说的。
         * 渲染时 coalesceTurns 会把它从折叠层里**提出来**放在调用组前面 ——
         * 模型说的话是这一组调用的由头与结论，藏进折叠层等于把最该读的东西收走。
         */
        const say: Item = {
          kind: 'say',
          seq: e.seq,
          at: e.at,
          text: e.summary,
          truncated: e.payload.truncated === true,
          fullLength: typeof e.payload.fullLength === 'number' ? e.payload.fullLength : null,
          turnIndex: currentTurn?.index ?? null,
          model: currentTurn ? splitMeter(currentTurn.detail).text : null,
          purpose: typeof e.payload.purpose === 'string' ? e.payload.purpose : null,
        };
        (currentTurn?.children ?? items).push(say);
        break;
      }

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

  return { items: coalesceTurns(items), omissions };
}

/** 这一轮里真正的工具调用（tool / command 两种呈现形态都算） */
function callsOf(turn: Extract<Item, { kind: 'turn' }>): ToolCallView[] {
  return turn.children
    .filter((c): c is Extract<Item, { kind: 'tool' | 'command' }> => c.kind === 'tool' || c.kind === 'command')
    .map((c) => c.call);
}

/**
 * 这一轮能不能并进组里，能的话属于哪一族。
 *
 * 三条否决：
 *   - 没有调用 → 它是"模型只说了话"的一轮，本身就是分隔，不并；
 *   - 有正文（Layer 2 起会有）→ 那段话是这一组的结论，不能被折进去；
 *   - 族不唯一，或族是 mutate/other → 改文件的调用永远单独成行、默认展开，
 *     未登记的工具语义不明，不做聚合。
 */
function mergeFamilyOf(children: readonly Item[]): ToolFamily | null {
  const calls = children
    .filter((c): c is Extract<Item, { kind: 'tool' | 'command' }> => c.kind === 'tool' || c.kind === 'command')
    .map((c) => c.call);
  if (calls.length === 0) return null;
  const families = new Set(calls.map((c) => toolFamily(c.toolName)));
  if (families.size !== 1) return null;
  const family = [...families][0]!;
  return family === 'read' || family === 'run' ? family : null;
}

/**
 * 把相邻的可并轮次收成 toolgroup。
 *
 * 只合并**紧挨着**的轮次：中间只要出现任何别的行（相位锚点、状态、审批、
 * ATTEMPT_STARTED、模型正文），组就断开 —— 那些行本来就是叙事的断点，
 * 跨过它们合并会把时间顺序弄乱。
 *
 * 单个可并轮次也转成 toolgroup：一轮一调用时，"#7 执行 模型 1 次工具 fs_read"
 * 这样的轮次头没有任何增量信息，换成"读取文件 src/app.ts"才是人能读的。
 */
function coalesceTurns(items: Item[]): Item[] {
  const out: Item[] = [];
  let group: Extract<Item, { kind: 'toolgroup' }> | null = null;

  for (const item of items) {
    if (item.kind !== 'turn') {
      group = null;
      out.push(item);
      continue;
    }

    /*
     * 模型正文从折叠层里**提出来**，放在这一轮的调用之前。
     *
     * 它在 children 里排在调用前面（Core 先 emit ASSISTANT_MESSAGE 再派发工具），
     * 所以提出来之后顺序仍是真的：先说要干什么，再干。
     *
     * 提出来还有第二个作用：它天然断开了折叠组 —— 模型说了话，那段话就是
     * 前一组调用的结论、下一组调用的由头，两组不该并成一坨。这正是
     * 「读一批 → 说一句 → 再读一批」应有的分段，不需要另写规则。
     */
    const says = item.children.filter((c) => c.kind === 'say');
    const rest = item.children.filter((c) => c.kind !== 'say');
    for (const say of says) {
      group = null;
      out.push(say);
    }

    // 只说了话、没调工具：说完就完了，不必再画一张空卡片
    if (rest.length === 0 && says.length > 0) continue;

    const family = mergeFamilyOf(rest);
    if (family === null) {
      group = null;
      out.push(says.length > 0 ? { ...item, children: rest } : item);
      continue;
    }
    if (group && group.family === family) {
      group.children.push(...rest);
      group.turnRange = [group.turnRange[0], item.index];
      if (!group.models.includes(item.detail)) group.models.push(item.detail);
      continue;
    }
    group = {
      kind: 'toolgroup',
      seq: item.seq,
      at: item.at,
      family,
      turnRange: [item.index, item.index],
      models: [item.detail],
      children: [...rest],
    };
    out.push(group);
  }
  return out;
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
          {/* 「AI」这个说话人现在有自己的行（SayRow）—— 这里只剩用户与平台两种 */}
          <div className="msg-gutter">{item.role === 'user' ? '你' : '平台'}</div>
          <div className="msg-body">
            {/*
              用户输入逐字原样显示 —— 那是他自己打的字，重排版会让人怀疑
              发出去的到底是不是这些字。模型与平台的正文走 Markdown 呈现：
              模型写的就是 Markdown，直接 {text} 会把 `**`、反引号、`##`
              当正文印出来。
            */}
            {item.role === 'user' ? item.text : <Prose text={item.text} />}
          </div>
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

    case 'say':
      return <SayRow item={item} />;

    case 'turn':
      return <TurnBlock item={item} />;

    case 'toolgroup':
      return <ToolGroupBlock item={item} />;

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

/**
 * 模型说的话。时间线上唯一署名「AI」的行 —— 别的行要么是用户，要么是平台。
 *
 * 三件事必须一起给：
 *   1. 正文按 Markdown 呈现（模型写的就是 Markdown）；
 *   2. 归属（哪一轮、哪个模型、哪一段用途）—— 否则并组之后就说不清是谁说的；
 *   3. **截断如实报数**。上一版切在第 400 个字符且一声不吭，界面上就是半句话没了。
 */
function SayRow({ item }: { item: Extract<Item, { kind: 'say' }> }) {
  const attribution = [
    item.turnIndex !== null ? `#${item.turnIndex}` : null,
    item.purpose ? modelPurposeText(item.purpose) : null,
    item.model,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="msg agent">
      <div className="msg-gutter" title={attribution || undefined}>
        AI
      </div>
      <div className="msg-body">
        <Prose text={item.text} />
        {attribution && <div className="say-attribution">{attribution}</div>}
        {item.truncated && (
          <div className="say-truncated">
            这段话被截断了
            {item.fullLength !== null
              ? `：只显示前 ${item.text.length} 字，原文共 ${item.fullLength} 字`
              : ''}
            。完整正文没有被封存，找不回来。
          </div>
        )}
      </div>
      <div className="msg-time">{timeOf(item.at)}</div>
    </div>
  );
}

/**
 * 「deepseek-v4-pro（in=12938 out=1485）」：行上留模型名，per-call token 计量
 * 进 title（交互评审 v0.2 N5）—— 总量在用量面板，逐笔在数据出站，这里不再第三遍。
 * 括号必须同时接受全角与半角：Core 的真实 summary 用的是全角（in=…），
 * 只匹配半角曾让这条降噪在真机上从未生效 —— 测试也用半角，恰好互相印证成假绿。
 */
function splitMeter(detail: string): { text: string; title: string | undefined } {
  const meter = /^(.*?)\s*[（(](in=.*?)[)）]\s*$/.exec(detail);
  return meter
    ? { text: meter[1]!, title: `${meter[1]!} · ${meter[2]!}` }
    : { text: detail, title: undefined };
}

function failedCount(calls: readonly ToolCallView[]): number {
  return calls.filter((c) => c.resolution !== null && c.resolution !== 'SUCCEEDED').length;
}

/**
 * 一组调用的标题。目标是**读起来像一句话**，而不是把内部标识符抄一遍：
 * 参照物那行是「已读取 MEMORY.md」「Ran 2 commands」，不是「fs_read / run_command」。
 *
 * 只有一次调用时连参数一起写进标题 —— 那种情况折叠头就是全部信息，
 * 逼人点开只为看一个文件名是纯粹的摩擦。
 */
function groupTitle(family: ToolFamily, calls: readonly ToolCallView[]): string {
  if (calls.length === 1) {
    const only = calls[0]!;
    return `${toolNameText(only.toolName)} ${only.argsSummary}`.trim();
  }
  if (family === 'run') {
    /*
     * 命令组的标题带上"有几条没退出 0"。只数拿得到终局的那些 ——
     * 旧记录没有 commandResult，不能把"不知道"算进"通过"。
     */
    const bad = calls.filter((c) => c.commandResult && c.commandResult.outcome !== 'EXIT_ZERO').length;
    return bad > 0
      ? `运行命令 · ${calls.length} 条 · ${bad} 条未退出 0`
      : `运行命令 · ${calls.length} 条`;
  }
  const names = new Set(calls.map((c) => c.toolName));
  if (names.size === 1) return `${toolNameText([...names][0]!)} · ${calls.length} 次`;
  return `读取与搜索 · ${calls.length} 次`;
}

/**
 * 一组相邻的同族调用。
 *
 * 默认开合按"这一族的输出值不值得直接看"决定，而不是一刀切：
 *   read —— 默认收起。这是噪声的主体：几十条 fs_read 铺开正是"啥也看不出来"的来源。
 *   run  —— 默认展开。命令输出通常就是用户要找的东西（构建到底错在哪一行），
 *           把它藏进折叠层等于把信号也一起收走。
 * 任何一条失败都强制展开 —— 失败不该藏在折叠层里。
 */
function ToolGroupBlock({ item }: { item: Extract<Item, { kind: 'toolgroup' }> }) {
  const calls = item.children
    .filter((c): c is Extract<Item, { kind: 'tool' | 'command' }> => c.kind === 'tool' || c.kind === 'command')
    .map((c) => c.call);
  const failed = failedCount(calls);
  const [from, to] = item.turnRange;
  // 并组不能让"这是哪几轮、哪个模型"消失：区间与模型名进 title
  const turns = from === to ? `#${from}` : `#${from}–#${to}`;
  const models = item.models.map((m) => splitMeter(m).title ?? m).join('；');

  return (
    <details className={`toolgroup ${item.family}`} open={failed > 0 || item.family === 'run'}>
      <summary className="toolgroup-head" title={`${turns} · ${models}`}>
        <span className="toolgroup-title">{groupTitle(item.family, calls)}</span>
        <span className="spacer" />
        {failed > 0 && <span className="toolgroup-failed">{failed} 失败</span>}
        {from !== to && <span className="toolgroup-turns">{to - from + 1} 轮</span>}
        <span className="msg-time">{timeOf(item.at)}</span>
      </summary>
      <div className="toolgroup-body">
        {item.children.map((c) => (
          <Row key={`${c.kind}-${c.seq}`} item={c} />
        ))}
      </div>
    </details>
  );
}

/**
 * 一轮模型思考，**没有**并进 toolgroup 的那种：要么它没调工具（只说了话），
 * 要么它这一轮里同时干了不同族的事（比如既读了文件又改了文件）。
 *
 * 没有调用的那一轮不画成卡片，只留一条安静的行。之前它渲染成一张写着
 * "没有工具调用"的折叠卡 —— 一整张卡片用来说"这里什么都没有"，
 * 正是真机截图里最刺眼的那一块。Layer 2 让模型正文进时间线之后，
 * 这一行会长出内容；在那之前它至少不该占着版面喊空。
 */
function TurnBlock({ item }: { item: Extract<Item, { kind: 'turn' }> }) {
  const calls = callsOf(item);
  const failed = failedCount(calls);
  const { text: detailText, title: detailTitle } = splitMeter(item.detail);
  const purpose = modelPurposeText(item.purpose);

  if (calls.length === 0) {
    return (
      <div className="turn-quiet">
        <span className="turn-index">#{item.index}</span>
        <span className="turn-purpose" title={item.purpose}>
          {purpose}
        </span>
        <span className="turn-detail" title={detailTitle}>
          {detailText}
        </span>
        <span className="spacer" />
        <span className="msg-time">{timeOf(item.at)}</span>
      </div>
    );
  }

  return (
    <details className="turn" open={failed > 0}>
      <summary className="turn-head">
        <span className="turn-index">#{item.index}</span>
        <span className="turn-purpose" title={item.purpose}>
          {purpose}
        </span>
        <span className="turn-detail" title={detailTitle}>
          {detailText}
        </span>
        <span className="spacer" />
        <span className={`turn-count ${failed > 0 ? 'bad' : ''}`}>
          {calls.length} 次工具{failed > 0 ? ` · ${failed} 失败` : ''}
        </span>
        <span className="turn-tools">
          {[...new Set(calls.map((c) => toolNameText(c.toolName)))].join(' / ')}
        </span>
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
        {/*
          终局的判别联合，不是布尔（不变式 5）。之前这里只有"成功/失败"徽章 ——
          "退出码 1"、"被信号杀掉"、"超时"、"根本没起来"长得一模一样，
          而这四种要采取的行动完全不同。commandResult 缺失（旧记录）时不猜，
          仍然只显示徽章。
        */}
        {call.commandResult && (
          <span
            className={call.commandResult.outcome === 'EXIT_ZERO' ? 'ok' : 'err'}
            title={call.commandResult.outcome}
          >
            {commandResultText(call.commandResult)}
          </span>
        )}
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

function CommandOutput({ outcome }: { outcome: CommandOutcome }) {
  const body = [outcome.stderrPreview, outcome.stdoutPreview].filter(Boolean).join('\n').trim();
  return (
    <>
      <div className="term-cmd">
        <span className="term-prompt">$</span> {outcome.argv.join(' ') || outcome.commandId}
        <span className="spacer" />
        <span className={outcome.outcome === 'EXIT_ZERO' ? 'ok' : 'err'} title={outcome.outcome}>
          {commandOutcomeText(outcome.outcome)} · {outcome.durationMs}ms
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
        {/* 说人话，raw 工具名进 title —— 与 RUN_STATUS_TEXT / RiskBadge 同一条规矩 */}
        <span className="toolrow-name" title={call.toolName}>
          {toolNameText(call.toolName)}
        </span>
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
