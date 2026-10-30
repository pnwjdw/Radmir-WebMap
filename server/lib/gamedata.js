import { decodeText, stripComment, splitFields } from './text.js';

export function parseCarcols(buf) {
  const out = { colors: [], cars: {}, diagnostics: [] };
  let section = null;
  decodeText(buf).split(/\r?\n/).forEach((raw, i) => {
    const s = stripComment(raw);
    if (!s) return;
    const low = s.toLowerCase();
    if (!section) { if (['col', 'car', 'car4'].includes(low)) section = low; return; }
    if (low === 'end') { section = null; return; }
    const f = splitFields(s.replace(/\./g, ','));
    if (section === 'col') {
      const [r, g, b] = f.map(Number);
      if ([r, g, b].some(Number.isNaN)) out.diagnostics.push({ line: i + 1, raw, message: 'цвет не из трёх чисел' });
      else out.colors.push([r, g, b]);
    } else {
      const name = f[0].toLowerCase();
      const values = f.slice(1).map(Number).filter((v) => !Number.isNaN(v));
      const step = section === 'car4' ? 4 : 2;
      const sets = [];
      for (let k = 0; k + step <= values.length; k += step) sets.push(values.slice(k, k + step));
      out.cars[name] = { sets, line: i + 1, section };
    }
  });
  return out;
}

export function parseSurfinfo(buf) {
  const names = [];
  for (const raw of decodeText(buf).split(/\r?\n/)) {
    const s = stripComment(raw);
    if (!s) continue;
    const name = s.split(/\s+/)[0];
    if (/^[A-Z0-9_]+$/i.test(name)) names.push(name);
  }
  return names;
}

export function parseWater(buf) {
  const quads = [];
  const diagnostics = [];
  decodeText(buf).split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith('#') || /^processed/i.test(s)) return;
    const v = s.split(/\s+/).map(Number);
    if (v.some(Number.isNaN)) { diagnostics.push({ line: i + 1, raw, message: 'нечисловое значение' }); return; }
    const n = v.length === 29 ? 4 : v.length === 22 ? 3 : 0;
    if (!n) { diagnostics.push({ line: i + 1, raw: raw.slice(0, 80), message: `неожиданное число полей ${v.length}` }); return; }
    const pts = [];
    for (let k = 0; k < n; k++) pts.push([v[k * 7], v[k * 7 + 1], v[k * 7 + 2]]);
    quads.push({ line: i + 1, points: pts, flag: v[v.length - 1] });
  });
  return { quads, diagnostics };
}

const KEY_SIZE = { 1: 20, 2: 32, 3: 10, 4: 16 };
function walkIfp(buf, onTrack) {
  const cstr = (o, n) => { const s = buf.toString('latin1', o, o + n); const z = s.indexOf('\0'); return z >= 0 ? s.slice(0, z) : s; };
  const name = cstr(8, 24), count = buf.readUInt32LE(32);
  const anims = [];
  let o = 36, error = null;
  for (let i = 0; i < count && !error; i++) {
    if (o + 36 > buf.length) { error = `анимация ${i}: заголовок за концом файла`; break; }
    const an = { name: cstr(o, 24), objects: buf.readUInt32LE(o + 24), dataSize: buf.readUInt32LE(o + 28), compressed: buf.readUInt32LE(o + 32) === 1, frames: 0 };
    o += 36;
    for (let j = 0; j < an.objects; j++) {
      if (o + 36 > buf.length) { error = `«${an.name}», дорожка ${j}: заголовок за концом файла`; break; }
      const type = buf.readUInt32LE(o + 24), n = buf.readUInt32LE(o + 28), bone = buf.readInt32LE(o + 32);
      const per = KEY_SIZE[type];
      if (!per || o + 36 + n * per > buf.length) { error = `«${an.name}», дорожка ${j}: тип ключей ${type}, ключей ${n} — данные не помещаются`; break; }
      an.frames = Math.max(an.frames, n);
      if (onTrack) onTrack(an, { name: cstr(o, 24), type, keys: n, bone, at: o + 36 });
      o += 36 + n * per;
    }
    anims.push(an);
  }
  return { name, count, anims, error };
}

export function parseIfpHeader(buf) {
  const sig = buf.toString('latin1', 0, 4);
  if (sig !== 'ANP3') return { format: sig, error: sig === 'ANPK' ? 'формат ANPK (GTA III/VC) — читается только заголовок' : 'не IFP' };
  const r = walkIfp(buf);
  return { format: sig, name: r.name, count: r.count, anims: r.anims.map(({ name, objects, frames, dataSize }) => ({ name, objects, frames, dataSize })), error: r.error || undefined };
}

export function ifpFirstKeys(buf, animName) {
  if (buf.toString('latin1', 0, 4) !== 'ANP3') return null;
  const want = animName.toLowerCase();
  const keys = new Map();
  let found = false;
  walkIfp(buf, (an, t) => {
    if (an.name.toLowerCase() !== want || !t.keys) return;
    found = true;
    const o = t.at;
    const packed = t.type >= 3;
    const rot = packed ? [0, 1, 2, 3].map((k) => buf.readInt16LE(o + k * 2) / 4096) : [0, 1, 2, 3].map((k) => buf.readFloatLE(o + k * 4));
    let pos = null;
    if (t.type === 4) pos = [0, 1, 2].map((k) => buf.readInt16LE(o + 10 + k * 2) / 1024);
    else if (t.type === 2) pos = [0, 1, 2].map((k) => buf.readFloatLE(o + 20 + k * 4));
    keys.set(t.bone, { name: t.name, rot, pos });
  });
  return found ? keys : null;
}
