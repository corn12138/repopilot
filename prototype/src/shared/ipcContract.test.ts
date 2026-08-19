import { describe, expect, it } from 'vitest';
import {
  ALLOWED_METHODS,
  IPC_CONTRACT,
  PAYLOAD_LIMITS,
  inspectPayloadShape,
  isRequestMethod,
  methodTimeoutMs,
  validateRequestPayload,
} from './ipcContract';

/**
 * 逐方法运行时合同的负向断言。
 *
 * 正向路径（合法 payload 通过）只有一条，错法有无数条 —— 所以主体是负向：
 * malformed、null、错类型、未知字段、超深嵌套、循环引用、超量。
 */

function reject(method: Parameters<typeof validateRequestPayload>[0], payload: unknown): string {
  const result = validateRequestPayload(method, payload);
  if (result.ok) throw new Error(`期望被拒绝，但通过了：${JSON.stringify(payload)}`);
  return `${result.message} | ${result.detail}`;
}

describe('IPC 合同表', () => {
  it('白名单来自合同表本身，不存在第二份手工维护的清单', () => {
    expect(ALLOWED_METHODS.size).toBe(Object.keys(IPC_CONTRACT).length);
    expect(isRequestMethod('files.read')).toBe(true);
    expect(isRequestMethod('run.deleteEverything')).toBe(false);
    expect(isRequestMethod('__project.register')).toBe(false);
    expect(isRequestMethod(null)).toBe(false);
    expect(isRequestMethod(42)).toBe(false);
  });

  it('每个方法都有正的超时上限 —— 没有"永远等下去"的方法', () => {
    for (const method of ALLOWED_METHODS) {
      const ms = methodTimeoutMs(method as never);
      expect(ms, method).toBeGreaterThan(0);
      expect(Number.isFinite(ms), method).toBe(true);
    }
  });

  it('Renderer 拿不到 Main 内部方法的合同', () => {
    for (const internal of ['__project.register', '__patch.content', '__patch.applyToRepo', '__credentials.sync']) {
      expect(ALLOWED_METHODS.has(internal)).toBe(false);
    }
  });
});

describe('结构体检', () => {
  it('拒绝 null、数组与标量作为请求体', () => {
    expect(inspectPayloadShape(null).ok).toBe(false);
    expect(inspectPayloadShape([]).ok).toBe(false);
    expect(inspectPayloadShape('runId=1').ok).toBe(false);
    expect(inspectPayloadShape(7).ok).toBe(false);
  });

  it('拒绝超过深度上限的嵌套，且校验器自己不会栈溢出', () => {
    // 远超上限，也远超一般递归校验器的舒适区。
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20_000; i += 1) deep = { next: deep };

    const result = inspectPayloadShape(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('嵌套过深');
  });

  it('拒绝循环引用，而不是让 JSON.stringify 抛出未捕获异常', () => {
    const cyclic: Record<string, unknown> = { runId: 'run-1' };
    cyclic.self = cyclic;
    const result = inspectPayloadShape(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('循环引用');
  });

  it('拒绝节点数超量的宽而浅结构', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < PAYLOAD_LIMITS.maxNodes + 10; i += 1) wide[`k${i}`] = i;
    const result = inspectPayloadShape(wide);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/节点数超出上限|请求体过大/);
  });

  it('拒绝函数等不可序列化的值', () => {
    expect(inspectPayloadShape({ runId: () => 'x' }).ok).toBe(false);
  });
});

