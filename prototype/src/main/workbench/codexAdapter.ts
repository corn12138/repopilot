import type { WorkbenchEngineCapability } from '@shared/workbenchProtocol';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultEngineCandidates, discoverEngineBinary } from '../observer/desktopProbe';
import type { AdapterEvent, ManagedEngineSession, WorkbenchAgentAdapter } from './adapter';
import { workbenchEngineEnv } from './isolatedEnv';
import { JsonRpcProcess } from './jsonRpcProcess';

const checked = (verdict: 'SUPPORTED' | 'UNKNOWN', checkedAt: string, evidence: readonly string[], reason: string | null) => ({ verdict, checkedAt, evidence, reason });

async function initialize(client: Pick<JsonRpcProcess, 'request' | 'notify'>): Promise<void> {
  await client.request('initialize', { clientInfo: { name: 'RepoPilot', version: '0.0.1' }, capabilities: {} });
  client.notify('initialized', {});
}

type RpcClient = Pick<JsonRpcProcess, 'request' | 'notify' | 'subscribe' | 'stop'>;
type ClientFactory = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => RpcClient;

const SUPPORTED_CODEX_VERSION = 'codex-cli 0.154.0-alpha.6.2';

function readCodexVersion(binaryPath: string, home: string): string {
  return execFileSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
    env: workbenchEngineEnv({ home }),
  }).trim().slice(0, 200);
}

