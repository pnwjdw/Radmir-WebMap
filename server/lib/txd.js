import { CHUNK, children, versionString } from './rw.js';

const RASTER_FORMATS = { 0x0000: 'DEFAULT', 0x0100: 'C1555', 0x0200: 'C565', 0x0300: 'C4444', 0x0400: 'LUM8', 0x0500: 'C8888', 0x0600: 'C888', 0x0700: 'D16', 0x0800: 'D24', 0x0900: 'D32', 0x0a00: 'C555' };
const D3D_FORMATS = { 21: 'A8R8G8B8', 22: 'X8R8G8B8', 23: 'R5G6B5', 24: 'X1R5G5B5', 25: 'A1R5G5B5', 26: 'A4R4G4B4', 28: 'A8', 41: 'P8', 50: 'L8', 51: 'A8L8', 0x31545844: 'DXT1', 0x32545844: 'DXT2', 0x33545844: 'DXT3', 0x34545844: 'DXT4', 0x35545844: 'DXT5' };
const PLATFORMS = { 8: 'D3D8 (PC)', 9: 'D3D9 (PC)', 5: 'Xbox', 0x00325350: 'PS2' };

function cstr(buf, off, len) {
  let s = buf.toString('latin1', off, off + len);
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

function parseNative(buf, c, index) {
  const parts = children(buf, c.start, c.end);
  const st = parts.find((p) => p.type === CHUNK.STRUCT);
  const t = { index, name: '', mask: '', platform: null, platformName: '', supported: false, error: null };
  if (!st || st.size < 88) { t.error = 'Texture Native без структуры'; return t; }
  let o = st.start;
  t.platform = buf.readUInt32LE(o);
  t.platformName = PLATFORMS[t.platform] || `0x${t.platform.toString(16)}`;
  const filterFlags = buf.readUInt32LE(o + 4);
  t.filter = filterFlags & 0xff; t.addressU = (filterFlags >> 8) & 0xf; t.addressV = (filterFlags >> 12) & 0xf;
  t.name = cstr(buf, o + 8, 32);
  t.mask = cstr(buf, o + 40, 32);
  if (t.platform !== 8 && t.platform !== 9) { t.error = `платформа ${t.platformName} не поддерживается`; return t; }
  o += 72;
  t.rasterFormat = buf.readUInt32LE(o);
  const fmt = t.rasterFormat & 0x0f00;
  t.formatName = RASTER_FORMATS[fmt] || `0x${fmt.toString(16)}`;
  t.paletted = (t.rasterFormat & 0x2000) ? 8 : (t.rasterFormat & 0x4000) ? 4 : 0;
  t.mipmapFlag = (t.rasterFormat & 0x8000) !== 0;
  t.autoMipmap = (t.rasterFormat & 0x1000) !== 0;
  const fourOrAlpha = buf.readUInt32LE(o + 4);
  t.width = buf.readUInt16LE(o + 8); t.height = buf.readUInt16LE(o + 10);
  t.depth = buf[o + 12]; t.levels = buf[o + 13]; t.rasterType = buf[o + 14];
  const comp = buf[o + 15];
  o += 16;
  if (t.platform === 8) {
    t.hasAlpha = fourOrAlpha !== 0;
    t.compression = comp ? `DXT${comp}` : null;
  } else {
    t.d3dFormat = fourOrAlpha;
    t.d3dFormatName = D3D_FORMATS[fourOrAlpha] || String(fourOrAlpha);
    t.hasAlpha = (comp & 1) !== 0;
    t.cube = (comp & 2) !== 0;
    t.compression = (comp & 8) ? (D3D_FORMATS[fourOrAlpha] || 'DXT?') : (/^DXT/.test(t.d3dFormatName) ? t.d3dFormatName : null);
  }
  if (t.paletted) {
    const n = t.paletted === 8 ? 256 : (t.platform === 9 ? 32 : 32);
    t.paletteOffset = o; t.paletteSize = n * 4;
    o += n * 4;
  }
  t.mips = [];
  let w = t.width, h = t.height;
  for (let l = 0; l < t.levels && o + 4 <= st.end; l++) {
    const size = buf.readUInt32LE(o);
    if (o + 4 + size > st.end) { t.error = `уровень ${l} выходит за пределы структуры`; break; }
    t.mips.push({ level: l, width: w, height: h, offset: o + 4, size });
    o += 4 + size;
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }
  t.encoding = t.compression ? t.compression.toLowerCase() : (t.paletted ? `pal${t.paletted}` : t.formatName.toLowerCase());
  t.supported = !t.error && (['dxt1', 'dxt3', 'dxt5'].includes(t.encoding) || ['c8888', 'c888', 'c565', 'c1555', 'c4444', 'c555', 'lum8', 'pal8', 'pal4'].includes(t.encoding));
  if (!t.supported && !t.error) t.error = `формат ${t.encoding} не поддерживается`;
  t.dataBytes = t.mips.reduce((s, m) => s + m.size, 0);
  return t;
}

export function parseTxd(buf) {
  const res = { rw: null, count: 0, device: null, textures: [], error: null, warnings: [] };
  const top = children(buf, 0, buf.length);
  const dict = top.find((c) => c.type === CHUNK.TEXDICT);
  if (!dict) { res.error = top.length ? `нет чанка Texture Dictionary (0x16); первый чанк 0x${top[0].type.toString(16)}` : 'файл пуст или не RenderWare'; return res; }
  res.rw = { version: dict.version, text: versionString(dict.version) };
  let i = 0;
  for (const c of children(buf, dict.start, dict.end)) {
    if (c.type === CHUNK.STRUCT) {
      if (dict.version >= 0x35000 || c.size === 4) { res.count = buf.readUInt16LE(c.start); res.device = buf.readUInt16LE(c.start + 2); }
      else res.count = buf.readUInt32LE(c.start);
    } else if (c.type === CHUNK.TEXNATIVE) res.textures.push(parseNative(buf, c, i++));
  }
  if (res.count && res.count !== res.textures.length) res.warnings.push(`заявлено ${res.count} текстур, прочитано ${res.textures.length}`);
  return res;
}

function expand5(v) { return (v << 3) | (v >> 2); }
function expand6(v) { return (v << 2) | (v >> 4); }
function expand4(v) { return (v << 4) | v; }

function convertLevel(buf, t, mip) {
  const n = mip.width * mip.height;
  const out = Buffer.alloc(n * 4);
  const src = buf.subarray(mip.offset, mip.offset + mip.size);
  const e = t.encoding;
  if (e === 'c8888' || e === 'c888') {
    for (let i = 0; i < n; i++) {
      out[i * 4] = src[i * 4 + 2]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4];
      out[i * 4 + 3] = e === 'c888' ? 255 : src[i * 4 + 3];
    }
  } else if (e === 'c565' || e === 'c1555' || e === 'c4444' || e === 'c555') {
    for (let i = 0; i < n; i++) {
      const v = src.readUInt16LE(i * 2);
      let r, g, b, a = 255;
      if (e === 'c565') { r = expand5(v >> 11); g = expand6((v >> 5) & 63); b = expand5(v & 31); }
      else if (e === 'c4444') { a = expand4(v >> 12); r = expand4((v >> 8) & 15); g = expand4((v >> 4) & 15); b = expand4(v & 15); }
      else { r = expand5((v >> 10) & 31); g = expand5((v >> 5) & 31); b = expand5(v & 31); if (e === 'c1555') a = v & 0x8000 ? 255 : 0; }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
    }
  } else if (e === 'lum8') {
    for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i]; out[i * 4 + 3] = 255; }
  } else if (e === 'pal8' || e === 'pal4') {
    const pal = buf.subarray(t.paletteOffset, t.paletteOffset + t.paletteSize);
    const packed = e === 'pal4' && src.length < n;
    for (let i = 0; i < n; i++) {
      const idx = packed ? (i & 1 ? src[i >> 1] >> 4 : src[i >> 1] & 15) : src[i];
      out[i * 4] = pal[idx * 4]; out[i * 4 + 1] = pal[idx * 4 + 1]; out[i * 4 + 2] = pal[idx * 4 + 2]; out[i * 4 + 3] = pal[idx * 4 + 3];
    }
  }
  return out;
}

