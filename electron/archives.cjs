const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { atomicWrite, readJson, safePath } = require('./storage.cjs');
const LIMIT = 256 * 1024 * 1024;

function collect(root, prefix, files, budget, skip = new Set()) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (skip.has(entry.name) || /\.(lock|tmp)$/.test(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name), key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collect(file, key, files, budget, skip);
    else if (entry.isFile()) {
      budget.bytes += fs.statSync(file).size;
      if (budget.bytes > LIMIT || files.length >= 30000) throw new Error('备份超过 256 MB 或 30,000 个文件，请先缩小数据范围');
      files.push({ path: key, data: fs.readFileSync(file).toString('base64') });
    }
  }
}
function createBackup(dataRoot, grokRoot, destination, password = '') {
  const files = [], budget = { bytes: 0 };
  for (const name of ['settings.json', 'recovery.json', 'composer.json']) {
    const file = path.join(dataRoot, name);
    if (fs.existsSync(file)) files.push({ path: `app/${name}`, data: fs.readFileSync(file).toString('base64') });
  }
  collect(path.join(grokRoot, 'sessions'), 'sessions', files, budget, new Set(['terminal', 'session_search.sqlite', 'session_search.sqlite-wal', 'session_search.sqlite-shm']));
  collect(path.join(grokRoot, 'skills'), 'skills', files, budget, new Set(['.git', 'node_modules']));
  collect(path.join(dataRoot, 'inbox'), 'app/inbox', files, budget);
  collect(path.join(dataRoot, 'checkpoints'), 'app/checkpoints', files, budget);
  collect(path.join(dataRoot, 'rewind-backups'), 'app/rewind-backups', files, budget);
  const raw = Buffer.from(JSON.stringify({ format: 'halora-backup', version: 1, at: new Date().toISOString(), sourceDataRoot: dataRoot, files }));
  if (raw.length > LIMIT * 1.5) throw new Error('备份体积过大');
  let output = zlib.gzipSync(raw);
  if (password) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(password, salt, 32), iv);
    const encrypted = Buffer.concat([cipher.update(output), cipher.final()]);
    output = Buffer.concat([Buffer.from('HALORA01'), salt, iv, cipher.getAuthTag(), encrypted]);
  }
  atomicWrite(destination, output);
  return { path: destination, count: files.length, bytes: fs.statSync(destination).size };
}
function parseBackup(file, password = '') {
  if (fs.statSync(file).size > LIMIT) throw new Error('备份文件过大');
  const bytes = fs.readFileSync(file);
  let compressed = bytes;
  if (bytes.subarray(0, 8).toString() === 'HALORA01') {
    if (!password) throw new Error('此备份需要密码');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(password, bytes.subarray(8, 24), 32), bytes.subarray(24, 36));
      decipher.setAuthTag(bytes.subarray(36, 52));
      compressed = Buffer.concat([decipher.update(bytes.subarray(52)), decipher.final()]);
    } catch { throw new Error('密码错误或备份已损坏'); }
  }
  const raw = zlib.gunzipSync(compressed, { maxOutputLength: LIMIT * 1.5 });
  const bundle = JSON.parse(raw.toString('utf8'));
  if (bundle.format !== 'halora-backup' || bundle.version !== 1 || !Array.isArray(bundle.files) || bundle.files.length > 30000) throw new Error('不支持的备份格式');
  const seen = new Set(); let size = 0;
  for (const row of bundle.files) {
    if (typeof row.path !== 'string' || typeof row.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data)) throw new Error('备份内容无效');
    if (!/^(sessions\/|skills\/|app\/(settings\.json$|recovery\.json$|composer\.json$|inbox\/|checkpoints\/|rewind-backups\/))/.test(row.path)) throw new Error('备份包含非允许文件');
    safePath(path.join(path.dirname(path.resolve(file)), 'validation'), row.path);
    const key = row.path.toLowerCase(); if (seen.has(key)) throw new Error('备份包含重复路径'); seen.add(key);
    size += Buffer.byteLength(row.data, 'base64'); if (size > LIMIT) throw new Error('备份内容过大');
  }
  return { ...bundle, fingerprint: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function restoreBackup(dataRoot, grokRoot, source, fingerprint, password = '') {
  const bundle = parseBackup(source, password);
  if (bundle.fingerprint !== fingerprint) throw new Error('备份文件已改变，请重新选择');
  const entries = bundle.files.map(row => {
    const root = row.path.startsWith('app/') ? dataRoot : grokRoot;
    const name = row.path.startsWith('app/') ? row.path.slice(4) : row.path;
    return { target: safePath(root, name), data: Buffer.from(row.data, 'base64') };
  });
  const backup = path.join(dataRoot, 'backups', `before-restore-${Date.now()}.halora`);
  createBackup(dataRoot, grokRoot, backup, password);
  // Keep the currently installed identity and rebase inbox paths on this machine.
  for (const entry of entries) {
    if (entry.target === path.join(dataRoot, 'composer.json') && bundle.sourceDataRoot) {
      const obj = JSON.parse(entry.data.toString());
      const rebase = value => {
        if (typeof value === 'string' && value.startsWith(bundle.sourceDataRoot + path.sep)) return dataRoot + value.slice(bundle.sourceDataRoot.length);
        if (Array.isArray(value)) return value.map(rebase);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v)]));
        return value;
      };
      const rebased = rebase(obj);
      for (const row of Object.values(rebased)) row.updatedAt = Date.now();
      entry.data = Buffer.from(JSON.stringify(rebased));
    }
  }
  const previous = entries.map(e => fs.existsSync(e.target) ? fs.readFileSync(e.target) : null);
  let applied = 0;
  try {
    for (const entry of entries) { atomicWrite(entry.target, entry.data); applied++; }
  } catch (error) {
    for (let i = applied - 1; i >= 0; i--) {
      try { if (previous[i]) atomicWrite(entries[i].target, previous[i]); else fs.unlinkSync(entries[i].target); } catch {}
    }
    throw new Error(`${error.message}；原数据备份保存在 ${backup}`);
  }
  return { count: entries.length, backup };
}

function exportTranscript(messages, title, format) {
  if (format === 'json') return JSON.stringify({ format: 'halora-conversation', version: 1, title, at: new Date().toISOString(), messages }, null, 2);
  const markdown = [`# ${title}\n`, ...messages.map(message => {
    const heading = message.role === 'user' ? '你' : message.role === 'assistant' ? 'Grok' : '系统';
    const parts = [`## ${heading}`, message.text || (message.kind === 'compact' ? '对话已压缩' : '')];
    for (const file of [...(message.files || []), ...(message.images || [])]) parts.push(`附件：${file.path || file.name || '图片'}`);
    if (message.thought) parts.push(`思考：\n${message.thought}`);
    for (const tool of message.tools || []) parts.push(`### ${tool.title || '工具'}\n\n${tool.output || ''}`);
    return parts.join('\n\n');
  })].join('\n\n');
  if (format === 'html') {
    const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(title)}</title><style>body{max-width:960px;margin:40px auto;padding:24px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><body><pre>${escape(markdown)}</pre></body></html>`;
  }
  return markdown;
}
module.exports = { createBackup, parseBackup, restoreBackup, exportTranscript };
