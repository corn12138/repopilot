import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 测试绝不碰真实数据根（~/Library/Application Support/RepoPilotPrototype）：
 * 并行的测试文件共享真根会互相踩（retention 的清扫会删掉别人的快照 ——
 * 528 全绿的套件曾因此随机红 3-4 条），而且会在用户机器上留垃圾，
 * 违反「自检和测试不能留下持久化改动」。vi.mock 提升到 import 之前，
 * 本文件模块图里的 paths 全部指向进程私有临时目录。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkdtempSync(j(tmpdir(), 'repopilot-test-data-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
  } as const;
  const ensure = () => {
    for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
      mkdirSync(d, { recursive: true });
    }
  };
  ensure();
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: ensure,
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import { newId } from '@shared/ids';
import { applyMutationPlan, globMatch, DEFAULT_MUTATION_POLICY } from './mutation';
import { importSnapshot, resolveProfile } from './repo';
import { MaterializedWorkspace, listTree } from './workspace';
import { PATHS, ensureDataRoot } from './paths';

/**
 * Mutation 引擎的负向测试。
 *
 * 这些用例对应 PRD-MUT-002/003 里"必须 fail-closed"的条款。
 * 每一条断言的核心都是同一句话：**失败时工作区必须逐字节不变**。
 */

let hostRepo: string;
let workspace: MaterializedWorkspace;
let runId: string;

function setupRepo(files: Record<string, string>): void {
  hostRepo = mkdtempSync(join(tmpdir(), 'repopilot-fixture-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(hostRepo, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['init', '-q'], { cwd: hostRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: hostRepo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: hostRepo });
  execFileSync('git', ['add', '-A'], { cwd: hostRepo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: hostRepo });
}

function makeWorkspace(): void {
  ensureDataRoot();
  const snapshot = importSnapshot('proj_test', hostRepo);
  runId = newId('run');
  workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);
}

/** 整棵树的指纹 —— 用来断言"失败后什么都没变" */
function fingerprint(): string {
  return JSON.stringify(listTree(workspace.activePath));
}

beforeEach(() => {
  setupRepo({
    'src/app.ts': 'const a = 1;\nconst b = 2;\nexport const total = a + b;\n',
    'src/dup.ts': 'const x = 1;\nconst x2 = 1;\nconst y = 1;\n',
    'package.json': '{"name":"fixture","version":"1.0.0"}\n',
  });
  makeWorkspace();
});

afterEach(() => {
  rmSync(hostRepo, { recursive: true, force: true });
  workspace?.cleanup();
});

describe('exact-span replace', () => {
  it('唯一命中时原子提交，并推进 generation', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    const before = workspace.activeGeneration;

    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: before,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          oldText: 'const b = 2;',
          newText: 'const b = 42;',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(workspace.activeGeneration).toBe(before + 1);
    expect(workspace.readText('src/app.ts')).toContain('const b = 42;');
  });

  it('0 次命中 → ZERO_MATCH，且不做模糊匹配', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    const snapshotBefore = fingerprint();

    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          // 只差一个空格 —— fuzzy apply 会"帮忙"改掉，这里必须拒绝
          oldText: 'const b  = 2;',
          newText: 'const b = 42;',
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ZERO_MATCH');
    expect(fingerprint()).toBe(snapshotBefore);
  });

  it('多次命中 → MULTIPLE_MATCH，绝不改第一个', () => {
    const { receipt } = workspace.issueReceipt('src/dup.ts', 'FULL_BLOB');
    const snapshotBefore = fingerprint();

    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/dup.ts',
          receiptId: receipt.receiptId,
          oldText: ' = 1;',
          newText: ' = 9;',
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MULTIPLE_MATCH');
    expect(fingerprint()).toBe(snapshotBefore);
  });

  it('同一文件多次顺序编辑：后一次基于前一次的结果', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');

    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          oldText: 'const a = 1;',
          newText: 'const a = 10;',
        },
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          oldText: 'const b = 2;',
          newText: 'const b = 20;',
        },
      ],
    });

    expect(result.ok).toBe(true);
    const text = workspace.readText('src/app.ts');
    expect(text).toContain('const a = 10;');
    expect(text).toContain('const b = 20;');
  });
});

