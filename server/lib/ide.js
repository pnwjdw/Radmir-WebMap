import { decodeText, forEachSectionLine, num } from './text.js';

export const MODEL_SECTIONS = ['objs', 'tobj', 'anim', 'weap', 'cars', 'peds', 'hier'];
const KEYWORDS = [...MODEL_SECTIONS, 'txdp', '2dfx', 'path', 'tanm'];

export const OBJECT_FLAGS = [
  [0x1, 'IS_ROAD (дорога, влажная поверхность)'], [0x4, 'DRAW_LAST (прозрачность, рисуется последней)'], [0x8, 'ADDITIVE (аддитивное смешивание)'],
  [0x40, 'NO_ZBUFFER_WRITE'], [0x80, 'DONT_RECEIVE_SHADOWS'], [0x200, 'IS_GLASS_TYPE_1'], [0x400, 'IS_GLASS_TYPE_2'],
  [0x800, 'IS_GARAGE_DOOR'], [0x1000, 'IS_DAMAGABLE'], [0x2000, 'IS_TREE'], [0x4000, 'IS_PALM'],
  [0x8000, 'DOES_NOT_COLLIDE_WITH_FLYER'], [0x100000, 'IS_TAG'], [0x200000, 'DISABLE_BACKFACE_CULLING'], [0x400000, 'IS_BREAKABLE_STATUE'],
];
export function decodeObjectFlags(flags) {
  return OBJECT_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name);
}

function modelDef(section, f, line, raw) {
  const d = { section, id: num(f[0]), model: (f[1] || '').trim(), txd: (f[2] || '').trim(), line, raw: raw.trim(), drawDist: [], flags: 0, extra: {} };
  if (!Number.isInteger(d.id)) return { error: 'ID не целое число' };
  if (!d.model) return { error: 'нет имени модели' };
  const n = f.length;
  if (section === 'objs' || section === 'tobj') {
    const base = section === 'tobj' ? n - 2 : n;
    if (section === 'tobj') { d.extra.timeOn = num(f[n - 2]); d.extra.timeOff = num(f[n - 1]); }
    if (base === 5 && num(f[3]) < 4 && Math.trunc(num(f[3])) === 1) {
      d.extra.meshCount = 1; d.drawDist = [num(f[4])]; d.flags = num(f[4]);
      d.extra.layout = 'по правилу игры: дальность < 4 → старый формат (id, model, txd, meshCount, drawDist), флаги из первого чтения';
    } else if (base === 5) { d.drawDist = [num(f[3])]; d.flags = num(f[4]); d.extra.layout = 'SA: id, model, txd, drawDist, flags'; }
    else if (base >= 6) {
      const meshes = num(f[3]);
      d.extra.meshCount = meshes;
      d.drawDist = f.slice(4, base - 1).map(num);
      d.flags = num(f[base - 1]);
      d.extra.layout = 'III/VC: id, model, txd, meshCount, drawDist…, flags';
    } else if (base === 4) { d.drawDist = [num(f[3])]; d.extra.layout = 'id, model, txd, drawDist (без флагов)'; }
    else return { error: `ожидалось 5–8 полей, найдено ${n}` };
  } else if (section === 'anim') {
    d.extra.animFile = f[3]; d.drawDist = [num(f[4])]; d.flags = num(f[5]);
  } else if (section === 'weap') {
    d.extra.animName = f[3];
    if (n >= 7) { d.extra.meshCount = num(f[4]); d.drawDist = [num(f[5])]; d.flags = num(f[6]); } else { d.drawDist = [num(f[4])]; d.flags = num(f[5]); }
  } else if (section === 'cars') {
    Object.assign(d.extra, { type: f[3], handling: f[4], gameName: f[5], anims: f[6], class: f[7], frequency: num(f[8]), level: f[9], compRules: f[10] });
    if (n >= 12) {
      const opt = (i, def) => (n > i && !Number.isNaN(num(f[i])) ? num(f[i]) : def);
      Object.assign(d.extra, { wheelId: opt(11, -1), wheelScaleFront: opt(12, 1), wheelScaleRear: opt(13, 1), upgradeClass: opt(14, -1) });
    }
  } else if (section === 'peds') {
    Object.assign(d.extra, { pedType: f[3], stats: f[4], animGroup: f[5], carsCanDrive: f[6], pedFlags: f[7], animFile: f[8], radio1: f[9], radio2: f[10], voiceArchive: f[11], voice1: f[12], voice2: f[13] });
  }
  if (Number.isNaN(d.flags)) { d.flags = 0; d.extra.flagsUnreadable = true; }
  d.drawDist = d.drawDist.filter((v) => !Number.isNaN(v));
  return d;
}

export function parseIde(buf) {
  const text = decodeText(buf);
  const out = { defs: [], txdp: [], service: [], unsupported: [], diagnostics: [], lines: 0 };
  const sectionLines = new Map();
  out.lines = forEachSectionLine(text, (section, f, line, raw) => {
    if (MODEL_SECTIONS.includes(section)) {
      const d = modelDef(section, f, line, raw);
      if (d.error) out.diagnostics.push({ line, raw: raw.trim(), message: `${section}: ${d.error}` });
      else out.defs.push(d);
    } else if (section === 'txdp') {
      if (f.length >= 2) out.txdp.push({ child: f[0], parent: f[1], line, raw: raw.trim() });
      else out.diagnostics.push({ line, raw: raw.trim(), message: 'txdp: ожидалось 2 поля' });
    } else {
      if (!sectionLines.has(section)) sectionLines.set(section, []);
      sectionLines.get(section).push({ line, raw: raw.trim() });
    }
  }, (d) => out.diagnostics.push(d), KEYWORDS);
  for (const [name, lines] of sectionLines) out.service.push({ section: name, count: lines.length, lines: lines.slice(0, 200) });
  return out;
}
