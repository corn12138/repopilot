import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 把受管数据根整体重定向到临时目录。
 *
 * 为什么必须 mock：project() 落 artifact 走 PATHS.artifacts，MaterializedWorkspace
 * 走 workspaceDir/snapshotDir —— 两者默认都指向真实数据根
 * (~/Library/Application Support/RepoPilotPrototype)。测试往那里写会污染用户数据，
 * 而且并行跑的测试文件之间会互相踩。这里不改任何产品代码，只换掉路径来源。
 */
vi.mock('./paths', async () => {
  const { mkdirSync: mkdir, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const DATA_ROOT = mkdtempSync(j(tmpdir(), 'repopilot-tools-'));
  const PATHS = {
    root: DATA_ROOT,
    projects: j(DATA_ROOT, 'projects.json'),
    runs: j(DATA_ROOT, 'runs'),
    snapshots: j(DATA_ROOT, 'snapshots'),
    workspaces: j(DATA_ROOT, 'workspaces'),
    artifacts: j(DATA_ROOT, 'artifacts'),
  };
  const ensureDataRoot = (): void => {
    for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
      mkdir(d, { recursive: true });
    }
  };
  ensureDataRoot();
  return {
    DATA_ROOT,
    PATHS,
    ensureDataRoot,
    runDir: (runId: string) => j(PATHS.runs, runId),
    workspaceDir: (runId: string) => j(PATHS.workspaces, runId),
    snapshotDir: (snapshotId: string) => j(PATHS.snapshots, snapshotId),
  };
});

import type { CommandDefinition, CommandOutcome, RepositoryHarnessProfile } from '@shared/domain';
import { newId, sha256 } from '@shared/ids';
import { PATHS, snapshotDir } from './paths';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { MaterializedWorkspace, listTree } from './workspace';
import {
  PLANNING_TOOLS,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_LINES,
  TOOLS,
  TOOLS_BY_NAME,
  commandOutcomeToTool,
  project,
  type ToolContext,
  type ToolDefinition,
} from './tools';

/**
 * 工具层（Tool Gateway）的负向测试。
 *
 * 这一层是模型与文件系统之间**唯一**的闸门，它的失败模式都很安静：
 * 截断了不说、搜漏了不说、被取消了却报"无匹配"、写失败了却留下半个文件。
 * 所以下面绝大多数用例断的不是"成功了没"，而是"失败时说的原因对不对、
 * 有没有留下副作用、省略有没有被声明出来"。
 */

const FIXTURE: Record<string, string> = {
  'src/app.ts': 'const a = 1;\nconst b = 2;\nexport const total = a + b;\n',
  'src/deep/util.ts': 'export const u = 1;\n',
  'src/needle.ts': 'const NEEDLE = 1;\nconst other = 2;\n',
  // 前缀陷阱：fs_list('src') 绝不能把 srcx/ 也算进去
  'srcx/other.ts': 'export const o = 1;\n',
  'docs/readme.md': '# doc\nNEEDLE in docs\n',
  'top.ts': 'export const t = 1;\n',
};

let ws: MaterializedWorkspace;

function makeWorkspace(files: Record<string, string> = FIXTURE): MaterializedWorkspace {
  const snapshotId = newId('snap');
  const dir = snapshotDir(snapshotId);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return MaterializedWorkspace.create(newId('run'), snapshotId);
}

function makeProfile(commands: Record<string, CommandDefinition> = {}): RepositoryHarnessProfile {
  return {
    profileId: 'prof_test',
    snapshotId: 'snap_test',
    adapterId: 'vite-react-ts',
    adapterVersion: '0.1.0',
    supportStatus: 'VERIFIED',
    detectedSignals: [],
    packageManager: 'pnpm',
    commands,
    protectedPaths: [],
    supportedTaskClasses: [],
    notes: [],
  };
}

function cmd(argv: readonly string[], timeoutMs = 10_000): CommandDefinition {
  return {
    commandId: 'probe',
    label: argv.join(' '),
    argv,
    cwdRelative: '.',
    timeoutMs,
    risk: 'R1',
    source: 'DETECTED',
  };
}

function makeCtx(workspace: MaterializedWorkspace, over: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run_test',
    attemptId: 'att_test',
    workspace,
    profile: makeProfile(),
    mutationPolicy: DEFAULT_MUTATION_POLICY,
    signal: new AbortController().signal,
    ...over,
  };
}

function tool(name: string): ToolDefinition {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
}

/** 整棵树的指纹 —— 用来断言"失败后逐字节没变" */
function fingerprint(): string {
  return JSON.stringify(listTree(ws.activePath));
}

