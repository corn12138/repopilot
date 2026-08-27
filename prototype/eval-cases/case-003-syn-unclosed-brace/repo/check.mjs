const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/render.mjs'); } catch (err) { fail('src/render.mjs 加载失败: ' + err.message); }
const withEmail = mod.renderUserCard({ name: '甲', email: 'a@b.c' });
if (withEmail !== 'name: 甲\nemail: a@b.c') fail('有邮箱的渲染不对: ' + JSON.stringify(withEmail));
const noEmail = mod.renderUserCard({ name: '乙' });
if (noEmail !== 'name: 乙') fail('无邮箱的渲染不对: ' + JSON.stringify(noEmail));
console.log('ok');
