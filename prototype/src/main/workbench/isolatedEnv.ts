import { tmpdir } from 'node:os';

export function workbenchEngineEnv(input: {
  source?: NodeJS.ProcessEnv;
  home: string;
  credential?: { readonly name: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'; readonly value: string };
}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env;
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot'] as const) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.HOME = input.home;
  env.CODEX_HOME = input.home;
  env.TMPDIR = tmpdir();
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  if (input.credential?.value.trim()) env[input.credential.name] = input.credential.value.trim();
  return env;
}
