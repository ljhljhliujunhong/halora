const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

const cache = process.env.GROKBUILD_TEST_ROOT || "E:/VsCodeProject/Agent缓存文件/temp/grokbuild-fixes";
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, "regression-"));
process.env.GROK_HOME = path.join(root, "grok");
const { buildContext, rememberCompaction } = require("../electron/context.cjs");
const { canonicalCwd, readTranscript, recordTurnDuration } = require("../electron/sessions.cjs");
const { classifyDroppedPath, classifyDroppedPaths, locateResource } = require("../electron/files.cjs");
const { looksLikeFile } = require("../src/resource-hint.mjs");
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};
const at = Date.now() - 10000;
function fixture(project, id, active = "2026-09-01T00:00:00Z") {
  const cwd = path.join(root, project);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(cwd), id);
  const summary = { info: { id, cwd }, generated_title: id, created_at: active, last_active_at: active };
  writeJson(path.join(dir, "summary.json"), summary);
  writeJson(path.join(dir, "signals.json"), {
    contextTokensUsed: 131235, contextWindowTokens: 500000, contextWindowUsage: 26,
  });
  fs.utimesSync(path.join(dir, "signals.json"), new Date(at - 1000), new Date(at - 1000));
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), JSON.stringify({type: "user", content: [{type: "text", text: "压缩后的摘要".repeat(500)}]}) + "\n");
  fs.utimesSync(path.join(dir, "chat_history.jsonl"), new Date(at), new Date(at));
  return { cwd, dir, id, summary };
}
function completion(f, after, timestamp = at) {
  return { sessionId: f.id, _meta: { agentTimestampMs: timestamp }, update: {
    sessionUpdate: "auto_compact_completed", tokens_before: 131235, tokens_after: after,
  } };
}
function persistCompletion(f, after) {
  const params = completion(f, after);
  fs.appendFileSync(path.join(f.dir, "updates.jsonl"), JSON.stringify({
    timestamp: at / 1000, method: "_x.ai/session/update", params,
  }) + "\n");
  return params;
}

test("restore compacted usage from disk and accept later real growth", () => {
  const f = fixture("context", "restore");
  persistCompletion(f, 16187);
  let c = buildContext(f.cwd, f.id);
  assert.equal(c.used, 16187);
  assert.equal(c.estimated, false);
  assert.equal(c.percent, 3);
  assert.equal(c.free, 483813);
  // A stale rewrite must not undo the compaction.
  fs.utimesSync(path.join(f.dir, "signals.json"), new Date(), new Date());
  assert.equal(buildContext(f.cwd, f.id).used, 16187);
  writeJson(path.join(f.dir, "signals.json"), { contextTokensUsed: 190000, contextWindowTokens: 500000 });
  c = buildContext(f.cwd, f.id);
  assert.equal(c.used, 190000);
  assert.equal(c.estimated, false);
});

test("bogus unchanged completion uses active history as an explicit estimate", () => {
  const f = fixture("context", "unchanged");
  persistCompletion(f, 131235);
  let c = buildContext(f.cwd, f.id);
  assert.ok(c.used > 0 && c.used < 10000);
  assert.equal(c.estimated, true);
  const before = c.used;
  fs.appendFileSync(path.join(f.dir, "chat_history.jsonl"), JSON.stringify({type:"assistant",content:"new content".repeat(1000)}) + "\n");
  c = buildContext(f.cwd, f.id);
  assert.ok(c.used > before);
  assert.equal(c.free, c.total - c.used);
});

