import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { CommandOutcome, MutationOperation, RepositoryHarnessProfile, ToolRisk } from '@shared/domain';
import { newId } from '@shared/ids';
import { PATHS } from './paths';
import { applyMutationPlan, globMatch, type MutationPolicy } from './mutation';
import { MaterializedWorkspace, listTree } from './workspace';
import { runCommand } from './command';

export const PREVIEW_MAX_BYTES = 4_000;
export const PREVIEW_MAX_LINES = 120;

export interface ToolContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly workspace: MaterializedWorkspace;
  readonly profile: RepositoryHarnessProfile;
  readonly mutationPolicy: MutationPolicy;
  readonly signal: AbortSignal;
}

export interface ToolOutcome {
  readonly ok: boolean;
  /** 回给模型的有界文本 —— 大输出只给 preview + artifact ref */
  readonly modelText: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly artifactRef: string | null;
  readonly failureReason?: string;
  /** 供 Core 记录到事件里的结构化补充 */
  readonly meta?: Record<string, unknown>;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly description: string;
  readonly schema: S;
  /** 给模型看的 JSON Schema */
  readonly jsonSchema: Record<string, unknown>;
  summarize(args: z.infer<S>): string;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// 输出投影：Gateway 自己计量，不信任工具自报 truncated
// ---------------------------------------------------------------------------

export function project(full: string, label: string): {
  preview: string;
  truncated: boolean;
  artifactRef: string | null;
} {
  const lines = full.split('\n');
  const byBytes = Buffer.byteLength(full, 'utf8') > PREVIEW_MAX_BYTES;
  const byLines = lines.length > PREVIEW_MAX_LINES;
  if (!byBytes && !byLines) return { preview: full, truncated: false, artifactRef: null };

  const head = lines.slice(0, PREVIEW_MAX_LINES).join('\n').slice(0, PREVIEW_MAX_BYTES);
  const artifactId = newId('art');
  const file = join(PATHS.artifacts, `${artifactId}.txt`);
  writeFileSync(file, full, 'utf8');
  return {
    preview: `${head}\n… [已截断：${lines.length} 行 / ${Buffer.byteLength(full, 'utf8')} 字节，完整内容见 ${label} artifact ${artifactId}]`,
    truncated: true,
    artifactRef: artifactId,
  };
}

// ---------------------------------------------------------------------------
// R0 — 读 / 搜索
// ---------------------------------------------------------------------------

const readSchema = z.object({
  path: z.string().min(1).describe('仓库相对路径'),
});

const fsRead: ToolDefinition<typeof readSchema> = {
  name: 'fs_read',
  risk: 'R0',
  description:
    '读取工作区中一个文件的完整内容，并返回一个 receiptId。修改现有文件前必须先用本工具读取，' +
    '并把返回的 receiptId 传给 workspace_mutate。',
  schema: readSchema,
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '仓库相对路径，如 src/App.tsx' } },
    required: ['path'],
    additionalProperties: false,
  },
  summarize: (a) => `读取 ${a.path}`,
  async execute(args, ctx) {
    if (!ctx.workspace.exists(args.path)) {
      return fail(`文件不存在: ${args.path}`);
    }
    const { content, receipt } = ctx.workspace.issueReceipt(args.path);
    const numbered = content
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join('\n');
    const p = project(numbered, 'fs_read');
    return {
      ok: true,
      modelText: `receiptId=${receipt.receiptId}\ndigest=${receipt.fileDigest}\n\n${p.preview}`,
      preview: p.preview,
      previewTruncated: p.truncated,
      artifactRef: p.artifactRef,
      meta: { receiptId: receipt.receiptId, path: args.path },
    };
  },
};

const globSchema = z.object({
  pattern: z.string().min(1).describe('glob 模式，如 src/**/*.tsx'),
});

const fsGlob: ToolDefinition<typeof globSchema> = {
  name: 'fs_glob',
  risk: 'R0',
  description: '按 glob 模式列出工作区中匹配的文件路径。',
  schema: globSchema,
  jsonSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  summarize: (a) => `glob ${a.pattern}`,
  async execute(args, ctx) {
    const matches = listTree(ctx.workspace.activePath)
      .map((f) => f.path)
      .filter((p) => globMatch(args.pattern, p));
    const text = matches.length ? matches.join('\n') : '（无匹配）';
    const p = project(text, 'fs_glob');
    return { ok: true, modelText: p.preview, preview: p.preview, previewTruncated: p.truncated, artifactRef: p.artifactRef };
  },
};

