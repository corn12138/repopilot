const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/dashboard.mjs'); } catch (err) { fail('src/dashboard.mjs 加载失败: ' + err.message); }
if (mod.statusView('loading') !== '加载中…') fail('loading 分支不对: ' + JSON.stringify(mod.statusView('loading')));
if (mod.statusView('error') !== '加载失败，可重试') fail('error 分支不对: ' + JSON.stringify(mod.statusView('error')));
if (mod.statusView('success') !== '就绪') fail('success 分支不对: ' + JSON.stringify(mod.statusView('success')));
let threw = false;
try { mod.statusView('bogus'); } catch { threw = true; }
if (!threw) fail('未知状态必须抛错，不能静默返回');
console.log('ok');
