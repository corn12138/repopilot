import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  BudgetLedger,
  DoctorCheck,
  FileTreeEntry,
  PatchArtifact,
  PatchDecisionKind,
  PlanRevision,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunEventKind,
  RunStatus,
  RunView,
  SubPackageCandidate,
  TaskSpec,
  ToolCallResolution,
  ToolCallView,
  ToolRisk,
  VerificationRun,
} from '@shared/domain';
import { EMPTY_LEDGER, isTerminal } from '@shared/domain';
import { sha256 } from '@shared/ids';
import type { ImportOutcome, PatchExportResult, PlatformError, PushEvent } from '@shared/protocol';
import { digestOf, newId, nowIso } from '@shared/ids';
import { AgentCancelled, PlanningFailed, runAgent } from './agent';
import { EgressBlocked, InvocationFailed, ModelGateway } from './model/gateway';
import { DEFAULT_MUTATION_POLICY } from './mutation';
import { applyPatchWithGit, sealPatch } from './patch';
import {
  type ImportOptions,
  RepositoryImportError,
  findSubPackages,
  importSnapshot,
  resolveProfile,
} from './repo';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { EventStore, readJson, writeJsonAtomic } from './store';
import {
  RUN_STATE_SCHEMA_VERSION,
  listPersistedRunIds,
  readRunState,
  writeRunState,
} from './persistence';
import {
  type LiveReferences,
  type PurgeSummary,
  type RetentionPolicy,
  diskUsage,
  loadLastSummary,
  loadPolicy,
  savePolicy,
  sweep,
} from './retention';
import { PATHS, ensureDataRoot, snapshotDir, workspaceDir } from './paths';
import { compareVerification } from './verify';
import {
  MaterializedWorkspace,
  fileDigestAt,
  isGeneratedPath,
  listTree,
  resolveManaged,
} from './workspace';

/** 单个文件预览上限；超出只给前面这些字节 */
const MAX_VIEW_BYTES = 400_000;

const APPROVAL_TTL_MS = 30 * 60 * 1000;

interface ProjectRecord {
  readonly ref: ProjectRef;
  /** 宿主绝对路径只存在于这里，永不出现在任何投影里 */
  readonly hostPath: string;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  /** 兑现审批：内部会清理超时定时器、abort 监听，并恢复墙钟 deadline */
  readonly resolve: (decision: ApprovalDecisionKind) => void;
}

/**
 * 可暂停的墙钟 deadline。
 *
 * 存在的理由：等待**人工审批**的时间不该算进 Run 的计算预算 —— 用户花 25 分钟
 * 审一个计划，不该导致 Run 被判 TIMED_OUT。所以进入审批等待时 pause()，
 * 用户决定后 resume()。审批期间模型并没有在跑，计算时间仍然是有界的。
 *
 * 之前是一个从 execute 开始就一直在走的 setTimeout，它覆盖了审批等待时间，
 * 且到点只 abort + setStatus，不兑现 awaitPlanApproval 的 Promise —— 于是
 * runAgent 永远挂在 await 上，execute 的 finally（清理 + CLEANUP_SUMMARY）永不执行。
 */
export class PausableDeadline {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private startedAt = 0;
  private done = false;

  constructor(
    totalMs: number,
    private readonly onFire: () => void,
  ) {
    this.remaining = totalMs;
    this.arm();
  }

  private arm(): void {
    if (this.done || this.handle) return;
    this.startedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      this.done = true;
      this.onFire();
    }, Math.max(0, this.remaining));
    this.handle.unref?.();
  }

  pause(): void {
    if (this.done || !this.handle) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.remaining -= Date.now() - this.startedAt;
  }

  resume(): void {
    this.arm();
  }

  clear(): void {
    this.done = true;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }
}

interface RunRecord {
  view: RunView;
  readonly task: TaskSpec;
  readonly snapshot: RepositorySnapshot;
  readonly profile: RepositoryHarnessProfile;
  /**
   * 从磁盘恢复的 Run 没有活工作区（目录可能还在，也可能已被清理），
   * 所以这里可空。所有摸它的地方都必须显式处理 null，不能让它抛未分类异常。
   */
  readonly workspace: MaterializedWorkspace | null;
  readonly events: EventStore;
  readonly abort: AbortController;
  /** 运行期墙钟 deadline；审批等待时暂停。恢复态与非执行期为 null */
  deadline: PausableDeadline | null;
  readonly toolCalls: Map<string, ToolCallView>;
  readonly verifications: VerificationRun[];
  readonly approvals: Map<string, PendingApproval>;
  plan: PlanRevision | null;
  patch: PatchArtifact | null;
}

/**
 * 「补丁能否写回宿主仓库」的门禁判定 —— 抽成纯函数，因为它是整个原型里
 * 唯一会写用户文件的动作的最后一道闸，必须能被单测直接打穿，而不依赖
 * 起一整个 RunAuthority + git 仓库。
 *
 * 两条规则：
 *   1. 必须先被接受（terminalFacts.patchAcceptanceId 存在）。REJECT / REQUEST_CHANGES
 *      走 BLOCKED、terminalFacts 为 null，被这条挡住。
 *   2. 请求里的 digest 必须与实际补丁一致；未提供一律拒绝 —— 写宿主仓库不接受"就地信任"。
 */
export type PatchApplyGate = { ok: true } | { ok: false; reason: string; detail: string };

export function checkPatchApplyGate(input: {
  status: RunStatus;
  patchAcceptanceId: string | null;
  actualDigest: string;
  requestedDigest: string | undefined;
}): PatchApplyGate {
  if (!input.patchAcceptanceId) {
    return {
      ok: false,
      reason: 'NOT_ACCEPTED',
      detail: `补丁尚未被接受（当前状态 ${input.status}）。请先在补丁审查里接受，再写回仓库。`,
    };
  }
  if (input.requestedDigest === undefined) {
    return {
      ok: false,
      reason: 'DIGEST_REQUIRED',
      detail: '写回宿主仓库必须携带补丁 digest 以校验一致性',
    };
  }
  if (input.actualDigest !== input.requestedDigest) {
    return { ok: false, reason: 'PATCH_CHANGED', detail: '补丁已变化，请刷新后重新确认' };
  }
  return { ok: true };
}

export class RunAuthority {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly profiles = new Map<string, RepositoryHarnessProfile>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly gateway = new ModelGateway();

  constructor(private readonly push: (event: PushEvent) => void) {
    ensureDataRoot();
    for (const rec of readJson<ProjectRecord[]>(PATHS.projects, [])) {
      this.projects.set(rec.ref.projectId, rec);
    }
    this.rehydrateRuns();
    this.startRetentionSchedule();
  }

  // -------------------------------------------------------------------------
  // 持久化与恢复
  // -------------------------------------------------------------------------

  /**
   * 把 Run 的当前状态快照写盘。
   *
   * 调用约定：**先 append 事件，再调这个**。事件流是流水账，状态快照是结算结果；
   * 顺序反了会在崩溃窗口里产生"状态说成功、时间线停在半路"的说谎方式。
   */
  private persist(record: RunRecord): void {
    try {
      writeRunState({
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        view: record.view,
        task: record.task,
        snapshot: record.snapshot,
        profile: record.profile,
        toolCalls: [...record.toolCalls.values()],
        verifications: record.verifications,
        plan: record.plan,
        patch: record.patch,
        eventHighWatermark: record.events.lastSeq(),
        persistedAt: nowIso(),
      });
    } catch (err) {
      // 写盘失败不能让运行中的 Run 崩掉，但必须留痕 —— 否则就成了静默的证据丢失
      console.error('[core] 持久化 Run 状态失败', record.view.runId, err);
    }
  }

