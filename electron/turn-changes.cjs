const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { git } = require('./review.cjs');
const { safePath, readJson, writeJson, atomicWrite } = require('./storage.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.turbo', 'Agent缓存文件']);
const LIMIT = 64 * 1024 * 1024;
const folder = (dataRoot, cwd) => path.join(dataRoot, 'turn-changes', hash(path.resolve(cwd).toLowerCase()));
function recordPath(dataRoot, cwd, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw new Error('无效的修改记录');
  return path.join(folder(dataRoot, cwd), `${id}.json`);
}
function readFile(cwd, name) {
  const file = safePath(cwd, name);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
  if (stat.isDirectory()) return null;
  if (!stat.isFile()) throw new Error(`不支持备份此文件：${name}`);
  if (stat.size > LIMIT) throw new Error(`文件超过 64 MB：${name}`);
  const bytes = fs.readFileSync(file);
  return { data: bytes.toString('base64'), hash: hash(bytes), mode: stat.mode };
}
const equal = (a, b) => (a?.hash || null) === (b?.hash || null) && (a?.mode || null) === (b?.mode || null);

async function capture(cwd, knownNames = []) {
  const root = path.resolve(cwd);
  let names;
  try {
    names = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  } catch (e) {
    if (!/not a git repository|ENOENT/i.test(e.message)) throw e;
    names = [];
    let entriesSeen = 0;
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++entriesSeen > 20000) throw new Error('项目过大，无法记录完整修改');
        if (ignored.has(entry.name)) continue;
        const name = prefix + entry.name;
        safePath(root, name);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), name + '/');
        else names.push(name);
      }
    };
    walk(root);
  }
  names = [...new Set([...names, ...knownNames])].sort();
  if (names.length > 10000) throw new Error('项目超过 10,000 个文件，无法记录完整修改');
  const files = Object.create(null);
  let bytes = 0;
  for (const name of names) {
    // Nested repositories and symlinks cannot be represented by a file snapshot.
    const target = safePath(root, name);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      if (fs.existsSync(path.join(target, '.git'))) throw new Error(`无法记录嵌套仓库：${name}`);
      continue;
    }
    const value = readFile(root, name);
    if (!value) continue;
    bytes += Buffer.byteLength(value.data, 'base64');
    if (bytes > LIMIT) throw new Error('项目内容超过 64 MB，无法记录完整修改');
    files[name] = value;
  }
  return { cwd: root, files };
}

