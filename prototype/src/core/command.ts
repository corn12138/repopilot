import { spawn } from 'node:child_process';
import type { CommandDefinition, CommandOutcome } from '@shared/domain';
import { PREVIEW_MAX_BYTES } from './tools';

const MAX_CAPTURE_BYTES = 512_000;

/**
 * 执行 profile 中已登记的结构化命令。
 *
 * 与 Neovate 样本的差别（overlay §7.2 Reject 行）：
 *   - 不使用宿主 login/interactive shell，不做字符串拼接 —— 只有 argv 数组。
 *   - 用 detached 进程组 + `kill(-pid)` 终止整棵进程树，避免留下孤儿构建进程。
 *   - 结果是判别联合：EXIT_ZERO / EXIT_NONZERO / SIGNAL / TIMEOUT / CANCELLED / SPAWN_ERROR。
 *     非零退出、被信号杀死、超时都**不可能**被当成成功。
 *   - stdout/stderr 有捕获上限，超出即停止累积，不在内存里无界拼接。
 */
export async function runCommand(
  def: CommandDefinition,
  cwd: string,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  const started = Date.now();
  const [bin, ...args] = def.argv;
  if (!bin) {
    return outcome(def, 'SPAWN_ERROR', null, null, started, '', 'argv 为空', false);
  }

  return new Promise<CommandOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

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

    const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
      const total = stdout.length + stderr.length;
      if (total >= MAX_CAPTURE_BYTES) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8').slice(0, MAX_CAPTURE_BYTES - total);
      if (into === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

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
      setTimeout(() => {
        if (settled || child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 3000).unref();
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
      resolve(outcome(def, kind, code, sig, started, stdout, stderr, truncated));
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

    child.on('error', (err) => {
      stderr += `\n[spawn error] ${(err as Error).message}`;
      finish('SPAWN_ERROR', null, null);
    });

    child.on('close', (code, sig) => {
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
  truncated: boolean,
): CommandOutcome {
  return {
    commandId: def.commandId,
    argv: def.argv,
    outcome: kind,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    stdoutPreview: tailPreview(stdout),
    stderrPreview: tailPreview(stderr),
    outputTruncated: truncated || stdout.length + stderr.length > PREVIEW_MAX_BYTES * 2,
  };
}

/** 构建/测试失败信息通常在尾部，所以保留尾巴而不是开头 */
function tailPreview(text: string): string {
  const trimmed = text.trimEnd();
  if (Buffer.byteLength(trimmed, 'utf8') <= PREVIEW_MAX_BYTES) return trimmed;
  const tail = trimmed.slice(-PREVIEW_MAX_BYTES);
  const cut = tail.indexOf('\n');
  return `…[前段已省略]\n${cut >= 0 ? tail.slice(cut + 1) : tail}`;
}
