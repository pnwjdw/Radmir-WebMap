import * as THREE from 'three';
import { getJson, sendJson, download, toCsv } from './api.js';
import { esc } from './inspector.js';
import { CLUMP } from './scene.js';
import { PRELIT } from './assets.js';

export function saveSettings(app) {
  const s = app.scene.settings;
  try {
    localStorage.setItem('rr-view-settings', JSON.stringify({
      ambient: PRELIT.ambient.value, night: PRELIT.night.value, lighting: app.scene.assets.lighting, genMips: app.scene.assets.genMips, drawScale: s.drawScale, maxDistance: s.maxDistance,
      lodMode: s.lodMode, interiors: [...s.interiors], speed: app.controls.speed,
    }));
  } catch {  }
}
export function loadSettings(app) {
  let v = null;
  try { v = JSON.parse(localStorage.getItem('rr-view-settings')); } catch {}
  if (!v) return;
  const s = app.scene.settings;
  if (typeof v.ambient === 'number') PRELIT.ambient.value = v.ambient;
  if (typeof v.night === 'number') PRELIT.night.value = v.night;
  if (v.lighting === 'prelight' || v.lighting === 'flat') app.scene.assets.lighting = v.lighting;
  if (typeof v.genMips === 'boolean') app.scene.assets.genMips = v.genMips;
  if (v.drawScale > 0) s.drawScale = v.drawScale;
  if (v.maxDistance > 0) s.maxDistance = v.maxDistance;
  if (['auto', 'hd', 'lod'].includes(v.lodMode)) s.lodMode = v.lodMode;
  if (Array.isArray(v.interiors)) s.interiors = new Set(v.interiors);
  if (v.speed > 0) app.controls.setSpeed(v.speed);
}

const CATS = [['', 'Все модели'], ['o', 'Объекты (objs/tobj)'], ['c', 'Машины'], ['p', 'Персонажи'], ['w', 'Оружие'], ['a', 'Анимированные'], ['h', 'Иерархии'], ['lod', 'LOD-модели'], ['t1', 'Дороги'], ['t2', 'Деревья и кусты'], ['t4', 'Провода и опоры'], ['none', 'Без IDE'], ['err', 'С ошибками']];
const SECTION_OF = { o: 'objs', t: 'tobj', a: 'anim', w: 'weap', c: 'cars', p: 'peds', h: 'hier' };
const KIND_NAMES = { img: 'IMG-архив', ide: 'IDE', ipl: 'IPL', manifest: 'манифест', dff: 'DFF', txd: 'TXD', col: 'COL', ifp: 'IFP', empty: 'пустой', text: 'текст', unknown: 'неизвестный', carcols: 'carcols', surfinfo: 'surfinfo', water: 'water', error: 'ошибка' };

export class Ui {
  constructor(app) {
    this.app = app;
    this.lib = null;
    this.thumbQueue = [];
    this.thumbBusy = 0;
  }

  init() {
    this.bindTabs();
    this.bindSplitters();
    this.bindWindows();
    this.bindToolbar();
    this.bindSearch();
    this.bindLibrary();
    this.bindFiles();
    this.renderLayers();
    this.renderProject();
    this.renderHelp();
    setInterval(() => this.updateStatus(), 500);
  }

  toast(text, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
  }

