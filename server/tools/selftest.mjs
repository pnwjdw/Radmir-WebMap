import fs from 'node:fs';
import path from 'node:path';
import { DECRYPTED } from '../lib/config.js';
import { readImgDirectory, readEntry, sniff } from '../lib/img.js';
import { parseDff, summarizeDff } from '../lib/dff.js';
import { parseTxd, textureData, decodeToRgba } from '../lib/txd.js';
import { listColModels, parseColModel } from '../lib/col.js';
import { parseIde } from '../lib/ide.js';
import { parseIpl } from '../lib/ipl.js';

const t0 = Date.now();
const img = path.join(DECRYPTED, 'models', 'img', 'radm_1.img');
const dir = readImgDirectory(img);
console.log('radm_1.img entries', dir.count, 'diag', dir.diagnostics.length);
const kinds = {};
for (const e of dir.entries) {
  const head = readEntry(img, { offset: e.offset, sectors: 1 }).subarray(0, 16);
  const k = sniff(head).kind;
  kinds[k] = (kinds[k] || 0) + 1;
}
console.log('kinds by content', kinds);
const dffE = dir.entries.find((e) => e.lower === '13connsmallrd.dff');
const dff = parseDff(readEntry(img, dffE), { tree: true });
console.log('dff', dff.rw, 'frames', dff.frames.map((f) => f.name), 'atomics', dff.atomics.length, 'geoms', dff.geometries.map((g) => ({ v: g.numVertices, t: g.numTriangles, uv: g.numUV, prelit: g.prelit, normals: g.normals, night: g.nightColors, mats: g.materials.map((m) => m.texture && m.texture.name), from: g.trianglesFrom, bin: g.binMesh })));
console.log('summary', summarizeDff(readEntry(img, dffE)));

for (let i = 1; i <= 23; i++) {
  const f = path.join(DECRYPTED, 'models', 'img', `radm_t_${i}.img`);
  const d = readImgDirectory(f);
  const e = d.entries.find((x) => x.lower === 'yuzn_roads.txd');
  if (!e) continue;
  const buf = readEntry(f, e);
  const txd = parseTxd(buf);
  console.log(`yuzn_roads.txd in radm_t_${i}`, txd.rw, txd.textures.length, txd.textures.slice(0, 4).map((t) => [t.name, t.width, t.height, t.encoding, t.levels, t.hasAlpha, t.supported]));
  const td = textureData(buf, txd.textures[0]);
  const rgba = decodeToRgba(td);
  console.log('decoded', td.encoding, td.mips.length, rgba.width, rgba.height, rgba.data.subarray(0, 8));
  break;
}
const cimg = path.join(DECRYPTED, 'models', 'img', 'radm_c_1.img');
const cd = readImgDirectory(cimg);
const colE = cd.entries.find((e) => e.lower.endsWith('.col'));
const colBuf = readEntry(cimg, colE);
const cl = listColModels(colBuf);
console.log('col', colE.name, cl.models.length, cl.models.slice(0, 3).map((m) => [m.name, m.version, m.counts]), cl.diagnostics);
const full = parseColModel(colBuf, cl.models[0].offset);
console.log('col model', full.name, full.version, full.spheres.length, full.boxes.length, full.vertices.length, full.faces.length, full.faceGroups.length, full.shadowFaces.length, full.warnings);
const ide = parseIde(fs.readFileSync(path.join(DECRYPTED, 'data', 'maps', 'sopki', 'sopki.ide')));
console.log('sopki.ide defs', ide.defs.length, ide.defs[0], 'diag', ide.diagnostics.slice(0, 3), 'service', ide.service.map((s) => s.section), 'unsupported', ide.unsupported.map((s) => s.section));
const ipl = parseIpl(fs.readFileSync(path.join(DECRYPTED, 'data', 'maps', 'sopki', 'sopki.ipl')));
console.log('sopki.ipl inst', ipl.inst.length, ipl.inst[0], 'diag', ipl.diagnostics.slice(0, 3), Object.keys(ipl.service));
for (const f of ['SAMP\\SAMP.ide', 'data\\maps\\output\\SAMP.ide']) {
  const d = parseIde(fs.readFileSync(path.join(DECRYPTED, f))).defs.find((x) => x.id === 18632);
  console.log('18632 in', f, d && d.raw);
}
const gimg = path.join(DECRYPTED, 'models', 'img', 'radm_c_1.img');
const sd = readImgDirectory(gimg);
const se = sd.entries.find((e) => e.lower.endsWith('.ipl'));
const sb = parseIpl(readEntry(gimg, se));
console.log('stream', se.name, sb.kind, sb.header, sb.inst.slice(0, 2), sb.diagnostics.slice(0, 2));
console.log('ms', Date.now() - t0);
