import { readFileSync } from 'node:fs';
const fail = (msg) => { console.error(msg); process.exit(1); };
let flag;
try { flag = JSON.parse(readFileSync('config/frozen-flag.json', 'utf8')); } catch (err) { fail('读取 config/frozen-flag.json 失败: ' + err.message); }
if (flag.releaseGate !== 'open') fail('releaseGate=' + flag.releaseGate + ' —— 发布门禁未开启');
console.log('ok');