describe('read receipt', () => {
  it('缺少 receipt → RECEIPT_MISSING', () => {
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        { kind: 'REPLACE_WHOLE_FILE', path: 'src/app.ts', newText: 'whatever' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('RECEIPT_MISSING');
  });

  /*
   * 08-17 审计 MUT-receipt-coverage-vs-truncated-read：fs_read 只把头部给模型，
   * 却签发覆盖全文的 receipt —— 模型据此整文件替换，尾部被静默删除。
   */
  it('BYTE_RANGE receipt + REPLACE_WHOLE_FILE → RECEIPT_COVERAGE_INSUFFICIENT，工作区逐字节不变', () => {
    const before = fingerprint();
    const { receipt } = workspace.issueReceipt('src/app.ts', 'BYTE_RANGE', 12);
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_WHOLE_FILE',
          path: 'src/app.ts',
          newText: 'const a = 1;\n', // 只保留了开头那行 —— 正是"尾部被静默删掉"的形态
          receiptId: receipt.receiptId,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('RECEIPT_COVERAGE_INSUFFICIENT');
      expect(result.detail).toContain('12/');
      expect(result.detail).toContain('REPLACE_EXACT_TEXT_SPAN');
    }
    expect(fingerprint()).toBe(before);
    expect(workspace.activeGeneration).toBe(0);
  });

  it('BYTE_RANGE receipt 仍可用于 exact-span —— 命中唯一性由引擎在真实全文里校验', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'BYTE_RANGE', 12);
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          oldText: 'const b = 2;',
          newText: 'const b = 3;',
          receiptId: receipt.receiptId,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace.activePath, 'src/app.ts'), 'utf8')).toContain('const b = 3;');
  });

  it('FULL_BLOB receipt 的整文件替换照常通过（规则没有误伤）', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        { kind: 'REPLACE_WHOLE_FILE', path: 'src/app.ts', newText: 'export const total = 9;\n', receiptId: receipt.receiptId },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('切代后旧 receipt 失效 → RECEIPT_MISSING', () => {
    const first = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    // 用另一个 receipt 推进一代
    const second = workspace.issueReceipt('src/dup.ts', 'FULL_BLOB');
    const advance = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/dup.ts',
          receiptId: second.receipt.receiptId,
          oldText: 'const y = 1;',
          newText: 'const y = 2;',
        },
      ],
    });
    expect(advance.ok).toBe(true);

    const stale = applyMutationPlan(workspace, {
      planId: 'p2',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: first.receipt.receiptId,
          oldText: 'const a = 1;',
          newText: 'const a = 3;',
        },
      ],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('RECEIPT_MISSING');
  });

  it('plan 基于旧 generation → STALE_GENERATION', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration - 1,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          oldText: 'const a = 1;',
          newText: 'const a = 3;',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('STALE_GENERATION');
  });
});

describe('create file', () => {
  it('目标不存在时创建成功', () => {
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [{ kind: 'CREATE_FILE', path: 'src/nested/new.ts', newText: 'export const n = 1;\n' }],
    });
    expect(result.ok).toBe(true);
    expect(workspace.readText('src/nested/new.ts')).toBe('export const n = 1;\n');
  });

  it('目标已存在 → TARGET_EXISTS，不做隐式覆盖', () => {
    const snapshotBefore = fingerprint();
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [{ kind: 'CREATE_FILE', path: 'src/app.ts', newText: 'overwritten' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TARGET_EXISTS');
    expect(fingerprint()).toBe(snapshotBefore);
  });
});