test("compact is not undone by a larger leftover signals count", () => {
  const f = fixture("context", "mismatch");
  writeJson(path.join(f.dir, "signals.json"), { contextTokensUsed: 100000, contextWindowTokens: 500000 });
  fs.utimesSync(path.join(f.dir, "signals.json"), new Date(at - 1000), new Date(at - 1000));
  rememberCompaction(f.cwd, f.id, {
    sessionId: f.id,
    _meta: { agentTimestampMs: at },
    update: { sessionUpdate: "auto_compact_completed", tokens_before: 13000, tokens_after: 11000 },
  });
  assert.equal(buildContext(f.cwd, f.id).used, 11000);
  fs.utimesSync(path.join(f.dir, "signals.json"), new Date(), new Date());
  assert.equal(buildContext(f.cwd, f.id).used, 11000);
  writeJson(path.join(f.dir, "signals.json"), { contextTokensUsed: 100000, contextWindowTokens: 500000 });
  assert.equal(buildContext(f.cwd, f.id).used, 11000);
  writeJson(path.join(f.dir, "signals.json"), { contextTokensUsed: 15000, contextWindowTokens: 500000 });
  assert.equal(buildContext(f.cwd, f.id).used, 15000);
});
test("zero and missing tokens are distinct, and usage is isolated per session", () => {
  const zero = fixture("context", "zero");
  rememberCompaction(zero.cwd, zero.id, completion(zero, 0));
  assert.equal(buildContext(zero.cwd, zero.id).used, 0);
  const missing = fixture("context", "missing");
  rememberCompaction(missing.cwd, missing.id, completion(missing, null));
  assert.equal(buildContext(missing.cwd, missing.id).estimated, true);
  const untouched = fixture("context", "untouched");
  assert.equal(buildContext(untouched.cwd, untouched.id).used, 131235);
});

