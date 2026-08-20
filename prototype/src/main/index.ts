import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import type { DoctorCheck, PatchExportGrant } from '@shared/domain';
import {
  IPC_CHANNEL,
  PROTOCOL_VERSION,
  type IpcResult,
  type PlatformError,
  type PushEvent,
  type RequestMethod,
} from '@shared/protocol';
import { isRequestMethod, methodTimeoutMs } from '@shared/ipcContract';
import { classifyEnvelope } from './envelope';
import {
  ExportDestinationError,
  classifyExportDestination,
  writeExportAtomically,
} from './patchExport';
import { probeRenderedStyles } from './renderProbe';
import { DATA_ROOT_ENV, isIsolatedDataRoot, resolveDataRoot } from '@shared/dataRoot';
import { CoreRequestBroker } from './coreChannel';

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

/**
 * Core 实例代次。每次 Core 就绪自增一次。
 *
 * Renderer 的界面是某一代 Core 的投影：那一代崩溃后，工作区没了、活着的 Run 被判成
 * INTERRUPTED、内存里的审批也不复存在。带着旧代次发来的请求不是"稍微过时"，
 * 而是**基于一个已经不存在的世界**。让它静默地被新实例应答，等于把两代事实缝在一起。
 * 所以除了用来获取代次的 core.getStatus，其余方法都必须带上匹配的 epoch。
 */
let coreEpoch = 0;

const broker = new CoreRequestBroker({
  post: (message) => {
    if (!core) throw new Error('Agent Core 不在运行');
    core.postMessage(message);
  },
});

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
      coreEpoch += 1;
      // Core 每次（重）启动都要重新注入凭据 —— 它只在内存持有，重启即丢
      void syncCredentialsToCore().then(() => {
        pushToRenderer({
          type: 'core.status',
          status: 'READY',
          detail: 'Agent Core 已就绪',
          epoch: coreEpoch,
        });
      });
      return;
    }
    if (data.kind === 'push') {
      pushToRenderer(data.event);
      return;
    }
    if (data.kind === 'response') {
      broker.settle(
        data.requestId,
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
    broker.failAll(`exit code ${code}`);
    pushToRenderer({
      type: 'core.status',
      status: 'DOWN',
      detail: `Agent Core 退出 (code=${code})`,
      epoch: coreEpoch,
    });
    if (!quitting) {
      pushToRenderer({
        type: 'core.status',
        status: 'RESTARTING',
        detail: '正在重启 Agent Core',
        epoch: coreEpoch,
      });
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

/** Main 自己发起的内部调用（`__` 前缀方法）没有 Renderer 合同，用这个上限。 */
const INTERNAL_CALL_TIMEOUT_MS = 120_000;

function callCore(method: string, payload: unknown): Promise<IpcResult<unknown>> {
  if (!core || !coreReady) {
    return Promise.resolve({
      ok: false,
      error: { code: 'CORE_UNAVAILABLE', message: 'Agent Core 尚未就绪', detail: null },
    });
  }
  const timeoutMs = isRequestMethod(method) ? methodTimeoutMs(method) : INTERNAL_CALL_TIMEOUT_MS;
  return broker.request(method, payload, timeoutMs);
}

function pushToRenderer(event: PushEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNEL.event, event);
  }
}

// ---------------------------------------------------------------------------
// Renderer 请求入口
// ---------------------------------------------------------------------------

/** Main 当下持有的 Core 进程状态快照。getStatus 与 core.status push 必须同源。 */
function coreStatusSnapshot(): { status: 'READY' | 'RESTARTING' | 'DOWN'; detail: string; epoch: number } {
  return {
    status: coreReady ? 'READY' : core ? 'RESTARTING' : 'DOWN',
    detail: coreReady ? 'Agent Core 已就绪' : core ? 'Agent Core 尚未就绪' : 'Agent Core 已退出',
    epoch: coreEpoch,
  };
}

/*
 * 外层兜底。
 *
 * 处理体里任何未预期的抛出（凭据写盘 ENOSPC/EACCES、原生对话框失败……）如果直接
 * 逃出 ipcMain.handle，Renderer 拿到的是一个 rejected invoke —— `bridge.call` 只会
 * 从 `{ok:false}` 信封构造 RequestError，于是那条错误既没有 code 也没有 detail，
 * 界面只能显示一句无来源的字符串。每个请求都必须有一个**结构化**的结局。
 */
ipcMain.handle(IPC_CHANNEL.request, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
  try {
    return await handleRendererRequest(event, raw);
  } catch (err) {
    console.error('[main] 未预期的请求失败', err);
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Main 处理请求时发生未预期错误',
        detail: (err as Error).message?.slice(0, 300) ?? null,
      },
    };
  }
});

