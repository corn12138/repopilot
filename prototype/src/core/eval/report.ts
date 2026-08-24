import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '@shared/ids';
import type { EvalArm, EvalObservation } from './runner';

/**
 * A/B 报告与盲评包（实验设计 §3、§4、§6）。
 *
 * 报告只装两类东西：机器证据（平台验证、账本）与"还没有的东西"的显式占位
 * （humanBlindEval: PENDING、样本不足告示）。主判据 verified defect delta
 * 在盲评完成前**不存在**，报告里没有任何字段能提前替它说话。
 */

export interface ArmAggregate {
  readonly arm: EvalArm;
  readonly observations: number;
  /** 平台验证通过（pass@1 口径：最后一次 POST_MUTATION 通过且有封存补丁） */
  readonly machineVerifiedPass: number;
  readonly machinePassRate: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 用量未知轮次合计 —— 未知不折 0，成本对比必须带着它 */
  readonly unknownUsageTurns: number;
  readonly avgWallClockMs: number | null;
  readonly review: {
    readonly rounds: number;
    readonly verdicts: { PASS: number; CHANGES_REQUESTED: number; INCONCLUSIVE: number };
    readonly blockingFindings: number;
    readonly remediations: number;
  } | null;
}

export interface CasePairing {
  readonly caseId: string;
  readonly caseDigest: string;
  readonly byArm: Partial<
    Record<EvalArm, { runId: string; status: string; machineVerifiedPass: boolean; patchDigest: string | null }>
  >;
  /** 两臂都在场才有：B 的机器验证通过 − A 的（1/0/-1）；缺臂为 null */
  readonly machinePassDelta: number | null;
}

export interface AbReport {
  readonly generatedAt: string;
  readonly cases: number;
  readonly pairings: readonly CasePairing[];
  readonly arms: readonly ArmAggregate[];
  /** 主判据：人工盲评 verified defect delta。盲评没做就是 PENDING，没有替代口径 */
  readonly humanBlindEval: 'PENDING';
  /** 观察数不足 PRD 靶值（20 case）时的显式告示 —— 结果只能标 PILOT / underpowered */
  readonly sampleCaveat: string | null;
  /** 回读结果文件时的坏行 / 篡改计数 —— 报告的可信度声明 */
  readonly resultFileDamage: { unparseableLines: number; digestMismatches: number };
}

const machinePass = (o: EvalObservation): boolean => o.finalVerificationPassed === true && o.patch !== null;

export function buildAbReport(
  observations: readonly EvalObservation[],
  damage: { unparseableLines: number; digestMismatches: number },
  generatedAt: string,
): AbReport {
  const arms: ArmAggregate[] = (['SINGLE_WRITER', 'CROSS_REVIEW'] as const).map((arm) => {
    const of = observations.filter((o) => o.arm === arm);
    const reviews = of.map((o) => o.crossReview).filter((r): r is NonNullable<typeof r> => r !== null);
    return {
      arm,
      observations: of.length,
      machineVerifiedPass: of.filter(machinePass).length,
      machinePassRate: of.length === 0 ? null : of.filter(machinePass).length / of.length,
      inputTokens: of.reduce((n, o) => n + o.ledger.inputTokens, 0),
      outputTokens: of.reduce((n, o) => n + o.ledger.outputTokens, 0),
      unknownUsageTurns: of.reduce((n, o) => n + (o.ledger.unknownUsageTurns ?? 0), 0),
      avgWallClockMs: of.length === 0 ? null : Math.round(of.reduce((n, o) => n + o.wallClockMs, 0) / of.length),
      review:
        arm === 'SINGLE_WRITER'
          ? null
          : {
              rounds: reviews.reduce((n, r) => n + r.rounds, 0),
              verdicts: {
                PASS: reviews.reduce((n, r) => n + r.verdicts.PASS, 0),
                CHANGES_REQUESTED: reviews.reduce((n, r) => n + r.verdicts.CHANGES_REQUESTED, 0),
                INCONCLUSIVE: reviews.reduce((n, r) => n + r.verdicts.INCONCLUSIVE, 0),
              },
              blockingFindings: reviews.reduce((n, r) => n + r.blockingFindings, 0),
              remediations: reviews.reduce((n, r) => n + r.remediations, 0),
            },
    };
  });

  const caseIds = [...new Set(observations.map((o) => o.caseId))].sort();
  const pairings: CasePairing[] = caseIds.map((caseId) => {
    const byArm: CasePairing['byArm'] = {};
    for (const o of observations.filter((x) => x.caseId === caseId)) {
      byArm[o.arm] = {
        runId: o.runId,
        status: o.status,
        machineVerifiedPass: machinePass(o),
        patchDigest: o.patch?.digest ?? null,
      };
    }
    const a = byArm.SINGLE_WRITER;
    const b = byArm.CROSS_REVIEW;
    return {
      caseId,
      caseDigest: observations.find((o) => o.caseId === caseId)!.caseDigest,
      byArm,
      machinePassDelta: a && b ? Number(b.machineVerifiedPass) - Number(a.machineVerifiedPass) : null,
    };
  });

  return {
    generatedAt,
    cases: caseIds.length,
    pairings,
    arms,
    humanBlindEval: 'PENDING',
    sampleCaveat:
      caseIds.length < 20
        ? `样本 ${caseIds.length} 个 case，低于 PRD 靶值 20 —— 一切结果只能标 PILOT / underpowered，不得进 Evidence 栏`
        : null,
    resultFileDamage: damage,
  };
}

