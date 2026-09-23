import { describe, expect, it } from 'vitest';
import { workbenchEngineEnv } from './isolatedEnv';

describe('workbenchEngineEnv', () => {
  it('只传递运行与显式认证目录，不继承宿主令牌', () => {
    const env = workbenchEngineEnv({ home: '/tmp/repopilot-engine', source: {
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      CODEX_HOME: '/Users/tester/.codex',
      GITHUB_TOKEN: 'secret-canary',
      ANTHROPIC_API_KEY: 'secret-canary',
      AWS_SECRET_ACCESS_KEY: 'secret-canary',
    } });

    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/repopilot-engine', CODEX_HOME: '/tmp/repopilot-engine' });
    expect(Object.values(env)).not.toContain('secret-canary');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(Object.getPrototypeOf(env)).toBeNull();
  });

  it('只注入调用方显式选择的一项工作位凭据', () => {
    const env = workbenchEngineEnv({
      home: '/tmp/repopilot-engine',
      source: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'ambient-anthropic', OPENAI_API_KEY: 'ambient-openai' },
      credential: { name: 'OPENAI_API_KEY', value: ' selected-openai ' },
    });

    expect(env.OPENAI_API_KEY).toBe('selected-openai');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(Object.values(env)).not.toContain('ambient-openai');
    expect(Object.values(env)).not.toContain('ambient-anthropic');
  });
});
