import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { readImgDirectory, readEntry, sniff, fdPool } from './img.js';
import { summarizeDff } from './dff.js';
import { parseTxd } from './txd.js';
import { listColModels } from './col.js';
import { parseIde } from './ide.js';
import { parseIpl } from './ipl.js';
import { parseManifest } from './dat.js';
import { parseNodes } from './nodes.js';
import { classifyBuffer } from './classify.js';
import { parseIfpHeader, parseCarcols, parseSurfinfo, parseWater } from './gamedata.js';

function txdSummary(buf) {
  const t = parseTxd(buf);
  if (t.error) return { error: t.error };
  return {
    rw: t.rw.version, warnings: t.warnings.length ? t.warnings : undefined,
    textures: t.textures.map((x) => {
      const o = { n: x.name, w: x.width, h: x.height, e: x.encoding, l: x.levels, a: x.hasAlpha ? 1 : 0 };
      if (x.mask) o.m = x.mask;
      if (!x.supported) o.err = x.error;
      return o;
    }),
  };
}

function iplRecord(p) {
  return {
    kind: p.kind, header: p.header, lines: p.lines,
    inst: p.inst.map((r) => {
      const o = { i: r.index, id: r.id, p: r.pos, r: r.rot, in: r.interior, l: r.lod };
      if (r.model) o.m = r.model;
      if (r.scale) o.s = r.scale;
      if (r.line) o.ln = r.line;
      if (r.offset !== undefined) o.of = r.offset;
      if (r.format !== 'SA' && r.format !== 'SA binary') o.f = r.format;
      return o;
    }),
    service: p.service, unsupported: p.unsupported, diagnostics: p.diagnostics,
  };
}

function entryRecord(kind, buf, name) {
  switch (kind) {
    case 'dff': return { dff: summarizeDff(buf) };
    case 'txd': return { txd: txdSummary(buf) };
    case 'col': { const c = listColModels(buf); return { col: { models: c.models.map((m) => ({ n: m.name, id: m.id, v: m.version, o: m.offset, sz: m.size, b: m.bounds, c: m.counts, f: m.flags })), diagnostics: c.diagnostics } }; }
    case 'ipl-binary': case 'ipl': return { ipl: iplRecord(parseIpl(buf)) };
    case 'ifp': { const h = parseIfpHeader(buf); return { ifp: { name: h.name, count: h.count, error: h.error, anims: h.anims ? h.anims.map((a) => a.name) : undefined } }; }
    case 'nodes': { const n = parseNodes(buf); return { nodes: n.error ? { error: n.error } : { counts: n.counts } }; }
    default: return {};
  }
}

function indexImg(abs, post) {
  const dir = readImgDirectory(abs);
  if (dir.error) return { kind: 'img', error: dir.error, entries: [] };
  const entries = [];
  const t0 = Date.now();
  dir.entries.forEach((e, i) => {
    const r = { n: e.name, o: e.offset, s: e.sectors };
    if (e.error) { r.err = e.error; entries.push(r); return; }
    if (!e.sectors) { r.k = 'empty'; entries.push(r); return; }
    let buf;
    try { buf = readEntry(abs, e); } catch (err) { r.err = `чтение: ${err.message}`; entries.push(r); return; }
    let kind = sniff(buf.subarray(0, 16)).kind;
    if (kind === 'text') kind = classifyBuffer(buf, path.extname(e.name)).kind;
    if ((kind === 'unknown' || kind === 'empty') && /^nodes\d+\.dat$/i.test(e.name)) kind = 'nodes';
    r.k = kind;
    const ext = path.extname(e.name).toLowerCase().slice(1);
    const expect = { dff: 'dff', txd: 'txd', col: 'col', ipl: kind === 'ipl' ? 'ipl' : 'ipl-binary', ifp: 'ifp' }[ext];
    if (expect && expect !== kind && !(ext === 'ipl' && (kind === 'ipl' || kind === 'ipl-binary'))) r.mismatch = `расширение .${ext}, по содержимому ${kind}`;
    try { Object.assign(r, entryRecord(kind, buf, e.name)); } catch (err) { r.err = `разбор: ${err.message}`; }
    entries.push(r);
    if (i % 250 === 0) post({ type: 'progress', done: i, total: dir.entries.length });
  });
  fdPool.closeAll();
  return { kind: 'img', count: dir.count, entries, diagnostics: dir.diagnostics, ms: Date.now() - t0 };
}

function indexLoose(abs) {
  const buf = fs.readFileSync(abs);
  const c = classifyBuffer(buf, path.extname(abs));
  const rec = { kind: c.kind, reason: c.reason };
  try {
    if (c.kind === 'ide') rec.ide = parseIde(buf);
    else if (c.kind === 'ipl' || c.kind === 'ipl-binary') rec.ipl = iplRecord(parseIpl(buf));
    else if (c.kind === 'manifest') rec.manifest = parseManifest(buf);
    else if (c.kind === 'dff' || c.kind === 'txd' || c.kind === 'col' || c.kind === 'ifp') Object.assign(rec, entryRecord(c.kind, buf, abs));
    const base = path.basename(abs).toLowerCase();
    if (base === 'carcols.dat') { rec.kind = 'carcols'; rec.carcols = parseCarcols(buf); }
    else if (base === 'surfinfo.dat') { rec.kind = 'surfinfo'; rec.surfinfo = parseSurfinfo(buf); }
    else if (base === 'water.dat') { rec.kind = 'water'; rec.water = parseWater(buf); }
  } catch (err) {
    rec.error = `разбор: ${err.message}`;
  }
  return rec;
}

parentPort.on('message', (task) => {
  const post = (m) => parentPort.postMessage({ ...m, key: task.key });
  try {
    const rec = task.img ? indexImg(task.abs, post) : indexLoose(task.abs);
    post({ type: 'done', record: rec });
  } catch (err) {
    post({ type: 'done', record: { kind: 'error', error: String(err && err.stack || err) } });
  }
});
