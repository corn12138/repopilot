import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BudgetLedger, CrossReviewRecord, PatchArtifact, RunEvent, RunView } from '@shared/domain';
import { isIsolatedDataRoot } from '@shared/dataRoot';
import { digestOf, nowIso } from '@shared/ids';
import type { PushEvent } from '@shared/protocol';
import { RunAuthority } from '../authority';
import type { EvalCase } from './cases';

/**
 * SPK-010 观察执行器：跑一个 (case × arm)，产出密封的 EvalObservation。
 *
 * Harness 纪律（实验设计 §5，来自 TD §22 对 SPK-010 的要求）：
 *   1. fresh authority —— 每个观察一个全新 RunAuthority，观察之间零共享内存态；
 *   2. 隔离强制 —— 未设 REPOPILOT_DATA_ROOT 直接拒跑（与 selftest 同一条规矩）；
 *   3. 计划自动批准如实记录（autoApprovals）；补丁接受在实验里不发生，
 *      度量止于 AWAITING_PATCH_REVIEW / 终态的平台事实；
 *   4. 臂完整性 fail-closed —— CROSS_REVIEW 臂的审核方若被降级（不可用/同厂商/缺凭据），
 *      观察立即作废抛错，绝不把实际单写的 Run 密封成 B 臂结果；
 *   5. 收敛与预算沿用产品，不放宽。
 */

export type EvalArm = 'SINGLE_WRITER' | 'CROSS_REVIEW';

export interface EvalRoutes {
  readonly implementerProfileId: string;
  /** CROSS_REVIEW 臂必填；SINGLE_WRITER 臂必须为 null */
  readonly reviewerProfileId: string | null;
}

/** 一次观察的密封结果。digest 覆盖除自身外的全部字段 */
export interface EvalObservation {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly caseDigest: string;
  readonly arm: EvalArm;
  readonly routes: EvalRoutes;
  readonly runId: string;
  readonly status: string;
  readonly failureClass: string | null;
  /** 事件流里逐次验证的 (phase, passed)；原始事实，不预消化 */
  readonly verificationRuns: readonly { phase: string; passed: boolean }[];
  /** 最后一次 POST_MUTATION 验证是否通过；没跑过为 null（不折成 false） */
  readonly finalVerificationPassed: boolean | null;
  readonly patch: {
    readonly digest: string;
    readonly files: number;
    readonly addedLines: number;
    readonly removedLines: number;
    readonly unifiedDiff: string;
  } | null;
  readonly crossReview: {
    readonly reviewerKey: string;
    readonly parity: string;
    readonly rounds: number;
    readonly verdicts: { PASS: number; CHANGES_REQUESTED: number; INCONCLUSIVE: number };
    readonly blockingFindings: number;
    readonly remediations: number;
    readonly stopReason: string | null;
  } | null;
  readonly ledger: BudgetLedger;
  readonly autoApprovals: number;
  readonly disclosureDigest: string;
  readonly wallClockMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly digest: string;
}

export class EvalHarnessError extends Error {
  constructor(
    readonly code: 'DATA_ROOT_NOT_ISOLATED' | 'ARM_INTEGRITY' | 'PHASE_TIMEOUT' | 'SETUP_FAILED',
    message: string,
  ) {
    super(message);
  }
}

const POLL_MS = 25;
const TERMINAL_OR_REVIEW = new Set([
  'AWAITING_PATCH_REVIEW',
  'SUCCEEDED',
  'ACCEPTED_UNVERIFIED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
  'INTERRUPTED',
]);

