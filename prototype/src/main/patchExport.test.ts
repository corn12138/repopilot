import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExportDestinationError,
  classifyExportDestination,
  writeExportAtomically,
} from './patchExport';

/**
 * 导出是除「应用到仓库」之外**唯一会写用户磁盘**的路径。
 * 08-17 审计：此前它是一句裸 `writeFileSync` —— 不排除项目根、不做 no-follow/TOCTOU 重验、
 * 非 atomic、静默覆盖。这些用例逐条钉住它现在挡住了什么。
 */

let sandbox: string;
let repo: string;
let dataRoot: string;
let downloads: string;

const CONTENT = '# RepoPilot patch\n--- a/x\n+++ b/x\n-old\n+new\n';

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'repopilot-export-')));
  repo = join(sandbox, 'repo');
  dataRoot = join(sandbox, 'managed');
  downloads = join(sandbox, 'downloads');
  for (const d of [repo, join(repo, 'src'), dataRoot, downloads]) mkdirSync(d, { recursive: true });
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function forbidden(): string[] {
  return [repo, dataRoot];
}

describe('classifyExportDestination：受保护根', () => {
  it('正常目的地放行，并回报"是否会覆盖已存在文件"', () => {
    const fresh = classifyExportDestination(join(downloads, 'fix.patch'), forbidden());
    expect(fresh).toMatchObject({ ok: true, existing: false });

    writeFileSync(join(downloads, 'old.patch'), 'x', 'utf8');
    const over = classifyExportDestination(join(downloads, 'old.patch'), forbidden());
    expect(over).toMatchObject({ ok: true, existing: true });
  });

  it('项目仓库内（含子目录）一律拒绝 —— 存进去下次导入就会把它当源码收进快照', () => {
    for (const target of [join(repo, 'fix.patch'), join(repo, 'src', 'deep', '..', 'fix.patch')]) {
      const v = classifyExportDestination(target, forbidden());
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.reason).toBe('FORBIDDEN_ROOT');
        expect(v.detail).toContain(repo);
      }
    }
  });

  it('受管数据根内拒绝 —— 保留策略会把陌生文件当垃圾清掉', () => {
    const v = classifyExportDestination(join(dataRoot, 'snapshots', '..', 'fix.patch'), forbidden());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('FORBIDDEN_ROOT');
  });

  it('用符号链接绕进受保护根：按 realpath 判，不按字符串判', () => {
    // ~/downloads/sneaky -> /repo：字符串看起来在 downloads 下，实际落在仓库里
    symlinkSync(repo, join(downloads, 'sneaky'), 'dir');
    const v = classifyExportDestination(join(downloads, 'sneaky', 'fix.patch'), forbidden());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('FORBIDDEN_ROOT');
  });

  it('目标本身是符号链接 → 不跟随也不覆盖（它可能指向任何地方）', () => {
    const victim = join(sandbox, 'victim.txt');
    writeFileSync(victim, 'important', 'utf8');
    symlinkSync(victim, join(downloads, 'link.patch'));
    const v = classifyExportDestination(join(downloads, 'link.patch'), forbidden());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('NOT_A_REGULAR_FILE');
    expect(readFileSync(victim, 'utf8')).toBe('important');
  });

  it('目标是目录 → 拒绝；父目录不存在 → UNRESOLVABLE（与"被禁止"区分开）', () => {
    mkdirSync(join(downloads, 'adir'));
    const dir = classifyExportDestination(join(downloads, 'adir'), forbidden());
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.reason).toBe('NOT_A_REGULAR_FILE');

    const gone = classifyExportDestination(join(downloads, 'nope', 'fix.patch'), forbidden());
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toBe('UNRESOLVABLE');
  });

  it('受保护根本身不存在时不影响判定（工作区可能已被清理）', () => {
    const v = classifyExportDestination(join(downloads, 'fix.patch'), [
      ...forbidden(),
      join(sandbox, 'already-cleaned-workspace'),
    ]);
    expect(v.ok).toBe(true);
  });
});

describe('writeExportAtomically', () => {
  it('写成功：内容逐字节一致，不留临时文件', () => {
    const target = join(downloads, 'fix.patch');
    const r = writeExportAtomically(target, CONTENT, forbidden());
    expect(r).toEqual({ bytes: Buffer.byteLength(CONTENT, 'utf8'), overwrote: false });
    expect(readFileSync(target, 'utf8')).toBe(CONTENT);
    expect(readdirSync(downloads)).toEqual(['fix.patch']);
  });

  it('覆盖已存在文件时如实回报 overwrote=true（"静默覆盖"要变成可陈述的事实）', () => {
    const target = join(downloads, 'fix.patch');
    writeFileSync(target, 'previous', 'utf8');
    const r = writeExportAtomically(target, CONTENT, forbidden());
    expect(r.overwrote).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(CONTENT);
  });

  it('写之前会**再判一次**：选完路径之后目标被换成符号链接，仍然拒绝且不写', () => {
    const victim = join(sandbox, 'victim.txt');
    writeFileSync(victim, 'important', 'utf8');
    const target = join(downloads, 'fix.patch');

    // 第一次判定通过（此刻目标不存在）
    expect(classifyExportDestination(target, forbidden()).ok).toBe(true);
    // TOCTOU 窗口：目标被换成指向别处的链接
    symlinkSync(victim, target);

    expect(() => writeExportAtomically(target, CONTENT, forbidden())).toThrow(ExportDestinationError);
    expect(readFileSync(victim, 'utf8')).toBe('important');
    expect(readdirSync(downloads)).toEqual(['fix.patch']); // 只有那个链接，没有临时文件
  });

  it('落在受保护根时直接抛 ExportDestinationError，一个字节都不写', () => {
    const target = join(repo, 'fix.patch');
    try {
      writeExportAtomically(target, CONTENT, forbidden());
      throw new Error('本该拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(ExportDestinationError);
      if (err instanceof ExportDestinationError) expect(err.reason).toBe('FORBIDDEN_ROOT');
    }
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(repo).sort()).toEqual(['src']);
  });

  it('写入失败（目录只读）时不留半个文件、也不留临时目录', () => {
    const target = join(downloads, 'fix.patch');
    // 让父目录不可写：mkdtemp 会失败
    const locked = join(sandbox, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    try {
      expect(() => writeExportAtomically(join(locked, 'fix.patch'), CONTENT, forbidden())).toThrow();
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      rmSync(locked, { recursive: true, force: true });
    }
    // 对照：正常目录仍然写得进去
    expect(writeExportAtomically(target, CONTENT, forbidden()).bytes).toBeGreaterThan(0);
  });
});
