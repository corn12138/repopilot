import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  desktopAppSupportPath,
  findBundledCli,
  findLevelDbDirs,
  findLocalAgentModeAudits,
  findVmArtifacts,
  probeJournalProvenance,
  userCliJournalRoot,
} from './desktopProbe';

/**
 * Desktop 集成面探针的执行入口（只读、opt-in）。
 *
 *   pnpm probe:desktop
 *
 * 默认**跳过**：单测不读真实 HOME。设置 REPOPILOT_PROBE_DESKTOP=1 才跑。
 * 只打印报告到控制台，不写任何文件、零出站。
 *
 * 要回答的四个问题（2026-09-11 侦察后修正过的目标）：
 *   Q1 desktop 里是否内嵌 CLI、几个版本、可执行文件在哪；
 *   Q2 用户 CLI 那棵 journal 树里的会话，有没有字段能归属到内嵌 CLI（版本对照）；
 *   Q3 VM 工件是否存在、是否活跃（mtime）；
 *   Q4 IndexedDB(LevelDB) 是否存在、是否活跃 —— 仅作记录，Q1–Q3 有解时不碰它。
 */

const MODE = process.env.REPOPILOT_PROBE_DESKTOP ?? '';
const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
void here;

function recentJournals(root: string, max: number): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 3 || out.length >= max) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.endsWith('.jsonl')) out.push(p);
      else {
        try {
          if (readdirSync(p).length >= 0 && existsSync(p) && !name.includes('.')) visit(p, depth + 1);
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  visit(root, 0);
  return out.slice(0, max);
}

const fmtBytes = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : `${(n / 1024).toFixed(1)}K`;
const fmtAge = (ms: number): string => `${((Date.now() - ms) / 86_400_000).toFixed(1)}d`;

describe.skipIf(MODE === '')('Desktop 集成面探针（REPOPILOT_PROBE_DESKTOP）', () => {
  for (const vendor of ['claude', 'codex'] as const) {
    it(`${vendor}：集成面形状报告`, () => {
      const appSupport = desktopAppSupportPath(vendor);
      const appSupportExists = existsSync(appSupport);

      const report = {
        vendor,
        appSupportExists,
        bundledCli: appSupportExists ? findBundledCli(appSupport, vendor) : null,
        vmArtifacts: appSupportExists ? findVmArtifacts(appSupport) : [],
        indexedDb: appSupportExists ? findLevelDbDirs(appSupport) : [],
        audits: appSupportExists ? findLocalAgentModeAudits(appSupport) : [],
      };

      // ---- 打印报告 ----
      console.log(`\n=== ${vendor} desktop 集成面 ===`);
      console.log(`app support: ${appSupport} ${appSupportExists ? '存在' : '不存在（该 desktop 未安装）'}`);
      if (report.bundledCli) {
        console.log(
          `内嵌 CLI: ${report.bundledCli.root} · 版本 [${report.bundledCli.versions.join(', ')}] · 可执行 ${report.bundledCli.binaries.length} 个`,
        );
      } else {
        console.log('内嵌 CLI: 未发现');
      }
      console.log(`本地 agent 模式审计日志: ${report.audits.length} 份`);
      for (const a of report.audits.slice(0, 4)) {
        console.log(`  ${fmtBytes(a.bytes).padStart(8)}  ${fmtAge(a.mtimeMs)} 前  ${a.path.split('/').slice(-4).join('/')}`);
      }
      console.log(`VM 工件: ${report.vmArtifacts.length} 个`);
      for (const a of report.vmArtifacts.slice(0, 5)) {
        console.log(`  ${fmtBytes(a.bytes).padStart(8)}  ${fmtAge(a.mtimeMs)} 前  ${a.path.split('/').slice(-2).join('/')}`);
      }
      console.log(`LevelDB 目录: ${report.indexedDb.length} 个`);
      for (const d of report.indexedDb.slice(0, 6)) {
        console.log(
          `  ${String(d.fileCount).padStart(3)} 文件  ${fmtBytes(d.totalBytes).padStart(8)}  最新 ${fmtAge(d.newestMtimeMs)} 前  manifest=${d.hasManifest}  ${d.dir.split('/').slice(-2).join('/')}`,
        );
      }

      // ---- Q2：journal 归属对照 ----
      const journals = recentJournals(userCliJournalRoot(vendor), 12);
      const provenance = probeJournalProvenance(journals);
      console.log(`\n用户 CLI journal 抽样 ${provenance.length} 个（根 ${userCliJournalRoot(vendor)}）`);
      const allMeta = [...new Set(provenance.flatMap((p) => p.metadataValues))].sort();
      console.log(`  归属元数据值: [${allMeta.join(', ')}]`);
      const bundled = report.bundledCli?.versions ?? [];
      const overlap = allMeta.filter((v) => bundled.includes(v));
      console.log(
        overlap.length > 0
          ? `  ⚠ 归属缺口：journal 版本 ${overlap.join(', ')} 与内嵌 CLI 版本重合 —— 同一棵树里混着 desktop 产生的会话`
          : `  journal 版本与内嵌 CLI 版本不重合（desktop 会话不在这棵树里，或它不写版本字段）`,
      );
      const keyUnion = [...new Set(provenance.flatMap((p) => p.topLevelKeys))].sort();
      console.log(`  顶层键并集（${keyUnion.length} 个）: ${keyUnion.join(', ')}`);

      // ---- 只断言结构性事实，不断言这台机器的具体状态 ----
      if (appSupportExists) {
        // LevelDB 存在即说明"会话在数据库里"这条侦察结论仍然成立
        expect(report.indexedDb.length).toBeGreaterThan(0);
      }
      if (report.bundledCli) {
        expect(report.bundledCli.versions.length).toBeGreaterThan(0);
      }
      // 探针自身必须只读：跑完后再扫一次，文件数不变
      const after = appSupportExists ? findLevelDbDirs(appSupport).length : 0;
      expect(after).toBe(report.indexedDb.length);
    });
  }

  it('Claude desktop 的本地 agent 模式审计日志：存在性与形状', () => {
    /*
     * 这条测试的前身断言「app support 下没有 journal」，探针首跑把它证伪了：
     * 存在 `local-agent-mode-sessions/<uuid>/<uuid>/<uuid>/audit.jsonl`。
     * 侦察漏掉它是因为 `find … -mtime -7 | head -10` 的截断 —— 又一次
     * 「我的工具替我做了采样，我把采样当成了全集」。
     *
     * 如果这是一份刻意写出、结构稳定的审计 Artifact，它才是 desktop 的观察面，
     * 而不是 profile 里那个活着的 LevelDB。这里只取形状（键名 + 归属元数据值），
     * 不取正文。
     */
    const appSupport = desktopAppSupportPath('claude');
    if (!existsSync(appSupport)) return; // 未安装则无意义
    const audits = findLocalAgentModeAudits(appSupport);
    console.log(`\n=== claude desktop 本地 agent 模式审计日志：${audits.length} 份 ===`);
    if (audits.length === 0) {
      console.log('（这台机器没有 local-agent-mode 会话；结论：该观察面不存在）');
      return;
    }
    const shapes = probeJournalProvenance(audits.map((a) => a.path));
    for (const s of shapes.slice(0, 4)) {
      console.log(`  ${s.journalPath.split('/').slice(-4).join('/')}`);
      console.log(`    读 ${s.linesRead} 行 · 键 ${s.topLevelKeys.length} 个: ${s.topLevelKeys.join(', ')}`);
      console.log(`    归属元数据: [${s.metadataValues.join(', ')}]`);
    }
    // 存在即可解析 —— 否则它不是 Artifact，只是碰巧叫 audit 的文件
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes[0]!.linesRead).toBeGreaterThan(0);
    expect(shapes[0]!.topLevelKeys.length).toBeGreaterThan(0);
  });
});
