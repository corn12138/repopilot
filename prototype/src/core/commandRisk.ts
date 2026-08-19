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
 *   R2  依赖安装、网络、服务生命周期（install/add/ci/curl/wget/docker/…）—— 原型不提供
 *       一次性精确审批，所以 fail-closed：拒绝登记，并说清楚为什么
 *   R3  删除/覆盖/权限/迁移类（rm/rmdir/chmod/chown/dd/mkfs/…）—— 首切片 hard deny
 *   R4  push/merge/部署/发布/凭据读写（git push/merge/rebase/reset --hard、npm publish、
 *       sudo、ssh、scp、env/printenv、cat ~/.ssh/…）—— always deny
 *
 * 认不出的可执行名按 R1 放行？不 —— 认不出按 **R2** 处理（fail-closed）：未知二进制可能是任何东西，
 * 用户可以用 `node`/`pnpm` 等已知入口包装它。白名单比黑名单诚实。
 */

export interface CommandRiskVerdict {
  readonly risk: ToolRisk;
  readonly reason: string;
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
  if (!bin0) return { risk: 'R2', reason: '空命令' };
  const bin = bin0.split('/').pop()!.toLowerCase();
  const sub = (sub0 ?? '').toLowerCase();

  if (R4_BINARIES.has(bin)) return { risk: 'R4', reason: `${bin} 属于提权/远程/凭据/部署类，永不允许` };
  if (R3_BINARIES.has(bin)) return { risk: 'R3', reason: `${bin} 属于删除/覆盖/权限类，首切片 hard deny` };
  if (R2_BINARIES.has(bin)) return { risk: 'R2', reason: `${bin} 属于网络/依赖/容器类，需要一次性精确审批，原型不开放` };

  if (bin === 'git') {
    if (GIT_R1.has(sub)) return { risk: 'R1', reason: `git ${sub} 只读` };
    if (GIT_R4.has(sub)) return { risk: 'R4', reason: `git ${sub} 会改写历史/远端/工作树，永不允许作为验证命令` };
    return { risk: 'R2', reason: `git ${sub || '(无子命令)'} 未在只读清单内，fail-closed` };
  }

  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
    if (PM_R4.has(sub)) return { risk: 'R4', reason: `${bin} ${sub} 属于发布/账户类，永不允许` };
    if (PM_R2.has(sub)) return { risk: 'R2', reason: `${bin} ${sub} 会安装/改动依赖或联网，原型不开放（依赖只读复用宿主 node_modules）` };
    // run <script> / build / test / lint / typecheck / 任意 package script
    return { risk: 'R1', reason: `${bin} ${sub || 'run'} 视为本地脚本` };
  }

  if (R1_BINARIES.has(bin)) {
    // 少数危险 flag：node -e 仍是本地执行（R1）；但 `node -e "require('child_process')…"` 我们管不住，
    // 这正是"验证命令在 MaterializedWorkspace 里跑、宿主仓库只读"要兜的底，不在这里重复分级
    return { risk: 'R1', reason: `${bin} 属于构建/测试/本地脚本类` };
  }
  return { risk: 'R2', reason: `未知可执行名 ${bin}：不在已知本地工具白名单内，fail-closed；可用 node / pnpm 等已知入口包装` };
}

/** 能否登记为验证命令：只有 R1 可以；R2/R3/R4 各有各的说法 */
export function userCommandAdmission(argv: readonly string[]): { ok: true; verdict: CommandRiskVerdict } | { ok: false; verdict: CommandRiskVerdict; message: string } {
  const verdict = classifyUserCommand(argv);
  if (verdict.risk === 'R1') return { ok: true, verdict };
  const shown = argv.join(' ');
  const message =
    verdict.risk === 'R4'
      ? `拒绝登记「${shown}」为验证命令（R4）：${verdict.reason}`
      : verdict.risk === 'R3'
        ? `拒绝登记「${shown}」为验证命令（R3）：${verdict.reason}`
        : `拒绝登记「${shown}」为验证命令（R2）：${verdict.reason}`;
  return { ok: false, verdict, message };
}
