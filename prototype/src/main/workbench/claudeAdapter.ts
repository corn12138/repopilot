import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WorkbenchEngineCapability } from '@shared/workbenchProtocol';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultEngineCandidates, discoverEngineBinary } from '../observer/desktopProbe';
import type { ManagedEngineSession, WorkbenchAgentAdapter } from './adapter';
import { workbenchEngineEnv } from './isolatedEnv';

type QueryFn = typeof query;

const capability = (verdict: 'SUPPORTED' | 'UNKNOWN', checkedAt: string, evidence: readonly string[], reason: string | null) => ({ verdict, checkedAt, evidence, reason });

/**
 * 防御性识别 Claude Agent SDK 的权限/控制请求（streaming 模式下形如
 * `{ type: 'control_request', request: { subtype: 'can_use_tool' } }`，或 subtype=can_use_tool）。
 * 用宽松 cast，不依赖 SDKMessage 是否已把该变体纳入联合 —— 未纳入时也不会 typecheck 失败。
 */
function isPermissionRequest(message: SDKMessage): boolean {
  const raw = message as { type?: unknown; subtype?: unknown; request?: { subtype?: unknown } | undefined };
  return (
    raw.type === 'control_request'
    || raw.subtype === 'can_use_tool'
    || raw.request?.subtype === 'can_use_tool'
  );
}

export class ClaudeAgentSdkAdapter implements WorkbenchAgentAdapter {
  readonly vendor = 'CLAUDE' as const;
  private authenticatedAt: string | null = null;
  private authenticatedModel: string | null = null;

  constructor(
    private readonly runQuery: QueryFn = query,
    private readonly discover = () => discoverEngineBinary('CLAUDE', defaultEngineCandidates()),
    private readonly credential = (): string | null => null,
  ) { }

  async probe(): Promise<WorkbenchEngineCapability> {
    const checkedAt = new Date().toISOString();
    const found = this.discover();
    const apiKey = this.credential()?.trim() ?? '';
    const credentialConfigured = apiKey
      ? capability('SUPPORTED', checkedAt, ['RepoPilot 凭据库已配置 ANTHROPIC_API_KEY'], null)
      : capability('UNKNOWN', checkedAt, [], '请先在设置中保存 Anthropic API key');
    const absent = capability('UNKNOWN', checkedAt, found.checkedPaths, found.reason);
    if (!found.binaryPath) return { vendor: 'CLAUDE', installed: absent, versionSupported: absent, transport: absent, credentialConfigured, authenticated: absent, createSession: absent, readStoredHistory: absent, attachLive: absent, interrupt: absent, readOnlyReviewIsolation: absent, version: null, source: 'NOT_FOUND' };
    const probeHome = mkdtempSync(join(tmpdir(), 'repopilot-claude-probe-'));
    let version: string;
    try {
      version = execFileSync(found.binaryPath, ['--version'], { encoding: 'utf8', timeout: 3_000, env: workbenchEngineEnv({ home: probeHome }) }).trim().slice(0, 200);
    } catch (error) {
      const failed = capability('UNKNOWN', checkedAt, [], `CLI 版本探测失败：${(error as Error).message}`);
      return { vendor: 'CLAUDE', installed: capability('SUPPORTED', checkedAt, [found.binaryPath], null), versionSupported: failed, transport: failed, credentialConfigured, authenticated: failed, createSession: failed, readStoredHistory: failed, attachLive: absent, interrupt: failed, readOnlyReviewIsolation: failed, version: null, source: found.source };
    } finally {
      rmSync(probeHome, { recursive: true, force: true });
    }
    const transport = capability('SUPPORTED', checkedAt, ['Claude Agent SDK 0.3.260 已固定；未发送模型消息'], null);
    const authenticated = this.authenticatedAt
      ? capability('SUPPORTED', checkedAt, [
        `使用 RepoPilot 凭据库中的 ANTHROPIC_API_KEY 完成模型轮次（${this.authenticatedAt}）`,
        ...(this.authenticatedModel ? [`实际模型：${this.authenticatedModel}`] : []),
      ], null)
      : capability('UNKNOWN', checkedAt, [], '未发送模型消息，认证与真实响应尚未验证');
    const unknown = capability('UNKNOWN', checkedAt, [], '未发送模型消息，真实响应尚未验证');
    const versionSupported = /^2\.1\.260(?:\s|$)/.test(version)
      ? capability('SUPPORTED', checkedAt, [`Claude CLI ${version} + Agent SDK 0.3.260`], null)
      : capability('UNKNOWN', checkedAt, [version], '当前只验证了 Claude CLI 2.1.260 与 Agent SDK 0.3.260 的固定配对');
    const createSession = versionSupported.verdict === 'SUPPORTED' && credentialConfigured.verdict === 'SUPPORTED'
      ? capability('SUPPORTED', checkedAt, ['固定版本配对、隔离配置与显式凭据均已就绪'], null)
      : capability('UNKNOWN', checkedAt, [], credentialConfigured.reason ?? versionSupported.reason ?? '工作位会话前置条件尚未满足');
    return { vendor: 'CLAUDE', installed: capability('SUPPORTED', checkedAt, [found.binaryPath], null), versionSupported, transport, credentialConfigured, authenticated, createSession, readStoredHistory: unknown, attachLive: capability('UNKNOWN', checkedAt, [], 'managed new session 不证明可控制 Desktop 活跃会话'), interrupt: capability('UNKNOWN', checkedAt, [], '未启动真实 query，尚未验证 AbortController 终局'), readOnlyReviewIsolation: capability('SUPPORTED', checkedAt, ['tools=[]、settingSources=[]、plugins=[]、mcpServers={}'], null), version, source: found.source };
  }

