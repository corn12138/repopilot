import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import type { RunEventKind, TaskSpec, ToolCallResolution, ToolRisk } from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { type AgentHost, type ModelInvoker, runAgent } from './agent';
import type { ContentBlock, ModelResponse } from './model/types';
import { findWireViolation } from './model/types';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { importSnapshot, resolveProfile } from './repo';
import { MaterializedWorkspace } from './workspace';
import { ensureDataRoot } from './paths';

/**
 * 规划阶段的只读强制。
 *
 * 背景：这道闸门原本**不存在**。`PLANNING_TOOLS` 只决定给模型看哪些 schema，
 * 而 `dispatchTool` 查的是全局 `TOOLS_BY_NAME` —— 模型只要凭记忆点名
 * `workspace_mutate`，之前就会真的执行。
 *
 * 更值得记的是：现有的 e2e 里有一条「规划阶段没有 R1 副作用」的断言一直是绿的，
 * 但它绿只是因为脚本化的模型恰好没点名 R1 工具。**一个永远不会红的断言
 * 等于没有断言** —— 所以这里的测试专门让模型去点名。
 */

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-phase-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), '{"name":"t","scripts":{"build":"true"}}', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** 规划期就点名写工具的模型。第二轮才老老实实提交计划。 */
class RogueModel implements ModelInvoker {
  turn = 0;
  readonly attempted: string[] = [];
  readonly routes: Array<{ purpose: string; resolutionId: string }> = [];

