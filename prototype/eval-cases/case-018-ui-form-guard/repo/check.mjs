const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/signup-form.mjs'); } catch (err) { fail('src/signup-form.mjs 加载失败: ' + err.message); }
const calls = [];
const service = { create: (payload) => calls.push(payload) };
const empty = mod.submit({ name: '   ' }, service);
if (calls.length !== 0) fail('空姓名不应调用服务，实际调用了 ' + calls.length + ' 次');
if (!empty || empty.ok !== false) fail('空姓名应返回 ok:false');
if (!empty.error || empty.error.fieldRef !== 'name') fail('错误必须带 fieldRef="name"（辅助技术要能定位到输入框）: ' + JSON.stringify(empty.error));
if (typeof empty.error.message !== 'string' || empty.error.message.trim() === '') fail('错误必须带非空 message');
const okRes = mod.submit({ name: '  Ada  ' }, service);
if (!okRes || okRes.ok !== true) fail('合法输入应返回 ok:true');
if (calls.length !== 1) fail('合法输入应恰好调用一次服务，实际 ' + calls.length + ' 次');
if (JSON.stringify(calls[0]) !== JSON.stringify({ name: 'Ada' })) fail('提交内容应去除首尾空白: ' + JSON.stringify(calls[0]));
console.log('ok');
