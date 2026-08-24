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
import { EvalHarnessError, runObservation, type EvalObservation } from './runner';
import { appendObservation, readObservations, resultsPath } from './results';
import { buildAbReport, buildBlindPacket } from './report';

/**
 * SPK-010 harness 端到端：真权威层（真 gateway/preflight/命令执行/落盘），
 * 模型在 HTTP 层脚本化。锁的是实验设计 §5 的五条 harness 纪律 ——
 * 隔离强制、fresh authority、臂完整性 fail-closed、密封可校验、盲包不破盲。
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

describe('2 case × 2 臂 端到端', () => {
  it(
    '四个观察密封落盘；B 臂有审核事实且已证异构；报告成对；盲包不破盲；篡改可检出',
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
        expect(o.status).toBe('AWAITING_PATCH_REVIEW'); // 度量止于人工审查点，补丁接受不发生
        expect(o.finalVerificationPassed).toBe(true); // node check.mjs 真的跑过且退出 0
        expect(o.patch).not.toBeNull();
        expect(o.autoApprovals).toBe(1); // 计划自动批准如实记录
        expect(o.ledger.inputTokens).toBeGreaterThan(0);
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

      // ---- A/B 报告 ----
      const report = buildAbReport(
        damaged.observations,
        { unparseableLines: damaged.unparseableLines, digestMismatches: damaged.digestMismatches },
        '2026-08-24T00:00:00.000Z',
      );
      expect(report.cases).toBe(2);
      expect(report.pairings.every((p) => p.byArm.SINGLE_WRITER && p.byArm.CROSS_REVIEW)).toBe(true);
      expect(report.pairings.every((p) => p.machinePassDelta === 0)).toBe(true); // 两臂都过机器验证
      const aggA = report.arms.find((x) => x.arm === 'SINGLE_WRITER')!;
      const aggB = report.arms.find((x) => x.arm === 'CROSS_REVIEW')!;
      expect(aggA.machinePassRate).toBe(1);
      expect(aggA.review).toBeNull();
      expect(aggB.review!.verdicts.PASS).toBe(2);
      // B 臂多一轮审核调用 → token 成本必须更高（额外成本可见，不被平均掉）
      expect(aggB.inputTokens).toBeGreaterThan(aggA.inputTokens);
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
