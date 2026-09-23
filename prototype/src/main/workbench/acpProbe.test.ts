import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultAcpAgentCandidates, filterExistingLaunches, probeAcpAgent } from './acpProbe';

/**
 * acpProbe 的负向测试（真子进程）。核心不是"能不能连上"，而是：
 *   1. 连上真 ACP agent 才 SUPPORTED；连不上/版本不符/不回话一律 UNKNOWN，不谎报；
 *   2. 探针**从不调 session/prompt** —— 用一个"收到 prompt 就写标记文件"的桩反证零模型出站。
 */

const sandbox = mkdtempSync(join(tmpdir(), 'repopilot-acpprobe-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const isoEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(sandbox, 'synthetic-home'),
    ...extra,
});

/** 一个真会讲 ACP 的子进程；若收到 session/prompt 就把 'PROMPTED' 写进标记文件。 */
function acpAgentScript(protocolVersion: number): string {
    return `
    process.on('SIGTERM', () => {});
    const fs = require('fs');
    const marker = process.env.ACP_PROMPT_MARKER;
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: ${protocolVersion}, agentCapabilities: { loadSession: false } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's-1' } });
      else if (m.method === 'session/prompt') { if (marker) fs.writeFileSync(marker, 'PROMPTED'); send({ id: m.id, result: { stopReason: 'end_turn' } }); }
    });
  `;
}

describe('probeAcpAgent', () => {
    it('连上真讲 ACP v1 的子进程 → 三项 SUPPORTED、拿到 sessionId、且从不发 prompt', async () => {
        const marker = join(sandbox, 'prompted-good');
        const result = await probeAcpAgent(
            { binary: process.execPath, args: ['-e', acpAgentScript(1)] },
            { env: isoEnv({ ACP_PROMPT_MARKER: marker }), cwd: sandbox, timeoutMs: 3_000 },
        );
        expect(result.reachable.verdict).toBe('SUPPORTED');
        expect(result.versionNegotiated.verdict).toBe('SUPPORTED');
        expect(result.createSession.verdict).toBe('SUPPORTED');
        expect(result.protocolVersion).toBe(1);
        expect(result.sessionId).toBe('s-1');
        // 零模型出站的硬证据：结构性 false + 桩的标记文件从未被写。
        expect(result.promptAttempted).toBe(false);
        expect(existsSync(marker)).toBe(false);
    }, 15_000);

    it('对端版本不是 v1 → versionNegotiated UNKNOWN，且不谎报 createSession', async () => {
        const marker = join(sandbox, 'prompted-ver');
        const result = await probeAcpAgent(
            { binary: process.execPath, args: ['-e', acpAgentScript(0)] },
            { env: isoEnv({ ACP_PROMPT_MARKER: marker }), cwd: sandbox, timeoutMs: 3_000 },
        );
        expect(result.reachable.verdict).toBe('SUPPORTED'); // 连上了，会回话
        expect(result.versionNegotiated.verdict).toBe('UNKNOWN'); // 但版本不匹配
        expect(result.createSession.verdict).toBe('UNKNOWN'); // 因版本不符跳过 session/new
        expect(result.sessionId).toBeNull();
        expect(existsSync(marker)).toBe(false);
    }, 15_000);

    it('二进制立刻退出（不是 ACP）→ 三项 UNKNOWN，绝不 SUPPORTED', async () => {
        const result = await probeAcpAgent(
            { binary: process.execPath, args: ['-e', 'process.exit(0)'] },
            { env: isoEnv({}), cwd: sandbox, timeoutMs: 3_000 },
        );
        expect(result.reachable.verdict).toBe('UNKNOWN');
        expect(result.versionNegotiated.verdict).toBe('UNKNOWN');
        expect(result.createSession.verdict).toBe('UNKNOWN');
        expect(result.protocolVersion).toBeNull();
    }, 15_000);

    it('二进制不回话（挂起）→ 超时落 UNKNOWN，不假绿', async () => {
        const result = await probeAcpAgent(
            { binary: process.execPath, args: ['-e', "process.stdin.resume(); process.on('SIGTERM', () => {})"] },
            { env: isoEnv({}), cwd: sandbox, timeoutMs: 400 },
        );
        expect(result.reachable.verdict).toBe('UNKNOWN');
        expect(result.reachable.reason).toMatch(/initialize|timeout|握手失败/i);
    }, 15_000);

    it('filterExistingLaunches 只留真实存在的可执行（发现≠协议成立）', () => {
        const launches = filterExistingLaunches([
            { binary: process.execPath, args: [] },
            { binary: '/definitely/missing/acp-agent', args: [] },
        ]);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.binary).toBe(process.execPath);
    });
});

/*
 * opt-in 真机探针（默认跳过，同 codexAdapter.probe.test.ts / desktopProbe 的 REPOPILOT_PROBE_DESKTOP 纪律）：
 *   REPOPILOT_ACP_REAL=1 REPOPILOT_ACP_AGENT=<binary> REPOPILOT_ACP_AGENT_ARGS="<args...>" \
 *   pnpm exec vitest run src/main/workbench/acpProbe.test.ts
 * 用真·第三方 ACP 实现（如 Neovate）验我们自己的 probeAcpAgent：只做本地握手、隔离 HOME、不发 prompt。
 */
const realGate = process.env.REPOPILOT_ACP_REAL === '1';
const realAgent = process.env.REPOPILOT_ACP_AGENT?.trim() ?? '';
const realArgs = (process.env.REPOPILOT_ACP_AGENT_ARGS ?? '').split(' ').filter(Boolean);
const realCwd = mkdtempSync(join(tmpdir(), 'repopilot-acp-real-'));

describe.skipIf(!realGate || !realAgent)('acpProbe × 真第三方 ACP agent（opt-in）', () => {
    it('对真 agent 完成本地握手并如实报告', async () => {
        // eslint-disable-next-line no-console
        console.log('[acpProbe] PATH 上发现的候选：', JSON.stringify(filterExistingLaunches(defaultAcpAgentCandidates())));
        const result = await probeAcpAgent(
            { binary: realAgent, args: realArgs, source: 'ENV' },
            { env: { PATH: process.env.PATH ?? '', HOME: realCwd }, cwd: realCwd, timeoutMs: 20_000 },
        );
        // eslint-disable-next-line no-console
        console.log('[acpProbe real]', JSON.stringify(result, null, 2));
        // 断言只卡“不会谎报”：握手成功则 reachable/version 都 SUPPORTED；失败则不允许 SUPPORTED 与失败并存。
        expect(result.promptAttempted).toBe(false);
        if (result.reachable.verdict === 'SUPPORTED') {
            expect(result.versionNegotiated.verdict).toBe('SUPPORTED');
        } else {
            expect(result.versionNegotiated.verdict).toBe('UNKNOWN');
        }
        rmSync(realCwd, { recursive: true, force: true });
    }, 60_000);
});
