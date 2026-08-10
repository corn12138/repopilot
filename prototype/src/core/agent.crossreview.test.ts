import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ModelRouteResolution,
  PatchArtifact,
  RunEventKind,
  RunStatus,
  TaskSpec,
  ToolCallResolution,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import {
  runReviewPass,
  type AgentDeps,
  type AgentHost,
  type ModelInvoker,
} from './agent';
import type { ContentBlock, ModelResponse } from './model/types';
import { findWireViolation } from './model/types';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { resolveManaged, type MaterializedWorkspace } from './workspace';

/**
 * 交叉审核只读通道（runReviewPass）的机器证据：
 *   - 审核方只能通过 submit_review 产出发现；写工具在 REVIEW phase 被平台拒绝
 *   - 发现的 fingerprint 由平台按 (severity,file,range,evidence) 计算，不信任模型自报
 *   - 审核"通过/有发现"如实映射成 CrossReviewRound；reviewedPatchDigest = 补丁 digest
 */

let dir: string;

/** 极简只读工作区替身：fs_read 需要它能定位到真实临时文件 */
class ReviewWorkspace {
  activeGeneration = 1;
  constructor(readonly activePath: string) {}
  exists(rel: string): boolean {
    try {
      return existsSync(this.resolveInActive(rel));
    } catch {
      return false;
    }
  }
  readText(rel: string): string {
    return readFileSync(this.resolveInActive(rel), 'utf8');
  }
  resolveInActive(rel: string): string {
    return resolveManaged(this.activePath, rel);
  }
  issueReceipt(rel: string): { content: string; receipt: unknown } {
    return { content: this.readText(rel), receipt: { receiptId: 'rcpt', path: rel } };
  }
}

function asWorkspace(w: ReviewWorkspace): MaterializedWorkspace {
  return w as unknown as MaterializedWorkspace;
}

class ReviewHost implements AgentHost {
  readonly events: Array<{ kind: RunEventKind; summary: string }> = [];
  readonly toolCalls: Array<{ toolName: string; resolution: ToolCallResolution | null; reason: string | null }> = [];
  modelTurns = 0;

  emit(kind: RunEventKind, summary: string): void {
    this.events.push({ kind, summary });
  }
  setStatus(): void {}
  async awaitPlanApproval(): Promise<'APPROVE' | 'REJECT'> {
    throw new Error('审核阶段不该请求计划审批');
  }
  beginToolCall(input: { toolName: string }): string {
    this.toolCalls.push({ toolName: input.toolName, resolution: null, reason: null });
    return `tc_${this.toolCalls.length - 1}`;
  }
  endToolCall(id: string, resolution: ToolCallResolution, reason: string | null): void {
    const c = this.toolCalls[Number(id.slice(3))]!;
    c.resolution = resolution;
    c.reason = reason;
  }
  chargeModelTurn(): void {
    this.modelTurns += 1;
  }
  chargeToolCall(): void {}
  chargeSelfFixRound(): void {}
  budgetExceeded(): { exceeded: boolean; reason: string } {
    return { exceeded: false, reason: '' };
  }
}

const RESOLUTION: ModelRouteResolution = {
  resolutionId: 'route_reviewer',
  profileId: 'profile_reviewer',
  providerId: 'openai',
  origin: 'https://api.openai.com/v1',
  modelId: 'reviewer-model',
  frozenAt: nowIso(),
  digest: digestOf({ reviewer: true }),
};

function toolUse(name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 7)}`, name, input }],
    stopReason: 'TOOL_USE',
    inputTokens: 10,
    outputTokens: 5,
  };
}

/** 按脚本回应的审核方替身；同时用 findWireViolation 守住消息序列合法性（孤儿 tool_use + role 交替）*/
class ScriptedReviewer implements ModelInvoker {
  turn = 0;
  constructor(private readonly script: (turn: number) => ModelResponse) {}
  async invoke(input: Parameters<ModelInvoker['invoke']>[0]) {
    this.turn += 1;
    const orphan = findWireViolation(input.request.messages);
    if (orphan) throw new Error(`审核方收到非法消息序列：${orphan}`);
    const response = this.script(this.turn);
    return {
      invocationId: `inv_${this.turn}`,
      response,
      manifest: {
        invocationId: `inv_${this.turn}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: input.resolution.providerId,
        origin: input.resolution.origin,
        modelId: 'reviewer-model',
        sent: false,
        blockReason: 'TEST_ONLY',
        contextFileRefs: [] as readonly string[],
        inputTokens: 10,
        outputTokens: 5,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }
}

