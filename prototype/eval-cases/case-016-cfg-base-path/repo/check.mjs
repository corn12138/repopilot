const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/config/base-url.mjs'); } catch (err) { fail('src/config/base-url.mjs 加载失败: ' + err.message); }
const table = [
  ['assetUrl', '/', 'assets/logo.svg', '/assets/logo.svg'],
  ['assetUrl', '/repo-pilot/', 'assets/logo.svg', '/repo-pilot/assets/logo.svg'],
  ['assetUrl', '/repo-pilot', 'assets/logo.svg', '/repo-pilot/assets/logo.svg'],
  ['routeHref', '/', '/runs/42', '/runs/42'],
  ['routeHref', '/repo-pilot/', '/runs/42', '/repo-pilot/runs/42'],
  ['routeHref', '/repo-pilot', '/runs/42', '/repo-pilot/runs/42'],
];
for (const [fn, base, path, expected] of table) {
  const got = mod[fn](base, path);
  if (got !== expected) fail(fn + '(' + JSON.stringify(base) + ', ' + JSON.stringify(path) + ') 应为 ' + expected + '，实际 ' + JSON.stringify(got));
  if (/\/\//.test(got)) fail('出现连续斜杠: ' + got);
}
console.log('ok');
