import { CHUNK, CHUNK_NAMES, children, readString, versionString, versionGame, chunkTree } from './rw.js';

export const EFFECT2D_TYPES = {
  0: 'свет', 1: 'частицы', 3: 'точка интереса пешеходов', 4: 'солнечный блик', 6: 'вход/выход (enex)',
  7: 'дорожный знак', 8: 'точка срабатывания', 9: 'укрытие', 10: 'эскалатор',
};
export const MATFX_TYPES = { 0: 'нет', 1: 'рельеф (bump)', 2: 'отражение (env)', 3: 'рельеф + отражение', 4: 'двойная текстура', 5: 'UV-трансформация', 6: 'двойная + UV' };

function f32(buf, off, count) {
  const ab = new ArrayBuffer(count * 4);
  new Uint8Array(ab).set(buf.subarray(off, off + count * 4));
  return new Float32Array(ab);
}

function geometryFormat(flags) {
  const names = [];
  if (flags & 0x01) names.push('tristrip');
  if (flags & 0x02) names.push('positions');
  if (flags & 0x04) names.push('textured');
  if (flags & 0x08) names.push('prelit');
  if (flags & 0x10) names.push('normals');
  if (flags & 0x20) names.push('light');
  if (flags & 0x40) names.push('modulateMaterialColor');
  if (flags & 0x80) names.push('textured2');
  if (flags & 0x01000000) names.push('native');
  return names;
}

function parseFrameList(buf, c, res) {
  const parts = children(buf, c.start, c.end);
  const st = parts.find((p) => p.type === CHUNK.STRUCT);
  if (!st) { res.warnings.push('Frame List без Struct'); return; }
  const n = buf.readUInt32LE(st.start);
  let o = st.start + 4;
  for (let i = 0; i < n && o + 56 <= st.end; i++, o += 56) {
    const rot = [];
    for (let k = 0; k < 9; k++) rot.push(buf.readFloatLE(o + k * 4));
    const pos = [buf.readFloatLE(o + 36), buf.readFloatLE(o + 40), buf.readFloatLE(o + 44)];
    res.frames.push({ index: i, name: '', parent: buf.readInt32LE(o + 48), flags: buf.readUInt32LE(o + 52), rot, pos, hanim: null });
  }
  const exts = parts.filter((p) => p.type === CHUNK.EXTENSION);
  exts.forEach((e, i) => {
    const f = res.frames[i];
    if (!f) return;
    for (const p of children(buf, e.start, e.end)) {
      if (p.type === CHUNK.FRAMENAME) f.name = buf.toString('latin1', p.start, p.end).replace(/\0.*$/, '');
      else if (p.type === CHUNK.HANIM && p.size >= 12) {
        const h = { version: buf.readUInt32LE(p.start), boneId: buf.readInt32LE(p.start + 4), numBones: buf.readUInt32LE(p.start + 8) };
        if (h.numBones > 0 && p.size >= 20 + h.numBones * 12) {
          h.flags = buf.readUInt32LE(p.start + 12);
          h.bones = [];
          for (let b = 0; b < h.numBones; b++) {
            const q = p.start + 20 + b * 12;
            h.bones.push({ id: buf.readInt32LE(q), index: buf.readUInt32LE(q + 4), flags: buf.readUInt32LE(q + 8) });
          }
        }
        f.hanim = h;
      }
    }
  });
}

function parseTexture(buf, c) {
  const t = { name: '', mask: '', filter: 0, addressU: 0, addressV: 0, extensions: [] };
  const parts = children(buf, c.start, c.end);
  let strings = 0;
  for (const p of parts) {
    if (p.type === CHUNK.STRUCT && p.size >= 4) {
      const v = buf.readUInt32LE(p.start);
      t.filter = v & 0xff; t.addressU = (v >> 8) & 0xf; t.addressV = (v >> 12) & 0xf;
    } else if (p.type === CHUNK.STRING) {
      if (strings++ === 0) t.name = readString(buf, p); else t.mask = readString(buf, p);
    } else if (p.type === CHUNK.EXTENSION) {
      for (const e of children(buf, p.start, p.end)) t.extensions.push(CHUNK_NAMES[e.type] || `0x${e.type.toString(16)}`);
    }
  }
  return t;
}

