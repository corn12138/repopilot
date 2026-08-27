const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/router-app.mjs'); } catch (err) { fail('src/router-app.mjs 加载失败: ' + err.message); }
const router = mod.buildRouter();
if (router.resolve('/') !== 'home') fail('/ 应解析到 home: ' + JSON.stringify(router.resolve('/')));
if (router.resolve('/runs') !== 'runs') fail('/runs 应解析到 runs: ' + JSON.stringify(router.resolve('/runs')));
if (router.resolve('/unknown') !== 'navigate:/404') fail('未知路径应跳转 /404: ' + JSON.stringify(router.resolve('/unknown')));
console.log('ok');
