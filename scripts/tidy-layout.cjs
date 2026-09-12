const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const deploy = require('./deployment.cjs');

async function removeWithRetry(target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code) || attempt >= 6) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function tidy(root) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, '.halora-update.json'))) throw new Error('请先完成待安装的更新');
  if (deploy.running(root)) throw new Error('请先退出 Halora，再整理旧安装目录');
  const current = path.join(root, 'runtime', 'app');
  const currentManifest = path.join(current, 'halora-manifest.json');
  if (!fs.existsSync(currentManifest)) throw new Error('当前安装缺少校验信息');
  deploy.verify(current, JSON.parse(fs.readFileSync(currentManifest, 'utf8')));

  const names = fs.readdirSync(root).filter(name => /^(halora-app(?:-[\w.-]+)?|release|pack-out)$/.test(name));
  const removed = [], deferred = [], plans = [];
  for (const name of names) {
    const source = path.resolve(root, name);
    if (path.dirname(source) !== root || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) continue;
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--', name], { encoding: 'utf8', windowsHide: true });
    if (tracked.trim()) throw new Error(`目录含有受版本控制的文件，未删除：${name}`);
    const app = ['release', 'pack-out'].includes(name) ? path.join(source, 'win-unpacked') : source;
    if (['release', 'pack-out'].includes(name)) {
      const unexpected = fs.readdirSync(source).filter(item => item !== 'win-unpacked' && !/^builder-(?:debug\.yml|effective-config\.yaml)$/.test(item));
      if (unexpected.length) throw new Error(`目录含有无法确认的文件，未删除：${name}/${unexpected[0]}`);
    }
    const packed = JSON.parse(asar.extractFile(path.join(app, 'resources/app.asar'), 'package.json'));
    if (packed.name !== 'halora' || !fs.existsSync(path.join(app, 'Halora.exe'))) throw new Error(`未识别为 Halora 安装产物：${name}`);
    plans.push({ name, source, version: packed.version });
  }
  for (const { name, source, version } of plans) {
    try {
      await removeWithRetry(source);
      removed.push({ source, version });
      console.log(`已删除旧产物：${name}`);
    } catch (error) {
      if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      deferred.push(name);
      console.warn(`目录仍被占用，暂时保留：${name}`);
    }
  }
  try { deploy.removeLegacyLayout(root); }
  catch (error) { deferred.push('runtime/versions'); console.warn(`旧版本目录暂时保留：${error.message}`); }
  return { removed, deferred };
}

if (require.main === module) {
  tidy(path.resolve(__dirname, '..')).then(result => { if (result.deferred.length) process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { tidy };
