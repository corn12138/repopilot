import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandDefinition, CrossReviewVerdict } from '@shared/domain';
import { digestOf, newId, nowIso } from '@shared/ids';
import { buildChildEnv, resolveBinary, runCommand } from '../command';

/**
 * 外部编码代理 CLI 连接器（本机装好的 Claude Code / Codex 当交叉审核选手）。
 *
 * 定位必须说在前面：这是 P1 合同
 * `docs/contracts/external-coding-agent-cross-review.md` 的一个**可丢弃 spike 子集**，
 * 不是那份合同的实现。合同状态仍是 `P1_DEFERRED / FEATURE_DISABLED`，
 * 这里没有 connector 评审流程、没有 terms/版本准入、没有 network manifest、
 * 没有 resource/thermal 治理，也**没有** CANDIDATE_AUTHOR 角色
 * （让外部 CLI 写代码要 disposable candidate workspace + single-writer epoch，
 * 风险高一个量级，不在本切片）。本切片只做 READ_ONLY_REVIEWER：
 * 外部 CLI 只读一段 diff 文本、只吐结构化发现，碰不到工作区、碰不到仓库。
 *
 * 合同里被当成硬边界照搬过来的几条（这些没打折）：
 *   - **synthetic HOME**：给一次性临时目录当 HOME/XDG_*，外部 CLI 读不到你真实的
 *     `~/.claude`、登录态、历史、settings、CLAUDE.md。合同原话是"无法用 OS 证据
 *     阻止读取真实 HOME/auth/history/settings 时 profile 保持 BLOCKED"。
 *   - **显式临时凭据 audience**：只注入调用方明确给的那一个 key 变量，
 *     不继承宿主环境里的任何凭据 —— 环境是整份替换，不是合并。
 *   - **异构 vendor 是不变式**：作者与审核方同厂商直接拒绝
 *     （SAME_VENDOR_REVIEW_DENIED），不是"披露一下就能继续"。
 *   - **只读**：cwd 是空的一次性目录，不挂载工作区；产出只有 finding，
 *     没有 mutation、没有终态权限。
 *
 * 形态是**动态探测**的，不假设用户装了 CLI。三种入口按可自动化程度排序：
 *   1. PATH 上的 CLI（或 env 显式指路）；
 *   2. **桌面应用 bundle 内打包的 CLI** —— ChatGPT.app 里就有一个完整的
 *      `Contents/Resources/codex`（codex-cli，带 exec/review 非交互子命令）。
 *      这不是 GUI 自动化，是合同允许的"可验证的非交互 CLI"，只是它随 .app 分发。
 *      早先版本把"装了 .app"一律判成不可自动化是**错的** —— 只看 PATH 就下结论，
 *      等于因为工具没装在常规位置就说它不存在。
 *   3. 只有 .app 且里面确实没有 CLI（Claude.app 实测如此）→ 才是真的不可自动化：
 *      驱动它只能靠 GUI 自动化/屏幕点击，那是合同第 2 节明令禁止的，也脆弱、
 *      也会动用户的登录态。这时如实报 `PRESENT_NOT_AUTOMATABLE` 并指向 API。
 *
 * 顺带一条产品判断：**用自己买的多家 API 做一写一审是最顺的路径** ——
 * 不依赖用户装了什么、不受 GUI 摆布、路由可冻结、用量可记账、异构随便配。
 * CLI 只是"你已经装了那就也能用"的补充。doctor 的推荐顺序按这个来。
 */

export type ExternalVendor = 'ANTHROPIC' | 'OPENAI';

export type ExternalConnectorKind = 'CLAUDE_CLI' | 'CODEX_CLI';

/**
 * 连接器状态（合同 ConnectorState 的诚实子集）。
 * 刻意把"没装"和"装了但不可用"分开 —— 合同枚举里两者都是 BLOCKED，
 * 但对用户来说前者是"去装一个"，后者是"去修一下"，混在一起没法给修复建议。
 */
export type ExternalConnectorState =
  | 'READY'
  | 'NOT_INSTALLED'
  /** 装了桌面应用但没有可自动化入口 —— 检测得到，用不了，必须说清楚 */
  | 'PRESENT_NOT_AUTOMATABLE'
  | 'BLOCKED';

/**
 * 检测到的入口形态。前两种可自动化（都是非交互 CLI）。
 * BUNDLED_CLI 单独标出来是因为它随 .app 分发 —— 升级/卸载桌面应用会让它消失，
 * 值得在界面上与独立安装的 CLI 区分。
 */
