import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventKind, TaskSpec, ToolCallResolution, ToolRisk } from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { type AgentHost, type ModelInvoker, runAgent } from './agent';
import type { ContentBlock, ModelResponse } from './model/types';
import { findOrphanToolUse } from './model/types';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { sealPatch } from './patch';
import { importSnapshot, resolveProfile } from './repo';
import { compareVerification } from './verify';
import { MaterializedWorkspace } from './workspace';
import { ensureDataRoot } from './paths';

/**
 * 端到端链路证据（不接真实模型）。
 *
 * 用确定性替身代替模型判断，验证除"模型聪不聪明"之外的**全部**平台行为：
 *   导入 tracked 快照 → 解析 VERIFIED profile → 基线验证真的失败
 *   → 规划阶段被强制只读 → 计划进入审批 → 用户批准
 *   → fs_read 产出 receipt → workspace_mutate 原子提交并推进 generation
 *   → 重新构建真的通过 → 基线对比分类正确 → PatchArtifact 封存且 diff 正确
 *   → 宿主仓库逐字节未被写入
 *
 * 这条测试跑真实的 tsc + vite build，所以比较慢，但它证明的是真东西。
 */

const FIXTURE_SOURCE = resolve(__dirname, '../../fixtures/vite-react-broken');

/**
 * 把 fixture 复制到临时目录，在**副本**里初始化 git。
 *
 * 两个理由：
 *   1. 仓库里那份 fixture 不能带 `.git` —— 嵌套 git 仓库会被外层当成损坏的 gitlink。
 *   2. 测试要断言「宿主仓库全程没被写过」，跑在副本上才不会有污染源仓库的风险。
 *
 * node_modules 用 symlink 复用，不复制 —— 几百 MB 拷不起。
 */
function materializeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repopilot-e2e-'));
  cpSync(FIXTURE_SOURCE, dir, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)$/.test(src),
  });
  symlinkSync(join(FIXTURE_SOURCE, 'node_modules'), join(dir, 'node_modules'), 'dir');

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    '-c',
    'user.email=fixture@local',
    '-c',
    'user.name=fixture',
    'commit',
    '-q',
    '-m',
    'cart: 引入 DiscountResult 重构（CartSummary 未同步更新，构建失败）',
  ]);
  return dir;
}

const BROKEN_LINE = '  const total = applyDiscount(subtotal, discountCode);';
const FIXED_LINE = '  const { amount: total } = applyDiscount(subtotal, discountCode);';