  /**
   * 启动时把磁盘上的 Run 读回来。
   *
   * 恢复出来的都是**只读**的：没有 Agent Loop、没有工作区，不能续跑。
   * 唯一的例外是 `AWAITING_PATCH_REVIEW` —— 补丁已封存、验证已完成，
   * 接受与否是纯粹的状态转换，不需要活的执行器。所以这个状态**可以跨重启存活**，
   * 用户第二天回来照样能接受并导出补丁。
   *
   * 其余非终态一律落成 `INTERRUPTED`：它们等的是一个已经不存在的执行器，
   * 假装还能继续才是真正的谎言。
   */
  private rehydrateRuns(): void {
    for (const runId of listPersistedRunIds()) {
      const loaded = readRunState(runId);
      const events = new EventStore(runId);

      if (!loaded.ok) {
        // 读不出来也要留在列表里，标明损坏 —— 不能让一个 Run 凭空消失
        const damaged = this.damagedRecord(runId, events, loaded.reason);
        if (damaged) this.runs.set(runId, damaged);
        continue;
      }

      const s = loaded.state;
      // 事件比状态新 = 崩溃发生在两次写之间。如实标注，不假装一致
      const eventsAhead = events.lastSeq() > s.eventHighWatermark;

      const record: RunRecord = {
        view: {
          ...s.view,
          restored: true,
          evidence: eventsAhead ? 'EVENTS_AHEAD' : 'INTACT',
          evidenceDetail: eventsAhead
            ? `事件流已到 seq ${events.lastSeq()}，状态快照停在 seq ${s.eventHighWatermark} —— 末尾若干事件未反映在状态里`
            : null,
        },
        task: s.task,
        snapshot: s.snapshot,
        profile: s.profile,
        workspace: null, // 恢复态没有活工作区
        events,
        abort: abortedController(),
        deadline: null,
        toolCalls: new Map(s.toolCalls.map((t) => [t.toolCallId, t])),
        verifications: [...s.verifications],
        approvals: new Map(),
        plan: s.plan,
        patch: s.patch,
      };

      this.runs.set(runId, record);
      this.snapshots.set(s.snapshot.snapshotId, s.snapshot);
      this.profiles.set(s.profile.profileId, s.profile);

      this.closeInterruptedRun(record);
    }
  }

  /** 非终态且不是待补丁审查的，落成 INTERRUPTED 并补一条清理说明 */
  private closeInterruptedRun(record: RunRecord): void {
    const status = record.view.status;
    if (isTerminal(status) || status === 'AWAITING_PATCH_REVIEW') return;

    const previous = status;
    record.view = {
      ...record.view,
      status: 'INTERRUPTED',
      statusReason: `进程退出时该 Run 处于 ${previous}，重启后无法续跑`,
      updatedAt: nowIso(),
    };
    record.events.append(record.view.attemptId, 'STATUS_CHANGED', `${previous} → INTERRUPTED（进程退出）`, {
      from: previous,
      to: 'INTERRUPTED',
      reason: 'PROCESS_EXIT',
    });

    const wsDir = workspaceDir(record.view.runId);
    record.events.append(
      record.view.attemptId,
      'CLEANUP_SUMMARY',
      `子进程与模型流已随进程退出释放；工作区 ${existsSync(wsDir) ? `仍在磁盘上（gen-${record.view.workspaceGeneration}）` : '已不存在'}`,
      { workspaceRetained: existsSync(wsDir), reason: 'PROCESS_EXIT' },
    );
    this.persist(record);
  }

  /** 状态快照坏了，但目录还在 —— 用事件流能捞多少算多少，剩下的标明未知 */
  private damagedRecord(runId: string, events: EventStore, reason: string): RunRecord | null {
    const all = events.all();
    if (all.length === 0) return null; // 连事件都没有，不构成一个可展示的 Run
    const first = all[0]!;
    const last = all[all.length - 1]!;

    return {
      view: {
        runId,
        taskId: String(first.payload.taskId ?? 'unknown'),
        projectId: '',
        title: first.summary.replace(/^任务已创建：/, '') || runId,
        attemptId: first.attemptId,
        attemptNo: 1,
        status: 'INTERRUPTED',
        statusReason: '状态快照损坏，仅能展示事件流',
        ledger: EMPTY_LEDGER,
        limits: {
          maxModelTurns: 0,
          maxToolCalls: 0,
          maxSelfFixRounds: 0,
          maxWallClockMs: 0,
          maxTotalTokens: 0,
        },
        workspaceGeneration: 0,
        createdAt: first.at,
        updatedAt: last.at,
        terminalFacts: null,
        restored: true,
        evidence: 'DAMAGED',
        evidenceDetail: reason,
      },
      task: null as unknown as TaskSpec,
      snapshot: null as unknown as RepositorySnapshot,
      profile: null as unknown as RepositoryHarnessProfile,
      workspace: null,
      events,
      abort: abortedController(),
      deadline: null,
      toolCalls: new Map(),
      verifications: [],
      approvals: new Map(),
      plan: null,
      patch: null,
    };
  }

  // -------------------------------------------------------------------------
  // 请求分发
  // -------------------------------------------------------------------------

