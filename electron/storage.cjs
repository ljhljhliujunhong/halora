const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJson(file, fallback = {}) {
  for (const candidate of [file, `${file}.bak`]) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
  }
  return fallback;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(temp, file);
}
function writeJson(file, value) { atomicWrite(file, JSON.stringify(value, null, 2)); }

const DEFAULTS = Object.freeze({
  modelId: 'grok-4.6', permissionMode: 'agent', autoCompact: 85,
  sendKey: 'enter', fontSize: 14, theme: 'light', confirmExit: true,
  checkpoints: true, defaultCwd: '',
});
function preferences(raw = {}) {
  const out = { ...DEFAULTS };
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) out.modelId = raw.modelId.slice(0, 100);
  if (['agent', 'plan', 'yolo'].includes(raw.permissionMode)) out.permissionMode = raw.permissionMode;
  if (['enter', 'ctrl-enter'].includes(raw.sendKey)) out.sendKey = raw.sendKey;
  if (['light', 'dark', 'system'].includes(raw.theme)) out.theme = raw.theme;
  for (const [key, min, max] of [['autoCompact', 50, 95], ['fontSize', 12, 20]]) {
    if (Number.isFinite(Number(raw[key]))) out[key] = Math.min(max, Math.max(min, Math.round(Number(raw[key]))));
  }
  for (const key of ['confirmExit', 'checkpoints']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  if (typeof raw.defaultCwd === 'string') out.defaultCwd = raw.defaultCwd.slice(0, 1000);
  return out;
}

function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative)) throw new Error('无效的文件路径');
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(p => !p || p === '..' || p === '.' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('文件路径越界');
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (!target.startsWith(base + path.sep)) throw new Error('文件路径越界');
  let cursor = base;
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('不支持符号链接目录');
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('不支持符号链接文件');
  }
  return target;
}

module.exports = { readJson, writeJson, atomicWrite, preferences, DEFAULTS, safePath };
