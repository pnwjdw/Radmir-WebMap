import fs from 'node:fs';
import path from 'node:path';
import { ROOTS } from './config.js';
import { readRange, SECTOR } from './img.js';
import { parseTxd } from './txd.js';

export class Lru {
  constructor(limitBytes) { this.limit = limitBytes; this.bytes = 0; this.map = new Map(); this.hits = 0; this.misses = 0; }
  get(k) {
    const e = this.map.get(k);
    if (!e) { this.misses++; return undefined; }
    this.hits++;
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k, v, size) {
    if (this.map.has(k)) { this.bytes -= this.map.get(k).size; this.map.delete(k); }
    this.map.set(k, { v, size });
    this.bytes += size;
    while (this.bytes > this.limit && this.map.size > 1) {
      const [key, e] = this.map.entries().next().value;
      this.map.delete(key); this.bytes -= e.size;
    }
  }
  delete(k) { const e = this.map.get(k); if (e) { this.bytes -= e.size; this.map.delete(k); } }
  stats() { return { entries: this.map.size, bytes: this.bytes, limit: this.limit, hits: this.hits, misses: this.misses }; }
}

export const rawCache = new Lru(384 * 1024 * 1024);
export const txdCache = new Lru(64 * 1024 * 1024);

export function absPath(file) {
  if (file.abs) return file.abs;
  return path.join(ROOTS[file.root], ...file.rel.split('/'));
}

export function readResource(cat, rid) {
  const hit = rawCache.get(rid);
  if (hit) return hit;
  const r = cat.res[rid];
  if (!r) throw new Error(`ресурс ${rid} не найден`);
  const f = cat.files[r.fid];
  const abs = absPath(f);
  const buf = r.entry >= 0 ? readRange(abs, r.offset * SECTOR, r.sectors * SECTOR) : fs.readFileSync(abs);
  rawCache.set(rid, buf, buf.length);
  return buf;
}

export function readFileBytes(cat, fid) {
  return fs.readFileSync(absPath(cat.files[fid]));
}

export function txdOf(cat, rid) {
  let t = txdCache.get(rid);
  if (t) return t;
  const buf = readResource(cat, rid);
  t = parseTxd(buf);
  t.byName = new Map(t.textures.map((x) => [x.name.toLowerCase(), x]));
  txdCache.set(rid, t, 4096 + t.textures.length * 512);
  return t;
}