const grepSchema = z.object({
  pattern: z.string().min(1).describe('正则表达式'),
  pathGlob: z.string().optional().describe('限定搜索范围的 glob，可选'),
});

const fsGrep: ToolDefinition<typeof grepSchema> = {
  name: 'fs_grep',
  risk: 'R0',
  description: '在工作区文件内容中用正则搜索，返回 path:line:内容。',
  schema: grepSchema,
  jsonSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, pathGlob: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  summarize: (a) => `grep /${a.pattern}/${a.pathGlob ? ` in ${a.pathGlob}` : ''}`,
  async execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (err) {
      return fail(`无效正则: ${(err as Error).message}`);
    }
    const hits: string[] = [];
    const MAX_HITS = 200;
    for (const entry of listTree(ctx.workspace.activePath)) {
      if (ctx.signal.aborted) break;
      if (args.pathGlob && !globMatch(args.pathGlob, entry.path)) continue;
      if (entry.bytes > 500_000) continue;
      let content: string;
      try {
        content = readFileSync(join(ctx.workspace.activePath, entry.path), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i]!)) {
          hits.push(`${entry.path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= MAX_HITS) break; // 源端早停，不是读全再截断
        }
      }
      if (hits.length >= MAX_HITS) break;
    }
    const text = hits.length ? hits.join('\n') : '（无匹配）';
    const p = project(text, 'fs_grep');
    return {
      ok: true,
      modelText: hits.length >= MAX_HITS ? `${p.preview}\n[已达 ${MAX_HITS} 条命中上限，结果不完整]` : p.preview,
      preview: p.preview,
      previewTruncated: p.truncated,
      artifactRef: p.artifactRef,
    };
  },
};

const listSchema = z.object({
  path: z.string().default('.').describe('目录相对路径'),
});

const fsList: ToolDefinition<typeof listSchema> = {
  name: 'fs_list',
  risk: 'R0',
  description: '列出工作区某个目录下的文件树（相对路径）。',
  schema: listSchema,
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string', default: '.' } },
    additionalProperties: false,
  },
  summarize: (a) => `列出 ${a.path}`,
  async execute(args, ctx) {
    const prefix = args.path === '.' || args.path === '' ? '' : `${args.path.replace(/\/$/, '')}/`;
    const files = listTree(ctx.workspace.activePath)
      .map((f) => f.path)
      .filter((p) => p.startsWith(prefix));
    const text = files.length ? files.join('\n') : '（空目录或路径不存在）';
    const p = project(text, 'fs_list');
    return { ok: true, modelText: p.preview, preview: p.preview, previewTruncated: p.truncated, artifactRef: p.artifactRef };
  },
};

// ---------------------------------------------------------------------------
// R1 — 变更 / 构建
// ---------------------------------------------------------------------------

const opSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REPLACE_EXACT_TEXT_SPAN'),
    path: z.string().min(1),
    receiptId: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
  }),
  z.object({
    kind: z.literal('REPLACE_WHOLE_FILE'),
    path: z.string().min(1),
    receiptId: z.string().min(1),
    newText: z.string(),
  }),
  z.object({
    kind: z.literal('CREATE_FILE'),
    path: z.string().min(1),
    newText: z.string(),
  }),
]);

const mutateSchema = z.object({
  operations: z.array(opSchema).min(1).max(20),
});

const workspaceMutate: ToolDefinition<typeof mutateSchema> = {
  name: 'workspace_mutate',
  risk: 'R1',
  description:
    '对工作区做一笔原子变更。整笔要么全部成功，要么全部不生效。' +
    'REPLACE_EXACT_TEXT_SPAN 的 oldText 必须在文件中恰好出现一次（不做模糊匹配），' +
    '且必须带上 fs_read 返回的 receiptId。CREATE_FILE 的目标必须不存在。',
  schema: mutateSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['REPLACE_EXACT_TEXT_SPAN', 'REPLACE_WHOLE_FILE', 'CREATE_FILE'] },
            path: { type: 'string', description: '仓库相对路径' },
            receiptId: { type: 'string', description: 'fs_read 返回的 receiptId；CREATE_FILE 不需要' },
            oldText: { type: 'string', description: '仅 REPLACE_EXACT_TEXT_SPAN：必须唯一命中的原文本' },
            newText: { type: 'string' },
          },
          required: ['kind', 'path', 'newText'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  summarize: (a) =>
    `变更 ${a.operations.length} 处: ${a.operations.map((o) => `${o.kind === 'CREATE_FILE' ? '+' : '~'}${o.path}`).join(', ')}`,
  async execute(args, ctx) {
    const result = applyMutationPlan(
      ctx.workspace,
      {
        planId: newId('mut'),
        runId: ctx.runId,
        inputGeneration: ctx.workspace.activeGeneration,
        operations: args.operations as unknown as MutationOperation[],
      },
      ctx.mutationPolicy,
    );

    if (!result.ok) {
      return {
        ok: false,
        modelText:
          `变更被阻断（整笔未生效，工作区保持在 gen-${result.rolledBackToGeneration}）\n` +
          `原因: ${result.reason}\n${result.detail}`,
        preview: `${result.reason}: ${result.detail}`,
        previewTruncated: false,
        artifactRef: null,
        failureReason: result.reason,
        meta: { blockReason: result.reason },
      };
    }

    const lines = result.operations.map(
      (o) => `${o.kind === 'CREATE_FILE' ? '新建' : '修改'} ${o.path} (${o.bytesDelta >= 0 ? '+' : ''}${o.bytesDelta} 字节)`,
    );
    return {
      ok: true,
      modelText: `变更已原子提交，工作区进入 gen-${result.outputGeneration}\n${lines.join('\n')}`,
      preview: lines.join('\n'),
      previewTruncated: false,
      artifactRef: null,
      meta: { generation: result.outputGeneration, treeDigest: result.treeDigest, operations: result.operations },
    };
  },
};

const commandSchema = z.object({
  commandId: z.string().min(1).describe('必须是 profile 中已登记的 command id'),
});

const runProfileCommand: ToolDefinition<typeof commandSchema> = {
  name: 'run_command',
  risk: 'R1',
  description:
    '运行仓库 profile 中已登记的命令（如 build / test / typecheck）。' +
    '只能用 commandId 引用，不能传任意 shell 字符串。',
  schema: commandSchema,
  jsonSchema: {
    type: 'object',
    properties: { commandId: { type: 'string' } },
    required: ['commandId'],
    additionalProperties: false,
  },
  summarize: (a) => `运行命令 ${a.commandId}`,
  async execute(args, ctx) {
    const def = ctx.profile.commands[args.commandId];
    if (!def) {
      return fail(
        `未登记的 commandId: ${args.commandId}。可用: ${Object.keys(ctx.profile.commands).join(', ') || '（无）'}`,
      );
    }
    const outcome = await runCommand(def, ctx.workspace.activePath, ctx.signal);
    return commandOutcomeToTool(outcome);
  },
};

export function commandOutcomeToTool(outcome: CommandOutcome): ToolOutcome {
  const combined = [
    `outcome=${outcome.outcome} exitCode=${outcome.exitCode ?? 'null'} signal=${outcome.signal ?? 'null'} durationMs=${outcome.durationMs}`,
    outcome.stdoutPreview ? `--- stdout ---\n${outcome.stdoutPreview}` : '',
    outcome.stderrPreview ? `--- stderr ---\n${outcome.stderrPreview}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const p = project(combined, 'run_command');
  const ok = outcome.outcome === 'EXIT_ZERO';
  return {
    ok,
    modelText: p.preview,
    preview: p.preview,
    previewTruncated: p.truncated,
    artifactRef: p.artifactRef,
    ...(ok ? {} : { failureReason: outcome.outcome }),
    meta: { outcome },
  };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const TOOLS: readonly ToolDefinition[] = [
  fsRead,
  fsGlob,
  fsGrep,
  fsList,
  workspaceMutate,
  runProfileCommand,
] as unknown as readonly ToolDefinition[];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 规划阶段由平台强制 read-only —— 不是靠 prompt 自律（PRD-PLAN-001） */
export const PLANNING_TOOLS = TOOLS.filter((t) => t.risk === 'R0');

function fail(message: string): ToolOutcome {
  return {
    ok: false,
    modelText: message,
    preview: message,
    previewTruncated: false,
    artifactRef: null,
    failureReason: 'TOOL_ERROR',
  };
}

export function relPathOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

export function safeStat(path: string): { size: number } | null {
  try {
    return { size: statSync(path).size };
  } catch {
    return null;
  }
}
