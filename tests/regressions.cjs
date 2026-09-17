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
const { canonicalCwd, readTranscript, recordTurnDuration, deleteSession, listProjects } = require("../electron/sessions.cjs");
const { classifyDroppedPath, classifyDroppedPaths, locateResource } = require("../electron/files.cjs");
const { looksLikeFile } = require("../src/resource-hint.mjs");
const { agentSpawnArgs, sessionMeta, modeSyncSteps, planRequest, questionRequest, planReply, questionReply } = require("../electron/permission-mode.cjs");
const { normalizeEffort, clampEffort, parseConfigOptions, configFromResult, effortFromSummary, defaultEffortOptions } = require("../electron/effort.cjs");
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
    commands = [];
    answers = [];
    modes = [];
    yolos = [];
    plans = [];
    questions = [];
    answerPermission(id, option) { this.answers.push([id, option]); }
    answerPlan(id, outcome, feedback) { this.plans.push([id, outcome, feedback]); }
    answerQuestion(id, outcome, answers) { this.questions.push([id, outcome, answers]); }
    async setMode(sessionId, modeId) { this.modes.push([sessionId, modeId]); return {}; }
    setYolo(sessionId, enabled) { this.yolos.push([sessionId, enabled]); }
    async setModel() {}
    async setConfigOption(sessionId, configId, value) {
      this.config = { sessionId, configId, value };
      return {};
    }
    async newSession(cwd, mode) {
      this.created = { cwd, mode };
      return { sessionId: "created-session" };
    }
    async loadSession(id, cwd, mode) {
      this.loads.push(id);
      this.loaded = { id, cwd, mode };
      return {};
    }
    async prompt(id, text) {
      this.prompts.push(id);
      this.commands.push(text);
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
    stop() { this.alive = false; this.stopped = true; }
    async stopAndWait() { this.stop(); }
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

test('cancel then steer emits separate turn clocks and rejects the old completion', async () => {
  const f = fixture('duration', 'steering');
  const h = mainHarness();
  h.state.cwd = f.cwd; h.state.sessionId = f.id;
  const oldGen = h.beginTurn(f.id, f.cwd, { user: 'first' });
  const first = h.snapshot().activeTurns[f.id];
  const update = { sessionId: f.id, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'reply' } } };
  h.acp.emit('notification', 'session/update', update);
  await h.handlers.get('cancel')(null, f.id);
  const nextGen = h.beginTurn(f.id, f.cwd, { user: 'steered' });
  const next = h.snapshot().activeTurns[f.id];
  assert.notEqual(first.turnId, next.turnId);
  assert.equal(h.endTurn(f.id, oldGen), false);
  assert.equal(h.snapshot().activeTurns[f.id].turnId, next.turnId);
  h.acp.emit('notification', 'session/update', update);
  assert.equal(h.events.filter(e => e.type === 'update').at(-1).payload.turn.turnId, next.turnId);
  assert.equal(h.endTurn(f.id, nextGen), true);
  const ends = h.events.filter(e => e.type === 'turn-end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].payload.turnId, first.turnId);
  assert.equal(ends[1].payload.turnId, next.turnId);
  assert.equal(h.snapshot().activeTurns[f.id], undefined);
  const recorded = fs.readFileSync(path.join(f.dir, 'halora-turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(r => r.user), ['first', 'steered']);
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
  const dialogs = [];
  const update = {
    check: async () => ({ current, latest: "1.0.30", available: current !== "1.0.30" }),
    install: async (_bin, _run, version) => {
      assert.equal(version, "1.0.30");
      current = "1.0.30";
      return { current, latest: "1.0.30", available: false };
    },
    runGrok: async () => "",
  };
  const later = mainHarness({
    update,
    dialog: { showMessageBox: async (_win, opts) => { dialogs.push(opts); return { response: 0 }; } },
  });
  later.state.grokBin = "grok";
  const checked = await later.handlers.get("grok-check-update")();
  assert.equal(checked.available, true);
  const gen = later.beginTurn("busy", later.state.cwd || root, { user: "hi" });
  const skipped = await later.handlers.get("grok-install-update")();
  assert.equal(skipped, null);
  assert.equal(dialogs.at(-1).buttons.join(","), "取消,继续");
  later.endTurn("busy", gen);
  const installed = await later.handlers.get("grok-install-update")();
  assert.equal(installed.available, false);
  assert.equal(installed.pendingRestart, true);
  assert.equal(installed.relaunched, false);
  assert.match(dialogs.at(-1).message, /1\.0\.30/);
  const restart = mainHarness({
    update,
    dialog: { showMessageBox: async (_win, opts) => { dialogs.push(opts); return { response: 1 }; } },
  });
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

test("permission modes map onto Grok spawn, session meta, and ACP mode steps", () => {
  assert.deepEqual(agentSpawnArgs().slice(0, 4), ["--permission-mode", "default", "agent", "--no-leader"]);
  assert.deepEqual(sessionMeta("yolo"), { yoloMode: true });
  assert.deepEqual(sessionMeta("agent"), { yoloMode: false });
  assert.deepEqual(sessionMeta("plan"), { yoloMode: false });
  assert.deepEqual(modeSyncSteps("agent", "yolo"), { yolo: true });
  assert.deepEqual(modeSyncSteps("yolo", "agent"), { yolo: false });
  assert.deepEqual(modeSyncSteps("agent", "plan"), { mode: "plan" });
  assert.deepEqual(modeSyncSteps("plan", "agent"), { mode: "default" });
  assert.deepEqual(modeSyncSteps("yolo", "plan"), { yolo: false, mode: "plan" });
  assert.deepEqual(modeSyncSteps("plan", "yolo"), { yolo: true, mode: "default" });
  assert.deepEqual(modeSyncSteps("agent", "agent"), {});
});

test("switching the picker uses set_mode and the yolo notification, never a prompt", async () => {
  const f = fixture("modes", "live");
  const h = mainHarness();
  h.state.cwd = f.cwd;
  h.state.sessionId = f.id;
  h.state.permissionMode = "agent";
  await h.handlers.get("load-chat")(null, { cwd: f.cwd, id: f.id });
  assert.equal(h.acp.loaded.id, f.id);
  assert.deepEqual(h.acp.modes, []);
  assert.deepEqual(h.acp.yolos, []);
  await h.handlers.get("set-permission-mode")(null, "yolo");
  assert.deepEqual(h.acp.yolos, [[f.id, true]]);
  assert.deepEqual(h.acp.modes, []);
  assert.equal(h.snapshot().permissionMode, "yolo");
  h.acp.emit("permission", {
    requestId: 7,
    params: {
      sessionId: f.id,
      toolCall: { title: "删除文件" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(h.acp.answers, [[7, "allow-once"]]);
  await h.handlers.get("set-permission-mode")(null, "plan");
  assert.deepEqual(h.acp.yolos, [[f.id, true], [f.id, false]]);
  assert.deepEqual(h.acp.modes, [[f.id, "plan"]]);
  assert.deepEqual(h.acp.commands.filter(Boolean), []);
  assert.deepEqual(h.acp.prompts, []);
  // Grok confirms with current_mode_update, including leaving plan after
  // approval. That is session state, not the user's saved picker.
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
  assert.equal(h.snapshot().permissionMode, "plan");
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
  assert.equal(h.snapshot().permissionMode, "plan");
  assert.equal(h.loadSettings().permissionMode, "plan");
  assert.ok(!h.events.some((e) => e.type === "update" && e.payload?.update?.sessionUpdate === "current_mode_update"));
  h.acp.created = null;
  h.state.permissionMode = "yolo";
  await h.handlers.get("new-chat")(null, f.cwd);
  assert.equal(h.acp.created.mode, "yolo");
});

test("saved permission mode survives Grok mode reports and a fresh launch", async () => {
  const f = fixture("modes", "persist-mode");
  const h = mainHarness();
  h.state.cwd = f.cwd;
  await h.handlers.get("load-chat")(null, { cwd: f.cwd, id: f.id });
  await h.handlers.get("set-permission-mode")(null, "yolo");
  assert.equal(h.loadSettings().permissionMode, "yolo");
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
  assert.equal(h.snapshot().permissionMode, "yolo");
  assert.equal(h.loadSettings().permissionMode, "yolo");
  await h.handlers.get("save-preferences")(null, { permissionMode: "plan" });
  assert.equal(h.snapshot().permissionMode, "plan");
  assert.equal(h.loadSettings().permissionMode, "plan");
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
  assert.equal(h.snapshot().permissionMode, "plan");

  const restart = mainHarness();
  restart.state.permissionMode = "agent";
  const snap = await restart.handlers.get("get-state")();
  assert.equal(snap.permissionMode, "plan");
  assert.equal(snap.preferences.permissionMode, "plan");
});

test("opening another chat does not push /plan or set_mode onto it", async () => {
  const a = fixture("modes", "chat-a");
  const b = fixture("modes", "chat-b");
  fs.writeFileSync(path.join(a.dir, "plan_mode.json"), JSON.stringify({ state: "Active" }));
  const h = mainHarness();
  h.state.cwd = a.cwd;
  h.state.permissionMode = "plan";
  await h.handlers.get("load-chat")(null, { cwd: a.cwd, id: a.id });
  assert.equal(h.snapshot().permissionMode, "plan");
  assert.deepEqual(h.acp.modes, []);
  assert.deepEqual(h.acp.prompts, []);
  assert.deepEqual(h.acp.commands.filter(Boolean), []);
  await h.handlers.get("load-chat")(null, { cwd: b.cwd, id: b.id });
  assert.equal(h.snapshot().permissionMode, "plan");
  assert.deepEqual(h.acp.modes, []);
  assert.deepEqual(h.acp.prompts, []);
  assert.deepEqual(h.acp.commands.filter(Boolean), []);
});

test("delete-chat buries a locked session so it disappears from the list", async () => {
  const f = fixture("modes", "gone");
  const trash = path.join(root, "trash");
  assert.equal(deleteSession(f.cwd, f.id, trash), true);
  const listed = listProjects({ known: [f.cwd] }).flatMap((p) => p.sessions.map((s) => s.id));
  assert.ok(!listed.includes(f.id));
  const buried = fs.readdirSync(trash).filter((name) => name.startsWith(f.id));
  assert.equal(buried.length, 1);
  assert.ok(fs.existsSync(path.join(trash, buried[0], "summary.json")));
  const h = mainHarness();
  const g = fixture("modes", "live-delete");
  h.state.cwd = g.cwd;
  await h.handlers.get("load-chat")(null, { cwd: g.cwd, id: g.id });
  await h.handlers.get("delete-chat")(null, { id: g.id, cwd: g.cwd });
  assert.equal((h.snapshot().projects.find((p) => canonicalCwd(p.cwd) === canonicalCwd(g.cwd))?.sessions || []).some((s) => s.id === g.id), false);
});

test("plan approval reaches the chat and the queue, and answers go back with feedback", async () => {
  const f = fixture("modes", "approval");
  const h = mainHarness();
  h.state.cwd = f.cwd;
  h.state.sessionId = f.id;
  h.state.permissionMode = "plan";
  await h.handlers.get("load-chat")(null, { cwd: f.cwd, id: f.id });
  h.events.length = 0;
  h.acp.emit("plan-approval", { requestId: 11, params: { sessionId: f.id, toolCallId: "call-1", planContent: "# 方案\n- 第一步" } });
  const ready = h.events.find((e) => e.type === "update" && e.payload?.update?.sessionUpdate === "plan_ready");
  assert.equal(ready.payload.update.planContent, "# 方案\n- 第一步");
  const item = h.snapshot().permissions[0];
  assert.equal(item.kind, "plan");
  assert.equal(item.plan, "# 方案\n- 第一步");
  assert.equal(item.options.map((o) => o.id).join(","), "approved,revise,abandoned");
  await assert.rejects(h.handlers.get("answer-permission")(null, { requestId: 11, optionId: "nope" }), /无效/);
  await h.handlers.get("answer-permission")(null, { requestId: 11, optionId: "revise", feedback: "先别动数据库" });
  assert.deepEqual(h.acp.plans, [[11, "revise", "先别动数据库"]]);
  assert.equal(h.snapshot().permissions.length, 0);
  // Plan text riding on a plan.md edit is forwarded for the live transcript.
  fs.writeFileSync(path.join(f.dir, "plan.md"), "# 方案 v2\n");
  h.events.length = 0;
  h.acp.emit("notification", "session/update", { sessionId: f.id, update: {
    sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed",
    content: [{ type: "diff", path: path.join(f.dir, "plan.md"), oldText: "", newText: "# 方案 v2\n" }],
  } });
  const forwarded = h.events.find((e) => e.type === "update" && e.payload?.update?.toolCallId === "call-2");
  assert.equal(forwarded.payload.update._halora.plan, "# 方案 v2\n");
  // Questions carry their choices and come back keyed by question text.
  h.acp.emit("question", { requestId: 12, params: { sessionId: f.id, toolCallId: "call-3", questions: [
    { question: "用哪个数据库？", options: [{ label: "SQLite", description: "零配置" }, { label: "Postgres" }], multiSelect: null },
  ] } });
  const ask = h.snapshot().permissions[0];
  assert.equal(ask.kind, "question");
  assert.equal(ask.questions[0].options[0].description, "零配置");
  await h.handlers.get("answer-permission")(null, { requestId: 12, optionId: "accepted", answers: { "用哪个数据库？": "SQLite" } });
  assert.deepEqual(h.acp.questions, [[12, "accepted", { "用哪个数据库？": "SQLite" }]]);
  h.acp.emit("question", { requestId: 13, params: { sessionId: f.id, questions: [] } });
  assert.deepEqual(h.acp.questions[1], [13, "chat_about_this", undefined]);
  // Grok's live payload uses snake_case and may omit sessionId; both still
  // have to land in the chat, not disappear into a tool card.
  h.events.length = 0;
  h.acp.emit("plan-approval", { requestId: 14, params: { session_id: f.id, plan_content: "# 蛇形字段\n- 可见" } });
  const snake = h.events.find((e) => e.type === "update" && e.payload?.update?.sessionUpdate === "plan_ready");
  assert.equal(snake.payload.update.planContent, "# 蛇形字段\n- 可见");
  assert.equal(h.snapshot().permissions[0].plan, "# 蛇形字段\n- 可见");
});

test("plan and question replies match Grok's ACP payload shapes", () => {
  assert.deepEqual(planRequest({ session_id: "s", plan_content: "# 方案" }), {
    sessionId: "s",
    toolCallId: null,
    planContent: "# 方案",
    planFilePath: "",
  });
  assert.deepEqual(planReply("approved"), { outcome: "approved", feedback: "" });
  assert.deepEqual(planReply("revise", "改接口"), { outcome: "revise", feedback: "改接口" });
  const asked = questionRequest({
    sessionId: "s",
    input: { questions: [{ question: "用哪个？", options: [{ label: "A", description: "一" }], multi_select: false }] },
  });
  assert.equal(asked.questions[0].question, "用哪个？");
  assert.equal(asked.questions[0].options[0].description, "一");
  assert.equal(questionReply("accepted", { "用哪个？": "A" }).type, "Accepted");
  assert.equal(questionReply("chat_about_this").type, "ChatAboutThis");
  assert.equal(questionReply("skip_interview").outcome, "skip_interview");
});

test("reopening a planned session shows the plan with the turn that wrote it", () => {
  const f = fixture("modes", "history");
  fs.writeFileSync(path.join(f.dir, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "帮我规划" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "看了一下代码" }], tool_calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ file_path: "a.js" }) }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "计划写好了" }], tool_calls: [
      { id: "c2", name: "write", arguments: JSON.stringify({ file_path: path.join(f.dir, "plan.md"), content: "# 计划\n- 改 a.js" }) },
      { id: "c3", name: "exit_plan_mode", arguments: "{}" },
    ] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "好，开始" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "做完了" }] }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(f.dir, "plan.md"), "# 计划\n- 改 a.js\n");
  const msgs = readTranscript(f.cwd, f.id);
  const planned = msgs.filter((m) => m.plan);
  assert.equal(planned.length, 1);
  assert.match(planned[0].text, /计划写好了/);
  assert.equal(planned[0].plan, "# 计划\n- 改 a.js\n");
});

