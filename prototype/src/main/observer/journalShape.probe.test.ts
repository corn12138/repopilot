import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ObserverProjection, ObserverPushEvent } from '@shared/observerProtocol';
import {
  captureShape,
  diffShape,
  discoverJournalFiles,
  parseSnapshot,
  readJournalLines,
  serializeSnapshot,
  type JournalVendor,
} from './journalShape';
import { ObserverService } from './observerService';

/**
 * 显式 opt-in 的本机日志对照与面板干跑（ASM-027 / TD-ASM-021 的执行入口）。
 *
 * `pnpm test` 默认**跳过**这里 —— 单测不读真实 HOME（工程诚实规则：自检不碰
 * 真实数据；其他机器/CI 上也根本没有这些日志）。要跑：
 *
 *   pnpm probe:journals                                    # 对照 + 面板干跑
 *   REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals    # 两家升级后重生成快照
 *   REPOPILOT_PROBE_PROJECT=/abs/path pnpm probe:journals  # 面板干跑换项目（默认本仓库）
 *
 * 只读真实日志、只写本目录下的两个快照文件（且仅 update 模式）、零出站。
 * 快照里只有键名与 type 名，不含任何记录值（DEC-020：内容零出站）。
 *
 * 基线扫描范围 2026-09-05 从 40 扩到 200 个文件：40 个文件的窗口让罕见 type
 * （bridge-session）上的可选键被误归入 required 层，三天后换个窗口就报"破坏性漂移"。
 * required 是交集，样本越多越接近真相；代价只是 update 模式慢几秒。
 */

const MODE = process.env.REPOPILOT_PROBE_JOURNALS ?? '';
const MAX_FILES_PER_VENDOR = 200;
/** 面板干跑最多监视多少个会话（每个都要完整读一次文件） */
const MAX_DRY_RUN_SESSIONS = 40;

interface VendorSpec {
  readonly vendor: JournalVendor;
  readonly root: string;
  readonly fileNameFilter?: (name: string) => boolean;
  readonly snapshotFile: string;
}

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects');
const CODEX_ROOT = join(homedir(), '.codex', 'sessions');

const SPECS: readonly VendorSpec[] = [
  { vendor: 'CLAUDE_JOURNAL', root: CLAUDE_ROOT, snapshotFile: here('claude-journal.shape.json') },
  {
    vendor: 'CODEX_ROLLOUT',
    root: CODEX_ROOT,
    fileNameFilter: (name) => name.startsWith('rollout-'),
    snapshotFile: here('codex-rollout.shape.json'),
  },
];

