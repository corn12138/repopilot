import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 测试绝不碰真实数据根（~/Library/Application Support/RepoPilotPrototype）：
 * 并行的测试文件共享真根会互相踩（retention 的清扫会删掉别人的快照 ——
 * 528 全绿的套件曾因此随机红 3-4 条），而且会在用户机器上留垃圾，
 * 违反「自检和测试不能留下持久化改动」。vi.mock 提升到 import 之前，
 * 本文件模块图里的 paths 全部指向进程私有临时目录。
 */
vi.mock('./paths', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const root = mkdtempSync(j(tmpdir(), 'repopilot-test-data-'));
  const PATHS = {
    root,
    projects: j(root, 'projects.json'),
    runs: j(root, 'runs'),
    snapshots: j(root, 'snapshots'),
    workspaces: j(root, 'workspaces'),
    artifacts: j(root, 'artifacts'),
    egressLog: j(root, 'egress.jsonl'),
  } as const;
  const ensure = () => {
    for (const d of [PATHS.root, PATHS.runs, PATHS.snapshots, PATHS.workspaces, PATHS.artifacts]) {
      mkdirSync(d, { recursive: true });
    }
  };
  ensure();
  return {
    DATA_ROOT: root,
    PATHS,
    ensureDataRoot: ensure,
    runDir: (id: string) => j(PATHS.runs, id),
    workspaceDir: (id: string) => j(PATHS.workspaces, id),
    snapshotDir: (id: string) => j(PATHS.snapshots, id),
  };
});