  async handle(method: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'doctor.run':
        return { checks: this.doctor() };

      case '__project.register':
        return { project: this.registerProject(String(payload.hostPath)) };

      case 'project.list':
        return { projects: [...this.projects.values()].map((p) => p.ref) };

      case 'project.import':
        return this.importProject(String(payload.projectId), {
          subPath: payload.subPath ? String(payload.subPath) : undefined,
        });

      case 'model.listProfiles':
        return { profiles: this.gateway.listProfiles(), secureStorage: true };

      // Main 解密后注入；Core 只在内存持有，绝不落盘
      case '__credentials.sync':
        this.gateway.syncCredentials(payload.keys as Record<string, string>);
        return { profiles: this.gateway.listProfiles() };

      case 'model.addProvider': {
        try {
          this.gateway.addCustomProvider({
            id: String(payload.id),
            name: String(payload.name ?? ''),
            api: String(payload.api),
            ...(payload.wire ? { wire: payload.wire as 'anthropic' | 'openai' } : {}),
            ...(Array.isArray(payload.models) ? { models: payload.models as string[] } : {}),
            ...(payload.doc ? { doc: String(payload.doc) } : {}),
          });
        } catch (err) {
          throw platformError('BAD_REQUEST', (err as Error).message);
        }
        return { profiles: this.gateway.listProfiles() };
      }

      case 'model.removeProvider':
        this.gateway.removeCustomProvider(String(payload.providerId));
        return { profiles: this.gateway.listProfiles() };

      case 'model.updateProfile': {
        this.gateway.updateProfile(String(payload.profileId), {
          ...(payload.modelId !== undefined ? { modelId: String(payload.modelId) } : {}),
          ...(payload.baseUrlOverride !== undefined
            ? { baseUrlOverride: String(payload.baseUrlOverride) }
            : {}),
        });
        return { profiles: this.gateway.listProfiles() };
      }

      case 'model.testProfile': {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        try {
          return await this.gateway.testProfile(String(payload.profileId), ac.signal);
        } finally {
          clearTimeout(timer);
        }
      }

      case 'task.create':
        return this.createTask(payload as never);

      case 'run.get':
        return { run: this.runs.get(String(payload.runId))?.view ?? null };

      case 'run.list':
        return {
          runs: [...this.runs.values()]
            .map((r) => r.view)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        };

      case 'run.events': {
        const rec = this.require(String(payload.runId));
        return { events: rec.events.after(Number(payload.afterSeq ?? 0)) };
      }

      case 'run.toolCalls': {
        const rec = this.require(String(payload.runId));
        return { toolCalls: [...rec.toolCalls.values()] };
      }

      case 'run.cancel':
        return { run: this.cancel(String(payload.runId), String(payload.reason ?? '用户取消')) };

      case 'plan.get':
        return { plan: this.runs.get(String(payload.runId))?.plan ?? null };

      case 'approval.pending': {
        const rec = this.require(String(payload.runId));
        return { approvals: [...rec.approvals.values()].map((a) => a.request) };
      }

      case 'approval.decide':
        return this.decideApproval(payload as never);

      case 'patch.get':
        return { patch: this.runs.get(String(payload.runId))?.patch ?? null };

      case 'patch.decide':
        return this.decidePatch(payload as never);

      case 'verification.list': {
        const rec = this.require(String(payload.runId));
        return { verifications: rec.verifications };
      }

      case 'retention.get':
        return {
          policy: loadPolicy(),
          usage: diskUsage(),
          lastSummary: loadLastSummary(),
        };

      case 'retention.update':
        return {
          policy: savePolicy({
            ...(payload.evidenceDays !== undefined ? { evidenceDays: Number(payload.evidenceDays) } : {}),
            ...(payload.workspaceGraceMinutes !== undefined
              ? { workspaceGraceMinutes: Number(payload.workspaceGraceMinutes) }
              : {}),
          }),
          usage: diskUsage(),
          lastSummary: loadLastSummary(),
        };

      case 'retention.sweepNow': {
        const summary = this.runSweep('manual');
        return { summary, usage: diskUsage(), policy: loadPolicy() };
      }

      case 'files.tree':
        return this.fileTree(String(payload.snapshotId), payload.runId ? String(payload.runId) : null);

      case 'files.read':
        return this.readFile(
          String(payload.snapshotId),
          String(payload.path),
          payload.runId ? String(payload.runId) : null,
        );

      // Main 需要补丁正文来存文件 / 写剪贴板；这两件事是原生能力，由 Main 做
      case '__patch.content': {
        const rec = this.require(String(payload.runId));
        if (!rec.patch || rec.patch.patchId !== String(payload.patchId)) {
          throw platformError('NOT_FOUND', '补丁不存在或已变化');
        }
        return {
          filename: suggestPatchFilename(rec),
          content: renderPatchFile(rec),
          digest: rec.patch.digest,
        };
      }

      case '__patch.applyToRepo':
        return this.applyPatchToRepo(
          String(payload.runId),
          String(payload.patchId),
          payload.patchDigest === undefined ? undefined : String(payload.patchDigest),
        );

      default:
        throw platformError('BAD_REQUEST', `未知方法: ${method}`);
    }
  }

  // -------------------------------------------------------------------------
  // 环境自检
  // -------------------------------------------------------------------------

  private doctor(): DoctorCheck[] {
    const checks: DoctorCheck[] = [
      {
        checkId: 'node',
        label: 'Node 运行时',
        status: 'READY',
        detail: `${process.version} / ${process.platform}-${process.arch}`,
        remediation: null,
      },
      {
        checkId: 'dataRoot',
        label: '本地数据根',
        status: 'READY',
        detail: PATHS.root,
        remediation: null,
      },
    ];

    try {
      const v = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
      checks.push({ checkId: 'git', label: 'Git', status: 'READY', detail: v, remediation: null });
    } catch {
      checks.push({
        checkId: 'git',
        label: 'Git',
        status: 'BLOCKED',
        detail: '未找到 git 可执行文件',
        remediation: '安装 Xcode Command Line Tools: xcode-select --install',
      });
    }

    const profiles = this.gateway.listProfiles();
    const enabled = profiles.filter((p) => p.enabled);
    checks.push({
      checkId: 'modelProfile',
      label: '模型连接（BYOK）',
      status: enabled.length > 0 ? 'READY' : 'BLOCKED',
      detail:
        enabled.length > 0
          ? `已启用 ${enabled.length} 个: ${enabled.map((p) => `${p.label}(${p.modelId})`).join(', ')}`
          : '没有可用的模型 Profile',
      remediation:
        enabled.length > 0
          ? null
          : `设置以下任一环境变量后重启应用: ${profiles.map((p) => p.credentialEnvVar).join(' / ')}`,
    });

    return checks;
  }

  // -------------------------------------------------------------------------
  // 项目 / 导入
  // -------------------------------------------------------------------------

  private registerProject(hostPath: string): ProjectRef {
    for (const rec of this.projects.values()) {
      if (rec.hostPath === hostPath) return rec.ref;
    }
    const ref: ProjectRef = {
      projectId: newId('proj'),
      name: basename(hostPath),
      displayPath: shortenPath(hostPath),
      createdAt: nowIso(),
    };
    this.projects.set(ref.projectId, { ref, hostPath });
    writeJsonAtomic(PATHS.projects, [...this.projects.values()]);
    return ref;
  }

  /**
   * 把用户手填的验证命令并入 profile。
   *
   * 这是「任何仓库都能用」的关键：检测不出命令时，用户可以自己说明怎么验证。
   * 命令仍然是结构化 argv，不是自由 shell 字符串 —— 模型依旧只能按 id 引用，
   * 无法构造新命令。
   */
  private withUserCommands(
    profile: RepositoryHarnessProfile,
    custom: ReadonlyArray<{ label: string; argv: string[] }>,
  ): RepositoryHarnessProfile {
    if (custom.length === 0) return profile;
    const commands = { ...profile.commands };
    custom.forEach((c, i) => {
      const argv = c.argv.map((a) => a.trim()).filter(Boolean);
      if (argv.length === 0) return;
      const commandId = `user${i + 1}`;
      commands[commandId] = {
        commandId,
        label: c.label.trim() || argv.join(' '),
        argv,
        cwdRelative: '.',
        timeoutMs: 600_000,
        risk: 'R1',
        source: 'USER',
      };
    });
    return { ...profile, profileId: newId('prof'), commands };
  }

  private importProject(projectId: string, options: ImportOptions): ImportOutcome {
    const project = this.projects.get(projectId);
    if (!project) throw platformError('NOT_FOUND', '项目不存在');

    // 子包候选与导入是否成功无关：即使被阻断，用户也需要看到"可以换成哪个子包"
    let candidates: SubPackageCandidate[] = [];
    try {
      candidates = findSubPackages(project.hostPath);
    } catch {
      candidates = [];
    }

    let snapshot: RepositorySnapshot;
    try {
      snapshot = importSnapshot(projectId, project.hostPath, options);
    } catch (err) {
      if (err instanceof RepositoryImportError) {
        // 被阻断是正常终态，作为数据返回，不作为异常抛出
        return {
          outcome: 'BLOCKED',
          code: err.code,
          message: err.message,
          detail: err.detail,
          candidates,
        };
      }
      throw err;
    }

    const profile = resolveProfile(snapshot);
    this.snapshots.set(snapshot.snapshotId, snapshot);
    this.profiles.set(profile.profileId, profile);
    return { outcome: 'IMPORTED', snapshot, profile, candidates };
  }

  // -------------------------------------------------------------------------
  // 任务 / Run
  // -------------------------------------------------------------------------

  private createTask(input: {
    projectId: string;
    snapshotId: string;
    profileId: string;
    modelProfileId: string;
    goal: string;
    taskClass: TaskSpec['taskClass'];
    allowedPaths: string[];
    acceptance: string[];
    verificationCommandIds: string[];
    customCommands?: Array<{ label: string; argv: string[] }>;
  }): { task: TaskSpec; run: RunView } {
    const project = this.projects.get(input.projectId);
    const snapshot = this.snapshots.get(input.snapshotId);
    const profile = this.profiles.get(input.profileId);
    if (!project || !snapshot || !profile) throw platformError('NOT_FOUND', '项目/快照/Profile 不存在');

    /*
     * 这里**不再有 profile 门禁**。任何导入进来的项目都可以创建任务。
     *
     * 唯一还成立的约束不是"能不能跑"，而是"能不能声称成功"：
     * 没有验证命令时 Run 仍然照常执行、照常产出补丁，只是终态只能是
     * `ACCEPTED_UNVERIFIED` 而不是 `SUCCEEDED`。约束在终态处强制，不在入口处拦人。
     */
    const effectiveProfile = this.withUserCommands(profile, input.customCommands ?? []);
    const unknownCommands = input.verificationCommandIds.filter(
      // hasOwnProperty：否则 'constructor' 这类 id 能通过这道校验，一路走到运行时崩溃
      (id) => !Object.prototype.hasOwnProperty.call(effectiveProfile.commands, id),
    );
    if (unknownCommands.length > 0) {
      throw platformError('BAD_REQUEST', `未登记的验证命令: ${unknownCommands.join(', ')}`);
    }
    this.profiles.set(effectiveProfile.profileId, effectiveProfile);

    const resolution = this.gateway.freezeRoute(input.modelProfileId);

    const task: TaskSpec = {
      taskId: newId('task'),
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      profileId: effectiveProfile.profileId,
      goal: input.goal,
      taskClass: input.taskClass,
      // 不再默认收窄到 src/**：用户信任的是整个项目
      allowedPaths: input.allowedPaths.length ? input.allowedPaths : ['**'],
      protectedPaths: effectiveProfile.protectedPaths,
      nonGoals: [],
      acceptance: input.acceptance,
      verificationCommandIds: input.verificationCommandIds,
      budget: {
        maxModelTurns: 40,
        maxToolCalls: 80,
        maxSelfFixRounds: 2,
        maxWallClockMs: 20 * 60 * 1000,
        maxTotalTokens: 600_000,
      },
      createdAt: nowIso(),
    };

    const runId = newId('run');
    const attemptId = newId('att');
    // 依赖复用要指向快照对应的那个目录：子包导入时是子包自己的 node_modules
    const depsRoot = snapshot.subPath ? join(project.hostPath, snapshot.subPath) : project.hostPath;
    const workspace = MaterializedWorkspace.create(runId, snapshot.snapshotId, depsRoot);

    const view: RunView = {
      runId,
      taskId: task.taskId,
      projectId: input.projectId,
      title: task.goal.length > 60 ? `${task.goal.slice(0, 60)}…` : task.goal,
      attemptId,
      attemptNo: 1,
      status: 'CREATED',
      statusReason: null,
      ledger: EMPTY_LEDGER,
      limits: task.budget,
      workspaceGeneration: workspace.activeGeneration,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      terminalFacts: null,
      restored: false,
      evidence: 'INTACT',
      evidenceDetail: null,
    };

    const record: RunRecord = {
      view,
      task,
      snapshot,
      profile: effectiveProfile,
      workspace,
      events: new EventStore(runId),
      abort: new AbortController(),
      deadline: null,
      toolCalls: new Map(),
      verifications: [],
      approvals: new Map(),
      plan: null,
      patch: null,
    };
    this.runs.set(runId, record);

    this.emit(record, 'RUN_CREATED', `任务已创建：${task.goal}`, {
      taskId: task.taskId,
      snapshotId: snapshot.snapshotId,
      route: { providerId: resolution.providerId, modelId: resolution.modelId, origin: resolution.origin },
      // 越过默认门禁的事实必须留在事件里，不能只存在于当时那次点击
      baseKind: snapshot.baseKind,
      dirtyFileCount: snapshot.dirtyFileCount,
      subPath: snapshot.subPath || null,
      profileSupportStatus: effectiveProfile.supportStatus,
      verificationCommands: input.verificationCommandIds,
      userDefinedCommands: (input.customCommands ?? []).length,
    });

    // 这些不是拦截，是**如实标注**：任何影响"成功意味着什么"的事实都进事件
    if (snapshot.baseKind === 'DIRTY_WORKTREE') {
      this.emit(
        record,
        'NOTE',
        `基线是工作区快照而非干净 commit（${snapshot.dirtyFileCount} 项本地改动）：补丁的 base 无法被他人从 ${snapshot.baseSha.slice(0, 12)} 重建`,
      );
    }
    if (snapshot.baseKind === 'NO_VCS') {
      this.emit(record, 'NOTE', '该项目不在版本控制下：基线是导入当时的目录内容，没有可回溯的 commit');
    }
    if (input.verificationCommandIds.length === 0) {
      this.emit(
        record,
        'NOTE',
        '本次任务没有选择任何验证命令：改动不会被机器验证，接受后终态为 ACCEPTED_UNVERIFIED 而不是 SUCCEEDED',
      );
    }

    // 异步启动，不阻塞 IPC 响应
    void this.execute(record, resolution);

    return { task, run: view };
  }

  private async execute(record: RunRecord, resolution: ReturnType<ModelGateway['freezeRoute']>): Promise<void> {
    const startedAt = Date.now();
    // 恢复态的 Run 没有活工作区，永远不该走到执行路径。真走到了就明确停住，
    // 而不是让一个 null 在深处炸成未分类异常。
    const workspace = record.workspace;
    if (!workspace) {
      this.setStatus(record, 'INTERRUPTED', '内部不变式违规：尝试执行一个没有工作区的 Run');
      return;
    }

    const deadline = new PausableDeadline(record.task.budget.maxWallClockMs, () => {
      if (!isTerminal(record.view.status)) {
        record.abort.abort();
        // 防御性：正常情况下审批期间 deadline 是暂停的，不会在这里撞上待审批；
        // 但万一撞上，也要兑现 Promise 让 runAgent 解开、finally 得以执行。
        this.cleanupPendingApprovals(record);
        this.setStatus(record, 'TIMED_OUT', '超过任务时间预算');
      }
    });
    record.deadline = deadline;

    try {
      const result = await runAgent({
        task: record.task,
        snapshot: record.snapshot,
        profile: record.profile,
        workspace,
        gateway: this.gateway,
        resolution,
        mutationPolicy: {
          ...DEFAULT_MUTATION_POLICY,
          allowedPaths: record.task.allowedPaths,
          protectedPaths: record.task.protectedPaths,
        },
        runId: record.view.runId,
        attemptId: record.view.attemptId,
        signal: record.abort.signal,
        host: this.hostFor(record, startedAt, deadline),
      });

      for (const v of [result.baseline, result.finalVerification]) {
        if (v && !record.verifications.some((x) => x.verificationRunId === v.verificationRunId)) {
          record.verifications.push(v);
        }
      }

      switch (result.kind) {
        case 'PATCH_READY': {
          const comparison =
            result.baseline && result.finalVerification
              ? compareVerification(result.baseline, result.finalVerification)
              : null;
          const patch = sealPatch(
            workspace,
            record.view.runId,
            record.view.attemptId,
            record.snapshot.baseSha,
            result.finalVerification,
            comparison,
            result.unverifiedItems,
          );
          record.patch = patch;
          this.emit(
            record,
            'PATCH_SEALED',
            `补丁已封存：${patch.files.length} 个文件，+${patch.files.reduce((n, f) => n + f.addedLines, 0)}/-${patch.files.reduce((n, f) => n + f.removedLines, 0)}`,
            { patchId: patch.patchId, digest: patch.digest, files: patch.files.map((f) => f.path) },
          );
          this.setStatus(record, 'AWAITING_PATCH_REVIEW', result.detail);
          break;
        }
        case 'PLAN_REJECTED':
          this.setStatus(record, 'BLOCKED', result.detail);
          break;
        case 'NO_CHANGES':
          this.setStatus(record, 'FAILED', result.detail);
          break;
        case 'VERIFICATION_FAILED':
          this.setStatus(record, 'FAILED', result.detail);
          break;
        case 'BLOCKED':
          this.setStatus(record, 'BLOCKED', result.detail);
          break;
      }
    } catch (err) {
      if (err instanceof AgentCancelled || record.abort.signal.aborted) {
        if (!isTerminal(record.view.status)) this.setStatus(record, 'CANCELLED', '已取消');
      } else if (err instanceof EgressBlocked) {
        this.setStatus(record, 'BLOCKED', `模型出站被阻断：${err.reason}`);
      } else if (err instanceof InvocationFailed) {
        this.setStatus(record, 'FAILED', `模型调用失败：${err.cause.kind} — ${err.message}`);
      } else if (err instanceof PlanningFailed) {
        this.setStatus(record, 'FAILED', `规划失败：${err.message}`);
      } else {
        this.setStatus(record, 'FAILED', `运行时异常：${(err as Error).message}`);
      }
    } finally {
      deadline.clear();
      record.deadline = null;
      this.cleanupPendingApprovals(record);
      if (isTerminal(record.view.status) && record.view.status !== 'AWAITING_PATCH_REVIEW') {
        this.emit(record, 'CLEANUP_SUMMARY', '已释放模型流、子进程与审批等待', {
          workspaceRetained: record.view.status === 'SUCCEEDED',
        });
      }
    }
  }

  private hostFor(record: RunRecord, startedAt: number, deadline: PausableDeadline) {
    return {
      emit: (kind: RunEventKind, summary: string, payload: Record<string, unknown> = {}) =>
        this.emit(record, kind, summary, payload),

      setStatus: (status: RunStatus, reason: string | null) => this.setStatus(record, status, reason),

      awaitPlanApproval: (plan: PlanRevision): Promise<ApprovalDecisionKind> => {
        record.plan = plan;
        const request: ApprovalRequest = {
          approvalId: newId('appr'),
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          kind: 'PLAN',
          risk: 'R1',
          title: '批准执行计划',
          detail: plan.summary,
          subjectDigest: plan.digest,
          requestedAt: nowIso(),
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        };

        // 人工审批不消耗计算预算：暂停墙钟，用户决定后再恢复。
        deadline.pause();

        return new Promise<ApprovalDecisionKind>((resolve, reject) => {
          // 已被取消就别挂起了，否则 runAgent 永远等不到（addEventListener 对已 abort
          // 的 signal 不会再触发）。正常路径上 runAgent 在调用本函数前刚 throwIfCancelled 过。
          if (record.abort.signal.aborted) {
            deadline.resume();
            reject(new AgentCancelled('审批开始前已取消'));
            return;
          }

          const cleanup = (): void => {
            clearTimeout(expiry);
            record.abort.signal.removeEventListener('abort', onAbort);
            record.approvals.delete(request.approvalId);
            this.pushApprovals(record);
          };

          // 取消 / 超时（deadline 兜底）→ abort：兑现 Promise，让 runAgent 解开、finally 执行。
          const onAbort = (): void => {
            cleanup();
            reject(new AgentCancelled('审批等待期间被中止'));
          };

          // 审批自身的过期（30 分钟未决定）→ BLOCKED，与「计算超时 TIMED_OUT」区分。
          // 之前这条只能被"用户回来点按钮"惰性触发，且那条分支只 delete 不 resolve，
          // 于是 Promise 永久泄漏、CLEANUP_SUMMARY 永远发不出来。
          const expiry = setTimeout(() => {
            if (!record.approvals.has(request.approvalId)) return;
            this.emit(record, 'NOTE', '计划审批已过期（超过 30 分钟未决定），已停止');
            this.setStatus(record, 'BLOCKED', '计划审批已过期（超过 30 分钟未决定）');
            record.abort.abort(); // 触发 onAbort → cleanup + reject
          }, APPROVAL_TTL_MS);
          expiry.unref?.();

          record.approvals.set(request.approvalId, {
            request,
            resolve: (decision: ApprovalDecisionKind) => {
              cleanup();
              deadline.resume(); // 决定完成，计算预算继续计时
              resolve(decision);
            },
          });
          record.abort.signal.addEventListener('abort', onAbort, { once: true });
          this.pushApprovals(record);
        });
      },

      beginToolCall: (input: {
        toolName: string;
        risk: ToolRisk;
        argsSummary: string;
        argsDigest: string;
      }): string => {
        const view: ToolCallView = {
          toolCallId: newId('tc'),
          runId: record.view.runId,
          attemptId: record.view.attemptId,
          toolName: input.toolName,
          risk: input.risk,
          argsSummary: input.argsSummary,
          argsDigest: input.argsDigest,
          resolution: null,
          resolutionReason: null,
          preview: null,
          previewTruncated: false,
          artifactRef: null,
          startedAt: nowIso(),
          resolvedAt: null,
          durationMs: null,
        };
        record.toolCalls.set(view.toolCallId, view);
        this.emit(record, 'TOOL_CALL_PROPOSED', `${input.toolName}: ${input.argsSummary}`, {
          toolCallId: view.toolCallId,
          risk: input.risk,
        });
        this.push({ type: 'toolcall.updated', toolCall: view });
        return view.toolCallId;
      },

      endToolCall: (
        toolCallId: string,
        resolution: ToolCallResolution,
        reason: string | null,
        preview: string,
        previewTruncated: boolean,
        artifactRef: string | null,
      ): void => {
        const prev = record.toolCalls.get(toolCallId);
        if (!prev) return;
        const updated: ToolCallView = {
          ...prev,
          resolution,
          resolutionReason: reason,
          preview,
          previewTruncated,
          artifactRef,
          resolvedAt: nowIso(),
          durationMs: Date.now() - Date.parse(prev.startedAt),
        };
        record.toolCalls.set(toolCallId, updated);
        this.emit(record, 'TOOL_CALL_RESOLVED', `${prev.toolName} → ${resolution}`, {
          toolCallId,
          resolution,
          reason,
        });
        this.persist(record);
        this.push({ type: 'toolcall.updated', toolCall: updated });
      },

      chargeModelTurn: (inputTokens: number, outputTokens: number) =>
        this.charge(record, startedAt, {
          modelTurns: 1,
          inputTokens,
          outputTokens,
        }),

      chargeToolCall: () => this.charge(record, startedAt, { toolCalls: 1 }),

      chargeSelfFixRound: () => this.charge(record, startedAt, { selfFixRounds: 1 }),

      budgetExceeded: () => {
        const l = record.view.ledger;
        const lim = record.task.budget;
        if (l.modelTurns >= lim.maxModelTurns) return { exceeded: true, reason: `模型轮次达上限 ${lim.maxModelTurns}` };
        if (l.toolCalls >= lim.maxToolCalls) return { exceeded: true, reason: `工具调用达上限 ${lim.maxToolCalls}` };
        if (l.inputTokens + l.outputTokens >= lim.maxTotalTokens) {
          return { exceeded: true, reason: `token 达上限 ${lim.maxTotalTokens}` };
        }
        if (Date.now() - startedAt >= lim.maxWallClockMs) return { exceeded: true, reason: '超过时间预算' };
        return { exceeded: false, reason: '' };
      },
    };
  }

  /** 账本只增不减 —— retry / deny / cancel 都不回退已消耗量 */
  private charge(record: RunRecord, startedAt: number, delta: Partial<BudgetLedger>): void {
    const l = record.view.ledger;
    record.view = {
      ...record.view,
      ledger: {
        modelTurns: l.modelTurns + (delta.modelTurns ?? 0),
        toolCalls: l.toolCalls + (delta.toolCalls ?? 0),
        selfFixRounds: l.selfFixRounds + (delta.selfFixRounds ?? 0),
        elapsedMs: Date.now() - startedAt,
        inputTokens: l.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: l.outputTokens + (delta.outputTokens ?? 0),
      },
      workspaceGeneration: record.workspace?.activeGeneration ?? record.view.workspaceGeneration,
      updatedAt: nowIso(),
    };
    this.push({ type: 'run.updated', run: record.view });
  }

  // -------------------------------------------------------------------------
  // 审批
  // -------------------------------------------------------------------------

  private decideApproval(input: {
    approvalId: string;
    decision: ApprovalDecisionKind;
    subjectDigest: string;
    note: string;
  }): { accepted: boolean; reason: string | null } {
    for (const record of this.runs.values()) {
      const pending = record.approvals.get(input.approvalId);
      if (!pending) continue;
      if (record.view.restored) {
        return { accepted: false, reason: '该 Run 已从磁盘恢复，没有在等待这个审批的执行器' };
      }

      // 已进入终态的 Run 不再接受审批决定 —— 否则会往一个 TIMED_OUT/CANCELLED 的
      // Run 上追加一条"用户批准了计划"的假审计记录，然后什么都不执行。
      if (isTerminal(record.view.status)) {
        return { accepted: false, reason: `当前状态 ${record.view.status} 不再接受审批决定` };
      }

      // digest 不匹配 = 审批对象已变化，旧审批失效（PRD-APPR-002）
      if (pending.request.subjectDigest !== input.subjectDigest) {
        return { accepted: false, reason: '审批对象已变化，请重新查看后再决定' };
      }
      if (Date.parse(pending.request.expiresAt) < Date.now()) {
        // 与代理超时定时器同样处理：置 BLOCKED 并 abort（→ onAbort 兑现 Promise 并清理）。
        // 绝不能只 delete 不 resolve —— 那正是之前 Promise 永久泄漏、CLEANUP_SUMMARY
        // 永远发不出来的根因。
        this.setStatus(record, 'BLOCKED', '计划审批已过期');
        record.abort.abort();
        return { accepted: false, reason: '审批已过期' };
      }

      // pending.resolve 内部会清理定时器/监听、恢复墙钟、并从 map 删除
      pending.resolve(input.decision);
      return { accepted: true, reason: null };
    }
    return { accepted: false, reason: '审批请求不存在或已被处理' };
  }

  private pushApprovals(record: RunRecord): void {
    this.push({
      type: 'approval.updated',
      runId: record.view.runId,
      approvals: [...record.approvals.values()].map((a) => a.request),
    });
  }

  private cleanupPendingApprovals(record: RunRecord): void {
    // 先快照：pending.resolve 内部会从 record.approvals 删除自己，
    // 边遍历边删原 map 容易漏项。
    const pendings = [...record.approvals.values()];
    for (const pending of pendings) {
      pending.resolve('REJECT'); // 内部 cleanup：清定时器/监听、从 map 删除、恢复墙钟（已 clear 时为 no-op）
    }
    record.approvals.clear();
    this.pushApprovals(record);
  }

  // -------------------------------------------------------------------------
  // 补丁决定 —— 唯一能进入 SUCCEEDED 的入口
  // -------------------------------------------------------------------------

  private decidePatch(input: {
    runId: string;
    patchId: string;
    decision: PatchDecisionKind;
    patchDigest: string;
    note: string;
  }): { run: RunView; reason: string | null } {
    const record = this.require(input.runId);
    if (!record.patch) throw platformError('CONFLICT', '当前 Run 没有可决定的补丁');
    if (record.patch.patchId !== input.patchId || record.patch.digest !== input.patchDigest) {
      return { run: record.view, reason: '补丁已变化，请刷新后重新决定' };
    }
    if (record.view.status !== 'AWAITING_PATCH_REVIEW') {
      return { run: record.view, reason: `当前状态 ${record.view.status} 不接受补丁决定` };
    }

    const acceptanceId = newId('acc');
    this.emit(record, 'PATCH_DECISION', `用户决定：${input.decision}`, {
      patchId: record.patch.patchId,
      decision: input.decision,
      note: input.note,
      acceptanceId,
    });

    if (input.decision === 'ACCEPT') {
      /*
       * 这是整套设计里最后一条不肯让步的规则：
       *   有通过的验证 + 用户接受 → SUCCEEDED
       *   只有用户接受            → ACCEPTED_UNVERIFIED
       *
       * 两者都是"接受了补丁"，但只有前者能说"这是被证明过的"。
       * 门禁全部放开之后，正是这条区分让 SUCCEEDED 还剩下意义。
       */
      const verified =
        record.patch.verificationRunId !== null &&
        record.verifications.some(
          (v) => v.verificationRunId === record.patch!.verificationRunId && v.passed,
        );

      record.view = {
        ...record.view,
        terminalFacts: {
          verificationRunId: verified ? record.patch.verificationRunId : null,
          patchAcceptanceId: acceptanceId,
        },
      };
      this.setStatus(
        record,
        verified ? 'SUCCEEDED' : 'ACCEPTED_UNVERIFIED',
        verified
          ? '验证通过且用户已接受补丁（补丁未写回宿主仓库，需另行导出）'
          : '用户已接受补丁，但没有通过的机器验证支撑 —— 正确性仅由人工判断',
      );
    } else if (input.decision === 'REJECT') {
      this.setStatus(record, 'BLOCKED', `用户拒绝了补丁：${input.note || '未填写原因'}`);
    } else {
      this.setStatus(record, 'BLOCKED', `用户要求修改：${input.note || '未填写反馈'}（原型暂未实现新 Attempt）`);
    }

    return { run: record.view, reason: null };
  }

  // -------------------------------------------------------------------------
  // 保留期与清理
  // -------------------------------------------------------------------------

  /**
   * 当前还活着的引用。清理器据此决定什么能删。
   *
   * 之所以由权威层提供而不是让 retention 自己扫：只有这里知道 Run 的终态、
   * 以及 toolCall/patch 引用了哪些 artifact。让清理器反向依赖 authority 会绕成环。
   */
  private liveReferences(): LiveReferences {
    const runs = new Map<string, { terminal: boolean; terminalAt: number | null; updatedAt: number }>();
    const snapshots = new Set<string>();
    const artifacts = new Set<string>();

    for (const [runId, record] of this.runs) {
      const terminal = isTerminal(record.view.status);
      runs.set(runId, {
        terminal,
        terminalAt: terminal ? Date.parse(record.view.updatedAt) : null,
        updatedAt: Date.parse(record.view.updatedAt),
      });
      if (record.snapshot?.snapshotId) snapshots.add(record.snapshot.snapshotId);
      for (const tc of record.toolCalls.values()) {
        if (tc.artifactRef) artifacts.add(tc.artifactRef);
      }
      if (record.patch) artifacts.add(record.patch.patchId);
    }
    return { runs, snapshots, artifacts };
  }

  /**
   * 跑一轮清理，并把结果写进相关 Run 的事件流。
   *
   * 被清理掉的 Run 要从内存里一并移除 —— 否则 UI 上还挂着一个已经没有任何
   * 磁盘数据支撑的条目，那是另一种形式的说谎。
   */
  private runSweep(trigger: string): PurgeSummary {
    const summary = sweep(this.liveReferences());

    for (const item of summary.items) {
      if (item.outcome !== 'DELETED') continue;
      if (item.domain === 'RUN_EVIDENCE') {
        this.runs.delete(item.target);
      } else if (item.domain === 'WORKSPACE') {
        const record = this.runs.get(item.target);
        if (record) {
          // 工作区没了，但 Run 记录还在：如实记一笔，别让用户以为文件树只是加载失败
          record.events.append(
            record.view.attemptId,
            'CLEANUP_SUMMARY',
            `工作区副本已按保留策略回收（释放 ${formatBytes(item.bytesFreed)}）`,
            { domain: 'WORKSPACE', trigger },
          );
        }
      }
    }

    if (summary.deleted > 0 || summary.status === 'INCOMPLETE') {
      console.log(
        `[core] 清理(${trigger}): 扫描 ${summary.scanned} 项，删除 ${summary.deleted} 项，` +
          `释放 ${formatBytes(summary.bytesFreed)}，结果 ${summary.status}` +
          `${summary.incompleteReason ? ` —— ${summary.incompleteReason}` : ''}`,
      );
    }
    this.push({ type: 'retention.swept', summary });
    return summary;
  }

  /** 启动时跑一次，之后每 6 小时一次。不做高频轮询。 */
  private startRetentionSchedule(): void {
    // 启动时延后一点，别和 rehydrate、首屏加载抢 I/O
    setTimeout(() => this.runSweep('startup'), 5_000).unref?.();
    const timer = setInterval(() => this.runSweep('scheduled'), 6 * 60 * 60 * 1000);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // 文件浏览（只读）
  // -------------------------------------------------------------------------

  /** 选定读取根：有 Run 就看它工作区的当前代，否则看快照原貌 */
  private browseRoot(
    snapshotId: string,
    runId: string | null,
  ): { root: string; baselineRoot: string | null; source: 'SNAPSHOT' | 'WORKSPACE'; generation: number | null } {
    if (runId) {
      const record = this.runs.get(runId);
      if (record && !record.workspace) {
        throw platformError(
          'CONFLICT',
          '该 Run 已从磁盘恢复，工作区不再可用',
          '只能查看导入时的快照原貌；补丁内容仍可在「补丁审查」里查看和导出',
        );
      }
      if (record && record.workspace) {
        return {
          root: record.workspace!.activePath,
          baselineRoot: record.workspace!.baselinePath(),
          source: 'WORKSPACE',
          generation: record.workspace!.activeGeneration,
        };
      }
    }
    if (!this.snapshots.has(snapshotId)) throw platformError('NOT_FOUND', '快照不存在');
    return { root: snapshotDir(snapshotId), baselineRoot: null, source: 'SNAPSHOT', generation: null };
  }

  private fileTree(snapshotId: string, runId: string | null) {
    const { root, baselineRoot, source, generation } = this.browseRoot(snapshotId, runId);
    const baseline = baselineRoot
      ? new Map(listTree(baselineRoot).map((f) => [f.path, f.digest]))
      : null;

    const entries: FileTreeEntry[] = listTree(root)
      .filter((f) => !isGeneratedPath(f.path))
      .map((f) => ({
        path: f.path,
        bytes: f.bytes,
        changed: baseline ? baseline.get(f.path) !== f.digest : false,
      }));

    return { entries, source, generation };
  }

  private readFile(snapshotId: string, path: string, runId: string | null) {
    const { root, baselineRoot } = this.browseRoot(snapshotId, runId);
    let abs: string;
    try {
      abs = resolveManaged(root, path); // 拒绝绝对路径 / `..` / symlink
    } catch (err) {
      throw platformError('POLICY_DENIED', (err as Error).message);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw platformError('NOT_FOUND', `文件不存在: ${path}`);
    }

    const raw = readFileSync(abs);
    // 含 NUL 字节就当二进制处理，不往 Renderer 塞乱码
    const binary = raw.subarray(0, 8000).includes(0);
    const truncated = raw.byteLength > MAX_VIEW_BYTES;
    const changed = baselineRoot
      ? (fileDigestAt(baselineRoot, path) ?? null) !== sha256(raw)
      : false;

    return {
      path,
      content: binary ? '' : raw.subarray(0, MAX_VIEW_BYTES).toString('utf8'),
      bytes: raw.byteLength,
      truncated,
      binary,
      changed,
    };
  }

  // -------------------------------------------------------------------------
  // 补丁交付
  // -------------------------------------------------------------------------

  /**
   * 把补丁真正应用回宿主仓库。
   *
   * 这是整个原型里**唯一**会写用户仓库的路径，因此：
   *   - 只有被**接受过**的补丁才能写：门禁必须在 Core，而不是只靠 Renderer 藏起按钮。
   *     （之前唯一的门禁是 RunDetail.tsx 里一个决定按钮显不显示的布尔量，任何一次
   *     重放 / 渲染 bug / 直接走 IPC 都能把**被拒绝的**补丁写进用户仓库。）
   *   - digest 必须与调用方看到的一致：「被应用的东西」= 「被接受的东西」。
   *   - 交给 `git apply` 做，不自己实现 patch 应用逻辑。
   *   - 先 `--check` 干跑一遍；有任何一处冲突就整笔拒绝，不做部分应用。
   *   - 子包导入时用 `--directory` 把坐标系还原回仓库根。
   *   - 结果如实回报，失败时原样带出 git 的错误。
   */
  private applyPatchToRepo(
    runId: string,
    patchId: string,
    patchDigest: string | undefined,
  ): PatchExportResult {
    const record = this.require(runId);
    if (!record.patch || record.patch.patchId !== patchId) {
      return { ok: false, reason: 'PATCH_CHANGED', detail: '补丁不存在或已变化，请刷新' };
    }

    // 接受态 + digest 双重门禁，抽成纯函数以便单测（见 checkPatchApplyGate）
    const gate = checkPatchApplyGate({
      status: record.view.status,
      patchAcceptanceId: record.view.terminalFacts?.patchAcceptanceId ?? null,
      actualDigest: record.patch.digest,
      requestedDigest: patchDigest,
    });
    if (!gate.ok) return gate;
    if (record.view.evidence === 'DAMAGED' || !record.snapshot || !record.task) {
      return {
        ok: false,
        reason: 'EVIDENCE_DAMAGED',
        detail: '该 Run 的状态快照已损坏，无法确定补丁的坐标系，拒绝应用',
      };
    }
    const project = this.projects.get(record.task.projectId);
    if (!project) return { ok: false, reason: 'PROJECT_MISSING', detail: '项目不存在' };
    if (record.snapshot.baseKind === 'NO_VCS') {
      return {
        ok: false,
        reason: 'NOT_A_GIT_REPO',
        detail: '该项目不在 git 管理下，无法用 git apply 安全应用。请改用「保存为文件」。',
      };
    }
    if (record.patch.files.length === 0) {
      return { ok: false, reason: 'EMPTY_PATCH', detail: '补丁为空' };
    }
    if (record.patch.files.some((f) => f.diffTruncated)) {
      return {
        ok: false,
        reason: 'PATCH_TRUNCATED',
        detail: '补丁中有被截断的 diff，应用会产生不完整结果。请改用「保存为文件」后手工处理。',
      };
    }

    const paths = record.patch.files.map((f) => f.path);
    const result = applyPatchWithGit(
      project.hostPath,
      record.snapshot.subPath,
      record.patch.unifiedDiff,
      join(PATHS.artifacts, `${record.patch.patchId}.diff`),
      paths,
    );

    if (!result.ok) {
      this.emit(record, 'NOTE', `补丁应用被拒绝（${result.stage}）：${result.detail.slice(0, 300)}`);
      return result.stage === 'CHECK'
        ? {
            ok: false,
            reason: 'APPLY_CONFLICT',
            detail: `git 认为这个补丁无法干净应用，已整笔拒绝、未改动任何文件：\n\n${result.detail}`,
          }
        : {
            ok: false,
            reason: 'APPLY_FAILED',
            detail: `--check 通过但实际应用失败（文件可能在这期间被改动）：\n\n${result.detail}`,
          };
    }

    this.emit(record, 'NOTE', `补丁已应用到宿主仓库：${paths.join(', ')}`, {
      applied: paths,
      subPath: record.snapshot.subPath || null,
    });
    return {
      ok: true,
      mode: 'APPLY_TO_REPO',
      detail: `已写入 ${paths.length} 个文件。改动尚未 commit，你可以用 git diff 复核，或 git checkout -- . 撤销。`,
      target: project.ref.displayPath,
    };
  }

  // -------------------------------------------------------------------------
  // 通用
  // -------------------------------------------------------------------------

  private cancel(runId: string, reason: string): RunView {
    const record = this.require(runId);
    if (isTerminal(record.view.status)) return record.view;
    if (record.view.restored) {
      // 恢复态唯一可能的非终态是 AWAITING_PATCH_REVIEW，那里没有进程可停
      this.setStatus(record, 'BLOCKED', `${reason}（该 Run 已从磁盘恢复，无运行中的进程）`);
      return record.view;
    }
    record.abort.abort();
    this.cleanupPendingApprovals(record);
    this.setStatus(record, 'CANCELLED', reason);
    return record.view;
  }

  private setStatus(record: RunRecord, status: RunStatus, reason: string | null): void {
    if (isTerminal(record.view.status)) return; // 终态不可逆
    const facts = record.view.terminalFacts;
    if (status === 'SUCCEEDED' && !(facts?.verificationRunId && facts.patchAcceptanceId)) {
      throw new Error('内部不变式违规：SUCCEEDED 必须同时绑定通过的 verification 与 patch acceptance');
    }
    if (status === 'ACCEPTED_UNVERIFIED' && !facts?.patchAcceptanceId) {
      throw new Error('内部不变式违规：ACCEPTED_UNVERIFIED 必须绑定 patch acceptance');
    }
    const previous = record.view.status;
    record.view = {
      ...record.view,
      status,
      statusReason: reason,
      workspaceGeneration: record.workspace?.activeGeneration ?? record.view.workspaceGeneration,
      updatedAt: nowIso(),
    };
    this.emit(record, 'STATUS_CHANGED', `${previous} → ${status}${reason ? `（${reason}）` : ''}`, {
      from: previous,
      to: status,
      reason,
    });
    this.persist(record); // 事件已 append，此刻状态快照才允许追上
    this.push({ type: 'run.updated', run: record.view });

    // Run 刚终态，它的工作区通常是最大的一块 —— 过了宽限期就该回收
    if (isTerminal(status)) {
      setTimeout(() => this.runSweep('run-terminal'), 30_000).unref?.();
    }
  }

  private emit(
    record: RunRecord,
    kind: RunEventKind,
    summary: string,
    payload: Record<string, unknown> = {},
  ): void {
    const event = record.events.append(record.view.attemptId, kind, summary, payload);
    this.push({ type: 'run.event', runId: record.view.runId, event });
  }

  private require(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw platformError('NOT_FOUND', `Run 不存在: ${runId}`);
    return record;
  }
}

