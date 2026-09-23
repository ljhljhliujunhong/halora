export function settledChangeStats(record) {
  if (!record || !Array.isArray(record.files) || !record.files.length) return null;
  if (typeof record.added !== "number" || typeof record.removed !== "number") return null;
  return { plus: record.added, minus: record.removed };
}

// Unified diff line numbers reset at each hunk; file headers aren't edits.
export function diffRows(text) {
  let old = 0, next = 0, inHunk = false;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    const row = { text, kind: 'meta', old: '', next: '' };
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; row.kind = 'hunk'; }
    else if (text.startsWith('diff --git ')) inHunk = false;
    else if (inHunk && text.startsWith('+')) { row.kind = 'add'; row.next = next++; }
    else if (inHunk && text.startsWith('-')) { row.kind = 'remove'; row.old = old++; }
    else if (inHunk && text.startsWith(' ')) { row.kind = 'context'; row.old = old++; row.next = next++; }
    return row;
  });
}

export function diffSections(text) {
  const sections = [];
  let lastOld = null, lastNext = null;
  for (const row of diffRows(text)) {
    if (row.kind === 'meta') continue;
    if (row.kind === 'hunk') {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row.text);
      if (!hunk) continue;
      const oldStart = Number(hunk[1]), nextStart = Number(hunk[2]);
      if (oldStart !== 0) {
        const count = Math.max(0, oldStart - (lastOld == null ? 1 : lastOld), nextStart - (lastNext == null ? 1 : lastNext));
        if (count > 0) sections.push({ kind: 'unmodified', count, old: '', next: '', text: `${count} 行未修改` });
      }
      continue;
    }
    sections.push(row);
    if (row.old !== '') lastOld = Number(row.old) + 1;
    if (row.next !== '') lastNext = Number(row.next) + 1;
  }
  return sections;
}
