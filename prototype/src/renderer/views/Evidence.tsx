import { useCallback, useEffect, useState } from 'react';
import type { EvidenceReviewerGroup, EvidenceSummary } from '@shared/protocol';
import type { RunStatus } from '@shared/domain';
import { call } from '../bridge';
import { Badge, Banner, Card, failureClassText, runStatusText } from '../components/common';

/**
 * 证据页 —— PRD §11 指标里平台事实撑得住的那个子集。
 *
 * 两条展示纪律（与 Core 侧 evidence.ts 同源）：
 *   1. 北极星与漏斗同屏 —— 不允许只看接受率不看前置阶段的失败（PRD §11.1）；
 *   2. 算不出来的指标显式列出并给原因，而不是从页面上消失。
 * 这里的一切都是观察性事实。它不能回答"交叉审核有没有用"（ASM-019），
 * 那需要 SPK-010 的 sealed A/B —— 页面上用操作者的话说这件事，规格编号收进 title
 * （交互评审 v0.2 N7：这页的读者是操作者，不是 PRD 评审）。
 */

const PARITY_LABEL: Record<EvidenceReviewerGroup['parity'], string> = {
  HETEROGENEOUS: '已证异构',
  SAME_VENDOR: '同厂商',
  UNVERIFIABLE: '厂商无法判定',
  LEGACY_BOOLEAN: '旧记录（仅布尔）',
};

function pct(n: number | null): string {
  return n === null ? '—（分母为 0，不写百分比）' : `${(n * 100).toFixed(1)}%`;
}