function parseMaterial(buf, c) {
  const m = { flags: 0, color: [255, 255, 255, 255], textured: false, texture: null, ambient: null, specular: null, diffuse: null, effects: [], matFx: null };
  for (const p of children(buf, c.start, c.end)) {
    if (p.type === CHUNK.STRUCT) {
      m.flags = buf.readUInt32LE(p.start);
      m.color = [buf[p.start + 4], buf[p.start + 5], buf[p.start + 6], buf[p.start + 7]];
      m.textured = buf.readUInt32LE(p.start + 12) !== 0;
      if (p.size >= 28) {
        m.ambient = buf.readFloatLE(p.start + 16); m.specular = buf.readFloatLE(p.start + 20); m.diffuse = buf.readFloatLE(p.start + 24);
      }
    } else if (p.type === CHUNK.TEXTURE) {
      m.texture = parseTexture(buf, p);
    } else if (p.type === CHUNK.EXTENSION) {
      for (const e of children(buf, p.start, p.end)) {
        m.effects.push(CHUNK_NAMES[e.type] || `0x${e.type.toString(16)}`);
        if (e.type === CHUNK.MATEFFECTS && e.size >= 4) m.matFx = buf.readUInt32LE(e.start);
      }
    }
  }
  return m;
}

function stripToList(strip, out, mat, matOut) {
  for (let i = 2; i < strip.length; i++) {
    const a = strip[i - 2], b = strip[i - 1], c = strip[i];
    if (a === b || b === c || a === c) continue;
    if ((i & 1) === 0) out.push(a, b, c); else out.push(b, a, c);
    matOut.push(mat);
  }
}

