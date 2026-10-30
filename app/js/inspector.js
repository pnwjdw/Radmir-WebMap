import * as THREE from 'three';
import { getJson, copyText, download, toCsv } from './api.js';

export const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const vec = (a) => (a ? `[${a.map(r3).join(', ')}]` : '—');
const SRC = '<span class="tag-src" title="значение из исходного файла">исх.</span>';
const CALC = '<span class="tag-calc" title="вычислено просмотрщиком">выч.</span>';
const UNK = '<span class="tag-unk" title="значение не определено">неизв.</span>';
const SECTION_NAMES = { objs: 'объект (objs)', tobj: 'объект по времени (tobj)', anim: 'анимированный (anim)', weap: 'оружие (weap)', cars: 'транспорт (cars)', peds: 'персонаж (peds)', hier: 'иерархия/катсцена (hier)' };

function kv(rows) {
  return `<table class="kv">${rows.filter(Boolean).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
}
function det(title, body, open = false) { return `<details ${open ? 'open' : ''}><summary>${title}</summary><div class="sec">${body}</div></details>`; }
function resLine(r) {
  if (!r) return '—';
  return `<span class="mono">${esc(r.container.path)}</span> → <b>${esc(r.name)}</b>${r.entry >= 0 ? ` (запись №${r.entry}, смещение ${r.offsetBytes} б = сектор ${r.offsetSectors}, размер ${r.sizeBytes} б)` : ` (отдельный файл, ${r.sizeBytes} б)`} <a class="link" data-res="${r.rid}">открыть</a>`;
}

export class Inspector {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.current = null;
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
  }

  async show(sel) {
    const ed = this.app.editor;
    this.current = sel;
    if (!sel.length) { this.el.innerHTML = '<p class="muted pad">Ничего не выбрано. Щёлкните объект на карте или выберите его в поиске, библиотеке или файлах.</p>'; return; }
    if (sel.length > 1) {
      this.el.innerHTML = `<div class="pad"><b>Выбрано объектов: ${sel.length}</b><p class="muted">Манипулятор двигает всю группу; копирование, скрытие и удаление применяются ко всем.</p>${sel.map((r) => `<div class="item" data-selone="${ed.keyOf(r)}"><span class="t">${esc(this.refName(r))}</span><span class="s">${r.kind === 'base' ? 'базовый' : 'добавлен'}</span></div>`).join('')}</div>`;
      return;
    }
    const r = sel[0];
    this.el.innerHTML = '<p class="muted pad">Загружаю сведения…</p>';
    try {
      if (r.kind === 'base') {
        const data = await getJson(`/api/inspect/instance/${r.iid}`);
        if (this.current !== sel) return;
        this.data = data;
        this.el.innerHTML = this.renderInstance(r, data);
      } else {
        const a = ed.added.get(r.uid);
        let model = null;
        if (a.ref.importId) model = { importInfo: await getJson('/api/imports').then((l) => l.find((x) => x.id === a.ref.importId)) };
        else if (a.ref.mi !== undefined && a.ref.mi >= 0) model = await getJson(`/api/inspect/model/${a.ref.mi}`);
        else if (a.ref.rid >= 0) model = { resource: await getJson(`/api/inspect/resource/${a.ref.rid}`) };
        if (this.current !== sel) return;
        this.data = { added: a, model };
        this.el.innerHTML = await this.renderAdded(r, a, model);
      }
    } catch (e) { this.el.innerHTML = `<p class="error pad">Не удалось получить сведения: ${esc(e.message)}</p>`; }
  }

  refName(r) {
    const ed = this.app.editor;
    if (r.kind === 'added') return (ed.added.get(r.uid) || {}).name || `объект ${r.uid}`;
    const rec = ed.baseRecord(r.iid);
    return rec && rec.mi >= 0 ? this.app.scene.models[rec.mi].name : `размещение ${r.iid}`;
  }

  editBlock(ref) {
    const t = this.app.editor.transformOf(ref);
    if (!t) return '';
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...t.quat), 'ZXY');
    const deg = (v) => Math.round(THREE.MathUtils.radToDeg(v) * 1000) / 1000;
    const f = (id, v, step = 0.1) => `<input class="num-in" data-edit="${id}" type="number" step="${step}" value="${r3(v)}">`;
    return det('Положение (текущее)', `<table class="kv">
      <tr><th>Позиция X, Y, Z</th><td>${f('px', t.pos[0])} ${f('py', t.pos[1])} ${f('pz', t.pos[2])}</td></tr>
      <tr><th>Поворот Z, X, Y (°)</th><td>${f('rz', deg(e.z), 1)} ${f('rx', deg(e.x), 1)} ${f('ry', deg(e.y), 1)}</td></tr>
      <tr><th>Масштаб</th><td>${f('sx', t.scale[0], 0.05)} ${f('sy', t.scale[1], 0.05)} ${f('sz', t.scale[2], 0.05)}</td></tr>
      <tr><th>Кватернион</th><td class="mono">${vec(t.quat)}</td></tr></table>
      <div class="actions"><button data-act2="apply-edit">Применить</button><button data-act2="drop">На поверхность</button><button data-act2="reset-one">Сброс</button></div>
      <p class="muted small">Масштаб базовых объектов в IPL SA не задаётся; он хранится только в пользовательском слое.</p>`, true);
  }

  renderInstance(ref, d) {
    const ed = this.app.editor;
    const ov = ed.overrides.get(ref.stable);
    const m = d.model && d.model.model;
    const badges = [`<span class="badge">базовый</span>`];
    if (ov && ov.pos) badges.push('<span class="badge info">изменён</span>');
    if (ov && ov.hidden) badges.push('<span class="badge off">скрыт</span>');
    if (ov && ov.deleted) badges.push('<span class="badge off">удалён в слое</span>');
    if (d.lodChildren && d.lodChildren.length) badges.push('<span class="badge info">LOD</span>');
    if (d.duplicateOf !== null && d.duplicateOf !== undefined) badges.push('<span class="badge off">точный дубль</span>');
    let html = `<div class="pad"><div><b style="font-size:15px">${esc(m ? m.name : 'нет модели')}</b> ${badges.join('')}</div>
      <div class="mono small">${esc(d.stable)} · iid ${d.iid}${m ? ` · ID ${m.id}` : ''}</div></div>
      <div class="actions"><button data-act2="focus">Фокус</button><button data-act2="orbit">Орбита</button>${m ? '<button data-act2="geom">Геометрия</button><button data-act2="tex">Текстуры</button><button data-act2="col">Коллизия</button>' : ''}
      <button data-act2="copy-pos">Копировать координаты</button><button data-act2="copy-src">Копировать происхождение</button><button data-act2="raw">Исходная запись</button></div>`;
    html += this.editBlock(ref);
    const o = d.original;
    html += det('Размещение (IPL)', kv([
      ['Файл', `<span class="mono">${esc(d.source.key)}</span> ${d.source.baseText ? `<span class="badge info">поток к ${esc(d.source.baseText.split('/').pop())}</span>` : d.source.orphan ? '<span class="badge warn" title="Имя не начинается с «<текстовый IPL>_stream» активного текстового IPL: движок грузит такой файл потоково, но без LOD-связей">поток без текстового IPL</span>' : ''}`],
      ['Тип файла', d.source.kind === 'binary' ? 'бинарный IPL (bnry)' : d.source.stream ? 'текстовый IPL внутри IMG (движок читает только inst)' : 'текстовый IPL'],
      ['Подключение', d.source.manifestLine ? esc(d.source.manifestLine) : d.source.orphan ? 'нет строки в манифесте: файл в активном IMG, правило профиля «Потоковые IPL — как движок»' : '—'],
      ['Секция / запись', d.record ? `inst, №${d.record.index}${d.record.line ? `, строка ${d.record.line}` : ''}${d.record.offset !== null ? `, смещение ${d.record.offset} б` : ''} (${esc(d.record.format)})` : '—'],
      ['ID в записи', o ? `${o.id} ${SRC}` : '—'],
      ['Имя в записи', o && o.modelName ? `${esc(o.modelName)} ${SRC}` : `нет (бинарный формат хранит только ID) ${SRC}`],
      d.nameNote ? ['Примечание', `<span class="warn">${esc(d.nameNote)}</span>`] : null,
      ['Позиция', o ? `${vec(o.pos)} ${SRC}` : '—'],
      ['Поворот (кватернион в IPL)', o ? `${vec(o.rotation)} ${SRC}` : '—'],
      ['Поворот, применённый', `${vec(d.applied.quaternionWorld)} ${CALC} <span class="muted small">${esc(d.applied.note)}</span>`],
      o && o.scale ? ['Масштаб (VC/III)', `${vec(o.scale)} ${SRC}`] : null,
      ['Интерьер', o ? `${o.interior.raw} ${SRC} → зона ${o.interior.area} ${CALC}${o.interior.flags.length ? '<br>' + o.interior.flags.map(esc).join('<br>') : ''}` : '—'],
      ['LOD-индекс', o ? `${o.lodIndex} ${SRC}${d.lod ? ` → <a class="link" data-iid="${d.lod.iid}">${esc(d.lod.model)} (iid ${d.lod.iid})</a>` : o.lodIndex >= 0 ? ' → не найден' : ''}` : '—'],
      ['HD-объекты этого LOD', d.lodChildren.length ? d.lodChildren.map((c) => `<a class="link" data-iid="${c.iid}">${esc(c.model)}</a>`).join(', ') : 'нет'],
      d.duplicateOf !== null && d.duplicateOf !== undefined ? ['Дубль', `та же модель, позиция и поворот, что у <a class="link" data-iid="${d.duplicateOf}">iid ${d.duplicateOf}</a>`] : null,
    ]), true);
    if (d.model && d.model.error) html += det('Модель', `<p class="error">${esc(d.model.error)}</p>${(d.model.definitionsAnywhere || []).map((x) => `<div class="src">${esc(x.file.path)}:${x.line} ${esc(x.raw)} ${x.active ? '' : '(неактивный IDE)'}</div>`).join('')}`, true);
    else html += this.renderModel(d.model);
    return html;
  }

  renderModel(mm) {
    if (!mm || mm.error) return det('Модель', `<p class="error">${esc(mm ? mm.error : 'нет данных')}</p>`);
    const m = mm.model, def = mm.definition;
    let html = det('Определение (IDE)', kv([
      ['ID / имя', `${m.id} / <b>${esc(m.name)}</b> ${SRC}`],
      ['Тип', `${esc(SECTION_NAMES[m.section] || m.section)} · ${m.clump ? 'clump-модель' : 'атомарная модель'}`],
      ['Файл и строка', `<span class="mono">${esc(def.file.path)}:${def.line}</span> <a class="link" data-raw="${esc(def.file.key)}" data-line="${def.line}">открыть</a>`],
      ['Исходная запись', `<div class="src">${esc(def.raw)}</div>`],
      ['TXD', `${esc(def.txd)} ${SRC}`],
      ['Дистанция прорисовки', `${def.drawDist.join(', ') || '—'} ${SRC}`],
      ['Флаги', `${def.flags} (0x${(def.flags >>> 0).toString(16)}) ${SRC}${def.flagNames.length ? '<br>' + def.flagNames.map(esc).join('<br>') : ''}`],
      Object.keys(def.extra || {}).length ? ['Прочие поля', `<span class="mono small">${esc(JSON.stringify(def.extra))}</span>`] : null,
      ['Выбор', def.chosen ? (mm.alternatives.filter((a) => a.active).length > 1 ? 'один из нескольких активных — см. альтернативы' : 'единственное активное определение') : 'не выбрано'],
    ]) + (mm.alternatives.length > 1 ? `<h4>Все определения ID ${m.id}</h4>${mm.alternatives.map((a) => `<div class="src">${a.chosen ? '★ ' : ''}${esc(a.file.path)}:${a.line} ${a.active ? '<span class="badge on">активный IDE</span>' : '<span class="badge off">неактивный IDE</span>'}<br>${esc(a.raw)}</div>`).join('')}` : ''), true);
    const dff = mm.dff;
    const st = mm.structure;
    html += det('Модель DFF', kv([
      ['Ресурс', resLine(dff.chosen)],
      ['Почему этот', esc(dff.reason)],
      ['Варианты', dff.candidates.length > 1 ? dff.candidates.map((c) => `${c.rid === (dff.chosen || {}).rid ? '★ ' : ''}<span class="mono small">${esc(c.container.path)}</span> ${c.activeArchive ? `<span class="badge on">IMG №${c.loadOrder + 1}</span>` : '<span class="badge off">неактивный</span>'}`).join('<br>') : 'один'],
      st && !st.error ? ['RenderWare', `${esc(st.rw.text)} (${esc(st.rw.libId)}) — ${esc(st.rw.game)}`] : null,
      st && !st.error ? ['Состав', `${st.frames.length} фреймов, ${st.atomics.length} атомиков, ${st.geometries.length} геометрий${st.clumps > 1 ? `, ${st.clumps} clump` : ''}${st.lights ? `, светов ${st.lights}` : ''}${st.uvAnimDict ? ', словарь UV-анимаций' : ''}${st.embeddedCollision ? ', встроенная коллизия' : ''}`] : null,
      ['Размеры (bbox)', m.bbox ? `${vec(m.bbox[0])} — ${vec(m.bbox[1])} ${CALC}` : UNK],
      ['Сфера', m.bsphere ? `центр ${vec(m.bsphere.slice(0, 3))}, радиус ${r3(m.bsphere[3])} ${CALC}` : UNK],
      st && st.error ? ['Ошибка', `<span class="error">${esc(st.error)}</span>`] : null,
    ]) + (st && !st.error ? this.structureTables(st) : ''));
    html += det(`Текстуры (${mm.textures.length})`, `<p class="small">Цепочка TXD: ${mm.txdChain.map((c) => `<a class="link" data-res="${c.rid}">${esc(c.name)}</a> <span class="muted">(${esc(c.reason)})</span>`).join(' → ') || '<span class="warn">TXD не найден</span>'}</p>
      <table class="grid"><tr><th>текстура</th><th>TXD</th><th>размер</th><th>формат</th><th>мипы</th><th>альфа</th></tr>
      ${mm.textures.map((t) => (t.missing ? `<tr><td>${esc(t.name)}</td><td colspan="5" class="error">не найдена в цепочке TXD</td></tr>` : `<tr><td>${esc(t.name)}</td><td>${esc(t.txd)}</td><td>${t.width}×${t.height}</td><td>${esc(t.encoding)} ${esc(t.d3dFormat || t.rasterFormat || '')}</td><td>${t.levels}</td><td>${t.alpha ? 'да' : 'нет'}</td></tr>`)).join('')}</table>`);
    const c = mm.collision;
    html += det('Коллизия (COL)', kv([
      ['Статус', esc({ found: 'найдена в COL-файле', embedded: 'встроена в DFF', inactive: 'есть только в неактивных архивах', none: 'нет коллизии' }[c.status])],
      ['Причина', esc(c.reason)],
      c.source ? ['Источник', resLine(c.source) + ` · модель №${c.modelIndex} в файле`] : null,
      c.header ? ['Версия', `${c.header.v === 1 ? 'COLL' : 'COL' + c.header.v}, ID в COL ${c.header.id}`] : null,
      c.header && c.header.c ? ['Примитивы', `сфер ${c.header.c.spheres}, боксов ${c.header.c.boxes}, граней ${c.header.c.faces}${c.header.c.shadowFaces ? `, теневых граней ${c.header.c.shadowFaces}` : ''}`] : null,
      c.header && c.header.b ? ['Границы', `${vec(c.header.b.min)} — ${vec(c.header.b.max)}, радиус ${r3(c.header.b.radius)} ${SRC}`] : null,
      c.alternatives && c.alternatives.length > 1 ? ['Варианты', c.alternatives.map((x) => `<span class="mono small">${esc(x.container.path)}</span> ${x.activeArchive ? '<span class="badge on">акт.</span>' : '<span class="badge off">неакт.</span>'}`).join('<br>')] : null,
    ]));
    html += det(`Размещения модели (${mm.placements.count})`, `<div class="actions"><button data-act2="placements-csv" data-mi="${m.mi}">Экспорт CSV</button></div>${mm.placements.list.slice(0, 200).map((p) => `<div class="item" data-iid="${p.iid}"><span class="t mono small">${esc(p.stable)}</span><span class="s">${vec(p.pos)}${p.interior ? ` · инт. ${p.interior}` : ''}</span></div>`).join('')}${mm.placements.count > 200 ? `<p class="muted">и ещё ${mm.placements.count - 200}</p>` : ''}`);
    if (mm.conflicts.length || mm.missing.length) html += det('Конфликты и недостающее', `${mm.conflicts.map((x) => `<p class="warn">${esc(x)}</p>`).join('')}${mm.missing.map((x) => `<p class="error">${esc(x)}</p>`).join('')}`, true);
    return html;
  }

  structureTables(st) {
    let h = `<h4>Фреймы (узлы)</h4><table class="grid"><tr><th>#</th><th>имя</th><th>родитель</th><th>позиция</th><th>кость HAnim</th></tr>${st.frames.slice(0, 120).map((f) => `<tr><td>${f.index}</td><td>${esc(f.name)}</td><td>${f.parent}</td><td class="mono small">${vec(f.pos)}</td><td>${f.hanim ? `id ${f.hanim.boneId}${f.hanim.numBones ? `, иерархия ${f.hanim.numBones} костей` : ''}` : '—'}</td></tr>`).join('')}</table>`;
    h += `<h4>Атомики</h4><table class="grid"><tr><th>#</th><th>фрейм</th><th>геометрия</th><th>флаги</th><th>плагины</th></tr>${st.atomics.map((a, i) => `<tr><td>${i}</td><td>${a.frame} ${esc((st.frames[a.frame] || {}).name || '')}</td><td>${a.geometry}</td><td>${a.flags}</td><td class="small">${esc(a.extensions.join(', '))}${a.pipeline ? ` pipeline ${esc(a.pipeline)}` : ''}</td></tr>`).join('')}</table>`;
    h += `<h4>Геометрии</h4><table class="grid"><tr><th>#</th><th>вершин</th><th>треуг.</th><th>UV</th><th>нормали</th><th>prelight</th><th>ночные</th><th>скин</th><th>2dfx</th><th>мат.</th><th>формат</th></tr>${st.geometries.map((g) => `<tr><td>${g.index}</td><td>${g.numVertices}</td><td>${g.numTriangles} (${esc(g.trianglesFrom)})</td><td>${g.numUV}</td><td>${g.normals ? 'да' : 'нет'}</td><td>${g.prelit ? 'да' : 'нет'}</td><td>${g.nightColors ? 'да' : 'нет'}</td><td>${g.skin ? `${g.skin.bones} костей, ${g.skin.maxWeights} весов` : '—'}</td><td>${g.effects2d.length ? g.effects2d.map((e) => esc(e.name)).join(', ') : '—'}</td><td>${g.materials.length}</td><td class="small">${esc(g.format.join(' '))}${g.binMesh ? `; bin mesh: ${g.binMesh.type}, ${g.binMesh.splits} частей` : ''}</td></tr>`).join('')}</table>`;
    const mats = [];
    st.geometries.forEach((g) => g.materials.forEach((m, i) => mats.push(`<tr><td>${g.index}.${i}</td><td>${m.texture ? esc(m.texture.name) : '—'}</td><td>${m.texture && m.texture.mask ? esc(m.texture.mask) : ''}</td><td>rgba(${(m.color || []).join(',')})</td><td class="small">${esc((m.effects || []).join(', '))}${m.matFx !== null && m.matFx !== undefined ? ` matFx ${m.matFx}` : ''}</td></tr>`)));
    h += `<h4>Материалы</h4><table class="grid"><tr><th>геом.мат</th><th>текстура</th><th>маска</th><th>цвет</th><th>эффекты</th></tr>${mats.join('')}</table>`;
    h += `<details><summary>Чанки RenderWare</summary><div class="src">${esc(treeText(st.tree))}</div></details>`;
    return h;
  }

  async renderAdded(ref, a, model) {
    let html = `<div class="pad"><div><b style="font-size:15px">${esc(a.name)}</b> <span class="badge info">добавлен</span> <span class="badge">${esc({ vehicle: 'машина', ped: 'персонаж', import: 'импорт', object: 'объект' }[a.kind])}</span>${a.hidden ? '<span class="badge off">скрыт</span>' : ''}</div>
      <div class="mono small">объект пользователя №${a.uid}${a.ref.id !== undefined ? ` · ID ${a.ref.id}` : ''}</div></div>
      <div class="actions"><button data-act2="focus">Фокус</button><button data-act2="orbit">Орбита</button><button data-act2="geom">Геометрия</button><button data-act2="tex">Текстуры</button>${a.ref.mi >= 0 ? '<button data-act2="col">Коллизия</button>' : ''}<button data-act2="copy-pos">Копировать координаты</button></div>`;
    html += this.editBlock(ref);
    if (a.kind === 'vehicle') html += await this.vehicleBlock(a);
    else if (a.kind === 'ped') html += det('Персонаж', '<p>Модель показана в позе привязки (bind pose) из DFF. Анимации IFP читаются только как список (см. отчёт покрытия): проигрывание на скелете не реализовано.</p>', true);
    const obj = this.app.editor.objects.get(this.app.editor.keyOf(ref));
    if (obj) {
      const parts = obj.group.children.filter((c) => c.userData.part && !c.userData.wheelClone);
      html += det('Компоненты (атомики DFF)', parts.map((c) => `<label class="item"><input type="checkbox" data-comp="${esc(c.userData.part.name)}" ${c.visible ? 'checked' : ''}> <span class="t">${esc(c.userData.part.name || '(без имени)')}</span><span class="s">${c.userData.part.triangles} треуг.</span></label>`).join('') + `<p class="muted small">По умолчанию скрыты части «_dam» (повреждённые) и «_vlo» (LOD машины). Колёса дублируются на все wheel_*_dummy, как в игре.</p>`);
    }
    if (model && model.importInfo) html += det('Импортированная модель', `<pre class="src">${esc(JSON.stringify(model.importInfo, null, 1))}</pre>`, true);
    else if (model && model.resource) html += det('Ресурс DFF', `<p>${resLine(model.resource.resource)}</p><p class="muted">Модель взята из библиотеки без активного определения IDE: дистанции и флаги не заданы.</p>`, true);
    else if (model) html += this.renderModel(model);
    return html;
  }

  async vehicleBlock(a) {
    const cc = await this.app.editor.loadCarcols();
    const entry = cc.cars[(a.name || '').toLowerCase()];
    const sets = entry ? entry.sets : [];
    const cur = (a.options && a.options.colors) || sets[0] || [1, 1];
    const sw = (i) => { const c = cc.colors[i] || [128, 128, 128]; return `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;background:rgb(${c.join(',')})"></span>`; };
    return det('Машина: цвета (carcols.dat)', sets.length ? `<p>Наборы для «${esc(a.name)}» из carcols.dat (строка ${entry.line}):</p>${sets.map((s, i) => `<label class="item"><input type="radio" name="vcol" data-vcol="${i}" ${s.join(',') === cur.join(',') ? 'checked' : ''}> ${s.map((c) => `${sw(c)} ${c}`).join(' ')}</label>`).join('')}<p class="muted small">Цвет заменяется на материалах с маркерами SA: зелёный (60,255,0) — основной, пурпурный (255,0,175) — дополнительный.</p>` : '<p class="warn">В carcols.dat нет записи для этой машины — используются цвета 1/1.</p>', true);
  }

  async onClick(e) {
    const app = this.app, ed = app.editor;
    const t = e.target.closest('[data-act2],[data-iid],[data-res],[data-raw],[data-selone]');
    if (!t) return;
    const ref = this.current && this.current[0];
    if (t.dataset.iid !== undefined) return app.selectBase(Number(t.dataset.iid), true);
    if (t.dataset.res !== undefined) return app.ui.openResource(Number(t.dataset.res));
    if (t.dataset.raw !== undefined) return app.ui.showRaw({ key: t.dataset.raw, line: Number(t.dataset.line) });
    if (t.dataset.selone !== undefined) { const r = this.current.find((x) => ed.keyOf(x) === t.dataset.selone); if (r) return ed.select([r]); }
    const act = t.dataset.act2;
    if (!ref) return;
    if (act === 'focus') app.focusSelection();
    else if (act === 'orbit') { app.focusSelection(); app.setCameraMode('orbit'); }
    else if (act === 'geom') app.openGeometry(ref);
    else if (act === 'tex') app.openTextures(ref);
    else if (act === 'col') app.openCollision(ref);
    else if (act === 'copy-pos') { const tr = ed.transformOf(ref); const ok = await copyText(tr.pos.map((v) => v.toFixed(3)).join(', ')); app.ui.toast(ok ? 'Координаты скопированы' : 'Буфер обмена недоступен', ok ? 'ok' : 'warn'); }
    else if (act === 'copy-src') {
      const d = this.data;
      const text = d.stable ? [`Размещение: ${d.stable} (iid ${d.iid})`, `IPL: ${d.source.key}${d.record ? `, inst №${d.record.index}${d.record.line ? `, строка ${d.record.line}` : ''}${d.record.offset !== null ? `, смещение ${d.record.offset}` : ''}` : ''}`,
        d.model && d.model.definition ? `IDE: ${d.model.definition.file.path}:${d.model.definition.line} — ${d.model.definition.raw}` : '', d.model && d.model.dff && d.model.dff.chosen ? `DFF: ${d.model.dff.chosen.key}` : '', d.model && d.model.txdChain ? `TXD: ${d.model.txdChain.map((c) => c.file + '|' + c.name).join(' → ')}` : '',
        d.model && d.model.collision && d.model.collision.source ? `COL: ${d.model.collision.source.key} (модель №${d.model.collision.modelIndex})` : ''].filter(Boolean).join('\n') : '';
      const ok = await copyText(text); app.ui.toast(ok ? 'Сведения о происхождении скопированы' : 'Буфер обмена недоступен', ok ? 'ok' : 'warn');
    } else if (act === 'raw') {
      const d = this.data;
      if (d.record && d.record.line) app.ui.showRaw({ key: d.source.container.key, rid: d.source.container.rid, line: d.record.line });
      else if (d.record) app.ui.showRaw({ rid: d.source.container.rid, offset: d.record.offset, length: 40, note: 'запись бинарного IPL: позиция (3×float), кватернион (4×float), ID, интерьер, LOD (int32)' });
    } else if (act === 'apply-edit') {
      const bad = [];
      const v = (k) => { const s = this.el.querySelector(`[data-edit=${k}]`).value.trim(); const n = Number(s); if (s === '' || !Number.isFinite(n)) bad.push(k); return n; };
      const pos = [v('px'), v('py'), v('pz')], rot = [v('rx'), v('ry'), v('rz')], scale = [v('sx'), v('sy'), v('sz')];
      if (bad.length) return app.ui.toast(`Не число в полях: ${bad.join(', ')}`, 'error');
      if (scale.some((s) => Math.abs(s) < 1e-4)) return app.ui.toast('Масштаб 0 делает объект невидимым и необратимым — укажите другое значение', 'error');
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot.map((d) => THREE.MathUtils.degToRad(d)), 'ZXY'));
      await ed.applyNumeric(ref, { pos, quat: q.toArray(), scale });
      this.show(this.current);
    } else if (act === 'drop') { await ed.dropToSurface(ref); this.show(this.current); }
    else if (act === 'reset-one') { await ed.resetSelection(); this.show(this.current); }
    else if (act === 'placements-csv') {
      const list = await getJson(`/api/placements/${t.dataset.mi}`);
      download(`размещения-${t.dataset.mi}.csv`, toCsv(list.map((p) => ({ iid: p.iid, stable: p.stable, x: p.pos[0], y: p.pos[1], z: p.pos[2], interior: p.interior, ipl: p.src })), ['iid', 'stable', 'x', 'y', 'z', 'interior', 'ipl']), 'text/csv');
    }
  }

  async onChange(e) {
    const ed = this.app.editor;
    const ref = this.current && this.current[0];
    if (!ref || ref.kind !== 'added') return;
    const a = ed.added.get(ref.uid);
    if (e.target.dataset.vcol !== undefined) {
      const cc = await ed.loadCarcols();
      const sets = (cc.cars[a.name.toLowerCase()] || {}).sets || [];
      await ed.commit('цвет машины', [`a:${a.uid}`], async () => { a.options = { ...(a.options || {}), colors: sets[Number(e.target.dataset.vcol)] }; });
      this.show(this.current);
    } else if (e.target.dataset.comp !== undefined) {
      await ed.commit('компонент', [`a:${a.uid}`], async () => { a.options = { ...(a.options || {}), components: { ...((a.options || {}).components || {}), [e.target.dataset.comp]: e.target.checked } }; });
    }
  }
}

