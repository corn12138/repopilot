import { createHash } from 'node:crypto';

import type { ToolRisk } from '@shared/domain';

/**
 * 用户手填命令的风险分级（Slice I-1，对应 08-17 审计 D3：此前一律硬编码 R1）。
 *
 * 分级只看 argv：可执行名 + 第一个子命令，外加少数危险 flag。它不是"猜用户意图"，
 * 是在登记为验证命令之前判断这条命令属于哪一档 —— 因为登记之后它会在**计划批准前**作为
 * 基线跑一次，之后模型还能在预算内用 `run_command` 重复调用。一条 `git push` 或 `rm -rf dist`
 * 被登记成 R1，就等于"填一次即永久授权"。
 *
 *   R1  构建/测试/类型/lint/本地脚本（node/tsc/vitest/pnpm build/…）—— 允许登记
 *   R2  依赖安装、网络、服务生命周期（install/add/ci/curl/wget/docker/…）—— 需要一次性精确审批
 *   R3  删除/覆盖/权限/迁移类（rm/rmdir/chmod/chown/dd/mkfs/…）—— 首切片 hard deny
 *   R4  push/merge/部署/发布/凭据读写（git push/merge/rebase/reset --hard、npm publish、
 *       sudo、ssh、scp、env/printenv、cat ~/.ssh/…）—— always deny
 *
 * 认不出的可执行名按 R1 放行？不 —— 认不出按 **R2** 处理（fail-closed）：未知二进制可能是任何东西，
 * 用户可以用 `node`/`pnpm` 等已知入口包装它。白名单比黑名单诚实。
 *
 * ## 为什么 R2 里只有"未知二进制"这一档可以批准（Slice K）
 *
 * `cause` 把"我们知道它危险"和"我们不认识它"分开 —— 这两件事在 I-1 里都落成 R2，
 * 但它们该有不同的出路：
 *
 *   - `NETWORK_OR_DEPS` / `GIT_UNKNOWN`：**批准也不执行**。工作区的 `node_modules` 是
 *     指向宿主仓库的 symlink（workspace.ts:linkDependencies），`pnpm install` 会直接写进
 *     用户真实的依赖树 —— 那是"宿主仓库只读"这条不变式的破口，不是一次点击能授权的东西。
 *   - `UNKNOWN_BINARY`：**可以一次性精确批准**。它是 fail-closed 的兜底，不是"已知危险"。
 *     而且这道白名单本来就不是一堵墙 —— `node -e "…"` 是 R1，它能干的事不比 `bash test.sh` 少。
 *     所以对 `bash scripts/test.sh` 一律拒绝，挡住的不是能力，只是**用别的仓库/别的语言栈的人**。
 *     诚实的做法是把决定权交回人，并且把这个决定绑死、记账、不让它变成永久授权。
 */

/**
 * 风险的**成因**，不是风险等级。等级决定"能不能直接跑"，成因决定"能不能被批准"。
 */
export type CommandRiskCause =
  /** 空 argv */
  | 'EMPTY'
  /** 不在已知本地工具白名单内 —— 唯一可以一次性精确批准的一类 */
  | 'UNKNOWN_BINARY'
  /** 联网 / 装依赖 / 容器：会写宿主依赖树或产生出站流量，批准也不执行 */
  | 'NETWORK_OR_DEPS'
  /** git 子命令不在只读清单内：未知的 git 操作仍然作用在仓库上 */
  | 'GIT_UNKNOWN'
  /** 删除 / 覆盖 / 权限 */
  | 'DESTRUCTIVE'
  /** 提权 / 远程 / 凭据 / 部署 */
  | 'PRIVILEGED'
  /** 发布 / 账户 */
  | 'PUBLISH'
  /** 写历史 / 写远端 / 写工作树的 git 子命令 */
  | 'GIT_WRITE'
  /** 已知的本地构建 / 测试 / 脚本类，不构成风险成因 */
  | 'KNOWN_LOCAL';

export interface CommandRiskVerdict {
  readonly risk: ToolRisk;
  readonly cause: CommandRiskCause;
  readonly reason: string;
}

/** 只有这一类 R2 能被一次性精确批准 —— 其余的批准了也不执行 */
export function isApprovableCause(verdict: CommandRiskVerdict): boolean {
  return verdict.risk === 'R2' && verdict.cause === 'UNKNOWN_BINARY';
}

const R1_BINARIES = new Set([
  'node', 'npx', 'tsx', 'ts-node', 'deno', 'bun',
  'tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome', 'vite', 'esbuild', 'rollup', 'webpack', 'turbo', 'nx',
  'npm', 'pnpm', 'yarn',
  'make', 'cargo', 'go', 'python', 'python3', 'pytest', 'ruff', 'mypy',
  'true', 'echo', 'ls', 'cat', 'grep', 'rg', 'find', 'wc', 'head', 'tail', 'diff',
]);