function parseGeometry(buf, g, index, wantData) {
  const geo = {
    index, flags: 0, format: [], numTriangles: 0, numVertices: 0, numMorphTargets: 0, numUV: 0, native: false,
    prelit: false, normals: false, nightColors: false, bsphere: null, bbox: null, materials: [], binMesh: null,
    skin: null, effects2d: [], extensions: [], trianglesFrom: 'struct', warnings: [],
  };
  const parts = children(buf, g.start, g.end);
  const st = parts.find((p) => p.type === CHUNK.STRUCT);
  if (!st) { geo.warnings.push('Geometry без Struct'); return geo; }
  let o = st.start;
  const flags = buf.readUInt32LE(o);
  const numTris = buf.readUInt32LE(o + 4), numVerts = buf.readUInt32LE(o + 8), numMorph = buf.readUInt32LE(o + 12);
  o += 16;
  if (st.version < 0x34000) o += 12;
  geo.flags = flags; geo.format = geometryFormat(flags);
  geo.numTriangles = numTris; geo.numVertices = numVerts; geo.numMorphTargets = numMorph;
  geo.native = (flags & 0x01000000) !== 0;
  let numUV = (flags >> 16) & 0xff;
  if (!numUV) numUV = flags & 0x80 ? 2 : flags & 0x04 ? 1 : 0;
  geo.numUV = numUV;
  const data = wantData ? { position: null, normal: null, uv: [], color: null, night: null, triangles: null, triMaterial: null, triSource: null } : null;
  let tris = null, triMat = null, binTris = null, binMat = null;
  if (!geo.native) {
    if (flags & 0x08) {
      geo.prelit = true;
      if (data) data.color = Uint8Array.from(buf.subarray(o, o + numVerts * 4));
      o += numVerts * 4;
    }
    for (let t = 0; t < numUV; t++) {
      if (data) data.uv.push(f32(buf, o, numVerts * 2));
      o += numVerts * 8;
    }
    if (numTris > 0 && o + numTris * 8 <= st.end) {
      tris = new Uint32Array(numTris * 3);
      triMat = new Uint16Array(numTris);
      for (let i = 0; i < numTris; i++) {
        const q = o + i * 8;
        tris[i * 3] = buf.readUInt16LE(q + 2);
        tris[i * 3 + 1] = buf.readUInt16LE(q);
        tris[i * 3 + 2] = buf.readUInt16LE(q + 6);
        triMat[i] = buf.readUInt16LE(q + 4);
      }
    }
    o += numTris * 8;
  }
  for (let m = 0; m < numMorph && o + 24 <= st.end; m++) {
    const sphere = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)];
    const hasVerts = buf.readUInt32LE(o + 16), hasNormals = buf.readUInt32LE(o + 20);
    o += 24;
    if (m === 0) geo.bsphere = sphere;
    let pos = null;
    if (hasVerts) {
      if (m === 0) pos = f32(buf, o, numVerts * 3);
      o += numVerts * 12;
    }
    if (hasNormals) {
      if (m === 0) { geo.normals = true; if (data) data.normal = f32(buf, o, numVerts * 3); }
      o += numVerts * 12;
    }
    if (m === 0 && pos) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) {
        for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
      }
      if (numVerts) geo.bbox = [lo, hi];
      if (data) data.position = pos;
    }
  }
  if (numMorph > 1) geo.warnings.push(`морф-целей: ${numMorph}, показывается первая`);
  for (const p of parts) {
    if (p.type === CHUNK.MATLIST) {
      const mp = children(buf, p.start, p.end);
      const ms = mp.find((x) => x.type === CHUNK.STRUCT);
      const list = [];
      if (ms) {
        const n = buf.readUInt32LE(ms.start);
        for (let i = 0; i < n; i++) list.push(buf.readInt32LE(ms.start + 4 + i * 4));
      }
      const parsed = mp.filter((x) => x.type === CHUNK.MATERIAL).map((x) => parseMaterial(buf, x));
      let next = 0;
      for (const ref of list) {
        if (ref < 0) geo.materials.push(parsed[next++] || { color: [255, 255, 255, 255], textured: false, texture: null, effects: [], missing: true });
        else geo.materials.push({ ...(geo.materials[ref] || {}), instanceOf: ref });
      }
    } else if (p.type === CHUNK.EXTENSION) {
      for (const e of children(buf, p.start, p.end)) {
        geo.extensions.push(CHUNK_NAMES[e.type] || `0x${e.type.toString(16)}`);
        if (e.type === CHUNK.BINMESH && e.size >= 12) {
          const type = buf.readUInt32LE(e.start), splits = buf.readUInt32LE(e.start + 4), total = buf.readUInt32LE(e.start + 8);
          geo.binMesh = { type: type === 1 ? 'tristrip' : 'trilist', splits, indices: total };
          if (!data && tris) { geo.trianglesFrom = 'binmesh'; continue; }
          if (!geo.native && e.size >= 12 + splits * 8 + total * 4) {
            const list = [], mats = [];
            let q = e.start + 12;
            for (let s = 0; s < splits; s++) {
              const n = buf.readUInt32LE(q), mat = buf.readUInt32LE(q + 4);
              q += 8;
              const idx = [];
              for (let k = 0; k < n; k++) idx.push(buf.readUInt32LE(q + k * 4));
              q += n * 4;
              if (type === 1) stripToList(idx, list, mat, mats);
              else for (let k = 0; k + 2 < n; k += 3) { list.push(idx[k], idx[k + 1], idx[k + 2]); mats.push(mat); }
            }
            binTris = Uint32Array.from(list); binMat = Uint16Array.from(mats);
          } else if (!geo.native) geo.warnings.push('Bin Mesh PLG короче заявленного — треугольники взяты из struct');
        } else if (e.type === CHUNK.EXTRAVERTCOLOR && e.size >= 4) {
          if (buf.readUInt32LE(e.start) !== 0 && e.size >= 4 + numVerts * 4) {
            geo.nightColors = true;
            if (data) data.night = Uint8Array.from(buf.subarray(e.start + 4, e.start + 4 + numVerts * 4));
          }
        } else if (e.type === CHUNK.SKIN && e.size >= 4) {
          geo.skin = { bones: buf[e.start], usedBones: buf[e.start + 1], maxWeights: buf[e.start + 2] };
          if (data) data.skin = readSkin(buf, e, numVerts, geo.skin);
        } else if (e.type === CHUNK.EFFECT2D && e.size >= 4) {
          const n = buf.readUInt32LE(e.start);
          let q = e.start + 4;
          for (let k = 0; k < n && q + 20 <= e.end; k++) {
            const type = buf.readUInt32LE(q + 12), size = buf.readUInt32LE(q + 16);
            geo.effects2d.push({ type, name: EFFECT2D_TYPES[type] || 'неизвестный', pos: [buf.readFloatLE(q), buf.readFloatLE(q + 4), buf.readFloatLE(q + 8)], size });
            q += 20 + size;
          }
        }
      }
    }
  }
  let triSource = null;
  if (binTris && binTris.length) {
    if (tris) {
      triSource = matchStructTriangles(binTris, tris);
      let differ = 0, unmatched = 0;
      for (let t = 0; t < binMat.length; t++) { const s = triSource[t]; if (s === NO_TRIANGLE) unmatched++; else if (triMat[s] !== binMat[t]) differ++; }
      if (differ) geo.warnings.push(`у ${differ} из ${binMat.length} треугольников материал в struct другой, чем в Bin Mesh; показано по Bin Mesh, как рисует RenderWare`);
      if (unmatched) geo.warnings.push(`${unmatched} треугольников Bin Mesh нет среди треугольников struct`);
      geo.materialMismatch = differ;
    }
    tris = binTris; triMat = binMat; geo.trianglesFrom = 'binmesh';
  }
  if (!tris) geo.trianglesFrom = geo.native ? 'native (не поддерживается)' : 'нет треугольников';
  geo.renderTriangles = tris ? tris.length / 3 : 0;
  if (data && data.position) {
    const p = data.position;
    let bad = null, count = 0;
    for (let v = 0; v < numVerts; v++) {
      if (Number.isFinite(p[v * 3]) && Number.isFinite(p[v * 3 + 1]) && Number.isFinite(p[v * 3 + 2])) continue;
      (bad = bad || new Uint8Array(numVerts))[v] = 1; count++;
      p[v * 3] = p[v * 3 + 1] = p[v * 3 + 2] = 0;
    }
    let dropped = 0, outside = 0;
    if (tris && !numVerts) { outside = tris.length / 3; tris = null; triMat = null; }
    if (tris) for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      if (a >= numVerts || b >= numVerts || c >= numVerts) { tris[t] = tris[t + 1] = tris[t + 2] = 0; outside++; }
      else if (bad && (bad[a] || bad[b] || bad[c])) { tris[t + 1] = tris[t + 2] = a; dropped++; }
    }
    if (count) { geo.warnings.push(`${count} из ${numVerts} вершин с нечисловыми координатами (NaN) в файле — обнулены, ${dropped} треугольников с ними не показаны`); geo.badVertices = count; }
    if (outside) geo.warnings.push(`${outside} треугольников ссылаются на вершины за пределами списка (${numVerts}) — не показаны`);
    const n = data.normal;
    if (n) for (let i = 0; i < n.length; i += 3) if (!(Number.isFinite(n[i]) && Number.isFinite(n[i + 1]) && Number.isFinite(n[i + 2]))) { n[i] = 0; n[i + 1] = 0; n[i + 2] = 1; }
  }
  if (data) { data.triangles = tris; data.triMaterial = triMat; data.triSource = triSource; geo.data = data; }
  return geo;
}

