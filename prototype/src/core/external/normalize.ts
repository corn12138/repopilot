import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MutationBlockReason, MutationOperation, MutationPlan, MutationResult } from '@shared/domain';
import { newId } from '@shared/ids';
import { applyMutationPlan, type MutationPolicy } from '../mutation';
import { MaterializedWorkspace, PathViolation } from '../workspace';
import type { CandidateTreeSeal } from './author';

/**
 * candidate → canonical 的归一化边界（TD-DEC-016 的那道线在原型里的落点）。
 *
 * 外部作者在 candidate 目录里随便改；平台拿封存好的 tree diff，把每个差异翻译成
 * **P0 允许的三种 operation 之一**，再交给 applyMutationPlan —— 于是主线 generation
 * 的所有不变式对外部作者一视同仁：receipt 绑 digest、CAS、protected/allowed path、
 * 预算、失败零写入。这里没有第二套写入路径。
 *
 * 翻译规则刻意只有这几条：
 *   - MODIFIED → REPLACE_WHOLE_FILE + 在 active 上签发的 receipt。whole-file 是 P0
 *     允许的 operation；receipt 绑的是整文件 digest，apply 时重验，所以比 exact-span
 *     更不可能"改错位置"。
 *   - ADDED    → CREATE_FILE（引擎会证明 ABSENT，已存在即 TARGET_EXISTS）。
 *   - DELETED  → **整个 candidate 拒绝**。删除是 P0 hard deny（DEC-012），
 *     不把删除降级成"留一个空文件"——那是撒谎。
 *   - 未导入、未显式编辑的约定输出路径跳过并报数；已有源码与锁文件保留。
 *   - 非 UTF-8 文件 → 整个 candidate 拒绝（原型 mutation 合同只有文本 operation）。
 *
 * 任何拒绝都发生在 applyMutationPlan **之前或之内**，主线零写入。
 */

export type CandidateRejectReason =
  | 'NO_CHANGES'
  | 'DELETE_NOT_EXPRESSIBLE'
  | 'BINARY_NOT_SUPPORTED'
  | 'PATH_INVALID'
  | MutationBlockReason;

export type CandidateApplyResult =
  | {
      readonly kind: 'APPLIED';
      readonly outputGeneration: number;
      readonly treeDigest: string;
      readonly changedPaths: readonly string[];
      readonly skippedGenerated: readonly string[];
    }
  | { readonly kind: 'NO_CHANGES'; readonly skippedGenerated: readonly string[] }
  | {
      readonly kind: 'REJECTED';
      readonly reason: CandidateRejectReason;
      readonly detail: string;
      readonly paths: readonly string[];
      readonly skippedGenerated: readonly string[];
    };

export interface NormalizedPlan {
  readonly plan: MutationPlan;
  readonly skippedGenerated: readonly string[];
}

export type NormalizeResult =
  | { readonly ok: true; readonly normalized: NormalizedPlan }
  | {
      readonly ok: false;
      readonly reason: 'NO_CHANGES' | 'DELETE_NOT_EXPRESSIBLE' | 'BINARY_NOT_SUPPORTED' | 'PATH_INVALID';
      readonly detail: string;
      readonly paths: readonly string[];
      readonly skippedGenerated: readonly string[];
    };

