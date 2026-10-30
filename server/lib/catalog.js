export class Catalog {
  constructor(records) {
    this.files = [];
    this.byKey = new Map();
    this.byRelLower = new Map();
    this.res = [];
    this.resByName = new Map();
    this.resByKey = new Map();
    this.defs = [];
    this.defsById = new Map();
    this.txdp = [];
    this.ipls = [];
    this.colIndex = new Map();
    this.diagnostics = [];
    this.special = {};
    for (const r of records) this.addFile(r);
    this.generation = Date.now().toString(36);
  }

  diag(d) { this.diagnostics.push(d); }

  addFile(r) {
    const fid = this.files.length;
    const f = {
      fid, key: r.key, root: r.root, rel: r.rel, lower: r.rel.toLowerCase(), kind: r.kind, size: r.size, mtime: r.mtime,
      error: r.error || null, reason: r.reason || null, entries: 0, diagnostics: 0,
    };
    this.files.push(f);
    this.byKey.set(r.key, f);
    if (!this.byRelLower.has(f.lower)) this.byRelLower.set(f.lower, []);
    this.byRelLower.get(f.lower).push(fid);
    if (r.error) this.diag({ fid, file: r.key, message: r.error });
    if (r.kind === 'img') {
      f.entries = r.entries.length;
      (r.diagnostics || []).forEach((d) => this.diag({ fid, file: r.key, offset: d.offset, entry: d.entry, message: d.message, raw: d.name, level: d.level }));
      r.entries.forEach((e, i) => this.addResource(f, e, i));
    } else if (['dff', 'txd', 'col', 'ifp'].includes(r.kind)) {
      this.addResource(f, { n: r.rel.split('/').pop(), o: 0, s: 0, k: r.kind, dff: r.dff, txd: r.txd, col: r.col, ifp: r.ifp }, -1);
    } else if (r.kind === 'ide' && r.ide) {
      f.ide = { lines: r.ide.lines, service: r.ide.service, unsupported: r.ide.unsupported };
      for (const d of r.ide.defs) {
        const did = this.defs.length;
        const def = { did, fid, key: `${r.key}#${d.line}`, ...d };
        this.defs.push(def);
        if (!this.defsById.has(d.id)) this.defsById.set(d.id, []);
        this.defsById.get(d.id).push(did);
      }
      for (const t of r.ide.txdp) this.txdp.push({ fid, ...t });
      r.ide.diagnostics.forEach((d) => this.diag({ fid, file: r.key, line: d.line, raw: d.raw, message: d.message, level: d.level }));
      f.diagnostics = r.ide.diagnostics.length;
      f.defs = r.ide.defs.length;
    } else if ((r.kind === 'ipl' || r.kind === 'ipl-binary') && r.ipl) {
      this.addIpl(f, -1, r.rel.split('/').pop(), r.ipl, r.key);
    } else if (r.kind === 'manifest') {
      f.manifest = r.manifest;
    } else if (r.kind === 'carcols') this.special.carcols = { fid, ...r.carcols };
    else if (r.kind === 'surfinfo') this.special.surfinfo = { fid, names: r.surfinfo };
    else if (r.kind === 'water') this.special.water = { fid, ...r.water };
  }

  addResource(f, e, index) {
    const rid = this.res.length;
    const name = e.n || '';
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const res = {
      rid, fid: f.fid, entry: index, name, lower, base: dot >= 0 ? lower.slice(0, dot) : lower, ext: dot >= 0 ? lower.slice(dot + 1) : '',
      kind: e.k || (e.err ? 'error' : 'unknown'), offset: e.o, sectors: e.s, bytes: index >= 0 ? e.s * 2048 : f.size,
      key: index >= 0 ? `${f.key}|${name}#${index}` : f.key,
      err: e.err || null, mismatch: e.mismatch || null,
    };
    if (e.dff) { res.dff = e.dff; if (e.dff.error) res.err = e.dff.error; }
    if (e.txd) { res.txd = e.txd; if (e.txd.error) res.err = e.txd.error; }
    if (e.col) res.col = e.col;
    if (e.ifp) res.ifp = e.ifp;
    if (e.nodes) res.nodes = e.nodes;
    this.res.push(res);
    this.resByKey.set(res.key, rid);
    if (!this.resByName.has(lower)) this.resByName.set(lower, []);
    this.resByName.get(lower).push(rid);
    if (res.err) this.diag({ fid: f.fid, rid, file: f.key, entry: name, offset: index >= 0 ? e.o * 2048 : 0, message: res.err });
    if (res.mismatch) this.diag({ fid: f.fid, rid, file: f.key, entry: name, message: res.mismatch, level: 'info' });
    if (e.col) {
      e.col.models.forEach((m, i) => {
        const k = (m.n || '').toLowerCase();
        if (!this.colIndex.has(k)) this.colIndex.set(k, []);
        this.colIndex.get(k).push({ rid, i, ...m });
      });
      (e.col.diagnostics || []).forEach((d) => this.diag({ fid: f.fid, rid, file: f.key, entry: name, offset: d.offset, message: d.message, level: d.level }));
    }
    if (e.ipl) this.addIpl(f, index, name, e.ipl, res.key, rid);
  }

  addIpl(f, entry, name, rec, key, rid = -1) {
    const lower = name.toLowerCase();
    const base = lower.replace(/\.(ipl|zon)$/, '');
    const pid = this.ipls.length;
    const stream = /^(.*)_stream(\d+)$/.exec(base);
    this.ipls.push({ pid, fid: f.fid, entry, rid, key, name, lower, base, kind: rec.kind, rec, streamOf: stream ? stream[1] : null, streamNo: stream ? Number(stream[2]) : -1 });
    (rec.diagnostics || []).forEach((d) => this.diag({ fid: f.fid, rid: rid >= 0 ? rid : undefined, file: key, line: d.line, offset: d.offset, raw: d.raw, message: d.message, level: d.level }));
    if (entry < 0) f.diagnostics = (rec.diagnostics || []).length;
  }

  resolvePath(p) {
    const lower = p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    const fids = this.byRelLower.get(lower) || [];
    const order = ['decrypted', 'game-import'];
    const sorted = fids.map((id) => this.files[id]).sort((a, b) => order.indexOf(a.root) - order.indexOf(b.root));
    return { file: sorted[0] || null, alternatives: sorted.slice(1) };
  }

  stats() {
    const kinds = {}, resKinds = {};
    const files = this.files.filter((f) => f.root !== 'import');
    const res = this.res.filter((r) => this.files[r.fid].root !== 'import');
    for (const f of files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    for (const r of res) resKinds[r.kind] = (resKinds[r.kind] || 0) + 1;
    return { files: files.length, kinds, resources: res.length, resKinds, defs: this.defs.length, ids: this.defsById.size, ipls: this.ipls.length, diagnostics: this.diagnostics.length };
  }
}
