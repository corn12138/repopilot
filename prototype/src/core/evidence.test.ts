import { describe, expect, it } from 'vitest';
import type {
  BudgetLedger,
  CrossReviewRecord,
  CrossReviewRound,
  ModelEgressManifest,
  ReviewFinding,
  RunEvent,
  RunView,
  VerificationRun,
} from '@shared/domain';
import { buildEvidenceSummary, type EvidenceRunInput } from './evidence';

/**
 * 证据聚合的诚实性。
 *
 * 主体是负向断言：分母为 0 不写百分比、INCONCLUSIVE 不折进 PASS、
 * 未知用量不折成 0、损坏的 Run 排除但报数、旧记录不做前缀猜测、
 * 算不出的指标必须在清单里点名。正向的"数对了"只是及格线。
 */

const ledger = (over: Partial<BudgetLedger> = {}): BudgetLedger => ({
  modelTurns: 0,
  toolCalls: 0,
  selfFixRounds: 0,
  elapsedMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownUsageTurns: 0,
  ...over,
});

let seq = 0;
const ev = (kind: RunEvent['kind'], attemptId: string, payload: Record<string, unknown> = {}): RunEvent => ({
  seq: ++seq,
  runId: 'run_x',
  attemptId,
  kind,
  at: '2026-08-24T00:00:00.000Z',
  summary: '',
  payload,
});

const view = (over: Partial<RunView>): RunView => ({
  runId: `run_${Math.random().toString(36).slice(2, 8)}`,
  taskId: 'task_1',
  projectId: 'proj_1',
  snapshotId: 'snap_1',
  title: 't',
  attemptId: 'att_1',
  attemptNo: 1,
  status: 'FAILED',
  statusReason: null,
  failureClass: null,
  ledger: ledger(),
  limits: { maxModelTurns: 1, maxToolCalls: 1, maxSelfFixRounds: 1, maxWallClockMs: 1, maxTotalTokens: 1 },
  workspaceGeneration: 0,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  terminalFacts: null,
  restored: false,
  evidence: 'INTACT',
  evidenceDetail: null,
  ...over,
});

const run = (over: Partial<EvidenceRunInput> & { view: RunView }): EvidenceRunInput => ({
  verifications: [],
  crossReview: null,
  patch: null,
  priorPatches: [],
  events: [],
  ...over,
});

const finding = (fingerprint: string, blocking = true): ReviewFinding => ({
  severity: 'HIGH',
  confidence: 0.9,
  file: 'a.ts',
  range: [1, 1],
  evidence: 'e',
  reproduction: null,
  suggestedRemediation: null,
  blocking,
  fingerprint,
});

const round = (n: number, verdict: CrossReviewRound['verdict'], findings: ReviewFinding[] = []): CrossReviewRound => ({
  round: n,
  reviewedPatchDigest: 'sha256:p',
  reviewerResolutionId: 'res_r',
  verdict,
  findings,
  startedAt: '2026-08-24T00:00:00.000Z',
  finishedAt: '2026-08-24T00:00:00.000Z',
});

