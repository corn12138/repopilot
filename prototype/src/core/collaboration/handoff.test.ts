import { describe, expect, it } from 'vitest';
import type { CollaborationHandoff, CollaborationHandoffDecision } from '@shared/domain';
import { digestOf } from '@shared/ids';
import { HandoffConsumeError, HandoffLedger, sealHandoff, verifyHandoffDigest } from './handoff';

function fixture(): CollaborationHandoff {
  return sealHandoff({
    schemaVersion: 1,
    handoffId: 'handoff-1',
    taskId: 'task-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    cycleId: 'cycle-1',
    fromRole: 'IMPLEMENTER',
    toRole: 'REVIEWER',
    nextPhase: 'FIRST_REVIEW',
    plan: { planId: 'plan-1', revision: 1, digest: 'sha256:plan' },
    snapshotId: 'snapshot-1',
    baseTreeDigest: 'sha256:base',
    generation: 2,
    treeDigest: 'sha256:tree',
    roleBindingDigest: 'sha256:roles',
    patch: { patchId: 'patch-1', digest: 'sha256:patch' },
    changedPaths: ['src/a.ts'],
    verificationIds: ['verify-1'],
    verificationInputDigest: 'sha256:inputs',
    verificationEligible: true,
    findings: [],
    context: {
      goal: '修复构建',
      acceptance: ['测试通过'],
      allowedPaths: ['src/**'],
      planSummary: '修改类型错误',
      provenance: ['task.goal', 'plan:1', 'patch:patch-1'],
    },
    disclosureDigest: 'sha256:disclosure',
    recipientIdentityDigest: 'sha256:reviewer',
    dataClasses: ['TASK_TEXT', 'PATCH_DIFF', 'COMMAND_OUTPUT'],
    counts: { included: 3, excluded: 1, truncated: 0, reasons: ['未发送聊天历史'] },
    budget: { modelTurnsRemaining: 4, toolCallsRemaining: 7, reviewerInvocations: 0, remediations: 0 },
    createdAt: '2026-09-15T00:00:00.000Z',
    expiresAt: '2026-09-15T00:30:00.000Z',
    coreEpoch: 4,
  });
}

function decision(handoff: CollaborationHandoff): CollaborationHandoffDecision {
  return {
    decisionId: 'decision-1',
    handoffId: handoff.handoffId,
    handoffDigest: handoff.digest,
    action: 'CONTINUE',
    decidedAt: '2026-09-15T00:10:00.000Z',
  };
}

const context = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  coreEpoch: 4,
  generation: 2,
  roleBindingDigest: 'sha256:roles',
  planDigest: 'sha256:plan',
  snapshotId: 'snapshot-1',
  baseTreeDigest: 'sha256:base',
  treeDigest: 'sha256:tree',
  patchDigest: 'sha256:patch',
  verificationInputDigest: 'sha256:inputs',
  verificationEligible: true,
  disclosureDigest: 'sha256:disclosure',
  recipientIdentityDigest: 'sha256:reviewer',
  contextDigest: digestOf(fixture().context),
  nowMs: Date.parse('2026-09-15T00:10:00.000Z'),
};

describe('CollaborationHandoff', () => {
  it('封存规范化工件并只消费一次', () => {
    const handoff = fixture();
    expect(verifyHandoffDigest(handoff)).toBe(true);
    const ledger = new HandoffLedger();
    expect(ledger.consume(handoff, decision(handoff), context).decisionId).toBe('decision-1');
    expect(() => ledger.consume(handoff, decision(handoff), context)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_ALREADY_CONSUMED' }),
    );
  });

  it('持久化失败回滚后可以重新消费，但旧决定不能误删新决定', () => {
    const handoff = fixture();
    const ledger = new HandoffLedger();
    const first = decision(handoff);
    ledger.consume(handoff, first, context);
    ledger.rollback(first);
    const second = { ...first, decisionId: 'decision-2' };
    ledger.consume(handoff, second, context);
    ledger.rollback(first);
    expect(ledger.decisionFor(handoff.handoffId)?.decisionId).toBe('decision-2');
  });

  it.each([
    ['HANDOFF_WRONG_RUN', { runId: 'run-other' }],
    ['HANDOFF_WRONG_ATTEMPT', { attemptId: 'attempt-other' }],
    ['HANDOFF_STALE_EPOCH', { coreEpoch: 5 }],
    ['HANDOFF_STALE_GENERATION', { generation: 3 }],
    ['HANDOFF_ROUTE_CHANGED', { roleBindingDigest: 'sha256:other' }],
    ['HANDOFF_PLAN_CHANGED', { planDigest: 'sha256:other' }],
    ['HANDOFF_TREE_CHANGED', { treeDigest: 'sha256:other' }],
    ['HANDOFF_PATCH_CHANGED', { patchDigest: 'sha256:other' }],
    ['HANDOFF_CONSENT_CHANGED', { disclosureDigest: 'sha256:other' }],
    ['HANDOFF_EXPIRED', { nowMs: Date.parse('2026-09-15T00:30:00.000Z') }],
  ] as const)('拒绝当前事实不匹配：%s', (code, changed) => {
    const handoff = fixture();
    try {
      new HandoffLedger().consume(handoff, decision(handoff), { ...context, ...changed });
      throw new Error('expected consume to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffConsumeError);
      expect((error as HandoffConsumeError).code).toBe(code);
    }
  });

  it('拒绝被 Renderer 篡改的正文和旧 digest', () => {
    const handoff = fixture();
    const changed = { ...handoff, changedPaths: ['src/out-of-scope.ts'] };
    expect(verifyHandoffDigest(changed)).toBe(false);
    expect(() => new HandoffLedger().consume(changed, decision(handoff), context)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_DIGEST_MISMATCH' }),
    );
  });
});