/** 只做翻译，不落盘。receipt 在这里签发（在 active 上），apply 时由引擎重验 */
export function normalizeCandidate(
  ws: MaterializedWorkspace,
  seal: CandidateTreeSeal,
  candidatePath: string,
  runId: string,
): NormalizeResult {
  const skippedGenerated: string[] = [];
  const deleted: string[] = [];
  const binary: string[] = [];
  const invalid: string[] = [];
  const ops: MutationOperation[] = [];

  for (const change of seal.changes) {
    if (ws.isGeneratedOutputPath(change.path)) {
      skippedGenerated.push(change.path);
      continue;
    }
    if (change.kind === 'DELETED') {
      deleted.push(change.path);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(candidatePath, change.path));
    } catch {
      invalid.push(change.path);
      continue;
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      binary.push(change.path);
      continue;
    }
    if (change.kind === 'ADDED') {
      ops.push({ kind: 'CREATE_FILE', path: change.path, newText: text });
      continue;
    }
    // MODIFIED：在 active 上签 receipt。签不出来（路径逃逸/symlink/大小写绕过）就是非法路径
    try {
      // FULL_BLOB 是名副其实的：平台自己读了 active 的全文，也拿到了 candidate 的全文新内容 ——
      // 与 fs_read 只给模型看开头的情形不同，这里没有"没看过的尾部"
      const { receipt } = ws.issueReceipt(change.path, 'FULL_BLOB');
      ops.push({ kind: 'REPLACE_WHOLE_FILE', path: change.path, newText: text, receiptId: receipt.receiptId });
    } catch (err) {
      if (err instanceof PathViolation) {
        invalid.push(change.path);
        continue;
      }
      throw err;
    }
  }

  const fail = (
    reason: 'DELETE_NOT_EXPRESSIBLE' | 'BINARY_NOT_SUPPORTED' | 'PATH_INVALID' | 'NO_CHANGES',
    detail: string,
    paths: string[],
  ): NormalizeResult => ({ ok: false, reason, detail, paths, skippedGenerated });

  // 先报最严重的拒绝原因：删除 > 非法路径 > 二进制 > 空
  if (deleted.length > 0) {
    return fail(
      'DELETE_NOT_EXPRESSIBLE',
      `外部作者删除了 ${deleted.length} 个文件；删除是 P0 hard deny，整个 candidate 不采用`,
      deleted,
    );
  }
  if (invalid.length > 0) {
    return fail('PATH_INVALID', `${invalid.length} 个路径无法在主线上安全解析，整个 candidate 不采用`, invalid);
  }
  if (binary.length > 0) {
    return fail('BINARY_NOT_SUPPORTED', `${binary.length} 个文件不是 UTF-8 文本；原型只支持文本 operation`, binary);
  }
  if (ops.length === 0) {
    return fail(
      'NO_CHANGES',
      skippedGenerated.length > 0
        ? `只改动了 ${skippedGenerated.length} 个命令产物路径，没有可采用的源码变更`
        : '外部作者没有产生任何文件变更',
      [],
    );
  }

  return {
    ok: true,
    normalized: {
      plan: { planId: newId('mplan'), runId, inputGeneration: seal.baseGeneration, operations: ops },
      skippedGenerated,
    },
  };
}

/**
 * 归一化 + 应用。唯一的落盘路径仍是 applyMutationPlan；这里只是把它的结果翻译成
 * "candidate 被采用 / 没有变更 / 被拒绝" 三态，供编排层与界面使用。
 */
export function applyCandidate(
  ws: MaterializedWorkspace,
  seal: CandidateTreeSeal,
  candidatePath: string,
  runId: string,
  policy: MutationPolicy,
): CandidateApplyResult {
  const normalized = normalizeCandidate(ws, seal, candidatePath, runId);
  if (!normalized.ok) {
    if (normalized.reason === 'NO_CHANGES') {
      return { kind: 'NO_CHANGES', skippedGenerated: normalized.skippedGenerated };
    }
    return {
      kind: 'REJECTED',
      reason: normalized.reason,
      detail: normalized.detail,
      paths: normalized.paths,
      skippedGenerated: normalized.skippedGenerated,
    };
  }
  const { plan, skippedGenerated } = normalized.normalized;
  const result: MutationResult = applyMutationPlan(ws, plan, policy);
  if (!result.ok) {
    return {
      kind: 'REJECTED',
      reason: result.reason,
      detail: result.detail,
      paths: plan.operations.map((o) => o.path),
      skippedGenerated,
    };
  }
  return {
    kind: 'APPLIED',
    outputGeneration: result.outputGeneration,
    treeDigest: result.treeDigest,
    changedPaths: result.operations.map((o) => o.path),
    skippedGenerated,
  };
}
