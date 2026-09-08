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
const { canonicalCwd } = require("../electron/sessions.cjs");
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

function mainHarness() {
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
  }
  const sandbox = {
    require(name) {
      if (name === "electron") return {
        app: { getPath: () => userData, setName() {}, setAppUserModelId() {}, on() {}, whenReady: () => ({then() {}}) },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      };
      if (name === "./acp.cjs") return { AcpClient: FakeAcp };
      if (name === "./billing.cjs") return { fetchQuota: async () => null };
      if (name === "node:fs") return { ...fs, watch: () => ({close() {}}) };
      return localRequire(name);
    },
    __dirname: path.dirname(file), process, Buffer,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8") + "\nglobalThis.harness = { state, acp, refreshSessions, refreshContext, snapshot, saveSettings, loadSettings, setWindow: (value) => { win = value; } };", sandbox);
  const h = sandbox.harness;
  h.state.ready = true;
  h.setWindow({webContents: { send: (_channel, event) => events.push(event) }});
  return { ...h, handlers, events };
}

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
async function waitFor(check, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await tick();
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
  waits.get(a.id)({});
  await pendingA;
  assert.ok(!h.snapshot().runningIds.includes(a.id));
  assert.ok(h.snapshot().runningIds.includes(b.id));
  waits.get(b.id)({});
  await pendingB;
  assert.equal(h.snapshot().runningIds.length, 0);
});
