import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PatchArtifact, RunStatus, RunView } from '@shared/domain';
import { EMPTY_LEDGER, TERMINAL_RUN_STATUSES } from '@shared/domain';
import { newId, nowIso } from '@shared/ids';
import {
  RUN_STATE_SCHEMA_VERSION,
  type PersistedRunState,
  listPersistedRunIds,
  readRunState,
  writeRunState,
} from './persistence';
import { EventStore } from './store';
import { PATHS, ensureDataRoot, runDir } from './paths';

/**
 * Run 事实的落盘与恢复。
 *
 * 这一层要证明的核心命题是：**写了的日志必须读得回来**。
 * 在此之前 events.jsonl 是只写不读的 —— 写了不能读的日志，不叫证据。
 */

const created: string[] = [];

function makeView(status: RunStatus, runId = newId('run')): RunView {
  return {
    runId,
    taskId: newId('task'),
    projectId: 'proj_x',
    title: '修复构建失败',
    attemptId: newId('att'),
    attemptNo: 1,
    status,
    statusReason: null,
    ledger: { ...EMPTY_LEDGER, modelTurns: 3, toolCalls: 7 },
    limits: {
      maxModelTurns: 40,
      maxToolCalls: 80,
      maxSelfFixRounds: 2,
      maxWallClockMs: 600_000,
      maxTotalTokens: 100_000,
    },
    workspaceGeneration: 2,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    terminalFacts: null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function makeState(view: RunView, overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    view,
    task: { taskId: view.taskId, goal: '修复构建失败' } as never,
    snapshot: { snapshotId: 'snap_x', baseSha: 'abc123', subPath: '' } as never,
    profile: { profileId: 'prof_x', commands: {} } as never,
    toolCalls: [],
    verifications: [],
    plan: null,
    patch: null,
    eventHighWatermark: 0,
    persistedAt: nowIso(),
    ...overrides,
  };
}

beforeEach(() => ensureDataRoot());

afterEach(() => {
  for (const runId of created) rmSync(runDir(runId), { recursive: true, force: true });
  created.length = 0;
});

function track(runId: string): string {
  created.push(runId);
  return runId;
}

describe('状态快照读写', () => {
  it('写进去的能原样读回来', () => {
    const view = makeView('SUCCEEDED');
    track(view.runId);
    writeRunState(makeState(view));

    const loaded = readRunState(view.runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.state.view.runId).toBe(view.runId);
      expect(loaded.state.view.status).toBe('SUCCEEDED');
      expect(loaded.state.view.ledger.toolCalls).toBe(7);
    }
  });

  it('补丁正文必须完整落盘 —— 事件流里没有 unifiedDiff', () => {
    const view = makeView('AWAITING_PATCH_REVIEW');
    track(view.runId);
    const patch = {
      patchId: 'patch_1',
      runId: view.runId,
      unifiedDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      files: [{ path: 'src/a.ts' }],
      digest: 'sha256:deadbeef',
    } as unknown as PatchArtifact;

    writeRunState(makeState(view, { patch }));

    const loaded = readRunState(view.runId);
    expect(loaded.ok).toBe(true);
    // 这是重启后还能导出补丁的前提
    if (loaded.ok) expect(loaded.state.patch!.unifiedDiff).toContain('+new');
  });

  it('目录被扫描到就算存在，不看内容好坏', () => {
    const view = makeView('FAILED');
    track(view.runId);
    writeRunState(makeState(view));
    expect(listPersistedRunIds()).toContain(view.runId);
  });
});

describe('损坏的状态快照不能让 Run 凭空消失', () => {
  it('JSON 坏了 → 报明确原因，不是静默 fallback', () => {
    const runId = track(newId('run'));
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(join(runDir(runId), 'state.json'), '{ 这不是合法 JSON', 'utf8');

    const loaded = readRunState(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/解析失败/);
    // 关键：目录还在，所以这个 Run 仍然会被列出来
    expect(listPersistedRunIds()).toContain(runId);
  });

  it('缺 schemaVersion → 拒绝，不猜', () => {
    const runId = track(newId('run'));
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(join(runDir(runId), 'state.json'), JSON.stringify({ view: { runId } }), 'utf8');

    const loaded = readRunState(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/schemaVersion/);
  });

  it('版本高于本程序 → 拒绝，不按旧格式硬读', () => {
    const view = makeView('SUCCEEDED');
    track(view.runId);
    writeRunState({ ...makeState(view), schemaVersion: RUN_STATE_SCHEMA_VERSION + 1 });

    const loaded = readRunState(view.runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/高于本程序支持/);
  });

  it('缺关键字段 → 拒绝', () => {
    const runId = track(newId('run'));
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(
      join(runDir(runId), 'state.json'),
      JSON.stringify({ schemaVersion: 1, view: { runId } }),
      'utf8',
    );
    const loaded = readRunState(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/缺少必需字段/);
  });
});

