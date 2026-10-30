import { worldQuat } from './ipl.js';

export const CELL = 300;
const CLUMP_SECTIONS = new Set(['cars', 'peds', 'weap', 'hier', 'anim']);
const SERVICE_TYPES = ['zone', 'enex', 'grge', 'cull', 'pick', 'cars', 'auzo', 'occl', 'tcyc', 'jump', 'mult', 'path'];

export class World {
  constructor(cat, profile) {
    this.cat = cat;
    this.profile = profile;
    this.generation = `${cat.generation}-${Date.now().toString(36)}`;
    this.diagnostics = [];
    this.conflicts = { ids: [], names: [], duplicates: [] };
    this.buildImgOrder();
    this.buildDefs();
    this.buildModels();
    this.buildInstances();
    this.buildCells();
    this.buildService();
  }

  note(type, message, extra = {}) { this.diagnostics.push({ type, message, ...extra }); }

  buildImgOrder() {
    this.imgOrder = new Map();
    for (const item of this.profile.img) {
      if (!item.active || !item.file || item.repeat) continue;
      const f = this.cat.byKey.get(item.file);
      if (f && !this.imgOrder.has(f.fid)) this.imgOrder.set(f.fid, this.imgOrder.size);
    }
    this.resCache = new Map();
  }

  resolveName(lower) {
    if (this.resCache.has(lower)) return this.resCache.get(lower);
    const all = this.cat.resByName.get(lower) || [];
    const active = all.filter((rid) => this.imgOrder.has(this.cat.res[rid].fid) && !this.cat.res[rid].err)
      .sort((a, b) => this.imgOrder.get(this.cat.res[a].fid) - this.imgOrder.get(this.cat.res[b].fid) || this.cat.res[a].entry - this.cat.res[b].entry);
    let rid = -1, reason;
    const ov = this.profile.overrides.resource[lower];
    if (ov !== undefined && this.cat.resByKey.has(ov)) { rid = this.cat.resByKey.get(ov); reason = 'выбрано вручную в профиле'; }
    else if (active.length) {
      rid = this.profile.rules.imgDuplicate === 'last' ? active[active.length - 1] : active[0];
      reason = active.length > 1 ? `${active.length} вариантов в активных IMG; правило «${this.profile.rules.imgDuplicate === 'last' ? 'последний' : 'первый'} по порядку подключения»` : 'единственный вариант в активных IMG';
    } else if (all.length) reason = 'есть только в неактивных архивах';
    else reason = 'не найден ни в одном архиве';
    const r = { rid, candidates: all, activeCandidates: active, reason };
    if (active.length > 1) this.conflicts.names.push(lower);
    this.resCache.set(lower, r);
    return r;
  }

  buildDefs() {
    const defsByFid = new Map();
    for (const d of this.cat.defs) {
      if (!defsByFid.has(d.fid)) defsByFid.set(d.fid, []);
      defsByFid.get(d.fid).push(d.did);
    }
    this.activeIde = [];
    const seen = new Set();
    for (const item of this.profile.ide) {
      if (!item.active || !item.file) continue;
      const f = this.cat.byKey.get(item.file);
      if (!f || seen.has(f.fid)) continue;
      seen.add(f.fid);
      this.activeIde.push(f.fid);
    }
    this.defsActiveById = new Map();
    for (const fid of this.activeIde) for (const did of defsByFid.get(fid) || []) {
      const id = this.cat.defs[did].id;
      if (!this.defsActiveById.has(id)) this.defsActiveById.set(id, []);
      this.defsActiveById.get(id).push(did);
    }
    this.chosenDef = new Map();
    for (const [id, list] of this.defsActiveById) {
      let did = this.profile.rules.ideDuplicate === 'first' ? list[0] : list[list.length - 1];
      const ov = this.profile.overrides.ide[id];
      if (ov) { const hit = (this.cat.defsById.get(id) || []).find((x) => this.cat.defs[x].key === ov); if (hit !== undefined) did = hit; }
      this.chosenDef.set(id, did);
      if (list.length > 1) this.conflicts.ids.push(id);
    }
    this.txdParent = new Map();
    const activeFids = new Set(this.activeIde);
    for (const t of this.cat.txdp) if (activeFids.has(t.fid)) this.txdParent.set(t.child.toLowerCase(), t.parent.toLowerCase());
  }

