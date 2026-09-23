import { useEffect, useState, type ReactNode } from 'react';
import type { DoctorStatus, RunStatus, ToolCallResolution, ToolRisk } from '@shared/domain';

export function Badge({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'ok' | 'warn' | 'err' | 'info' | 'purple';
  children: ReactNode;
}) {
  return <span className={`badge ${tone === 'default' ? '' : tone}`}>{children}</span>;
}

/**
 * 状态展示成人话，raw status 收进 title。
 * 「待你审批 / 待你审查补丁」刻意带"你"字 —— 这两个状态在等的是用户，
 * 不是系统；之前显示英文 AWAITING_PLAN_APPROVAL，用户看不出球在自己这边。
 */
const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  CREATED: '已创建',
  PLANNING: '规划中',
  AWAITING_PLAN_APPROVAL: '待你审批',
  EXECUTING: '执行中',
  VERIFYING: '验证中',
  CROSS_REVIEWING: '交叉审核中',
  AWAITING_HANDOFF: '待继续下一步',
  AWAITING_PATCH_REVIEW: '待你审查补丁',
  SUCCEEDED: '成功',
  ACCEPTED_UNVERIFIED: '已接受·未验证',
  FAILED: '失败',
  BLOCKED: '被阻断',
  CANCELLED: '已取消',
  TIMED_OUT: '超时',
  INTERRUPTED: '被打断',
};

/** 状态 → 色调。一处定义，Badge 与列表层状态点两处消费 —— 复制会漂移 */
export function runStatusTone(status: RunStatus): 'ok' | 'warn' | 'err' | 'purple' | 'info' {
  return status === 'SUCCEEDED'
    ? 'ok'
    : // 接受了但没验证 —— 视觉上必须与 SUCCEEDED 区分开
      status === 'ACCEPTED_UNVERIFIED'
      ? 'warn'
      : status === 'FAILED' || status === 'TIMED_OUT'
        ? 'err'
        : status === 'BLOCKED' || status === 'CANCELLED' || status === 'INTERRUPTED'
          ? 'warn'
          : status === 'AWAITING_PLAN_APPROVAL' || status === 'AWAITING_HANDOFF' || status === 'AWAITING_PATCH_REVIEW'
            ? 'purple'
            : 'info';
}

export function runStatusText(status: RunStatus): string {
  return RUN_STATUS_TEXT[status] ?? status;
}

/**
 * 相对时间：只给列表层用（"多久之前"一眼可读）。
 * 绝对时间仍在详情页 —— 相对时间是降噪手段，不是事实的替代。
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
  return iso.slice(5, 10);
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span title={status}>
      <Badge tone={runStatusTone(status)}>{RUN_STATUS_TEXT[status] ?? status}</Badge>
    </span>
  );
}

/** R0–R4 是内部分级代号，光秃秃地印出来没人看得懂 —— 代号保留，语义进 title（v0.2 N7） */
const TOOL_RISK_TITLE: Record<ToolRisk, string> = {
  R0: 'R0 · 只读操作',
  R1: 'R1 · 构建/测试/类型检查类命令，允许执行',
  R2: 'R2 · 安装/网络/服务类，需要一次性精确批准',
  R3: 'R3 · 删除/覆盖/权限类，平台拒绝执行',
  R4: 'R4 · push/发布/凭据类，平台拒绝执行',
};

export function RiskBadge({ risk }: { risk: ToolRisk }) {
  const tone = risk === 'R0' ? 'default' : risk === 'R1' ? 'info' : risk === 'R2' ? 'warn' : 'err';
  return (
    <span title={TOOL_RISK_TITLE[risk] ?? risk}>
      <Badge tone={tone}>{risk}</Badge>
    </span>
  );
}

/**
 * 工具调用结果说人话，raw 枚举进 title。
 * UNKNOWN_RECONCILING 不是失败 —— 是"断连期间结果没拿到、正在对账"，
 * 用紫色（信号缺失）而不是红色（机器负向终局），红色会让用户误以为要去修它。
 */
const TOOL_RESOLUTION_TEXT: Record<ToolCallResolution, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  DENIED: '被拒绝',
  CANCELLED: '已取消',
  SKIPPED: '已跳过',
  UNKNOWN_RECONCILING: '结果未知 · 对账中',
};

export function ResolutionBadge({ resolution }: { resolution: ToolCallResolution | null }) {
  if (!resolution) return <Badge tone="info">运行中</Badge>;
  const tone =
    resolution === 'SUCCEEDED'
      ? 'ok'
      : resolution === 'UNKNOWN_RECONCILING'
        ? 'purple'
        : resolution === 'FAILED'
          ? 'err'
          : 'warn';
  return (
    <span title={resolution}>
      <Badge tone={tone}>{TOOL_RESOLUTION_TEXT[resolution] ?? resolution}</Badge>
    </span>
  );
}