function treeText(tree, depth = 0) {
  if (!tree) return '';
  return tree.map((n) => `${'  '.repeat(depth)}${n.name} (${n.size} б, ${n.version})${n.truncated ? ' ОБРЕЗАН' : ''}\n${n.children ? treeText(n.children, depth + 1) : ''}`).join('');
}

export async function renderTextures(app, body, spec) {
  body.innerHTML = '<p class="muted">Загружаю список текстур…</p>';
  let chain = [], used = new Map();
  if (spec.mi !== undefined && spec.mi >= 0) {
    const mm = await getJson(`/api/inspect/model/${spec.mi}`);
    chain = mm.txdChain;
    for (const t of mm.textures) used.set(t.name.toLowerCase(), t);
  } else if (spec.importId) {
    const sc = app.scene, asset = sc.specAsset(spec, () => -1);
    sc.assets.retain(asset);
    try {
      await sc.assets.whenReady(asset);
      if (asset.state === 'error') throw new Error(asset.error);
      chain = asset.header.chain;
      for (const t of Object.values(asset.header.textures)) used.set(t.name.toLowerCase(), { name: t.name, txd: t.txd, rid: t.rid, width: t.w, height: t.h, encoding: t.e, alpha: !!t.a, levels: t.levels });
      for (const n of asset.header.missingTextures) used.set(n.toLowerCase(), { name: n, missing: true });
    } finally { sc.assets.release(asset); }
  } else if (spec.txdRid >= 0) chain = [{ rid: spec.txdRid, name: spec.txdName, reason: 'TXD ресурса' }];
  let html = `<p>Цепочка: ${chain.map((c) => `<b>${esc(c.name)}</b> <span class="muted">(${esc(c.reason)})</span>`).join(' → ') || 'нет TXD'}</p>`;
  if (used.size) {
    html += '<h3>Используются моделью</h3><div class="tex-grid">';
    for (const t of used.values()) html += texCard(t, t.missing ? null : t.rid);
    html += '</div>';
  }
  for (const c of chain) {
    const info = await getJson(`/api/txd/${c.rid}`);
    if (!info.txd || info.txd.error) { html += `<p class="error">${esc(c.name)}: ${esc(info.txd ? info.txd.error : 'не прочитан')}</p>`; continue; }
    html += `<details ${used.size ? '' : 'open'}><summary>Весь словарь ${esc(c.name)} — ${info.txd.textures.length} текстур, RW ${esc(info.txd.rw.text)}</summary><div class="tex-grid">${info.txd.textures.map((t) => texCard({ name: t.name, txd: c.name, width: t.width, height: t.height, encoding: t.encoding, d3dFormat: t.d3dFormat, rasterFormat: t.rasterFormat, levels: t.levels, alpha: t.alpha, mask: t.mask, error: t.error, supported: t.supported, bytes: t.bytes }, c.rid)).join('')}</div></details>`;
  }
  body.innerHTML = html;
  body.onchange = (e) => {
    const s = e.target.closest('[data-mipsel]');
    if (!s) return;
    const img = s.closest('.tex-card').querySelector('img');
    img.src = `/api/texpng/${s.dataset.rid}/${encodeURIComponent(s.dataset.name)}?mip=${s.value}`;
  };
}

