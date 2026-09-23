import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type JsonRecord = Record<string, unknown>;

export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: JsonRecord) => void>();
  private stderrTail = '';

  constructor(
    private readonly binary: string,
    private readonly args: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly stopGraceMs = 1_000,
  ) { }

  private async start(): Promise<void> {
    if (this.child?.pid) return;
    if (this.starting) return this.starting;
    const child = spawn(this.binary, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    this.child = child;
    this.starting = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-1_000);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: JsonRecord;
      try {
        message = JSON.parse(line) as JsonRecord;
      } catch {
        for (const listener of this.listeners) {
          listener({ method: 'transport/protocolError', params: { reason: 'app-server emitted malformed JSON' } });
        }
        return;
      }
      if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if ('error' in message) waiter.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
        else waiter.resolve((message.result as JsonRecord) ?? {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    const disconnect = (error: Error) => {
      if (this.child !== child) return;
      const detail = this.stderrTail.trim();
      const reported = detail ? new Error(`${error.message} stderr=${detail}`) : error;
      for (const waiter of this.pending.values()) waiter.reject(reported);
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: 'transport/disconnected', params: { reason: reported.message } });
      this.child = null;
      this.starting = null;
    };
    child.once('error', (error) => disconnect(new Error(`app-server spawn failed: ${error.message}`)));
    child.once('exit', (code, signal) => {
      disconnect(new Error(`app-server exited: code=${String(code)} signal=${String(signal)}`));
    });
    try {
      await this.starting;
    } catch (error) {
      disconnect(new Error(`app-server spawn failed: ${(error as Error).message}`));
      throw error;
    }
  }

  async request(method: string, params: JsonRecord, timeoutMs = 15_000): Promise<JsonRecord> {
    await this.start();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: JsonRecord): void {
    if (!this.child?.pid) throw new Error('app-server has not started');
    this.write({ method, params });
  }

  /**
   * 应答 Agent 发起的请求（ACP 的 `session/request_permission` 等）。
   * 只负责写回一帧、不追踪幂等 —— 调用方保证每个 inbound id 只应答一次。
   * 与 `request`/`notify` 不同：这条给"对端主动发来、带 id 的请求"回话，
   * 是 ACP 客户端能跑真实会话的前置（Codex app-server 方言从不发入站请求，故其现有路径不受影响）。
   */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  subscribe(listener: (message: JsonRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => {
        child.off('exit', exited);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const exited = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', exited);
    });
    child.kill('SIGTERM');
    if (await waitForExit(this.stopGraceMs)) return;
    child.kill('SIGKILL');
    if (await waitForExit(Math.max(this.stopGraceMs, 1_000))) return;
    throw new Error('app-server did not exit after SIGTERM and SIGKILL');
  }

  private write(message: JsonRecord): void {
    if (!this.child?.stdin.writable) throw new Error('app-server stdin is not writable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
