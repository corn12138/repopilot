#!/usr/bin/env node
/**
 * devlog 索引一致性校验（fail-closed）。
 *
 * 2026-08-27 的重审发现两类静默漂移：19 篇 devlog 未入索引、
 * `2026-08-21-02` 编号被用了两次（撞号导致其中一篇被索引遗漏）。
 * 文件与索引各自都"看起来没问题"，对不上的事实只有放在一起才显形 ——
 * 所以校验器同时读两边，任何一条violation都以非零退出，不打折、不告警了事。
 *
 * 校验项：
 *   1. 文件名必须是 `YYYY-MM-DD-NN-短标题.md`（README.md 除外）；
 *   2. `YYYY-MM-DD-NN` 前缀全库唯一 —— 撞号即失败；
 *   3. 每个文件在 docs/devlog/README.md 里恰好被链接一次 —— 0 次是漏索引，
 *      2 次是重复行；
 *   4. 索引里的每个链接都指向真实存在的文件 —— 断链即失败。
 *
 * 用法：node scripts/check-devlog.mjs（仓库任意位置均可）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEVLOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'devlog');
const INDEX = join(DEVLOG_DIR, 'README.md');

const problems = [];

// ---- 1/2. 文件侧：命名形状 + 编号唯一 ----
const files = readdirSync(DEVLOG_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort();

const NAME_RE = /^(\d{4}-\d{2}-\d{2}-\d{2})-.+\.md$/;
const byPrefix = new Map();
for (const f of files) {
  const m = NAME_RE.exec(f);
  if (!m) {
    problems.push(`命名不合形状（要求 YYYY-MM-DD-NN-短标题.md）：${f}`);
    continue;
  }
  const prefix = m[1];
  const dupes = byPrefix.get(prefix) ?? [];
  dupes.push(f);
  byPrefix.set(prefix, dupes);
}
for (const [prefix, group] of byPrefix) {
  if (group.length > 1) {
    problems.push(`编号 ${prefix} 被用了 ${group.length} 次：${group.join(' / ')}`);
  }
}

// ---- 3/4. 索引侧：链接目标提取（形如 ](2026-…-….md)）----
const indexText = readFileSync(INDEX, 'utf8');
const linkTargets = [...indexText.matchAll(/\]\((\d{4}-\d{2}-\d{2}-[^)]+\.md)\)/g)].map((m) => m[1]);

const linkCount = new Map();
for (const t of linkTargets) linkCount.set(t, (linkCount.get(t) ?? 0) + 1);

for (const f of files) {
  const n = linkCount.get(f) ?? 0;
  if (n === 0) problems.push(`未入索引：${f}`);
  if (n > 1) problems.push(`索引里出现 ${n} 次（应恰好 1 次）：${f}`);
}
for (const t of linkCount.keys()) {
  if (!existsSync(join(DEVLOG_DIR, t))) problems.push(`索引断链（文件不存在）：${t}`);
}

// ---- 收口：省略要报数，通过也要报数 ----
if (problems.length > 0) {
  console.error(`devlog 索引校验失败，共 ${problems.length} 条：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`devlog 索引校验通过：${files.length} 篇文件 ↔ ${linkTargets.length} 条索引链接，编号无撞车，无断链。`);