function mainHarness(options = {}) {
  const file = path.resolve(__dirname, "../electron/main.cjs");
  const localRequire = createRequire(file);
  const handlers = new Map();
  const events = [];
  const userData = path.join(root, "settings");
  class FakeAcp extends EventEmitter {
    alive = true;
    cancelled = [];
    loads = [];
    prompts = [];
    answers = [];
    answerPermission(id, option) { this.answers.push([id, option]); }
    async setModel() {}
    async loadSession(id) {
      this.loads.push(id);
      return {};
    }
    async prompt(id) {
      this.prompts.push(id);
      return {};
    }
    cancel(id) {
      this.cancelled.push(id);
    }
    async compact(id) {
      this.emit("notification", "_x.ai/session/update", this.notice);
      return {};
    }
    start() { this.alive = true; this.started = true; }
    async initialize() { this.inited = true; return {}; }
    stop() {}
  }
  const sandbox = {
    require(name) {
      if (name === "electron") return {
        app: { getPath: () => userData, setName() {}, setAppUserModelId() {}, on() {}, whenReady: () => ({then() {}}), relaunch() { events.push({ type: "relaunch" }); }, exit() { events.push({ type: "exit" }); } },
        dialog: options.dialog || { showMessageBox: async () => ({ response: 1 }) },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      };
      if (name === "./acp.cjs") return { AcpClient: FakeAcp };
      if (name === "./billing.cjs") return options.billing || { fetchQuota: async () => null, hasAuth: () => false };
      if (name === "./update.cjs") return options.update || localRequire(name);
      if (name === "node:fs") return { ...fs, watch: () => ({close() {}}) };
      return localRequire(name);
    },
    __dirname: path.dirname(file), process, Buffer,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8") + "\nglobalThis.harness = { state, acp, refreshSessions, refreshContext, snapshot, saveSettings, loadSettings, beginTurn, endTurn, recovery, markInterrupted, setWindow: (value) => { win = value; } };", sandbox);
  const h = sandbox.harness;
  h.state.ready = true;
  h.setWindow({webContents: { send: (_channel, event) => events.push(event) }});
  return { ...h, handlers, events };
}

test('theme changes do not require writable Grok config and threshold failure preserves local preferences', async () => {
  const h = mainHarness(); h.saveSettings({ autoCompact: 85 });
  const config = path.join(process.env.GROK_HOME, 'config.toml');
  fs.mkdirSync(config, { recursive: true });
  const result = await h.handlers.get('save-preferences')(null, { theme: 'dark', autoCompact: 85 });
  assert.equal(result.preferences.theme, 'dark'); assert.equal(result.settingsWarning, '');
  const next = await h.handlers.get('save-preferences')(null, { fontSize: 16, autoCompact: 80 });
  assert.equal(next.preferences.fontSize, 16); assert.equal(next.preferences.autoCompact, 80); assert.match(next.settingsWarning, /写入失败/);
});

test("compact IPC handles vendor channel and survives refresh/load/send", async () => {
  const f = fixture("integration", "compact");
  const h = mainHarness();
  h.state.cwd = f.cwd;
  h.state.sessionId = f.id;
  h.acp.notice = completion(f, 16187);
  await h.handlers.get("compact")(null, "keep decisions");
  assert.equal(h.snapshot().context.used, 16187);
  assert.ok(h.events.some(e => e.type === "compact" && e.payload.phase === "done" && e.payload.tokensAfter === 16187));
  h.refreshContext();
  assert.equal(h.snapshot().context.used, 16187);
  await h.handlers.get("load-chat")(null, { cwd: f.cwd, id: f.id });
  assert.equal(h.snapshot().context.used, 16187);
  await h.handlers.get("send-prompt")(null, "hello");
  assert.equal(h.snapshot().context.used, 16187);
  for (const channel of ["session/update", "x.ai/session/update", "_x.ai/session_notification"]) {
    h.acp.emit("notification", channel, completion(f, 12000, at + 500));
    assert.equal(h.snapshot().context.used, 12000);
  }
  h.acp.emit("notification", "_x.ai/session/update", completion({id:"different"}, 1, at+1000));
  assert.equal(h.snapshot().context.used, 12000);
});

test("project and chat order survives activity, transient missing summaries, and restart", async () => {
  const first = fixture("project-a", "first", "2026-09-03T00:00:00Z");
  const middle = fixture("project-a", "middle", "2026-09-02T00:00:00Z");
  fixture("project-a", "last", "2026-09-01T00:00:00Z");
  fixture("project-b", "other", "2026-09-04T00:00:00Z");
  const h = mainHarness();
  h.refreshSessions();
  const order = () => JSON.stringify(h.state.projects.map(p => [p.cwd, p.sessions.map(s => s.id)]));
  const original = order();
  writeJson(path.join(middle.dir, "summary.json"), {...middle.summary, last_active_at:"2026-09-08T00:00:00Z"});
  h.refreshSessions();
  assert.equal(order(), original);
  fs.renameSync(path.join(middle.dir,"summary.json"), path.join(middle.dir,"summary.pending"));
  h.refreshSessions();
  fs.renameSync(path.join(middle.dir,"summary.pending"), path.join(middle.dir,"summary.json"));
  h.refreshSessions();
  assert.equal(order(), original);
  const restarted = mainHarness();
  restarted.refreshSessions();
  assert.equal(JSON.stringify(restarted.state.projects.map(p => [p.cwd, p.sessions.map(s => s.id)])), original);
  const reversed = h.state.projects.map(p => p.cwd).reverse();
  await h.handlers.get("reorder-projects")(null, reversed);
  assert.deepEqual(Array.from(h.state.projects, p => p.cwd), reversed);
  await h.handlers.get("pin-chat")(null, {id:middle.id, pinned:true});
  assert.equal(h.state.projects.find(p => canonicalCwd(p.cwd) === canonicalCwd(first.cwd)).sessions[0].id, middle.id);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

test("switching chats keeps the other session running and accepts a second prompt", async () => {
  const a = fixture("live-a", "alpha");
  const b = fixture("live-b", "beta");
  const h = mainHarness();
  const waits = new Map();
  h.acp.prompt = async (id) => {
    h.acp.prompts.push(id);
    return new Promise((resolve) => waits.set(id, resolve));
  };
  h.state.cwd = a.cwd;
  h.state.sessionId = a.id;
  const pendingA = h.handlers.get("send-prompt")(null, { text: "from a", sessionId: a.id, cwd: a.cwd });
  await waitFor(() => h.snapshot().runningIds.includes(a.id));
  assert.equal(h.snapshot().running, true);
  await h.handlers.get("load-chat")(null, { cwd: b.cwd, id: b.id });
  assert.deepEqual(h.acp.cancelled, []);
  assert.equal(h.snapshot().sessionId, b.id);
  assert.equal(h.snapshot().running, false);
  assert.deepEqual([...h.snapshot().runningIds], [a.id]);
  h.events.length = 0;
  h.acp.emit("notification", "session/update", {
    sessionId: a.id,
    update: { sessionUpdate: "agent_message_chunk", content: { text: "still going" } },
  });
  assert.ok(h.events.some((event) => event.type === "update" && event.payload.sessionId === a.id));
  const pendingB = h.handlers.get("send-prompt")(null, { text: "from b", sessionId: b.id, cwd: b.cwd });
  await waitFor(() => h.snapshot().runningIds.includes(b.id));
  assert.equal(h.snapshot().running, true);
  assert.ok(h.snapshot().runningIds.includes(a.id));
  assert.ok(h.snapshot().runningIds.includes(b.id));
  assert.deepEqual(h.acp.cancelled, []);
  const loadsBeforeReturn = h.acp.loads.length;
  await h.handlers.get("load-chat")(null, { cwd: a.cwd, id: a.id });
  assert.equal(h.acp.loads.length, loadsBeforeReturn);
  assert.equal(h.snapshot().running, true);
  assert.deepEqual(h.acp.cancelled, []);
  await waitFor(() => waits.has(a.id) && waits.has(b.id));
  waits.get(a.id)({});
  await pendingA;
  assert.ok(!h.snapshot().runningIds.includes(a.id));
  assert.ok(h.snapshot().runningIds.includes(b.id));
  waits.get(b.id)({});
  await pendingB;
  assert.equal(h.snapshot().runningIds.length, 0);
});

test('disconnect preserves interrupted turns and accepted queue items across restart', async () => {
  const f = fixture('recovery', 'recover'); const h = mainHarness(); h.state.cwd=f.cwd; h.state.sessionId=f.id;
  h.beginTurn(f.id, f.cwd, {user:'finish work',itemId:'already-sent'});
  h.acp.emit('permission',{requestId:901,params:{sessionId:f.id,toolCall:{title:'Write'},options:[{optionId:'allow',kind:'allow_once'}]}});
  assert.equal(h.snapshot().permissions.length,1);
  h.acp.emit('exit',1);
  assert.equal(h.snapshot().permissions.length,0); assert.equal(h.snapshot().runningIds.length,0);
  assert.equal(h.recovery().turns[f.id].status,'interrupted');
  await h.handlers.get('save-composer')(null,{key:f.id,value:{draft:'keep draft',queue:[{id:'already-sent'},{id:'unsent'}]}});
  const second=mainHarness(); const state=await second.handlers.get('get-state')();
  assert.ok(state.interrupted.some(t=>t.id===f.id)); assert.equal(state.composers[f.id].draft,'keep draft');
  assert.deepEqual(state.composers[f.id].queue.map(q=>q.id),['unsent']);
  await second.handlers.get('dismiss-recovery')(null,f.id); assert.ok(!second.snapshot().interrupted.some(t=>t.id===f.id));
});

test('quota failure exposes stale status and timestamp without erasing a known balance', async () => {
  const h=mainHarness({billing:{fetchQuota:async()=>{throw new Error('billing 503');},hasAuth:()=>true}});
  h.state.quota={percent:32,updatedAt:'2026-09-01T00:00:00Z'};
  const next=await h.handlers.get('refresh-quota')();
  assert.equal(next.quota.percent,32); assert.equal(next.quota.status,'stale'); assert.equal(next.quota.updatedAt,'2026-09-01T00:00:00Z');
  h.state.quota=null; const unavailable=await h.handlers.get('refresh-quota')(); assert.equal(unavailable.quota.percent,null); assert.equal(unavailable.quota.status,'unavailable');
});

test('ACP permissions can be answered for a background session without replacing the foreground request', async () => {
  const f=fixture('permissions','permission-a'), g=fixture('permissions','permission-b'); const h=mainHarness(); h.state.cwd=f.cwd;h.state.sessionId=f.id;
  for(const [id,sessionId] of [[101,f.id],[102,g.id]]) h.acp.emit('permission',{requestId:id,params:{sessionId,options:[{optionId:'allow',kind:'allow_once'}],toolCall:{title:'edit'}}});
  assert.equal(h.snapshot().permissions.length,2); await h.handlers.get('answer-permission')(null,{requestId:102,optionId:'allow'});
  assert.equal(h.snapshot().permissions[0].sessionId,f.id); assert.deepEqual(h.acp.answers,[[102,'allow']]);
});

test('sessions stored with forward slashes reopen on Windows', () => {
  const cwd=path.join(root,'forward');fs.mkdirSync(cwd,{recursive:true});const id='forward-session';
  const dir=path.join(process.env.GROK_HOME,'sessions',encodeURIComponent(cwd.replace(/\\/g,'/')),id);
  writeJson(path.join(dir,'summary.json'),{info:{id,cwd}});
  fs.writeFileSync(path.join(dir,'chat_history.jsonl'),JSON.stringify({type:'user',content:'hello'})+'\n');
  assert.ok(readTranscript(cwd,id).some(m=>m.text==='hello'));
});

test('rewind uses conversation-only mode, backs up first, and surfaces native failure', async () => {
  const f=fixture('rewind-test','rewind-fixture'); const h=mainHarness();h.state.cwd=f.cwd;h.state.sessionId=f.id;
  let mode;
  h.acp.request=async(method,params)=>{
    if(method.endsWith('/points')) return {rewind_points:[{prompt_index:0}]};
    mode=params.mode; return {success:false,error:'test rejection'};
  };
  await assert.rejects(h.handlers.get('rewind-execute')(null,{cwd:f.cwd,sessionId:f.id,index:0}),/test rejection/);
  assert.equal(mode,'conversation_only');
  const backupRoot=path.join(root,'settings','rewind-backups'); const folder=fs.readdirSync(backupRoot).find(f=>f.startsWith('rewind-fixture-'));
  assert.ok(fs.existsSync(path.join(backupRoot,folder,'chat_history.jsonl')));
  assert.ok(fs.existsSync(path.join(f.dir,'chat_history.jsonl')));
});

test("turn durations restore from events.jsonl and sidecar after reopen", () => {
  const f = fixture("duration", "chat");
  fs.writeFileSync(path.join(f.dir, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "first question" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "first answer" }] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "second question" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "second answer" }] }),
  ].join("\n") + "\n");
  const start1 = "2026-09-07T14:51:15.037Z";
  const end1 = "2026-09-07T14:52:32.942Z";
  const start2 = "2026-09-07T14:54:48.102Z";
  const end2 = "2026-09-07T14:54:57.086Z";
  fs.writeFileSync(path.join(f.dir, "events.jsonl"), [
    JSON.stringify({ ts: start1, type: "turn_started", turn_number: 0 }),
    JSON.stringify({ ts: end1, type: "turn_ended", outcome: "completed" }),
    JSON.stringify({ ts: start2, type: "turn_started", turn_number: 1 }),
    JSON.stringify({ ts: end2, type: "turn_ended", outcome: "completed" }),
  ].join("\n") + "\n");
  let msgs = readTranscript(f.cwd, f.id);
  const first = msgs.filter((item) => item.role === "assistant");
  assert.equal(first.length, 2);
  assert.equal(first[0].durationMs, Date.parse(end1) - Date.parse(start1));
  assert.equal(first[1].durationMs, Date.parse(end2) - Date.parse(start2));
  recordTurnDuration(f.cwd, f.id, {
    startedAt: 1000,
    endedAt: 124000,
    durationMs: 123000,
    user: "second question",
  });
  msgs = readTranscript(f.cwd, f.id);
  const second = msgs.filter((item) => item.role === "assistant");
  assert.equal(second[0].durationMs, Date.parse(end1) - Date.parse(start1));
  assert.equal(second[1].durationMs, 123000);
});