const review = (over: Partial<CrossReviewRecord>): CrossReviewRecord => ({
  enabled: true,
  reviewerProfileId: 'profile_moonshot-cn',
  reviewerIdentity: { kind: 'MODEL_API', profileId: 'profile_moonshot-cn' },
  heterogeneous: true,
  vendorParity: { kind: 'HETEROGENEOUS', detail: 'd' },
  rounds: [],
  reviewerInvocations: 0,
  remediations: 0,
  stopReason: 'REVIEWER_PASSED',
  startedAt: '2026-08-24T00:00:00.000Z',
  finishedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

const noEgress = { manifests: [], unparseableLines: 0 };

describe('北极星与漏斗：同产出，分母为 0 不编百分比', () => {
  it('空输入：rate 是 null 而不是 0 或 1；notComputable 仍然完整列出', () => {
    const s = buildEvidenceSummary([], noEgress);
    expect(s.northStar.rate).toBeNull();
    expect(s.northStar.executingAttempts).toBe(0);
    // 算不出的指标不因为没有数据就消失 —— defect delta 必须点名 SPK-010
    expect(s.notComputable.some((n) => n.metric.includes('defect delta') && n.unblocks.includes('SPK-010'))).toBe(true);
    expect(s.notComputable.some((n) => n.metric.includes('用户返工率'))).toBe(true);
  });

  it('分母是进入过 EXECUTING 的 Attempt，不是 Run：REQUEST_CHANGES 的第二个 Attempt 单独计', () => {
    const r = run({
      view: view({ status: 'SUCCEEDED' }),
      events: [
        ev('PLAN_GENERATED', 'att_1'),
        ev('STATUS_CHANGED', 'att_1', { from: 'PLANNING', to: 'EXECUTING' }),
        ev('PATCH_SEALED', 'att_1'),
        ev('PATCH_DECISION', 'att_1', { decision: 'REQUEST_CHANGES' }),
        ev('ATTEMPT_STARTED', 'att_2'),
        ev('STATUS_CHANGED', 'att_2', { from: 'CREATED', to: 'EXECUTING' }),
        ev('PATCH_SEALED', 'att_2'),
        ev('PATCH_DECISION', 'att_2', { decision: 'ACCEPT' }),
      ],
    });
    const s = buildEvidenceSummary([r], noEgress);
    expect(s.funnel.attemptsStarted).toBe(2);
    expect(s.northStar.executingAttempts).toBe(2);
    expect(s.northStar.acceptedVerified).toBe(1);
    // 1 个接受的验证补丁 / 2 个进入执行的 Attempt —— 第一次被要求修改的 Attempt 不从分母里消失
    expect(s.northStar.rate).toBe(0.5);
    expect(s.funnel.decisions).toEqual({ ACCEPT: 1, REJECT: 0, REQUEST_CHANGES: 1 });
    expect(s.funnel.patchesSealed).toBe(2);
  });

  it('同一 Attempt 内多次 STATUS_CHANGED 到 EXECUTING 只计一次（整改回执行不是新 Attempt）', () => {
    const r = run({
      view: view({}),
      events: [
        ev('STATUS_CHANGED', 'att_1', { to: 'EXECUTING' }),
        ev('STATUS_CHANGED', 'att_1', { to: 'VERIFYING' }),
        ev('STATUS_CHANGED', 'att_1', { to: 'EXECUTING' }),
      ],
    });
    expect(buildEvidenceSummary([r], noEgress).northStar.executingAttempts).toBe(1);
  });
});

describe('交叉审核分组：观察事实，不做前缀猜测，INCONCLUSIVE 不折进 PASS', () => {
  it('INCONCLUSIVE 单列 —— 与 PASS 的计数永不合并', () => {
    const r = run({
      view: view({ status: 'AWAITING_PATCH_REVIEW' }),
      crossReview: review({
        rounds: [round(1, 'INCONCLUSIVE')],
        reviewerInvocations: 1,
        stopReason: 'REVIEWER_INCONCLUSIVE',
      }),
    });
    const g = buildEvidenceSummary([r], noEgress).crossReview.groups[0]!;
    expect(g.verdicts).toEqual({ PASS: 0, CHANGES_REQUESTED: 0, INCONCLUSIVE: 1 });
    expect(g.stopReasons.REVIEWER_INCONCLUSIVE).toBe(1);
  });

  it('指纹跨轮重复才算 no-progress 信号；同一轮内出现一次不算', () => {
    const repeated = run({
      view: view({}),
      crossReview: review({
        rounds: [round(1, 'CHANGES_REQUESTED', [finding('fp-a')]), round(2, 'CHANGES_REQUESTED', [finding('fp-a')])],
      }),
    });
    const single = run({
      view: view({}),
      crossReview: review({ rounds: [round(1, 'CHANGES_REQUESTED', [finding('fp-b'), finding('fp-c')])] }),
    });
    const s = buildEvidenceSummary([repeated, single], noEgress);
    const g = s.crossReview.groups[0]!;
    expect(g.runs).toBe(2);
    expect(g.runsWithRepeatedFingerprint).toBe(1);
    expect(g.blockingFindings).toBe(4);
  });

  it('旧记录没有判别联合身份 → LEGACY_UNKNOWN / LEGACY_BOOLEAN，不从字符串前缀猜 kind', () => {
    const legacy = run({
      view: view({}),
      crossReview: review({
        reviewerProfileId: 'external:claude-cli',
        reviewerIdentity: undefined,
        vendorParity: undefined,
        rounds: [round(1, 'PASS')],
      }),
    });
    const g = buildEvidenceSummary([legacy], noEgress).crossReview.groups[0]!;
    expect(g.reviewerKind).toBe('LEGACY_UNKNOWN');
    expect(g.parity).toBe('LEGACY_BOOLEAN');
    expect(g.reviewerKey).toBe('external:claude-cli');
  });

  it('审后去向按 Run 现状分布记录 —— 审核"通过"不折成任务成功', () => {
    const r = run({
      view: view({ status: 'AWAITING_PATCH_REVIEW' }),
      crossReview: review({ rounds: [round(1, 'PASS')] }),
    });
    const g = buildEvidenceSummary([r], noEgress).crossReview.groups[0]!;
    expect(g.outcomes.AWAITING_PATCH_REVIEW).toBe(1);
    expect(g.outcomes.SUCCEEDED).toBeUndefined();
  });
});

describe('数据质量与排除：损坏的 Run 不进聚合，但必须报数', () => {
  it('DAMAGED 排除出漏斗/成本/终态，excludedFromMetrics 如实计数', () => {
    const good = run({ view: view({ status: 'SUCCEEDED', ledger: ledger({ inputTokens: 100 }) }) });
    const bad = run({
      view: view({ status: 'INTERRUPTED', evidence: 'DAMAGED', ledger: ledger({ inputTokens: 999 }) }),
      events: [ev('PLAN_GENERATED', 'att_1')],
    });
    const s = buildEvidenceSummary([good, bad], noEgress);
    expect(s.dataQuality.totalRuns).toBe(2);
    expect(s.dataQuality.damaged).toBe(1);
    expect(s.dataQuality.excludedFromMetrics).toBe(1);
    expect(s.funnel.runsCreated).toBe(1);
    expect(s.funnel.plansGenerated).toBe(0); // 损坏 Run 的事件不进漏斗
    expect(s.cost.ledger.inputTokens).toBe(100); // 999 没有被算进来
    expect(s.outcomes.byStatus.INTERRUPTED).toBeUndefined();
  });
});

describe('成本：未知就是未知，不折成 0', () => {
  it('账本未知轮次求和上报；被接受 Run 的均值样本里含未知用量的 Run 单独计数', () => {
    const a = run({ view: view({ status: 'SUCCEEDED', ledger: ledger({ inputTokens: 100, outputTokens: 10, unknownUsageTurns: 2, elapsedMs: 2000 }) }) });
    const b = run({ view: view({ status: 'ACCEPTED_UNVERIFIED', ledger: ledger({ inputTokens: 300, outputTokens: 30, elapsedMs: 4000 }) }) });
    const s = buildEvidenceSummary([a, b], noEgress);
    expect(s.cost.ledger.unknownUsageTurns).toBe(2);
    expect(s.cost.acceptedRuns).toBe(2);
    expect(s.cost.acceptedAvgInputTokens).toBe(200);
    expect(s.cost.acceptedRunsWithUnknownUsage).toBe(1);
  });

  it('没有被接受的 Run 时均值是 null，不是 0', () => {
    const s = buildEvidenceSummary([run({ view: view({ status: 'FAILED' }) })], noEgress);
    expect(s.cost.acceptedAvgInputTokens).toBeNull();
    expect(s.cost.acceptedRuns).toBe(0);
  });

  it('egress 按 purpose 拆分：发出/拦下/未达三分；用量未知计数而不是记 0 就完事', () => {
    const m = (over: Partial<ModelEgressManifest>): ModelEgressManifest => ({
      invocationId: 'inv',
      runId: 'run_x',
      attemptId: 'att_1',
      purpose: 'CROSS_REVIEW',
      resolutionId: 'res',
      providerId: 'moonshot-cn',
      origin: 'https://x',
      modelId: 'kimi-k2',
      sent: true,
      blockReason: null,
      contextFileRefs: [],
      inputTokens: 10,
      outputTokens: 5,
      requestedAt: '2026-08-24T00:00:00.000Z',
      settledAt: null,
      errorKind: null,
      ...over,
    });
    const s = buildEvidenceSummary([], {
      manifests: [
        m({}),
        m({ inputTokens: null, outputTokens: null }), // 发出但用量未知
        m({ sent: false, blockReason: 'CONSENT_MISSING', inputTokens: null, outputTokens: null }),
        m({ sent: false, blockReason: null, inputTokens: null, outputTokens: null, errorKind: 'NETWORK' }),
        m({ purpose: 'PLANNING', inputTokens: 7, outputTokens: 3 }),
      ],
      unparseableLines: 2,
    });
    expect(s.cost.byPurpose.CROSS_REVIEW).toEqual({
      manifests: 4,
      sent: 2,
      blocked: 1,
      failedBeforeSend: 1,
      inputTokens: 10,
      outputTokens: 5,
      usageUnknown: 1,
    });
    expect(s.cost.byPurpose.PLANNING!.inputTokens).toBe(7);
    // 坏行数如实上报 —— 读不出的出站清单与"没出过站"必须可区分
    expect(s.cost.egressLogUnparseableLines).toBe(2);
  });
});

describe('验证与覆盖', () => {
  it('BASELINE 与 POST_MUTATION 分列；触碰验证输入的补丁（含历史补丁）计入覆盖削弱', () => {
    const v = (phase: VerificationRun['phase'], passed: boolean): VerificationRun => ({
      verificationRunId: 'v1',
      runId: 'run_x',
      attemptId: 'att_1',
      phase,
      generation: 1,
      commands: [],
      passed,
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:00:00.000Z',
    });
    const patch = (touched: string[]) =>
      ({
        patchId: 'p1',
        runId: 'run_x',
        attemptId: 'att_1',
        baseSha: 'sha',
        generation: 1,
        files: [],
        unifiedDiff: '',
        digest: 'sha256:d',
        sealedAt: '2026-08-24T00:00:00.000Z',
        verificationRunId: null,
        comparison: null,
        unverifiedItems: [],
        verificationInputsTouched: touched,
        excludedGeneratedFiles: [],
      }) as const;
    const r = run({
      view: view({}),
      verifications: [v('BASELINE', false), v('POST_MUTATION', true)],
      patch: patch(['check.mjs']),
      priorPatches: [patch([])],
    });
    const s = buildEvidenceSummary([r], noEgress);
    expect(s.verification.baseline).toEqual({ passed: 0, failed: 1 });
    expect(s.verification.postMutation).toEqual({ passed: 1, failed: 0 });
    expect(s.verification.coverageWeakenedPatches).toBe(1);
  });
});
