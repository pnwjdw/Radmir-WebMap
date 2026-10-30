import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GAME_IMPORT, DEFAULT_GAME_DIR, APP_ROOT } from '../lib/config.js';
import { parseManifest } from '../lib/dat.js';
import { parseTextIpl } from '../lib/ipl.js';
import { parseTxd } from '../lib/txd.js';
import { parseDff } from '../lib/dff.js';
import { listColModels } from '../lib/col.js';
import { parseCarcols, parseSurfinfo, parseWater, parseIfpHeader } from '../lib/gamedata.js';

const gameDir = process.argv[2] || DEFAULT_GAME_DIR;
const RADMIR_MAGIC = '72174a33';

const FILES = [
  ['CustomSAA2\\GTA.DAT', 'manifest', 'Действующий манифест: порядок IMG/IDE/IPL. Все пути существуют, блок «Generated IMG» совпадает с models\\img'],
  ['CustomSAA2\\DEFAULT.DAT', 'manifest', 'Загружается до GTA.DAT: SAMP\\CUSTOM.IMG, SAMP\\SAMP.IMG, MODELS\\GTA3.IMG, DEFAULT/VEHICLES/PEDS.IDE, WEAPONS.COL'],
  ['data\\gta.dat', 'manifest', 'Альтернативный (устаревший) манифест: 7 IMG из него отсутствуют на диске, показывается для сравнения'],
  ['data\\default.dat', 'manifest', 'Альтернативный default.dat без строк IMG, для сравнения'],
  ['data\\map.zon', 'zon', 'Зоны карты: подключены в GTA.DAT, в decrypted отсутствуют'],
  ['data\\info.zon', 'zon', 'Информационные зоны: подключены в GTA.DAT, в decrypted отсутствуют'],
  ['data\\carcols.dat', 'carcols', 'Цвета кузова машин (основной и дополнительный)'],
  ['data\\surfinfo.dat', 'surfinfo', 'Имена поверхностей для материалов коллизий COL'],
  ['models\\generic\\vehicle.txd', 'txd', 'Общие текстуры машин (фары, грязь, номера), путь зашит в движок SA'],
  ['CustomSAA2\\VEHICLE.TXD', 'txd', 'Второй вариант общих текстур машин (папка CustomSAA2), используется как запасной'],
  ['models\\generic\\wheels.dff', 'dff', 'Колёса тюнинга'],
  ['models\\generic\\wheels.txd', 'txd', 'Текстуры колёс тюнинга'],
  ['models\\coll\\weapons.col', 'col', 'Коллизии оружия (COLFILE в DEFAULT.DAT)'],
  ['models\\coll\\vehicles.col', 'col', 'Коллизии машин из движка SA'],
  ['models\\coll\\peds.col', 'col', 'Коллизии пешеходов из движка SA'],
  ['anim\\ped.ifp', 'ifp', 'Анимации пешеходов (заголовки для просмотра)'],
  ['data\\water.dat', 'water', 'Плоскости воды'],
  ['fastman92limitAdjuster_GTASA.ini', 'text', 'Настройки лимитов: «Max number of IMG archives = 128» (почему 102 IMG допустимы)'],
  ['CustomSAA2\\stream.ini', 'text', 'Настройки стриминга клиента'],
];

function resolveCi(root, rel) {
  let cur = root;
  for (const part of rel.split(/[\\/]/)) {
    if (!part) continue;
    let names;
    try { names = fs.readdirSync(cur); } catch { return null; }
    const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

function check(kind, buf) {
  const head = buf.subarray(0, 4).toString('hex');
  if (head === RADMIR_MAGIC) return { ok: false, error: 'файл зашифрован RADMIR (сигнатура 72174a33); нужна расшифровка' };
  switch (kind) {
    case 'manifest': { const m = parseManifest(buf); const by = {}; for (const e of m.entries) if (e.active) by[e.keyword] = (by[e.keyword] || 0) + 1; return { ok: m.entries.length > 0, summary: `активных строк: ${JSON.stringify(by)}`, diagnostics: m.diagnostics.length }; }
    case 'zon': { const z = parseTextIpl(buf); return { ok: !!(z.service.zone && z.service.zone.length), summary: `зон: ${(z.service.zone || []).length}`, diagnostics: z.diagnostics.length }; }
    case 'carcols': { const c = parseCarcols(buf); return { ok: c.colors.length > 0, summary: `цветов: ${c.colors.length}, машин: ${Object.keys(c.cars).length}`, diagnostics: c.diagnostics.length }; }
    case 'surfinfo': { const s = parseSurfinfo(buf); return { ok: s.length > 0, summary: `поверхностей: ${s.length}` }; }
    case 'txd': { const t = parseTxd(buf); return { ok: !t.error, summary: t.error || `текстур: ${t.textures.length}, поддерживается: ${t.textures.filter((x) => x.supported).length}` }; }
    case 'dff': { const d = parseDff(buf, { data: false }); return { ok: !d.error, summary: d.error || `RW ${d.rw.text}, атомиков: ${d.atomics.length}, фреймов: ${d.frames.length}` }; }
    case 'col': { const c = listColModels(buf); return { ok: c.models.length > 0, summary: `моделей: ${c.models.length}, версии: ${[...new Set(c.models.map((m) => m.version))].join(',')}`, diagnostics: c.diagnostics.length }; }
    case 'ifp': { const f = parseIfpHeader(buf); return { ok: !f.error, summary: f.error || `пакет «${f.name}», анимаций: ${f.count}` }; }
    case 'water': { const w = parseWater(buf); return { ok: w.quads.length > 0, summary: `полигонов воды: ${w.quads.length}`, diagnostics: w.diagnostics.length }; }
    default: return { ok: true, summary: `строк: ${buf.toString('latin1').split(/\r?\n/).length}` };
  }
}

const registry = { createdAt: new Date().toISOString(), gameDir, files: [], missing: [] };
for (const [rel, kind, purpose] of FILES) {
  const src = resolveCi(gameDir, rel);
  if (!src) { registry.missing.push({ source: rel, purpose }); console.log('нет в игре:', rel); continue; }
  const buf = fs.readFileSync(src);
  const relActual = path.relative(gameDir, src);
  const target = path.join(GAME_IMPORT, relActual);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  const copy = fs.readFileSync(target);
  const sha = crypto.createHash('sha256').update(copy).digest('hex');
  const same = sha === crypto.createHash('sha256').update(buf).digest('hex');
  let result;
  try { result = check(kind, copy); } catch (e) { result = { ok: false, error: String(e.message || e) }; }
  const entry = {
    source: src, target: path.relative(APP_ROOT, target), relative: relActual, size: copy.length, sha256: sha,
    copyVerified: same, kind, purpose, check: result,
  };
  registry.files.push(entry);
  console.log(`${result.ok ? 'OK ' : 'ERR'} ${relActual} (${copy.length} б): ${result.summary || result.error}`);
}
fs.writeFileSync(path.join(GAME_IMPORT, 'registry.json'), JSON.stringify(registry, null, 2));
console.log(`скопировано ${registry.files.length}, не найдено ${registry.missing.length}; реестр: resources/game-import/registry.json`);
