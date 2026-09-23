import { describe, expect, it } from 'vitest';
import type { CrossReviewRound, ReviewFinding } from '@shared/domain';
import { deriveFindingDispositions } from './findingLifecycle';

const finding = (fingerprint: string): ReviewFinding => ({
  severity: 'HIGH',
  confidence: 1,
  file: 'src/a.ts',
  range: [1, 1],
  evidence: fingerprint,
  reproduction: null,
  suggestedRemediation: null,
  blocking: true,
  fingerprint,
});

const round = (
  roundNumber: number,
  findings: readonly ReviewFinding[],
  resolvedFindingFingerprints: readonly string[] = [],
  cycleId = 'cycle-1',
): CrossReviewRound => ({
  round: roundNumber,
  cycleId,
  reviewId: `${cycleId}:review:${roundNumber}`,
  reviewedPatchDigest: `sha256:patch-${roundNumber}`,
  reviewerResolutionId: 'reviewer',
  verdict: findings.length > 0 ? 'CHANGES_REQUESTED' : 'PASS',
  findings,
  resolvedFindingFingerprints,
  startedAt: '2026-09-16T00:00:00.000Z',
  finishedAt: '2026-09-16T00:00:01.000Z',
});

describe('deriveFindingDispositions', () => {
  it('按审核顺序关闭发现，并忽略未知 fingerprint 的解决声明', () => {
    expect(
      deriveFindingDispositions(
        [round(1, [finding('known')]), round(2, [], ['unknown', 'known'])],
        'attempt-1',
      ),
    ).toEqual([
      {
        fingerprint: 'known',
        disposition: 'RESOLVED',
        reviewId: 'cycle-1:review:2',
      },
    ]);
  });

  it('同一 fingerprint 后续重现时覆盖旧解决声明并绑定新 cycle', () => {
    expect(
      deriveFindingDispositions(
        [
          round(1, [finding('same')]),
          round(2, [], ['same']),
          round(1, [finding('same')], [], 'cycle-2'),
        ],
        'attempt-1',
      ),
    ).toEqual([
      {
        fingerprint: 'same',
        disposition: 'OPEN',
        reviewId: 'cycle-2:review:1',
      },
    ]);
  });
});
