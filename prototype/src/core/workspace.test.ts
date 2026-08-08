import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@shared/ids';
import {
  MaterializedWorkspace,
  PathViolation,
  fileDigestAt,
  isGeneratedPath,
  listTree,
  resolveManaged,
} from './workspace';
import { snapshotDir } from './paths';

/**
 * MaterializedWorkspace 自身的语义测试（mutation 引擎由 mutation.test.ts 覆盖）。
 *
 * 这个类是整个产品"宿主仓库永远只读 + 要么完整旧的要么完整新的"这条承诺的落点，
 * 所以下面几乎每条用例都在问同一个问题：**出错的时候，有没有东西被悄悄改掉/漏掉。**
 *
 * 数据根重定向：MaterializedWorkspace.create() 走 paths.workspaceDir/snapshotDir，
 * 默认落在 ~/Library/Application Support/RepoPilotPrototype。测试并行跑会互相踩，
 * 所以这里把这两个函数重定向到进程私有的临时目录；其余导出保持原样。
 */
const testDataRoot = vi.hoisted(async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtemp(joinPath(tmp(), 'repopilot-wstest-'));
});

vi.mock('./paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths')>();
  const { join: joinPath } = await import('node:path');
  const root = await testDataRoot;
  return {
    ...actual,
    workspaceDir: (runId: string) => joinPath(root, 'workspaces', runId),
    snapshotDir: (snapshotId: string) => joinPath(root, 'snapshots', snapshotId),
  };
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const FIXTURE: Record<string, string> = {
  'src/app.ts': 'const a = 1;\nconst b = 2;\nexport const total = a + b;\n',
  // 多字节内容：用来卡住"byteLength 写成了字符数"这类谎言
  'src/i18n.ts': 'export const 问候 = "你好，世界";\n',
  // dotfile：clone 用 `cp -R from/.` 而不是 glob，漏了它就说明克隆方式退化了
  '.hiddenrc': 'hidden=1\n',
  'package.json': '{"name":"fixture","version":"1.0.0"}\n',
};

let seq = 0;
const liveWorkspaces: MaterializedWorkspace[] = [];
const scratchDirs: string[] = [];

function writeTree(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function newSnapshot(files: Record<string, string>): string {
  const id = `snap_test_${process.pid}_${++seq}`;
  const dir = snapshotDir(id);
  rmSync(dir, { recursive: true, force: true });
  writeTree(dir, files);
  return id;
}

function newWorkspace(
  files: Record<string, string> = FIXTURE,
  hostRepoPath: string | null = null,
): MaterializedWorkspace {
  const ws = MaterializedWorkspace.create(
    `run_test_${process.pid}_${++seq}`,
    newSnapshot(files),
    hostRepoPath,
  );
  liveWorkspaces.push(ws);
  return ws;
}

/** 临时目录（受管根之外），用来模拟"链接指向仓库外面" */
function newScratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-outside-'));
  writeTree(dir, files);
  scratchDirs.push(dir);
  return dir;
}

/** 整棵树的逐字节指纹 —— 用来断言"失败之后什么都没变" */
function fingerprint(ws: MaterializedWorkspace): string {
  return JSON.stringify(listTree(ws.activePath));
}

/**
 * 直接往工作区目录里写文件，**故意绕开受治理的 mutation 接口**。
 * 这模拟的是验证命令（vite build / tsc）在工作区里的产出。
 */