export type ExternalAgentForm = 'CLI' | 'BUNDLED_CLI' | 'DESKTOP_APP';

export interface ExternalConnectorDescriptor {
  readonly connectorId: string;
  readonly kind: ExternalConnectorKind;
  readonly vendor: ExternalVendor;
  readonly label: string;
  /**
   * 候选可执行名，按顺序试第一个命中的。多候选是因为同一工具在不同安装方式下
   * 名字可能不同 —— 写死一个名字等于假设用户的安装方式。
   */
  readonly binaries: readonly string[];
  /**
   * 显式覆盖路径的环境变量：装在非常规位置时的逃生口，
   * 不逼用户改 PATH（GUI 应用继承的是 launchd 的 PATH，改了也未必生效）。
   */
  readonly binaryPathEnv: string;
  /** 桌面应用候选位置（macOS bundle） */
  readonly appBundles: readonly string[];
  /**
   * bundle 内可能打包的 CLI 相对路径。ChatGPT.app 就在
   * `Contents/Resources/codex` 放了一个完整的 codex-cli。
   * 命中它 = 拿到合法的非交互入口，与 GUI 自动化无关。
   */
  readonly bundledBinaryRelPaths: readonly string[];
  /** 探测版本用的参数 */
  readonly versionArgv: readonly string[];
  /**
   * 非交互入口（合同的 allowedNonInteractiveEntry）：prompt 走 stdin。
   * 只允许这一条形态 —— 不接受运行时拼接的任意 argv。
   */
  readonly reviewArgv: readonly string[];
  /** 显式凭据 audience：只注入这一个变量 */
  readonly credentialEnvVar: string;
}

const DESCRIPTORS: readonly ExternalConnectorDescriptor[] = [
  {
    connectorId: 'claude-cli',
    kind: 'CLAUDE_CLI',
    vendor: 'ANTHROPIC',
    label: 'Claude Code',
    binaries: ['claude'],
    binaryPathEnv: 'REPOPILOT_CLAUDE_CLI_PATH',
    appBundles: ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')],
    // Claude.app 实测不打包 CLI（`claude` 需单独安装）；留空数组而不是瞎猜路径
    bundledBinaryRelPaths: [],
    versionArgv: ['--version'],
    // -p/--print = 非交互一次性执行，prompt 从 stdin 读
    reviewArgv: ['-p'],
    credentialEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    connectorId: 'codex-cli',
    kind: 'CODEX_CLI',
    vendor: 'OPENAI',
    label: 'Codex',
    binaries: ['codex', 'codex-cli'],
    binaryPathEnv: 'REPOPILOT_CODEX_CLI_PATH',
    // Codex 现在主要随 ChatGPT 桌面应用分发，未必存在独立 CLI
    appBundles: [
      '/Applications/ChatGPT.app',
      join(homedir(), 'Applications', 'ChatGPT.app'),
      '/Applications/Codex.app',
    ],
    bundledBinaryRelPaths: ['Contents/Resources/codex'],
    versionArgv: ['--version'],
    /*
     * exec 非交互；`-` 表示 prompt 从 stdin 读（codex 自己的 help 写明）。
     * --skip-git-repo-check：我们的 cwd 是空的一次性目录，本来就不是仓库。
     * --ignore-user-config / --ephemeral：不读用户 ~/.codex 配置、不留会话 ——
     * 与 synthetic HOME 是同一目的的两道保险。
     */
    reviewArgv: ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-'],
    credentialEnvVar: 'OPENAI_API_KEY',
  },
];

export interface ExternalConnectorProfile {
  readonly connectorId: string;
  readonly kind: ExternalConnectorKind;
  readonly vendor: ExternalVendor;
  readonly label: string;
  readonly state: ExternalConnectorState;
  /** 实际检测到的形态；什么都没检测到为 null */
  readonly form: ExternalAgentForm | null;
  /** 检测到的桌面应用位置（仅用于告知，不可自动化） */
  readonly appPath: string | null;
  /** 解析到的绝对路径；没有可自动化 CLI 时为 null */
  readonly binaryPath: string | null;
  readonly version: string | null;
  /** 身份摘要：路径 + 版本。换了二进制或升级了版本，这个值就变 */
  readonly identityDigest: string | null;
  readonly credentialEnvVar: string;
  readonly detail: string;
  readonly remediation: string | null;
}

export function connectorDescriptors(): readonly ExternalConnectorDescriptor[] {
  return DESCRIPTORS;
}

export function descriptorOfConnector(connectorId: string): ExternalConnectorDescriptor | null {
  return DESCRIPTORS.find((d) => d.connectorId === connectorId) ?? null;
}

