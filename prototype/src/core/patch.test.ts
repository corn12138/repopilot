import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MutationOperation,
  VerificationComparison,
  VerificationRun,
} from '@shared/domain';
import { newId } from '@shared/ids';

/*
 * 把受管数据根重定向到进程私有的临时目录。
 *
 * 为什么必须这么做：sealPatch 依赖 MaterializedWorkspace / importSnapshot，
 * 而它们的落盘位置来自 paths.ts 里在模块求值时算出的 DATA_ROOT
 * （~/Library/Application Support/RepoPilotPrototype）。多个测试文件并行跑时
 * 共用同一个真实数据根，快照/工作区目录会互相踩，而且会在用户机器上留垃圾。
 * vi.mock 会被提升到 import 之前，所以 workspace.ts / repo.ts 拿到的就是这份。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-patch-data-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
  } as const;
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: () => {
      for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
        mkDir(d, { recursive: true });
      }
    },
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import { applyMutationPlan } from './mutation';
import { sealPatch } from './patch';
import { importSnapshot } from './repo';
import { MaterializedWorkspace } from './workspace';
import { PATHS, ensureDataRoot } from './paths';

/**
 * 补丁封存（sealPatch）。
 *
 * PatchArtifact 是交付物本身，用户就是看着它做接受/拒绝决定的。所以这里关心的
 * 全部是"它会不会撒谎"：
 *   - 头里泄漏宿主绝对路径 → 补丁既不可移植，也泄漏了用户的目录结构；
 *   - 静默丢掉某个 changed file → 用户以为自己看到了全部改动；
 *   - 行数统计 / 截断标记与真实 diff 对不上 → 决策依据是假的；
 *   - 没验证却让人以为验证过 → 最贵的一种谎。
 *
 * applyPatchWithGit 由 apply.test.ts 覆盖，这里不重复。
 */

const MAX_DIFF_BYTES_PER_FILE = 60_000;

const hosts: string[] = [];
let workspace: MaterializedWorkspace | null = null;

function setupHost(files: Record<string, string>): string {
  const host = mkdtempSync(join(tmpdir(), 'repopilot-patch-host-'));
  hosts.push(host);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(host, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['init', '-q'], { cwd: host });
  execFileSync('git', ['add', '-A'], { cwd: host });
  execFileSync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: host },
  );
  return host;
}

interface Opened {
  readonly ws: MaterializedWorkspace;
  readonly runId: string;
  readonly baseSha: string;
}

function open(files: Record<string, string>): Opened {
  const host = setupHost(files);
  ensureDataRoot();
  const snapshot = importSnapshot('proj_patch', host);
  const runId = newId('run');
  workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);
  return { ws: workspace, runId, baseSha: snapshot.baseSha };
}

/** 走真实 mutation 引擎产生改动 —— 不手工伪造 generation，避免测到不可能出现的状态 */
function mutate(
  ws: MaterializedWorkspace,
  runId: string,
  specs: ReadonlyArray<{
    kind: MutationOperation['kind'];
    path: string;
    oldText?: string;
    newText: string;
  }>,
): void {
  const operations: MutationOperation[] = specs.map((s) => {
    if (s.kind === 'CREATE_FILE') return { kind: 'CREATE_FILE', path: s.path, newText: s.newText };
    const { receipt } = ws.issueReceipt(s.path);
    return {
      kind: s.kind,
      path: s.path,
      receiptId: receipt.receiptId,
      oldText: s.oldText,
      newText: s.newText,
    };
  });
  const result = applyMutationPlan(ws, {
    planId: newId('plan'),
    runId,
    inputGeneration: ws.activeGeneration,
    operations,
  });
  if (!result.ok) throw new Error(`fixture mutation 失败: ${result.reason} ${result.detail}`);
}

