import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  CrossReviewRecord,
  PatchArtifact,
  PatchDecisionKind,
  PlanRevision,
  ReviewFinding,
  RunEvent,
  RunView,
  ToolCallView,
  VerificationRun,
} from '@shared/domain';
import { TERMINAL_RUN_STATUSES } from '@shared/domain';
import { call } from '../bridge';
import {
  Badge,
  Banner,
  Card,
  DiffView,
  timeOf,
} from '../components/common';
import {
  createLatestRequestGuard,
  OWNED_ASYNC_IDLE,
  type LatestRequestGuard,
  type OwnedAsyncState,
} from '../ownedAsync';
import type { ApprovalActionController } from '../useApprovalAction';
import { Transcript } from './Transcript';

export function RunDetail({
  run,
  events,
  toolCalls,
  approvals,
  plan,
  patch,
  priorPatches = [],
  verifications,
  approvalAction,
  onError,
  onRefresh,
}: {
  run: RunView;
  events: RunEvent[];
  toolCalls: ToolCallView[];
  approvals: ApprovalRequest[];
  plan: PlanRevision | null;
  patch: PatchArtifact | null;
  /** 被 REQUEST_CHANGES 掉的历史补丁；用户否掉的那一版仍要能翻出来看 */
  priorPatches?: readonly PatchArtifact[];
  verifications: VerificationRun[];
  approvalAction: ApprovalActionController;
  onError: (err: unknown) => void;
  onRefresh: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const active = !TERMINAL_RUN_STATUSES.includes(run.status);

  const crossReviewRequestsRef = useRef<LatestRequestGuard<string> | null>(null);
  if (crossReviewRequestsRef.current === null) {
    crossReviewRequestsRef.current = createLatestRequestGuard<string>();
  }
  const crossReviewRequests = crossReviewRequestsRef.current;
  const [crossReviewState, setCrossReviewState] = useState<
    OwnedAsyncState<string, CrossReviewRecord | null, string>
  >(OWNED_ASYNC_IDLE);

  // 交叉审核记录随 Run 状态变化拉取（进行中会从 CROSS_REVIEWING 变到终态）。
  useEffect(() => {
    const identity = crossReviewRequests.begin(run.runId);
    setCrossReviewState({ status: 'loading', ...identity });
    void call('crossreview.get', { runId: run.runId })
      .then((r) => {
        // runId 还不够：同一 Run 的较新状态刷新也必须压过旧请求，避免旧审核记录回流。
        if (!crossReviewRequests.isLatest(identity)) return;
        setCrossReviewState({ status: 'ready', ...identity, data: r.crossReview });
      })
      .catch((error: unknown) => {
        if (!crossReviewRequests.isLatest(identity)) return;
        setCrossReviewState({
          status: 'error',
          ...identity,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      if (crossReviewRequests.isLatest(identity)) crossReviewRequests.invalidate();
    };
  }, [crossReviewRequests, run.runId, run.status]);

  // 渲染时再核对 owner，使 Run B 连一帧 Run A 的审核记录都不会接手。
  const ownedCrossReviewState =
    crossReviewState.status !== 'idle' && crossReviewState.ownerId === run.runId
      ? crossReviewState
      : null;
  const crossReview =
    ownedCrossReviewState?.status === 'ready' ? ownedCrossReviewState.data : null;
  const crossReviewError =
    ownedCrossReviewState?.status === 'error' ? ownedCrossReviewState.error : null;

  /*
   * 取消是一次有明确目标的危险动作，所以它的 busy 与失败必须留在按钮旁边，
   * 而不是只飞到页面顶部的通用错误条里 —— 长页面下用户根本看不到那里发生了什么。
   * 单航班：请求在途时不接受第二次点击，避免向同一个 Run 连发取消。
   */
  const [cancelState, setCancelState] = useState<
    | { readonly status: 'idle' }
    | { readonly status: 'pending' }
    | { readonly status: 'failed'; readonly message: string }
  >({ status: 'idle' });

  const cancel = async () => {
    if (cancelState.status === 'pending') return;
    setCancelState({ status: 'pending' });
    try {
      await call('run.cancel', { runId: run.runId, reason: '用户在 UI 中取消' });
      setCancelState({ status: 'idle' });
    } catch (err) {
      setCancelState({
        status: 'failed',
        message: err instanceof Error ? err.message : '取消请求失败',
      });
      onError(err);
    }
  };

  return (
    // 入场只有 opacity + 4px transform，不改变任何布局事实；reduced-motion 下自动关闭。
    <div className="rp-enter">
      <Card
        title="运行"
        hint={`${run.runId} · gen-${run.workspaceGeneration}`}
        right={
          <div className="row">
            <button onClick={onRefresh}>刷新</button>
            {active && (
              <button
                className="danger"
                disabled={cancelState.status === 'pending'}
                aria-busy={cancelState.status === 'pending'}
                onClick={() => void cancel()}
              >
                {cancelState.status === 'pending' ? '取消中…' : '取消'}
              </button>
            )}
          </div>
        }
      >
        {cancelState.status === 'failed' && (
          <div role="alert">
            <Banner tone="err">
              <strong>取消失败：{cancelState.message}</strong>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => void cancel()}>重试取消</button>
                <button onClick={() => setCancelState({ status: 'idle' })}>收起</button>
              </div>
            </Banner>
          </div>
        )}
        {/*
          每个事实只有一个主场（交互评审 v0.2 N2）：状态与证据徽章归 ChatHead，
          四项 m/n 计量与墙钟归用量面板（顶栏用量 chip 点开），gen 收进卡片 hint。
          这张卡只保留别处没有的判定：失败归类。
        */}
        {run.failureClass && (
          <div className="row wrap" style={{ marginBottom: 12 }}>
            <FailureClassBadge failureClass={run.failureClass} />
          </div>
        )}

        {run.evidence === 'DAMAGED' && (
          <Banner tone="err">
            <strong>状态快照损坏，只能展示事件流。</strong>
            {run.evidenceDetail && <div style={{ marginTop: 4 }}>{run.evidenceDetail}</div>}
            <div style={{ marginTop: 6 }}>
              补丁内容与验证记录无法恢复，因此不能导出或应用。这个 Run 保留在列表里是为了
              让「曾经跑过一次」这件事本身不丢失。
            </div>
          </Banner>
        )}
        {/*
          恢复的 Run 落后一拍是设计内的正常终局，不是警报（交互评审 v0.2 N4）：
          黄色横幅只留给"活动 Run 真的落后了"；恢复态的落后细节并入恢复说明，
          seq 数字保留在小字里 —— 降层级，不删事实。
        */}
        {run.evidence === 'EVENTS_AHEAD' && !run.restored && (
          <Banner tone="warn">
            <strong>状态快照落后于事件流。</strong>
            {run.evidenceDetail && <div style={{ marginTop: 4 }}>{run.evidenceDetail}</div>}
            <div style={{ marginTop: 6 }}>
              时间线是完整的，但上面的状态、预算和补丁可能不是最后一刻的样子。
            </div>
          </Banner>
        )}
        {run.restored && run.evidence !== 'DAMAGED' && (
          <Banner tone="info">
            该 Run 是从磁盘恢复的。历史、验证记录和补丁都是真的，
            {run.status === 'AWAITING_PATCH_REVIEW'
              ? '补丁仍可接受与导出（这不需要运行中的执行器）。'
              : '但没有运行中的执行器，不能续跑。'}
            工作区文件树不可用 —— 那份隔离副本随进程一起结束了。
            {run.evidence === 'EVENTS_AHEAD' && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                状态快照停在事件流之前{run.evidenceDetail ? `（${run.evidenceDetail}）` : ''}——
                时间线是完整的，以时间线为准。
              </div>
            )}
          </Banner>
        )}

        {run.statusReason && (
          <Banner
            tone={
              run.status === 'SUCCEEDED'
                ? 'info'
                : run.status === 'FAILED' || run.status === 'TIMED_OUT'
                  ? 'err'
                  : 'warn'
            }
          >
            {run.statusReason}
          </Banner>
        )}

        {run.terminalFacts && (
          <dl className="kv">
            <dt>verification</dt>
            <dd>{run.terminalFacts.verificationRunId}</dd>
            <dt>patch acceptance</dt>
            <dd>{run.terminalFacts.patchAcceptanceId}</dd>
          </dl>
        )}
      </Card>

      {approvals.length > 0 && plan && run.status === 'AWAITING_PLAN_APPROVAL' && (
        <div id="plan-approval-card">
          <PlanApproval approval={approvals[0]!} plan={plan} action={approvalAction} />
        </div>
      )}

      {run.status === 'CROSS_REVIEWING' && (
        <Banner tone="info">第二个模型正在只读交叉审核这个补丁…</Banner>
      )}

      {crossReviewError && (
        <Banner tone="err">交叉审核记录读取失败：{crossReviewError}</Banner>
      )}

      {crossReview && <CrossReviewPanel record={crossReview} />}

      {crossReview && (
        <CrossReviewContinueGate
          key={run.runId}
          run={run}
          record={crossReview}
          onError={onError}
        />
      )}

      {patch && (
        <div id="patch-review-card">
          {/* patchId 是确认动作边界；A 的确认、busy、说明状态都不能进入 B。 */}
          <PatchReview
            key={patch.patchId}
            patch={patch}
            canDecide={run.status === 'AWAITING_PATCH_REVIEW'}
            accepted={run.status === 'SUCCEEDED' || run.status === 'ACCEPTED_UNVERIFIED'}
            restored={run.restored}
            salvage={
              run.status === 'FAILED' || run.status === 'BLOCKED' || run.status === 'CANCELLED'
            }
            onError={onError}
          />
        </div>
      )}

      {priorPatches.length > 0 && <PriorPatchesPanel patches={priorPatches} />}

      {verifications.length > 0 && <VerificationPanel verifications={verifications} />}

      <EgressPanel events={events} />

      <Card
        title="对话"
        hint={`${events.length} 条持久化事件 · ${toolCalls.length} 次工具调用`}
        right={
          <button onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? '看对话' : '看原始事件'}
          </button>
        }
      >
        {showRaw ? (
          <div className="timeline">
            {events.map((e) => (
              <div key={e.seq} className="event">
                <span className="time">{timeOf(e.at)}</span>
                <span className="kind">{e.kind}</span>
                <span className="summary">{e.summary}</span>
              </div>
            ))}
            {events.length === 0 && <div className="empty">暂无事件</div>}
          </div>
        ) : (
          <Transcript events={events} toolCalls={toolCalls} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** 失败归类的中文标签；raw 枚举收进 title 悬停可见（与状态徽章同一约定） */
const FAILURE_CLASS_TEXT: Record<string, string> = {
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

function FailureClassBadge({ failureClass }: { failureClass: string }) {
  return (
    <span title={failureClass}>
      <Badge tone="err">{FAILURE_CLASS_TEXT[failureClass] ?? failureClass}</Badge>
    </span>
  );
}

function PlanApproval({
  approval,
  plan,
  action,
}: {
  approval: ApprovalRequest;
  plan: PlanRevision;
  action: ApprovalActionController;
}) {
  const busy = action.isPending(approval.approvalId);
  const pendingDecision = action.pending.find(
    (item) => item.approvalId === approval.approvalId,
  )?.decision;
  const error = action.error?.approvalId === approval.approvalId ? action.error : null;

  // detail 的首行是计划摘要（已由上面的横幅展示）；其后几行是 Core 附上的"批准范围"：
  // 允许改动的路径、受保护路径、实现方是谁。用户批准的不只是摘要，这些必须在同一张卡上看见。
  const scopeLines = approval.detail.split('\n').slice(1).filter(Boolean);

  return (
    <Card title="待审批计划" hint="批准后才允许产生副作用">
      <Banner tone="info">{plan.summary}</Banner>
      {scopeLines.length > 0 && (
        <div
          data-testid="approval-scope"
          style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.6 }}
        >
          {scopeLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <ol style={{ paddingLeft: 20, fontSize: 12.5, margin: '0 0 12px' }}>
        {plan.steps.map((s) => (
          <li key={s.index} style={{ marginBottom: 6 }}>
            {s.intent}
            {s.targetPaths.length > 0 && (
              <div style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {s.targetPaths.join(', ')}
              </div>
            )}
            {s.expectedEffect && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>预期：{s.expectedEffect}</div>
            )}
          </li>
        ))}
      </ol>

      {plan.risks.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>风险</div>
          <ul className="plain">
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 12 }}>
          <Banner tone="err">
            <strong>{error.message}</strong>
            {error.detail && <div style={{ marginTop: 4 }}>{error.detail}</div>}
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => void action.retry()}>重试这次决定</button>
              <button onClick={action.clearError}>收起</button>
            </div>
          </Banner>
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
          plan digest {plan.digest.slice(7, 27)}…
        </span>
        <span className="spacer" />
        <button
          className="danger"
          disabled={busy}
          onClick={() => void action.decide(approval, 'REJECT')}
        >
          {pendingDecision === 'REJECT' ? '拒绝中…' : '拒绝'}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void action.decide(approval, 'APPROVE')}
        >
          {pendingDecision === 'APPROVE' ? '批准中…' : '批准并执行'}
        </button>
      </div>
    </Card>
  );
}

/**
 * 导出被拒的原因标签。原始 reason 是给日志与统计用的封闭枚举，
 * 但直接甩给用户一句 `FORBIDDEN_ROOT` 等于让他自己去猜 —— 每一条都要说清下一步。
 */
const EXPORT_REASON_LABEL: Record<string, string> = {
  FORBIDDEN_ROOT: '不能存到这里（项目仓库或 RepoPilot 数据目录内）',
  NOT_A_REGULAR_FILE: '目标不是普通文件（符号链接与目录都不覆盖）',
  UNRESOLVABLE: '目标所在目录无法解析',
  WRITE_FAILED: '写入失败',
  CANCELLED: '已取消',
};

function PatchReview({
  patch,
  canDecide,
  accepted,
  salvage,
  restored = false,
  onError,
}: {
  patch: PatchArtifact;
  canDecide: boolean;
  accepted: boolean;
  /** 恢复态的 Run 没有活的执行器：能接受/拒绝，但开不了新的尝试 */
  restored?: boolean;
  /** 失败/中止现场的挽救补丁：只能检视与导出，永远不能被接受 */
  salvage?: boolean;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const runExport = async (mode: 'SAVE_FILE' | 'COPY' | 'APPLY_TO_REPO') => {
    setBusy(true);
    setExportMsg(null);
    try {
      const r = await call('patch.export', {
        runId: patch.runId,
        patchId: patch.patchId,
        mode,
        // 写回宿主仓库时带上 digest，由 Core 比对「应用的」= 「接受的」。
        // SAVE_FILE / COPY 不写仓库，Core 侧忽略。
        patchDigest: patch.digest,
      });
      setExportMsg(
        r.ok
          ? { ok: true, text: `${r.detail}${r.target ? ` → ${r.target}` : ''}` }
          : { ok: false, text: `${EXPORT_REASON_LABEL[r.reason] ?? r.reason}：${r.detail}` },
      );
      if (r.ok) setConfirmApply(false);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: PatchDecisionKind) => {
    setBusy(true);
    try {
      const r = await call('patch.decide', {
        runId: patch.runId,
        patchId: patch.patchId,
        decision,
        patchDigest: patch.digest,
        note,
      });
      if (r.reason) onError(new Error(r.reason));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const added = patch.files.reduce((n, f) => n + f.addedLines, 0);
  const removed = patch.files.reduce((n, f) => n + f.removedLines, 0);

  return (
    <Card
      title={salvage ? '挽救补丁' : '补丁审查'}
      hint={`${patch.files.length} 个文件 · +${added} / -${removed}`}
    >
      {salvage && (
        <Banner tone="warn">
          <strong>这是失败/中止现场的挽救封存。</strong>
          它未被证明正确，<b>不能被接受</b>，也不能一键写回仓库 ——
          只能复制或保存后人工检视、手工挽救。下面的"仍失败/未验证"标注就是它失败时的样子。
        </Banner>
      )}
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {patch.comparison === null ? (
          <Badge tone="err">未经机器验证</Badge>
        ) : (
          <>
            {patch.comparison.fixed.length > 0 && (
              <Badge tone="ok">已修复 {patch.comparison.fixed.join(', ')}</Badge>
            )}
            {patch.comparison.stillFailing.length > 0 && (
              <Badge tone="warn">仍失败 {patch.comparison.stillFailing.join(', ')}</Badge>
            )}
            {patch.comparison.newlyFailing.length > 0 && (
              <Badge tone="err">新增失败 {patch.comparison.newlyFailing.join(', ')}</Badge>
            )}
          </>
        )}
      </div>

      {patch.comparison === null && (
        <Banner tone="warn">
          本次运行没有执行任何验证命令。补丁的正确性<strong>完全</strong>由你判断；
          接受后 Run 终态是 <code>ACCEPTED_UNVERIFIED</code>，不是 <code>SUCCEEDED</code>。
        </Banner>
      )}
      {(patch.verificationInputsTouched?.length ?? 0) > 0 && (
        // 验证"通过"的徽章就在上面，所以这条必须紧挨着它：通过的是被改过的验证
        <Banner tone="warn">
          <strong>补丁修改了验证输入：</strong>
          {patch.verificationInputsTouched!.join('、')}。
          上面的"已修复"是在被改过的配置/测试/验证脚本下跑出来的，<b>不能证明修复正确</b>；
          接受后 Run 终态是 <code>ACCEPTED_UNVERIFIED</code>，不是 <code>SUCCEEDED</code>。
          若任务本来就要改这些文件，请自行核对验证语义没有被放宽。
        </Banner>
      )}

      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>base commit</dt>
        <dd>{patch.baseSha.slice(0, 12)}</dd>
        <dt>patch digest</dt>
        <dd>{patch.digest.slice(7, 33)}…</dd>
        <dt>generation</dt>
        <dd>gen-{patch.generation}</dd>
      </dl>

      {patch.files.map((f) => (
        <details key={f.path} className="toolcall" open={patch.files.length <= 3}>
          <summary>
            <Badge tone={f.changeKind === 'ADDED' ? 'info' : 'default'}>{f.changeKind}</Badge>
            <code>{f.path}</code>
            <span className="spacer" style={{ flex: 1 }} />
            <span style={{ color: 'var(--state-verified-fg)', fontSize: 11 }}>+{f.addedLines}</span>
            <span style={{ color: 'var(--state-failed-fg)', fontSize: 11 }}>-{f.removedLines}</span>
          </summary>
          <div className="body">
            <DiffView diff={f.diff} />
            {f.diffTruncated && (
              <div style={{ color: 'var(--state-warning-fg)', fontSize: 11, marginTop: 4 }}>diff 已截断</div>
            )}
          </div>
        </details>
      ))}

      {patch.excludedGeneratedFiles.length > 0 && (
        <details className="toolcall" style={{ marginTop: 10 }}>
          <summary>
            <Badge tone="warn">已排除</Badge>
            <span style={{ color: 'var(--text-secondary)' }}>
              {patch.excludedGeneratedFiles.length} 个由验证命令生成的文件未纳入补丁
            </span>
          </summary>
          <div className="body">
            <pre className="output">{patch.excludedGeneratedFiles.join('\n')}</pre>
          </div>
        </details>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>未验证项（接受前请确认）</div>
        <ul className="plain">
          {patch.unverifiedItems.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
      </div>

      {canDecide && (
        <>
          <div className="field" style={{ marginTop: 14 }}>
            <label>决定说明（拒绝或要求修改时建议填写）</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
          </div>
          <div className="row">
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              接受只是记录你的判断；补丁要不要落到仓库，接受之后再单独决定。
            </span>
            <span className="spacer" />
            <button className="danger" disabled={busy} onClick={() => void decide('REJECT')}>
              拒绝
            </button>
            <button
              disabled={busy || restored}
              title={
                restored
                  ? '这个 Run 是从磁盘恢复的，没有活的执行器 —— 可以接受或拒绝，但开不了新的尝试'
                  : '开一次新的尝试：带上你的反馈重做，预算与本次共用'
              }
              onClick={() => void decide('REQUEST_CHANGES')}
            >
              要求修改
            </button>
            <button className="primary" disabled={busy} onClick={() => void decide('ACCEPT')}>
              接受补丁
            </button>
          </div>
        </>
      )}

      {salvage && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-hairline)' }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 12.5 }}>挽救导出</strong>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              没有「应用到仓库」—— 那条路只对被接受的补丁开放
            </span>
            <span className="spacer" />
            <button disabled={busy} onClick={() => void runExport('COPY')}>
              复制到剪贴板
            </button>
            <button disabled={busy} onClick={() => void runExport('SAVE_FILE')}>
              保存为 .patch
            </button>
          </div>
          {exportMsg && (
            <Banner tone={exportMsg.ok ? 'info' : 'err'}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{exportMsg.text}</span>
            </Banner>
          )}
        </div>
      )}

      {accepted && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-hairline)' }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 12.5 }}>交付</strong>
            <span className="spacer" />
            <button disabled={busy} onClick={() => void runExport('COPY')}>
              复制到剪贴板
            </button>
            <button disabled={busy} onClick={() => void runExport('SAVE_FILE')}>
              保存为 .patch
            </button>
            <button
              className={confirmApply ? 'danger' : ''}
              disabled={busy}
              onClick={() => (confirmApply ? void runExport('APPLY_TO_REPO') : setConfirmApply(true))}
            >
              {confirmApply ? '确认写入仓库' : '应用到仓库…'}
            </button>
          </div>

          {confirmApply && (
            <Banner tone="warn">
              这会<strong>真的修改你的仓库文件</strong>（{patch.files.map((f) => f.path).join('、')}）。
              先跑 <code>git apply --check</code>，有任何冲突就整笔拒绝、一个字节都不写。
              成功后改动不会自动 commit，可以用 <code>git diff</code> 复核或 <code>git checkout -- .</code> 撤销。
              <div style={{ marginTop: 8 }}>
                <button onClick={() => setConfirmApply(false)}>取消</button>
              </div>
            </Banner>
          )}

          {exportMsg && (
            <Banner tone={exportMsg.ok ? 'info' : 'err'}>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  font: 'inherit',
                  fontFamily: exportMsg.ok ? 'inherit' : 'var(--font-mono)',
                  fontSize: exportMsg.ok ? 12.5 : 11,
                }}
              >
                {exportMsg.text}
              </pre>
            </Banner>
          )}
        </div>
      )}

      {!canDecide && !accepted && <Banner tone="info">该补丁已被决定，不能再次决定。</Banner>}
    </Card>
  );
}

const SEVERITY_TONE: Record<ReviewFinding['severity'], 'err' | 'warn' | 'info' | 'default'> = {
  CRITICAL: 'err',
  HIGH: 'err',
  MEDIUM: 'warn',
  LOW: 'info',
  INFO: 'default',
};

const STOP_REASON_LABEL: Record<string, string> = {
  REVIEWER_PASSED: '审核方未发现阻断问题',
  // 与上一行必须读起来就不一样：一个是"看过了"，一个是"没看成"
  REVIEWER_INCONCLUSIVE: '审核方未给出可用结论 —— 这不是"通过"',
  COUNTER_EXHAUSTED: '已用满可自动进行的审核/整改轮次',
  NO_DELTA: '整改后补丁无变化',
  NO_PROGRESS: '整改未产生进展（阻断未减少 / 指纹重现 / 整改后验证失败）',
  REVIEWER_UNAVAILABLE: '审核方不可用',
  BUDGET_EXHAUSTED: '预算耗尽',
  CANCELLED: '已取消',
  ERROR: '审核过程出错',
};

const CONTINUABLE_STOP_REASONS = new Set([
  'COUNTER_EXHAUSTED',
  'NO_PROGRESS',
  'NO_DELTA',
  // 没拿到结论 → "再跑一轮"正是下一步（与 authority.ts 的同名集合保持一致）
  'REVIEWER_INCONCLUSIVE',
]);

/**
 * 循环续期的用户闸门。自动轮次每循环硬上限（2 审 1 改），
 * 跨循环只能由这里的人手推进 —— 这就是"一写一审"互动的防死循环设计：
 * 平台绝不自己"再试一次"，续得越多、警示越重。
 */
function CrossReviewContinueGate({
  run,
  record,
  onError,
}: {
  run: RunView;
  record: CrossReviewRecord;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const continuations = record.userContinuations ?? 0;

  const applicable =
    run.status === 'AWAITING_PATCH_REVIEW' &&
    !run.restored &&
    record.stopReason !== null &&
    CONTINUABLE_STOP_REASONS.has(record.stopReason);
  if (!applicable) return null;

  const lastRound = record.rounds[record.rounds.length - 1];
  const lastBlocking = lastRound?.findings.filter((f) => f.blocking).length ?? 0;

  const requestContinue = async () => {
    setBusy(true);
    try {
      const r = await call('crossreview.continue', { runId: run.runId });
      if (!r.accepted) onError(new Error(r.reason ?? '续期未被接受'));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="要再循环一轮吗" hint="写 → 审 → 改 的续期由你决定">
      <Banner tone={continuations >= 2 ? 'err' : continuations >= 1 ? 'warn' : 'info'}>
        {continuations >= 2 ? (
          <>
            <strong>已手动续期 {continuations} 次仍未收敛。</strong>
            连续多轮"审出问题 → 改 → 再审出问题"通常说明双方在原地打转 ——
            这正是该<b>人工接手</b>的信号：直接审查下方补丁，自己决定接受、拒绝或改需求。
          </>
        ) : (
          <>
            上一循环{lastBlocking > 0 ? `还剩 ${lastBlocking} 条阻断发现` : '未收敛'}。
            你可以授权<b>再跑一轮</b>（最多 2 次审核 + 1 次整改，用完再回到这里），
            也可以直接在下方审查补丁自行决定。自动轮次有硬上限，跨轮只能由你推进 ——
            不存在会自己转下去的循环。
          </>
        )}
      </Banner>
      <div className="row" style={{ marginTop: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          累计：{record.reviewerInvocations} 轮审核 · {record.remediations} 次整改
          {continuations > 0 ? ` · 用户续期 ${continuations} 次` : ''}（计数只增不清）
        </span>
        <span className="spacer" />
        <button className={continuations >= 2 ? '' : 'primary'} disabled={busy} onClick={() => void requestContinue()}>
          {busy ? '启动中…' : '再循环一轮（2 审 1 改）'}
        </button>
      </div>
    </Card>
  );
}

function CrossReviewPanel({ record }: { record: CrossReviewRecord }) {
  const findings = record.rounds.flatMap((r) => r.findings);
  const blocking = findings.filter((f) => f.blocking).length;
  const verdicts = record.rounds.map((r) => r.verdict).join(' → ') || '（无）';
  const multiRound = record.rounds.length > 1;

  return (
    <Card
      title="交叉审核（第二个模型只读）"
      hint={`${record.reviewerInvocations} 轮审核 · ${record.remediations} 次整改${(record.userContinuations ?? 0) > 0 ? ` · 用户续期 ${record.userContinuations} 次` : ''} · ${findings.length} 条发现 · 阻断 ${blocking}`}
      right={
        record.vendorParity ? (
          // 三态如实展示：无法判定不折成"异构"也不折成"同源"
          <Badge tone={record.vendorParity.kind === 'HETEROGENEOUS' ? 'info' : 'warn'}>
            {record.vendorParity.kind === 'HETEROGENEOUS'
              ? '异构审核方'
              : record.vendorParity.kind === 'SAME_VENDOR'
                ? '同厂商审核方'
                : '厂商无法判定'}
          </Badge>
        ) : (
          // 旧持久化记录只有布尔字段，按当年记下的展示，不重写历史
          <Badge tone={record.heterogeneous ? 'info' : 'warn'}>
            {record.heterogeneous ? '异构审核方' : '同源审核方'}
          </Badge>
        )
      }
    >
      {/* 这条免责必须显眼：审核只是第二意见，绝不代表可以接受 */}
      <Banner tone="info">
        这是第二个模型对已封存补丁的只读第二意见，<b>既不是机器验证，也不代表补丁可以接受</b>。
        是否接受仍由你在下方决定。
      </Banner>

      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>结论序列</dt>
        <dd>{verdicts}</dd>
        <dt>结束原因</dt>
        <dd>{record.stopReason ? (STOP_REASON_LABEL[record.stopReason] ?? record.stopReason) : '进行中'}</dd>
        {record.vendorParity && (
          <>
            <dt>厂商同异</dt>
            <dd>{record.vendorParity.detail}</dd>
          </>
        )}
      </dl>

      {findings.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', marginTop: 10 }}>审核方没有提出发现。</p>
      ) : (
        record.rounds.map((round) => (
          <div key={round.round} style={{ marginTop: 10 }}>
            {multiRound && (
              <div className="section-label" style={{ padding: '4px 2px' }}>
                第 {round.round} 轮（{round.verdict}
                {round.round === 1 && record.remediations > 0 ? ' · 之后进行了整改' : ''}） ·
                针对补丁 <code style={{ fontSize: 10.5 }}>{round.reviewedPatchDigest.slice(0, 18)}…</code>
              </div>
            )}
            {round.findings.map((f, i) => (
              <details key={i} className="toolcall" open={f.blocking && round.round === record.rounds.length}>
                <summary>
                  <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                  {f.blocking && <Badge tone="err">阻断</Badge>}
                  <code style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {f.file ?? '（无具体文件）'}
                    {f.range ? `:${f.range[0]}-${f.range[1]}` : ''}
                  </code>
                  <span className="spacer" style={{ flex: 1 }} />
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                    信心 {(f.confidence * 100).toFixed(0)}%
                  </span>
                </summary>
                <div className="body">
                  <p style={{ margin: '6px 0' }}>{f.evidence}</p>
                  {f.reproduction && (
                    <p style={{ margin: '6px 0', color: 'var(--text-secondary)' }}>复现：{f.reproduction}</p>
                  )}
                  {f.suggestedRemediation && (
                    <p style={{ margin: '6px 0', color: 'var(--text-secondary)' }}>
                      建议：{f.suggestedRemediation}
                    </p>
                  )}
                </div>
              </details>
            ))}
            {round.findings.length === 0 && multiRound && (
              <p style={{ color: 'var(--text-secondary)', margin: '4px 2px' }}>本轮没有发现。</p>
            )}
          </div>
        ))
      )}
    </Card>
  );
}

/**
 * 数据出站（PRD-DATA-001/002 的"对等可见"那一半）：用户随时能看到 Agent 把什么送给了谁。
 * 事实只来自持久化事件：RUN_CREATED 里的同意摘要、每次 MODEL_INVOCATION 的 egress manifest、
 * 每次外部 CLI 调用的 invocation manifest。被拦下的（NOT_SENT）与发出去的并列展示，
 * 拦下的原因写在那一行 —— 不存在"只显示成功出站"的过滤。
 */
interface EgressRow {
  readonly key: string;
  readonly at: string;
  readonly who: string;
  readonly where: string;
  readonly sent: boolean | null;
  readonly detail: string;
  readonly tokens: string;
}

function EgressPanel({ events }: { events: RunEvent[] }) {
  const consent = useMemo(() => {
    const created = events.find((e) => e.kind === 'RUN_CREATED');
    return (created?.payload as { egressConsent?: {
      disclosureDigest: string;
      destinations: { role: string; channel: string; label: string; origin: string | null; isRelay: boolean; dataClasses: string[] }[];
      policy: { retention: string; training: string; region: string };
    } } | undefined)?.egressConsent ?? null;
  }, [events]);

  const rows = useMemo<EgressRow[]>(() => {
    const out: EgressRow[] = [];
    for (const e of events) {
      if (e.kind !== 'MODEL_INVOCATION') continue;
      const m = (e.payload as { manifest?: Record<string, unknown> }).manifest;
      if (m) {
        const sent = m.sent === true;
        const attempt = typeof m.sendAttempt === 'number' && m.sendAttempt > 1 ? `（第 ${m.sendAttempt} 次尝试）` : '';
        out.push({
          key: `m-${e.seq}`,
          at: e.at,
          who: `${String(m.purpose)} · 模型 API`,
          where: `${String(m.providerId)} / ${String(m.modelId)} @ ${String(m.origin)}`,
          sent,
          detail: sent
            ? `已发送${attempt}${typeof m.errorKind === 'string' && m.errorKind ? ` · ${m.errorKind}` : ''}`
            : m.blockReason
              ? `未发送 · 出站前阻断：${String(m.blockReason)}`
              : `未发送 · ${String(m.errorKind ?? '连接未建立')}${attempt}`,
          tokens:
            m.inputTokens === null && m.outputTokens === null
              ? sent
                ? 'token 未知（供应商未回报）'
                : '—'
              : `in=${m.inputTokens ?? '?'} out=${m.outputTokens ?? '?'}`,
        });
        continue;
      }
      const x = (e.payload as { externalInvocation?: Record<string, unknown> }).externalInvocation;
      if (x) {
        const state = String(x.state);
        out.push({
          key: `x-${e.seq}`,
          at: e.at,
          who: `${String(x.role) === 'CANDIDATE_AUTHOR' ? `作者 ${String(x.phase ?? '')}`.trim() : '只读审核'} · 本机 CLI`,
          where: `${String(x.connectorId)}（${String(x.vendor)}；端点由 CLI 决定）`,
          sent: state === 'SEALED' || state === 'FAILED' || state === 'TIMED_OUT',
          detail:
            state === 'SEALED'
              ? `已调用并封存${typeof x.changedCount === 'number' ? ` · ${x.changedCount} 处变更` : ''}`
              : state === 'BLOCKED'
                ? `未调用 · 出站前阻断：${String(x.failureDetail ?? '')}`
                : `${state}${x.failureDetail ? ` · ${String(x.failureDetail)}` : ''}`,
          tokens: 'token 未知（CLI 自行计费）',
        });
      }
    }
    return out;
  }, [events]);

  const sentCount = rows.filter((r) => r.sent).length;
  const blockedCount = rows.filter((r) => r.sent === false).length;

  /*
   * 报数常驻卡片头，逐笔明细默认收起（交互评审 v0.2 N3）：同样这些调用在
   * 「对话」卡里已按轮呈现，这里是审计账本，不是每次打开详情的默认视野。
   * 0 笔且无同意记录时不成卡 —— 报数仍在，一行说清。
   */
  if (rows.length === 0 && !consent) {
    return (
      <div className="help" style={{ padding: '4px 2px' }}>
        数据出站 · 0 次 —— 这个 Run 没有任何出站记录，也没有出站同意（早于该合同的历史 Run）。
      </div>
    );
  }

  return (
    <Card title="数据出站" hint={`${sentCount} 次已发出 · ${blockedCount} 次未发出`}>
      <details className="egress-details">
        <summary>出站同意与逐笔明细</summary>
      {consent ? (
        <div className="egress-consent" data-testid="egress-consent">
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            你确认的披露 <code>{consent.disclosureDigest.slice(0, 16)}</code> · 保留/训练/地域政策：
            {[consent.policy.retention, consent.policy.training, consent.policy.region].every((v) => v === 'UNKNOWN') ? '未知' : '见披露'}
          </div>
          <ul className="plain">
            {consent.destinations.map((d, i) => (
              <li key={i}>
                {d.role === 'IMPLEMENTER' ? '实现方' : d.role === 'REVIEWER' ? '审核方' : '作者'} {d.label}
                {d.channel === 'MODEL_API' ? `（${d.isRelay ? '第三方中转' : '官方'} · ${d.origin}）` : '（本机 CLI 自行出站）'} —— {d.dataClasses.join('、')}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="help">这个 Run 没有记录出站同意（早于该合同的历史 Run）。</div>
      )}
      {rows.length === 0 ? (
        <div className="empty">还没有任何出站。</div>
      ) : (
        <div className="egress-rows" data-testid="egress-rows">
          {rows.map((r) => (
            <div key={r.key} className="egress-row" data-sent={r.sent === null ? 'unknown' : r.sent ? 'yes' : 'no'}>
              <span className="time">{timeOf(r.at)}</span>
              <span className="kind">{r.who}</span>
              <span className="summary">
                {r.where} · {r.detail} · {r.tokens}
              </span>
            </div>
          ))}
        </div>
      )}
      </details>
    </Card>
  );
}

/**
 * 被"要求修改"掉的历史补丁。
 *
 * 它们不再可决定（当前那份才是），但必须能翻出来 —— 用户否掉的那一版是"为什么不接受"的证据，
 * 而 PATCH_SEALED 事件里没有 diff 正文。默认折叠：它是历史，不该跟当前待决定的补丁抢注意力。
 */
function PriorPatchesPanel({ patches }: { patches: readonly PatchArtifact[] }) {
  return (
    <Card title="历史补丁" hint={`${patches.length} 版被要求修改`}>
      {patches.map((p, i) => (
        <details key={p.patchId} className="toolcall" data-testid="prior-patch">
          <summary>
            第 {i + 1} 版 · {p.files.length} 个文件 · {p.digest.slice(0, 16)} · {timeOf(p.sealedAt)}
            {p.verificationRunId ? '' : ' · 未经机器验证'}
          </summary>
          <div className="diff">
            {p.files.map((f) => (
              <div key={f.path}>
                <div className="diff-path">{f.path}</div>
                <pre className="output">{f.diff}</pre>
              </div>
            ))}
          </div>
        </details>
      ))}
    </Card>
  );
}

function VerificationPanel({ verifications }: { verifications: VerificationRun[] }) {
  return (
    <Card title="验证记录" hint={`${verifications.length} 次`}>
      {verifications.map((v) => (
        <details key={v.verificationRunId} className="toolcall">
          <summary>
            <Badge tone={v.phase === 'BASELINE' ? 'default' : 'info'}>{v.phase}</Badge>
            <Badge tone={v.passed ? 'ok' : 'err'}>{v.passed ? 'PASSED' : 'FAILED'}</Badge>
            <span style={{ color: 'var(--text-secondary)' }}>gen-{v.generation}</span>
            <span className="spacer" style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>{timeOf(v.startedAt)}</span>
          </summary>
          <div className="body">
            {v.commands.map((c, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <Badge tone={c.outcome === 'EXIT_ZERO' ? 'ok' : 'err'}>{c.outcome}</Badge>
                  <code style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {c.argv.join(' ') || c.commandId}
                  </code>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                    exit={c.exitCode ?? 'null'} · {c.durationMs}ms
                  </span>
                </div>
                {(c.stderrPreview || c.stdoutPreview) && (
                  <pre className="output">{c.stderrPreview || c.stdoutPreview}</pre>
                )}
              </div>
            ))}
          </div>
        </details>
      ))}
    </Card>
  );
}
