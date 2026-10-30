import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { APP_ROOT, APP_STATIC, PORT, PROJECTS, IMPORTS, CACHE, GAME_IMPORT, DECRYPTED, DECRYPTED_CANDIDATES, DOCS } from './lib/config.js';
import { buildIndex, progress } from './lib/indexer.js';
import { Catalog } from './lib/catalog.js';
import { buildDefaultProfile, readProfile, saveProfile, loadProfiles, currentProfileId, setCurrentProfileId, upgradeProfile, profilePath, PROFILE_FORMAT } from './lib/profile.js';
import { World, CELL } from './lib/world.js';
import { packModel, textureChain } from './lib/geompack.js';
import { readResource, txdOf, rawCache, txdCache, Lru, readFileBytes } from './lib/resources.js';
import { ifpFirstKeys } from './lib/gamedata.js';
import { textureData, decodeToRgba, parseTxd } from './lib/txd.js';
import { encodePng } from './lib/png.js';
import { withMipChain } from './lib/dxtgen.js';
import { inspectInstance, inspectModel, inspectResource, colModelData } from './lib/inspect.js';
import { buildLibrary, search } from './lib/library.js';
import { coverage } from './lib/coverage.js';
import { parseNodes } from './lib/nodes.js';
import { parseDff } from './lib/dff.js';
import { listColModels, parseColModel } from './lib/col.js';
import { decodeText } from './lib/text.js';

const state = { cat: null, world: null, profile: null, library: null, ready: false, error: null, startedAt: Date.now(), registry: null };
const geomCache = new Lru(256 * 1024 * 1024);
const mipCache = new Lru(256 * 1024 * 1024);
const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);

function loadRegistry() {
  try { state.registry = JSON.parse(fs.readFileSync(path.join(GAME_IMPORT, 'registry.json'), 'utf8')); } catch { state.registry = null; }
}

function rebuildWorld() {
  const t0 = Date.now();
  state.world = new World(state.cat, state.profile);
  state.library = null;
  geomCache.map.clear(); geomCache.bytes = 0;
  log(`мир: ${state.world.count} размещений, ${state.world.models.length} моделей, ${state.world.cells.size} ячеек (${Date.now() - t0} мс)`);
}

async function boot() {
  loadRegistry();
  if (!fs.existsSync(DECRYPTED)) {
    state.error = `не найдена папка decrypted с файлами игры. Положите её рядом с папкой программы или внутрь неё. Искал здесь: ${DECRYPTED_CANDIDATES.join('; ')}`;
    log(state.error);
    return;
  }
  if (!state.registry) log('внимание: нет resources/game-import/registry.json — выполните «node server/tools/import-game.mjs», манифесты игры недоступны');
  const records = await buildIndex({ log });
  state.cat = new Catalog(records);
  const id = currentProfileId();
  let p = id ? readProfile(id) : null;
  if (p && (p.format || 0) < PROFILE_FORMAT) { upgradeProfile(p); saveProfile(p); log(`профиль ${p.id} обновлён до формата ${PROFILE_FORMAT}`); }
  else if (p) upgradeProfile(p);
  if (!p || !Array.isArray(p.img) || !Array.isArray(p.ide) || !Array.isArray(p.ipl)) {
    p = buildDefaultProfile(state.cat);
    saveProfile(p);
    setCurrentProfileId(p.id);
    log('создан предварительный профиль по манифестам:', p.name);
  }
  state.profile = p;
  rebuildWorld();
  pruneThumbs();
  state.ready = true;
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function sendJson(req, res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  if (body.length > 2048 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    return send(res, code, zlib.gzipSync(body, { level: 4 }), 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip' });
  }
  send(res, code, body);
}
function sendBin(req, res, buf, type = 'application/octet-stream', cache = true) {
  const headers = { 'Content-Type': type, 'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-store' };
  if (buf.length > 4096 && type === 'application/octet-stream' && /gzip/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    buf = zlib.gzipSync(buf, { level: 1 });
  }
  res.writeHead(200, headers);
  res.end(buf);
}
function fail(req, res, code, message, details) { sendJson(req, res, { error: message, details }, code); }
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('слишком большой запрос'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJson(req, kind = 'any') {
  const body = await readBody(req);
  let v;
  try { v = JSON.parse(body.toString('utf8')); } catch (e) { throw Object.assign(new Error(`тело запроса не JSON: ${e.message}`), { status: 400 }); }
  if (kind === 'array' && !Array.isArray(v)) throw Object.assign(new Error('ожидался массив JSON'), { status: 400 });
  if (kind === 'object' && (!v || typeof v !== 'object' || Array.isArray(v))) throw Object.assign(new Error('ожидался объект JSON'), { status: 400 });
  return v;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const badPart = (s) => s === '..' || /[. ]$/.test(s) || s.includes(':') || s.includes('\0');
function serveStatic(req, res, root, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return fail(req, res, 400, 'неверный путь'); }
  if (decoded.split(/[\\/]+/).filter(Boolean).some(badPart)) return fail(req, res, 403, 'запрещено');
  const p = path.normalize(path.join(root, decoded));
  if (p !== root && !p.startsWith(root + path.sep)) return fail(req, res, 403, 'запрещено');
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) return fail(req, res, 404, `нет файла ${rel}`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  });
}
const safeName = (s) => String(s).replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 120);
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const routes = [];
const route = (method, pattern, fn, needReady = true) => routes.push({ method, pattern, fn, needReady });

