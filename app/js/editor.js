import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import { getJson, sendJson, getBuffer, decodeInstances, download } from './api.js';
import { rwMatrix, cloneMaterial } from './assets.js';
import { gtaToThree } from './scene.js';

export const PROJECT_FORMAT = 'radmir-map-project';
export const PROJECT_VERSION = 1;

const PAINT = [[[60, 255, 0], 0], [[255, 0, 175], 1], [[0, 255, 255], 2], [[255, 0, 255], 3]];
const LIGHTS = [[255, 175, 0], [0, 255, 200], [185, 255, 0], [255, 60, 0]];
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export class Editor {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.overrides = new Map();
    this.added = new Map();
    this.objects = new Map();
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.snap = { grid: 0, angle: 0, surface: false };
    this.placeMode = null;
    this.nextUid = 1;
    this.pivot = new THREE.Object3D();
    this.scene.root.add(this.pivot);
    this.gizmo = new TransformControls(this.scene.camera, this.scene.canvas);
    this.gizmo.setSize(0.9);
    const helper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    this.scene.scene.add(helper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.app.controls.enabled = !e.value;
      if (e.value) this.beginDrag(); else this.endDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this.dragUpdate());
    this.carcols = null;
    this.selBox = null;
    this.stableByIid = new Map();
    this.iidByStable = new Map();
    this.syncing = new Map();
  }

  async loadCarcols() {
    if (!this.carcols) this.carcols = await getJson('/api/carcols').catch(() => ({ colors: [], cars: {} }));
    return this.carcols;
  }

  async buildObject(spec) {
    const sc = this.scene;
    const asset = sc.specAsset(spec, () => 0);
    sc.assets.retain(asset);
    await sc.assets.whenReady(asset);
    if (asset.state === 'error') { sc.assets.release(asset); throw new Error(asset.error); }
    const group = new THREE.Group();
    group.userData.asset = asset;
    const vehicle = spec.section === 'cars';
    const colors = vehicle ? await this.vehicleColors(spec) : null;
    for (const p of asset.parts) {
      let mats = p.materials;
      if (vehicle) mats = mats.map((m) => this.paint(m, colors));
      const mesh = new THREE.Mesh(p.geometry, mats);
      mesh.visible = spec.components && spec.components[p.name] !== undefined ? spec.components[p.name] : p.visible;
      mesh.userData.part = p;
      group.add(mesh);
    }
    if (vehicle) this.addWheels(group, asset);
    return group;
  }

  async vehicleColors(spec) {
    const cc = await this.loadCarcols();
    const sets = (cc.cars[(spec.name || '').toLowerCase()] || {}).sets || [];
    const pick = spec.colors || sets[0] || [1, 1];
    const rgb = pick.map((i) => cc.colors[i] || [200, 200, 200]);
    return { indices: pick, rgb, sets, source: sets.length ? 'carcols.dat' : 'нет в carcols.dat — цвет 1/1' };
  }

  paint(mat, colors) {
    const src = mat.userData.source;
    if (!src) return mat;
    const c = src.color;
    let rgb = null;
    for (const [marker, slot] of PAINT) if (same(c, marker)) rgb = colors.rgb[slot] || colors.rgb[0];
    if (!rgb && LIGHTS.some((l) => same(c, l))) rgb = [255, 255, 255];
    if (!rgb) return mat;
    const m = cloneMaterial(mat);
    m.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    return m;
  }

  addWheels(group, asset) {
    const h = asset.header;
    const frames = h.frames;
    const wheelPart = asset.parts.find((p) => /^wheel/i.test(p.name) && p.visible) || asset.parts.find((p) => /wheel/i.test(p.name));
    if (!wheelPart) return;
    const wheelFrame = frames[wheelPart.atomic.frame];
    const src = frames.findIndex((f, i) => /^wheel_[lr][fbm]_dummy$/i.test(f.name) && (i === wheelFrame.parent || i === wheelPart.atomic.frame));
    if (src < 0) return;
    const ltm = (i) => rwMatrix(ltmOf(frames, i));
    const srcInv = ltm(src).invert();
    for (let i = 0; i < frames.length; i++) {
      if (i === src || !/^wheel_[lr][fbm]_dummy$/i.test(frames[i].name)) continue;
      const left = /^wheel_l/i.test(frames[i].name);
      const m = ltm(i);
      if (left) m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
      m.multiply(srcInv);
      const mesh = new THREE.Mesh(wheelPart.geometry, group.children[asset.parts.indexOf(wheelPart)].material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      mesh.userData.part = wheelPart;
      mesh.userData.wheelClone = frames[i].name;
      group.add(mesh);
    }
  }

  keyOf(ref) { return ref.kind === 'base' ? `b${ref.iid}` : `a${ref.uid}`; }

  baseRecord(iid) { return this.scene.inst.get(iid); }

  async ensureBase(iid) {
    let r = this.scene.inst.get(iid);
    if (!r) {
      const list = decodeInstances(await getBuffer(`/api/world/instances?ids=${iid}`));
      if (list[0]) r = this.scene.addInstance(list[0]);
    }
    return r;
  }

  transformOf(ref) {
    if (ref.kind === 'base') {
      const ov = this.overrides.get(ref.stable);
      if (ov && ov.pos) return { pos: ov.pos, quat: ov.quat, scale: ov.scale || [1, 1, 1] };
      const r = this.baseRecord(ref.iid);
      return r ? { pos: [r.x, r.y, r.z], quat: [r.qx, r.qy, r.qz, r.qw], scale: [1, 1, 1] } : null;
    }
    const a = this.added.get(ref.uid);
    return a ? { pos: a.pos, quat: a.quat, scale: a.scale } : null;
  }

  matrixOf(t) {
    return new THREE.Matrix4().compose(new THREE.Vector3(...t.pos), new THREE.Quaternion(...t.quat), new THREE.Vector3(...t.scale));
  }

  shown(key) {
    const sc = this.scene;
    if (sc.isolate && !sc.isolate.has(key)) return false;
    if (key.startsWith('a')) { const a = this.added.get(Number(key.slice(1))); return !!a && !a.hidden; }
    const ov = this.overrides.get(this.stableByIid.get(Number(key.slice(1))));
    return !!ov && !ov.hidden && !ov.deleted;
  }

  async syncObject(key) {
    const prev = this.syncing.get(key);
    const run = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => this.syncNow(key));
    this.syncing.set(key, run);
    try { await run; } finally { if (this.syncing.get(key) === run) this.syncing.delete(key); }
  }

  async syncNow(key) {
    const sc = this.scene;
    const existing = this.objects.get(key);
    if (key.startsWith('b')) {
      const iid = Number(key.slice(1));
      const stable = this.stableByIid.get(iid) || null;
      const ov = stable ? this.overrides.get(stable) : null;
      if (!ov || !(ov.pos || ov.hidden || ov.deleted)) {
        sc.suppress.delete(iid);
        if (existing) this.removeObject(key);
        sc.lastUpdate = 0;
        return;
      }
      sc.suppress.add(iid);
      sc.lastUpdate = 0;
      if (!ov.pos) { if (existing) this.removeObject(key); return; }
      if (ov.hidden || ov.deleted) { if (existing) existing.group.visible = false; return; }
      const r = await this.ensureBase(iid);
      if (!r) return;
      let obj = existing;
      if (!obj) {
        const group = await this.buildObject({ mi: r.mi, section: sc.models[r.mi].section, name: sc.models[r.mi].name });
        group.userData.ref = { kind: 'base', iid, stable };
        obj = { key, group };
        this.objects.set(key, obj);
        sc.dynGroup.add(group);
      }
      const now = this.overrides.get(stable);
      if (!now || !now.pos) { this.removeObject(key); return; }
      obj.group.visible = this.shown(key);
      this.placeGroup(obj.group, { pos: now.pos, quat: now.quat, scale: now.scale || [1, 1, 1] });
      return;
    }
    const uid = Number(key.slice(1));
    const a = this.added.get(uid);
    if (!a) { if (existing) this.removeObject(key); return; }
    let obj = existing;
    if (obj && obj.specKey !== specKey(a)) { this.removeObject(key); obj = null; }
    if (!obj) {
      let group;
      try { group = await this.buildObject({ ...a.ref, name: a.name, colors: a.options && a.options.colors, components: a.options && a.options.components }); }
      catch (e) { this.app.ui.toast(`Объект «${a.name}» не построен: ${e.message}`, 'error'); return; }
      group.userData.ref = { kind: 'added', uid };
      obj = { key, group, specKey: specKey(a) };
      this.objects.set(key, obj);
      sc.dynGroup.add(group);
    }
    const now = this.added.get(uid);
    if (!now) { this.removeObject(key); return; }
    obj.group.visible = this.shown(key);
    this.placeGroup(obj.group, now);
  }

  placeGroup(group, t) {
    group.position.set(...t.pos);
    group.quaternion.set(...t.quat);
    group.scale.set(...t.scale);
    group.updateMatrixWorld(true);
  }

  async rebuildAll(between) {
    const keys = [...this.objects.keys()];
    for (const k of keys) this.removeObject(k);
    if (between) await between();
    for (const k of keys) await this.syncObject(k);
    this.updateSelectionVisuals();
  }

  removeObject(key) {
    const obj = this.objects.get(key);
    if (!obj) return;
    this.scene.dynGroup.remove(obj.group);
    if (obj.group.userData.asset) this.scene.assets.release(obj.group.userData.asset);
    obj.group.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) for (const m of o.material) if (m.userData && !m.userData.modelKey) m.dispose(); });
    this.objects.delete(key);
  }

  snapshot(keys) {
    const s = {};
    for (const k of keys) {
      if (k.startsWith('o:')) { const ov = this.overrides.get(k.slice(2)); s[k] = ov ? JSON.parse(JSON.stringify(ov)) : null; }
      else if (k.startsWith('a:')) { const a = this.added.get(Number(k.slice(2))); s[k] = a ? JSON.parse(JSON.stringify(a)) : null; }
    }
    return s;
  }

  async restore(s) {
    const touched = [];
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith('o:')) {
        const stable = k.slice(2);
        if (v) this.overrides.set(stable, v); else this.overrides.delete(stable);
        const iid = this.iidByStable.get(stable);
        if (iid !== undefined) touched.push(`b${iid}`);
      } else {
        const uid = Number(k.slice(2));
        if (v) this.added.set(uid, v); else this.added.delete(uid);
        touched.push(`a${uid}`);
      }
    }
    for (const t of touched) await this.syncObject(t);
    this.app.ui.refreshSelection();
    this.app.ui.updateLayerSummary();
  }

  async commit(label, keys, mutate) {
    const before = this.snapshot(keys);
    await mutate();
    const after = this.snapshot(keys);
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    await this.restore(after);
    this.app.ui.updateHistory();
  }
  async undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    this.redoStack.push(c);
    await this.restore(c.before);
    this.app.ui.updateHistory();
    this.app.ui.toast(`Отменено: ${c.label}`);
  }
  async redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    this.undoStack.push(c);
    await this.restore(c.after);
    this.app.ui.updateHistory();
    this.app.ui.toast(`Повторено: ${c.label}`);
  }

  async stablesFor(iids) {
    this.stableByIid = this.stableByIid || new Map();
    this.iidByStable = this.iidByStable || new Map();
    const need = iids.filter((i) => !this.stableByIid.has(i));
    if (need.length) {
      const map = await getJson(`/api/stable?ids=${need.join(',')}`);
      for (const [i, s] of Object.entries(map)) { this.stableByIid.set(Number(i), s); this.iidByStable.set(s, Number(i)); }
    }
    return iids.map((i) => this.stableByIid.get(i));
  }

  undoKey(ref) { return ref.kind === 'base' ? `o:${ref.stable}` : `a:${ref.uid}`; }

  async select(refs, add = false) {
    if (!add) this.selection = [];
    for (const r of refs) {
      if (r.kind === 'base' && !r.stable) r.stable = (await this.stablesFor([r.iid]))[0];
      const k = this.keyOf(r);
      const idx = this.selection.findIndex((x) => this.keyOf(x) === k);
      if (idx >= 0 && add) this.selection.splice(idx, 1); else if (idx < 0) this.selection.push(r);
    }
    this.scene.selection = new Set(this.selection.filter((r) => r.kind === 'base').map((r) => r.iid));
    this.updateSelectionVisuals();
    this.app.ui.refreshSelection();
  }

  updateSelectionVisuals() {
    const sc = this.scene;
    if (this.selBox) { sc.overlay.remove(this.selBox); this.selBox.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.selBox = null; }
    const g = new THREE.Group();
    const items = [];
    for (const r of this.selection) {
      const t = this.transformOf(r);
      if (!t) continue;
      const m = this.matrixOf(t);
      let box = null;
      const obj = this.objects.get(this.keyOf(r));
      if (obj) box = new THREE.Box3().setFromObject(obj.group, true);
      else {
        const rec = this.baseRecord(r.iid);
        const b = rec && sc.batches.get(rec.mi);
        if (b && b.asset.box) box = b.asset.box.clone().applyMatrix4(m);
        else { const mm = rec && sc.models[rec.mi]; const rad = mm && mm.bs ? mm.bs[3] : 3; box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...t.pos), new THREE.Vector3(rad * 2, rad * 2, rad * 2)); }
      }
      if (obj && !box.isEmpty()) {
        const inv = sc.root.matrixWorld.clone().invert();
        box.applyMatrix4(inv);
      }
      const helper = new THREE.Box3Helper(box, 0xffee00);
      helper.material.depthTest = false;
      helper.renderOrder = 10;
      g.add(helper);
      const axes = new THREE.AxesHelper(Math.max(1.5, box.getSize(new THREE.Vector3()).length() * 0.3));
      axes.matrixAutoUpdate = false;
      axes.matrix.copy(m);
      axes.material.depthTest = false;
      axes.renderOrder = 11;
      g.add(axes);
      const rec = r.kind === 'base' ? this.baseRecord(r.iid) : null;
      items.push({ mi: rec ? rec.mi : (this.added.get(r.uid) || {}).ref?.mi, matrix: m });
    }
    this.selBox = g;
    sc.overlay.add(g);
    sc.showSelectedCollision(items.filter((x) => x.mi !== undefined && x.mi >= 0));
    this.attachGizmo();
  }

  attachGizmo() {
    if (!this.selection.length || !this.gizmoMode) { this.gizmo.detach(); return; }
    const pos = new THREE.Vector3();
    let n = 0;
    for (const r of this.selection) { const t = this.transformOf(r); if (t) { pos.add(new THREE.Vector3(...t.pos)); n++; } }
    if (!n) { this.gizmo.detach(); return; }
    pos.divideScalar(n);
    this.pivot.position.copy(pos);
    const first = this.transformOf(this.selection[0]);
    this.pivot.quaternion.set(...(this.selection.length === 1 ? first.quat : [0, 0, 0, 1]));
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.setTranslationSnap(this.snap.grid > 0 ? this.snap.grid : null);
    this.gizmo.setRotationSnap(this.snap.angle > 0 ? THREE.MathUtils.degToRad(this.snap.angle) : null);
  }

  setGizmoMode(mode) {
    this.gizmoMode = mode;
    this.attachGizmo();
    this.app.ui.updateToolState();
  }

  beginDrag() {
    const refs = [...this.selection];
    const drag = { pivot: this.pivot.matrix.clone(), items: [], refs, before: this.snapshot(refs.map((r) => this.undoKey(r))) };
    this.drag = drag;
    drag.ready = (async () => {
      for (const r of refs) {
        if (r.kind === 'base') await this.makeEditable(r);
        const t = this.transformOf(r);
        if (t) drag.items.push({ ref: r, start: this.matrixOf(t) });
      }
      if (this.drag === drag) this.dragUpdate();
    })();
  }

  async makeEditable(ref) {
    if (this.overrides.has(ref.stable) && this.overrides.get(ref.stable).pos) return;
    const r = await this.ensureBase(ref.iid);
    const ov = this.overrides.get(ref.stable) || {};
    ov.pos = [r.x, r.y, r.z]; ov.quat = [r.qx, r.qy, r.qz, r.qw]; ov.scale = [1, 1, 1];
    ov.original = { pos: [r.x, r.y, r.z], quat: [r.qx, r.qy, r.qz, r.qw] };
    ov.model = { id: this.scene.models[r.mi] ? this.scene.models[r.mi].id : null, name: this.scene.models[r.mi] ? this.scene.models[r.mi].name : null };
    this.overrides.set(ref.stable, ov);
    await this.syncObject(`b${ref.iid}`);
  }

  dragUpdate() {
    if (!this.drag) return;
    this.pivot.updateMatrix();
    const delta = this.pivot.matrix.clone().multiply(this.drag.pivot.clone().invert());
    for (const it of this.drag.items) {
      const m = delta.clone().multiply(it.start);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      this.setTransform(it.ref, { pos: p.toArray(), quat: q.toArray(), scale: s.toArray() }, false);
    }
    this.app.ui.refreshTransformFields();
  }

  async endDrag() {
    const drag = this.drag;
    if (!drag) return;
    await drag.ready;
    this.dragUpdate();
    this.drag = null;
    if (this.snap.surface) for (const it of drag.items) await this.dropToSurface(it.ref, false);
    for (const r of drag.refs) {
      if (r.kind !== 'base' || drag.before[this.undoKey(r)]) continue;
      const ov = this.overrides.get(r.stable);
      if (ov && ov.original && !ov.hidden && !ov.deleted && sameTransform(ov, ov.original)) { this.overrides.delete(r.stable); await this.syncObject(`b${r.iid}`); }
    }
    const keys = drag.refs.map((r) => this.undoKey(r));
    const after = this.snapshot(keys);
    const label = { translate: 'перемещение', rotate: 'поворот', scale: 'масштаб' }[this.gizmoMode] || 'перемещение';
    if (JSON.stringify(after) !== JSON.stringify(drag.before)) { this.undoStack.push({ label, before: drag.before, after }); this.redoStack = []; }
    this.updateSelectionVisuals();
    this.app.ui.updateHistory();
    this.app.ui.updateLayerSummary();
  }

  setTransform(ref, t, sync = true) {
    if (ref.kind === 'base') {
      const ov = this.overrides.get(ref.stable);
      if (!ov) return;
      Object.assign(ov, t);
    } else {
      const a = this.added.get(ref.uid);
      if (!a) return;
      Object.assign(a, t);
    }
    const obj = this.objects.get(this.keyOf(ref));
    if (obj) this.placeGroup(obj.group, { ...this.transformOf(ref) });
    if (sync) this.updateSelectionVisuals();
  }

  async applyNumeric(ref, t) {
    await this.commit('изменение координат', [this.undoKey(ref)], async () => {
      if (ref.kind === 'base') await this.makeEditable(ref);
      this.setTransform(ref, t, false);
    });
    this.updateSelectionVisuals();
  }

  async dropToSurface(ref, record = true) {
    const t = this.transformOf(ref);
    const obj = this.objects.get(this.keyOf(ref));
    const z = this.scene.groundAt(t.pos[0], t.pos[1], t.pos[2] + 50, obj ? obj.group : null);
    if (z === null) { this.app.ui.toast('Под объектом нет поверхности из загруженных моделей', 'warn'); return; }
    let minZ = 0;
    if (obj) { const box = new THREE.Box3().setFromObject(obj.group, true); const inv = this.scene.root.matrixWorld.clone().invert(); box.applyMatrix4(inv); minZ = box.min.z - t.pos[2]; }
    const pos = [t.pos[0], t.pos[1], z - minZ];
    if (record) await this.commit('на поверхность', [this.undoKey(ref)], async () => { if (ref.kind === 'base') await this.makeEditable(ref); this.setTransform(ref, { pos }, false); });
    else this.setTransform(ref, { pos }, false);
  }

  async addModel(spec, placement) {
    const uid = this.nextUid++;
    const a = {
      uid, name: spec.name, kind: spec.section === 'cars' ? 'vehicle' : spec.section === 'peds' ? 'ped' : spec.importId ? 'import' : 'object',
      ref: { mi: spec.mi, rid: spec.rid, key: spec.key, id: spec.id, section: spec.section, txd: spec.txd, clump: spec.clump, flags: spec.flags, importId: spec.importId },
      pos: placement.pos, quat: placement.quat || [0, 0, 0, 1], scale: [1, 1, 1], hidden: false, options: spec.options || {},
    };
    await this.commit(`добавление «${spec.name}»`, [`a:${uid}`], async () => { this.added.set(uid, a); });
    const ref = { kind: 'added', uid };
    if (placement.restOn !== undefined) this.restOn(ref, placement.restOn);
    else if (placement.dropToSurface) await this.dropToSurface(ref, false);
    const now = this.added.get(uid);
    if (now) now.initial = { pos: [...now.pos], quat: [...now.quat], scale: [...now.scale] };
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && `a:${uid}` in last.after) last.after = this.snapshot([`a:${uid}`]);
    await this.select([ref]);
    return uid;
  }

  restOn(ref, z) {
    const obj = this.objects.get(this.keyOf(ref));
    const t = this.transformOf(ref);
    if (!obj || !t) return;
    const box = new THREE.Box3().setFromObject(obj.group, true);
    if (box.isEmpty()) return;
    box.applyMatrix4(this.scene.root.matrixWorld.clone().invert());
    this.setTransform(ref, { pos: [t.pos[0], t.pos[1], z - (box.min.z - t.pos[2])] }, false);
  }

  async duplicate() {
    const refs = [...this.selection];
    const made = [];
    for (const r of refs) {
      const t = this.transformOf(r);
      if (!t) continue;
      let spec;
      if (r.kind === 'base') {
        const rec = await this.ensureBase(r.iid);
        const m = this.scene.models[rec.mi];
        spec = { mi: rec.mi, rid: m.dff, id: m.id, name: m.name, section: m.section, txd: m.txd, clump: m.clump, flags: m.flags };
      } else { const a = this.added.get(r.uid); spec = { ...a.ref, name: a.name, options: JSON.parse(JSON.stringify(a.options || {})) }; }
      const uid = this.nextUid++;
      const pos = [t.pos[0] + 2, t.pos[1], t.pos[2]];
      const a = { uid, name: spec.name, kind: 'object', ref: { mi: spec.mi, rid: spec.rid, id: spec.id, section: spec.section, txd: spec.txd, clump: spec.clump, flags: spec.flags, importId: spec.importId }, pos, quat: [...t.quat], scale: [...t.scale], hidden: false, options: spec.options || {} };
      a.kind = spec.section === 'cars' ? 'vehicle' : spec.section === 'peds' ? 'ped' : spec.importId ? 'import' : 'object';
      a.initial = { pos: [...pos], quat: [...t.quat], scale: [...t.scale] };
      made.push(a);
    }
    if (!made.length) return;
    await this.commit(`копирование (${made.length})`, made.map((a) => `a:${a.uid}`), async () => { for (const a of made) this.added.set(a.uid, a); });
    await this.select(made.map((a) => ({ kind: 'added', uid: a.uid })));
  }

  async setHidden(hidden) {
    const refs = [...this.selection];
    if (!refs.length) return;
    await this.commit(hidden ? 'скрытие' : 'показ', refs.map((r) => this.undoKey(r)), async () => {
      for (const r of refs) {
        if (r.kind === 'base') {
          const ov = this.overrides.get(r.stable) || {};
          if (hidden) ov.hidden = true; else delete ov.hidden;
          if (ov.pos || ov.hidden || ov.deleted) this.overrides.set(r.stable, ov); else this.overrides.delete(r.stable);
        } else { const a = this.added.get(r.uid); if (a) a.hidden = hidden; }
      }
    });
  }

  async deleteSelection() {
    const refs = [...this.selection];
    if (!refs.length) return;
    await this.commit(`удаление (${refs.length})`, refs.map((r) => this.undoKey(r)), async () => {
      for (const r of refs) {
        if (r.kind === 'base') { const ov = this.overrides.get(r.stable) || {}; ov.deleted = true; this.overrides.set(r.stable, ov); }
        else this.added.delete(r.uid);
      }
    });
    await this.select([]);
  }

  async resetSelection() {
    const refs = [...this.selection];
    await this.commit('сброс объекта', refs.map((r) => this.undoKey(r)), async () => {
      for (const r of refs) {
        if (r.kind === 'base') this.overrides.delete(r.stable);
        else { const a = this.added.get(r.uid); if (a && a.initial) Object.assign(a, JSON.parse(JSON.stringify(a.initial)), { hidden: false }); }
      }
    });
    this.updateSelectionVisuals();
  }

  isolateSelection(on) {
    const sc = this.scene;
    sc.isolate = on && this.selection.length ? new Set(this.selection.map((r) => this.keyOf(r))) : null;
    for (const [k, o] of this.objects) o.group.visible = this.shown(k);
    sc.lastUpdate = 0;
  }

  async removeAllAdded() {
    const keys = [...this.added.keys()].map((u) => `a:${u}`);
    if (!keys.length) return;
    await this.commit('удаление всех добавленных', keys, async () => { this.added.clear(); });
    await this.select(this.selection.filter((r) => r.kind === 'base'));
  }

  async resetAll() {
    const keys = [...[...this.overrides.keys()].map((s) => `o:${s}`), ...[...this.added.keys()].map((u) => `a:${u}`)];
    await this.commit('полный сброс сцены', keys, async () => { this.overrides.clear(); this.added.clear(); });
    this.scene.isolate = null;
    await this.select([]);
    this.scene.suppress.clear();
    this.scene.lastUpdate = 0;
  }

  async toProject() {
    const sc = this.scene;
    const profile = await getJson('/api/profile');
    const sources = new Set();
    const overrides = [];
    for (const [stable, ov] of this.overrides) {
      overrides.push({ stable, ...ov });
      sources.add(stable.slice(0, stable.lastIndexOf('#')));
    }
    const added = [...this.added.values()].map((a) => {
      const res = a.ref.rid !== undefined && a.ref.rid >= 0 ? a.ref.key : null;
      return { ...a, resourceKey: res };
    });
    const resKeys = await this.resourceKeys(added);
    for (const k of resKeys) if (k) sources.add(k);
    const fp = await sendJson('/api/fingerprints', 'POST', [...sources]);
    return {
      format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: new Date().toISOString(), application: 'Просмотр объектов RADMIR',
      profile: { id: profile.profile.id, name: profile.profile.name, rules: profile.profile.rules, manifests: profile.profile.manifests, worldGeneration: sc.generation },
      sources: fp, overrides, added, camera: this.app.controls.bookmark('camera'), bookmarks: this.app.bookmarks,
      layers: { interiors: [...sc.settings.interiors], hiddenSourceKeys: sc.meta.sourcesList.filter((s) => sc.settings.hiddenSources.has(s.si)).map((s) => s.key), drawScale: sc.settings.drawScale },
    };
  }

  async resourceKeys(added) {
    const out = [];
    for (const a of added) {
      if (a.ref.importId) { out.push(null); a.resourceKey = `import:${a.ref.importId}`; continue; }
      if (a.ref.rid === undefined || a.ref.rid < 0) { out.push(null); continue; }
      try { const info = await getJson(`/api/inspect/resource/${a.ref.rid}`); a.resourceKey = info.resource.key; out.push(info.resource.key); } catch { out.push(null); }
    }
    return out;
  }

  async loadProject(p) {
    const warnings = [];
    if (!p || p.format !== PROJECT_FORMAT) throw new Error('это не проект просмотрщика (нет format = radmir-map-project)');
    if (p.version > PROJECT_VERSION) warnings.push(`проект версии ${p.version}, приложение понимает версию ${PROJECT_VERSION}`);
    const profile = await getJson('/api/profile');
    if (p.profile && p.profile.id !== profile.profile.id) warnings.push(`проект сохранён с профилем «${p.profile.name}», сейчас активен «${profile.profile.name}»`);
    const keys = Object.keys(p.sources || {});
    if (keys.length) {
      const now = await sendJson('/api/fingerprints', 'POST', keys);
      for (const k of keys) {
        const a = p.sources[k], b = now[k];
        if (!b || !b.exists) warnings.push(`ресурс отсутствует: ${k}`);
        else if (a && a.exists && (a.size !== b.size || (a.containerSize && a.containerSize !== b.containerSize) || (a.mtime && a.mtime !== b.mtime))) warnings.push(`ресурс изменился с момента сохранения: ${k}`);
      }
    }
    const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
    const overrides = (Array.isArray(p.overrides) ? p.overrides : []).filter((o) => o && typeof o.stable === 'string' && o.stable.includes('#') && (!o.pos || (vec(o.pos, 3) && vec(o.quat, 4))));
    const addedList = (Array.isArray(p.added) ? p.added : []).filter((a) => a && a.ref && typeof a.name === 'string' && vec(a.pos, 3) && vec(a.quat, 4) && vec(a.scale, 3));
    const dropped = ((p.overrides || []).length - overrides.length) + ((p.added || []).length - addedList.length);
    if (dropped) warnings.push(`записей с неполными данными пропущено: ${dropped}`);
    const stables = overrides.map((o) => o.stable);
    const iids = stables.length ? await sendJson('/api/resolve', 'POST', stables) : {};
    for (const key of [...this.objects.keys()]) this.removeObject(key);
    this.overrides.clear(); this.added.clear();
    this.scene.suppress.clear();
    this.stableByIid = this.stableByIid || new Map();
    this.iidByStable = this.iidByStable || new Map();
    let missing = 0;
    for (const o of overrides) {
      const iid = iids[o.stable];
      if (iid === undefined || iid < 0) { missing++; continue; }
      const { stable, ...ov } = o;
      this.overrides.set(stable, ov);
      this.stableByIid.set(iid, stable); this.iidByStable.set(stable, iid);
    }
    if (missing) warnings.push(`изменённые базовые объекты не найдены в текущем профиле и пропущены: ${missing}`);
    const resKeys = addedList.map((a) => a.resourceKey).filter((k) => k && !k.startsWith('import:'));
    const rids = resKeys.length ? await sendJson('/api/reskeys', 'POST', resKeys) : {};
    const imports = addedList.some((a) => a.ref.importId) ? new Set((await getJson('/api/imports').catch(() => [])).filter((i) => i.ok).map((i) => i.id)) : new Set();
    for (const a of addedList) {
      if (!Number.isInteger(a.uid) || a.uid < 1 || this.added.has(a.uid)) a.uid = Math.max(this.nextUid, ...[...this.added.keys()].map((u) => u + 1), 1);
      if (a.ref.importId && !imports.has(a.ref.importId)) { warnings.push(`импорт «${a.ref.importId}» для «${a.name}» удалён или повреждён — объект пропущен`); continue; }
      if (a.resourceKey && !a.ref.importId) {
        const rid = rids[a.resourceKey];
        if (rid === undefined || rid < 0) { warnings.push(`модель «${a.name}» (${a.resourceKey}) не найдена — объект пропущен`); continue; }
        a.ref.rid = rid;
        const mi = a.ref.id !== undefined ? this.scene.modelById.get(a.ref.id) : undefined;
        if (mi !== undefined && this.scene.models[mi].dff === rid) a.ref.mi = mi; else delete a.ref.mi;
      }
      this.added.set(a.uid, a);
      this.nextUid = Math.max(this.nextUid, a.uid + 1);
    }
    this.undoStack = []; this.redoStack = [];
    for (const [stable] of this.overrides) await this.syncObject(`b${this.iidByStable.get(stable)}`);
    for (const uid of this.added.keys()) await this.syncObject(`a${uid}`);
    if (p.layers) {
      const sc = this.scene;
      if (Array.isArray(p.layers.interiors)) sc.settings.interiors = new Set(p.layers.interiors.filter(Number.isInteger));
      if (Array.isArray(p.layers.hiddenSourceKeys)) {
        const byKey = new Map(sc.meta.sourcesList.map((s) => [s.key, s.si]));
        sc.settings.hiddenSources = new Set(p.layers.hiddenSourceKeys.map((k) => byKey.get(k)).filter((si) => si !== undefined));
        const lost = p.layers.hiddenSourceKeys.filter((k) => !byKey.has(k));
        if (lost.length) warnings.push(`скрытые IPL не найдены в текущем профиле: ${lost.join(', ')}`);
      } else if (Array.isArray(p.layers.hiddenSources) && p.layers.hiddenSources.length) warnings.push('скрытые IPL записаны номерами (старая запись) — не применены, все IPL показаны');
      if (Number.isFinite(p.layers.drawScale) && p.layers.drawScale > 0) sc.settings.drawScale = p.layers.drawScale;
    }
    if (Array.isArray(p.bookmarks)) {
      const same = (a, b) => a.name === b.name && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) && Math.round(a.z) === Math.round(b.z);
      for (const b of p.bookmarks) if (b && Number.isFinite(b.x) && !this.app.bookmarks.some((x) => same(x, b))) this.app.bookmarks.push(b);
      this.app.saveBookmarks();
    }
    const c = p.camera;
    if (c && [c.x, c.y, c.z, c.yaw, c.pitch].every(Number.isFinite)) this.app.controls.setPose(c.x, c.y, c.z, c.yaw, c.pitch);
    this.scene.lastUpdate = 0;
    await this.select([]);
    this.app.ui.updateHistory();
    this.app.ui.updateLayerSummary();
    return warnings;
  }

  async exportLayer() {
    const p = await this.toProject();
    download(`слой-пользователя-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(p, null, 1));
  }

  summary() {
    let moved = 0, hidden = 0, deleted = 0;
    for (const ov of this.overrides.values()) { if (ov.deleted) deleted++; else if (ov.hidden) hidden++; if (ov.pos) moved++; }
    return { moved, hidden, deleted, added: this.added.size, undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

function specKey(a) { return JSON.stringify([a.ref, a.options && a.options.colors, a.options && a.options.components]); }

function sameTransform(t, o) {
  const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) <= e);
  const dot = Math.abs(t.quat.reduce((s, v, i) => s + v * o.quat[i], 0));
  return near(t.pos, o.pos, 1e-3) && dot > 1 - 1e-7 && near(t.scale || [1, 1, 1], [1, 1, 1], 1e-6);
}

function ltmOf(frames, index) {
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  for (let i = index, guard = 0; i >= 0 && i < frames.length && guard < 64; i = frames[i].parent, guard++) {
    const f = frames[i];
    if (f.parent < 0) break;
    const r = f.rot, p = f.pos, n = new Array(12);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) n[row * 3 + col] = m[row * 3] * r[col] + m[row * 3 + 1] * r[3 + col] + m[row * 3 + 2] * r[6 + col];
    for (let col = 0; col < 3; col++) n[9 + col] = m[9] * r[col] + m[10] * r[3 + col] + m[11] * r[6 + col] + p[col];
    m = n;
  }
  return m;
}

export { gtaToThree };
