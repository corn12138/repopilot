import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import { resolveDataRoot } from '@shared/dataRoot';

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

/*
 * 跟随受管数据根，而不是再拼一次 homedir。隔离 data root 时凭据也必须跟着搬家 ——
 * 否则「隔离的自检」仍然会覆盖你真实的 API Key。
 *
 * **每次调用都重新解析，不能在模块加载时算一次。** Main 的模块在 `app.whenReady()`
 * 之前就全部加载完了，而隔离根是在 whenReady 里、fork Core 之前才设置的。
 * 写成 `const FILE = ...` 的版本里，Core 正确地用了隔离根，Main 自己却还指着真实目录 ——
 * 自检因此在隔离模式下依然读写你真实的 credentials.bin。
 * 这个 bug 是被自检收尾的残留检查抓出来的，不是推理出来的。
 */
function storageFile(): string {
  return join(resolveDataRoot(), 'credentials.bin');
}

type Store = Record<string, string>;

/**
 * 凭据存储的三态。
 *
 * `ABSENT` 与 `UNREADABLE` 必须分开：前者是"你还没配过"，后者是"配过但现在读不出来"
 * （换机器、Keychain 被清、文件损坏）。以前两者都返回 `{}`，于是界面上
 * 「没有可用连接」既可能是真的没配，也可能是你的 key 全都还在、只是解不开。
 */
export type CredentialStoreState = 'ABSENT' | 'OK' | 'UNREADABLE';

export interface CredentialLoad {
  readonly state: CredentialStoreState;
  readonly store: Store;
  readonly detail: string | null;
}

function load(): CredentialLoad {
  const file = storageFile();
  if (!existsSync(file)) return { state: 'ABSENT', store: {}, detail: null };
  try {
    const blob = readFileSync(file);
    if (blob.byteLength === 0) return { state: 'ABSENT', store: {}, detail: null };
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        state: 'UNREADABLE',
        store: {},
        detail: '凭据文件存在，但系统钥匙串不可用，无法解密',
      };
    }
    return { state: 'OK', store: JSON.parse(safeStorage.decryptString(blob)) as Store, detail: null };
  } catch (err) {
    // 解密失败（换机器 / Keychain 被清）不是崩溃理由，但也不是"没有凭据"。
    return {
      state: 'UNREADABLE',
      store: {},
      detail: `凭据文件存在但无法解密或解析：${(err as Error).message}`,
    };
  }
}

/**
 * 钥匙串不可用时的显式失败。
 *
 * 之前 `persist` 会直接让 `safeStorage.encryptString` 抛一个来源不明的异常，
 * 于是隔离 HOME 下跑自检会变成一个未处理的 rejection 并把进程挂住。
 * 不可用是一种**可预期的环境状态**（CI、隔离 HOME、Keychain 被锁），
 * 它应该产生一个能被上层翻译成 SKIP/BLOCKED 的具名错误，而不是崩溃。
 */
export class CredentialStorageUnavailable extends Error {
  readonly code = 'CREDENTIAL_STORAGE_UNAVAILABLE';
  constructor() {
    super('系统钥匙串不可用，无法读写应用内凭据');
  }
}

function persist(store: Store): void {
  if (!safeStorage.isEncryptionAvailable()) throw new CredentialStorageUnavailable();
  const file = storageFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 存储读不出来时的写入拒绝。
 *
 * 这不是保守，是防数据丢失：`load()` 在读不出来时返回空 store，
 * 若照旧写回去，就等于用「只有这一把 key」的内容覆盖掉那份其实还在的密文 ——
 * 用户其余所有 provider 的凭据会在一次「保存」里被彻底删掉，而且没有任何提示。
 */
export class CredentialStoreUnreadable extends Error {
  readonly code = 'CREDENTIAL_STORE_UNREADABLE';
  constructor(readonly detail: string | null) {
    super('凭据文件存在但读不出来，已拒绝写入以免覆盖掉现有凭据');
  }
}

export function isAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function state(): CredentialStoreState {
  return load().state;
}

/** 供 Settings 展示：读不出来时说清楚是读不出来，而不是让它看起来像"还没配"。 */
export function stateDetail(): string | null {
  return load().detail;
}

export function getAll(): Store {
  return load().store;
}

function mutate(change: (store: Store) => void): void {
  const loaded = load();
  if (loaded.state === 'UNREADABLE') throw new CredentialStoreUnreadable(loaded.detail);
  const store = loaded.store;
  change(store);
  persist(store);
}

export function setKey(providerId: string, apiKey: string): void {
  mutate((store) => {
    const trimmed = apiKey.trim();
    if (trimmed) store[providerId] = trimmed;
    else delete store[providerId];
  });
}

export function removeKey(providerId: string): void {
  // 没有存储、也没有文件时，"删除"已经是事实，不需要为此写盘或报错。
  if (!safeStorage.isEncryptionAvailable() && !existsSync(storageFile())) return;
  mutate((store) => {
    delete store[providerId];
  });
}

/** 供自检与诊断使用：知道凭据落在哪，才能证明隔离生效。 */
export function storagePath(): string {
  return storageFile();
}
