import * as THREE from 'three';
import { getJson, getBuffer, decodeCells, decodeInstances, sendJson } from './api.js';
import { Assets, rwMatrix } from './assets.js';

export const CLUMP = new Set(['cars', 'peds', 'weap', 'hier', 'anim']);
const SURFACE_COLORS = [0x8d8d8d, 0x6c9a4c, 0xb59a5a, 0x5a7dbb, 0xbb5a5a, 0x9a5abb, 0x5abba8, 0xbbb25a];

export function gtaToThree(x, y, z) { return new THREE.Vector3(x, z, -y); }
export function threeToGta(v) { return { x: v.x, y: -v.z, z: v.y }; }

export class MapScene {
  constructor(canvas, hooks = {}) {
    THREE.ColorManagement.enabled = false;
    this.hooks = hooks;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.sky = new THREE.Color(0x9fc3e0);
    this.scene.background = this.sky;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 12000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, 1, 0.3);
    this.scene.add(sun);
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;
    this.root.updateMatrixWorld(true);
    this.scene.add(this.root);
    this.baseGroup = new THREE.Group(); this.dynGroup = new THREE.Group(); this.overlay = new THREE.Group(); this.serviceGroup = new THREE.Group(); this.colGroup = new THREE.Group();
    this.root.add(this.baseGroup, this.dynGroup, this.overlay, this.serviceGroup, this.colGroup);
    this.assets = new Assets(this.renderer);
    this.models = [];
    this.inst = new Map();
    this.cells = new Map();
    this.far = [];
    this.batches = new Map();
    this.meta = null;
    this.settings = {
      drawScale: 1, maxDistance: 1600, interiors: new Set([0]), lodMode: 'auto', hiddenSources: new Set(), showModels: true,
      wire: false, boxes: false, axes: false, labels: false, colSelected: false, colArea: false, hideDuplicates: false, showUnknown: false,
    };
    this.suppress = new Set();
    this.isolate = null;
    this.selection = new Set();
    this.selObjects = [];
    this.visibleCount = 0;
    this.lastUpdate = 0;
    this.lastCellCheck = 0;
    this.camGta = { x: 0, y: 0, z: 0 };
    this.frustum = new THREE.Frustum();
    this.tmpM = new THREE.Matrix4();
    this.colCache = new Map();
    this.serviceLayers = {};
    this.labels = [];
    this.stats = { cellsLoaded: 0, cellRequests: 0, instances: 0, candidates: 0, visible: 0, pending: 0, batches: 0 };
    this.raycaster = new THREE.Raycaster();
    this.boxLines = null;
    this.axesLines = null;
  }

  async init() {
    const [models, meta] = await Promise.all([getJson('/api/models'), getJson('/api/world/meta')]);
    this.generation = models.generation;
    this.models = models.models.map((m, mi) => ({ mi, id: m[0], name: m[1], txd: m[2], section: m[3], dd: m[4], flags: m[5], dff: m[6], txdRid: m[7], bs: m[8], clump: !!m[9], col: m[10] }));
    this.modelById = new Map(this.models.map((m) => [m.id, m.mi]));
    this.meta = meta;
    this.scales = new Map(meta.scales || []);
    this.settings.hideDuplicates = !!(meta.rules && meta.rules.hideExactDuplicates);
    const farBuf = await getBuffer('/api/world/far');
    this.far = decodeInstances(farBuf).map((r) => this.addInstance(r).iid);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  addInstance(r) {
    const existing = this.inst.get(r.iid);
    if (existing) return existing;
    const m = new THREE.Matrix4();
    const s = this.scales.get(r.iid);
    m.compose(new THREE.Vector3(r.x, r.y, r.z), new THREE.Quaternion(r.qx, r.qy, r.qz, r.qw), s ? new THREE.Vector3(s[0], s[1], s[2]) : new THREE.Vector3(1, 1, 1));
    r.matrix = m;
    this.inst.set(r.iid, r);
    return r;
  }

  modelUrl(mi) {
    const m = this.models[mi];
    return `/api/geom/${m.dff}?mi=${mi}&g=${this.generation}`;
  }

  modelAsset(mi, priority) {
    const m = this.models[mi];
    return this.assets.model(`m${mi}`, this.modelUrl(mi), { mi, flags: m.flags, clump: m.clump, section: m.section }, priority);
  }

  specAsset(spec, priority) {
    if (spec.mi !== undefined && spec.mi >= 0) return this.modelAsset(spec.mi, priority);
    const section = spec.section || 'objs';
    const pose = section === 'peds' ? 'pose=ped' : '';
    if (spec.importId) return this.assets.model(`imp:${spec.importId}|${section}`, `/api/igeom/${encodeURIComponent(spec.importId)}?vehicle=${section === 'cars' ? 1 : 0}${pose ? `&${pose}` : ''}`, { flags: 0, clump: spec.clump !== false, section }, priority);
    return this.assets.model(`r${spec.rid}|${spec.txd || ''}|${section}`, `/api/geom/${spec.rid}?txd=${encodeURIComponent(spec.txd || '')}&vehicle=${section === 'cars' ? 1 : 0}${pose ? `&${pose}` : ''}&g=${this.generation}`, { flags: spec.flags || 0, clump: !!spec.clump, section }, priority);
  }

  async updateCells(force = false) {
    const now = performance.now();
    if (!force && now - this.lastCellCheck < 600) return;
    this.lastCellCheck = now;
    const size = this.meta.cellSize;
    const R = Math.min(this.settings.maxDistance, 1400);
    const cx = this.camGta.x, cy = this.camGta.y;
    const need = [];
    for (let gx = Math.floor((cx - R) / size); gx <= Math.floor((cx + R) / size); gx++) {
      for (let gy = Math.floor((cy - R) / size); gy <= Math.floor((cy + R) / size); gy++) {
        const k = `${gx},${gy}`;
        if (!this.meta.cellCounts[k]) continue;
        const dx = Math.max(0, Math.abs((gx + 0.5) * size - cx) - size / 2), dy = Math.max(0, Math.abs((gy + 0.5) * size - cy) - size / 2);
        if (Math.hypot(dx, dy) > R) continue;
        const c = this.cells.get(k);
        if (c) { c.lastNeeded = now; continue; }
        need.push({ k, d: Math.hypot(dx, dy) });
      }
    }
    need.sort((a, b) => a.d - b.d);
    const batch = need.slice(0, 24).map((x) => x.k);
    if (batch.length && !this.cellLoading) {
      this.cellLoading = true;
      for (const k of batch) this.cells.set(k, { k, iids: [], state: 'loading', lastNeeded: now });
      try {
        this.stats.cellRequests++;
        const { counts, instances } = decodeCells(await getBuffer(`/api/world/cells?c=${batch.join(';')}`));
        let o = 0;
        for (let i = 0; i < counts.length; i += 2) {
          const c = this.cells.get(counts[i]);
          const n = counts[i + 1];
          const list = instances.slice(o, o + n);
          o += n;
          if (c) { c.iids = list.map((r) => this.addInstance(r).iid); c.state = 'ready'; }
        }
      } catch (e) {
        for (const k of batch) this.cells.delete(k);
        if (this.hooks.error) this.hooks.error(`Ячейки карты не загрузились: ${e.message}`);
      }
      this.cellLoading = false;
      this.lastUpdate = 0;
    }
    for (const [k, c] of this.cells) {
      if (c.state !== 'ready' || now - c.lastNeeded < 20000) continue;
      for (const iid of c.iids) if (!this.selection.has(iid) && !this.suppress.has(iid)) this.inst.delete(iid);
      this.cells.delete(k);
    }
    this.stats.cellsLoaded = [...this.cells.values()].filter((c) => c.state === 'ready').length;
    this.stats.instances = this.inst.size;
  }

  hiddenByFilter(r, keepSuppressed = false) {
    if (!this.settings.interiors.has(r.interior & 0xff)) return true;
    if (this.settings.hiddenSources.has(r.src)) return true;
    if (this.settings.hideDuplicates && r.flags & 2) return true;
    if (!keepSuppressed && this.suppress.has(r.iid)) return true;
    if (this.isolate && !this.isolate.has(`b${r.iid}`)) return true;
    return false;
  }

  updateVisibility(force = false) {
    const now = performance.now();
    if (!force && now - this.lastUpdate < 180) return;
    this.lastUpdate = now;
    this.camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.root.matrixWorld);
    this.frustum.setFromProjectionMatrix(pv);
    const cam = this.camGta;
    const s = this.settings;
    const cand = [];
    const edited = [];
    const sphere = new THREE.Sphere();
    const consider = (iid) => {
      const r = this.inst.get(iid);
      if (!r || r.mi < 0) return;
      const m = this.models[r.mi];
      if (m.dff < 0) return;
      if (this.hiddenByFilter(r)) {
        if (r.lod >= 0 && !(r.flags & 1) && this.suppress.has(r.iid) && !this.hiddenByFilter(r, true)) edited.push(r);
        return;
      }
      const isLod = (r.flags & 1) !== 0;
      if (s.lodMode === 'hd' && isLod) return;
      if (s.lodMode === 'lod' && !isLod && r.lod >= 0) return;
      const rad = m.bs ? m.bs[3] : 20;
      const d = Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z);
      const limit = Math.min(m.dd * s.drawScale, s.maxDistance * (isLod ? 3 : 1));
      if (d - rad > limit) return;
      sphere.center.set(r.x + (m.bs ? m.bs[0] : 0), r.y + (m.bs ? m.bs[1] : 0), r.z + (m.bs ? m.bs[2] : 0));
      sphere.radius = rad * 1.5 + 2;
      if (!this.frustum.intersectsSphere(sphere)) { r._vis = false; return; }
      r._vis = true;
      r._d = d;
      cand.push(r);
    };
    for (const iid of this.far) consider(iid);
    for (const c of this.cells.values()) if (c.state === 'ready') for (const iid of c.iids) consider(iid);
    const shown = [];
    const hdReady = new Set();
    for (const r of cand) {
      if (r.flags & 1) continue;
      const a = this.batches.get(r.mi);
      if (a && a.asset.state === 'ready' && r.lod >= 0) hdReady.add(r.lod);
    }
    for (const r of edited) {
      const m = this.models[r.mi], rad = m.bs ? m.bs[3] : 20;
      if (Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) - rad <= Math.min(m.dd * s.drawScale, s.maxDistance)) hdReady.add(r.lod);
    }
    for (const r of cand) {
      if ((r.flags & 1) && s.lodMode === 'auto' && hdReady.has(r.iid)) continue;
      shown.push(r);
    }
    this.stats.candidates = cand.length;
    const byModel = new Map();
    for (const r of shown) {
      if (!byModel.has(r.mi)) byModel.set(r.mi, []);
      byModel.get(r.mi).push(r);
    }
    let pending = 0, visible = 0;
    for (const [mi, list] of byModel) {
      let b = this.batches.get(mi);
      if (!b) {
        const asset = this.modelAsset(mi, () => (b ? b.minDist : 1e9));
        this.assets.retain(asset);
        b = { mi, asset, meshes: [], cap: 0, iids: [], minDist: 1e9, lastVisible: now, built: false };
        this.batches.set(mi, b);
      }
      b.lastVisible = now;
      b.minDist = Math.min(...list.map((r) => r._d));
      if (b.asset.state !== 'ready') { if (b.asset.state !== 'error') pending++; continue; }
      this.fillBatch(b, list);
      visible += list.length;
    }
    for (const [mi, b] of this.batches) {
      if (byModel.has(mi)) continue;
      for (const mesh of b.meshes) { mesh.count = 0; mesh.visible = false; }
      b.iids = [];
      if (now - b.lastVisible > 25000) this.dropBatch(b);
    }
    this.stats.visible = visible;
    this.stats.pending = pending;
    this.stats.batches = this.batches.size;
    this.visibleCount = visible;
    if (s.boxes || s.axes) this.updateHelpers(shown);
    if (s.colArea) this.updateAreaCollisions(shown);
    this.assets.collect();
  }

  fillBatch(b, list) {
    const a = b.asset;
    if (!b.built || b.cap < list.length) {
      for (const mesh of b.meshes) { this.baseGroup.remove(mesh); mesh.dispose(); }
      b.cap = Math.max(4, list.length * 2);
      b.meshes = a.parts.filter((p) => p.visible).map((p) => {
        const mesh = new THREE.InstancedMesh(p.geometry, p.materials, b.cap);
        mesh.frustumCulled = false;
        mesh.userData = { batch: b, part: p };
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.baseGroup.add(mesh);
        return mesh;
      });
      b.built = true;
    }
    b.iids = list.map((r) => r.iid);
    for (const mesh of b.meshes) {
      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i].matrix);
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = this.settings.showModels;
      mesh.computeBoundingSphere();
    }
  }

  dropBatch(b) {
    for (const mesh of b.meshes) { this.baseGroup.remove(mesh); mesh.dispose(); }
    this.assets.release(b.asset);
    this.batches.delete(b.mi);
  }

  refreshAll() {
    for (const b of [...this.batches.values()]) this.dropBatch(b);
    this.lastUpdate = 0;
  }

  updateHelpers(shown) {
    const near = shown.filter((r) => r._d < 180).sort((a, b) => a._d - b._d).slice(0, 400);
    if (this.settings.boxes) {
      const pts = [];
      const corner = new THREE.Vector3();
      for (const r of near) {
        const m = this.models[r.mi];
        const a = this.batches.get(r.mi) && this.batches.get(r.mi).asset;
        const box = a && a.box ? a.box : null;
        if (!box) continue;
        const c = [];
        for (let k = 0; k < 8; k++) {
          corner.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).applyMatrix4(r.matrix);
          c.push(corner.clone());
        }
        for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) pts.push(c[i], c[j]);
        void m;
      }
      this.setLines('boxLines', pts, (r) => r, 0xffcc33);
    }
    if (this.settings.axes) {
      const pts = [];
      for (const r of near.slice(0, 150)) {
        const o = new THREE.Vector3().setFromMatrixPosition(r.matrix);
        const len = Math.max(1.5, Math.min(8, (this.models[r.mi].bs ? this.models[r.mi].bs[3] : 4) * 0.5));
        for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
          pts.push(o.clone(), o.clone().add(axis.transformDirection(r.matrix).multiplyScalar(len)));
        }
      }
      this.setLines('axesLines', pts, null, null, true);
    }
  }

  setLines(name, pts, _f, color, axisColors = false) {
    if (this[name]) { this.overlay.remove(this[name]); this[name].geometry.dispose(); this[name].material.dispose(); this[name] = null; }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    let mat;
    if (axisColors) {
      const cols = [];
      const palette = [[1, 0.2, 0.2], [0.2, 1, 0.2], [0.3, 0.5, 1]];
      for (let i = 0; i < pts.length; i += 2) { const c = palette[(i / 2) % 3]; cols.push(...c, ...c); }
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    } else mat = new THREE.LineBasicMaterial({ color, depthTest: true });
    this[name] = new THREE.LineSegments(g, mat);
    this[name].renderOrder = 5;
    this.overlay.add(this[name]);
  }

  clearHelpers() { this.setLines('boxLines', []); this.setLines('axesLines', []); }

  async collisionFor(mi) {
    if (this.colCache.has(mi)) return this.colCache.get(mi);
    const p = getJson(`/api/colfor/${mi}`).then((r) => (r.model ? r : null)).catch(() => null);
    this.colCache.set(mi, p);
    return p;
  }

  buildCollision(col, surfaces = []) {
    const g = new THREE.Group();
    g.userData.collision = col;
    const wire = new THREE.LineBasicMaterial({ color: 0xff3355 });
    for (const s of col.spheres || []) {
      const geo = new THREE.WireframeGeometry(new THREE.SphereGeometry(s.radius, 12, 8));
      const l = new THREE.LineSegments(geo, wire);
      l.position.set(...s.center);
      g.add(l);
    }
    for (const b of col.boxes || []) {
      const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(...size));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff8800 }));
      l.position.set((b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2);
      g.add(l);
    }
    if (col.faces && col.faces.length && col.vertices.length) {
      const pos = new Float32Array(col.faces.length * 9), colr = new Float32Array(col.faces.length * 9);
      col.faces.forEach((f, i) => {
        const c = new THREE.Color(SURFACE_COLORS[f[3] % SURFACE_COLORS.length]);
        for (let k = 0; k < 3; k++) {
          const v = col.vertices[f[k]] || [0, 0, 0];
          pos.set(v, i * 9 + k * 3);
          colr.set([c.r, c.g, c.b], i * 9 + k * 3);
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
      g.add(mesh);
      g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.6 })));
    }
    if (col.shadowFaces && col.shadowFaces.length) {
      const pos = [];
      for (const f of col.shadowFaces) for (let k = 0; k < 3; k++) pos.push(...(col.shadowVertices[f[k]] || [0, 0, 0]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x33ccff, transparent: true, opacity: 0.5 }));
      l.userData.shadow = true;
      g.add(l);
    }
    return g;
  }

  clearCollisions(tag) {
    for (const c of [...this.colGroup.children]) if (!tag || c.userData.tag === tag) { this.colGroup.remove(c); c.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  }

  async showSelectedCollision(items) {
    this.clearCollisions('sel');
    if (!this.settings.colSelected) return;
    for (const it of items) {
      if (it.mi < 0 || it.mi === undefined) continue;
      const r = await this.collisionFor(it.mi);
      if (!r) continue;
      const g = this.buildCollision(r.model);
      g.matrixAutoUpdate = false;
      g.matrix.copy(it.matrix);
      g.userData.tag = 'sel';
      this.colGroup.add(g);
    }
  }

  async updateAreaCollisions(shown) {
    if (this.colAreaBusy) return;
    const now = performance.now();
    if (now - (this.colAreaAt || 0) < 1500) return;
    this.colAreaAt = now;
    this.colAreaBusy = true;
    try {
      const near = shown.filter((r) => r._d < 140 && this.models[r.mi].col).sort((a, b) => a._d - b._d).slice(0, 220);
      const need = [...new Set(near.map((r) => r.mi))].filter((mi) => !this.colCache.has(mi));
      if (need.length) {
        const data = await sendJson('/api/colbatch', 'POST', need);
        for (const mi of need) this.colCache.set(mi, Promise.resolve(data[mi] && !data[mi].error ? { model: data[mi] } : null));
      }
      this.clearCollisions('area');
      for (const r of near) {
        const c = await this.colCache.get(r.mi);
        if (!c) continue;
        const g = this.buildCollision(c.model);
        g.matrixAutoUpdate = false;
        g.matrix.copy(r.matrix);
        g.userData.tag = 'area';
        this.colGroup.add(g);
      }
    } finally { this.colAreaBusy = false; }
  }

  pick(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line.threshold = 0.2;
    const targets = [];
    for (const b of this.batches.values()) for (const m of b.meshes) if (m.count > 0 && m.visible) targets.push(m);
    this.dynGroup.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      if (h.object.isInstancedMesh) {
        const b = h.object.userData.batch;
        const iid = b.iids[h.instanceId];
        if (iid !== undefined) return { kind: 'base', iid, point: h.point, face: h.face, part: h.object.userData.part };
      } else {
        let o = h.object;
        while (o && !o.userData.ref) o = o.parent;
        if (o) return { kind: o.userData.ref.kind, ref: o.userData.ref, object: o, point: h.point, part: h.object.userData.part };
      }
    }
    return null;
  }

  groundAt(x, y, zFrom, ignore) {
    const origin = gtaToThree(x, y, zFrom);
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    const targets = [];
    for (const b of this.batches.values()) for (const m of b.meshes) if (m.count > 0) targets.push(m);
    this.dynGroup.traverse((o) => { if (o.isMesh && o !== ignore && !(ignore && isChildOf(o, ignore))) targets.push(o); });
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? threeToGta(hit.point).z : null;
  }

  async setServiceLayer(type, on) {
    if (this.serviceLayers[type]) { this.serviceGroup.remove(this.serviceLayers[type]); this.serviceLayers[type].traverse((o) => { if (o.geometry) o.geometry.dispose(); }); delete this.serviceLayers[type]; }
    this.labels = this.labels.filter((l) => l.layer !== type);
    if (!on) return { count: 0 };
    const data = await getJson(`/api/layer/${type}`);
    const g = new THREE.Group();
    let count = 0;
    const boxLines = (min, max, color) => {
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => Math.max(0.5, Math.abs(v)));
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)), new THREE.LineBasicMaterial({ color }));
      l.position.set((max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2);
      return l;
    };
    const marker = (p, color, h = 3) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, h, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }));
      m.rotation.x = Math.PI / 2;
      m.position.set(p[0], p[1], p[2] + h / 2);
      return m;
    };
    if (type === 'zone' || type === 'auzo' || type === 'tcyc') {
      for (const z of data) {
        if (z.min && z.max) { g.add(boxLines(z.min, z.max, type === 'zone' ? 0x33ddff : type === 'auzo' ? 0x55ff88 : 0xffee55)); count++; this.labels.push({ layer: type, text: z.name || z.text || type, pos: [(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, Math.max(z.min[2], z.max[2])] }); }
        else if (z.center) { const s = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(z.radius || 5, 12, 8)), new THREE.LineBasicMaterial({ color: 0x55ff88 })); s.position.set(...z.center); g.add(s); count++; }
      }
    } else if (type === 'enex') {
      for (const e of data) { g.add(marker(e.pos, 0xffd400)); count++; this.labels.push({ layer: type, text: `вход: ${e.name || ''} → инт. ${e.interior}`, pos: [e.pos[0], e.pos[1], e.pos[2] + 3.5] }); }
    } else if (type === 'grge') {
      for (const e of data) {
        const min = [Math.min(e.pos[0], e.cube[0]), Math.min(e.pos[1], e.cube[1]), Math.min(e.pos[2], e.cube[2])];
        const max = [Math.max(e.pos[0], e.cube[0], e.line[0]), Math.max(e.pos[1], e.cube[1], e.line[1]), Math.max(e.pos[2], e.cube[2])];
        g.add(boxLines(min, max, 0xff8a00)); count++;
        this.labels.push({ layer: type, text: `гараж ${e.name}`, pos: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]] });
      }
    } else if (type === 'cull' || type === 'occl' || type === 'pick' || type === 'cars') {
      for (const e of data) { const p = e.center || e.pos; if (!p) continue; g.add(marker(p, type === 'cull' ? 0xff44cc : 0x44ccff, 2)); count++; }
    } else if (type === 'paths') {
      const byKey = new Map();
      for (const a of data.areas) for (const n of a.nodes) byKey.set(`${n[6]}:${n[7]}`, n);
      const veh = [], ped = [];
      for (const a of data.areas) {
        for (const n of a.nodes) {
          for (let k = 0; k < n[5]; k++) {
            const l = a.links[n[4] + k];
            if (!l) continue;
            const t = byKey.get(`${l[0]}:${l[1]}`);
            if (!t) continue;
            (n[3] === 0 ? veh : ped).push(n[0], n[1], n[2] + 0.3, t[0], t[1], t[2] + 0.3);
          }
          count++;
        }
      }
      for (const [arr, color] of [[veh, 0x3388ff], [ped, 0x33dd55]]) {
        if (!arr.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color })));
      }
    } else if (type === 'water') {
      const pos = [];
      for (const q of data.quads) {
        const p = q.points;
        if (p.length === 4) pos.push(...p[0], ...p[1], ...p[2], ...p[2], ...p[1], ...p[3]);
        else pos.push(...p[0], ...p[1], ...p[2]);
        count++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2a6fb5, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })));
    }
    this.serviceLayers[type] = g;
    this.serviceGroup.add(g);
    return { count, errors: data.errors };
  }

  render() {
    const p = threeToGta(this.camera.position);
    this.camGta = p;
    this.updateCells();
    this.updateVisibility();
    this.renderer.render(this.scene, this.camera);
  }

  info() {
    const r = this.renderer.info.render;
    return { ...this.stats, drawCalls: r.calls, triangles: r.triangles, assets: this.assets.stats(), gpu: this.renderer.info.memory };
  }
}

function isChildOf(o, parent) {
  for (let p = o.parent; p; p = p.parent) if (p === parent) return true;
  return false;
}

export { rwMatrix };
