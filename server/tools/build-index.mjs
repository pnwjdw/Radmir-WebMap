import { buildIndex, progress } from '../lib/indexer.js';

const force = process.argv.includes('--force');
const t0 = Date.now();
const timer = setInterval(() => {
  const cur = progress.current.map((c) => `${c.key.split('/').pop()} ${c.done}/${c.total}`).join(', ');
  console.log(`[${Math.round((Date.now() - t0) / 1000)} с] файлов ${progress.doneFiles}/${progress.totalFiles}, ${(progress.bytesDone / 1e9).toFixed(2)}/${(progress.bytesTotal / 1e9).toFixed(2)} ГБ; ${cur}`);
}, 10000);
const records = await buildIndex({ force, log: console.log });
clearInterval(timer);
const kinds = {};
let entries = 0;
const entryKinds = {};
for (const r of records) {
  kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  if (r.entries) for (const e of r.entries) { entries++; entryKinds[e.k || (e.err ? 'error' : '?')] = (entryKinds[e.k || (e.err ? 'error' : '?')] || 0) + 1; }
}
console.log('файлы по видам', kinds);
console.log('записей в IMG', entries, entryKinds);
console.log('ошибки', progress.errors.slice(0, 20));
console.log(`готово за ${Math.round((Date.now() - t0) / 1000)} с; переиндексировано ${progress.reindexed}, из кэша ${progress.reused}`);
