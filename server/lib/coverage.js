import { textureChain } from './geompack.js';

export function coverage(cat, world, registry) {
  const byKind = {}, byRoot = {};
  const fileErrors = [];
  let fileTotal = 0;
  for (const f of cat.files) {
    if (f.root === 'import') continue;
    fileTotal++;
    byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    byRoot[f.root] = (byRoot[f.root] || 0) + 1;
    if (f.error) fileErrors.push({ file: f.key, error: f.error });
  }
  const entries = {}, entryErrors = [];
  let dffOk = 0, dffBad = 0, txdOk = 0, txdBad = 0, texTotal = 0, texSupported = 0, colModels = 0, nativeGeo = 0;
  const texUnsupported = {}, colVersions = {}, unknownExt = {};
  for (const r of cat.res) {
    if (cat.files[r.fid].root === 'import') continue;
    entries[r.kind] = (entries[r.kind] || 0) + 1;
    if (r.err) entryErrors.push({ key: r.key, error: r.err });
    if (r.kind === 'dff') { if (r.dff && !r.dff.error) dffOk++; else dffBad++; }
    if (r.kind === 'txd') {
      if (r.txd && !r.txd.error) {
        txdOk++;
        for (const t of r.txd.textures) { texTotal++; if (!t.err) texSupported++; else texUnsupported[t.e] = (texUnsupported[t.e] || 0) + 1; }
      } else txdBad++;
    }
    if (r.kind === 'col' && r.col) for (const m of r.col.models) { colModels++; colVersions[`COL${m.v === 1 ? 'L' : m.v}`] = (colVersions[`COL${m.v === 1 ? 'L' : m.v}`] || 0) + 1; }
    if (r.kind === 'unknown' || r.kind === 'text') unknownExt[r.ext || '(без расширения)'] = (unknownExt[r.ext || '(без расширения)'] || 0) + 1;
  }
  let iplInstAll = 0, iplText = 0, iplBinary = 0;
  for (const s of cat.ipls) { iplInstAll += s.rec.inst.length; if (s.kind === 'binary') iplBinary++; else iplText++; }
  let withDff = 0, withTxd = 0, withCol = 0, embedded = 0, texNeeded = 0, texResolved = 0, modelsAllTex = 0;
  const txdNames = new Map();
  const texSetOf = (rid) => {
    if (!txdNames.has(rid)) txdNames.set(rid, new Set((cat.res[rid].txd && cat.res[rid].txd.textures || []).map((t) => t.n.toLowerCase())));
    return txdNames.get(rid);
  };
  for (const m of world.models) {
    if (m.dff >= 0) withDff++;
    if (m.txdRid >= 0) withTxd++;
    if (m.col) withCol++; else if (m.embeddedCol) embedded++;
    if (m.dff < 0) continue;
    const s = cat.res[m.dff].dff;
    if (!s || !s.textures) continue;
    const chain = textureChain(world, cat, { txdRid: m.txdRid, txdName: m.txd, vehicle: m.vehicleTex }).map((c) => texSetOf(c.rid));
    let all = true;
    for (const t of s.textures) { texNeeded++; if (chain.some((set) => set.has(t))) texResolved++; else all = false; }
    if (all) modelsAllTex++;
  }
  let drawable = 0, noDef = 0, noDff = 0;
  for (let i = 0; i < world.count; i++) {
    const mi = world.inst.mi[i];
    if (mi < 0) noDef++; else if (world.models[mi].dff < 0) noDff++; else drawable++;
  }
  let lodLinks = 0;
  for (let i = 0; i < world.count; i++) if (world.inst.lod[i] >= 0) lodLinks++;
  const service = Object.fromEntries(Object.entries(world.service).map(([k, v]) => [k, v.length]));
  const unsupportedSections = [];
  for (const f of cat.files) {
    if (f.ide) for (const u of f.ide.unsupported) unsupportedSections.push({ file: f.key, section: u.section, lines: u.count });
  }
  for (const s of cat.ipls) for (const u of s.rec.unsupported || []) unsupportedSections.push({ file: s.key, section: u.section, lines: u.count });
  return {
    generatedAt: new Date().toISOString(),
    profile: { id: world.profile.id, name: world.profile.name },
    files: { total: fileTotal, byRoot, byKind, errors: fileErrors },
    archiveEntries: { total: cat.res.filter((r) => r.entry >= 0).length, byKind: entries, errors: entryErrors.slice(0, 200), errorCount: entryErrors.length },
    dff: { total: dffOk + dffBad, parsed: dffOk, failed: dffBad },
    txd: { total: txdOk + txdBad, parsed: txdOk, failed: txdBad, textures: texTotal, texturesSupported: texSupported, unsupportedByFormat: texUnsupported },
    col: { files: entries.col || 0, models: colModels, versions: colVersions },
    ide: { files: byKind.ide || 0, definitions: cat.defs.length, uniqueIds: cat.defsById.size, activeFiles: world.activeIde.length, activeIds: world.models.length, idConflictsActive: world.conflicts.ids.length },
    ipl: { textFiles: iplText, binaryFiles: iplBinary, placementsInAllFiles: iplInstAll, activeSources: world.sources.length, streamSources: world.sources.filter((s) => s.stream).length, activePlacements: world.count, drawable, withoutDefinition: noDef, withoutDff: noDff, lodLinks, exactDuplicates: world.duplicateCount, nonUnitScale: world.scales.size },
    models: { total: world.models.length, withDff, withTxd, withCollisionFile: withCol, withEmbeddedCollision: embedded, texturesNeeded: texNeeded, texturesResolved: texResolved, modelsWithAllTextures: modelsAllTex },
    service, unsupportedSections,
    unknownEntries: unknownExt,
    gameImport: registry ? { files: registry.files.length, missing: registry.missing.length, checked: registry.files.filter((f) => f.check && f.check.ok).length } : null,
    notSupported: [
      { what: 'Записи .rrr (записи маршрутов транспорта), .scm, .dat вне Paths', why: 'не относятся к геометрии карты; индексируются как «unknown», не разбираются' },
      { what: 'Проигрывание IFP-анимаций', why: 'читаются анимации и их кадры; персонажи ставятся в первый кадр IDLE_stance из ped.ifp (поза покоя в игре), движение не проигрывается; прочие skinned-модели — в позе кадров DFF' },
      { what: 'Нативная геометрия (PS2/Xbox) и текстуры не для PC', why: 'в наборе не встречаются; при появлении помечаются как неподдерживаемые' },
      { what: 'Отражения (Material Effects env map), specular, UV-анимация', why: 'наличие показывается в инспекторе, при отрисовке не применяются' },
      { what: 'Дневной/ночной цикл, освещение timecyc, тени', why: 'вершинные цвета prelight с регулируемой подсветкой (ползунок «ночные цвета» смешивает Extra Vert Colour); timecyc и тени не применяются — яркость приближённая' },
      { what: 'Модели с двумя clump в одном DFF (одежда CJ в player.img и др.)', why: 'показывается первый clump, как с предупреждением в инспекторе' },
      { what: 'Объекты, создаваемые сервером во время игры', why: 'их нет в файлах; data\\maps\\map.ipl (вне манифестов) можно включить отдельным слоем' },
    ],
  };
}