describe('事件流与状态快照的一致性', () => {
  it('lastSeq 反映真实水位', () => {
    const runId = track(newId('run'));
    const events = new EventStore(runId);
    expect(events.lastSeq()).toBe(0);
    events.append('att_1', 'RUN_CREATED', '任务已创建：x');
    events.append('att_1', 'STATUS_CHANGED', 'CREATED → PLANNING');
    expect(events.lastSeq()).toBe(2);
  });

  it('事件比状态新时能被检测出来（崩溃落在两次写之间）', () => {
    const view = makeView('EXECUTING');
    track(view.runId);
    const events = new EventStore(view.runId);
    events.append(view.attemptId, 'RUN_CREATED', '任务已创建：x');
    writeRunState(makeState(view, { eventHighWatermark: events.lastSeq() }));

    // 模拟：又写了两条事件，但还没来得及 persist 状态就挂了
    events.append(view.attemptId, 'TOOL_CALL_PROPOSED', 'fs_read');
    events.append(view.attemptId, 'TOOL_CALL_RESOLVED', 'fs_read → SUCCEEDED');

    const loaded = readRunState(view.runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const reloaded = new EventStore(view.runId);
      expect(reloaded.lastSeq()).toBeGreaterThan(loaded.state.eventHighWatermark);
    }
  });

  it('事件日志可跨实例读回 —— 这是整个改动的立足点', () => {
    const runId = track(newId('run'));
    const writer = new EventStore(runId);
    writer.append('att_1', 'RUN_CREATED', '任务已创建：修复构建失败');
    writer.append('att_1', 'PATCH_SEALED', '补丁已封存：1 个文件');

    // 全新实例，模拟进程重启
    const reader = new EventStore(runId);
    const all = reader.all();
    expect(all).toHaveLength(2);
    expect(all[0]!.summary).toContain('修复构建失败');
    expect(reader.after(1)).toHaveLength(1);
  });
});

describe('中断终态的语义', () => {
  it('INTERRUPTED 是终态', () => {
    expect(TERMINAL_RUN_STATUSES).toContain('INTERRUPTED');
  });

  it('AWAITING_PATCH_REVIEW 不是终态 —— 它要能跨重启继续被决定', () => {
    expect(TERMINAL_RUN_STATUSES).not.toContain('AWAITING_PATCH_REVIEW');
  });

  it.each<[RunStatus, boolean]>([
    ['CREATED', true],
    ['PLANNING', true],
    ['AWAITING_PLAN_APPROVAL', true],
    ['EXECUTING', true],
    ['VERIFYING', true],
    ['AWAITING_PATCH_REVIEW', false], // 补丁已封存，接受是纯状态转换，不需要执行器
    ['SUCCEEDED', false],
    ['FAILED', false],
    ['CANCELLED', false],
  ])('%s 重启后是否应落成 INTERRUPTED = %s', (status, shouldClose) => {
    const isTerminalStatus = TERMINAL_RUN_STATUSES.includes(status);
    const willClose = !isTerminalStatus && status !== 'AWAITING_PATCH_REVIEW';
    expect(willClose).toBe(shouldClose);
  });
});

describe('数据根布局', () => {
  it('state.json 与 events.jsonl 在同一个 Run 目录下', () => {
    const view = makeView('SUCCEEDED');
    track(view.runId);
    const events = new EventStore(view.runId);
    events.append(view.attemptId, 'RUN_CREATED', 'x');
    writeRunState(makeState(view));

    expect(existsSync(join(runDir(view.runId), 'state.json'))).toBe(true);
    expect(existsSync(join(runDir(view.runId), 'events.jsonl'))).toBe(true);
    expect(runDir(view.runId).startsWith(PATHS.runs)).toBe(true);
  });

  it('state.json 是原子写：不会看到半个文件', () => {
    const view = makeView('SUCCEEDED');
    track(view.runId);
    writeRunState(makeState(view));
    // writeJsonAtomic 走 write-temp → rename，落地后不该残留 .tmp
    expect(existsSync(join(runDir(view.runId), 'state.json.tmp'))).toBe(false);
    expect(() => JSON.parse(readFileSync(join(runDir(view.runId), 'state.json'), 'utf8'))).not.toThrow();
  });
});
