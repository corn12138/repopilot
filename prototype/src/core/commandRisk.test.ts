import { describe, expect, it } from 'vitest';
import { classifyUserCommand, userCommandAdmission } from './commandRisk';

/**
 * 用户手填命令的风险分级：白名单放行、其余 fail-closed。
 * 每条断言对应 08-17 审计 D3 里点名的形态：`git push origin main`（R4）、`npm install some-pkg`（R2）、`rm -rf dist`（R3）。
 */

describe('classifyUserCommand', () => {
  it.each([
    [['node', 'check.mjs'], 'R1'],
    [['tsc', '--noEmit'], 'R1'],
    [['vitest', 'run'], 'R1'],
    [['pnpm', 'build'], 'R1'],
    [['pnpm', 'run', 'test'], 'R1'],
    [['npm', 'test'], 'R1'],
    [['yarn', 'lint'], 'R1'],
    [['/usr/local/bin/node', 'x.js'], 'R1'],
    [['git', 'status'], 'R1'],
    [['git', 'diff'], 'R1'],
  ])('R1：%j', (argv, risk) => {
    expect(classifyUserCommand(argv).risk).toBe(risk);
  });

  it.each([
    [['npm', 'install', 'some-pkg'], 'R2'],
    [['pnpm', 'add', 'lodash'], 'R2'],
    [['pnpm', 'i'], 'R2'],
    [['yarn', 'add', 'x'], 'R2'],
    [['npx', 'something'], 'R1'], // npx 视为本地入口（它可能联网，但与 node 同级；由工作区隔离兜底）
    [['curl', 'https://example.com'], 'R2'],
    [['wget', 'x'], 'R2'],
    [['docker', 'build', '.'], 'R2'],
    [['git', 'fetch'], 'R4'],
    [['unknown-binary', '--flag'], 'R2'],
    [['pnpm', 'dlx', 'x'], 'R2'],
  ])('R2/未知 fail-closed：%j → %s', (argv, risk) => {
    expect(classifyUserCommand(argv).risk).toBe(risk);
  });

  it.each([
    [['rm', '-rf', 'dist']],
    [['rmdir', 'x']],
    [['chmod', '777', 'x']],
    [['dd', 'if=/dev/zero']],
    [['mv', 'a', 'b']],
  ])('R3：%j', (argv) => {
    expect(classifyUserCommand(argv).risk).toBe('R3');
  });

  it.each([
    [['git', 'push', 'origin', 'main']],
    [['git', 'merge', 'x']],
    [['git', 'reset', '--hard']],
    [['git', 'commit', '-m', 'x']],
    [['git', 'clean', '-fd']],
    [['npm', 'publish']],
    [['pnpm', 'publish']],
    [['sudo', 'anything']],
    [['ssh', 'host']],
    [['env']],
    [['aws', 's3', 'cp']],
    [['kubectl', 'apply']],
  ])('R4：%j', (argv) => {
    expect(classifyUserCommand(argv).risk).toBe('R4');
  });

  it('空 argv 不是 R1', () => {
    expect(classifyUserCommand([]).risk).toBe('R2');
  });
});

describe('userCommandAdmission：只有 R1 能登记为验证命令', () => {
  it('R1 放行并带回 verdict', () => {
    const a = userCommandAdmission(['node', 'check.mjs']);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.verdict.risk).toBe('R1');
  });
  it('R2/R3/R4 拒绝，消息点名等级与命令、说明原因', () => {
    const r4 = userCommandAdmission(['git', 'push', 'origin', 'main']);
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.message).toContain('（R4）');
      expect(r4.message).toContain('git push origin main');
      expect(r4.message).toContain('永不允许');
    }
    const r3 = userCommandAdmission(['rm', '-rf', 'dist']);
    if (!r3.ok) expect(r3.message).toContain('（R3）');
    const r2 = userCommandAdmission(['npm', 'install', 'some-pkg']);
    if (!r2.ok) {
      expect(r2.message).toContain('（R2）');
      expect(r2.message).toContain('原型不开放');
    }
  });
});
