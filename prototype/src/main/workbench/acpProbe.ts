import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACP_PROTOCOL_VERSION, CONVERSATION_ONLY_CLIENT_CAPABILITIES } from './acpClientSession';
import { JsonRpcProcess } from './jsonRpcProcess';

/**
 * 对**外部真 ACP Agent** 的只读探针（`acpProbe.ts`）。
 *
 * 为什么单独一个模块、而不是注册成第三个 vendor：`WorkbenchVendor` 是封闭枚举
 * （'CODEX'|'CLAUDE'），加一项会波及共享协议 + Renderer 一堆穷举映射 —— 那是独立决定，
 * 本探针不承担，它只回答一个窄问题："给定一个 ACP 二进制，它是否真的讲 ACP v1、能不能建会话"。
 *
 * 硬纪律（全负向钉住于 acpProbe.test.ts）：
 *   - **只做 `initialize` + `session/new` 本地握手，结构上从不调 `session/prompt`** ——
 *     prompt 才会触发模型/出站。探针 `promptAttempted` 恒为 false。
 *   - 任何失败（spawn 不起来 / 无响应 / 版本不符 / 无 sessionId）一律落 `UNKNOWN` + 原因，
 *     **绝不谎报 SUPPORTED**（"未知不是默认绿灯"，同 stopReason 纪律）。
 *   - 由调用方注入隔离 env（synthetic HOME + 白名单），本模块不自己拼真实凭据环境。
 */

export type ProbeVerdict = 'SUPPORTED' | 'UNKNOWN';

export interface AcpProbeCapability {
    readonly verdict: ProbeVerdict;
    readonly evidence: readonly string[];
    readonly reason: string | null;
}

export interface AcpProbeResult {
    readonly binary: string;
    readonly args: readonly string[];
    readonly source: 'ENV' | 'PATH' | 'EXPLICIT';
    readonly reachable: AcpProbeCapability;
    readonly versionNegotiated: AcpProbeCapability;
    readonly createSession: AcpProbeCapability;
    readonly protocolVersion: number | null;
    readonly agentCapabilities: unknown;
    readonly sessionId: string | null;
    /** 恒为 false：探针绝不发 prompt（零模型出站）。留字段是为了被负向断言钉住。 */
    readonly promptAttempted: false;
    readonly checkedAt: string;
}

const cap = (verdict: ProbeVerdict, evidence: readonly string[], reason: string | null): AcpProbeCapability => ({ verdict, evidence, reason });

export interface AcpAgentLaunch {
    readonly binary: string;
    readonly args: readonly string[];
    readonly source?: AcpProbeResult['source'];
}

/**
 * 发现候选 ACP Agent：显式 env 优先（`REPOPILOT_ACP_AGENT`=可执行路径，`REPOPILOT_ACP_AGENT_ARGS`=参数），
 * 否则扫 PATH 上已知讲 ACP 的名字。**发现只证明可执行文件在，协议/认证保持 UNKNOWN**（同 desktopProbe 纪律）。
 */
export function defaultAcpAgentCandidates(pathEntries: readonly string[] = (process.env.PATH ?? '').split(':').filter(Boolean)): AcpAgentLaunch[] {
    const out: AcpAgentLaunch[] = [];
    const envBinary = process.env.REPOPILOT_ACP_AGENT?.trim();
    if (envBinary) {
        out.push({ binary: envBinary, args: (process.env.REPOPILOT_ACP_AGENT_ARGS ?? '').split(' ').filter(Boolean), source: 'ENV' });
    }
    for (const dir of pathEntries) {
        if (!dir) continue;
        out.push({ binary: join(dir, 'neovate'), args: ['acp'], source: 'PATH' });
        out.push({ binary: join(dir, 'gemini'), args: ['--experimental-acp'], source: 'PATH' });
    }
    return out;
}

/** 只保留可执行文件存在的候选（不执行、不 probe）。 */
export function filterExistingLaunches(candidates: readonly AcpAgentLaunch[]): AcpAgentLaunch[] {
    return candidates.filter((c) => existsSync(c.binary));
}

/**
 * 对一个 ACP 二进制做本地握手探针。调用方负责传隔离 env（synthetic HOME + 白名单）。
 * 全程不 import 任何凭据、不发 prompt。
 */
export async function probeAcpAgent(
    launch: AcpAgentLaunch,
    opts: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly timeoutMs?: number },
): Promise<AcpProbeResult> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const base = {
        binary: launch.binary,
        args: launch.args,
        source: launch.source ?? 'EXPLICIT',
        promptAttempted: false as const,
        checkedAt,
    };
    const rpc = new JsonRpcProcess(launch.binary, [...launch.args], opts.env, 200);
    try {
        const init = await rpc.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: CONVERSATION_ONLY_CLIENT_CAPABILITIES,
            clientInfo: { name: 'RepoPilot-probe', version: '0.0.1' },
        }, timeoutMs);
        const reachable = cap('SUPPORTED', [`initialize 在 stdio 上得到响应`], null);
        const negotiated = init.protocolVersion === ACP_PROTOCOL_VERSION;
        const versionNegotiated = negotiated
            ? cap('SUPPORTED', [`对端接受协议版本 v${ACP_PROTOCOL_VERSION}`], null)
            : cap('UNKNOWN', [`对端回 protocolVersion=${String(init.protocolVersion)}`], `只验证了 ACP v${ACP_PROTOCOL_VERSION}，对端版本不匹配`);
        let createSession = cap('UNKNOWN', [], negotiated ? '未尝试 session/new' : '版本未协商成功，跳过 session/new');
        let sessionId: string | null = null;
        if (negotiated) {
            const created = await rpc.request('session/new', { cwd: opts.cwd, mcpServers: [] }, timeoutMs);
            sessionId = typeof created.sessionId === 'string' ? created.sessionId : null;
            createSession = sessionId
                ? cap('SUPPORTED', ['session/new 返回 sessionId（未发 prompt）'], null)
                : cap('UNKNOWN', [], 'session/new 响应缺少 sessionId');
        }
        return {
            ...base,
            reachable,
            versionNegotiated,
            createSession,
            protocolVersion: typeof init.protocolVersion === 'number' ? init.protocolVersion : null,
            agentCapabilities: init.agentCapabilities ?? null,
            sessionId,
        };
    } catch (error) {
        const message = (error as Error).message.slice(0, 300);
        const unknown = cap('UNKNOWN', [], `initialize 握手失败：${message}`);
        return {
            ...base,
            reachable: unknown,
            versionNegotiated: unknown,
            createSession: cap('UNKNOWN', [], '因未握上手的 initialize 而跳过'),
            protocolVersion: null,
            agentCapabilities: null,
            sessionId: null,
        };
    } finally {
        await rpc.stop().catch(() => { });
    }
}
