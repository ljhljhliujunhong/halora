const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AcpClient } = require("./acp.cjs");
const { findGrokBinary } = require("./grok-path.cjs");
const {
  listSessionsForCwd,
  listProjects,
  readTranscript,
  renameSession,
  deleteSession,
  setAutoTitle,
  sessionsRoot,
  shortenTitle,
  samePath,
  canonicalCwd,
  lookupOrder,
} = require("./sessions.cjs");
const { buildContext, rememberCompaction } = require("./context.cjs");
const { fetchQuota } = require("./billing.cjs");
const { listSkills, listSkillLibrary, importSkillsFrom, removeUserSkill } = require("./skills.cjs");
const { extFromMime, fileToImage, toDataUrl, MAX_BYTES } = require("./media.cjs");
const { searchFiles, resolveMentions, collectMentions } = require("./files.cjs");

const acp = new AcpClient();
const live = new Map();
let loadingId = null;

const state = {
  cwd: null,
  sessionId: null,
  grokBin: null,
  ready: false,
  models: [],
  modelId: "grok-4.6",
  sessions: [],
  projects: [],
  permission: null,
  permissionMode: "agent",
  commands: [],
  skills: [],
  skillLibrary: [],
  context: null,
  quota: null,
};

let win = null;

function liveSlot(id, cwd) {
  if (!id) return null;
  let slot = live.get(id);
  if (!slot) {
    slot = { cwd: cwd || null, running: false, gen: 0, attached: false };
    live.set(id, slot);
  } else if (cwd) {
    slot.cwd = cwd;
  }
  return slot;
}

function runningIds() {
  const ids = [];
  for (const [id, slot] of live) {
    if (slot.running) ids.push(id);
  }
  return ids;
}

function viewedRunning() {
  return Boolean(state.sessionId && live.get(state.sessionId)?.running);
}

function cwdOfSession(sessionId) {
  if (!sessionId) return state.cwd;
  const slot = live.get(sessionId);
  if (slot?.cwd) return slot.cwd;
  if (sessionId === state.sessionId) return state.cwd;
  for (const project of state.projects || []) {
    if ((project.sessions || []).some((item) => item.id === sessionId)) return project.cwd;
  }
  return state.cwd;
}

function noticeSessionId(params) {
  return params?.sessionId || loadingId || state.sessionId;
}

function beginTurn(id, cwd) {
  const slot = liveSlot(id, cwd);
  slot.gen += 1;
  slot.running = true;
  return slot.gen;
}

function endTurn(id, gen) {
  const slot = live.get(id);
  if (!slot || slot.gen !== gen) return false;
  slot.running = false;
  return true;
}

function cancelLive(id) {
  if (!id) return;
  const slot = live.get(id);
  if (slot) {
    slot.gen += 1;
    slot.running = false;
  }
  try {
    acp.cancel(id);
  } catch {
    // agent may already be gone
  }
  if (state.permission?.sessionId === id || (!state.permission?.sessionId && id === state.sessionId)) {
    if (state.permission) acp.answerPermission(state.permission.requestId, "__cancel__");
    state.permission = null;
    send("permission", null);
  }
}

function resetLive(keepIds = false) {
  for (const slot of live.values()) {
    slot.attached = false;
    slot.running = false;
    slot.gen += 1;
  }
  if (!keepIds) live.clear();
}

async function attachSession(id, cwd) {
  await ensureAgent();
  const slot = liveSlot(id, cwd);
  if (slot.attached && acp.alive) return null;
  const loaded = await acp.loadSession(id, cwd);
  slot.attached = true;
  slot.cwd = cwd || slot.cwd;
  return loaded;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
}

function moveToFront(list, value) {
  return [value, ...(list || []).filter((item) => item !== value)];
}

function dropFromChatOrder(chatOrder, id) {
  const next = {};
  for (const [key, ids] of Object.entries(chatOrder || {})) {
    next[key] = (ids || []).filter((item) => item !== id);
  }
  return next;
}

function send(type, payload = {}) {
  if (win) win.webContents.send("workshop-event", { type, payload });
}