function CountRow({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function DistTable({
  dist,
  translate,
}: {
  dist: Readonly<Record<string, number>>;
  /** 键的中文词典（raw 键进 title）；不传则原样展示 */
  translate?: (key: string) => string;
}) {
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span style={{ color: 'var(--text-secondary)' }}>（无）</span>;
  return (
    <span>
      {entries.map(([k, v], i) => (
        <span key={k} title={translate ? k : undefined}>
          {i > 0 ? ' · ' : ''}
          {translate ? translate(k) : k} <b>{v}</b>
        </span>
      ))}
    </span>
  );
}

export function EvidenceView({ onError }: { onError: (message: string, detail: string | null) => void }) {
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await call('evidence.summary', {});
      setSummary(res.summary);
    } catch (err) {
      onError('无法取得证据摘要', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!summary) {
    return <p style={{ color: 'var(--text-secondary)', padding: 16 }}>{loading ? '正在聚合证据…' : '暂无数据'}</p>;
  }

  const q = summary.dataQuality;
  const f = summary.funnel;
  const ns = summary.northStar;
  const c = summary.cost;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 这页的读者是操作者，不是 PRD 评审 —— 规格编号收进 title（交互评审 v0.2 N7） */}
      <Banner tone="info">
        本页全部数字来自平台观察到的事实（账本 / 只追加事件 / 封存记录），
        <b>不从模型或审核方的自报计算</b>。它是观察性分布，
        <span title="ASM-019（异构审核是否降低缺陷）需要 SPK-010 的 sealed A/B 对照实验">
          <b>不能证明"换个厂商交叉审核就能降低缺陷"</b> —— 那需要密封 A/B 对照实验
        </span>
        。
      </Banner>

      <Card
        title="数据质量"
        hint={`共 ${q.totalRuns} 个 Run`}
        right={
          <button disabled={loading} onClick={() => void refresh()}>
            {loading ? '聚合中…' : '刷新'}
          </button>
        }
      >
        <dl className="kv">
          <CountRow label="证据完整" value={q.intact} />
          <CountRow label="事件超前于状态" value={q.eventsAhead} />
          <CountRow label="证据损坏" value={q.damaged} />
          <CountRow label="重启恢复" value={q.restored} />
          <CountRow label="被排除出聚合" value={`${q.excludedFromMetrics}（损坏的 Run 不进任何统计，排除必须报数）`} />
        </dl>
      </Card>

      <Card title="北极星与漏斗" hint="两者必须同屏发布 —— 只看接受率会隐藏前置阶段的失败">
        <dl className="kv">
          <dt title="Accepted Verified Patch Rate">接受且验证通过率（北极星）</dt>
          <dd>{pct(ns.rate)}</dd>
          <dt title="SUCCEEDED">分子：接受且验证通过</dt>
          <dd>{ns.acceptedVerified}</dd>
          <dt title="ACCEPTED_UNVERIFIED">接受但未验证</dt>
          <dd>{ns.acceptedUnverified}</dd>
          <dt title="EXECUTING">分母：进入执行阶段的尝试</dt>
          <dd>{ns.executingAttempts}</dd>
        </dl>
        <dl className="kv" style={{ marginTop: 8 }}>
          <CountRow label="Run 创建" value={f.runsCreated} />
          <CountRow label="生成过计划" value={f.plansGenerated} />
          <CountRow label="Attempt 总数" value={f.attemptsStarted} />
          <CountRow label="补丁封存次数" value={f.patchesSealed} />
          <CountRow
            label="人工决定"
            value={`接受 ${f.decisions.ACCEPT} · 拒绝 ${f.decisions.REJECT} · 要求修改 ${f.decisions.REQUEST_CHANGES}`}
          />
        </dl>
      </Card>

      <Card title="终态与失败分类">
        <dl className="kv">
          <dt>终态分布</dt>
          <dd>
            <DistTable dist={summary.outcomes.byStatus} translate={(k) => runStatusText(k as RunStatus)} />
          </dd>
          <dt>失败分类</dt>
          <dd>
            <DistTable dist={summary.outcomes.byFailureClass} translate={failureClassText} />
          </dd>
        </dl>
      </Card>

      <Card title="验证">
        <dl className="kv">
          <CountRow
            label="基线验证"
            value={`通过 ${summary.verification.baseline.passed} · 失败 ${summary.verification.baseline.failed}`}
          />
          <CountRow
            label="改后验证"
            value={`通过 ${summary.verification.postMutation.passed} · 失败 ${summary.verification.postMutation.failed}`}
          />
          <CountRow
            label="覆盖被削弱的补丁"
            value={`${summary.verification.coverageWeakenedPatches}（补丁触碰了验证输入，这些"通过"不构成修复证明）`}
          />
        </dl>
      </Card>

      <Card
        title="交叉审核（观察性事实）"
        hint={`${summary.crossReview.runsWithReview} 个 Run 启用了交叉审核`}
      >
        {summary.crossReview.groups.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>还没有启用过交叉审核的 Run。</p>
        ) : (
          summary.crossReview.groups.map((g) => (
            <div key={`${g.reviewerKey}|${g.parity}`} style={{ marginTop: 10 }}>
              <div className="section-label" style={{ padding: '4px 2px' }}>
                {g.reviewerKey}
                {'　'}
                <Badge tone={g.parity === 'HETEROGENEOUS' ? 'info' : 'warn'}>{PARITY_LABEL[g.parity]}</Badge>
              </div>
              <dl className="kv">
                <CountRow label="Run / 轮次 / 整改 / 用户续期" value={`${g.runs} / ${g.rounds} / ${g.remediations} / ${g.userContinuations}`} />
                <CountRow
                  label="结论分布"
                  value={`通过 ${g.verdicts.PASS} · 要求修改 ${g.verdicts.CHANGES_REQUESTED} · 未给出结论 ${g.verdicts.INCONCLUSIVE}（后者不是通过）`}
                />
                <CountRow label="发现（阻断）" value={`${g.findings}（${g.blockingFindings}）`} />
                <CountRow label="指纹跨轮重复的 Run" value={`${g.runsWithRepeatedFingerprint}（no-progress 信号，指纹由平台计算）`} />
                <dt>结束原因</dt>
                <dd>
                  <DistTable dist={g.stopReasons} />
                </dd>
                <dt>审后 Run 现状</dt>
                <dd>
                  <DistTable dist={g.outcomes} translate={(k) => runStatusText(k as RunStatus)} />
                </dd>
              </dl>
            </div>
          ))
        )}
      </Card>

      <Card title="成本" hint="token 未知记未知轮次，不折成 0">
        <dl className="kv">
          <CountRow label="模型轮次 / 工具调用" value={`${c.ledger.modelTurns} / ${c.ledger.toolCalls}`} />
          <CountRow label="token（入 / 出）" value={`${c.ledger.inputTokens} / ${c.ledger.outputTokens}`} />
          <CountRow label="用量未知的轮次" value={c.ledger.unknownUsageTurns} />
          <CountRow label="累计运行时长" value={`${Math.round(c.ledger.elapsedMs / 1000)}s`} />
          <CountRow
            label="每个被接受 Run 的均值"
            value={
              c.acceptedRuns === 0
                ? '—（还没有被接受的 Run）'
                : `token ${c.acceptedAvgInputTokens}/${c.acceptedAvgOutputTokens} · ${Math.round((c.acceptedAvgElapsedMs ?? 0) / 1000)}s` +
                  `（样本 ${c.acceptedRuns} 个，其中 ${c.acceptedRunsWithUnknownUsage} 个含未知用量轮次）`
            }
          />
        </dl>
        {Object.keys(c.byPurpose).length > 0 && (
          <>
            <div className="section-label" style={{ padding: '6px 2px 2px' }}>
              按用途拆分（egress.jsonl 逐笔清单；外部 CLI 不经网关，其用量在账本里是未知轮次）
              {c.egressLogUnparseableLines > 0 && `　· ${c.egressLogUnparseableLines} 行无法解析，未计入`}
            </div>
            <dl className="kv">
              {Object.entries(c.byPurpose).map(([purpose, p]) => (
                <CountRow
                  key={purpose}
                  label={purpose}
                  value={`${p.manifests} 笔（发出 ${p.sent} · 拦下 ${p.blocked} · 未达 ${p.failedBeforeSend}）· token ${p.inputTokens}/${p.outputTokens}${p.usageUnknown > 0 ? ` · ${p.usageUnknown} 笔用量未知` : ''}`}
                />
              ))}
            </dl>
          </>
        )}
      </Card>

      <Card title="算不出来的指标" hint="缺什么、为什么缺、怎么解锁 —— 不从清单里消失">
        {summary.notComputable.map((n) => (
          <div key={n.metric} style={{ marginTop: 8 }}>
            <div>
              <b>{n.metric}</b>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>
              {n.reason}
              <br />
              解锁：{n.unblocks}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