test("unclosed turn_started still yields a duration, open turn does not", () => {
  const f = fixture("duration", "open-turn");
  fs.writeFileSync(path.join(f.dir, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "one" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a1" }] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "two" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a2" }] }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(f.dir, "events.jsonl"), [
    JSON.stringify({ ts: "2026-09-08T02:21:40.000Z", type: "turn_started" }),
    JSON.stringify({ ts: "2026-09-08T02:25:51.000Z", type: "turn_started" }),
    JSON.stringify({ ts: "2026-09-08T02:26:10.000Z", type: "turn_ended", outcome: "completed" }),
  ].join("\n") + "\n");
  const msgs = readTranscript(f.cwd, f.id).filter((item) => item.role === "assistant");
  assert.equal(msgs[0].durationMs, Date.parse("2026-09-08T02:25:51.000Z") - Date.parse("2026-09-08T02:21:40.000Z"));
  assert.equal(msgs[1].durationMs, Date.parse("2026-09-08T02:26:10.000Z") - Date.parse("2026-09-08T02:25:51.000Z"));
});

test("an in-progress assistant does not inherit the previous turn duration", () => {
  const f = fixture("duration", "live-tail");
  fs.writeFileSync(path.join(f.dir, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "one" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a1" }] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "two" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "still running" }] }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(f.dir, "events.jsonl"), [
    JSON.stringify({ ts: "2026-09-08T16:06:54.000Z", type: "turn_started" }),
    JSON.stringify({ ts: "2026-09-08T16:08:22.000Z", type: "turn_ended", outcome: "completed" }),
    JSON.stringify({ ts: "2026-09-08T16:10:33.000Z", type: "turn_started" }),
  ].join("\n") + "\n");
  const msgs = readTranscript(f.cwd, f.id).filter((item) => item.role === "assistant");
  assert.equal(msgs[0].durationMs, Date.parse("2026-09-08T16:08:22.000Z") - Date.parse("2026-09-08T16:06:54.000Z"));
  assert.equal(msgs[1].durationMs, undefined);
});

