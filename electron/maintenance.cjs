const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, safePath } = require('./storage.cjs');
const DAY = 86400000;
function files(root) {
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    const target = path.join(root, e.name);
    return e.isDirectory() ? files(target) : e.isFile() ? [target] : [];
  });
}
function inspect(dataRoot, grokRoot) {
  const categories = ['checkpoints', 'turn-changes', 'inbox', 'rewind-backups', 'backups', 'trash', 'logs'];
  const usage = categories.map(name => ({ name, bytes: files(path.join(dataRoot, name)).reduce((n, f) => n + fs.statSync(f).size, 0) }));
  const references = new Set();
  const candidates = files(path.join(dataRoot, 'inbox'));
  const names = candidates.map(f => path.basename(f));
  const sources = [path.join(dataRoot, 'composer.json'), ...files(path.join(grokRoot, 'sessions')), ...files(path.join(dataRoot, 'rewind-backups')), ...files(path.join(dataRoot, 'trash'))];
  for (const file of sources) {
    if (!fs.existsSync(file) || !/\.(jsonl?|md|txt)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const name of names) if (text.includes(name)) references.add(name);
  }
  const removable = candidates.filter(f => !references.has(path.basename(f)) && Date.now() - fs.statSync(f).mtimeMs > 7 * DAY);
  for (const category of ['backups', 'rewind-backups', 'trash']) {
    const root = path.join(dataRoot, category);
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).map(n => path.join(root, n)).filter(f => !fs.lstatSync(f).isSymbolicLink()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    // Keep the latest three safety backups regardless of age.
    removable.push(...entries.slice(3).filter(f => Date.now() - fs.statSync(f).mtimeMs > 30 * DAY));
  }
  return { usage, removable: removable.map(f => ({ path: path.relative(dataRoot, f), bytes: fs.statSync(f).isDirectory() ? files(f).reduce((n, x) => n + fs.statSync(x).size, 0) : fs.statSync(f).size })) };
}
function cleanup(dataRoot, grokRoot, approved) {
  const current = inspect(dataRoot, grokRoot);
  const selected = new Set(approved || []);
  let count = 0;
  for (const row of current.removable) if (selected.has(row.path)) {
    const target = safePath(dataRoot, row.path);
    fs.rmSync(target, { recursive: true }); count++;
  }
  return { count, ...inspect(dataRoot, grokRoot) };
}
function forgetComposer(dataRoot, id) {
  const value = readJson(path.join(dataRoot, 'composer.json'), {});
  delete value[id]; writeJson(path.join(dataRoot, 'composer.json'), value);
  // The fallback must not resurrect deleted drafts.
  writeJson(path.join(dataRoot, 'composer.json'), value);
}
module.exports = { inspect, cleanup, forgetComposer };