export const NO_TRIANGLE = 0xffffffff;

function matchStructTriangles(bin, struct) {
  const exact = new Map(), loose = new Map();
  const cyc = (a, b, c) => (a <= b && a <= c ? `${a},${b},${c}` : b <= a && b <= c ? `${b},${c},${a}` : `${c},${a},${b}`);
  const srt = (a, b, c) => [a, b, c].sort((x, y) => x - y).join(',');
  const push = (map, k, i) => { const l = map.get(k); if (l) l.push(i); else map.set(k, [i]); };
  for (let i = 0; i < struct.length / 3; i++) {
    const a = struct[i * 3], b = struct[i * 3 + 1], c = struct[i * 3 + 2];
    push(exact, cyc(a, b, c), i); push(loose, srt(a, b, c), i);
  }
  const used = new Uint8Array(struct.length / 3);
  const take = (list) => { if (!list) return NO_TRIANGLE; for (const i of list) if (!used[i]) { used[i] = 1; return i; } return list[0]; };
  const out = new Uint32Array(bin.length / 3);
  for (let t = 0; t < out.length; t++) {
    const a = bin[t * 3], b = bin[t * 3 + 1], c = bin[t * 3 + 2];
    const e = exact.get(cyc(a, b, c));
    out[t] = e ? take(e) : take(loose.get(srt(a, b, c)));
  }
  return out;
}

