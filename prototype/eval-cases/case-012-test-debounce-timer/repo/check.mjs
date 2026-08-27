const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/debounce.mjs'); } catch (err) { fail('src/debounce.mjs 加载失败: ' + err.message); }
const pending = new Map();
let nextId = 1;
const clock = {
  setTimeout(cb, ms) { const id = nextId++; pending.set(id, cb); return id; },
  clearTimeout(id) { pending.delete(id); },
};
const flush = () => { const cbs = [...pending.values()]; pending.clear(); for (const cb of cbs) cb(); };
const calls = [];
const d = mod.debounce((v) => calls.push(v), 50, clock);
d('a'); d('ab'); d('abc');
flush();
if (JSON.stringify(calls) !== JSON.stringify(['abc'])) fail('连续调用应只触发最后一次: ' + JSON.stringify(calls));
d('x');
d.cancel();
if (pending.size !== 0) fail('cancel 之后仍有 ' + pending.size + ' 个挂着的定时器（泄漏）');
flush();
if (calls.length !== 1) fail('cancel 之后不应再触发: ' + JSON.stringify(calls));
console.log('ok');
