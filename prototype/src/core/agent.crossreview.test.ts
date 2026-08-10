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
  AgentCancelled,
  runCrossReviewCycle,
  runRemediationPass,
  runReviewPass,
  type AgentDeps,
  type AgentHost,
  type CrossReviewCycleHooks,
  type ModelInvoker,
} from './agent';
import { EgressBlocked } from './model/gateway';
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
  /** 达到该轮次数后报"预算耗尽"；null = 永不耗尽（默认，既有用例不受影响） */
  exceedAfterTurns: number | null = null;
  budgetExceeded(): { exceeded: boolean; reason: string } {
    const exceeded = this.exceedAfterTurns !== null && this.modelTurns >= this.exceedAfterTurns;
    return { exceeded, reason: exceeded ? `测试预算：模型轮次已达 ${this.modelTurns}` : '' };
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

function makeDeps(
  gateway: ModelInvoker,
  host: ReviewHost,
  resolution: ModelRouteResolution = RESOLUTION,
): AgentDeps {
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
    resolution,
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

// ---------------------------------------------------------------------------
// 收敛循环（runCrossReviewCycle）：审核 → 整改 → 重验 → 重封存 → 再审
// ---------------------------------------------------------------------------

const IMPLEMENTER: ModelRouteResolution = {
  resolutionId: 'route_implementer',
  profileId: 'profile_implementer',
  providerId: 'anthropic',
  origin: 'https://api.anthropic.com/v1',
  modelId: 'implementer-model',
  frozenAt: nowIso(),
  digest: digestOf({ implementer: true }),
};

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }], stopReason: 'END_TURN', inputTokens: 3, outputTokens: 2 };
}

/**
 * 双角色替身：按 purpose 分流。CROSS_REVIEW → 审核方脚本；其余（整改的 EXECUTION）
 * → 实现方脚本。顺带记录每次调用的 purpose 与 resolutionId —— "整改必须走实现方
 * route、审核必须走审核方 route" 靠这两份审计断言，不靠脚本自觉。
 */
