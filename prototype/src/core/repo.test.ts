import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

import {
  RepositoryImportError,
  findSubPackages,
  importSnapshot,
  resolveProfile,
  summarizeShapes,
} from './repo';
import { listTree } from './workspace';
import type { RepositorySnapshot } from '@shared/domain';
import { snapshotDir } from './paths';
import { ensureDataRoot } from './paths';

/**
 * 导入的行为契约。
 *
 * 现在的语义是**导入不设门禁**：选中目录就是信任手势，dirty worktree、非 git 目录、
 * 检测不出命令全都直接导入，如实标记 `baseKind` / `dirtyFileCount` / `supportStatus`，
 * 由用户带着这些事实决定要不要继续。只在物理上做不到时才失败
 * （`PATH_UNREADABLE` / `EMPTY_TREE` / `CAPACITY_EXCEEDED`）。
 *
 * 这段注释此前还写着"dirty 默认阻断、可显式越过"，而下面的用例断言的是直接导入成功 ——
 * 断言早就改了，注释没跟上。过期的注释和过期的断言是同一类问题。
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

  /*
   * 以下两条钉的是同一件事的两面：untracked 文件是**排除**，不是**改动**。
   * 以前 `git status --porcelain` 的 `??` 行被并进 dirtyFileCount，于是
   * "只新建了一个文件"的仓库会被标成「工作区基线 · 1 项改动」——
   * 而快照内容与 HEAD 逐字节相同，那个新文件根本没进来。
   * 界面说"进来了而且改过了"，事实是"完全没进来"：这是分类撒谎，比不报数更糟。
   */
  it('只有 untracked 文件时基线仍是 CLEAN_COMMIT，untracked 单独报数', () => {
    write('apps/web/src/scratch.ts', 'const scratch = 1;\n');
    const snap = importSnapshot('p', repo);

    expect(snap.baseKind).toBe('CLEAN_COMMIT');
    // 负向断言：这个 1 绝不能出现在 dirtyFileCount 上。
    expect(snap.dirtyFileCount).toBe(0);
    expect(snap.untrackedCount).toBe(1);

    // 快照内容确实与干净 commit 一致 —— 所以 CLEAN_COMMIT 是诚实的。
    const clean = importSnapshot('p', repo);
    expect(snap.treeDigest).toBe(clean.treeDigest);
  });

  it('tracked 改动与 untracked 新增同时存在时，两个数各归各的', () => {
    write('apps/web/src/App.tsx', 'export const App = () => 1;\n'); // tracked 改动
    write('apps/web/src/a.ts', 'export const a = 1;\n'); // untracked
    write('apps/web/src/b.ts', 'export const b = 2;\n'); // untracked
    const snap = importSnapshot('p', repo);

    expect(snap.baseKind).toBe('DIRTY_WORKTREE');
    expect(snap.dirtyFileCount).toBe(1);
    expect(snap.untrackedCount).toBe(2);
  });

  it('untracked 计数与 dirty 一样只看导入范围', () => {
    write('apps/api/src/scratch.ts', 'const scratch = 1;\n');
    expect(importSnapshot('p', repo).untrackedCount).toBe(1);
    expect(importSnapshot('p', repo, { subPath: 'apps/web' }).untrackedCount).toBe(0);
  });

  it('软链接记为 SYMLINK 而不是 BINARY —— 分类要说实话', () => {
    symlinkSync(join(repo, 'apps/web/src/App.tsx'), join(repo, 'apps/web/src/alias.tsx'));
    commitAll('add symlink');
    const snap = importSnapshot('p', repo);

    const entry = snap.excludedPaths.find((e) => e.path === 'apps/web/src/alias.tsx');
    expect(entry).toBeTruthy();
    expect(entry!.reason).toBe('SYMLINK');
    // 负向断言：以前这里是 BINARY，一个软链接被说成了二进制文件。
    expect(entry!.reason).not.toBe('BINARY');
    expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).not.toContain(
      'apps/web/src/alias.tsx',
    );
  });
});

