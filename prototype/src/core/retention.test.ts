import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@shared/ids';
import {
  DEFAULT_RETENTION,
  type LiveReferences,
  type RetentionPolicy,
  sweep,
} from './retention';
import { PATHS, ensureDataRoot, runDir, snapshotDir, workspaceDir } from './paths';
import { writeJsonAtomic } from './store';

/**
 * 保留期清理。
 *
 * 这是唯一一块**主动删除用户数据**的代码，所以测试的重点全在
 * "不该删的绝不能删" 和 "删不干净时必须说删不干净" 上。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

/** 不落盘 last-purge.json，也不动真实策略文件；测试全用显式传入的 policy */
const POLICY: RetentionPolicy = {
  ...DEFAULT_RETENTION,
  evidenceDays: 30,
  workspaceGraceMinutes: 60,
};

const made: string[] = [];

function mkRun(id: string): string {
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\n', 'utf8');
  made.push(dir);
  return id;
}

function mkWorkspace(runId: string): void {
  const dir = join(workspaceDir(runId), 'gen-0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.ts'), 'x'.repeat(500), 'utf8');
  made.push(workspaceDir(runId));
}

function mkSnapshot(id: string): string {
  const dir = snapshotDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.ts'), 'y'.repeat(300), 'utf8');
  made.push(dir);
  return id;
}

function mkArtifact(id: string): string {
  mkdirSync(PATHS.artifacts, { recursive: true });
  const f = join(PATHS.artifacts, `${id}.txt`);
  writeFileSync(f, 'z'.repeat(100), 'utf8');
  made.push(f);
  return id;
}

function refs(
  runs: Record<string, { terminal: boolean; ageDays: number }>,
  snapshots: string[] = [],
  artifacts: string[] = [],
): LiveReferences {
  return {
    runs: new Map(
      Object.entries(runs).map(([id, r]) => [
        id,
        {
          terminal: r.terminal,
          terminalAt: r.terminal ? NOW - r.ageDays * DAY : null,
          updatedAt: NOW - r.ageDays * DAY,
        },
      ]),
    ),
    snapshots: new Set(snapshots),
    artifacts: new Set(artifacts),
  };
}

beforeEach(() => ensureDataRoot());

afterEach(async () => {
  const { rmSync } = await import('node:fs');
  for (const p of made) rmSync(p, { recursive: true, force: true });
  made.length = 0;
});

describe('工作区：Run 终态且过宽限期才删', () => {
  it('运行中的 Run，工作区绝不能删', () => {
    const id = mkRun(newId('run'));
    mkWorkspace(id);
    const s = sweep(refs({ [id]: { terminal: false, ageDays: 0 } }, [], []), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'WORKSPACE' && i.target === id)!;
    expect(item.outcome).toBe('KEPT_REFERENCED');
    expect(existsSync(workspaceDir(id))).toBe(true);
  });

  it('刚终态、宽限期未过 → 保留（这样用户还能浏览文件树）', () => {
    const id = mkRun(newId('run'));
    mkWorkspace(id);
    // 终态 10 分钟，宽限期 60 分钟
    const live = refs({ [id]: { terminal: true, ageDays: 10 / (24 * 60) } });
    const s = sweep(live, POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'WORKSPACE' && i.target === id)!;
    expect(item.outcome).toBe('KEPT_NOT_DUE');
    expect(existsSync(workspaceDir(id))).toBe(true);
  });

  it('终态且过了宽限期 → 删掉，并报出释放的字节', () => {
    const id = mkRun(newId('run'));
    mkWorkspace(id);
    const s = sweep(refs({ [id]: { terminal: true, ageDays: 1 } }), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'WORKSPACE' && i.target === id)!;
    expect(item.outcome).toBe('DELETED');
    expect(item.bytesFreed).toBeGreaterThan(0);
    expect(existsSync(workspaceDir(id))).toBe(false);
    // 证据目录不能被顺手删掉
    expect(existsSync(runDir(id))).toBe(true);
  });

  it('没有对应 Run 的孤儿工作区 → 回收', () => {
    const orphan = newId('run');
    mkWorkspace(orphan);
    const s = sweep(refs({}), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'WORKSPACE' && i.target === orphan)!;
    expect(item.outcome).toBe('DELETED');
    expect(item.reason).toMatch(/孤儿/);
  });
});