class ScriptedDuo implements ModelInvoker {
  reviewTurn = 0;
  execTurn = 0;
  readonly purposes: string[] = [];
  readonly resolutionIds: string[] = [];
  readonly execBriefs: string[] = [];
  constructor(
    private readonly review: (turn: number) => ModelResponse,
    private readonly exec: (turn: number) => ModelResponse = () => textResponse('（实现方结束回合）'),
  ) {}
  async invoke(input: Parameters<ModelInvoker['invoke']>[0]) {
    const orphan = findWireViolation(input.request.messages);
    if (orphan) throw new Error(`非法消息序列：${orphan}`);
    this.purposes.push(input.purpose);
    this.resolutionIds.push(input.resolution.resolutionId);
    const isReview = input.purpose === 'CROSS_REVIEW';
    if (!isReview) {
      const first = input.request.messages[0]?.content.find((b) => b.type === 'text');
      this.execBriefs.push(first && 'text' in first ? first.text : '');
    }
    const response = isReview ? this.review(++this.reviewTurn) : this.exec(++this.execTurn);
    return {
      invocationId: `inv_${this.purposes.length}`,
      response,
      manifest: {
        invocationId: `inv_${this.purposes.length}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: input.resolution.providerId,
        origin: input.resolution.origin,
        modelId: input.resolution.modelId,
        sent: false,
        blockReason: 'TEST_ONLY',
        contextFileRefs: [] as readonly string[],
        inputTokens: 3,
        outputTokens: 2,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }
}

const submitReview = (verdict: 'PASS' | 'CHANGES_REQUESTED' | 'INCONCLUSIVE', findings: unknown[]) =>
  toolUse('submit_review', { verdict, findings });

/** 两条可复用的阻断发现。指纹由平台按 (severity,file,range,evidence) 算，字段一致 → 指纹重现 */
const FINDING_A = {
  severity: 'HIGH',
  confidence: 0.9,
  file: 'src/app.ts',
  startLine: 1,
  endLine: 1,
  evidence: 'app.ts 未处理空输入',
  suggestedRemediation: '增加空值分支',
  blocking: true,
};
const FINDING_B = {
  severity: 'CRITICAL',
  confidence: 0.8,
  file: 'src/other.ts',
  startLine: 3,
  endLine: 5,
  evidence: 'other.ts 数组访问越界',
  blocking: true,
};
/** 与 A/B 指纹都不同的新阻断 */
const FINDING_C = {
  severity: 'MEDIUM',
  confidence: 0.7,
  file: 'src/new.ts',
  startLine: 2,
  endLine: 2,
  evidence: '整改引入的新问题',
  blocking: true,
};

function makeHooks(opts: { reverify?: 'pass' | 'fail' | 'disabled'; resealDigest?: string } = {}) {
  const calls = { reverify: 0, reseal: 0, adopt: 0, restore: 0 };
  const resealArgs: Array<{ verification: VerificationRun | null; truncationReason: string | null }> = [];
  const adopted: PatchArtifact[] = [];
  const mode = opts.reverify ?? 'pass';
  const hooks: CrossReviewCycleHooks = {
    reverify:
      mode === 'disabled'
        ? null
        : async () => {
            calls.reverify += 1;
            return { ...VERIFICATION, verificationRunId: 'ver_rem', passed: mode === 'pass' };
          },
    reseal: (verification, truncationReason) => {
      calls.reseal += 1;
      resealArgs.push({ verification, truncationReason });
      return { ...PATCH, patchId: 'patch_resealed', digest: opts.resealDigest ?? 'sha256:resealed' };
    },
    adoptPatch: (p) => {
      calls.adopt += 1;
      adopted.push(p);
    },
    restoreWorkspace: () => {
      calls.restore += 1;
    },
  };
  return { hooks, calls, resealArgs, adopted };
}

const cycleInput = { reviewerResolution: RESOLUTION, patch: PATCH, finalVerification: VERIFICATION };

describe('runCrossReviewCycle：终止语义与 counter', () => {
  it('第 1 轮 PASS → REVIEWER_PASSED，零整改、零钩子调用', async () => {
    const host = new ReviewHost();
    const duo = new ScriptedDuo(() => submitReview('PASS', []));
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(makeDeps(duo, host, IMPLEMENTER), cycleInput, hooks);

    expect(out.stopReason).toBe('REVIEWER_PASSED');
    expect(out.rounds).toHaveLength(1);
    expect(out.remediations).toBe(0);
    expect(calls).toEqual({ reverify: 0, reseal: 0, adopt: 0, restore: 0 });
    // 全程只有审核方被调用
    expect(duo.purposes).toEqual(['CROSS_REVIEW']);
    expect(duo.resolutionIds).toEqual(['route_reviewer']);
  });

  it('有发现但零阻断 → 不整改，REVIEWER_PASSED（提示性发现不驱动整改）', async () => {
    const host = new ReviewHost();
    const duo = new ScriptedDuo(() =>
      submitReview('CHANGES_REQUESTED', [{ ...FINDING_A, blocking: false }]),
    );
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(makeDeps(duo, host, IMPLEMENTER), cycleInput, hooks);

    expect(out.stopReason).toBe('REVIEWER_PASSED');
    expect(out.remediations).toBe(0);
    expect(calls.reseal).toBe(0);
  });

  it('完整闭环：阻断 → 整改（实现方 route）→ 重验 → 重封存 → 第 2 轮 PASS', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      (turn) => (turn === 1 ? submitReview('CHANGES_REQUESTED', [FINDING_A]) : submitReview('PASS', [])),
      () => {
        ws!.activeGeneration += 1; // 模拟整改真的推进了一代
        return textResponse('已按发现修复');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks, calls, resealArgs, adopted } = makeHooks();

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('REVIEWER_PASSED');
    expect(out.rounds).toHaveLength(2);
    expect(out.remediations).toBe(1);
    expect(calls).toEqual({ reverify: 1, reseal: 1, adopt: 1, restore: 0 });
    // 第 2 轮审核针对的是**重封存后**的补丁，不是旧补丁
    expect(out.rounds[1]!.reviewedPatchDigest).toBe('sha256:resealed');
    expect(adopted[0]!.digest).toBe('sha256:resealed');
    // 重封存绑定的是整改后的验证
    expect(resealArgs[0]!.verification?.verificationRunId).toBe('ver_rem');
    // 调用序列：审核（审核方 route）→ 整改（实现方 route，EXECUTION）→ 审核
    expect(duo.purposes).toEqual(['CROSS_REVIEW', 'EXECUTION', 'CROSS_REVIEW']);
    expect(duo.resolutionIds).toEqual(['route_reviewer', 'route_implementer', 'route_reviewer']);
  });

  it('整改没动任何文件 → NO_DELTA，不重验、不重封存、不再审', async () => {
    const host = new ReviewHost();
    const duo = new ScriptedDuo(
      () => submitReview('CHANGES_REQUESTED', [FINDING_A]),
      () => textResponse('我认为这条发现不成立，不改'), // 不推进 generation
    );
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(makeDeps(duo, host, IMPLEMENTER), cycleInput, hooks);

    expect(out.stopReason).toBe('NO_DELTA');
    expect(out.rounds).toHaveLength(1);
    // 模型确实被调了 —— counter 如实记 1，不因"没产出"而虚报 0
    expect(out.remediations).toBe(1);
    expect(duo.reviewTurn).toBe(1);
    expect(calls).toEqual({ reverify: 0, reseal: 0, adopt: 0, restore: 0 });
    expect(host.events.some((e) => e.summary.includes('没有产生任何文件变更'))).toBe(true);
  });

  it('重封存后 digest 与整改前相同 → NO_DELTA，不采用新补丁、不再审', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      () => submitReview('CHANGES_REQUESTED', [FINDING_A]),
      () => {
        ws!.activeGeneration += 1; // 动了文件，但（比如改了又改回去）产物逐字节相同
        return textResponse('改完');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks, calls } = makeHooks({ resealDigest: PATCH.digest });

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('NO_DELTA');
    expect(out.rounds).toHaveLength(1);
    expect(calls.reseal).toBe(1);
    expect(calls.adopt).toBe(0);
  });

  it('整改后验证失败 → 恢复工作区、补丁维持原样、NO_PROGRESS', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      () => submitReview('CHANGES_REQUESTED', [FINDING_A]),
      () => {
        ws!.activeGeneration += 1;
        return textResponse('自以为修好了');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks, calls } = makeHooks({ reverify: 'fail' });

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('NO_PROGRESS');
    expect(out.rounds).toHaveLength(1);
    expect(out.remediations).toBe(1);
    expect(calls.restore).toBe(1); // 工作区必须恢复 —— 封存补丁和文件树要指同一棵树
    expect(calls.reseal).toBe(0); // 验证失败的树绝不封存
    expect(calls.adopt).toBe(0);
    expect(host.events.some((e) => e.summary.includes('验证未通过'))).toBe(true);
  });

  it('第 2 轮指纹重现 → NO_PROGRESS，即使阻断数减少了', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      (turn) =>
        turn === 1
          ? submitReview('CHANGES_REQUESTED', [FINDING_A, FINDING_B]) // 2 条阻断
          : submitReview('CHANGES_REQUESTED', [FINDING_A]), // 1 条，但同一指纹
      () => {
        ws!.activeGeneration += 1;
        return textResponse('修了 B，A 没修');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks } = makeHooks();

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('NO_PROGRESS');
    expect(out.rounds).toHaveLength(2);
    expect(host.events.some((e) => e.summary.includes('指纹重现 1 条'))).toBe(true);
  });

  it('第 2 轮阻断数未减少（全新指纹）→ NO_PROGRESS', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      (turn) =>
        turn === 1
          ? submitReview('CHANGES_REQUESTED', [FINDING_A])
          : submitReview('CHANGES_REQUESTED', [FINDING_C]), // 1 → 1，新问题换旧问题
      () => {
        ws!.activeGeneration += 1;
        return textResponse('修一个引入一个');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks } = makeHooks();

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);
    expect(out.stopReason).toBe('NO_PROGRESS');
  });

  it('第 2 轮阻断减少且全是新指纹 → COUNTER_EXHAUSTED（有进展但轮次用满）', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      (turn) =>
        turn === 1
          ? submitReview('CHANGES_REQUESTED', [FINDING_A, FINDING_B]) // 2 条
          : submitReview('CHANGES_REQUESTED', [FINDING_C]), // 1 条新指纹
      () => {
        ws!.activeGeneration += 1;
        return textResponse('修掉两条，引入一条小的');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks } = makeHooks();

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('COUNTER_EXHAUSTED');
    expect(out.rounds).toHaveLength(2);
    expect(out.remediations).toBe(1);
  });

  it('第 1 轮后预算耗尽 → BUDGET_EXHAUSTED，不整改（counter 记 0）', async () => {
    const host = new ReviewHost();
    host.exceedAfterTurns = 1; // 第 1 轮审核那一次调用之后即耗尽
    const duo = new ScriptedDuo(() => submitReview('CHANGES_REQUESTED', [FINDING_A]));
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(makeDeps(duo, host, IMPLEMENTER), cycleInput, hooks);

    expect(out.stopReason).toBe('BUDGET_EXHAUSTED');
    expect(out.rounds).toHaveLength(1);
    expect(out.remediations).toBe(0);
    expect(duo.execTurn).toBe(0); // 实现方一次都没被调用
    expect(calls.reseal).toBe(0);
  });

  it('第 1 轮审核方出站被阻断 → REVIEWER_UNAVAILABLE，rounds 为空', async () => {
    const host = new ReviewHost();
    const duo = new ScriptedDuo(() => {
      throw new EgressBlocked('ORIGIN_NOT_ALLOWED', {} as never);
    });
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(makeDeps(duo, host, IMPLEMENTER), cycleInput, hooks);

    expect(out.stopReason).toBe('REVIEWER_UNAVAILABLE');
    expect(out.rounds).toHaveLength(0);
    expect(out.remediations).toBe(0);
    expect(calls).toEqual({ reverify: 0, reseal: 0, adopt: 0, restore: 0 });
  });

  it('整改中途被取消（已经动了文件）→ 恢复工作区，CANCELLED，保留第 1 轮记录', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      () => submitReview('CHANGES_REQUESTED', [FINDING_A]),
      () => {
        ws!.activeGeneration += 1; // 改到一半……
        throw new AgentCancelled(); // ……用户点了取消
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks, calls } = makeHooks();

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('CANCELLED');
    // 第 1 轮已经真实发生、token 已花掉 —— 不能因为取消把记录归零
    expect(out.rounds).toHaveLength(1);
    expect(out.remediations).toBe(1);
    expect(calls.restore).toBe(1);
    expect(calls.reseal).toBe(0);
  });

  it('未验证模式：跳过重验，用 null 验证重封存，仍跑第 2 轮', async () => {
    const host = new ReviewHost();
    let ws: ReviewWorkspace | null = null;
    const duo = new ScriptedDuo(
      (turn) => (turn === 1 ? submitReview('CHANGES_REQUESTED', [FINDING_A]) : submitReview('PASS', [])),
      () => {
        ws!.activeGeneration += 1;
        return textResponse('修好了');
      },
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);
    ws = deps.workspace as unknown as ReviewWorkspace;
    const { hooks, calls, resealArgs } = makeHooks({ reverify: 'disabled' });

    const out = await runCrossReviewCycle(deps, cycleInput, hooks);

    expect(out.stopReason).toBe('REVIEWER_PASSED');
    expect(out.rounds).toHaveLength(2);
    expect(calls.reverify).toBe(0);
    expect(resealArgs[0]!.verification).toBeNull(); // 未验证就如实封存"未验证"
  });
});

describe('runRemediationPass', () => {
  it('实现方直接结束回合 → mutated=false；整改简报包含阻断证据、diff 与范围约束', async () => {
    const host = new ReviewHost();
    const duo = new ScriptedDuo(
      () => {
        throw new Error('本用例不该有审核调用');
      },
      () => textResponse('看过了，不改'),
    );
    const deps = makeDeps(duo, host, IMPLEMENTER);

    const r = await runRemediationPass(deps, {
      patch: PATCH,
      findings: [
        {
          severity: 'HIGH',
          confidence: 0.9,
          file: 'src/app.ts',
          range: [1, 1],
          evidence: 'app.ts 未处理空输入',
          reproduction: null,
          suggestedRemediation: '增加空值分支',
          blocking: true,
          fingerprint: 'fp_a',
        },
      ],
    });

    expect(r.mutated).toBe(false);
    expect(r.truncationReason).toBeNull();
    const brief = duo.execBriefs[0]!;
    expect(brief).toContain('阻断');
    expect(brief).toContain('app.ts 未处理空输入');
    expect(brief).toContain('增加空值分支');
    expect(brief).toContain(PATCH.unifiedDiff.trim().slice(0, 30));
    expect(brief).toContain('只');
  });

  it('预算已耗尽 → 一次模型调用都不发起，truncationReason 如实非空', async () => {
    const host = new ReviewHost();
    host.exceedAfterTurns = 0;
    const duo = new ScriptedDuo(() => {
      throw new Error('不该有任何调用');
    });
    const deps = makeDeps(duo, host, IMPLEMENTER);

    const r = await runRemediationPass(deps, { patch: PATCH, findings: [] });

    expect(r.mutated).toBe(false);
    expect(r.truncationReason).not.toBeNull();
    expect(duo.execTurn).toBe(0);
    expect(duo.reviewTurn).toBe(0);
  });
});
