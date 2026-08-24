import { readFileSync } from 'node:fs';
const s = readFileSync('src/app.js', 'utf8');
if (!s.includes('fixed')) { console.error('still broken'); process.exit(1); }
console.log('ok');