// ---------------------------------------------------------------------------

export class CoreError extends Error {
  constructor(readonly payload: PlatformError) {
    super(payload.message);
  }
}

export function platformError(
  code: PlatformError['code'],
  message: string,
  detail: string | null = null,
): CoreError {
  return new CoreError({ code, message, detail });
}

/** 恢复态 Run 用的 AbortController：一出生就是已取消，任何误用都会立刻停 */
function abortedController(): AbortController {
  const ac = new AbortController();
  ac.abort();
  return ac;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function suggestPatchFilename(record: RunRecord): string {
  const stamp = record.patch!.sealedAt.replace(/[:.]/g, '-').slice(0, 19);
  const scope = record.snapshot.subPath ? record.snapshot.subPath.replace(/\//g, '-') : 'repo';
  return `repopilot-${scope}-${stamp}.patch`;
}

/** 补丁文件带头部元信息：光有 diff 没法说明它是基于什么、验证过没有 */
function renderPatchFile(record: RunRecord): string {
  const p = record.patch!;
  const verified = p.verificationRunId !== null;
  const header = [
    `# RepoPilot patch`,
    `# patchId:     ${p.patchId}`,
    `# digest:      ${p.digest}`,
    `# sealedAt:    ${p.sealedAt}`,
    `# base:        ${record.snapshot.baseKind === 'NO_VCS' ? '(no vcs)' : p.baseSha}`,
    `# baseKind:    ${record.snapshot.baseKind}${
      record.snapshot.dirtyFileCount ? ` (${record.snapshot.dirtyFileCount} uncommitted changes at snapshot time)` : ''
    }`,
    `# scope:       ${record.snapshot.subPath || '(repository root)'}`,
    `# verified:    ${verified ? `yes (${p.verificationRunId})` : 'NO — accepted without machine verification'}`,
    `# task:        ${record.task.goal.replace(/\n/g, ' ')}`,
    `#`,
    `# apply with:  git apply -p1${record.snapshot.subPath ? ` --directory=${record.snapshot.subPath}` : ''} <this-file>`,
    `# revert with: git checkout -- ${p.files.map((f) => f.path).join(' ')}`,
    `#`,
    ...p.unverifiedItems.map((u) => `# unverified: ${u}`),
    '',
  ].join('\n');
  return `${header}${ensureTrailingNewline(p.unifiedDiff)}`;
}

function shortenPath(hostPath: string): string {
  const home = process.env.HOME ?? '';
  const shown = home && hostPath.startsWith(home) ? `~${hostPath.slice(home.length)}` : hostPath;
  const parts = shown.split('/');
  return parts.length <= 4 ? shown : `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

export { digestOf };
