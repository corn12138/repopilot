import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { classifyEnvelope } from './envelope';

/**
 * 信封准入的负向断言。
 *
 * 这一层是 Renderer → Main 的第一道门，也是此前唯一没有测试的一层：
 * `ipcContract.ts` 有测试不等于**接线**有测试。漏调一次校验、或者把代次判定写松一点，
 * 合同测试照样全绿，而门实际上是开的。
 */

const EPOCH = 7;

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'r_1',
    method: 'run.get',
    payload: { runId: 'run-1' },
    epoch: EPOCH,
    ...overrides,
  };
}

function rejection(raw: unknown, epoch = EPOCH) {
  const decision = classifyEnvelope(raw, epoch);
  if (decision.kind !== 'reject') throw new Error('期望被拒绝，但通过了');
  return decision.error;
}

describe('信封准入', () => {
  it('合法信封通过并交出已校验的 payload', () => {
    const decision = classifyEnvelope(envelope(), EPOCH);
    expect(decision.kind).toBe('accept');
    if (decision.kind !== 'accept') return;
    expect(decision.method).toBe('run.get');
    expect(decision.payload).toEqual({ runId: 'run-1' });
  });

  it('非对象信封被拒绝，不会在解构时炸掉', () => {
    for (const raw of [null, undefined, 'run.get', 42, [], true]) {
      expect(rejection(raw).code).toBe('BAD_REQUEST');
    }
    expect(rejection(null).detail).toContain('null');
    expect(rejection([]).detail).toContain('array');
  });

  it('协议版本不匹配一律拒绝，不做向下兼容', () => {
    expect(rejection(envelope({ protocolVersion: '0.3.0' })).message).toBe('协议版本不匹配');
    expect(rejection(envelope({ protocolVersion: undefined })).code).toBe('BAD_REQUEST');
    expect(rejection(envelope({ protocolVersion: 4 })).code).toBe('BAD_REQUEST');
  });

  it('白名单外的方法被拒绝，包括 Main 的内部方法', () => {
    for (const method of [
      'run.deleteEverything',
      '__project.register',
      '__patch.applyToRepo',
      '__credentials.sync',
      '',
      null,
      42,
    ]) {
      expect(rejection(envelope({ method })).code, String(method)).toBe('POLICY_DENIED');
    }
  });

  // ---- 代次 ----

  it('代次不匹配时拒绝，并与 CORE_UNAVAILABLE 区分开', () => {
    const error = rejection(envelope({ epoch: EPOCH - 1 }));
    expect(error.code).toBe('CORE_EPOCH_MISMATCH');
    expect(error.detail).toContain(`当前代次 ${EPOCH}`);
    expect(error.detail).toContain(`请求代次 ${EPOCH - 1}`);
  });

  it('缺少代次等同于代次不匹配 —— 旧端不得被当成"恰好是当前这一代"', () => {
    expect(rejection(envelope({ epoch: undefined })).code).toBe('CORE_EPOCH_MISMATCH');
    expect(rejection(envelope({ epoch: null })).code).toBe('CORE_EPOCH_MISMATCH');
    expect(rejection(envelope({ epoch: '7' })).code).toBe('CORE_EPOCH_MISMATCH');
    // 数字型强转的经典漏洞：'7' 与 7 必须不同，NaN 也不能与自己相等地混过去。
    expect(rejection(envelope({ epoch: Number.NaN })).code).toBe('CORE_EPOCH_MISMATCH');
  });

  it('只有 core.getStatus 豁免代次 —— 它是获取代次的方法本身', () => {
    const decision = classifyEnvelope(
      envelope({ method: 'core.getStatus', payload: {}, epoch: undefined }),
      EPOCH,
    );
    expect(decision.kind).toBe('accept');

    // 其余方法即使 payload 完全合法也过不去。
    expect(rejection(envelope({ method: 'run.list', payload: {}, epoch: undefined })).code).toBe(
      'CORE_EPOCH_MISMATCH',
    );
    expect(
      rejection(envelope({ method: 'patch.export', payload: { runId: 'r', patchId: 'p', mode: 'COPY' }, epoch: undefined }))
        .code,
    ).toBe('CORE_EPOCH_MISMATCH');
  });

  it('代次判定排在 payload 校验之前：代次不对时不泄漏字段级细节', () => {
    const error = rejection(envelope({ epoch: 0, payload: { nope: 1 } }));
    expect(error.code).toBe('CORE_EPOCH_MISMATCH');
    expect(error.detail).not.toContain('nope');
  });

  // ---- payload 合同确实被接上了 ----

  it('payload 校验真的被调用了，而不是只存在于合同模块里', () => {
    expect(rejection(envelope({ payload: {} })).message).toContain('缺少必填字段');
    expect(rejection(envelope({ payload: null })).message).toContain('请求体必须是对象');
    expect(rejection(envelope({ payload: { runId: 'r', hostPath: '/Users/me' } })).message).toContain(
      '不在合同内',
    );
    expect(rejection(envelope({ payload: { runId: 5 } })).message).toContain('类型错误');
  });

  it('错误消息带上方法名，便于定位是哪一个调用被拒', () => {
    expect(rejection(envelope({ payload: {} })).message).toContain('run.get:');
  });

  it('超深嵌套 payload 在这一层就被挡住，不会到达 Core', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20_000; i += 1) deep = { next: deep };
    const error = rejection(envelope({ method: 'run.get', payload: deep }));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain('嵌套过深');
  });

  it('带环的 payload 被拒绝，而不是让判定自己抛异常', () => {
    const cyclic: Record<string, unknown> = { runId: 'run-1' };
    cyclic.self = cyclic;
    expect(rejection(envelope({ payload: cyclic })).message).toContain('循环引用');
  });

  it('代次为 0 是合法代次，不能被当成"没提供"', () => {
    const decision = classifyEnvelope(envelope({ epoch: 0 }), 0);
    expect(decision.kind).toBe('accept');
    // 而 Core 已经重启过一次时，同一个 0 必须被拒。
    expect(rejection(envelope({ epoch: 0 }), 1).code).toBe('CORE_EPOCH_MISMATCH');
  });
});