async function handleRendererRequest(
  event: Electron.IpcMainInvokeEvent,
  raw: unknown,
): Promise<IpcResult<unknown>> {
  // 绑定 sender：只接受主窗口发来的请求
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { ok: false, error: { code: 'POLICY_DENIED', message: '未授权的发送方', detail: null } };
  }

  // 协议版本、方法白名单、Core 代次、payload 合同 —— 判定逻辑在 envelope.ts 里可测。
  const decision = classifyEnvelope(raw, coreEpoch);
  if (decision.kind === 'reject') return { ok: false, error: decision.error };
  const { method, payload } = decision;

  /*
   * Core 状态属于 Main 的进程监督事实，不转交 Core。push 负责实时变化，这个快照负责
   * Renderer 订阅建立前已经发生的 READY；两者合起来才不会把一次性事件当持久状态。
   */
  if (method === 'core.getStatus') {
    return { ok: true, data: coreStatusSnapshot() };
  }

  // project.pick 是原生手势能力，由 Main 自己实现，然后把结果登记进 Core
  if (method === 'project.pick') {
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

  if (method === 'patch.export') {
    return exportPatch(payload as unknown as ExportRequest);
  }

  // 凭据写入只在 Main 完成：Renderer 送来明文，落盘前立刻加密，之后再不回传
  if (method === 'model.setKey') {
    const { profileId, apiKey } = payload as { profileId: string; apiKey: string };
    const providerId = profileId.replace(/^profile_/, '');
    if (!providerId) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: '未知 profile', detail: null } };
    }
    if (!credentials.isAvailable()) {
      // 删除也要写盘，所以钥匙串不可用时两个方向都做不了 —— 说清楚，不要假装成功。
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: '系统钥匙串不可用，无法读写应用内凭据',
          detail: '可改用环境变量方式提供 API Key',
        },
      };
    }
    try {
      credentials.setKey(providerId, apiKey);
    } catch (err) {
      /*
       * 存储读不出来时写入会用「只有这一把 key」覆盖掉那份其实还在的密文，
       * 一次「保存」就把其余 provider 的凭据全删了。拒绝并说清楚，不静默继续。
       */
      if (err instanceof credentials.CredentialStoreUnreadable) {
        return {
          ok: false,
          error: { code: 'CONFLICT', message: err.message, detail: err.detail },
        };
      }
      throw err;
    }
    return syncCredentialsToCore();
  }

  /*
   * 删自定义 provider 时把它的应用内凭据一并删掉。
   *
   * 以前只有 Core 侧的描述符被删，`credentials.bin` 里那把加密的 key 原样留着 ——
   * 用户界面上再也看不到它，但它还在磁盘上；更糟的是重新添加一个同名 provider 会让它
   * **悄悄复活**（profile 直接显示 credentialSource=APP 和旧 key 的末四位）。
   * 一个删掉的东西不该在暗处留一份秘密。删不掉时如实报错，不假装删干净了。
   */
  if (method === 'model.removeProvider') {
    const { providerId } = payload as { providerId: string };
    const res = await callCore('model.removeProvider', payload);
    if (!res.ok) return res;
    try {
      credentials.removeKey(providerId);
    } catch (err) {
      if (err instanceof credentials.CredentialStoreUnreadable) {
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: `Provider 已删除，但它的应用内凭据没能一并删掉：${err.message}`,
            detail: err.detail,
          },
        };
      }
      throw err;
    }
    // Core 内存里也要同步移除，否则这一代 Core 仍持有那把 key。
    const synced = await syncCredentialsToCore();
    return synced.ok ? res : synced;
  }

  if (method === 'model.listProfiles') {
    const res = await callCore('model.listProfiles', {});
    if (res.ok) {
      // 凭据文件只有 Main 碰得到，所以可读性也只能由 Main 回答。
      return {
        ok: true,
        data: {
          ...(res.data as object),
          secureStorage: credentials.isAvailable(),
          credentialStore: credentials.state(),
          credentialStoreDetail: credentials.stateDetail(),
        },
      };
    }
    return res;
  }

  return callCore(method, payload);
}

/** 把解密后的凭据推进 Core 内存。启动时和每次改动后各调一次。 */
async function syncCredentialsToCore(): Promise<IpcResult<unknown>> {
  return callCore('__credentials.sync', { keys: credentials.getAll() });
}

