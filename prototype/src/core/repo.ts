import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  CommandDefinition,
  ExclusionEntry,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  SubPackageCandidate,
  TaskClass,
} from '@shared/domain';
import { digestOf, newId, nowIso, sha256 } from '@shared/ids';
import { snapshotDir } from './paths';

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 80_000_000;
const MAX_FILE_COUNT = 8000;

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mp3', '.wav',
  '.zip', '.gz', '.tgz', '.bz2', '.7z', '.dmg', '.node', '.wasm',
]);

const SECRET_SUSPECT = [/^\.env($|\.)/, /(^|\/)id_rsa$/, /\.pem$/, /\.p12$/, /\.keystore$/];

/**
 * 导入只在**物理上做不到**时失败：目录不存在、里面没有可用文件、超出容量。
 *
 * 仓库脏不脏、是不是 git、是不是 Vite —— 都不再是门禁。用户选中目录
 * 就是信任手势，剩下的由 RepoPilot 如实标注，而不是拦住不让用。
 */
export type ImportBlockCode = 'PATH_UNREADABLE' | 'EMPTY_TREE' | 'CAPACITY_EXCEEDED' | 'GIT_FAILED';

export class RepositoryImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportBlockCode,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface ImportOptions {
  /** 只导入这个子目录（monorepo 子包），相对仓库根；留空为整个项目 */
  readonly subPath?: string;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new RepositoryImportError('git 命令失败', 'GIT_FAILED', (e.stderr || e.message || '').trim());
  }
}

/**
 * 导入一个项目目录的只读快照。
 *
 * 设计取向：**选中目录就是信任手势，导入不设业务门禁。**
 * git / 非 git、干净 / 脏、Vite / 不是 Vite，都能导进来，差异如实标注在
 * `baseKind` 上并一路带到 Run 与补丁。
 *
 * 只在物理上做不到时失败：目录读不了、没有可用文件、超出容量。
 *
 * 始终成立的安全性质（这些不是门禁，是快照本身的定义）：
 *   - 不跟随 symlink；`.git` 永不进快照。
 *   - git 仓库只收 tracked 文件，untracked 不进快照。
 *   - 二进制 / 超大 / 疑似 secret 文件被排除，且排除清单回传给用户，不静默丢弃。
 */
export function importSnapshot(
  projectId: string,
  hostPath: string,
  options: ImportOptions = {},
): RepositorySnapshot {
  if (!existsSync(hostPath)) {
    throw new RepositoryImportError('目录不存在或无法读取', 'PATH_UNREADABLE', hostPath);
  }

  const subPath = normalizeSubPath(options.subPath);
  const scopeRoot = subPath ? join(hostPath, subPath) : hostPath;
  if (subPath && !existsSync(scopeRoot)) {
    throw new RepositoryImportError(`子目录不存在: ${subPath}`, 'PATH_UNREADABLE', subPath);
  }

  const isGit = existsSync(join(hostPath, '.git'));

  let baseSha = '';
  let branch = '';
  let dirtyLines: string[] = [];
  let listed: string[];

  if (isGit) {
    // dirty 只是一个属性，不是门禁；范围限定在导入范围内
    const statusArgs = ['status', '--porcelain'];
    if (subPath) statusArgs.push('--', subPath);
    const status = git(hostPath, statusArgs).trim();
    dirtyLines = status ? status.split('\n') : [];

    baseSha = git(hostPath, ['rev-parse', 'HEAD']).trim();
    branch = git(hostPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    const lsArgs = ['ls-files', '-z'];
    if (subPath) lsArgs.push('--', subPath);
    listed = git(hostPath, lsArgs)
      .split('\0')
      .filter(Boolean)
      // 子包导入时，快照内路径相对子包根，profile / 命令 / 补丁都以子包为坐标系
      .map((p) => (subPath ? p.slice(subPath.length + 1) : p))
      .filter(Boolean);
  } else {
    // 非 git 目录：直接走文件树，用与 git 相同的排除规则
    listed = walkPlainDirectory(scopeRoot);
  }

  if (listed.length === 0) {
    throw new RepositoryImportError(
      subPath ? `${subPath} 下没有可导入的文件` : '目录里没有可导入的文件',
      'EMPTY_TREE',
      isGit ? baseSha : hostPath,
    );
  }

  const snapshotId = newId('snap');
  const target = snapshotDir(snapshotId);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const excluded: ExclusionEntry[] = [];
  const included: Array<{ path: string; digest: string }> = [];
  let totalBytes = 0;

  for (const rel of listed) {
    const abs = join(scopeRoot, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    // 不跟随 symlink：软链接一律不进快照
    if (!st.isFile()) {
      excluded.push({ path: rel, reason: 'BINARY', bytes: 0 });
      continue;
    }

    const reason = classifyExclusion(rel, st.size);
    if (reason) {
      excluded.push({ path: rel, reason, bytes: st.size });
      continue;
    }

    if (totalBytes + st.size > MAX_TOTAL_BYTES || included.length >= MAX_FILE_COUNT) {
      rmSync(target, { recursive: true, force: true });
      throw new RepositoryImportError(
        '仓库超出原型容量上限',
        'CAPACITY_EXCEEDED',
        `已收 ${included.length} 个文件 / ${totalBytes} 字节`,
      );
    }

    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    totalBytes += st.size;
    included.push({ path: rel, digest: sha256(readFileSync(abs)) });
  }

  included.sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    snapshotId,
    projectId,
    baseSha,
    branch,
    baseKind: !isGit ? 'NO_VCS' : dirtyLines.length > 0 ? 'DIRTY_WORKTREE' : 'CLEAN_COMMIT',
    dirtyFileCount: dirtyLines.length,
    subPath,
    fileCount: included.length,
    totalBytes,
    treeDigest: digestOf(included),
    excludedPaths: excluded,
    createdAt: nowIso(),
  };
}

function normalizeSubPath(input: string | undefined): string {
  if (!input) return '';
  const trimmed = input.replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return '';
  if (trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
    throw new RepositoryImportError(`非法子目录: ${input}`, 'PATH_UNREADABLE', input);
  }
  return trimmed;
}

/** 非 git 目录的文件枚举：跳过 symlink 与依赖/产物目录，路径相对 root */
function walkPlainDirectory(root: string): string[] {
  const out: string[] = [];
  const skipDir = /^(\.git|node_modules|dist|build|out|coverage|\.next|\.turbo|\.vite|\.cache|\.pnpm-store|vendor|target|__pycache__|\.venv)$/;

  const walk = (dir: string, prefix: string): void => {
    if (out.length >= MAX_FILE_COUNT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILE_COUNT) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDir.test(entry.name)) continue;
        walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };

  walk(root, '');
  return out;
}