describe('端到端：Vite + React + TS 构建失败修复', () => {
  it(
    '从导入到封存补丁的完整链路',
    async () => {
      if (!existsSync(resolve(FIXTURE_SOURCE, 'node_modules'))) {
        throw new Error(
          'fixture 依赖未安装。先执行：cd prototype/fixtures/vite-react-broken && npm install',
        );
      }
      ensureDataRoot();
      const FIXTURE = materializeFixture();

      // ---- 导入 ----
      const snapshot = importSnapshot('proj_e2e', FIXTURE);
      const profile = resolveProfile(snapshot);

      expect(profile.supportStatus).toBe('VERIFIED');
      expect(profile.supportedTaskClasses).toContain('BUILD_FAILURE_FIX');
      expect(profile.commands.build).toBeDefined();
      // tracked-only：node_modules / dist 不进快照
      expect(snapshot.fileCount).toBeLessThan(20);

      const runId = newId('run');
      const attemptId = newId('att');
      const workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId, FIXTURE);

      const task: TaskSpec = {
        taskId: newId('task'),
        projectId: 'proj_e2e',
        snapshotId: snapshot.snapshotId,
        profileId: profile.profileId,
        goal: '修复 npm run build 失败：CartSummary 把 DiscountResult 当成 number 用了',
        taskClass: 'BUILD_FAILURE_FIX',
        allowedPaths: ['src/**'],
        protectedPaths: profile.protectedPaths,
        nonGoals: [],
        acceptance: ['不修改 pricing.ts 的公开签名'],
        verificationCommandIds: ['build'],
        budget: {
          maxModelTurns: 20,
          maxToolCalls: 30,
          maxSelfFixRounds: 2,
          maxWallClockMs: 10 * 60 * 1000,
          maxTotalTokens: 100_000,
        },
        createdAt: nowIso(),
      };

      const recorder = new Recorder();
      const gateway = new ScriptedModel();

      const result = await runAgent({
        task,
        snapshot,
        profile,
        workspace,
        gateway,
        resolution: {
          resolutionId: 'route_test',
          profileId: 'profile_test_only_fake',
          providerId: 'ANTHROPIC_OFFICIAL',
          origin: 'https://api.anthropic.com',
          modelId: 'TEST_ONLY_FAKE',
          frozenAt: nowIso(),
          digest: digestOf({ test: true }),
        },
        mutationPolicy: {
          ...DEFAULT_MUTATION_POLICY,
          allowedPaths: task.allowedPaths,
          protectedPaths: task.protectedPaths,
        },
        runId,
        attemptId,
        signal: new AbortController().signal,
        host: recorder,
      });

      // ---- 结果断言 ----
      // 带上 detail 与模型轮次：这条断言曾经红过一次且复现不出来，
      // 只说 "expected BLOCKED to be PATCH_READY" 是查不下去的。
      expect(
        result.kind,
        `result.detail=${result.detail} · modelTurns=${recorder.ledger.modelTurns} · ` +
          `finalVerification=${result.finalVerification?.commands.map((c) => `${c.commandId}=${c.outcome}`).join(' ') ?? 'null'}`,
      ).toBe('PATCH_READY');

      // 基线必须是"真的构建失败"，不能是 spawn 失败伪装成的失败
      const baselineBuild = result.baseline!.commands.find((c) => c.commandId === 'build')!;
      expect(baselineBuild.outcome).toBe('EXIT_NONZERO');
      expect(baselineBuild.exitCode).toBeGreaterThan(0);
      expect(`${baselineBuild.stdoutPreview}${baselineBuild.stderrPreview}`).toContain('TS2345');
      expect(result.baseline!.passed).toBe(false);

      // 修复后必须是真的 exit 0
      const fixedBuild = result.finalVerification!.commands.find((c) => c.commandId === 'build')!;
      expect(fixedBuild.outcome).toBe('EXIT_ZERO');
      expect(result.finalVerification!.passed).toBe(true);

      // 规划阶段没有产生任何 R1 副作用
      const planPhaseWrites = recorder.toolCalls.filter(
        (t) => t.risk !== 'R0' && t.at < recorder.planApprovedAt!,
      );
      expect(planPhaseWrites).toHaveLength(0);

      // generation 推进了，且工作区里是修好的代码
      expect(workspace.activeGeneration).toBeGreaterThan(0);
      expect(workspace.readText('src/components/CartSummary.tsx')).toContain(FIXED_LINE.trim());

      // ---- 封存补丁 ----
      const comparison = compareVerification(result.baseline!, result.finalVerification!);
      expect(comparison.fixed).toEqual(['build']);
      expect(comparison.newlyFailing).toEqual([]);

      const patch = sealPatch(
        workspace,
        runId,
        attemptId,
        snapshot.baseSha,
        result.finalVerification!,
        comparison,
        result.unverifiedItems,
      );

      expect(patch.files).toHaveLength(1);
      expect(patch.files[0]!.path).toBe('src/components/CartSummary.tsx');
      expect(patch.files[0]!.changeKind).toBe('MODIFIED');
      // vite build 产出的 dist/* 不进补丁，但必须被显式列出而不是静默丢弃
      expect(patch.excludedGeneratedFiles.length).toBeGreaterThan(0);
      expect(patch.excludedGeneratedFiles.every((p) => p.startsWith('dist/'))).toBe(true);
      expect(patch.unifiedDiff).toContain(`-${BROKEN_LINE}`);
      expect(patch.unifiedDiff).toContain(`+${FIXED_LINE}`);
      // diff 头里不能出现宿主绝对路径
      expect(patch.unifiedDiff).not.toContain('/Users/');
      expect(patch.unverifiedItems.length).toBeGreaterThan(0);

      // ---- 宿主仓库必须一个字节都没被动过 ----
      const hostStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: FIXTURE,
        encoding: 'utf8',
      }).trim();
      expect(hostStatus).toBe('');

      workspace.cleanup();
      rmSync(FIXTURE, { recursive: true, force: true });
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// 确定性模型替身：按固定脚本回应，不联网
// ---------------------------------------------------------------------------

class ScriptedModel implements ModelInvoker {
  private turn = 0;

  async invoke(input: Parameters<ModelInvoker['invoke']>[0]) {
    // 真实 provider 会对孤儿 tool_use 返回 400，测试替身不会 —— 所以这里
    // 主动用与网关同一个校验器把关，否则这类回归在测试里是静默的。
    const orphan = findOrphanToolUse(input.request.messages);
    if (orphan) throw new Error(`${input.purpose} 调用收到非法消息序列：${orphan}`);
    this.turn += 1;
    const response = this.script(input.purpose, input);
    return {
      invocationId: `inv_fake_${this.turn}`,
      response,
      manifest: {
        invocationId: `inv_fake_${this.turn}`,
        runId: input.runId,
        attemptId: input.attemptId,
        purpose: input.purpose,
        resolutionId: input.resolution.resolutionId,
        providerId: input.resolution.providerId,
        origin: input.resolution.origin,
        modelId: 'TEST_ONLY_FAKE',
        sent: false,
        blockReason: 'TEST_ONLY_FAKE_NO_EGRESS',
        contextFileRefs: [],
        inputTokens: 100,
        outputTokens: 50,
        requestedAt: nowIso(),
        settledAt: nowIso(),
        errorKind: null,
      },
    };
  }

  private script(
    purpose: string,
    input: Parameters<ModelInvoker['invoke']>[0],
  ): ModelResponse {
    const messages = input.request.messages;
    const lastText = JSON.stringify(messages[messages.length - 1]?.content ?? '');

    if (purpose === 'PLANNING') {
      // 第一步先读文件，第二步提交计划
      if (!lastText.includes('receiptId=')) {
        return toolUse('fs_read', { path: 'src/components/CartSummary.tsx' });
      }
      return toolUse('submit_plan', {
        summary:
          'applyDiscount 已改为返回 DiscountResult，但 CartSummary 仍把它当 number 传给 formatMoney。解构出 amount 即可。',
        steps: [
          {
            intent: '在 CartSummary 中解构 applyDiscount 的返回值，取 amount',
            targetPaths: ['src/components/CartSummary.tsx'],
            expectedEffect: 'tsc 类型错误消失，build 通过',
          },
        ],
        risks: ['若其他调用点也有同样问题，本次修改不覆盖'],
      });
    }

    // 执行阶段
    const receiptId = extractReceipt(lastText);
    if (!receiptId) {
      return toolUse('fs_read', { path: 'src/components/CartSummary.tsx' });
    }
    if (!lastText.includes('gen-1')) {
      return toolUse('workspace_mutate', {
        operations: [
          {
            kind: 'REPLACE_EXACT_TEXT_SPAN',
            path: 'src/components/CartSummary.tsx',
            receiptId,
            oldText: BROKEN_LINE,
            newText: FIXED_LINE,
          },
        ],
      });
    }
    if (!lastText.includes('EXIT_ZERO')) {
      return toolUse('run_command', { commandId: 'build' });
    }
    return {
      content: [{ type: 'text', text: '已把 applyDiscount 的返回值解构为 amount，构建通过。' }],
      stopReason: 'END_TURN',
      inputTokens: 100,
      outputTokens: 20,
    };
  }
}

function toolUse(name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 7)}`, name, input }],
    stopReason: 'TOOL_USE',
    inputTokens: 100,
    outputTokens: 50,
  };
}

function extractReceipt(text: string): string | null {
  const m = /receiptId=(rcpt_[a-z0-9]+)/.exec(text);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------

interface RecordedCall {
  toolName: string;
  risk: ToolRisk;
  at: number;
  resolution?: ToolCallResolution;
}

class Recorder implements AgentHost {
  readonly events: Array<{ kind: RunEventKind; summary: string }> = [];
  readonly toolCalls: RecordedCall[] = [];
  planApprovedAt: number | null = null;
  private ledger = { modelTurns: 0, toolCalls: 0, selfFixRounds: 0 };

  emit(kind: RunEventKind, summary: string): void {
    this.events.push({ kind, summary });
  }

  setStatus(): void {}

  async awaitPlanApproval(): Promise<'APPROVE' | 'REJECT'> {
    this.planApprovedAt = Date.now();
    return 'APPROVE';
  }

  beginToolCall(input: { toolName: string; risk: ToolRisk }): string {
    const id = `tc_${this.toolCalls.length}`;
    this.toolCalls.push({ toolName: input.toolName, risk: input.risk, at: Date.now() });
    return id;
  }

  endToolCall(toolCallId: string, resolution: ToolCallResolution): void {
    const idx = Number(toolCallId.split('_')[1]);
    const call = this.toolCalls[idx];
    if (call) call.resolution = resolution;
  }

  chargeModelTurn(): void {
    this.ledger.modelTurns += 1;
  }
  chargeToolCall(): void {
    this.ledger.toolCalls += 1;
  }
  chargeSelfFixRound(): void {
    this.ledger.selfFixRounds += 1;
  }
  budgetExceeded(): { exceeded: boolean; reason: string } {
    if (this.ledger.modelTurns > 30) return { exceeded: true, reason: '测试上限' };
    return { exceeded: false, reason: '' };
  }
}