function makeDeps(gateway: ModelInvoker, host: ReviewHost): AgentDeps {
  const ws = new ReviewWorkspace(dir);
  return {
    task: {
      taskId: 'task_1',
      projectId: 'proj_1',
      snapshotId: 'snap_1',
      profileId: 'profile_1',
      goal: '修复 build 失败',
      taskClass: 'BUILD_FAILURE_FIX',
      allowedPaths: ['src/**'],
      protectedPaths: ['package.json'],
      nonGoals: ['不要动 pricing 的公开签名'],
      acceptance: ['build 通过'],
      verificationCommandIds: ['build'],
      budget: {
        maxModelTurns: 40,
        maxToolCalls: 80,
        maxSelfFixRounds: 2,
        maxWallClockMs: 600_000,
        maxTotalTokens: 600_000,
      },
      createdAt: nowIso(),
    } as TaskSpec,
    snapshot: { snapshotId: 'snap_1', baseSha: 'abc', baseKind: 'CLEAN' } as never,
    profile: { adapterId: 'node', packageManager: 'npm', commands: {} } as never,
    workspace: asWorkspace(ws),
    gateway,
    resolution: RESOLUTION,
    mutationPolicy: { ...DEFAULT_MUTATION_POLICY, allowedPaths: ['src/**'], protectedPaths: ['package.json'] },
    runId: 'run_1',
    attemptId: 'att_1',
    signal: new AbortController().signal,
    host,
  };
}

const PATCH: PatchArtifact = {
  patchId: 'patch_1',
  runId: 'run_1',
  attemptId: 'att_1',
  baseSha: 'abc',
  generation: 1,
  files: [{ path: 'src/app.ts', changeKind: 'MODIFIED', addedLines: 1, removedLines: 1, diffTruncated: false }] as never,
  unifiedDiff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const a=1\n+const a=2\n',
  digest: 'sha256:patchdigest',
  sealedAt: nowIso(),
  verificationRunId: 'ver_1',
  comparison: null,
  unverifiedItems: [],
  excludedGeneratedFiles: [],
};