import { newId } from '@shared/ids';
import {
  DEFAULT_RETENTION,
  type LiveReferences,
  type RetentionPolicy,
  loadLastSummary,
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

/**
 * 造一个快照目录。`ageMinutes` 把目录的 mtime 相对 NOW 往前拨 ——
 * 快照的回收判据里有宽限期，"多久以前导入的"必须能被测试控制，
 * 否则拿到的永远是真实当下的时间戳（相对固定的 NOW 永远算"新鲜"）。
 */
function mkSnapshot(id: string, ageMinutes = 0): string {
  const dir = snapshotDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.ts'), 'y'.repeat(300), 'utf8');
  const at = new Date(NOW - ageMinutes * 60_000);
  utimesSync(dir, at, at);
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
  runs: Record<string, { terminal: boolean; ageDays: number; snapshotId?: string }>,
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
          snapshotId: r.snapshotId ?? null,
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

  it('刚导入、还没建任务的快照不删 —— 那正是用户准备开工的时刻', () => {
    /*
     * 这条钉住一个真实事故：用户导入项目后跑了一次「立即清理」，
     * 快照因"无 Run 引用"被删，界面还攥着那个 snapshotId，
     * 点「开始」时 cloneTree 抛裸 ENOENT，冒泡成 [core] unhandled。
     * "无 Run 引用"不等于"没人要"——刚导入的快照天然就是这个状态。
     */
    const fresh = mkSnapshot(newId('snap'), 0);
    const s = sweep(refs({}, []), POLICY, NOW);

    const item = s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === fresh)!;
    expect(item.outcome).toBe('KEPT_NOT_DUE');
    expect(item.reason).toContain('宽限期未过');
    expect(existsSync(snapshotDir(fresh))).toBe(true);
  });

  it('无引用且过了宽限期的快照才删掉', () => {
    const snapId = mkSnapshot(newId('snap'), POLICY.workspaceGraceMinutes + 10);
    const s = sweep(refs({}, []), POLICY, NOW);

    expect(s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!.outcome).toBe(
      'DELETED',
    );
    expect(existsSync(snapshotDir(snapId))).toBe(false);
  });

  it('本轮刚被删掉证据的 Run，其独占快照同一轮就回收（不用等下一轮）', () => {
    // 之前 purgedRuns 是只写不读的死变量，注释写着"要扣掉刚删掉的那些 Run"却没扣，
    // 于是这个快照要等 6 小时后的下一轮才回收 —— 而那时它已经没有任何引用者了。
    const snapId = mkSnapshot(newId('snap'), POLICY.workspaceGraceMinutes + 10);
    const oldRun = mkRun(newId('run'));
    const s = sweep(
      refs({ [oldRun]: { terminal: true, ageDays: 400, snapshotId: snapId } }, [snapId]),
      POLICY,
      NOW,
    );

    // 前提：证据确实在本轮被删了，否则下面的断言什么都没验证
    expect(s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === oldRun)!.outcome).toBe(
      'DELETED',
    );
    expect(s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!.outcome).toBe(
      'DELETED',
    );
    expect(existsSync(snapshotDir(snapId))).toBe(false);
  });

  it('快照还被别的存活 Run 引用时，即使一个引用者被清掉也不能删', () => {
    const snapId = mkSnapshot(newId('snap'));
    const oldRun = mkRun(newId('run'));
    const liveRun = mkRun(newId('run'));
    const s = sweep(
      refs(
        {
          [oldRun]: { terminal: true, ageDays: 400, snapshotId: snapId },
          [liveRun]: { terminal: false, ageDays: 0, snapshotId: snapId },
        },
        [snapId],
      ),
      POLICY,
      NOW,
    );

    expect(s.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === oldRun)!.outcome).toBe(
      'DELETED',
    );
    expect(s.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!.outcome).toBe(
      'KEPT_REFERENCED',
    );
    expect(existsSync(snapshotDir(snapId))).toBe(true);
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

  it('某个域整个读不了 → 该域记 FAILED、整体 INCOMPLETE，绝不当成"这个域是空的"', async () => {
    /*
     * 把 artifacts 目录换成一个普通文件：readdir 会抛 ENOTDIR。
     * 之前 listFiles 在这里 `catch { return [] }`，于是 artifacts 一项都没检查，
     * 汇总照样 COMPLETE —— 与 README 自述的"任一失败整体只能 INCOMPLETE"直接矛盾。
     */
    const { rmSync } = await import('node:fs');
    rmSync(PATHS.artifacts, { recursive: true, force: true });
    writeFileSync(PATHS.artifacts, 'not a directory');
    made.push(PATHS.artifacts);
    const id = mkRun(newId('run'));

    const s = sweep(refs({ [id]: { terminal: true, ageDays: 1 } }), POLICY, NOW);

    expect(s.status).toBe('INCOMPLETE');
    expect(s.incompleteReason).toMatch(/删除失败/);
    const failed = s.items.filter((i) => i.outcome === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ domain: 'ARTIFACT', target: PATHS.artifacts });
    expect(failed[0]!.reason).toMatch(/无法枚举该域（ENOTDIR）/);
    // 其他域照常处理：读不了的只是 artifacts，不能连累别的域被跳过
    expect(s.items.some((i) => i.domain === 'RUN_EVIDENCE')).toBe(true);
    // 预演同样如实：读不了就是读不了，不因为"没真删"就假装检查过
    const dry = sweep(refs({ [id]: { terminal: true, ageDays: 1 } }), POLICY, NOW, { dryRun: true });
    expect(dry.status).toBe('INCOMPLETE');
    expect(dry.items.filter((i) => i.outcome === 'FAILED')).toHaveLength(1);
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

/**
 * 预演（dry run）。
 *
 * 在此之前，想知道「立即清理」会删掉什么的唯一办法是**真的删一次**。
 * 预演走的是与真删完全相同的判定路径，只跳过 rmSync —— 所以它给出的不是估算。
 * 这里的每一条都在钉同一件事：判定一致、磁盘不动、结果不可被误当成已执行。
 */
describe('清理预演：算得准，且一个字节都不删', () => {
  /** 造一组必然会被删的东西：终态且过期的 Run + 它的工作区 + 无引用 artifact。 */
  function seedDeletable(): { runId: string; artifactId: string } {
    const runId = mkRun(newId('run'));
    mkWorkspace(runId);
    const artifactId = mkArtifact(newId('art'));
    return { runId, artifactId };
  }

  it('预演不删除任何东西，磁盘保持原样', () => {
    const { runId, artifactId } = seedDeletable();
    const live = refs({ [runId]: { terminal: true, ageDays: 90 } });

    const preview = sweep(live, POLICY, NOW, { dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.items.some((i) => i.outcome === 'WOULD_DELETE')).toBe(true);
    // 负向断言，也是这条测试的全部意义：预演之后磁盘上的东西一个都不能少。
    expect(existsSync(workspaceDir(runId))).toBe(true);
    expect(existsSync(runDir(runId))).toBe(true);
    expect(existsSync(join(PATHS.artifacts, `${artifactId}.txt`))).toBe(true);
  });

  it('预演里没有 DELETED，真删里没有 WOULD_DELETE —— 两者不可能被混淆', () => {
    const { runId } = seedDeletable();
    const live = refs({ [runId]: { terminal: true, ageDays: 90 } });

    const preview = sweep(live, POLICY, NOW, { dryRun: true });
    expect(preview.items.some((i) => i.outcome === 'DELETED')).toBe(false);

    const real = sweep(live, POLICY, NOW);
    expect(real.dryRun).toBe(false);
    expect(real.items.some((i) => i.outcome === 'WOULD_DELETE')).toBe(false);
  });

  it('预演的判定与真删逐项一致 —— 它不是另一套规则', () => {
    const { runId } = seedDeletable();
    const live = refs({ [runId]: { terminal: true, ageDays: 90 } });

    const preview = sweep(live, POLICY, NOW, { dryRun: true });
    const real = sweep(live, POLICY, NOW);

    const shape = (s: typeof preview) =>
      s.items
        .map((i) => `${i.domain}:${i.target}:${i.outcome === 'WOULD_DELETE' ? 'DELETED' : i.outcome}`)
        .sort();
    expect(shape(preview)).toEqual(shape(real));
    // 体积也要对得上：预演报的"将释放"就是真删释放的那些字节。
    expect(preview.bytesFreed).toBe(real.bytesFreed);
    expect(preview.deleted).toBe(real.deleted);
  });

  /*
   * 级联回收：删掉 Run 证据会让「只被它引用的快照」在同一轮里失去最后一个引用者。
   * 预演必须把这一级也算进去 —— 只认 DELETED 的话，预演会把那些快照报成
   * KEPT_REFERENCED，于是预览说删 N 项、真跑删 N+1 项。
   * 一个会少报的预览比没有预览更糟：用户是照着它按下确认的。
   */
  it('预演算得出级联删除的快照，不会少报', () => {
    const runId = mkRun(newId('run'));
    const snapId = mkSnapshot(newId('snap'), 10_000); // 远超宽限期
    const live: LiveReferences = {
      runs: new Map([
        [runId, { terminal: true, terminalAt: NOW - 90 * DAY, updatedAt: NOW - 90 * DAY, snapshotId: snapId }],
      ]),
      snapshots: new Set([snapId]),
      artifacts: new Set<string>(),
    };

    const preview = sweep(live, POLICY, NOW, { dryRun: true });
    const snapshotItem = preview.items.find((i) => i.domain === 'SNAPSHOT' && i.target === snapId)!;
    expect(snapshotItem.outcome).toBe('WOULD_DELETE');

    const real = sweep(live, POLICY, NOW);
    expect(preview.deleted).toBe(real.deleted);
    expect(preview.bytesFreed).toBe(real.bytesFreed);
  });

  it('预演不覆盖上一次真实清理的记录', () => {
    const { runId } = seedDeletable();
    const live = refs({ [runId]: { terminal: true, ageDays: 90 } });

    // 先跑一次真删，它会把汇总写进 last-purge.json。
    const real = sweep(live, POLICY, NOW);
    const stored = loadLastSummary();
    expect(stored?.dryRun).toBe(false);
    expect(stored?.deleted).toBe(real.deleted);

    // 再预演一次：last-purge.json 必须原封不动。
    sweep(refs({}), POLICY, NOW, { dryRun: true });

    const after = loadLastSummary();
    /*
     * 负向断言：无条件写 last-purge.json 时，这里会读到一份 dryRun 的空汇总 ——
     * 既是预演的副作用，也把用户真实的上一次清理记录销毁了。
     */
    expect(after?.dryRun).toBe(false);
    expect(after?.startedAt).toBe(stored?.startedAt);
    expect(after?.deleted).toBe(real.deleted);
  });

  it('预演可以用一份尚未保存的策略，且不写盘', () => {
    const runId = mkRun(newId('run'));
    mkWorkspace(runId);
    // 10 天前进入终态：默认 30 天保留期下不该删。
    const live = refs({ [runId]: { terminal: true, ageDays: 10 } });

    const kept = sweep(live, POLICY, NOW, { dryRun: true });
    expect(
      kept.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === runId)!.outcome,
    ).toBe('KEPT_NOT_DUE');

    // 把保留期收紧到 5 天来预演：同一份数据，结论应当变成"会删"。
    const tightened = sweep(live, { ...POLICY, evidenceDays: 5 }, NOW, { dryRun: true });
    expect(
      tightened.items.find((i) => i.domain === 'RUN_EVIDENCE' && i.target === runId)!.outcome,
    ).toBe('WOULD_DELETE');
    // 预演一个还没决定要不要保存的策略，不该产生任何持久化后果。
    expect(existsSync(runDir(runId))).toBe(true);
  });
});
