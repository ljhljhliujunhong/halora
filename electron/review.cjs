const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { readJson, writeJson, safePath } = require('./storage.cjs');

function git(cwd, args, extra = false) {
  const binary = extra === true || extra?.binary === true;
  const timeout = Number(extra?.timeout) > 0 ? extra.timeout : 20000;
  const env = extra?.network ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : process.env;
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args],
    { windowsHide: true, encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
}
function gitFail(err) {
  const text = String(err.message || err);
  if (/Could not read from remote|unable to access|Could not resolve host|Failed to connect/i.test(text)) return new Error('连不上远程仓库');
  if (/Authentication failed|Permission denied \(publickey\)|could not read Username|could not read Password/i.test(text)) return new Error('远程仓库验证失败');
  if (/failed to push some refs|non-fast-forward/i.test(text)) return new Error('远程有新提交，请先同步');
  if (/Your local changes .* overwritten|uncommitted changes|Please commit your changes or stash/i.test(text)) return new Error('有未提交的改动，无法拉取');
  if (/\bCONFLICT\b|Merge conflict/i.test(text)) return new Error('拉取时出现冲突，请先处理冲突');
  if (/divergent branches/i.test(text)) return new Error('本地和远程已分叉，请先处理');
  return err instanceof Error ? err : new Error(text);
}
async function tracking(root) {
  const remotes = (await git(root, ['remote'])).split(/\r?\n/).filter(Boolean);
  let upstream = '', ahead = 0, behind = 0;
  try {
    upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    const parts = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/);
    ahead = Number(parts[0]) || 0;
    behind = Number(parts[1]) || 0;
  } catch {}
  return { remotes, upstream, ahead, behind };
}
async function gitRoot(cwd) {
  if (!cwd) throw new Error('先打开一个项目');
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  // Never checkpoint or restore neighbouring projects in a parent repository.
  if (path.resolve(root).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error('请打开 Git 仓库根目录');
  return path.resolve(root);
}
function statusRows(raw) {
  const records = raw.split('\0'); const out = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i]; if (!line) continue;
    const status = line.slice(0, 2), file = line.slice(3);
    const row = { path: file, status, staged: ![' ', '?'].includes(status[0]), untracked: status === '??' };
    if (/[RC]/.test(status)) row.from = records[++i];
    out.push(row);
  }
  return out;
}
async function review(cwd) {
  const root = await gitRoot(cwd);
  const [raw, branch, track] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['branch', '--show-current']),
    tracking(root),
  ]);
  return { cwd: root, branch: branch.trim() || '游离 HEAD', files: statusRows(raw), ...track };
}
async function diff(cwd, file) {
  const root = await gitRoot(cwd); const target = safePath(root, file);
  const state = await review(root); const row = state.files.find(f => f.path === file);
  if (!row) return { text: '', binary: false };
  if (row.untracked) {
    const stat = fs.statSync(target);
    if (stat.size > 512 * 1024) return { text: '文件超过 512 KB，请在编辑器中查看。', binary: true };
    const data = fs.readFileSync(target);
    if (data.includes(0)) return { text: '二进制文件', binary: true };
    const lines = data.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return { text: `--- /dev/null\n+++ ${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(s => '+' + s).join('\n'), binary: false };
  }
  const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  const text = hasHead ? await git(root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file, ...(row.from ? [row.from] : [])]) :
    await git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', file]);
  return { text: text.slice(0, 512 * 1024), truncated: text.length > 512 * 1024, binary: /Binary files/.test(text) };
}
async function stage(cwd, files, unstage = false) {
  const root = await gitRoot(cwd);
  if (files === true) {
    if (unstage) {
      const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
      await git(root, hasHead ? ['restore', '--staged', '.'] : ['rm', '--cached', '-r', '-f', '.']);
    } else await git(root, ['add', '-A']);
    return review(root);
  }
  const rows = (await review(root)).files;
  if (!Array.isArray(files) || !files.length) throw new Error('先选择文件');
  const paths = new Set();
  for (const file of files) {
    safePath(root, file); const row = rows.find(r => r.path === file);
    if (!row) throw new Error('文件状态已改变，请刷新');
    paths.add(file); if (row.from) { safePath(root, row.from); paths.add(row.from); }
  }
  if (unstage) {
    const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
    await git(root, hasHead ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '--', ...paths]);
  } else await git(root, ['add', '--', ...paths]);
  return review(root);
}
async function commit(cwd, message) {
  const root = await gitRoot(cwd);
  const text = String(message || '').trim(); if (!text) throw new Error('填写提交说明');
  if (!(await review(root)).files.some(f => f.staged)) throw new Error('没有已暂存的修改');
  await git(root, ['commit', '-m', text]);
  return review(root);
}
async function syncPlan(cwd) {
  const root = await gitRoot(cwd);
  const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  if (!hasHead) throw new Error('还没有提交');
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  if (!branch) throw new Error('游离 HEAD 无法同步');
  const remotes = (await git(root, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (!remotes.length) throw new Error('还没有远程仓库');
  const configured = await git(root, ['config', '--get', `branch.${branch}.remote`]).then(s => s.trim(), () => '');
  const remote = configured || (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (remote === '.' || !remotes.includes(remote)) throw new Error('请配置有效的远程跟踪分支');
  const mergeRef = await git(root, ['config', '--get', `branch.${branch}.merge`]).then(s => s.trim(), () => `refs/heads/${branch}`);
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('不支持的远程分支');
  const net = { timeout: 120000, network: true };
  try {
    await git(root, ['fetch', remote, '--prune'], net);
    let upstream = '';
    try { upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim(); } catch {}
    const current = await review(root);
    if (current.files.length) throw new Error('请先提交或保存工作区改动，再同步');
    if (current.ahead && current.behind) throw new Error('本地与远程已分叉，请在编辑器中处理；未合并或推送');
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const remoteHead = upstream ? (await git(root, ['rev-parse', '@{upstream}'])).trim() : '';
    return { root, remote, branch, mergeRef, upstream, head, remoteHead, action: !upstream || current.ahead ? '推送' : current.behind ? '快进拉取' : '已同步', count: current.ahead || current.behind || 0 };
  } catch (err) { throw gitFail(err); }
}
async function sync(cwd, approved) {
  const plan = await syncPlan(cwd);
  if (approved && JSON.stringify(plan) !== JSON.stringify(approved)) throw new Error('同步状态已改变，请重新确认');
  const net = { timeout: 120000, network: true };
  try {
    if (plan.action === '快进拉取') await git(plan.root, ['merge', '--ff-only', plan.remoteHead]);
    if (plan.action === '推送') await git(plan.root, ['push', ...(!plan.upstream ? ['-u'] : []), plan.remote, `HEAD:${plan.mergeRef}`], net);
  } catch (error) { throw gitFail(error); }
  return review(plan.root);
}

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function projectSnapshot(cwd) {
  const root = await gitRoot(cwd);
  const names = [...new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  if (names.length > 10000) throw new Error('项目超过 10,000 个文件，无法建立完整检查点');
  const files = Object.create(null); let size = 0;
  for (const name of names) {
    const target = safePath(root, name);
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) {
      if (fs.existsSync(path.join(target, '.git'))) throw new Error(`检查点不包含嵌套仓库：${name}`);
      continue;
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) throw new Error(`无法备份 ${name}，检查点未创建`);
    size += stat.size;
    if (size > 64 * 1024 * 1024) throw new Error('项目内容超过 64 MB，检查点未创建');
    files[name] = { data: fs.readFileSync(target).toString('base64'), mode: stat.mode };
  }
  return { cwd: root, files, fingerprint: hash(JSON.stringify(files)) };
}
function checkpointFolder(dataRoot, cwd) { return path.join(dataRoot, 'checkpoints', hash(path.resolve(cwd).toLowerCase())); }
async function checkpoint(dataRoot, cwd, label, sessionId, automatic = false) {
  const snap = await projectSnapshot(cwd);
  const folder = checkpointFolder(dataRoot, cwd);
  // Content addressed blobs avoid copying unchanged project files per turn.
  for (const value of Object.values(snap.files)) {
    const bytes = Buffer.from(value.data, 'base64');
    const blob = hash(bytes), target = path.join(folder, 'blobs', blob);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) require('./storage.cjs').atomicWrite(target, require('node:zlib').gzipSync(bytes));
    delete value.data; value.blob = blob;
  }
  snap.fingerprint = hash(JSON.stringify(snap.files));
  const id = crypto.randomUUID();
  const record = { version: 2, id, automatic, at: new Date().toISOString(), label: String(label || '手动检查点').slice(0, 160), sessionId, ...snap };
  writeJson(path.join(checkpointFolder(dataRoot, cwd), `${id}.json`), record);
  pruneCheckpoints(dataRoot, cwd, id);
  return { id, at: record.at, label: record.label, sessionId, count: Object.keys(snap.files).length };
}
function checkpointList(dataRoot, cwd) {
  const folder = checkpointFolder(dataRoot, cwd);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(s => s.endsWith('.json')).map(name => {
    const r = readJson(path.join(folder, name), null);
    return r && { id: r.id, at: r.at, label: r.label, sessionId: r.sessionId, automatic: Boolean(r.automatic), count: Object.keys(r.files || {}).length };
  }).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
}
function loadCheckpoint(dataRoot, cwd, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw new Error('无效的检查点');
  const record = readJson(path.join(checkpointFolder(dataRoot, cwd), `${id}.json`), null);
  if (!record || path.resolve(record.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error('检查点不属于此项目');
  if (![1, 2].includes(record.version) || hash(JSON.stringify(record.files)) !== record.fingerprint) throw new Error('检查点内容校验失败');
  record.files = Object.assign(Object.create(null), record.files);
  for (const name of Object.keys(record.files)) {
    if (name.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('检查点包含 Git 内部文件');
    safePath(cwd, name);
    if (record.version === 2) {
      const blob = record.files[name].blob;
      if (!/^[a-f0-9]{64}$/.test(blob)) throw new Error('检查点内容校验失败');
      const bytes = require('node:zlib').gunzipSync(fs.readFileSync(path.join(checkpointFolder(dataRoot, cwd), 'blobs', blob)), { maxOutputLength: 64 * 1024 * 1024 });
      if (hash(bytes) !== blob) throw new Error('检查点内容校验失败');
      record.files[name] = { data: bytes.toString('base64'), mode: record.files[name].mode };
    }
  }
  record.fingerprint = hash(JSON.stringify(record.files));
  return record;
}

function deleteCheckpoint(dataRoot, cwd, id) {
  loadCheckpoint(dataRoot, cwd, id);
  const file = path.join(checkpointFolder(dataRoot, cwd), `${id}.json`);
  fs.unlinkSync(file);
  if (fs.existsSync(file + '.bak')) fs.unlinkSync(file + '.bak');
  pruneCheckpoints(dataRoot, cwd);
  return checkpointList(dataRoot, cwd);
}
function pruneCheckpoints(dataRoot, cwd, keepId) {
  const folder = checkpointFolder(dataRoot, cwd);
  const rows = checkpointList(dataRoot, cwd);
  const expired = rows.filter(r => r.automatic && r.id !== keepId).slice(rows.some(r => r.id === keepId && r.automatic) ? 29 : 30);
  for (const row of expired) fs.unlinkSync(path.join(folder, row.id + '.json'));
  const refs = new Set(); let bytes = 0;
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith('.json')) : []) {
    const file = path.join(folder, name), record = readJson(file, {});
    bytes += fs.statSync(file).size;
    for (const value of Object.values(record.files || {})) if (value.blob) refs.add(value.blob);
  }
  const blobs = path.join(folder, 'blobs');
  if (fs.existsSync(blobs)) for (const name of fs.readdirSync(blobs)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const file = path.join(blobs, name);
    if (!refs.has(name)) fs.unlinkSync(file); else bytes += fs.statSync(file).size;
  }
  if (bytes > 256 * 1024 * 1024 && keepId) {
    fs.unlinkSync(path.join(folder, keepId + '.json'));
    pruneCheckpoints(dataRoot, cwd);
    throw new Error('检查点空间达到 256 MB，请删除不需要的检查点');
  }
  return bytes;
}
async function restorePreview(dataRoot, cwd, id) {
  const record = loadCheckpoint(dataRoot, cwd, id), current = await projectSnapshot(cwd);
  const files = [];
  for (const name of new Set([...Object.keys(record.files), ...Object.keys(current.files)])) {
    const before = current.files[name], after = record.files[name];
    if (before?.data === after?.data && before?.mode === after?.mode) continue;
    files.push({ path: name, action: !after ? '删除' : !before ? '恢复' : '修改' });
  }
  return { id, files, fingerprint: current.fingerprint, label: record.label };
}
async function restoreCheckpoint(dataRoot, cwd, id, fingerprint) {
  const plan = await restorePreview(dataRoot, cwd, id);
  if (plan.fingerprint !== fingerprint) throw new Error('文件在预览后发生变化，请重新预览');
  const record = loadCheckpoint(dataRoot, cwd, id);
  const backup = await checkpoint(dataRoot, cwd, '恢复前自动备份', null);
  const saved = loadCheckpoint(dataRoot, cwd, backup.id);
  if (saved.fingerprint !== fingerprint) throw new Error('建立恢复备份时文件发生变化，请重新预览');
  const apply = (files, changes) => {
    // Delete files first to support file-to-directory transitions.
    for (const { path: name } of changes) if (!files[name]) {
      const target = safePath(cwd, name); if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) fs.unlinkSync(target);
    }
    for (const { path: name } of changes) if (files[name]) {
      const target = safePath(cwd, name);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) fs.rmdirSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(files[name].data, 'base64'));
      fs.chmodSync(target, files[name].mode);
    }
  };
  try { apply(record.files, plan.files); } catch (err) {
    try { apply(saved.files, plan.files); } catch {}
    throw new Error(`${err.message}；恢复前备份：${backup.id}`);
  }
  return { backup, changed: plan.files.length };
}
module.exports = { git, gitRoot, review, diff, stage, commit, sync, syncPlan, checkpoint, checkpointList, restorePreview, restoreCheckpoint, projectSnapshot, deleteCheckpoint, pruneCheckpoints };
