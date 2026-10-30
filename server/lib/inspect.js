import { parseDff } from './dff.js';
import { readResource, txdOf } from './resources.js';
import { parseColModel } from './col.js';
import { decodeObjectFlags } from './ide.js';
import { decodeInterior } from './ipl.js';
import { textureChain } from './geompack.js';
import { SECTOR } from './img.js';

function fileRef(cat, fid) {
  const f = cat.files[fid];
  return { key: f.key, root: f.root, path: f.rel, kind: f.kind, size: f.size };
}

export function resourceRef(cat, rid) {
  if (rid < 0) return null;
  const r = cat.res[rid];
  const f = cat.files[r.fid];
  return {
    rid, key: r.key, name: r.name, kind: r.kind, container: { key: f.key, path: f.rel, kind: f.kind },
    entry: r.entry, offsetBytes: r.entry >= 0 ? r.offset * 2048 : 0, offsetSectors: r.entry >= 0 ? r.offset : null, sizeBytes: r.bytes, sizeSectors: r.entry >= 0 ? r.sectors : null,
    error: r.err, mismatch: r.mismatch,
  };
}

function defRef(cat, world, did) {
  const d = cat.defs[did];
  const active = world.activeIde.includes(d.fid);
  return {
    did, key: d.key, file: fileRef(cat, d.fid), line: d.line, raw: d.raw, section: d.section, id: d.id, model: d.model, txd: d.txd,
    drawDist: d.drawDist, flags: d.flags, flagNames: ['objs', 'tobj'].includes(d.section) ? decodeObjectFlags(d.flags) : [], extra: d.extra,
    active, chosen: world.chosenDef.get(d.id) === did,
  };
}

function candidateList(cat, world, lower) {
  const r = world.resolveName(lower);
  return {
    chosen: resourceRef(cat, r.rid), reason: r.reason,
    candidates: r.candidates.map((rid) => ({ ...resourceRef(cat, rid), activeArchive: world.imgOrder.has(cat.res[rid].fid), loadOrder: world.imgOrder.has(cat.res[rid].fid) ? world.imgOrder.get(cat.res[rid].fid) : null })),
  };
}

export function dffStructure(cat, rid) {
  const buf = readResource(cat, rid);
  const d = parseDff(buf, { data: false, tree: true });
  if (d.error) return { error: d.error };
  return {
    rw: d.rw, clumps: d.clumps, topChunks: d.topChunks, tree: d.tree, lights: d.lights, cameras: d.cameras, warnings: d.warnings, uvAnimDict: d.uvAnimDict,
    numAtomicsDeclared: d.numAtomicsDeclared, embeddedCollision: d.collision,
    frames: d.frames.map((f) => ({ index: f.index, name: f.name, parent: f.parent, pos: f.pos, rot: f.rot, flags: f.flags, hanim: f.hanim ? { boneId: f.hanim.boneId, numBones: f.hanim.numBones, bones: f.hanim.bones ? f.hanim.bones.slice(0, 64) : undefined } : null })),
    atomics: d.atomics,
    geometries: d.geometries.map((g) => { const { data, ...rest } = g; return rest; }),
  };
}

export function colSummary(cat, world, m) {
  if (m.col) {
    const r = cat.res[m.col.rid];
    const entry = r.col && r.col.models[m.col.i];
    const all = (cat.colIndex.get(m.name.toLowerCase()) || []).map((c) => ({ ...resourceRef(cat, c.rid), modelIndex: c.i, version: c.v, activeArchive: world.imgOrder.has(cat.res[c.rid].fid) }));
    return { status: 'found', source: resourceRef(cat, m.col.rid), modelIndex: m.col.i, header: entry, alternatives: all, reason: 'COL-модель с тем же именем в активном IMG (первая по порядку подключения)' };
  }
  if (m.embeddedCol) return { status: 'embedded', reason: 'коллизия хранится внутри DFF (плагин Collision Model), как у машин' };
  const anywhere = cat.colIndex.get(m.name.toLowerCase());
  if (anywhere && anywhere.length) return { status: 'inactive', reason: 'COL-модель есть только в неактивных архивах', alternatives: anywhere.map((c) => resourceRef(cat, c.rid)) };
  return { status: 'none', reason: 'ни в одном COL нет модели с этим именем, и в DFF нет встроенной коллизии' };
}

export function colModelData(cat, rid, index) {
  const r = cat.res[rid];
  const buf = readResource(cat, rid);
  if (r.kind === 'dff') {
    const d = parseDff(buf, { data: false });
    if (!d.collision) throw new Error('в DFF нет встроенной коллизии');
    return parseColModel(buf, d.collision.offset);
  }
  const m = r.col && r.col.models[index];
  if (!m) throw new Error('модель коллизии не найдена');
  return parseColModel(buf, m.o);
}