function readSkin(buf, e, numVerts, head) {
  let o = e.start + 4 + head.usedBones;
  const need = numVerts * 20 + head.bones * (head.usedBones ? 64 : 68);
  if (o + need > e.end) return null;
  const indices = Uint8Array.from(buf.subarray(o, o + numVerts * 4)); o += numVerts * 4;
  const weights = f32(buf, o, numVerts * 4); o += numVerts * 16;
  const inverse = [];
  for (let b = 0; b < head.bones; b++) {
    if (!head.usedBones) o += 4;
    const m = [];
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) m.push(buf.readFloatLE(o + k * 4));
    inverse.push(m);
    o += 64;
  }
  return { indices, weights, inverse };
}

function mulRw(a, b) {
  const n = new Array(12);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) n[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
  for (let col = 0; col < 3; col++) n[9 + col] = a[9] * b[col] + a[10] * b[3 + col] + a[11] * b[6 + col] + b[9 + col];
  return n;
}

function keyRows(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
}

export function applySkin(d, pose = null) {
  const root = d.frames.find((f) => f.hanim && f.hanim.bones && f.hanim.bones.length);
  const byId = new Map(d.frames.filter((f) => f.hanim).map((f) => [f.hanim.boneId, f.index]));
  let animated = 0;
  const local = d.frames.map((f) => {
    const k = pose && pose.keys && f.hanim ? pose.keys.get(f.hanim.boneId) : null;
    if (!k) return [...f.rot, ...f.pos];
    animated++;
    return [...keyRows(k.rot), ...(k.pos || f.pos)];
  });
  const ltm = (index) => {
    if (d.frames[index].parent < 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    let m = local[index];
    for (let p = d.frames[index].parent, guard = 0; p >= 0 && d.frames[p].parent >= 0 && guard < 64; p = d.frames[p].parent, guard++) m = mulRw(m, local[p]);
    return m;
  };
  const what = pose && animated ? `позу «${pose.label}» (${animated} костей из анимации)` : 'позу кадров DFF';
  for (const g of d.geometries) {
    const data = g.data, skin = data && data.skin;
    if (!skin || !data.position) continue;
    if (!root) { g.warnings.push('скин без иерархии HAnim: вершины показаны в пространстве кожи'); continue; }
    const mats = skin.inverse.map((ibm, b) => {
      const node = root.hanim.bones[b];
      const fi = node ? byId.get(node.id) : undefined;
      return fi === undefined ? null : mulRw(ibm, ltm(fi));
    });
    if (mats.some((m) => !m)) { g.warnings.push('кость скина не найдена среди кадров: вершины показаны в пространстве кожи'); continue; }
    const n = g.numVertices, src = data.position, nrm = data.normal;
    const pos = new Float32Array(n * 3), nor = nrm ? new Float32Array(n * 3) : null;
    let unweighted = 0;
    for (let v = 0; v < n; v++) {
      const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = skin.weights[v * 4 + k];
        if (!(w > 0)) continue;
        const m = mats[skin.indices[v * 4 + k]];
        if (!m) continue;
        sum += w;
        px += w * (x * m[0] + y * m[3] + z * m[6] + m[9]); py += w * (x * m[1] + y * m[4] + z * m[7] + m[10]); pz += w * (x * m[2] + y * m[5] + z * m[8] + m[11]);
        if (nrm) { const a = nrm[v * 3], b = nrm[v * 3 + 1], c = nrm[v * 3 + 2]; nx += w * (a * m[0] + b * m[3] + c * m[6]); ny += w * (a * m[1] + b * m[4] + c * m[7]); nz += w * (a * m[2] + b * m[5] + c * m[8]); }
      }
      if (sum > 0) { pos[v * 3] = px / sum; pos[v * 3 + 1] = py / sum; pos[v * 3 + 2] = pz / sum; }
      else { unweighted++; const m = mats[0]; pos[v * 3] = x * m[0] + y * m[3] + z * m[6] + m[9]; pos[v * 3 + 1] = x * m[1] + y * m[4] + z * m[7] + m[10]; pos[v * 3 + 2] = x * m[2] + y * m[5] + z * m[8] + m[11]; }
      if (nor) { const l = Math.hypot(nx, ny, nz) || 1; nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l; }
    }
    data.position = pos;
    if (nor) data.normal = nor;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    if (n) g.bbox = [lo, hi];
    g.skinApplied = true;
    g.warnings.push(`скин: вершины поставлены в ${what}, ${skin.inverse.length} костей${unweighted ? `, без весов ${unweighted} вершин — по первой кости` : ''}; в файле они хранятся в пространстве кожи`);
  }
}

