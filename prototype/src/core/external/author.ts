import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandDefinition } from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { buildChildEnv, runCommand } from '../command';
import { describeDlpHits, scanSegments } from '../dlp';
import { listTree, type TreeEntry } from '../workspace';
import {
  descriptorOfConnector,
  isolatedEnv,
  type ExternalConnectorProfile,
  type ExternalInvocationManifest,
  type ExternalInvocationState,
} from './connector';

/**
 * 外部编码代理当**作者**（CANDIDATE_AUTHOR）：让本机的 Codex / Claude CLI 在一个
 * 一次性 candidate 目录里改代码。
 *
 * 这是 P1 合同 `external-coding-agent-cross-review.md` 里 candidate-to-canonical 边界
 * （TD-DEC-016）的可丢弃 spike 子集，不是合同实现：没有 connector 准入评审、
 * 没有 terms/版本准入、没有 network manifest、没有 resource/thermal 治理。
 *
 * 状态从哪来，是这条路最容易走歪的地方，所以先把它钉死：
 *
 *   **"作者写完了" = 子进程退出 + 平台对 candidate 目录做 tree diff。**
 *
 * 没有第二种来源。CLI 自己输出的"done"/摘要只是一条 untrusted 备注（authorNote），
 * 记进清单、展示给人看，不驱动任何判定。所以：
 *   - 退出码非零 / 超时 / 取消 → 本次调用 FAILED / TIMED_OUT / CANCELLED，
 *     candidate 里写了什么都**整笔丢弃**（调用方 discardCandidate），不看内容。
 *   - 退出码为零 → SEALED：平台把 candidate 树与导出时的 baseTree 逐文件比对，
 *     产出 CandidateTreeSeal（改了哪些、新增哪些、删了哪些，各自 digest）。
 *     seal 不是"采用"：采用发生在 normalize.ts 把 seal 归一化成 MutationPlan 并经
 *     applyMutationPlan（receipt + whole-file digest CAS + protected path + 预算）之后。
 *
 * 隔离与 reviewer 一致：synthetic HOME、整份替换的环境、只注入一个凭据变量、
 * 有界超时、进程组整树终止。与 reviewer 唯一的不同是 cwd 不再是空目录，而是
 * candidate 目录 —— 那是它唯一能写的地方，而且那里不是主线 generation。
 */

export type ExternalAuthorPhase = 'IMPLEMENT' | 'SELF_FIX' | 'REMEDIATE';

export interface CandidateChange {
  readonly path: string;
  readonly kind: 'MODIFIED' | 'ADDED' | 'DELETED';
  /** 变更后的字节数；DELETED 为 0 */
  readonly bytes: number;
}

/** 作者自己说的话 —— untrusted，只记录与展示，不驱动判定 */
export interface AuthorNote {
  readonly summary: string | null;
  readonly changedFiles: readonly string[];
  readonly gaveUp: boolean;
}

/**
 * candidate 目录在作者退出后的封存结果。只描述事实（哪些文件与 base 不同），
 * 不含任何"可以采用"的判断 —— 那是 normalize/apply 的事。
 */
export interface CandidateTreeSeal {
  readonly candidateId: string;
  readonly baseGeneration: number;
  readonly baseTreeDigest: string;
  readonly candidateTreeDigest: string;
  readonly changes: readonly CandidateChange[];
  readonly authorNote: AuthorNote | null;
}

export interface ExternalAuthorManifest extends ExternalInvocationManifest {
  readonly role: 'CANDIDATE_AUTHOR';
  readonly phase: ExternalAuthorPhase;
  readonly candidateId: string;
  /** SEALED 时为 changes 数；其他状态为 null（没看、也不该看） */
  readonly changedCount: number | null;
}

export interface ExternalAuthorResult {
  readonly manifest: ExternalAuthorManifest;
  /** 只有 SEALED 才有；其他状态一律 null，candidate 内容不被读取 */
  readonly seal: CandidateTreeSeal | null;
}

