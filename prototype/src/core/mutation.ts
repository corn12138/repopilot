import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MutationBlockReason,
  MutationOperation,
  MutationOperationResult,
  MutationPlan,
  MutationResult,
} from '@shared/domain';
import { sha256 } from '@shared/ids';
import { MaterializedWorkspace, PathViolation, fileDigestAt, resolveManaged } from './workspace';

export interface MutationPolicy {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly maxOperations: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_MUTATION_POLICY: MutationPolicy = {
  allowedPaths: ['**'],
  protectedPaths: [],
  maxOperations: 20,
  maxBytesPerFile: 400_000,
  maxTotalBytes: 2_000_000,
};

class Blocked extends Error {
  constructor(
    readonly reason: MutationBlockReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

interface SimFile {
  readonly path: string;
  readonly originalDigest: string | null;
  content: string;
  touched: boolean;
}

/**
 * 应用一个 WorkspaceMutationPlan。
 *
 * 这是整个原型里唯一的落盘路径。契约（PRD-MUT-001..004）：
 *
 *   1. 模型只能提交结构化 operation，拿不到通用 FS/shell 写接口。
 *   2. 每个改动现有文件的 operation 必须带 MutationReadReceipt；receipt 绑定的
 *      generation 与 digest 在事务开始时校验，**receipt 本身不是写权限凭据**。
 *   3. exact-span replace 的 oldText 必须恰好命中一次。
 *      0 次 → ZERO_MATCH，多次 → MULTIPLE_MATCH。两者都零写入，绝不 fuzzy 重定位。
 *   4. create-file 的目标必须可证明 ABSENT；已存在 → TARGET_EXISTS，不隐式覆盖。
 *   5. 事务先在**内存中完整模拟**一遍；只有全部通过才建 staged generation 落盘。
 *   6. 只有全部写入成功才 CAS 切换 active generation。
 *
 * 失败时 workspace 与调用前逐字节相同 —— 不存在部分提交。
 */
export function applyMutationPlan(
  ws: MaterializedWorkspace,
  plan: MutationPlan,
  policy: MutationPolicy = DEFAULT_MUTATION_POLICY,
): MutationResult {
  const expectedActive = ws.activeGeneration;

  if (plan.inputGeneration !== expectedActive) {
    return blocked(
      'STALE_GENERATION',
      `plan 基于 gen-${plan.inputGeneration}，当前 active 是 gen-${expectedActive}`,
      expectedActive,
    );
  }
  if (plan.operations.length === 0) {
    return blocked('BUDGET_EXCEEDED', 'mutation plan 为空', expectedActive);
  }
  if (plan.operations.length > policy.maxOperations) {
    return blocked(
      'BUDGET_EXCEEDED',
      `operation 数 ${plan.operations.length} 超过上限 ${policy.maxOperations}`,
      expectedActive,
    );
  }

  // ---- 阶段 1：内存中完整模拟整笔事务。任何失败 = 零写入。 ----
  let sim: Map<string, SimFile>;
  try {
    sim = simulate(ws, plan, policy);
  } catch (err) {
    if (err instanceof Blocked) return blocked(err.reason, err.detail, expectedActive);
    if (err instanceof PathViolation) return blocked(err.reason, err.message, expectedActive);
    throw err;
  }

  // ---- 阶段 2：把模拟结果写进 staged generation ----
  const staged = ws.stage();
  const results: MutationOperationResult[] = [];
  try {
    for (const file of sim.values()) {
      if (!file.touched) continue;
      const abs = resolveManaged(staged.path, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, 'utf8');
      const kind: MutationOperation['kind'] =
        file.originalDigest === null ? 'CREATE_FILE' : 'REPLACE_EXACT_TEXT_SPAN';
      results.push({
        path: file.path,
        kind: plan.operations.find((o) => o.path === file.path)?.kind ?? kind,
        beforeDigest: file.originalDigest,
        afterDigest: sha256(Buffer.from(file.content, 'utf8')),
        bytesDelta:
          Buffer.byteLength(file.content, 'utf8') -
          (file.originalDigest === null ? 0 : originalBytes(ws, file.path)),
      });
    }
  } catch (err) {
    ws.discard(staged.generation); // rollback：staged 整个丢弃，active 不动
    if (err instanceof Blocked) return blocked(err.reason, err.detail, expectedActive);
    if (err instanceof PathViolation) return blocked(err.reason, err.message, expectedActive);
    throw err;
  }

  // ---- 阶段 3：CAS 提交 ----
  if (!ws.commit(staged.generation, expectedActive)) {
    ws.discard(staged.generation);
    return blocked(
      'STALE_GENERATION',
      'CAS 失败：active generation 在事务期间被改变',
      ws.activeGeneration,
    );
  }

  return {
    ok: true,
    outputGeneration: ws.activeGeneration,
    operations: results,
    treeDigest: ws.treeDigest(),
  };
}

// ---------------------------------------------------------------------------

function simulate(
  ws: MaterializedWorkspace,
  plan: MutationPlan,
  policy: MutationPolicy,
): Map<string, SimFile> {
  const active = ws.activePath;
  const sim = new Map<string, SimFile>();
  let totalBytes = 0;

  for (const op of plan.operations) {
    if (isProtected(op.path, policy.protectedPaths)) {
      throw new Blocked('PROTECTED_PATH', `${op.path} 命中受保护路径`);
    }
    if (!isAllowed(op.path, policy.allowedPaths)) {
      throw new Blocked('PATH_NOT_ALLOWED', `${op.path} 不在 TaskSpec 允许范围内`);
    }
    resolveManaged(active, op.path); // 触发 PATH_ESCAPE / SYMLINK_REJECTED

    let file = sim.get(op.path);

    if (!file) {
      // 首次触碰这个路径：在此校验 receipt / 存在性
      const currentDigest = fileDigestAt(active, op.path);

      if (op.kind === 'CREATE_FILE') {
        if (currentDigest !== null) {
          throw new Blocked('TARGET_EXISTS', `${op.path} 已存在，CREATE_FILE 不做隐式覆盖`);
        }
        file = { path: op.path, originalDigest: null, content: '', touched: false };
      } else {
        verifyReceipt(ws, op, currentDigest);
        file = {
          path: op.path,
          originalDigest: currentDigest,
          content: readFileSync(resolveManaged(active, op.path), 'utf8'),
          touched: false,
        };
      }
      sim.set(op.path, file);
    } else if (op.kind === 'CREATE_FILE') {
      throw new Blocked('TARGET_EXISTS', `${op.path} 在本次事务中已被创建`);
    }

    // 对**演化后的内容**应用 operation，允许同文件多次顺序编辑
    file.content = applyToContent(op, file.content);
    file.touched = true;

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > policy.maxBytesPerFile) {
      throw new Blocked('BUDGET_EXCEEDED', `${op.path} 超过单文件上限 ${policy.maxBytesPerFile} 字节`);
    }
  }

  for (const file of sim.values()) {
    if (file.touched) totalBytes += Buffer.byteLength(file.content, 'utf8');
  }
  if (totalBytes > policy.maxTotalBytes) {
    throw new Blocked('BUDGET_EXCEEDED', `本次 mutation 总字节 ${totalBytes} 超限`);
  }

  return sim;
}

function verifyReceipt(
  ws: MaterializedWorkspace,
  op: MutationOperation,
  currentDigest: string | null,
): void {
  if (!op.receiptId) {
    throw new Blocked('RECEIPT_MISSING', `${op.path} 缺少 MutationReadReceipt`);
  }
  const receipt = ws.getReceipt(op.receiptId);
  if (!receipt) {
    throw new Blocked('RECEIPT_MISSING', `receipt ${op.receiptId} 不存在或已随切代失效`);
  }
  if (Date.parse(receipt.expiresAt) < Date.now()) {
    throw new Blocked('RECEIPT_EXPIRED', `receipt ${op.receiptId} 已过期，请重新读取文件`);
  }
  if (receipt.path !== op.path) {
    throw new Blocked('RECEIPT_MISSING', `receipt 绑定的是 ${receipt.path}，与 ${op.path} 不符`);
  }
  if (receipt.generation !== ws.activeGeneration) {
    throw new Blocked(
      'STALE_GENERATION',
      `receipt 绑定 gen-${receipt.generation}，当前 gen-${ws.activeGeneration}`,
    );
  }
  if (currentDigest === null) {
    throw new Blocked('TARGET_ABSENT', `${op.path} 不存在`);
  }
  if (currentDigest !== receipt.fileDigest) {
    throw new Blocked('STALE_FILE_DIGEST', `${op.path} 内容自读取后已变化，需重新读取`);
  }
}

function applyToContent(op: MutationOperation, content: string): string {
  switch (op.kind) {
    case 'CREATE_FILE':
    case 'REPLACE_WHOLE_FILE':
      return op.newText;
    case 'REPLACE_EXACT_TEXT_SPAN': {
      const oldText = op.oldText;
      if (typeof oldText !== 'string' || oldText.length === 0) {
        throw new Blocked('ZERO_MATCH', `${op.path} 的 oldText 为空`);
      }
      const first = content.indexOf(oldText);
      if (first < 0) {
        throw new Blocked(
          'ZERO_MATCH',
          `${op.path} 中找不到 oldText —— 不做模糊匹配，请重新读取文件再改`,
        );
      }
      if (content.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Blocked(
          'MULTIPLE_MATCH',
          `${op.path} 中 oldText 命中多次 —— 请扩大上下文使其唯一`,
        );
      }
      return content.slice(0, first) + op.newText + content.slice(first + oldText.length);
    }
  }
}

function originalBytes(ws: MaterializedWorkspace, relPath: string): number {
  try {
    const abs = resolveManaged(ws.activePath, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) return 0;
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function blocked(reason: MutationBlockReason, detail: string, gen: number): MutationResult {
  return { ok: false, reason, detail, rolledBackToGeneration: gen };
}

/** 极简 glob：支持 `**\/`、`**`、`*` 与精确匹配 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if ('.+^${}()|[]\\?'.includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

function isAllowed(path: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.some((p) => globMatch(p, path));
}

function isProtected(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((p) => globMatch(p, path));
}