function parseAtomic(buf, c) {
  const a = { frame: -1, geometry: -1, flags: 0, extensions: [], pipeline: null, rightToRender: null };
  for (const p of children(buf, c.start, c.end)) {
    if (p.type === CHUNK.STRUCT) {
      a.frame = buf.readInt32LE(p.start); a.geometry = buf.readInt32LE(p.start + 4); a.flags = buf.readUInt32LE(p.start + 8);
    } else if (p.type === CHUNK.EXTENSION) {
      for (const e of children(buf, p.start, p.end)) {
        a.extensions.push(CHUNK_NAMES[e.type] || `0x${e.type.toString(16)}`);
        if (e.type === CHUNK.PIPELINE && e.size >= 4) a.pipeline = '0x' + buf.readUInt32LE(e.start).toString(16);
        if (e.type === CHUNK.RIGHTTORENDER && e.size >= 8) a.rightToRender = { plugin: '0x' + buf.readUInt32LE(e.start).toString(16), extra: buf.readUInt32LE(e.start + 4) };
      }
    }
  }
  return a;
}

export function frameLtm(frames, index, includeRoot = false) {
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  for (let i = index, guard = 0; i >= 0 && i < frames.length && guard < 64; i = frames[i].parent, guard++) {
    const f = frames[i];
    if (f.parent < 0 && !includeRoot) break;
    const r = f.rot, p = f.pos;
    const n = new Array(12);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) n[row * 3 + col] = m[row * 3] * r[col] + m[row * 3 + 1] * r[3 + col] + m[row * 3 + 2] * r[6 + col];
    }
    for (let col = 0; col < 3; col++) n[9 + col] = m[9] * r[col] + m[10] * r[3 + col] + m[11] * r[6 + col] + p[col];
    m = n;
  }
  return m;
}

