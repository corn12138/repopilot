import type { CommandDefinition } from '@shared/domain';
import { globMatch } from './mutation';

/**
 * 验证覆盖不能被静默放宽（Slice G，对应 PRD-NFR-COR-001 / TD §9.8）。
 *
 * 08-17 审计里全仓最短的一条 false-green 路径：给 `vitest.config.ts` 的 exclude 加一条，
 * 基线失败的命令在 POST_MUTATION 变绿 → `compareVerification` 算进 fixed → 补丁绑一次
 * passed 的验证 → 用户看到绿色「已修复」→ `SUCCEEDED`。现在外部作者是个黑盒，
 * 这条路更近了。
 *
 * 这里不把测试/配置文件一刀切成受保护路径 —— 修 bug 经常要改测试，改 tsconfig 也可能
 * 就是修复本身。规则是：**补丁触碰了验证输入，这次"验证通过"就不能再证明修复正确**。
 * 封存时把触碰到的路径记进 PatchArtifact，接受时终态只能是 ACCEPTED_UNVERIFIED，
 * 导出文件头如实写 NO。这是 TD 原话"无法独立证明时只能 BLOCKED/UNVERIFIED"的原型落点；
 * "独立 task assertion 证明覆盖没被放宽"那一半原型没有，所以这里只有降级，没有放行。
 *
 * 两类验证输入：
 *   1. 按模式：构建/类型/测试/lint 的配置文件、测试文件、测试夹具与 setup；
 *   2. 按命令：验证命令 argv 里直接点名、且确实存在于仓库的文件（`node check.mjs` 的 check.mjs）。
 *      这类不可能靠模式猜出来，只能从任务实际选用的命令推。
 */
export const VERIFICATION_INPUT_PATTERNS: readonly string[] = [
  // 类型 / 构建 / 测试 / lint 的配置
  '**/tsconfig*.json',
  '**/jsconfig*.json',
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/.eslintignore',
  '**/babel.config.*',
  '**/.babelrc*',
  '**/.swcrc',
  // 测试本身、夹具、快照、setup
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/test/**',
  '**/tests/**',
  '**/setupTests.*',
  '**/vitest.setup.*',
  '**/test-setup.*',
];

export interface VerificationInputTouch {
  readonly path: string;
  /** 命中的模式，或 `command:<commandId>` 表示被验证命令 argv 点名 */
  readonly matchedBy: string;
}

/** 按模式 + 按命令点名，找出补丁里属于验证输入的路径。结果按路径排序、每路径只报一次 */
export function classifyVerificationInputs(
  changedPaths: readonly string[],
  commandReferenced: readonly { path: string; commandId: string }[] = [],
): VerificationInputTouch[] {
  const out = new Map<string, string>();
  for (const path of changedPaths) {
    const pattern = VERIFICATION_INPUT_PATTERNS.find((p) => globMatch(p, path));
    if (pattern) out.set(path, pattern);
  }
  for (const ref of commandReferenced) {
    if (changedPaths.includes(ref.path) && !out.has(ref.path)) out.set(ref.path, `command:${ref.commandId}`);
  }
  return [...out.entries()]
    .map(([path, matchedBy]) => ({ path, matchedBy }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 从验证命令的 argv 里找出"被直接点名的仓库文件"。
 * 只看 argv[1..]（argv[0] 是可执行名），只认在基线里真实存在的相对路径 —— 这样 `pnpm build`
 * 一个都推不出（对），`node check.mjs` 推出 check.mjs（也对），`vitest run src/a.test.ts` 推出那个测试文件。
 */
export function verificationInputsFromCommands(
  commands: readonly CommandDefinition[],
  existsInBaseline: (relPath: string) => boolean,
): { path: string; commandId: string }[] {
  const out: { path: string; commandId: string }[] = [];
  for (const c of commands) {
    for (const token of c.argv.slice(1)) {
      if (!token || token.startsWith('-') || token.startsWith('/') || token.includes('..')) continue;
      const rel = c.cwdRelative && c.cwdRelative !== '.' ? `${c.cwdRelative.replace(/\/$/, '')}/${token}` : token;
      if (existsInBaseline(rel)) out.push({ path: rel, commandId: c.commandId });
    }
  }
  return out;
}

/** 给未验证清单与状态原因用的一句话 */
export function describeCoverageWeakening(touches: readonly VerificationInputTouch[]): string {
  const shown = touches.slice(0, 5).map((t) => t.path).join(', ');
  const more = touches.length > 5 ? ` 等 ${touches.length} 个` : '';
  return (
    `⚠ COVERAGE_WEAKENED：补丁修改了验证输入 ${shown}${more}（配置 / 测试 / 验证脚本）—— ` +
    `这次"验证通过"可能是因为验证本身被放宽，不能证明修复正确；接受后终态只能是 ACCEPTED_UNVERIFIED`
  );
}