route('GET', /^\/api\/status$/, (req, res) => sendJson(req, res, {
  app: APP_ID, ready: state.ready, error: state.error, index: progress, catalog: state.cat ? state.cat.stats() : null, world: state.world ? state.world.summary() : null,
  caches: { raw: rawCache.stats(), txd: txdCache.stats(), geometry: geomCache.stats() }, memory: process.memoryUsage(), gameImport: !!state.registry,
}), false);

route('GET', /^\/api\/profile$/, (req, res) => sendJson(req, res, { profile: state.profile, world: state.world.summary(), profiles: loadProfiles() }));
route('PUT', /^\/api\/profile$/, async (req, res) => {
  const p = await readJson(req, 'object');
  if (!p || !Array.isArray(p.img) || !Array.isArray(p.ide) || !Array.isArray(p.ipl)) return fail(req, res, 400, 'неверный профиль: нужны списки img, ide, ipl');
  upgradeProfile(p);
  if (!p.id) p.id = 'user-' + Date.now().toString(36);
  state.profile = p;
  saveProfile(p);
  setCurrentProfileId(p.id);
  rebuildWorld();
  sendJson(req, res, { ok: true, world: state.world.summary() });
});
route('POST', /^\/api\/profile\/reset$/, (req, res) => {
  const p = buildDefaultProfile(state.cat);
  state.profile = p; saveProfile(p); setCurrentProfileId(p.id); rebuildWorld();
  sendJson(req, res, { ok: true, world: state.world.summary() });
});
route('DELETE', /^\/api\/profile\/([^/]+)$/, (req, res, m) => {
  const id = decodeURIComponent(m[1]);
  if (id === state.profile.id) return fail(req, res, 409, 'это активный профиль — сначала выберите другой');
  const file = profilePath(id);
  if (!fs.existsSync(file)) return fail(req, res, 404, 'профиль не найден');
  fs.unlinkSync(file);
  sendJson(req, res, { ok: true, profiles: loadProfiles() });
});
route('POST', /^\/api\/profile\/select\/([^/]+)$/, (req, res, m) => {
  const p = upgradeProfile(readProfile(decodeURIComponent(m[1])));
  if (!p || !Array.isArray(p.img) || !Array.isArray(p.ide) || !Array.isArray(p.ipl)) return fail(req, res, 404, 'профиль не найден или повреждён');
  state.profile = p; setCurrentProfileId(p.id); rebuildWorld();
  sendJson(req, res, { ok: true, world: state.world.summary() });
});

route('GET', /^\/api\/models$/, (req, res) => {
  const w = state.world;
  sendJson(req, res, { generation: w.generation, models: w.models.map((m) => [m.id, m.name, m.txd, m.section, m.dd, m.flags, m.dff, m.txdRid, m.bs || null, m.clump ? 1 : 0, m.col ? 1 : m.embeddedCol ? 2 : 0]) });
});
route('GET', /^\/api\/world\/meta$/, (req, res) => {
  const w = state.world;
  const cells = {};
  for (const [k, v] of w.cells) cells[k] = v.length;
  sendJson(req, res, { ...w.summary(), cellSize: CELL, cellCounts: cells, sourcesList: w.sources.map((s) => ({ si: s.si, key: s.key, name: s.name, kind: s.kind, stream: s.stream, base: s.base, count: s.count })), scales: [...w.scales.entries()], rules: w.profile.rules });
});
route('GET', /^\/api\/world\/far$/, (req, res) => sendBin(req, res, state.world.encode(state.world.far), 'application/octet-stream', false));
route('GET', /^\/api\/world\/cells$/, (req, res, m, url) => {
  const keys = (url.searchParams.get('c') || '').split(';').filter(Boolean).slice(0, 200);
  const ids = [];
  const counts = [];
  for (const k of keys) { const list = state.world.cells.get(k) || []; counts.push(k, list.length); ids.push(...list); }
  const body = state.world.encode(ids);
  const head = Buffer.from(JSON.stringify(counts));
  const h = Buffer.alloc(4); h.writeUInt32LE(head.length);
  sendBin(req, res, Buffer.concat([h, head, Buffer.alloc((4 - (head.length % 4)) % 4), body]), 'application/octet-stream', false);
});
route('GET', /^\/api\/world\/instances$/, (req, res, m, url) => {
  const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter((x) => x >= 0 && x < state.world.count).slice(0, 5000);
  sendBin(req, res, state.world.encode(ids), 'application/octet-stream', false);
});

function modelChain(mi, url) {
  const w = state.world;
  if (mi >= 0) { const m = w.models[mi]; return textureChain(w, state.cat, { txdRid: m.txdRid, txdName: m.txd, vehicle: m.vehicleTex }); }
  const txd = url.searchParams.get('txd');
  if (txd) return textureChain(w, state.cat, { txdRid: /^\d+$/.test(txd) ? Number(txd) : -1, txdName: /^\d+$/.test(txd) ? null : txd, vehicle: url.searchParams.get('vehicle') === '1' });
  return [];
}
let pedPoseCache;
function pedPose() {
  if (pedPoseCache !== undefined) return pedPoseCache;
  pedPoseCache = null;
  const r = state.cat.resolvePath('ANIM\\PED.IFP');
  if (r.file) {
    try {
      const keys = ifpFirstKeys(readFileBytes(state.cat, r.file.fid), 'idle_stance');
      if (keys) pedPoseCache = { keys, label: `IDLE_stance, ${r.file.key}` };
    } catch (e) { log('ped.ifp не прочитан:', e.message); }
  }
  return pedPoseCache;
}
const wantsPedPose = (mi, url) => (mi >= 0 && state.world.models[mi] && state.world.models[mi].section === 'peds') || url.searchParams.get('pose') === 'ped';

