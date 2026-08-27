const fail = (msg) => { console.error(msg); process.exit(1); };
let mod;
try { mod = await import('./src/project-list.mjs'); } catch (err) { fail('src/project-list.mjs 加载失败: ' + err.message); }
const log = [];
const cards = mod.renderList(
  [{ id: 12, name: 'Alpha' }, { id: 7, name: 'Beta' }],
  (project) => log.push('open:' + project.id + ':' + project.name),
);
if (!Array.isArray(cards) || cards.length !== 2) fail('renderList 应返回两张卡片');
cards[0].click();
cards[1].click();
if (JSON.stringify(log) !== JSON.stringify(['open:12:Alpha', 'open:7:Beta'])) fail('点击卡片没有拿到正确的项目对象: ' + JSON.stringify(log));
console.log('ok');
