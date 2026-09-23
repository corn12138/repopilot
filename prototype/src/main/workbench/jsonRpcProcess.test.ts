import { describe, expect, it } from 'vitest';
import { JsonRpcProcess } from './jsonRpcProcess';

const respondingScript = String.raw`
  process.on('SIGTERM', () => {});
  process.stdin.setEncoding('utf8');
  let buffered = '';
  process.stdin.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line);
      if (typeof message.id === 'number') {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
      }
    }
  });
`;

describe('JsonRpcProcess', () => {
  it('子进程无法 spawn 时让首个请求明确失败', async () => {
    const rpc = new JsonRpcProcess('/definitely/missing/repopilot-app-server', [], process.env, 20);
    await expect(rpc.request('initialize', {}, 1_000)).rejects.toThrow(/ENOENT|spawn/i);
  });

  it('坏 JSON 帧会产生协议错误事件，不会静默消失', async () => {
    const script = `process.stdout.write('not-json\\n');${respondingScript}`;
    const rpc = new JsonRpcProcess(process.execPath, ['-e', script], process.env, 20);
    const methods: string[] = [];
    rpc.subscribe((message) => {
      if (typeof message.method === 'string') methods.push(message.method);
    });
    try {
      await rpc.request('initialize', {});
      expect(methods).toContain('transport/protocolError');
    } finally {
      await rpc.stop();
    }
  });

  it('SIGTERM 后仍存活时升级到 SIGKILL，并等待退出后才返回', async () => {
    const rpc = new JsonRpcProcess(process.execPath, ['-e', respondingScript], process.env, 20);
    await rpc.request('initialize', {});
    await expect(rpc.stop()).resolves.toBeUndefined();
  });
});