  async start(): Promise<ManagedEngineSession> {
    const found = this.discover();
    if (!found.binaryPath) throw new Error(found.reason ?? 'Claude executable not found');
    const apiKey = this.credential()?.trim();
    if (!apiKey) throw new Error('未配置 Anthropic 工作位凭据');
    const binaryPath = found.binaryPath;
    const cwd = mkdtempSync(join(tmpdir(), 'repopilot-claude-workbench-'));
    const engineHome = join(cwd, 'engine-home');
    mkdirSync(engineHome, { recursive: true });
    let abort: AbortController | null = null;
    let sessionId: string | undefined;
    let activeRequest: string | null = null;
    let activeStream: ReturnType<QueryFn> | null = null;
    let activeCompletion: Promise<void> | null = null;
    let disposed = false;
    return {
      vendorSessionId: '',
      send: async ({ requestId, text, onEvent }) => {
        if (disposed) throw new Error('session disposed');
        if (activeRequest) throw new Error('turn already active');
        activeRequest = requestId;
        abort = new AbortController();
        const stream = this.runQuery({
          prompt: text,
          options: {
            pathToClaudeCodeExecutable: binaryPath,
            cwd,
            env: workbenchEngineEnv({ home: engineHome, credential: { name: 'ANTHROPIC_API_KEY', value: apiKey } }),
            abortController: abort,
            includePartialMessages: true,
            ...(sessionId ? { resume: sessionId } : {}),
            tools: [],
            disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
            settingSources: [],
            mcpServers: {},
            plugins: [],
            systemPrompt: 'Conversation-only workstation. Do not use tools or modify files.',
          },
        });
        activeStream = stream;
        const completion = (async () => {
          let sequence = 0;
          let terminal = false;
          let sawStreamText = false;
          try {
            for await (const message of stream as AsyncIterable<SDKMessage>) {
              if (typeof message.session_id === 'string') sessionId = message.session_id;
              if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
                this.authenticatedModel = message.model;
              }
              if (
                message.type === 'stream_event'
                && message.event.type === 'content_block_delta'
                && message.event.delta.type === 'text_delta'
              ) {
                sawStreamText = true;
                onEvent({ kind: 'text', turnId: requestId, sequence: ++sequence, text: message.event.delta.text });
              } else if (message.type === 'assistant' && !sawStreamText) {
                const content = ((message.message as { content?: unknown[] } | undefined)?.content ?? []);
                for (const block of content) if ((block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
                  onEvent({ kind: 'text', turnId: requestId, sequence: ++sequence, text: String((block as { text: string }).text) });
                }
              } else if (isPermissionRequest(message)) {
                /*
                 * herdr 式 blocked：引擎请求权限/批准。只**呈现**、不代答 —— conversation-only
                 * 工作位（tools=[]、disallowedTools 覆盖全部写/执行工具）不会放行工具，所以
                 * 当前配置下这条分支不会被真实引擎触发；它由确定性替身测试覆盖映射本身。
                 * 真正"从 RepoPilot 应答批准"是控制动作，属后续独立的隔离/信任域决定，本轮不做
                 * （SDK 权限回调只能提交批准请求，绝不绕过 Core 自动放行 —— 设计文档 §5.3）。
                 */
                onEvent({ kind: 'waiting', turnId: requestId, sequence: ++sequence, reason: 'APPROVAL', label: '引擎请求权限/批准 —— 请在该会话自己的工具里应答，RepoPilot 不代答' });
              } else if (message.type === 'result') {
                const interrupted = abort?.signal.aborted ?? false;
                if (!interrupted && !message.is_error) this.authenticatedAt = new Date().toISOString();
                activeRequest = null;
                abort = null;
                onEvent({ kind: 'finished', turnId: requestId, sequence: ++sequence, outcome: interrupted ? 'INTERRUPTED' : message.is_error ? 'FAILED' : 'COMPLETED', reason: typeof message.subtype === 'string' ? message.subtype : null });
                terminal = true;
              }
            }
          } catch (error) {
            const interrupted = abort?.signal.aborted ?? false;
            activeRequest = null;
            abort = null;
            onEvent({ kind: 'finished', turnId: requestId, sequence: ++sequence, outcome: interrupted ? 'INTERRUPTED' : 'FAILED', reason: (error as Error).message });
            terminal = true;
          } finally {
            if (!terminal) {
              activeRequest = null;
              abort = null;
              onEvent({ kind: 'finished', turnId: requestId, sequence: ++sequence, outcome: 'UNKNOWN', reason: 'Claude SDK 流结束但没有 result 消息' });
            }
            if (activeStream === stream) activeStream = null;
          }
        })();
        activeCompletion = completion;
        void completion.finally(() => {
          if (activeCompletion === completion) activeCompletion = null;
        });
      },
      interrupt: async (requestId) => {
        if (activeRequest !== requestId || !abort) throw new Error('request is not active');
        abort.abort();
      },
      dispose: async () => {
        disposed = true;
        abort?.abort();
        if (typeof activeStream?.close === 'function') activeStream.close();
        await activeCompletion;
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  }
}
