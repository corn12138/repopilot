/**
 * SPK-010 sealed A/B 实验执行器（实验设计 v0.1-r2 §5、§6）。
 *
 * 用法（在 prototype/ 下）：
 *   pnpm eval:spk010 --implementer deepseek --reviewer moonshot-cn [选项]
 *
 * 选项：
 *   --implementer <providerId>   写手 provider（必填）
 *   --reviewer <providerId>      审核方 provider（必填，与写手不同厂商）
 *   --out <dir>                  结果目录（默认 eval-out/spk010）；可重入，已密封的观察自动跳过
 *   --cases <id,id,...>          只跑指定 caseId（默认全部 20 个）
 *   --arms <A,B>                 SINGLE_WRITER / CROSS_REVIEW（默认两臂）
 *   --phase-timeout-ms <n>       单阶段墙钟上限（默认 900000 = 15 分钟）
 *   --max-consecutive-failures <n>  连续失败熔断阈值（默认 3）
 *   --dry-run                    只打印预检与执行计划，不发起任何模型调用
 *
 * 纪律（与 runner 同源，这里只做编排，不放宽任何一条）：
 *   - 凭据只从环境变量读（EnvVar 名单见预检输出）；本脚本不接受、不打印、不落盘任何 key；
 *   - REPOPILOT_DATA_ROOT 未设时指向 <out>/data-root —— 实验绝不写真实用户数据根；
 *   - 断点续跑按 (caseDigest, arm) 去重：只认 digest 校验通过的已密封观察；
 *     caseDigest 与当前案例集不符的历史观察不计入报告（数量如实报出）；
 *   - 任何观察失败不静默：逐条列出，进程以非零退出；连续失败达到阈值立即熔断
 *     （大概率是配额/凭据/网络这类系统性问题，继续烧 token 没有意义）。
 */

import type { ProviderDescriptor } from '../model/registry';
import type { EvalArm } from './runner';

const HELP_HINT = '用法：pnpm eval:spk010 --implementer <providerId> --reviewer <providerId> [--dry-run]';