describe('非 git 目录的枚举同样报数', () => {
  let plain: string;

  beforeEach(() => {
    plain = mkdtempSync(join(tmpdir(), 'repopilot-plain-'));
    mkdirSync(join(plain, 'src'), { recursive: true });
    writeFileSync(join(plain, 'src/index.ts'), 'export const a = 1;\n');
    mkdirSync(join(plain, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(plain, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
    mkdirSync(join(plain, 'dist'), { recursive: true });
    writeFileSync(join(plain, 'dist/bundle.js'), 'var x=1;\n');
    symlinkSync(join(plain, 'src/index.ts'), join(plain, 'src/alias.ts'));
    ensureDataRoot();
  });

  afterEach(() => rmSync(plain, { recursive: true, force: true }));

  it('跳过的依赖目录、产物目录与软链接都留下 ExclusionEntry', () => {
    const snap = importSnapshot('p', plain);
    expect(snap.baseKind).toBe('NO_VCS');

    const byReason = (reason: string) => snap.excludedPaths.filter((e) => e.reason === reason);
    // 以前 NO_VCS 路径在界面上打印「排除文件 0 个」，而整棵 node_modules 都没进来。
    expect(snap.excludedPaths.length).toBeGreaterThan(0);
    expect(byReason('DEPENDENCY_DIR').map((e) => e.path)).toContain('node_modules');
    expect(byReason('BUILD_OUTPUT').map((e) => e.path)).toContain('dist');
    expect(byReason('SYMLINK').map((e) => e.path)).toContain('src/alias.ts');

    // 真正进来的只有那一个源文件。
    expect(snap.fileCount).toBe(1);
    expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).toEqual(['src/index.ts']);
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

// ---------------------------------------------------------------------------
// 仓库形态：LFS 指针 / 子模块 / 未检出 / 大小写碰撞
// ---------------------------------------------------------------------------

/**
 * 这四种形态此前全是 fail-open，而且失败方式都不可见（08-17 审计 D2-repo-shape-fail-open）：
 * LFS 指针被当源码收进快照且**完全静默**，子模块与未检出都被伪装成"读取失败"。
 *
 * 其中 LFS 是唯一一条会**破坏用户真实仓库**的：指针进了快照 → 模型对它生成补丁 →
 * 用户点「应用到仓库」→ `git apply --check` 通过 → 宿主上真正的指针被覆盖成模型写的文本。
 */

const LFS_POINTER =
  'version https://git-lfs.github.com/spec/v1\noid sha256:' +
  'a'.repeat(64) +
  '\nsize 12345678\n';

function excludedFor(snapshot: RepositorySnapshot, reason: string): string[] {
  return snapshot.excludedPaths.filter((e) => e.reason === reason).map((e) => e.path);
}

function setupPlainGitRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'repopilot-shape-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  write('package.json', JSON.stringify({ name: 'shape', scripts: { build: 'vite build' } }));
  write('src/app.ts', 'export const a = 1;\n');
  ensureDataRoot();
}

describe('仓库形态：Git LFS 指针', () => {
  beforeEach(setupPlainGitRepo);
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('指针文件被排除并单独归因 LFS_POINTER —— 不进快照，模型看不到，也就改不了它', () => {
    write('assets/logo.png', LFS_POINTER);
    write('docs/big.psd', LFS_POINTER);
    commitAll('lfs');

    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'LFS_POINTER').sort()).toEqual(['assets/logo.png', 'docs/big.psd']);
    // 关键：快照里没有它们 —— 补丁不可能触碰到宿主上的真指针
    expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).not.toContain('assets/logo.png');
    // 不能被伪装成别的原因（此前它是完全静默的，连排除清单都没有）
    expect(excludedFor(snap, 'BINARY')).not.toContain('assets/logo.png');
    expect(excludedFor(snap, 'UNREADABLE')).toEqual([]);
  });

  it('判据是磁盘上现在是什么：同一目录同一扩展名，指针被排除、真内容照常收进来', () => {
    /*
     * 不写 `filter=lfs` 的 .gitattributes —— 那会让 git 去调本机的 git-lfs 二进制，
     * 测试就变成"这台机器装没装 git-lfs"的函数（本机没装时 `git add` 直接失败）。
     * 而这条用例要断言的本来就与 .gitattributes 无关：**只看内容**。
     */
    write('data/big.csv', LFS_POINTER);
    write('data/real.csv', 'a,b\n1,2\n');
    commitAll('mixed-csv');

    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'LFS_POINTER')).toEqual(['data/big.csv']);
    expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).toContain('data/real.csv');
  });

  it('二进制扩展名下的指针归因 LFS_POINTER 而不是 BINARY —— "二进制跳过了"会盖住真正该说的事', () => {
    write('assets/logo.png', LFS_POINTER); // 指针
    write('assets/tiny.gif', 'GIF89a-real-bytes\n'); // 真二进制内容
    commitAll('mixed');

    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'LFS_POINTER')).toEqual(['assets/logo.png']);
    expect(excludedFor(snap, 'BINARY')).toEqual(['assets/tiny.gif']);
  });

  it('只是碰巧以 version 开头的普通文件不误判', () => {
    write('src/notes.txt', 'version https://example.com/not-lfs\nsome notes\n');
    commitAll('lookalike');
    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'LFS_POINTER')).toEqual([]);
  });
});