/**
 * 在 monorepo 里找出可以单独当项目根导入的子包。
 *
 * 只扫两层常见工作区目录，不递归全仓 —— 避免为了找包把整个磁盘走一遍。
 */
export function findSubPackages(hostPath: string): SubPackageCandidate[] {
  const roots = ['apps', 'packages', 'examples', 'services'];
  const found: SubPackageCandidate[] = [];

  for (const root of roots) {
    const dir = join(hostPath, root);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const pkgPath = join(dir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        found.push({
          subPath: `${root}/${name}`,
          name: (pkg as { name?: string }).name ?? name,
          hasVite: 'vite' in deps,
          hasReact: 'react' in deps,
          hasTypescript: 'typescript' in deps,
          scripts: Object.keys(pkg.scripts ?? {}),
        });
      } catch {
        // package.json 坏了就跳过，不猜
      }
    }
  }

  // 越像首切片目标的排越前
  return found.sort(
    (a, b) =>
      Number(b.hasVite) * 4 + Number(b.hasReact) * 2 + Number(b.hasTypescript) -
      (Number(a.hasVite) * 4 + Number(a.hasReact) * 2 + Number(a.hasTypescript)),
  );
}

function classifyExclusion(rel: string, size: number): ExclusionEntry['reason'] | null {
  if (rel.startsWith('.git/') || rel === '.git') return 'GIT_INTERNAL';
  if (/(^|\/)(node_modules|\.pnpm-store|vendor)\//.test(rel)) return 'DEPENDENCY_DIR';
  if (/(^|\/)(dist|build|out|coverage|\.next|\.turbo|\.vite)\//.test(rel)) return 'BUILD_OUTPUT';
  if (SECRET_SUSPECT.some((re) => re.test(rel))) return 'SECRET_SUSPECT';
  const dot = rel.lastIndexOf('.');
  if (dot >= 0 && BINARY_EXT.has(rel.slice(dot).toLowerCase())) return 'BINARY';
  if (size > MAX_FILE_BYTES) return 'OVERSIZE';
  return null;
}

// ---------------------------------------------------------------------------
// Repository Harness Profile
// ---------------------------------------------------------------------------

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * 从快照解析 snapshot-bound profile。
 *
 * 只在信号明确时给 VERIFIED；缺 vite / 缺 react / 缺 typescript 都会降级。
 * 非 VERIFIED 的 profile 不允许生成可执行 Plan（PRD-REPO-002）。
 */
export function resolveProfile(snapshot: RepositorySnapshot): RepositoryHarnessProfile {
  const root = snapshotDir(snapshot.snapshotId);
  const pkgPath = join(root, 'package.json');
  const signals: string[] = [];
  const notes: string[] = [];

  let pkg: PackageJson = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
      signals.push('package.json');
    } catch {
      notes.push('package.json 解析失败');
    }
  } else {
    notes.push('缺少 package.json');
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(allDeps, name);

  if (has('vite')) signals.push('dep:vite');
  if (has('react')) signals.push('dep:react');
  if (has('typescript')) signals.push('dep:typescript');
  for (const cfg of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
    if (existsSync(join(root, cfg))) signals.push(`file:${cfg}`);
  }
  if (existsSync(join(root, 'tsconfig.json'))) signals.push('file:tsconfig.json');

  const packageManager: RepositoryHarnessProfile['packageManager'] = existsSync(
    join(root, 'pnpm-lock.yaml'),
  )
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'package-lock.json'))
        ? 'npm'
        : 'unknown';

  if (packageManager === 'unknown') notes.push('未找到 lockfile，包管理器不确定');

  const scripts = pkg.scripts ?? {};
  // 用无原型对象：commandId 是模型可控的字符串，普通对象字面量会让
  // 'constructor' / 'toString' 这类 key 命中 Object.prototype 并被当成"已登记命令"
  const commands: Record<string, CommandDefinition> = Object.create(null);
  const runner = packageManager === 'unknown' ? 'npm' : packageManager;

  if (scripts.build) {
    commands.build = {
      commandId: 'build',
      label: `${runner} run build`,
      argv: [runner, 'run', 'build'],
      cwdRelative: '.',
      timeoutMs: 300_000,
      risk: 'R1',
      source: 'DETECTED',
    };
  }
  if (scripts.test) {
    commands.test = {
      commandId: 'test',
      label: `${runner} run test`,
      argv: [runner, 'run', 'test'],
      cwdRelative: '.',
      timeoutMs: 300_000,
      risk: 'R1',
      source: 'DETECTED',
    };
  }
  if (existsSync(join(root, 'tsconfig.json'))) {
    commands.typecheck = {
      commandId: 'typecheck',
      label: 'tsc --noEmit',
      argv: ['npx', '--no-install', 'tsc', '--noEmit'],
      cwdRelative: '.',
      timeoutMs: 180_000,
      risk: 'R1',
      source: 'DETECTED',
    };
  }

  const hasCore = has('vite') && has('react') && has('typescript');
  const hasCommand = Object.keys(commands).length > 0;

  /*
   * supportStatus 现在是**纯信息**，不再是门禁。
   *
   * 它回答的是"这个仓库跟首个验证过的形态有多接近"，用来提示用户预期，
   * 而不是决定能不能用。能不能判定成功由"有没有验证命令"决定，
   * 而验证命令用户可以自己填 —— 所以没有哪个仓库是被永久拒之门外的。
   */
  let supportStatus: RepositoryHarnessProfile['supportStatus'];
  if (hasCore && hasCommand) {
    supportStatus = 'VERIFIED';
  } else if (signals.length > 0 && hasCommand) {
    supportStatus = 'PREVIEW';
    notes.push('不是 vite + react + typescript 的标准形态，但解析出了可执行命令');
  } else if (signals.length > 0) {
    supportStatus = 'AMBIGUOUS';
    notes.push('未解析出 build / test / typecheck 命令，可在创建任务时自己填一条验证命令');
  } else {
    supportStatus = 'UNSUPPORTED';
    notes.push('未检测到已知技术栈信号，可在创建任务时自己填验证命令');
  }

  // 有对应命令就列出对应任务类型，不再要求 VERIFIED
  const supportedTaskClasses: TaskClass[] = [
    commands.build ? 'BUILD_FAILURE_FIX' : null,
    commands.test ? 'TEST_FAILURE_FIX' : null,
    commands.typecheck ? 'TYPE_ERROR_FIX' : null,
  ].filter(Boolean) as TaskClass[];

  return {
    profileId: newId('prof'),
    snapshotId: snapshot.snapshotId,
    adapterId: 'vite-react-ts',
    adapterVersion: '0.1.0',
    supportStatus,
    detectedSignals: signals,
    packageManager,
    commands,
    protectedPaths: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.github/**',
      '.git/**',
    ],
    supportedTaskClasses,
    notes,
  };
}

/** 把仓库相对路径解析成受管根内的绝对路径；任何逃逸都抛错 */
export function resolveInsideRoot(root: string, relPath: string): string {
  if (relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`拒绝绝对路径: ${relPath}`);
  }
  const abs = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error(`路径逃逸受管根: ${relPath}`);
  }
  if (existsSync(abs) && !lstatSync(abs).isFile() && statSync(abs).isFile() === false) {
    // 目录或特殊文件由调用方判断
  }
  return abs;
}
