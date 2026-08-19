import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT_ENV } from '@shared/dataRoot';

/**
 * 凭据文件必须跟着**当前**受管数据根走。
 *
 * 这条测试对应一个真实发生过、且只被自检的收尾残留检查抓到的 bug：
 * `credentials.ts` 曾经在模块加载时算好路径（`const FILE = join(resolveDataRoot(), …)`）。
 * Main 的模块在 `app.whenReady()` 之前就加载完了，而隔离根是在 whenReady 里、
 * fork Core 之前才设置的 —— 于是 Core 用了隔离根，Main 自己还指着真实目录，
 * "隔离的自检"照旧读写用户真实的 credentials.bin。
 *
 * 断言的是**调用时解析**这一条语义，所以每个用例都在两个根之间来回切。
 */

// safeStorage 需要真实 Electron 运行时；这里只要求它可逆，不要求它真加密。
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (blob: Buffer) => blob.toString('utf8').replace(/^enc:/, ''),
  },
}));

const roots: string[] = [];
let savedEnv: string | undefined;

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'repopilot-cred-test-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  savedEnv = process.env[DATA_ROOT_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[DATA_ROOT_ENV];
  else process.env[DATA_ROOT_ENV] = savedEnv;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
  vi.resetModules();
});

describe('凭据存储跟随受管数据根', () => {
  it('路径在每次调用时解析，而不是在模块加载时冻结', async () => {
    const first = newRoot();
    process.env[DATA_ROOT_ENV] = first;
    const credentials = await import('./credentials');
    expect(credentials.storagePath()).toBe(join(first, 'credentials.bin'));

    // 模块已经加载过了 —— 换根之后它必须立刻跟上，这正是当初出错的地方。
    const second = newRoot();
    process.env[DATA_ROOT_ENV] = second;
    expect(credentials.storagePath()).toBe(join(second, 'credentials.bin'));
  });

  it('写入落在切换后的根里，且不碰切换前的根', async () => {
    const original = newRoot();
    process.env[DATA_ROOT_ENV] = original;
    const credentials = await import('./credentials');
    credentials.setKey('anthropic', 'sk-real-user-key');
    expect(existsSync(join(original, 'credentials.bin'))).toBe(true);

    const isolated = newRoot();
    process.env[DATA_ROOT_ENV] = isolated;
    credentials.setKey('anthropic', 'sk-selftest-key');

    expect(existsSync(join(isolated, 'credentials.bin'))).toBe(true);
    // 隔离期间读到的是隔离根里的值，真实根的那份不受影响。
    expect(credentials.getAll().anthropic).toBe('sk-selftest-key');

    process.env[DATA_ROOT_ENV] = original;
    expect(credentials.getAll().anthropic).toBe('sk-real-user-key');
  });

  it('删除同样只作用于当前根', async () => {
    const original = newRoot();
    process.env[DATA_ROOT_ENV] = original;
    const credentials = await import('./credentials');
    credentials.setKey('anthropic', 'sk-real-user-key');

    const isolated = newRoot();
    process.env[DATA_ROOT_ENV] = isolated;
    credentials.setKey('anthropic', 'sk-selftest-key');
    credentials.removeKey('anthropic');
    expect(credentials.getAll().anthropic).toBeUndefined();

    process.env[DATA_ROOT_ENV] = original;
    expect(credentials.getAll().anthropic).toBe('sk-real-user-key');
  });

  it('根不存在时读取返回空，不抛异常', async () => {
    process.env[DATA_ROOT_ENV] = join(tmpdir(), 'repopilot-cred-test-missing-root');
    const credentials = await import('./credentials');
    expect(credentials.getAll()).toEqual({});
  });
});

/**
 * "没配过" 与 "配过但读不出来" 必须分开，而且后者绝不能被写入覆盖。
 *
 * 旧实现里 `load()` 对解密/解析失败一律返回 `{}`，于是：
 *   - 界面显示成"还没有任何连接"，而用户其实配过一堆 key；
 *   - 更糟的是保存一把新 key 会写回 `{ 新key }`，把那份仍在磁盘上的密文整个覆盖掉，
 *     其余所有 provider 的凭据在一次"保存"里被永久删除，全程没有任何提示。
 */
describe('凭据存储的三态与写入保护', () => {
  it('文件不存在是 ABSENT，不是 UNREADABLE', async () => {
    process.env[DATA_ROOT_ENV] = newRoot();
    const credentials = await import('./credentials');
    expect(credentials.state()).toBe('ABSENT');
    expect(credentials.stateDetail()).toBeNull();
  });

  it('写入过后是 OK', async () => {
    process.env[DATA_ROOT_ENV] = newRoot();
    const credentials = await import('./credentials');
    credentials.setKey('anthropic', 'sk-a');
    expect(credentials.state()).toBe('OK');
  });

  it('文件损坏是 UNREADABLE，且带上原因 —— 不伪装成"没配过"', async () => {
    const root = newRoot();
    process.env[DATA_ROOT_ENV] = root;
    const credentials = await import('./credentials');
    credentials.setKey('anthropic', 'sk-real');
    writeFileSync(join(root, 'credentials.bin'), 'enc:{ not json at all', { mode: 0o600 });

    expect(credentials.state()).toBe('UNREADABLE');
    expect(credentials.stateDetail()).toContain('无法解密或解析');
    // 负向断言：绝不能表现成 ABSENT。
    expect(credentials.state()).not.toBe('ABSENT');
  });

  it('存储读不出来时拒绝写入，磁盘字节保持不变', async () => {
    const root = newRoot();
    process.env[DATA_ROOT_ENV] = root;
    const credentials = await import('./credentials');
    const file = join(root, 'credentials.bin');

    credentials.setKey('anthropic', 'sk-anthropic');
    credentials.setKey('openai', 'sk-openai');
    writeFileSync(file, 'enc:{ corrupted', { mode: 0o600 });
    const before = readFileSync(file);

    expect(() => credentials.setKey('deepseek', 'sk-new')).toThrow(
      credentials.CredentialStoreUnreadable,
    );
    expect(() => credentials.removeKey('anthropic')).toThrow(
      credentials.CredentialStoreUnreadable,
    );

    /*
     * 这一行是整条测试的重点：旧实现会把文件重写成只含 deepseek 的 store，
     * 另外两把 key 就此消失。拒绝写入的意义就是这些字节一个都不许动。
     */
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('可读的存储照常写入，保护不会误伤正常路径', async () => {
    process.env[DATA_ROOT_ENV] = newRoot();
    const credentials = await import('./credentials');
    credentials.setKey('anthropic', 'sk-a');
    credentials.setKey('openai', 'sk-o');
    expect(credentials.getAll()).toEqual({ anthropic: 'sk-a', openai: 'sk-o' });

    credentials.removeKey('anthropic');
    expect(credentials.getAll()).toEqual({ openai: 'sk-o' });
  });
});