describe('证据：满 30 天才删', () => {
  it('29 天的 Run 保留，并说明还剩几天', () => {
    const id = mkRun(newId('run'));
    const s = sweep(refs({ [id]: { terminal: true, ageDays: 29 } }), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === id)!;
    expect(item.outcome).toBe('KEPT_NOT_DUE');
    expect(item.reason).toMatch(/还剩/);
    expect(existsSync(runDir(id))).toBe(true);
  });

  it('31 天的 Run 删除', () => {
    const id = mkRun(newId('run'));
    const s = sweep(refs({ [id]: { terminal: true, ageDays: 31 } }), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === id)!;
    expect(item.outcome).toBe('DELETED');
    expect(existsSync(runDir(id))).toBe(false);
  });

  it('非终态的 Run 无论多老都不删 —— 它可能只是在等你审批', () => {
    const id = mkRun(newId('run'));
    const s = sweep(refs({ [id]: { terminal: false, ageDays: 400 } }), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === id)!;
    expect(item.outcome).toBe('KEPT_REFERENCED');
    expect(existsSync(runDir(id))).toBe(true);
  });

  it('保留天数可配置，且立刻生效', () => {
    const id = mkRun(newId('run'));
    const shortPolicy = { ...POLICY, evidenceDays: 7 };
    const s = sweep(refs({ [id]: { terminal: true, ageDays: 10 } }), shortPolicy, NOW);

    expect(s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === id)!.outcome).toBe(
      'DELETED',
    );
  });
});

describe('快照与 artifact：引用计数', () => {
  it('仍被引用的快照不删', () => {
    const snapId = mkSnapshot(newId('snap'));
    const s = sweep(refs({}, [snapId]), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!;
    expect(item.outcome).toBe('KEPT_REFERENCED');
    expect(existsSync(snapshotDir(snapId))).toBe(true);
  });

  it('无引用的快照删掉', () => {
    const snapId = mkSnapshot(newId('snap'));
    const s = sweep(refs({}, []), POLICY, NOW);

    expect(s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!.outcome).toBe(
      'DELETED',
    );
    expect(existsSync(snapshotDir(snapId))).toBe(false);
  });

  it('被工具调用引用的 artifact 不删，孤儿删', () => {
    const kept = mkArtifact(newId('art'));
    const orphan = mkArtifact(newId('art'));
    const s = sweep(refs({}, [], [kept]), POLICY, NOW);

    const keptItem = s.items.find((i) => i.domain === 'ARTIFACT' && i.target === `${kept}.txt`)!;
    const orphanItem = s.items.find((i) => i.domain === 'ARTIFACT' && i.target === `${orphan}.txt`)!;
    expect(keptItem.outcome).toBe('KEPT_REFERENCED');
    expect(orphanItem.outcome).toBe('DELETED');
    expect(existsSync(join(PATHS.artifacts, `${kept}.txt`))).toBe(true);
  });
});

describe('删除结果必须诚实', () => {
  it('全部成功 → COMPLETE', () => {
    const id = mkRun(newId('run'));
    const s = sweep(refs({ [id]: { terminal: true, ageDays: 1 } }), POLICY, NOW);
    expect(s.status).toBe('COMPLETE');
    expect(s.incompleteReason).toBeNull();
  });

  it('被数量上限截断 → INCOMPLETE 且说明原因', () => {
    for (let i = 0; i < 5; i += 1) mkWorkspace(mkRun(newId('run')));
    const tiny = { ...POLICY, maxItemsPerSweep: 2 };
    const s = sweep(refs({}), tiny, NOW);

    expect(s.status).toBe('INCOMPLETE');
    expect(s.incompleteReason).toMatch(/处理数达上限/);
    // 关键：截断不等于失败，已处理的那些是真的处理了
    expect(s.items.length).toBeLessThanOrEqual(2);
  });

  it('逐项结果齐全 —— 不是一句"清理完成"', () => {
    const a = mkRun(newId('run'));
    mkWorkspace(a);
    const b = mkRun(newId('run'));
    const s = sweep(
      refs({ [a]: { terminal: true, ageDays: 1 }, [b]: { terminal: false, ageDays: 0 } }),
      POLICY,
      NOW,
    );

    // 每一项都有 domain / target / outcome / reason，能回答"这个东西为什么还在/没了"
    expect(s.items.length).toBeGreaterThanOrEqual(3);
    for (const item of s.items) {
      expect(item.domain).toBeTruthy();
      expect(item.target).toBeTruthy();
      expect(['DELETED', 'KEPT_REFERENCED', 'KEPT_NOT_DUE', 'FAILED']).toContain(item.outcome);
      expect(item.reason).toBeTruthy();
    }
    expect(s.deleted).toBe(s.items.filter((i) => i.outcome === 'DELETED').length);
    expect(s.bytesFreed).toBe(
      s.items.filter((i) => i.outcome === 'DELETED').reduce((n, i) => n + i.bytesFreed, 0),
    );
  });
});

describe('策略夹紧', () => {
  it('保留天数被夹到安全区间 —— 0 天等于删掉刚跑完的 Run', async () => {
    const { savePolicy, loadPolicy } = await import('./retention');
    const backup = loadPolicy();
    try {
      expect(savePolicy({ evidenceDays: 0 }).evidenceDays).toBe(1);
      expect(savePolicy({ evidenceDays: 99999 }).evidenceDays).toBe(365);
      expect(savePolicy({ evidenceDays: 30 }).evidenceDays).toBe(30);
    } finally {
      writeJsonAtomic(join(PATHS.root, 'retention.json'), backup);
    }
  });
});
