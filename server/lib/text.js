const cp1251 = new TextDecoder('windows-1251');
const utf8 = new TextDecoder('utf-8');

export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8.decode(buf.subarray(3));
  return cp1251.decode(buf);
}

export function splitFields(line) {
  const s = line.trim();
  if (!s) return [];
  if (s.includes(',')) return s.split(',').map((f) => f.trim());
  return s.split(/\s+/);
}

export function stripComment(line) {
  let s = line;
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  const d = s.indexOf('//');
  if (d >= 0) s = s.slice(0, d);
  return s.trim();
}

export function gameLine(raw) {
  return raw.replace(/[\x00-\x1f,]/g, ' ').trimStart();
}

export function forEachSectionLine(text, onLine, onDiag, keywords) {
  const lines = text.split('\n');
  let section = null, sectionLine = 0, stray = null;
  const flush = () => {
    if (!stray) return;
    const onlyEnd = stray.words.size === 1 && stray.words.has('end');
    const what = onlyEnd ? 'строка end вне секции' : `строк вне секции: ${stray.count} (первая — «${stray.first}»)`;
    onDiag({ line: stray.line, raw: stray.raw, message: `${what} — игра такие строки пропускает`, level: onlyEnd ? 'info' : 'warning' });
    stray = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const g = gameLine(raw);
    if (!g || g[0] === '#') continue;
    const h = g.indexOf('#');
    const s = (h >= 0 ? g.slice(0, h) : g).trim();
    if (!s) continue;
    if (section === null) {
      const kw = keywords.find((k) => s.startsWith(k));
      if (kw) { flush(); section = kw; sectionLine = i + 1; continue; }
      const word = s.split(/\s+/)[0];
      if (!stray) stray = { line: i + 1, raw: raw.trim(), count: 0, first: word.slice(0, 40), words: new Set() };
      stray.count++; stray.words.add(word);
      continue;
    }
    if (s.startsWith('end')) { section = null; continue; }
    onLine(section, s.split(/\s+/), i + 1, raw);
  }
  flush();
  if (section !== null) onDiag({ line: sectionLine, raw: (lines[sectionLine - 1] || '').trim(), message: `секция «${section}» не закрыта строкой end — игра читает её до конца файла` });
  return lines.length;
}

export const num = (s) => {
  if (s === undefined || s === '') return NaN;
  return Number(s);
};
