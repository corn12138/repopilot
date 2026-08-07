import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepositoryImportError, findSubPackages, importSnapshot, resolveProfile } from './repo';
import { listTree } from './workspace';
import { snapshotDir } from './paths';
import { ensureDataRoot } from './paths';

/**
 * 导入门禁的行为契约。
 *
 * 核心区分：**默认阻断** ≠ **永远不给走**。
 *   - dirty worktree：默认阻断，但可由显式选择越过，越过后如实标记 baseKind。
 *   - 没有验证命令：硬阻断，因为没有任何东西能判定成功。
 */

let repo: string;

function commitAll(message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', message], {
    cwd: repo,
  });
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** 一个 monorepo：apps/web 是 Vite+React+TS，apps/api 不是 */
function setupMonorepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'repopilot-mono-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });

  write('package.json', JSON.stringify({ name: 'root', scripts: { build: 'turbo build' } }));
  write('apps/web/package.json', JSON.stringify({
    name: '@app/web',
    scripts: { build: 'tsc --noEmit && vite build', test: 'vitest run' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { vite: '^5.0.0', typescript: '^5.0.0' },
  }));
  write('apps/web/package-lock.json', '{}');
  write('apps/web/tsconfig.json', '{}');
  write('apps/web/vite.config.ts', 'export default {};');
  write('apps/web/src/App.tsx', 'export const App = () => null;\n');
  write('apps/api/package.json', JSON.stringify({
    name: '@app/api',
    scripts: { build: 'nest build' },
    dependencies: { '@nestjs/core': '^10.0.0' },
  }));
  write('apps/api/src/main.ts', 'export const main = 1;\n');
  commitAll('init');
  ensureDataRoot();
}

beforeEach(setupMonorepo);
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('导入不设业务门禁，只如实标注', () => {
  it('dirty 仓库直接导入成功，标记 DIRTY_WORKTREE 与改动数', () => {
    write('apps/web/src/App.tsx', 'export const App = () => 1;\n');
    const snap = importSnapshot('p', repo);

    expect(snap.baseKind).toBe('DIRTY_WORKTREE');
    expect(snap.dirtyFileCount).toBe(1);
    // 快照内容是**磁盘上的**内容，不是 commit 里的
    const abs = join(snapshotDir(snap.snapshotId), 'apps/web/src/App.tsx');
    expect(readFileSync(abs, 'utf8')).toContain('=> 1');
  });

  it('干净仓库标记为 CLEAN_COMMIT', () => {
    const snap = importSnapshot('p', repo);
    expect(snap.baseKind).toBe('CLEAN_COMMIT');
    expect(snap.dirtyFileCount).toBe(0);
  });

  it('untracked 文件永远不进快照', () => {
    write('apps/web/src/secret-scratch.ts', 'const leaked = 1;\n');
    const snap = importSnapshot('p', repo);
    const paths = listTree(snapshotDir(snap.snapshotId)).map((f) => f.path);
    expect(paths).not.toContain('apps/web/src/secret-scratch.ts');
  });

  it('dirty 计数只看导入范围', () => {
    write('apps/api/src/main.ts', 'export const main = 2;\n');
    expect(importSnapshot('p', repo).dirtyFileCount).toBe(1);
    // 只导入 apps/web 则不受另一个包影响
    expect(importSnapshot('p', repo, { subPath: 'apps/web' }).baseKind).toBe('CLEAN_COMMIT');
  });

  it('非 git 目录也能导入，标记 NO_VCS 且跳过依赖/产物目录', () => {
    const plain = mkdtempSync(join(tmpdir(), 'repopilot-plain-'));
    try {
      mkdirSync(join(plain, 'src'), { recursive: true });
      mkdirSync(join(plain, 'node_modules/lodash'), { recursive: true });
      mkdirSync(join(plain, 'dist'), { recursive: true });
      writeFileSync(join(plain, 'src/index.ts'), 'export const a = 1;\n');
      writeFileSync(join(plain, 'package.json'), '{"name":"plain"}');
      writeFileSync(join(plain, 'node_modules/lodash/index.js'), 'module.exports = {};');
      writeFileSync(join(plain, 'dist/bundle.js'), 'var x;');

      const snap = importSnapshot('p', plain);
      expect(snap.baseKind).toBe('NO_VCS');
      expect(snap.baseSha).toBe('');

      const paths = listTree(snapshotDir(snap.snapshotId)).map((f) => f.path);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('package.json');
      expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('monorepo 子包导入', () => {
  it('找得到子包，且 Vite+React+TS 的排最前', () => {
    const candidates = findSubPackages(repo);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]!.subPath).toBe('apps/web');
    expect(candidates[0]!.hasVite).toBe(true);
    expect(candidates.find((c) => c.subPath === 'apps/api')!.hasVite).toBe(false);
  });

  it('整仓导入：根 profile 不是 VERIFIED，但仍可用（supportStatus 只是信息）', () => {
    const snap = importSnapshot('p', repo);
    const profile = resolveProfile(snap);
    expect(snap.subPath).toBe('');
    expect(profile.supportStatus).not.toBe('VERIFIED');
    // 根有 build 脚本，所以任务类型照样列得出来 —— 不再要求 VERIFIED
    expect(profile.supportedTaskClasses).toContain('BUILD_FAILURE_FIX');
  });

  it('导入 apps/web：路径以子包为坐标系，profile 变 VERIFIED', () => {
    const snap = importSnapshot('p', repo, { subPath: 'apps/web' });

    expect(snap.subPath).toBe('apps/web');
    const paths = listTree(snapshotDir(snap.snapshotId)).map((f) => f.path);
    // 子包内路径不再带 apps/web/ 前缀
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('vite.config.ts');
    expect(paths.some((p) => p.startsWith('apps/'))).toBe(false);
    // 另一个子包的文件不在范围内
    expect(paths.some((p) => p.includes('main.ts'))).toBe(false);

    const profile = resolveProfile(snap);
    expect(profile.supportStatus).toBe('VERIFIED');
    expect(profile.packageManager).toBe('npm');
    expect(profile.commands.build).toBeDefined();
    expect(profile.supportedTaskClasses).toContain('BUILD_FAILURE_FIX');
  });

  it('导入不存在的子目录 → PATH_UNREADABLE', () => {
    try {
      importSnapshot('p', repo, { subPath: 'apps/nope' });
      throw new Error('本应抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(RepositoryImportError);
      expect((err as RepositoryImportError).code).toBe('PATH_UNREADABLE');
    }
  });

  it('子目录路径逃逸被拒绝', () => {
    expect(() => importSnapshot('p', repo, { subPath: '../../etc' })).toThrow(/非法子目录/);
  });
});

describe('仍然成立的物理约束', () => {
  it('目录不存在 → PATH_UNREADABLE', () => {
    try {
      importSnapshot('p', join(tmpdir(), 'definitely-not-here-xyz'));
      throw new Error('本应抛出');
    } catch (err) {
      expect((err as RepositoryImportError).code).toBe('PATH_UNREADABLE');
    }
  });

  it('空目录 → EMPTY_TREE', () => {
    const empty = mkdtempSync(join(tmpdir(), 'repopilot-empty-'));
    try {
      importSnapshot('p', empty);
      throw new Error('本应抛出');
    } catch (err) {
      expect((err as RepositoryImportError).code).toBe('EMPTY_TREE');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
