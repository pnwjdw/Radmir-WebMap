import * as THREE from 'three';
import { getJson, sendJson } from './api.js';
import { MapScene, gtaToThree, threeToGta } from './scene.js';
import { Controls, isTyping } from './controls.js';
import { Editor } from './editor.js';
import { Inspector, renderTextures, renderCollision, esc } from './inspector.js';
import { GeometryWindow } from './viewer3d.js';
import { Ui, loadSettings, saveSettings } from './ui.js';

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.loading = document.getElementById('loading');
    this.fps = 0;
    this.bookmarks = loadLocal('rr-bookmarks', []);
    this.projectName = 'проект';
  }

  async start() {
    if (window.radmirBlocked) return;
    await this.waitServer();
    this.scene = new MapScene(this.canvas, { error: (m) => this.ui && this.ui.toast(m, 'error') });
    this.loading.textContent = 'Загружаю таблицу моделей и дальние LOD…';
    await this.scene.init();
    this.controls = new Controls(this.scene.camera, this.canvas, {
      speedChange: (v) => { if (this.ui) { this.ui.speedChanged(v); saveSettings(this); } },
      lockChange: (l) => { document.getElementById('crosshair').hidden = !l; },
      modeChange: () => this.ui && this.ui.updateToolState(),
    });
    loadSettings(this);
    this.editor = new Editor(this);
    this.inspector = new Inspector(this, document.getElementById('inspector'));
    this.geom = new GeometryWindow(this, document.getElementById('win-geom'));
    this.ui = new Ui(this);
    this.ui.init();
    this.ui.refreshBookmarks();
    this.ui.speedChanged(this.controls.speed);
    this.ui.updateToolState();
    const sp = this.scene.meta.spawn;
    this.controls.setPose(sp.x - 120, sp.y - 120, sp.z, 45, -20);
    this.controls.lookAtGta(sp.x, sp.y, sp.z - 70);
    this.loading.textContent = `Карта: ${this.scene.meta.instances} размещений в профиле «${this.scene.meta.profile.name}». Загружаю ячейки рядом с камерой (${Math.round(sp.x)}, ${Math.round(sp.y)})…`;
    this.bindCanvas();
    this.bindKeys();
    this.minimap = new Minimap(this, document.getElementById('minimap'));
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    let last = performance.now(), frames = 0, acc = 0;
    const loop = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      frames++; acc += dt;
      if (acc > 0.5) { this.fps = frames / acc; frames = 0; acc = 0; }
      this.controls.update(dt);
      this.scene.render();
      this.updateHud();
      this.updateLabels();
      this.minimap.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async waitServer() {
    for (;;) {
      let s;
      try { s = await getJson('/api/status'); } catch (e) { this.loading.innerHTML = `Сервер недоступен: ${esc(e.message)}. Запустите «Запуск.bat».`; await sleep(1500); continue; }
      if (s.error) { this.loading.innerHTML = `<span class="error">Ошибка сервера: ${esc(s.error)}</span>`; await sleep(2000); continue; }
      if (s.ready) return s;
      const p = s.index;
      const pct = p.bytesTotal ? Math.round((p.bytesDone / p.bytesTotal) * 100) : 0;
      this.loading.innerHTML = `Строится индекс ресурсов: файлов ${p.doneFiles} из ${p.totalFiles}, ${pct}% данных<br><span class="small muted">${p.current.map((c) => esc(c.key.split('/').pop())).join(', ')}</span><div class="progress"><div style="width:${pct}%"></div></div><span class="small muted">Индекс сохраняется в cache/ и при следующем запуске перечитываются только изменённые файлы.</span>`;
      await sleep(700);
    }
  }

  onResize() {
    const c = document.getElementById('center');
    this.scene.resize(c.clientWidth, c.clientHeight);
  }

  bindCanvas() {
    let down = null;
    this.canvas.addEventListener('mousedown', (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; this.canvas.focus(); });
    this.canvas.addEventListener('mouseup', async (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      down = null;
      if (moved || this.editor.gizmo.dragging || this.gizmoHover(e)) return;
      const ndc = this.controls.locked ? new THREE.Vector2(0, 0) : this.ndc(e);
      const hit = this.scene.pick(ndc);
      if (this.placing) {
        if (!hit) { this.ui.toast('Под курсором нет поверхности загруженных моделей', 'warn'); return; }
        const p = threeToGta(hit.point);
        const spec = this.placing;
        this.placing = null;
        this.canvas.style.cursor = '';
        await this.editor.addModel(spec, { pos: [p.x, p.y, p.z], restOn: p.z });
        this.ui.toast(`Добавлено: ${spec.name}`, 'ok');
        return;
      }
      if (!hit) { if (!e.shiftKey) this.editor.select([]); return; }
      if (hit.kind === 'base') this.editor.select([{ kind: 'base', iid: hit.iid }], e.shiftKey);
      else this.editor.select([hit.ref], e.shiftKey);
    });
  }

  gizmoHover() { return this.editor.gizmo.axis !== null && this.editor.gizmo.axis !== undefined && this.editor.gizmoMode; }

  ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  async place(spec, how) {
    if (how === 'surface') {
      this.placing = spec;
      this.canvas.style.cursor = 'copy';
      this.ui.toast(`Щёлкните по поверхности на карте, чтобы поставить «${spec.name}» (Esc — отмена)`);
      return;
    }
    if (how === 'coords') {
      const p = this.controls.gtaPosition();
      this.ui.dialog(`Добавить «${spec.name}» по координатам`, `<div class="row">X <input data-c="x" type="number" step="0.1" value="${p.x.toFixed(2)}" class="w6"> Y <input data-c="y" type="number" step="0.1" value="${p.y.toFixed(2)}" class="w6"> Z <input data-c="z" type="number" step="0.1" value="${(p.z - 5).toFixed(2)}" class="w6"></div><div class="row">Поворот вокруг Z, ° <input data-c="h" type="number" step="5" value="0" class="w4"> <label><input data-c="drop" type="checkbox"> опустить на поверхность</label></div><div class="actions"><button data-c="ok">Добавить</button></div>`, (b, close) => {
        b.querySelector('[data-c=ok]').onclick = async () => {
          const bad = [];
          const v = (k) => { const s = b.querySelector(`[data-c=${k}]`).value.trim(); const n = Number(s); if (s === '' || !Number.isFinite(n)) bad.push(k.toUpperCase()); return n; };
          const x = v('x'), y = v('y'), z = v('z'), h = v('h');
          if (bad.length) { this.ui.toast(`Не число: ${bad.join(', ')}`, 'error'); return; }
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(h));
          close();
          await this.editor.addModel(spec, { pos: [x, y, z], quat: q.toArray(), dropToSurface: b.querySelector('[data-c=drop]').checked });
          this.focusSelection();
        };
      });
      return;
    }
    const fwd = new THREE.Vector3();
    this.scene.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const pos = this.scene.camera.position.clone().addScaledVector(fwd, 12);
    const g = threeToGta(pos);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    await this.editor.addModel(spec, { pos: [g.x, g.y, g.z], quat: q.toArray(), dropToSurface: true });
    this.ui.toast(`Добавлено перед камерой: ${spec.name}`, 'ok');
  }

  async selectBase(iid, focus = false) {
    const r = await this.editor.ensureBase(iid);
    if (!r) { this.ui.toast(`Размещение ${iid} не найдено`, 'error'); return; }
    await this.editor.select([{ kind: 'base', iid }]);
    if (focus) this.focusSelection();
  }

  focusSelection() {
    const ed = this.editor;
    if (!ed.selection.length) { this.ui.toast('Ничего не выбрано', 'warn'); return; }
    const box = new THREE.Box3();
    for (const r of ed.selection) {
      const t = ed.transformOf(r);
      if (!t) continue;
      let rad = 4;
      if (r.kind === 'base') { const rec = ed.baseRecord(r.iid); const m = rec && this.scene.models[rec.mi]; if (m && m.bs) rad = m.bs[3]; }
      else { const o = ed.objects.get(ed.keyOf(r)); if (o) { const b = new THREE.Box3().setFromObject(o.group); rad = b.getSize(new THREE.Vector3()).length() / 2; } }
      box.expandByPoint(new THREE.Vector3(t.pos[0] - rad, t.pos[1] - rad, t.pos[2] - rad));
      box.expandByPoint(new THREE.Vector3(t.pos[0] + rad, t.pos[1] + rad, t.pos[2] + rad));
    }
    const c = box.getCenter(new THREE.Vector3()), rad = Math.max(2, box.getSize(new THREE.Vector3()).length() / 2);
    if (this.controls.mode === 'orbit') { this.controls.startOrbit({ x: c.x, y: c.y, z: c.z }, rad); return; }
    const dir = new THREE.Vector3();
    this.scene.camera.getWorldDirection(dir);
    const camPos = gtaToThree(c.x, c.y, c.z).addScaledVector(dir, -rad * 2.6);
    const g = threeToGta(camPos);
    this.controls.setPose(g.x, g.y, g.z);
    this.controls.lookAtGta(c.x, c.y, c.z);
    this.focusTarget = c;
  }

  setCameraMode(mode) {
    if (mode === 'orbit') {
      const ed = this.editor;
      if (!ed.selection.length) { this.ui.toast('Для орбиты выберите объект', 'warn'); return; }
      const t = ed.transformOf(ed.selection[0]);
      const rec = ed.selection[0].kind === 'base' ? ed.baseRecord(ed.selection[0].iid) : null;
      const rad = rec && this.scene.models[rec.mi] && this.scene.models[rec.mi].bs ? this.scene.models[rec.mi].bs[3] : 5;
      this.controls.startOrbit({ x: t.pos[0], y: t.pos[1], z: t.pos[2] }, rad);
    }
    this.controls.setMode(mode);
  }

  specOf(ref) {
    if (ref.kind === 'base') {
      const rec = this.editor.baseRecord(ref.iid);
      return rec && rec.mi >= 0 ? this.ui.specFromModel(rec.mi) : null;
    }
    const a = this.editor.added.get(ref.uid);
    return a ? { ...a.ref, name: a.name } : null;
  }
  openGeometry(ref) { const s = this.specOf(ref); if (s) this.geom.open(s); }
  openTextures(ref) { const s = this.specOf(ref); if (s) this.openTexturesSpec(s); }
  async openTexturesSpec(spec) {
    const w = document.getElementById('win-tex');
    w.hidden = false;
    w.querySelector('[data-t=title]').textContent = `Текстуры: ${spec.name || spec.txdName || ''}`;
    try {
      if (spec.mi === undefined && spec.txdRid === undefined && spec.txd) {
        const r = await getJson(`/api/search?q=${encodeURIComponent(spec.txd)}`);
        const t = r.resources.find((x) => x.kind === 'txd' && x.name.toLowerCase() === `${spec.txd.toLowerCase()}.txd` && x.active) || r.resources.find((x) => x.kind === 'txd' && x.name.toLowerCase() === `${spec.txd.toLowerCase()}.txd`);
        if (t) spec = { ...spec, txdRid: t.rid, txdName: t.name };
      }
      await renderTextures(this, w.querySelector('[data-t=body]'), spec);
    } catch (e) { w.querySelector('[data-t=body]').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }
  openCollision(ref) {
    const s = this.specOf(ref);
    if (s && s.importId) this.openCollisionImport(s.importId, s.name);
    else if (s && s.mi >= 0) this.openCollisionMi(s.mi);
    else this.ui.toast('Коллизия доступна для моделей профиля и импортов; у этой модели нет определения в активных IDE', 'warn');
  }
  openCollisionMi(mi) { return this.showCollision(this.scene.models[mi].name, `/api/colfor/${mi}`); }
  openCollisionImport(id, name) { return this.showCollision(`${name} (импорт ${id})`, `/api/icol/${encodeURIComponent(id)}`); }
  async showCollision(title, url) {
    const w = document.getElementById('win-col');
    w.hidden = false;
    w.querySelector('[data-c=title]').textContent = `Коллизия: ${title}`;
    try { await renderCollision(this, w.querySelector('[data-c=body]'), url); } catch (e) { w.querySelector('[data-c=body]').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }

  async renderThumb(spec) {
    if (!this.thumbR) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      this.thumbR = new THREE.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true, alpha: true });
      this.thumbR.outputColorSpace = THREE.LinearSRGBColorSpace;
      this.thumbScene = new THREE.Scene();
      this.thumbScene.add(new THREE.AmbientLight(0xffffff, 1.6));
      const d = new THREE.DirectionalLight(0xffffff, 1.5); d.position.set(1, 2, 1.5); this.thumbScene.add(d);
      this.thumbCam = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    }
    const group = await this.editor.buildObject(spec);
    const asset = group.userData.asset;
    await waitTextures(this.scene.assets, asset, 2500);
    const holder = new THREE.Group();
    holder.rotation.x = -Math.PI / 2;
    holder.add(group);
    this.thumbScene.add(holder);
    const box = new THREE.Box3().setFromObject(holder);
    const s = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    this.thumbCam.position.copy(s.center).addScaledVector(dir, Math.max(0.5, s.radius) * 3.2);
    this.thumbCam.lookAt(s.center);
    this.thumbR.render(this.thumbScene, this.thumbCam);
    const url = this.thumbR.domElement.toDataURL('image/png');
    this.thumbScene.remove(holder);
    group.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.userData && m.userData.clone) m.dispose(); });
    this.scene.assets.release(asset);
    return url;
  }

  async action(a) {
    const ed = this.editor;
    switch (a) {
      case 'mode-fly': this.controls.setMode('fly'); break;
      case 'mode-orbit': this.setCameraMode('orbit'); break;
      case 'mode-top': this.controls.setMode(this.controls.mode === 'top' ? 'fly' : 'top'); break;
      case 'lock': this.controls.lock(); break;
      case 'focus': this.focusSelection(); break;
      case 'goto': this.gotoDialog(); break;
      case 'bookmark': this.addBookmark(); break;
      case 'giz-none': ed.setGizmoMode(null); break;
      case 'giz-translate': ed.setGizmoMode('translate'); break;
      case 'giz-rotate': ed.setGizmoMode('rotate'); break;
      case 'giz-scale': ed.setGizmoMode('scale'); break;
      case 'dup': await ed.duplicate(); break;
      case 'hide': { const r = ed.selection[0]; const hidden = r && (r.kind === 'base' ? (ed.overrides.get(r.stable) || {}).hidden : (ed.added.get(r.uid) || {}).hidden); await ed.setHidden(!hidden); break; }
      case 'isolate': ed.isolateSelection(!this.scene.isolate); this.ui.updateToolState(); break;
      case 'drop': for (const r of [...ed.selection]) await ed.dropToSurface(r); break;
      case 'delete': await ed.deleteSelection(); break;
      case 'reset-sel': await ed.resetSelection(); break;
      case 'undo': await ed.undo(); break;
      case 'redo': await ed.redo(); break;
      case 'save': await this.saveProject(); break;
      case 'shot': this.screenshot(); break;
      case 'help': document.getElementById('win-help').hidden = false; break;
      default: break;
    }
    this.ui.updateToolState();
  }

  gotoDialog() {
    const p = this.controls.gtaPosition();
    this.ui.dialog('Перейти к координатам (GTA: X — восток, Y — север, Z — высота)', `<div class="row">X <input data-g="x" type="number" step="1" value="${p.x.toFixed(1)}" class="w6"> Y <input data-g="y" type="number" step="1" value="${p.y.toFixed(1)}" class="w6"> Z <input data-g="z" type="number" step="1" value="${p.z.toFixed(1)}" class="w6"></div><div class="row"><input data-g="paste" placeholder="или вставьте «x, y, z»" class="grow"></div><div class="actions"><button data-g="ok">Перейти</button></div>`, (b, close) => {
      b.querySelector('[data-g=paste]').addEventListener('input', (e) => {
        const n = e.target.value.split(/[,;\s]+/).filter((s) => s !== '').map(Number).filter(Number.isFinite);
        if (n.length >= 2) { b.querySelector('[data-g=x]').value = n[0]; b.querySelector('[data-g=y]').value = n[1]; if (n.length >= 3) b.querySelector('[data-g=z]').value = n[2]; }
      });
      let gone = false;
      const go = () => {
        if (gone) return;
        const vals = ['x', 'y', 'z'].map((k) => { const s = b.querySelector(`[data-g=${k}]`).value.trim(); return s === '' ? NaN : Number(s); });
        if (!vals.every(Number.isFinite)) { this.ui.toast('Укажите X, Y и Z числами', 'error'); return; }
        gone = true;
        close();
        this.controls.setPose(vals[0], vals[1], vals[2]);
      };
      b.querySelector('[data-g=ok]').onclick = go;
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  }

  addBookmark() {
    const b = this.controls.bookmark(`Закладка ${this.bookmarks.length + 1}`);
    this.ui.dialog('Закладка камеры', `<div class="row">Название <input data-b="n" value="${esc(b.name)}" class="grow"></div><div class="actions"><button data-b="ok">Сохранить</button></div>`, (body, close) => {
      body.querySelector('[data-b=ok]').onclick = () => { b.name = body.querySelector('[data-b=n]').value || b.name; this.bookmarks.push(b); this.saveBookmarks(); close(); this.ui.toast('Закладка добавлена', 'ok'); };
    });
  }
  saveBookmarks() { saveLocal('rr-bookmarks', this.bookmarks); this.ui.refreshBookmarks(); }
  goBookmark(b) {
    if (!b || ![b.x, b.y, b.z].every(Number.isFinite)) return;
    if (this.controls.mode !== 'fly') this.setCameraMode('fly');
    this.controls.setPose(b.x, b.y, b.z, Number.isFinite(b.yaw) ? b.yaw : null, Number.isFinite(b.pitch) ? b.pitch : null);
    if (b.mode === 'top') { this.setCameraMode('top'); this.controls.top.height = Math.max(20, b.z); }
    this.ui.updateToolState();
  }

  screenshot() {
    if (!this.canvas.width || !this.canvas.height) { this.ui.toast('Окно 3D-вида свёрнуто — снимать нечего', 'warn'); return; }
    this.scene.renderer.render(this.scene.scene, this.scene.camera);
    const p = this.controls.gtaPosition();
    const name = `снимок_${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}.png`;
    this.canvas.toBlob((blob) => {
      if (!blob) { this.ui.toast('Снимок не получился', 'error'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.ui.toast(`Снимок ${this.canvas.width}×${this.canvas.height} сохранён: ${name}`, 'ok');
    }, 'image/png');
  }

  async saveProject() {
    try {
      const p = await this.editor.toProject();
      const r = await sendJson(`/api/projects/${encodeURIComponent(this.projectName)}`, 'PUT', p);
      this.projectName = r.name;
      this.ui.toast(`Проект «${r.name}» сохранён (${r.file})`, 'ok');
    } catch (e) { this.ui.toast(`Проект не сохранён: ${e.message}`, 'error'); }
  }
  async loadProjectByName(name) {
    try { this.projectName = name; await this.loadProjectData(await getJson(`/api/projects/${encodeURIComponent(name)}`)); } catch (e) { this.ui.toast(`Проект не открыт: ${e.message}`, 'error'); }
  }
  async loadProjectData(p) {
    const warnings = await this.editor.loadProject(p);
    this.ui.refreshBookmarks();
    this.ui.renderLayers();
    if (warnings.length) this.ui.dialog('Проект открыт с предупреждениями', `<ul class="plain">${warnings.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul>`);
    else this.ui.toast('Проект открыт', 'ok');
  }

  async applyProfile(draft) {
    try { await sendJson('/api/profile', 'PUT', draft); this.ui.toast('Профиль применён, карта перезагружается…', 'ok'); setTimeout(() => location.reload(), 600); }
    catch (e) { this.ui.toast(`Профиль не применён: ${e.message}`, 'error'); }
  }
  async resetProfile() { await getJson('/api/profile/reset', { method: 'POST' }); location.reload(); }
  async switchProfile(id) { await getJson(`/api/profile/select/${encodeURIComponent(id)}`, { method: 'POST' }); location.reload(); }

  bindKeys() {
    window.addEventListener('keydown', async (e) => {
      if (isTyping(e)) return;
      const k = e.code, ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (k === 'KeyY' || (e.shiftKey && k === 'KeyZ'))) { e.preventDefault(); return this.action('redo'); }
      if (ctrl && k === 'KeyZ') { e.preventDefault(); return this.action('undo'); }
      if (ctrl && k === 'KeyD') { e.preventDefault(); return this.action('dup'); }
      if (ctrl && k === 'KeyH') { e.preventDefault(); return this.action('hide'); }
      if (ctrl && k === 'KeyS') { e.preventDefault(); return this.action('save'); }
      if (ctrl) return;
      if (k === 'Escape') { if (this.placing) { this.placing = null; this.canvas.style.cursor = ''; this.ui.toast('Размещение отменено'); } for (const w of document.querySelectorAll('.window.modal')) w.hidden = true; return; }
      if (k === 'F1' || (e.key === '?')) { e.preventDefault(); return this.action('help'); }
      if (k === 'KeyM') { const mm = document.getElementById('minimap'); mm.hidden = !mm.hidden; return; }
      const map = { KeyF: 'focus', KeyO: 'mode-orbit', KeyT: 'mode-top', KeyG: 'goto', KeyB: 'bookmark', KeyL: 'lock', KeyI: 'isolate', Delete: 'delete', KeyP: 'shot', Digit1: 'giz-translate', Digit2: 'giz-rotate', Digit3: 'giz-scale', Digit0: 'giz-none' };
      if (k === 'KeyO' && this.controls.mode === 'orbit') { this.controls.setMode('fly'); return; }
      if (map[k]) { e.preventDefault(); this.action(map[k]); }
    });
  }

  updateHud() {
    const p = this.controls.gtaPosition();
    const s = this.scene.info();
    document.getElementById('hud-pos').textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}  Z ${p.z.toFixed(1)}  курс ${this.controls.heading().toFixed(0)}°  ${this.controls.currentSpeed.toFixed(1)} м/с`;
    const mode = { fly: 'полёт', orbit: 'орбита', top: 'вид сверху' }[this.controls.mode];
    const busy = s.assets.geomQueue + s.assets.texQueue;
    document.getElementById('hud-state').textContent = `${mode} · видно ${s.visible} · ячеек ${s.cellsLoaded}${busy ? ` · загрузка: моделей ${s.assets.geomQueue}, текстур ${s.assets.texQueue}` : ''}${s.pending ? ` · ждут геометрию ${s.pending}` : ''}${this.placing ? ' · РАЗМЕЩЕНИЕ: щёлкните по поверхности' : ''}`;
    if (this.loading && !this.loading.hidden) {
      if (s.visible > 0 && s.assets.geomQueue < 20) this.loading.hidden = true;
      else if (s.cellsLoaded > 0) this.loading.textContent = `Подгружаю модели рядом с камерой: в очереди ${s.assets.geomQueue}, готово ${s.assets.ready}…`;
    }
  }

  updateLabels() {
    const now = performance.now();
    if (now - (this.lastLabels || 0) < 120) return;
    this.lastLabels = now;
    const el = document.getElementById('labels');
    const sc = this.scene;
    const items = [...sc.labels];
    if (sc.settings.labels) {
      let n = 0;
      for (const b of sc.batches.values()) {
        for (const iid of b.iids) {
          const r = sc.inst.get(iid);
          if (!r || r._d > 120 || n > 60) continue;
          items.push({ text: sc.models[r.mi].name, pos: [r.x, r.y, r.z + (sc.models[r.mi].bs ? sc.models[r.mi].bs[3] * 0.6 : 2)] });
          n++;
        }
      }
    }
    for (const ref of this.editor.selection) {
      const t = this.editor.transformOf(ref);
      if (t) items.push({ text: this.inspector.refName(ref), pos: [t.pos[0], t.pos[1], t.pos[2] + 2], sel: true });
    }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, cam = sc.camera;
    const html = [];
    const v = new THREE.Vector3();
    const cp = threeToGta(cam.position);
    for (const it of items) {
      if (Math.hypot(it.pos[0] - cp.x, it.pos[1] - cp.y) > 900) continue;
      v.copy(gtaToThree(...it.pos)).project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      html.push(`<div style="left:${((v.x + 1) / 2) * w}px;top:${((1 - v.y) / 2) * h}px${it.sel ? ';background:#7a5d00' : ''}">${esc(it.text)}</div>`);
      if (html.length > 160) break;
    }
    el.innerHTML = html.join('');
  }
}

class Minimap {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.img = new Image();
    this.img.src = '/catalog/data/map.jpg';
    this.zoom = 1;
    this.last = 0;
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const { x, y } = this.toWorld(((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height);
      const p = app.controls.gtaPosition();
      app.controls.setPose(x, y, Math.max(p.z, 80));
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(1, Math.min(16, this.zoom * Math.exp(-e.deltaY * 0.002))); }, { passive: false });
  }
  view() {
    const p = this.app.controls.gtaPosition();
    const span = 12000 / this.zoom;
    return { cx: this.zoom === 1 ? 0 : p.x, cy: this.zoom === 1 ? 0 : p.y, span };
  }
  toWorld(px, py) {
    const v = this.view(), s = this.canvas.width;
    return { x: v.cx + (px / s - 0.5) * v.span, y: v.cy - (py / s - 0.5) * v.span };
  }
  draw() {
    const now = performance.now();
    if (now - this.last < 100 || this.canvas.hidden) return;
    this.last = now;
    const c = this.ctx, s = this.canvas.width, v = this.view();
    c.fillStyle = '#0d2540'; c.fillRect(0, 0, s, s);
    if (this.img.complete && this.img.naturalWidth) {
      const k = this.img.naturalWidth / 12000;
      const sx = (v.cx - v.span / 2 + 6000) * k, sy = (6000 - (v.cy + v.span / 2)) * k;
      c.drawImage(this.img, sx, sy, v.span * k, v.span * k, 0, 0, s, s);
    }
    const toPx = (x, y) => [((x - v.cx) / v.span + 0.5) * s, (0.5 - (y - v.cy) / v.span) * s];
    const cs = this.app.scene.meta.cellSize;
    c.strokeStyle = 'rgba(80,200,255,0.35)';
    for (const k of this.app.scene.cells.keys()) {
      const [gx, gy] = k.split(',').map(Number);
      const [x0, y0] = toPx(gx * cs, (gy + 1) * cs), [x1, y1] = toPx((gx + 1) * cs, gy * cs);
      c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    const p = this.app.controls.gtaPosition();
    const [px, py] = toPx(p.x, p.y);
    const hd = (this.app.controls.heading() * Math.PI) / 180;
    c.fillStyle = '#ffd400';
    c.beginPath(); c.moveTo(px + Math.sin(hd) * 9, py - Math.cos(hd) * 9); c.lineTo(px + Math.sin(hd + 2.5) * 6, py - Math.cos(hd + 2.5) * 6); c.lineTo(px + Math.sin(hd - 2.5) * 6, py - Math.cos(hd - 2.5) * 6); c.closePath(); c.fill();
    c.fillStyle = '#fff'; c.font = '10px Segoe UI';
    c.fillText(this.zoom === 1 ? 'вся карта · колесо — масштаб' : `×${this.zoom.toFixed(1)}`, 4, s - 4);
  }
}

function waitTextures(assets, asset, timeout) {
  const start = performance.now();
  return new Promise((res) => {
    const tick = () => {
      const pending = [...asset.textures].some((k) => { const t = assets.textures.get(k); return t && (t.state === 'queued' || t.state === 'loading'); });
      if (!pending || performance.now() - start > timeout) res(); else setTimeout(tick, 100);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadLocal(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } }
function saveLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

const app = new App();
window.radmirApp = app;
app.start().catch((e) => { document.getElementById('loading').innerHTML = `<span class="error">Ошибка запуска: ${esc(e.message)}</span>`; console.error(e); });
