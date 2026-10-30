import path from 'node:path';
import { DECRYPTED } from '../lib/config.js';
import { readImgDirectory, readEntry } from '../lib/img.js';
import { parseTxd, textureData, decodeToRgba } from '../lib/txd.js';
import { withMipChain } from '../lib/dxtgen.js';

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; se += (a[i] - b[i]) ** 2; }
  const mse = se / (a.length * 0.75);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
function halve(src, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
    let s = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { s += src[(Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * 4 + c]; n++; }
    out[(y * nw + x) * 4 + c] = s / n;
  }
  return { data: out, width: nw, height: nh };
}

const f = path.join(DECRYPTED, 'models', 'img', 'radm_t_15.img');
const d = readImgDirectory(f);
let tested = 0, worst = Infinity;
const byFormat = {};
for (const e of d.entries) {
  if (!e.lower.endsWith('.txd') || tested >= 60) continue;
  const buf = readEntry(f, e);
  const t = parseTxd(buf);
  for (const x of t.textures) {
    if (!x.supported || x.levels !== 1 || tested >= 60) continue;
    const td = textureData(buf, x);
    const gen = withMipChain(td);
    let ref = decodeToRgba({ encoding: td.encoding, mips: [td.mips[0]] });
    for (let l = 1; l < Math.min(gen.mips.length, 4); l++) {
      ref = halve(ref.data, ref.width, ref.height);
      const got = decodeToRgba({ encoding: td.encoding, mips: [gen.mips[l]] });
      if (got.width !== ref.width || got.height !== ref.height) throw new Error(`size mismatch ${x.name} level ${l}`);
      const p = psnr(got.data, ref.data);
      worst = Math.min(worst, p);
      (byFormat[td.encoding] = byFormat[td.encoding] || []).push(p);
    }
    const expected = Math.floor(Math.log2(Math.max(x.width, x.height))) + 1;
    if (gen.mips.length !== expected) throw new Error(`${x.name}: ${gen.mips.length} levels, expected ${expected}`);
    tested++;
  }
}
for (const [k, v] of Object.entries(byFormat)) console.log(k, 'levels', v.length, 'mean PSNR', (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1), 'min', Math.min(...v).toFixed(1));
console.log('textures', tested, 'worst PSNR', worst.toFixed(1));