route('GET', /^\/api\/geom\/(\d+)$/, (req, res, m, url) => {
  const rid = Number(m[1]);
  const mi = url.searchParams.has('mi') ? Number(url.searchParams.get('mi')) : -1;
  const ped = wantsPedPose(mi, url);
  const key = `${rid}|${mi}|${url.searchParams.get('txd') || ''}|${url.searchParams.get('vehicle') || ''}|${ped ? 'ped' : ''}`;
  let buf = geomCache.get(key);
  if (!buf) {
    const r = state.cat.res[rid];
    if (!r || r.kind !== 'dff') return fail(req, res, 404, 'это не DFF-ресурс');
    try { buf = packModel(state.cat, state.world, rid, modelChain(mi, url), ped ? pedPose() : null); } catch (e) { return fail(req, res, 422, `DFF не прочитан: ${e.message}`, { rid, key: r.key }); }
    geomCache.set(key, buf, buf.length);
  }
  sendBin(req, res, buf);
});
function findTexture(rid, name) {
  const t = txdOf(state.cat, rid);
  if (t.error) throw new Error(t.error);
  const tex = t.byName.get(name.toLowerCase());
  if (!tex) throw new Error(`текстуры «${name}» нет в ${state.cat.res[rid].name}`);
  return tex;
}
route('GET', /^\/api\/tex\/(\d+)\/(.+)$/, (req, res, m, url) => {
  const rid = Number(m[1]), name = decodeURIComponent(m[2]);
  try {
    const tex = findTexture(rid, name);
    let td = textureData(readResource(state.cat, rid), tex);
    if (url.searchParams.get('mips') === '1' && td.mips.length === 1) {
      const key = `${rid}/${name.toLowerCase()}`;
      let gen = mipCache.get(key);
      if (!gen) { gen = withMipChain(td); mipCache.set(key, gen, gen.mips.reduce((s, x) => s + x.data.length, 0)); }
      td = gen;
    }
    if (url.searchParams.get('rgba') === '1' && td.encoding !== 'rgba8') {
      td = { ...td, mips: td.mips.map((x) => { const d = decodeToRgba({ encoding: td.encoding, mips: [x] }); return { width: d.width, height: d.height, data: d.data }; }), encoding: 'rgba8' };
    }
    let off = 0;
    const mips = td.mips.map((x) => { const r = { w: x.width, h: x.height, off, len: x.data.length }; off += x.data.length; return r; });
    const hj = Buffer.from(JSON.stringify({ name: tex.name, encoding: td.encoding, width: td.width, height: td.height, alpha: td.alpha, mips, fileLevels: tex.levels, generatedMips: td.generatedMips || 0 }));
    const h = Buffer.alloc(8); h.write('RMT1', 0, 'latin1'); h.writeUInt32LE(hj.length, 4);
    sendBin(req, res, Buffer.concat([h, hj, Buffer.alloc((4 - ((8 + hj.length) % 4)) % 4), ...td.mips.map((x) => x.data)]));
  } catch (e) { fail(req, res, 404, e.message); }
});
route('GET', /^\/api\/texpng\/(\d+)\/(.+)$/, (req, res, m, url) => {
  const rid = Number(m[1]), name = decodeURIComponent(m[2]);
  try {
    const tex = findTexture(rid, name);
    const td = textureData(readResource(state.cat, rid), tex);
    const level = Math.min(Number(url.searchParams.get('mip') || 0), td.mips.length - 1);
    const one = { ...td, mips: [td.mips[level]] };
    const rgba = decodeToRgba(one);
    if (url.searchParams.get('opaque') === '1') for (let i = 3; i < rgba.data.length; i += 4) rgba.data[i] = 255;
    sendBin(req, res, encodePng(rgba.width, rgba.height, rgba.data), 'image/png');
  } catch (e) { fail(req, res, 404, e.message); }
});
route('GET', /^\/api\/txd\/(\d+)$/, (req, res, m) => sendJson(req, res, inspectResource(state.cat, state.world, Number(m[1]))));
route('GET', /^\/api\/col\/(\d+)\/(\d+)$/, (req, res, m) => {
  try { sendJson(req, res, colModelData(state.cat, Number(m[1]), Number(m[2]))); } catch (e) { fail(req, res, 404, e.message); }
});
route('GET', /^\/api\/colfor\/(\d+)$/, (req, res, m) => {
  const mm = state.world.models[Number(m[1])];
  if (!mm) return fail(req, res, 404, 'модель не найдена');
  try {
    if (mm.col) return sendJson(req, res, { source: 'col', rid: mm.col.rid, index: mm.col.i, model: colModelData(state.cat, mm.col.rid, mm.col.i) });
    if (mm.embeddedCol) return sendJson(req, res, { source: 'embedded', rid: mm.dff, model: colModelData(state.cat, mm.dff, 0) });
    sendJson(req, res, { source: 'none', reason: 'нет COL-модели с этим именем в активных IMG и нет встроенной коллизии' });
  } catch (e) { fail(req, res, 422, e.message); }
});
route('POST', /^\/api\/colbatch$/, async (req, res) => {
  const list = (await readJson(req, 'array')).filter(Number.isInteger).slice(0, 400);
  const out = {};
  for (const mi of list) {
    const mm = state.world.models[mi];
    if (!mm) continue;
    try {
      if (mm.col) out[mi] = colModelData(state.cat, mm.col.rid, mm.col.i);
      else if (mm.embeddedCol) out[mi] = colModelData(state.cat, mm.dff, 0);
      else out[mi] = null;
    } catch (e) { out[mi] = { error: e.message }; }
  }
  sendJson(req, res, out);
});

