import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 与 mutation.test.ts 同一套隔离：测试绝不碰真实数据根
vi.mock('../paths', async () => {
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
import { DEFAULT_MUTATION_POLICY, applyMutationPlan } from '../mutation';
import { ensureDataRoot } from '../paths';
import { importSnapshot } from '../repo';
import { MaterializedWorkspace, listTree } from '../workspace';
import { diffTrees, type CandidateTreeSeal } from './author';
import { applyCandidate, normalizeCandidate } from './normalize';

/**
 * candidate → canonical 归一化的负向测试。
 *
 * 核心断言只有一句：**外部作者在 candidate 里干了什么，主线要么完整采用、
 * 要么逐字节不变** —— 没有"采用一半"，也没有绕过 applyMutationPlan 的第二条落盘路径。
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

function fingerprint(): string {
  return JSON.stringify(listTree(workspace.activePath));
}

/** 模拟"外部作者退出后"的封存：对 candidate 目录做真实 tree diff */
function sealOf(candidate: ReturnType<MaterializedWorkspace['exportCandidate']>): CandidateTreeSeal {
  const now = listTree(candidate.path);
  return {
    candidateId: candidate.candidateId,
    baseGeneration: candidate.baseGeneration,
    baseTreeDigest: 'sha256:base',
    candidateTreeDigest: 'sha256:now',
    changes: diffTrees(candidate.baseTree, now),
    authorNote: null,
  };
}

const policy = {
  ...DEFAULT_MUTATION_POLICY,
  allowedPaths: ['**'],
  protectedPaths: ['package.json', '.github/**'],
};

beforeEach(() => {
  setupRepo({
    'src/app.ts': 'export const total = 1 + 1;\n',
    'src/util.ts': 'export const id = (x: number) => x;\n',
    'package.json': '{"name":"fixture","version":"1.0.0"}\n',
  });
  ensureDataRoot();
  const snapshot = importSnapshot('proj_test', hostRepo);
  runId = newId('run');
  workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);
});

afterEach(() => {
  rmSync(hostRepo, { recursive: true, force: true });
  workspace?.cleanup();
});

describe('exportCandidate / discardCandidate', () => {
  it('candidate 是 active 的内容副本，不是 generation；改它不改主线', () => {
    const before = fingerprint();
    const c = workspace.exportCandidate();
    expect(c.baseGeneration).toBe(workspace.activeGeneration);
    expect(c.baseTree.map((f) => f.path)).toEqual(['package.json', 'src/app.ts', 'src/util.ts']);
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 3;\n');
    expect(fingerprint()).toBe(before);
    expect(workspace.activeGeneration).toBe(0);
    workspace.discardCandidate(c.path);
  });

  it('discardCandidate 只接受本工作区根下的 candidate-* 路径', () => {
    const c = workspace.exportCandidate();
    expect(() => workspace.discardCandidate(workspace.activePath)).toThrow(/拒绝删除/);
    expect(() => workspace.discardCandidate('/tmp')).toThrow(/拒绝删除/);
    workspace.discardCandidate(c.path);
  });
});

describe('normalize：翻译规则', () => {
  it('MODIFIED → REPLACE_WHOLE_FILE + receipt；ADDED → CREATE_FILE；产物路径跳过但报数', () => {
    const c = workspace.exportCandidate();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    mkdirSync(join(c.path, 'src/new'), { recursive: true });
    writeFileSync(join(c.path, 'src/new/x.ts'), 'export const x = 1;\n');
    mkdirSync(join(c.path, 'dist'), { recursive: true });
    writeFileSync(join(c.path, 'dist/bundle.js'), 'built');

    const r = normalizeCandidate(workspace, sealOf(c), c.path, runId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kinds = r.normalized.plan.operations.map((o) => [o.path, o.kind, Boolean(o.receiptId)]);
    expect(kinds).toEqual([
      ['src/app.ts', 'REPLACE_WHOLE_FILE', true],
      ['src/new/x.ts', 'CREATE_FILE', false],
    ]);
    expect(r.normalized.skippedGenerated).toEqual(['dist/bundle.js']);
    expect(r.normalized.plan.inputGeneration).toBe(c.baseGeneration);
    workspace.discardCandidate(c.path);
  });

  it('DELETED → 整个 candidate 拒绝（删除是 P0 hard deny），不把删除降级成空文件', () => {
    const c = workspace.exportCandidate();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    unlinkSync(join(c.path, 'src/util.ts'));
    const r = normalizeCandidate(workspace, sealOf(c), c.path, runId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('DELETE_NOT_EXPRESSIBLE');
    expect(r.paths).toEqual(['src/util.ts']);
    workspace.discardCandidate(c.path);
  });

  it('非 UTF-8 文件 → BINARY_NOT_SUPPORTED，整个 candidate 拒绝', () => {
    const c = workspace.exportCandidate();
    writeFileSync(join(c.path, 'src/app.ts'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const r = normalizeCandidate(workspace, sealOf(c), c.path, runId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('BINARY_NOT_SUPPORTED');
    expect(r.paths).toEqual(['src/app.ts']);
    workspace.discardCandidate(c.path);
  });

  it('只动了命令产物 → NO_CHANGES，并说明是产物路径', () => {
    const c = workspace.exportCandidate();
    mkdirSync(join(c.path, 'coverage'), { recursive: true });
    writeFileSync(join(c.path, 'coverage/lcov.info'), 'TN:\n');
    const r = normalizeCandidate(workspace, sealOf(c), c.path, runId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NO_CHANGES');
    expect(r.skippedGenerated).toEqual(['coverage/lcov.info']);
    expect(r.detail).toContain('命令产物');
    workspace.discardCandidate(c.path);
  });
});

describe('applyCandidate：要么完整采用，要么主线逐字节不变', () => {
  it('合法变更经 applyMutationPlan 落成新 generation；candidate 本身不是 generation', () => {
    const c = workspace.exportCandidate();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    writeFileSync(join(c.path, 'src/added.ts'), 'export const y = 2;\n');
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, policy);
    expect(r.kind).toBe('APPLIED');
    if (r.kind !== 'APPLIED') return;
    expect(r.outputGeneration).toBe(1);
    expect(workspace.activeGeneration).toBe(1);
    expect(readFileSync(workspace.resolveInActive('src/app.ts'), 'utf8')).toBe('export const total = 2;\n');
    expect(readFileSync(workspace.resolveInActive('src/added.ts'), 'utf8')).toBe('export const y = 2;\n');
    expect(r.changedPaths).toEqual(['src/added.ts', 'src/app.ts']);
    workspace.discardCandidate(c.path);
  });

  it('触碰受保护路径 → 引擎 PROTECTED_PATH 拒绝，连同其他合法改动一起零写入', () => {
    const c = workspace.exportCandidate();
    const before = fingerprint();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    writeFileSync(join(c.path, 'package.json'), '{"name":"fixture","version":"9.9.9"}\n');
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, policy);
    expect(r.kind).toBe('REJECTED');
    if (r.kind !== 'REJECTED') return;
    expect(r.reason).toBe('PROTECTED_PATH');
    expect(fingerprint()).toBe(before);
    expect(workspace.activeGeneration).toBe(0);
    workspace.discardCandidate(c.path);
  });

  it('allowedPaths 收窄时，范围外改动 → PATH_NOT_ALLOWED，零写入', () => {
    const c = workspace.exportCandidate();
    const before = fingerprint();
    writeFileSync(join(c.path, 'src/util.ts'), 'export const id = (x: number) => x + 0;\n');
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, { ...policy, allowedPaths: ['src/app.ts'] });
    expect(r.kind).toBe('REJECTED');
    if (r.kind !== 'REJECTED') return;
    expect(r.reason).toBe('PATH_NOT_ALLOWED');
    expect(fingerprint()).toBe(before);
    workspace.discardCandidate(c.path);
  });

  it('主线在作者工作期间被别的事务推进 → STALE_GENERATION，不把旧 candidate 叠上去', () => {
    const c = workspace.exportCandidate();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    // 平台自己（或另一条路径）先推进了一代
    const { receipt } = workspace.issueReceipt('src/util.ts', 'FULL_BLOB');
    const advanced = applyCandidateLikeInternal(receipt.receiptId);
    expect(advanced).toBe(true);
    const before = fingerprint();
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, policy);
    expect(r.kind).toBe('REJECTED');
    if (r.kind !== 'REJECTED') return;
    expect(r.reason).toBe('STALE_GENERATION');
    expect(fingerprint()).toBe(before);
    workspace.discardCandidate(c.path);
  });

  it('文件数超过 maxOperations → BUDGET_EXCEEDED，零写入（外部作者也没有预算特权）', () => {
    const c = workspace.exportCandidate();
    const before = fingerprint();
    for (let i = 0; i < 25; i += 1) writeFileSync(join(c.path, `src/f${i}.ts`), `export const f${i} = ${i};\n`);
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, policy);
    expect(r.kind).toBe('REJECTED');
    if (r.kind !== 'REJECTED') return;
    expect(r.reason).toBe('BUDGET_EXCEEDED');
    expect(fingerprint()).toBe(before);
    workspace.discardCandidate(c.path);
  });

  it('DELETED 与合法修改同时出现 → 整笔拒绝，合法的那部分也不采用', () => {
    const c = workspace.exportCandidate();
    const before = fingerprint();
    writeFileSync(join(c.path, 'src/app.ts'), 'export const total = 2;\n');
    unlinkSync(join(c.path, 'src/util.ts'));
    const r = applyCandidate(workspace, sealOf(c), c.path, runId, policy);
    expect(r.kind).toBe('REJECTED');
    expect(fingerprint()).toBe(before);
    workspace.discardCandidate(c.path);
  });
});

/** 用内部路径推进一代，模拟"作者还在写的时候主线变了" */
function applyCandidateLikeInternal(receiptId: string): boolean {
  const r = applyMutationPlan(
    workspace,
    {
      planId: 'p-internal',
      runId,
      inputGeneration: workspace.activeGeneration,
      operations: [
        {
          kind: 'REPLACE_EXACT_TEXT_SPAN',
          path: 'src/util.ts',
          oldText: 'x;',
          newText: 'x + 1;',
          receiptId,
        },
      ],
    },
    policy,
  );
  return r.ok;
}
