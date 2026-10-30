function cstr(buf, off, len) {
  const s = buf.toString('latin1', off, off + len);
  const z = s.search(/[^\x20-\x7e]/);
  return z >= 0 ? s.slice(0, z) : s;
}
const vec = (buf, o) => [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
const surface = (buf, o) => ({ material: buf[o], flag: buf[o + 1], brightness: buf[o + 2], light: buf[o + 3] });

const isSig = (buf, o) => o >= 0 && o + 4 <= buf.length && /^COL[L234]$/.test(buf.toString('latin1', o, o + 4));

export function listColModels(buf) {
  const models = [];
  const diagnostics = [];
  let o = 0;
  while (o + 32 <= buf.length) {
    const four = buf.toString('latin1', o, o + 4);
    if (!isSig(buf, o)) {
      if (!buf.subarray(o, Math.min(buf.length, o + 64)).some((b) => b !== 0)) break;
      let found = -1;
      for (let d = 1; d <= 16 && found < 0; d++) {
        if (isSig(buf, o - d)) found = o - d;
        else if (isSig(buf, o + d)) found = o + d;
      }
      const prev = models[models.length - 1];
      if (found >= 0 && prev) {
        diagnostics.push({ offset: o, level: 'warning', message: `модель «${prev.name}»: размер блока указан ${prev.size - 8}, а следующая сигнатура найдена со сдвигом ${found - o} байт (смещение ${found}); чтение продолжено с неё` });
        prev.sizeMismatch = found - o;
        o = found;
        continue;
      }
      diagnostics.push({ offset: o, message: `ожидалась сигнатура COLL/COL2/COL3/COL4, найдено «${four.replace(/[^\x20-\x7e]/g, '.')}»; дальше файл не читается` });
      break;
    }
    const size = buf.readUInt32LE(o + 4);
    const version = four === 'COLL' ? 1 : Number(four[3]);
    const name = cstr(buf, o + 8, 22);
    const id = buf.readUInt16LE(o + 30);
    const end = o + 8 + size;
    if (size < 24 || end > buf.length) { diagnostics.push({ offset: o, message: `модель «${name}»: размер блока ${size} выходит за пределы файла` }); break; }
    const headerEnd = o + 72 + (version >= 3 ? 48 : version === 2 ? 36 : 0) + (version === 1 ? 4 : 0);
    if (headerEnd > end) { diagnostics.push({ offset: o, message: `модель «${name}»: блок ${size} байт короче заголовка ${four}` }); o = end; continue; }
    let bounds;
    const b = o + 32;
    if (version === 1) bounds = { radius: buf.readFloatLE(b), center: vec(buf, b + 4), min: vec(buf, b + 16), max: vec(buf, b + 28) };
    else bounds = { min: vec(buf, b), max: vec(buf, b + 12), center: vec(buf, b + 24), radius: buf.readFloatLE(b + 36) };
    const m = { name, id, version, offset: o, size: size + 8, bounds };
    if (version >= 2) {
      const h = o + 72;
      m.counts = { spheres: buf.readUInt16LE(h), boxes: buf.readUInt16LE(h + 2), faces: buf.readUInt16LE(h + 4), lines: buf[h + 6] };
      m.flags = buf.readUInt32LE(h + 8);
      if (version >= 3) m.counts.shadowFaces = buf.readUInt32LE(h + 36);
    }
    models.push(m);
    o = end;
  }
  return { models, diagnostics };
}

export function parseColModel(buf, off) {
  const four = buf.toString('latin1', off, off + 4);
  const version = four === 'COLL' ? 1 : Number(four[3]);
  const size = buf.readUInt32LE(off + 4);
  const end = Math.min(off + 8 + size, buf.length);
  const m = { version, name: cstr(buf, off + 8, 22), id: buf.readUInt16LE(off + 30), spheres: [], boxes: [], vertices: [], faces: [], faceGroups: [], shadowVertices: [], shadowFaces: [], lines: 0, flags: 0, warnings: [] };
  let o = off + 32;
  if (version !== 1 && off + (version === 2 ? 108 : version === 3 ? 120 : 124) > end) { m.warnings.push(`блок короче заголовка ${four}`); return m; }
  if (version === 1) {
    const limit = end;
    const count = (what, item) => {
      if (o + 4 > limit) { m.warnings.push(`блок закончился до числа ${what}`); return -1; }
      const n = buf.readUInt32LE(o); o += 4;
      if (o + n * item > limit) { m.warnings.push(`число ${what} ${n} не помещается в блок — блок повреждён, дальше не читается`); return -1; }
      return n;
    };
    if (o + 40 > limit) { m.warnings.push('блок короче заголовка границ'); return m; }
    m.bounds = { radius: buf.readFloatLE(o), center: vec(buf, o + 4), min: vec(buf, o + 16), max: vec(buf, o + 28) };
    o += 40;
    const ns = count('сфер', 20); if (ns < 0) return m;
    for (let i = 0; i < ns; i++, o += 20) m.spheres.push({ radius: buf.readFloatLE(o), center: vec(buf, o + 4), surface: surface(buf, o + 16) });
    const nl = count('линий', 24); if (nl < 0) return m;
    m.lines = nl; m.lineSegments = [];
    for (let i = 0; i < nl; i++, o += 24) m.lineSegments.push([vec(buf, o), vec(buf, o + 12)]);
    const nb = count('боксов', 28); if (nb < 0) return m;
    for (let i = 0; i < nb; i++, o += 28) m.boxes.push({ min: vec(buf, o), max: vec(buf, o + 12), surface: surface(buf, o + 24) });
    const nv = count('вершин', 12); if (nv < 0) return m;
    for (let i = 0; i < nv; i++, o += 12) m.vertices.push(vec(buf, o));
    const nf = count('граней', 16); if (nf < 0) return m;
    for (let i = 0; i < nf; i++, o += 16) {
      const s = surface(buf, o + 12);
      m.faces.push([buf.readUInt32LE(o), buf.readUInt32LE(o + 4), buf.readUInt32LE(o + 8), s.material, s.light]);
    }
    return checkFaces(m);
  }
  m.bounds = { min: vec(buf, o), max: vec(buf, o + 12), center: vec(buf, o + 24), radius: buf.readFloatLE(o + 36) };
  const h = off + 72;
  const ns = buf.readUInt16LE(h), nb = buf.readUInt16LE(h + 2), nf = buf.readUInt16LE(h + 4);
  m.lines = buf[h + 6];
  m.flags = buf.readUInt32LE(h + 8);
  const base = off + 4;
  const offSph = buf.readUInt32LE(h + 12), offBox = buf.readUInt32LE(h + 16), offVert = buf.readUInt32LE(h + 24), offFace = buf.readUInt32LE(h + 28);
  for (let i = 0; i < ns; i++) {
    const q = base + offSph + i * 20;
    if (q + 20 > end) { m.warnings.push('сферы выходят за пределы блока'); break; }
    m.spheres.push({ center: vec(buf, q), radius: buf.readFloatLE(q + 12), surface: surface(buf, q + 16) });
  }
  for (let i = 0; i < nb; i++) {
    const q = base + offBox + i * 28;
    if (q + 28 > end) { m.warnings.push('боксы выходят за пределы блока'); break; }
    m.boxes.push({ min: vec(buf, q), max: vec(buf, q + 12), surface: surface(buf, q + 24) });
  }
  let maxIndex = -1;
  for (let i = 0; i < nf; i++) {
    const q = base + offFace + i * 8;
    if (q + 8 > end) { m.warnings.push('грани выходят за пределы блока'); break; }
    const a = buf.readUInt16LE(q), b = buf.readUInt16LE(q + 2), c = buf.readUInt16LE(q + 4);
    m.faces.push([a, b, c, buf[q + 6], buf[q + 7]]);
    maxIndex = Math.max(maxIndex, a, b, c);
  }
  for (let i = 0; i <= maxIndex; i++) {
    const q = base + offVert + i * 6;
    if (q + 6 > end) { m.warnings.push('вершины выходят за пределы блока'); break; }
    m.vertices.push([buf.readInt16LE(q) / 128, buf.readInt16LE(q + 2) / 128, buf.readInt16LE(q + 4) / 128]);
  }
  if (m.flags & 8 && offFace >= 4 && base + offFace <= end) {
    const q = base + offFace - 4;
    const ng = buf.readUInt32LE(q);
    for (let i = 0; i < ng && i < 4096; i++) {
      const g = q - (i + 1) * 28;
      if (g < off) break;
      m.faceGroups.push({ min: vec(buf, g), max: vec(buf, g + 12), start: buf.readUInt16LE(g + 24), end: buf.readUInt16LE(g + 26) });
    }
  }
  if (version >= 3 && m.flags & 16) {
    const nsf = buf.readUInt32LE(h + 36), offSv = buf.readUInt32LE(h + 40), offSf = buf.readUInt32LE(h + 44);
    let maxS = -1;
    for (let i = 0; i < nsf; i++) {
      const q = base + offSf + i * 8;
      if (q + 8 > end) break;
      const a = buf.readUInt16LE(q), b = buf.readUInt16LE(q + 2), c = buf.readUInt16LE(q + 4);
      m.shadowFaces.push([a, b, c, buf[q + 6], buf[q + 7]]);
      maxS = Math.max(maxS, a, b, c);
    }
    for (let i = 0; i <= maxS; i++) {
      const q = base + offSv + i * 6;
      if (q + 6 > end) break;
      m.shadowVertices.push([buf.readInt16LE(q) / 128, buf.readInt16LE(q + 2) / 128, buf.readInt16LE(q + 4) / 128]);
    }
  }
  return checkFaces(m);
}

function checkFaces(m) {
  for (const [faces, verts, what] of [[m.faces, m.vertices, 'граней'], [m.shadowFaces, m.shadowVertices, 'граней тени']]) {
    let bad = 0;
    for (const f of faces) if (f[0] >= verts.length || f[1] >= verts.length || f[2] >= verts.length) { f[0] = f[1] = f[2] = 0; bad++; }
    if (!bad) continue;
    m.warnings.push(`${what} со ссылкой на несуществующую вершину: ${bad} из ${faces.length} (вершин ${verts.length}) — не показаны`);
    if (!verts.length) faces.length = 0;
  }
  if (!m.faces.length) m.faceGroups = [];
  return m;
}
