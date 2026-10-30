import fs from 'node:fs';
import path from 'node:path';
import { PROFILES } from './config.js';

export const PROFILE_FORMAT = 3;
const VEHMODS_ASSUMPTION = 'Детали тюнинга из veh_mods.ide (диски, выхлопы, обвесы) ищут текстуры и в общих TXD машин (models\\generic\\vehicle.txd, CustomSAA2\\VEHICLE.TXD), как машины: 1648 таких моделей RADMIR без этого остались бы без большей части текстур. Как именно клиент RADMIR подключает этот словарь, не проверено.';
export const DEFAULT_RULES = { imgDuplicate: 'first', ideDuplicate: 'last', streamIpl: 'game', hideExactDuplicates: false };
const STREAM_ASSUMPTION = 'IPL внутри активных IMG: каждый файл — потоковый слот, как в CIplStore. Слот, чьё имя начинается с «<текстовый IPL>_stream», берёт LOD-связи из этого текстового IPL; остальные (их текстовый IPL закомментирован, отсутствует или имя записано с опечаткой — список в диагностике мира) движок SA тоже грузит, но без LOD. Как с ними поступает клиент RADMIR, не проверено; правило «Потоковые IPL» в профиле позволяет их отключить.';

export function upgradeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  if ((p.format || 0) < 2) {
    p.rules = { ...(p.rules || {}) };
    if (!p.rules.streamIpl || p.rules.streamIpl === 'base-name') p.rules.streamIpl = 'game';
    if (Array.isArray(p.assumptions)) p.assumptions = p.assumptions.map((a) => (/^Потоковые IPL \(\*_streamN\.ipl в IMG\)/.test(a) ? STREAM_ASSUMPTION : a));
  }
  if ((p.format || 0) < 3 && Array.isArray(p.assumptions) && !p.assumptions.includes(VEHMODS_ASSUMPTION)) p.assumptions.push(VEHMODS_ASSUMPTION);
  if ((p.format || 0) < PROFILE_FORMAT) p.format = PROFILE_FORMAT;
  p.rules = { ...DEFAULT_RULES, ...(p.rules || {}) };
  p.overrides = { ide: {}, resource: {}, ...(p.overrides || {}) };
  return p;
}

const MANIFESTS = [
  { key: 'game-import:CustomSAA2/DEFAULT.DAT', role: 'default.dat (загружается первым)' },
  { key: 'game-import:CustomSAA2/GTA.DAT', role: 'gta.dat' },
];
const ALT_MANIFESTS = ['game-import:data/default.dat', 'game-import:data/gta.dat'];

