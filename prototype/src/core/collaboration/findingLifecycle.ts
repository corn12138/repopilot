import type {
  CollaborationFindingRef,
  CrossReviewRound,
  Digest,
} from '@shared/domain';

export interface FindingDisposition {
  readonly fingerprint: Digest;
  readonly disposition: CollaborationFindingRef['disposition'];
  readonly reviewId: string;
}

/**
 * Resolution applies only to a finding that was already open before this review.
 * Processing resolutions before findings makes a same-fingerprint recurrence reopen it.
 */
export function deriveFindingDispositions(
  rounds: readonly CrossReviewRound[],
  fallbackIdentity: string,
): readonly FindingDisposition[] {
  const byFingerprint = new Map<Digest, FindingDisposition>();

  for (const round of rounds) {
    const reviewId = round.reviewId ?? `${round.cycleId ?? fallbackIdentity}:review:${round.round}`;
    for (const fingerprint of round.resolvedFindingFingerprints ?? []) {
      const prior = byFingerprint.get(fingerprint);
      if (!prior) continue;
      byFingerprint.set(fingerprint, { fingerprint, disposition: 'RESOLVED', reviewId });
    }
    for (const finding of round.findings) {
      byFingerprint.set(finding.fingerprint, {
        fingerprint: finding.fingerprint,
        disposition: 'OPEN',
        reviewId,
      });
    }
  }

  return [...byFingerprint.values()];
}