route('GET', /^\/api\/inspect\/instance\/(\d+)$/, (req, res, m) => sendJson(req, res, inspectInstance(state.cat, state.world, Number(m[1]))));
route('GET', /^\/api\/inspect\/model\/(\d+)$/, (req, res, m) => sendJson(req, res, inspectModel(state.cat, state.world, Number(m[1]))));
route('GET', /^\/api\/inspect\/resource\/(\d+)$/, (req, res, m) => sendJson(req, res, inspectResource(state.cat, state.world, Number(m[1]))));
route('GET', /^\/api\/stable$/, (req, res, m, url) => {
  const w = state.world;
  const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter((x) => x >= 0 && x < w.count).slice(0, 5000);
  sendJson(req, res, Object.fromEntries(ids.map((i) => [i, w.stableId(i)])));
});
route('POST', /^\/api\/resolve$/, async (req, res) => {
  const list = (await readJson(req, 'array')).filter((s) => typeof s === 'string').slice(0, 20000);
  sendJson(req, res, Object.fromEntries(list.map((s) => [s, state.world.findStable(s)])));
});
route('POST', /^\/api\/reskeys$/, async (req, res) => {
  const list = (await readJson(req, 'array')).filter((s) => typeof s === 'string').slice(0, 20000);
  sendJson(req, res, Object.fromEntries(list.map((k) => [k, state.cat.resByKey.has(k) ? state.cat.resByKey.get(k) : -1])));
});
route('GET', /^\/api\/placements\/(\d+)$/, (req, res, m) => {
  const w = state.world, list = w.byModel.get(Number(m[1])) || [];
  sendJson(req, res, list.map((i) => ({ iid: i, stable: w.stableId(i), pos: [...w.inst.pos.subarray(i * 3, i * 3 + 3)], interior: w.inst.interior[i], src: w.sources[w.inst.src[i]].key })));
});
route('GET', /^\/api\/search$/, (req, res, m, url) => sendJson(req, res, search(state.cat, state.world, url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 40))));
route('GET', /^\/api\/library$/, (req, res) => {
  if (!state.library) state.library = buildLibrary(state.cat, state.world);
  let have = new Set();
  try { have = new Set(fs.readdirSync(THUMBS)); } catch {}
  const thumbs = have.size ? state.library.items.filter((it) => have.has(thumbFile(state.cat.res[it.r]))).map((it) => it.r) : [];
  sendJson(req, res, { ...state.library, thumbs });
});
route('GET', /^\/api\/files$/, (req, res) => {
  const p = state.profile;
  const status = new Map();
  for (const kind of ['img', 'ide', 'ipl']) for (const it of p[kind]) if (it.file && !it.repeat) status.set(it.file, { active: it.active, reason: it.reason, manifest: it.manifest, line: it.line });
  sendJson(req, res, state.cat.files.filter((f) => f.root !== 'import').map((f) => ({ key: f.key, root: f.root, path: f.rel, kind: f.kind, size: f.size, entries: f.entries, defs: f.defs, diagnostics: f.diagnostics, error: f.error, reason: f.reason, profile: status.get(f.key) || null })));
});
route('GET', /^\/api\/file$/, (req, res, m, url) => {
  const f = state.cat.byKey.get(url.searchParams.get('key') || '');
  if (!f) return fail(req, res, 404, 'файл не найден');
  const out = { ...f };
  if (f.kind === 'img') out.entryList = state.cat.res.filter((r) => r.fid === f.fid).map((r) => ({ rid: r.rid, name: r.name, kind: r.kind, offset: r.offset, sectors: r.sectors, error: r.err, mismatch: r.mismatch }));
  const ipl = state.cat.ipls.filter((s) => s.fid === f.fid && s.entry < 0);
  if (ipl.length) out.ipl = ipl.map((s) => ({ kind: s.kind, inst: s.rec.inst.length, service: Object.fromEntries(Object.entries(s.rec.service || {}).map(([k, v]) => [k, v.length])), unsupported: s.rec.unsupported, diagnostics: s.rec.diagnostics, header: s.rec.header }));
  if (f.kind === 'ide') out.defList = state.cat.defs.filter((d) => d.fid === f.fid).slice(0, 3000).map((d) => ({ did: d.did, id: d.id, model: d.model, txd: d.txd, section: d.section, line: d.line, chosen: state.world.chosenDef.get(d.id) === d.did }));
  out.diagnosticsList = state.cat.diagnostics.filter((d) => d.fid === f.fid).slice(0, 500);
  sendJson(req, res, out);
});
route('GET', /^\/api\/raw$/, (req, res, m, url) => {
  const f = state.cat.byKey.get(url.searchParams.get('key') || '');
  const rid = url.searchParams.has('rid') ? Number(url.searchParams.get('rid')) : -1;
  try {
    const buf = rid >= 0 ? readResource(state.cat, rid) : f ? readFileBytes(state.cat, f.fid) : null;
    if (!buf) return fail(req, res, 404, 'источник не найден');
    if (url.searchParams.has('offset')) {
      const off = Number(url.searchParams.get('offset')), len = Math.min(Number(url.searchParams.get('length') || 64), 4096);
      return sendJson(req, res, { offset: off, length: len, hex: buf.subarray(off, off + len).toString('hex') });
    }
    const lines = decodeText(buf).split(/\r?\n/);
    const line = Number(url.searchParams.get('line') || 1), ctx = Math.min(Number(url.searchParams.get('context') || 12), 400);
    const from = Math.max(1, line - ctx), to = Math.min(lines.length, line + ctx);
    sendJson(req, res, { line, from, to, total: lines.length, lines: lines.slice(from - 1, to) });
  } catch (e) { fail(req, res, 422, e.message); }
});
route('GET', /^\/api\/diagnostics$/, (req, res) => sendJson(req, res, {
  catalog: state.cat.diagnostics.map((d) => ({ ...d, file: d.file || (state.cat.files[d.fid] || {}).key })),
  world: state.world.diagnostics, conflicts: { ids: state.world.conflicts.ids, names: [...new Set(state.world.conflicts.names)], duplicates: state.world.conflicts.duplicates },
}));
route('GET', /^\/api\/conflicts$/, (req, res) => {
  const w = state.world, cat = state.cat;
  sendJson(req, res, {
    ids: w.conflicts.ids.map((id) => ({ id, chosen: cat.defs[w.chosenDef.get(id)].key, options: w.defsActiveById.get(id).map((did) => ({ key: cat.defs[did].key, file: cat.files[cat.defs[did].fid].rel, line: cat.defs[did].line, raw: cat.defs[did].raw })) })),
    names: [...new Set(w.conflicts.names)].map((n) => { const r = w.resolveName(n); return { name: n, chosen: r.rid >= 0 ? cat.res[r.rid].key : null, reason: r.reason, options: r.activeCandidates.map((rid) => cat.res[rid].key) }; }),
  });
});
route('GET', /^\/api\/coverage$/, (req, res) => sendJson(req, res, coverage(state.cat, state.world, state.registry)));
route('GET', /^\/api\/registry$/, (req, res) => sendJson(req, res, state.registry || { files: [], missing: [], note: 'реестр не создан' }));

