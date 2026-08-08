import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import * as credentials from './credentials';
import {
  IPC_CHANNEL,
  PROTOCOL_VERSION,
  type IpcResult,
  type PlatformError,
  type PushEvent,
} from '@shared/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Electron Main = Desktop Capability Broker。
 *
 * 它**只**做四件事：
 *   1. 窗口生命周期
 *   2. 原生手势能力（目录选择）
 *   3. 监督 Desktop Agent Core 子进程
 *   4. 校验 Renderer 请求后转发给 Core
 *
 * 它明确**不**持有：Task/Run/Approval 权威、Agent Loop、模型调用、仓库写权限。
 * 这条边界是 overlay §3 表格的代码实现。
 */

let mainWindow: BrowserWindow | null = null;
let core: UtilityProcess | null = null;
let coreReady = false;
/** 退出中标记：区分"Core 意外崩溃需重启"和"应用正在退出" */
let quitting = false;

const pending = new Map<string, (result: IpcResult<unknown>) => void>();
let requestSeq = 0;

// ---------------------------------------------------------------------------
// Core 监督
// ---------------------------------------------------------------------------

function startCore(): void {
  const corePath = join(__dirname, 'core.js');
  coreReady = false;

  const child = utilityProcess.fork(corePath, [], {
    serviceName: 'repopilot-agent-core',
    stdio: 'inherit',
    // Core 需要 Provider 凭据（BYOK 环境变量）；Renderer 永远拿不到它们
    env: { ...process.env },
  });

  child.on('message', (message: unknown) => {
    const data = message as
      | { kind: 'ready' }
      | { kind: 'response'; requestId: string; ok: boolean; data?: unknown; error?: unknown }
      | { kind: 'push'; event: PushEvent };

    if (data.kind === 'ready') {
      coreReady = true;
      // Core 每次（重）启动都要重新注入凭据 —— 它只在内存持有，重启即丢
      void syncCredentialsToCore().then(() => {
        pushToRenderer({ type: 'core.status', status: 'READY', detail: 'Agent Core 已就绪' });
      });
      return;
    }
    if (data.kind === 'push') {
      pushToRenderer(data.event);
      return;
    }
    if (data.kind === 'response') {
      const resolve = pending.get(data.requestId);
      if (!resolve) return;
      pending.delete(data.requestId);
      resolve(
        data.ok
          ? { ok: true, data: data.data }
          : { ok: false, error: data.error as PlatformError },
      );
    }
  });

  child.on('exit', (code) => {
    coreReady = false;
    core = null;
    // 所有在途请求必须收到明确失败，不能永远挂着
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({
        ok: false,
        error: { code: 'CORE_UNAVAILABLE', message: 'Agent Core 已退出', detail: `exit code ${code}` },
      });
    }
    pushToRenderer({ type: 'core.status', status: 'DOWN', detail: `Agent Core 退出 (code=${code})` });
    if (!quitting) {
      pushToRenderer({ type: 'core.status', status: 'RESTARTING', detail: '正在重启 Agent Core' });
      setTimeout(startCore, 1000);
    }
  });

  core = child;
}

/**
 * 主动杀掉 Core。
 *
 * 必须**同步**把 coreReady 置 false —— `exit` 事件是异步到达的，在那之前
 * callCore 会认为 Core 还活着，把消息 post 给一个已死进程，然后那个 Promise
 * 永远不会 resolve。（这条是被重启自检抓出来的。）
 */
function killCore(): void {
  coreReady = false;
  core?.kill();
}