  buildModels() {
    this.models = [];
    this.modelById = new Map();
    const ids = [...this.chosenDef.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const def = this.cat.defs[this.chosenDef.get(id)];
      const clump = CLUMP_SECTIONS.has(def.section);
      const dff = this.resolveName(`${def.model.toLowerCase()}.dff`);
      const txd = def.txd && def.txd.toLowerCase() !== 'null' ? this.resolveName(`${def.txd.toLowerCase()}.txd`) : { rid: -1, reason: 'txd не указан' };
      const vehicleTex = def.section === 'cars' || /(^|\/)veh_mods\.ide$/i.test(this.cat.files[def.fid].rel);
      const m = {
        mi: this.models.length, id, did: def.did, name: def.model, txd: def.txd, section: def.section, flags: def.flags || 0,
        dd: def.drawDist.length ? Math.max(...def.drawDist) : 300, clump, dff: dff.rid, txdRid: txd.rid, col: null, vehicleTex,
      };
      const s = dff.rid >= 0 ? this.cat.res[dff.rid].dff : null;
      if (s && !s.error) {
        const bs = clump ? s.bsphereClump : s.bsphere;
        const bb = clump ? s.bboxClump : s.bbox;
        if (bs) m.bs = bs;
        if (bb) m.bb = bb;
        m.tris = s.tris;
        if (s.collision) m.embeddedCol = true;
      }
      const cols = (this.cat.colIndex.get(def.model.toLowerCase()) || []).filter((c) => this.imgOrder.has(this.cat.res[c.rid].fid))
        .sort((a, b) => this.imgOrder.get(this.cat.res[a.rid].fid) - this.imgOrder.get(this.cat.res[b.rid].fid));
      if (cols.length) m.col = { rid: cols[0].rid, i: cols[0].i, alternatives: cols.length - 1 };
      if (dff.rid < 0) this.note('model', `${def.section} ${id} «${def.model}»: DFF ${dff.reason}`, { id, did: def.did });
      if (txd.rid < 0 && def.txd && def.txd.toLowerCase() !== 'null') this.note('model', `${def.section} ${id} «${def.model}»: TXD «${def.txd}» ${txd.reason}`, { id, did: def.did, level: 'warning' });
      this.models.push(m);
      this.modelById.set(id, m.mi);
    }
  }

  imgIplSlots(texts) {
    const byRid = new Map(this.cat.ipls.filter((s) => s.entry >= 0).map((s) => [s.rid, s]));
    const names = new Set(this.cat.ipls.filter((s) => s.entry >= 0 && this.imgOrder.has(s.fid)).map((s) => s.lower));
    const slots = [];
    for (const lower of names) {
      const r = this.resolveName(lower);
      const src = byRid.get(r.rid);
      if (!src) continue;
      if (r.activeCandidates.length > 1) this.note('ipl', `потоковый ${src.name} есть в ${r.activeCandidates.length} активных IMG: ${r.reason}`, { level: 'info', key: src.key });
      let base = null;
      for (const t of texts) if (lower.startsWith(`${t.base}_stream`)) base = t;
      slots.push({ src, base });
    }
    return slots.sort((a, b) => a.src.lower.localeCompare(b.src.lower, 'en', { numeric: true }));
  }

  placementSources() {
    const texts = [];
    const seenFiles = new Set();
    for (const item of this.profile.ipl) {
      if (!item.active || !item.file || item.repeat || seenFiles.has(item.file)) continue;
      seenFiles.add(item.file);
      const f = this.cat.byKey.get(item.file);
      if (f) for (const t of this.cat.ipls.filter((s) => s.fid === f.fid && s.entry < 0)) texts.push({ item, src: t });
    }
    const rule = this.profile.rules.streamIpl;
    const slots = rule === 'none' ? [] : this.imgIplSlots(texts.map((t) => t.src));
    const out = [];
    for (const t of texts) {
      out.push({ src: t.src, base: null, item: t.item.path });
      for (const s of slots) if (s.base === t.src) out.push({ src: s.src, base: t.src, item: t.item.path });
    }
    const orphans = slots.filter((s) => !s.base);
    if (rule === 'game') {
      for (const s of orphans) out.push({ src: s.src, base: null, item: null, orphan: true });
      if (orphans.length) this.note('ipl', `${orphans.length} IPL в активных IMG без связанного текстового IPL подключены без LOD-связей, как их потоково грузит движок: ${orphans.map((s) => s.src.name).join(', ')}`, { level: 'info' });
    } else if (orphans.length) this.note('ipl', `${orphans.length} IPL в активных IMG без связанного текстового IPL не подключены (правило профиля): ${orphans.map((s) => s.src.name).join(', ')}`, { level: 'warning' });
    return out;
  }

