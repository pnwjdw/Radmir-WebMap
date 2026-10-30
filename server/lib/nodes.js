export function parseNodes(buf) {
  if (buf.length < 20) return { error: `файл короче заголовка (${buf.length} байт)` };
  const n = buf.readUInt32LE(0), veh = buf.readUInt32LE(4), ped = buf.readUInt32LE(8), navi = buf.readUInt32LE(12), links = buf.readUInt32LE(16);
  const need = 20 + n * 28 + navi * 14 + links * 4;
  if (n !== veh + ped || need > buf.length) return { error: `заголовок не сходится с размером: узлов ${n} (${veh}+${ped}), navi ${navi}, связей ${links}, нужно ${need} байт из ${buf.length}` };
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const o = 20 + i * 28;
    const flags = buf.readUInt32LE(o + 24);
    nodes.push({
      x: buf.readInt16LE(o + 8) / 8, y: buf.readInt16LE(o + 10) / 8, z: buf.readInt16LE(o + 12) / 8,
      link: buf.readUInt16LE(o + 16), area: buf.readUInt16LE(o + 18), id: buf.readUInt16LE(o + 20),
      width: buf[o + 22], links: flags & 15, flags, type: i < veh ? 'veh' : 'ped',
    });
  }
  const linkBase = 20 + n * 28 + navi * 14;
  const linkList = [];
  for (let i = 0; i < links; i++) linkList.push([buf.readUInt16LE(linkBase + i * 4), buf.readUInt16LE(linkBase + i * 4 + 2)]);
  return { counts: { nodes: n, vehicle: veh, ped, navi, links }, nodes, links: linkList };
}
