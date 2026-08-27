/**
 * Machine pass 的唯一判定（SPK-010 收口）：fail-closed、纯函数、可独立测试。
 *
 * 报告、配对、聚合都只能经过这里 —— 不再允许各处自己维护"什么算成功"的口径
 * （旧口径只看"最终验证通过且有补丁"，候选改 check.mjs 骗绿也会被计成功）。
 *
 * 只有同时满足下列全部条件才计成功：
 *   1. digest 校验通过（损坏的行在 readObservations 已被分开，这里按标志位收）；
 *   2. observation schema 是当前支持的版本且证据字段完整；
 *   3. 存在至少一次明确失败的 BASELINE（基线不红，"修好"无从谈起）；
 *   4. 最后一次 POST_MUTATION 验证通过；
 *   5. 存在封存 patch；
 *   6. verificationInputsTouched 明确存在且为空（没碰验证脚本/配置/测试）；
 *   7. Run status 为本 Harness 的人工收口点 AWAITING_PATCH_REVIEW。
 *
 * 任何一条不满足都不得计成功，且必须给出稳定的 primary reason。
 */

export const CURRENT_OBSERVATION_SCHEMA = 2;

/** 人工收口点：Harness 的度量止于此，补丁接受在实验里不发生 */
const ELIGIBLE_STATUS = 'AWAITING_PATCH_REVIEW';

/**
 * 未计分 reason 的封闭枚举（稳定输出合同，不得合并/改名）。
 * 顺序即判定优先级：同一条 observation 可能同时违反多条，
 * 只计入优先级最高的那一个 —— 固定优先级保证各 reason 数量之和
 * 与未通过/损坏观察数对得上，不漏不重。
 */
export const MACHINE_PASS_REASONS = [
  'RESULT_DIGEST_INVALID',
  'OBSERVATION_SCHEMA_LEGACY',
  'OBSERVATION_SCHEMA_UNKNOWN',
  'OBSERVATION_EVIDENCE_INCOMPLETE',
  'BASELINE_MISSING',
  'BASELINE_NOT_FAILED',
  'POST_MUTATION_MISSING',
  'POST_MUTATION_FAILED',
  'PATCH_MISSING',
  'VERIFICATION_INPUTS_TOUCHED',
  'RUN_STATUS_INELIGIBLE',
] as const;

export type MachinePassReason = (typeof MACHINE_PASS_REASONS)[number];

export interface MachinePassVerdict {
  readonly pass: boolean;
  /** 未计分时的唯一 primary reason（按上面的固定优先级取第一个）；pass 时为 null */
  readonly reason: MachinePassReason | null;
}

export type MachinePassReasonCounts = Readonly<Record<MachinePassReason, number>>;

