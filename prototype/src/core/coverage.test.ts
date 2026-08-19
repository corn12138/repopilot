import { describe, expect, it } from 'vitest';
import type { CommandDefinition } from '@shared/domain';
import {
  classifyVerificationInputs,
  describeCoverageWeakening,
  verificationInputsFromCommands,
} from './coverage';

/**
 * 验证输入的判定。两条原则：
 *   - 模式要覆盖"能让验证变绿"的那些文件（配置 / 测试 / setup），但不把普通源码误判进去；
 *   - 命令点名的文件只认真实存在的相对路径，`pnpm build` 推不出任何东西。
 */

describe('classifyVerificationInputs：按模式', () => {
  it('配置类：tsconfig / vite / vitest / eslint / babel，根目录与子包都算', () => {
    const got = classifyVerificationInputs([
      'tsconfig.json',
      'tsconfig.node.json',
      'vite.config.ts',
      'packages/web/vitest.config.mts',
      'eslint.config.js',
      '.eslintrc.cjs',
      'babel.config.js',
      'src/app.ts',
    ]);
    expect(got.map((t) => t.path)).toEqual([
      '.eslintrc.cjs',
      'babel.config.js',
      'eslint.config.js',
      'packages/web/vitest.config.mts',
      'tsconfig.json',
      'tsconfig.node.json',
      'vite.config.ts',
    ]);
    expect(got.find((t) => t.path === 'tsconfig.node.json')!.matchedBy).toBe('**/tsconfig*.json');
  });

  it('测试类：*.test.* / *.spec.* / __tests__ / __mocks__ / __snapshots__ / test(s)/ / setup', () => {
    const got = classifyVerificationInputs([
      'src/a.test.ts',
      'src/b.spec.tsx',
      'src/__tests__/c.ts',
      'src/__mocks__/fs.ts',
      'src/__snapshots__/x.snap',
      'test/helpers.ts',
      'tests/e2e/run.ts',
      'src/setupTests.ts',
      'vitest.setup.ts',
      'src/components/Button.tsx',
      'src/testing-utils.ts', // 不是 test/ 目录也不是 .test.，不该误判
    ]);
    expect(got.map((t) => t.path)).toEqual([
      'src/__mocks__/fs.ts',
      'src/__snapshots__/x.snap',
      'src/__tests__/c.ts',
      'src/a.test.ts',
      'src/b.spec.tsx',
      'src/setupTests.ts',
      'test/helpers.ts',
      'tests/e2e/run.ts',
      'vitest.setup.ts',
    ]);
  });

  it('普通源码一个都不报；空输入返回空', () => {
    expect(classifyVerificationInputs(['src/app.ts', 'src/util/x.ts', 'README.md', 'package-lock.json'])).toEqual([]);
    expect(classifyVerificationInputs([])).toEqual([]);
  });

  it('命令点名的路径：只有真的出现在改动里才报，且不与模式重复报', () => {
    const got = classifyVerificationInputs(
      ['check.mjs', 'src/a.test.ts', 'src/app.ts'],
      [
        { path: 'check.mjs', commandId: 'user1' },
        { path: 'src/a.test.ts', commandId: 'test' },
        { path: 'scripts/not-changed.mjs', commandId: 'user1' },
      ],
    );
    expect(got).toEqual([
      { path: 'check.mjs', matchedBy: 'command:user1' },
      { path: 'src/a.test.ts', matchedBy: '**/*.test.*' },
    ]);
  });
});

describe('verificationInputsFromCommands', () => {
  const cmd = (commandId: string, argv: string[], cwdRelative = ''): CommandDefinition => ({
    commandId,
    label: commandId,
    argv,
    cwdRelative,
    timeoutMs: 1000,
    risk: 'R1',
    source: 'DETECTED',
  });
  const exists = (p: string) => ['check.mjs', 'src/a.test.ts', 'packages/web/verify.js'].includes(p);

  it('`pnpm build` 推不出任何文件；`node check.mjs` 推出 check.mjs', () => {
    expect(verificationInputsFromCommands([cmd('build', ['pnpm', 'build'])], exists)).toEqual([]);
    expect(verificationInputsFromCommands([cmd('user1', ['node', 'check.mjs'])], exists)).toEqual([
      { path: 'check.mjs', commandId: 'user1' },
    ]);
  });

  it('flag、绝对路径、`..`、不存在的 token 都不算；cwdRelative 会拼到路径前', () => {
    expect(
      verificationInputsFromCommands(
        [cmd('x', ['vitest', 'run', '--reporter', 'dot', '/abs/file', '../escape', 'nope.ts', 'src/a.test.ts'])],
        exists,
      ),
    ).toEqual([{ path: 'src/a.test.ts', commandId: 'x' }]);
    expect(verificationInputsFromCommands([cmd('w', ['node', 'verify.js'], 'packages/web')], exists)).toEqual([
      { path: 'packages/web/verify.js', commandId: 'w' },
    ]);
  });
});

describe('describeCoverageWeakening', () => {
  it('点名路径、说明后果（ACCEPTED_UNVERIFIED），超过 5 个只报数', () => {
    const one = describeCoverageWeakening([{ path: 'vitest.config.ts', matchedBy: '**/vitest.config.*' }]);
    expect(one).toContain('COVERAGE_WEAKENED');
    expect(one).toContain('vitest.config.ts');
    expect(one).toContain('ACCEPTED_UNVERIFIED');
    const many = describeCoverageWeakening(
      Array.from({ length: 7 }, (_, i) => ({ path: `t${i}.test.ts`, matchedBy: '**/*.test.*' })),
    );
    expect(many).toContain('等 7 个');
    expect(many).not.toContain('t6.test.ts');
  });
});