function callCore(method: string, payload: unknown): Promise<IpcResult<unknown>> {
  if (!core || !coreReady) {
    return Promise.resolve({
      ok: false,
      error: { code: 'CORE_UNAVAILABLE', message: 'Agent Core 尚未就绪', detail: null },
    });
  }
  requestSeq += 1;
  const requestId = `req_${requestSeq}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    core!.postMessage({ kind: 'request', requestId, method, payload });
  });
}

function pushToRenderer(event: PushEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNEL.event, event);
  }
}

// ---------------------------------------------------------------------------
// Renderer 请求入口
// ---------------------------------------------------------------------------

/** 白名单：不在这个集合里的方法名一律拒绝，不存在通用 invoke */
const ALLOWED_METHODS = new Set([
  'doctor.run',
  'project.pick',
  'project.list',
  'project.import',
  'model.listProfiles',
  'model.testProfile',
  'model.setKey',
  'model.updateProfile',
  'model.addProvider',
  'model.removeProvider',
  'task.create',
  'run.get',
  'run.list',
  'run.events',
  'run.toolCalls',
  'run.cancel',
  'plan.get',
  'approval.pending',
  'approval.decide',
  'patch.get',
  'patch.decide',
  'patch.export',
  'verification.list',
  'files.tree',
  'files.read',
  'retention.get',
  'retention.update',
  'retention.sweepNow',
]);

const MAX_PAYLOAD_BYTES = 256 * 1024;

ipcMain.handle(IPC_CHANNEL.request, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
  // 绑定 sender：只接受主窗口发来的请求
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { ok: false, error: { code: 'POLICY_DENIED', message: '未授权的发送方', detail: null } };
  }

  const envelope = raw as { protocolVersion?: string; method?: string; payload?: unknown };
  if (envelope?.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: '协议版本不匹配',
        detail: `期望 ${PROTOCOL_VERSION}，收到 ${String(envelope?.protocolVersion)}`,
      },
    };
  }
  if (typeof envelope.method !== 'string' || !ALLOWED_METHODS.has(envelope.method)) {
    return {
      ok: false,
      error: { code: 'POLICY_DENIED', message: `方法不在白名单内: ${String(envelope.method)}`, detail: null },
    };
  }
  if (Buffer.byteLength(JSON.stringify(envelope.payload ?? {}), 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: '请求体过大', detail: null } };
  }

  // project.pick 是原生手势能力，由 Main 自己实现，然后把结果登记进 Core
  if (envelope.method === 'project.pick') {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要授权给 RepoPilot 的 Git 仓库',
      properties: ['openDirectory'],
      buttonLabel: '授权此仓库',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, data: { project: null } };
    }
    return callCore('__project.register', { hostPath: result.filePaths[0] });
  }

  if (envelope.method === 'patch.export') {
    return exportPatch(envelope.payload as ExportRequest);
  }

  // 凭据写入只在 Main 完成：Renderer 送来明文，落盘前立刻加密，之后再不回传
  if (envelope.method === 'model.setKey') {
    const { profileId, apiKey } = envelope.payload as { profileId: string; apiKey: string };
    const providerId = profileId.replace(/^profile_/, '');
    if (!providerId) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: '未知 profile', detail: null } };
    }
    if (apiKey.trim() && !credentials.isAvailable()) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: '系统钥匙串不可用，无法安全保存凭据',
          detail: '可改用环境变量方式提供 API Key',
        },
      };
    }
    credentials.setKey(providerId, apiKey);
    return syncCredentialsToCore();
  }

  if (envelope.method === 'model.listProfiles') {
    const res = await callCore('model.listProfiles', {});
    if (res.ok) {
      return {
        ok: true,
        data: { ...(res.data as object), secureStorage: credentials.isAvailable() },
      };
    }
    return res;
  }

  return callCore(envelope.method, envelope.payload ?? {});
});

/** 把解密后的凭据推进 Core 内存。启动时和每次改动后各调一次。 */
async function syncCredentialsToCore(): Promise<IpcResult<unknown>> {
  return callCore('__credentials.sync', { keys: credentials.getAll() });
}

interface ExportRequest {
  runId: string;
  patchId: string;
  mode: 'SAVE_FILE' | 'COPY' | 'APPLY_TO_REPO';
}

/**
 * 补丁交付。
 *
 * 写宿主仓库这件事完全在 Core 里做（它才知道 hostPath，且要用 git apply 保证原子性）；
 * Main 只负责两个原生能力：保存对话框和剪贴板。Renderer 全程拿不到宿主路径。
 */
async function exportPatch(req: ExportRequest): Promise<IpcResult<unknown>> {
  if (req.mode === 'APPLY_TO_REPO') {
    return callCore('__patch.applyToRepo', { runId: req.runId, patchId: req.patchId });
  }

  const contentResult = await callCore('__patch.content', {
    runId: req.runId,
    patchId: req.patchId,
  });
  if (!contentResult.ok) return contentResult;
  const { filename, content } = contentResult.data as { filename: string; content: string };

  if (req.mode === 'COPY') {
    clipboard.writeText(content);
    return {
      ok: true,
      data: {
        ok: true,
        mode: 'COPY',
        detail: `${Buffer.byteLength(content, 'utf8')} 字节已复制到剪贴板`,
        target: null,
      },
    };
  }

  const chosen = await dialog.showSaveDialog(mainWindow!, {
    title: '保存补丁',
    defaultPath: join(app.getPath('downloads'), filename),
    filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
  });
  if (chosen.canceled || !chosen.filePath) {
    return { ok: true, data: { ok: false, reason: 'CANCELLED', detail: '已取消' } };
  }
  try {
    writeFileSync(chosen.filePath, content, 'utf8');
  } catch (err) {
    return {
      ok: true,
      data: { ok: false, reason: 'WRITE_FAILED', detail: (err as Error).message },
    };
  }
  return {
    ok: true,
    data: {
      ok: true,
      mode: 'SAVE_FILE',
      detail: `已保存 ${Buffer.byteLength(content, 'utf8')} 字节`,
      target: basename(chosen.filePath),
    },
  };
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'RepoPilot Prototype',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e1116',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Renderer 三不：无 Node、开 sandbox、开 contextIsolation
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Core 的 ready 推送可能早于 Renderer 订阅完成。事件是"推"的，不能指望
  // 订阅方一定在场 —— 所以每次 Renderer 加载完成后补发一次当前状态。
  mainWindow.webContents.on('did-finish-load', () => {
    pushToRenderer({
      type: 'core.status',
      status: coreReady ? 'READY' : core ? 'RESTARTING' : 'DOWN',
      detail: coreReady ? 'Agent Core 已就绪' : 'Agent Core 尚未就绪',
    });
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * 自检模式：`REPOPILOT_SELFTEST=1 npx electron .`
 *
 * 走**完全相同**的 Main → Core 通道跑几个只读方法，打印结果后退出。
 * 用途是拿到"三个进程真的起来了、私有 IPC 真的通了"的确定性证据，
 * 而不是靠"启动没报错"来推断。
 */
async function selfTest(): Promise<void> {
  const started = Date.now();
  while (!coreReady && Date.now() - started < 15_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!coreReady) {
    console.error('[selftest] FAIL: Core 在 15s 内未就绪');
    app.exit(1);
    return;
  }
  console.log(`[selftest] Core 就绪，用时 ${Date.now() - started}ms`);

  let failures = 0;
  for (const method of ['doctor.run', 'model.listProfiles', 'project.list', 'run.list']) {
    const result = await callCore(method, {});
    if (result.ok) {
      console.log(`[selftest] PASS ${method} → ${JSON.stringify(result.data).slice(0, 220)}`);
    } else {
      console.error(`[selftest] FAIL ${method} → ${JSON.stringify(result.error)}`);
      failures += 1;
    }
  }

  // 可选：对一个真实仓库跑导入，验证成功/阻断都返回**明确终态**而不是永远挂起
  const probeRepo = process.env.REPOPILOT_SELFTEST_REPO;
  if (probeRepo) {
    const reg = await callCore('__project.register', { hostPath: probeRepo });
    if (!reg.ok) {
      console.error(`[selftest] FAIL 注册项目 → ${JSON.stringify(reg.error)}`);
      failures += 1;
    } else {
      const projectId = (reg.data as { project: { projectId: string } }).project.projectId;

      let lastSnapshotId: string | null = null;
      const attempt = async (label: string, payload: Record<string, unknown>): Promise<void> => {
        const t0 = Date.now();
        const res = await callCore('project.import', { projectId, ...payload });
        const ms = Date.now() - t0;
        if (!res.ok) {
          console.error(`[selftest] FAIL ${label} 返回异常 → ${JSON.stringify(res.error)}`);
          failures += 1;
          return;
        }
        const d = res.data as {
          outcome: string;
          code?: string;
          message?: string;
          candidates?: Array<{ subPath: string; hasVite: boolean }>;
          snapshot?: {
            snapshotId: string;
            fileCount: number;
            baseKind: string;
            dirtyFileCount: number;
            subPath: string;
          };
          profile?: { supportStatus: string; commands: Record<string, unknown> };
        };
        if (d.outcome === 'IMPORTED') {
          lastSnapshotId = d.snapshot!.snapshotId;
          console.log(
            `[selftest] PASS ${label}（${ms}ms）→ ${d.snapshot!.fileCount} 文件 · base=${d.snapshot!.baseKind}` +
              `(${d.snapshot!.dirtyFileCount} 项改动) · sub="${d.snapshot!.subPath}" · profile=${d.profile!.supportStatus}` +
              ` · 命令=[${Object.keys(d.profile!.commands).join(',')}]`,
          );
        } else {
          console.log(
            `[selftest] PASS ${label}（${ms}ms）→ BLOCKED ${d.code} "${d.message}"` +
              ` · 子包候选=[${(d.candidates ?? []).map((c) => `${c.subPath}${c.hasVite ? '✦' : ''}`).join(',')}]`,
          );
        }
      };

      await attempt('默认导入', {});
      const probeSub = process.env.REPOPILOT_SELFTEST_SUBPATH;
      if (probeSub) await attempt(`子包 ${probeSub}`, { subPath: probeSub });

      // 文件树与文件读取走与 UI 完全相同的通道
      if (lastSnapshotId) {
        const tree = await callCore('files.tree', { snapshotId: lastSnapshotId });
        if (!tree.ok) {
          console.error(`[selftest] FAIL files.tree → ${JSON.stringify(tree.error)}`);
          failures += 1;
        } else {
          const t = tree.data as { entries: Array<{ path: string }>; source: string };
          console.log(`[selftest] PASS files.tree → ${t.entries.length} 项 · source=${t.source}`);

          const first = t.entries.find((e) => /\.(ts|tsx|json|md)$/.test(e.path));
          if (first) {
            const read = await callCore('files.read', {
              snapshotId: lastSnapshotId,
              path: first.path,
            });
            if (!read.ok) {
              console.error(`[selftest] FAIL files.read → ${JSON.stringify(read.error)}`);
              failures += 1;
            } else {
              const f = read.data as { path: string; bytes: number; binary: boolean };
              console.log(`[selftest] PASS files.read ${f.path} → ${f.bytes}B binary=${f.binary}`);
            }
          }

          // 负向：路径逃逸必须被拒
          const escape = await callCore('files.read', {
            snapshotId: lastSnapshotId,
            path: '../../../../etc/passwd',
          });
          if (escape.ok) {
            console.error('[selftest] FAIL 路径逃逸竟然被允许');
            failures += 1;
          } else {
            console.log(`[selftest] PASS 路径逃逸被拒绝 → ${JSON.stringify(escape.error)}`);
          }
        }
      }
    }
  }

  // 凭据与 profile 配置：走与 UI 完全相同的路径，最后清理掉写入的测试值
  {
    const before = credentials.getAll().anthropic;
    const show = async (label: string): Promise<Record<string, unknown> | null> => {
      const r = await callCore('model.listProfiles', {});
      if (!r.ok) {
        console.error(`[selftest] FAIL ${label} → ${JSON.stringify(r.error)}`);
        failures += 1;
        return null;
      }
      const p = (r.data as { profiles: Array<Record<string, unknown>> }).profiles.find(
        (x) => x.providerId === 'anthropic',
      )!;
      console.log(
        `[selftest] ${label} → source=${p.credentialSource} hint=${p.credentialHint} ` +
          `model=${p.modelId} origin=${p.origin} relay=${p.isRelay} enabled=${p.enabled} ` +
          `models=${(p.availableModels as string[]).length}`,
      );
      return p;
    };

    const initial = await show('PASS 初始 profile');
    const originalModel = String(initial?.modelId ?? '');

    credentials.setKey('anthropic', 'sk-ant-selftest-ABCD1234');
    await syncCredentialsToCore();
    const withKey = await show('PASS 存入 key 后');
    if (withKey && (withKey.credentialSource !== 'APP' || withKey.credentialHint !== '…1234')) {
      console.error('[selftest] FAIL 应用内凭据未生效');
      failures += 1;
    }

    await callCore('model.updateProfile', {
      profileId: 'profile_anthropic',
      modelId: 'claude-opus-5',
      baseUrlOverride: 'https://relay.example.com/v1',
    });
    const relayed = await show('PASS 改模型 + 覆盖 origin 后');
    // 只填域名会自动补 /v1
    if (relayed && (relayed.isRelay !== true || relayed.origin !== 'https://relay.example.com/v1')) {
      console.error('[selftest] FAIL 中转 origin 未生效或未标记');
      failures += 1;
    }

    // 自定义 provider：加一个中转站，验证它能进列表、协议/地址正确、能删掉
    const added = await callCore('model.addProvider', {
      id: 'selftest-relay',
      name: '自检中转',
      api: 'https://relay.selftest.example',
      wire: 'openai',
      models: ['some-model-a', 'some-model-b'],
    });
    if (!added.ok) {
      console.error(`[selftest] FAIL 添加自定义 provider → ${JSON.stringify(added.error)}`);
      failures += 1;
    } else {
      const list = (added.data as { profiles: Array<Record<string, unknown>> }).profiles;
      const custom = list.find((p) => p.providerId === 'selftest-relay');
      const ok =
        custom &&
        custom.kind === 'CUSTOM' &&
        custom.isRelay === true &&
        custom.origin === 'https://relay.selftest.example/v1' && // 只填域名时自动补 /v1
        custom.modelId === 'some-model-a';
      console.log(
        `[selftest] ${ok ? 'PASS' : 'FAIL'} 自定义 provider → 共 ${list.length} 个 provider · ` +
          `kind=${custom?.kind} origin=${custom?.origin} model=${custom?.modelId} wire=${custom?.wire}`,
      );
      if (!ok) failures += 1;
    }

    const removed = await callCore('model.removeProvider', { providerId: 'selftest-relay' });
    if (removed.ok) {
      const list = (removed.data as { profiles: Array<{ providerId: string }> }).profiles;
      const gone = !list.some((p) => p.providerId === 'selftest-relay');
      console.log(`[selftest] ${gone ? 'PASS' : 'FAIL'} 删除自定义 provider → 剩 ${list.length} 个`);
      if (!gone) failures += 1;
    }

    // 负向：与内置重名必须被拒
    const dup = await callCore('model.addProvider', {
      id: 'anthropic',
      name: 'x',
      api: 'https://evil.example/v1',
    });
    if (dup.ok) {
      console.error('[selftest] FAIL 与内置重名的 provider 竟然被接受');
      failures += 1;
    } else {
      console.log(`[selftest] PASS 重名被拒绝 → ${JSON.stringify(dup.error)}`);
    }

    // 还原：自检不能留下任何持久化改动
    await callCore('model.updateProfile', {
      profileId: 'profile_anthropic',
      baseUrlOverride: '',
      ...(originalModel ? { modelId: originalModel } : {}),
    });
    if (before) credentials.setKey('anthropic', before);
    else credentials.removeKey('anthropic');
    await syncCredentialsToCore();
    await show('PASS 还原后');
  }

  // 重启恢复：造一个真实 Run → 杀 Core → 确认新实例能把它读回来
  {
    /*
     * 造一个真实的、跑到一半的 Run，然后在它非终态时杀掉 Core。
     *
     * 为了不产生任何外部网络请求，临时把 anthropic 的 base URL 指向
     * 一个必然连不上的本地端口。Run 依然会真实地走完 createTask → 基线验证
     * （真跑 npm run build）→ 模型调用失败，我们在基线验证那一两秒的窗口里下手。
     */
    const fixture = join(__dirname, '../../fixtures/vite-react-broken');
    const savedKey = credentials.getAll().anthropic;
    let seededRunId: string | null = null;

    credentials.setKey('anthropic', 'sk-ant-selftest-restart');
    await syncCredentialsToCore();
    await callCore('model.updateProfile', {
      profileId: 'profile_anthropic',
      baseUrlOverride: 'https://127.0.0.1:9/v1', // discard 端口，必然 ECONNREFUSED
    });

    const reg = await callCore('__project.register', { hostPath: fixture });
    if (reg.ok) {
      const projectId = (reg.data as { project: { projectId: string } }).project.projectId;
      const imported = await callCore('project.import', { projectId });
      const d = imported.ok
        ? (imported.data as {
            outcome: string;
            snapshot?: { snapshotId: string };
            profile?: { profileId: string; commands: Record<string, unknown> };
          })
        : null;
      if (d?.outcome === 'IMPORTED' && d.snapshot && d.profile) {
        const snap = d.snapshot;
        const prof = d.profile;
        const created = await callCore('task.create', {
          projectId,
          snapshotId: snap.snapshotId,
          profileId: prof.profileId,
          modelProfileId: 'profile_anthropic',
          goal: '[selftest] 重启恢复用例',
          taskClass: 'BUILD_FAILURE_FIX',
          allowedPaths: ['src/**'],
          acceptance: [],
          // 选上 build：基线验证要真跑一两秒，给我们一个"非终态"窗口
          verificationCommandIds: Object.keys(prof.commands).includes('build') ? ['build'] : [],
        });
        if (created.ok) {
          seededRunId = (created.data as { run: { runId: string } }).run.runId;
          console.log(`[selftest] 已造出 Run ${seededRunId}，等它进入执行中`);
          await new Promise((r) => setTimeout(r, 700)); // 落在基线验证窗口里
          const mid = await callCore('run.get', { runId: seededRunId });
          if (mid.ok) {
            const st = (mid.data as { run: { status: string } | null }).run?.status;
            console.log(`[selftest] 杀 Core 前该 Run 的状态：${st}`);
          }
        } else {
          console.error(`[selftest] FAIL 造 Run 失败 → ${JSON.stringify(created.error)}`);
          failures += 1;
        }
      }
    }

    const before = await callCore('run.list', {});
    const beforeCount = before.ok ? (before.data as { runs: unknown[] }).runs.length : -1;

    // 直接重启 Core（等价于崩溃后自动拉起），看历史还在不在
    killCore(); // exit handler 会在 1s 后重新 startCore
    const t0 = Date.now();
    while (!coreReady && Date.now() - t0 < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const restarted = coreReady;
    console.log(`[selftest] Core 重启用时 ${Date.now() - t0}ms`);

    if (!restarted) {
      console.error('[selftest] FAIL Core 重启后未就绪');
      failures += 1;
    } else {
      const after = await callCore('run.list', {});
      if (!after.ok) {
        console.error(`[selftest] FAIL 重启后 run.list → ${JSON.stringify(after.error)}`);
        failures += 1;
      } else {
        const runs = (after.data as { runs: Array<Record<string, unknown>> }).runs;
        const restoredCount = runs.filter((r) => r.restored === true).length;
        const nonTerminalLeft = runs.filter(
          (r) => !['SUCCEEDED', 'ACCEPTED_UNVERIFIED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED'].includes(
            String(r.status),
          ) && r.status !== 'AWAITING_PATCH_REVIEW',
        ).length;

        const ok = runs.length >= beforeCount && nonTerminalLeft === 0;
        console.log(
          `[selftest] ${ok ? 'PASS' : 'FAIL'} 重启恢复 → 重启前 ${beforeCount} 个 Run，` +
            `重启后 ${runs.length} 个（其中 ${restoredCount} 个标记为 restored）；` +
            `残留非终态 ${nonTerminalLeft} 个`,
        );
        if (!ok) failures += 1;

        // 恢复的 Run 必须真的能读出事件，不能只是个空壳
        const sample = runs.find((r) => r.runId === seededRunId) ?? runs.find((r) => r.restored === true);
        if (sample) {
          const ev = await callCore('run.events', { runId: sample.runId, afterSeq: 0 });
          const count = ev.ok ? (ev.data as { events: unknown[] }).events.length : -1;
          const hasEvidence =
            count > 0 && sample.restored === true && sample.evidence !== 'DAMAGED';
          console.log(
            `[selftest] ${hasEvidence ? 'PASS' : 'FAIL'} 恢复的 Run 可读 → ${sample.runId}` +
              ` · ${count} 条事件 · status=${sample.status} · restored=${sample.restored}` +
              ` · evidence=${sample.evidence}`,
          );
          if (!hasEvidence) failures += 1;

          // 被打断的 Run 必须落成 INTERRUPTED，而不是继续假装在跑
          if (sample.runId === seededRunId) {
            const ok = sample.status === 'INTERRUPTED' || sample.status === 'FAILED';
            console.log(
              `[selftest] ${ok ? 'PASS' : 'FAIL'} 被打断的 Run 有明确终态 → ${sample.status}` +
                `（${String(sample.statusReason ?? '')}）`,
            );
            if (!ok) failures += 1;
          }
        }
      }
    }

    // 还原：删掉测试凭据、恢复官方 origin
    await callCore('model.updateProfile', { profileId: 'profile_anthropic', baseUrlOverride: '' });
    if (savedKey) credentials.setKey('anthropic', savedKey);
    else credentials.removeKey('anthropic');
    await syncCredentialsToCore();
  }

  // 负向：白名单外的方法必须被 Core 拒绝
  const denied = await callCore('run.deleteEverything', {});
  if (denied.ok) {
    console.error('[selftest] FAIL 未知方法竟然被接受');
    failures += 1;
  } else {
    console.log(`[selftest] PASS 未知方法被拒绝 → ${JSON.stringify(denied.error)}`);
  }

  // Renderer 真的挂载了吗？"编译通过"不等于"能渲染"
  createWindow();
  const rendererOk = await new Promise<boolean>((resolve) => {
    const wc = mainWindow!.webContents;
    const timer = setTimeout(() => resolve(false), 15_000);
    wc.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer);
      console.error(`[selftest] renderer 加载失败 ${code} ${desc}`);
      resolve(false);
    });
    wc.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (rendererOk) {
    // 进一步确认 React 真的挂上去了，而不是白屏
    const mounted = (await mainWindow!.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('root');
        return { children: r ? r.children.length : -1,
                 hasBridge: typeof window.repopilot === 'object',
                 text: (document.body.innerText || '').slice(0, 60) }; })()`,
    )) as { children: number; hasBridge: boolean; text: string };

    if (mounted.children > 0 && mounted.hasBridge) {
      console.log(
        `[selftest] PASS renderer 已挂载（root 子节点 ${mounted.children}，preload bridge 存在）："${mounted.text.replace(/\n/g, ' ')}"`,
      );
    } else {
      console.error(`[selftest] FAIL renderer 白屏或 bridge 缺失 ${JSON.stringify(mounted)}`);
      failures += 1;
    }
  } else {
    console.error('[selftest] FAIL renderer 未能完成加载');
    failures += 1;
  }

  console.log(failures === 0 ? '[selftest] ALL PASS' : `[selftest] ${failures} 项失败`);
  quitting = true;
  core?.kill();
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  startCore();

  if (process.env.REPOPILOT_SELFTEST === '1') {
    void selfTest();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  core?.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
