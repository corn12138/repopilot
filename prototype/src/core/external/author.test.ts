import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTree } from '../workspace';
import { diffTrees, parseAuthorNote, renderCliAuthorPrompt, runExternalCliAuthor } from './author';
import type { ExternalConnectorProfile } from './connector';

/**
 * 外部作者调用的负向断言（真子进程）。
 *
 * 要钉死的只有一件事：**"作者写完了" = 子进程退出 + 平台 tree diff**。
 * 退出非零/超时/取消时 candidate 里写了什么都不被读取（seal=null）；
 * 退出为零时 seal 记录的是目录事实，不是作者的自述。
 */

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 造一个假 CLI。body 在 candidate 目录（cwd）里执行 */
function makeFakeCli(body: string): ExternalConnectorProfile {
  const bin = tempDir('repopilot-fakeauthor-');
  const exe = join(bin, 'fakecli');
  writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  chmodSync(exe, 0o755);
  return {
    connectorId: 'codex-cli',
    kind: 'CODEX_CLI',
    vendor: 'OPENAI',
    label: 'fake',
    state: 'READY',
    form: 'CLI',
    appPath: null,
    binaryPath: exe,
    version: 'fake 1.0',
    identityDigest: 'sha256:fake',
    credentialEnvVar: 'OPENAI_API_KEY',
    authorAdmitted: true,
    detail: 'fake',
    remediation: null,
  };
}

/** 造一个 candidate 目录（模拟 exportCandidate 的产物）并算出 baseTree */
function makeCandidate(files: Record<string, string>) {
  const path = tempDir('repopilot-candidate-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(path, rel, '..'), { recursive: true });
    writeFileSync(join(path, rel), content);
  }
  return { candidateId: 'cand_test', path, baseGeneration: 0, baseTree: listTree(path) };
}

