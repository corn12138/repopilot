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
  AWAITING_PATCH_REVIEW: '待你审查补丁',
  SUCCEEDED: '成功',
  ACCEPTED_UNVERIFIED: '已接受·未验证',
  FAILED: '失败',
  BLOCKED: '被阻断',
  CANCELLED: '已取消',
  TIMED_OUT: '超时',
  INTERRUPTED: '被打断',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const tone =
    status === 'SUCCEEDED'
      ? 'ok'
      : // 接受了但没验证 —— 视觉上必须与 SUCCEEDED 区分开
        status === 'ACCEPTED_UNVERIFIED'
        ? 'warn'
        : status === 'FAILED' || status === 'TIMED_OUT'
          ? 'err'
          : status === 'BLOCKED' || status === 'CANCELLED' || status === 'INTERRUPTED'
            ? 'warn'
            : status === 'AWAITING_PLAN_APPROVAL' || status === 'AWAITING_PATCH_REVIEW'
              ? 'purple'
              : 'info';
  return (
    <span title={status}>
      <Badge tone={tone}>{RUN_STATUS_TEXT[status] ?? status}</Badge>
    </span>
  );
}

export function RiskBadge({ risk }: { risk: ToolRisk }) {
  const tone = risk === 'R0' ? 'default' : risk === 'R1' ? 'info' : risk === 'R2' ? 'warn' : 'err';
  return <Badge tone={tone}>{risk}</Badge>;
}

export function ResolutionBadge({ resolution }: { resolution: ToolCallResolution | null }) {
  if (!resolution) return <Badge tone="info">运行中</Badge>;
  const tone =
    resolution === 'SUCCEEDED'
      ? 'ok'
      : resolution === 'FAILED' || resolution === 'UNKNOWN_RECONCILING'
        ? 'err'
        : 'warn';
  return <Badge tone={tone}>{resolution}</Badge>;
}

/** 恢复态与证据完整性徽标。两者都必须一眼可见，否则用户会把只读当成能续跑。 */
export function RestoredBadge({ run }: { run: { restored: boolean; evidence: string } }) {
  if (run.evidence === 'DAMAGED') return <Badge tone="err">证据损坏</Badge>;
  if (run.evidence === 'EVENTS_AHEAD') return <Badge tone="warn">状态落后于事件</Badge>;
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