function artifactCount(): number {
  return readdirSync(PATHS.artifacts).length;
}

function artifactText(ref: string | null): string {
  if (!ref) throw new Error('期望有 artifact，但 artifactRef 为 null');
  return readFileSync(join(PATHS.artifacts, `${ref}.txt`), 'utf8');
}

beforeEach(() => {
  ws = makeWorkspace();
});

afterEach(() => {
  ws?.cleanup();
});

afterAll(() => {
  // 护栏：PATHS 来自 vi.mock，一旦 mock 失效这行会删掉用户真实的数据根。
  // 只允许删临时目录，绝不碰 ~/Library/Application Support。
  if (PATHS.root.startsWith(tmpdir()) || PATHS.root.startsWith('/private')) {
    rmSync(PATHS.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

describe('project — 输出投影', () => {
  it('未超限时原样返回，且不产生 artifact 文件', () => {
    // 每个小输出都落一个文件的话，artifacts 目录会被日常读文件撑爆
    const before = artifactCount();
    const p = project('hello\nworld', 'fs_read');
    expect(p.preview).toBe('hello\nworld');
    expect(p.truncated).toBe(false);
    expect(p.artifactRef).toBeNull();
    expect(artifactCount()).toBe(before);
  });

  it('恰好等于上限不算超限（边界是 >，不是 >=）', () => {
    const exactBytes = 'x'.repeat(PREVIEW_MAX_BYTES);
    expect(project(exactBytes, 't').truncated).toBe(false);

    const exactLines = Array.from({ length: PREVIEW_MAX_LINES }, (_, i) => `L${i}`).join('\n');
    expect(exactLines.split('\n')).toHaveLength(PREVIEW_MAX_LINES);
    expect(project(exactLines, 't').truncated).toBe(false);
  });

  it('超出字节上限一个字节就截断，artifact 逐字节保留完整内容', () => {
    const before = artifactCount();
    const full = 'x'.repeat(PREVIEW_MAX_BYTES + 1);
    const p = project(full, 'fs_read');
    expect(p.truncated).toBe(true);
    expect(p.artifactRef).not.toBeNull();
    expect(artifactCount()).toBe(before + 1);
    // artifact 是"完整内容"的唯一来源，少一个字节这条工具链就不可审计了
    expect(artifactText(p.artifactRef)).toBe(full);
  });

  it('只超行数不超字节也要截断，且 preview 真的只剩前 120 行', () => {
    const lines = Array.from({ length: PREVIEW_MAX_LINES + 1 }, (_, i) => `L${i}`);
    const full = lines.join('\n');
    expect(Buffer.byteLength(full, 'utf8')).toBeLessThan(PREVIEW_MAX_BYTES); // 确认只由行数触发

    const p = project(full, 'fs_glob');
    expect(p.truncated).toBe(true);
    expect(p.preview).toContain('L0');
    expect(p.preview).toContain(`L${PREVIEW_MAX_LINES - 1}`);
    // 关键：第 121 行必须真的不在 preview 里，否则"截断"只是个标记位
    expect(p.preview).not.toContain(`L${PREVIEW_MAX_LINES}`);
    expect(artifactText(p.artifactRef)).toBe(full);
  });

  it('截断说明报告的是完整内容的规模，而不是 preview 自己的规模', () => {
    // 这是最容易说谎的地方：把截断后的行数/字节数写进说明，用户就以为没丢东西
    const full = Array.from({ length: 500 }, () => 'y'.repeat(50)).join('\n');
    const p = project(full, 'run_command');
    expect(p.preview).toContain('已截断');
    expect(p.preview).toContain('500 行');
    expect(p.preview).toContain(`${Buffer.byteLength(full, 'utf8')} 字节`);
    // 说明里必须带 label 和 artifact id，否则用户无从把这段输出取回来
    expect(p.preview).toContain('run_command');
    expect(p.preview).toContain(p.artifactRef ?? '<none>');
    expect(p.preview.length).toBeLessThan(full.length);
  });

  it('两次截断产生互不覆盖的独立 artifact', () => {
    const a = project('a'.repeat(PREVIEW_MAX_BYTES + 1), 'x');
    const b = project('b'.repeat(PREVIEW_MAX_BYTES + 1), 'x');
    expect(a.artifactRef).not.toBe(b.artifactRef);
    // 固定文件名的实现会让后一次冲掉前一次，事件里的引用就指向错的内容
    expect(artifactText(a.artifactRef).startsWith('a')).toBe(true);
    expect(artifactText(b.artifactRef).startsWith('b')).toBe(true);
  });

  it('多字节内容下 preview 仍应受字节上限约束（按字符 slice 会超限 3 倍）', () => {
    // head 用的是 .slice(0, PREVIEW_MAX_BYTES) —— 那是 UTF-16 code unit，不是字节。
    // 中文注释/中文报错是这个产品的主场景，实际投给模型的 preview 会到 12000 字节。
    const full = '中'.repeat(4000); // 12000 字节
    const p = project(full, 'fs_read');
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(p.preview, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX_BYTES + 300);
  });
});

// ---------------------------------------------------------------------------

describe('fs_read', () => {
  it('modelText 里的 digest 与 receipt 一致，且绑定的是文件原始字节', async () => {
    const res = await tool('fs_read').execute({ path: 'src/app.ts' }, makeCtx(ws));
    expect(res.ok).toBe(true);

    const m = /^receiptId=(\S+)\ndigest=(\S+)\n\n/.exec(res.modelText);
    expect(m).not.toBeNull();
    const [, receiptId, digest] = m!;

    const receipt = ws.getReceipt(receiptId!);
    expect(receipt).toBeDefined();
    expect(receipt!.fileDigest).toBe(digest);
    expect(receipt!.path).toBe('src/app.ts');
    expect(receipt!.generation).toBe(ws.activeGeneration);
    expect(res.meta?.receiptId).toBe(receiptId);

    // digest 必须是原始字节的，不是渲染出来的带行号文本的 ——
    // 否则 apply 时重新计算 digest 永远对不上，receipt 就成了摆设
    const raw = readFileSync(join(ws.activePath, 'src/app.ts'));
    expect(digest).toBe(sha256(raw));
    expect(digest).not.toBe(sha256(res.preview));
    expect(receipt!.byteLength).toBe(raw.byteLength);
  });

  it('行号从 1 开始且右对齐 —— 模型靠它定位，错一行就改错地方', async () => {
    const res = await tool('fs_read').execute({ path: 'src/app.ts' }, makeCtx(ws));
    const lines = res.preview.split('\n');
    expect(lines[0]).toBe('    1\tconst a = 1;');
    expect(lines[1]).toBe('    2\tconst b = 2;');
  });

  it('文件不存在 → ok=false 且带路径，不发 receipt', async () => {
    const before = fingerprint();
    const res = await tool('fs_read').execute({ path: 'src/missing.ts' }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('TOOL_ERROR');
    expect(res.modelText).toContain('src/missing.ts');
    expect(res.meta).toBeUndefined(); // 没有 receiptId 泄出去
    expect(res.artifactRef).toBeNull();
    expect(fingerprint()).toBe(before);
  });

  it.each(['/etc/hosts', '../../../etc/hosts', 'src/../../escape.ts'])(
    '越界路径 %s 被拒绝且不抛异常',
    async (path) => {
      const res = await tool('fs_read').execute({ path }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.failureReason).toBe('TOOL_ERROR');
    },
  );

  it('symlink 不能被当成读文件的跳板', async () => {
    // 工作区里放一个指向宿主文件的链接：resolveManaged 逐级拒绝 symlink，
    // 所以这里必须读不到，而不是把 /etc/hosts 的内容喂给模型
    symlinkSync('/etc/hosts', join(ws.activePath, 'hosts.link'));
    const res = await tool('fs_read').execute({ path: 'hosts.link' }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.modelText).not.toContain('localhost');
  });

  it('大文件截断后 receiptId 仍在 modelText 里（截断不能把写入凭据吞掉）', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const local = makeWorkspace({ 'big.txt': big });
    try {
      const res = await tool('fs_read').execute({ path: 'big.txt' }, makeCtx(local));
      expect(res.ok).toBe(true);
      expect(res.previewTruncated).toBe(true);
      expect(res.artifactRef).not.toBeNull();
      // receipt 被截掉的话，模型就永远改不了这个文件
      expect(res.modelText).toMatch(/^receiptId=rcpt_/);
      expect(local.getReceipt(res.meta?.receiptId as string)).toBeDefined();
      // artifact 里是完整的带行号内容，最后一行必须在
      expect(artifactText(res.artifactRef)).toContain('  400\tline 399');
    } finally {
      local.cleanup();
    }
  });

  it('读一个目录应当优雅失败，而不是抛 EISDIR', async () => {
    // exists('src') 对目录返回 true，随后 issueReceipt 里的 readFileSync 直接抛，
    // 绕过了本工具自己的 fail() 契约，模型只会收到一句 OS errno
    const res = await tool('fs_read').execute({ path: 'src' }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('TOOL_ERROR');
  });
});

// ---------------------------------------------------------------------------

describe('fs_glob', () => {
  it('* 不跨越目录分隔符', async () => {
    const res = await tool('fs_glob').execute({ pattern: '*.ts' }, makeCtx(ws));
    expect(res.modelText.split('\n')).toContain('top.ts');
    // 经典 bug：把 * 编译成 .*，一个顶层 glob 就把整棵树捞回来
    expect(res.modelText).not.toContain('src/app.ts');
  });

  it('src/**/*.ts 命中嵌套但不越出 src', async () => {
    const res = await tool('fs_glob').execute({ pattern: 'src/**/*.ts' }, makeCtx(ws));
    const got = res.modelText.split('\n');
    expect(got).toContain('src/app.ts');
    expect(got).toContain('src/deep/util.ts');
    expect(got).not.toContain('srcx/other.ts');
    expect(got).not.toContain('docs/readme.md');
  });

  it('无匹配时明说无匹配，不退化成"返回全部"', async () => {
    const res = await tool('fs_glob').execute({ pattern: 'nope/**/*.rs' }, makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.modelText).toBe('（无匹配）');
  });
});

// ---------------------------------------------------------------------------

describe('fs_grep', () => {
  it.each(['(', '[a-', 'a{2,1}', '*'])('非法正则 %s → 报错而不是崩', async (pattern) => {
    const res = await tool('fs_grep').execute({ pattern }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('TOOL_ERROR');
    expect(res.modelText).toContain('无效正则');
  });

  it('命中格式是 path:line:内容，行号从 1 开始', async () => {
    const res = await tool('fs_grep').execute({ pattern: 'NEEDLE' }, makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.modelText).toContain('src/needle.ts:1: const NEEDLE = 1;');
    expect(res.modelText).toContain('docs/readme.md:2: NEEDLE in docs');
  });

  it('pathGlob 真的收窄了搜索范围', async () => {
    const res = await tool('fs_grep').execute({ pattern: 'NEEDLE', pathGlob: 'src/**' }, makeCtx(ws));
    expect(res.modelText).toContain('src/needle.ts:1');
    // 范围外的命中泄露出来，等于 TaskSpec 的范围约束在读侧就失效了
    expect(res.modelText).not.toContain('docs/readme.md');
  });

  it('无匹配是 ok=true 的正常结论，不是工具失败', async () => {
    const res = await tool('fs_grep').execute({ pattern: 'ZZZ_NOT_PRESENT' }, makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.failureReason).toBeUndefined();
    expect(res.modelText).toBe('（无匹配）');
  });

  it('达到 200 条命中上限时截断并声明结果不完整', async () => {
    const many = Array.from({ length: 300 }, (_, i) => `hit ${i} NEEDLE`).join('\n');
    const local = makeWorkspace({ 'many.txt': many });
    try {
      const res = await tool('fs_grep').execute({ pattern: 'NEEDLE' }, makeCtx(local));
      expect(res.ok).toBe(true);
      // 声明必须出现：否则模型会把"200 条"当成全部命中来推理
      expect(res.modelText).toContain('已达 200 条命中上限，结果不完整');
      expect(artifactText(res.artifactRef).split('\n')).toHaveLength(200);
      expect(res.modelText).not.toContain('hit 299');
    } finally {
      local.cleanup();
    }
  });

  it('未达上限时不得出现"结果不完整"（恒真告警等于没有告警）', async () => {
    const res = await tool('fs_grep').execute({ pattern: 'NEEDLE' }, makeCtx(ws));
    expect(res.modelText).not.toContain('不完整');
  });

  it('被取消时应当说明结果不完整，而不是把"没搜完"报成"无匹配"', async () => {
    // 循环开头 signal.aborted 就 break，然后一路走到 hits.length? '（无匹配）'。
    // 调用方（agent）拿到的是 ok=true 的"搜过了，没找到"，这是个会误导推理的谎。
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await tool('fs_grep').execute({ pattern: 'NEEDLE' }, makeCtx(ws, { signal: ctrl.signal }));
    expect(res.modelText).toMatch(/取消|中断|不完整/);
  });

  it('跳过超大文件时应当说明，否则"无匹配"同样是个谎', async () => {
    // >500KB 的文件被静默跳过。产品的立身之本是"任何省略都要说明"（PRD-DIFF-001），
    // 这里省略了却一个字都没提。
    const local = makeWorkspace({
      'huge.txt': `${'x'.repeat(600_000)}\nBIGNEEDLE\n`,
      'small.txt': 'nothing here\n',
    });
    try {
      const res = await tool('fs_grep').execute({ pattern: 'BIGNEEDLE' }, makeCtx(local));
      expect(res.modelText).toContain('（无匹配）'); // 现状：命中被跳过了
      expect(res.modelText).toMatch(/跳过|未搜索|过大/); // 现状：一个字都没说
    } finally {
      local.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------

describe('fs_list', () => {
  it('前缀过滤按目录边界，srcx 不算 src', async () => {
    const res = await tool('fs_list').execute({ path: 'src' }, makeCtx(ws));
    const got = res.modelText.split('\n');
    expect(got).toContain('src/app.ts');
    expect(got).toContain('src/deep/util.ts');
    // startsWith('src') 会把 srcx/other.ts 也算进来 —— 那是错的
    expect(got).not.toContain('srcx/other.ts');
    expect(got).not.toContain('top.ts');
  });

  it('带尾斜杠与不带等价', async () => {
    const withSlash = await tool('fs_list').execute({ path: 'src/' }, makeCtx(ws));
    const without = await tool('fs_list').execute({ path: 'src' }, makeCtx(ws));
    expect(withSlash.modelText).toBe(without.modelText);
  });

  it('不存在的目录给出明确文案，不是空串', async () => {
    const res = await tool('fs_list').execute({ path: 'no/such/dir' }, makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.modelText).toBe('（空目录或路径不存在）');
  });

  it("'.' 列出全部，与 listTree 一致", async () => {
    const res = await tool('fs_list').execute({ path: '.' }, makeCtx(ws));
    expect(res.modelText.split('\n').sort()).toEqual(listTree(ws.activePath).map((f) => f.path).sort());
  });

  it('schema 允许省略 path（jsonSchema 里它不是 required）', () => {
    const parsed = tool('fs_list').schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.path).toBe('.');
  });
});

// ---------------------------------------------------------------------------

describe('workspace_mutate — schema 校验', () => {
  const schema = () => tool('workspace_mutate').schema;

  it('REPLACE_EXACT_TEXT_SPAN 缺 receiptId → 在 receiptId 上报错', () => {
    const r = schema().safeParse({
      operations: [{ kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'a.ts', oldText: 'x', newText: 'y' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // 断在具体字段上：只断 success===false 的话，任何别的字段写错也能让它"通过"
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('operations.0.receiptId');
    }
  });

  it('REPLACE_WHOLE_FILE 同样必须带 receiptId', () => {
    const r = schema().safeParse({
      operations: [{ kind: 'REPLACE_WHOLE_FILE', path: 'a.ts', newText: 'y' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('operations.0.receiptId');
    }
  });

  it('CREATE_FILE 不需要 receiptId —— 上面两条不是被别的原因拦下的', () => {
    const r = schema().safeParse({
      operations: [{ kind: 'CREATE_FILE', path: 'a.ts', newText: 'y' }],
    });
    expect(r.success).toBe(true);
  });

  it('kind 非法 → 在 kind 上报判别式错误，而不是静默走某个分支', () => {
    const r = schema().safeParse({
      operations: [{ kind: 'DELETE_FILE', path: 'a.ts', newText: '' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'operations.0.kind');
      expect(issue?.code).toBe('invalid_union_discriminator');
    }
  });

  it('operations 为空数组 → 拒绝（空事务不是"什么都没做"，是参数错）', () => {
    const r = schema().safeParse({ operations: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe('too_small');
      expect(r.error.issues[0]?.path.join('.')).toBe('operations');
    }
  });

  it('operations 缺失 → 拒绝', () => {
    const r = schema().safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path.join('.')).toBe('operations');
  });

  it('超过 20 条 operation → 拒绝（预算上限在 schema 就卡住）', () => {
    const ops = Array.from({ length: 21 }, (_, i) => ({
      kind: 'CREATE_FILE',
      path: `f${i}.ts`,
      newText: 'x',
    }));
    const r = schema().safeParse({ operations: ops });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.code).toBe('too_big');
  });

  it.each([
    ['oldText 为空串', { kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'a.ts', receiptId: 'r', oldText: '', newText: 'y' }, 'operations.0.oldText'],
    ['path 为空串', { kind: 'CREATE_FILE', path: '', newText: 'y' }, 'operations.0.path'],
    ['receiptId 为空串', { kind: 'REPLACE_WHOLE_FILE', path: 'a.ts', receiptId: '', newText: 'y' }, 'operations.0.receiptId'],
  ])('%s → 拒绝', (_label, op, expectedPath) => {
    const r = schema().safeParse({ operations: [op] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain(expectedPath);
  });

  it('newText 允许为空串（清空一段文本是合法意图）', () => {
    const r = schema().safeParse({
      operations: [{ kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'a.ts', receiptId: 'r', oldText: 'x', newText: '' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('workspace_mutate — 执行', () => {
  async function readReceipt(path: string): Promise<string> {
    const res = await tool('fs_read').execute({ path }, makeCtx(ws));
    return res.meta?.receiptId as string;
  }

  it('成功时推进 generation 并如实报告字节增量', async () => {
    const receiptId = await readReceipt('src/app.ts');
    const res = await tool('workspace_mutate').execute(
      {
        operations: [
          { kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'src/app.ts', receiptId, oldText: 'const b = 2;', newText: 'const b = 42;' },
        ],
      },
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect(res.failureReason).toBeUndefined();
    expect(ws.activeGeneration).toBe(1);
    expect(res.modelText).toContain('gen-1');
    expect(res.preview).toContain('修改 src/app.ts (+1 字节)');
    expect(res.meta?.generation).toBe(1);
    expect(ws.readText('src/app.ts')).toContain('const b = 42;');
  });

  it('ZERO_MATCH 时 failureReason 是具体阻断原因，且工作区逐字节不变', async () => {
    const receiptId = await readReceipt('src/app.ts');
    const before = fingerprint();
    const beforeGen = ws.activeGeneration;

    const res = await tool('workspace_mutate').execute(
      {
        operations: [
          // 只差一个空格：不做模糊匹配
          { kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'src/app.ts', receiptId, oldText: 'const b  = 2;', newText: 'x' },
        ],
      },
      makeCtx(ws),
    );

    expect(res.ok).toBe(false);
    // 笼统的 TOOL_ERROR 会让模型无从判断该重读文件还是该换策略
    expect(res.failureReason).toBe('ZERO_MATCH');
    expect(res.meta?.blockReason).toBe('ZERO_MATCH');
    expect(res.modelText).toContain('整笔未生效');
    expect(res.modelText).toContain(`gen-${beforeGen}`);
    expect(ws.activeGeneration).toBe(beforeGen);
    expect(fingerprint()).toBe(before);
  });

  it('批次里第二条非法时，第一条也不能落盘', async () => {
    const receiptId = await readReceipt('src/app.ts');
    const before = fingerprint();

    const res = await tool('workspace_mutate').execute(
      {
        operations: [
          { kind: 'REPLACE_EXACT_TEXT_SPAN', path: 'src/app.ts', receiptId, oldText: 'const a = 1;', newText: 'const a = 100;' },
          { kind: 'CREATE_FILE', path: 'top.ts', newText: 'collision' },
        ],
      },
      makeCtx(ws),
    );

    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('TARGET_EXISTS');
    expect(fingerprint()).toBe(before);
    expect(ws.readText('src/app.ts')).toContain('const a = 1;');
  });

  it('ctx.mutationPolicy 的 protectedPaths 真的生效（不是用默认 policy 跑的）', async () => {
    const receiptId = await readReceipt('src/app.ts');
    const before = fingerprint();

    const res = await tool('workspace_mutate').execute(
      {
        operations: [
          { kind: 'REPLACE_WHOLE_FILE', path: 'src/app.ts', receiptId, newText: 'wiped' },
        ],
      },
      makeCtx(ws, { mutationPolicy: { ...DEFAULT_MUTATION_POLICY, protectedPaths: ['src/**'] } }),
    );

    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('PROTECTED_PATH');
    expect(fingerprint()).toBe(before);
  });

  it('ctx.mutationPolicy 的 allowedPaths 真的生效', async () => {
    const before = fingerprint();
    const res = await tool('workspace_mutate').execute(
      { operations: [{ kind: 'CREATE_FILE', path: 'docs/new.md', newText: 'x' }] },
      makeCtx(ws, { mutationPolicy: { ...DEFAULT_MUTATION_POLICY, allowedPaths: ['src/**'] } }),
    );
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('PATH_NOT_ALLOWED');
    expect(fingerprint()).toBe(before);
  });

  it('伪造的 receiptId 无法写入', async () => {
    const before = fingerprint();
    const res = await tool('workspace_mutate').execute(
      {
        operations: [
          { kind: 'REPLACE_WHOLE_FILE', path: 'src/app.ts', receiptId: 'rcpt_forged', newText: 'pwned' },
        ],
      },
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('RECEIPT_MISSING');
    expect(fingerprint()).toBe(before);
  });

  it('路径逃逸在工具层同样零写入', async () => {
    const before = fingerprint();
    const res = await tool('workspace_mutate').execute(
      { operations: [{ kind: 'CREATE_FILE', path: '../escaped.ts', newText: 'x' }] },
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('PATH_ESCAPE');
    expect(fingerprint()).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe('run_command', () => {
  const NODE = process.execPath;

  it('未登记的 commandId → 列出可用命令，而不是让模型瞎猜', async () => {
    const profile = makeProfile({
      build: cmd([NODE, '-e', '0']),
      test: cmd([NODE, '-e', '0']),
    });
    const res = await tool('run_command').execute({ commandId: 'lint' }, makeCtx(ws, { profile }));
    expect(res.ok).toBe(false);
    // 是"工具用错了"，不是"命令失败了" —— 两者对模型的下一步含义完全不同
    expect(res.failureReason).toBe('TOOL_ERROR');
    expect(res.modelText).toContain('未登记的 commandId: lint');
    expect(res.modelText).toContain('build');
    expect(res.modelText).toContain('test');
  });

  it('profile 一条命令都没有时说明"（无）"，不是空列表', async () => {
    const res = await tool('run_command').execute({ commandId: 'build' }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.modelText).toContain('（无）');
  });

  it('命令跑在工作区当前代里，不是宿主仓库里', async () => {
    // 跑错目录 = 在用户真实仓库上执行构建，这是这层最不能出的错
    const profile = makeProfile({
      probe: cmd([NODE, '-e', 'process.stdout.write(process.cwd())']),
    });
    const res = await tool('run_command').execute({ commandId: 'probe' }, makeCtx(ws, { profile }));
    expect(res.ok).toBe(true);
    const outcome = res.meta?.outcome as CommandOutcome;
    expect(outcome.stdoutPreview.endsWith('gen-0')).toBe(true);
    expect(outcome.stdoutPreview).toContain(ws.runId);
  });

  it('退出码非零 → EXIT_NONZERO，不能和 SPAWN_ERROR 混为一谈', async () => {
    const profile = makeProfile({
      build: cmd([NODE, '-e', 'process.stderr.write("BOOM"); process.exit(3)']),
    });
    const res = await tool('run_command').execute({ commandId: 'build' }, makeCtx(ws, { profile }));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('EXIT_NONZERO');
    expect(res.modelText).toContain('exitCode=3');
    expect(res.modelText).toContain('BOOM');
  });

  it('二进制不存在 → SPAWN_ERROR，与"构建真的失败了"必须可区分', async () => {
    const profile = makeProfile({ build: cmd(['repopilot-no-such-binary-xyz']) });
    const res = await tool('run_command').execute({ commandId: 'build' }, makeCtx(ws, { profile }));
    expect(res.ok).toBe(false);
    // 这两种都会让 passed=false；分不清就等于把"环境坏了"当成"代码坏了"
    expect(res.failureReason).toBe('SPAWN_ERROR');
    expect(res.failureReason).not.toBe('EXIT_NONZERO');
  });

  it('argv 为空 → SPAWN_ERROR 并说明原因', async () => {
    const profile = makeProfile({ build: cmd([]) });
    const res = await tool('run_command').execute({ commandId: 'build' }, makeCtx(ws, { profile }));
    expect(res.failureReason).toBe('SPAWN_ERROR');
    expect((res.meta?.outcome as CommandOutcome).stderrPreview).toContain('argv 为空');
  });

  it('超时 → TIMEOUT，不是 EXIT_ZERO 也不是 CANCELLED', async () => {
    const profile = makeProfile({
      build: cmd([NODE, '-e', 'setTimeout(() => {}, 30000)'], 200),
    });
    const res = await tool('run_command').execute({ commandId: 'build' }, makeCtx(ws, { profile }));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('TIMEOUT');
  });

  it('运行中被取消 → CANCELLED，绝不能被记成成功', async () => {
    const ctrl = new AbortController();
    const profile = makeProfile({
      build: cmd([NODE, '-e', 'setTimeout(() => {}, 30000)'], 30_000),
    });
    const pending = tool('run_command').execute(
      { commandId: 'build' },
      makeCtx(ws, { profile, signal: ctrl.signal }),
    );
    setTimeout(() => ctrl.abort(), 80);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('CANCELLED');
  });

  it('原型链上的名字（constructor）应当被当作未登记，而不是抛异常', async () => {
    // commands 是普通对象字面量，`commands['constructor']` 拿到的是 Object 构造函数，
    // 于是 def 为真、def.argv 为 undefined，解构直接抛，绕过了"可用命令列表"这条路径
    const res = await tool('run_command').execute({ commandId: 'constructor' }, makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.modelText).toContain('未登记的 commandId');
  });
});

// ---------------------------------------------------------------------------

describe('commandOutcomeToTool', () => {
  function outcomeOf(kind: CommandOutcome['outcome'], over: Partial<CommandOutcome> = {}): CommandOutcome {
    return {
      commandId: 'build',
      argv: ['pnpm', 'run', 'build'],
      outcome: kind,
      exitCode: kind === 'EXIT_ZERO' ? 0 : 1,
      signal: null,
      durationMs: 12,
      stdoutPreview: '',
      stderrPreview: '',
      outputTruncated: false,
      ...over,
    };
  }

  it('EXIT_ZERO 才算成功，且不带 failureReason 字段', () => {
    const r = commandOutcomeToTool(outcomeOf('EXIT_ZERO'));
    expect(r.ok).toBe(true);
    expect('failureReason' in r).toBe(false);
  });

  it.each(['EXIT_NONZERO', 'SIGNAL', 'TIMEOUT', 'CANCELLED', 'SPAWN_ERROR'] as const)(
    '%s → ok=false 且 failureReason 逐字对应 outcome',
    (kind) => {
      const r = commandOutcomeToTool(outcomeOf(kind));
      expect(r.ok).toBe(false);
      expect(r.failureReason).toBe(kind);
      expect((r.meta?.outcome as CommandOutcome).outcome).toBe(kind);
    },
  );

  it('stdout/stderr 为空时不产生空的分节标题', () => {
    const r = commandOutcomeToTool(outcomeOf('EXIT_ZERO'));
    expect(r.modelText).toContain('outcome=EXIT_ZERO exitCode=0');
    expect(r.modelText).not.toContain('--- stdout ---');
    expect(r.modelText).not.toContain('--- stderr ---');
  });

  it('exitCode / signal 为 null 时如实写 null，不伪装成 0', () => {
    const r = commandOutcomeToTool(outcomeOf('TIMEOUT', { exitCode: null, signal: null }));
    expect(r.modelText).toContain('exitCode=null');
    expect(r.modelText).toContain('signal=null');
  });

  it('超长输出落 artifact，完整内容可回溯', () => {
    const r = commandOutcomeToTool(outcomeOf('EXIT_NONZERO', { stderrPreview: 'E'.repeat(PREVIEW_MAX_BYTES + 1) }));
    expect(r.previewTruncated).toBe(true);
    expect(r.artifactRef).not.toBeNull();
    expect(artifactText(r.artifactRef)).toContain('E'.repeat(PREVIEW_MAX_BYTES + 1));
    expect(r.failureReason).toBe('EXIT_NONZERO'); // 截断不能把失败原因冲掉
  });
});

// ---------------------------------------------------------------------------

describe('工具注册表', () => {
  it('PLANNING_TOOLS 只含 R0 —— 规划阶段的只读是平台强制的，不靠 prompt 自律', () => {
    // 这里刻意写死名单：新增任何工具都必须显式决定它能不能进规划阶段
    expect(PLANNING_TOOLS.map((t) => t.name).sort()).toEqual(['fs_glob', 'fs_grep', 'fs_list', 'fs_read']);
    expect(PLANNING_TOOLS.every((t) => t.risk === 'R0')).toBe(true);

    const writeTools = TOOLS.filter((t) => t.risk !== 'R0').map((t) => t.name);
    expect(writeTools).toEqual(['workspace_mutate', 'run_command']);
    for (const name of writeTools) {
      expect(PLANNING_TOOLS.map((t) => t.name)).not.toContain(name);
    }
  });

  it('TOOLS_BY_NAME 与 TOOLS 一一对应（重名会静默吞掉一个工具）', () => {
    expect(TOOLS_BY_NAME.size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(TOOLS_BY_NAME.get(t.name)).toBe(t);
  });

  it('每个工具的 jsonSchema.required 都在 zod schema 里真的是必填', () => {
    // 给模型看的 schema 与实际校验的 schema 不一致，模型会反复撞墙
    for (const t of TOOLS) {
      const required = (t.jsonSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        const r = t.schema.safeParse({});
        expect(r.success).toBe(false);
        if (!r.success) {
          expect(r.error.issues.some((i) => i.path[0] === key)).toBe(true);
        }
      }
    }
  });
});
