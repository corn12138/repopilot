const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/avatar.mjs'); } catch (err) { fail('src/avatar.mjs 加载失败: ' + err.message); }
let withUrl;
try { withUrl = mod.avatarLabel({ name: 'Ada Wong', avatarUrl: '  https://x/y.png  ' }); } catch (err) { fail('有头像的分支崩溃: ' + err.message); }
if (withUrl !== 'img:https://x/y.png') fail('有头像的输出不对: ' + JSON.stringify(withUrl));
let withNull;
try { withNull = mod.avatarLabel({ name: 'Ada Wong', avatarUrl: null }); } catch (err) { fail('avatarUrl 为 null 时崩溃: ' + err.message); }
if (withNull !== 'initials:AW') fail('null 头像应显示首字母: ' + JSON.stringify(withNull));
console.log('ok');