export function textureReport(cat, world, chain, names) {
  const out = [];
  for (const n of names) {
    const low = n.toLowerCase();
    let hit = null;
    for (const c of chain) {
      let t;
      try { t = txdOf(cat, c.rid); } catch { continue; }
      const tex = t.byName.get(low);
      if (tex) {
        hit = { name: tex.name, txd: c.name, rid: c.rid, width: tex.width, height: tex.height, encoding: tex.encoding, rasterFormat: tex.formatName, d3dFormat: tex.d3dFormatName, platform: tex.platformName, levels: tex.levels, mipsRead: tex.mips.length, alpha: tex.hasAlpha, mask: tex.mask, supported: tex.supported, error: tex.error, bytes: tex.dataBytes, filter: tex.filter, addressU: tex.addressU, addressV: tex.addressV };
        break;
      }
    }
    out.push(hit || { name: n, missing: true });
  }
  return out;
}

export function inspectModel(cat, world, mi) {
  const m = world.models[mi];
  if (!m) return { error: 'модель не найдена' };
  const def = defRef(cat, world, m.did);
  const alternatives = (cat.defsById.get(m.id) || []).map((did) => defRef(cat, world, did));
  const dff = candidateList(cat, world, `${m.name.toLowerCase()}.dff`);
  const txd = m.txd ? candidateList(cat, world, `${m.txd.toLowerCase()}.txd`) : null;
  const chain = textureChain(world, cat, { txdRid: m.txdRid, txdName: m.txd, vehicle: m.vehicleTex });
  let structure = null, textures = [];
  if (m.dff >= 0) {
    try {
      structure = dffStructure(cat, m.dff);
      const names = new Set();
      for (const g of structure.geometries || []) for (const mat of g.materials) if (mat.texture && mat.texture.name) names.add(mat.texture.name);
      textures = textureReport(cat, world, chain, [...names]);
    } catch (e) { structure = { error: String(e.message || e) }; }
  }
  const placements = world.byModel.get(mi) || [];
  const conflicts = [];
  if (alternatives.filter((a) => a.active).length > 1) conflicts.push(`ID ${m.id} определён в ${alternatives.filter((a) => a.active).length} активных IDE; выбран ${def.file.path}:${def.line} (${world.profile.overrides.ide[m.id] ? 'вручную' : 'правило «последний загруженный»'})`);
  if (alternatives.some((a) => !a.active)) conflicts.push(`ещё ${alternatives.filter((a) => !a.active).length} определений этого ID в неактивных IDE`);
  if (dff.candidates.length > 1) conflicts.push(`DFF «${m.name}.dff»: ${dff.candidates.length} вариантов, ${dff.reason}`);
  const missing = [];
  if (m.dff < 0) missing.push(`DFF «${m.name}.dff»: ${dff.reason}`);
  if (txd && m.txdRid < 0) missing.push(`TXD «${m.txd}.txd»: ${txd.reason}`);
  for (const t of textures) if (t.missing) missing.push(`текстура «${t.name}» не найдена в цепочке TXD`);
  return {
    model: { mi, id: m.id, name: m.name, section: m.section, clump: m.clump, drawDistance: m.dd, flags: m.flags, bsphere: m.bs || null, bbox: m.bb || null, triangles: m.tris || 0 },
    definition: def, alternatives, dff, txd, txdChain: chain, structure, textures,
    collision: colSummary(cat, world, m),
    placements: { count: placements.length, list: placements.slice(0, 500).map((i) => ({ iid: i, stable: world.stableId(i), pos: [...world.inst.pos.subarray(i * 3, i * 3 + 3)], interior: world.inst.interior[i] })) },
    conflicts, missing,
    computed: ['bbox/bsphere модели — посчитаны по вершинам видимых атомиков', 'drawDistance — максимум дистанций из IDE'],
  };
}

