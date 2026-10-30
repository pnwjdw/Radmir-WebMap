import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.js';

const SECTION_CODE = { objs: 'o', tobj: 't', anim: 'a', weap: 'w', cars: 'c', peds: 'p', hier: 'h' };

function oldCatalogTags() {
  const tags = new Map();
  try {
    const text = fs.readFileSync(path.join(APP_ROOT, 'data', 'catalog.js'), 'utf8');
    const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    for (const f of data.files) {
      const src = data.sources[f.s];
      if (!src) continue;
      tags.set(`${src.p.replace(/\\/g, '/').toLowerCase()}|${f.n.toLowerCase()}`, f.c);
    }
  } catch {}
  return tags;
}

export function buildLibrary(cat, world) {
  const tags = oldCatalogTags();
  const defsByName = new Map();
  for (const d of cat.defs) {
    const k = d.model.toLowerCase();
    if (!defsByName.has(k)) defsByName.set(k, []);
    defsByName.get(k).push(d.did);
  }
  const containers = new Map();
  const items = [];
  for (const r of cat.res) {
    const f = cat.files[r.fid];
    if (r.kind !== 'dff' || f.root === 'import') continue;
    if (!containers.has(r.fid)) containers.set(r.fid, { fid: r.fid, path: f.rel, active: world.imgOrder.has(r.fid) });
    const defs = (defsByName.get(r.base) || []).map((did) => {
      const d = cat.defs[did];
      const chosen = world.chosenDef.get(d.id) === did;
      return [d.id, SECTION_CODE[d.section] || '?', chosen ? 1 : world.activeIde.includes(d.fid) ? 2 : 0, d.txd];
    });
    const it = { r: r.rid, n: r.name, f: r.fid, d: defs };
    if (r.dff && !r.dff.error) { it.tri = r.dff.tris; if (r.dff.skin) it.sk = 1; if (r.dff.bsphere) it.rad = Math.round(r.dff.bsphere[3] * 10) / 10; }
    if (r.err) it.err = r.err;
    const t = tags.get(`${f.rel.toLowerCase()}|${r.lower}`);
    if (t) it.tg = t;
    items.push(it);
  }
  const miByRid = new Map();
  for (const m of world.models) if (m.dff >= 0 && !miByRid.has(m.dff)) miByRid.set(m.dff, m.mi);
  for (const it of items) if (miByRid.has(it.r)) it.mi = miByRid.get(it.r);
  return { containers: [...containers.values()], items, sections: SECTION_CODE };
}

export function search(cat, world, q, limit = 40) {
  const s = q.trim().toLowerCase();
  const out = { query: q, definitions: [], resources: [], files: [], collisions: [], instances: [], models: [] };
  if (!s) return out;
  const asNum = /^\d+$/.test(s) ? Number(s) : null;
  if (asNum !== null) {
    for (const did of cat.defsById.get(asNum) || []) out.definitions.push(defBrief(cat, world, did));
    const mi = world.modelById.get(asNum);
    if (mi !== undefined) {
      out.models.push(modelBrief(world, mi));
      for (const i of (world.byModel.get(mi) || []).slice(0, limit)) out.instances.push(instBrief(cat, world, i, 'model'));
    }
    if (asNum < world.count) out.instances.push(instBrief(cat, world, asNum, 'iid'));
  }
  const iidMatch = /^iid[:#]?(\d+)$/.exec(s);
  if (iidMatch && Number(iidMatch[1]) < world.count) out.instances.push(instBrief(cat, world, Number(iidMatch[1]), 'iid'));
  if (s.includes('#')) { const i = world.findStable(q.trim()); if (i >= 0) out.instances.push(instBrief(cat, world, i, 'stable')); }
  if (s.length >= 2) {
    for (const d of cat.defs) {
      if (out.definitions.length >= limit) break;
      if (d.model.toLowerCase().includes(s) || (d.txd && d.txd.toLowerCase() === s)) out.definitions.push(defBrief(cat, world, d.did));
    }
    for (const m of world.models) {
      if (out.models.length >= limit) break;
      if (m.name.toLowerCase().includes(s) || (m.txd && m.txd.toLowerCase().includes(s))) out.models.push(modelBrief(world, m.mi));
    }
    for (const r of cat.res) {
      if (out.resources.length >= limit) break;
      const f = cat.files[r.fid];
      if (f.root !== 'import' && r.lower.includes(s)) {
        out.resources.push({ rid: r.rid, name: r.name, kind: r.kind, container: f.rel, active: world.imgOrder.has(r.fid), error: r.err });
      }
    }
    for (const f of cat.files) {
      if (out.files.length >= limit) break;
      if (f.root !== 'import' && f.lower.includes(s)) out.files.push({ key: f.key, path: f.rel, root: f.root, kind: f.kind, size: f.size });
    }
    for (const [name, list] of cat.colIndex) {
      if (out.collisions.length >= limit) break;
      if (name.includes(s)) for (const c of list.slice(0, 3)) out.collisions.push({ name: c.n, rid: c.rid, index: c.i, version: c.v, container: cat.res[c.rid].name, active: world.imgOrder.has(cat.res[c.rid].fid) });
    }
  }
  return out;
}

function defBrief(cat, world, did) {
  const d = cat.defs[did];
  return { did, id: d.id, model: d.model, txd: d.txd, section: d.section, file: cat.files[d.fid].rel, line: d.line, chosen: world.chosenDef.get(d.id) === did, active: world.activeIde.includes(d.fid) };
}
function modelBrief(world, mi) {
  const m = world.models[mi];
  return { mi, id: m.id, name: m.name, txd: m.txd, section: m.section, placements: (world.byModel.get(mi) || []).length, dff: m.dff };
}
function instBrief(cat, world, i, how) {
  const mi = world.inst.mi[i];
  return { iid: i, stable: world.stableId(i), model: mi >= 0 ? world.models[mi].name : null, id: world.inst.id[i], pos: [...world.inst.pos.subarray(i * 3, i * 3 + 3)], how };
}
