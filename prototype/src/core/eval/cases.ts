import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { digestOf, sha256 } from '@shared/ids';

/**
 * EvalCase：SPK-010 实验的最小单元（实验设计 §2、§7）。
 *
 * 一个 case = `case.json`（目标/验收/验证命令）+ `repo/`（损坏仓库树）。
 * caseDigest 覆盖两者 —— case 是内容寻址的：改一个字节就是另一个 case，
 * 结果与 case 的绑定靠这个 digest，不靠目录名。
 *
 * 加载 fail-closed：缺文件、形状不对、命令为空都直接抛错并说明哪里不对 ——
 * 一个"默认修补过的 case"跑出来的结果没有意义。
 */

export interface EvalCaseCommand {
  readonly label: string;
  readonly argv: readonly string[];
}

export interface EvalCase {
  readonly caseId: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly commands: readonly EvalCaseCommand[];
  /** case 根目录（含 case.json 与 repo/） */
  readonly dir: string;
  /** 损坏仓库模板；runner 每次观察都复制一份，绝不原地修改 */
  readonly repoDir: string;
  /** 覆盖 case.json + repo 全树内容的 digest */
  readonly caseDigest: string;
}

/** repo 模板里不参与 digest 也不该存在的目录 —— 出现即视为模板被污染 */
const FORBIDDEN_DIRS = new Set(['.git', 'node_modules']);

function walkFiles(root: string, dir: string, out: { path: string; sha: string }[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (FORBIDDEN_DIRS.has(name)) {
        throw new Error(`case 模板不允许包含 ${name}/（${full}）：模板必须是干净的源树`);
      }
      walkFiles(root, full, out);
    } else {
      out.push({ path: relative(root, full), sha: sha256(readFileSync(full)) });
    }
  }
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`case.json 的 ${what} 必须是非空字符串`);
  return v;
}

export function loadEvalCase(dir: string): EvalCase {
  const specPath = join(dir, 'case.json');
  const repoDir = join(dir, 'repo');
  if (!existsSync(specPath)) throw new Error(`缺少 ${specPath}`);
  if (!existsSync(repoDir)) throw new Error(`缺少 ${repoDir}/`);

  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${specPath} 不是合法 JSON：${(err as Error).message}`);
  }

  const caseId = requireString(spec.caseId, 'caseId');
  const title = requireString(spec.title, 'title');
  const goal = requireString(spec.goal, 'goal');
  const acceptance = Array.isArray(spec.acceptance) ? spec.acceptance.map((a, i) => requireString(a, `acceptance[${i}]`)) : [];
  if (!Array.isArray(spec.commands) || spec.commands.length === 0) {
    throw new Error('case.json 的 commands 必须至少有一条验证命令 —— 无验证的 case 无法产出机器证据');
  }
  const commands: EvalCaseCommand[] = spec.commands.map((c, i) => {
    const obj = c as { label?: unknown; argv?: unknown };
    const label = requireString(obj.label, `commands[${i}].label`);
    if (!Array.isArray(obj.argv) || obj.argv.length === 0) {
      throw new Error(`commands[${i}].argv 必须是非空字符串数组`);
    }
    return { label, argv: obj.argv.map((a, j) => requireString(a, `commands[${i}].argv[${j}]`)) };
  });

  const files: { path: string; sha: string }[] = [];
  walkFiles(repoDir, repoDir, files);
  if (files.length === 0) throw new Error(`${repoDir}/ 是空的 —— 没有仓库就没有实验对象`);

  return {
    caseId,
    title,
    goal,
    acceptance,
    commands,
    dir,
    repoDir,
    caseDigest: digestOf({ spec: { caseId, title, goal, acceptance, commands }, files }),
  };
}

/** 加载一个目录下的全部 case（每个子目录一个）；空目录抛错而不是返回空数组 */
export function loadEvalCases(root: string): EvalCase[] {
  if (!existsSync(root)) throw new Error(`case 集目录不存在：${root}`);
  const dirs = readdirSync(root)
    .sort()
    .map((n) => join(root, n))
    .filter((p) => statSync(p).isDirectory());
  if (dirs.length === 0) throw new Error(`${root} 下没有任何 case 目录`);
  const cases = dirs.map(loadEvalCase);
  const ids = new Set(cases.map((c) => c.caseId));
  if (ids.size !== cases.length) throw new Error('caseId 重复：结果与 case 的绑定会失真');
  return cases;
}
