import { sniff } from './img.js';
import { stripComment } from './text.js';

const IDE_SECTIONS = new Set(['objs', 'tobj', 'anim', 'weap', 'peds', 'hier', 'txdp', '2dfx', 'tanm']);
const IPL_SECTIONS = new Set(['inst', 'zone', 'cull', 'grge', 'enex', 'pick', 'jump', 'tcyc', 'auzo', 'mult', 'occl']);

export function classifyBuffer(buf, ext) {
  if (buf.length === 0) return { kind: 'empty', reason: 'файл пуст (0 байт)' };
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'VER2') return { kind: 'img', reason: 'сигнатура VER2' };
  const s = sniff(buf.subarray(0, 16));
  if (s.kind === 'dff' || s.kind === 'txd' || s.kind === 'col' || s.kind === 'ifp' || s.kind === 'ipl-binary') return { kind: s.kind, reason: s.detail || s.kind };
  if (buf.subarray(0, 4).toString('hex') === '72174a33') return { kind: 'encrypted', reason: 'сигнатура шифрования RADMIR (72174a33)' };
  if (s.kind !== 'text') return { kind: s.kind, reason: 'не распознан по содержимому' };
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('latin1', bom ? 3 : 0, Math.min(buf.length, 65536));
  let manifest = 0, ide = 0, ipl = 0, cars = 0, pathSec = 0, iniSections = 0, assignments = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*;/.test(raw)) continue;
    if (/^\s*\[[^\]]+\]\s*$/.test(raw)) { iniSections++; continue; }
    const line = stripComment(raw);
    if (!line) continue;
    if (/^[^=,]+=[^=]*$/.test(line)) assignments++;
    const low = line.toLowerCase();
    if (/^(img|ide|ipl|colfile|texdiction|modelfile|splash|cdimage|imglist)\s+\S/.test(low)) manifest++;
    else if (IDE_SECTIONS.has(low)) ide++;
    else if (IPL_SECTIONS.has(low)) ipl++;
    else if (low === 'cars') cars++;
    else if (low === 'path') pathSec++;
  }
  const enc = bom ? ', UTF-8 с BOM' : '';
  if (iniSections >= 2 && assignments > manifest) return { kind: 'text', reason: `INI-настройки: секций [..] ${iniSections}, присваиваний ${assignments}` };
  if (manifest && !ide && !ipl) return { kind: 'manifest', reason: `строк манифеста: ${manifest}${enc}` };
  if (ide > ipl) return { kind: 'ide', reason: `секций IDE: ${ide}` };
  if (ipl > ide) return { kind: 'ipl', reason: `секций IPL: ${ipl}` };
  if (cars || pathSec) {
    const e = (ext || '').toLowerCase();
    if (e === '.ide') return { kind: 'ide', reason: 'секции cars/path, по расширению .ide' };
    return { kind: 'ipl', reason: 'секции cars/path, по расширению' };
  }
  const e = (ext || '').toLowerCase();
  if (e === '.ipl' || e === '.zon') return { kind: 'ipl', reason: `нет секций; по расширению — пустой IPL${enc}` };
  if (e === '.ide') return { kind: 'ide', reason: `нет секций; по расширению — пустой IDE${enc}` };
  return { kind: 'text', reason: `текст без известных секций${enc}` };
}