/**
 * 探测一个连接器。
 *
 * 在**子进程真正会拿到的那份 PATH** 里解析二进制（与 doctor 的 toolchain 检查同源）——
 * 从 Finder 启动的 .app 拿到的是 launchd 的 PATH，`~/.local/bin/claude` 不在里面。
 * 版本探测本身也走隔离环境：不能为了问一句版本就把真实 HOME 暴露出去。
 */
export function probeConnector(d: ExternalConnectorDescriptor): ExternalConnectorProfile {
  const base = {
    connectorId: d.connectorId,
    kind: d.kind,
    vendor: d.vendor,
    label: d.label,
    credentialEnvVar: d.credentialEnvVar,
  };
  const childEnv = buildChildEnv().env;
  const appPath = d.appBundles.find((p) => existsSync(p)) ?? null;

  // 解析顺序：显式覆盖 > PATH 上的候选名。覆盖优先是因为 GUI 应用的 PATH 靠不住
  const override = process.env[d.binaryPathEnv]?.trim();
  let form: ExternalAgentForm | null = null;
  let binaryPath: string | null = null;
  if (override) {
    binaryPath = resolveBinary(override, childEnv);
    if (binaryPath) form = 'CLI';
  } else {
    binaryPath = d.binaries.map((b) => resolveBinary(b, childEnv)).find((p) => p !== null) ?? null;
    if (binaryPath) {
      form = 'CLI';
    } else if (appPath) {
      // PATH 上没有，不代表没有可自动化入口 —— .app 里可能就打包着 CLI
      binaryPath =
        d.bundledBinaryRelPaths
          .map((rel) => resolveBinary(join(appPath, rel), childEnv))
          .find((p) => p !== null) ?? null;
      if (binaryPath) form = 'BUNDLED_CLI';
    }
  }

  if (!binaryPath) {
    // 装了桌面应用但没有可自动化入口：检测得到 ≠ 用得上，必须说清楚而不是报"没装"
    if (appPath) {
      return {
        ...base,
        state: 'PRESENT_NOT_AUTOMATABLE',
        form: 'DESKTOP_APP',
        appPath,
        binaryPath: null,
        version: null,
        identityDigest: null,
        detail: `检测到桌面应用 ${appPath}，但 bundle 里没有可自动化的非交互 CLI`,
        remediation:
          `桌面应用只能靠 GUI 自动化驱动，那既被合同禁止也会动用你的登录态 —— ` +
          `请改用${d.vendor === 'OPENAI' ? ' OpenAI' : ' Anthropic'} API 做交叉审核（更顺，也可记账），` +
          `或安装其 CLI 后设 ${d.binaryPathEnv} 指向它`,
      };
    }
    if (override) {
      return {
        ...base,
        state: 'BLOCKED',
        form: null,
        appPath: null,
        binaryPath: null,
        version: null,
        identityDigest: null,
        detail: `${d.binaryPathEnv} 指向 ${override}，但那里没有可执行文件`,
        remediation: `修正 ${d.binaryPathEnv}，或清空它回落到 PATH 探测`,
      };
    }
    return {
      ...base,
      state: 'NOT_INSTALLED',
      form: null,
      appPath: null,
      binaryPath: null,
      version: null,
      identityDigest: null,
      detail: `没有找到 ${d.binaries.join(' / ')}，也没有检测到桌面应用`,
      remediation:
        `不装也行 —— 用 API 做交叉审核是更顺的路径。若要用 CLI：装好后重启应用，` +
        `或设 ${d.binaryPathEnv} 指向它（从 Finder 启动时 PATH 不含 ~/.local/bin 与 Homebrew）`,
    };
  }

  let version: string;
  const probeHome = mkdtempSync(join(tmpdir(), 'repopilot-probe-'));
  try {
    version = execFileSync(binaryPath, [...d.versionArgv], {
      encoding: 'utf8',
      timeout: 10_000,
      // 探测也走 synthetic HOME：问版本不该成为读真实配置的借口
      env: isolatedEnv({ pathValue: childEnv.PATH ?? '', home: probeHome }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0]!
      .trim();
  } catch (err) {
    return {
      ...base,
      state: 'BLOCKED',
      form,
      appPath,
      binaryPath,
      version: null,
      identityDigest: null,
      detail: `找到了 ${binaryPath}，但 ${d.versionArgv.join(' ')} 探测失败：${(err as Error).message.slice(0, 160)}`,
      remediation: '确认该 CLI 能在隔离环境下非交互运行（不依赖你的登录态与真实 HOME）',
    };
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }

  return {
    ...base,
    state: 'READY',
    form,
    appPath,
    binaryPath,
    version,
    identityDigest: digestOf({ binaryPath, version }),
    detail: `${version} @ ${binaryPath}${form === 'BUNDLED_CLI' ? '（随桌面应用分发）' : ''}`,
    remediation: null,
  };
}

export function discoverConnectors(): readonly ExternalConnectorProfile[] {
  return DESCRIPTORS.map(probeConnector);
}

/**
 * 构造隔离环境。**整份替换**，不合并宿主环境。
 *
 * 给的东西只有：PATH（否则 CLI 找不到自己的 node）、synthetic HOME 与 XDG_*、
 * 一个最小 locale、以及调用方显式给的那一个凭据变量。
 * 不给的东西里最重要的是：真实 HOME、宿主的任何 *_API_KEY / TOKEN。
 */
export function isolatedEnv(input: {
  pathValue: string;
  home: string;
  credential?: { name: string; value: string };
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  env.PATH = input.pathValue;
  env.HOME = input.home;
  env.XDG_CONFIG_HOME = join(input.home, '.config');
  env.XDG_CACHE_HOME = join(input.home, '.cache');
  env.XDG_DATA_HOME = join(input.home, '.local', 'share');
  env.XDG_STATE_HOME = join(input.home, '.local', 'state');
  env.TMPDIR = join(input.home, 'tmp');
  env.LANG = 'en_US.UTF-8';
  env.CI = '1';
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  if (input.credential) env[input.credential.name] = input.credential.value;
  return env;
}

/** 合同的 ExternalAgentInvocationState（本切片用到的子集，状态机不放宽） */
export type ExternalInvocationState =
  | 'PREFLIGHT'
  | 'SEALED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'FAILED';

/**
 * 一次外部 CLI 调用的凭证记录。
 * 与 ModelEgressManifest 平行 —— 合同明确要求 CLI 路径不得伪装成模型 API 调用。
 * 不含 raw secret、不含 prompt 正文（只留输入摘要）。
 */
export interface ExternalInvocationManifest {
  readonly invocationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly role: 'READ_ONLY_REVIEWER';
  readonly connectorId: string;
  readonly vendor: ExternalVendor;
  readonly identityDigest: string | null;
  readonly inputDigest: string;
  readonly state: ExternalInvocationState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly failureDetail: string | null;
}

export interface ExternalReviewSubmission {
  readonly verdict: CrossReviewVerdict;
  readonly findings: readonly Record<string, unknown>[];
}

export interface ExternalReviewResult {
  readonly manifest: ExternalInvocationManifest;
  /** 解析成功才有；失败一律 null —— 绝不编造发现 */
  readonly submission: ExternalReviewSubmission | null;
}

export class SameVendorReviewDenied extends Error {
  readonly code = 'SAME_VENDOR_REVIEW_DENIED';
  constructor(readonly vendor: ExternalVendor) {
    super(`审核方与实现方同为 ${vendor}：异构是硬不变式，同厂商审核被拒绝`);
  }
}

/**
 * 异构不变式。合同原话：`authorVendor != reviewerVendor` 是 canonical invariant，
 * 同 vendor 必须返回 SAME_VENDOR_REVIEW_DENIED —— **单纯披露"非异构"不能继续**。
 * 所以这里抛错而不是加个 warning 字段。
 */
export function assertHeterogeneousVendor(
  authorVendor: ExternalVendor,
  reviewerVendor: ExternalVendor,
): void {
  if (authorVendor === reviewerVendor) throw new SameVendorReviewDenied(authorVendor);
}

/**
 * 从 CLI 的自由文本输出里提取结构化审核结论。
 *
 * 不做任何"友好兜底"：解析不出来就是 null，由调用方记 INCONCLUSIVE。
 * 把无法解析的输出补成"没有发现"，等于用一个假绿灯替换一次失败 ——
 * 这与 openai 适配器不修 JSON、不 fallback 成 `{}` 是同一条原则。
 */
export function parseReviewOutput(raw: string): ExternalReviewSubmission | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);

  // ```json ... ``` 围栏
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  // 最外层花括号跨度
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
    const obj = parsed as { verdict?: unknown; findings?: unknown };
    const verdict = obj?.verdict;
    if (verdict !== 'PASS' && verdict !== 'CHANGES_REQUESTED' && verdict !== 'INCONCLUSIVE') {
      continue;
    }
    const findings = Array.isArray(obj.findings)
      ? (obj.findings.filter((f) => f && typeof f === 'object') as Record<string, unknown>[])
      : [];
    return { verdict, findings };
  }
  return null;
}

