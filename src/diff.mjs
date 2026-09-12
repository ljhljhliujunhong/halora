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