export function textureData(buf, t) {
  if (!t.supported) throw new Error(t.error || 'текстура не поддерживается');
  const dxt = ['dxt1', 'dxt3', 'dxt5'].includes(t.encoding);
  const mips = t.mips.filter((m) => m.size > 0).map((m) => ({ width: m.width, height: m.height, data: dxt ? buf.subarray(m.offset, m.offset + m.size) : convertLevel(buf, t, m) }));
  return { encoding: dxt ? t.encoding : 'rgba8', width: t.width, height: t.height, alpha: !!t.hasAlpha, mips };
}

function color565(c) { return [expand5(c >> 11), expand6((c >> 5) & 63), expand5(c & 31)]; }

export function decodeToRgba(tex) {
  const m = tex.mips[0];
  if (tex.encoding === 'rgba8') return { width: m.width, height: m.height, data: m.data };
  const w = m.width, h = m.height, src = m.data;
  const out = Buffer.alloc(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const blockSize = tex.encoding === 'dxt1' ? 8 : 16;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = (by * bw + bx) * blockSize;
    if (b + blockSize > src.length) continue;
    const cOff = tex.encoding === 'dxt1' ? b : b + 8;
    const c0 = src.readUInt16LE(cOff), c1 = src.readUInt16LE(cOff + 2);
    const p0 = color565(c0), p1 = color565(c1);
    const pal = [[...p0, 255], [...p1, 255]];
    if (c0 > c1 || tex.encoding !== 'dxt1') {
      pal.push([0, 1, 2].map((k) => ((2 * p0[k] + p1[k]) / 3) | 0).concat(255), [0, 1, 2].map((k) => ((p0[k] + 2 * p1[k]) / 3) | 0).concat(255));
    } else {
      pal.push([0, 1, 2].map((k) => ((p0[k] + p1[k]) / 2) | 0).concat(255), [0, 0, 0, 0]);
    }
    const bits = src.readUInt32LE(cOff + 4);
    let alpha = null;
    if (tex.encoding === 'dxt3') {
      alpha = [];
      for (let k = 0; k < 16; k++) alpha.push(((src[b + (k >> 1)] >> ((k & 1) * 4)) & 15) * 17);
    } else if (tex.encoding === 'dxt5') {
      const a0 = src[b], a1 = src[b + 1];
      const ap = [a0, a1];
      if (a0 > a1) for (let k = 1; k < 7; k++) ap.push((((7 - k) * a0 + k * a1) / 7) | 0);
      else { for (let k = 1; k < 5; k++) ap.push((((5 - k) * a0 + k * a1) / 5) | 0); ap.push(0, 255); }
      let abits = 0n;
      for (let k = 0; k < 6; k++) abits |= BigInt(src[b + 2 + k]) << BigInt(8 * k);
      alpha = [];
      for (let k = 0; k < 16; k++) alpha.push(ap[Number((abits >> BigInt(3 * k)) & 7n)]);
    }
    for (let k = 0; k < 16; k++) {
      const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
      if (x >= w || y >= h) continue;
      const p = pal[(bits >>> (2 * k)) & 3];
      const q = (y * w + x) * 4;
      out[q] = p[0]; out[q + 1] = p[1]; out[q + 2] = p[2]; out[q + 3] = alpha ? alpha[k] : p[3];
    }
  }
  return { width: w, height: h, data: out };
}