function snapshot() {
  return {
    cwd: state.cwd,
    sessionId: state.sessionId,
    ready: state.ready,
    grokBin: state.grokBin,
    models: state.models,
    modelId: state.modelId,
    sessions: state.sessions,
    projects: state.projects,
    permission: state.permission,
    permissionMode: state.permissionMode || "agent",
    grokFound: Boolean(state.grokBin),
    sidebarCollapsed: Boolean(loadSettings().sidebarCollapsed),
    commands: state.commands,
    skills: state.skills,
    skillLibrary: state.skillLibrary || [],
    context: state.context,
    quota: state.quota,
    running: viewedRunning(),
    runningIds: runningIds(),
  };
}

function rememberProject(cwd) {
  if (!cwd) return;
  const resolved = path.resolve(cwd);
  const settings = loadSettings();
  const list = Array.isArray(settings.projects) ? settings.projects : [];
  const key = canonicalCwd(resolved);
  const next = [resolved, ...list.filter((item) => canonicalCwd(item) !== key)].slice(0, 80);
  const hidden = (settings.hiddenProjects || []).filter((item) => canonicalCwd(item) !== key);
  saveSettings({ lastCwd: resolved, projects: next, hiddenProjects: hidden });
}

function sameIdList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

function stabilizeChatOrder(projects) {
  const settings = loadSettings();
  const pinnedSet = new Set(settings.pinnedChats || []);
  const chatOrder = { ...(settings.chatOrder || {}) };
  let changed = false;
  for (const project of projects || []) {
    const key = canonicalCwd(project.cwd);
    if (!key) continue;
    const live = (project.sessions || []).map((item) => item.id).filter(Boolean);
    if (!live.length) continue;
    const raw = lookupOrder(chatOrder, key);
    // A summary can briefly disappear while Grok rewrites it. Only explicit
    // deletion should remove a saved slot, otherwise it reappears at the top.
    const existing = raw;
    let next;
    if (!existing.length) {
      next = live;
    } else {
      const missing = live.filter((id) => !existing.includes(id));
      if (!missing.length && existing.length === raw.length) continue;
      const pinnedNew = missing.filter((id) => pinnedSet.has(id));
      const restNew = missing.filter((id) => !pinnedSet.has(id));
      const pinnedExisting = existing.filter((id) => pinnedSet.has(id));
      const restExisting = existing.filter((id) => !pinnedSet.has(id));
      next = [...pinnedNew, ...pinnedExisting, ...restNew, ...restExisting];
    }
    if (sameIdList(next, raw)) continue;
    chatOrder[key] = next;
    changed = true;
  }
  // Freeze the project rows too; activity must not move a whole project.
  const projectOrder = (settings.projectOrder || []).map(canonicalCwd).filter(Boolean);
  const liveProjects = (projects || []).map((project) => canonicalCwd(project.cwd));
  const nextProjects = [
    ...liveProjects.filter((key) => !projectOrder.includes(key)),
    ...projectOrder,
  ];
  const projectsChanged = !sameIdList(nextProjects, projectOrder);
  if (!changed && !projectsChanged) return false;
  saveSettings({ chatOrder, projectOrder: nextProjects });
  return true;
}

function projectListOptions(settings) {
  return {
    known: settings.projects || [],
    titles: settings.sessionTitles || {},
    hidden: settings.hiddenProjects || [],
    pinnedProjects: settings.pinnedProjects || [],
    pinnedChats: settings.pinnedChats || [],
    projectNames: settings.projectNames || {},
    projectOrder: settings.projectOrder || [],
    chatOrder: settings.chatOrder || {},
  };
}

function refreshSessions() {
  const settings = loadSettings();
  state.projects = listProjects(projectListOptions(settings));
  if (stabilizeChatOrder(state.projects)) {
    state.projects = listProjects(projectListOptions(loadSettings()));
  }
  if (!state.cwd) {
    state.sessions = [];
    return [];
  }
  const current = state.projects.find((item) => samePath(item.cwd, state.cwd));
  state.sessions = current ? current.sessions : listSessionsForCwd(state.cwd, settings.sessionTitles || {});
  return state.sessions;
}

