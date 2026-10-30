import { parseDff, applySkin, atomicFrameMatrix, defaultAtomicVisible } from './dff.js';
import { readResource, txdOf } from './resources.js';

export function textureChain(world, cat, { txdRid = -1, txdName = null, vehicle = false } = {}) {
  const chain = [];
  const seen = new Set();
  let rid = txdRid, name = txdName;
  if (rid < 0 && name) rid = world.resolveName(`${name.toLowerCase()}.txd`).rid;
  else if (rid >= 0) name = cat.res[rid].base;
  let reason = 'TXD из определения IDE';
  for (let guard = 0; guard < 8 && name; guard++) {
    if (rid >= 0 && !seen.has(rid)) { chain.push({ rid, name: cat.res[rid].name, file: cat.files[cat.res[rid].fid].key, reason }); seen.add(rid); }
    const parent = world.txdParent.get(name.toLowerCase());
    if (!parent) break;
    name = parent;
    rid = world.resolveName(`${parent}.txd`).rid;
    reason = `родитель по секции txdp «${parent}»`;
  }
  if (vehicle) {
    for (const k of ['game-import:models/generic/vehicle.txd', 'game-import:CustomSAA2/VEHICLE.TXD']) {
      const r = cat.resByKey.get(k);
      if (r !== undefined && !seen.has(r)) { chain.push({ rid: r, name: cat.res[r].name, file: k, reason: 'общие текстуры машин (движок SA)' }); seen.add(r); }
    }
  }
  return chain;
}

function texturesFor(cat, chain, names) {
  const found = {}, missing = [];
  for (const n of names) {
    const low = n.toLowerCase();
    let hit = null;
    for (const c of chain) {
      let t;
      try { t = txdOf(cat, c.rid); } catch { continue; }
      const tex = t.byName.get(low);
      if (tex) { hit = { rid: c.rid, txd: c.name, name: tex.name, w: tex.width, h: tex.height, e: tex.encoding, a: tex.hasAlpha ? 1 : 0, levels: tex.levels, supported: tex.supported, error: tex.error || undefined }; break; }
    }
    if (hit) found[low] = hit; else missing.push(n);
  }
  return { found, missing };
}

export function packModel(cat, world, rid, chain, pose = null) {
  const buf = readResource(cat, rid);
  const d = parseDff(buf, { data: true });
  if (d.error) throw new Error(d.error);
  applySkin(d, pose);
  const parts = [];
  let offset = 0;
  const add = (arr) => {
    if (!arr) return null;
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
    const at = offset;
    parts.push(b); offset += b.length;
    return [at, arr.length];
  };
  const texNames = new Set();
  const geometries = d.geometries.map((g) => {
    const data = g.data;
    const out = {
      index: g.index, vertices: g.numVertices, triangles: g.numTriangles, renderTriangles: g.renderTriangles, trianglesFrom: g.trianglesFrom, materialMismatch: g.materialMismatch || 0, badVertices: g.badVertices || 0,
      uvSets: g.numUV, prelit: g.prelit, normals: g.normals, nightColors: g.nightColors, format: g.format, bsphere: g.bsphere, bbox: g.bbox,
      native: g.native, skin: g.skin, skinApplied: !!g.skinApplied, binMesh: g.binMesh, effects2d: g.effects2d, extensions: g.extensions, warnings: g.warnings,
      materials: g.materials.map((m) => {
        if (m.texture && m.texture.name) texNames.add(m.texture.name);
        return { color: m.color, textured: m.textured, texture: m.texture ? m.texture.name : null, mask: m.texture ? m.texture.mask : null, filter: m.texture ? m.texture.filter : null, addressU: m.texture ? m.texture.addressU : null, addressV: m.texture ? m.texture.addressV : null, matFx: m.matFx, effects: m.effects, ambient: m.ambient, specular: m.specular, diffuse: m.diffuse };
      }),
      groups: [], buffers: {},
    };
    if (!data || !data.position || !data.triangles) return out;
    const nt = data.triangles.length / 3;
    const nm = Math.max(1, g.materials.length);
    const byMat = Array.from({ length: nm + 1 }, () => []);
    for (let t = 0; t < nt; t++) { const m = data.triMaterial[t]; byMat[m < nm ? m : nm].push(t); }
    const wide = g.numVertices > 65535;
    const idx = wide ? new Uint32Array(nt * 3) : new Uint16Array(nt * 3);
    const tri = new Uint32Array(nt);
    let k = 0;
    byMat.forEach((list, m) => {
      if (!list.length) return;
      out.groups.push({ material: m < nm ? m : -1, start: k * 3, count: list.length * 3 });
      for (const t of list) { idx[k * 3] = data.triangles[t * 3]; idx[k * 3 + 1] = data.triangles[t * 3 + 1]; idx[k * 3 + 2] = data.triangles[t * 3 + 2]; tri[k] = data.triSource ? data.triSource[t] : t; k++; }
    });
    out.buffers.position = add(data.position);
    out.buffers.normal = add(data.normal);
    if (data.uv[0]) out.buffers.uv0 = add(data.uv[0]);
    if (data.uv[1]) out.buffers.uv1 = add(data.uv[1]);
    out.buffers.color = add(data.color);
    out.buffers.night = add(data.night);
    out.buffers.index = add(idx);
    out.buffers.tri = add(tri);
    out.indexType = wide ? 'u32' : 'u16';
    return out;
  });
  const tex = chain ? texturesFor(cat, chain, texNames) : { found: {}, missing: [...texNames] };
  const header = {
    rid, key: cat.res[rid].key, name: cat.res[rid].name, rw: d.rw, warnings: d.warnings, clumps: d.clumps, lights: d.lights, cameras: d.cameras,
    frames: d.frames.map((f) => ({ name: f.name, parent: f.parent, rot: f.rot, pos: f.pos, bone: f.hanim ? f.hanim.boneId : undefined, bones: f.hanim && f.hanim.bones ? f.hanim.bones.length : undefined })),
    atomics: d.atomics.map((a) => {
      const fr = d.frames[a.frame];
      const name = fr ? fr.name : '';
      return { frame: a.frame, geometry: a.geometry, flags: a.flags, name, visible: defaultAtomicVisible(name), ltm: atomicFrameMatrix(d, a, true), pipeline: a.pipeline, rightToRender: a.rightToRender };
    }),
    geometries, textures: tex.found, missingTextures: tex.missing, chain: chain || [], embeddedCollision: !!d.collision, uvAnimDict: d.uvAnimDict,
  };
  const hj = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(8);
  head.write('RMG1', 0, 'latin1');
  head.writeUInt32LE(hj.length, 4);
  const pad = (4 - ((8 + hj.length) % 4)) % 4;
  return Buffer.concat([head, hj, Buffer.alloc(pad), ...parts]);
}