/** 审核简报 → CLI prompt。输出契约与 submit_review 工具同形，平台侧共用归一化与指纹 */
export function renderCliReviewPrompt(brief: string): string {
  return `${brief}

————
你是独立的第二个模型，只做**只读审核**。你没有可写工具，也不要尝试修改任何文件。
只输出一个 JSON 对象，不要有任何其他文字、不要用围栏之外的解释：

{"verdict":"PASS|CHANGES_REQUESTED|INCONCLUSIVE","findings":[
  {"severity":"INFO|LOW|MEDIUM|HIGH|CRITICAL","confidence":0.0-1.0,
   "file":"相对路径","startLine":1,"endLine":1,
   "evidence":"你依据的具体事实","blocking":true|false}
]}

规则：
- 没有阻断问题就用 PASS，findings 可以为空数组。
- 只有证据完整的 HIGH/CRITICAL 才允许 blocking=true。
- 不要臆测你看不到的文件内容；看不到就别报。
- 不要输出 fingerprint 字段，那个由平台计算。`;
}

/**
 * 以只读审核方身份跑一次外部 CLI。
 *
 * 隔离在这里落地：一次性 synthetic HOME、整份替换的环境、cwd 指向那个空目录
 * （不挂载工作区，CLI 就算想读仓库也没有坐标系）、有界超时、进程组整树终止
 * （复用 runCommand 的那套）。无论成败，HOME 都在 finally 里删掉。
 */