/** 两棵树逐文件比对。base/now 都来自 listTree（已排序、跳过 symlink） */
export function diffTrees(base: readonly TreeEntry[], now: readonly TreeEntry[]): CandidateChange[] {
  const baseMap = new Map(base.map((f) => [f.path, f]));
  const nowMap = new Map(now.map((f) => [f.path, f]));
  const out: CandidateChange[] = [];
  for (const f of now) {
    const b = baseMap.get(f.path);
    if (!b) out.push({ path: f.path, kind: 'ADDED', bytes: f.bytes });
    else if (b.digest !== f.digest) out.push({ path: f.path, kind: 'MODIFIED', bytes: f.bytes });
  }
  for (const f of base) {
    if (!nowMap.has(f.path)) out.push({ path: f.path, kind: 'DELETED', bytes: 0 });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * 从作者的自由文本输出里提取备注 JSON。解析不出就是 null —— 这不是失败：
 * 作者的话本来就不驱动判定，tree diff 才是事实。
 */
export function parseAuthorNote(raw: string): AuthorNote | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { summary?: unknown; changedFiles?: unknown; gaveUp?: unknown };
    if (typeof obj.summary !== 'string' && !Array.isArray(obj.changedFiles)) continue;
    return {
      summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 2_000) : null,
      changedFiles: Array.isArray(obj.changedFiles)
        ? obj.changedFiles.filter((x): x is string => typeof x === 'string').slice(0, 200)
        : [],
      gaveUp: obj.gaveUp === true,
    };
  }
  return null;
}

/** 作者简报 → CLI prompt。规则写死在平台侧，不随任务文本变化 */
export function renderCliAuthorPrompt(brief: string, phase: ExternalAuthorPhase): string {
  const phaseLine =
    phase === 'IMPLEMENT'
      ? '这是首次实现。'
      : phase === 'SELF_FIX'
        ? '上一版改动没有通过平台验证，这是自修复。'
        : '上一版补丁经独立模型审核被标出阻断问题，这是整改。';
  return `${brief}

————
你现在所在的目录（当前工作目录）是这个仓库的一份**一次性副本**。${phaseLine}
你是实现方，在这个目录里直接修改文件。规则：

- 只改任务允许的路径；不要碰受保护路径（配置文件、lockfile、CI、.git）。
- 不要运行 git，不要安装依赖，不要联网，不要创建或删除大批文件，不要重构任务之外的代码。
- 你改完后，**平台会在另一个隔离环境里重新跑验证**；你自己的判断不会被采信，所以不要为了"显得完成"而改验证配置或测试本身。
- 完成时（或者你决定放弃时）最后输出一个 JSON 对象：
  {"summary":"一句话说明你做了什么","changedFiles":["相对路径"],"gaveUp":false}
  这只是给人看的备注；平台以目录里的实际变更为准。`;
}

/**
 * 以作者身份跑一次外部 CLI。调用方负责 exportCandidate / discardCandidate ——
 * 这个函数只管"调用 + 退出即封存"，不拥有 candidate 的生命周期。
 */