interface CliArgs {
  implementer: string;
  reviewer: string;
  out: string;
  cases: string[] | null;
  arms: ('SINGLE_WRITER' | 'CROSS_REVIEW')[];
  phaseTimeoutMs: number;
  maxConsecutiveFailures: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    implementer: '',
    reviewer: '',
    out: 'eval-out/spk010',
    cases: null,
    arms: ['SINGLE_WRITER', 'CROSS_REVIEW'],
    phaseTimeoutMs: 900_000,
    maxConsecutiveFailures: 3,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 需要一个值。${HELP_HINT}`);
      i += 1;
      return v;
    };
    if (a === '--implementer') out.implementer = next();
    else if (a === '--reviewer') out.reviewer = next();
    else if (a === '--out') out.out = next();
    else if (a === '--cases') out.cases = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--arms') {
      out.arms = next().split(',').map((s) => s.trim()) as CliArgs['arms'];
      for (const arm of out.arms) {
        if (arm !== 'SINGLE_WRITER' && arm !== 'CROSS_REVIEW') throw new Error(`未知臂：${arm}（只有 SINGLE_WRITER / CROSS_REVIEW）`);
      }
    } else if (a === '--phase-timeout-ms') out.phaseTimeoutMs = Number(next());
    else if (a === '--max-consecutive-failures') out.maxConsecutiveFailures = Number(next());
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`未知参数：${a}。${HELP_HINT}`);
  }
  if (!out.implementer || !out.reviewer) throw new Error(`--implementer 与 --reviewer 都必填。${HELP_HINT}`);
  if (out.implementer === out.reviewer) {
    throw new Error('写手与审核方是同一个 provider —— 异构是不变式，实验的自变量就是"第二个异构模型"');
  }
  if (!Number.isFinite(out.phaseTimeoutMs) || out.phaseTimeoutMs <= 0) throw new Error('--phase-timeout-ms 必须是正数');
  return out;
}

async function main(): Promise<number> {
  const { mkdirSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  // 隔离先于一切 import：paths 模块在首次加载时解析数据根
  if (!process.env.REPOPILOT_DATA_ROOT) {
    process.env.REPOPILOT_DATA_ROOT = join(outDir, 'data-root');
  }
  mkdirSync(process.env.REPOPILOT_DATA_ROOT, { recursive: true });

  const { allProviders } = await import('../model/registry');
  const { profileIdOf } = await import('../model/gateway');
  const { loadEvalCases } = await import('./cases');
  const { runObservation, EvalHarnessError } = await import('./runner');
  const { appendObservation, readObservations } = await import('./results');
  const { buildAbReport, buildBlindPacket, writeBlindMaterials } = await import('./report');
  const { classifyObservation } = await import('./judge');
  const { nowIso } = await import('@shared/ids');
  const { writeFileSync } = await import('node:fs');

  // ---- 预检 ----
  const providers = allProviders();
  const pick = (id: string, role: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) {
      throw new Error(`${role} provider 不存在：${id}。可选：${providers.map((x) => x.id).join(', ')}`);
    }
    return p;
  };
  const impl = pick(args.implementer, '写手');
  const rev = pick(args.reviewer, '审核方');

  const keyStatus = (p: ProviderDescriptor): { names: string; present: boolean } => ({
    names: p.env.join(' / ') || '（无环境变量通道）',
    present: p.env.some((n) => (process.env[n] ?? '').trim() !== ''),
  });
  const implKey = keyStatus(impl);
  const revKey = keyStatus(rev);

  const casesRoot = resolve('eval-cases');
  const allCases = loadEvalCases(casesRoot);
  const selected = args.cases ? allCases.filter((c) => args.cases!.includes(c.caseId)) : allCases;
  if (args.cases) {
    const missing = args.cases.filter((id) => !allCases.some((c) => c.caseId === id));
    if (missing.length > 0) throw new Error(`--cases 里有不存在的 caseId：${missing.join(', ')}`);
  }

  const prior = readObservations(outDir);
  const currentDigests = new Set(selected.map((c) => c.caseDigest));
  const done = new Set(prior.observations.map((o) => `${o.caseDigest}:${o.arm}`));
  const staleObservations = prior.observations.filter((o) => !allCases.some((c) => c.caseDigest === o.caseDigest)).length;

  const plan: { caseId: string; arm: EvalArm; state: 'PENDING' | 'SEALED' }[] = [];
  for (const c of selected) {
    for (const arm of args.arms) {
      plan.push({ caseId: c.caseId, arm, state: done.has(`${c.caseDigest}:${arm}`) ? 'SEALED' : 'PENDING' });
    }
  }
  const pending = plan.filter((p) => p.state === 'PENDING');

  console.log('SPK-010 预检');
  console.log(`  写手     ${impl.id}（默认模型 ${impl.defaultModel}）  凭据 ${implKey.names}：${implKey.present ? '已设置' : '未设置'}`);
  console.log(`  审核方   ${rev.id}（默认模型 ${rev.defaultModel}）  凭据 ${revKey.names}：${revKey.present ? '已设置' : '未设置'}`);
  console.log(`  案例集   ${selected.length}/${allCases.length} 个 case（${casesRoot}）`);
  console.log(`  臂       ${args.arms.join(' + ')}`);
  console.log(`  结果     ${outDir}（已密封 ${plan.length - pending.length}/${plan.length}，本次待跑 ${pending.length}）`);
  if (prior.unparseableLines || prior.digestMismatches) {
    console.log(`  ⚠ 结果文件损伤：坏行 ${prior.unparseableLines}，digest 不符 ${prior.digestMismatches}（保留在案，进报告总账）`);
  }
  if (staleObservations > 0) {
    console.log(`  ⚠ ${staleObservations} 条历史观察的 caseDigest 不属于当前案例集 —— 不计入本轮报告，请考虑换一个 --out`);
  }
  console.log(`  数据根   ${process.env.REPOPILOT_DATA_ROOT}（隔离，不碰真实用户数据）`);
  console.log(`  阶段超时 ${args.phaseTimeoutMs}ms · 连续失败熔断 ${args.maxConsecutiveFailures}`);

  if (args.dryRun) {
    console.log('\n执行计划（--dry-run，未发起任何模型调用）：');
    for (const p of plan) console.log(`  ${p.state === 'SEALED' ? '✓ 已密封' : '· 待跑  '} ${p.caseId} × ${p.arm}`);
    return 0;
  }

  if (!implKey.present || !revKey.present) {
    console.error('\n凭据未就绪 —— 本脚本不接受明文 key，请在运行的 shell 里 export 上面列出的环境变量后重试。');
    return 1;
  }

  // ---- 执行 ----
  const routesFor = (arm: EvalArm) => ({
    implementerProfileId: profileIdOf(impl.id),
    reviewerProfileId: arm === 'CROSS_REVIEW' ? profileIdOf(rev.id) : null,
  });
  const failures: { caseId: string; arm: EvalArm; error: string }[] = [];
  let consecutive = 0;
  let sealed = 0;

  for (const c of selected) {
    for (const arm of args.arms) {
      if (done.has(`${c.caseDigest}:${arm}`)) continue;
      const label = `${c.caseId} × ${arm}`;
      process.stdout.write(`▶ ${label} … `);
      try {
        const o = await runObservation({ evalCase: c, arm, routes: routesFor(arm), phaseTimeoutMs: args.phaseTimeoutMs });
        appendObservation(outDir, o);
        sealed += 1;
        consecutive = 0;
        const verdict = classifyObservation(o, true);
        const tok = `${o.ledger.inputTokens}+${o.ledger.outputTokens}tok${(o.ledger.unknownUsageTurns ?? 0) > 0 ? `（${o.ledger.unknownUsageTurns} 轮用量未知）` : ''}`;
        console.log(
          `${o.status} · machine ${verdict.pass ? 'PASS' : `no（${verdict.reason}）`} · ${Math.round(o.wallClockMs / 1000)}s · ${tok}`,
        );
      } catch (err) {
        consecutive += 1;
        const msg = err instanceof EvalHarnessError ? `${err.code}: ${err.message}` : String(err instanceof Error ? err.message : err);
        failures.push({ caseId: c.caseId, arm, error: msg });
        console.log(`✗ 失败 —— ${msg}`);
        if (consecutive >= args.maxConsecutiveFailures) {
          console.error(`\n连续失败 ${consecutive} 次，熔断停跑 —— 大概率是凭据/配额/网络这类系统性问题，先修再续（结果目录可重入）。`);
          break;
        }
      }
    }
    if (consecutive >= args.maxConsecutiveFailures) break;
  }

  // ---- 报告与盲评包（只用当前案例集的观察；历史/异集观察如实排除并报数） ----
  const after = readObservations(outDir);
  const inSet = after.observations.filter((o) => currentDigests.has(o.caseDigest));
  const excluded = after.observations.length - inSet.length;
  const report = buildAbReport(
    inSet,
    { unparseableLines: after.unparseableLines, digestMismatches: after.digestMismatches, digestInvalidRecords: after.digestInvalidRecords },
    nowIso(),
  );
  writeFileSync(join(outDir, 'ab-report.json'), JSON.stringify(report, null, 2), 'utf8');
  const infoOf = new Map(allCases.map((c) => [c.caseId, { title: c.title, goal: c.goal }]));
  const { packet, key } = buildBlindPacket(inSet, (caseId) => {
    const info = infoOf.get(caseId);
    if (!info) throw new Error(`观察引用了未知 caseId：${caseId}`);
    return info;
  });
  writeBlindMaterials(outDir, packet, key);

  console.log('\nSPK-010 本轮收口');
  console.log(`  本次密封 ${sealed} 条；累计在集观察 ${inSet.length} 条${excluded > 0 ? `（另有 ${excluded} 条异集观察被排除）` : ''}`);
  for (const armAgg of report.arms) {
    console.log(`  ${armAgg.arm}: machine pass ${armAgg.machineVerifiedPass}/${armAgg.observations}`);
    const reasons = Object.entries(armAgg.machinePassReasons).filter(([, n]) => n > 0);
    if (reasons.length > 0) console.log(`    未计分原因：${reasons.map(([r, n]) => `${r}×${n}`).join('，')}`);
  }
  if (report.sampleCaveat) console.log(`  ⚠ ${report.sampleCaveat}`);
  console.log(`  报告   ${join(outDir, 'ab-report.json')}`);
  console.log(`  盲评包 ${join(outDir, 'blind-packet.json')}（钥匙文件在盲评完成前不要打开）`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} 个观察未完成（重跑同一命令会自动续跑）：`);
    for (const f of failures) console.error(`  ✗ ${f.caseId} × ${f.arm} —— ${f.error}`);
    return 1;
  }
  console.log('\nmachine 侧到此为止 —— pass@1 delta 不能替代 verified defect delta，下一步是人工盲评（实验设计 §4）。');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
