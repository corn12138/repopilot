import { useState } from 'react';
import type {
  ApprovalRequest,
  PatchArtifact,
  PatchDecisionKind,
  PlanRevision,
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
  RestoredBadge,
  RunStatusBadge,
  timeOf,
} from '../components/common';
import { Transcript } from './Transcript';

export function RunDetail({
  run,
  events,
  toolCalls,
  approvals,
  plan,
  patch,
  verifications,
  onError,
  onRefresh,
}: {
  run: RunView;
  events: RunEvent[];
  toolCalls: ToolCallView[];
  approvals: ApprovalRequest[];
  plan: PlanRevision | null;
  patch: PatchArtifact | null;
  verifications: VerificationRun[];
  onError: (err: unknown) => void;
  onRefresh: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const active = !TERMINAL_RUN_STATUSES.includes(run.status);

  const cancel = async () => {
    try {
      await call('run.cancel', { runId: run.runId, reason: '用户在 UI 中取消' });
    } catch (err) {
      onError(err);
    }
  };

  return (
    <>
      <Card
        title="运行"
        hint={run.runId}
        right={
          <div className="row">
            <button onClick={onRefresh}>刷新</button>
            {active && (
              <button className="danger" onClick={() => void cancel()}>
                取消
              </button>
            )}
          </div>
        }
      >
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <RunStatusBadge status={run.status} />
          <RestoredBadge run={run} />
          <Badge>gen-{run.workspaceGeneration}</Badge>
          <Badge>模型轮次 {run.ledger.modelTurns}/{run.limits.maxModelTurns}</Badge>
          <Badge>工具调用 {run.ledger.toolCalls}/{run.limits.maxToolCalls}</Badge>
          <Badge>自修复 {run.ledger.selfFixRounds}/{run.limits.maxSelfFixRounds}</Badge>
          <Badge>
            token {run.ledger.inputTokens + run.ledger.outputTokens}/{run.limits.maxTotalTokens}
          </Badge>
          <Badge>{Math.round(run.ledger.elapsedMs / 1000)}s</Badge>
        </div>

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
        {run.evidence === 'EVENTS_AHEAD' && (
          <Banner tone="warn">
            <strong>状态快照落后于事件流。</strong>
            {run.evidenceDetail && <div style={{ marginTop: 4 }}>{run.evidenceDetail}</div>}
            <div style={{ marginTop: 6 }}>
              时间线是完整的，但上面的状态、预算和补丁可能不是最后一刻的样子。
            </div>
          </Banner>
        )}
        {run.restored && run.evidence === 'INTACT' && (
          <Banner tone="info">
            该 Run 是从磁盘恢复的。历史、验证记录和补丁都是真的，
            {run.status === 'AWAITING_PATCH_REVIEW'
              ? '补丁仍可接受与导出（这不需要运行中的执行器）。'
              : '但没有运行中的执行器，不能续跑。'}
            工作区文件树不可用 —— 那份隔离副本随进程一起结束了。
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

      {approvals.length > 0 && plan && (
        <PlanApproval approval={approvals[0]!} plan={plan} onError={onError} />
      )}

      {patch && (
        <PatchReview
          patch={patch}
          canDecide={run.status === 'AWAITING_PATCH_REVIEW'}
          accepted={run.status === 'SUCCEEDED' || run.status === 'ACCEPTED_UNVERIFIED'}
          onError={onError}
        />
      )}

      {verifications.length > 0 && <VerificationPanel verifications={verifications} />}

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
    </>
  );
}

// ---------------------------------------------------------------------------

function PlanApproval({
  approval,
  plan,
  onError,
}: {
  approval: ApprovalRequest;
  plan: PlanRevision;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    try {
      const r = await call('approval.decide', {
        approvalId: approval.approvalId,
        decision,
        subjectDigest: approval.subjectDigest,
        note: '',
      });
      if (!r.accepted) onError(new Error(r.reason ?? '审批未被接受'));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="待审批计划" hint="批准后才允许产生副作用">
      <Banner tone="info">{plan.summary}</Banner>

      <ol style={{ paddingLeft: 20, fontSize: 12.5, margin: '0 0 12px' }}>
        {plan.steps.map((s) => (
          <li key={s.index} style={{ marginBottom: 6 }}>
            {s.intent}
            {s.targetPaths.length > 0 && (
              <div style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {s.targetPaths.join(', ')}
              </div>
            )}
            {s.expectedEffect && (
              <div style={{ color: 'var(--text-dim)', fontSize: 11.5 }}>预期：{s.expectedEffect}</div>
            )}
          </li>
        ))}
      </ol>

      {plan.risks.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>风险</div>
          <ul className="plain">
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>
          plan digest {plan.digest.slice(7, 27)}…
        </span>
        <span className="spacer" />
        <button className="danger" disabled={busy} onClick={() => void decide('REJECT')}>
          拒绝
        </button>
        <button className="primary" disabled={busy} onClick={() => void decide('APPROVE')}>
          批准并执行
        </button>
      </div>
    </Card>
  );
}

function PatchReview({
  patch,
  canDecide,
  accepted,
  onError,
}: {
  patch: PatchArtifact;
  canDecide: boolean;
  accepted: boolean;
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
      const r = await call('patch.export', { runId: patch.runId, patchId: patch.patchId, mode });
      setExportMsg(
        r.ok
          ? { ok: true, text: `${r.detail}${r.target ? ` → ${r.target}` : ''}` }
          : { ok: false, text: `${r.reason}：${r.detail}` },
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
    <Card title="补丁审查" hint={`${patch.files.length} 个文件 · +${added} / -${removed}`}>
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
            <span style={{ color: 'var(--ok)', fontSize: 11 }}>+{f.addedLines}</span>
            <span style={{ color: 'var(--err)', fontSize: 11 }}>-{f.removedLines}</span>
          </summary>
          <div className="body">
            <DiffView diff={f.diff} />
            {f.diffTruncated && (
              <div style={{ color: 'var(--warn)', fontSize: 11, marginTop: 4 }}>diff 已截断</div>
            )}
          </div>
        </details>
      ))}

      {patch.excludedGeneratedFiles.length > 0 && (
        <details className="toolcall" style={{ marginTop: 10 }}>
          <summary>
            <Badge tone="warn">已排除</Badge>
            <span style={{ color: 'var(--text-dim)' }}>
              {patch.excludedGeneratedFiles.length} 个由验证命令生成的文件未纳入补丁
            </span>
          </summary>
          <div className="body">
            <pre className="output">{patch.excludedGeneratedFiles.join('\n')}</pre>
          </div>
        </details>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>未验证项（接受前请确认）</div>
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
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              接受只是记录你的判断；补丁要不要落到仓库，接受之后再单独决定。
            </span>
            <span className="spacer" />
            <button className="danger" disabled={busy} onClick={() => void decide('REJECT')}>
              拒绝
            </button>
            <button disabled={busy} onClick={() => void decide('REQUEST_CHANGES')}>
              要求修改
            </button>
            <button className="primary" disabled={busy} onClick={() => void decide('ACCEPT')}>
              接受补丁
            </button>
          </div>
        </>
      )}

      {accepted && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
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
                  fontFamily: exportMsg.ok ? 'inherit' : 'var(--mono)',
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

function VerificationPanel({ verifications }: { verifications: VerificationRun[] }) {
  return (
    <Card title="验证记录" hint={`${verifications.length} 次`}>
      {verifications.map((v) => (
        <details key={v.verificationRunId} className="toolcall">
          <summary>
            <Badge tone={v.phase === 'BASELINE' ? 'default' : 'info'}>{v.phase}</Badge>
            <Badge tone={v.passed ? 'ok' : 'err'}>{v.passed ? 'PASSED' : 'FAILED'}</Badge>
            <span style={{ color: 'var(--text-dim)' }}>gen-{v.generation}</span>
            <span className="spacer" style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{timeOf(v.startedAt)}</span>
          </summary>
          <div className="body">
            {v.commands.map((c, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <Badge tone={c.outcome === 'EXIT_ZERO' ? 'ok' : 'err'}>{c.outcome}</Badge>
                  <code style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    {c.argv.join(' ') || c.commandId}
                  </code>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
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
