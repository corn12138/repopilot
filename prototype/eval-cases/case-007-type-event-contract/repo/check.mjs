const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/debounced-input.mjs'); } catch (err) { fail('src/debounced-input.mjs 加载失败: ' + err.message); }
let handler = null;
const field = { subscribe(fn) { handler = fn; } };
const got = [];
mod.attachInput(field, (value) => got.push(value));
if (typeof handler !== 'function') fail('attachInput 没有订阅输入事件');
handler({ value: 'a' });
handler({ value: 'ab' });
for (const v of got) { if (typeof v !== 'string') fail('onChange 收到的不是字符串: ' + JSON.stringify(v)); }
if (JSON.stringify(got) !== JSON.stringify(['a', 'ab'])) fail('onChange 收到的值序列不对: ' + JSON.stringify(got));
console.log('ok');