function prepareEphemeralCredentialStore(engineHome: string): void {
  mkdirSync(engineHome, { recursive: true });
  writeFileSync(
    join(engineHome, 'config.toml'),
    'cli_auth_credentials_store = "ephemeral"\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function establishApiKeyIdentity(client: RpcClient, apiKey: string): Promise<boolean> {
  const login = await client.request('account/login/start', { type: 'apiKey', apiKey });
  if (login.type !== 'apiKey') throw new Error('account/login/start 未确认 apiKey 身份');
  const account = await client.request('account/read', { refreshToken: false });
  return (account.account as Record<string, unknown> | null | undefined)?.type === 'apiKey';
}

export class CodexAppServerAdapter implements WorkbenchAgentAdapter {
  readonly vendor = 'CODEX' as const;
  private authenticatedAt: string | null = null;
  private authenticatedModel: string | null = null;

  constructor(
    private readonly createClient: ClientFactory = (binary, args, env) => new JsonRpcProcess(binary, args, env),
    private readonly discover = () => discoverEngineBinary('CODEX', defaultEngineCandidates()),
    private readonly credential = (): string | null => null,
    private readonly readVersion = readCodexVersion,
  ) { }

  async probe(): Promise<WorkbenchEngineCapability> {
    const checkedAt = new Date().toISOString();
    const found = this.discover();
    const apiKey = this.credential()?.trim() ?? '';
    const credentialConfigured = apiKey
      ? checked('SUPPORTED', checkedAt, ['RepoPilot 凭据库已配置 OPENAI_API_KEY'], null)
      : checked('UNKNOWN', checkedAt, [], '请先在设置中保存 OpenAI API key');
    if (!found.binaryPath) {
      const absent = checked('UNKNOWN', checkedAt, found.checkedPaths, found.reason);
      return { vendor: 'CODEX', installed: absent, versionSupported: absent, transport: absent, credentialConfigured, authenticated: absent, createSession: absent, readStoredHistory: absent, attachLive: absent, interrupt: absent, readOnlyReviewIsolation: absent, version: null, source: 'NOT_FOUND' };
    }
    const probeCwd = mkdtempSync(join(tmpdir(), 'repopilot-codex-probe-'));
    const engineHome = join(probeCwd, 'engine-home');
    prepareEphemeralCredentialStore(engineHome);
    const client = this.createClient(found.binaryPath, ['app-server'], workbenchEngineEnv({ home: engineHome }));
    try {
      await initialize(client);
      mkdirSync(join(probeCwd, 'version-home'), { recursive: true });
      const versionText = this.readVersion(found.binaryPath, join(probeCwd, 'version-home'));
      if (!/\d+\.\d+/.test(versionText)) throw new Error(`无法解析版本：${versionText || '空输出'}`);
      const versionSupported = versionText === SUPPORTED_CODEX_VERSION
        ? checked('SUPPORTED', checkedAt, [`已验证 app-server 合同版本：${versionText}`], null)
        : checked('UNKNOWN', checkedAt, [versionText], '该 Codex 版本尚未列入已验证兼容配对');
      const transport = checked('SUPPORTED', checkedAt, ['initialize response received over stdio'], null);
      if (versionSupported.verdict !== 'SUPPORTED') {
        const unavailable = checked('UNKNOWN', checkedAt, [], versionSupported.reason);
        return {
          vendor: 'CODEX',
          installed: checked('SUPPORTED', checkedAt, [`${found.source}: ${found.binaryPath}`], null),
          versionSupported,
          transport,
          credentialConfigured,
          authenticated: unavailable,
          createSession: unavailable,
          readStoredHistory: unavailable,
          attachLive: unavailable,
          interrupt: unavailable,
          readOnlyReviewIsolation: unavailable,
          version: versionText,
          source: found.source,
        };
      }
      const identityEstablished = apiKey ? await establishApiKeyIdentity(client, apiKey) : false;
      const started = await client.request('thread/start', {
        cwd: probeCwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      });
      if (typeof (started.thread as Record<string, unknown> | undefined)?.id !== 'string') {
        throw new Error('thread/start response omitted thread.id');
      }
      const createSession = versionSupported.verdict === 'SUPPORTED' && identityEstablished
        ? checked('SUPPORTED', checkedAt, ['ephemeral read-only thread/start returned thread.id after apiKey identity binding'], null)
        : checked(
          'UNKNOWN',
          checkedAt,
          [],
          credentialConfigured.reason ?? versionSupported.reason ?? 'app-server 未建立 apiKey 身份',
        );
      const authenticated = this.authenticatedAt
        ? checked('SUPPORTED', checkedAt, [
          `使用 RepoPilot 凭据库中的 OPENAI_API_KEY 完成模型轮次（${this.authenticatedAt}）`,
          ...(this.authenticatedModel ? [`实际模型：${this.authenticatedModel}`] : []),
        ], null)
        : identityEstablished
          ? checked('SUPPORTED', checkedAt, ['account/login/start + account/read 已建立 apiKey 身份；未发送模型消息'], null)
          : checked('UNKNOWN', checkedAt, [], 'app-server 尚未建立 apiKey 身份');
      const unknown = checked('UNKNOWN', checkedAt, [], '未发送模型消息，尚未验证真实响应');
      return {
        vendor: 'CODEX',
        installed: checked('SUPPORTED', checkedAt, [`${found.source}: ${found.binaryPath}`], null),
        versionSupported,
        transport,
        credentialConfigured,
        authenticated,
        createSession,
        readStoredHistory: checked('UNKNOWN', checkedAt, [], '本切片只创建 ephemeral thread，不读取历史'),
        attachLive: checked('UNKNOWN', checkedAt, [], '新建 thread 不证明可控制 Desktop 活跃会话'),
        interrupt: checked('UNKNOWN', checkedAt, [], '未启动真实模型 turn，尚未验证 turn/interrupt 终局'),
        readOnlyReviewIsolation: checked('SUPPORTED', checkedAt, ['thread/start sandbox=read-only, approvalPolicy=never'], null),
        version: versionText,
        source: found.source,
      };
    } catch (error) {
      const failed = checked('UNKNOWN', checkedAt, [], `stdio initialize 失败：${(error as Error).message}`);
      return { vendor: 'CODEX', installed: checked('SUPPORTED', checkedAt, [`${found.source}: ${found.binaryPath}`], null), versionSupported: failed, transport: failed, credentialConfigured, authenticated: failed, createSession: failed, readStoredHistory: failed, attachLive: failed, interrupt: failed, readOnlyReviewIsolation: failed, version: null, source: found.source };
    } finally {
      await client.stop();
      rmSync(probeCwd, { recursive: true, force: true });
    }
  }

  async start(): Promise<ManagedEngineSession> {
    const found = this.discover();
    if (!found.binaryPath) throw new Error(found.reason ?? 'Codex executable not found');
    const apiKey = this.credential()?.trim();
    if (!apiKey) throw new Error('未配置 OpenAI 工作位凭据');
    const cwd = mkdtempSync(join(tmpdir(), 'repopilot-codex-workbench-'));
    let client: RpcClient | null = null;
    try {
      const engineHome = join(cwd, 'engine-home');
      prepareEphemeralCredentialStore(engineHome);
      const versionHome = join(cwd, 'version-home');
      mkdirSync(versionHome, { recursive: true });
      const versionText = this.readVersion(found.binaryPath, versionHome);
      if (versionText !== SUPPORTED_CODEX_VERSION) {
        throw new Error(`Codex 版本未准入：${versionText || '空输出'}`);
      }
      client = this.createClient(found.binaryPath, ['app-server'], workbenchEngineEnv({ home: engineHome }));
      const activeClient = client;
      await initialize(activeClient);
      if (!await establishApiKeyIdentity(activeClient, apiKey)) {
        throw new Error('account/read 未确认 apiKey 身份');
      }
      const response = await activeClient.request('thread/start', {
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: 'This is a conversation-only workstation. Do not call tools or modify files.',
      });
      const thread = response.thread as Record<string, unknown> | undefined;
      const threadId = typeof thread?.id === 'string' ? thread.id : null;
      if (typeof thread?.model === 'string') this.authenticatedModel = thread.model;
      if (!threadId) throw new Error('thread/start response omitted thread.id');
      let current: { requestId: string; turnId: string; emit: (event: AdapterEvent) => void; sequence: number } | null = null;
      let starting: { requestId: string; emit: (event: AdapterEvent) => void; buffered: Record<string, unknown>[] } | null = null;
      const handleMessage = (message: Record<string, unknown>) => {
        if (typeof message.method !== 'string') return;
        if (!current) {
          if (starting) starting.buffered.push(message);
          return;
        }
        const params = (message.params as Record<string, unknown>) ?? {};
        if (message.method === 'transport/disconnected' || message.method === 'transport/protocolError') {
          current.emit({ kind: 'disconnected', turnId: current.turnId, sequence: ++current.sequence, reason: String((params as { reason?: unknown }).reason ?? 'transport disconnected') });
          current = null;
          return;
        }
        const eventThreadId = typeof params.threadId === 'string' ? params.threadId : null;
        const eventTurnId = typeof params.turnId === 'string'
          ? params.turnId
          : typeof (params.turn as Record<string, unknown> | undefined)?.id === 'string'
            ? String((params.turn as Record<string, unknown>).id)
            : null;
        /*
         * app-server 通知属于 thread + turn 二元身份。缺任一字段都不能猜成当前轮，
         * 否则别的客户端或晚到通知会被写进眼前这段对话。
         */
        if (eventThreadId !== threadId || eventTurnId !== current.turnId) return;
        /*
         * 这里没有 waiting/blocked 分支，是刻意的：thread/start 与 turn/start 都固定
         * approvalPolicy='never' + sandbox='read-only'（只读隔离不变式），app-server 因此不会
         * 向我们发审批/elicitation 请求 —— Codex 受管会话的 agentState 只有 WORKING/DONE/
         * ERROR/DISCONNECTED，永远不出现 BLOCKED_APPROVAL。放宽这条隔离去换取 blocked 感知
         * 是另一个信任域决定，本轮不做；workbenchService.test.ts 有负向断言钉住它没被放宽。
         */
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          current.emit({ kind: 'text', turnId: current.turnId, sequence: ++current.sequence, text: params.delta });
        } else if (message.method === 'turn/completed') {
          const status = (params.turn as Record<string, unknown> | undefined)?.status;
          const outcome = status === 'completed' ? 'COMPLETED' : status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
          if (outcome === 'COMPLETED') this.authenticatedAt = new Date().toISOString();
          current.emit({ kind: 'finished', turnId: current.turnId, sequence: ++current.sequence, outcome, reason: status ? String(status) : null });
          current = null;
        }
      };
      const unsubscribe = activeClient.subscribe(handleMessage);
      return {
        vendorSessionId: threadId,
        send: async ({ requestId, text, onEvent }) => {
          if (starting || current) throw new Error('turn already active');
          starting = { requestId, emit: onEvent, buffered: [] };
          const response = await activeClient.request('turn/start', {
            threadId,
            input: [{ type: 'text', text }],
            approvalPolicy: 'never',
          });
          const turn = response.turn as Record<string, unknown> | undefined;
          if (typeof turn?.id !== 'string') {
            starting = null;
            throw new Error('turn/start response omitted turn.id');
          }
          current = { requestId, turnId: turn.id, emit: onEvent, sequence: 0 };
          const buffered = starting.buffered;
          starting = null;
          for (const message of buffered) handleMessage(message);
        },
        interrupt: async () => {
          if (!current) throw new Error('no active turn');
          await activeClient.request('turn/interrupt', { threadId, turnId: current.turnId });
        },
        dispose: async () => {
          unsubscribe();
          await activeClient.stop();
          rmSync(cwd, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await client?.stop();
      rmSync(cwd, { recursive: true, force: true });
      throw error;
    }
  }
}