let sessionWatchers = [];
let refreshTimer = null;
let pollTimer = null;
let quotaTimer = null;

function sessionsFingerprint() {
  return JSON.stringify({
    cwd: state.cwd,
    sessionId: state.sessionId,
    projects: (state.projects || []).map((project) => [
      project.cwd,
      project.sessions.map((item) => [item.id, item.title, item.updatedAt]),
    ]),
    context: state.context,
  });
}

function stopSessionWatch() {
  for (const watcher of sessionWatchers) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
  sessionWatchers = [];
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function scheduleSessionRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const before = sessionsFingerprint();
    refreshSessions();
    refreshContext();
    if (sessionsFingerprint() !== before) send("state", snapshot());
  }, 400);
}

function watchSessions() {
  stopSessionWatch();
  const root = sessionsRoot();
  if (fs.existsSync(root)) {
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const name = String(filename || "").replace(/\\/g, "/");
        if (name && !["summary.json", "signals.json", "updates.jsonl", "chat_history.jsonl"]
          .some((file) => name.endsWith(file))) return;
        scheduleSessionRefresh();
      });
      sessionWatchers.push(watcher);
    } catch {
      // fall back to polling
    }
  }
  pollTimer = setInterval(scheduleSessionRefresh, 5000);
}

async function switchProject(cwd, { clearSession = true } = {}) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error("这个文件夹不存在");
  const resolved = path.resolve(cwd);
  const same = state.cwd && samePath(state.cwd, resolved);
  state.cwd = resolved;
  rememberProject(resolved);
  if (!same && clearSession) state.sessionId = null;
  await ensureAgent();
  refreshSessions();
  refreshSkills();
  watchSessions();
}

function applyCommands(list) {
  if (!Array.isArray(list)) return;
  state.commands = list.map((item) => ({
    name: item.name,
    description: item.description || "",
    hint: item.input?.hint || item.hint || "",
  }));
}

function refreshSkills() {
  state.skills = listSkills(state.cwd);
  state.skillLibrary = listSkillLibrary(state.cwd).map((item) => ({
    name: item.name,
    label: item.label || item.name,
    description: item.description || "",
    source: item.source || "",
    dir: item.dir || "",
    removable: Boolean(item.removable),
  }));
  return state.skills;
}

function refreshContext() {
  if (!state.cwd || !state.sessionId) {
    state.context = null;
    return null;
  }
  state.context = buildContext(state.cwd, state.sessionId);
  return state.context;
}

async function refreshQuota(force = false) {
  try {
    const next = await fetchQuota({ force });
    if (!next) return state.quota;
    const same =
      state.quota &&
      state.quota.percent === next.percent &&
      state.quota.resetAt === next.resetAt &&
      state.quota.window === next.window &&
      state.quota.plan === next.plan &&
      state.quota.resets === next.resets &&
      state.quota.resetCardUntil === next.resetCardUntil;
    if (same) return state.quota;
    state.quota = next;
    send("state", snapshot());
    return next;
  } catch {
    return state.quota;
  }
}

function applyInit(result) {
  const models =
    result?._meta?.modelState?.availableModels ||
    result?.models?.availableModels ||
    [];
  if (models.length) {
    state.models = models.map((m) => ({
      id: m.modelId,
      name: m.name || m.modelId,
    }));
  }
  state.modelId =
    result?._meta?.modelState?.currentModelId ||
    result?.models?.currentModelId ||
    state.modelId;
  const commands = result?._meta?.availableCommands || result?.availableCommands;
  if (commands) applyCommands(commands);
}

async function ensureAgent() {
  if (acp.alive && state.ready) return;
  resetLive(true);
  state.grokBin = findGrokBinary();
  if (!state.grokBin) {
    throw new Error("找不到 Grok Build。请先在电脑上安装它。");
  }
  acp.start(state.grokBin);
  const init = await acp.initialize();
  applyInit(init);
  state.ready = true;
}

