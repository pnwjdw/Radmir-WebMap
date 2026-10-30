import { decodeText } from './text.js';

const KEYWORDS = new Set(['IMG', 'IDE', 'IPL', 'COLFILE', 'TEXDICTION', 'MODELFILE', 'HIERFILE', 'SPLASH', 'CDIMAGE', 'IMGLIST', 'EXIT', 'MAPZONE', 'LEVEL']);

export function parseManifest(buf) {
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  const out = { entries: [], comments: 0, diagnostics: [] };
  lines.forEach((raw, i) => {
    let s = raw.trim();
    if (!s) return;
    let commented = false;
    if (s.startsWith('#')) {
      const body = s.replace(/^#+\s*/, '');
      const kw = body.split(/\s+/)[0].toUpperCase();
      if (!KEYWORDS.has(kw)) { out.comments++; return; }
      commented = true;
      s = body;
    }
    const m = /^(\S+)\s*(.*)$/.exec(s);
    const keyword = m[1].toUpperCase();
    if (!KEYWORDS.has(keyword)) { out.diagnostics.push({ line: i + 1, raw, message: `неизвестное ключевое слово «${m[1]}»` }); return; }
    let args = m[2].trim();
    let colfileZone = null;
    if (keyword === 'COLFILE') { const p = args.split(/\s+/); colfileZone = Number(p[0]); args = p.slice(1).join(' '); }
    out.entries.push({ line: i + 1, raw: raw.trim(), keyword, path: args.replace(/\//g, '\\'), active: !commented, colfileZone });
  });
  return out;
}