function patchFor(dataRoot, name, before, after) {
  const oldBytes = Buffer.from(before?.data || '', 'base64');
  const newBytes = Buffer.from(after?.data || '', 'base64');
  if (oldBytes.includes(0) || newBytes.includes(0)) return { text: '二进制文件已修改', binary: true, added: null, removed: null };
  if (Math.max(oldBytes.length, newBytes.length) > 512 * 1024) return { text: '文件超过 512 KB，无法显示行差异。', binary: true, added: null, removed: null };
  const tempRoot = path.join(dataRoot, 'turn-changes', 'diff-temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'diff-'));
  let body;
  try {
    fs.writeFileSync(path.join(temp, 'before'), oldBytes);
    fs.writeFileSync(path.join(temp, 'after'), newBytes);
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=3', '--', 'before', 'after'], { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status)) throw result.error || new Error(result.stderr || '无法生成差异');
    const offset = result.stdout.indexOf('@@ ');
    body = offset < 0 ? '' : result.stdout.slice(offset);
  } catch (e) {
    // Plain folders can still be reviewed on machines without Git.
    if (e.code !== 'ENOENT') throw e;
    const lines = bytes => { const rows = bytes.toString('utf8').split('\n'); if (rows.at(-1) === '') rows.pop(); return rows; };
    const oldLines = lines(oldBytes), newLines = lines(newBytes);
    body = `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n` + [...oldLines.map(s => '-' + s), ...newLines.map(s => '+' + s)].join('\n');
  } finally {
    for (const file of ['before', 'after']) fs.rmSync(path.join(temp, file), { force: true });
    fs.rmdirSync(temp);
  }
  const rows = body.split('\n');
  return { text: body ? `--- ${before ? name : '/dev/null'}\n+++ ${after ? name : '/dev/null'}\n${body}` : '', binary: false, added: rows.filter(s => s.startsWith('+')).length, removed: rows.filter(s => s.startsWith('-')).length };
}

function load(dataRoot, cwd, id) {
  const record = readJson(recordPath(dataRoot, cwd, id), null);
  if (!record || record.cwd !== path.resolve(cwd) || record.id !== id) throw new Error('找不到此项目的修改记录');
  return record;
}
function list(dataRoot, cwd, sessionId) {
  const dir = folder(dataRoot, cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJson(path.join(dir, n), null))
    .filter(r => r?.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt);
}
function save(dataRoot, record) { writeJson(recordPath(dataRoot, record.cwd, record.id), record); return record; }
async function finish(dataRoot, cwd, turn, before, warning = '') {
  const record = { id: crypto.randomUUID(), cwd: path.resolve(cwd), ...turn, files: [], added: 0, removed: 0, warning, undone: false };
  if (warning || !before) return save(dataRoot, record);
  const after = await capture(cwd, Object.keys(before.files));
  const changes = Object.create(null);
  for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const old = before.files[name] || null, next = after.files[name] || null;
    if (equal(old, next)) continue;
    const patch = patchFor(dataRoot, name, old, next);
    changes[name] = { before: old, after: next, patch };
    record.files.push({ path: name, action: !old ? '新增' : !next ? '删除' : '修改', added: patch.added, removed: patch.removed });
    record.added += patch.added || 0;
    record.removed += patch.removed || 0;
  }
  if (!record.files.length) return null;
  const content = zlib.gzipSync(Buffer.from(JSON.stringify(changes)));
  record.contentHash = hash(content);
  atomicWrite(recordPath(dataRoot, cwd, record.id) + '.gz', content);
  return save(dataRoot, record);
}
function contents(dataRoot, cwd, record) {
  const bytes = fs.readFileSync(recordPath(dataRoot, cwd, record.id) + '.gz');
  if (hash(bytes) !== record.contentHash) throw new Error('修改记录校验失败');
  const changes = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }));
  for (const name of Object.keys(changes)) {
    safePath(cwd, name);
    if (name.split(/[\\/]/).some(p => p.toLowerCase() === '.git')) throw new Error('不能修改 Git 内部文件');
  }
  return changes;
}
function diff(dataRoot, cwd, id, file) {
  const changes = contents(dataRoot, cwd, load(dataRoot, cwd, id));
  if (!Object.hasOwn(changes, file)) throw new Error('文件不属于这次修改');
  return changes[file].patch;
}
function undo(dataRoot, cwd, id) {
  const record = load(dataRoot, cwd, id);
  if (record.undone) throw new Error('这次修改已撤销');
  const changes = contents(dataRoot, cwd, record);
  // Validate every affected file before writing anything; unrelated files are untouched.
  for (const [name, value] of Object.entries(changes)) {
    if (!equal(readFile(cwd, name), value.after)) throw new Error(`${name} 后来又被修改，未执行撤销`);
    const target = safePath(cwd, name);
    if (value.before && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const check = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const rel = path.relative(cwd, file).replace(/\\/g, '/');
        if (entry.isDirectory()) check(file);
        else if (!Object.hasOwn(changes, rel) || changes[rel].before) throw new Error(`${name} 中有后续新增文件，未执行撤销`);
      } };
      check(target);
    }
  }
  const apply = side => {
    for (const [name, value] of Object.entries(changes)) if (!value[side]) {
      const target = safePath(cwd, name);
      if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) fs.unlinkSync(target);
    }
    const emptyDirectory = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('目录中出现新文件，撤销已停止');
        emptyDirectory(path.join(dir, entry.name));
      }
      fs.rmdirSync(dir);
    };
    for (const [name, value] of Object.entries(changes)) if (value[side]) {
      const target = safePath(cwd, name);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) emptyDirectory(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(value[side].data, 'base64'));
      fs.chmodSync(target, value[side].mode);
    }
  };
  try {
    apply('before');
    return save(dataRoot, { ...record, undone: true });
  } catch (error) {
    try { apply('after'); } catch { throw new Error(`${error.message}；恢复未完成，原始内容保存在修改记录 ${record.id}`); }
    throw error;
  }
}
module.exports = { capture, finish, list, load, diff, undo };
