// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callMock = vi.fn();
vi.mock('../bridge', () => ({
  call: (...args: unknown[]) => callMock(...args),
  RequestError: class RequestError extends Error {},
}));

import type { EvidenceSummary } from '@shared/protocol';
import { EvidenceView } from './Evidence';

/**
 * 证据页的展示纪律（真实 DOM 断言）：
 *   - 分母为 0 时不渲染任何百分比数字；
 *   - INCONCLUSIVE 的文案必须说明"不是通过"；
 *   - 观察性声明与"算不出的指标"清单必须可见 —— 页面不许宣称回答了 ASM-019。
 */

const summary = (over: Partial<EvidenceSummary> = {}): EvidenceSummary => ({
  generatedAt: '2026-08-24T00:00:00.000Z',
  dataQuality: { totalRuns: 0, intact: 0, eventsAhead: 0, damaged: 0, restored: 0, excludedFromMetrics: 0 },
  funnel: {
    runsCreated: 0,
    plansGenerated: 0,
    attemptsStarted: 0,
    attemptsEnteredExecuting: 0,
    patchesSealed: 0,
    decisions: { ACCEPT: 0, REJECT: 0, REQUEST_CHANGES: 0 },
  },
  northStar: { acceptedVerified: 0, acceptedUnverified: 0, executingAttempts: 0, rate: null },
  outcomes: { byStatus: {}, byFailureClass: {} },
  verification: { baseline: { passed: 0, failed: 0 }, postMutation: { passed: 0, failed: 0 }, coverageWeakenedPatches: 0 },
  crossReview: { runsWithReview: 0, groups: [] },
  cost: {
    ledger: { modelTurns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, unknownUsageTurns: 0, elapsedMs: 0 },
    byPurpose: {},
    egressLogUnparseableLines: 0,
    acceptedRuns: 0,
    acceptedAvgInputTokens: null,
    acceptedAvgOutputTokens: null,
    acceptedAvgElapsedMs: null,
    acceptedRunsWithUnknownUsage: 0,
  },
  notComputable: [
    { metric: '整改后 verified defect delta（ASM-019）', reason: '需要 sealed A/B', unblocks: 'SPK-010 —— Deferred / Not authorized' },
  ],
  ...over,
});

afterEach(() => {
  cleanup();
  callMock.mockReset();
});

describe('EvidenceView', () => {
  it('分母为 0：不渲染百分比，写明"分母为 0"；观察性免责与 SPK-010 点名可见', async () => {
    callMock.mockResolvedValue({ summary: summary() });
    render(<EvidenceView onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/分母为 0，不写百分比/)).toBeTruthy());
    expect(screen.queryByText(/%/)).toBeNull();
    // 页面必须自己声明它不构成 ASM-019 的证据
    expect(screen.getByText(/不构成 ASM-019/)).toBeTruthy();
    expect(screen.getByText(/SPK-010 —— Deferred \/ Not authorized/)).toBeTruthy();
  });

  it('INCONCLUSIVE 计数带"不是通过"的说明，与 PASS 分列', async () => {
    callMock.mockResolvedValue({
      summary: summary({
        crossReview: {
          runsWithReview: 1,
          groups: [
            {
              reviewerKey: 'profile_moonshot-cn',
              reviewerKind: 'MODEL_API',
              parity: 'HETEROGENEOUS',
              runs: 1,
              rounds: 1,
              verdicts: { PASS: 0, CHANGES_REQUESTED: 0, INCONCLUSIVE: 1 },
              findings: 0,
              blockingFindings: 0,
              remediations: 0,
              userContinuations: 0,
              runsWithRepeatedFingerprint: 0,
              stopReasons: { REVIEWER_INCONCLUSIVE: 1 },
              outcomes: { AWAITING_PATCH_REVIEW: 1 },
            },
          ],
        },
      }),
    });
    render(<EvidenceView onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/未给出结论 1（后者不是通过）/)).toBeTruthy());
    expect(screen.getByText('已证异构')).toBeTruthy();
  });

  it('取不到摘要时走 onError，不静默', async () => {
    callMock.mockRejectedValue(new Error('core down'));
    const onError = vi.fn();
    render(<EvidenceView onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('无法取得证据摘要', 'core down'));
  });
});
