import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngineCandidates, discoverEngineBinary } from './desktopProbe';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('official engine discovery', () => {
  it('finds Codex in the actual ChatGPT bundle without treating absence as protocol unsupported', () => {
    root = mkdtempSync(join(tmpdir(), 'repopilot-engine-discovery-'));
    const binary = join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, 'fixture');
    chmodSync(binary, 0o755);
    const candidates = defaultEngineCandidates({ applicationsDir: root, claudeAppSupport: join(root, 'none'), pathEntries: [] });
    expect(discoverEngineBinary('CODEX', candidates)).toMatchObject({
      binaryPath: binary,
      source: 'APP_BUNDLE',
      reason: null,
    });
  });

  it('reports bounded omissions and NOT_FOUND instead of claiming an unsupported protocol', () => {
    const result = discoverEngineBinary(
      'CLAUDE',
      Array.from({ length: 4 }, (_, i) => ({ vendor: 'CLAUDE' as const, path: `/missing/${i}`, source: 'PATH' as const })),
      2,
    );
    expect(result).toMatchObject({
      binaryPath: null,
      source: 'NOT_FOUND',
      omittedCandidates: 2,
    });
    expect(result.reason).toContain('另有 2 个未检查');
  });
});