test("send-prompt records duration and compact does not", async () => {
  const f = fixture("duration", "persist");
  const h = mainHarness();
  h.state.cwd = f.cwd;
  h.state.sessionId = f.id;
  h.acp.notice = completion(f, 16187);
  await h.handlers.get("compact")(null, "keep");
  assert.equal(fs.existsSync(path.join(f.dir, "halora-turns.jsonl")), false);
  h.acp.prompt = async (id) => {
    h.acp.emit("notification", "session/update", {
      sessionId: id,
      update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
    });
    return {};
  };
  await h.handlers.get("send-prompt")(null, { text: "hello there", sessionId: f.id, cwd: f.cwd });
  const rows = fs.readFileSync(path.join(f.dir, "halora-turns.jsonl"), "utf8").trim().split(/\n/);
  assert.equal(rows.length, 1);
  const row = JSON.parse(rows[0]);
  assert.ok(row.durationMs >= 0);
  assert.equal(row.user, "hello there");
});

test("startup shows last saved quota before a live fetch", async () => {
  const h = mainHarness();
  h.saveSettings({
    lastQuota: {
      percent: 6,
      window: "本周",
      resetAt: "2026-09-14T00:00:00Z",
      plan: "SuperGrok",
      resets: 2,
      resetCardUntil: null,
    },
  });
  h.state.quota = null;
  const snap = await h.handlers.get("get-state")();
  assert.equal(snap.quota.percent, 6);
  assert.equal(snap.quota.window, "本周");
  assert.equal(snap.quota.resets, 2);
});