  async invoke(input: Parameters<ModelInvoker['invoke']>[0]) {
    // 真实 provider 会对孤儿 tool_use 返回 400，测试替身不会 —— 所以这里
    // 主动用与网关同一个校验器把关，否则这类回归在测试里是静默的。
    const orphan = findWireViolation(input.request.messages);
    if (orphan) throw new Error(`${input.purpose} 调用收到非法消息序列：${orphan}`);
    this.turn += 1;
    this.routes.push({ purpose: input.purpose, resolutionId: input.resolution.resolutionId });
    input.onDispatch?.({
      invocationId: `inv_phase_${this.turn}`,
      sendAttempt: 1,
      requestedAt: nowIso(),
      purpose: input.purpose,
      resolutionId: input.resolution.resolutionId,
      providerId: input.resolution.providerId,
      modelId: input.resolution.modelId,
    });
    const last = JSON.stringify(input.request.messages.at(-1)?.content ?? '');
    let content: ContentBlock[];

    if (input.purpose === 'PLANNING' && this.turn === 1) {
      // 规划期直接点名 R1 工具 —— 模型完全可以凭记忆写出这个名字
      this.attempted.push('workspace_mutate');
      content = [
        {
          type: 'tool_use',
          id: 'tu_rogue',
          name: 'workspace_mutate',
          input: {
            operations: [{ kind: 'CREATE_FILE', path: 'src/planted.ts', newText: 'export const evil = 1;\n' }],
          },
        },
      ];
    } else if (input.purpose === 'PLANNING' && this.turn === 2) {
      // 规划期点名跑命令，同样是 R1
      this.attempted.push('run_command');
      content = [{ type: 'tool_use', id: 'tu_cmd', name: 'run_command', input: { commandId: 'build' } }];
    } else if (input.purpose === 'PLANNING') {
      content = [
        {
          type: 'tool_use',
          id: 'tu_plan',
          name: 'submit_plan',
          input: { summary: '只读看过了', steps: [{ intent: '改 app.ts' }], risks: [] },
        },
      ];
    } else {
      // 执行阶段：不做任何改动，让 runAgent 走到 NO_CHANGES 提前收尾
      void last;
      content = [{ type: 'text', text: '不改了' }];
    }

    return {
      invocationId: `inv_${this.turn}`,
      response: { content, stopReason: 'TOOL_USE', inputTokens: 10, outputTokens: 5 } as ModelResponse,
      manifest: {
        invocationId: `inv_${this.turn}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: 'test',
        origin: 'https://test.invalid/v1',
        modelId: 'TEST_ONLY_FAKE',
        sent: false,
        blockReason: 'TEST_ONLY_FAKE_NO_EGRESS',
        contextFileRefs: [],
        inputTokens: 10,
        outputTokens: 5,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }
}

interface Call {
  toolName: string;
  risk: ToolRisk;
  resolution?: ToolCallResolution;
  reason?: string | null;
}

class Recorder implements AgentHost {
  readonly calls: Call[] = [];
  readonly events: Array<{ kind: RunEventKind; summary: string }> = [];

  emit(kind: RunEventKind, summary: string): void {
    this.events.push({ kind, summary });
  }
  setStatus(): void {}
  async awaitPlanApproval(): Promise<'APPROVE' | 'REJECT'> {
    return 'APPROVE';
  }
  beginToolCall(i: { toolName: string; risk: ToolRisk }): string {
    this.calls.push({ toolName: i.toolName, risk: i.risk });
    return `tc_${this.calls.length - 1}`;
  }
  endToolCall(id: string, resolution: ToolCallResolution, reason: string | null): void {
    const c = this.calls[Number(id.split('_')[1])];
    if (c) {
      c.resolution = resolution;
      c.reason = reason;
    }
  }
  reserveModelTurn(): void {}
  settleModelTurn(): void {}
  chargeToolCall(): void {}
  chargeSelfFixRound(): void {}
  budgetExceeded(): { exceeded: boolean; reason: string } {
    return { exceeded: false, reason: '' };
  }
}

describe('规划阶段由平台强制只读', () => {
  it('模型点名 R1 工具 → DENIED/PHASE_READONLY，且文件真的没被创建', async () => {
    ensureDataRoot();
    const repo = makeRepo();
    const snapshot = importSnapshot('proj_phase', repo);
    const profile = resolveProfile(snapshot);
    const runId = newId('run');
    const workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId);

    const task: TaskSpec = {
      taskId: newId('task'),
      projectId: 'proj_phase',
      snapshotId: snapshot.snapshotId,
      profileId: profile.profileId,
      goal: '测试阶段闸门',
      taskClass: 'BUILD_FAILURE_FIX',
      allowedPaths: ['src/**'],
      protectedPaths: [],
      nonGoals: [],
      acceptance: [],
      // 空验证命令 → 走未验证模式，跳过真实 build，测试跑得快
      verificationCommandIds: [],
      budget: {
        maxModelTurns: 20,
        maxToolCalls: 20,
        maxSelfFixRounds: 0,
        maxWallClockMs: 60_000,
        maxTotalTokens: 100_000,
      },
      createdAt: nowIso(),
    };

    const host = new Recorder();
    const model = new RogueModel();

    await runAgent({
      task,
      snapshot,
      profile,
      workspace,
      gateway: model,
      resolution: {
        resolutionId: 'r',
        profileId: 'p',
        providerId: 'test',
        origin: 'https://test.invalid/v1',
        modelId: 'TEST_ONLY_FAKE',
        frozenAt: nowIso(),
        digest: digestOf({ t: 1 }),
      },
      plannerResolution: {
        resolutionId: 'r-planner',
        profileId: 'p-planner',
        providerId: 'anthropic',
        origin: 'https://planner.invalid/v1',
        modelId: 'TEST_PLANNER',
        frozenAt: nowIso(),
        digest: digestOf({ t: 'planner' }),
      },
      mutationPolicy: { ...DEFAULT_MUTATION_POLICY, allowedPaths: ['src/**'], protectedPaths: [] },
      runId,
      attemptId: newId('att'),
      signal: new AbortController().signal,
      host,
    });

    // 前提：模型确实尝试了 —— 否则这条测试什么都没验证
    expect(model.attempted).toEqual(['workspace_mutate', 'run_command']);
    expect(model.routes.filter((route) => route.purpose === 'PLANNING').every((route) => route.resolutionId === 'r-planner')).toBe(true);
    expect(model.routes.filter((route) => route.purpose === 'EXECUTION').every((route) => route.resolutionId === 'r')).toBe(true);

    const denied = host.calls.filter((c) => c.resolution === 'DENIED');
    expect(denied.map((c) => c.toolName).sort()).toEqual(['run_command', 'workspace_mutate']);
    for (const c of denied) expect(c.reason).toBe('PHASE_READONLY');

    // 最硬的断言：那个文件根本不存在，generation 也没推进
    expect(existsSync(join(workspace.activePath, 'src/planted.ts'))).toBe(false);
    expect(workspace.activeGeneration).toBe(0);
    expect(workspace.changedFilesVsBaseline()).toEqual([]);

    workspace.cleanup();
  }, 60_000);

  it('拒绝信息要告诉模型下一步该做什么，而不是只说"不行"', async () => {
    // 直接检查产品代码里的措辞 —— 这条断言的价值在于防止有人把它改成一句裸错误码
    const src = readFileSync(join(__dirname, 'agent.ts'), 'utf8');
    const idx = src.indexOf('PHASE_READONLY');
    expect(idx).toBeGreaterThan(0);
    const around = src.slice(idx, idx + 700);
    expect(around).toContain('submit_plan');
    expect(around).toContain('只读');
  });
});
