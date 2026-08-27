import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digestOf } from '@shared/ids';
import type { EvalObservation } from './runner';

/**
 * sealed EvalResult 的落盘与回读（实验设计 §5.4）。
 *
 * append-only JSONL：结果只增不改。回读时逐条校验 digest ——
 * 坏行与被篡改的条目**计数上报**而不是静默丢弃：
 * "结果文件里有一条不可信"与"实验本来就只有这些观察"必须可区分。
 */

export interface EvalResultsRead {
  readonly observations: readonly EvalObservation[];
  readonly unparseableLines: number;
  /** JSON 读得出来但 digest 对不上 —— 被改动过或写入时就是坏的 */
  readonly digestMismatches: number;
  /**
   * digest 对不上的原始记录本体。不静默丢弃：交给判定层计 RESULT_DIGEST_INVALID，
   * 与"实验本来就只有这些观察"可区分。内容不可信，只用于计数。
   */
  readonly digestInvalidRecords: readonly unknown[];
}

export function resultsPath(outDir: string): string {
  return join(outDir, 'results.jsonl');
}

export function appendObservation(outDir: string, obs: EvalObservation): void {
  const file = resultsPath(outDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obs)}\n`, 'utf8');
}

/** 重算一条观察的 digest（digestOf 是键排序稳定的，JSON 往返不影响） */
export function observationDigest(obs: EvalObservation): string {
  const { digest: _digest, ...body } = obs;
  return digestOf(body);
}

export function readObservations(outDir: string): EvalResultsRead {
  const file = resultsPath(outDir);
  if (!existsSync(file)) {
    return { observations: [], unparseableLines: 0, digestMismatches: 0, digestInvalidRecords: [] };
  }
  const observations: EvalObservation[] = [];
  const digestInvalidRecords: unknown[] = [];
  let unparseableLines = 0;
  let digestMismatches = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obs: EvalObservation;
    try {
      obs = JSON.parse(trimmed) as EvalObservation;
    } catch {
      unparseableLines += 1;
      continue;
    }
    if (observationDigest(obs) !== obs.digest) {
      digestMismatches += 1;
      digestInvalidRecords.push(obs); // 计数之外保留本体 —— 不静默丢弃
      continue;
    }
    observations.push(obs);
  }
  return { observations, unparseableLines, digestMismatches, digestInvalidRecords };
}