export function inspectInstance(cat, world, iid) {
  if (!(iid >= 0 && iid < world.count)) return { error: 'размещение не найдено' };
  const s = world.sources[world.inst.src[iid]];
  const ipl = cat.ipls[s.pid];
  const rec = ipl.rec.inst.find((r) => r.i === world.inst.index[iid]);
  const lod = world.inst.lod[iid];
  const children = world.children.get(iid) || [];
  const q = [...world.inst.quat.subarray(iid * 4, iid * 4 + 4)];
  const out = {
    iid, stable: world.stableId(iid),
    source: { key: s.key, name: s.name, kind: s.kind, stream: s.stream, orphan: s.orphan, baseText: s.base, manifestLine: s.manifestItem, container: ipl.entry >= 0 ? resourceRef(cat, ipl.rid) : fileRef(cat, ipl.fid) },
    record: rec ? { section: 'inst', index: rec.i, line: rec.ln || null, offset: rec.of !== undefined ? rec.of : null, fields: rec, format: rec.f || (ipl.kind === 'binary' ? 'SA binary' : 'SA') } : null,
    original: rec ? { id: rec.id, modelName: rec.m || null, pos: rec.p, rotation: rec.r, interior: decodeInterior(rec.in), lodIndex: rec.l, scale: rec.s || null } : null,
    applied: { pos: [...world.inst.pos.subarray(iid * 3, iid * 3 + 3)], quaternionWorld: q, note: 'кватернион IPL хранит обратный поворот; применяется сопряжённый (−x, −y, −z, w)' },
    lod: lod >= 0 ? { iid: lod, stable: world.stableId(lod), model: world.inst.mi[lod] >= 0 ? world.models[world.inst.mi[lod]].name : null } : null,
    lodChildren: children.slice(0, 50).map((c) => ({ iid: c, stable: world.stableId(c), model: world.inst.mi[c] >= 0 ? world.models[world.inst.mi[c]].name : null })),
    duplicateOf: (world.inst.flags[iid] & 2) ? (world.conflicts.duplicates.find((d) => d.iid === iid) || {}).of : null,
    model: world.inst.mi[iid] >= 0 ? inspectModel(cat, world, world.inst.mi[iid]) : { error: `ID ${world.inst.id[iid]} не определён ни в одном активном IDE`, definitionsAnywhere: (cat.defsById.get(world.inst.id[iid]) || []).map((did) => defRef(cat, world, did)) },
  };
  if (rec && rec.m && out.model && out.model.model && rec.m.toLowerCase() !== out.model.model.name.toLowerCase()) {
    out.nameNote = rec.m.toLowerCase() === 'dummy' ? 'в IPL записано имя «dummy»: модель взята по ID' : `в IPL записано «${rec.m}», а ID ${rec.id} в выбранном IDE — «${out.model.model.name}»: модель взята по ID`;
  }
  return out;
}

export function inspectResource(cat, world, rid) {
  const r = cat.res[rid];
  if (!r) return { error: 'ресурс не найден' };
  const out = { resource: resourceRef(cat, rid), activeArchive: world.imgOrder.has(r.fid) };
  const base = r.base;
  if (r.kind === 'dff') {
    try { out.structure = dffStructure(cat, rid); } catch (e) { out.structure = { error: String(e.message || e) }; }
    out.definitions = [];
    for (const d of cat.defs) if (d.model.toLowerCase() === base) out.definitions.push(defRef(cat, world, d.did));
    const mi = world.models.findIndex((m) => m.dff === rid);
    out.modelIndex = mi;
    out.chosenFor = world.models.filter((m) => m.dff === rid).map((m) => ({ mi: m.mi, id: m.id, name: m.name }));
    out.sameName = candidateList(cat, world, r.lower);
  } else if (r.kind === 'txd') {
    try {
      const t = txdOf(cat, rid);
      out.txd = { rw: t.rw, count: t.count, device: t.device, warnings: t.warnings, textures: t.textures.map((x) => ({ name: x.name, mask: x.mask, width: x.width, height: x.height, encoding: x.encoding, rasterFormat: x.formatName, d3dFormat: x.d3dFormatName, platform: x.platformName, levels: x.levels, alpha: x.hasAlpha, supported: x.supported, error: x.error, bytes: x.dataBytes })) };
    } catch (e) { out.txd = { error: String(e.message || e) }; }
    out.usedBy = world.models.filter((m) => m.txdRid === rid).slice(0, 300).map((m) => ({ mi: m.mi, id: m.id, name: m.name }));
    out.parent = world.txdParent.get(base) || null;
  } else if (r.kind === 'col') {
    out.col = r.col;
  } else if (r.kind === 'ipl-binary' || r.kind === 'ipl') {
    const ipl = cat.ipls.find((x) => x.rid === rid);
    out.ipl = ipl ? { kind: ipl.kind, header: ipl.rec.header, count: ipl.rec.inst.length, streamOf: ipl.streamOf, active: world.sources.some((s) => s.pid === ipl.pid) } : null;
  } else if (r.kind === 'ifp') out.ifp = r.ifp;
  else if (r.kind === 'nodes') out.nodes = r.nodes;
  return out;
}
