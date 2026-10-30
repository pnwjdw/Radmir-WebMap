export const CHUNK = {
  STRUCT: 0x01, STRING: 0x02, EXTENSION: 0x03, CAMERA: 0x05, TEXTURE: 0x06, MATERIAL: 0x07, MATLIST: 0x08,
  FRAMELIST: 0x0e, GEOMETRY: 0x0f, CLUMP: 0x10, LIGHT: 0x12, ATOMIC: 0x14, TEXNATIVE: 0x15, TEXDICT: 0x16,
  GEOMLIST: 0x1a, ANIMANIMATION: 0x1b, RIGHTTORENDER: 0x1f, UVANIMDICT: 0x2b,
  MORPH: 0x105, SKIN: 0x116, HANIM: 0x11e, MATEFFECTS: 0x120, UVANIM: 0x135, BINMESH: 0x50e, NATIVEDATA: 0x510,
  PIPELINE: 0x253f2f3, SPECULAR: 0x253f2f6, EFFECT2D: 0x253f2f8, EXTRAVERTCOLOR: 0x253f2f9, COLLISION: 0x253f2fa,
  REFLECTION: 0x253f2fc, BREAKABLE: 0x253f2fd, FRAMENAME: 0x253f2fe,
};

export const CHUNK_NAMES = {
  0x01: 'Struct', 0x02: 'String', 0x03: 'Extension', 0x05: 'Camera', 0x06: 'Texture', 0x07: 'Material',
  0x08: 'Material List', 0x0e: 'Frame List', 0x0f: 'Geometry', 0x10: 'Clump', 0x12: 'Light', 0x14: 'Atomic',
  0x15: 'Texture Native', 0x16: 'Texture Dictionary', 0x1a: 'Geometry List', 0x1b: 'Animation Animation',
  0x1f: 'Right To Render', 0x2b: 'UV Animation Dictionary', 0x105: 'Morph PLG', 0x116: 'Skin PLG', 0x11e: 'HAnim PLG',
  0x120: 'Material Effects PLG', 0x135: 'UV Animation PLG', 0x50e: 'Bin Mesh PLG', 0x510: 'Native Data PLG',
  0x253f2f3: 'Pipeline Set (Rockstar)', 0x253f2f6: 'Specular Material (Rockstar)', 0x253f2f8: '2d Effect (Rockstar)',
  0x253f2f9: 'Extra Vert Colour (Rockstar)', 0x253f2fa: 'Collision Model (Rockstar)', 0x253f2fc: 'Reflection Material (Rockstar)',
  0x253f2fd: 'Breakable (Rockstar)', 0x253f2fe: 'Frame Name (Rockstar)',
};

export function decodeVersion(libId) {
  if (libId & 0xffff0000) {
    return { version: (((libId >>> 14) & 0x3ff00) + 0x30000) | ((libId >>> 16) & 0x3f), build: libId & 0xffff };
  }
  return { version: libId << 8, build: 0 };
}

export function versionString(v) {
  return `${(v >> 16) & 0xf}.${(v >> 12) & 0xf}.${(v >> 8) & 0xf}.${v & 0xff}`;
}

export function versionGame(v) {
  if (v === 0x36003) return 'GTA San Andreas (PC)';
  if (v === 0x34003 || v === 0x34005) return 'GTA Vice City';
  if (v === 0x33002 || v === 0x31001 || v === 0x30400 || v === 0x35000) return 'GTA III / Vice City (ранние версии)';
  return 'неизвестная игра';
}

export function readChunk(buf, off, end = buf.length) {
  if (off + 12 > end) return null;
  const type = buf.readUInt32LE(off);
  const size = buf.readUInt32LE(off + 4);
  const libId = buf.readUInt32LE(off + 8);
  const start = off + 12;
  const stop = start + size;
  if (stop > end) return { type, size, libId, start, end: end, truncated: true, ...decodeVersion(libId) };
  return { type, size, libId, start, end: stop, truncated: false, ...decodeVersion(libId) };
}

export function children(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 12 <= end) {
    const c = readChunk(buf, off, end);
    if (!c) break;
    out.push(c);
    if (c.truncated || c.end <= off) break;
    off = c.end;
  }
  return out;
}

export function readString(buf, c) {
  let s = buf.toString('latin1', c.start, c.end);
  const z = s.indexOf('\0');
  if (z >= 0) s = s.slice(0, z);
  return s;
}

export function chunkTree(buf, start, end, depth = 0, budget = { n: 400 }) {
  const out = [];
  const containers = new Set([0x03, 0x06, 0x07, 0x08, 0x0e, 0x0f, 0x10, 0x14, 0x16, 0x1a, 0x15, 0x2b]);
  for (const c of children(buf, start, end)) {
    if (budget.n-- <= 0) break;
    const node = { type: c.type, name: CHUNK_NAMES[c.type] || `0x${c.type.toString(16)}`, size: c.size, version: versionString(c.version) };
    if (c.truncated) node.truncated = true;
    if (containers.has(c.type) && depth < 6) node.children = chunkTree(buf, c.start, c.end, depth + 1, budget);
    out.push(node);
  }
  return out;
}