  buildInstances() {
    const cap = 200000;
    this.sources = [];
    const iidOf = new Map();
    const tmp = { id: [], mi: [], pos: [], quat: [], interior: [], lod: [], src: [], index: [], flags: [] };
    this.scales = new Map();
    let n = 0, noDef = 0, mismatch = 0, badLod = 0, orphanLods = 0;
    const samples = { noDef: [], mismatch: [], badLod: [] };
    const pendingLods = [];
    {
      for (const { src, base, item, orphan } of this.placementSources()) {
        const si = this.sources.length;
        const indexToIid = [];
        this.sources.push({ si, pid: src.pid, key: src.key, name: src.name, kind: src.kind, stream: src.entry >= 0, orphan: !!orphan, base: base ? base.key : null, manifestItem: item, count: src.rec.inst.length, first: n });
        iidOf.set(src.pid, indexToIid);
        for (const r of src.rec.inst) {
          if (n >= cap) break;
          const mi = this.modelById.has(r.id) ? this.modelById.get(r.id) : -1;
          tmp.id.push(r.id); tmp.mi.push(mi); tmp.pos.push(r.p[0], r.p[1], r.p[2]);
          const q = worldQuat(r.r);
          tmp.quat.push(q[0], q[1], q[2], q[3]);
          tmp.interior.push(r.in | 0); tmp.lod.push(-1); tmp.src.push(si); tmp.index.push(r.i); tmp.flags.push(0);
          if (r.s && (r.s[0] !== 1 || r.s[1] !== 1 || r.s[2] !== 1)) this.scales.set(n, r.s);
          indexToIid[r.i] = n;
          if (mi < 0) { noDef++; tmp.flags[n] |= 4; if (samples.noDef.length < 50) samples.noDef.push({ iid: n, id: r.id, model: r.m || '', src: src.key, line: r.ln, offset: r.of }); }
          else if (r.m && r.m.toLowerCase() !== 'dummy' && r.m.toLowerCase() !== this.models[mi].name.toLowerCase()) {
            mismatch++;
            if (samples.mismatch.length < 50) samples.mismatch.push({ iid: n, id: r.id, ipl: r.m, ide: this.models[mi].name, src: src.key, line: r.ln });
          }
          if (r.l >= 0) { if (orphan) orphanLods++; else pendingLods.push([n, r.l, base ? base.pid : src.pid]); }
          n++;
        }
      }
    }
    this.count = n;
    this.inst = {
      id: Int32Array.from(tmp.id), mi: Int32Array.from(tmp.mi), pos: Float32Array.from(tmp.pos), quat: Float32Array.from(tmp.quat),
      interior: Int32Array.from(tmp.interior), lod: Int32Array.from(tmp.lod), src: Int32Array.from(tmp.src), index: Int32Array.from(tmp.index), flags: Uint32Array.from(tmp.flags),
    };
    for (const [iid, lodIndex, pid] of pendingLods) {
      const map = iidOf.get(pid);
      const target = map ? map[lodIndex] : undefined;
      if (target === undefined) { badLod++; if (samples.badLod.length < 50) samples.badLod.push({ iid, lodIndex, src: this.sources[this.inst.src[iid]].key }); continue; }
      this.inst.lod[iid] = target;
      this.inst.flags[target] |= 1;
    }
    this.children = new Map();
    for (let i = 0; i < n; i++) { const l = this.inst.lod[i]; if (l >= 0) { if (!this.children.has(l)) this.children.set(l, []); this.children.get(l).push(i); } }
    if (noDef) this.note('instance', `${noDef} размещений с ID без активного определения (не отображаются)`, { samples: samples.noDef });
    if (mismatch) this.note('instance', `${mismatch} размещений: имя модели в IPL не совпадает с выбранным IDE (модель взята по ID)`, { samples: samples.mismatch, level: 'warning' });
    if (badLod) this.note('instance', `${badLod} LOD-ссылок указывают за пределы своего IPL`, { samples: samples.badLod });
    if (orphanLods) this.note('instance', `${orphanLods} LOD-индексов в IPL без связанного текстового IPL не используются (движку не на что их направить)`, { level: 'info' });
    const dup = new Map();
    let dups = 0;
    for (let i = 0; i < n; i++) {
      const k = `${this.inst.id[i]}|${Math.round(this.inst.pos[i * 3] * 100)}|${Math.round(this.inst.pos[i * 3 + 1] * 100)}|${Math.round(this.inst.pos[i * 3 + 2] * 100)}|${[0, 1, 2, 3].map((c) => Math.round(this.inst.quat[i * 4 + c] * 1000)).join(',')}|${this.inst.interior[i]}`;
      const prev = dup.get(k);
      if (prev === undefined) { dup.set(k, i); continue; }
      dups++;
      this.inst.flags[i] |= 2;
      if (this.conflicts.duplicates.length < 500) this.conflicts.duplicates.push({ iid: i, of: prev, src: this.sources[this.inst.src[i]].key, srcOf: this.sources[this.inst.src[prev]].key });
    }
    this.duplicateCount = dups;
    if (dups) this.note('instance', `${dups} точных дублей размещений (та же модель, позиция и поворот) — ${this.profile.rules.hideExactDuplicates ? 'скрыты правилом профиля' : 'показываются, как в игре'}`, { level: 'info' });
    this.byModel = new Map();
    for (let i = 0; i < n; i++) { const mi = this.inst.mi[i]; if (mi < 0) continue; if (!this.byModel.has(mi)) this.byModel.set(mi, []); this.byModel.get(mi).push(i); }
  }

