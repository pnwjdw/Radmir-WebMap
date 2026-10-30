import fs from 'node:fs';

export const SECTOR = 2048;

export function readImgDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    const got = fs.readSync(fd, head, 0, 8, 0);
    if (got < 8) return { error: `файл короче заголовка (${got} байт)`, entries: [] };
    const sig = head.toString('latin1', 0, 4);
    if (sig !== 'VER2') return { error: `сигнатура «${sig.replace(/[^\x20-\x7e]/g, '.')}» вместо VER2 (зашифрованный или другой формат)`, entries: [] };
    const count = head.readUInt32LE(4);
    const size = fs.fstatSync(fd).size;
    const dir = Buffer.alloc(count * 32);
    fs.readSync(fd, dir, 0, dir.length, 8);
    const entries = [];
    const diagnostics = [];
    for (let i = 0; i < count; i++) {
      const o = i * 32;
      const offset = dir.readUInt32LE(o);
      const streaming = dir.readUInt16LE(o + 4), archived = dir.readUInt16LE(o + 6);
      const sectors = streaming || archived;
      let name = dir.toString('latin1', o + 8, o + 32);
      const z = name.indexOf('\0');
      if (z >= 0) name = name.slice(0, z);
      const e = { index: i, name, lower: name.toLowerCase(), offset, sectors, bytes: sectors * SECTOR };
      if (!name) diagnostics.push({ entry: i, offset: 8 + o, message: 'запись без имени' });
      if ((offset + sectors) * SECTOR > size) { e.error = 'данные выходят за пределы архива'; diagnostics.push({ entry: i, offset: 8 + o, name, message: e.error }); }
      if (!sectors) e.empty = true;
      entries.push(e);
    }
    return { count, size, entries, diagnostics };
  } finally {
    fs.closeSync(fd);
  }
}

class FdPool {
  constructor(limit = 48) { this.limit = limit; this.map = new Map(); }
  get(file) {
    let e = this.map.get(file);
    if (e) { this.map.delete(file); this.map.set(file, e); return e; }
    if (this.map.size >= this.limit) {
      const [k, v] = this.map.entries().next().value;
      fs.closeSync(v);
      this.map.delete(k);
    }
    e = fs.openSync(file, 'r');
    this.map.set(file, e);
    return e;
  }
  closeAll() { for (const fd of this.map.values()) fs.closeSync(fd); this.map.clear(); }
}
export const fdPool = new FdPool();

export function readRange(file, offset, length) {
  const buf = Buffer.alloc(length);
  const fd = fdPool.get(file);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

export function readEntry(file, entry) {
  return readRange(file, entry.offset * SECTOR, entry.sectors * SECTOR);
}

export function sniff(head) {
  if (!head || head.length === 0) return { kind: 'empty' };
  if (head.length < 4) return /^[\x09\x0a\x0d\x20-\x7e\x80-\xff]+$/.test(head.toString('latin1')) ? { kind: 'text' } : { kind: 'unknown' };
  const sig = head.toString('latin1', 0, 4);
  if (/^COL[L234]$/.test(sig)) return { kind: 'col', detail: sig };
  if (sig === 'bnry') return { kind: 'ipl-binary' };
  if (sig === 'ANP3' || sig === 'ANPK' || sig === 'ANP2') return { kind: 'ifp', detail: sig };
  if (head.length >= 12) {
    const type = head.readUInt32LE(0);
    if (type === 0x10 || type === 0x2b) return { kind: 'dff', detail: type === 0x2b ? 'UV anim dict + clump' : 'clump' };
    if (type === 0x16) return { kind: 'txd' };
  }
  if (head.every((b) => b === 0)) return { kind: 'empty' };
  const body = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head;
  if (!body.length || /^[\x09\x0a\x0d\x20-\x7e\x80-\xff]+$/.test(body.toString('latin1'))) return { kind: 'text', detail: body !== head ? 'UTF-8 с BOM' : undefined };
  return { kind: 'unknown' };
}
