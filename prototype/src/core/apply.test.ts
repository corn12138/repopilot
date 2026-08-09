import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@shared/ids';
import { checkPatchApplyGate } from './authority';
import { applyMutationPlan } from './mutation';
import { applyPatchWithGit, sealPatch } from './patch';
import { importSnapshot } from './repo';
import { MaterializedWorkspace } from './workspace';
import { PATHS, ensureDataRoot } from './paths';

/**
 * 补丁应用回宿主仓库 —— 原型里唯一会写用户文件的路径。
 *
 * 它必须满足两条：
 *   1. 干净场景下真的改对了。
 *   2. 冲突场景下**一个字节都不写**，且原因可读。
 */

let host: string;
let workspace: MaterializedWorkspace | null = null;
let patchFile: string;

const ORIGINAL = 'export function greet(name: string) {\n  return "hi " + name;\n}\n';

function git(args: string[], cwd = host): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function setup(subDir = ''): void {
  host = mkdtempSync(join(tmpdir(), 'repopilot-apply-'));
  const fileDir = subDir ? join(host, subDir, 'src') : join(host, 'src');
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(join(fileDir, 'greet.ts'), ORIGINAL, 'utf8');
  writeFileSync(
    join(subDir ? join(host, subDir) : host, 'package.json'),
    '{"name":"t","scripts":{"build":"true"}}',
    'utf8',
  );
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  ensureDataRoot();
  patchFile = join(PATHS.artifacts, `${newId('t')}.diff`);
}

/** 走完整链路产出一个真实补丁 */
function makePatch(subPath = ''): ReturnType<typeof sealPatch> {
  const snapshot = importSnapshot('p', host, subPath ? { subPath } : {});
  const runId = newId('run');
  workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);
  const { receipt } = workspace.issueReceipt('src/greet.ts');

  const result = applyMutationPlan(workspace, {
    planId: 'p1',
    runId,
    inputGeneration: workspace.activeGeneration,
    operations: [
      {
        kind: 'REPLACE_EXACT_TEXT_SPAN',
        path: 'src/greet.ts',
        receiptId: receipt.receiptId,
        oldText: 'return "hi " + name;',
        newText: 'return `hi ${name}`;',
      },
    ],
  });
  expect(result.ok).toBe(true);

  return sealPatch(workspace, runId, newId('att'), snapshot.baseSha, null, null, []);
}

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
  workspace?.cleanup();
  workspace = null;
});

describe('整仓补丁应用', () => {
  beforeEach(() => setup());

  it('干净场景：真的改对了宿主文件', () => {
    const patch = makePatch();
    expect(patch.files).toHaveLength(1);

    const result = applyPatchWithGit(host, '', patch.unifiedDiff, patchFile, ['src/greet.ts']);
    expect(result.ok).toBe(true);

    const applied = readFileSync(join(host, 'src/greet.ts'), 'utf8');
    expect(applied).toContain('return `hi ${name}`;');
    expect(applied).not.toContain('"hi " + name');
    // 只改工作区文件：既不自动 commit，也不自动 stage
    expect(git(['status', '--porcelain'])).toBe(' M src/greet.ts\n');
  });

  it('目标文件已被改动 → --check 拒绝，且宿主一个字节没变', () => {
    const patch = makePatch();

    // 模拟"生成补丁之后用户又自己改了这个文件"
    const drifted = 'export function greet(name: string) {\n  return "HELLO " + name;\n}\n';
    writeFileSync(join(host, 'src/greet.ts'), drifted, 'utf8');

    const result = applyPatchWithGit(host, '', patch.unifiedDiff, patchFile, ['src/greet.ts']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('CHECK');
      expect(result.detail.length).toBeGreaterThan(0);
    }
    // 关键断言：拒绝之后文件与拒绝之前逐字节相同
    expect(readFileSync(join(host, 'src/greet.ts'), 'utf8')).toBe(drifted);
  });

  it('目标文件被删除 → 拒绝而不是重建', () => {
    const patch = makePatch();
    rmSync(join(host, 'src/greet.ts'));

    const result = applyPatchWithGit(host, '', patch.unifiedDiff, patchFile, ['src/greet.ts']);
    expect(result.ok).toBe(false);
  });
});

