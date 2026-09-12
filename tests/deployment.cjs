const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const deploy = require('../scripts/deployment.cjs');
const { tidy } = require('../scripts/tidy-layout.cjs');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');

const base = 'E:/VsCodeProject/Agent缓存文件/temp/halora-layout';
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'test-'));

function transaction(install, content) {
  const stage = fs.mkdtempSync(path.join(base, 'stage-'));
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(stage, 'Halora.exe'), content);
  const manifest = deploy.manifest(stage, '0.2.5');
  fs.writeFileSync(path.join(stage, 'halora-manifest.json'), JSON.stringify(manifest));
  const launcher = path.join(base, `launcher-${crypto.randomUUID()}.exe`);
  fs.writeFileSync(launcher, 'launcher');
  const marker = path.join(install, '.halora-update.json');
  const tx = {
    root: install,
    stage,
    backup: path.join(install, 'runtime', `.rollback-${crypto.randomUUID()}`),
    manifest,
    launcher,
    launcherHash: deploy.hash(fs.readFileSync(launcher)),
    marker,
    relaunch: false,
  };
  fs.writeFileSync(marker, JSON.stringify(tx));
  return tx;
}

test('installation keeps only the current app and deletes the transient rollback', () => {
  const install = path.join(root, 'single-app');
  deploy.apply(transaction(install, 'first'));
  const second = transaction(install, 'second');
  deploy.apply(second);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'second');
  assert.equal(fs.existsSync(second.backup), false);
  assert.deepEqual(fs.readdirSync(path.join(install, 'runtime')), ['app']);
  assert.deepEqual(fs.readdirSync(install).sort(), ['runtime', '星环.exe'].sort());
  fs.writeFileSync(second.marker, JSON.stringify(second));
  deploy.apply(second);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'second');
});

test('a corrupt staged package preserves the installed app', () => {
  const install = path.join(root, 'corrupt');
  deploy.apply(transaction(install, 'current'));
  const next = transaction(install, 'next');
  fs.writeFileSync(path.join(next.stage, 'Halora.exe'), 'bad');
  assert.throws(() => deploy.apply(next), /校验/);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'current');
  assert.equal(fs.existsSync(next.stage), true);
});

test('an interrupted swap resumes from the installed target and removes rollback data', () => {
  const install = path.join(root, 'resume');
  deploy.apply(transaction(install, 'current'));
  const next = transaction(install, 'next');
  fs.renameSync(deploy.installTarget(next), next.backup);
  fs.renameSync(next.stage, deploy.installTarget(next));
  deploy.apply(next);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'next');
  assert.equal(fs.existsSync(next.backup), false);
  assert.equal(fs.existsSync(next.marker), false);
});

test('launcher verification fails before replacing the installed app', () => {
  const install = path.join(root, 'launcher-check');
  deploy.apply(transaction(install, 'current'));
  const next = transaction(install, 'next');
  fs.writeFileSync(next.launcher, 'tampered');
  assert.throws(() => deploy.apply(next), /启动器/);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'current');
  assert.equal(fs.existsSync(next.stage), true);
});

test('legacy cleanup validates then deletes old products and version directories', async () => {
  const install = path.join(root, 'migration');
  deploy.apply(transaction(install, 'current'));
  execFileSync('git', ['init', '-q', install], { windowsHide: true });
  const src = fs.mkdtempSync(path.join(base, 'asar-source-'));
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'halora', version: '0.2.2' }));
  for (const legacy of ['halora-app', 'halora-app-0.2.2-abcdef012345', 'release/win-unpacked', 'pack-out/win-unpacked']) {
    const target = path.join(install, legacy);
    fs.mkdirSync(path.join(target, 'resources'), { recursive: true });
    await asar.createPackage(src, path.join(target, 'resources/app.asar'));
    fs.writeFileSync(path.join(target, 'Halora.exe'), 'legacy');
  }
  const oldVersion = path.join(install, 'runtime/versions/0.2.4-abcdef012345');
  fs.mkdirSync(oldVersion, { recursive: true });
  fs.writeFileSync(path.join(oldVersion, 'Halora.exe'), 'old-version');
  fs.writeFileSync(path.join(oldVersion, 'halora-manifest.json'), JSON.stringify(deploy.manifest(oldVersion, '0.2.4')));
  fs.writeFileSync(path.join(install, 'runtime/current.json'), '{}');
  fs.writeFileSync(path.join(install, 'release/user-note.txt'), 'keep');
  fs.writeFileSync(path.join(install, 'settings.json'), 'user-settings');
  execFileSync('git', ['-C', install, 'add', 'release/user-note.txt'], { windowsHide: true });
  await assert.rejects(tidy(install), /版本控制/);
  assert.ok(fs.existsSync(path.join(install, 'halora-app')));
  execFileSync('git', ['-C', install, 'rm', '--cached', 'release/user-note.txt'], { windowsHide: true });
  fs.unlinkSync(path.join(install, 'release/user-note.txt'));
  const result = await tidy(install);
  assert.equal(result.removed.length, 4);
  assert.deepEqual(result.deferred, []);
  assert.equal(fs.existsSync(path.join(install, 'runtime/versions')), false);
  assert.equal(fs.existsSync(path.join(install, 'runtime/current.json')), false);
  assert.equal(fs.readFileSync(path.join(install, 'runtime/app/Halora.exe'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(install, 'settings.json'), 'utf8'), 'user-settings');
  assert.equal((await tidy(install)).removed.length, 0);
});
