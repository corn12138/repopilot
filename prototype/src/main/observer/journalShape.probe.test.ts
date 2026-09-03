import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  captureShape,
  diffShape,
  discoverJournalFiles,
  parseSnapshot,
  readJournalLines,
  serializeSnapshot,
  type JournalVendor,
} from './journalShape';

/**
 * 显式 opt-in 的本机日志对照（ASM-027 / TD-ASM-021 的执行入口）。
 *
 * `pnpm test` 默认**跳过**这里 —— 单测不读真实 HOME（工程诚实规则：自检不碰
 * 真实数据；其他机器/CI 上也根本没有这些日志）。要跑：
 *
 *   pnpm probe:journals                                    # 对照（BREAKING 即红）
 *   REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals    # 两家升级后重生成快照
 *
 * 只读真实日志、只写本目录下的两个快照文件（且仅 update 模式）、零出站。
 * 快照里只有键名与 type 名，不含任何记录值（DEC-020：内容零出站）。
 */

const MODE = process.env.REPOPILOT_PROBE_JOURNALS ?? '';
const MAX_FILES_PER_VENDOR = 40;

interface VendorSpec {
  readonly vendor: JournalVendor;
  readonly root: string;
  readonly fileNameFilter?: (name: string) => boolean;
  readonly snapshotFile: string;
}

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

const SPECS: readonly VendorSpec[] = [
  {
    vendor: 'CLAUDE_JOURNAL',
    root: join(homedir(), '.claude', 'projects'),
    snapshotFile: here('claude-journal.shape.json'),
  },
  {
    vendor: 'CODEX_ROLLOUT',
    root: join(homedir(), '.codex', 'sessions'),
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
      const fileLines: (readonly string[])[] = [];
      for (const f of sweep.files) {
        const lines = readJournalLines(f);
        if (lines === null) unreadableFiles += 1;
        else fileLines.push(lines);
      }
      const current = captureShape(spec.vendor, fileLines);

      // 省略要报数：扫了多少、跳了多少、坏了多少，全部进输出
      console.log(
        `[probe:${spec.vendor}] 文件 ${fileLines.length}/${sweep.totalMatched}` +
          `（上限跳过 ${sweep.skippedFiles}，读失败 ${unreadableFiles}，symlink 跳过 ${sweep.symlinksSkipped}，坏目录 ${sweep.unreadableDirs}）；` +
          `记录 ${current.records}，坏行 ${current.unparseableLines}，空行 ${current.blankLines}，` +
          `截断行 ${current.truncatedLines}，type 上限丢弃 ${current.droppedForTypeCap}；` +
          `top type ${Object.keys(current.types).length} 种` +
          (current.payloadTypes ? `，payload type ${Object.keys(current.payloadTypes).length} 种` : ''),
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

      // 只有破坏性漂移判红；增量漂移是「词表该更新了」，用 update 模式收编
      expect(report.breaking, '基线必现键缺席/降级 —— 观察面板此时必须降级为「格式未知」').toEqual([]);
    });
  }
});
