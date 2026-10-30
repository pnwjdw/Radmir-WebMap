import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ROOTS, CACHE } from './config.js';

export const INDEX_FORMAT = 7;
const META = path.join(CACHE, 'index-meta.json');
const FILES_DIR = path.join(CACHE, 'files');

export const progress = {
  state: 'idle', startedAt: null, finishedAt: null, totalFiles: 0, doneFiles: 0, reused: 0, reindexed: 0,
  current: [], errors: [], bytesTotal: 0, bytesDone: 0,
};

function walk(root, rootName) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const r = rel ? path.join(rel, it.name) : it.name;
      if (it.isDirectory()) stack.push(r);
      else if (it.isFile()) {
        if (rootName === 'game-import' && it.name === 'registry.json') continue;
        const st = fs.statSync(path.join(root, r));
        out.push({ key: `${rootName}:${r.split(path.sep).join('/')}`, root: rootName, rel: r.split(path.sep).join('/'), abs: path.join(root, r), size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  }
  return out;
}

function cacheFileFor(key) {
  return path.join(FILES_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

export async function buildIndex({ force = false, log = () => {} } = {}) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  Object.assign(progress, { state: 'scanning', startedAt: Date.now(), finishedAt: null, doneFiles: 0, reused: 0, reindexed: 0, errors: [], current: [], bytesDone: 0 });
  const files = [];
  for (const [name, root] of Object.entries(ROOTS)) files.push(...walk(root, name));
  files.sort((a, b) => a.key.localeCompare(b.key));
  let meta = { format: 0, files: {} };
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch {}
  const fresh = !force && meta.format === INDEX_FORMAT;
  const records = new Map();
  const tasks = [];
  progress.totalFiles = files.length;
  progress.bytesTotal = 0;
  for (const f of files) {
    const m = fresh && meta.files[f.key];
    if (m && m.size === f.size && m.mtime === f.mtime && fs.existsSync(cacheFileFor(f.key))) {
      try {
        records.set(f.key, { ...f, ...JSON.parse(fs.readFileSync(cacheFileFor(f.key), 'utf8')) });
        progress.reused++; progress.doneFiles++;
        continue;
      } catch {}
    }
    const img = /\.img$/i.test(f.rel) && f.size >= 8;
    tasks.push({ ...f, img });
    progress.bytesTotal += f.size;
  }
  progress.state = tasks.length ? 'indexing' : 'ready';
  log(`индекс: файлов ${files.length}, из кэша ${progress.reused}, к разбору ${tasks.length}`);
  if (tasks.length) {
    tasks.sort((a, b) => b.size - a.size);
    const count = Math.max(1, Math.min(tasks.length, Math.min(6, os.cpus().length - 1 || 1)));
    await new Promise((resolve) => {
      let next = 0, active = 0;
      const workers = [];
      const startNext = (w) => {
        if (next >= tasks.length) { w.terminate(); if (--active === 0) resolve(); return; }
        const t = tasks[next++];
        w.current = t;
        progress.current = workers.filter((x) => x.current).map((x) => ({ key: x.current.key, done: 0, total: 0 }));
        w.postMessage({ key: t.key, abs: t.abs, img: t.img });
      };
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./index-worker.js', import.meta.url));
        workers.push(w); active++;
        w.on('message', (m) => {
          if (m.type === 'progress') {
            const c = progress.current.find((x) => x.key === m.key);
            if (c) { c.done = m.done; c.total = m.total; }
            return;
          }
          const t = w.current;
          w.current = null;
          const rec = m.record;
          if (rec.error) progress.errors.push({ key: t.key, error: rec.error });
          fs.writeFileSync(cacheFileFor(t.key), JSON.stringify(rec));
          meta.files[t.key] = { size: t.size, mtime: t.mtime };
          records.set(t.key, { ...t, ...rec });
          progress.doneFiles++; progress.reindexed++; progress.bytesDone += t.size;
          startNext(w);
        });
        w.on('error', (err) => {
          const t = w.current;
          if (t) { progress.errors.push({ key: t.key, error: String(err) }); records.set(t.key, { ...t, kind: 'error', error: String(err) }); progress.doneFiles++; }
          active--;
          if (active === 0) resolve();
        });
        startNext(w);
      }
    });
  }
  const keep = {};
  for (const f of files) if (meta.files[f.key]) keep[f.key] = meta.files[f.key];
  fs.writeFileSync(META, JSON.stringify({ format: INDEX_FORMAT, builtAt: new Date().toISOString(), files: keep }));
  Object.assign(progress, { state: 'ready', finishedAt: Date.now(), current: [] });
  return files.map((f) => records.get(f.key)).filter(Boolean);
}
