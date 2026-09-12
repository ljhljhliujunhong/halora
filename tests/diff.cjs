const test = require('node:test');
const assert = require('node:assert/strict');
const { diffRows } = require('../src/diff.mjs');
test('diff numbers distinguish file headers, edits, context and separate hunks', () => {
  const rows = diffRows('diff --git a/f b/f\r\n--- a/f\r\n+++ b/f\r\n@@ -7,2 +7,2 @@\r\n-old\r\n+new\r\n same\r\n@@ -20,0 +21,2 @@\r\n+++code\r\n+second\r\n\\ No newline at end of file\r\n');
  assert.equal(rows[2].kind, 'meta');
  assert.deepEqual([rows[4].old,rows[4].next,rows[4].kind], [7,'','remove']);
  assert.deepEqual([rows[5].old,rows[5].next,rows[5].kind], ['',7,'add']);
  assert.deepEqual([rows[6].old,rows[6].next], [8,8]);
  assert.equal(rows[8].next,21); assert.equal(rows[8].kind,'add');
  assert.equal(rows[9].next,22); assert.equal(rows[10].kind,'meta');
});