test("dropped folders and files become attachments", () => {
  const dir = path.join(root, "drop-box");
  const inner = path.join(dir, "notes");
  fs.mkdirSync(inner, { recursive: true });
  const file = path.join(dir, "readme.txt");
  fs.writeFileSync(file, "hello");
  const folder = classifyDroppedPath(inner);
  const plain = classifyDroppedPath(file);
  assert.equal(folder.kind, "folder");
  assert.equal(folder.name, "notes");
  assert.equal(plain.kind, "file");
  assert.equal(plain.name, "readme.txt");
  const mixed = classifyDroppedPaths([inner, file, file, path.join(dir, "missing")]);
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed.map((item) => item.kind), ["folder", "file"]);
});

test("resolve-drops ipc keeps a folder as one attachment", async () => {
  const dir = path.join(root, "drop-ipc");
  fs.mkdirSync(dir, { recursive: true });
  const h = mainHarness();
  const rows = await h.handlers.get("resolve-drops")(null, [dir]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "folder");
  assert.equal(rows[0].name, "drop-ipc");
});

test("locateResource finds relative, absolute, and basename-only files", () => {
  const cwd = path.join(root, "assets-project");
  const nested = path.join(cwd, "images");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "starbase-girl-model3-v1.jpg");
  fs.writeFileSync(file, "x");
  assert.equal(locateResource(cwd, file), path.resolve(file));
  assert.equal(locateResource(cwd, "images/starbase-girl-model3-v1.jpg"), path.resolve(file));
  assert.equal(locateResource(cwd, "starbase-girl-model3-v1.jpg"), path.resolve(file));
  assert.equal(locateResource(cwd, "`starbase-girl-model3-v1.jpg`"), path.resolve(file));
  assert.equal(locateResource(cwd, "missing-nope.jpg"), null);
});

