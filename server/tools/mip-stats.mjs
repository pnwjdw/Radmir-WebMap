import path from 'node:path';
import { DECRYPTED } from '../lib/config.js';
import { readImgDirectory, readEntry } from '../lib/img.js';
import { parseTxd } from '../lib/txd.js';

const stats = { textures: 0, single: 0, singleAuto: 0, multi: 0, auto: 0, mipFlag: 0 };
const files = ['radm_t_1', 'radm_t_5', 'radm_t_9', 'radm_t_15', 'radm_t_19', 'gta_3', 'vice_2'].map((n) => path.join(DECRYPTED, 'models', 'img', `${n}.img`));
for (const f of files) {
  const d = readImgDirectory(f);
  for (const e of d.entries) {
    if (!e.lower.endsWith('.txd') || !e.sectors) continue;
    const t = parseTxd(readEntry(f, e));
    for (const x of t.textures) {
      if (!x.supported) continue;
      stats.textures++;
      if (x.autoMipmap) stats.auto++;
      if (x.mipmapFlag) stats.mipFlag++;
      if (x.levels <= 1) { stats.single++; if (x.autoMipmap) stats.singleAuto++; } else stats.multi++;
    }
  }
}
console.log(stats);
