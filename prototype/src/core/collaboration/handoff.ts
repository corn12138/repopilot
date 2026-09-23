import type {
  CollaborationHandoff,
  CollaborationHandoffDecision,
  Digest,
} from '@shared/domain';
import { digestOf } from '@shared/ids';

export const HANDOFF_DECISION_TTL_MS = 30 * 60 * 1000;

export type HandoffConsumeErrorCode =
  | 'HANDOFF_DIGEST_MISMATCH'
  | 'HANDOFF_EXPIRED'
  | 'HANDOFF_ALREADY_CONSUMED'
  | 'HANDOFF_WRONG_RUN'
  | 'HANDOFF_WRONG_ATTEMPT'
  | 'HANDOFF_STALE_EPOCH'
  | 'HANDOFF_STALE_GENERATION'
  | 'HANDOFF_ROUTE_CHANGED'
  | 'HANDOFF_PLAN_CHANGED'
  | 'HANDOFF_SNAPSHOT_CHANGED'
  | 'HANDOFF_TREE_CHANGED'
  | 'HANDOFF_PATCH_CHANGED'
  | 'HANDOFF_VERIFICATION_CHANGED'
  | 'HANDOFF_CONSENT_CHANGED'
  | 'HANDOFF_RECIPIENT_CHANGED'
  | 'HANDOFF_CONTEXT_CHANGED'
  | 'DECISION_MISMATCH';

export class HandoffConsumeError extends Error {
  constructor(readonly code: HandoffConsumeErrorCode, message: string) {
    super(message);
  }
}

export type UnsignedHandoff = Omit<CollaborationHandoff, 'digest'>;

export function sealHandoff(input: UnsignedHandoff): CollaborationHandoff {
  return { ...input, digest: digestOf(input) };
}

export function verifyHandoffDigest(handoff: CollaborationHandoff): boolean {
  const { digest: _digest, ...payload } = handoff;
  return digestOf(payload) === handoff.digest;
}

export interface HandoffConsumptionContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly coreEpoch: number;
  readonly generation: number;
  readonly roleBindingDigest: Digest;
  readonly planDigest: Digest;
  readonly snapshotId: string;
  readonly baseTreeDigest: Digest;
  readonly treeDigest: Digest;
  readonly patchDigest: Digest | null;
  readonly verificationInputDigest: Digest | null;
  readonly verificationEligible: boolean;
  readonly disclosureDigest: Digest;
  readonly recipientIdentityDigest: Digest;
  readonly contextDigest: Digest;
  readonly nowMs: number;
}

/**
 * Renderer 的决定只携带句柄和 digest；真正准入由 Core 用当前事实逐项重算。
 * 调用方必须先持久化返回的消费记录，再派发下一阶段，避免日志失败后仍产生出站副作用。
 */
export class HandoffLedger {
  private readonly consumed = new Map<string, CollaborationHandoffDecision>();

  consume(
    handoff: CollaborationHandoff,
    decision: CollaborationHandoffDecision,
    context: HandoffConsumptionContext,
  ): CollaborationHandoffDecision {
    if (!verifyHandoffDigest(handoff)) {
      throw new HandoffConsumeError('HANDOFF_DIGEST_MISMATCH', '交接工件内容与摘要不一致');
    }
    if (handoff.runId !== context.runId) {
      throw new HandoffConsumeError('HANDOFF_WRONG_RUN', '交接工件不属于当前 Run');
    }
    if (handoff.attemptId !== context.attemptId) {
      throw new HandoffConsumeError('HANDOFF_WRONG_ATTEMPT', '交接工件不属于当前 Attempt');
    }
    if (handoff.coreEpoch !== context.coreEpoch) {
      throw new HandoffConsumeError('HANDOFF_STALE_EPOCH', '交接工件来自已失效的 Core 代次');
    }
    if (handoff.generation !== context.generation) {
      throw new HandoffConsumeError('HANDOFF_STALE_GENERATION', '交接工件绑定的工作区代次已变化');
    }
    if (handoff.roleBindingDigest !== context.roleBindingDigest) {
      throw new HandoffConsumeError('HANDOFF_ROUTE_CHANGED', '角色或路由已变化，需刷新交接工件');
    }
    if (handoff.plan.digest !== context.planDigest) {
      throw new HandoffConsumeError('HANDOFF_PLAN_CHANGED', '计划已变化，需刷新交接工件');
    }
    if (handoff.snapshotId !== context.snapshotId || handoff.baseTreeDigest !== context.baseTreeDigest) {
      throw new HandoffConsumeError('HANDOFF_SNAPSHOT_CHANGED', '仓库快照已变化，需刷新交接工件');
    }
    if (handoff.treeDigest !== context.treeDigest) {
      throw new HandoffConsumeError('HANDOFF_TREE_CHANGED', '工作区内容已变化，需刷新交接工件');
    }
    if ((handoff.patch?.digest ?? null) !== context.patchDigest) {
      throw new HandoffConsumeError('HANDOFF_PATCH_CHANGED', '补丁已变化，需刷新交接工件');
    }
    if (
      handoff.verificationInputDigest !== context.verificationInputDigest ||
      handoff.verificationEligible !== context.verificationEligible
    ) {
      throw new HandoffConsumeError('HANDOFF_VERIFICATION_CHANGED', '验证事实已变化，需刷新交接工件');
    }
    if (handoff.disclosureDigest !== context.disclosureDigest) {
      throw new HandoffConsumeError('HANDOFF_CONSENT_CHANGED', '数据出站同意已变化，需刷新交接工件');
    }
    if (handoff.recipientIdentityDigest !== context.recipientIdentityDigest) {
      throw new HandoffConsumeError('HANDOFF_RECIPIENT_CHANGED', '接收方身份已变化，需刷新交接工件');
    }
    if (digestOf(handoff.context) !== context.contextDigest) {
      throw new HandoffConsumeError('HANDOFF_CONTEXT_CHANGED', '任务上下文已变化，需刷新交接工件');
    }
    if (Date.parse(handoff.expiresAt) <= context.nowMs) {
      throw new HandoffConsumeError('HANDOFF_EXPIRED', '交接决定已过期');
    }
    if (
      decision.handoffId !== handoff.handoffId ||
      decision.handoffDigest !== handoff.digest
    ) {
      throw new HandoffConsumeError('DECISION_MISMATCH', '决定未绑定当前交接工件');
    }
    if (this.consumed.has(handoff.handoffId)) {
      throw new HandoffConsumeError('HANDOFF_ALREADY_CONSUMED', '交接工件已经消费');
    }
    this.consumed.set(handoff.handoffId, decision);
    return decision;
  }

  restore(decision: CollaborationHandoffDecision): void {
    this.consumed.set(decision.handoffId, decision);
  }

  /** 事件账本未能落盘时撤回内存预留；下一阶段仍不得派发。 */
  rollback(decision: CollaborationHandoffDecision): void {
    if (this.consumed.get(decision.handoffId)?.decisionId === decision.decisionId) {
      this.consumed.delete(decision.handoffId);
    }
  }

  decisionFor(handoffId: string): CollaborationHandoffDecision | null {
    return this.consumed.get(handoffId) ?? null;
  }
}