  isFar(i) {
    const mi = this.inst.mi[i];
    if (mi < 0) return false;
    const m = this.models[mi];
    return m.dd >= 400 || (m.bs && m.bs[3] >= 120) || (this.inst.flags[i] & 1) !== 0;
  }

  buildCells() {
    this.cells = new Map();
    this.far = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const interiors = new Map();
    for (let i = 0; i < this.count; i++) {
      const x = this.inst.pos[i * 3], y = this.inst.pos[i * 3 + 1], z = this.inst.pos[i * 3 + 2];
      if (Math.abs(x) < 1e6 && Math.abs(y) < 1e6) {
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
      }
      const area = this.inst.interior[i] & 0xff;
      interiors.set(area, (interiors.get(area) || 0) + 1);
      if (this.isFar(i)) { this.far.push(i); continue; }
      const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(i);
    }
    this.bounds = { min: lo, max: hi };
    this.interiors = [...interiors.entries()].sort((a, b) => a[0] - b[0]).map(([area, count]) => ({ area, count }));
    let best = null, bestN = 0;
    for (const [k, list] of this.cells) {
      let c = 0;
      for (const i of list) if ((this.inst.interior[i] & 0xff) === 0 && this.inst.mi[i] >= 0) c++;
      if (c > bestN) { bestN = c; best = k; }
    }
    if (best) {
      const [cx, cy] = best.split(',').map(Number);
      const zs = this.cells.get(best).filter((i) => (this.inst.interior[i] & 0xff) === 0).map((i) => this.inst.pos[i * 3 + 2]).sort((a, b) => a - b);
      const z = zs.length ? zs[zs.length >> 1] : 20;
      this.spawn = { x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL, z: z + 70, cell: best, objects: bestN };
    } else this.spawn = { x: 0, y: 0, z: 100, cell: null, objects: 0 };
  }

  buildService() {
    this.service = {};
    for (const t of SERVICE_TYPES) this.service[t] = [];
    let ignored = 0;
    for (const s of this.sources) {
      const src = this.cat.ipls[s.pid];
      for (const [t, list] of Object.entries(src.rec.service || {})) {
        if (src.entry >= 0 && !(t === 'cars' && src.kind === 'binary')) { ignored += list.length; continue; }
        if (!this.service[t]) this.service[t] = [];
        for (const e of list) this.service[t].push({ ...e, src: src.key });
      }
    }
    if (ignored) this.note('ipl', `${ignored} записей служебных секций в текстовых IPL внутри IMG не используются: из таких файлов движок читает только inst`, { level: 'info' });
  }

  encode(iids) {
    const buf = Buffer.alloc(iids.length * 48);
    let o = 0;
    for (const i of iids) {
      buf.writeUInt32LE(i, o); buf.writeInt32LE(this.inst.mi[i], o + 4);
      for (let k = 0; k < 3; k++) buf.writeFloatLE(this.inst.pos[i * 3 + k], o + 8 + k * 4);
      for (let k = 0; k < 4; k++) buf.writeFloatLE(this.inst.quat[i * 4 + k], o + 20 + k * 4);
      buf.writeInt32LE(this.inst.interior[i], o + 36); buf.writeInt32LE(this.inst.lod[i], o + 40);
      buf.writeUInt32LE(((this.inst.src[i] & 0xffff) << 16) | (this.inst.flags[i] & 0xffff), o + 44);
      o += 48;
    }
    return buf;
  }

  stableId(i) {
    const s = this.sources[this.inst.src[i]];
    return `${s.key}#${this.inst.index[i]}`;
  }

  findStable(stable) {
    const h = stable.lastIndexOf('#');
    const key = stable.slice(0, h), index = Number(stable.slice(h + 1));
    const s = this.sources.find((x) => x.key === key);
    if (!s) return -1;
    for (let i = s.first; i < s.first + s.count && i < this.count; i++) if (this.inst.index[i] === index) return i;
    return -1;
  }

  summary() {
    return {
      generation: this.generation, profile: { id: this.profile.id, name: this.profile.name }, instances: this.count, models: this.models.length,
      sources: this.sources.length, cells: this.cells.size, far: this.far.length, bounds: this.bounds, spawn: this.spawn, interiors: this.interiors,
      conflicts: { ids: this.conflicts.ids.length, names: [...new Set(this.conflicts.names)].length, duplicates: this.duplicateCount },
      diagnostics: this.diagnostics.map((d) => ({ type: d.type, message: d.message, level: d.level || 'error', samples: d.samples ? d.samples.length : 0 })),
    };
  }
}