const nodesCache = { data: null };
route('GET', /^\/api\/layer\/(\w+)$/, (req, res, m) => {
  const type = m[1], w = state.world;
  if (type === 'paths') {
    if (!nodesCache.data) {
      const out = { areas: [], errors: [] };
      for (const r of state.cat.res) {
        if (r.kind !== 'nodes' || !w.imgOrder.has(r.fid)) continue;
        const n = parseNodes(readResource(state.cat, r.rid));
        if (n.error) { out.errors.push({ name: r.name, error: n.error }); continue; }
        out.areas.push({ name: r.name, counts: n.counts, nodes: n.nodes.map((x) => [x.x, x.y, x.z, x.type === 'veh' ? 0 : 1, x.link, x.links, x.area, x.id]), links: n.links });
      }
      nodesCache.data = out;
    }
    return sendJson(req, res, nodesCache.data);
  }
  if (type === 'water') return sendJson(req, res, state.cat.special.water ? { quads: state.cat.special.water.quads, source: state.cat.files[state.cat.special.water.fid].key } : { quads: [], error: 'water.dat не импортирован' });
  sendJson(req, res, w.service[type] || []);
});
route('GET', /^\/api\/carcols$/, (req, res) => sendJson(req, res, state.cat.special.carcols || { colors: [], cars: {} }));
route('GET', /^\/api\/surfaces$/, (req, res) => sendJson(req, res, state.cat.special.surfinfo ? state.cat.special.surfinfo.names : []));

