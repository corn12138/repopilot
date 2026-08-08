import type { ReactNode } from 'react';
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
  return <Badge tone={tone}>{status}</Badge>;
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
