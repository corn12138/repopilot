import { describe, expect, it } from 'vitest';
import {
  classifyUserCommand,
  commandArgvDigest,
  isApprovableCause,
  userCommandAdmission,
} from './commandRisk';

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
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.message).toContain('（R2）');
      // 说清"为什么"而不是"不支持"：装依赖会写进宿主真实的依赖树
      expect(r2.message).toContain('node_modules');
      // 而且它**不可批准** —— 界面不该给它一个"我了解风险"的复选框
      expect(r2.approvable).toBe(false);
    }
  });
});

describe('可批准的只有"未知二进制"这一档（Slice K）', () => {
  it('未知可执行名 → R2 + UNKNOWN_BINARY + approvable，消息是"需要你逐条批准"而不是"拒绝登记"', () => {
    const v = classifyUserCommand(['bash', 'scripts/test.sh']);
    expect(v.risk).toBe('R2');
    expect(v.cause).toBe('UNKNOWN_BINARY');
    expect(isApprovableCause(v)).toBe(true);

    const admission = userCommandAdmission(['bash', 'scripts/test.sh']);
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.approvable).toBe(true);
      expect(admission.message).toContain('逐条批准');
    }
  });

  it('联网/装依赖/容器、未知 git 子命令、R3、R4 一律不可批准', () => {
    const cases: ReadonlyArray<readonly [string[], string]> = [
      [['pnpm', 'install'], 'NETWORK_OR_DEPS'],
      [['curl', 'https://example.com'], 'NETWORK_OR_DEPS'],
      [['docker', 'compose', 'up'], 'NETWORK_OR_DEPS'],
      [['git', 'bisect', 'start'], 'GIT_UNKNOWN'],
      [['rm', '-rf', 'dist'], 'DESTRUCTIVE'],
      [['sudo', 'make', 'install'], 'PRIVILEGED'],
      [['npm', 'publish'], 'PUBLISH'],
      [['git', 'push'], 'GIT_WRITE'],
    ];
    for (const [argv, cause] of cases) {
      const v = classifyUserCommand(argv);
      expect(v.cause, argv.join(' ')).toBe(cause);
      expect(isApprovableCause(v), argv.join(' ')).toBe(false);
      const admission = userCommandAdmission(argv);
      expect(admission.ok, argv.join(' ')).toBe(false);
      if (!admission.ok) expect(admission.approvable, argv.join(' ')).toBe(false);
    }
  });

  it('批准绑整条 argv：多一个参数就是另一条命令，digest 不同 → 仍然拒绝', () => {
    const approved = new Set([commandArgvDigest(['bash', 'scripts/test.sh'])]);
    expect(userCommandAdmission(['bash', 'scripts/test.sh'], approved).ok).toBe(true);
    // 加参数
    expect(userCommandAdmission(['bash', 'scripts/test.sh', '-u'], approved).ok).toBe(false);
    // 换可执行名
    expect(userCommandAdmission(['zsh', 'scripts/test.sh'], approved).ok).toBe(false);
    // 同一批准不会顺带放行另一条未知命令
    expect(userCommandAdmission(['bazel', 'test', '//...'], approved).ok).toBe(false);
  });

  it('批准过的 R2 通过登记时 viaApproval=true，风险等级仍然如实是 R2 —— 不被"洗白"成 R1', () => {
    const approved = new Set([commandArgvDigest(['just', 'ci'])]);
    const admission = userCommandAdmission(['just', 'ci'], approved);
    expect(admission.ok).toBe(true);
    if (admission.ok) {
      expect(admission.viaApproval).toBe(true);
      expect(admission.verdict.risk).toBe('R2');
    }
  });

  it('批准不能把 R3/R4 变成可登记：即使 digest 在集合里也照拒', () => {
    const approved = new Set([
      commandArgvDigest(['rm', '-rf', 'dist']),
      commandArgvDigest(['git', 'push']),
      commandArgvDigest(['pnpm', 'install']),
    ]);
    expect(userCommandAdmission(['rm', '-rf', 'dist'], approved).ok).toBe(false);
    expect(userCommandAdmission(['git', 'push'], approved).ok).toBe(false);
    expect(userCommandAdmission(['pnpm', 'install'], approved).ok).toBe(false);
  });

  it('argv digest 区分 ["a b"] 与 ["a","b"]：用空格 join 会把它们混成同一条命令', () => {
    expect(commandArgvDigest(['a b'])).not.toBe(commandArgvDigest(['a', 'b']));
  });
});