const call = (
  connector: ExternalConnectorProfile,
  candidate: ReturnType<typeof makeCandidate>,
  opts: { apiKey?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) =>
  runExternalCliAuthor({
    connector,
    apiKey: opts.apiKey ?? 'sk-scoped-for-author',
    brief: '任务目标：把 total 改成 2',
    phase: 'IMPLEMENT',
    runId: 'run_x',
    attemptId: 'att_x',
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal ?? new AbortController().signal,
    candidate,
  });

beforeEach(() => {
  process.env.REPOPILOT_SECRET_CANARY = 'canary-must-not-leak';
});
afterEach(() => {
  delete process.env.REPOPILOT_SECRET_CANARY;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('diffTrees / parseAuthorNote / prompt', () => {
  it('diffTrees 区分 MODIFIED / ADDED / DELETED，按路径排序', () => {
    const base = [
      { path: 'a.ts', digest: 'd1', bytes: 1 },
      { path: 'b.ts', digest: 'd2', bytes: 2 },
      { path: 'c.ts', digest: 'd3', bytes: 3 },
    ];
    const now = [
      { path: 'a.ts', digest: 'd1', bytes: 1 },
      { path: 'b.ts', digest: 'dX', bytes: 9 },
      { path: 'd.ts', digest: 'd4', bytes: 4 },
    ];
    expect(diffTrees(base, now)).toEqual([
      { path: 'b.ts', kind: 'MODIFIED', bytes: 9 },
      { path: 'c.ts', kind: 'DELETED', bytes: 0 },
      { path: 'd.ts', kind: 'ADDED', bytes: 4 },
    ]);
  });

  it('parseAuthorNote：解析不出就是 null，解析出来也只是备注', () => {
    expect(parseAuthorNote('done.')).toBeNull();
    expect(parseAuthorNote('{"verdict":"PASS"}')).toBeNull();
    expect(parseAuthorNote('blah ```json\n{"summary":"改了 total","changedFiles":["src/app.ts"]}\n``` ok')).toEqual({
      summary: '改了 total',
      changedFiles: ['src/app.ts'],
      gaveUp: false,
    });
    expect(parseAuthorNote('{"changedFiles":[],"gaveUp":true}')).toEqual({ summary: null, changedFiles: [], gaveUp: true });
  });

  it('prompt 把"平台会重新验证、不要改验证配置"写死在平台侧', () => {
    const p = renderCliAuthorPrompt('brief', 'SELF_FIX');
    expect(p).toContain('自修复');
    expect(p).toContain('平台会在另一个隔离环境里重新跑验证');
    expect(p).toContain('不要运行 git');
  });
});

describe('runExternalCliAuthor：状态 = 退出 + tree diff', () => {
  it('退出为零 → SEALED：seal 记录目录事实；备注只是备注', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'export const total = 1;\n', 'keep.ts': 'x\n' });
    const fake = makeFakeCli(
      [
        'printf "export const total = 2;\\n" > src/app.ts',
        'mkdir -p src/new && printf "new\\n" > src/new/n.ts',
        'rm keep.ts',
        // 作者嘴上说只改了一个文件 —— 平台不信这个，信 diff
        'printf \'{"summary":"只改了 app.ts","changedFiles":["src/app.ts"],"gaveUp":false}\'',
      ].join('\n'),
    );
    const r = await call(fake, candidate);
    expect(r.manifest.state).toBe('SEALED');
    expect(r.manifest.role).toBe('CANDIDATE_AUTHOR');
    expect(r.manifest.phase).toBe('IMPLEMENT');
    expect(r.manifest.changedCount).toBe(3);
    expect(r.seal).not.toBeNull();
    expect(r.seal!.changes).toEqual([
      { path: 'keep.ts', kind: 'DELETED', bytes: 0 },
      { path: 'src/app.ts', kind: 'MODIFIED', bytes: 24 },
      { path: 'src/new/n.ts', kind: 'ADDED', bytes: 4 },
    ]);
    expect(r.seal!.authorNote).toEqual({ summary: '只改了 app.ts', changedFiles: ['src/app.ts'], gaveUp: false });
    expect(r.seal!.baseGeneration).toBe(0);
  });

  it('退出非零 → FAILED：candidate 里写了什么都不读（seal=null，changedCount=null）', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'export const total = 1;\n' });
    const fake = makeFakeCli('printf "export const total = 2;\\n" > src/app.ts\necho boom >&2\nexit 7');
    const r = await call(fake, candidate);
    expect(r.manifest.state).toBe('FAILED');
    expect(r.manifest.exitCode).toBe(7);
    expect(r.manifest.failureDetail).toContain('整笔丢弃');
    expect(r.manifest.changedCount).toBeNull();
    expect(r.seal).toBeNull();
    // 目录确实被改了 —— 但平台不看；这是调用方 discardCandidate 的活
    expect(readFileSync(join(candidate.path, 'src/app.ts'), 'utf8')).toBe('export const total = 2;\n');
  });

  it('超时 → TIMED_OUT，seal=null；进程组被整树终止', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'x\n' });
    const marker = join(candidate.path, 'still-running');
    const fake = makeFakeCli(`printf "y\\n" > src/app.ts\nsleep 30\ntouch "${marker}"`);
    const t0 = Date.now();
    const r = await call(fake, candidate, { timeoutMs: 1_200 });
    expect(r.manifest.state).toBe('TIMED_OUT');
    expect(r.seal).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(marker)).toBe(false);
  });

  it('取消 → CANCELLED，seal=null', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'x\n' });
    const fake = makeFakeCli('sleep 30');
    const ac = new AbortController();
    const p = call(fake, candidate, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.manifest.state).toBe('CANCELLED');
    expect(r.seal).toBeNull();
  });

  it('PREFLIGHT：连接器非 READY 或缺 Key → BLOCKED，根本不起进程', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'x\n' });
    const marker = join(candidate.path, 'ran');
    const fake = makeFakeCli(`touch "${marker}"`);
    const blocked = await call({ ...fake, state: 'BLOCKED', binaryPath: null }, candidate);
    expect(blocked.manifest.state).toBe('BLOCKED');
    const noKey = await call(fake, candidate, { apiKey: '   ' });
    expect(noKey.manifest.state).toBe('BLOCKED');
    expect(noKey.manifest.failureDetail).toContain('OPENAI_API_KEY');
    expect(existsSync(marker)).toBe(false);
  });

  it('隔离：cwd 是 candidate 目录，HOME 是一次性目录，只注入一个凭据变量，宿主 canary 不可见', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'x\n' });
    const fake = makeFakeCli(
      [
        'printf "%s" "$PWD" > cwd.txt',
        'printf "%s" "$HOME" > home.txt',
        'env | sort > env.txt',
      ].join('\n'),
    );
    const r = await call(fake, candidate, { apiKey: 'sk-only-this' });
    expect(r.manifest.state).toBe('SEALED');
    const cwd = readFileSync(join(candidate.path, 'cwd.txt'), 'utf8');
    const home = readFileSync(join(candidate.path, 'home.txt'), 'utf8');
    const env = readFileSync(join(candidate.path, 'env.txt'), 'utf8');
    // macOS /private 前缀：用 endsWith 比较
    expect(candidate.path.endsWith(cwd.replace(/^\/private/, '')) || cwd.endsWith(candidate.path.replace(/^\/private/, ''))).toBe(true);
    expect(home).toContain('repopilot-xauthor-');
    expect(home).not.toBe(process.env.HOME);
    expect(env).toContain('OPENAI_API_KEY=sk-only-this');
    expect(env).not.toContain('canary-must-not-leak');
    expect(env).not.toContain('ANTHROPIC_API_KEY');
    // 三个探针文件本身也出现在 seal 里：事实来自目录，不来自作者
    expect(r.seal!.changes.map((c) => c.path)).toEqual(['cwd.txt', 'env.txt', 'home.txt']);
  });
});

