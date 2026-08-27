const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/config/env.mjs'); } catch (err) { fail('src/config/env.mjs 加载失败: ' + err.message); }
const got = mod.apiBaseUrl({ VITE_API_URL: 'https://api.example.test/' });
if (got !== 'https://api.example.test') fail('应读取注入的 VITE_API_URL 并去掉尾斜杠: ' + JSON.stringify(got));
for (const env of [{}, { VITE_API_URL: '' }, { VITE_API_URL: '   ' }]) {
  let threw = false;
  try { mod.apiBaseUrl(env); } catch (err) { threw = /VITE_API_URL/.test(err.message); }
  if (!threw) fail('缺失/空的 VITE_API_URL 必须抛出点名它的错误: ' + JSON.stringify(env));
}
console.log('ok');