interface ExportRequest {
  runId: string;
  patchId: string;
  mode: 'SAVE_FILE' | 'COPY' | 'APPLY_TO_REPO';
  patchDigest?: string;
}

/**
 * 补丁交付。
 *
 * 写宿主仓库这件事完全在 Core 里做（它才知道 hostPath，且要用 git apply 保证原子性）；
 * Main 只负责两个原生能力：保存对话框和剪贴板。Renderer 全程拿不到宿主路径。
 */
async function exportPatch(req: ExportRequest): Promise<IpcResult<unknown>> {
  if (req.mode === 'APPLY_TO_REPO') {
    return callCore('__patch.applyToRepo', {
      runId: req.runId,
      patchId: req.patchId,
      patchDigest: req.patchDigest,
    });
  }

  /*
   * 一次性导出授权（PRD-DIFF-004）。Core 一并给出内容、内容 digest、和一份
   * "绝对不能写进去"的目录清单；无论成功还是失败，这张票都要回报给 Core 消费掉。
   * 分两次拿（先内容后授权）会在中间留一个"补丁已变但票还有效"的窗口，所以是一次调用。
   */
  const granted = await callCore('__patch.exportGrant', {
    runId: req.runId,
    patchId: req.patchId,
  });
  if (!granted.ok) return granted;
  const { grant, content } = granted.data as { grant: PatchExportGrant; content: string };
  const settle = (
    outcome: 'WRITTEN' | 'CANCELLED' | 'REJECTED' | 'FAILED',
    extra: Record<string, unknown> = {},
  ): Promise<IpcResult<unknown>> =>
    callCore('__patch.exportResult', { grantId: grant.grantId, outcome, ...extra });

  if (req.mode === 'COPY') {
    clipboard.writeText(content);
    await settle('WRITTEN', {
      targetName: '(剪贴板)',
      bytes: grant.byteLength,
      overwrote: false,
      contentDigest: grant.contentDigest,
    });
    return {
      ok: true,
      data: {
        ok: true,
        mode: 'COPY',
        detail: `${grant.byteLength} 字节已复制到剪贴板`,
        target: null,
      },
    };
  }

  const chosen = await dialog.showSaveDialog(mainWindow!, {
    title: '保存补丁',
    defaultPath: join(app.getPath('downloads'), grant.filename),
    filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
  });
  if (chosen.canceled || !chosen.filePath) {
    await settle('CANCELLED', { detail: '用户取消' });
    return { ok: true, data: { ok: false, reason: 'CANCELLED', detail: '已取消' } };
  }

  // 选完先判一次：受保护根 / 符号链接 / 父目录不可解析。写之前还会再判一次（TOCTOU）
  const verdict = classifyExportDestination(chosen.filePath, grant.forbiddenRoots);
  if (!verdict.ok) {
    await settle('REJECTED', { detail: `${verdict.reason}: ${verdict.detail}` });
    return { ok: true, data: { ok: false, reason: verdict.reason, detail: verdict.detail } };
  }

  let written;
  try {
    written = writeExportAtomically(chosen.filePath, content, grant.forbiddenRoots);
  } catch (err) {
    const reason = err instanceof ExportDestinationError ? err.reason : 'WRITE_FAILED';
    await settle(err instanceof ExportDestinationError ? 'REJECTED' : 'FAILED', {
      detail: (err as Error).message,
    });
    return { ok: true, data: { ok: false, reason, detail: (err as Error).message } };
  }

  await settle('WRITTEN', {
    targetName: basename(chosen.filePath),
    bytes: written.bytes,
    overwrote: written.overwrote,
    contentDigest: grant.contentDigest,
  });
  return {
    ok: true,
    data: {
      ok: true,
      mode: 'SAVE_FILE',
      detail: `已保存 ${written.bytes} 字节${written.overwrote ? '（覆盖了同名文件）' : ''}`,
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
    pushToRenderer({ type: 'core.status', ...coreStatusSnapshot() });
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * 自检模式：`pnpm selftest`（内部即 `REPOPILOT_SELFTEST=1 npx electron .`）。
 *
 * 走**完全相同**的 Main → Core 通道跑几个只读方法，打印结果后退出。
 * 用途是拿到"三个进程真的起来了、私有 IPC 真的通了"的确定性证据，
 * 而不是靠"启动没报错"来推断。
 *
 * 隔离约定（Slice C）：自检**必须**运行在一次性 data root 下。它会创建 credential、
 * project、snapshot、run，还会启动 retention 清扫 —— 对着真实用户目录做这些事，
 * 等于用你的数据来验证代码。`prepareSelfTestRoot()` 在 Core 启动前设置
 * `REPOPILOT_DATA_ROOT`，`finishSelfTest()` 在任何退出路径上都会清掉它。
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
  for (const method of [
    'doctor.run',
    'model.listProfiles',
    'crossreview.reviewers',
    'project.list',
    'run.list',
  ]) {
    const result = await callCore(method, {});
    if (!result.ok) {
      console.error(`[selftest] FAIL ${method} → ${JSON.stringify(result.error)}`);
      failures += 1;
      continue;
    }
    if (method === 'doctor.run') {
      // 逐条打印而不是截断到 220 字符：自检报告被截掉正好是这里最不该发生的事。
      // 打包后「工具链缺失」这条排在后面，截断版本里根本看不见它。
      const { checks } = result.data as { checks: DoctorCheck[] };
      console.log(`[selftest] PASS doctor.run → ${checks.length} 项`);
      for (const c of checks) {
        console.log(
          `[selftest]   ${c.status === 'READY' ? '✓' : '✗'} ${c.checkId}(${c.status}) ${c.detail}` +
            `${c.remediation ? ` … ${c.remediation}` : ''}`,
        );
      }
    } else if (method === 'crossreview.reviewers') {
      const { reviewers } = result.data as {
        reviewers: Array<{ id: string; kind: string; label: string; available: boolean; reason: string | null }>;
      };
      console.log(`[selftest] PASS crossreview.reviewers → ${reviewers.length} 个`);
      for (const r of reviewers) {
        console.log(
          `[selftest]   ${r.available ? '✓' : '✗'} [${r.kind}] ${r.id} — ${r.label}` +
            `${r.reason ? ` … ${r.reason}` : ''}`,
        );
      }
    } else {
      console.log(`[selftest] PASS ${method} → ${JSON.stringify(result.data).slice(0, 220)}`);
    }
  }

  // 可选：对一个真实仓库跑导入，验证成功/阻断都返回**明确终态**而不是永远挂起
  // （只读宿主仓库，但会在受管根下产生 snapshot，所以同样要求隔离）
  const probeRepo = isIsolatedDataRoot() ? process.env.REPOPILOT_SELFTEST_REPO : undefined;
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
              expectedGeneration: null,
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
            expectedGeneration: null,
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

  /*
   * 两道前置闸门，缺一不可：
   *   隔离  —— 没隔离就绝不写凭据 / profile / Run，宁可整段 SKIP；
   *   钥匙串 —— 不可用时明确 BLOCKED，而不是让 encryptString 抛出未处理 rejection
   *             并把整个自检挂住（阶段审计 P2-5 记的就是这条）。
   */
  const isolated = isIsolatedDataRoot();
  const secureStorageAvailable = credentials.isAvailable();
  if (!isolated) {
    console.error('[selftest] BLOCKED 未运行在隔离 data root 下，跳过所有写入型用例');
    failures += 1;
  } else if (!secureStorageAvailable) {
    console.log(
      '[selftest] SKIP 凭据、profile 与重启恢复用例：本机 safeStorage 不可用' +
        `（凭据文件位置 ${credentials.storagePath()}）。这不是失败，是环境不具备。`,
    );
  }

  // 凭据与 profile 配置：走与 UI 完全相同的路径，最后清理掉写入的测试值
  if (isolated && secureStorageAvailable) {
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
  if (isolated && secureStorageAvailable) {
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
        // 出站同意：自检也走真实合同 —— 先披露再同意，不给自检开后门
        const disclosed = await callCore('egress.disclosure', {
          snapshotId: snap.snapshotId,
          modelProfileId: 'profile_anthropic',
        });
        const consentDigest = disclosed.ok
          ? (disclosed.data as { disclosure: { digest: string } }).disclosure.digest
          : '';
        const created = await callCore('task.create', {
          projectId,
          snapshotId: snap.snapshotId,
          profileId: prof.profileId,
          modelProfileId: 'profile_anthropic',
          egressConsentDigest: consentDigest,
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

    /*
     * 渲染层取证：计算样式 + 真实几何 + prefers-reduced-motion 媒体模拟。
     * 这一段拿到的是单测拿不到的东西 —— jsdom 不应用外部样式表、也没有布局，
     * 所以"CSS 真的生效了""容器真的能滚""减少动效真的关掉了运动"只能在这里证明。
     */
    const probe = await probeRenderedStyles(mainWindow!.webContents);
    for (const pass of probe.passes) console.log(`[selftest] PASS 渲染层 · ${pass}`);
    for (const failure of probe.failures) console.error(`[selftest] FAIL 渲染层 · ${failure}`);
    failures += probe.failures.length;
  } else {
    console.error('[selftest] FAIL renderer 未能完成加载');
    failures += 1;
  }

  console.log(failures === 0 ? '[selftest] ALL PASS' : `[selftest] ${failures} 项失败`);
  quitting = true;
  core?.kill();
  app.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 自检的数据隔离
// ---------------------------------------------------------------------------

/** 本次自检自己创建的一次性根；用户显式指定 data root 时为 null（不由我们删）。 */
let selfTestOwnedRoot: string | null = null;

/**
 * 在 Core 启动**之前**准备隔离根。
 *
 * 时机是硬要求：`core/paths.ts` 与 `main/credentials.ts` 都在模块加载时就把
 * DATA_ROOT 定下来了，Core 又是带着 `process.env` 快照 fork 出去的。晚一步设置，
 * 隔离就只在 Main 生效，Core 仍然写你的真实目录。
 */
function prepareSelfTestRoot(): void {
  if (process.env[DATA_ROOT_ENV]?.trim()) {
    console.log(`[selftest] 使用调用方指定的隔离 data root：${resolveDataRoot()}`);
    return;
  }
  selfTestOwnedRoot = mkdtempSync(join(tmpdir(), 'repopilot-selftest-'));
  process.env[DATA_ROOT_ENV] = selfTestOwnedRoot;
  console.log(`[selftest] 已创建一次性 data root：${selfTestOwnedRoot}`);
}

/**
 * 收尾：先证明"没留下东西"，再删掉一次性根。
 *
 * 顺序不能反 —— 先删再数，数出来永远是零，那种"清理干净"是自证的。
 */
function reportSelfTestResidue(): number {
  const root = resolveDataRoot();
  if (!existsSync(root)) {
    console.log('[selftest] PASS 种子数据为零：data root 不存在');
    return 0;
  }
  const counts = ['runs', 'workspaces', 'snapshots', 'artifacts'].map((name) => {
    const dir = join(root, name);
    return { name, entries: existsSync(dir) ? readdirSync(dir).length : 0 };
  });
  const credentialFile = credentials.storagePath();
  const leakedCredentials = existsSync(credentialFile) && !credentialFile.startsWith(root);
  const seeded = counts.reduce((sum, c) => sum + c.entries, 0);

  console.log(
    `[selftest] 隔离根内种子数据：${counts.map((c) => `${c.name}=${c.entries}`).join(' ')}` +
      ` · credentials=${credentialFile.startsWith(root) ? '隔离内' : '隔离外（异常）'}`,
  );
  if (leakedCredentials) {
    console.error(`[selftest] FAIL 凭据文件落在隔离根之外：${credentialFile}`);
    return 1;
  }
  // 种子数据本身不是失败 —— 它证明自检真的跑通了闭环；随一次性根一起删掉即可。
  if (seeded > 0 && selfTestOwnedRoot === null) {
    console.log('[selftest] 注意：data root 由调用方指定，种子数据保留在那里，不由自检删除');
  }
  return 0;
}

function cleanupSelfTestRoot(): void {
  if (!selfTestOwnedRoot) return;
  try {
    rmSync(selfTestOwnedRoot, { recursive: true, force: true });
    console.log(`[selftest] 已删除一次性 data root：${selfTestOwnedRoot}`);
  } catch (err) {
    console.error(`[selftest] 一次性 data root 删除失败：${(err as Error).message}`);
  }
  selfTestOwnedRoot = null;
}

/**
 * 自检的唯一入口。
 *
 * `try/finally` 包住全部流程：无论 selfTest 正常结束、抛异常、还是在中途
 * `app.exit()`，一次性根都必须被删掉。此前没有这层包裹，任何一条异常路径
 * 都会把种子数据永久留在磁盘上。
 */
async function runSelfTestIsolated(): Promise<void> {
  try {
    await selfTest();
  } catch (err) {
    console.error(`[selftest] FAIL 自检抛出未处理异常：${(err as Error).stack ?? String(err)}`);
    quitting = true;
    core?.kill();
    app.exit(1);
  } finally {
    const residueFailures = reportSelfTestResidue();
    cleanupSelfTestRoot();
    if (residueFailures > 0) app.exit(1);
  }
}

app.whenReady().then(() => {
  if (process.env.REPOPILOT_SELFTEST === '1') {
    // 必须先隔离，再启动 Core —— Core 的 DATA_ROOT 在它自己的模块加载时就冻结了。
    prepareSelfTestRoot();
    startCore();
    void runSelfTestIsolated();
    return;
  }

  startCore();

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