function writeRaw(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * 空推进一代：不改任何内容，只让 activePath 和 baselinePath 变成两个不同的目录。
 *
 * 这是 changedVsBaseline 类用例的必要前置：gen-0 时基线目录**就是**活动目录，
 * 往里写什么都会同时改掉基线，差异恒为空 —— 那样的用例断言不到任何东西。
 */
function advanceGeneration(ws: MaterializedWorkspace): void {
  const staged = ws.stage();
  if (!ws.commit(staged.generation, staged.generation - 1)) {
    throw new Error('测试前置条件失败：空推进一代没能 commit');
  }
}

/** 捕获 PathViolation 并交出来 —— 只断言"抛了"不够，必须断言 reason 对 */
function violationOf(fn: () => unknown): PathViolation {
  try {
    fn();
  } catch (err) {
    if (err instanceof PathViolation) return err;
    throw err;
  }
  throw new Error('期望抛出 PathViolation，但函数正常返回了');
}

let root: string;

beforeEach(() => {
  root = newScratch();
});

afterEach(() => {
  for (const ws of liveWorkspaces) ws.cleanup();
  liveWorkspaces.length = 0;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

afterAll(async () => {
  rmSync(await testDataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('resolveManaged — 受管根边界', () => {
  it.each([
    ['/etc/passwd', 'POSIX 绝对路径'],
    ['/tmp/evil.ts', '绝对路径指向临时目录'],
    ['C:/Windows/system32', 'Windows 盘符 + 正斜杠'],
    ['C:\\Windows\\system32', 'Windows 盘符 + 反斜杠'],
    ['', '空路径：不能退化成"就用根目录"'],
  ])('拒绝 %s（%s）', (relPath) => {
    expect(violationOf(() => resolveManaged(root, relPath)).reason).toBe('PATH_ESCAPE');
  });

  it.each([
    ['..'],
    ['../outside.ts'],
    ['src/../../outside.ts'],
    ['a/b/../../../outside.ts'],
    // 反斜杠形态：POSIX 下 resolve() 不会把它当分隔符，所以逃逸检查必须自己拆两种分隔符
    ['..\\outside.ts'],
    // 即使 .. 最终仍落在根内也拒绝：不去"信任规范化后的结果"，只认字面形状
    ['src/../src/app.ts'],
  ])('拒绝含 .. 的路径 %s', (relPath) => {
    expect(violationOf(() => resolveManaged(root, relPath)).reason).toBe('PATH_ESCAPE');
  });

  it('尚不存在的深层路径可以解析 —— 否则 CREATE_FILE 无法建新目录', () => {
    const abs = resolveManaged(root, 'src/nested/deep/new.ts');
    expect(abs).toBe(join(root, 'src/nested/deep/new.ts'));
    expect(existsSync(abs)).toBe(false);
  });

  it('末级是 symlink → SYMLINK_REJECTED（而不是 PATH_ESCAPE）', () => {
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    expect(violationOf(() => resolveManaged(root, 'leak.txt')).reason).toBe('SYMLINK_REJECTED');
  });

  it('中间某一级是 symlink 目录 → 逐级检查必须在那一级就拦住', () => {
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(outside, join(root, 'leakdir'), 'dir');
    // 末级 secret.txt 本身不是链接，只有 leakdir 是 —— 只查末级的实现会漏掉这条
    expect(violationOf(() => resolveManaged(root, 'leakdir/secret.txt')).reason).toBe(
      'SYMLINK_REJECTED',
    );
  });

  it('指向根内部的 symlink 同样拒绝 —— 不去判断"这条链接是否安全"', () => {
    writeTree(root, { 'src/app.ts': 'x' });
    symlinkSync(join(root, 'src/app.ts'), join(root, 'alias.ts'));
    expect(violationOf(() => resolveManaged(root, 'alias.ts')).reason).toBe('SYMLINK_REJECTED');
  });

  it('普通文件与目录不会被误判成 symlink', () => {
    writeTree(root, { 'src/app.ts': 'x' });
    expect(resolveManaged(root, 'src/app.ts')).toBe(join(root, 'src/app.ts'));
  });
});

describe('工作区读取不会顺着 symlink 逃出受管根', () => {
  it('exists() 吞掉 PathViolation 返回 false，readText() 必须硬抛', () => {
    const ws = newWorkspace();
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(outside, join(ws.activePath, 'leakdir'), 'dir');

    expect(ws.exists('leakdir/secret.txt')).toBe(false);
    expect(ws.exists('../outside.ts')).toBe(false);
    // 读必须失败得很响：静默返回空串会让 Agent 以为文件是空的
    expect(violationOf(() => ws.readText('leakdir/secret.txt')).reason).toBe('SYMLINK_REJECTED');
    // 受管根外的内容确实还在原处，只是拿不到 —— 排除"因为我们把它删了才读不到"
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });

  it('symlink 指向的外部内容不会混进 listTree / treeDigest / 变更集', () => {
    const ws = newWorkspace();
    advanceGeneration(ws); // 让基线目录与活动目录分离，变更集断言才有意义
    const before = ws.treeDigest();
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(outside, join(ws.activePath, 'leakdir'), 'dir');

    const paths = listTree(ws.activePath).map((f) => f.path);
    expect(paths.some((p) => p.startsWith('leakdir'))).toBe(false);
    // 加一条链接不改变树指纹，否则补丁摘要会被外部目录的内容牵着走
    expect(ws.treeDigest()).toBe(before);
    expect(ws.changedVsBaseline()).toEqual({ authored: [], generated: [], deleted: [] });
  });
});

describe('listTree', () => {
  it('收录 dotfile 与嵌套文件，路径用 / 且已排序', () => {
    const ws = newWorkspace();
    expect(listTree(ws.activePath).map((f) => f.path)).toEqual([
      '.hiddenrc',
      'package.json',
      'src/app.ts',
      'src/i18n.ts',
    ]);
  });

  it('digest 与 bytes 按真实字节算（多字节文件不能按字符数）', () => {
    const ws = newWorkspace();
    const entry = listTree(ws.activePath).find((f) => f.path === 'src/i18n.ts');
    const raw = readFileSync(join(ws.activePath, 'src/i18n.ts'));
    expect(entry?.digest).toBe(sha256(raw));
    expect(entry?.bytes).toBe(raw.byteLength);
    expect(entry?.bytes).toBeGreaterThan(FIXTURE['src/i18n.ts']!.length);
  });

  it('目录不存在时返回空数组而不是抛 —— 调用点在算 digest，不该被 ENOENT 打断', () => {
    expect(listTree(join(root, 'no-such-dir'))).toEqual([]);
  });

  it('跳过文件 symlink 和目录 symlink，但不跳过它们旁边的真实文件', () => {
    writeTree(root, { 'real.ts': 'real', 'sub/inner.ts': 'inner' });
    const outside = newScratch({ 'a.txt': 'a', 'b.txt': 'b' });
    symlinkSync(join(outside, 'a.txt'), join(root, 'file-link.txt'));
    symlinkSync(outside, join(root, 'dir-link'), 'dir');

    expect(listTree(root).map((f) => f.path)).toEqual(['real.ts', 'sub/inner.ts']);
  });
});

describe('treeDigest', () => {
  it('同内容不同根 → 同 digest（内容寻址，不掺路径）', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    expect(a.activePath).not.toBe(b.activePath);
    expect(a.treeDigest()).toBe(b.treeDigest());
  });

  it('重写完全相同的内容（mtime 变了）→ digest 不变', () => {
    const ws = newWorkspace();
    const before = ws.treeDigest();
    writeRaw(ws.activePath, 'src/app.ts', FIXTURE['src/app.ts']!);
    expect(ws.treeDigest()).toBe(before);
  });

  it('改一个字节 → digest 必须变', () => {
    const ws = newWorkspace();
    const before = ws.treeDigest();
    writeRaw(ws.activePath, 'src/app.ts', FIXTURE['src/app.ts']!.replace('const a = 1;', 'const a = 2;'));
    expect(ws.treeDigest()).not.toBe(before);
  });

  it('新增文件 / 删除文件都要反映到 digest 上', () => {
    const ws = newWorkspace();
    const before = ws.treeDigest();
    writeRaw(ws.activePath, 'src/added.ts', 'export const n = 1;\n');
    const afterAdd = ws.treeDigest();
    expect(afterAdd).not.toBe(before);

    rmSync(join(ws.activePath, 'src/app.ts'));
    expect(ws.treeDigest()).not.toBe(afterAdd);
  });
});

describe('generation：stage / commit / discard', () => {
  it('stage() 克隆当前代，且对 staged 的写入不污染 active（克隆不是硬链接）', () => {
    const ws = newWorkspace();
    const staged = ws.stage();

    expect(staged.generation).toBe(ws.activeGeneration + 1);
    expect(readFileSync(join(staged.path, 'src/app.ts'), 'utf8')).toBe(FIXTURE['src/app.ts']);
    expect(existsSync(join(staged.path, '.hiddenrc'))).toBe(true);

    const before = fingerprint(ws);
    writeRaw(staged.path, 'src/app.ts', 'MUTATED');
    // 若 clonefile 退化成硬链接，这一行会失败 —— 那意味着"旧代仍完整可用"是假的
    expect(fingerprint(ws)).toBe(before);
    expect(ws.readText('src/app.ts')).toBe(FIXTURE['src/app.ts']);
  });

  it('stage() 会清掉上一次残留的 staged 目录（崩在半路的事务不能渗进下一代）', () => {
    const ws = newWorkspace();
    const first = ws.stage();
    writeRaw(first.path, 'leftover.ts', '上一次事务没提交完就挂了');

    const second = ws.stage();
    expect(second.generation).toBe(first.generation);
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'leftover.ts'))).toBe(false);
  });

  it('commit CAS 成功：active 推进，读到的是新代内容', () => {
    const ws = newWorkspace();
    const staged = ws.stage();
    writeRaw(staged.path, 'src/app.ts', 'const a = 99;\n');

    expect(ws.commit(staged.generation, 0)).toBe(true);
    expect(ws.activeGeneration).toBe(1);
    expect(ws.readText('src/app.ts')).toBe('const a = 99;\n');
    expect(ws.activePath).toBe(ws.generationPath(1));
  });

  it('expectedActive 不匹配 → commit 失败，且 active 与 receipt 一个都不动', () => {
    const ws = newWorkspace();
    const { receipt } = ws.issueReceipt('src/app.ts');
    const staged = ws.stage();
    writeRaw(staged.path, 'src/app.ts', 'const a = 99;\n');
    const before = fingerprint(ws);

    // 别人已经把 active 推到别处（这里用一个不等于 0 的 expected 来表达）
    expect(ws.commit(staged.generation, 5)).toBe(false);
    expect(ws.activeGeneration).toBe(0);
    expect(fingerprint(ws)).toBe(before);
    expect(ws.readText('src/app.ts')).toBe(FIXTURE['src/app.ts']);
    // CAS 失败不是"切代"，凭据不能被顺手清掉，否则调用方重试时会白白丢掉一次读
    expect(ws.getReceipt(receipt.receiptId)).toBeDefined();
  });

  it('stagedGeneration 不是 expectedActive+1 → 拒绝跳代提交', () => {
    const ws = newWorkspace();
    ws.stage();
    expect(ws.commit(3, 0)).toBe(false);
    expect(ws.commit(0, 0)).toBe(false);
    expect(ws.activeGeneration).toBe(0);
  });

  it('同一代重复 commit：第二次必须失败（幂等重放不能再推一代）', () => {
    const ws = newWorkspace();
    const staged = ws.stage();
    expect(ws.commit(staged.generation, 0)).toBe(true);
    expect(ws.commit(staged.generation, 0)).toBe(false);
    expect(ws.activeGeneration).toBe(1);
  });

  it('discard 之后 active 代号与内容逐字节不变，staged 目录被清掉', () => {
    const ws = newWorkspace();
    const before = fingerprint(ws);
    const staged = ws.stage();
    writeRaw(staged.path, 'src/app.ts', 'MUTATED');

    ws.discard(staged.generation);
    expect(ws.activeGeneration).toBe(0);
    expect(fingerprint(ws)).toBe(before);
    expect(existsSync(staged.path)).toBe(false);
  });

  it('discard 不能删掉当前代或更早的代 —— 传错代号不许炸掉活动工作区', () => {
    const ws = newWorkspace();
    const staged = ws.stage();
    expect(ws.commit(staged.generation, 0)).toBe(true);
    const before = fingerprint(ws);

    ws.discard(1); // == active
    ws.discard(0); // < active
    expect(ws.activeGeneration).toBe(1);
    expect(existsSync(ws.activePath)).toBe(true);
    expect(fingerprint(ws)).toBe(before);
    // gen-0 是 changedVsBaseline 的基线，删了它整个补丁就无从算起
    expect(existsSync(ws.baselinePath())).toBe(true);
  });

  it('discard 一个从未 stage 过的代号是无操作，不抛', () => {
    const ws = newWorkspace();
    const before = fingerprint(ws);
    expect(() => ws.discard(42)).not.toThrow();
    expect(fingerprint(ws)).toBe(before);
  });

  /**
   * BUG：commit() 只校验代号算术，不校验 staged 目录是否还在。
   * 先 discard 再 commit 会让 active 指向一个不存在的目录 —— 这既不是"完整的旧代"
   * 也不是"完整的新代"，正好打破类注释里承诺的那条不变式。期望它返回 false。
   */
  it('已被 discard 的代不应该还能 commit 成功', () => {
    const ws = newWorkspace();
    const staged = ws.stage();
    ws.discard(staged.generation);
    expect(ws.commit(staged.generation, 0)).toBe(false);
  });
});

describe('read receipt', () => {
  it('digest / byteLength 与磁盘内容一致，generation 是签发时的当前代', () => {
    const ws = newWorkspace();
    const { content, receipt } = ws.issueReceipt('src/i18n.ts');
    const raw = readFileSync(join(ws.activePath, 'src/i18n.ts'));

    expect(content).toBe(FIXTURE['src/i18n.ts']);
    expect(receipt.fileDigest).toBe(sha256(raw));
    expect(receipt.byteLength).toBe(raw.byteLength);
    expect(receipt.byteLength).not.toBe(content.length); // 多字节：字节数 ≠ 字符数
    expect(receipt.path).toBe('src/i18n.ts');
    expect(receipt.generation).toBe(ws.activeGeneration);
  });

  it('expiresAt 在未来，且比 readAt 晚 15 分钟', () => {
    const ws = newWorkspace();
    const { receipt } = ws.issueReceipt('src/app.ts');
    const ttl = Date.parse(receipt.expiresAt) - Date.parse(receipt.readAt);

    expect(Date.parse(receipt.expiresAt)).toBeGreaterThan(Date.now());
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });

  it('receipt 是读取瞬间的快照，文件后来被改也不会跟着变', () => {
    const ws = newWorkspace();
    const { receipt } = ws.issueReceipt('src/app.ts');
    writeRaw(ws.activePath, 'src/app.ts', '别人改过了\n');

    // 若 fileDigest 是"活引用"，apply 时的二次校验就形同虚设
    expect(receipt.fileDigest).toBe(sha256(Buffer.from(FIXTURE['src/app.ts']!, 'utf8')));
    expect(receipt.fileDigest).not.toBe(sha256(readFileSync(join(ws.activePath, 'src/app.ts'))));
  });

  it('同一文件连发两张凭据，id 不同且都可查', () => {
    const ws = newWorkspace();
    const a = ws.issueReceipt('src/app.ts').receipt;
    const b = ws.issueReceipt('src/app.ts').receipt;
    expect(a.receiptId).not.toBe(b.receiptId);
    expect(ws.getReceipt(a.receiptId)?.receiptId).toBe(a.receiptId);
    expect(ws.getReceipt(b.receiptId)?.receiptId).toBe(b.receiptId);
  });

  it('切代之后所有旧凭据一律失效（它们绑定的是旧 generation）', () => {
    const ws = newWorkspace();
    const a = ws.issueReceipt('src/app.ts').receipt;
    const b = ws.issueReceipt('package.json').receipt;

    const staged = ws.stage();
    expect(ws.commit(staged.generation, 0)).toBe(true);

    expect(ws.getReceipt(a.receiptId)).toBeUndefined();
    expect(ws.getReceipt(b.receiptId)).toBeUndefined();
    // 新代重新签发的凭据带的是新代号
    expect(ws.issueReceipt('src/app.ts').receipt.generation).toBe(1);
  });

  it('discard 不清凭据 —— active 没动，凭据就还有效', () => {
    const ws = newWorkspace();
    const { receipt } = ws.issueReceipt('src/app.ts');
    const staged = ws.stage();
    ws.discard(staged.generation);
    expect(ws.getReceipt(receipt.receiptId)).toBeDefined();
  });

  it('未知 receiptId 返回 undefined，不返回"看起来像"的那张', () => {
    const ws = newWorkspace();
    ws.issueReceipt('src/app.ts');
    expect(ws.getReceipt('rcpt_不存在')).toBeUndefined();
  });

  it('symlink 路径不发凭据：抛 SYMLINK_REJECTED', () => {
    const ws = newWorkspace();
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(join(outside, 'secret.txt'), join(ws.activePath, 'leak.ts'));
    expect(violationOf(() => ws.issueReceipt('leak.ts')).reason).toBe('SYMLINK_REJECTED');
  });

  it('逃逸路径不发凭据：抛 PATH_ESCAPE', () => {
    const ws = newWorkspace();
    expect(violationOf(() => ws.issueReceipt('../outside.ts')).reason).toBe('PATH_ESCAPE');
  });
});

describe('changedVsBaseline', () => {
  it('推进一代但没改内容 → 变更集为空（克隆本身不许制造假差异）', () => {
    const ws = newWorkspace();
    advanceGeneration(ws);
    expect(ws.activePath).not.toBe(ws.baselinePath());
    expect(ws.changedVsBaseline()).toEqual({ authored: [], generated: [], deleted: [] });
    expect(ws.changedFilesVsBaseline()).toEqual([]);
  });

  it('把构建产物和人写的改动分开，两边都排序', () => {
    const ws = newWorkspace();
    advanceGeneration(ws);
    writeRaw(ws.activePath, 'src/app.ts', 'const a = 99;\n');
    writeRaw(ws.activePath, 'src/added.ts', 'export const n = 1;\n');
    writeRaw(ws.activePath, 'dist/bundle.js', 'built');
    writeRaw(ws.activePath, 'coverage/lcov.info', 'cov');
    writeRaw(ws.activePath, '.vite/deps/x.js', 'cache');

    const { authored, generated } = ws.changedVsBaseline();
    expect(authored).toEqual(['src/added.ts', 'src/app.ts']);
    expect(generated).toEqual(['.vite/deps/x.js', 'coverage/lcov.info', 'dist/bundle.js']);
    // changedFilesVsBaseline 是补丁的输入，生成物绝不能混进去
    expect(ws.changedFilesVsBaseline()).toEqual(authored);
  });

  it('前缀相似的真实源码目录不能被当成构建产物吞掉', () => {
    const ws = newWorkspace();
    advanceGeneration(ws);
    writeRaw(ws.activePath, 'distribution/plan.ts', 'x');
    writeRaw(ws.activePath, 'outbound/mail.ts', 'x');
    writeRaw(ws.activePath, 'src/dist-helper.ts', 'x');

    // 被误判成 generated 就等于用户的改动被静默丢弃
    expect(ws.changedVsBaseline().generated).toEqual([]);
    expect(ws.changedVsBaseline().authored).toEqual([
      'distribution/plan.ts',
      'outbound/mail.ts',
      'src/dist-helper.ts',
    ]);
  });

  it('改完又改回原样 → 不算改动（按内容比，不按 mtime）', () => {
    const ws = newWorkspace();
    advanceGeneration(ws);
    writeRaw(ws.activePath, 'src/app.ts', '临时乱改\n');
    expect(ws.changedVsBaseline().authored).toEqual(['src/app.ts']);

    writeRaw(ws.activePath, 'src/app.ts', FIXTURE['src/app.ts']!);
    expect(ws.changedVsBaseline().authored).toEqual([]);
  });

  it('多代之后仍然对比 gen-0，而不是上一代', () => {
    const ws = newWorkspace();
    const g1 = ws.stage();
    writeRaw(g1.path, 'src/app.ts', 'const a = 99;\n');
    expect(ws.commit(g1.generation, 0)).toBe(true);

    const g2 = ws.stage();
    writeRaw(g2.path, 'package.json', '{"name":"changed"}\n');
    expect(ws.commit(g2.generation, 1)).toBe(true);

    // 第一代的改动不能因为第二代没碰它就从补丁里消失
    expect(ws.changedVsBaseline().authored).toEqual(['package.json', 'src/app.ts']);
  });

  /**
   * BUG：changedVsBaseline 只遍历当前代，基线里存在、当前代已被删掉的文件
   * 两个列表里都不出现 —— 这是一次静默省略，和 PRD-DIFF-001「任何省略都要说明」相冲。
   * 原型里没有 DELETE_FILE 操作，但验证命令（clean 脚本等）完全可能删文件。
   */
  it('被删掉的基线文件应当出现在变更集里', () => {
    const ws = newWorkspace();
    advanceGeneration(ws);
    rmSync(join(ws.activePath, 'src/app.ts'));
    // 删除有自己的类别：它既不是"人改的内容"也不是"命令生成的"，
    // 但绝不能从变更集里消失 —— 那是 patch.ts 明令禁止的静默省略
    const { authored, generated, deleted } = ws.changedVsBaseline();
    expect(deleted).toContain('src/app.ts');
    expect([...authored, ...generated]).not.toContain('src/app.ts');
  });
});

describe('isGeneratedPath', () => {
  it.each([
    ['dist/bundle.js', true],
    ['dist', true],
    ['build/main.js', true],
    ['out/index.js', true],
    ['coverage/lcov.info', true],
    ['.vite/deps/x.js', true],
    ['.turbo/log.txt', true],
    ['.next/static/x.js', true],
    ['node_modules/react/index.js', true],
    // 下面这些必须是 false：吞掉它们等于丢用户代码
    ['distribution/plan.ts', false],
    ['distance.ts', false],
    ['outbound/mail.ts', false],
    ['builder/config.ts', false],
    ['src/dist/bundle.js', false],
    ['src/app.ts', false],
    ['', false],
  ])('%s → %s', (path, expected) => {
    expect(isGeneratedPath(path)).toBe(expected);
  });
});

describe('fileDigestAt', () => {
  it('与内容 sha256 一致', () => {
    const ws = newWorkspace();
    expect(fileDigestAt(ws.activePath, 'src/i18n.ts')).toBe(
      sha256(readFileSync(join(ws.activePath, 'src/i18n.ts'))),
    );
  });

  it('文件不存在 → null（不是抛，也不是空 digest）', () => {
    const ws = newWorkspace();
    expect(fileDigestAt(ws.activePath, 'src/nope.ts')).toBeNull();
  });

  it('目标是目录 → null，不去 digest 一个目录', () => {
    const ws = newWorkspace();
    expect(fileDigestAt(ws.activePath, 'src')).toBeNull();
  });

  it('symlink → 抛 PathViolation，绝不返回链接目标的 digest', () => {
    const ws = newWorkspace();
    const outside = newScratch({ 'secret.txt': 'TOP SECRET' });
    symlinkSync(join(outside, 'secret.txt'), join(ws.activePath, 'leak.ts'));
    expect(violationOf(() => fileDigestAt(ws.activePath, 'leak.ts')).reason).toBe(
      'SYMLINK_REJECTED',
    );
  });
});

describe('宿主 node_modules 的只读复用', () => {
  function hostWithDeps(): string {
    return newScratch({ 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
  }

  it('依赖链接挂上了，但既不进 listTree 也不进 treeDigest', () => {
    const host = hostWithDeps();
    const withDeps = newWorkspace(FIXTURE, host);
    const withoutDeps = newWorkspace(FIXTURE, null);

    expect(lstatSync(join(withDeps.activePath, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(listTree(withDeps.activePath).some((f) => f.path.startsWith('node_modules'))).toBe(false);
    // 挂不挂依赖都不影响树指纹，否则补丁 digest 会随宿主环境漂移
    expect(withDeps.treeDigest()).toBe(withoutDeps.treeDigest());
    // 换一代之后依赖链接会被重新挂一次，它也不能因此变成一条"改动"
    advanceGeneration(withDeps);
    expect(withDeps.changedVsBaseline()).toEqual({ authored: [], generated: [], deleted: [] });
  });

  it('模型无法经由 node_modules/... 解析路径，宿主依赖不会被动到', () => {
    const host = hostWithDeps();
    const ws = newWorkspace(FIXTURE, host);

    expect(violationOf(() => ws.resolveInActive('node_modules/left-pad/index.js')).reason).toBe(
      'SYMLINK_REJECTED',
    );
    expect(ws.exists('node_modules/left-pad/index.js')).toBe(false);
    // 宿主那份仍然原样存在 —— 只读复用的前提就是它一个字节都没被改
    expect(readFileSync(join(host, 'node_modules/left-pad/index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
  });

  it('stage 出来的新代同样带依赖链接（否则新代一构建就找不到依赖）', () => {
    const ws = newWorkspace(FIXTURE, hostWithDeps());
    const staged = ws.stage();
    expect(lstatSync(join(staged.path, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('宿主没装依赖时不挂链接，也不报错', () => {
    const ws = newWorkspace(FIXTURE, newScratch());
    expect(existsSync(join(ws.activePath, 'node_modules'))).toBe(false);
  });
});

describe('工作区生命周期', () => {
  it('create 会清掉同名 runId 的残留目录（重跑不继承上一次的垃圾）', () => {
    const ws = newWorkspace();
    writeRaw(ws.activePath, 'garbage.ts', '上一轮留下的');
    const reborn = MaterializedWorkspace.create(ws.runId, newSnapshot(FIXTURE));
    liveWorkspaces.push(reborn);

    expect(reborn.root).toBe(ws.root);
    expect(existsSync(join(reborn.activePath, 'garbage.ts'))).toBe(false);
    expect(reborn.activeGeneration).toBe(0);
  });

  it('cleanup 删整个工作区根，但不碰快照（快照是 immutable 源）', () => {
    const snapshotId = newSnapshot(FIXTURE);
    const ws = MaterializedWorkspace.create(`run_test_${process.pid}_${++seq}`, snapshotId);
    expect(existsSync(ws.root)).toBe(true);

    ws.cleanup();
    expect(existsSync(ws.root)).toBe(false);
    expect(readFileSync(join(snapshotDir(snapshotId), 'src/app.ts'), 'utf8')).toBe(
      FIXTURE['src/app.ts'],
    );
  });
});