export function emptyReasonCounts(): MachinePassReasonCounts {
  return Object.fromEntries(MACHINE_PASS_REASONS.map((r) => [r, 0])) as MachinePassReasonCounts;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * v2 证据完整性：当前 schema 下 machine-pass 判定所需的关键字段必须在、且形状对。
 * 这不是"全部字段"校验（ledger/crossReview 等统计字段不参与判定），而是
 * "缺了它就无法判定"的字段 —— 缺了计 EVIDENCE_INCOMPLETE，不静默按成功处理。
 */
function evidenceComplete(o: Record<string, unknown>): boolean {
  for (const k of ['caseId', 'caseDigest', 'runId', 'status', 'disclosureDigest', 'startedAt', 'finishedAt']) {
    if (!isStr(o[k])) return false;
  }
  for (const k of ['autoApprovals', 'wallClockMs']) {
    if (!isNum(o[k])) return false;
  }
  if (o.arm !== 'SINGLE_WRITER' && o.arm !== 'CROSS_REVIEW') return false;
  if (!isObject(o.routes) || !isStr(o.routes.implementerProfileId)) return false;
  if (!isObject(o.ledger)) return false;
  if (typeof o.finalVerificationPassed !== 'boolean' && o.finalVerificationPassed !== null) return false;
  if (!Array.isArray(o.verificationRuns)) return false;
  for (const v of o.verificationRuns) {
    if (!isObject(v) || !isStr(v.phase) || typeof v.passed !== 'boolean') return false;
  }
  if (o.crossReview !== null && !isObject(o.crossReview)) return false;
  // patch 与 verificationInputsTouched 是配对事实：有 patch 就必须有明确的 touched 数组
  if (o.patch === null) {
    if (o.verificationInputsTouched !== null) return false;
  } else if (isObject(o.patch)) {
    const p = o.patch;
    if (!isStr(p.digest) || !isNum(p.files) || !isNum(p.addedLines) || !isNum(p.removedLines) || !isStr(p.unifiedDiff)) {
      return false;
    }
    if (!Array.isArray(o.verificationInputsTouched) || !o.verificationInputsTouched.every(isStr)) return false;
  } else {
    return false;
  }
  return true;
}

/**
 * 判定一条 observation 是否计 machine pass。
 *
 * @param record 解析出的 observation（可能是任意 JSON —— 旧版、损坏版、伪造版）
 * @param digestValid readObservations 重算 digest 的结果；false = 被篡改或写入即坏
 */
export function classifyObservation(record: unknown, digestValid: boolean): MachinePassVerdict {
  const reject = (reason: MachinePassReason): MachinePassVerdict => ({ pass: false, reason });

  // 1. digest 损坏 —— 内容不可信，后续一切判定都没有意义
  if (!digestValid) return reject('RESULT_DIGEST_INVALID');

  // 2/3. schema 版本门：缺失/非整数/过旧 = 旧版；更新 = 未知版
  const ver = isObject(record) ? record.schemaVersion : undefined;
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < CURRENT_OBSERVATION_SCHEMA) {
    return reject('OBSERVATION_SCHEMA_LEGACY');
  }
  if (ver > CURRENT_OBSERVATION_SCHEMA) return reject('OBSERVATION_SCHEMA_UNKNOWN');
  if (!isObject(record)) return reject('OBSERVATION_EVIDENCE_INCOMPLETE');

  // 4. 当前版本但证据字段缺失/形状不对
  if (!evidenceComplete(record)) return reject('OBSERVATION_EVIDENCE_INCOMPLETE');

  // 以下判定只在"证据完整"的前提下进行 —— 用原始事实 verificationRuns，
  // 不用预消化的 finalVerificationPassed（判据必须建在封存的原始事实上）
  const runs = record.verificationRuns as { phase: string; passed: boolean }[];
  const baselines = runs.filter((v) => v.phase === 'BASELINE');
  // 5. 基线必须存在且确实红过 —— 基线本来就绿，"修复"没有发生
  if (baselines.length === 0) return reject('BASELINE_MISSING');
  if (!baselines.some((v) => v.passed === false)) return reject('BASELINE_NOT_FAILED');

  // 6. 终验必须跑过且最后一次通过
  const postMutation = runs.filter((v) => v.phase === 'POST_MUTATION');
  if (postMutation.length === 0) return reject('POST_MUTATION_MISSING');
  if (postMutation[postMutation.length - 1]!.passed !== true) return reject('POST_MUTATION_FAILED');

  // 7. 必须有封存补丁
  if (record.patch === null) return reject('PATCH_MISSING');

  // 8. 补丁不得触碰验证输入 —— 改 check.mjs 让命令变绿的"通过"不构成修复证据
  if ((record.verificationInputsTouched as string[]).length > 0) return reject('VERIFICATION_INPUTS_TOUCHED');

  // 9. 度量止于人工收口点：其他终态（FAILED/BLOCKED/SUCCEEDED…）都不计
  if (record.status !== ELIGIBLE_STATUS) return reject('RUN_STATUS_INELIGIBLE');

  return { pass: true, reason: null };
}