test("reasoning effort is parsed from ACP options and sent as set_config_option", async () => {
  assert.equal(normalizeEffort("Extra high"), "xhigh");
  assert.equal(normalizeEffort("最高"), "xhigh");
  const parsed = parseConfigOptions([{
    configId: "reasoning_effort",
    category: "thought_level",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra high" },
    ],
  }]);
  assert.equal(parsed.current, "high");
  assert.deepEqual(parsed.options.map((item) => item.id), ["low", "high", "xhigh"]);
  const reversed = parseConfigOptions([{
    configId: "reasoning_effort",
    currentValue: "xhigh",
    options: [
      { value: "xhigh", name: "Extra high" },
      { value: "high", name: "High" },
      { value: "medium", name: "Medium" },
      { value: "low", name: "Low" },
    ],
  }]);
  assert.equal(reversed.current, "xhigh");
  assert.deepEqual(reversed.options.map((item) => item.id), ["low", "medium", "high", "xhigh"]);
  const live = parseConfigOptions([{
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "xhigh",
    options: [
      { value: "xhigh", name: "Extra High Effort" },
      { value: "high", name: "High Effort" },
      { value: "medium", name: "Medium Effort" },
      { value: "low", name: "Low Effort" },
    ],
  }]);
  assert.equal(live.current, "xhigh");
  assert.deepEqual(live.options.map((item) => item.id), ["low", "medium", "high", "xhigh"]);
  assert.ok(!defaultEffortOptions().some((item) => item.id === "minimal"));
  assert.equal(clampEffort("minimal", live.options), "low");
  assert.equal(clampEffort("xhigh", live.options), "xhigh");
  assert.equal(configFromResult({ configOptions: [{ configId: "reasoning_effort", currentValue: "xhigh" }] }).current, "xhigh");
  assert.equal(effortFromSummary({ reasoning_effort: "xhigh" }).current, "xhigh");
  const f = fixture("effort", "chat");
  writeJson(path.join(f.dir, "summary.json"), { ...f.summary, reasoning_effort: "high" });
  const h = mainHarness();
  h.saveSettings({ effort: "minimal" });
  h.state.cwd = f.cwd;
  h.state.sessionId = f.id;
  h.acp.setConfigOption = async (sessionId, configId, value) => {
    h.acp.config = { sessionId, configId, value };
    return {
      configOptions: [{
        configId: "reasoning_effort",
        category: "thought_level",
        currentValue: value?.value || value,
        options: [
          { value: "xhigh", name: "Extra high" },
          { value: "high", name: "High" },
          { value: "medium", name: "Medium" },
          { value: "low", name: "Low" },
        ],
      }],
    };
  };
  await h.handlers.get("load-chat")(null, { cwd: f.cwd, id: f.id });
  assert.equal(h.snapshot().effort.current, "high");
  const snap = await h.handlers.get("set-effort")(null, "xhigh");
  assert.equal(h.acp.config.configId, "reasoning_effort");
  assert.equal(h.acp.config.value?.value || h.acp.config.value, "xhigh");
  assert.equal(snap.effort.current, "xhigh");
  assert.ok(snap.effort.options.some((item) => item.id === "xhigh" && item.label === "最高"));
  const clamped = await h.handlers.get("set-effort")(null, "minimal");
  assert.equal(h.acp.config.value?.value || h.acp.config.value, "low");
  assert.equal(clamped.effort.current, "low");
  h.acp.setConfigOption = async () => {
    throw Object.assign(new Error("Invalid params"), { payload: { data: "unknown reasoning_effort value" } });
  };
  await assert.rejects(() => h.handlers.get("set-effort")(null, "high"), /当前模型不支持这个思考强度/);
  h.acp.setConfigOption = async () => {
    throw Object.assign(new Error("Invalid params"), { payload: { data: "data did not match any variant of untagged enum SessionConfigOptionValue" } });
  };
  await assert.rejects(() => h.handlers.get("set-effort")(null, "medium"), /思考强度没能改成功/);
  const g = mainHarness();
  g.state.cwd = f.cwd;
  g.state.sessionId = f.id;
  g.acp.setConfigOption = async (sessionId, configId, value) => {
    g.acp.config = { sessionId, configId, value };
    return {
      configOptions: [{
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: value,
        options: [
          { value: "xhigh", name: "Extra high" },
          { value: "high", name: "High" },
          { value: "medium", name: "Medium" },
          { value: "low", name: "Low" },
        ],
      }],
    };
  };
  const attached = await g.handlers.get("set-effort")(null, "xhigh");
  assert.ok(g.acp.loads.includes(f.id));
  assert.equal(g.acp.config.value, "xhigh");
  assert.equal(attached.effort.current, "xhigh");
});
