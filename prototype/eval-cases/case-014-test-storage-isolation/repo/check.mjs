const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/preferences.mjs'); } catch (err) { fail('src/preferences.mjs 加载失败: ' + err.message); }
const memStorage = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const storageA = memStorage();
const prefsA = mod.createPreferences(storageA);
prefsA.set('theme', 'dark');
const storageB = memStorage();
const prefsB = mod.createPreferences(storageB);
const fresh = prefsB.get('theme', 'light');
if (fresh !== 'light') fail('独立 storage 读到了别人的值（模块级缓存串仓）: ' + JSON.stringify(fresh));
const prefsA2 = mod.createPreferences(storageA);
const persisted = prefsA2.get('theme', 'light');
if (persisted !== 'dark') fail('同一 storage 重建实例后值丢了: ' + JSON.stringify(persisted));
console.log('ok');
