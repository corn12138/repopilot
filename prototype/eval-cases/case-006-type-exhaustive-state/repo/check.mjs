const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/run-state.mjs'); } catch (err) { fail('src/run-state.mjs 加载失败: ' + err.message); }
const seen = new Set();
for (const state of mod.RUN_STATES) {
  let label;
  try { label = mod.labelFor(state); } catch (err) { fail('状态 ' + state + ' 没有文案: ' + err.message); }
  if (typeof label !== 'string' || label.trim() === '') fail('状态 ' + state + ' 的文案为空');
  if (seen.has(label)) fail('状态 ' + state + ' 的文案与其他状态重复: ' + label);
  seen.add(label);
}
let threw = false;
try { mod.labelFor('bogus'); } catch (err) { threw = /未处理的状态/.test(err.message); }
if (!threw) fail('穷尽检查被移除了：未知状态必须抛「未处理的状态」');
console.log('ok');