route('GET', /^\/api\/projects$/, (req, res) => {
  fs.mkdirSync(PROJECTS, { recursive: true });
  sendJson(req, res, fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.json')).map((f) => { const st = fs.statSync(path.join(PROJECTS, f)); return { name: f.slice(0, -5), size: st.size, modified: st.mtime }; }));
}, false);
route('GET', /^\/api\/projects\/(.+)$/, (req, res, m) => {
  const f = path.join(PROJECTS, safeName(decodeURIComponent(m[1])) + '.json');
  if (!fs.existsSync(f)) return fail(req, res, 404, 'проект не найден');
  send(res, 200, fs.readFileSync(f));
}, false);
route('PUT', /^\/api\/projects\/(.+)$/, async (req, res, m) => {
  const body = await readBody(req);
  let p;
  try { p = JSON.parse(body.toString('utf8')); } catch (e) { return fail(req, res, 400, `не JSON: ${e.message}`); }
  if (!p || p.format !== 'radmir-map-project') return fail(req, res, 400, 'не проект: нужно поле format = "radmir-map-project"');
  const name = safeName(decodeURIComponent(m[1])).trim() || 'проект';
  fs.mkdirSync(PROJECTS, { recursive: true });
  writeFileAtomic(path.join(PROJECTS, name + '.json'), JSON.stringify(p, null, 1));
  sendJson(req, res, { ok: true, name, file: `projects/${name}.json` });
}, false);
route('DELETE', /^\/api\/projects\/(.+)$/, (req, res, m) => {
  const f = path.join(PROJECTS, safeName(decodeURIComponent(m[1])) + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
  sendJson(req, res, { ok: true });
}, false);
route('POST', /^\/api\/fingerprints$/, async (req, res) => {
  const keys = (await readJson(req, 'array')).filter((k) => typeof k === 'string');
  const out = {};
  for (const k of keys) {
    const rid = state.cat.resByKey.get(k);
    const f = state.cat.byKey.get(k);
    if (rid !== undefined) { const r = state.cat.res[rid]; const c = state.cat.files[r.fid]; out[k] = { exists: true, size: r.bytes, container: c.key, containerSize: c.size, containerMtime: c.mtime }; }
    else if (f) out[k] = { exists: true, size: f.size, mtime: f.mtime };
    else out[k] = { exists: false };
  }
  sendJson(req, res, out);
});

const IMPORT_ID = /^[\p{L}\p{N}_-]{1,80}$/u;
const IMPORT_FILE = /^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]{0,99}\.(dff|txd|col)$/iu;
const importState = new Map();
function importDir(id) {
  if (!IMPORT_ID.test(id)) throw Object.assign(new Error(`недопустимый идентификатор импорта «${id}»`), { status: 400 });
  return path.join(IMPORTS, id);
}
function checkImport(id) {
  const dir = importDir(id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort((a, b) => a.localeCompare(b)) : [];
  const out = { id, files: [], dff: null, txd: [], col: [], problems: [], ok: false };
  for (const name of files) {
    const buf = fs.readFileSync(path.join(dir, name));
    const lower = name.toLowerCase();
    if (lower.endsWith('.dff')) {
      const d = parseDff(buf, { data: false });
      if (d.error) out.problems.push(`${name}: не DFF — ${d.error}`);
      else if (out.dff) out.problems.push(`${name}: второй DFF в импорте не используется — модель берётся из ${out.dff.name}`);
      else {
        const tex = new Set();
        for (const g of d.geometries) for (const m of g.materials) if (m.texture && m.texture.name) tex.add(m.texture.name);
        out.dff = { name, rw: d.rw, atomics: d.atomics.length, geometries: d.geometries.length, frames: d.frames.length, textures: [...tex], embeddedCollision: !!d.collision, native: d.geometries.some((g) => g.native) };
        if (out.dff.native) out.problems.push(`${name}: нативная (не PC) геометрия не поддерживается`);
      }
    } else if (lower.endsWith('.txd')) {
      const t = parseTxd(buf);
      if (t.error) out.problems.push(`${name}: не TXD — ${t.error}`);
      else out.txd.push({ name, textures: t.textures.map((x) => ({ name: x.name, w: x.width, h: x.height, e: x.encoding, supported: x.supported, error: x.error })) });
    } else if (lower.endsWith('.col')) {
      const c = listColModels(buf);
      if (!c.models.length) out.problems.push(`${name}: в COL нет моделей`);
      out.col.push({ name, models: c.models.map((x) => ({ name: x.name, version: x.version, counts: x.counts })), diagnostics: c.diagnostics });
    } else out.problems.push(`${name}: неизвестный тип файла (нужны .dff, .txd, .col)`);
    out.files.push({ name, size: buf.length });
  }
  if (!out.dff) out.problems.push('нет DFF-модели');
  else {
    const have = new Set(out.txd.flatMap((t) => t.textures.map((x) => x.name.toLowerCase())));
    out.missingTextures = out.dff.textures.filter((t) => !have.has(t.toLowerCase()));
    const shared = new Set();
    for (const c of textureChain(state.world, state.cat, { vehicle: true })) { try { for (const n of txdOf(state.cat, c.rid).byName.keys()) shared.add(n); } catch {} }
    const forCars = out.missingTextures.filter((t) => shared.has(t.toLowerCase()));
    const absent = out.missingTextures.filter((t) => !shared.has(t.toLowerCase()));
    if (forCars.length) out.problems.push(`текстуры ${forCars.join(', ')} есть только в общих текстурах машин — найдутся, если разместить как машину`);
    if (absent.length) out.problems.push(`нет текстур: ${absent.join(', ')} (будут показаны без текстуры; добавьте TXD)`);
    const base = out.dff.name.replace(/\.dff$/i, '').toLowerCase();
    out.colMatch = out.col.some((c) => c.models.some((x) => x.name.toLowerCase() === base));
    if (out.col.length && !out.colMatch) out.problems.push(`в COL нет модели с именем «${base}»`);
  }
  out.ok = !!out.dff && !out.dff.native;
  importState.set(id, out);
  return out;
}
route('PUT', /^\/api\/import\/([^/]+)\/([^/]+)$/, async (req, res, m) => {
  const id = decodeURIComponent(m[1]), name = safeName(decodeURIComponent(m[2])).trim();
  const dir = importDir(id);
  if (!IMPORT_FILE.test(name)) return fail(req, res, 400, `«${name}»: нужен файл .dff, .txd или .col с обычным именем`);
  const body = await readBody(req);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  importState.delete(id);
  sendJson(req, res, { ok: true, name, size: body.length });
});
route('POST', /^\/api\/import\/([^/]+)\/check$/, (req, res, m) => sendJson(req, res, checkImport(decodeURIComponent(m[1]))));
route('GET', /^\/api\/imports$/, (req, res) => {
  fs.mkdirSync(IMPORTS, { recursive: true });
  const ids = fs.readdirSync(IMPORTS, { withFileTypes: true }).filter((d) => d.isDirectory() && IMPORT_ID.test(d.name)).map((d) => d.name);
  sendJson(req, res, ids.map((id) => checkImport(id)));
});
route('GET', /^\/api\/icol\/([^/]+)$/, (req, res, m) => {
  const id = decodeURIComponent(m[1]);
  const info = importState.get(id) || checkImport(id);
  if (!info.dff) return sendJson(req, res, { source: 'none', reason: 'в импорте нет читаемого DFF' });
  const base = info.dff.name.replace(/\.dff$/i, '').toLowerCase();
  for (const c of info.col) {
    const i = c.models.findIndex((x) => x.name.toLowerCase() === base);
    if (i < 0) continue;
    const buf = fs.readFileSync(path.join(importDir(id), c.name));
    return sendJson(req, res, { source: 'col', file: c.name, index: i, model: parseColModel(buf, listColModels(buf).models[i].offset) });
  }
  if (info.dff.embeddedCollision) {
    const buf = fs.readFileSync(path.join(importDir(id), info.dff.name));
    const d = parseDff(buf, { data: false });
    return sendJson(req, res, { source: 'embedded', model: parseColModel(buf, d.collision.offset) });
  }
  sendJson(req, res, { source: 'none', reason: info.col.length ? `в COL импорта нет модели «${base}»` : 'в импорте нет COL и в DFF нет встроенной коллизии' });
});
route('GET', /^\/api\/igeom\/([^/]+)$/, (req, res, m, url) => {
  const id = decodeURIComponent(m[1]);
  const info = importState.get(id) || checkImport(id);
  if (!info.dff) return fail(req, res, 422, 'в импорте нет читаемого DFF', info.problems);
  const cat = state.cat;
  const register = (name, kind) => {
    const key = `import:${id}/${name}`;
    const abs = path.join(importDir(id), name);
    const st = fs.statSync(abs);
    let rid = cat.resByKey.get(key);
    if (rid === undefined) {
      const fid = cat.files.length;
      cat.files.push({ fid, key, root: 'import', rel: `${id}/${name}`, lower: `${id}/${name}`.toLowerCase(), kind, size: st.size, abs });
      rid = cat.res.length;
      cat.res.push({ rid, fid, entry: -1, name, lower: name.toLowerCase(), base: name.toLowerCase().replace(/\.\w+$/, ''), ext: kind, kind, offset: 0, sectors: 0, bytes: st.size, key });
      cat.resByKey.set(key, rid);
    }
    const r = cat.res[rid];
    if (r.mtime !== st.mtimeMs || r.bytes !== st.size) {
      r.mtime = st.mtimeMs; r.bytes = st.size; cat.files[r.fid].size = st.size;
      rawCache.set(rid, fs.readFileSync(abs), st.size);
      txdCache.delete(rid);
    }
    return rid;
  };
  const rid = register(info.dff.name, 'dff');
  const chain = info.txd.map((t) => ({ rid: register(t.name, 'txd'), name: t.name, file: `import:${id}`, reason: 'TXD из импорта' }));
  if (url.searchParams.get('vehicle') === '1') for (const c of textureChain(state.world, cat, { vehicle: true })) chain.push(c);
  try { sendBin(req, res, packModel(cat, state.world, rid, chain, url.searchParams.get('pose') === 'ped' ? pedPose() : null), 'application/octet-stream', false); } catch (e) { fail(req, res, 422, e.message); }
});
route('POST', /^\/api\/import\/([^/]+)\/delete$/, (req, res, m) => {
  fs.rmSync(importDir(decodeURIComponent(m[1])), { recursive: true, force: true });
  importState.delete(decodeURIComponent(m[1]));
  sendJson(req, res, { ok: true });
});

const THUMBS = path.join(CACHE, 'thumbs');
const THUMB_VERSION = 3;
const thumbFile = (r) => crypto.createHash('sha1').update(`${r.key}|${r.offset}|${r.sectors}|${THUMB_VERSION}`).digest('hex') + '.png';
function pruneThumbs() {
  let files;
  try { files = fs.readdirSync(THUMBS); } catch { return; }
  const keep = new Set(state.cat.res.filter((r) => r.kind === 'dff').map(thumbFile));
  let removed = 0;
  for (const f of files) if (f.endsWith('.png') && !keep.has(f)) { try { fs.unlinkSync(path.join(THUMBS, f)); removed++; } catch {} }
  if (removed) log(`превью: удалено устаревших ${removed}`);
}
route('GET', /^\/api\/thumb\/(\d+)$/, (req, res, m) => {
  const r = state.cat.res[Number(m[1])];
  if (!r) return fail(req, res, 404, 'нет ресурса');
  const f = path.join(THUMBS, thumbFile(r));
  if (!fs.existsSync(f)) return fail(req, res, 404, 'нет превью');
  sendBin(req, res, fs.readFileSync(f), 'image/png', false);
});
route('PUT', /^\/api\/thumb\/(\d+)$/, async (req, res, m) => {
  const r = state.cat.res[Number(m[1])];
  if (!r) return fail(req, res, 404, 'нет ресурса');
  const body = await readBody(req, 2 * 1024 * 1024);
  if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return fail(req, res, 400, 'превью должно быть PNG');
  fs.mkdirSync(THUMBS, { recursive: true });
  fs.writeFileSync(path.join(THUMBS, thumbFile(r)), body);
  sendJson(req, res, { ok: true });
});
route('POST', /^\/api\/report$/, async (req, res) => {
  const report = await readJson(req, 'object');
  fs.mkdirSync(DOCS, { recursive: true });
  writeFileAtomic(path.join(DOCS, 'coverage.json'), JSON.stringify(report, null, 1));
  sendJson(req, res, { ok: true, path: path.relative(APP_ROOT, path.join(DOCS, 'coverage.json')) });
});

let port = PORT;
const localHost = (h) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
const server = http.createServer(async (req, res) => {
  if (req.headers.host && !localHost(req.headers.host.toLowerCase())) return fail(req, res, 403, 'сервер отвечает только на адрес 127.0.0.1/localhost');
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && !localHost(req.headers.origin.toLowerCase().replace(/^http:\/\//, ''))) return fail(req, res, 403, 'запрос не со страницы приложения');
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return fail(req, res, 400, 'неверный адрес'); }
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(p);
        if (!m) continue;
        if (r.needReady && !state.ready) return fail(req, res, 503, state.error || 'индекс ещё строится', { progress });
        return await r.fn(req, res, m, url);
      }
      return fail(req, res, 404, `нет метода ${req.method} ${p}`);
    }
    if (p === '/' || p === '/index.html') return serveStatic(req, res, APP_STATIC, 'index.html');
    if (p.startsWith('/catalog/')) {
      const rel = p === '/catalog/' ? 'index.html' : p.slice('/catalog/'.length);
      if (!['index.html', 'viewer.html'].includes(rel) && !rel.startsWith('data/')) return fail(req, res, 404, `нет файла ${rel}`);
      return serveStatic(req, res, APP_ROOT, rel);
    }
    if (p.startsWith('/docs/')) return serveStatic(req, res, DOCS, p.slice('/docs/'.length));
    return serveStatic(req, res, APP_STATIC, p.slice(1));
  } catch (e) {
    if (!e.status) log('ошибка', req.method, p, e.stack || e);
    if (!res.headersSent) fail(req, res, e.status || 500, String(e.message || e));
  }
});

