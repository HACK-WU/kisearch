// usage: node scan-dup.mjs — 找 kafka 组内「同 kind + 同文本」重复块的文档
const BASE = 'http://127.0.0.1:7423';
const SCOPE = 'kafka';
const strip = (s) => s.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
const kind = (line) => {
  if (/^#{1,6}\s/.test(line)) return 'h';
  if (/^\s*[-*+]\s+/.test(line)) return 'li';
  if (/^\s*\d+\.\s+/.test(line)) return 'li';
  return null;
};
const list = await (await fetch(`${BASE}/api/doc/list?scope=${SCOPE}`)).json();
const out = [];
for (const d of list.docs) {
  const r = await (await fetch(`${BASE}/api/doc/edit?${new URLSearchParams({ scope: SCOPE, group: d.group, relation: d.name })}`)).json();
  const content = r.content || '';
  const counts = new Map();
  let inTable = false;
  for (const line of content.split('\n')) {
    if (/^\s*\|/.test(line)) {
      inTable = true;
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
        for (const cell of line.split('|').slice(1, -1)) {
          const t = strip(cell);
          if (t) counts.set('td|' + t, (counts.get('td|' + t) || 0) + 1);
        }
      }
      continue;
    }
    inTable = false;
    const k = kind(line);
    if (!k) continue;
    const t = strip(k === 'h' ? line.replace(/^#{1,6}\s+/, '') : line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
    if (t.length >= 4) counts.set(k + '|' + t, (counts.get(k + '|' + t) || 0) + 1);
  }
  const dups = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (dups.length) out.push({ name: d.name, dupCount: dups.length, sample: dups[0][0].slice(0, 58), times: dups[0][1] });
}
console.log(JSON.stringify(out, null, 1));