/** 失败归类的中文词典。原先只在详情页内用，证据页的分布表也要 —— 一处定义两处消费 */
export const FAILURE_CLASS_TEXT: Record<string, string> = {
  VERIFICATION_FAILED: '验证未通过',
  NO_CHANGES: '未产生改动',
  MODEL_INVOCATION_FAILED: '模型调用失败',
  PLANNING_FAILED: '规划失败',
  RUNTIME_ERROR: '运行时异常',
  BUDGET_EXHAUSTED: '预算耗尽',
  EGRESS_BLOCKED: '出站被阻断',
  PLAN_REJECTED: '计划被拒',
  APPROVAL_EXPIRED: '审批过期',
  PATCH_REJECTED: '补丁被拒',
  CHANGES_REQUESTED: '要求修改',
  USER_CANCELLED: '用户取消',
  TIMEOUT: '超时',
  INTERRUPTED: '进程中断',
  INVARIANT_VIOLATION: '平台内部错误',
};

export function failureClassText(failureClass: string): string {
  return FAILURE_CLASS_TEXT[failureClass] ?? failureClass;
}

/**
 * 工具名的中文词典。与 RUN_STATUS_TEXT / TOOL_RISK_TITLE 同一条规矩：
 * 说人话，raw 标识符进 title —— 别处再开一份就会漂。
 *
 * 未登记的工具名原样显示：新工具上线时宁可露出标识符，也不能悄悄显示成别的东西。
 */
const TOOL_NAME_TEXT: Record<string, string> = {
  fs_read: '读取文件',
  fs_glob: '匹配文件',
  fs_grep: '搜索内容',
  fs_list: '列出目录',
  run_command: '运行命令',
  workspace_mutate: '修改文件',
  verify_command: '验证命令',
};

export function toolNameText(toolName: string): string {
  return TOOL_NAME_TEXT[toolName] ?? toolName;
}

/**
 * 工具族：决定时间线上哪些相邻调用可以并成一组。
 *
 *   read   —— 只读探索。这一族最密、最不值得逐条看，是折叠的主要收益来源。
 *   run    —— 模型自己发起的命令。输出重要，但同族相邻的可以并。
 *   mutate —— 改文件。**永远单独成行、永远默认展开**：它是这个产品里
 *             唯一会改变工作区的动作，把它折进"已读取 7 个文件"是不可接受的。
 *   other  —— 未登记的工具，不并组（不确定语义时不做聚合）。
 */
export type ToolFamily = 'read' | 'run' | 'mutate' | 'other';

const TOOL_FAMILY: Record<string, ToolFamily> = {
  fs_read: 'read',
  fs_glob: 'read',
  fs_grep: 'read',
  fs_list: 'read',
  run_command: 'run',
  workspace_mutate: 'mutate',
};

export function toolFamily(toolName: string): ToolFamily {
  return TOOL_FAMILY[toolName] ?? 'other';
}

/**
 * 模型调用的用途。Core 侧的枚举是 PLANNING / EXECUTION / REVIEW（agent.ts 的 Phase），
 * 但时间线上还会出现历史事件里的其他写法，所以未登记的一律原样透出。
 */
const MODEL_PURPOSE_TEXT: Record<string, string> = {
  PLANNING: '规划',
  EXECUTION: '执行',
  EXECUTING: '执行',
  REVIEW: '审核',
  CROSS_REVIEW: '交叉审核',
};

export function modelPurposeText(purpose: string): string {
  return MODEL_PURPOSE_TEXT[purpose] ?? purpose;
}

/**
 * 命令终局的词典（判别联合的六个终态说人话，raw 进 title —— v0.2 N7 同一红线）。
 *
 * 两处消费：平台验证命令的 CommandOutcome，与模型发起 run_command 的 CommandResult。
 * 一处定义 —— 复制会漂，而这六个词恰恰是不变式 5 要求"必须可区分"的那六种。
 */
const COMMAND_OUTCOME_TEXT: Record<string, string> = {
  EXIT_ZERO: '退出 0',
  EXIT_NONZERO: '非零退出',
  SIGNAL: '被信号终止',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
  SPAWN_ERROR: '无法启动',
};

export function commandOutcomeText(outcome: string): string {
  return COMMAND_OUTCOME_TEXT[outcome] ?? outcome;
}

/**
 * 命令终局的一行呈现：非零退出把退出码带上，被信号杀掉把信号名带上。
 * "非零退出"和"非零退出 · 1"对排错的价值差得远。
 */
export function commandResultText(result: {
  outcome: string;
  exitCode: number | null;
  signal: string | null;
}): string {
  const base = commandOutcomeText(result.outcome);
  if (result.outcome === 'EXIT_NONZERO' && result.exitCode !== null) return `${base} · ${result.exitCode}`;
  if (result.outcome === 'SIGNAL' && result.signal) return `${base} · ${result.signal}`;
  return base;
}

