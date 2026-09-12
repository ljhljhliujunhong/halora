const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const deploy = require('./deployment.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const source = path.resolve(root, pkg.build.directories.output, 'win-unpacked');
const cache = path.join('E:/VsCodeProject/Agent缓存文件', 'halora-updates', crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16));
fs.mkdirSync(cache, { recursive: true });
const marker = path.join(root, '.halora-update.json');
if (fs.existsSync(marker)) throw new Error('还有待完成的更新，请先退出 Halora 并等待安装完成');
const archive = path.join(source, 'resources', 'app.asar');
const packed = JSON.parse(asar.extractFile(archive, 'package.json'));
if (packed.version !== pkg.version || packed.name !== 'halora') throw new Error('打包版本与源码不一致');
for (const name of asar.listPackage(archive).map(s => s.replace(/\\/g, '/').replace(/^\//, ''))) {
  if (!/^(electron|dist)\//.test(name)) continue;
  const local = path.join(root, name);
  if (fs.existsSync(local) && fs.statSync(local).isFile() && !asar.extractFile(archive, name.split('/').join(path.sep)).equals(fs.readFileSync(local))) throw new Error(`打包文件不是当前源码：${name}`);
}
const stage = path.join(cache, crypto.randomUUID());
console.log(`源码与打包版本校验通过：Halora ${pkg.version}`);
console.log(`准备安装文件：${stage}`);
function copyPackage(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`安装包不支持符号链接：${entry.name}`);
    if (entry.isDirectory()) copyPackage(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
    else throw new Error(`不支持的安装文件：${entry.name}`);
  }
}
copyPackage(source, stage);
console.log('生成并校验安装文件哈希');
const manifest = deploy.manifest(stage, pkg.version);
fs.writeFileSync(path.join(stage, 'halora-manifest.json'), JSON.stringify(manifest));
deploy.verify(stage, manifest);
const launcher = path.join(cache, `launcher-${crypto.randomUUID()}.exe`);
console.log('编译根目录启动器');
const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const built = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', `/out:${launcher}`, '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/win32icon:${path.join(root, 'build/icon.ico')}`, path.join(root, 'scripts/launcher.cs')], { windowsHide: true, encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stdout || built.stderr || '启动器编译失败');
const helper = path.join(cache, `deployment-${crypto.randomUUID()}.cjs`);
fs.copyFileSync(path.join(__dirname, 'deployment.cjs'), helper);
const transaction = { root, stage, backup: path.join(cache, `previous-${Date.now()}`), manifest, launcher, launcherHash: deploy.hash(fs.readFileSync(launcher)), node: process.execPath, helper, marker };
fs.writeFileSync(marker, JSON.stringify(transaction));
fs.copyFileSync(launcher, path.join(root, '星环.exe'));
if (deploy.running(root)) {
  const child = spawn(process.execPath, [helper, marker], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  console.log(`已校验 Halora ${pkg.version}；退出应用后自动替换。`);
} else {
  deploy.apply(transaction);
  console.log(`已安装并校验 Halora ${pkg.version}：${path.join(root, '星环.exe')}`);
}