export function parseDff(buf, opts = {}) {
  const wantData = opts.data !== false;
  const res = { rw: null, clumps: 0, topChunks: [], frames: [], geometries: [], atomics: [], lights: 0, cameras: 0, numAtomicsDeclared: 0, collision: null, uvAnimDict: false, warnings: [], error: null };
  const top = children(buf, 0, buf.length);
  let clump = null;
  for (const c of top) {
    res.topChunks.push({ type: c.type, name: CHUNK_NAMES[c.type] || `0x${c.type.toString(16)}`, size: c.size });
    if (c.type === CHUNK.CLUMP) { res.clumps++; if (!clump) clump = c; }
    else if (c.type === CHUNK.UVANIMDICT) res.uvAnimDict = true;
  }
  if (!clump) { res.error = top.length ? `нет чанка Clump (0x10); первый чанк 0x${top[0].type.toString(16)}` : 'файл пуст или не RenderWare'; return res; }
  if (res.clumps > 1) res.warnings.push(`в файле ${res.clumps} clump, показывается первый`);
  res.rw = { libId: '0x' + clump.libId.toString(16), version: clump.version, build: clump.build, text: versionString(clump.version), game: versionGame(clump.version) };
  if (clump.truncated) res.warnings.push('Clump обрезан: размер чанка больше файла');
  for (const c of children(buf, clump.start, clump.end)) {
    if (c.type === CHUNK.STRUCT) {
      res.numAtomicsDeclared = buf.readUInt32LE(c.start);
      if (c.size >= 12) { res.lights = buf.readUInt32LE(c.start + 4); res.cameras = buf.readUInt32LE(c.start + 8); }
    } else if (c.type === CHUNK.FRAMELIST) parseFrameList(buf, c, res);
    else if (c.type === CHUNK.GEOMLIST) {
      let i = 0;
      for (const g of children(buf, c.start, c.end)) if (g.type === CHUNK.GEOMETRY) res.geometries.push(parseGeometry(buf, g, i++, wantData));
    } else if (c.type === CHUNK.ATOMIC) res.atomics.push(parseAtomic(buf, c));
    else if (c.type === CHUNK.EXTENSION) {
      for (const e of children(buf, c.start, c.end)) if (e.type === CHUNK.COLLISION) res.collision = { offset: e.start, size: e.size };
    }
  }
  if (opts.tree) res.tree = chunkTree(buf, 0, buf.length);
  return res;
}

export function atomicFrameMatrix(d, atomic, clumpModel) {
  const g = d.geometries[atomic.geometry];
  return clumpModel && !(g && g.skinApplied) ? frameLtm(d.frames, atomic.frame) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}
export function frameNameOf(d, atomic) {
  const f = d.frames[atomic.frame];
  return f ? f.name : '';
}
export function defaultAtomicVisible(name) {
  const n = (name || '').toLowerCase();
  return !(n.endsWith('_dam') || n.endsWith('_vlo') || n.includes('_dam_'));
}

function boundsOf(d, clumpModel) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const a of d.atomics) {
    const g = d.geometries[a.geometry];
    if (!g || !g.bbox || !defaultAtomicVisible(frameNameOf(d, a))) continue;
    const m = atomicFrameMatrix(d, a, clumpModel);
    for (let k = 0; k < 8; k++) {
      const p = [g.bbox[k & 1 ? 1 : 0][0], g.bbox[k & 2 ? 1 : 0][1], g.bbox[k & 4 ? 1 : 0][2]];
      for (let c = 0; c < 3; c++) {
        const v = p[0] * m[c] + p[1] * m[3 + c] + p[2] * m[6 + c] + m[9 + c];
        if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
      }
    }
  }
  if (!(lo[0] <= hi[0])) return null;
  const r2 = (v) => Math.round(v * 100) / 100;
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
  return { bbox: [lo.map(r2), hi.map(r2)], bsphere: [cx, cy, cz, Math.hypot(hi[0] - cx, hi[1] - cy, hi[2] - cz)].map(r2) };
}

export function summarizeDff(buf) {
  let d = parseDff(buf, { data: false });
  if (d.error) return { error: d.error };
  if (d.geometries.some((g) => g.skin)) { d = parseDff(buf, { data: true }); applySkin(d); }
  let verts = 0, tris = 0, mats = 0;
  const textures = new Set();
  for (const a of d.atomics) {
    const g = d.geometries[a.geometry];
    if (!g) continue;
    verts += g.numVertices; tris += g.renderTriangles; mats += g.materials.length;
    for (const m of g.materials) if (m.texture && m.texture.name) textures.add(m.texture.name.toLowerCase());
  }
  const out = {
    rw: d.rw.version, atomics: d.atomics.length, geometries: d.geometries.length, frames: d.frames.length,
    verts, tris, mats, textures: [...textures], skin: d.geometries.some((g) => g.skin), collision: !!d.collision,
  };
  const atomicB = boundsOf(d, false), clumpB = boundsOf(d, true);
  if (atomicB) { out.bbox = atomicB.bbox; out.bsphere = atomicB.bsphere; }
  if (clumpB) { out.bboxClump = clumpB.bbox; out.bsphereClump = clumpB.bsphere; }
  if (d.warnings.length) out.warnings = d.warnings;
  return out;
}