export async function runObservation(input: {
  readonly evalCase: EvalCase;
  readonly arm: EvalArm;
  readonly routes: EvalRoutes;
  /** 单个阶段（等审批 / 等终态）的墙钟上限 */
  readonly phaseTimeoutMs?: number;
}): Promise<EvalObservation> {
  if (!isIsolatedDataRoot()) {
    throw new EvalHarnessError(
      'DATA_ROOT_NOT_ISOLATED',
      '未设 REPOPILOT_DATA_ROOT：实验绝不写真实用户数据根（与 selftest 同一条规矩）',
    );
  }
  if (input.arm === 'CROSS_REVIEW' && !input.routes.reviewerProfileId) {
    throw new EvalHarnessError('SETUP_FAILED', 'CROSS_REVIEW 臂必须指定 reviewerProfileId');
  }
  if (input.arm === 'SINGLE_WRITER' && input.routes.reviewerProfileId) {
    throw new EvalHarnessError('SETUP_FAILED', 'SINGLE_WRITER 臂不允许携带审核方 —— 两臂差异必须只有这一个变量');
  }
  const phaseTimeoutMs = input.phaseTimeoutMs ?? 60_000;
  const startedAt = nowIso();
  const started = Date.now();

  // 模板 → 一次性工作副本 → git 仓库。模板本身永不被改动
  const workDir = mkdtempSync(join(tmpdir(), 'repopilot-eval-case-'));
  cpSync(input.evalCase.repoDir, workDir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=spk010', '-c', 'user.email=spk010@eval', ...args], {
      cwd: workDir,
      stdio: 'ignore',
    });
  git('init');
  git('add', '.');
  git('commit', '-m', `eval baseline ${input.evalCase.caseId}`);

  // fresh authority：观察之间零共享内存态
  const pushes: PushEvent[] = [];
  const authority = new RunAuthority((e) => pushes.push(e), { backgroundRetention: false });
  const call = async <T>(method: string, payload: Record<string, unknown>): Promise<T> =>
    (await authority.handle(method, payload)) as T;

  const latestView = (runId: string): RunView | null => {
    for (let i = pushes.length - 1; i >= 0; i -= 1) {
      const p = pushes[i]!;
      if (p.type === 'run.updated' && p.run.runId === runId) return p.run;
    }
    return null;
  };

  try {
    const { project } = await call<{ project: { projectId: string } }>('__project.register', { hostPath: workDir });
    const imported = await call<{
      outcome: string;
      snapshot: { snapshotId: string };
      profile: { profileId: string; supportedTaskClasses: string[] };
    }>('project.import', { projectId: project.projectId });
    if (imported.outcome !== 'IMPORTED') {
      throw new EvalHarnessError('SETUP_FAILED', `case 仓库导入失败：${imported.outcome}`);
    }

    const { disclosure } = await call<{ disclosure: { digest: string; destinations: { role: string }[] } }>(
      'egress.disclosure',
      {
        snapshotId: imported.snapshot.snapshotId,
        modelProfileId: input.routes.implementerProfileId,
        ...(input.routes.reviewerProfileId ? { reviewerModelProfileId: input.routes.reviewerProfileId } : {}),
      },
    );
    // 臂完整性第一道：B 臂的披露里必须真的有 REVIEWER 目的地（降级在预览就会显形）
    if (input.arm === 'CROSS_REVIEW' && !disclosure.destinations.some((d) => d.role === 'REVIEWER')) {
      throw new EvalHarnessError(
        'ARM_INTEGRITY',
        'CROSS_REVIEW 臂的审核方在披露里被降级（不可用/缺凭据/同厂商）—— 观察作废，不密封为 B 臂结果',
      );
    }

    const { run } = await call<{ run: RunView }>('task.create', {
      projectId: project.projectId,
      snapshotId: imported.snapshot.snapshotId,
      profileId: imported.profile.profileId,
      modelProfileId: input.routes.implementerProfileId,
      egressConsentDigest: disclosure.digest,
      goal: input.evalCase.goal,
      taskClass: imported.profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
      allowedPaths: [],
      acceptance: [...input.evalCase.acceptance],
      verificationCommandIds: input.evalCase.commands.map((_, i) => `user${i + 1}`),
      customCommands: input.evalCase.commands.map((c) => ({ label: c.label, argv: [...c.argv] })),
      ...(input.routes.reviewerProfileId ? { reviewerModelProfileId: input.routes.reviewerProfileId } : {}),
    });
    const runId = run.runId;

    // 臂完整性第二道：创建后若出现降级 NOTE，同样作废（挡"预览与创建之间世界变了"）
    const created = await call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
    if (input.arm === 'CROSS_REVIEW' && created.events.some((e) => e.kind === 'NOTE' && e.summary.includes('降级为不审核'))) {
      throw new EvalHarnessError('ARM_INTEGRITY', 'CROSS_REVIEW 臂在创建时被降级为不审核 —— 观察作废');
    }

    // 驱动到止点：计划审批由 harness 代行并如实计数；补丁接受不发生
    let autoApprovals = 0;
    const phaseDeadline = () => Date.now() + phaseTimeoutMs;
    let deadline = phaseDeadline();
    for (;;) {
      const view = latestView(runId) ?? run;
      if (TERMINAL_OR_REVIEW.has(view.status)) break;
      if (view.status === 'AWAITING_PLAN_APPROVAL') {
        const { approvals } = await call<{ approvals: { approvalId: string; subjectDigest: string }[] }>(
          'approval.pending',
          { runId },
        );
        if (approvals.length > 0) {
          await call('approval.decide', {
            approvalId: approvals[0]!.approvalId,
            decision: 'APPROVE',
            subjectDigest: approvals[0]!.subjectDigest,
            note: 'SPK-010 harness 自动批准（实验语境，如实记录）',
          });
          autoApprovals += 1;
          deadline = phaseDeadline();
        }
      }
      if (Date.now() > deadline) {
        const { events } = await call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
        throw new EvalHarnessError(
          'PHASE_TIMEOUT',
          `等待终态超时（当前 ${view.status}）。最近事件：${events.slice(-5).map((e) => `${e.kind} ${e.summary}`).join(' | ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    // 采集平台事实
    const finalView = (await call<{ run: RunView | null }>('run.get', { runId })).run!;
    const { events } = await call<{ events: RunEvent[] }>('run.events', { runId, afterSeq: 0 });
    const { patch } = await call<{ patch: PatchArtifact | null }>('patch.get', { runId });
    const { crossReview } = await call<{ crossReview: CrossReviewRecord | null }>('crossreview.get', { runId });

    // 臂完整性第三道：B 臂跑完必须真的有审核记录
    if (input.arm === 'CROSS_REVIEW' && !crossReview) {
      throw new EvalHarnessError('ARM_INTEGRITY', 'CROSS_REVIEW 臂结束时没有审核记录 —— 观察作废，不密封为 B 臂结果');
    }

    const verificationRuns = events
      .filter((e) => e.kind === 'VERIFICATION_FINISHED')
      .map((e) => {
        const v = e.payload.verification as { phase?: unknown; passed?: unknown } | undefined;
        return { phase: String(v?.phase ?? e.payload.phase ?? 'UNKNOWN'), passed: v?.passed === true };
      });
    const postMutation = verificationRuns.filter((v) => v.phase === 'POST_MUTATION');
    const finalVerificationPassed = postMutation.length === 0 ? null : postMutation[postMutation.length - 1]!.passed;

    const body = {
      schemaVersion: 1 as const,
      caseId: input.evalCase.caseId,
      caseDigest: input.evalCase.caseDigest,
      arm: input.arm,
      routes: input.routes,
      runId,
      status: finalView.status,
      failureClass: finalView.failureClass ?? null,
      verificationRuns,
      finalVerificationPassed,
      patch: patch
        ? {
            digest: patch.digest,
            files: patch.files.length,
            addedLines: patch.files.reduce((n, f) => n + f.addedLines, 0),
            removedLines: patch.files.reduce((n, f) => n + f.removedLines, 0),
            unifiedDiff: patch.unifiedDiff,
          }
        : null,
      crossReview: crossReview
        ? {
            reviewerKey: crossReview.reviewerProfileId,
            parity: crossReview.vendorParity?.kind ?? 'LEGACY_BOOLEAN',
            rounds: crossReview.rounds.length,
            verdicts: {
              PASS: crossReview.rounds.filter((r) => r.verdict === 'PASS').length,
              CHANGES_REQUESTED: crossReview.rounds.filter((r) => r.verdict === 'CHANGES_REQUESTED').length,
              INCONCLUSIVE: crossReview.rounds.filter((r) => r.verdict === 'INCONCLUSIVE').length,
            },
            blockingFindings: crossReview.rounds.flatMap((r) => r.findings).filter((f) => f.blocking).length,
            remediations: crossReview.remediations,
            stopReason: crossReview.stopReason,
          }
        : null,
      ledger: finalView.ledger,
      autoApprovals,
      disclosureDigest: disclosure.digest,
      wallClockMs: Date.now() - started,
      startedAt,
      finishedAt: nowIso(),
    };
    return { ...body, digest: digestOf(body) };
  } finally {
    authority.shutdown('spk010-observation-complete');
    rmSync(workDir, { recursive: true, force: true });
  }
}