describe('逐字段校验', () => {
  it('接受合法 payload', () => {
    expect(validateRequestPayload('files.read', {
      snapshotId: 'snap-1',
      path: 'src/app.ts',
      runId: 'run-1',
      expectedGeneration: 3,
    }).ok).toBe(true);
    expect(validateRequestPayload('files.read', {
      snapshotId: 'snap-1',
      path: 'src/app.ts',
      expectedGeneration: null,
    }).ok).toBe(true);
    expect(validateRequestPayload('run.list', {}).ok).toBe(true);
    // 缺失 = 零字段方法的正常形态。
    expect(validateRequestPayload('run.list', undefined).ok).toBe(true);
  });

  it('显式 null 的 payload 被拒绝，即使方法本身不要字段', () => {
    // 合并 undefined 与 null（`rawPayload ?? {}`）会让畸形信封在零字段方法上悄悄通过。
    expect(reject('run.list', null)).toContain('请求体必须是对象');
    expect(reject('doctor.run', null)).toContain('请求体必须是对象');
  });

  it('缺字段、错类型、null 都被区分开地拒绝', () => {
    expect(reject('files.read', { path: 'a', expectedGeneration: null })).toContain('缺少必填字段');
    expect(reject('files.read', { snapshotId: 5, path: 'a', expectedGeneration: null })).toContain('类型错误');
    expect(reject('files.read', { snapshotId: null, path: 'a', expectedGeneration: null })).toContain('类型错误');
    expect(reject('files.read', { snapshotId: 's', path: 'a' })).toContain('缺少必填字段');
    // nullable ≠ optional：明确的 null 合法，缺失不合法。
    expect(reject('run.events', { runId: 'r', afterSeq: null })).toContain('不允许为 null');
  });

  it('整数字段拒绝小数、NaN、Infinity 与越界值', () => {
    expect(reject('run.events', { runId: 'r', afterSeq: 1.5 })).toContain('安全整数');
    expect(reject('run.events', { runId: 'r', afterSeq: Number.NaN })).toContain('安全整数');
    expect(reject('run.events', { runId: 'r', afterSeq: Number.POSITIVE_INFINITY })).toContain('安全整数');
    expect(reject('run.events', { runId: 'r', afterSeq: -1 })).toContain('小于下限');
    expect(reject('files.read', { snapshotId: 's', path: 'p', expectedGeneration: -1 })).toContain('小于下限');
    expect(reject('retention.update', { evidenceDays: 99_999 })).toContain('大于上限');
  });

  it('枚举字段只接受合同内取值', () => {
    expect(validateRequestPayload('approval.decide', {
      approvalId: 'a',
      decision: 'APPROVE',
      subjectDigest: 'sha256:x',
      note: '',
    }).ok).toBe(true);
    expect(reject('approval.decide', {
      approvalId: 'a',
      decision: 'approve',
      subjectDigest: 'sha256:x',
      note: '',
    })).toContain('不在允许取值内');
    expect(reject('patch.export', { runId: 'r', patchId: 'p', mode: 'DELETE_REPO' })).toContain(
      '不在允许取值内',
    );
  });

  it('未知字段一律拒绝，不静默忽略', () => {
    expect(reject('run.get', { runId: 'r', hostPath: '/Users/me/secret' })).toContain('不在合同内');
    expect(reject('run.list', { runId: 'r' })).toContain('不在合同内');
    expect(
      reject('task.create', {
        projectId: 'p',
        snapshotId: 's',
        profileId: 'pr',
        modelProfileId: 'm',
        goal: 'fix',
        taskClass: '',
        allowedPaths: [],
        acceptance: [],
        verificationCommandIds: [],
        __proto__hack: 1,
      }),
    ).toContain('不在合同内');
  });

  it('空字符串标识被拒绝，但语义上允许为空的字段可以为空', () => {
    expect(reject('run.get', { runId: '   ' })).toContain('不能为空');
    // note / reason / taskClass / apiKey 允许为空 —— 空是它们的正常取值。
    expect(validateRequestPayload('run.cancel', { runId: 'r', reason: '' }).ok).toBe(true);
    expect(validateRequestPayload('model.setKey', { profileId: 'p', apiKey: '' }).ok).toBe(true);
  });

  it('字符串数组逐元素校验，并限制元素个数与长度', () => {
    expect(reject('task.create', {
      projectId: 'p',
      snapshotId: 's',
      profileId: 'pr',
      modelProfileId: 'm',
      goal: 'fix',
      taskClass: '',
      allowedPaths: ['src/**', 42],
      acceptance: [],
      verificationCommandIds: [],
    })).toContain('allowedPaths[1]');
    expect(reject('task.create', {
      projectId: 'p',
      snapshotId: 's',
      profileId: 'pr',
      modelProfileId: 'm',
      goal: 'fix',
      taskClass: '',
      allowedPaths: Array.from({ length: 501 }, () => 'src/**'),
      acceptance: [],
      verificationCommandIds: [],
    })).toContain('元素过多');
    expect(reject('task.create', {
      projectId: 'p',
      snapshotId: 's',
      profileId: 'pr',
      modelProfileId: 'm',
      goal: 'fix',
      taskClass: '',
      allowedPaths: 'src/**',
      acceptance: [],
      verificationCommandIds: [],
    })).toContain('期望数组');
  });

  it('嵌套对象数组按自己的字段合同校验', () => {
    const base = {
      projectId: 'p',
      snapshotId: 's',
      profileId: 'pr',
      modelProfileId: 'm',
      goal: 'fix',
      taskClass: '',
      allowedPaths: [],
      acceptance: [],
      verificationCommandIds: ['user1'],
    };
    expect(validateRequestPayload('task.create', {
      ...base,
      customCommands: [{ label: 'build', argv: ['pnpm', 'build'] }],
    }).ok).toBe(true);
    expect(reject('task.create', { ...base, customCommands: [{ label: 'build' }] })).toContain(
      'customCommands[0].argv',
    );
    expect(reject('task.create', { ...base, customCommands: [{ label: 'b', argv: ['x'], cwd: '/' }] })).toContain(
      '不在合同内',
    );
    expect(reject('task.create', { ...base, customCommands: ['pnpm build'] })).toContain('期望对象');
  });

  it('过长字符串被拒绝而不是被截断', () => {
    const detail = reject('files.read', {
      snapshotId: 's',
      path: 'x'.repeat(4_001),
      expectedGeneration: null,
    });
    expect(detail).toContain('过长');
  });
});
