import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CommandDefinition } from '@shared/domain';
import { digestOf, sha256 } from '@shared/ids';
import { VERIFICATION_INPUT_PATTERNS, verificationInputsFromCommands } from '../coverage';
import { globMatch } from '../mutation';

/**
 * EvalCase：SPK-010 实验的最小单元（实验设计 §2、§7）。
 *
 * 一个 case = `case.json`（目标/验收/验证命令/可修改范围）+ `repo/`（损坏仓库树）。
 * caseDigest 覆盖两者 —— case 是内容寻址的：改一个字节就是另一个 case，
 * 结果与 case 的绑定靠这个 digest，不靠目录名。
 *
 * 加载 fail-closed：缺文件、形状不对、命令为空、范围非法都直接抛错并说明哪里不对 ——
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
  /**
   * 候选可修改范围（必填合同，进 digest）。
   *
   * 产品层把空范围解释为全仓可写（authority.createTask 的 `['**']` 兜底），
   * 所以 Eval 这边不允许"没填范围"的 case 存在 —— 缺省等于把验证脚本也交给
   * 候选改写，"验证通过"就不再能证明修复正确。Runner 必须把它原样交给
   * task.create，不能回退为空或更宽的范围。
   */
  readonly allowedPaths: readonly string[];
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

/**
 * allowedPaths 校验（fail-closed，唯一的校验点）：
 *
 * 合法值是规范化的 POSIX 仓库相对路径或受限 glob（`src/app.js`、`src/features/**`）。
 * 以下全部直接拒绝，不修正、不默认放宽：
 *   - 缺失 / 不是数组 / 空数组 / 空字符串项；
 *   - 绝对路径、盘符路径、反斜线、NUL；
 *   - 空路径段、`.`、`..` 段；
 *   - 全仓 catch-all（`**` 及其纯 `**` 段变体）—— case 必须显式圈定范围；
 *   - 重复项（规范化后）；
 *   - 直接或通过 glob 命中任一验证输入 —— 验证脚本只能由 case 作者冻结，
 *     候选能改 `check.mjs` 的话，"验证通过"就不再能证明修复正确。
 */
export function validateAllowedPaths(raw: unknown, verificationInputFiles: readonly string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      'case.json 的 allowedPaths 必须是非空数组 —— case 必须声明候选可修改范围；' +
        '缺省会被产品层兜底为全仓可写，验证脚本将失去保护',
    );
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  raw.forEach((p, i) => {
    const what = `allowedPaths[${i}]`;
    if (typeof p !== 'string' || p.length === 0) throw new Error(`${what} 必须是非空字符串`);
    if (p.includes(String.fromCharCode(0))) throw new Error(`${what} 含 NUL 字节：${JSON.stringify(p)}`);
    if (p.includes('\\')) throw new Error(`${what} 含反斜线 —— 只接受 POSIX 正斜杠路径：${p}`);
    if (p.startsWith('/')) throw new Error(`${what} 是绝对路径 —— 只接受仓库相对路径：${p}`);
    if (/^[A-Za-z]:[\\/]/.test(p)) throw new Error(`${what} 是盘符绝对路径 —— 只接受仓库相对路径：${p}`);
    const segments = p.split('/');
    if (segments.includes('')) throw new Error(`${what} 含空路径段（// 或结尾 /）：${p}`);
    if (segments.includes('.')) throw new Error(`${what} 含 "." 段 —— 不接受当前目录写法，路径必须是规范形：${p}`);
    if (segments.includes('..')) throw new Error(`${what} 含 ".." 段 —— 不接受父目录写法：${p}`);
    if (/^\*\*(\/\*\*)*$/.test(p)) {
      throw new Error(`${what} 是全仓 catch-all（${p}）—— 不接受"整仓可写"的简写，case 必须显式圈定范围`);
    }
    // 合法写法到此已是规范形（所有非规范形都在上面拒掉了）；join 再 split 是恒等，去重防字面重复
    const normalized = segments.join('/');
    if (seen.has(normalized)) throw new Error(`${what} 与前面的项重复：${p}`);
    seen.add(normalized);
    const hit = verificationInputFiles.find((v) => globMatch(p, v));
    if (hit) {
      throw new Error(
        `${what}（${p}）会命中验证输入 ${hit} —— 验证脚本只能由 case 作者冻结，` +
          '不能进入候选可修改范围（直接点名与 glob 覆盖都拒绝）',
      );
    }
    paths.push(normalized);
  });
  return paths;
}

/**
 * case 的验证输入清单（候选绝不可修改的文件）：
 *   1. 验证命令 argv 直接点名、且在基线真实存在的文件（`node check.mjs` → check.mjs）；
 *   2. 按模式命中的配置 / 测试 / 夹具文件（coverage.VERIFICATION_INPUT_PATTERNS）。
 * 与产品层 sealPatch 的判定同源 —— Eval 只是在加载时先把范围合同钉死。
 */
export function caseVerificationInputFiles(
  commands: readonly EvalCaseCommand[],
  baselineFilePaths: readonly string[],
): string[] {
  const exists = new Set(baselineFilePaths);
  const asDefinitions: CommandDefinition[] = commands.map((c, i) => ({
    commandId: `user${i + 1}`,
    label: c.label,
    argv: [...c.argv],
    cwdRelative: '.',
    timeoutMs: 60_000,
    risk: 'R1',
    source: 'USER',
  }));
  const commandNamed = verificationInputsFromCommands(asDefinitions, (rel) => exists.has(rel)).map((r) => r.path);
  const patternMatched = baselineFilePaths.filter((p) =>
    VERIFICATION_INPUT_PATTERNS.some((pat) => globMatch(pat, p)),
  );
  return [...new Set([...commandNamed, ...patternMatched])].sort();
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

  // 范围合同先于一切结果存在：校验不过 = case 不存在，没有"默认放宽"的余地
  const allowedPaths = validateAllowedPaths(spec.allowedPaths, caseVerificationInputFiles(commands, files.map((f) => f.path)));

  return {
    caseId,
    title,
    goal,
    acceptance,
    commands,
    allowedPaths,
    dir,
    repoDir,
    caseDigest: digestOf({ spec: { caseId, title, goal, acceptance, commands, allowedPaths }, files }),
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
