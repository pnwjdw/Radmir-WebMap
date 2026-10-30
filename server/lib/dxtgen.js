import { decodeToRgba } from './txd.js';

function halve(src, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy);
      const q = (sy * w + sx) * 4;
      r += src[q]; g += src[q + 1]; b += src[q + 2]; a += src[q + 3]; n++;
    }
    const o = (y * nw + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  return { data: out, width: nw, height: nh };
}

const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

function colorBlock(px, out, o, punch) {
  let lo = [255, 255, 255], hi = [0, 0, 0], any = false, transparent = false;
  for (let k = 0; k < 16; k++) {
    if (punch && px[k * 4 + 3] < 128) { transparent = true; continue; }
    any = true;
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], px[k * 4 + c]); hi[c] = Math.max(hi[c], px[k * 4 + c]); }
  }
  if (!any) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
  let c0 = to565(hi[0], hi[1], hi[2]), c1 = to565(lo[0], lo[1], lo[2]);
  const three = punch && transparent;
  if (three ? c0 > c1 : c0 < c1) [c0, c1] = [c1, c0];
  if (!three && c0 === c1) { if (c0 < 0xffff) c0++; else c1--; }
  const p0 = from565(c0), p1 = from565(c1);
  const pal = three
    ? [p0, p1, p0.map((v, i) => (v + p1[i]) / 2)]
    : [p0, p1, p0.map((v, i) => (2 * v + p1[i]) / 3), p0.map((v, i) => (v + 2 * p1[i]) / 3)];
  let bits = 0;
  for (let k = 0; k < 16; k++) {
    let best = 0;
    if (three && px[k * 4 + 3] < 128) best = 3;
    else {
      let bd = Infinity;
      pal.forEach((p, i) => {
        const d = (p[0] - px[k * 4]) ** 2 + (p[1] - px[k * 4 + 1]) ** 2 + (p[2] - px[k * 4 + 2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
    }
    bits |= best << (2 * k);
  }
  out.writeUInt16LE(c0, o); out.writeUInt16LE(c1, o + 2); out.writeUInt32LE(bits >>> 0, o + 4);
}

function alphaBlock5(px, out, o) {
  let a0 = 0, a1 = 255;
  for (let k = 0; k < 16; k++) { a0 = Math.max(a0, px[k * 4 + 3]); a1 = Math.min(a1, px[k * 4 + 3]); }
  if (a0 === a1) { out[o] = a0; out[o + 1] = a1; out.fill(0, o + 2, o + 8); return; }
  const pal = [a0, a1];
  for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  let bits = 0n;
  for (let k = 0; k < 16; k++) {
    const a = px[k * 4 + 3];
    let best = 0, bd = Infinity;
    pal.forEach((p, i) => { const d = Math.abs(p - a); if (d < bd) { bd = d; best = i; } });
    bits |= BigInt(best) << BigInt(3 * k);
  }
  out[o] = a0; out[o + 1] = a1;
  for (let i = 0; i < 6; i++) out[o + 2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
}

function alphaBlock3(px, out, o) {
  for (let k = 0; k < 16; k += 2) out[o + (k >> 1)] = (px[k * 4 + 3] >> 4) | ((px[(k + 1) * 4 + 3] >> 4) << 4);
}

function encode(level, encoding, punch) {
  const { data, width, height } = level;
  const bw = Math.max(1, (width + 3) >> 2), bh = Math.max(1, (height + 3) >> 2);
  const size = encoding === 'dxt1' ? 8 : 16;
  const out = Buffer.alloc(bw * bh * size);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let k = 0; k < 16; k++) {
      const x = Math.min(width - 1, bx * 4 + (k & 3)), y = Math.min(height - 1, by * 4 + (k >> 2));
      px.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), k * 4);
    }
    const o = (by * bw + bx) * size;
    if (encoding === 'dxt1') colorBlock(px, out, o, punch);
    else {
      if (encoding === 'dxt5') alphaBlock5(px, out, o); else alphaBlock3(px, out, o);
      colorBlock(px, out, o + 8, false);
    }
  }
  return out;
}

export function withMipChain(td) {
  if (td.mips.length !== 1 || (td.width <= 1 && td.height <= 1)) return { ...td, generatedMips: 0 };
  const base = td.mips[0];
  let level = td.encoding === 'rgba8' ? { data: base.data, width: base.width, height: base.height } : decodeToRgba({ encoding: td.encoding, mips: [base] });
  const mips = [base];
  while (level.width > 1 || level.height > 1) {
    level = halve(level.data, level.width, level.height);
    mips.push({ width: level.width, height: level.height, data: td.encoding === 'rgba8' ? level.data : encode(level, td.encoding, td.alpha) });
  }
  return { ...td, mips, generatedMips: mips.length - 1 };
}
