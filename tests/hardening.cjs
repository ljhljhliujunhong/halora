const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const base = 'E:/VsCodeProject/Agent缓存文件/temp/halora-hardening';
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'test-'));
process.env.GROK_HOME = path.join(root, 'grok');
const review = require('../electron/review.cjs');
const archives = require('../electron/archives.cjs');
const deploy = require('../scripts/deployment.cjs');
const { AcpClient } = require('../electron/acp.cjs');
const { readTranscript } = require('../electron/sessions.cjs');
const maintenance = require('../electron/maintenance.cjs');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.invalid');
  put(path.join(cwd, 'file'), 'initial'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'initial'); return cwd;
}
function client() {
  const c = new AcpClient(); c.sent = [];
  c.proc = { stdin: { writable: true, write: raw => c.sent.push(JSON.parse(raw)) }, kill() {} };
  return c;
}
test('cancel settles the prompt and waits for acknowledgement before the next prompt', async () => {
  const c = client(); const first = c.prompt('a', 'first');
  const rejected = assert.rejects(first, /取消/); await new Promise(r => setImmediate(r));
  const id = c.sent[0].id; c.cancel('a'); await rejected;
  const next = c.prompt('a', 'next'); await new Promise(r => setImmediate(r));
  assert.equal(c.sent.filter(m => m.method === 'session/prompt').length, 1);
  c.onLine(JSON.stringify({ id, result: {} })); await new Promise(r => setImmediate(r));
  const nextId = c.sent.at(-1).id; c.onLine(JSON.stringify({ id: nextId, result: {} })); await next; c.stop();
});
test('idle and unacknowledged cancellation disconnect instead of locking the queue forever', async () => {
  const c = client(); c.idleMs = 20;
  await assert.rejects(c.prompt('a', 'hello'), /超时/); assert.equal(c.alive, false);
  const d = client(); d.cancelGraceMs = 20;
  const p = d.prompt('a', 'first'); const rejected = assert.rejects(p, /取消/);
  await new Promise(r => setImmediate(r)); d.cancel('a'); await rejected;
  await assert.rejects(d.prompt('a', 'next'), /没连上/); assert.equal(d.draining.size, 0);
});
test('repeated turns and complete tool output survive history loading and export', () => {
  const cwd = path.join(root, 'history'), id = 'chat';
  const dir = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd), id);
  put(path.join(dir, 'summary.json'), '{}');
  const rows = [{type:'user',content:'继续'}, {type:'assistant',content:'好的'}, {type:'user',content:'继续'}, {type:'assistant',content:'好的',tool_calls:[{id:'tool',name:'read',arguments:'{}'}]}, {type:'tool_result',tool_call_id:'tool',content:'x'.repeat(16000)}];
  put(path.join(dir, 'chat_history.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const messages = readTranscript(cwd, id);
  assert.equal(messages.filter(m => m.role === 'user').length, 2);
  assert.equal(messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(messages.at(-1).tools[0].output.length, 16000);
  assert.ok(archives.exportTranscript(messages, 'Test', 'md').includes('x'.repeat(16000)));
});
test('checkpoints reuse blobs, keep 30 automatic points and restore legacy snapshots', async () => {
  const cwd = repo('points'), data = path.join(root, 'point-data');
  const manual = await review.checkpoint(data, cwd, 'manual');
  for (let i = 0; i < 32; i++) await review.checkpoint(data, cwd, 'auto', 'chat', true);
  assert.equal(review.checkpointList(data, cwd).length, 31);
  const folder = path.join(data, 'checkpoints', fs.readdirSync(path.join(data, 'checkpoints'))[0]);
  assert.equal(fs.readdirSync(path.join(folder, 'blobs')).length, 1);
  put(path.join(cwd, 'file'), 'changed');
  const preview = await review.restorePreview(data, cwd, manual.id);
  await review.restoreCheckpoint(data, cwd, manual.id, preview.fingerprint);
  assert.equal(fs.readFileSync(path.join(cwd, 'file'), 'utf8'), 'initial');
  const snapshot = await review.projectSnapshot(cwd), id = crypto.randomUUID();
  put(path.join(folder, id + '.json'), JSON.stringify({version:1,id,at:new Date().toISOString(),label:'legacy',...snapshot}));
  assert.equal((await review.restorePreview(data, cwd, id)).files.length, 0);
});
test('encrypted backups require the correct password and verify tampering', () => {
  const data = path.join(root, 'encrypted'), grok = path.join(root, 'backup-grok'), destination = path.join(root, 'encrypted.halora');
  put(path.join(data, 'settings.json'), '{"theme":"dark"}');
  archives.createBackup(data, grok, destination, 'password-test');
  assert.throws(() => archives.parseBackup(destination), /密码/);
  assert.throws(() => archives.parseBackup(destination, 'wrong'), /密码/);
  const bundle = archives.parseBackup(destination, 'password-test'); assert.equal(bundle.files.length, 1);
  archives.restoreBackup(path.join(root, 'restored'), grok, destination, bundle.fingerprint, 'password-test');
  const bytes = fs.readFileSync(destination); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(destination, bytes);
  assert.throws(() => archives.parseBackup(destination, 'password-test'), /损坏/);
});
test('sync refuses divergence and preserves head and working files', async () => {
  const cwd = repo('sync'), bare = path.join(root, 'origin.git'), other = path.join(root, 'other');
  fs.mkdirSync(bare); git(bare, 'init', '--bare', '-q'); git(cwd, 'remote', 'add', 'origin', bare); await review.sync(cwd);
  execFileSync('git', ['clone','-q',bare,other], {windowsHide:true}); git(other, 'config','user.name','Test'); git(other,'config','user.email','test@example.invalid');
  put(path.join(other,'remote'),'remote'); git(other,'add','.'); git(other,'commit','-qm','remote'); git(other,'push');
  put(path.join(cwd,'local'),'local'); git(cwd,'add','.'); git(cwd,'commit','-qm','local'); const head = git(cwd,'rev-parse','HEAD');
  await assert.rejects(review.sync(cwd), /分叉/); assert.equal(git(cwd,'rev-parse','HEAD'), head); assert.equal(fs.existsSync(path.join(cwd,'.git','MERGE_HEAD')),false);
});
test('installer verifies hashes, swaps whole directories, and keeps the previous app', () => {
  const install = path.join(root,'install'), stage = path.join(root,'stage'), backup = path.join(root,'previous'), marker = path.join(install,'.halora-update.json'), launcher = path.join(root,'launcher.exe');
  put(path.join(install,'halora-app','Halora.exe'),'old'); put(path.join(stage,'Halora.exe'),'new'); put(launcher,'launcher');
  const manifest = deploy.manifest(stage,'0.2.2');
  put(path.join(stage,'Halora.exe'),'bad'); assert.throws(() => deploy.verify(stage,manifest), /校验/); put(path.join(stage,'Halora.exe'),'new');
  const tx = {root:install,stage,backup,marker,launcher,launcherHash:deploy.hash(fs.readFileSync(launcher)),manifest}; put(marker,JSON.stringify(tx)); deploy.apply(tx);
  assert.equal(fs.readFileSync(path.join(install,'halora-app','Halora.exe'),'utf8'),'new'); assert.equal(fs.readFileSync(path.join(backup,'Halora.exe'),'utf8'),'old'); assert.equal(fs.existsSync(marker),false);
  // Resume a crash after swapping but before clearing the marker.
  put(marker,JSON.stringify(tx)); deploy.apply(tx); assert.equal(fs.existsSync(marker),false);
});
test('cleanup preserves referenced attachments and only removes approved stale files', () => {
  const data = path.join(root,'cleanup'), grok = path.join(root,'cleanup-grok');
  for (const name of ['keep.png','orphan.png']) { const file = path.join(data,'inbox',name); put(file,'image'); fs.utimesSync(file,new Date(0),new Date(0)); }
  put(path.join(grok,'sessions','project','chat','chat_history.jsonl'), 'keep.png');
  const preview = maintenance.inspect(data,grok); assert.deepEqual(preview.removable.map(r => path.basename(r.path)),['orphan.png']);
  const result = maintenance.cleanup(data,grok,preview.removable.map(r => r.path)); assert.equal(result.count,1); assert.equal(fs.existsSync(path.join(data,'inbox','keep.png')),true);
});

test('Windows deferred installer waits for the app process to exit then installs automatically', {skip:process.platform !== 'win32'}, async () => {
  const install = path.join(root,'deferred'), target = path.join(install,'halora-app'), stage = path.join(root,'deferred-stage');
  fs.mkdirSync(target,{recursive:true});
  execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo','/target:winexe',`/out:${path.join(target,'Halora.exe')}`,path.join(__dirname,'fixtures/hold.cs')], {windowsHide:true});
  put(path.join(stage,'Halora.exe'),'new'); const launcher=path.join(root,'deferred-launcher.exe'); put(launcher,'launcher');
  const marker=path.join(install,'.halora-update.json');
  const tx={root:install,stage,backup:path.join(root,'deferred-previous'),marker,launcher,launcherHash:deploy.hash(fs.readFileSync(launcher)),manifest:deploy.manifest(stage,'0.2.2')}; put(marker,JSON.stringify(tx));
  const app=spawn(path.join(target,'Halora.exe'),[],{windowsHide:true});
  assert.equal(deploy.running(install),true);
  const helper=spawn(process.execPath,[path.resolve(__dirname,'../scripts/deployment.cjs'),marker],{windowsHide:true});
  const completed=new Promise((resolve,reject)=>{helper.on('error',reject);helper.on('exit',code=>code===0?resolve():reject(new Error(String(code))));});
  await new Promise(r=>setTimeout(r,500)); assert.equal(fs.existsSync(marker),true);
  await completed;
  assert.equal(fs.existsSync(marker),false); assert.equal(fs.readFileSync(path.join(target,'Halora.exe'),'utf8'),'new');
  app.unref();
});
