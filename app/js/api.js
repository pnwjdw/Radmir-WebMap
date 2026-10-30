export async function getJson(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch {  }
  if (!r.ok) {
    const e = new Error((body && body.error) || `${r.status} ${r.statusText}`);
    e.status = r.status; e.details = body && body.details;
    throw e;
  }
  return body;
}

export async function sendJson(url, method, data) {
  return getJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

export async function getBuffer(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const b = await r.json(); if (b && b.error) msg = b.error; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r.arrayBuffer();
}

export function decodeInstances(buf, offset = 0) {
  const dv = new DataView(buf, offset);
  const n = Math.floor(dv.byteLength / 48);
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const o = k * 48;
    const packed = dv.getUint32(o + 44, true);
    out[k] = {
      iid: dv.getUint32(o, true), mi: dv.getInt32(o + 4, true),
      x: dv.getFloat32(o + 8, true), y: dv.getFloat32(o + 12, true), z: dv.getFloat32(o + 16, true),
      qx: dv.getFloat32(o + 20, true), qy: dv.getFloat32(o + 24, true), qz: dv.getFloat32(o + 28, true), qw: dv.getFloat32(o + 32, true),
      interior: dv.getInt32(o + 36, true), lod: dv.getInt32(o + 40, true), src: packed >>> 16, flags: packed & 0xffff,
    };
  }
  return out;
}

export function decodeCells(buf) {
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const counts = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const start = 4 + hl + ((4 - (hl % 4)) % 4);
  return { counts, instances: decodeInstances(buf, start) };
}

function headerOf(buf, magic) {
  const dv = new DataView(buf);
  const m = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (m !== magic) throw new Error(`ожидался формат ${magic}, получено ${m}`);
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  const base = 8 + hl + ((4 - ((8 + hl) % 4)) % 4);
  return { header, base };
}

export function decodeModel(buf) {
  const { header, base } = headerOf(buf, 'RMG1');
  const view = (ref, Type) => (ref ? new Type(buf, base + ref[0], ref[1]) : null);
  for (const g of header.geometries) {
    const b = g.buffers || {};
    g.arrays = {
      position: view(b.position, Float32Array), normal: view(b.normal, Float32Array), uv0: view(b.uv0, Float32Array), uv1: view(b.uv1, Float32Array),
      color: view(b.color, Uint8Array), night: view(b.night, Uint8Array), index: view(b.index, g.indexType === 'u32' ? Uint32Array : Uint16Array), tri: view(b.tri, Uint32Array),
    };
  }
  return header;
}

export function decodeTexture(buf) {
  const { header, base } = headerOf(buf, 'RMT1');
  header.mips = header.mips.map((m) => ({ width: m.w, height: m.h, data: new Uint8Array(buf, base + m.off, m.len) }));
  return header;
}

export function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export function toCsv(rows, columns) {
  const q = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [columns.map(q).join(';'), ...rows.map((r) => columns.map((c) => q(r[c])).join(';'))].join('\r\n');
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