export async function runExternalCliAuthor(input: {
  connector: ExternalConnectorProfile;
  apiKey: string;
  brief: string;
  phase: ExternalAuthorPhase;
  runId: string;
  attemptId: string;
  timeoutMs: number;
  signal: AbortSignal;
  candidate: {
    candidateId: string;
    path: string;
    baseGeneration: number;
    baseTree: readonly TreeEntry[];
  };
}): Promise<ExternalAuthorResult> {
  const d = descriptorOfConnector(input.connector.connectorId);
  const startedAt = nowIso();
  const started = Date.now();
  const prompt = renderCliAuthorPrompt(input.brief, input.phase);
  const inputDigest = digestOf({ prompt, baseGeneration: input.candidate.baseGeneration });
  const invocationId = newId('xinv');

  const base = {
    invocationId,
    runId: input.runId,
    attemptId: input.attemptId,
    role: 'CANDIDATE_AUTHOR' as const,
    phase: input.phase,
    candidateId: input.candidate.candidateId,
    connectorId: input.connector.connectorId,
    vendor: input.connector.vendor,
    identityDigest: input.connector.identityDigest,
    inputDigest,
    startedAt,
  };
  const seal = (
    state: ExternalInvocationState,
    exitCode: number | null,
    failureDetail: string | null,
    changedCount: number | null,
  ): ExternalAuthorManifest => ({
    ...base,
    state,
    exitCode,
    durationMs: Date.now() - started,
    settledAt: nowIso(),
    failureDetail,
    changedCount,
  });

  // PREFLIGHT：与 reviewer 同一套门槛；不满足就不发起
  if (!d || input.connector.state !== 'READY' || !input.connector.binaryPath) {
    return { manifest: seal('BLOCKED', null, `连接器不可用：${input.connector.detail}`, null), seal: null };
  }
  if (!input.apiKey.trim()) {
    return {
      manifest: seal('BLOCKED', null, `缺少 ${d.credentialEnvVar}：拒绝以宿主登录态运行外部 CLI`, null),
      seal: null,
    };
  }
  // 简报（含失败摘要 / 审核发现 / diff）是出站内容：与 ModelGateway 同一道 DLP
  const dlp = scanSegments([{ text: prompt, where: `author-brief:${input.phase}` }]);
  if (dlp.length > 0) {
    return { manifest: seal('BLOCKED', null, describeDlpHits(dlp), null), seal: null };
  }

  /*
   * 作者角色的准入闸门。描述符里 `authorArgv === null` 意味着这一家**只准入了
   * 审核方角色** —— 它的工具白名单/沙箱证据还不足以让它在 candidate 目录里写代码。
   *
   * 这道检查在这里而不只在 authority：author.ts 是所有作者调用的必经之路，
   * 挡在这里才不依赖上游每个调用点都记得查。
   */
  if (!d.authorArgv) {
    return {
      manifest: seal('BLOCKED', null, `${d.label} 尚未以作者身份准入（只准入了只读审核方）`, null),
      seal: null,
    };
  }

  const home = mkdtempSync(join(tmpdir(), 'repopilot-xauthor-'));
  try {
    const def: CommandDefinition = {
      commandId: `external-author:${d.connectorId}`,
      label: `${d.label} 作者`,
      argv: [input.connector.binaryPath, ...d.authorArgv],
      cwdRelative: '.',
      timeoutMs: input.timeoutMs,
      // 它会写文件 —— 但只写 candidate 目录；主线的写入权仍在 applyMutationPlan 手里
      risk: 'R1',
      source: 'DETECTED',
    };
    const outcome = await runCommand(def, input.candidate.path, input.signal, {
      env: isolatedEnv({
        pathValue: buildChildEnv().env.PATH ?? '',
        home,
        credential: { name: d.credentialEnvVar, value: input.apiKey },
        extraEnv: d.extraEnv,
      }),
      stdin: prompt,
    });

    if (outcome.outcome === 'TIMEOUT') {
      return { manifest: seal('TIMED_OUT', null, `超过 ${input.timeoutMs}ms —— candidate 整笔丢弃`, null), seal: null };
    }
    if (outcome.outcome === 'CANCELLED') {
      return { manifest: seal('CANCELLED', null, '调用被取消 —— candidate 整笔丢弃', null), seal: null };
    }
    if (outcome.outcome !== 'EXIT_ZERO') {
      return {
        manifest: seal(
          'FAILED',
          outcome.exitCode,
          `${outcome.outcome}: ${outcome.stderrPreview.slice(0, 300) || outcome.stdoutPreview.slice(0, 300)} —— candidate 整笔丢弃，不看内容`,
          null,
        ),
        seal: null,
      };
    }

    // 退出为零：封存 —— 事实来自 tree diff，不来自作者的话
    const now = listTree(input.candidate.path);
    const changes = diffTrees(input.candidate.baseTree, now);
    const treeSeal: CandidateTreeSeal = {
      candidateId: input.candidate.candidateId,
      baseGeneration: input.candidate.baseGeneration,
      baseTreeDigest: digestOf(input.candidate.baseTree),
      candidateTreeDigest: digestOf(now),
      changes,
      authorNote: parseAuthorNote(outcome.stdoutPreview),
    };
    return { manifest: seal('SEALED', outcome.exitCode, null, changes.length), seal: treeSeal };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
