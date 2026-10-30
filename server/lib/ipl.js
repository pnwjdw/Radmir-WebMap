import { decodeText, forEachSectionLine, num } from './text.js';

const SERVICE = ['zone', 'cull', 'grge', 'enex', 'pick', 'cars', 'jump', 'tcyc', 'auzo', 'mult', 'occl', 'path'];
const KEYWORDS = ['inst', ...SERVICE];

function nums(f, from, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(num(f[from + i]));
  return out;
}
const bad = (arr) => arr.some((v) => Number.isNaN(v));

function parseInst(f, line, raw, index) {
  const n = f.length;
  let r;
  if (n >= 13) {
    const p = nums(f, 3, 10);
    r = { format: 'VC', interior: num(f[2]), pos: p.slice(0, 3), scale: p.slice(3, 6), rot: p.slice(6, 10), lod: -1 };
  } else if (n === 12) {
    const p = nums(f, 2, 10);
    r = { format: 'III', interior: 0, pos: p.slice(0, 3), scale: p.slice(3, 6), rot: p.slice(6, 10), lod: -1 };
  } else if (n === 11 || n === 10) {
    const p = nums(f, 3, 7);
    r = { format: 'SA', interior: num(f[2]), pos: p.slice(0, 3), rot: p.slice(3, 7), lod: n === 11 ? num(f[10]) : -1 };
  } else return { error: `inst: ожидалось 10–13 полей, найдено ${n}` };
  r.id = num(f[0]);
  r.model = (f[1] || '').trim();
  if (!Number.isInteger(r.id)) return { error: 'inst: ID не целое число' };
  if (bad(r.pos) || bad(r.rot) || (r.scale && bad(r.scale)) || Number.isNaN(r.interior) || Number.isNaN(r.lod)) return { error: 'inst: нечисловое значение координат, поворота, интерьера или LOD' };
  r.index = index; r.line = line; r.raw = raw.trim();
  return r;
}