function texCard(t, rid) {
  if (!rid && rid !== 0) return `<div class="tex-card"><b>${esc(t.name)}</b><p class="error">не найдена ни в одном TXD цепочки</p></div>`;
  const mips = Array.from({ length: t.levels || 1 }, (_, i) => `<option value="${i}">мип ${i}: ${Math.max(1, t.width >> i)}×${Math.max(1, t.height >> i)}</option>`).join('');
  return `<div class="tex-card"><div class="img">${t.supported === false ? `<span class="error small">${esc(t.error)}</span>` : `<img loading="lazy" src="/api/texpng/${rid}/${encodeURIComponent(t.name)}" alt="${esc(t.name)}">`}</div>
    <div><b>${esc(t.name)}</b> <span class="muted small">${esc(t.txd || '')}</span></div>
    <div class="small">${t.width}×${t.height}, ${esc(t.encoding)} ${esc(t.d3dFormat || t.rasterFormat || '')}, мипов ${t.levels}, альфа ${t.alpha ? 'да' : 'нет'}${t.mask ? `, маска ${esc(t.mask)}` : ''}${t.bytes ? `, ${Math.round(t.bytes / 1024)} КБ` : ''}</div>
    ${t.levels > 1 ? `<select data-mipsel data-rid="${rid}" data-name="${esc(t.name)}">${mips}</select>` : ''}</div>`;
}

