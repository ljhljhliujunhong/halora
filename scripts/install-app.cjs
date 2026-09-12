const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const source = process.env.HALORA_UNPACKED || path.join(root, 'release', 'win-unpacked');
const dest = path.join(root, 'halora-app');
const launcherOut = path.join(root, '星环.exe');
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function run(file, args, opts = {}) {
  const result = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', ...opts });
  return result;
}

function copyApp() {
  if (!fs.existsSync(path.join(source, 'Halora.exe'))) {
    throw new Error(`还没有打包结果：${source}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const robocopy = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'robocopy.exe');
  let result = run(robocopy, [source, dest, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np']);
  if (result.status >= 8) {
    run('taskkill', ['/IM', 'Halora.exe', '/F']);
    run('taskkill', ['/IM', 'Xinghuan.exe', '/F']);
    result = run(robocopy, [source, dest, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np']);
  }
  if (result.status >= 8) {
    throw new Error(`复制应用失败（${result.status}）：${result.stderr || result.stdout || ''}`.trim());
  }
  if (!fs.existsSync(path.join(dest, 'Halora.exe'))) throw new Error('复制后找不到 Halora.exe');
}

function compileLauncher() {
  if (!fs.existsSync(csc)) throw new Error('找不到 csc.exe，无法生成 星环.exe');
  const tmp = path.join(root, 'xinghuan-launcher.exe');
  const ico = path.join(root, 'build', 'icon.ico');
  const args = ['/nologo', '/target:winexe', '/platform:anycpu', `/out:${tmp}`, '/r:System.Windows.Forms.dll', path.join('scripts', 'launcher.cs')];
  if (fs.existsSync(ico)) args.splice(4, 0, `/win32icon:${ico}`);
  const result = run(csc, args, { cwd: root });
  if (result.status !== 0 || !fs.existsSync(tmp)) {
    throw new Error(`编译启动器失败：${(result.stdout || '') + (result.stderr || '')}`.trim());
  }
  fs.copyFileSync(tmp, launcherOut);
  fs.unlinkSync(tmp);
  if (!fs.existsSync(launcherOut)) throw new Error('没有写出 星环.exe');
}

copyApp();
compileLauncher();
console.log(`installed ${dest}`);
console.log(`launcher ${launcherOut}`);
