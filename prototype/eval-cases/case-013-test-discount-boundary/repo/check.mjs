const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/discount.mjs'); } catch (err) { fail('src/discount.mjs 加载失败: ' + err.message); }
const near = (a, b) => Math.abs(a - b) < 1e-9;
if (!near(mod.finalPrice(99.99), 99.99)) fail('99.99 不满 100，应原价: ' + mod.finalPrice(99.99));
if (!near(mod.finalPrice(100), 90)) fail('100 应打九折得 90: ' + mod.finalPrice(100));
if (!near(mod.finalPrice(100.01), 90.009)) fail('100.01 应打九折得 90.009: ' + mod.finalPrice(100.01));
if (!near(mod.finalPrice(0), 0)) fail('0 应得 0: ' + mod.finalPrice(0));
let threw = false;
try { mod.finalPrice(-1); } catch { threw = true; }
if (!threw) fail('负数金额必须抛错');
console.log('ok');
