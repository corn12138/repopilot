import { existsSync, readFileSync } from 'node:fs';
import type {
  CrossReviewRecord,
  ModelEgressManifest,
  PatchArtifact,
  RunEvent,
  RunView,
  VerificationRun,
} from '@shared/domain';
import type {
  EvidenceNotComputable,
  EvidencePurposeCost,
  EvidenceReviewerGroup,
  EvidenceSummary,
} from '@shared/protocol';
import { nowIso } from '@shared/ids';
import { PATHS } from './paths';

/**
 * 跨 Run 证据聚合 —— 评估体系的第一块基建（PRD §11 的观察性子集）。
 *
 * 定位必须说清楚：这里聚合的是**已经发生的 Run 的平台事实**（append-only 事件、
 * 预算账本、封存记录、逐笔出站清单），它能回答"发生了什么、分布如何、成本多少"，
 * **不能**回答 ASM-019（异构审核是否降低 verified defect）—— 那需要 SPK-010 的
 * sealed A/B 对照，而 SPK-010 目前是 Deferred / Not authorized。观察性数据里
 * 选了审核方的任务与没选的任务本身就不可比（选择偏差），所以本模块只报事实分布，
 * 不产出任何"审核有效/无效"的结论字段。算不出的指标进 notComputable，带原因。
 *
 * 纪律（与 PRD §11 逐条对应）：
 *   - 北极星与漏斗必须同时产出，缺一即不发布（§11.1 反美化条款）；
 *   - 质量类数字一律来自平台观察（指纹是平台算的、阻断数是平台数的），
 *     不从 reviewer 或模型的自报"通过"计算（§11.2 交叉审核行）；
 *   - token 未知记未知轮次，不折成 0（与账本同一条规矩）；
 *   - 证据损坏的 Run 从所有聚合里排除，但**排除必须报数**（dataQuality.excludedFromMetrics）。
 */

/** 聚合的每 Run 输入 —— 全部是平台已持有的事实，抽成纯输入以便单测不起 RunAuthority */
export interface EvidenceRunInput {
  readonly view: RunView;
  readonly verifications: readonly VerificationRun[];
  readonly crossReview: CrossReviewRecord | null;
  readonly patch: PatchArtifact | null;
  readonly priorPatches: readonly PatchArtifact[];
  readonly events: readonly RunEvent[];
}

export interface EgressLogRead {
  readonly manifests: readonly ModelEgressManifest[];
  readonly unparseableLines: number;
}

/**
 * 逐行读 egress.jsonl。坏行计数返回，不吞 —— 一条读不出的出站清单
 * 与"没出过站"必须可区分（与 EventStore 对坏行的态度一致）。
 */
export function readEgressLog(): EgressLogRead {
  if (!existsSync(PATHS.egressLog)) return { manifests: [], unparseableLines: 0 };
  const manifests: ModelEgressManifest[] = [];
  let unparseableLines = 0;
  for (const line of readFileSync(PATHS.egressLog, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      manifests.push(JSON.parse(trimmed) as ModelEgressManifest);
    } catch {
      unparseableLines += 1;
    }
  }
  return { manifests, unparseableLines };
}

/** 算不出来的指标不从清单里消失 —— 点名 + 原因 + 解锁条件（PRD §11.2 的完整性要求） */
const NOT_COMPUTABLE: readonly EvidenceNotComputable[] = [
  {
    metric: 'actionable finding precision / recall',
    reason: '需要对审核发现做人工盲评标注；平台只观察到发现本身，观察不到"它是不是真缺陷"',
    unblocks: '设计人工盲评流程（PRD §11.2 交叉审核行）',
  },
  {
    metric: '整改后 verified defect delta（ASM-019）',
    reason:
      '需要同一 sealed case 的 single-agent vs cross-review 对照实验；观察性数据存在选择偏差，' +
      '选了审核方的任务与没选的任务不可比',
    unblocks: 'SPK-010 本机 sealed A/B —— 目前 Deferred / Not authorized，需另行授权（TD §22）',
  },
  {
    metric: '用户返工率',
    reason: '观察窗口与用户反馈方式未冻结，PRD 明确其为 measurement design pending',
    unblocks: '用户研究冻结返工定义（PRD §11.2）',
  },
  {
    metric: 'Benchmark pass@1 / pass@3',
    reason: '需要 sealed EvalCase 基准集与 sealed EvalResult；两者尚不存在，不从普通验证结果推导',
    unblocks: '建立固定任务基准集（PRD §11.1.1 计数口径已冻结）',
  },
];

function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

