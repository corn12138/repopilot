const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/app.mjs'); } catch (err) { fail('src/app.mjs 加载失败: ' + err.message); }
const out = mod.classes('btn', { active: true, hidden: false });
if (out !== 'btn active') fail('classes 输出不对: ' + JSON.stringify(out));
console.log('ok');