const VERIFICATION: VerificationRun = {
  verificationRunId: 'ver_1',
  runId: 'run_1',
  attemptId: 'att_1',
  phase: 'POST_MUTATION',
  generation: 1,
  commands: [{ commandId: 'build', outcome: 'EXIT_ZERO' }] as never,
  passed: true,
  startedAt: nowIso(),
  finishedAt: nowIso(),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repopilot-review-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.ts'), 'const a=2\n', 'utf8');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runReviewPass', () => {
  it('审核方直接提交发现 → 映射成 CrossReviewRound，fingerprint 由平台计算', async () => {
    const host = new ReviewHost();
    const gateway = new ScriptedReviewer(() =>
      toolUse('submit_review', {
        verdict: 'CHANGES_REQUESTED',
        findings: [
          {
            severity: 'HIGH',
            confidence: 0.9,
            file: 'src/app.ts',
            startLine: 1,
            endLine: 1,
            evidence: 'a 被改成 2 但没有对应测试',
            blocking: true,
            // 模型自报一个假 fingerprint —— 必须被平台忽略
            fingerprint: 'MODEL_SUPPLIED_FAKE',
          },
        ],
      }),
    );

    const round = await runReviewPass(makeDeps(gateway, host), {
      reviewerResolution: RESOLUTION,
      patch: PATCH,
      finalVerification: VERIFICATION,
      round: 1,
    });

    expect(round.verdict).toBe('CHANGES_REQUESTED');
    expect(round.reviewedPatchDigest).toBe('sha256:patchdigest');
    expect(round.reviewerResolutionId).toBe('route_reviewer');
    expect(round.findings).toHaveLength(1);
    const f = round.findings[0]!;
    expect(f.severity).toBe('HIGH');
    expect(f.blocking).toBe(true);
    expect(f.range).toEqual([1, 1]);
    // 平台计算的 fingerprint，绝不是模型自报的那个
    expect(f.fingerprint).not.toBe('MODEL_SUPPLIED_FAKE');
    expect(f.fingerprint).toBe(
      digestOf({ severity: 'HIGH', file: 'src/app.ts', range: [1, 1], evidence: 'a 被改成 2 但没有对应测试' }),
    );
    expect(host.events.some((e) => e.kind === 'CROSS_REVIEW_ROUND')).toBe(true);
  });

  it('审核方 PASS 且无发现 → verdict PASS，findings 为空', async () => {
    const host = new ReviewHost();
    const gateway = new ScriptedReviewer(() =>
      toolUse('submit_review', { verdict: 'PASS', findings: [] }),
    );
    const round = await runReviewPass(makeDeps(gateway, host), {
      reviewerResolution: RESOLUTION,
      patch: PATCH,
      finalVerification: VERIFICATION,
      round: 1,
    });
    expect(round.verdict).toBe('PASS');
    expect(round.findings).toEqual([]);
  });

  it('审核方试图写工作区 → 被平台以 PHASE_READONLY 拒绝，然后才提交发现', async () => {
    const host = new ReviewHost();
    const gateway = new ScriptedReviewer((turn) => {
      if (turn === 1) {
        // 审核方越权点名写工具 —— 必须被拒
        return toolUse('workspace_mutate', {
          operations: [{ kind: 'CREATE_FILE', path: 'src/evil.ts', newText: 'x' }],
        });
      }
      return toolUse('submit_review', { verdict: 'PASS', findings: [] });
    });

    const round = await runReviewPass(makeDeps(gateway, host), {
      reviewerResolution: RESOLUTION,
      patch: PATCH,
      finalVerification: VERIFICATION,
      round: 1,
    });

    const denied = host.toolCalls.find((c) => c.toolName === 'workspace_mutate');
    expect(denied).toBeDefined();
    expect(denied!.resolution).toBe('DENIED');
    expect(denied!.reason).toBe('PHASE_READONLY');
    // 被拒后审核方仍走到提交结论
    expect(round.verdict).toBe('PASS');
    // 且工作区里那个恶意文件根本不存在
    expect(existsSync(join(dir, 'src/evil.ts'))).toBe(false);
  });

  it('审核方只读读取补丁文件是允许的（fs_read 走 R0）', async () => {
    const host = new ReviewHost();
    const gateway = new ScriptedReviewer((turn) => {
      if (turn === 1) return toolUse('fs_read', { path: 'src/app.ts' });
      return toolUse('submit_review', { verdict: 'PASS', findings: [] });
    });
    const round = await runReviewPass(makeDeps(gateway, host), {
      reviewerResolution: RESOLUTION,
      patch: PATCH,
      finalVerification: VERIFICATION,
      round: 1,
    });
    const read = host.toolCalls.find((c) => c.toolName === 'fs_read');
    expect(read!.resolution).toBe('SUCCEEDED');
    expect(round.verdict).toBe('PASS');
  });

  it('用满轮次未提交 → INCONCLUSIVE，不编造发现', async () => {
    const host = new ReviewHost();
    // 每轮只回文本，从不 submit_review
    const gateway: ModelInvoker = {
      async invoke(input) {
        const orphan = findWireViolation(input.request.messages);
        if (orphan) throw new Error(orphan);
        return {
          invocationId: 'inv',
          response: { content: [{ type: 'text', text: '我还在看' }], stopReason: 'END_TURN', inputTokens: 1, outputTokens: 1 },
          manifest: {
            invocationId: 'inv',
            runId: input.runId,
            attemptId: input.attemptId,
            purpose: input.purpose,
            resolutionId: input.resolution.resolutionId,
            providerId: input.resolution.providerId,
            origin: input.resolution.origin,
            modelId: 'reviewer-model',
            sent: false,
            blockReason: 'TEST_ONLY',
            contextFileRefs: [] as readonly string[],
            inputTokens: 1,
            outputTokens: 1,
            requestedAt: nowIso(),
            settledAt: nowIso(),
            errorKind: null,
          },
        };
      },
    };
    const round = await runReviewPass(makeDeps(gateway, host), {
      reviewerResolution: RESOLUTION,
      patch: PATCH,
      finalVerification: VERIFICATION,
      round: 1,
    });
    expect(round.verdict).toBe('INCONCLUSIVE');
    expect(round.findings).toEqual([]);
  });
});