async function createSession() {
  await ensureAgent();
  if (!state.cwd) throw new Error("先打开一个文件夹");
  const preferred = loadSettings().modelId || state.modelId;
  const created = await acp.newSession(state.cwd);
  state.sessionId = created.sessionId;
  const slot = liveSlot(created.sessionId, state.cwd);
  slot.attached = true;
  if (created.models?.availableModels || created._meta || created.availableCommands) {
    applyInit({
      models: created.models,
      _meta: created._meta,
      availableCommands: created.availableCommands,
    });
  }
  if (preferred) {
    try {
      await acp.setModel(state.sessionId, preferred);
      state.modelId = preferred;
    } catch {
      // keep going with the default
    }
  }
  refreshSessions();
  refreshSkills();
  refreshContext();
  watchSessions();
  send("state", snapshot());
  return created;
}

function appIcon() {
  const packaged = path.join(process.resourcesPath, "icon.ico");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  const localIco = path.join(__dirname, "../build/icon.ico");
  if (fs.existsSync(localIco)) return localIco;
  return path.join(__dirname, "../public/icon.jpg");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f3f6fa",
    title: "Halora",
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) win.loadURL("http://127.0.0.1:5173");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

function handleSessionNotice(params) {
  const update = params?.update || {};
  const kind = update.sessionUpdate;
  const sessionId = noticeSessionId(params);
  if (loadingId && sessionId === loadingId) return;
  const cwd = cwdOfSession(sessionId);
  if (kind === "auto_compact_started") {
    send("compact", {
      sessionId,
      phase: "start",
      used: update.tokens_used,
      total: update.context_window,
      percent: update.percentage,
    });
    return;
  }
  if (kind === "auto_compact_completed" || kind === "compaction_completed" || kind === "context_compact") {
    rememberCompaction(cwd, sessionId, params);
    if (sessionId === state.sessionId) refreshContext();
    send("compact", {
      sessionId,
      phase: "done",
      tokensBefore: update.tokens_before ?? update.tokensBefore,
      tokensAfter: sessionId === state.sessionId ? state.context?.used : update.tokens_after ?? update.tokensAfter,
      estimated: sessionId === state.sessionId ? Boolean(state.context?.estimated) : false,
      summary: update.summary_preview || update.summary || "",
    });
    send("state", snapshot());
    return;
  }
  if (kind === "auto_compact_failed" || kind === "auto_compact_cancelled") {
    send("compact", {
      sessionId,
      phase: "fail",
      message: update.reason || update.message || "压缩没完成",
    });
  }
}

acp.on("notification", (method, params) => {
  if (method === "session/update" || method === "_x.ai/session/update" || method === "x.ai/session/update") {
    const update = params.update;
    if (!update) return;
    const sessionId = noticeSessionId(params);
    if (loadingId && sessionId === loadingId) {
      if (update.sessionUpdate === "available_commands_update" && sessionId === state.sessionId) {
        applyCommands(update.availableCommands);
        send("state", snapshot());
      }
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      if (sessionId === state.sessionId) {
        applyCommands(update.availableCommands);
        send("state", snapshot());
      }
      return;
    }
    if (
      update.sessionUpdate === "auto_compact_started" ||
      update.sessionUpdate === "auto_compact_completed" ||
      update.sessionUpdate === "auto_compact_failed" ||
      update.sessionUpdate === "auto_compact_cancelled" ||
      update.sessionUpdate === "compaction_completed" ||
      update.sessionUpdate === "context_compact"
    ) {
      handleSessionNotice(params);
      return;
    }
    send("update", { sessionId, update });
    return;
  }
  if (method === "_x.ai/session_notification" || method === "x.ai/session_notification") {
    handleSessionNotice(params || {});
    return;
  }
  if (method === "_x.ai/models/update") {
    applyInit({ _meta: { modelState: params } });
    send("state", snapshot());
  }
});

function pickAllowOption(options) {
  const list = options || [];
  const score = (opt) => {
    const blob = `${opt.kind || ""} ${opt.name || ""}`.toLowerCase();
    if (blob.includes("allow_always") || blob.includes("allow always") || blob.includes("始终允许")) {
      return 3;
    }
    if (blob.includes("allow_once") || blob.includes("allow once") || blob.includes("允许一次")) {
      return 2;
    }
    if (blob.includes("allow")) return 1;
    return 0;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0] || null;
}

