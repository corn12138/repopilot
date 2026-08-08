import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommandDefinition, CommandOutcome } from '@shared/domain';
import { PREVIEW_MAX_BYTES } from './tools';

/** 每条流最多留这么多字节。**留尾巴**，因为构建错误的结论在最后。 */
const MAX_CAPTURE_BYTES = 512_000;

/**
 * 保留尾部的输出缓冲。
 *
 * 早先的实现是"累计到上限就不再累积"，保留的是**开头** 512KB；
 * 而 tailPreview 又从中取尾巴，于是拿到的是「前 512KB 的末尾」。
 * 对 tsc / webpack / 大仓库测试这种动辄上 MB 的输出，真正的错误摘要
 * 恰恰在最后几行 —— 输出越大越拿不到结论。所以这里改成从**头部丢弃**。
 *
 * 顺带解决跨 chunk 的多字节字符问题：64KB 的 pipe 边界几乎不可能整除 3，
 * 逐块 `toString('utf8')` 会把中文报错、中文测试名随机糊成 U+FFFD。
 * 用 StringDecoder 持有跨块状态。
 */
class TailBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** 有内容因为超限被从头部丢弃过 */
  droppedHead = false;

  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    if (!text) return;
    const buf = Buffer.from(text, 'utf8');
    this.chunks.push(buf);
    this.bytes += buf.byteLength;
    while (this.bytes > MAX_CAPTURE_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.byteLength;
      this.droppedHead = true;
    }
  }

  finish(): string {
    const tail = this.decoder.end();
    if (tail) this.chunks.push(Buffer.from(tail, 'utf8'));
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * 按**字节**截断到最近的完整码点边界。
 *
 * 三处截断（这里、tools.project、patch.sealPatch）原本都是"按字节判阈值、
 * 按字符切片"，多字节内容下体积上限最坏会被撑到 3 倍 —— 调用方按 4000 字节
 * 规划 IPC 载荷和提示词预算，实际拿到 12000 字节。
 */
export function truncateTailToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  // 从尾部取，再用 StringDecoder 丢掉开头可能残缺的半个码点
  const tail = buf.subarray(buf.byteLength - maxBytes);
  const decoded = new StringDecoder('utf8').write(tail);
  const cut = decoded.indexOf('\n');
  return { text: cut >= 0 ? decoded.slice(cut + 1) : decoded, truncated: true };
}

/**
 * 执行 profile 中已登记的结构化命令。
 *
 * 与参考 CLI 样本的差别（overlay §7.2 Reject 行）：
 *   - 不使用宿主 login/interactive shell，不做字符串拼接 —— 只有 argv 数组。
 *   - 用 detached 进程组 + `kill(-pid)` 终止整棵进程树，SIGTERM 无效时升级 SIGKILL。
 *   - 结果是判别联合：EXIT_ZERO / EXIT_NONZERO / SIGNAL / TIMEOUT / CANCELLED / SPAWN_ERROR。
 *     非零退出、被信号杀死、超时都**不可能**被当成成功。
 *   - 输出保留尾部并按字节截断，截断与否由缓冲层自己回报，不在外面靠阈值猜。
 */
export async function runCommand(
  def: CommandDefinition,
  cwd: string,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  const started = Date.now();

  // 进来时就已经取消了 —— 必须在 spawn 之前返回。
  // 之前只挂 addEventListener，而 abort 事件早就派发过了，监听器永远不会触发，
  // 于是"用户已取消"之后命令照常执行并产生真实副作用。
  if (signal.aborted) {
    return outcome(def, 'CANCELLED', null, null, started, '', '调用时 signal 已处于 aborted 状态', false);
  }

  const [bin, ...args] = def.argv;
  if (!bin) {
    return outcome(def, 'SPAWN_ERROR', null, null, started, '', 'argv 为空', false);
  }

  return new Promise<CommandOutcome>((resolve) => {
    const out = new TailBuffer();
    const err = new TailBuffer();
    let settled = false;
    /** 进程是否真的退出了。**不能**复用 settled —— 那表示 Promise 已定型，不是进程已死。 */
    let childClosed = false;

    const child = spawn(bin, args, {
      cwd,
      detached: true, // 建立独立进程组，便于整树终止
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NODE_ENV: process.env.NODE_ENV ?? 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* 已退出 */
        }
      }
      // 升级到 SIGKILL：判据是"进程还没 close"，不是"Promise 还没定型"。
      // 之前用 settled 判断，而 finish() 是同步先于定时器执行的，
      // 于是这段升级逻辑是死代码 —— 屏蔽 SIGTERM 的构建/watch 工具会变成永久孤儿，
      // 而 outcome 已经报告 TIMEOUT，从返回值上完全看不出来。
      const escalate = setTimeout(() => {
        if (childClosed || child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
        }
      }, 3000);
      // 刻意**不** unref：必须活到升级发生，否则进程可能在升级前就随主进程退出
      void escalate;
    };

    const finish = (
      kind: CommandOutcome['outcome'],
      code: number | null,
      sig: string | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(
        outcome(
          def,
          kind,
          code,
          sig,
          started,
          out.finish(),
          err.finish(),
          out.droppedHead || err.droppedHead,
        ),
      );
    };

    const timer = setTimeout(() => {
      killTree();
      finish('TIMEOUT', null, null);
    }, def.timeoutMs);

    const onAbort = (): void => {
      killTree();
      finish('CANCELLED', null, null);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      childClosed = true;
      err.push(Buffer.from(`\n[spawn error] ${(e as Error).message}`, 'utf8'));
      finish('SPAWN_ERROR', null, null);
    });

    child.on('close', (code, sig) => {
      childClosed = true;
      if (sig) finish('SIGNAL', code, sig);
      else if (code === 0) finish('EXIT_ZERO', 0, null);
      else finish('EXIT_NONZERO', code, null);
    });
  });
}

function outcome(
  def: CommandDefinition,
  kind: CommandOutcome['outcome'],
  exitCode: number | null,
  signal: string | null,
  started: number,
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
): CommandOutcome {
  const o = truncateTailToBytes(stdout.trimEnd(), PREVIEW_MAX_BYTES);
  const e = truncateTailToBytes(stderr.trimEnd(), PREVIEW_MAX_BYTES);
  return {
    commandId: def.commandId,
    argv: def.argv,
    outcome: kind,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    stdoutPreview: o.truncated ? `…[前段已省略]\n${o.text}` : o.text,
    stderrPreview: e.truncated ? `…[前段已省略]\n${e.text}` : e.text,
    // 由各层自己回报，不在外面用另一套阈值猜 —— 之前单条 6000 字节的输出
    // 明明已被腰斩，这里却报 false，下游据此把残缺日志当成完整证据
    outputTruncated: captureTruncated || o.truncated || e.truncated,
  };
}
