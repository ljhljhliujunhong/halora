const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { readJson, writeJson, preferences, safePath } = require('../electron/storage.cjs');
const { PermissionQueue } = require('../electron/permissions.cjs');
const review = require('../electron/review.cjs');
const grokUpdate = require('../electron/update.cjs');
const archives = require('../electron/archives.cjs');
const { parseQuota } = require('../electron/billing.cjs');
const cache = 'E:/VsCodeProject/Agent缓存文件/temp/halora-workbench';
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'test-'));
const makeDir = name => { const dir = path.join(root, name); fs.mkdirSync(dir, {recursive:true}); return dir; };
const put = (dir, name, text) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); };
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {windowsHide:true, encoding:'utf8'});
function repo(name) {
  const cwd = makeDir(name); git(cwd, ['init', '-q']); git(cwd, ['config','user.name','Halora Test']); git(cwd, ['config','user.email','halora-test@example.invalid']);
  put(cwd, '代码.txt', 'before\n'); put(cwd, '.gitignore', 'ignored/\n'); git(cwd,['add','.']); git(cwd,['commit','-qm','initial']); return cwd;
}
test('atomic JSON survives a truncated latest write and preferences are bounded', () => {
  const file = path.join(root,'settings.json'); writeJson(file,{theme:'dark'}); writeJson(file,{theme:'light'}); fs.writeFileSync(file,'{"theme":');
  assert.equal(readJson(file).theme,'dark');
  assert.deepEqual([preferences({autoCompact:999,fontSize:1}).autoCompact,preferences({fontSize:1}).fontSize],[95,12]);
  assert.equal(preferences({permissionMode:'unknown'}).permissionMode,'agent');
});
test('permission requests stay isolated when answered out of order, cancelled, or disconnected', () => {
  const answers=[]; let latest=[];
  const q = new PermissionQueue((id,option)=>answers.push([id,option]), items=>latest=[...items]);
  q.add({requestId:1,sessionId:'a',options:[{id:'yes'}]}); q.add({requestId:2,sessionId:'b',options:[{id:'no'}]});
  assert.throws(()=>q.resolve(1,'no'),/无效/); assert.equal(latest.length,2);
  q.resolve(2,'no'); assert.equal(latest[0].sessionId,'a');
  q.cancelSession('b'); assert.equal(latest.length,1); q.cancelSession('a'); assert.deepEqual(answers,[[2,'no'],[1,'__cancel__']]);
  assert.throws(()=>q.resolve(1,'yes'),/已结束/); q.add({requestId:3,sessionId:'c',options:[]}); q.clear(); assert.equal(latest.length,0);
});
test('missing quota never becomes zero; real zero and invalid bounds are distinct', () => {
  assert.equal(parseQuota({},null,null),null);
  assert.equal(parseQuota({creditUsagePercent:null},null,null),null);
  assert.equal(parseQuota({creditUsagePercent:-1},null,null),null);
  assert.equal(parseQuota({creditUsagePercent:0},null,null).percent,0);
  assert.equal(parseQuota({creditUsagePercent:101},null,null),null);
});
test('grok update check parses json, ignores log lines, and treats matching versions as current', () => {
  assert.deepEqual(grokUpdate.parseCheck('{"currentVersion":"1.0.29","latestVersion":"1.0.30","updateAvailable":true,"error":null}'), { current: '1.0.29', latest: '1.0.30', available: true });
  assert.equal(grokUpdate.parseCheck('note\n{"currentVersion":"1.0.30","latestVersion":"1.0.30","updateAvailable":false,"error":null}').available, false);
  assert.equal(grokUpdate.parseCheck('{"currentVersion":"1.0.30","latestVersion":"1.0.30","updateAvailable":true,"error":null}').available, false);
  assert.throws(() => grokUpdate.parseCheck('{"error":"offline"}'), /offline/);
});
test('grok update install runs update then refuses if still behind', async () => {
  const calls = [];
  const run = async (_bin, args) => {
    calls.push(args[0] === 'update' && args[1] === '--check' ? 'check' : 'update');
    if (args.includes('--check')) return '{"currentVersion":"1.0.30","latestVersion":"1.0.30","updateAvailable":false,"error":null}';
    return 'updated';
  };
  assert.deepEqual(await grokUpdate.install('grok', run), { current: '1.0.30', latest: '1.0.30', available: false });
  assert.deepEqual(calls, ['update', 'check']);
  await assert.rejects(grokUpdate.install('grok', async (_bin, args) => args.includes('--check')
    ? '{"currentVersion":"1.0.29","latestVersion":"1.0.30","updateAvailable":true,"error":null}' : 'updated'), /没有完成/);
  await assert.rejects(grokUpdate.check(null), /找不到/);
});
test('review stages and unstages Unicode paths, commits only staged changes, and handles binary files', async () => {
  const cwd=repo('review'); put(cwd,'代码.txt','after\n'); put(cwd,'new.txt','new'); put(cwd,'binary.png',Buffer.from([0,1,2]));
  assert.match((await review.diff(cwd,'代码.txt')).text,/\+after/);
  assert.equal((await review.diff(cwd,'binary.png')).binary,true);
  assert.equal((await review.stage(cwd,['代码.txt'])).files.find(f=>f.path==='代码.txt').staged,true);
  assert.equal((await review.stage(cwd,['代码.txt'],true)).files.find(f=>f.path==='代码.txt').staged,false);
  await review.stage(cwd,['代码.txt']); const result=await review.commit(cwd,'test'); assert.ok(result.files.some(f=>f.path==='new.txt'));
  assert.ok(!result.files.some(f=>f.path==='代码.txt')); await assert.rejects(review.diff(cwd,'../outside'),/越界/);
  const child=path.join(cwd,'child'); fs.mkdirSync(child); await assert.rejects(review.review(child),/根目录/);
});
test('review stages every file and syncs commits with a local remote', async () => {
  const origin=makeDir('origin.git'); git(origin,['init','-q','--bare']);
  const cwd=repo('sync-src'); git(cwd,['remote','add','origin',origin.replace(/\\/g,'/')]); git(cwd,['push','-u','origin','HEAD']);
  put(cwd,'代码.txt','after\n'); put(cwd,'extra.txt','extra');
  const staged=await review.stage(cwd,true);
  assert.ok(staged.files.length>=2); assert.ok(staged.files.every(f=>f.staged));
  const unstaged=await review.stage(cwd,true,true);
  assert.ok(unstaged.files.every(f=>!f.staged));
  await review.stage(cwd,true); const committed=await review.commit(cwd,'all');
  assert.equal(committed.files.length,0); assert.equal(committed.ahead,1); assert.ok(committed.remotes.includes('origin'));
  const synced=await review.sync(cwd); assert.equal(synced.ahead,0); assert.equal(synced.behind,0);
  const other=path.join(root,'sync-clone'); git(root,['clone','-q',origin.replace(/\\/g,'/'),other]);
  git(other,['config','user.name','Halora Test']); git(other,['config','user.email','halora-test@example.invalid']);
  put(other,'from-other.txt','x'); git(other,['add','.']); git(other,['commit','-qm','other']); git(other,['push','-q','origin','HEAD']);
  const pulled=await review.sync(cwd);
  assert.equal(fs.readFileSync(path.join(cwd,'from-other.txt'),'utf8'),'x');
  assert.equal(pulled.behind,0); assert.equal(pulled.ahead,0);
  await assert.rejects(review.sync(repo('no-remote')),/远程/);
});
test('checkpoint restoration preserves ignored data, detects races, and makes a reversible backup', async () => {
  const cwd=repo('restore'), data=makeDir('data'); put(cwd,'ignored/secret','keep');
  const point=await review.checkpoint(data,cwd,'baseline','session');
  put(cwd,'代码.txt','changed'); put(cwd,'added','extra'); const preview=await review.restorePreview(data,cwd,point.id);
  put(cwd,'代码.txt','changed again'); await assert.rejects(review.restoreCheckpoint(data,cwd,point.id,preview.fingerprint),/发生变化/);
  const next=await review.restorePreview(data,cwd,point.id); const result=await review.restoreCheckpoint(data,cwd,point.id,next.fingerprint);
  assert.equal(fs.readFileSync(path.join(cwd,'代码.txt'),'utf8'),'before\n'); assert.equal(fs.existsSync(path.join(cwd,'added')),false);
  assert.equal(fs.readFileSync(path.join(cwd,'ignored/secret'),'utf8'),'keep');
  const undo=await review.restorePreview(data,cwd,result.backup.id); await review.restoreCheckpoint(data,cwd,result.backup.id,undo.fingerprint);
  assert.equal(fs.readFileSync(path.join(cwd,'代码.txt'),'utf8'),'changed again'); assert.equal(fs.readFileSync(path.join(cwd,'added'),'utf8'),'extra');
});
test('checkpoint supports a file changing into a directory and back', async () => {
  const cwd=repo('transition'), data=makeDir('transition-data'); put(cwd,'slot','original');
  const point=await review.checkpoint(data,cwd,'file'); fs.unlinkSync(path.join(cwd,'slot')); put(cwd,'slot/child','child');
  const p=await review.restorePreview(data,cwd,point.id); const r=await review.restoreCheckpoint(data,cwd,point.id,p.fingerprint);
  assert.equal(fs.readFileSync(path.join(cwd,'slot'),'utf8'),'original');
  const q=await review.restorePreview(data,cwd,r.backup.id); await review.restoreCheckpoint(data,cwd,r.backup.id,q.fingerprint);
  assert.equal(fs.readFileSync(path.join(cwd,'slot/child'),'utf8'),'child');
});
test('backup roundtrip excludes credentials, preserves unrelated data, rebases drafts and keeps recovery backup', () => {
  const data=makeDir('backup-data'), grok=makeDir('backup-grok'), target=makeDir('target-data'), targetGrok=makeDir('target-grok');
  put(data,'settings.json','{"theme":"dark"}'); put(data,'composer.json',JSON.stringify({chat:{draft:'hello',updatedAt:1,attachments:[{path:path.join(data,'inbox','image.png')}]}}));
  put(data,'inbox/image.png','image'); put(grok,'sessions/project/chat/summary.json','{}'); put(grok,'auth.json','secret'); put(grok,'skills/demo/SKILL.md','# Demo');
  const file=path.join(root,'backup.halora'); archives.createBackup(data,grok,file); const bundle=archives.parseBackup(file);
  assert.ok(!bundle.files.some(f=>f.path.includes('auth'))); put(target,'settings.json','{"theme":"light"}'); put(targetGrok,'sessions/unrelated/chat','keep');
  const result=archives.restoreBackup(target,targetGrok,file,bundle.fingerprint);
  assert.equal(readJson(path.join(target,'settings.json')).theme,'dark'); assert.ok(fs.existsSync(result.backup));
  assert.equal(readJson(path.join(target,'composer.json')).chat.attachments[0].path,path.join(target,'inbox','image.png'));
  assert.equal(fs.readFileSync(path.join(targetGrok,'sessions/unrelated/chat'),'utf8'),'keep');
  assert.throws(()=>archives.restoreBackup(target,targetGrok,file,'changed'),/已改变/);
});
test('backup and file guards reject traversal, alternate streams, reserved names and case collisions', () => {
  for(const name of ['../outside','folder/../../outside','C:/outside','x:stream','folder/NUL.txt','folder./x']) assert.throws(()=>safePath(root,name));
  for(const files of [[{path:'sessions/../../escape',data:''}],[{path:'app/auth.json',data:''}],[{path:'sessions/a',data:''},{path:'sessions/A',data:''}]]) {
    const file=path.join(root,'bad.halora'); fs.writeFileSync(file,zlib.gzipSync(JSON.stringify({format:'halora-backup',version:1,files})));
    assert.throws(()=>archives.parseBackup(file));
  }
});
test('exports preserve tool results and escape executable HTML', () => {
  const messages=[{role:'user',text:'<script>alert(1)</script>'},{role:'assistant',text:'answer',tools:[{title:'read',output:'tool text'}]}];
  assert.match(archives.exportTranscript(messages,'title','md'),/tool text/);
  const html=archives.exportTranscript(messages,'<title>','html'); assert.ok(!html.includes('<script>')); assert.match(html,/&lt;script&gt;/);
  assert.deepEqual(JSON.parse(archives.exportTranscript(messages,'title','json')).messages,messages);
});