const APP_ID = 'radmir-map-viewer';
const wantOpen = process.argv.includes('--open') && !process.env.RADMIR_NO_BROWSER;

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => log(`откройте в браузере: ${url}`));
    child.unref();
  } catch { log(`откройте в браузере: ${url}`); }
}

function probe(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/status', timeout: 1500 }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8')).app === APP_ID); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function startupProblems() {
  const problems = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) problems.push(`нужен Node.js 18 или новее, сейчас ${process.version}. Запустите «Запуск.bat» — он скачает подходящую версию сам.`);
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    const probeFile = path.join(CACHE, `.write-test-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
  } catch (e) {
    problems.push(`в папку программы нельзя писать (${e.code || e.message}). Скорее всего, она лежит в Program Files или в архиве. Распакуйте её, например, на рабочий стол.`);
  }
  return problems;
}

process.on('uncaughtException', (e) => log('непредвиденная ошибка', e.stack || e));
process.on('unhandledRejection', (e) => log('непредвиденная ошибка', (e && e.stack) || e));

let attempt = 0;
let listening = false;

server.on('listening', () => {
  listening = true;
  const url = `http://127.0.0.1:${port}/`;
  log(`Карта RADMIR: ${url}${attempt ? ` (порт ${PORT} был занят)` : ''}`);
  log(`файлы игры: ${DECRYPTED}`);
  log('окно не закрывайте, пока работаете с картой');
  if (wantOpen) openBrowser(url);
  boot().catch((e) => { state.error = String(e.stack || e); log('ошибка запуска', state.error); });
});

server.on('error', async (e) => {
  if (listening) { log('ошибка сервера:', e.message); return; }
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') { log('сервер не запустился:', e.message); process.exit(1); }
  if (await probe(port)) {
    log(`программа уже запущена: http://127.0.0.1:${port}/`);
    if (wantOpen) openBrowser(`http://127.0.0.1:${port}/`);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (attempt >= 20) { log(`порты ${PORT}–${PORT + 20} заняты другими программами. Задайте свободный порт: set RADMIR_VIEWER_PORT=9000`); process.exit(1); }
  attempt++;
  listen();
});

function listen() {
  port = PORT + attempt;
  server.listen(port, '127.0.0.1');
}

const problems = startupProblems();
if (problems.length) {
  for (const p of problems) log(p);
  process.exit(1);
}
listen();