describe.skipIf(MODE === '')('本机日志字段快照对照（REPOPILOT_PROBE_JOURNALS）', () => {
  for (const spec of SPECS) {
    it(`${spec.vendor}：${MODE === 'update' ? '重生成快照' : '对照已提交快照'}`, () => {
      expect(existsSync(spec.root), `日志根目录不存在：${spec.root} —— 这台机器没有该日志，probe 无意义`).toBe(true);

      const sweep = discoverJournalFiles(spec.root, {
        maxFiles: MAX_FILES_PER_VENDOR,
        ...(spec.fileNameFilter ? { fileNameFilter: spec.fileNameFilter } : {}),
      });
      expect(sweep.files.length, `${spec.root} 下没有匹配的 .jsonl —— 无样本可对照`).toBeGreaterThan(0);

      let unreadableFiles = 0;
      const t0 = performance.now();
      // 生成器逐个读：任何时刻内存里只有一个文件的行（200 个文件一次性全读曾直接 OOM）
      function* lazily(): Generator<readonly string[]> {
        for (const f of sweep.files) {
          const lines = readJournalLines(f);
          if (lines === null) unreadableFiles += 1;
          else yield lines;
        }
      }
      const current = captureShape(spec.vendor, lazily());
      const elapsedMs = Math.round(performance.now() - t0);

      // 省略要报数：扫了多少、跳了多少、坏了多少、花了多久，全部进输出
      console.log(
        `[probe:${spec.vendor}] 文件 ${current.files}/${sweep.totalMatched}` +
          `（上限跳过 ${sweep.skippedFiles}，读失败 ${unreadableFiles}，symlink 跳过 ${sweep.symlinksSkipped}，坏目录 ${sweep.unreadableDirs}）；` +
          `记录 ${current.records}，坏行 ${current.unparseableLines}，空行 ${current.blankLines}，` +
          `截断行 ${current.truncatedLines}，type 上限丢弃 ${current.droppedForTypeCap}；` +
          `top type ${Object.keys(current.types).length} 种` +
          (current.payloadTypes ? `，payload type ${Object.keys(current.payloadTypes).length} 种` : '') +
          `；读取+归纳 ${elapsedMs}ms`,
      );

      if (MODE === 'update') {
        writeFileSync(spec.snapshotFile, serializeSnapshot(current), 'utf8');
        // 写完立刻按解析器自检读回 —— 生成的基线必须能过自己的形状校验
        const reloaded = parseSnapshot(readFileSync(spec.snapshotFile, 'utf8'));
        expect(reloaded.vendor).toBe(spec.vendor);
        expect(Object.keys(reloaded.types).length).toBeGreaterThan(0);
        console.log(`[probe:${spec.vendor}] 快照已重生成 → ${spec.snapshotFile}`);
        return;
      }

      expect(
        existsSync(spec.snapshotFile),
        `缺已提交快照 ${spec.snapshotFile} —— 先跑 REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals`,
      ).toBe(true);
      const baseline = parseSnapshot(readFileSync(spec.snapshotFile, 'utf8'));
      const report = diffShape(baseline, current);

      if (report.unobservedTypes.length + report.unobservedPayloadTypes.length > 0) {
        console.log(
          `[probe:${spec.vendor}] 未观测（无信号，不定罪）：` +
            [...report.unobservedTypes, ...report.unobservedPayloadTypes].join('、'),
        );
      }
      if (report.additive.length > 0) {
        console.log(`[probe:${spec.vendor}] 增量漂移 ${report.additive.length} 条：\n  ${report.additive.join('\n  ')}`);
      }
      console.log(`[probe:${spec.vendor}] verdict = ${report.verdict}`);

      /*
       * 破坏性漂移判红，但要说清它的含义：基线 required 层是样本归纳，一条反例分不清
       * 「格式真变了」和「上次样本太小」。两种情况的处置都是同一件事 —— 人看一眼版本号，
       * 然后用 update 模式重建基线。面板本身不受此影响（它只看消费契约）。
       */
      expect(
        report.breaking,
        '基线必现键缺席/降级 —— 要么格式变了，要么上次基线过拟合；核对两家版本后用 update 重建基线',
      ).toEqual([]);
    });
  }

  it('面板干跑：对真实项目的真实会话逐个投影，报状态分布、漂移提示频次与耗时', () => {
    const project = process.env.REPOPILOT_PROBE_PROJECT ?? resolve(here('.'), '../../../..');
    const events: ObserverPushEvent[] = [];
    const service = new ObserverService({
      claudeProjectsRoot: CLAUDE_ROOT,
      codexSessionsRoot: CODEX_ROOT,
      emit: (e) => events.push(e),
    });

    const t0 = performance.now();
    const { sessions, counts } = service.enable(project, project);
    const enableMs = Math.round(performance.now() - t0);
    console.log(
      `[dry-run] 项目 ${project}：会话 ${sessions.length}（claude ${counts.claudeMatched}，子代理/子文件未列 ${counts.claudeNestedSkipped}，` +
        `codex ${counts.codexMatched}/${counts.codexScanned}，codex 首行读不出 ${counts.codexUnreadable}）；enable 耗时 ${enableMs}ms`,
    );
    expect(sessions.length, `该项目在本机没有任何代理会话日志：${project}`).toBeGreaterThan(0);

    const byStatus: Record<ObserverProjection['status'], number> = { OK: 0, FORMAT_UNKNOWN: 0 };
    const driftFreq = new Map<string, number>();
    const unknown: string[] = [];
    const watchMs: number[] = [];
    let totalRecords = 0;
    for (const s of sessions.slice(0, MAX_DRY_RUN_SESSIONS)) {
      const before = events.length;
      const t = performance.now();
      service.watch(s.sessionId);
      watchMs.push(performance.now() - t);
      const ev = events.slice(before).find((e) => e.kind === 'observer.projection');
      if (!ev || ev.kind !== 'observer.projection') {
        unknown.push(`${s.sessionId}（无投影：文件读不出）`);
        continue;
      }
      byStatus[ev.projection.status] += 1;
      totalRecords += ev.projection.counts.records;
      for (const d of ev.projection.driftNotes) driftFreq.set(d, (driftFreq.get(d) ?? 0) + 1);
      if (ev.projection.status === 'FORMAT_UNKNOWN') {
        unknown.push(`${s.sessionId}：${ev.projection.breaking.join('、')}`);
      }
    }
    service.disable();

    const sorted = [...watchMs].sort((a, b) => a - b);
    const p = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    console.log(
      `[dry-run] 监视 ${watchMs.length} 个会话，共 ${totalRecords} 条记录：OK ${byStatus.OK}，FORMAT_UNKNOWN ${byStatus.FORMAT_UNKNOWN}；` +
        `单次 watch（含整文件读取+投影）耗时 p50 ${p(0.5)}ms · p90 ${p(0.9)}ms · max ${Math.round(sorted[sorted.length - 1] ?? 0)}ms`,
    );
    if (driftFreq.size > 0) {
      const top = [...driftFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`[dry-run] 漂移提示（出现会话数）：\n  ${top.map(([k, n]) => `${k} ×${n}`).join('\n  ')}`);
    }
    if (unknown.length > 0) console.log(`[dry-run] 格式未知的会话：\n  ${unknown.join('\n  ')}`);

    // 面板对真实数据的可用率是这条验证的核心断言：消费契约不该在自家日志上误报
    expect(unknown, '真实会话被判成格式未知 —— 要么日志真的变了，要么消费契约写窄了').toEqual([]);
  });
});