export async function renderCollision(app, body, url) {
  body.innerHTML = '<p class="muted">Загружаю коллизию…</p>';
  const [r, surfaces] = await Promise.all([getJson(url), getJson('/api/surfaces').catch(() => [])]);
  if (!r.model) { body.innerHTML = `<p class="warn">${esc(r.reason || 'коллизии нет')}</p>`; return; }
  const c = r.model;
  const surf = (s) => `${s.material} ${esc(surfaces[s.material] || '?')}`;
  const byMat = new Map();
  for (const f of c.faces) byMat.set(f[3], (byMat.get(f[3]) || 0) + 1);
  body.innerHTML = `${kv([
    ['Источник', r.source === 'embedded' ? 'встроена в DFF (Collision Model plugin)' : `COL-файл${r.file ? ` ${esc(r.file)}` : ''}, модель №${r.index}`],
    ['Версия', c.version === 1 ? 'COLL (v1)' : `COL${c.version}`], ['Имя / ID в COL', `${esc(c.name)} / ${c.id}`],
    ['Границы', `min ${vec(c.bounds.min)}, max ${vec(c.bounds.max)}, центр ${vec(c.bounds.center)}, радиус ${r3(c.bounds.radius)}`],
    ['Флаги', `${c.flags}${c.flags & 8 ? ' (есть группы граней)' : ''}${c.flags & 16 ? ' (есть теневая сетка)' : ''}`],
    ['Примитивы', `сфер ${c.spheres.length}, боксов ${c.boxes.length}, вершин ${c.vertices.length}, граней ${c.faces.length}, групп граней ${c.faceGroups.length}, линий ${c.lines}, теневых граней ${c.shadowFaces.length}`],
    ['Поверхности граней', [...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${esc(surfaces[m] || '?')}: ${n}`).join('<br>') || '—'],
    c.warnings.length ? ['Предупреждения', c.warnings.map(esc).join('<br>')] : null,
  ])}
  ${c.spheres.length ? `<h4>Сферы</h4><table class="grid"><tr><th>#</th><th>центр</th><th>радиус</th><th>поверхность</th></tr>${c.spheres.map((s, i) => `<tr><td>${i}</td><td>${vec(s.center)}</td><td>${r3(s.radius)}</td><td>${surf(s.surface)}</td></tr>`).join('')}</table>` : ''}
  ${c.boxes.length ? `<h4>Боксы</h4><table class="grid"><tr><th>#</th><th>min</th><th>max</th><th>поверхность</th></tr>${c.boxes.map((s, i) => `<tr><td>${i}</td><td>${vec(s.min)}</td><td>${vec(s.max)}</td><td>${surf(s.surface)}</td></tr>`).join('')}</table>` : ''}
  ${c.faceGroups.length ? `<h4>Группы граней</h4><table class="grid"><tr><th>#</th><th>min</th><th>max</th><th>грани</th></tr>${c.faceGroups.map((g, i) => `<tr><td>${i}</td><td>${vec(g.min)}</td><td>${vec(g.max)}</td><td>${g.start}–${g.end}</td></tr>`).join('')}</table>` : ''}
  ${c.faces.length ? `<details><summary>Грани (первые 500 из ${c.faces.length})</summary><table class="grid"><tr><th>#</th><th>вершины</th><th>поверхность</th><th>свет</th></tr>${c.faces.slice(0, 500).map((f, i) => `<tr><td>${i}</td><td>${f[0]}, ${f[1]}, ${f[2]}</td><td>${f[3]} ${esc(surfaces[f[3]] || '')}</td><td>${f[4]}</td></tr>`).join('')}</table></details>` : ''}`;
}