describe('子包补丁应用', () => {
  beforeEach(() => setup('apps/web'));

  it('用 --directory 把坐标系还原回仓库根', () => {
    const patch = makePatch('apps/web');
    // 补丁里的路径是相对子包的
    expect(patch.files[0]!.path).toBe('src/greet.ts');

    const result = applyPatchWithGit(host, 'apps/web', patch.unifiedDiff, patchFile, [
      'src/greet.ts',
    ]);
    expect(result.ok).toBe(true);

    // 写到的是 apps/web/src/greet.ts，不是仓库根的 src/greet.ts
    expect(readFileSync(join(host, 'apps/web/src/greet.ts'), 'utf8')).toContain(
      'return `hi ${name}`;',
    );
  });

  it('不带 --directory 时会因为路径对不上而拒绝', () => {
    const patch = makePatch('apps/web');
    const result = applyPatchWithGit(host, '', patch.unifiedDiff, patchFile, ['src/greet.ts']);
    expect(result.ok).toBe(false);
  });
});

describe('写回宿主仓库的接受态门禁（checkPatchApplyGate）', () => {
  const DIGEST = 'sha256:deadbeef';

  it('已接受 + digest 一致 → 放行', () => {
    const g = checkPatchApplyGate({
      status: 'SUCCEEDED',
      patchAcceptanceId: 'acc_1',
      actualDigest: DIGEST,
      requestedDigest: DIGEST,
    });
    expect(g.ok).toBe(true);
  });

  it('未验证但已接受（ACCEPTED_UNVERIFIED）同样放行', () => {
    const g = checkPatchApplyGate({
      status: 'ACCEPTED_UNVERIFIED',
      patchAcceptanceId: 'acc_2',
      actualDigest: DIGEST,
      requestedDigest: DIGEST,
    });
    expect(g.ok).toBe(true);
  });

  it('被拒绝的补丁（BLOCKED，无 patchAcceptanceId）绝不能写回', () => {
    // 这是本条修复要堵的核心场景：用户点了「拒绝」，补丁仍留在 record 里，
    // 一次 patch.export{APPLY_TO_REPO} 不能把它写进用户仓库。
    const g = checkPatchApplyGate({
      status: 'BLOCKED',
      patchAcceptanceId: null,
      actualDigest: DIGEST,
      requestedDigest: DIGEST,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('NOT_ACCEPTED');
  });

  it('停在 AWAITING_PATCH_REVIEW、还没决定，也不能写回', () => {
    const g = checkPatchApplyGate({
      status: 'AWAITING_PATCH_REVIEW',
      patchAcceptanceId: null,
      actualDigest: DIGEST,
      requestedDigest: DIGEST,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('NOT_ACCEPTED');
  });

  it('已接受但没带 digest → 拒绝（写宿主仓库不接受就地信任）', () => {
    const g = checkPatchApplyGate({
      status: 'SUCCEEDED',
      patchAcceptanceId: 'acc_3',
      actualDigest: DIGEST,
      requestedDigest: undefined,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('DIGEST_REQUIRED');
  });

  it('已接受但 digest 对不上 → 拒绝（应用的必须等于接受的）', () => {
    const g = checkPatchApplyGate({
      status: 'SUCCEEDED',
      patchAcceptanceId: 'acc_4',
      actualDigest: DIGEST,
      requestedDigest: 'sha256:0ther',
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('PATCH_CHANGED');
  });

  it('门禁顺序：未接受优先于 digest —— 被拒补丁即使 digest 对也进不来', () => {
    const g = checkPatchApplyGate({
      status: 'BLOCKED',
      patchAcceptanceId: null,
      actualDigest: DIGEST,
      requestedDigest: DIGEST,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('NOT_ACCEPTED');
  });
});
