const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const changes = require('../electron/turn-changes.cjs');
const cache = 'E:/VsCodeProject/Agent缓存文件/temp/halora-turn-changes';
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'test-'));
const dir = name => { const value = path.join(root, name); fs.mkdirSync(value, { recursive: true }); return value; };
const put = (cwd, name, text) => { const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
const get = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
function repo(name) {
  const cwd = dir(name);
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'Test']); git(cwd, ['config', 'user.email', 'test@example.invalid']);
  put(cwd, '.gitignore', 'ignored/\n'); put(cwd, '代码.txt', 'initial\n');
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'initial']);
  return cwd;
}
const turn = n => ({ sessionId: 'chat', turnId: `chat:${n}`, startedAt: n });

test('turn summary compares against dirty pre-turn contents and undo preserves the index and unrelated edits', async () => {
  const cwd = repo('dirty'), data = dir('dirty-data');
  put(cwd, '代码.txt', 'user staged\n'); git(cwd, ['add', '.']); put(cwd, '代码.txt', 'user draft\n');
  put(cwd, 'existing.txt', 'existing untracked\n'); put(cwd, 'ignored/private.txt', 'private');
  const before = await changes.capture(cwd);
  put(cwd, '代码.txt', 'agent result\n'); put(cwd, 'new file.txt', 'one\ntwo\n');
  const record = await changes.finish(data, cwd, turn(1), before);
  assert.equal(record.files.length, 2); assert.equal(record.added, 3); assert.equal(record.removed, 1);
  assert.match(changes.diff(data, cwd, record.id, '代码.txt').text, /-user draft\n\+agent result/);
  put(cwd, 'existing.txt', 'later unrelated edit');
  assert.equal(changes.undo(data, cwd, record.id).undone, true);
  assert.equal(get(cwd, '代码.txt'), 'user draft\n'); assert.equal(get(cwd, 'existing.txt'), 'later unrelated edit');
  assert.equal(get(cwd, 'ignored/private.txt'), 'private'); assert.equal(fs.existsSync(path.join(cwd, 'new file.txt')), false);
  assert.equal(git(cwd, ['show', ':代码.txt']), 'user staged\n');
  assert.equal(changes.list(data, cwd, 'chat')[0].undone, true);
  assert.throws(() => changes.undo(data, cwd, record.id), /已撤销/);
});

test('later changes block the entire undo before any file is touched; historical diff stays fixed', async () => {
  const cwd = repo('conflict'), data = dir('conflict-data');
  const before = await changes.capture(cwd);
  put(cwd, '代码.txt', 'agent\n'); put(cwd, 'z.txt', 'new');
  const record = await changes.finish(data, cwd, turn(2), before);
  put(cwd, 'z.txt', 'later change');
  assert.throws(() => changes.undo(data, cwd, record.id), /后来又被修改/);
  assert.equal(get(cwd, '代码.txt'), 'agent\n'); assert.equal(get(cwd, 'z.txt'), 'later change');
  assert.equal(changes.list(data, cwd, 'chat')[0].undone, false);
  assert.match(changes.diff(data, cwd, record.id, 'z.txt').text, /\+new/);
  assert.doesNotMatch(changes.diff(data, cwd, record.id, 'z.txt').text, /later change/);
});

test('plain folders capture additions, empty files, binary files and deletions; no-op turns have no card', async () => {
  const cwd = dir('plain'), data = dir('plain-data');
  put(cwd, 'gone.txt', 'old\n'); put(cwd, 'node_modules/package/a', 'skip');
  const before = await changes.capture(cwd);
  assert.equal(await changes.finish(data, cwd, turn(3), before), null);
  fs.unlinkSync(path.join(cwd, 'gone.txt')); put(cwd, 'empty.txt', ''); put(cwd, 'pic.bin', Buffer.from([0, 1, 2]));
  const record = await changes.finish(data, cwd, turn(3), before);
  assert.equal(record.files.length, 3); assert.equal(record.removed, 1);
  assert.equal(record.files.find(f => f.path === 'pic.bin').added, null);
  assert.equal(changes.diff(data, cwd, record.id, 'pic.bin').binary, true);
  changes.undo(data, cwd, record.id);
  assert.equal(get(cwd, 'gone.txt'), 'old\n'); assert.equal(fs.existsSync(path.join(cwd, 'empty.txt')), false);
  assert.equal(get(cwd, 'node_modules/package/a'), 'skip');
});