function parseService(section, f) {
  const v = (i) => num(f[i]);
  switch (section) {
    case 'zone': return f.length >= 9 ? { name: f[0], type: v(1), min: [v(2), v(3), v(4)], max: [v(5), v(6), v(7)], level: v(8), text: f[9] || '' } : null;
    case 'grge': return f.length >= 11 ? { pos: [v(0), v(1), v(2)], line: [v(3), v(4)], cube: [v(5), v(6), v(7)], door: v(8), type: v(9), name: f[10] } : null;
    case 'enex': return f.length >= 14 ? { pos: [v(0), v(1), v(2)], angle: v(3), size: [v(4), v(5)], exit: [v(7), v(8), v(9)], exitAngle: v(10), interior: v(11), flags: v(12), name: (f[13] || '').replace(/"/g, ''), sky: v(14), timeOn: v(16), timeOff: v(17) } : null;
    case 'pick': return f.length >= 4 ? { item: v(0), pos: [v(1), v(2), v(3)] } : null;
    case 'cars': return f.length >= 7 ? { pos: [v(0), v(1), v(2)], angle: v(3), model: v(4), colors: [v(5), v(6)], forceSpawn: v(7), alarm: v(8), doorLock: v(9) } : null;
    case 'cull': return f.length >= 3 ? { center: [v(0), v(1), v(2)], values: f.slice(3).map(num) } : null;
    case 'auzo': return f.length >= 7 ? (f.length >= 9 ? { name: f[0], id: v(1), on: v(2), min: [v(3), v(4), v(5)], max: [v(6), v(7), v(8)] } : { name: f[0], id: v(1), on: v(2), center: [v(3), v(4), v(5)], radius: v(6) }) : null;
    case 'occl': return f.length >= 6 ? { center: [v(0), v(1), v(2)], size: [v(3), v(4), v(5)], rot: f.slice(6, 9).map(num) } : null;
    case 'tcyc': return f.length >= 6 ? { min: [v(0), v(1), v(2)], max: [v(3), v(4), v(5)], values: f.slice(6).map(num) } : null;
    case 'jump': return f.length >= 12 ? { startMin: [v(0), v(1), v(2)], startMax: [v(3), v(4), v(5)], targetMin: [v(6), v(7), v(8)], targetMax: [v(9), v(10), v(11)] } : null;
    default: return { fields: f };
  }
}

export function parseTextIpl(buf) {
  const text = decodeText(buf);
  const out = { kind: 'text', inst: [], service: {}, unsupported: [], diagnostics: [], lines: 0 };
  let ordinal = 0;
  out.lines = forEachSectionLine(text, (section, f, line, raw) => {
    if (section === 'inst') {
      const r = parseInst(f, line, raw, ordinal++);
      if (r.error) out.diagnostics.push({ line, raw: raw.trim(), message: `${r.error} (запись №${ordinal - 1} пропущена, номера LOD сохранены)` });
      else out.inst.push(r);
    } else {
      if (!out.service[section]) out.service[section] = [];
      const p = parseService(section, f);
      if (!p) out.diagnostics.push({ line, raw: raw.trim(), message: `${section}: мало полей (${f.length})` });
      else out.service[section].push({ ...p, line, raw: raw.trim() });
    }
  }, (d) => out.diagnostics.push(d), KEYWORDS);
  return out;
}

export function parseBinaryIpl(buf) {
  const out = { kind: 'binary', inst: [], service: {}, unsupported: [], diagnostics: [], header: null };
  if (buf.length < 76) { out.diagnostics.push({ offset: 0, message: `файл короче заголовка (${buf.length} из 76 байт)` }); return out; }
  const h = (i) => buf.readInt32LE(4 + i * 4);
  const numInst = h(0), numCars = h(4), offInst = buf.readInt32LE(28), offCars = buf.readInt32LE(60);
  out.header = { numInst, unknown: [h(1), h(2), h(3), h(5)], numCars, offInst, offCars };
  for (let i = 0; i < numInst; i++) {
    const o = offInst + i * 40;
    if (o + 40 > buf.length) { out.diagnostics.push({ offset: o, message: `запись ${i} выходит за пределы файла (${numInst} заявлено)` }); break; }
    out.inst.push({
      index: i, offset: o, format: 'SA binary',
      pos: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      rot: [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20), buf.readFloatLE(o + 24)],
      id: buf.readInt32LE(o + 28), interior: buf.readInt32LE(o + 32), lod: buf.readInt32LE(o + 36), model: '',
      raw: buf.subarray(o, o + 40).toString('hex'),
    });
  }
  if (numCars > 0) {
    out.service.cars = [];
    for (let i = 0; i < numCars; i++) {
      const o = offCars + i * 48;
      if (o + 48 > buf.length) { out.diagnostics.push({ offset: o, message: `машина ${i} выходит за пределы файла` }); break; }
      out.service.cars.push({ offset: o, pos: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)], angle: buf.readFloatLE(o + 12), model: buf.readInt32LE(o + 16), colors: [buf.readInt32LE(o + 20), buf.readInt32LE(o + 24)] });
    }
  }
  return out;
}

export function parseIpl(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'bnry') return parseBinaryIpl(buf);
  return parseTextIpl(buf);
}

export function worldQuat(rot) {
  return [-rot[0], -rot[1], -rot[2], rot[3]];
}

export function decodeInterior(value) {
  const v = value | 0;
  const flags = [];
  if (v & 0x100) flags.push('бит 8 (0x100): «под водой» по описанию движка SA');
  if (v & 0x200) flags.push('бит 9 (0x200): «тоннель»');
  if (v & 0x400) flags.push('бит 10 (0x400): «переход тоннеля»');
  if (v & 0x800) flags.push('бит 11 (0x800): «неважный стриминг»');
  if (v >>> 12) flags.push(`старшие биты 0x${(v >>> 12).toString(16)}: значение неизвестно`);
  return { raw: value, area: v & 0xff, flags };
}