describe('runExternalCliAuthor：简报 DLP（与 ModelGateway 同一道）', () => {
  it('简报里有高置信度凭据 → BLOCKED(DLP)，子进程根本没起；原因不含原文', async () => {
    const candidate = makeCandidate({ 'src/app.ts': 'x\n' });
    const marker = join(candidate.path, 'ran');
    const fake = makeFakeCli(`touch "${marker}"`);
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const r = await runExternalCliAuthor({
      connector: fake,
      apiKey: 'sk-scoped',
      brief: `任务目标：把 key ${secret} 换掉`,
      phase: 'IMPLEMENT',
      runId: 'run_x',
      attemptId: 'att_x',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      candidate,
    });
    expect(r.manifest.state).toBe('BLOCKED');
    expect(r.manifest.failureDetail).toContain('DLP: AWS_ACCESS_KEY_ID');
    expect(r.manifest.failureDetail).toContain('author-brief:IMPLEMENT');
    expect(r.manifest.failureDetail).not.toContain(secret);
    expect(existsSync(marker)).toBe(false);
    expect(r.seal).toBeNull();
  });
});

describe('作者角色的准入闸门：只准入审核方的连接器不许写代码', () => {
  /**
   * 分阶段准入的执行面。一个连接器可以只以**只读审核方**身份进来 ——
   * 那条路上 cwd 是空目录、产出只有一段 JSON，"它能不能写文件"不影响结果。
   * 作者角色不一样：它在 candidate 目录里真的改代码，「工具白名单能不能压住
   * shell」是安全边界，必须有实测证据。
   *
   * 闸门放在 author.ts 而不只在 authority：这里是**所有**作者调用的必经之路，
   * 挡在这里才不依赖上游每个调用点都记得查。
   */
  it('authorArgv 为 null → BLOCKED，且一个子进程都不起', async () => {
    const candidate = makeCandidate({ 'src/a.ts': 'export const total = 1;\n' });
    const before = listTree(candidate.path);

    // 用真实的 opencode-deepseek 描述符：它只准入了审核方角色
    const res = await call(
      {
        connectorId: 'opencode-deepseek',
        kind: 'CODEX_CLI', // kind 与本用例无关；连接器身份由 connectorId 决定
        vendor: 'DEEPSEEK',
        label: 'OpenCode · DeepSeek',
        state: 'READY',
        form: 'CLI',
        appPath: null,
        // 指向一个必然会改文件的假 CLI：真起了进程就会被下面的 tree 断言抓到
        binaryPath: '/bin/sh',
        version: 'x',
        identityDigest: 'sha256:x',
        credentialEnvVar: 'DEEPSEEK_API_KEY',
        authorAdmitted: false,
        detail: '',
        remediation: null,
      },
      candidate,
    );

    expect(res.manifest.state).toBe('BLOCKED');
    expect(res.manifest.failureDetail).toContain('尚未以作者身份准入');
    expect(res.seal).toBeNull();
    // 没跑过任何东西：candidate 目录逐字节不变
    expect(listTree(candidate.path)).toEqual(before);
    // 拒绝发生在起进程之前，所以没有退出码可记
    expect(res.manifest.exitCode).toBeNull();
  });
})
