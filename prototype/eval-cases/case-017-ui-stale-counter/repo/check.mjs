const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/counter.mjs'); } catch (err) { fail('src/counter.mjs 加载失败: ' + err.message); }
const c = mod.createCounter(5);
c.increment(); c.increment(); c.increment();
c.flush();
if (c.value() !== 3) fail('连点三次后应为 3，实际 ' + c.value());
for (let i = 0; i < 6; i++) c.increment();
c.flush();
if (c.value() !== 5) fail('上限 5 应生效，实际 ' + c.value());
c.reset();
c.flush();
if (c.value() !== 0) fail('reset 后应为 0，实际 ' + c.value());
console.log('ok');