interface ReviewerGroupAcc {
  reviewerKey: string;
  reviewerKind: EvidenceReviewerGroup['reviewerKind'];
  parity: EvidenceReviewerGroup['parity'];
  runs: number;
  rounds: number;
  verdicts: { PASS: number; CHANGES_REQUESTED: number; INCONCLUSIVE: number };
  findings: number;
  blockingFindings: number;
  remediations: number;
  userContinuations: number;
  runsWithRepeatedFingerprint: number;
  stopReasons: Record<string, number>;
  outcomes: Record<string, number>;
}

export function buildEvidenceSummary(
  runs: readonly EvidenceRunInput[],
  egress: EgressLogRead,
): EvidenceSummary {
  const damaged = runs.filter((r) => r.view.evidence === 'DAMAGED');
  // 损坏的 Run 没有可信的账本/记录，从所有聚合里排除；排除数在 dataQuality 里如实报
  const usable = runs.filter((r) => r.view.evidence !== 'DAMAGED');

  // ---- 漏斗（北极星的强制随行，PRD §11.1）----
  let plansGenerated = 0;
  let attemptsStarted = 0;
  let attemptsEnteredExecuting = 0;
  let patchesSealed = 0;
  const decisions = { ACCEPT: 0, REJECT: 0, REQUEST_CHANGES: 0 };
  for (const r of usable) {
    if (r.events.some((e) => e.kind === 'PLAN_GENERATED')) plansGenerated += 1;
    attemptsStarted += 1 + r.events.filter((e) => e.kind === 'ATTEMPT_STARTED').length;
    const executing = new Set<string>();
    for (const e of r.events) {
      if (e.kind === 'STATUS_CHANGED' && e.payload.to === 'EXECUTING') executing.add(e.attemptId);
      if (e.kind === 'PATCH_SEALED') patchesSealed += 1;
      if (e.kind === 'PATCH_DECISION') {
        const d = e.payload.decision;
        if (d === 'ACCEPT' || d === 'REJECT' || d === 'REQUEST_CHANGES') decisions[d] += 1;
      }
    }
    attemptsEnteredExecuting += executing.size;
  }

  // ---- 北极星：SUCCEEDED 的语义由 setStatus 不变式担保（接受 + 验证通过 + 覆盖未削弱）----
  const acceptedVerified = usable.filter((r) => r.view.status === 'SUCCEEDED').length;
  const acceptedUnverified = usable.filter((r) => r.view.status === 'ACCEPTED_UNVERIFIED').length;

  // ---- 终态与失败分类分布 ----
  const byStatus: Record<string, number> = {};
  const byFailureClass: Record<string, number> = {};
  for (const r of usable) {
    inc(byStatus, r.view.status);
    if (r.view.failureClass) inc(byFailureClass, r.view.failureClass);
  }

  // ---- 验证 ----
  const verification = {
    baseline: { passed: 0, failed: 0 },
    postMutation: { passed: 0, failed: 0 },
    coverageWeakenedPatches: 0,
  };
  for (const r of usable) {
    for (const v of r.verifications) {
      const bucket = v.phase === 'BASELINE' ? verification.baseline : verification.postMutation;
      if (v.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
    for (const p of [...(r.patch ? [r.patch] : []), ...r.priorPatches]) {
      if ((p.verificationInputsTouched?.length ?? 0) > 0) verification.coverageWeakenedPatches += 1;
    }
  }

  // ---- 交叉审核：按审核方身份 + 厂商同异分组的观察事实 ----
  const groups = new Map<string, ReviewerGroupAcc>();
  let runsWithReview = 0;
  for (const r of usable) {
    const cr = r.crossReview;
    if (!cr?.enabled) continue;
    runsWithReview += 1;
    // 身份走判别联合；旧记录没有联合时如实标 LEGACY，不做前缀猜测
    const kind: EvidenceReviewerGroup['reviewerKind'] = cr.reviewerIdentity?.kind ?? 'LEGACY_UNKNOWN';
    const parity: EvidenceReviewerGroup['parity'] = cr.vendorParity?.kind ?? 'LEGACY_BOOLEAN';
    const key = `${cr.reviewerProfileId}|${parity}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        reviewerKey: cr.reviewerProfileId,
        reviewerKind: kind,
        parity,
        runs: 0,
        rounds: 0,
        verdicts: { PASS: 0, CHANGES_REQUESTED: 0, INCONCLUSIVE: 0 },
        findings: 0,
        blockingFindings: 0,
        remediations: 0,
        userContinuations: 0,
        runsWithRepeatedFingerprint: 0,
        stopReasons: {},
        outcomes: {},
      };
      groups.set(key, g);
    }
    g.runs += 1;
    g.rounds += cr.rounds.length;
    g.remediations += cr.remediations;
    g.userContinuations += cr.userContinuations ?? 0;
    if (cr.stopReason) inc(g.stopReasons, cr.stopReason);
    inc(g.outcomes, r.view.status);
    // 指纹是平台按 (severity,file,range,evidence) 算的 —— 跨轮重复 = no-progress 的观察信号
    const fingerprintRounds = new Map<string, Set<number>>();
    for (const round of cr.rounds) {
      g.verdicts[round.verdict] += 1;
      g.findings += round.findings.length;
      g.blockingFindings += round.findings.filter((f) => f.blocking).length;
      for (const f of round.findings) {
        const seen = fingerprintRounds.get(f.fingerprint) ?? new Set<number>();
        seen.add(round.round);
        fingerprintRounds.set(f.fingerprint, seen);
      }
    }
    if ([...fingerprintRounds.values()].some((s) => s.size > 1)) g.runsWithRepeatedFingerprint += 1;
  }

  // ---- 成本：账本合计 + egress.jsonl 按 purpose 拆分 ----
  const ledger = { modelTurns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, unknownUsageTurns: 0, elapsedMs: 0 };
  for (const r of usable) {
    ledger.modelTurns += r.view.ledger.modelTurns;
    ledger.toolCalls += r.view.ledger.toolCalls;
    ledger.inputTokens += r.view.ledger.inputTokens;
    ledger.outputTokens += r.view.ledger.outputTokens;
    ledger.unknownUsageTurns += r.view.ledger.unknownUsageTurns ?? 0;
    ledger.elapsedMs += r.view.ledger.elapsedMs;
  }
  const byPurpose: Record<string, { -readonly [K in keyof EvidencePurposeCost]: EvidencePurposeCost[K] }> = {};
  for (const m of egress.manifests) {
    const p = (byPurpose[m.purpose] ??= {
      manifests: 0,
      sent: 0,
      blocked: 0,
      failedBeforeSend: 0,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: 0,
    });
    p.manifests += 1;
    if (m.sent) {
      p.sent += 1;
      if (m.inputTokens === null || m.outputTokens === null) p.usageUnknown += 1;
    } else if (m.blockReason) {
      p.blocked += 1;
    } else {
      p.failedBeforeSend += 1;
    }
    p.inputTokens += m.inputTokens ?? 0;
    p.outputTokens += m.outputTokens ?? 0;
  }

  const accepted = usable.filter(
    (r) => r.view.status === 'SUCCEEDED' || r.view.status === 'ACCEPTED_UNVERIFIED',
  );
  const avg = (f: (r: EvidenceRunInput) => number): number | null =>
    accepted.length === 0 ? null : Math.round(accepted.reduce((n, r) => n + f(r), 0) / accepted.length);

  return {
    generatedAt: nowIso(),
    dataQuality: {
      totalRuns: runs.length,
      intact: runs.filter((r) => r.view.evidence === 'INTACT').length,
      eventsAhead: runs.filter((r) => r.view.evidence === 'EVENTS_AHEAD').length,
      damaged: damaged.length,
      restored: runs.filter((r) => r.view.restored).length,
      excludedFromMetrics: damaged.length,
    },
    funnel: {
      runsCreated: usable.length,
      plansGenerated,
      attemptsStarted,
      attemptsEnteredExecuting,
      patchesSealed,
      decisions,
    },
    northStar: {
      acceptedVerified,
      acceptedUnverified,
      executingAttempts: attemptsEnteredExecuting,
      rate: attemptsEnteredExecuting === 0 ? null : acceptedVerified / attemptsEnteredExecuting,
    },
    outcomes: { byStatus, byFailureClass },
    verification,
    crossReview: {
      runsWithReview,
      groups: [...groups.values()].sort((a, b) => b.runs - a.runs),
    },
    cost: {
      ledger,
      byPurpose,
      egressLogUnparseableLines: egress.unparseableLines,
      acceptedRuns: accepted.length,
      acceptedAvgInputTokens: avg((r) => r.view.ledger.inputTokens),
      acceptedAvgOutputTokens: avg((r) => r.view.ledger.outputTokens),
      acceptedAvgElapsedMs: avg((r) => r.view.ledger.elapsedMs),
      acceptedRunsWithUnknownUsage: accepted.filter((r) => (r.view.ledger.unknownUsageTurns ?? 0) > 0).length,
    },
    notComputable: NOT_COMPUTABLE,
  };
}