describe('路径策略', () => {
  it('绝对路径 → PATH_ESCAPE', () => {
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [{ kind: 'CREATE_FILE', path: '/tmp/evil.ts', newText: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PATH_ESCAPE');
  });

  it('.. 逃逸 → PATH_ESCAPE', () => {
    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [{ kind: 'CREATE_FILE', path: '../escaped.ts', newText: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PATH_ESCAPE');
  });

  it('受保护路径 → PROTECTED_PATH', () => {
    const { receipt } = workspace.issueReceipt('package.json', 'FULL_BLOB');
    const result = applyMutationPlan(
      workspace,
      {
        planId: 'p1',
        runId,
        inputGeneration: workspace.activeGeneration,
        operations: [
          {
            kind: 'REPLACE_WHOLE_FILE',
            path: 'package.json',
            receiptId: receipt.receiptId,
            newText: '{}',
          },
        ],
      },
      { ...DEFAULT_MUTATION_POLICY, protectedPaths: ['package.json'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PROTECTED_PATH');
  });

  it('大小写变体绕过受保护路径 → 整笔拒绝，package.json 逐字节不变', () => {
    // 攻击链：fs_read('Package.json') 拿 receipt（APFS 大小写不敏感读成功）
    // → REPLACE_WHOLE_FILE path='Package.json' 覆盖 package.json，
    // 而 protectedPaths=['package.json'] 的大小写敏感匹配对不上 'Package.json'。
    // resolveManaged 的 PATH_CASE_MISMATCH 必须在写入前把整笔拦下。
    const before = workspace.readText('package.json');

    // 在大小写敏感的 fs 上（多数 Linux CI），'Package.json' 是另一个不存在的路径，
    // issueReceipt 会直接失败，这条攻击根本不成立 —— 跳过。
    let receiptId: string;
    try {
      receiptId = workspace.issueReceipt('Package.json', 'FULL_BLOB').receipt.receiptId;
    } catch {
      return;
    }

    const result = applyMutationPlan(
      workspace,
      {
        planId: 'p1',
        runId,
        inputGeneration: workspace.activeGeneration,
        operations: [
          {
            kind: 'REPLACE_WHOLE_FILE',
            path: 'Package.json',
            receiptId,
            newText: '{"scripts":{"build":"true"}}',
          },
        ],
      },
      { ...DEFAULT_MUTATION_POLICY, protectedPaths: ['package.json'] },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PATH_CASE_MISMATCH');
    // 最硬的断言：真实文件一个字节都没被改
    expect(workspace.readText('package.json')).toBe(before);
  });

  it('不在 allowedPaths 内 → PATH_NOT_ALLOWED', () => {
    const result = applyMutationPlan(
      workspace,
      {
        planId: 'p1',
        runId,
        inputGeneration: workspace.activeGeneration,
        operations: [{ kind: 'CREATE_FILE', path: 'docs/readme.md', newText: 'x' }],
      },
      { ...DEFAULT_MUTATION_POLICY, allowedPaths: ['src/**'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PATH_NOT_ALLOWED');
  });
});

describe('原子性', () => {
  it('批次中任一 operation 失败 → 整批零写入', () => {
    const { receipt } = workspace.issueReceipt('src/app.ts', 'FULL_BLOB');
    const snapshotBefore = fingerprint();

    const result = applyMutationPlan(workspace, {
      planId: 'p1',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        // 第一个是合法的
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/app.ts',
          receiptId: receipt.receiptId,
          oldText: 'const a = 1;',
          newText: 'const a = 100;',
        },
        // 第二个非法 —— 整批都不能生效
        { kind: 'CREATE_FILE', path: 'src/dup.ts', newText: 'collision' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TARGET_EXISTS');
    expect(fingerprint()).toBe(snapshotBefore);
    expect(workspace.readText('src/app.ts')).toContain('const a = 1;');
  });
});

describe('快照与 profile', () => {
  it('tracked-only 快照不包含 .git', () => {
    const files = listTree(workspace.activePath).map((f) => f.path);
    expect(files.some((f) => f.startsWith('.git'))).toBe(false);
    expect(files).toContain('src/app.ts');
  });

  it('dirty worktree 不阻断导入，但如实标记为工作区基线', () => {
    writeFileSync(join(hostRepo, 'src/app.ts'), 'dirty', 'utf8');
    const snap = importSnapshot('proj_test', hostRepo);
    expect(snap.baseKind).toBe('DIRTY_WORKTREE');
    expect(snap.dirtyFileCount).toBe(1);
  });

  it('非 Vite 仓库不会得到 VERIFIED', () => {
    const snapshot = importSnapshot('proj_test2', hostRepo);
    const profile = resolveProfile(snapshot);
    expect(profile.supportStatus).not.toBe('VERIFIED');
    expect(profile.supportedTaskClasses).toHaveLength(0);
  });
});

describe('globMatch', () => {
  it.each([
    ['**', 'a/b/c.ts', true],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'docs/a.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['**/*.test.ts', 'src/a/b.test.ts', true],
    ['**/*.test.ts', 'b.test.ts', true],
    ['package.json', 'package.json', true],
    ['package.json', 'src/package.json', false],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });
});