test('file/directory transitions are reversible and later descendants block undo', async () => {
  const cwd = repo('transition'), data = dir('transition-data'); put(cwd, 'slot', 'original');
  const before = await changes.capture(cwd);
  fs.unlinkSync(path.join(cwd, 'slot')); put(cwd, 'slot/nested/child', 'new');
  const record = await changes.finish(data, cwd, turn(4), before);
  put(cwd, 'slot/later', 'keep');
  assert.throws(() => changes.undo(data, cwd, record.id), /后续新增文件/);
  assert.equal(get(cwd, 'slot/nested/child'), 'new');
  fs.unlinkSync(path.join(cwd, 'slot/later')); changes.undo(data, cwd, record.id);
  assert.equal(get(cwd, 'slot'), 'original');
  const next = await changes.capture(cwd);
  fs.unlinkSync(path.join(cwd, 'slot')); put(cwd, 'slot/child', 'directory baseline');
  const intermediate = await changes.capture(cwd);
  fs.unlinkSync(path.join(cwd, 'slot/child')); fs.rmdirSync(path.join(cwd, 'slot')); put(cwd, 'slot', 'file again');
  const reverse = await changes.finish(data, cwd, turn(5), intermediate);
  changes.undo(data, cwd, reverse.id);
  assert.equal(get(cwd, 'slot/child'), 'directory baseline');
  assert.ok(next.files.slot);
});

test('new ignore rules do not misreport existing files as deleted, and sessions stay separate', async () => {
  const cwd = repo('ignore'), data = dir('ignore-data'); put(cwd, 'draft.txt', 'keep');
  const before = await changes.capture(cwd);
  put(cwd, '.gitignore', 'ignored/\ndraft.txt\n');
  const record = await changes.finish(data, cwd, turn(6), before);
  assert.deepEqual(record.files.map(f => f.path), ['.gitignore']);
  assert.equal(changes.list(data, cwd, 'other-chat').length, 0);
  assert.throws(() => changes.diff(data, cwd, record.id, '../outside'), /不属于/);
  assert.throws(() => changes.load(data, dir('other-project'), record.id), /找不到/);
  changes.undo(data, cwd, record.id); assert.equal(get(cwd, 'draft.txt'), 'keep');
});

test('change card opens a side drawer and file rows can collapse it', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/TurnChanges.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/turn-changes.css'), 'utf8');
  assert.match(ui, /toggle\(record, file\.path\)/);
  assert.match(ui, /className="change-drawer"/);
  assert.match(ui, /className="change-chevron"/);
  assert.doesNotMatch(ui, /className="change-review"/);
  assert.equal(/[⌃⌄]/.test(ui), false);
  assert.match(css, /\.change-drawer\{/);
  assert.match(css, /transform:translateX\(calc\(100% \+ 24px\)\) scale\(\.98\)/);
  assert.match(css, /transition:transform var\(--panel-duration\) var\(--panel-ease\)/);
  assert.match(css, /\.main-stage-chat\{/);
  assert.match(ui, /setOpen\(false\)/);
  assert.match(css, /\.change-expand\[aria-expanded=true\] \.change-chevron\{transform:rotate\(180deg\)\}/);
});

test('failed or concurrent captures persist a warning without enabling destructive operations', async () => {
  const cwd = dir('warning'), data = dir('warning-data');
  const record = await changes.finish(data, cwd, turn(7), null, '无法单独记录本轮修改');
  assert.equal(record.files.length, 0); assert.match(changes.list(data, cwd, 'chat')[0].warning, /无法/);
  assert.throws(() => changes.undo(data, cwd, record.id));
});

test('application backup preserves change cards and their undo contents', async () => {
  const archives = require('../electron/archives.cjs');
  const cwd = dir('backup-project'), data = dir('backup-data'), restored = dir('backup-restored'), grok = dir('backup-grok');
  put(cwd, 'a', 'before'); const before = await changes.capture(cwd); put(cwd, 'a', 'after');
  const record = await changes.finish(data, cwd, turn(8), before);
  const file = path.join(root, 'changes.halora'); archives.createBackup(data, grok, file);
  archives.restoreBackup(restored, grok, file, archives.parseBackup(file).fingerprint);
  assert.equal(changes.list(restored, cwd, 'chat')[0].id, record.id);
  changes.undo(restored, cwd, record.id); assert.equal(get(cwd, 'a'), 'before');
});
