import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 受管数据根的**唯一**解析点。
 *
 * 之前有两个：`core/paths.ts` 从 homedir 拼出 DATA_ROOT，`main/credentials.ts` 又
 * 各自拼了一遍 credentials.bin 的路径。两处独立拼装意味着"隔离 data root"这件事
 * 只要漏改一处，自检就会照旧往真实用户目录里写凭据 —— 那正是阶段审计 P2-5 记下的问题。
 *
 * `REPOPILOT_DATA_ROOT` 是显式隔离入口：设了就完全改用它，不与默认根做任何合并。
 * 读环境变量而不是读配置文件，是因为它必须在**任何模块副作用之前**就确定；
 * Core 是被 fork 出来的独立进程，env 是唯一能保证先于模块加载到位的通道。
 *
 * 注意：这个模块只被 Main 与 Core 引用。Renderer 是 sandbox 进程，没有 Node，
 * 也永远不需要知道任何宿主路径。
 */

const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'RepoPilotPrototype');

export const DATA_ROOT_ENV = 'REPOPILOT_DATA_ROOT';

export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_ROOT_ENV];
  return override && override.trim() ? override : DEFAULT_ROOT;
}

/** 是否运行在显式隔离的数据根下 —— 自检据此判断能不能安全地造种子数据。 */
export function isIsolatedDataRoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDataRoot(env) !== DEFAULT_ROOT;
}

export function defaultDataRoot(): string {
  return DEFAULT_ROOT;
}