acp.on("permission", ({ requestId, params }) => {
  const options = (params.options || []).map((opt) => ({
    id: opt.optionId,
    name: opt.name,
    kind: opt.kind,
  }));
  if (state.permissionMode === "yolo") {
    const allow = pickAllowOption(options);
    if (allow?.id) {
      acp.answerPermission(requestId, allow.id);
      return;
    }
  }
  state.permission = {
    requestId,
    sessionId: params.sessionId,
    title: params.toolCall?.title || "需要许可",
    input: params.toolCall?.rawInput || params.toolCall || null,
    options,
  };
  send("permission", state.permission);
});

acp.on("exit", () => {
  state.ready = false;
  resetLive(true);
  send("state", snapshot());
  send("error", { message: "Grok 连接断开了" });
});

ipcMain.handle("get-state", async () => {
  state.grokBin = findGrokBinary();
  const settings = loadSettings();
  if (!state.cwd && settings.lastCwd && fs.existsSync(settings.lastCwd)) {
    const hidden = (settings.hiddenProjects || []).map(canonicalCwd);
    if (!hidden.includes(canonicalCwd(settings.lastCwd))) {
      state.cwd = settings.lastCwd;
      rememberProject(state.cwd);
      refreshSkills();
    }
  }
  if (settings.modelId) state.modelId = settings.modelId;
  if (["agent", "plan", "yolo"].includes(settings.permissionMode)) {
    state.permissionMode = settings.permissionMode;
  }
  refreshSessions();
  refreshSkills();
  watchSessions();
  refreshQuota();
  return snapshot();
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "选择项目文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("open-project", async (_event, cwd) => {
  await switchProject(cwd, { clearSession: true });
  send("state", snapshot());
  send("transcript", { sessionId: state.sessionId, messages: [] });
  return snapshot();
});

ipcMain.handle("new-chat", async (_event, cwd) => {
  const target = cwd || state.cwd;
  if (!target) throw new Error("先打开一个文件夹");
  await switchProject(target, { clearSession: true });
  await createSession();
  send("transcript", { sessionId: state.sessionId, messages: [] });
  return snapshot();
});

ipcMain.handle("load-chat", async (_event, payload) => {
  const id = typeof payload === "string" ? payload : payload?.id;
  const cwd = (typeof payload === "object" && payload?.cwd) || state.cwd;
  if (!id) throw new Error("找不到这次对话");
  if (!cwd) throw new Error("先打开一个文件夹");
  loadingId = id;
  try {
    await switchProject(cwd, { clearSession: false });
    const messages = readTranscript(state.cwd, id);
    const slot = liveSlot(id, state.cwd);
    if (!slot.attached) {
      try {
        const loaded = await attachSession(id, state.cwd);
        applyInit(loaded || {});
      } catch {
        // still show the saved chat
      }
    }
    state.sessionId = id;
    refreshSessions();
    refreshSkills();
    refreshContext();
    send("transcript", { sessionId: id, messages, live: Boolean(slot.running) });
    send("state", snapshot());
    return snapshot();
  } finally {
    if (loadingId === id) loadingId = null;
  }
});

