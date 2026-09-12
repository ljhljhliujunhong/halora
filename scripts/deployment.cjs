const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

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
  walk(root);
  return { version, files: rows };
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

function installTarget(tx) {
  return path.join(path.resolve(tx.root), 'runtime', 'app');
}

function validateTransaction(tx) {
  const root = path.resolve(tx.root);
  if (path.resolve(tx.marker) !== path.join(root, '.halora-update.json')) throw new Error('更新事务无效');
  const backup = path.resolve(tx.backup);
  if (path.dirname(backup) !== path.join(root, 'runtime') || !/^\.rollback-[0-9a-f-]+$/i.test(path.basename(backup))) throw new Error('回滚目录无效');
  return { root, target: installTarget(tx), backup };
}

function removeLegacyLayout(root) {
  const runtime = path.join(root, 'runtime');
  const versions = path.join(runtime, 'versions');
  if (fs.existsSync(versions)) {
    if (fs.lstatSync(versions).isSymbolicLink()) throw new Error('旧版本目录无效');
    for (const entry of fs.readdirSync(versions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w.-]+-[a-f0-9]{12}$/.test(entry.name)) throw new Error(`无法确认旧版本：${entry.name}`);
      const candidate = path.join(versions, entry.name);
      const metadata = path.join(candidate, 'halora-manifest.json');
      if (!fs.existsSync(metadata)) throw new Error(`旧版本缺少校验信息：${entry.name}`);
      verify(candidate, JSON.parse(fs.readFileSync(metadata, 'utf8')));
    }
    fs.rmSync(versions, { recursive: true, force: true });
  }
  for (const pointer of [path.join(runtime, 'current.json'), path.join(root, '.halora-current.json')]) {
    if (fs.existsSync(pointer)) fs.unlinkSync(pointer);
  }
}

function apply(tx) {
  const { root, target, backup } = validateTransaction(tx);
  const stageExists = fs.existsSync(tx.stage);
  if (stageExists) verify(tx.stage, tx.manifest);
  else verify(target, tx.manifest); // resumed after the new directory was moved into place
  if (hash(fs.readFileSync(tx.launcher)) !== tx.launcherHash) throw new Error('启动器校验失败');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let movedOld = fs.existsSync(backup);
  let installedNew = !stageExists;
  try {
    if (stageExists) {
      if (fs.existsSync(target)) {
        if (movedOld) throw new Error('回滚目录已存在');
        fs.renameSync(target, backup);
        movedOld = true;
      }
      fs.renameSync(tx.stage, target);
      installedNew = true;
    }
    verify(target, tx.manifest);
    const launcher = path.join(root, '星环.exe');
    if (!fs.existsSync(launcher) || hash(fs.readFileSync(launcher)) !== tx.launcherHash) fs.copyFileSync(tx.launcher, launcher);
    fs.unlinkSync(tx.marker);
  } catch (error) {
    if (stageExists && installedNew && fs.existsSync(target)) {
      try { fs.renameSync(target, tx.stage); } catch {}
    }
    if (movedOld && fs.existsSync(backup) && !fs.existsSync(target)) {
      try { fs.renameSync(backup, target); } catch {}
    }
    throw error;
  }

  if (fs.existsSync(tx.marker + '.error')) fs.unlinkSync(tx.marker + '.error');
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  try { removeLegacyLayout(root); }
  catch (error) { console.warn(`旧安装布局暂未删除：${error.message}`); }
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
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  let completed = false;
  let tx;
  try {
    tx = JSON.parse(fs.readFileSync(marker, 'utf8'));
    for (let attempt = 0; running(tx.root); attempt++) {
      if (attempt >= 120) throw new Error('Halora 未能在一分钟内退出，更新将在下次启动前继续');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (let attempt = 0; ; attempt++) {
      try { apply(tx); completed = true; break; }
      catch (error) { if (attempt >= 60) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
  } catch (error) {
    fs.writeFileSync(marker + '.error', error.message);
  } finally {
    fs.unlinkSync(lock);
  }
  if (completed && tx.relaunch) {
    const child = spawn(path.join(path.resolve(tx.root), '星环.exe'), [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  if (completed) {
    const helper = path.resolve(tx.helper || '');
    const launcher = path.resolve(tx.launcher || '');
    const helperIsSelf = helper === path.resolve(__filename) && /^deployment-[0-9a-f-]+\.cjs$/i.test(path.basename(helper));
    const launcherMatches = helperIsSelf && path.dirname(launcher) === path.dirname(helper) && /^launcher-[0-9a-f-]+\.exe$/i.test(path.basename(launcher));
    for (const temporary of [launcherMatches ? launcher : null, helperIsSelf ? helper : null]) {
      if (!temporary) continue;
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}

if (require.main === module) resume(process.argv[2]);
module.exports = { hash, manifest, verify, apply, running, installTarget, removeLegacyLayout };
