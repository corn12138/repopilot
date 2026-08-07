import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';

/**
 * Provider API Key 的本地保管。
 *
 * 与参考 CLI 的关键差别：
 *   `temp/neovate-code/src/slash-commands/builtin/login.tsx:342-351` 把 key 明文
 *   写进全局 JSON 配置（`config.set` → `provider.<id>.options.apiKey`）。
 *   那份工程审计里这条被明确 Reject。
 *
 * 这里改成 Electron `safeStorage` 加密后落盘 —— 加密密钥由 macOS Keychain 托管，
 * 密文文件即使被读走也无法直接使用。Renderer 全程只看到来源和末四位，
 * 完整值只在 Main 解密后经私有 IPC 注入 Core 内存。
 *
 * 残余风险（原型阶段明确接受）：同一用户下的其他进程可以调用同一个 Keychain 条目解密。
 * 真正的隔离需要独立 Keychain item + ACL，属于发行阶段的工作。
 */

const FILE = join(
  homedir(),
  'Library',
  'Application Support',
  'RepoPilotPrototype',
  'credentials.bin',
);

type Store = Record<string, string>;

function load(): Store {
  if (!existsSync(FILE)) return {};
  try {
    const blob = readFileSync(FILE);
    if (blob.byteLength === 0) return {};
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(blob)) as Store;
  } catch {
    // 解密失败（换机器 / Keychain 被清）不是崩溃理由，当作没有凭据
    return {};
  }
}

function persist(store: Store): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function isAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function getAll(): Store {
  return load();
}

export function setKey(providerId: string, apiKey: string): void {
  const store = load();
  const trimmed = apiKey.trim();
  if (trimmed) store[providerId] = trimmed;
  else delete store[providerId];
  persist(store);
}

export function removeKey(providerId: string): void {
  const store = load();
  delete store[providerId];
  persist(store);
}
