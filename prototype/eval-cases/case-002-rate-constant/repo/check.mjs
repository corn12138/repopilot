import { total } from './src/app.js';
if (total !== 120) { console.error(`total=${total}, expected 120`); process.exit(1); }
console.log('ok');