  bindTabs() {
    for (const nav of document.querySelectorAll('[data-tabs]')) {
      nav.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        const panel = nav.parentElement;
        nav.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        panel.querySelectorAll(':scope > [data-pane]').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
        this.onTab(b.dataset.tab);
      });
    }
    document.querySelectorAll('[data-collapse]').forEach((b) => b.addEventListener('click', () => this.togglePanel(b.dataset.collapse)));
    document.getElementById('show-left').addEventListener('click', () => this.togglePanel('left'));
    document.getElementById('show-right').addEventListener('click', () => this.togglePanel('right'));
  }

  togglePanel(which) {
    document.body.classList.toggle(`${which}-off`);
    document.getElementById('show-left').hidden = !document.body.classList.contains('left-off');
    document.getElementById('show-right').hidden = !document.body.classList.contains('right-off');
    this.app.onResize();
  }

  onTab(tab) {
    if (tab === 'library' && !this.lib) this.loadLibrary();
    if (tab === 'files' && !this.files) this.loadFiles();
    if (tab === 'profile') this.renderProfile();
    if (tab === 'project') this.renderProject();
    if (tab === 'diag') this.renderDiagnostics();
    if (tab === 'coverage') this.renderCoverage();
    if (tab === 'history') this.updateHistory();
    if (tab === 'layers') this.renderLayers();
  }

  bindSplitters() {
    const root = document.documentElement;
    const drag = (el, fn) => el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => { fn(ev); this.app.onResize(); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    drag(document.querySelector('[data-split=left]'), (e) => root.style.setProperty('--left', `${Math.max(220, Math.min(800, e.clientX))}px`));
    drag(document.querySelector('[data-split=right]'), (e) => root.style.setProperty('--right', `${Math.max(260, Math.min(900, window.innerWidth - e.clientX))}px`));
    drag(document.querySelector('.hsplitter'), (e) => root.style.setProperty('--bottom', `${Math.max(60, Math.min(window.innerHeight - 260, window.innerHeight - e.clientY))}px`));
  }

  bindWindows() {
    for (const w of document.querySelectorAll('.window')) {
      const head = w.querySelector('.win-head');
      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => { w.style.left = `${Math.max(0, ev.clientX - dx)}px`; w.style.top = `${Math.max(0, ev.clientY - dy)}px`; };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
      w.querySelector('[data-close]').addEventListener('click', () => { if (w.id === 'win-geom') this.app.geom.close(); else w.hidden = true; });
    }
  }

  dialog(title, html, onReady) {
    const w = document.getElementById('win-dialog');
    w.querySelector('[data-d=title]').textContent = title;
    const body = w.querySelector('[data-d=body]');
    body.innerHTML = html;
    w.hidden = false;
    if (onReady) onReady(body, () => { w.hidden = true; });
    const first = body.querySelector('input,select,textarea,button');
    if (first) first.focus();
  }

  bindToolbar() {
    const app = this.app;
    document.getElementById('toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) app.action(b.dataset.act);
    });
    const speed = document.getElementById('speed');
    speed.addEventListener('input', () => app.controls.setSpeed(Math.exp(speed.value / 100 * Math.log(3000 / 0.5)) * 0.5));
    document.getElementById('bookmarks').addEventListener('change', (e) => {
      if (e.target.value !== '') app.goBookmark(app.bookmarks[Number(e.target.value)]);
      e.target.value = '';
    });
    const snap = () => {
      app.editor.snap.grid = Number(document.getElementById('snap-grid').value) || 0;
      app.editor.snap.angle = Number(document.getElementById('snap-angle').value) || 0;
      app.editor.snap.surface = document.getElementById('snap-surface').checked;
      app.editor.attachGizmo();
    };
    for (const id of ['snap-grid', 'snap-angle', 'snap-surface']) document.getElementById(id).addEventListener('change', snap);
  }

  speedChanged(v) {
    document.getElementById('speed-val').textContent = `${v < 10 ? v.toFixed(1) : Math.round(v)} м/с`;
    document.getElementById('speed').value = String(Math.round((Math.log(v / 0.5) / Math.log(3000 / 0.5)) * 100));
  }

  updateToolState() {
    const app = this.app;
    const set = (act, on) => { const b = document.querySelector(`[data-act=${act}]`); if (b) b.classList.toggle('on', !!on); };
    set('mode-fly', app.controls.mode === 'fly'); set('mode-orbit', app.controls.mode === 'orbit'); set('mode-top', app.controls.mode === 'top');
    const g = app.editor.gizmoMode;
    set('giz-none', !g); set('giz-translate', g === 'translate'); set('giz-rotate', g === 'rotate'); set('giz-scale', g === 'scale');
    set('isolate', !!app.scene.isolate);
    const has = app.editor.selection.length > 0;
    for (const a of ['dup', 'hide', 'delete', 'reset-sel', 'drop', 'focus']) { const b = document.querySelector(`[data-act=${a}]`); if (b) b.disabled = !has; }
    document.querySelector('[data-act=undo]').disabled = !app.editor.undoStack.length;
    document.querySelector('[data-act=redo]').disabled = !app.editor.redoStack.length;
  }

  refreshBookmarks() {
    const s = document.getElementById('bookmarks');
    s.innerHTML = '<option value="">Закладки</option>' + this.app.bookmarks.map((b, i) => `<option value="${i}">${esc(b.name)} (${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.z)})</option>`).join('');
  }

  refreshSelection() {
    this.app.inspector.show([...this.app.editor.selection]);
    this.updateToolState();
  }
  refreshTransformFields() {
    const ref = this.app.editor.selection[0];
    if (!ref) return;
    const t = this.app.editor.transformOf(ref);
    if (!t) return;
    const set = (k, v) => { const el = document.querySelector(`[data-edit=${k}]`); if (el && document.activeElement !== el) el.value = Math.round(v * 1000) / 1000; };
    set('px', t.pos[0]); set('py', t.pos[1]); set('pz', t.pos[2]);
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...t.quat), 'ZXY');
    set('rx', THREE.MathUtils.radToDeg(e.x)); set('ry', THREE.MathUtils.radToDeg(e.y)); set('rz', THREE.MathUtils.radToDeg(e.z));
    set('sx', t.scale[0]); set('sy', t.scale[1]); set('sz', t.scale[2]);
  }

  bindSearch() {
    const q = document.getElementById('search-q');
    let timer = 0;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.runSearch(q.value), 220); });
    document.getElementById('search-out').addEventListener('click', (e) => this.onResultClick(e));
  }

  async runSearch(text) {
    const out = document.getElementById('search-out');
    if (!text.trim()) { out.innerHTML = '<p class="muted pad">Поиск по ID, имени модели, DFF, TXD, COL, IMG, IDE, IPL; «iid:123» — размещение по номеру; «файл.ipl#5» — по устойчивому идентификатору.</p>'; return; }
    out.innerHTML = '<p class="muted pad">Ищу…</p>';
    let r;
    try { r = await getJson(`/api/search?q=${encodeURIComponent(text)}`); } catch (e) { out.innerHTML = `<p class="error pad">${esc(e.message)}</p>`; return; }
    const g = (title, items, fn) => (items.length ? `<div class="res-group"><h4>${title} (${items.length})</h4>${items.map(fn).join('')}</div>` : '');
    const how = { model: 'размещение модели', iid: 'по номеру iid', stable: 'по устойчивому id' };
    out.innerHTML = g('Размещения', r.instances, (x) => `<div class="item" data-iid="${x.iid}"><span class="t">${esc(x.model || '?')} <span class="mono small">${esc(x.stable)}</span></span><span class="s">${esc(how[x.how] || '')} · ${x.pos.map((v) => Math.round(v)).join(', ')}</span></div>`)
      + g('Модели профиля', r.models, (x) => `<div class="item" data-mi="${x.mi}"><span class="t">${x.id} <b>${esc(x.name)}</b> <span class="muted">${esc(x.txd)}</span></span><span class="s">${esc(x.section)} · ${x.placements} разм.</span></div>`)
      + g('Определения IDE', r.definitions, (x) => `<div class="item" data-def="${x.id}" data-name="${esc(x.model)}"><span class="t">${x.id} ${esc(x.model)} <span class="muted small">${esc(x.file)}:${x.line}</span></span><span class="s">${x.chosen ? '<span class="badge on">выбрано</span>' : x.active ? '<span class="badge">активный</span>' : '<span class="badge off">неактивный</span>'}</span></div>`)
      + g('Ресурсы в архивах', r.resources, (x) => `<div class="item" data-rid="${x.rid}"><span class="t">${esc(x.name)} <span class="muted small">${esc(x.container)}</span></span><span class="s">${esc(x.kind)}${x.active ? '' : ' · неакт.'}${x.error ? ' · <span class="error">ошибка</span>' : ''}</span></div>`)
      + g('Коллизии', r.collisions, (x) => `<div class="item" data-rid="${x.rid}"><span class="t">${esc(x.name)} <span class="muted small">${esc(x.container)} №${x.index}</span></span><span class="s">COL${x.version === 1 ? 'L' : x.version}</span></div>`)
      + g('Файлы', r.files, (x) => `<div class="item" data-file="${esc(x.key)}"><span class="t mono small">${esc(x.path)}</span><span class="s">${esc(KIND_NAMES[x.kind] || x.kind)} · ${x.root}</span></div>`)
      || '<p class="muted pad">Ничего не найдено.</p>';
  }

  async onResultClick(e) {
    const it = e.target.closest('.item');
    if (!it) return;
    const app = this.app;
    if (it.dataset.iid !== undefined) return app.selectBase(Number(it.dataset.iid), true);
    if (it.dataset.mi !== undefined) return this.openModel(Number(it.dataset.mi));
    if (it.dataset.rid !== undefined) return this.openResource(Number(it.dataset.rid));
    if (it.dataset.file !== undefined) return this.openFile(it.dataset.file);
    if (it.dataset.def !== undefined) {
      const mi = app.scene.modelById.get(Number(it.dataset.def));
      if (mi !== undefined && app.scene.models[mi].name.toLowerCase() === it.dataset.name.toLowerCase()) return this.openModel(mi);
      const r = await getJson(`/api/search?q=${encodeURIComponent(it.dataset.name)}`);
      const res = r.resources.find((x) => x.kind === 'dff' && x.name.toLowerCase() === `${it.dataset.name.toLowerCase()}.dff`);
      if (res) return this.openResource(res.rid);
      this.toast(`DFF «${it.dataset.name}.dff» не найден ни в одном архиве`, 'warn');
    }
  }

  async openModel(mi) {
    const el = document.getElementById('inspector');
    el.innerHTML = '<p class="muted pad">Загружаю…</p>';
    const mm = await getJson(`/api/inspect/model/${mi}`);
    this.app.inspector.current = null;
    const m = mm.model;
    el.innerHTML = `<div class="pad"><b style="font-size:15px">${esc(m.name)}</b> <span class="badge">модель профиля</span><div class="mono small">ID ${m.id} · ${mm.placements.count} размещений</div></div>
      <div class="actions"><button data-m="geom">Геометрия</button><button data-m="tex">Текстуры</button><button data-m="col">Коллизия</button><button data-m="add-front">Добавить перед камерой</button><button data-m="add-surface">Добавить на поверхность</button><button data-m="add-coords">Добавить по координатам</button>${mm.placements.count ? '<button data-m="goto">К первому размещению</button>' : ''}</div>
      ${this.app.inspector.renderModel(mm)}`;
    el.querySelector('.actions').onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      const spec = this.specFromModel(mi);
      if (b.dataset.m === 'geom') this.app.geom.open({ ...spec });
      if (b.dataset.m === 'tex') this.app.openTexturesSpec(spec);
      if (b.dataset.m === 'col') this.app.openCollisionMi(mi);
      if (b.dataset.m.startsWith('add')) this.app.place(spec, b.dataset.m.slice(4));
      if (b.dataset.m === 'goto') this.app.selectBase(mm.placements.list[0].iid, true);
    };
  }

  specFromModel(mi) {
    const m = this.app.scene.models[mi];
    return { mi, rid: m.dff, id: m.id, name: m.name, section: m.section, txd: m.txd, clump: m.clump, flags: m.flags };
  }

  async openResource(rid) {
    const el = document.getElementById('inspector');
    el.innerHTML = '<p class="muted pad">Загружаю…</p>';
    const d = await getJson(`/api/inspect/resource/${rid}`);
    this.app.inspector.current = null;
    const r = d.resource;
    let html = `<div class="pad"><b style="font-size:15px">${esc(r.name)}</b> <span class="badge">${esc(KIND_NAMES[r.kind] || r.kind)}</span> ${d.activeArchive ? '<span class="badge on">активный архив</span>' : '<span class="badge off">неактивный архив</span>'}
      <div class="mono small">${esc(r.key)}</div><div class="small">${esc(r.container.path)} · запись №${r.entry} · смещение ${r.offsetBytes} б · ${r.sizeBytes} б</div>${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}${r.mismatch ? `<p class="warn">${esc(r.mismatch)}</p>` : ''}</div>`;
    const acts = [];
    if (r.kind === 'dff') acts.push('<button data-r="geom">Геометрия</button><button data-r="add-front">Добавить перед камерой</button><button data-r="add-surface">Добавить на поверхность</button><button data-r="add-coords">Добавить по координатам</button>');
    if (r.kind === 'txd') acts.push('<button data-r="tex">Текстуры</button>');
    html += `<div class="actions">${acts.join('')}<button data-r="file">Архив</button></div>`;
    if (d.structure) html += d.structure.error ? `<p class="error pad">${esc(d.structure.error)}</p>` : `<details open><summary>Структура DFF</summary><div class="sec">${this.app.inspector.structureTables(d.structure)}</div></details>`;
    if (d.definitions) html += `<details open><summary>Определения IDE с этим именем (${d.definitions.length})</summary><div class="sec">${d.definitions.map((x) => `<div class="src">${x.chosen ? '★ ' : ''}${esc(x.file.path)}:${x.line} ${x.active ? '<span class="badge on">активный</span>' : '<span class="badge off">неактивный</span>'}<br>${esc(x.raw)}</div>`).join('') || '<p class="muted">Ни одно IDE не объявляет эту модель — в игре она не загружается.</p>'}</div></details>`;
    if (d.sameName && d.sameName.candidates.length > 1) html += `<details><summary>Файлы с тем же именем (${d.sameName.candidates.length})</summary><div class="sec">${d.sameName.candidates.map((c) => `<div class="small"><span class="mono">${esc(c.container.path)}</span> ${c.activeArchive ? `<span class="badge on">IMG №${c.loadOrder + 1}</span>` : '<span class="badge off">неакт.</span>'}</div>`).join('')}<p class="small">${esc(d.sameName.reason)}</p></div></details>`;
    if (d.txd) html += d.txd.error ? `<p class="error pad">${esc(d.txd.error)}</p>` : `<details open><summary>Текстуры (${d.txd.textures.length})</summary><div class="sec"><table class="grid"><tr><th>имя</th><th>размер</th><th>формат</th><th>мипы</th><th>альфа</th></tr>${d.txd.textures.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.width}×${t.height}</td><td>${esc(t.encoding)} ${esc(t.d3dFormat || t.rasterFormat || '')}</td><td>${t.levels}</td><td>${t.alpha ? 'да' : 'нет'}</td></tr>`).join('')}</table>${d.parent ? `<p>Родительский TXD (txdp): ${esc(d.parent)}</p>` : ''}<p class="small">Используют: ${d.usedBy.map((u) => esc(u.name)).join(', ') || 'ни одна модель профиля'}</p></div></details>`;
    if (d.col) html += `<details open><summary>Модели коллизий (${d.col.models.length})</summary><div class="sec"><table class="grid"><tr><th>#</th><th>имя</th><th>версия</th><th>ID</th><th>примитивы</th></tr>${d.col.models.map((m, i) => `<tr><td>${i}</td><td>${esc(m.n)}</td><td>${m.v === 1 ? 'COLL' : 'COL' + m.v}</td><td>${m.id}</td><td>${m.c ? `сф ${m.c.spheres}, бокс ${m.c.boxes}, гр ${m.c.faces}` : '—'}</td></tr>`).join('')}</table></div></details>`;
    if (d.ipl) html += `<details open><summary>IPL</summary><div class="sec">${esc(JSON.stringify(d.ipl))}</div></details>`;
    if (d.ifp) html += `<details open><summary>IFP</summary><div class="sec">${esc(d.ifp.name || '')} — анимаций ${d.ifp.count || 0}<br><span class="small">${esc((d.ifp.anims || []).slice(0, 300).join(', '))}</span></div></details>`;
    if (d.nodes) html += `<details open><summary>Узлы путей</summary><div class="sec">${esc(JSON.stringify(d.nodes))}</div></details>`;
    el.innerHTML = html;
    el.querySelector('.actions').onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      const def = (d.definitions || []).find((x) => x.chosen) || (d.definitions || [])[0];
      const spec = d.chosenFor && d.chosenFor.length ? this.specFromModel(d.chosenFor[0].mi) : { rid, name: r.name.replace(/\.dff$/i, ''), section: def ? def.section : 'objs', txd: def ? def.txd : r.name.replace(/\.dff$/i, ''), clump: def ? CLUMP.has(def.section) : false, flags: def ? def.flags : 0, id: def ? def.id : undefined };
      if (b.dataset.r === 'geom') this.app.geom.open(spec);
      if (b.dataset.r === 'tex') this.app.openTexturesSpec({ txdRid: rid, txdName: r.name });
      if (b.dataset.r === 'file') this.openFile(r.container.key);
      if (b.dataset.r.startsWith('add')) this.app.place(spec, b.dataset.r.slice(4));
    };
  }

  async openFile(key) {
    const el = document.getElementById('inspector');
    el.innerHTML = '<p class="muted pad">Загружаю…</p>';
    const f = await getJson(`/api/file?key=${encodeURIComponent(key)}`);
    this.app.inspector.current = null;
    let html = `<div class="pad"><b>${esc(f.rel)}</b> <span class="badge">${esc(KIND_NAMES[f.kind] || f.kind)}</span><div class="mono small">${esc(f.key)}</div><div class="small">${f.size} б${f.reason ? ` · распознан: ${esc(f.reason)}` : ''}</div>${f.error ? `<p class="error">${esc(f.error)}</p>` : ''}</div>`;
    if (['ide', 'ipl', 'manifest', 'text', 'empty'].includes(f.kind)) html += `<div class="actions"><button data-f="raw">Показать содержимое</button></div>`;
    if (f.entryList) {
      const by = {};
      for (const e of f.entryList) by[e.kind] = (by[e.kind] || 0) + 1;
      html += `<details open><summary>Записи архива (${f.entryList.length})</summary><div class="sec"><p class="small">${Object.entries(by).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}</p><input type="search" data-f="filter" placeholder="Фильтр записей"><div data-f="entries"></div></div></details>`;
    }
    if (f.defList) html += `<details open><summary>Определения (${f.defList.length})</summary><div class="sec">${f.defList.slice(0, 1500).map((d) => `<div class="item" data-defid="${d.id}" data-name="${esc(d.model)}"><span class="t">${d.id} ${esc(d.model)} <span class="muted small">${esc(d.txd)}</span></span><span class="s">${esc(d.section)} · стр. ${d.line}${d.chosen ? ' <span class="badge on">выбрано</span>' : ''}</span></div>`).join('')}</div></details>`;
    if (f.ide) html += `<details><summary>Служебные и неподдержанные секции IDE</summary><div class="sec">${[...f.ide.service.map((s) => `<p>${esc(s.section)}: ${s.count} строк (служебная, сохранена)</p>`), ...f.ide.unsupported.map((s) => `<p class="warn">${esc(s.section)}: ${s.count} строк — секция не поддерживается</p>`)].join('') || 'нет'}</div></details>`;
    if (f.ipl) html += f.ipl.map((p) => `<details open><summary>IPL: ${p.kind === 'binary' ? 'бинарный' : 'текстовый'}, inst ${p.inst}</summary><div class="sec">${p.header ? `<p class="mono small">${esc(JSON.stringify(p.header))}</p>` : ''}<p>Служебные секции: ${Object.entries(p.service).map(([k, v]) => `${esc(k)}: ${v}`).join(', ') || 'нет'}</p>${p.unsupported.map((u) => `<p class="warn">${esc(u.section)}: ${u.count} строк — не поддерживается</p>`).join('')}</div></details>`).join('');
    if (f.diagnosticsList && f.diagnosticsList.length) html += `<details open><summary>Диагностика (${f.diagnosticsList.length})</summary><div class="sec">${f.diagnosticsList.map((d) => `<div class="small"><span class="${d.level === 'info' ? 'muted' : 'error'}">${esc(d.message)}</span>${d.line ? ` · строка ${d.line}` : ''}${d.offset !== undefined ? ` · смещение ${d.offset}` : ''}${d.entry ? ` · ${esc(d.entry)}` : ''}${d.raw ? `<div class="src">${esc(d.raw)}</div>` : ''}</div>`).join('')}</div></details>`;
    el.innerHTML = html;
    const list = el.querySelector('[data-f=entries]');
    const drawEntries = (q = '') => {
      if (!list) return;
      const rows = f.entryList.filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase())).slice(0, 600);
      list.innerHTML = rows.map((e) => `<div class="item" data-rid="${e.rid}"><span class="t">${esc(e.name)}</span><span class="s">${esc(e.kind)} · сектор ${e.offset} · ${e.sectors * 2048} б${e.error ? ' · <span class="error">ошибка</span>' : ''}${e.mismatch ? ' · <span class="warn">расширение≠содержимое</span>' : ''}</span></div>`).join('') + (rows.length >= 600 ? '<p class="muted">показаны первые 600 — уточните фильтр</p>' : '');
    };
    drawEntries();
    el.onclick = async (e) => {
      const b = e.target.closest('[data-f=raw]');
      if (b) return this.showRaw({ key: f.key, line: 1, context: 400 });
      const it = e.target.closest('[data-rid]');
      if (it) return this.openResource(Number(it.dataset.rid));
      const d = e.target.closest('[data-defid]');
      if (d) { const mi = this.app.scene.modelById.get(Number(d.dataset.defid)); if (mi !== undefined && this.app.scene.models[mi].name.toLowerCase() === d.dataset.name.toLowerCase()) this.openModel(mi); else { const r = await getJson(`/api/search?q=${encodeURIComponent(d.dataset.name)}`); const res = r.resources.find((x) => x.kind === 'dff' && x.name.toLowerCase() === `${d.dataset.name.toLowerCase()}.dff`); if (res) this.openResource(res.rid); else this.toast('DFF не найден', 'warn'); } }
    };
    const flt = el.querySelector('[data-f=filter]');
    if (flt) flt.addEventListener('input', () => drawEntries(flt.value));
  }

  async showRaw({ key, rid, line = 1, offset, length, note, context = 14 }) {
    try {
      const q = new URLSearchParams();
      if (key) q.set('key', key);
      if (rid !== undefined && rid !== null && rid >= 0 && !key) q.set('rid', rid);
      if (offset !== undefined && offset !== null) { q.set('offset', offset); q.set('length', length || 64); }
      else { q.set('line', line); q.set('context', context); }
      if (rid !== undefined && rid >= 0 && offset !== undefined) { q.delete('key'); q.set('rid', rid); }
      const r = await getJson(`/api/raw?${q}`);
      if (r.hex) {
        const bytes = r.hex.match(/../g) || [];
        const rows = [];
        for (let i = 0; i < bytes.length; i += 16) rows.push(`${(r.offset + i).toString(16).padStart(8, '0')}  ${bytes.slice(i, i + 16).join(' ')}`);
        this.dialog('Исходная запись (байты)', `<p class="small">${esc(note || '')}</p><div class="src">${rows.join('\n')}</div>`);
      } else {
        this.dialog(`Исходный текст, строки ${r.from}–${r.to} из ${r.total}`, `<div class="src">${r.lines.map((l, i) => `${String(r.from + i).padStart(5, ' ')}${r.from + i === line ? ' ▶ ' : '   '}${esc(l)}`).join('\n')}</div>`);
      }
    } catch (e) { this.toast(`Источник не прочитан: ${e.message}`, 'error'); }
  }

  bindLibrary() {
    const cat = document.getElementById('lib-cat');
    cat.innerHTML = CATS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    for (const id of ['lib-q', 'lib-cat', 'lib-arch', 'lib-active', 'lib-thumbs']) document.getElementById(id).addEventListener(id === 'lib-q' ? 'input' : 'change', () => this.filterLibrary());
    const list = document.getElementById('lib-list');
    list.addEventListener('scroll', () => this.drawLibrary());
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lact]');
      const it = e.target.closest('[data-li]');
      if (!it) return;
      const item = this.libView[Number(it.dataset.li)];
      const spec = this.specFromLib(item);
      if (!b) return item.mi !== undefined ? this.openModel(item.mi) : this.openResource(item.r);
      if (b.dataset.lact === 'geom') this.app.geom.open(spec);
      else this.app.place(spec, b.dataset.lact);
    });
  }

  async loadLibrary() {
    document.getElementById('lib-count').textContent = 'Загружаю библиотеку…';
    this.lib = await getJson('/api/library');
    this.libThumbs = new Set(this.lib.thumbs || []);
    this.libByRid = new Map(this.lib.items.map((x) => [x.r, x]));
    const arch = document.getElementById('lib-arch');
    arch.innerHTML = '<option value="">Все архивы</option>' + this.lib.containers.sort((a, b) => a.path.localeCompare(b.path)).map((c) => `<option value="${c.fid}">${esc(c.path)}${c.active ? '' : ' (неакт.)'}</option>`).join('');
    this.libActive = new Map(this.lib.containers.map((c) => [c.fid, c.active]));
    this.filterLibrary();
  }

  filterLibrary() {
    if (!this.lib) return;
    const q = document.getElementById('lib-q').value.trim().toLowerCase();
    const cat = document.getElementById('lib-cat').value;
    const arch = document.getElementById('lib-arch').value;
    const onlyActive = document.getElementById('lib-active').checked;
    const num = /^\d+$/.test(q) ? Number(q) : null;
    this.libView = this.lib.items.filter((it) => {
      if (onlyActive && !this.libActive.get(it.f)) return false;
      if (arch && String(it.f) !== arch) return false;
      if (q && !(it.n.toLowerCase().includes(q) || (num !== null && it.d.some((d) => d[0] === num)))) return false;
      if (!cat) return true;
      if (cat === 'lod') return it.n.toLowerCase().startsWith('lod');
      if (cat === 'none') return !it.d.length;
      if (cat === 'err') return !!it.err;
      if (cat[0] === 't') return (it.tg || 0) & Number(cat.slice(1));
      if (cat === 'o') return it.d.some((d) => d[1] === 'o' || d[1] === 't');
      return it.d.some((d) => d[1] === cat);
    });
    document.getElementById('lib-count').textContent = `Моделей: ${this.libView.length} из ${this.lib.items.length} (все DFF из архивов, объявленные в IDE и нет)`;
    document.getElementById('lib-list').scrollTop = 0;
    this.drawLibrary(true);
  }

  specFromLib(it) {
    if (it.mi !== undefined) return this.specFromModel(it.mi);
    const d = it.d.find((x) => x[2] === 1) || it.d.find((x) => x[2] === 2) || it.d[0];
    const section = d ? SECTION_OF[d[1]] || 'objs' : 'objs';
    return { rid: it.r, name: it.n.replace(/\.dff$/i, ''), id: d ? d[0] : undefined, section, txd: d ? d[3] : it.n.replace(/\.dff$/i, ''), clump: CLUMP.has(section), flags: 0 };
  }

  drawLibrary(force) {
    const list = document.getElementById('lib-list');
    const H = 58;
    const total = this.libView.length;
    const first = Math.max(0, Math.floor(list.scrollTop / H) - 4), last = Math.min(total, first + Math.ceil(list.clientHeight / H) + 10);
    if (!force && this.libRange === `${first}:${last}`) return;
    this.libRange = `${first}:${last}`;
    const thumbs = document.getElementById('lib-thumbs').checked;
    let html = `<div style="height:${total * H}px;position:relative">`;
    for (let i = first; i < last; i++) {
      const it = this.libView[i];
      const d = it.d.find((x) => x[2] === 1) || it.d[0];
      const tag = d ? `${d[0]} · ${({ o: 'объект', t: 'по времени', a: 'анимир.', w: 'оружие', c: 'машина', p: 'персонаж', h: 'иерархия' })[d[1]] || d[1]}` : 'нет в IDE';
      html += `<div class="item" data-li="${i}" style="position:absolute;left:0;right:0;top:${i * H}px;height:${H}px">${thumbs ? `<img data-thumb="${it.r}" alt="">` : ''}<span class="t"><b>${esc(it.n)}</b><br><span class="muted small">${esc(tag)}${it.tri ? ` · ${it.tri} треуг.` : ''}${it.err ? ' · <span class="error">ошибка</span>' : ''}${it.mi === undefined && d ? ' · <span class="warn">не в профиле</span>' : ''}</span></span>
        <span class="s"><button data-lact="geom" title="Окно геометрии">3D</button> <button data-lact="front" title="Добавить перед камерой">+</button> <button data-lact="surface" title="Добавить на поверхность (щелчок по карте)">⤓</button> <button data-lact="coords" title="Добавить по координатам">xyz</button></span></div>`;
    }
    list.innerHTML = html + '</div>';
    if (thumbs) for (const img of list.querySelectorAll('img[data-thumb]')) this.thumb(img, Number(img.dataset.thumb));
  }

  thumb(img, rid) {
    const it = this.libByRid.get(rid);
    const render = () => { if (it && !it.err) this.queueThumb(img, it); };
    if (!this.libThumbs.has(rid)) { render(); return; }
    img.onerror = () => { img.onerror = null; img.removeAttribute('src'); this.libThumbs.delete(rid); render(); };
    img.src = `/api/thumb/${rid}`;
  }

  queueThumb(img, it) {
    this.thumbQueue.push({ img, it });
    this.pumpThumbs();
  }

  async pumpThumbs() {
    if (this.thumbBusy || !this.thumbQueue.length) return;
    this.thumbBusy = 1;
    const { img, it } = this.thumbQueue.shift();
    try {
      if (img.isConnected) {
        const url = await this.app.renderThumb(this.specFromLib(it));
        if (url) {
          img.src = url;
          const r = await fetch(`/api/thumb/${it.r}`, { method: 'PUT', body: await (await fetch(url)).blob() }).catch(() => null);
          if (r && r.ok) this.libThumbs.add(it.r);
        }
      }
    } catch {  }
    this.thumbBusy = 0;
    this.pumpThumbs();
  }

  bindFiles() {
    document.getElementById('files-q').addEventListener('input', () => this.drawFiles());
    document.getElementById('files-kind').addEventListener('change', () => this.drawFiles());
    document.getElementById('files-list').addEventListener('click', (e) => { const it = e.target.closest('[data-file]'); if (it) this.openFile(it.dataset.file); });
  }
  async loadFiles() {
    this.files = await getJson('/api/files');
    const kinds = [...new Set(this.files.map((f) => f.kind))];
    document.getElementById('files-kind').innerHTML = '<option value="">Все виды</option>' + kinds.map((k) => `<option value="${k}">${esc(KIND_NAMES[k] || k)} (${this.files.filter((f) => f.kind === k).length})</option>`).join('');
    this.drawFiles();
  }
  drawFiles() {
    if (!this.files) return;
    const q = document.getElementById('files-q').value.toLowerCase(), k = document.getElementById('files-kind').value;
    const rows = this.files.filter((f) => (!k || f.kind === k) && (!q || f.path.toLowerCase().includes(q)));
    document.getElementById('files-list').innerHTML = rows.map((f) => `<div class="item" data-file="${esc(f.key)}"><span class="t"><span class="mono small">${esc(f.path)}</span><br><span class="muted small">${esc(f.root)} · ${esc(KIND_NAMES[f.kind] || f.kind)} · ${(f.size / 1024).toFixed(0)} КБ${f.entries ? ` · ${f.entries} записей` : ''}${f.defs ? ` · ${f.defs} опр.` : ''}${f.diagnostics ? ` · <span class="warn">${f.diagnostics} диагн.</span>` : ''}</span></span><span class="s">${f.profile ? (f.profile.active ? '<span class="badge on">активен</span>' : `<span class="badge off" title="${esc(f.profile.reason)}">неактивен</span>`) : ''}${f.error ? '<span class="badge off">ошибка</span>' : ''}</span></div>`).join('');
  }

  renderLayers() {
    const app = this.app, s = app.scene.settings, meta = app.scene.meta;
    if (!meta) return;
    const el = document.getElementById('layers');
    const cb = (id, label, on, title = '') => `<label class="item" title="${esc(title)}"><input type="checkbox" data-layer="${id}" ${on ? 'checked' : ''}> <span class="t">${label}</span></label>`;
    el.innerHTML = `<h3>Отображение</h3>
      ${cb('showModels', 'Модели карты', s.showModels)}
      ${cb('wire', 'Каркас всех моделей', s.wire)}
      ${cb('boxes', 'Границы (bounding box) рядом с камерой', s.boxes, 'до 180 м, не более 400 объектов')}
      ${cb('axes', 'Оси объектов рядом с камерой', s.axes)}
      ${cb('labels', 'Подписи моделей рядом с камерой', s.labels)}
      ${cb('hideDuplicates', 'Скрывать точные дубли размещений', s.hideDuplicates, 'та же модель, позиция и поворот; в игре они рисуются оба')}
      ${cb('genMips', 'Достраивать мипы текстурам без мипов', app.scene.assets.genMips, 'у ~80% текстур RADMIR в файле один уровень — вдали они рябят; цепочка строится сервером только для показа, файл не меняется, инспектор показывает реальное число уровней')}
      ${cb('minimap', 'Мини-карта (M)', !document.getElementById('minimap').hidden)}
      <div class="row">LOD: <select data-layer-sel="lodMode"><option value="auto">как в игре</option><option value="hd">только HD</option><option value="lod">только LOD</option></select></div>
      <div class="row">Освещение: <select data-layer-sel="lighting"><option value="prelight">prelight + окружающий свет (RW)</option><option value="flat">без prelight: текстуры и простой свет</option></select></div>
      <div class="row" title="Добавка к вершинным цветам. 0 — ровно как записано в DFF. Точная формула шейдеров RADMIR в файлах не задана.">Окружающий свет <input type="range" min="0" max="0.7" step="0.01" data-prelit="ambient" value="${PRELIT.ambient.value}"><span class="num" data-show-prelit="ambient">${PRELIT.ambient.value}</span></div>
      <div class="row" title="Смешивание основного prelight с вторым набором из плагина Extra Vert Colour (в SA это ночные цвета; у части моделей RADMIR второй набор, наоборот, ярче). Влияет только на модели, где второй набор есть.">Основной ↔ Extra Vert Colour <input type="range" min="0" max="1" step="0.05" data-prelit="night" value="${PRELIT.night.value}"><span class="num" data-show-prelit="night">${PRELIT.night.value}</span></div>
      <div class="row">Дальность ×<input type="range" min="0.2" max="4" step="0.1" data-layer-range="drawScale" value="${s.drawScale}"><span class="num" data-show="drawScale">${s.drawScale}</span></div>
      <div class="row">Максимум, м <input type="range" min="300" max="6000" step="100" data-layer-range="maxDistance" value="${s.maxDistance}"><span class="num" data-show="maxDistance">${s.maxDistance}</span></div>
      <h3>Коллизии</h3>
      ${cb('colSelected', 'Коллизия выделенного объекта', s.colSelected)}
      ${cb('colArea', 'Коллизии видимой области (до 140 м)', s.colArea)}
      <p class="muted small pad">Видимость коллизий не влияет на камеру: полёт всегда свободный.</p>
      <h3>Интерьеры и зоны (поле interior & 0xFF)</h3>
      ${meta.interiors.map((i) => cb(`int:${i.area}`, `${i.area === 0 ? 'Улица (0)' : `Интерьер ${i.area}`} — ${i.count}`, s.interiors.has(i.area))).join('')}
      <h3>Служебные слои</h3>
      ${[['zone', 'Зоны (map.zon, info.zon)'], ['enex', 'Входы и выходы (enex)'], ['grge', 'Гаражи (grge)'], ['cull', 'Зоны отсечения (cull)'], ['auzo', 'Аудиозоны (auzo)'], ['paths', 'Пути (nodes*.dat из Paths.img)'], ['water', 'Вода (water.dat)'], ['cars', 'Припаркованные машины (cars)']].map(([k, v]) => cb(`svc:${k}`, v, !!app.scene.serviceLayers[k])).join('')}
      <h3>Исходные файлы IPL (${meta.sourcesList.length})</h3>
      <div class="row"><button data-layer-all="1">Все</button><button data-layer-all="0">Ни одного</button></div>
      ${meta.sourcesList.map((src) => cb(`src:${src.si}`, `<span class="mono small">${esc(src.name)}</span> <span class="muted small">${src.count}${src.stream ? ' · поток' : ''}</span>`, !s.hiddenSources.has(src.si), src.key)).join('')}`;
    el.querySelector('[data-layer-sel=lodMode]').value = s.lodMode;
    el.querySelector('[data-layer-sel=lighting]').value = app.scene.assets.lighting;
    el.onchange = (e) => this.onLayer(e);
    el.oninput = (e) => {
      const pk = e.target.dataset.prelit;
      if (pk) {
        PRELIT[pk].value = Number(e.target.value);
        el.querySelector(`[data-show-prelit=${pk}]`).textContent = e.target.value;
        saveSettings(app);
        return;
      }
      const r = e.target.dataset.layerRange;
      if (!r) return;
      s[r] = Number(e.target.value);
      el.querySelector(`[data-show=${r}]`).textContent = e.target.value;
      app.scene.lastUpdate = 0;
      saveSettings(app);
    };
    el.onclick = (e) => {
      const b = e.target.closest('[data-layer-all]');
      if (!b) return;
      s.hiddenSources = b.dataset.layerAll === '1' ? new Set() : new Set(meta.sourcesList.map((x) => x.si));
      this.renderLayers();
      app.scene.lastUpdate = 0;
    };
  }

  async rebuildModels() {
    const sc = this.app.scene;
    await this.app.editor.rebuildAll(async () => {
      sc.refreshAll();
      for (const a of [...sc.assets.models.values()]) if (a.refs === 0) sc.assets.disposeModel(a);
    });
  }

  async onLayer(e) {
    const app = this.app, sc = app.scene, s = sc.settings;
    const t = e.target;
    if (t.dataset.layerSel === 'lodMode') { s.lodMode = t.value; sc.lastUpdate = 0; saveSettings(app); return; }
    if (t.dataset.layerSel === 'lighting') {
      sc.assets.lighting = t.value;
      saveSettings(app);
      await this.rebuildModels();
      this.toast('Освещение изменено: модели перестраиваются по мере загрузки');
      return;
    }
    const id = t.dataset.layer;
    if (!id) return;
    if (id.startsWith('int:')) { const a = Number(id.slice(4)); if (t.checked) s.interiors.add(a); else s.interiors.delete(a); sc.lastUpdate = 0; saveSettings(app); return; }
    if (id.startsWith('src:')) { const si = Number(id.slice(4)); if (t.checked) s.hiddenSources.delete(si); else s.hiddenSources.add(si); sc.lastUpdate = 0; return; }
    if (id.startsWith('svc:')) {
      const type = id.slice(4);
      try { const r = await sc.setServiceLayer(type, t.checked); if (t.checked) this.toast(`Слой «${type}»: ${r.count} элементов${r.errors && r.errors.length ? `, ошибок ${r.errors.length}` : ''}`); }
      catch (err) { this.toast(`Слой не загружен: ${err.message}`, 'error'); t.checked = false; }
      return;
    }
    if (id === 'minimap') { document.getElementById('minimap').hidden = !t.checked; return; }
    if (id === 'genMips') {
      sc.assets.genMips = t.checked;
      saveSettings(app);
      await this.rebuildModels();
      return;
    }
    s[id] = t.checked;
    if (id === 'showModels') for (const b of sc.batches.values()) for (const m of b.meshes) m.visible = t.checked;
    if (id === 'wire') { sc.assets.wireframe = t.checked; for (const a of sc.assets.models.values()) for (const p of a.parts) for (const m of p.materials) m.wireframe = t.checked; }
    if (id === 'boxes' || id === 'axes') { if (!t.checked) sc.setLines(id === 'boxes' ? 'boxLines' : 'axesLines', []); }
    if (id === 'colArea' && !t.checked) sc.clearCollisions('area');
    if (id === 'colSelected') app.editor.updateSelectionVisuals();
    sc.lastUpdate = 0;
  }

  async renderProfile() {
    const el = document.getElementById('profile');
    el.innerHTML = '<p class="muted pad">Загружаю профиль…</p>';
    const [{ profile: p, world, profiles }, conflicts] = await Promise.all([getJson('/api/profile'), getJson('/api/conflicts')]);
    this.profileDraft = JSON.parse(JSON.stringify(p));
    const list = (kind, title) => {
      const items = this.profileDraft[kind];
      return `<h3>${title} (<span data-pcount="${kind}">${items.filter((x) => x.active && !x.repeat).length}</span> активных из ${items.length})</h3><div class="prof-list" data-plist="${kind}">${items.map((it, i) => this.profItemHtml(kind, it, i)).join('')}</div>`;
    };
    el.innerHTML = `<div class="block"><b>${esc(p.name)}</b><div class="small muted">id ${esc(p.id)} · создан ${esc(p.createdAt || '')}${p.updatedAt ? ` · изменён ${esc(p.updatedAt)}` : ''}</div>
      <p class="small">Активно: ${world.instances} размещений, ${world.models} моделей, ${world.sources} IPL-источников; конфликтов ID ${world.conflicts.ids}, повторов имён в IMG ${world.conflicts.names}, точных дублей ${world.conflicts.duplicates}.</p>
      <div class="actions"><button data-prof="apply">Применить профиль</button><button data-prof="reset">Построить заново по манифестам</button><select data-prof="select">${profiles.map((x) => `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><button data-prof="saveas">Сохранить как…</button><button data-prof="delete" ${profiles.length > 1 ? '' : 'disabled'}>Удалить профили…</button></div></div>
      <h3>Манифесты</h3><div class="block">${p.manifests.map((m) => `<div class="mono small">${esc(m.key)} — ${esc(m.role)}</div>`).join('')}${p.alternativeManifests.length ? `<div class="small muted">Альтернативные (не используются): ${p.alternativeManifests.map(esc).join(', ')}</div>` : ''}</div>
      <h3>Доказательства</h3><ul class="plain small">${p.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h3>Предположения</h3><ul class="plain small warn">${p.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h3>Правила</h3><div class="block">
        <div class="row">Повтор имени в IMG: <select data-rule="imgDuplicate"><option value="first">первый по порядку подключения</option><option value="last">последний</option></select></div>
        <div class="row">Повтор ID в IDE: <select data-rule="ideDuplicate"><option value="last">последний загруженный</option><option value="first">первый</option></select></div>
        <div class="row">Потоковые IPL: <select data-rule="streamIpl" title="IPL-файлы внутри активных IMG"><option value="game">как движок: все IPL из IMG; LOD — от текстового IPL с тем же именем</option><option value="base-name">только связанные с текстовым IPL по имени</option><option value="none">не подключать</option></select></div>
        <label class="row"><input type="checkbox" data-rule="hideExactDuplicates" ${p.rules.hideExactDuplicates ? 'checked' : ''}> скрывать точные дубли размещений</label></div>
      ${list('img', 'IMG-архивы (порядок = приоритет)')}${list('ide', 'IDE')}${list('ipl', 'IPL')}
      <h3>Конфликты ID (${conflicts.ids.length})</h3><div class="prof-list">${conflicts.ids.map((c) => `<div class="prof-item"><span class="mono">${c.id}</span><select data-ovid="${c.id}">${c.options.map((o) => `<option value="${esc(o.key)}" ${o.key === c.chosen ? 'selected' : ''}>${esc(o.file)}:${o.line} — ${esc(o.raw)}</option>`).join('')}</select></div>`).join('') || '<p class="muted pad">нет</p>'}</div>
      <h3>Повторы имён в активных IMG (${conflicts.names.length})</h3><div class="prof-list">${conflicts.names.map((c) => `<div class="prof-item"><span class="p">${esc(c.name)}</span><select data-ovres="${esc(c.name)}">${c.options.map((o) => `<option value="${esc(o)}" ${o === c.chosen ? 'selected' : ''}>${esc(o.split('|')[0])}</option>`).join('')}</select></div>`).join('') || '<p class="muted pad">нет</p>'}</div>`;
    for (const [k, v] of Object.entries(p.rules)) { const s = el.querySelector(`select[data-rule=${k}]`); if (s) s.value = v; }
    el.onchange = (e) => {
      const t = e.target, d = this.profileDraft;
      if (t.dataset.pk && t.type === 'checkbox') { d[t.dataset.pk][Number(t.dataset.pi)].active = t.checked; this.redrawProfileLists(el); }
      if (t.dataset.rule) d.rules[t.dataset.rule] = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.ovid) d.overrides.ide[t.dataset.ovid] = t.value;
      if (t.dataset.ovres) d.overrides.resource[t.dataset.ovres] = t.value;
      if (t.dataset.prof === 'select') this.app.switchProfile(t.value);
    };
    el.onclick = async (e) => {
      const t = e.target;
      if (t.dataset.pmove) {
        const arr = this.profileDraft[t.dataset.pk], i = Number(t.dataset.pi), j = i + Number(t.dataset.pmove);
        if (j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        const prev = el.scrollTop;
        this.redrawProfileLists(el);
        el.scrollTop = prev;
      }
      if (t.dataset.prof === 'apply') this.app.applyProfile(this.profileDraft);
      if (t.dataset.prof === 'reset') this.app.resetProfile();
      if (t.dataset.prof === 'delete') {
        const others = profiles.filter((x) => x.id !== p.id);
        this.dialog('Удалить профили', `<p class="small">Активный профиль «${esc(p.name)}» удалить нельзя. Удаление файла профиля не отменяется.</p>${others.map((x) => `<div class="prof-item"><span class="p">${esc(x.name)}</span><span class="muted small">${esc(x.id)}</span><button data-delprof="${esc(x.id)}">Удалить</button></div>`).join('')}`, (body, close) => {
          body.onclick = async (ev) => {
            const id = ev.target.dataset && ev.target.dataset.delprof;
            if (!id) return;
            try { await getJson(`/api/profile/${encodeURIComponent(id)}`, { method: 'DELETE' }); ev.target.closest('.prof-item').remove(); this.toast('Профиль удалён', 'ok'); }
            catch (err) { this.toast(`Не удалён: ${err.message}`, 'error'); }
            if (!body.querySelector('[data-delprof]')) { close(); this.renderProfile(); }
          };
        });
      }
      if (t.dataset.prof === 'saveas') this.dialog('Сохранить профиль как', '<div class="row">Название <input data-n="name" value="Мой профиль" class="grow"></div><div class="actions"><button data-n="ok">Сохранить и применить</button></div>', (body, close) => {
        body.querySelector('[data-n=ok]').onclick = () => { const name = body.querySelector('[data-n=name]').value.trim() || 'Профиль'; this.profileDraft.name = name; this.profileDraft.id = 'user-' + Date.now().toString(36); close(); this.app.applyProfile(this.profileDraft); };
      });
    };
  }

  profItemHtml(kind, it, i) {
    return `<div class="prof-item" title="${esc(it.reason)}${it.raw ? '\n' + esc(it.raw) : ''}">
        <input type="checkbox" data-pk="${kind}" data-pi="${i}" ${it.active ? 'checked' : ''} ${it.file ? '' : 'disabled'}>
        <span class="p">${esc(it.path)}</span>${it.manifest ? `<span class="muted small">стр. ${it.line}</span>` : '<span class="badge off">вне манифеста</span>'}${it.repeat ? '<span class="badge">повтор</span>' : ''}${!it.file ? '<span class="badge off">нет файла</span>' : ''}
        <button data-pmove="-1" data-pk="${kind}" data-pi="${i}" title="Выше (раньше загружается)">↑</button><button data-pmove="1" data-pk="${kind}" data-pi="${i}" title="Ниже (позже загружается)">↓</button></div>`;
  }

  redrawProfileLists(el) {
    const d = this.profileDraft;
    for (const kind of ['img', 'ide', 'ipl']) {
      const box = el.querySelector(`[data-plist=${kind}]`);
      if (!box) continue;
      const top = box.scrollTop;
      box.innerHTML = d[kind].map((it, i) => this.profItemHtml(kind, it, i)).join('');
      box.scrollTop = top;
      const c = el.querySelector(`[data-pcount=${kind}]`);
      if (c) c.textContent = d[kind].filter((x) => x.active && !x.repeat).length;
    }
  }

  async renderProject() {
    const app = this.app;
    const el = document.getElementById('project');
    let projects = [];
    try { projects = await getJson('/api/projects'); } catch {}
    const s = app.editor.summary();
    let imports = [];
    try { imports = await getJson('/api/imports'); } catch {}
    el.innerHTML = `<h3>Пользовательский слой</h3><div class="block small">Изменено базовых: ${s.moved}, скрыто: ${s.hidden}, удалено: ${s.deleted}, добавлено: ${s.added}. Отмен: ${s.undo}, повторов: ${s.redo}.</div>
      <div class="actions"><button data-p="remove-added">Удалить все добавленные</button><button data-p="reset-all">Полный сброс к базовому профилю</button></div>
      <h3>Проект</h3><div class="row"><input data-p="name" value="${esc(app.projectName || 'проект')}" class="grow"><button data-p="save">Сохранить на сервере</button></div>
      <div class="actions"><button data-p="export">Экспорт слоя (JSON)</button><label class="item" style="display:inline-flex;border:0"><input type="file" data-p="import" accept=".json" hidden><button data-p="import-btn">Импорт слоя…</button></label></div>
      <div class="prof-list">${projects.map((p) => `<div class="prof-item"><span class="p">${esc(p.name)}</span><span class="muted small">${new Date(p.modified).toLocaleString('ru-RU')}</span><button data-p="load" data-name="${esc(p.name)}">Открыть</button><button data-p="del" data-name="${esc(p.name)}">×</button></div>`).join('') || '<p class="muted pad">Сохранённых проектов нет.</p>'}</div>
      <p class="muted small pad">Формат проекта описан в docs/ФОРМАТ_ПРОЕКТА.md. Проект хранит версию формата, профиль карты, отпечатки ресурсов и только изменения поверх базы.</p>
      <h3>Импорт своей модели</h3><div class="block small">DFF и при необходимости TXD и COL. Файлы проверяются до размещения.</div>
      <div class="row"><input type="file" data-p="model-files" multiple accept=".dff,.txd,.col"><button data-p="model-up">Загрузить и проверить</button></div>
      <div data-p="import-report">${this.lastImportReport || ''}</div>
      ${imports.map((i) => `<div class="prof-item" title="${esc([...i.files.map((f) => `${f.name} (${f.size} б)`), ...i.problems].join('\n'))}"><span class="p">${esc(i.id)} — ${esc(i.dff ? i.dff.name : 'нет DFF')}</span>${i.ok ? '<span class="badge on">годен</span>' : '<span class="badge off">ошибки</span>'}${i.problems.length ? `<span class="badge warn">${i.problems.length} замеч.</span>` : ''}
        <select data-imptype="${esc(i.id)}" title="Как разместить: объект, машина (цвета и колёса) или персонаж (поза покоя)"><option value="objs">объект</option><option value="cars">машина</option><option value="peds">персонаж</option></select>
        <button data-p="imp-place" data-id="${esc(i.id)}" ${i.ok ? '' : 'disabled'}>Разместить</button><button data-p="imp-geom" data-id="${esc(i.id)}" ${i.ok ? '' : 'disabled'}>3D</button><button data-p="imp-col" data-id="${esc(i.id)}" ${i.ok ? '' : 'disabled'}>Коллизия</button><button data-p="imp-del" data-id="${esc(i.id)}">×</button></div>`).join('')}
      <h3>Закладки камеры</h3>${app.bookmarks.map((b, i) => `<div class="prof-item"><span class="p">${esc(b.name)} (${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.z)})</span><button data-p="bm-go" data-i="${i}">Перейти</button><button data-p="bm-del" data-i="${i}">×</button></div>`).join('') || '<p class="muted pad">Нет закладок (кнопка «+ Закладка» или B).</p>'}`;
    el.onclick = async (e) => {
      const t = e.target.closest('[data-p]');
      if (!t) return;
      const p = t.dataset.p;
      if (p === 'remove-added') await app.editor.removeAllAdded();
      if (p === 'reset-all') this.dialog('Полный сброс', '<p>Сбросить все изменения базовых объектов и удалить все добавленные объекты? Действие можно отменить (Ctrl+Z).</p><div class="actions"><button data-y>Сбросить</button></div>', (b, close) => { b.querySelector('[data-y]').onclick = async () => { close(); await app.editor.resetAll(); this.toast('Сцена сброшена к базовому профилю', 'ok'); this.renderProject(); }; });
      if (p === 'save') { app.projectName = el.querySelector('[data-p=name]').value.trim() || 'проект'; await app.saveProject(); this.renderProject(); }
      if (p === 'export') app.editor.exportLayer();
      if (p === 'import-btn') el.querySelector('[data-p=import]').click();
      if (p === 'load') await app.loadProjectByName(t.dataset.name);
      if (p === 'del') {
        const name = t.dataset.name;
        this.dialog('Удалить проект', `<p>Удалить сохранённый проект «${esc(name)}» с диска? Это нельзя отменить.</p><div class="actions"><button data-y>Удалить</button></div>`, (b, close) => {
          b.querySelector('[data-y]').onclick = async () => { close(); const r = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }); this.toast(r.ok ? `Проект «${name}» удалён` : 'Проект не удалён', r.ok ? 'ok' : 'error'); this.renderProject(); };
        });
      }
      if (p === 'model-up') await this.uploadModel(el);
      const imp = t.dataset.id ? imports.find((x) => x.id === t.dataset.id) : null;
      const impSpec = () => { const section = el.querySelector(`[data-imptype="${CSS.escape(imp.id)}"]`).value; return { importId: imp.id, name: imp.dff.name.replace(/\.dff$/i, ''), section, clump: true }; };
      if (p === 'imp-place' && imp) app.place(impSpec(), 'front');
      if (p === 'imp-geom' && imp) app.geom.open(impSpec());
      if (p === 'imp-col' && imp) app.openCollisionImport(imp.id, imp.dff.name);
      if (p === 'imp-del' && imp) {
        const used = [...app.editor.added.values()].filter((a) => a.ref.importId === imp.id).length;
        this.dialog('Удалить импорт', `<p>Удалить загруженные файлы импорта «${esc(imp.id)}» (${esc(imp.files.map((f) => f.name).join(', '))})? Это нельзя отменить.</p>${used ? `<p class="warn">На карте ${used} объектов из этого импорта: после удаления они не построятся при следующем открытии проекта.</p>` : ''}<div class="actions"><button data-y>Удалить</button></div>`, (b, close) => {
          b.querySelector('[data-y]').onclick = async () => { close(); await fetch(`/api/import/${encodeURIComponent(imp.id)}/delete`, { method: 'POST' }); this.renderProject(); };
        });
      }
      if (p === 'bm-go') app.goBookmark(app.bookmarks[Number(t.dataset.i)]);
      if (p === 'bm-del') { app.bookmarks.splice(Number(t.dataset.i), 1); app.saveBookmarks(); this.renderProject(); }
      if (['remove-added'].includes(p)) this.renderProject();
    };
    el.querySelector('[data-p=import]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { await app.loadProjectData(JSON.parse(await f.text())); } catch (err) { this.toast(`Слой не загружен: ${err.message}`, 'error'); }
    };
  }

  async uploadModel(el) {
    const files = [...el.querySelector('[data-p=model-files]').files];
    const rep = el.querySelector('[data-p=import-report]');
    if (!files.length) { rep.innerHTML = '<p class="warn pad">Выберите файлы .dff (и .txd, .col).</p>'; return; }
    const id = `imp-${Date.now().toString(36)}`;
    rep.innerHTML = '<p class="muted pad">Загружаю…</p>';
    const refused = [];
    for (const f of files) {
      const r = await fetch(`/api/import/${id}/${encodeURIComponent(f.name)}`, { method: 'PUT', body: f }).catch((e) => ({ ok: false, json: async () => ({ error: e.message }) }));
      if (!r.ok) refused.push(`${f.name}: ${(await r.json().catch(() => ({}))).error || `ошибка ${r.status}`}`);
    }
    let html;
    if (refused.length === files.length) html = `<div class="block small"><p class="error">Ни один файл не принят.</p>${refused.map((x) => `<p class="warn">${esc(x)}</p>`).join('')}</div>`;
    else {
      const r = await getJson(`/api/import/${id}/check`, { method: 'POST' });
      html = `<div class="block small"><p>Импорт ${esc(id)}:</p>${r.ok ? '<p class="ok">Модель читается и может быть размещена.</p>' : '<p class="error">Модель нельзя разместить.</p>'}${[...refused, ...r.problems].map((p) => `<p class="warn">${esc(p)}</p>`).join('')}${r.dff ? `<p>DFF: RW ${esc(r.dff.rw.text)}, атомиков ${r.dff.atomics}, геометрий ${r.dff.geometries}, текстур ${r.dff.textures.length}${r.dff.embeddedCollision ? ', встроенная коллизия' : ''}</p>` : ''}${r.txd.map((t) => `<p>TXD ${esc(t.name)}: текстур ${t.textures.length}${t.textures.some((x) => !x.supported) ? ', есть неподдерживаемые форматы' : ''}</p>`).join('')}${r.col.map((c) => `<p>COL ${esc(c.name)}: моделей ${c.models.length}${r.colMatch ? ', есть модель с именем DFF' : ''}</p>`).join('')}</div>`;
    }
    this.lastImportReport = html;
    rep.innerHTML = html;
    this.renderProject();
  }

  updateStatus() {
    const app = this.app;
    if (!app.scene || !app.scene.meta) return;
    const i = app.scene.info();
    const a = i.assets;
    const mb = (b) => (b / 1048576).toFixed(0);
    const el = document.getElementById('status');
    if (document.querySelector('[data-pane=status]').classList.contains('active')) {
      el.innerHTML = `<div class="row wrap small">
        <span>Ячеек загружено: <b>${i.cellsLoaded}</b> из ${Object.keys(app.scene.meta.cellCounts).length}</span>
        <span>Размещений в памяти: <b>${i.instances}</b></span><span>Кандидатов: ${i.candidates}</span><span>Видно: <b>${i.visible}</b></span>
        <span>Моделей: ${a.ready} готово, ${a.loading} в очереди/загрузке, ${a.failed} ошибок</span>
        <span>Текстур: ${a.texReady}/${a.textures}</span><span>Очереди: геометрия ${a.geomQueue}, текстуры ${a.texQueue}</span>
        <span>Память: геометрия ${mb(a.bytes.geometry)} / ${mb(app.scene.assets.budget.geometry)} МБ, текстуры ${mb(a.bytes.texture)} / ${mb(app.scene.assets.budget.texture)} МБ</span>
        <span>Освобождено: моделей ${a.evicted.models}, текстур ${a.evicted.textures}</span>
        <span>Вызовов отрисовки: ${i.drawCalls}, треугольников: ${i.triangles}</span><span>FPS: ${app.fps.toFixed(0)}</span></div>
        ${app.scene.assets.errors.length ? `<h3>Ошибки загрузки (${app.scene.assets.errors.length})</h3><div class="small">${app.scene.assets.errors.slice(-15).reverse().map((e) => `<div class="error">${esc(e.key)}: ${esc(e.error)}</div>`).join('')}</div>` : ''}`;
    }
    if (document.querySelector('[data-pane=stats]').classList.contains('active')) {
      document.getElementById('stats').innerHTML = `<table class="kv small"><tr><th>Пакетов (моделей с экземплярами)</th><td>${i.batches}</td></tr><tr><th>Запросов ячеек</th><td>${i.cellRequests}</td></tr><tr><th>GPU-геометрий / текстур (three.js)</th><td>${i.gpu.geometries} / ${i.gpu.textures}</td></tr><tr><th>S3TC (DXT) в браузере</th><td>${app.scene.assets.s3tc ? 'поддерживается — текстуры передаются без распаковки' : 'нет — сервер распаковывает в RGBA'}</td></tr>
        <tr><th>Лимит геометрии, МБ</th><td><input type="number" min="128" step="64" data-budget="geometry" value="${mb(app.scene.assets.budget.geometry)}"></td></tr><tr><th>Лимит текстур, МБ</th><td><input type="number" min="128" step="64" data-budget="texture" value="${mb(app.scene.assets.budget.texture)}"></td></tr></table>
        <div class="actions"><button data-free>Освободить неиспользуемое</button></div>`;
      const st = document.getElementById('stats');
      st.onchange = (e) => {
        const k = e.target.dataset.budget;
        if (!k) return;
        const v = Number(e.target.value);
        if (!Number.isFinite(v) || v < 128) { this.toast('Лимит — число не меньше 128 МБ', 'error'); e.target.value = mb(app.scene.assets.budget[k]); return; }
        app.scene.assets.budget[k] = v * 1048576;
      };
      st.onclick = (e) => { if (e.target.dataset.free !== undefined) { const n = app.scene.assets.collect(true); this.toast(`Освобождено моделей: ${n}`); } };
    }
  }

  async renderDiagnostics() {
    const el = document.getElementById('diag');
    el.innerHTML = '<p class="muted pad">Загружаю…</p>';
    const d = await getJson('/api/diagnostics');
    this.diagData = d;
    const sample = (s) => [s.src && s.src.split('|').pop(), s.line ? `стр. ${s.line}` : '', s.offset !== undefined && s.offset !== null ? `@${s.offset}` : '', s.id !== undefined ? `ID ${s.id}` : '', s.ipl ? `IPL «${s.ipl}»` : s.model ? `«${s.model}»` : '', s.ide ? `IDE «${s.ide}»` : '', s.lodIndex !== undefined ? `LOD ${s.lodIndex}` : ''].filter(Boolean).join(' ');
    const rows = [...d.world.map((x) => ({ level: x.level || 'error', where: x.key || 'профиль', file: x.key || '', message: x.message, raw: Array.isArray(x.samples) && x.samples.length ? `${x.samples.slice(0, 3).map(sample).join('; ')}${x.samples.length > 3 ? `; … всего примеров ${x.samples.length}` : ''}` : '' })), ...d.catalog.map((x) => ({ level: x.level || 'error', where: x.entry ? `${x.file} → ${x.entry}` : x.file, file: x.file, line: x.line, offset: x.offset, message: x.message, raw: x.raw || '' }))];
    el.innerHTML = `<div class="row"><input type="search" data-dq placeholder="Фильтр"><button data-dx="csv">CSV</button><button data-dx="json">JSON</button><span class="muted small">Всего: ${rows.length}; конфликтов ID ${d.conflicts.ids.length}, повторов имён ${d.conflicts.names.length}, дублей ${d.conflicts.duplicates.length} (первые 500)</span></div>
      <table class="grid" data-dt><tr><th>уровень</th><th>где</th><th>строка/смещение</th><th>сообщение</th><th>исходная запись</th></tr></table>`;
    const draw = (q = '') => {
      const t = el.querySelector('[data-dt]');
      const f = rows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())).slice(0, 1500);
      t.innerHTML = '<tr><th>уровень</th><th>где</th><th>строка/смещение</th><th>сообщение</th><th>исходная запись</th></tr>' + f.map((r) => `<tr><td class="${r.level === 'info' ? 'muted' : r.level === 'warning' ? 'warn' : 'error'}">${esc(r.level)}</td><td class="mono small">${esc(r.where)}</td><td>${r.line ? `стр. ${r.line}` : ''}${r.offset !== undefined ? ` @${r.offset}` : ''}</td><td>${esc(r.message)}</td><td class="mono small">${esc(r.raw)}</td></tr>`).join('');
    };
    draw();
    el.querySelector('[data-dq]').addEventListener('input', (e) => draw(e.target.value));
    el.onclick = (e) => {
      if (e.target.dataset.dx === 'csv') download('диагностика.csv', toCsv(rows, ['level', 'where', 'file', 'line', 'offset', 'message', 'raw']), 'text/csv');
      if (e.target.dataset.dx === 'json') download('диагностика.json', JSON.stringify(d, null, 1));
    };
  }

  async renderCoverage() {
    const el = document.getElementById('coverage');
    el.innerHTML = '<p class="muted pad">Считаю покрытие…</p>';
    const c = await getJson('/api/coverage');
    this.coverageData = c;
    const t = (o) => `<table class="kv small">${Object.entries(o).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${typeof v === 'object' ? `<span class="mono">${esc(JSON.stringify(v))}</span>` : esc(v)}</td></tr>`).join('')}</table>`;
    el.innerHTML = `<div class="actions"><button data-cv="json">Экспорт JSON</button><button data-cv="save">Сохранить в docs/coverage.json</button></div>
      <div class="row wrap" style="align-items:flex-start">
      <div class="grow"><h3>Файлы</h3>${t({ всего: c.files.total, ...c.files.byRoot, ...c.files.byKind })}<h3>Записи IMG</h3>${t({ всего: c.archiveEntries.total, ...c.archiveEntries.byKind, ошибок: c.archiveEntries.errorCount })}</div>
      <div class="grow"><h3>DFF / TXD / COL</h3>${t({ 'DFF найдено': c.dff.total, 'DFF прочитано': c.dff.parsed, 'DFF с ошибкой': c.dff.failed, 'TXD найдено': c.txd.total, 'TXD прочитано': c.txd.parsed, 'текстур всего': c.txd.textures, 'текстур поддерживается': c.txd.texturesSupported, 'COL-файлов': c.col.files, 'COL-моделей': c.col.models, 'версии COL': c.col.versions })}</div>
      <div class="grow"><h3>IDE / IPL</h3>${t({ 'IDE-файлов': c.ide.files, определений: c.ide.definitions, 'уникальных ID': c.ide.uniqueIds, 'активных IDE': c.ide.activeFiles, 'активных ID': c.ide.activeIds, 'конфликтов ID (активных)': c.ide.idConflictsActive, 'текстовых IPL': c.ipl.textFiles, 'бинарных IPL': c.ipl.binaryFiles, 'размещений во всех файлах': c.ipl.placementsInAllFiles, 'активных источников': c.ipl.activeSources, 'из них потоковых': c.ipl.streamSources, 'размещений активировано': c.ipl.activePlacements, 'можно отрисовать': c.ipl.drawable, 'без определения': c.ipl.withoutDefinition, 'без DFF': c.ipl.withoutDff, 'LOD-связей': c.ipl.lodLinks, 'точных дублей': c.ipl.exactDuplicates })}</div>
      <div class="grow"><h3>Модели профиля</h3>${t({ всего: c.models.total, 'с DFF': c.models.withDff, 'с TXD': c.models.withTxd, 'с COL-файлом': c.models.withCollisionFile, 'со встроенной коллизией': c.models.withEmbeddedCollision, 'текстур нужно': c.models.texturesNeeded, 'текстур найдено': c.models.texturesResolved, 'моделей со всеми текстурами': c.models.modelsWithAllTextures })}<h3>Служебные секции</h3>${t(c.service)}</div></div>
      <h3>Не поддерживается</h3><table class="grid small">${c.notSupported.map((n) => `<tr><td>${esc(n.what)}</td><td>${esc(n.why)}</td></tr>`).join('')}</table>
      <h3>Неподдержанные секции (${c.unsupportedSections.length})</h3><div class="small">${c.unsupportedSections.map((u) => `${esc(u.file)}: ${esc(u.section)} (${u.lines})`).join('<br>') || 'нет'}</div>
      <h3>Неразобранные записи по расширениям</h3>${t(c.unknownEntries)}
      ${c.gameImport ? `<h3>Ресурсы из установленной игры</h3>${t(c.gameImport)}` : ''}`;
    el.onclick = async (e) => {
      if (e.target.dataset.cv === 'json') download('покрытие.json', JSON.stringify(c, null, 1));
      if (e.target.dataset.cv === 'save') { const r = await sendJson('/api/report', 'POST', c); this.toast(`Сохранено: ${r.path}`, 'ok'); }
    };
  }

  updateHistory() {
    const ed = this.app.editor;
    const el = document.getElementById('history');
    el.innerHTML = `<div class="row small"><span>Отменить: ${ed.undoStack.length}</span><span>Повторить: ${ed.redoStack.length}</span></div>${ed.undoStack.slice().reverse().map((c, i) => `<div class="item small">${i === 0 ? '▶ ' : ''}${esc(c.label)}</div>`).join('')}${ed.redoStack.length ? `<h3>Можно повторить</h3>${ed.redoStack.slice().reverse().map((c) => `<div class="item small muted">${esc(c.label)}</div>`).join('')}` : ''}`;
    this.updateToolState();
  }

  updateLayerSummary() { if (document.querySelector('[data-pane=project]').classList.contains('active')) this.renderProject(); }

  renderHelp() {
    document.getElementById('help-body').innerHTML = `
      <h3>Полёт</h3><ul class="plain">
      <li><span class="kbd">W A S D</span> — вперёд, влево, назад, вправо; <span class="kbd">Пробел</span>/<span class="kbd">E</span> — вверх; <span class="kbd">Q</span>/<span class="kbd">C</span> — вниз</li>
      <li>Правая кнопка мыши (зажать) — взгляд; <span class="kbd">L</span> или «Взгляд мышью» — захват курсора, <span class="kbd">Esc</span> — отпустить</li>
      <li>Колесо — скорость; <span class="kbd">Shift</span> — ×4 быстрее; <span class="kbd">Alt</span> или <span class="kbd">Ctrl</span> — точный медленный режим</li>
      <li><span class="kbd">O</span> — орбита вокруг выделения (колесо — расстояние), <span class="kbd">T</span> — вид сверху, <span class="kbd">F</span> — фокус на выделении</li>
      <li><span class="kbd">G</span> — перейти к координатам, <span class="kbd">B</span> — закладка камеры, <span class="kbd">M</span> — показать или спрятать мини-карту; щелчок по мини-карте — перелёт</li></ul>
      <h3>Выбор и правка</h3><ul class="plain">
      <li>Щелчок — выбрать объект, <span class="kbd">Shift</span>+щелчок — добавить к выделению</li>
      <li><span class="kbd">1</span>/<span class="kbd">2</span>/<span class="kbd">3</span> — перемещение/поворот/масштаб манипулятором, <span class="kbd">0</span> — только выбор</li>
      <li><span class="kbd">Ctrl+D</span> — копия, <span class="kbd">Ctrl+H</span> — скрыть, <span class="kbd">I</span> — изолировать, <span class="kbd">Delete</span> — удалить</li>
      <li><span class="kbd">Ctrl+Z</span>/<span class="kbd">Ctrl+Y</span> — отмена/повтор, <span class="kbd">Ctrl+S</span> — сохранить проект, <span class="kbd">P</span> — снимок сцены</li>
      <li>В режиме размещения «на поверхность» щёлкните по карте; <span class="kbd">Esc</span> — отменить размещение</li></ul>
      <h3>Что откуда</h3><p>Карта собирается из профиля (вкладка «Профиль»): IMG/IDE/IPL из манифестов CustomSAA2\\DEFAULT.DAT и GTA.DAT. Исходные файлы не изменяются: правки хранятся в пользовательском слое и сохраняются в проект. Инспектор показывает файл, строку или смещение записи и какие ресурсы использованы.</p>`;
  }
}