export function buildDefaultProfile(cat) {
  const p = {
    format: PROFILE_FORMAT, id: 'radmir-customsaa2', name: 'RADMIR: CustomSAA2\\DEFAULT.DAT + GTA.DAT', createdAt: new Date().toISOString(),
    manifests: [], alternativeManifests: [], evidence: [], assumptions: [], img: [], ide: [], ipl: [], colfile: [],
    rules: { ...DEFAULT_RULES },
    overrides: { ide: {}, resource: {} },
  };
  const seen = { img: new Set(), ide: new Set(), ipl: new Set() };
  for (const m of MANIFESTS) {
    const f = cat.byKey.get(m.key);
    if (!f || !f.manifest) { p.evidence.push(`Манифест ${m.key} не найден — профиль построен без него`); continue; }
    p.manifests.push({ key: m.key, role: m.role });
    for (const e of f.manifest.entries) {
      const kw = e.keyword.toLowerCase();
      if (!['img', 'ide', 'ipl', 'colfile'].includes(kw)) continue;
      const r = cat.resolvePath(e.path);
      const item = {
        path: e.path, manifest: m.key, line: e.line, raw: e.raw, file: r.file ? r.file.key : null,
        alternatives: r.alternatives.map((a) => a.key), active: e.active && !!r.file,
        reason: !e.active ? 'закомментировано в манифесте' : r.file ? `строка ${e.line} манифеста ${m.key.split(':')[1]}` : 'файл не найден ни в decrypted, ни в game-import',
      };
      if (kw === 'colfile') { p.colfile.push(item); continue; }
      const list = p[kw];
      const dupKey = (item.file || item.path).toLowerCase();
      if (seen[kw].has(dupKey)) {
        if (item.file && /empty\.ipl$/i.test(item.file)) { item.slot = true; item.reason = 'пустой слот empty.ipl (36 штук в манифесте)'; }
        else if (e.active) item.reason += '; повтор уже подключённого файла';
        item.repeat = true;
      }
      seen[kw].add(dupKey);
      list.push(item);
    }
  }
  for (const k of ALT_MANIFESTS) if (cat.byKey.get(k)) p.alternativeManifests.push(k);
  const mentioned = new Set([...p.img, ...p.ide, ...p.ipl].map((x) => x.file).filter(Boolean));
  for (const f of cat.files) {
    if (mentioned.has(f.key)) continue;
    const kind = f.kind === 'img' ? 'img' : f.kind === 'ide' ? 'ide' : (f.kind === 'ipl' || f.kind === 'ipl-binary' || f.kind === 'empty') && /\.(ipl|zon)$/i.test(f.rel) ? 'ipl' : null;
    if (!kind) continue;
    let reason = 'не подключён в манифестах';
    if (/data\/maps\/map\.ipl$/i.test(f.rel)) reason = 'нет в манифестах; ~24 тыс. объектов с именем «dummy» (разрешаются по ID) — похоже на выгрузку объектов сервера; включается отдельно';
    else if (/models\/player\.img$/i.test(f.rel)) reason = 'нет в манифестах; одежда CJ, движок открывает этот архив сам';
    else if (/_fix\.ipl$/i.test(f.rel)) reason = 'нет в манифестах; вариант *_FIX перекрывает исходную расстановку';
    p[kind].push({ path: f.rel.replace(/\//g, '\\'), manifest: null, line: null, raw: null, file: f.key, alternatives: [], active: false, reason, unlisted: true });
  }
  p.evidence.push(
    'data\\gta.dat ссылается на models\\radm.img, radm_t.img, radm2.img, cars.img, cars2.img, cars_t.img, vice.img — этих файлов нет ни в игре, ни в decrypted; значит, игра не может работать по нему.',
    'CustomSAA2\\GTA.DAT: все 102 IMG, 44 IDE и 99 IPL существуют; блок «# Generated IMG start … end» перечисляет ровно архивы models\\img — его генерирует клиент.',
    'CustomSAA2\\DEFAULT.DAT загружается раньше GTA.DAT (так устроен движок SA) и подключает SAMP\\CUSTOM.IMG, SAMP\\SAMP.IMG, MODELS\\GTA3.IMG и DATA\\DEFAULT.IDE, VEHICLES.IDE, PEDS.IDE.',
    'В fastman92limitAdjuster_GTASA.ini задано «Max number of IMG archives = 128», поэтому 105 архивов из манифестов допустимы.',
    'Игровые IDE/IPL/IMG зашифрованы RADMIR (сигнатура 72174a33); содержимое берётся из decrypted, недостающие открытые файлы — из resources\\game-import (см. registry.json).',
  );
  p.assumptions.push(
    'Повтор имени файла в разных IMG: используется первая запись по порядку подключения IMG (так ведёт себя загрузчик каталога в re3/gta-reversed: «appears more than once»). Поведение лимит-аджастера RADMIR не проверено.',
    'Повтор ID в разных IDE: побеждает определение из позже загруженного IDE (движок перезаписывает слот модели). Можно выбрать другое определение для каждого ID.',
    STREAM_ASSUMPTION,
    VEHMODS_ASSUMPTION,
    'Объекты, которые сервер создаёт во время игры (CreateObject), в файлах отсутствуют; data\\maps\\map.ipl может быть их выгрузкой, но ни один манифест его не подключает.',
  );
  return p;
}

export function profilePath(id) { return path.join(PROFILES, `${id.replace(/[^a-z0-9_.-]/gi, '_')}.json`); }

export function loadProfiles() {
  fs.mkdirSync(PROFILES, { recursive: true });
  return fs.readdirSync(PROFILES).filter((f) => f.endsWith('.json')).map((f) => {
    try { const p = JSON.parse(fs.readFileSync(path.join(PROFILES, f), 'utf8')); return { id: p.id, name: p.name, file: f, createdAt: p.createdAt, updatedAt: p.updatedAt }; } catch { return null; }
  }).filter(Boolean);
}

export function saveProfile(p) {
  fs.mkdirSync(PROFILES, { recursive: true });
  p.updatedAt = new Date().toISOString();
  const file = profilePath(p.id), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, file);
}

export function readProfile(id) {
  try { return JSON.parse(fs.readFileSync(profilePath(id), 'utf8')); } catch { return null; }
}

export function currentProfileId() {
  try { return fs.readFileSync(path.join(PROFILES, 'current.txt'), 'utf8').trim(); } catch { return null; }
}
export function setCurrentProfileId(id) {
  fs.mkdirSync(PROFILES, { recursive: true });
  fs.writeFileSync(path.join(PROFILES, 'current.txt'), id);
}
