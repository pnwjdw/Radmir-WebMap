import * as THREE from 'three';
import { getJson } from './api.js';
import { cloneMaterial } from './assets.js';

const MODES = { textured: 'Текстуры', solid: 'Однотонная поверхность', wire: 'Каркас', solidwire: 'Поверхность с каркасом', normals: 'Нормали' };

export class GeometryWindow {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x20262c);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(1, 2, 1.5); this.scene.add(d);
    this.holder = new THREE.Group();
    this.holder.rotation.x = -Math.PI / 2;
    this.scene.add(this.holder);
    this.mode = 'textured';
    this.opts = { bounds: false, frames: false, collision: false, hiddenParts: false };
    this.orbit = { yaw: 0.8, pitch: 0.4, dist: 10, target: new THREE.Vector3() };
    this.asset = null;
    this.partIndex = -1;
    this.materialIndex = -1;
    this.bind();
    const loop = () => { if (!this.root.hidden) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false }; });
    window.addEventListener('mouseup', (e) => {
      if (drag && !drag.moved && drag.button === 0 && e.target === c) this.pickTriangle(e);
      drag = null;
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.button === 0) { this.orbit.yaw -= dx * 0.008; this.orbit.pitch = Math.max(-1.5, Math.min(1.5, this.orbit.pitch + dy * 0.008)); }
      else {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        const k = this.orbit.dist * 0.0015;
        this.orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.orbit.dist = Math.max(0.05, this.orbit.dist * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    const sel = this.root.querySelector('[data-g=mode]');
    sel.innerHTML = Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.addEventListener('change', () => { this.mode = sel.value; this.rebuild(); });
    for (const k of Object.keys(this.opts)) {
      const cb = this.root.querySelector(`[data-g=${k}]`);
      if (cb) cb.addEventListener('change', () => { this.opts[k] = cb.checked; this.rebuild(); });
    }
    this.root.querySelector('[data-g=part]').addEventListener('change', (e) => { this.partIndex = Number(e.target.value); this.materialIndex = -1; this.fillMaterials(); this.rebuild(); });
    this.root.querySelector('[data-g=material]').addEventListener('change', (e) => { this.materialIndex = Number(e.target.value); this.rebuild(); });
    this.root.querySelector('[data-g=reset]').addEventListener('click', () => this.frame());
    this.root.querySelector('[data-g=shot]').addEventListener('click', () => {
      this.draw();
      const a = document.createElement('a');
      a.href = this.canvas.toDataURL('image/png');
      a.download = `${(this.title || 'model').replace(/[^\p{L}\p{N}_.-]/gu, '_')}.png`;
      a.click();
    });
  }

  async open(spec) {
    this.root.hidden = false;
    this.spec = spec;
    this.title = spec.name;
    this.root.querySelector('[data-g=title]').textContent = `Геометрия: ${spec.name}`;
    const info = this.root.querySelector('[data-g=info]');
    info.innerHTML = '<p class="muted">Загружаю полную геометрию…</p>';
    if (this.asset) this.app.scene.assets.release(this.asset);
    const sc = this.app.scene;
    const asset = sc.specAsset(spec, () => -1);
    sc.assets.retain(asset);
    this.asset = asset;
    await sc.assets.whenReady(asset);
    if (asset.state === 'error') { info.innerHTML = `<p class="error">Геометрия не прочитана: ${esc(asset.error)}</p>`; return; }
    this.col = null;
    if (spec.mi !== undefined && spec.mi >= 0) this.col = await getJson(`/api/colfor/${spec.mi}`).catch(() => null);
    else if (asset.header.embeddedCollision && spec.rid >= 0) this.col = { source: 'embedded', model: await getJson(`/api/col/${spec.rid}/0`).catch(() => null) };
    const partSel = this.root.querySelector('[data-g=part]');
    partSel.innerHTML = `<option value="-1">Все атомики (${asset.parts.length})</option>` + asset.parts.map((p, i) => `<option value="${i}">${i}: ${esc(p.name || '(без имени)')} — геометрия ${p.geometryIndex}, ${p.vertices} вершин, ${p.triangles} треуг.${p.visible ? '' : ' (скрыт по умолчанию)'}</option>`).join('');
    this.partIndex = -1; this.materialIndex = -1;
    this.fillMaterials();
    this.rebuild();
    this.frame();
    this.renderInfo();
  }

  fillMaterials() {
    const sel = this.root.querySelector('[data-g=material]');
    const p = this.asset && this.asset.parts[this.partIndex];
    if (!p) { sel.innerHTML = '<option value="-1">выберите атомик</option>'; return; }
    const g = this.asset.header.geometries[p.geometryIndex];
    sel.innerHTML = '<option value="-1">Все материалы</option>' + g.materials.map((m, i) => `<option value="${i}">${i}: ${esc(m.texture || 'без текстуры')} rgba(${m.color.join(',')})</option>`).join('');
  }

  rebuild() {
    for (const c of [...this.holder.children]) { this.holder.remove(c); c.traverse((o) => { if (o.userData.own && o.geometry) o.geometry.dispose(); }); }
    if (!this.asset || this.asset.state !== 'ready') return;
    const parts = this.asset.parts;
    this.meshes = [];
    parts.forEach((p, i) => {
      if (this.partIndex >= 0 && i !== this.partIndex) return;
      if (!p.visible && !this.opts.hiddenParts && this.partIndex !== i) return;
      let mats;
      const solid = new THREE.MeshLambertMaterial({ color: 0xb9c2cc, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1 });
      if (this.mode === 'textured') mats = p.materials;
      else if (this.mode === 'wire') mats = new THREE.MeshBasicMaterial({ color: 0x9fe0ff, wireframe: true });
      else if (this.mode === 'normals') mats = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
      else mats = solid;
      if (this.materialIndex >= 0 && this.mode === 'textured') mats = p.materials.map((m, k) => (k === this.materialIndex ? m : dimOf(m)));
      const mesh = new THREE.Mesh(p.geometry, mats);
      mesh.userData.part = p; mesh.userData.partIndex = i;
      this.holder.add(mesh);
      this.meshes.push(mesh);
      if (this.mode === 'solidwire') {
        const w = new THREE.LineSegments(new THREE.WireframeGeometry(p.geometry), new THREE.LineBasicMaterial({ color: 0x1b2836 }));
        w.userData.own = true; this.holder.add(w);
      }
      if (this.mode === 'normals') this.holder.add(normalLines(p.geometry, this.asset.sphere.radius * 0.04));
      if (this.materialIndex >= 0 && this.mode !== 'textured') {
        const g = p.geometry.groups.find((x) => x.materialIndex === this.materialIndex);
        if (g) {
          const hl = new THREE.Mesh(p.geometry, new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false, transparent: true, opacity: 0.6 }));
          hl.geometry = p.geometry.clone(); hl.geometry.clearGroups(); hl.geometry.setDrawRange(g.start, g.count); hl.userData.own = true;
          this.holder.add(hl);
        }
      }
      if (this.opts.bounds) { const bh = new THREE.Box3Helper(p.geometry.boundingBox, 0xffcc33); bh.userData.own = true; this.holder.add(bh); }
    });
    if (this.opts.frames) {
      for (const [i, f] of this.asset.header.frames.entries()) {
        const ax = new THREE.AxesHelper(this.asset.sphere.radius * 0.15);
        ax.matrixAutoUpdate = false;
        const m = frameMatrix(this.asset.header.frames, i);
        ax.matrix.copy(m);
        ax.userData.own = true;
        this.holder.add(ax);
        void f;
      }
    }
    if (this.opts.collision && this.col && this.col.model) this.holder.add(this.app.scene.buildCollision(this.col.model));
    if (this.tri) this.holder.add(this.tri);
  }

  frame() {
    if (!this.asset || !this.asset.sphere) return;
    const s = this.asset.sphere;
    this.orbit.target.copy(new THREE.Vector3(s.center.x, s.center.z, -s.center.y));
    this.orbit.dist = Math.max(0.5, s.radius * 2.6);
  }

  draw() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    const o = this.orbit;
    this.camera.position.set(o.target.x + o.dist * Math.cos(o.pitch) * Math.sin(o.yaw), o.target.y + o.dist * Math.sin(o.pitch), o.target.z + o.dist * Math.cos(o.pitch) * Math.cos(o.yaw));
    this.camera.near = Math.max(0.005, o.dist / 500); this.camera.far = o.dist * 50 + 100; this.camera.updateProjectionMatrix();
    this.camera.lookAt(o.target);
    this.renderer.render(this.scene, this.camera);
  }

  pickTriangle(e) {
    if (!this.meshes || !this.meshes.length) return;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.meshes, false)[0];
    if (!hit) return;
    const p = hit.object.userData.part;
    const g = this.asset.header.geometries[p.geometryIndex];
    const k = hit.faceIndex;
    const idx = g.arrays.index;
    const vi = [idx[k * 3], idx[k * 3 + 1], idx[k * 3 + 2]];
    const group = g.groups.find((gr) => k * 3 >= gr.start && k * 3 < gr.start + gr.count);
    const mat = group && group.material >= 0 ? g.materials[group.material] : null;
    const src = g.arrays.tri ? g.arrays.tri[k] : k;
    const v3 = (arr, i, n) => (arr ? Array.from(arr.subarray(i * n, i * n + n)).map((x) => Math.round(x * 10000) / 10000) : null);
    this.triInfo = {
      part: hit.object.userData.partIndex, atomic: p.name, geometry: p.geometryIndex, renderTriangle: k, sourceTriangle: src === 0xffffffff ? null : src, trianglesFrom: g.trianglesFrom, skinned: !!g.skinApplied,
      material: group ? group.material : null, texture: mat ? mat.texture : null, color: mat ? mat.color : null,
      vertices: vi.map((i) => ({ index: i, position: v3(g.arrays.position, i, 3), uv0: v3(g.arrays.uv0, i, 2), uv1: v3(g.arrays.uv1, i, 2), normal: g.arrays.normal ? v3(g.arrays.normal, i, 3) : 'нет в исходнике', prelit: g.arrays.color ? Array.from(g.arrays.color.subarray(i * 4, i * 4 + 4)) : null, night: g.arrays.night ? Array.from(g.arrays.night.subarray(i * 4, i * 4 + 4)) : null })),
    };
    if (this.tri) { this.holder.remove(this.tri); this.tri.geometry.dispose(); }
    const pos = p.geometry.attributes.position;
    const pts = vi.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const geo = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
    this.tri = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff2244, depthTest: false }));
    this.tri.renderOrder = 20;
    this.holder.add(this.tri);
    this.renderInfo();
  }

  renderInfo() {
    const a = this.asset, h = a.header, info = this.root.querySelector('[data-g=info]');
    const srcTris = h.geometries.reduce((s, g) => s + g.triangles, 0), srcVerts = h.geometries.reduce((s, g) => s + g.vertices, 0);
    const vis = a.parts.filter((p) => p.visible);
    const drawn = vis.reduce((s, p) => s + p.triangles, 0);
    let html = `<table class="kv">
      <tr><th>RenderWare</th><td>${esc(h.rw.text)} (${esc(h.rw.libId)}), ${esc(h.rw.game)}</td></tr>
      <tr><th>Исходник</th><td>${h.geometries.length} геометрий, ${srcVerts} вершин, ${srcTris} треугольников, ${h.atomics.length} атомиков, ${h.frames.length} фреймов</td></tr>
      <tr><th>Отрисовывается</th><td>${vis.length} атомиков, ${drawn} треугольников${a.parts.length > vis.length ? ` (скрыты по умолчанию: ${a.parts.filter((p) => !p.visible).map((p) => esc(p.name)).join(', ')})` : ''}</td></tr>
      <tr><th>Вид модели</th><td>${a.ctx.clump ? 'clump: применяется иерархия фреймов (корень заменяется матрицей объекта)' : 'атомарная: матрицы фреймов DFF не применяются (как в движке SA)'}</td></tr>
      <tr><th>Коллизия</th><td>${this.col ? (this.col.model ? `${this.col.source === 'embedded' ? 'встроена в DFF' : 'COL-файл'}: ${this.col.model.version === 1 ? 'COLL' : 'COL' + this.col.model.version}, сфер ${this.col.model.spheres.length}, боксов ${this.col.model.boxes.length}, граней ${this.col.model.faces.length}` : esc(this.col.reason || 'нет')) : 'нет данных'}</td></tr>
    </table>`;
    html += '<h4>Меши</h4><table class="grid"><tr><th>#</th><th>атомик</th><th>геом.</th><th>вершин</th><th>треуг. (исх./отрис.)</th><th>UV</th><th>нормали</th><th>prelight</th><th>ночные</th><th>скин</th><th>материалы</th></tr>';
    a.parts.forEach((p, i) => {
      const g = h.geometries[p.geometryIndex];
      html += `<tr><td>${i}</td><td>${esc(p.name)}</td><td>${p.geometryIndex}</td><td>${g.vertices}</td><td>${g.triangles}/${p.triangles} (${esc(g.trianglesFrom)})</td><td>${g.uvSets}</td><td>${g.normals ? 'да' : 'нет (рассчитаны)'}</td><td>${g.prelit ? 'да' : 'нет'}</td><td>${g.nightColors ? 'да' : 'нет'}</td><td>${g.skin ? `костей ${g.skin.bones}, весов ${g.skin.maxWeights}${g.skinApplied ? ', поза применена' : ''}` : '—'}</td><td>${g.materials.length}</td></tr>`;
    });
    html += '</table>';
    const notes = [...new Set(h.geometries.flatMap((g) => g.warnings || []))];
    if (notes.length) html += `<h4>Замечания по геометрии</h4><ul class="plain small">${notes.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul>`;
    if (this.triInfo) {
      const t = this.triInfo;
      html += `<h4>Треугольник</h4><table class="kv"><tr><th>Индекс</th><td>${t.sourceTriangle === null ? 'в struct такого нет (только в Bin Mesh)' : `в struct №${t.sourceTriangle}`}, в отрисовке №${t.renderTriangle} (${esc(t.trianglesFrom)}); атомик ${t.part} «${esc(t.atomic)}», геометрия ${t.geometry}</td></tr>
        <tr><th>Материал</th><td>${t.material === null ? '—' : t.material} ${t.texture ? `текстура «${esc(t.texture)}»` : 'без текстуры'} ${t.color ? `rgba(${t.color.join(',')})` : ''}</td></tr></table>
        <table class="grid"><tr><th>вершина</th><th>${t.skinned ? 'позиция (после скина)' : 'позиция (DFF)'}</th><th>UV0</th><th>UV1</th><th>нормаль</th><th>prelight</th><th>ночной</th></tr>
        ${t.vertices.map((v) => `<tr><td>${v.index}</td><td>${fmt(v.position)}</td><td>${fmt(v.uv0)}</td><td>${fmt(v.uv1)}</td><td>${Array.isArray(v.normal) ? fmt(v.normal) : esc(v.normal)}</td><td>${fmt(v.prelit)}</td><td>${fmt(v.night)}</td></tr>`).join('')}</table>`;
    } else html += '<p class="muted">Щёлкните по модели, чтобы выбрать треугольник.</p>';
    info.innerHTML = html;
  }

  close() {
    this.root.hidden = true;
    if (this.asset) { this.app.scene.assets.release(this.asset); this.asset = null; }
  }
}

function dimOf(m) {
  const d = cloneMaterial(m);
  d.transparent = true; d.opacity = 0.15; d.depthWrite = false;
  return d;
}

function normalLines(geo, len) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const pts = [];
  const step = Math.max(1, Math.floor(pos.count / 20000));
  for (let i = 0; i < pos.count; i += step) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i), n = new THREE.Vector3().fromBufferAttribute(nor, i);
    pts.push(p, p.clone().addScaledVector(n, len));
  }
  const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x66ff99 }));
  l.userData.own = true;
  return l;
}

function frameMatrix(frames, index) {
  let m = new THREE.Matrix4();
  for (let i = index, guard = 0; i >= 0 && guard < 64; i = frames[i].parent, guard++) {
    const f = frames[i];
    if (f.parent < 0) break;
    const r = f.rot, p = f.pos;
    const fm = new THREE.Matrix4().set(r[0], r[3], r[6], p[0], r[1], r[4], r[7], p[1], r[2], r[5], r[8], p[2], 0, 0, 0, 1);
    m = fm.multiply(m);
  }
  return m;
}

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (a) => (a ? `[${a.join(', ')}]` : '—');