export async function runExternalCliReview(input: {
  connector: ExternalConnectorProfile;
  apiKey: string;
  brief: string;
  runId: string;
  attemptId: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ExternalReviewResult> {
  const d = descriptorOfConnector(input.connector.connectorId);
  const startedAt = nowIso();
  const started = Date.now();
  const prompt = renderCliReviewPrompt(input.brief);
  const inputDigest = digestOf({ prompt });
  const invocationId = newId('xinv');

  const base = {
    invocationId,
    runId: input.runId,
    attemptId: input.attemptId,
    role: 'READ_ONLY_REVIEWER' as const,
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
  ): ExternalInvocationManifest => ({
    ...base,
    state,
    exitCode,
    durationMs: Date.now() - started,
    settledAt: nowIso(),
    failureDetail,
  });

  // PREFLIGHT：不满足就不发起，绝不"先跑起来再说"
  if (!d || input.connector.state !== 'READY' || !input.connector.binaryPath) {
    return {
      manifest: seal('BLOCKED', null, `连接器不可用：${input.connector.detail}`),
      submission: null,
    };
  }
  if (!input.apiKey.trim()) {
    return {
      manifest: seal('BLOCKED', null, `缺少 ${d.credentialEnvVar}：拒绝以宿主登录态运行外部 CLI`),
      submission: null,
    };
  }

  const home = mkdtempSync(join(tmpdir(), 'repopilot-xagent-'));
  try {
    const def: CommandDefinition = {
      commandId: `external:${d.connectorId}`,
      label: `${d.label} 只读审核`,
      argv: [input.connector.binaryPath, ...d.reviewArgv],
      cwdRelative: '.',
      timeoutMs: input.timeoutMs,
      risk: 'R0',
      source: 'DETECTED',
    };
    const outcome = await runCommand(def, home, input.signal, {
      env: isolatedEnv({
        pathValue: buildChildEnv().env.PATH ?? '',
        home,
        credential: { name: d.credentialEnvVar, value: input.apiKey },
      }),
      stdin: prompt,
    });

    if (outcome.outcome === 'TIMEOUT') {
      return { manifest: seal('TIMED_OUT', null, `超过 ${input.timeoutMs}ms`), submission: null };
    }
    if (outcome.outcome === 'CANCELLED') {
      return { manifest: seal('CANCELLED', null, '调用被取消'), submission: null };
    }
    if (outcome.outcome !== 'EXIT_ZERO') {
      return {
        manifest: seal(
          'FAILED',
          outcome.exitCode,
          `${outcome.outcome}: ${outcome.stderrPreview.slice(0, 300) || outcome.stdoutPreview.slice(0, 300)}`,
        ),
        submission: null,
      };
    }

    const submission = parseReviewOutput(outcome.stdoutPreview);
    if (!submission) {
      return {
        manifest: seal('FAILED', outcome.exitCode, '输出不含可解析的审核 JSON —— 不编造发现'),
        submission: null,
      };
    }
    return { manifest: seal('SEALED', outcome.exitCode, null), submission };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
