import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_ROOT_ENV, defaultDataRoot, isIsolatedDataRoot, resolveDataRoot } from './dataRoot';

/**
 * 隔离开关的合同。
 *
 * 它看起来只有三行，但这三行决定了"自检会不会写你的真实数据目录"。
 * 所以这里断言的是**替换语义**：设了就完全换掉，不与默认根做任何拼接或合并 ——
 * 一个把 override 当作前缀或子目录来用的实现，会让隔离在某些路径上悄悄失效。
 */
describe('受管数据根解析', () => {
  const isolated = { [DATA_ROOT_ENV]: '/tmp/repopilot-isolated' } as NodeJS.ProcessEnv;

  it('未设置时使用默认根', () => {
    expect(resolveDataRoot({})).toBe(join(homedir(), 'Library', 'Application Support', 'RepoPilotPrototype'));
    expect(resolveDataRoot({})).toBe(defaultDataRoot());
    expect(isIsolatedDataRoot({})).toBe(false);
  });

  it('设置后完全替换默认根，不做拼接', () => {
    expect(resolveDataRoot(isolated)).toBe('/tmp/repopilot-isolated');
    expect(resolveDataRoot(isolated).startsWith(homedir())).toBe(false);
    expect(isIsolatedDataRoot(isolated)).toBe(true);
  });

  it('空串与纯空白视为未设置 —— 半个隔离比没有隔离更危险', () => {
    expect(resolveDataRoot({ [DATA_ROOT_ENV]: '' })).toBe(defaultDataRoot());
    expect(resolveDataRoot({ [DATA_ROOT_ENV]: '   ' })).toBe(defaultDataRoot());
    expect(isIsolatedDataRoot({ [DATA_ROOT_ENV]: '' })).toBe(false);
  });

  it('指向默认根本身不算隔离', () => {
    expect(isIsolatedDataRoot({ [DATA_ROOT_ENV]: defaultDataRoot() })).toBe(false);
  });
});
