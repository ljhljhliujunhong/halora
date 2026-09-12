const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function manifest(root, version) {
  const rows = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('安装包不支持符号链接');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push({ path: path.relative(root, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size, hash: hash(fs.readFileSync(full)) });
    }
  }
  walk(root); return { version, files: rows };
}
function verify(root, expected) {
  for (const file of expected.files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('安装包路径越界');
    if (!fs.existsSync(target) || fs.statSync(target).size !== file.bytes || hash(fs.readFileSync(target)) !== file.hash) throw new Error(`安装包校验失败：${file.path}`);
  }
}
function running(root) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$p = @(Get-CimInstance Win32_Process -Filter "Name=\'Halora.exe\'" -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:HALORA_INSTALL_ROOT + "\\", [StringComparison]::OrdinalIgnoreCase) }); if ($p.Count) { exit 10 }'], { windowsHide: true, env: { ...process.env, HALORA_INSTALL_ROOT: path.resolve(root) }, encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 10) throw new Error('无法检查 Halora 运行状态');
  return result.status === 10;
}
function apply(tx) {
  const root = path.resolve(tx.root), target = path.join(root, 'halora-app');
  if (path.resolve(tx.marker) !== path.join(root, '.halora-update.json')) throw new Error('更新事务无效');
  if (!fs.existsSync(target) && fs.existsSync(tx.backup)) fs.renameSync(tx.backup, target);
  if (!fs.existsSync(tx.stage) && fs.existsSync(target)) {
    verify(target, tx.manifest);
    fs.unlinkSync(tx.marker); return;
  }
  verify(tx.stage, tx.manifest);
  if (hash(fs.readFileSync(tx.launcher)) !== tx.launcherHash) throw new Error('启动器校验失败');
  let moved = false, installed = false;
  try {
    if (fs.existsSync(target)) { fs.renameSync(target, tx.backup); moved = true; }
    fs.renameSync(tx.stage, target); installed = true;
    verify(target, tx.manifest);
    const launcher = path.join(root, '星环.exe');
    if (!fs.existsSync(launcher) || hash(fs.readFileSync(launcher)) !== tx.launcherHash) fs.copyFileSync(tx.launcher, launcher);
    fs.unlinkSync(tx.marker);
  } catch (error) {
    if (installed) fs.renameSync(target, tx.stage);
    if (moved) fs.renameSync(tx.backup, target);
    throw error;
  }
}
async function resume(marker) {
  const lock = marker + '.lock';
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); return; } catch {}
    fs.unlinkSync(lock);
  }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return; }
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  try {
    const tx = JSON.parse(fs.readFileSync(marker, 'utf8'));
    while (running(tx.root)) await new Promise(r => setTimeout(r, 1500));
    for (let attempt = 0; ; attempt++) {
      try { apply(tx); break; } catch (error) { if (attempt >= 10) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
  } catch (error) { fs.writeFileSync(marker + '.error', error.message); }
  finally { fs.unlinkSync(lock); }
}
if (require.main === module) resume(process.argv[2]);
module.exports = { hash, manifest, verify, apply, running };