function persistIncomingImages(images) {
  const dir = path.join(app.getPath("temp"), "gongfang-inbox");
  fs.mkdirSync(dir, { recursive: true });
  return (images || [])
    .map((img, index) => {
      if (img?.path) {
        const fromDisk = fileToImage(img.path);
        if (fromDisk) return fromDisk;
      }
      if (!img?.data) return null;
      const ext = extFromMime(img.mime);
      const filePath = path.join(dir, `${Date.now()}-${index}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(img.data, "base64"));
      return {
        name: img.name || path.basename(filePath),
        mime: img.mime || "image/png",
        data: img.data,
        path: filePath,
      };
    })
    .filter(Boolean);
}

function pickedFromPath(filePath) {
  const img = fileToImage(filePath);
  if (img) return { kind: "image", ...img };
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  return {
    kind: "file",
    name: path.basename(resolved),
    path: resolved,
  };
}

ipcMain.handle("pick-images", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "选择文件",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths.map(pickedFromPath).filter(Boolean);
});

ipcMain.handle("pick-files", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "选择文件",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths.map(pickedFromPath).filter(Boolean);
});

ipcMain.handle("pin-project", async (_event, { cwd, pinned }) => {
  if (!cwd) throw new Error("找不到这个项目");
  const key = canonicalCwd(cwd);
  const settings = loadSettings();
  let list = (settings.pinnedProjects || []).map(canonicalCwd).filter(Boolean);
  list = list.filter((item) => item !== key);
  if (pinned) list.unshift(key);
  const patch = { pinnedProjects: list };
  const order = (settings.projectOrder || []).map(canonicalCwd).filter(Boolean);
  if (order.length) patch.projectOrder = pinned ? moveToFront(order, key) : order;
  saveSettings(patch);
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("rename-project", async (_event, { cwd, name }) => {
  if (!cwd) throw new Error("找不到这个项目");
  const key = canonicalCwd(cwd);
  const settings = loadSettings();
  const names = { ...(settings.projectNames || {}) };
  const title = String(name || "").trim();
  if (title) names[key] = title;
  else delete names[key];
  saveSettings({ projectNames: names });
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("hide-project", async (_event, { cwd }) => {
  if (!cwd) throw new Error("找不到这个项目");
  const key = canonicalCwd(cwd);
  const settings = loadSettings();
  const hidden = (settings.hiddenProjects || []).map(canonicalCwd).filter(Boolean);
  if (!hidden.includes(key)) hidden.push(key);
  const lastIsThis = settings.lastCwd && samePath(settings.lastCwd, cwd);
  const chatOrder = { ...(settings.chatOrder || {}) };
  delete chatOrder[key];
  for (const raw of Object.keys(chatOrder)) {
    if (canonicalCwd(raw) === key) delete chatOrder[raw];
  }
  saveSettings({
    hiddenProjects: hidden,
    pinnedProjects: (settings.pinnedProjects || []).filter((item) => canonicalCwd(item) !== key),
    projects: (settings.projects || []).filter((item) => canonicalCwd(item) !== key),
    projectOrder: (settings.projectOrder || []).map(canonicalCwd).filter((item) => item && item !== key),
    chatOrder,
    lastCwd: lastIsThis ? "" : settings.lastCwd,
  });
  const cleared = state.cwd && samePath(state.cwd, cwd);
  for (const [id, slot] of [...live]) {
    if (slot.cwd && samePath(slot.cwd, cwd)) {
      cancelLive(id);
      live.delete(id);
    }
  }
  if (cleared) {
    state.cwd = null;
    state.sessionId = null;
    state.context = null;
    send("transcript", { sessionId: null, messages: [] });
  }
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("pin-chat", async (_event, { id, pinned }) => {
  if (!id) throw new Error("找不到这次对话");
  const settings = loadSettings();
  let list = Array.isArray(settings.pinnedChats) ? [...settings.pinnedChats] : [];
  list = list.filter((item) => item !== id);
  if (pinned) list.unshift(id);
  const patch = { pinnedChats: list };
  const chatOrder = { ...(settings.chatOrder || {}) };
  for (const [key, ids] of Object.entries(chatOrder)) {
    if (!Array.isArray(ids) || !ids.includes(id)) continue;
    chatOrder[key] = pinned ? moveToFront(ids, id) : ids;
  }
  if (Object.keys(chatOrder).length) patch.chatOrder = chatOrder;
  saveSettings(patch);
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("delete-chat", async (_event, { id, cwd }) => {
  const target = cwd || state.cwd;
  if (!id || !target) throw new Error("找不到这次对话");
  cancelLive(id);
  live.delete(id);
  if (state.sessionId === id) {
    state.sessionId = null;
    state.context = null;
    send("transcript", { sessionId: id, messages: [] });
  }
  const settings = loadSettings();
  const titles = { ...(settings.sessionTitles || {}) };
  delete titles[id];
  saveSettings({
    sessionTitles: titles,
    pinnedChats: (settings.pinnedChats || []).filter((item) => item !== id),
    chatOrder: dropFromChatOrder(settings.chatOrder, id),
  });
  deleteSession(target, id);
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("rename-chat", async (_event, { id, title, cwd }) => {
  const target = cwd || state.cwd;
  if (!target) throw new Error("先打开一个文件夹");
  const name = String(title || "").trim();
  if (!name) throw new Error("名字不能为空");
  const settings = loadSettings();
  saveSettings({
    sessionTitles: { ...(settings.sessionTitles || {}), [id]: name },
  });
  try {
    renameSession(target, id, name);
  } catch {
    // overlay still saved
  }
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("media-src", async (_event, filePath) => {
  const src = toDataUrl(filePath);
  if (!src) throw new Error("这张图打不开");
  return src;
});

ipcMain.handle("open-external", async (_event, url) => {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value) && !/^mailto:/i.test(value)) return false;
  await shell.openExternal(value);
  return true;
});

ipcMain.handle("compact", async (_event, payload) => {
  const hint = typeof payload === "string" || payload == null ? payload : payload.hint;
  const sessionId = (typeof payload === "object" && payload?.sessionId) || state.sessionId;
  const cwd = (typeof payload === "object" && payload?.cwd) || cwdOfSession(sessionId);
  await ensureAgent();
  if (!cwd) throw new Error("先打开一个文件夹");
  if (!sessionId) throw new Error("先打开一次对话");
  await attachSession(sessionId, cwd).catch(() => {});
  const gen = beginTurn(sessionId, cwd);
  send("compact", { sessionId, phase: "start" });
  send("state", snapshot());
  try {
    const result = await acp.compact(sessionId, hint);
    return { ok: true, result };
  } finally {
    if (endTurn(sessionId, gen)) {
      refreshSessions();
      if (sessionId === state.sessionId) refreshContext();
      refreshQuota(true);
      send("state", snapshot());
    }
  }
});

ipcMain.handle("send-prompt", async (_event, payload) => {
  const rawText = typeof payload === "string" ? payload : String(payload?.text || "");
  const attached = (typeof payload === "string" ? [] : payload?.files || []).filter(
    (item) => item?.path
  );
  const sessionIdHint = typeof payload === "object" ? payload?.sessionId : null;
  const cwdHint = typeof payload === "object" ? payload?.cwd : null;
  let sessionId = sessionIdHint || state.sessionId;
  let cwd = cwdHint || cwdOfSession(sessionId) || state.cwd;
  const mentioned = resolveMentions(cwd, collectMentions(rawText));
  const fileMap = new Map();
  for (const item of [...attached, ...mentioned]) {
    if (item?.path) fileMap.set(String(item.path).toLowerCase(), item);
  }
  const fileList = [...fileMap.values()];
  const files = fileList.map((item) => item.path);
  const text = [rawText.trim(), ...attached.map((item) => item.path)].filter(Boolean).join("\n");
  const images = persistIncomingImages(typeof payload === "string" ? [] : payload?.images);
  if (!text.trim() && !images.length && !fileList.length) return { ok: false };
  await ensureAgent();
  if (!cwd) throw new Error("先打开一个文件夹");
  if (!sessionId) {
    if (!samePath(state.cwd, cwd)) await switchProject(cwd, { clearSession: true });
    await createSession();
    sessionId = state.sessionId;
    cwd = state.cwd;
  } else {
    liveSlot(sessionId, cwd);
    await attachSession(sessionId, cwd).catch(() => {});
  }
  const auto =
    shortenTitle(rawText) ||
    shortenTitle(images[0]?.name) ||
    shortenTitle(files[0] && path.basename(files[0]));
  const applyAuto = () => {
    if (!auto || !cwd || !sessionId) return;
    setAutoTitle(cwd, sessionId, auto);
    scheduleSessionRefresh();
  };
  applyAuto();
  setTimeout(applyAuto, 900);
  refreshSessions();
  watchSessions();
  const gen = beginTurn(sessionId, cwd);
  send("state", snapshot());
  try {
    try {
      const result = await acp.prompt(sessionId, text, images, fileList);
      return { ok: true, result };
    } catch (err) {
      if (!images.length && !fileList.length) throw err;
      const fallback = [text.trim(), ...images.map((img) => img.path), ...files]
        .filter(Boolean)
        .join("\n");
      const result = await acp.prompt(sessionId, fallback, [], []);
      return { ok: true, result };
    }
  } finally {
    if (endTurn(sessionId, gen)) {
      refreshSessions();
      if (sessionId === state.sessionId) refreshContext();
      refreshQuota(true);
      send("state", snapshot());
    }
  }
});

ipcMain.handle("cancel", async (_event, sessionId) => {
  const id = sessionId || state.sessionId;
  cancelLive(id);
  send("state", snapshot());
  return { ok: true };
});

ipcMain.handle("set-model", async (_event, modelId) => {
  state.modelId = modelId;
  saveSettings({ modelId });
  if (state.sessionId && acp.alive) {
    await acp.setModel(state.sessionId, modelId);
  }
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("answer-permission", async (_event, { requestId, optionId }) => {
  acp.answerPermission(requestId, optionId);
  state.permission = null;
  send("permission", null);
  return { ok: true };
});

ipcMain.handle("search-files", async (_event, payload) => {
  if (!state.cwd) return [];
  return searchFiles(state.cwd, payload?.query || "", { hidden: Boolean(payload?.hidden) });
});

ipcMain.handle("reorder-projects", async (_event, order) => {
  const keys = [...new Set((Array.isArray(order) ? order : []).map(canonicalCwd).filter(Boolean))];
  saveSettings({ projectOrder: keys });
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("reorder-chats", async (_event, { cwd, order }) => {
  if (!cwd) throw new Error("找不到这个项目");
  const key = canonicalCwd(cwd);
  const ids = [...new Set((Array.isArray(order) ? order : []).map(String).filter(Boolean))];
  const settings = loadSettings();
  const chatOrder = { ...(settings.chatOrder || {}) };
  for (const raw of Object.keys(chatOrder)) {
    if (canonicalCwd(raw) === key) delete chatOrder[raw];
  }
  chatOrder[key] = ids;
  saveSettings({ chatOrder });
  refreshSessions();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("set-permission-mode", async (_event, mode) => {
  const value = ["agent", "plan", "yolo"].includes(mode) ? mode : "agent";
  state.permissionMode = value;
  saveSettings({ permissionMode: value });
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("set-sidebar", async (_event, collapsed) => {
  saveSettings({ sidebarCollapsed: Boolean(collapsed) });
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("pick-skill-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "选择技能",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("import-skills", async (_event, payload) => {
  const from = payload?.from;
  if (!from) return snapshot();
  const result = importSkillsFrom(from, { replace: Boolean(payload?.replace) });
  refreshSkills();
  send("state", snapshot());
  return { ...snapshot(), importResult: result };
});

ipcMain.handle("remove-skill", async (_event, dir) => {
  removeUserSkill(dir);
  refreshSkills();
  send("state", snapshot());
  return snapshot();
});

ipcMain.handle("login", async () => {
  const bin = findGrokBinary();
  if (!bin) throw new Error("找不到 Grok Build");
  spawn(bin, ["login"], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return { ok: true };
});

app.setName("Halora");
app.setAppUserModelId("local.halora");

if (process.env.SMOKE_TEST === "1") {
  app.whenReady().then(() => {
    const ok = typeof app === "object" && typeof ipcMain.handle === "function";
    process.stdout.write(`SMOKE ${ok ? "OK" : "FAIL"} grok=${findGrokBinary() || "missing"}\n`);
    app.quit();
  });
} else {
  app.whenReady().then(() => {
    createWindow();
    state.grokBin = findGrokBinary();
    refreshQuota();
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = setInterval(() => refreshQuota(), 5 * 60 * 1000);
  });
}

app.on("window-all-closed", () => {
  stopSessionWatch();
  if (quotaTimer) clearInterval(quotaTimer);
  acp.stop();
  app.quit();
});

app.on("before-quit", () => {
  stopSessionWatch();
  if (quotaTimer) clearInterval(quotaTimer);
  acp.stop();
});
