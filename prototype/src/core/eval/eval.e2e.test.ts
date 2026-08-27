import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 与 authority.e2e 同一手法：受管数据根重定向到进程私有临时目录
vi.mock('../paths', async () => {
  const { mkdtempSync: mkTemp, mkdirSync: mkDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkTemp(j(tmp(), 'repopilot-eval-e2e-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
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

import { DATA_ROOT } from '../paths';
import { loadEvalCase, loadEvalCases } from './cases';
import { MACHINE_PASS_REASONS, classifyObservation } from './judge';
import { EvalHarnessError, runObservation, type EvalObservation } from './runner';
import { appendObservation, readObservations, resultsPath } from './results';
import { buildAbReport, buildBlindPacket } from './report';

/**
 * SPK-010 harness 端到端：真权威层（真 gateway/preflight/命令执行/落盘），
 * 模型在 HTTP 层脚本化。锁的是实验设计 §5 的五条 harness 纪律 ——
 * 隔离强制、fresh authority、臂完整性 fail-closed、密封可校验、盲包不破盲；
 * 以及 SPK-010 收口：case 范围合同、Runner 不放宽、假绿不计分、reason 可对账。
 */

const CASES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'eval-cases');
const IMPL = 'api.deepseek.com';
const REVIEWER = 'api.moonshot.cn';
const ROUTES_B = { implementerProfileId: 'profile_deepseek', reviewerProfileId: 'profile_moonshot-cn' } as const;
const ROUTES_A = { implementerProfileId: 'profile_deepseek', reviewerProfileId: null } as const;

// ---- OpenAI-wire 脚本 ----
let callSeq = 0;
const USAGE = { prompt_tokens: 120, completion_tokens: 45 };
type Responder = (bodyText: string) => unknown;

function oaToolCall(name: string, input: unknown): unknown {
  callSeq += 1;
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: `call_${name}_${callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: USAGE,
  };
}
const oaText = (text: string): unknown => ({
  choices: [{ message: { content: text }, finish_reason: 'stop' }],
  usage: USAGE,
});

function lastReceipt(bodyText: string): string {
  const matches = [...bodyText.matchAll(/receiptId=(rcpt_[a-z0-9]+)/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) throw new Error('脚本期望上下文里有 receiptId');
  return last;
}

/** 实现方脚本：规划 → 读 → 整文件替换 → 收尾 */
function implementerScript(file: string, fixedText: string): Responder[] {
  return [
    () =>
      oaToolCall('submit_plan', {
        summary: `修复 ${file}`,
        steps: [{ intent: `修改 ${file}`, targetPaths: [file], expectedEffect: '验证命令退出 0' }],
        risks: [],
      }),
    () => oaToolCall('fs_read', { path: file }),
    (body) =>
      oaToolCall('workspace_mutate', {
        operations: [{ kind: 'REPLACE_WHOLE_FILE', path: file, receiptId: lastReceipt(body), newText: fixedText }],
      }),
    () => oaText('修复完成。'),
  ];
}
// 工厂而不是共享常量：fetch 处理器用 shift() 消费队列，共享数组会被第一次观察掏空
const reviewerPass = (): Responder[] => [() => oaToolCall('submit_review', { verdict: 'PASS', findings: [] })];

const FIX: Record<string, { file: string; text: string }> = {
  'case-001-status-flag': { file: 'src/app.js', text: "export const STATUS = 'fixed';\n" },
  'case-002-rate-constant': { file: 'src/util.js', text: 'export const rate = 0.2;\n' },
};

const queues = new Map<string, Responder[]>();
function script(host: string, responders: Responder[]): void {
  queues.set(host, responders);
}

const tempDirs = new Set<string>();

/** 从受管数据根读回某 Run 的事件流（mock 的 ../paths 把它指到进程私有临时目录） */
function readRunEvents(runId: string): { kind: string; summary: string; payload: Record<string, unknown> }[] {
  const file = join(DATA_ROOT, 'runs', runId, 'events.jsonl');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; summary: string; payload: Record<string, unknown> });
}

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-eval-implementer';
  process.env.MOONSHOT_API_KEY = 'sk-eval-reviewer';
  // 隔离守卫看的是环境变量；paths 已被 mock，这里把两者指到同一个地方
  process.env.REPOPILOT_DATA_ROOT = DATA_ROOT;
  queues.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const queue = queues.get(host);
      const bodyText = String(init?.body ?? '');
      if (!queue || queue.length === 0) throw new Error(`${host} 的模型脚本已耗尽：${bodyText.slice(-300)}`);
      return new Response(JSON.stringify(queue.shift()!(bodyText)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.REPOPILOT_DATA_ROOT;
  vi.unstubAllGlobals();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.clear();
});

// ---- 合成 case 夹具 ----

const SYN_SPEC_BASE = {
  caseId: 'syn-scope',
  title: '范围合同测试',
  goal: 'g',
  acceptance: [],
  commands: [{ label: 'node check.mjs', argv: ['node', 'check.mjs'] }],
};
const SYN_FILES_BASE: Record<string, string> = {
  'check.mjs':
    "import { readFileSync } from 'node:fs';\n" +
    "const s = readFileSync('src/app.js', 'utf8');\n" +
    "if (!s.includes('fixed')) { console.error('still broken'); process.exit(1); }\n" +
    "console.log('ok');\n",
  'src/app.js': "export const STATUS = 'broken';\n",
};

function writeSyntheticCase(dir: string, spec: Record<string, unknown>, files: Record<string, string> = SYN_FILES_BASE): void {
  mkdirSync(join(dir, 'repo'), { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify(spec));
  for (const [rel, content] of Object.entries(files)) {
    const f = join(dir, 'repo', rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
}

const synCase = (allowedPaths: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...SYN_SPEC_BASE,
  ...extra,
  allowedPaths,
});

describe('EvalCase 加载：内容寻址，fail-closed', () => {
  it('seed 两个 case 可加载，digest 互异且对内容敏感', () => {
    const cases = loadEvalCases(CASES_ROOT);
    expect(cases.map((c) => c.caseId)).toEqual(['case-001-status-flag', 'case-002-rate-constant']);
    expect(cases[0]!.caseDigest).not.toBe(cases[1]!.caseDigest);

    // 改模板一个字节 → 另一个 case
    const copy = mkdtempSync(join(tmpdir(), 'eval-case-copy-'));
    tempDirs.add(copy);
    cpSync(cases[0]!.dir, copy, { recursive: true });
    const before = loadEvalCase(copy).caseDigest;
    writeFileSync(join(copy, 'repo', 'src', 'app.js'), "export const STATUS = 'broken!!';\n");
    expect(loadEvalCase(copy).caseDigest).not.toBe(before);
  });

  it('缺 case.json / 空 commands / 模板带 node_modules → 拒绝加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-case-bad-'));
    tempDirs.add(dir);
    expect(() => loadEvalCase(dir)).toThrow(/case\.json/);

    mkdirSync(join(dir, 'repo'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'a.js'), 'x');
    writeFileSync(
      join(dir, 'case.json'),
      JSON.stringify({ caseId: 'x', title: 't', goal: 'g', acceptance: [], commands: [] }),
    );
    expect(() => loadEvalCase(dir)).toThrow(/至少有一条验证命令/);

    writeFileSync(
      join(dir, 'case.json'),
      JSON.stringify({ caseId: 'x', title: 't', goal: 'g', acceptance: [], commands: [{ label: 'c', argv: ['node'] }] }),
    );
    mkdirSync(join(dir, 'repo', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'node_modules', 'x.js'), 'x');
    expect(() => loadEvalCase(dir)).toThrow(/node_modules/);
  });
});

describe('EvalCase allowedPaths：必填范围合同，fail-closed', () => {
  it('两个 seed 的范围分别钉死为 src/app.js 与 src/util.js', () => {
    const cases = loadEvalCases(CASES_ROOT);
    expect(cases[0]!.allowedPaths).toEqual(['src/app.js']);
    expect(cases[1]!.allowedPaths).toEqual(['src/util.js']);
  });

  it.each([
    ['字段缺失', { ...SYN_SPEC_BASE }, /allowedPaths 必须是非空数组/],
    ['不是数组', synCase('src/app.js'), /allowedPaths 必须是非空数组/],
    ['空数组', synCase([]), /allowedPaths 必须是非空数组/],
    ['空字符串项', synCase(['']), /必须是非空字符串/],
    ['非字符串项', synCase([42]), /必须是非空字符串/],
    ['重复项', synCase(['src/app.js', 'src/app.js']), /重复/],
    ['绝对路径', synCase(['/src/app.js']), /绝对路径/],
    ['盘符路径', synCase(['C:/src/app.js']), /盘符/],
    ['父目录段', synCase(['../evil.js']), /父目录/],
    ['反斜线', synCase(['src\\app.js']), /反斜线/],
    ['NUL 字节', synCase(['src/app.js\u0000']), /NUL/],
    ['空路径段', synCase(['src//app.js']), /空路径段/],
    ['结尾斜杠', synCase(['src/app.js/']), /空路径段/],
    ['当前目录段', synCase(['.']), /当前目录/],
    ['全仓 catch-all', synCase(['**']), /全仓 catch-all/],
    ['全仓 catch-all 变体', synCase(['**/**']), /全仓 catch-all/],
    ['直接点名验证脚本', synCase(['check.mjs']), /验证输入/],
    ['顶层 glob 覆盖验证脚本', synCase(['*.mjs']), /验证输入/],
    ['任意层 glob 覆盖验证脚本', synCase(['**/*.mjs']), /验证输入/],
  ])('%s → 拒绝加载（不修正、不放宽）', (_label, spec, re) => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-scope-bad-'));
    tempDirs.add(dir);
    writeSyntheticCase(dir, spec);
    expect(() => loadEvalCase(dir)).toThrow(re);
  });

  it('目录级 glob 覆盖测试夹具（按模式命中的验证输入）→ 拒绝加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-scope-tests-'));
    tempDirs.add(dir);
    writeSyntheticCase(dir, synCase(['tests/**']), {
      ...SYN_FILES_BASE,
      'tests/fixture.json': '{}',
    });
    expect(() => loadEvalCase(dir)).toThrow(/验证输入/);
  });

  it.each([
    ['单文件', ['src/app.js']],
    ['目录 glob', ['src/**']],
    ['深层 glob', ['src/features/search/**']],
    ['顶层 glob 但不碰验证输入', ['*.json']],
    ['多项', ['src/app.js', 'src/util.js']],
  ])('合法范围 %s → 加载并原样保留', (_label, allowedPaths) => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-scope-ok-'));
    tempDirs.add(dir);
    writeSyntheticCase(dir, synCase(allowedPaths));
    expect(loadEvalCase(dir).allowedPaths).toEqual(allowedPaths);
  });

  it('只改变 allowedPaths 会改变 case digest；改回来 digest 复原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-scope-digest-'));
    tempDirs.add(dir);
    writeSyntheticCase(dir, synCase(['src/app.js']));
    const d1 = loadEvalCase(dir).caseDigest;

    writeSyntheticCase(dir, synCase(['src/**']));
    expect(loadEvalCase(dir).caseDigest).not.toBe(d1);

    writeSyntheticCase(dir, synCase(['src/app.js']));
    expect(loadEvalCase(dir).caseDigest).toBe(d1);
  });
});

describe('harness 纪律', () => {
  it('未设 REPOPILOT_DATA_ROOT → 拒跑（隔离强制）', async () => {
    delete process.env.REPOPILOT_DATA_ROOT;
    const c = loadEvalCases(CASES_ROOT)[0]!;
    await expect(runObservation({ evalCase: c, arm: 'SINGLE_WRITER', routes: ROUTES_A })).rejects.toMatchObject({
      code: 'DATA_ROOT_NOT_ISOLATED',
    });
  });

  it('臂完整性 fail-closed：B 臂审核方缺凭据会被披露降级 → 观察作废，不密封成 B 臂结果', async () => {
    delete process.env.MOONSHOT_API_KEY;
    const c = loadEvalCases(CASES_ROOT)[0]!;
    await expect(runObservation({ evalCase: c, arm: 'CROSS_REVIEW', routes: ROUTES_B })).rejects.toMatchObject({
      code: 'ARM_INTEGRITY',
    });
  });

  it('臂配置自检：A 臂带审核方 / B 臂缺审核方都是配置错误', async () => {
    const c = loadEvalCases(CASES_ROOT)[0]!;
    await expect(
      runObservation({ evalCase: c, arm: 'SINGLE_WRITER', routes: ROUTES_B }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' });
    await expect(
      runObservation({ evalCase: c, arm: 'CROSS_REVIEW', routes: ROUTES_A }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' });
  });
});

describe('Runner 不放宽范围：task.create 拿到的是 case 合同的逐字 scope', () => {
  it(
    '候选试图改 check.mjs 被 PATH_NOT_ALLOWED 整笔阻断（零写入），回头改 src/app.js 仍可完成且计 machine pass',
    async () => {
      const c = loadEvalCases(CASES_ROOT)[0]!;
      // 被阻断后模型必须继续用工具调用自救 —— 纯文本回复会被平台当作"模型结束执行"
      script(IMPL, [
        () =>
          oaToolCall('submit_plan', {
            summary: '改 check.mjs 让它直接通过',
            steps: [{ intent: '修改 check.mjs', targetPaths: ['check.mjs'], expectedEffect: '验证命令退出 0' }],
            risks: [],
          }),
        () => oaToolCall('fs_read', { path: 'check.mjs' }),
        (body) =>
          oaToolCall('workspace_mutate', {
            operations: [{ kind: 'REPLACE_WHOLE_FILE', path: 'check.mjs', receiptId: lastReceipt(body), newText: 'console.log("ok");\n' }],
          }),
        () => oaToolCall('fs_read', { path: 'src/app.js' }),
        (body) =>
          oaToolCall('workspace_mutate', {
            operations: [{ kind: 'REPLACE_WHOLE_FILE', path: 'src/app.js', receiptId: lastReceipt(body), newText: FIX[c.caseId]!.text }],
          }),
        () => oaText('修复完成。'),
      ]);
      const o = await runObservation({ evalCase: c, arm: 'SINGLE_WRITER', routes: ROUTES_A, phaseTimeoutMs: 30_000 });

      // 平台事实：check.mjs 的 mutation 被整笔阻断，工作区零写入；最终只有 src/app.js 进补丁
      const events = readRunEvents(o.runId);
      const blocks = events.filter(
        (e) => e.kind === 'TOOL_CALL_RESOLVED' && e.payload?.resolution === 'FAILED' && e.payload?.reason === 'PATH_NOT_ALLOWED',
      );
      expect(blocks).toHaveLength(1);
      const applied = events.filter((e) => e.kind === 'MUTATION_APPLIED');
      expect(applied).toHaveLength(1);
      expect(o.status).toBe('AWAITING_PATCH_REVIEW');
      expect(o.patch).not.toBeNull();
      expect(o.patch!.unifiedDiff).toContain('src/app.js');
      expect(o.patch!.unifiedDiff).not.toContain('check.mjs');
      expect(o.verificationInputsTouched).toEqual([]);
      expect(classifyObservation(o, true).pass).toBe(true);
    },
    60_000,
  );

  it(
    '候选只改 check.mjs：零 MUTATION_APPLIED、无封存补丁、不跑终验 —— 假绿链路封死，不计 machine pass',
    async () => {
      const c = loadEvalCases(CASES_ROOT)[0]!;
      script(IMPL, [
        () =>
          oaToolCall('submit_plan', {
            summary: '改 check.mjs 让它直接通过',
            steps: [{ intent: '修改 check.mjs', targetPaths: ['check.mjs'], expectedEffect: '验证命令退出 0' }],
            risks: [],
          }),
        () => oaToolCall('fs_read', { path: 'check.mjs' }),
        (body) =>
          oaToolCall('workspace_mutate', {
            operations: [{ kind: 'REPLACE_WHOLE_FILE', path: 'check.mjs', receiptId: lastReceipt(body), newText: 'console.log("ok");\n' }],
          }),
        () => oaText('修复完成。'),
      ]);
      const o = await runObservation({ evalCase: c, arm: 'SINGLE_WRITER', routes: ROUTES_A, phaseTimeoutMs: 30_000 });

      const events = readRunEvents(o.runId);
      expect(events.some((e) => e.kind === 'MUTATION_APPLIED')).toBe(false);
      expect(
        events.some((e) => e.kind === 'TOOL_CALL_RESOLVED' && e.payload?.reason === 'PATH_NOT_ALLOWED'),
      ).toBe(true);
      // 工作区零改动 → 平台按 NO_CHANGES 收场：没有补丁、也不跑 POST_MUTATION
      expect(o.patch).toBeNull();
      expect(o.verificationInputsTouched).toBeNull();
      const v = classifyObservation(o, true);
      expect(v.pass).toBe(false);
      expect(v.reason).toBe('POST_MUTATION_MISSING');
      // 模板本身没有被候选碰到
      expect(readFileSync(join(CASES_ROOT, c.caseId, 'repo', 'check.mjs'), 'utf8')).toContain('still broken');
    },
    60_000,
  );
});

describe('machine pass 判定：fail-closed，reason 稳定可对账', () => {
  /** 全绿 observation（v2、证据完整）—— 每个负向用例只改一个维度 */
  const validObservation = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 2,
    caseId: 'case-x',
    caseDigest: 'sha256:aaa',
    arm: 'SINGLE_WRITER',
    routes: { implementerProfileId: 'p1', reviewerProfileId: null },
    runId: 'run_x',
    status: 'AWAITING_PATCH_REVIEW',
    failureClass: null,
    verificationRuns: [
      { phase: 'BASELINE', passed: false },
      { phase: 'POST_MUTATION', passed: true },
    ],
    finalVerificationPassed: true,
    patch: { digest: 'sha256:bbb', files: 1, addedLines: 1, removedLines: 0, unifiedDiff: 'diff --git a/x b/x' },
    verificationInputsTouched: [],
    crossReview: null,
    ledger: { inputTokens: 10, outputTokens: 5, unknownUsageTurns: 0 },
    autoApprovals: 1,
    disclosureDigest: 'sha256:ccc',
    wallClockMs: 123,
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    digest: 'sha256:ddd',
    ...overrides,
  });

  it('全绿 → pass，无 reason', () => {
    expect(classifyObservation(validObservation(), true)).toEqual({ pass: true, reason: null });
  });

  it('内容全对但 digest 损坏 → RESULT_DIGEST_INVALID，且压过一切其他理由', () => {
    expect(classifyObservation(validObservation(), false)).toEqual({ pass: false, reason: 'RESULT_DIGEST_INVALID' });
    expect(classifyObservation(validObservation({ status: 'SUCCEEDED' }), false)).toEqual({
      pass: false,
      reason: 'RESULT_DIGEST_INVALID',
    });
  });

  it.each([
    ['v1 旧版', { schemaVersion: 1 }, 'OBSERVATION_SCHEMA_LEGACY'],
    ['v0 旧版', { schemaVersion: 0 }, 'OBSERVATION_SCHEMA_LEGACY'],
    ['缺 schemaVersion', { schemaVersion: undefined }, 'OBSERVATION_SCHEMA_LEGACY'],
    ['schemaVersion 是字符串', { schemaVersion: '2' }, 'OBSERVATION_SCHEMA_LEGACY'],
    ['非整数版本', { schemaVersion: 2.5 }, 'OBSERVATION_SCHEMA_LEGACY'],
    ['更新的未知版', { schemaVersion: 3 }, 'OBSERVATION_SCHEMA_UNKNOWN'],
    ['未来大版本', { schemaVersion: 99 }, 'OBSERVATION_SCHEMA_UNKNOWN'],
  ])('%s → %s', (_label, overrides, reason) => {
    expect(classifyObservation(validObservation(overrides), true)).toEqual({ pass: false, reason });
  });

  it.each([
    ['缺 verificationRuns', { verificationRuns: undefined }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['verificationRuns 不是数组', { verificationRuns: {} }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['verificationRuns 条目缺 passed', { verificationRuns: [{ phase: 'BASELINE' }] }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['缺 status', { status: undefined }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['patch 非对象', { patch: 'x' }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['patch 缺 digest', { patch: { files: 1, addedLines: 1, removedLines: 0, unifiedDiff: 'd' } }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['有 patch 但 touched 为 null', { verificationInputsTouched: null }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['有 patch 但 touched 缺失', { verificationInputsTouched: undefined }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['touched 含非字符串', { verificationInputsTouched: [1] }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['arm 非法', { arm: 'SOLO' }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['routes 非对象', { routes: null }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['ledger 缺失', { ledger: undefined }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
    ['autoApprovals 非数字', { autoApprovals: '1' }, 'OBSERVATION_EVIDENCE_INCOMPLETE'],
  ])('v2 但证据不足：%s → %s', (_label, overrides, reason) => {
    expect(classifyObservation(validObservation(overrides), true)).toEqual({ pass: false, reason });
  });

  it.each([
    ['没有 BASELINE', { verificationRuns: [{ phase: 'POST_MUTATION', passed: true }] }, 'BASELINE_MISSING'],
    ['BASELINE 本来就绿', { verificationRuns: [{ phase: 'BASELINE', passed: true }, { phase: 'POST_MUTATION', passed: true }] }, 'BASELINE_NOT_FAILED'],
    ['没有 POST_MUTATION', { verificationRuns: [{ phase: 'BASELINE', passed: false }] }, 'POST_MUTATION_MISSING'],
    [
      '最后一次 POST_MUTATION 失败',
      { verificationRuns: [{ phase: 'BASELINE', passed: false }, { phase: 'POST_MUTATION', passed: false }] },
      'POST_MUTATION_FAILED',
    ],
    [
      '倒数第二次失败、最后一次通过 → 通过（看最后一次）',
      {
        verificationRuns: [
          { phase: 'BASELINE', passed: false },
          { phase: 'POST_MUTATION', passed: false },
          { phase: 'POST_MUTATION', passed: true },
        ],
      },
      null,
    ],
    ['没有封存补丁', { patch: null, verificationInputsTouched: null }, 'PATCH_MISSING'],
    ['补丁碰了验证输入（改 check.mjs 骗绿）', { verificationInputsTouched: ['check.mjs'] }, 'VERIFICATION_INPUTS_TOUCHED'],
    ['Run 停在 FAILED', { status: 'FAILED' }, 'RUN_STATUS_INELIGIBLE'],
    ['Run 停在 SUCCEEDED', { status: 'SUCCEEDED' }, 'RUN_STATUS_INELIGIBLE'],
  ])('%s → %s', (_label, overrides, reason) => {
    const v = classifyObservation(validObservation(overrides), true);
    expect(v.pass).toBe(reason === null);
    expect(v.reason).toBe(reason);
  });

  it('固定优先级：同时违反多条时只计最高优先级那一个', () => {
    // 无 BASELINE + 终验失败 + 无补丁 + 碰了验证输入 + 状态不对 → BASELINE_MISSING
    const worst = validObservation({
      verificationRuns: [{ phase: 'POST_MUTATION', passed: false }],
      patch: null,
      verificationInputsTouched: null,
      status: 'FAILED',
    });
    expect(classifyObservation(worst, true).reason).toBe('BASELINE_MISSING');
    // 终验失败 + 无补丁 + 状态不对 → POST_MUTATION_FAILED（先于 PATCH_MISSING / RUN_STATUS_INELIGIBLE）
    expect(
      classifyObservation(
        validObservation({ verificationRuns: [{ phase: 'BASELINE', passed: false }, { phase: 'POST_MUTATION', passed: false }], patch: null, verificationInputsTouched: null, status: 'FAILED' }),
        true,
      ).reason,
    ).toBe('POST_MUTATION_FAILED');
    // 有补丁但碰了验证输入 + 状态不对 → VERIFICATION_INPUTS_TOUCHED（先于 RUN_STATUS_INELIGIBLE）
    expect(classifyObservation(validObservation({ verificationInputsTouched: ['check.mjs'], status: 'FAILED' }), true).reason).toBe(
      'VERIFICATION_INPUTS_TOUCHED',
    );
  });

  it('reason 计数守恒：各 reason 之和 + 通过数 = 输入总数，不漏不重', () => {
    const items: { rec: Record<string, unknown>; digestValid: boolean }[] = [
      { rec: validObservation(), digestValid: true }, // pass
      { rec: validObservation({ status: 'SUCCEEDED' }), digestValid: true }, // RUN_STATUS_INELIGIBLE
      { rec: validObservation({ verificationInputsTouched: ['check.mjs'] }), digestValid: true }, // VERIFICATION_INPUTS_TOUCHED
      { rec: validObservation({ patch: null, verificationInputsTouched: null }), digestValid: true }, // PATCH_MISSING
      { rec: validObservation({ verificationRuns: [{ phase: 'BASELINE', passed: false }, { phase: 'POST_MUTATION', passed: false }] }), digestValid: true }, // POST_MUTATION_FAILED
      { rec: validObservation({ verificationRuns: [{ phase: 'POST_MUTATION', passed: true }] }), digestValid: true }, // BASELINE_MISSING
      { rec: validObservation({ schemaVersion: 1 }), digestValid: true }, // LEGACY
      { rec: validObservation({ schemaVersion: 3 }), digestValid: true }, // UNKNOWN
      { rec: validObservation({ verificationRuns: undefined }), digestValid: true }, // EVIDENCE_INCOMPLETE
      { rec: validObservation({ verificationRuns: [{ phase: 'BASELINE', passed: true }, { phase: 'POST_MUTATION', passed: true }] }), digestValid: true }, // BASELINE_NOT_FAILED
      { rec: validObservation({ verificationRuns: [{ phase: 'BASELINE', passed: false }] }), digestValid: true }, // POST_MUTATION_MISSING
      { rec: validObservation(), digestValid: false }, // RESULT_DIGEST_INVALID
      { rec: validObservation(), digestValid: true }, // pass
    ];
    const verdicts = items.map((i) => classifyObservation(i.rec, i.digestValid));
    const passed = verdicts.filter((v) => v.pass).length;
    const reasonCounts = new Map<string, number>();
    for (const v of verdicts) {
      if (v.reason) reasonCounts.set(v.reason, (reasonCounts.get(v.reason) ?? 0) + 1);
    }
    expect(passed).toBe(2);
    for (const r of MACHINE_PASS_REASONS) expect(reasonCounts.get(r) ?? 0).toBe(1); // 11 个 reason 各一次
    expect(passed + [...reasonCounts.values()].reduce((a, b) => a + b, 0)).toBe(items.length);
    // 每个 reason 名称都在稳定合同里，没有拼写漂移
    expect([...reasonCounts.keys()].every((r) => (MACHINE_PASS_REASONS as readonly string[]).includes(r))).toBe(true);
  });
});

describe('2 case × 2 臂 端到端', () => {
  it(
    '四个观察密封落盘；B 臂有审核事实且已证异构；报告成对；盲包不破盲；篡改可检出；假绿不计分',
    async () => {
      const cases = loadEvalCases(CASES_ROOT);
      const outDir = mkdtempSync(join(tmpdir(), 'eval-out-'));
      tempDirs.add(outDir);
      const observations: EvalObservation[] = [];

      for (const c of cases) {
        const fix = FIX[c.caseId]!;
        // Arm A：单写
        script(IMPL, implementerScript(fix.file, fix.text));
        const a = await runObservation({ evalCase: c, arm: 'SINGLE_WRITER', routes: ROUTES_A, phaseTimeoutMs: 30_000 });
        // Arm B：一写一审（审核方一轮 PASS）
        script(IMPL, implementerScript(fix.file, fix.text));
        script(REVIEWER, reviewerPass());
        const b = await runObservation({ evalCase: c, arm: 'CROSS_REVIEW', routes: ROUTES_B, phaseTimeoutMs: 30_000 });
        observations.push(a, b);
        appendObservation(outDir, a);
        appendObservation(outDir, b);
      }

      // ---- 观察本体 ----
      expect(observations).toHaveLength(4);
      for (const o of observations) {
        expect(o.schemaVersion).toBe(2);
        expect(o.status).toBe('AWAITING_PATCH_REVIEW'); // 度量止于人工审查点，补丁接受不发生
        expect(o.finalVerificationPassed).toBe(true); // node check.mjs 真的跑过且退出 0
        expect(o.patch).not.toBeNull();
        expect(o.verificationInputsTouched).toEqual([]); // 只改业务源码，没碰验证输入
        expect(o.autoApprovals).toBe(1); // 计划自动批准如实记录
        expect(o.ledger.inputTokens).toBeGreaterThan(0);
        // 每条观察单独过 fail-closed 判定
        expect(classifyObservation(o, true)).toEqual({ pass: true, reason: null });
      }
      const armA = observations.filter((o) => o.arm === 'SINGLE_WRITER');
      const armB = observations.filter((o) => o.arm === 'CROSS_REVIEW');
      for (const o of armA) expect(o.crossReview).toBeNull();
      for (const o of armB) {
        expect(o.crossReview).not.toBeNull();
        expect(o.crossReview!.parity).toBe('HETEROGENEOUS'); // deepseek 写、moonshot 审：两侧厂商都有证据
        expect(o.crossReview!.verdicts.PASS).toBe(1);
        expect(o.crossReview!.stopReason).toBe('REVIEWER_PASSED');
      }
      // fresh authority：四个观察四个不同 Run
      expect(new Set(observations.map((o) => o.runId)).size).toBe(4);

      // ---- 密封回读与篡改检出 ----
      const clean = readObservations(outDir);
      expect(clean.observations).toHaveLength(4);
      expect(clean.digestMismatches).toBe(0);
      const tampered = { ...observations[0]!, status: 'SUCCEEDED' }; // 改内容不改 digest
      appendFileSync(resultsPath(outDir), `${JSON.stringify(tampered)}\n`, 'utf8');
      appendFileSync(resultsPath(outDir), 'not json at all\n', 'utf8');
      const damaged = readObservations(outDir);
      expect(damaged.observations).toHaveLength(4);
      expect(damaged.digestMismatches).toBe(1);
      expect(damaged.unparseableLines).toBe(1);
      expect(damaged.digestInvalidRecords).toHaveLength(1); // 不静默丢弃：损坏记录留本体给判定层

      // ---- A/B 报告 ----
      const report = buildAbReport(
        damaged.observations,
        {
          unparseableLines: damaged.unparseableLines,
          digestMismatches: damaged.digestMismatches,
          digestInvalidRecords: damaged.digestInvalidRecords,
        },
        '2026-08-24T00:00:00.000Z',
      );
      expect(report.cases).toBe(2);
      expect(report.pairings.every((p) => p.byArm.SINGLE_WRITER && p.byArm.CROSS_REVIEW)).toBe(true);
      expect(report.pairings.every((p) => p.machinePassDelta === 0)).toBe(true); // 两臂都过机器验证
      expect(report.pairings.every((p) => Object.values(p.byArm).every((a) => a.machinePassReason === null))).toBe(true);
      const aggA = report.arms.find((x) => x.arm === 'SINGLE_WRITER')!;
      const aggB = report.arms.find((x) => x.arm === 'CROSS_REVIEW')!;
      expect(aggA.machinePassRate).toBe(1);
      expect(aggA.review).toBeNull();
      expect(aggB.review!.verdicts.PASS).toBe(2);
      // B 臂多一轮审核调用 → token 成本必须更高（额外成本可见，不被平均掉）
      expect(aggB.inputTokens).toBeGreaterThan(aggA.inputTokens);
      // 未计分 reason 全臂可对账：4 条真观察全过，唯一的未计分记录是被篡改那条
      expect(aggA.machinePassReasons.RESULT_DIGEST_INVALID).toBe(0); // 损坏记录没有臂，不进单臂
      expect(aggB.machinePassReasons.RESULT_DIGEST_INVALID).toBe(0);
      expect(report.machinePassReasons.RESULT_DIGEST_INVALID).toBe(1);
      for (const r of MACHINE_PASS_REASONS) {
        if (r !== 'RESULT_DIGEST_INVALID') expect(report.machinePassReasons[r]).toBe(0);
      }
      // 主判据在盲评前不存在；样本不足必须显式告示
      expect(report.humanBlindEval).toBe('PENDING');
      expect(report.sampleCaveat).toContain('PILOT');
      expect(report.resultFileDamage).toEqual({ unparseableLines: 1, digestMismatches: 1 });

      // ---- 盲包 ----
      let seed = 42;
      const rng = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const caseInfo = new Map(cases.map((c) => [c.caseId, { title: c.title, goal: c.goal }]));
      const { packet, key } = buildBlindPacket(damaged.observations, (id) => caseInfo.get(id)!, rng);
      expect(packet.entries).toHaveLength(4);
      expect(packet.excludedNoPatch).toBe(0);
      // 不破盲：盲包正文不得含臂标识、runId、审核方痕迹、发现清单
      const packetText = JSON.stringify(packet);
      for (const forbidden of ['CROSS_REVIEW', 'SINGLE_WRITER', 'runId', 'run_', 'moonshot', 'reviewer', 'findings']) {
        expect(packetText).not.toContain(forbidden);
      }
      // 钥匙单独存在且能开箱：每臂 2 个观察
      const armsInKey = Object.values(key.byLabel).map((k) => k.arm);
      expect(armsInKey.filter((a) => a === 'CROSS_REVIEW')).toHaveLength(2);
      expect(armsInKey.filter((a) => a === 'SINGLE_WRITER')).toHaveLength(2);
      expect(new Set(Object.keys(key.byLabel))).toEqual(new Set(packet.entries.map((e) => e.label)));

      // 补丁内容是真实修复（盲评对象），与工作副本一致而模板未被改动
      const diffs = packet.entries.map((e) => e.unifiedDiff).join('\n');
      expect(diffs).toContain("+export const STATUS = 'fixed';");
      expect(diffs).toContain('+export const rate = 0.2;');
      expect(readFileSync(join(CASES_ROOT, 'case-001-status-flag', 'repo', 'src', 'app.js'), 'utf8')).toContain(
        "'broken'",
      );
    },
    120_000,
  );
});
