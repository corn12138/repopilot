import type { WorkbenchEngineCapability, WorkbenchVendor } from '@shared/workbenchProtocol';
import { defaultEngineCandidates, discoverEngineBinary } from '../observer/desktopProbe';
import type { ManagedEngineSession, WorkbenchAgentAdapter } from './adapter';

const unknown = (checkedAt: string, reason: string) => ({
  verdict: 'UNKNOWN' as const,
  checkedAt,
  evidence: [] as readonly string[],
  reason,
});

/**
 * 只读发现 adapter 让 UI 能准确区分“已安装”和“可发消息”。传输 adapter 未接入前，
 * start 永远 fail closed；发现一个二进制不会顺带把协议、认证或 Desktop attach 标绿。
 */
export class DiscoveryOnlyAdapter implements WorkbenchAgentAdapter {
  constructor(readonly vendor: WorkbenchVendor) {}

  async probe(): Promise<WorkbenchEngineCapability> {
    const checkedAt = new Date().toISOString();
    const found = discoverEngineBinary(this.vendor, defaultEngineCandidates());
    const installed = found.binaryPath
      ? { verdict: 'SUPPORTED' as const, checkedAt, evidence: [`${found.source}: ${found.binaryPath}`], reason: null }
      : { verdict: 'UNKNOWN' as const, checkedAt, evidence: found.checkedPaths, reason: found.reason };
    const pending = unknown(checkedAt, '结构化传输尚未接入；安装存在不能证明该能力');
    return {
      vendor: this.vendor,
      installed,
      versionSupported: pending,
      transport: pending,
      credentialConfigured: pending,
      authenticated: pending,
      createSession: pending,
      readStoredHistory: pending,
      attachLive: unknown(checkedAt, '新建引擎会话与既有 Desktop live attach 是独立能力'),
      interrupt: pending,
      readOnlyReviewIsolation: pending,
      version: null,
      source: found.source,
    };
  }

  async start(): Promise<ManagedEngineSession> {
    throw new Error(`${this.vendor} 结构化传输尚未接入`);
  }
}