// ---------------------------------------------------------------------------
// 盲评包
// ---------------------------------------------------------------------------

/** 盲包条目：评审员看到的全部内容。不含臂、runId、审核方、发现清单（发现只在 B 臂，带上即破盲） */
export interface BlindEntry {
  readonly label: string;
  readonly caseTitle: string;
  readonly goal: string;
  readonly unifiedDiff: string;
}

export interface BlindPacket {
  readonly entries: readonly BlindEntry[];
  /** 没有补丁可评的观察数 —— 排除必须报数 */
  readonly excludedNoPatch: number;
}

export interface BlindKey {
  readonly byLabel: Readonly<Record<string, { caseId: string; arm: EvalArm; runId: string; resultDigest: string }>>;
  readonly digest: string;
}

/**
 * 生成盲评包与密封钥匙。rng 可注入以便测试确定性；
 * 打乱的是"条目顺序 → label 的对应"，评审员无法从顺序推臂。
 */
export function buildBlindPacket(
  observations: readonly EvalObservation[],
  caseInfoOf: (caseId: string) => { title: string; goal: string },
  rng: () => number = Math.random,
): { packet: BlindPacket; key: BlindKey } {
  const withPatch = observations.filter((o) => o.patch !== null);
  const shuffled = [...withPatch];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const entries: BlindEntry[] = [];
  const byLabel: Record<string, { caseId: string; arm: EvalArm; runId: string; resultDigest: string }> = {};
  shuffled.forEach((o, i) => {
    const label = `P${String(i + 1).padStart(2, '0')}`;
    const info = caseInfoOf(o.caseId);
    entries.push({ label, caseTitle: info.title, goal: info.goal, unifiedDiff: o.patch!.unifiedDiff });
    byLabel[label] = { caseId: o.caseId, arm: o.arm, runId: o.runId, resultDigest: o.digest };
  });
  return {
    packet: { entries, excludedNoPatch: observations.length - withPatch.length },
    key: { byLabel, digest: digestOf(byLabel) },
  };
}

/** 盲包与钥匙分文件落盘：钥匙在盲评完成前不许打开（流程约束，文件名写明） */
export function writeBlindMaterials(outDir: string, packet: BlindPacket, key: BlindKey): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'blind-packet.json'), JSON.stringify(packet, null, 2), 'utf8');
  writeFileSync(join(outDir, 'blind-key.DO-NOT-OPEN-BEFORE-JUDGING.json'), JSON.stringify(key, null, 2), 'utf8');
}