describe('仓库形态：子模块', () => {
  beforeEach(setupPlainGitRepo);
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('gitlink 归因 SUBMODULE，而不是伪装成"读取失败"', () => {
    // 造一个真的子模块：另建一个仓库再 add 进来
    const inner = mkdtempSync(join(tmpdir(), 'repopilot-inner-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: inner });
      writeFileSync(join(inner, 'lib.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: inner });
      execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'inner'], {
        cwd: inner,
      });
      commitAll('base');
      execFileSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner, 'vendor/inner'],
        { cwd: repo, stdio: 'ignore' },
      );
      commitAll('add submodule');

      const snap = importSnapshot('proj', repo);
      expect(excludedFor(snap, 'SUBMODULE')).toEqual(['vendor/inner']);
      // 此前它走到 lstat 那里被记成 UNREADABLE —— 把"未支持形态"说成"读取失败"
      expect(excludedFor(snap, 'UNREADABLE')).toEqual([]);
      // 子模块里的文件当然也不在快照里
      expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).not.toContain('vendor/inner/lib.ts');
    } finally {
      rmSync(inner, { recursive: true, force: true });
    }
  });
});

describe('仓库形态：索引里有、工作区没有（sparse checkout）', () => {
  beforeEach(setupPlainGitRepo);
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('ENOENT 归因 NOT_CHECKED_OUT，与真正读不了的 UNREADABLE 分开', () => {
    write('src/kept.ts', 'export const kept = 1;\n');
    write('src/gone.ts', 'export const gone = 1;\n');
    write('src/also-gone.ts', 'export const g2 = 1;\n');
    commitAll('all');
    // 模拟 sparse：索引里还在，工作区删掉（不 commit 删除）
    rmSync(join(repo, 'src/gone.ts'));
    rmSync(join(repo, 'src/also-gone.ts'));

    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'NOT_CHECKED_OUT').sort()).toEqual(['src/also-gone.ts', 'src/gone.ts']);
    expect(excludedFor(snap, 'UNREADABLE')).toEqual([]);
    // 快照仍然产出（用户可能就是有意 sparse），但缺席是**报了数**的
    expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).toContain('src/kept.ts');
  });
});

describe('仓库形态：仅大小写不同的重名路径', () => {
  beforeEach(setupPlainGitRepo);
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('在大小写不敏感的文件系统上整组排除（磁盘只有一个文件，两条路径无法无歧义寻址）', () => {
    write('src/readme.md', 'lower\n');
    commitAll('one');
    // 用 update-index 往索引里塞一个只有大小写不同的条目 —— 在 APFS 上它们指向同一个 inode
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'upper\n' })
      .toString()
      .trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},src/README.md`], {
      cwd: repo,
    });

    const snap = importSnapshot('proj', repo);
    const collided = excludedFor(snap, 'CASE_COLLISION').sort();
    const insensitive = existsSync(join(repo, 'src/README.md')); // APFS 默认大小写不敏感
    if (insensitive) {
      expect(collided).toEqual(['src/README.md', 'src/readme.md']);
      // 整组都不进快照：收一个进来就等于让"改这个"静默改掉"那个"
      expect(listTree(snapshotDir(snap.snapshotId)).map((f) => f.path)).not.toContain('src/readme.md');
    } else {
      // 大小写敏感的文件系统上它们是两个真文件：不许误伤
      expect(collided).toEqual([]);
      expect(excludedFor(snap, 'NOT_CHECKED_OUT')).toEqual(['src/README.md']);
    }
  });

  it('大小写不同但确实是两个不同文件时不误伤（不同 inode）', () => {
    // 造两个内容不同、路径大小写不同的文件；在不敏感 FS 上第二次 write 会覆盖第一个，
    // 于是它们本来就是同一个 inode —— 这条用例只在敏感 FS 上有区分力，两边都不该崩
    write('src/a.ts', 'a\n');
    write('src/B.ts', 'b\n');
    commitAll('two');
    const snap = importSnapshot('proj', repo);
    expect(excludedFor(snap, 'CASE_COLLISION')).toEqual([]);
  });
});

describe('summarizeShapes', () => {
  it('按形态聚合、给样例与下一步；没有该形态就不出现', () => {
    const findings = summarizeShapes([
      { path: 'a.png', reason: 'LFS_POINTER', bytes: 130 },
      { path: 'b.png', reason: 'LFS_POINTER', bytes: 130 },
      { path: 'c.png', reason: 'LFS_POINTER', bytes: 130 },
      { path: 'd.png', reason: 'LFS_POINTER', bytes: 130 },
      { path: 'vendor/x', reason: 'SUBMODULE', bytes: 0 },
      { path: 'node_modules/y', reason: 'DEPENDENCY_DIR', bytes: 10 },
    ]);
    expect(findings.map((f) => f.kind)).toEqual(['LFS_POINTER', 'SUBMODULE']);
    expect(findings[0]!.count).toBe(4);
    expect(findings[0]!.samples).toHaveLength(3); // 只举例，不列全
    expect(findings[0]!.advice).toContain('git lfs pull');
    expect(findings[1]!.advice).toContain('单独导入');
    expect(summarizeShapes([])).toEqual([]);
  });
});