/** 包管理器的子命令：哪些是跑脚本（R1），哪些是装依赖/发布（R2/R4） */
const PM_R2 = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'link', 'dedupe', 'prune', 'rebuild', 'import', 'patch', 'patch-commit', 'dlx', 'exec', 'create', 'init', 'login', 'logout', 'config', 'set', 'cache']);
const PM_R4 = new Set(['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'adduser', 'whoami', 'version', 'pack']);

const R3_BINARIES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs', 'mv', 'ln', 'truncate', 'kill', 'killall', 'pkill']);
const R4_BINARIES = new Set(['sudo', 'su', 'doas', 'ssh', 'scp', 'sftp', 'rsync', 'env', 'printenv', 'security', 'keychain', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'terraform', 'vercel', 'netlify', 'fly', 'heroku']);
const R2_BINARIES = new Set(['curl', 'wget', 'docker', 'docker-compose', 'podman', 'brew', 'apt', 'apt-get', 'pip', 'pip3', 'gem', 'nc', 'ncat', 'telnet', 'open', 'osascript']);

const GIT_R4 = new Set(['push', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'restore', 'clean', 'branch', 'tag', 'commit', 'cherry-pick', 'revert', 'stash', 'am', 'apply', 'pull', 'fetch', 'clone', 'remote', 'submodule', 'gc', 'prune', 'filter-branch', 'reflog', 'worktree']);
const GIT_R1 = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'describe', 'blame', 'grep', 'cat-file', 'shortlog']);

export function classifyUserCommand(argv: readonly string[]): CommandRiskVerdict {
  const [bin0, sub0] = argv;
  if (!bin0) return { risk: 'R2', cause: 'EMPTY', reason: '空命令' };
  const bin = bin0.split('/').pop()!.toLowerCase();
  const sub = (sub0 ?? '').toLowerCase();

  if (R4_BINARIES.has(bin)) return { risk: 'R4', cause: 'PRIVILEGED', reason: `${bin} 属于提权/远程/凭据/部署类，永不允许` };
  if (R3_BINARIES.has(bin)) return { risk: 'R3', cause: 'DESTRUCTIVE', reason: `${bin} 属于删除/覆盖/权限类，首切片 hard deny` };
  if (R2_BINARIES.has(bin)) return { risk: 'R2', cause: 'NETWORK_OR_DEPS', reason: `${bin} 属于网络/依赖/容器类：会联网或写宿主依赖树，批准也不执行` };

  if (bin === 'git') {
    if (GIT_R1.has(sub)) return { risk: 'R1', cause: 'KNOWN_LOCAL', reason: `git ${sub} 只读` };
    if (GIT_R4.has(sub)) return { risk: 'R4', cause: 'GIT_WRITE', reason: `git ${sub} 会改写历史/远端/工作树，永不允许作为验证命令` };
    return { risk: 'R2', cause: 'GIT_UNKNOWN', reason: `git ${sub || '(无子命令)'} 未在只读清单内，fail-closed` };
  }

  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
    if (PM_R4.has(sub)) return { risk: 'R4', cause: 'PUBLISH', reason: `${bin} ${sub} 属于发布/账户类，永不允许` };
    if (PM_R2.has(sub)) return { risk: 'R2', cause: 'NETWORK_OR_DEPS', reason: `${bin} ${sub} 会安装/改动依赖或联网：工作区的 node_modules 是指向你仓库的 symlink，它会写进你真实的依赖树` };
    // run <script> / build / test / lint / typecheck / 任意 package script
    return { risk: 'R1', cause: 'KNOWN_LOCAL', reason: `${bin} ${sub || 'run'} 视为本地脚本` };
  }

  if (R1_BINARIES.has(bin)) {
    // 少数危险 flag：node -e 仍是本地执行（R1）；但 `node -e "require('child_process')…"` 我们管不住，
    // 这正是"验证命令在 MaterializedWorkspace 里跑、宿主仓库只读"要兜的底，不在这里重复分级
    return { risk: 'R1', cause: 'KNOWN_LOCAL', reason: `${bin} 属于构建/测试/本地脚本类` };
  }
  return { risk: 'R2', cause: 'UNKNOWN_BINARY', reason: `未知可执行名 ${bin}：不在已知本地工具白名单内，fail-closed` };
}

/**
 * 能否登记为验证命令。
 *
 * `approvedDigests` 是用户已经**逐条精确批准**过的 argv digest 集合（`CommandApproval`）。
 * 没有批准时，可批准的那一类会带 `approvable: true` 回去 —— 界面据此决定是给一句
 * "不支持"，还是给一个"我了解风险，批准这一条"的手势。两者的差别是产品能不能被
 * 非 Node 栈的人用上。
 */
export function userCommandAdmission(
  argv: readonly string[],
  approvedDigests: ReadonlySet<string> = new Set(),
):
  | { ok: true; verdict: CommandRiskVerdict; viaApproval: boolean }
  | { ok: false; verdict: CommandRiskVerdict; approvable: boolean; message: string } {
  const verdict = classifyUserCommand(argv);
  if (verdict.risk === 'R1') return { ok: true, verdict, viaApproval: false };
  const shown = argv.join(' ');
  const approvable = isApprovableCause(verdict);
  if (approvable && approvedDigests.has(commandArgvDigest(argv))) {
    return { ok: true, verdict, viaApproval: true };
  }
  const message = approvable
    ? `「${shown}」需要你逐条批准（R2）：${verdict.reason}`
    : `拒绝登记「${shown}」为验证命令（${verdict.risk}）：${verdict.reason}`;
  return { ok: false, verdict, approvable, message };
}

/**
 * 批准绑定用的 argv digest。
 *
 * 精确到**整个 argv 数组**，不是可执行名、不是前缀：`bash test.sh` 的批准不覆盖
 * `bash test.sh --update-snapshots`。分隔符用 \u0000 是为了让 `['a b']` 和 `['a','b']`
 * 算出不同的值 —— 用空格 join 会把它们混成同一条命令。
 */
export function commandArgvDigest(argv: readonly string[]): string {
  return createHash('sha256').update(argv.join('\u0000'), 'utf8').digest('hex');
}