/** 模拟验证命令在工作区里写文件（构建产物、缓存），这不是 Agent 的编辑意图 */
function writeIntoActive(ws: MaterializedWorkspace, rel: string, content: string): void {
  const abs = join(ws.activePath, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function headerLines(diff: string): string[] {
  return diff.split('\n').filter((l) => /^(diff --git |--- |\+\+\+ )/.test(l));
}

afterEach(() => {
  workspace?.cleanup();
  workspace = null;
  for (const h of hosts.splice(0)) rmSync(h, { recursive: true, force: true });
});

afterAll(() => {
  // 只删自己 mock 出来的临时根；万一 mock 没生效，这里就不会误删真实数据根
  if (PATHS.root.startsWith(tmpdir()) || PATHS.root.startsWith('/private')) {
    rmSync(PATHS.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

describe('diff 头归一化', () => {
  it('修改文件：头里只有仓库相对路径，宿主与工作区绝对路径一个字都不泄漏', () => {
    const { ws, runId, baseSha } = open({
      'src/greet.ts': 'export function greet(n: string) {\n  return "hi " + n;\n}\n',
      'package.json': '{"name":"t"}\n',
    });
    mutate(ws, runId, [
      {
        kind: 'REPLACE_EXACT_TEXT_SPAN',
        path: 'src/greet.ts',
        oldText: '"hi " + n',
        newText: '`hi ${n}`',
      },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // git diff --no-index 天然产出的是两个绝对路径；normalizeHeaders 必须全部换掉。
    // 只断言"包含 a/src/greet.ts"是不够的 —— 那种断言在头里同时还留着绝对路径时也过。
    expect(headerLines(patch.unifiedDiff)).toEqual([
      'diff --git a/src/greet.ts b/src/greet.ts',
      '--- a/src/greet.ts',
      '+++ b/src/greet.ts',
    ]);
    expect(patch.unifiedDiff).not.toContain(hosts[0]);
    expect(patch.unifiedDiff).not.toContain(ws.root);
    expect(patch.unifiedDiff).not.toContain(tmpdir());
    // 同一份内容也必须存进 files[].diff，两处不能各说各话
    expect(patch.files[0]!.diff).toBe(patch.unifiedDiff);
  });

  it('新增文件：--- 侧保持 /dev/null 不被改写成 a/…，changeKind 为 ADDED', () => {
    const { ws, runId, baseSha } = open({ 'src/keep.ts': 'export const keep = 1;\n' });
    mutate(ws, runId, [
      {
        kind: 'CREATE_FILE',
        path: 'src/added.ts',
        newText: 'export const x = 1;\nexport const y = 2;\n',
      },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const entry = patch.files.find((f) => f.path === 'src/added.ts')!;

    expect(entry.changeKind).toBe('ADDED');
    // /dev/null 是新增文件的语义标记：写成 a/src/added.ts 会让 git apply 以为
    // 这是一次修改，从而在目标文件不存在时失败
    expect(headerLines(entry.diff)).toEqual([
      'diff --git a/src/added.ts b/src/added.ts',
      '--- /dev/null',
      '+++ b/src/added.ts',
    ]);
    expect(entry.addedLines).toBe(2);
    expect(entry.removedLines).toBe(0);
    expect(entry.diffTruncated).toBe(false);
  });

  it('修改既有文件不会被误判成 ADDED（baseline 存在性是判据，不是猜的）', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
      { kind: 'CREATE_FILE', path: 'src/b.ts', newText: 'const b = 1;\n' },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // 两个文件同批提交，changeKind 必须各判各的
    expect(patch.files.map((f) => [f.path, f.changeKind])).toEqual([
      ['src/a.ts', 'MODIFIED'],
      ['src/b.ts', 'ADDED'],
    ]);
  });
});

describe('行数统计', () => {
  it('+++/--- 文件头不计入 addedLines / removedLines', () => {
    const { ws, runId, baseSha } = open({
      'src/calc.ts': 'export function calc(a: number, b: number) {\n  return a + b;\n}\n',
    });
    mutate(ws, runId, [
      {
        kind: 'REPLACE_EXACT_TEXT_SPAN',
        path: 'src/calc.ts',
        oldText: '  return a + b;',
        newText: '  const sum = a + b;\n  return sum;',
      },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const entry = patch.files[0]!;

    // 头确实在 diff 里（否则这条断言就是空转）
    expect(entry.diff).toContain('--- a/src/calc.ts');
    expect(entry.diff).toContain('+++ b/src/calc.ts');
    // 1 行换 2 行；把头算进去就会变成 3 / 2
    expect(entry.addedLines).toBe(2);
    expect(entry.removedLines).toBe(1);
  });

  it('内容行本身以 ++ / -- 开头时被当成文件头漏计（产品缺陷）', () => {
    // 现实里很常见：SQL 的 `-- 注释`、YAML 的 `---` 分隔符、C 风格的 `++i;`
    // 顶格出现时，diff 行会变成 `----…` / `+++…`，countPrefix 把它们当文件头跳过。
    const { ws, runId, baseSha } = open({ 'db/schema.sql': '--- 旧分隔线\nSELECT 1;\n' });
    mutate(ws, runId, [
      {
        kind: 'REPLACE_EXACT_TEXT_SPAN',
        path: 'db/schema.sql',
        oldText: '--- 旧分隔线',
        newText: '++inc',
      },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const entry = patch.files[0]!;

    // 用户看到的是 0/0，而 diff 里明明有一增一删
    expect(entry.removedLines).toBe(1);
    expect(entry.addedLines).toBe(1);
  });
});

describe('生成文件的可见性', () => {
  it('构建产物不进 files，但逐条出现在 excludedGeneratedFiles', () => {
    const { ws, runId, baseSha } = open({
      'src/greet.ts': 'export const g = 1;\n',
      'package.json': '{"name":"t"}\n',
    });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/greet.ts', newText: 'export const g = 2;\n' },
    ]);
    // 验证命令跑完之后工作区里多出来的东西
    writeIntoActive(ws, 'dist/bundle.js', 'console.log(1);\n');
    writeIntoActive(ws, 'dist/assets/app.css', 'body{}\n');
    writeIntoActive(ws, 'node_modules/.vite/deps/react.js', 'export default {};\n');

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    expect(patch.files.map((f) => f.path)).toEqual(['src/greet.ts']);
    // 静默过滤和静默通过是同一类问题：过滤掉了就必须在别处说清楚
    expect(patch.excludedGeneratedFiles).toEqual([
      'dist/assets/app.css',
      'dist/bundle.js',
      'node_modules/.vite/deps/react.js',
    ]);
    expect(patch.unifiedDiff).not.toContain('bundle.js');
  });

  it('改动全是生成文件时 files 为空 —— 但空补丁不等于"什么都没发生"', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    // 不做任何 authored 改动，只推进一代（模拟只跑了验证命令）
    const staged = ws.stage();
    expect(ws.commit(staged.generation, 0)).toBe(true);
    writeIntoActive(ws, 'dist/bundle.js', 'console.log(1);\n');

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    expect(patch.files).toEqual([]);
    expect(patch.unifiedDiff).toBe('');
    // 这条才是关键：如果 excludedGeneratedFiles 也是空的，这个补丁就和
    // "工作区原封不动"完全无法区分了
    expect(patch.excludedGeneratedFiles).toEqual(['dist/bundle.js']);
    expect(patch.generation).toBe(1);
  });

  it('被删除的文件在补丁里无声消失（产品缺陷）', () => {
    const { ws, runId, baseSha } = open({
      'src/keep.ts': 'const k = 1;\n',
      'src/legacy.ts': 'const legacy = 1;\n',
    });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/keep.ts', newText: 'const k = 2;\n' },
    ]);
    // 验证命令（clean 脚本之类）把一个基线文件删掉了
    rmSync(join(ws.activePath, 'src/legacy.ts'));

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // changedVsBaseline 只遍历"当前存在的文件"，删除既不在 files 也不在
    // excludedGeneratedFiles —— 违反模块自己声明的"不允许静默把文件去掉"
    const surfaced = [...patch.files.map((f) => f.path), ...patch.excludedGeneratedFiles];
    expect(surfaced).toContain('src/legacy.ts');
  });
});

describe('验证绑定', () => {
  const comparison: VerificationComparison = {
    fixed: ['build'],
    stillFailing: [],
    newlyFailing: ['test'],
    notRerun: [],
  };

  function verificationRun(runId: string, generation: number): VerificationRun {
    return {
      verificationRunId: 'vrun_fixture_0001',
      runId,
      attemptId: 'att_fixture',
      phase: 'POST_MUTATION',
      generation,
      commands: [],
      passed: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    };
  }

  it('未验证模式：verification / comparison 传 null 时两者都必须是 null', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, ['build 未运行']);

    // 用 null 而不是 '' / undefined：类型上就能区分"没验证"和"验证了但没 id"
    expect(patch.verificationRunId).toBeNull();
    expect(patch.comparison).toBeNull();
    // 未覆盖项必须原样带到交付物上，不能被吞掉
    expect(patch.unverifiedItems).toEqual(['build 未运行']);
  });

  it('已验证模式：verificationRunId 取自 VerificationRun，comparison 原样透传', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const patch = sealPatch(
      ws,
      runId,
      newId('att'),
      baseSha,
      verificationRun(runId, ws.activeGeneration),
      comparison,
      [],
    );

    // 和上一条成对存在：只有两条同时过，才能排除"永远返回 null"或"永远返回 id"
    expect(patch.verificationRunId).toBe('vrun_fixture_0001');
    expect(patch.comparison).toEqual(comparison);
    // newlyFailing 不允许在封存时被"友好地"抹掉
    expect(patch.comparison?.newlyFailing).toEqual(['test']);
    expect(patch.unverifiedItems).toEqual([]);
  });
});

describe('单文件 diff 超限截断', () => {
  const LINES = 3000;
  const bigFile = `${Array.from({ length: LINES }, (_, i) => `export const CONST_${i} = ${i};`).join('\n')}\n`;

  it('内容被截断，但路径、行数统计和截断标记全部保留', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [{ kind: 'CREATE_FILE', path: 'src/huge.ts', newText: bigFile }]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const entry = patch.files.find((f) => f.path === 'src/huge.ts')!;

    expect(entry.diffTruncated).toBe(true);
    expect(entry.diff).toContain('已截断');
    expect(entry.diff).toContain(`gen-${ws.activeGeneration}`);
    // 内容真的短了（否则 diffTruncated 就是个装饰）
    expect(entry.diff.length).toBeLessThan(MAX_DIFF_BYTES_PER_FILE + 200);

    // 这才是"不静默丢文件"的实质：路径与统计仍然是完整 diff 的，
    // 不能因为展示截断了就顺手把行数也报成截断后的
    expect(entry.path).toBe('src/huge.ts');
    expect(entry.changeKind).toBe('ADDED');
    expect(entry.addedLines).toBe(LINES);
    expect(entry.removedLines).toBe(0);
    // 截断后的内容里根本装不下 3000 行，用它数出来的值必然更小
    expect(entry.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length)
      .toBeLessThan(LINES);
  });

  it('同批次里没超限的文件不受影响', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'CREATE_FILE', path: 'src/huge.ts', newText: bigFile },
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // 截断是 per-file 的，不能因为一个大文件把整笔补丁都标成截断
    expect(patch.files.find((f) => f.path === 'src/a.ts')!.diffTruncated).toBe(false);
    expect(patch.files.find((f) => f.path === 'src/huge.ts')!.diffTruncated).toBe(true);
    expect(patch.files).toHaveLength(2);
  });

  it('多字节内容：按字节判超限却按字符截断，体积上限形同虚设（产品缺陷）', () => {
    // 中文一个字符 3 字节。Buffer.byteLength(raw) > 60000 触发 truncated=true，
    // 但 raw.slice(0, 60000) 是**字符**切片，26000 字符的 diff 一个字都没被切掉。
    // 结果：标了"已截断"却原样存进 artifact，上限没起作用，提示还是假的。
    const cjk = `${Array.from({ length: 2000 }, (_, i) => `常量说明行文本内容第${i}行`).join('\n')}\n`;
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [{ kind: 'CREATE_FILE', path: 'docs/notes.md', newText: cjk }]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const entry = patch.files.find((f) => f.path === 'docs/notes.md')!;

    expect(entry.diffTruncated).toBe(true);
    expect(Buffer.byteLength(entry.diff, 'utf8')).toBeLessThanOrEqual(MAX_DIFF_BYTES_PER_FILE + 200);
  });
});

describe('封存元数据', () => {
  it('digest 绑定树内容：同一状态两次封存相同，改一个字节就不同', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const first = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    const second = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // digest 要能当"同一棵树"的判据，所以不能掺 patchId / sealedAt 这类随机量
    expect(second.digest).toBe(first.digest);
    expect(second.patchId).not.toBe(first.patchId);

    // 路径集合不变、只有内容变 —— digest 仍然必须变，否则它只是路径列表的哈希
    mutate(ws, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 3;\n' },
    ]);
    const third = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);
    expect(third.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
    expect(third.digest).not.toBe(first.digest);
    expect(third.generation).toBe(2);
  });

  it('没有任何改动时：files 与 unifiedDiff 都是空，不凭空造出一个补丁条目', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    expect(patch.files).toEqual([]);
    expect(patch.unifiedDiff).toBe('');
    expect(patch.excludedGeneratedFiles).toEqual([]);
    expect(patch.generation).toBe(0);
    expect(patch.baseSha).toBe(baseSha);
  });

  it('多文件：files 按路径排序，unifiedDiff 与 files 一一对应且顺序一致', () => {
    const { ws, runId, baseSha } = open({ 'src/a.ts': 'const a = 1;\n' });
    mutate(ws, runId, [
      { kind: 'CREATE_FILE', path: 'src/z.ts', newText: 'const z = 1;\n' },
      { kind: 'CREATE_FILE', path: 'docs/readme.md', newText: '# hi\n' },
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const patch = sealPatch(ws, runId, newId('att'), baseSha, null, null, []);

    // 顺序确定，展示层和导出的 .diff 才可复现比对
    expect(patch.files.map((f) => f.path)).toEqual(['docs/readme.md', 'src/a.ts', 'src/z.ts']);
    expect(patch.unifiedDiff).toBe(patch.files.map((f) => f.diff).join('\n'));
    expect(headerLines(patch.unifiedDiff).filter((l) => l.startsWith('diff --git '))).toEqual([
      'diff --git a/docs/readme.md b/docs/readme.md',
      'diff --git a/src/a.ts b/src/a.ts',
      'diff --git a/src/z.ts b/src/z.ts',
    ]);
  });
});

describe('子包坐标系', () => {
  it('子包导入时 diff 头用子包内相对路径，不带 apps/web 前缀也不带绝对路径', () => {
    const host = setupHost({
      'apps/web/src/a.ts': 'const a = 1;\n',
      'apps/web/package.json': '{"name":"web"}\n',
      'package.json': '{"name":"root"}\n',
    });
    ensureDataRoot();
    const snapshot = importSnapshot('proj_patch', host, { subPath: 'apps/web' });
    const runId = newId('run');
    workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);
    mutate(workspace, runId, [
      { kind: 'REPLACE_WHOLE_FILE', path: 'src/a.ts', newText: 'const a = 2;\n' },
    ]);

    const patch = sealPatch(workspace, runId, newId('att'), snapshot.baseSha, null, null, []);

    // 坐标系是子包根：还原到仓库根是 applyPatchWithGit 的 --directory 的职责，
    // 封存阶段擅自加前缀会导致两边都加一次
    expect(headerLines(patch.unifiedDiff)).toEqual([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
    ]);
    expect(patch.unifiedDiff).not.toContain('apps/web');
    expect(patch.unifiedDiff).not.toContain(host);
  });
});
