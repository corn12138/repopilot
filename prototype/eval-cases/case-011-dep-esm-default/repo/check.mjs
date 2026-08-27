const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/report.mjs'); } catch (err) { fail('src/report.mjs 加载失败: ' + err.message); }
const out = mod.report(['B a', 'B a', 'c']);
if (out !== 'b-a,c') fail('report 输出不对: ' + JSON.stringify(out));
console.log('ok');
