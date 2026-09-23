import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from './codexAdapter';
import { ClaudeAgentSdkAdapter } from './claudeAdapter';

describe.skipIf(process.env.REPOPILOT_PROBE_WORKBENCH !== '1')('Codex App Server read-only probe', () => {
  it('initializes and creates an ephemeral read-only thread without sending a model turn', async () => {
    const capability = await new CodexAppServerAdapter().probe();
    console.log(JSON.stringify(capability, null, 2));
    expect(['SUPPORTED', 'UNKNOWN']).toContain(capability.installed.verdict);
    expect(['SUPPORTED', 'UNKNOWN']).toContain(capability.transport.verdict);
    expect(['SUPPORTED', 'UNKNOWN']).toContain(capability.createSession.verdict);
    expect(capability.authenticated.verdict).toBe('UNKNOWN');
    expect(capability.attachLive.verdict).toBe('UNKNOWN');
  }, 30_000);

  it('reports Claude binary/version and pinned SDK without sending a model turn', async () => {
    const capability = await new ClaudeAgentSdkAdapter().probe();
    console.log(JSON.stringify(capability, null, 2));
    expect(['SUPPORTED', 'UNKNOWN']).toContain(capability.installed.verdict);
    expect(capability.authenticated.verdict).toBe('UNKNOWN');
    expect(capability.attachLive.verdict).toBe('UNKNOWN');
  }, 30_000);
});