/** 恢复态与证据完整性徽标。两者都必须一眼可见，否则用户会把只读当成能续跑。 */
export function RestoredBadge({ run }: { run: { restored: boolean; evidence: string } }) {
  if (run.evidence === 'DAMAGED') return <Badge tone="err">证据损坏</Badge>;
  if (run.evidence === 'EVENTS_AHEAD') {
    // 恢复的 Run 落后一拍是设计内常态：主导事实是「从磁盘恢复」，落后细节进
    // title 与详情页说明。常开的黄徽章会让真警报失去信号（交互评审 v0.2 N4）。
    if (run.restored) {
      return (
        <span title="状态快照落后于事件流（详情页有说明）；时间线完整，以时间线为准">
          <Badge tone="info">已从磁盘恢复</Badge>
        </span>
      );
    }
    return <Badge tone="warn">状态落后于事件</Badge>;
  }
  if (run.restored) return <Badge tone="info">已从磁盘恢复</Badge>;
  return null;
}

export function DoctorBadge({ status }: { status: DoctorStatus }) {
  const tone =
    status === 'READY' ? 'ok' : status === 'DEGRADED' ? 'warn' : status === 'BLOCKED' ? 'err' : 'default';
  return <Badge tone={tone}>{status}</Badge>;
}

export function Card({
  title,
  hint,
  right,
  children,
}: {
  title?: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card">
      {title && (
        <h2 className="row">
          <span>
            {title}
            {hint && <span className="hint">{hint}</span>}
          </span>
          <span className="spacer" />
          {right}
        </h2>
      )}
      {children}
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: 'err' | 'warn' | 'info';
  children: ReactNode;
}) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

/**
 * 高影响动作的两段式确认。
 *
 * 设计要点只有一条：**第一次点击不发请求，只展开后果**。
 * 展开的内容必须是调用方算得出来的事实（会删掉什么、会掉到哪个凭据来源），
 * 不允许出现"预计""大约"这类估算 —— 一个猜出来的影响预览比没有更糟，
 * 因为它同样会被当成承诺。
 *
 * 这个形态照搬 `RunDetail` 里「应用到仓库… → 确认写入仓库」那一处 ——
 * 那是此前整个 Renderer 里唯一的确认，Settings 里一处都没有。
 */
/**
 * 后果的三态。
 *
 * 判别联合，不是「ReactNode | null」。用后者时，"算不出来"只能表达成一个非空的
 * 错误节点，而守卫写的是 `consequence === null` —— 于是**预演失败反而让确认按钮变可点**，
 * 横幅上写着"已阻止执行"，底下的按钮是活的。这不是理论风险，是本切片被审出来的真实缺陷。
 * 三个取值各自对应一种可确认性，类型层面就不允许再把它们混起来。
 */
export type ActionConsequence =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly detail: ReactNode }
  | { readonly kind: 'blocked'; readonly reason: ReactNode };

export function ConfirmAction({
  label,
  confirmLabel,
  busyLabel,
  busy = false,
  disabled = false,
  consequence,
  armKey,
  tone = 'warn',
  onConfirm,
  onArm,
}: {
  label: string;
  confirmLabel: string;
  busyLabel: string;
  busy?: boolean;
  disabled?: boolean;
  consequence: ActionConsequence;
  /**
   * 后果所依据的事实的身份。它一变就自动解除武装。
   *
   * 没有它的话，用户可以「展开后果 → 改掉策略/切换实体 → 确认」，
   * 而横幅上还挂着依据旧事实算出来的那段话 —— 两段式确认反而成了误导的载体。
   */
  armKey?: string;
  tone?: 'warn' | 'err';
  onConfirm: () => void;
  /** 第一次点击时触发，用来去 Core 取真实影响（例如清理预演）。 */
  onArm?: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // 依据变了就退回第一段，强制重新取一次后果。
  useEffect(() => {
    setArmed(false);
  }, [armKey]);

  if (!armed) {
    return (
      <button
        className="danger"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => {
          setArmed(true);
          onArm?.();
        }}
      >
        {busy ? busyLabel : label}
      </button>
    );
  }

  return (
    <div className="confirm-action" role="group" aria-label={`${label}：确认`}>
      <Banner tone={consequence.kind === 'blocked' ? 'err' : tone}>
        {consequence.kind === 'ready' ? (
          consequence.detail
        ) : consequence.kind === 'blocked' ? (
          consequence.reason
        ) : (
          <span aria-busy="true">正在计算这次操作的实际影响…</span>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {/*
            只有 ready 才允许确认。pending = 还不知道后果，blocked = 知道自己算不出来 ——
            两者都不能让用户在不了解结果的情况下按下一个不可撤销的操作。
          */}
          {consequence.kind === 'ready' && (
            <button
              className="danger"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                setArmed(false);
                onConfirm();
              }}
            >
              {busy ? busyLabel : confirmLabel}
            </button>
          )}
          <button disabled={busy} onClick={() => setArmed(false)}>
            {consequence.kind === 'ready' ? '取消' : '关闭'}
          </button>
        </div>
      </Banner>
    </div>
  );
}

/** 简易 diff 着色：只按行首字符区分，不做语法解析 */
export function DiffView({ diff }: { diff: string }) {
  return (
    <div className="diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : '';
        return (
          <div key={i} className={`line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}