test("opening the app connects grok instead of showing disconnected", async () => {
  const fake = path.join(root, "fake-grok.exe");
  fs.writeFileSync(fake, "fake");
  process.env.GROK_BINARY = fake;
  const h = mainHarness();
  h.state.ready = false;
  const snap = await h.handlers.get("get-state")();
  assert.equal(snap.connection, "reconnecting");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.state.ready, true);
  assert.equal(h.snapshot().connection, "connected");
  assert.equal(h.snapshot().everReady, true);
});

test("settings can check grok updates, block install while running, and restart after install", async () => {
  let current = "1.0.29";
  const update = {
    check: async () => ({ current, latest: "1.0.30", available: current !== "1.0.30" }),
    install: async () => { current = "1.0.30"; return { current, latest: "1.0.30", available: false }; },
  };
  const later = mainHarness({ update, dialog: { showMessageBox: async () => ({ response: 0 }) } });
  later.state.grokBin = "grok";
  const checked = await later.handlers.get("grok-check-update")();
  assert.equal(checked.available, true);
  const gen = later.beginTurn("busy", later.state.cwd || root, { user: "hi" });
  await assert.rejects(later.handlers.get("grok-install-update")(), /停止/);
  later.endTurn("busy", gen);
  const installed = await later.handlers.get("grok-install-update")();
  assert.equal(installed.available, false);
  assert.equal(installed.relaunched, false);
  const restart = mainHarness({ update, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  restart.state.grokBin = "grok";
  current = "1.0.29";
  const done = await restart.handlers.get("grok-install-update")();
  assert.equal(done.relaunched, true);
  assert.ok(restart.events.some((event) => event.type === "relaunch"));
});
test("looksLikeFile accepts real files and rejects emails and sites", () => {
  assert.equal(looksLikeFile("starbase-girl-model3-v1.jpg"), "starbase-girl-model3-v1.jpg");
  assert.equal(looksLikeFile("`src/App.jsx`"), "src/App.jsx");
  assert.equal(looksLikeFile("E:/folder/notes.md"), "E:/folder/notes.md");
  assert.equal(looksLikeFile("1914210972@qq.com"), "");
  assert.equal(looksLikeFile("junhong liu (1914210972@qq.com)"), "");
  assert.equal(looksLikeFile("https://luma.com/l0jfxz91"), "");
  assert.equal(looksLikeFile("luma.com"), "");
  assert.equal(looksLikeFile("qq.com"), "");
});
