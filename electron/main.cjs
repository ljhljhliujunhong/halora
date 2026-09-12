const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AcpClient } = require("./acp.cjs");
const { findGrokBinary, grokHome } = require("./grok-path.cjs");
const { readJson, writeJson, atomicWrite, preferences } = require('./storage.cjs');
const { PermissionQueue } = require('./permissions.cjs');
const reviewService = require('./review.cjs');
const archives = require('./archives.cjs');
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
  recordTurnDuration,
  sessionDir,
} = require("./sessions.cjs");
const { buildContext, rememberCompaction } = require("./context.cjs");
const { fetchQuota, hasAuth } = require("./billing.cjs");
const { listSkills, listSkillLibrary, importSkillsFrom, removeUserSkill } = require("./skills.cjs");
const { extFromMime, fileToImage, toDataUrl } = require("./media.cjs");
const { searchFiles, resolveMentions, collectMentions, classifyDroppedPath, classifyDroppedPaths, locateResource } = require("./files.cjs");

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
let quitting = false;
let closing = false;
let reconnectTimer = null;
let connecting = null;
let reconnectAttempts = 0;
let maintenance = false;
const projectLocks = new Set();
const lockKey = cwd => canonicalCwd(cwd).toLowerCase();
const dataFile = name => path.join(app.getPath('userData'), name);
const recovery = () => readJson(dataFile('recovery.json'), { turns: {} });
function updateRecovery(id, patch) {
  const value = recovery();
  value.turns ||= {};
  if (patch) value.turns[id] = { ...value.turns[id], ...patch, id };
  else delete value.turns[id];
  if (patch?.itemId) value.acceptedItems = [...new Set([...(value.acceptedItems || []), patch.itemId])].slice(-1000);
  writeJson(dataFile('recovery.json'), value);
}
const permissions = new PermissionQueue((id, option) => acp.answerPermission(id, option), items => {
  state.permission = items[0] || null;
  send('permissions', items);
  send('permission', state.permission);
});

function interruptedTurns() {
  return Object.values(recovery().turns || {}).filter(t => t.status === 'interrupted');
}
function markInterrupted() {
  const value = recovery();
  for (const turn of Object.values(value.turns || {})) if (turn.status === 'running') turn.status = 'interrupted';
  writeJson(dataFile('recovery.json'), value);
}
function activeProject(cwd) {
  return [...live.values()].some(slot => slot.running && samePath(slot.cwd, cwd));
}
async function lockedProject(cwd, action) {
  const key = lockKey(cwd);
  if (activeProject(cwd) || projectLocks.has(key)) throw new Error('项目还有任务运行，请停止后再操作');
  projectLocks.add(key);
  try { return await action(); } finally { projectLocks.delete(key); }
}

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

function beginTurn(id, cwd, opts = {}) {
  if (maintenance || projectLocks.has(lockKey(cwd))) throw new Error('正在恢复数据，请稍后再试');
  const slot = liveSlot(id, cwd);
  if (slot.running) throw new Error('这次对话正在运行');
  updateRecovery(id, { cwd, status: 'running', startedAt: Date.now(), prompt: String(opts.user || ''), compact: Boolean(opts.compact), itemId: opts.itemId || null });
  slot.gen += 1;
  slot.running = true;
  slot.turnStartedAt = Date.now();
  slot.compactTurn = Boolean(opts.compact);
  slot.gotUpdate = false;
  slot.turnUser = String(opts.user || "").slice(0, 200);
  return slot.gen;
}

function stampTurn(id) {
  const slot = live.get(id);
  if (!slot?.turnStartedAt || slot.compactTurn) {
    if (slot) slot.turnStartedAt = 0;
    return;
  }
  const startedAt = slot.turnStartedAt;
  const user = slot.turnUser;
  slot.turnStartedAt = 0;
  slot.turnUser = "";
  if (!slot.gotUpdate) return;
  const endedAt = Date.now();
  recordTurnDuration(slot.cwd, id, {
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    user,
  });
}

function endTurn(id, gen) {
  const slot = live.get(id);
  if (!slot || slot.gen !== gen) return false;
  stampTurn(id);
  slot.running = false;
  slot.compactTurn = false;
  if (recovery().turns?.[id]?.status === 'running') updateRecovery(id, null);
  return true;
}

function cancelLive(id) {
  if (!id) return;
  const slot = live.get(id);
  if (slot) {
    stampTurn(id);
    slot.gen += 1;
    slot.running = false;
    slot.compactTurn = false;
  }
  try {
    acp.cancel(id);
  } catch {
    // agent may already be gone
  }
  permissions.cancelSession(id);
  if (!quitting) updateRecovery(id, null);
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
  return readJson(settingsPath(), {});
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(settingsPath(), next);
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
    permissions: permissions.items,
    preferences: preferences(loadSettings()),
    interrupted: interruptedTurns(),
    connection: state.ready ? 'connected' : reconnectTimer || connecting ? 'reconnecting' : 'disconnected',
    everReady: Boolean(state.everReady),
    checkpointWarning: state.checkpointWarning || '',
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
let quotaRetryTimer = null;
let quotaRetryStep = 0;
const QUOTA_RETRY_MS = [2000, 5000, 15000, 30000];

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
  if (clearSession) { state.sessionId = null; saveSettings({ lastSessionId: null }); }
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
  state.context.autoCompact = preferences(loadSettings()).autoCompact;
  return state.context;
}

function hydrateQuota() {
  if (state.quota) return state.quota;
  const saved = loadSettings().lastQuota;
  if (!saved || saved.percent == null || !Number.isFinite(Number(saved.percent))) return null;
  state.quota = {
    percent: Math.max(0, Math.min(100, Math.round(Number(saved.percent)))),
    resetAt: saved.resetAt || null,
    window: saved.window || "本周",
    plan: saved.plan || "",
    resets: Number.isFinite(Number(saved.resets)) ? Number(saved.resets) : null,
    resetCardUntil: saved.resetCardUntil || null,
    updatedAt: saved.updatedAt || null,
    status: 'stale',
    error: '等待刷新',
  };
  return state.quota;
}

function stopQuotaTimers() {
  if (quotaTimer) {
    clearInterval(quotaTimer);
    quotaTimer = null;
  }
  if (quotaRetryTimer) {
    clearTimeout(quotaRetryTimer);
    quotaRetryTimer = null;
  }
}

function scheduleQuotaRetry() {
  if (quotaRetryTimer) return;
  const wait = QUOTA_RETRY_MS[Math.min(quotaRetryStep, QUOTA_RETRY_MS.length - 1)];
  quotaRetryStep += 1;
  quotaRetryTimer = setTimeout(() => {
    quotaRetryTimer = null;
    refreshQuota(true);
  }, wait);
}

async function refreshQuota(force = false) {
  try {
    const next = await fetchQuota({ force });
    if (next) {
      quotaRetryStep = 0;
      if (quotaRetryTimer) {
        clearTimeout(quotaRetryTimer);
        quotaRetryTimer = null;
      }
      state.quota = { ...next, status: 'live', error: null };
      saveSettings({ lastQuota: state.quota });
      send("state", snapshot());
      return next;
    }
  } catch (error) {
    state.quota = { ...state.quota, percent: state.quota?.percent ?? null, status: state.quota?.percent != null ? 'stale' : 'unavailable', error: /401|403/.test(error.message) ? '登录已失效，请重新登录' : '暂时无法刷新' };
  }
  if (!state.quota) state.quota = { percent: null, status: 'unavailable', error: hasAuth() ? '暂时无法刷新' : '尚未登录' };
  if (hasAuth()) scheduleQuotaRetry();
  send('state', snapshot());
  return state.quota;
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
  if (connecting) return connecting;
  connecting = (async () => {
    resetLive(true);
    state.grokBin = findGrokBinary();
    if (!state.grokBin) throw new Error('找不到 Grok Build。请先在电脑上安装它。');
    acp.start(state.grokBin);
    applyInit(await acp.initialize());
    state.ready = true;
    state.everReady = true;
    reconnectAttempts = 0;
  })();
  try { return await connecting; } finally { connecting = null; }
}

async function createSession() {
  await ensureAgent();
  if (!state.cwd) throw new Error("先打开一个文件夹");
  const preferred = loadSettings().modelId || state.modelId;
  const created = await acp.newSession(state.cwd);
  state.sessionId = created.sessionId;
  saveSettings({ lastSessionId: state.sessionId });
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
  const theme = preferences(loadSettings()).theme || "light";
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: theme === "dark" ? "#101e26" : "#f3f6fa",
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
  win.on('close', async event => {
    if (quitting) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      if (runningIds().length && preferences(loadSettings()).confirmExit) {
        const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['继续运行', '保存并退出'], defaultId: 0, cancelId: 0, title: '退出 Halora', message: `还有 ${runningIds().length} 个任务正在运行。`, detail: '退出会中断任务，草稿和待发消息将在下次打开时恢复。' });
        if (result.response !== 1) return;
      }
      quitting = true;
      markInterrupted();
      app.quit();
    } finally { closing = false; }
  });
  win.webContents.on('render-process-gone', () => {
    markInterrupted();
    for (const id of runningIds()) { try { acp.cancel(id); } catch {} }
    resetLive(true);
    permissions.clear();
    win?.reload();
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
    const slot = live.get(sessionId);
    if (slot?.running) slot.gotUpdate = true;
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
  permissions.add({
    requestId,
    sessionId: params.sessionId,
    title: params.toolCall?.title || "需要许可",
    input: params.toolCall?.rawInput || params.toolCall || null,
    options,
    cwd: cwdOfSession(params.sessionId),
    sessionTitle: state.projects.flatMap(p => p.sessions || []).find(s => s.id === params.sessionId)?.title || params.sessionId?.slice(0, 8) || '对话',
  });
});

acp.on("exit", () => {
  state.ready = false;
  markInterrupted();
  resetLive(true);
  permissions.clear();
  send("state", snapshot());
  if (!quitting) scheduleReconnect();
});

function scheduleReconnect() {
  if (reconnectTimer || quitting || reconnectAttempts >= 5) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectAttempts++;
    try { await ensureAgent(); send('state', snapshot()); }
    catch { scheduleReconnect(); send('state', snapshot()); }
  }, Math.min(30000, 1000 * 2 ** reconnectAttempts));
}

ipcMain.handle("get-state", async () => {
  state.grokBin = findGrokBinary();
  const settings = loadSettings();
  settings.lastCwd ||= settings.defaultCwd;
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
  hydrateQuota();
  if (!state.sessionId && settings.lastSessionId && state.sessions.some(s => s.id === settings.lastSessionId)) state.sessionId = settings.lastSessionId;
  if (state.sessionId) {
    refreshContext();
    send('transcript', { sessionId: state.sessionId, messages: readTranscript(state.cwd, state.sessionId), live: viewedRunning() });
  }
  if (state.quota) {
    refreshQuota();
  } else {
    await Promise.race([
      refreshQuota(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
  if (!state.ready) {
    ensureAgent().then(() => send("state", snapshot())).catch(() => send("state", snapshot()));
  }
  return { ...snapshot(), composers: readJson(dataFile('composer.json'), {}), acceptedItems: recovery().acceptedItems || [] };
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
    saveSettings({ lastSessionId: id });
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
  const dir = dataFile('inbox');
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
  return classifyDroppedPath(filePath);
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

ipcMain.handle("resolve-drops", async (_event, paths) => {
  return classifyDroppedPaths(Array.isArray(paths) ? paths : []);
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

function locatedFrom(payload) {
  const hint = typeof payload === "string" ? payload : payload?.hint || payload?.path || "";
  const cwd = (typeof payload === "object" && payload?.cwd) || state.cwd;
  const found = locateResource(cwd, hint);
  if (!found) throw new Error("找不到这个文件");
  return found;
}

ipcMain.handle("show-in-folder", async (_event, payload) => {
  const found = locatedFrom(payload);
  shell.showItemInFolder(found);
  return { ok: true, path: found };
});

ipcMain.handle("open-path", async (_event, payload) => {
  const found = locatedFrom(payload);
  const err = await shell.openPath(found);
  if (err) throw new Error(err);
  return { ok: true, path: found };
});

ipcMain.handle("compact", async (_event, payload) => {
  const hint = typeof payload === "string" || payload == null ? payload : payload.hint;
  const sessionId = (typeof payload === "object" && payload?.sessionId) || state.sessionId;
  const cwd = (typeof payload === "object" && payload?.cwd) || cwdOfSession(sessionId);
  await ensureAgent();
  if (!cwd) throw new Error("先打开一个文件夹");
  if (!sessionId) throw new Error("先打开一次对话");
  if (projectLocks.has(lockKey(cwd))) throw new Error('项目正在恢复，请稍后再试');
  await attachSession(sessionId, cwd);
  const gen = beginTurn(sessionId, cwd, { compact: true });
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
  if (projectLocks.has(lockKey(cwd))) throw new Error('项目正在恢复，请稍后再试');
  if (!sessionId) {
    if (!samePath(state.cwd, cwd)) await switchProject(cwd, { clearSession: true });
    await createSession();
    sessionId = state.sessionId;
    cwd = state.cwd;
  } else {
    liveSlot(sessionId, cwd);
    await attachSession(sessionId, cwd);
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
  const gen = beginTurn(sessionId, cwd, { user: rawText, itemId: payload?.itemId });
  send("state", snapshot());
  try {
    if (preferences(loadSettings()).checkpoints && !rawText.trim().startsWith('/')) {
      try {
        await reviewService.checkpoint(app.getPath('userData'), cwd, rawText || '发送附件前', sessionId);
        state.checkpointWarning = '';
      } catch (error) {
        state.checkpointWarning = `本轮未建立文件检查点：${error.message}`;
        send('state', snapshot());
      }
    }
    const context = buildContext(cwd, sessionId);
    if (!rawText.trim().startsWith('/') && context.percent >= preferences(loadSettings()).autoCompact) {
      await acp.compact(sessionId, '');
    }
    try {
      const result = await acp.prompt(sessionId, text, images, fileList);
      return { ok: true, result };
    } catch (err) {
      // Retry only protocol-level unsupported attachments, never a turn that
      // already ran tools or was cancelled.
      if ((!images.length && !fileList.length) || live.get(sessionId)?.gotUpdate || !/unsupported|invalid params|resource_link/i.test(err.message)) throw err;
      const fallback = [text.trim(), ...images.map((img) => img.path), ...files]
        .filter(Boolean)
        .join("\n");
      const result = await acp.prompt(sessionId, fallback, [], []);
      return { ok: true, result };
    }
  } catch (error) {
    if (live.get(sessionId)?.gen === gen) updateRecovery(sessionId, { status: 'interrupted' });
    throw error;
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
  permissions.resolve(requestId, optionId);
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

function saveComposer(payload) {
  if (maintenance) return { ok: false };
  if (!payload || typeof payload.key !== 'string' || payload.key.length > 1200) throw new Error('无效的草稿');
  const value = readJson(dataFile('composer.json'), {});
  const row = JSON.parse(JSON.stringify(payload.value || {}));
  const cleanImage = image => {
    if (!image?.data) return image;
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MB');
    const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const file = path.join(dataFile('inbox'), digest + extFromMime(image.mime));
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
    const { data, src, ...rest } = image;
    return { ...rest, path: file };
  };
  row.attachments = (row.attachments || []).slice(0, 16).map(cleanImage);
  const accepted = new Set(recovery().acceptedItems || []);
  row.queue = (row.queue || []).filter(item => !accepted.has(item.id)).slice(0, 100).map(item => ({ ...item, images: (item.images || []).map(cleanImage) }));
  row.updatedAt = Date.now();
  value[payload.key] = row;
  writeJson(dataFile('composer.json'), value);
  return { ok: true };
}
ipcMain.handle('save-composer', (_event, payload) => saveComposer(payload));
ipcMain.on?.('save-composer-sync', (event, payload) => {
  try { event.returnValue = saveComposer(payload); } catch (error) { event.returnValue = { error: error.message }; }
});

ipcMain.handle('reconnect', async () => { reconnectAttempts = 0; await ensureAgent(); send('state', snapshot()); return snapshot(); });
ipcMain.handle('dismiss-recovery', (_event, id) => { updateRecovery(id, null); send('state', snapshot()); return snapshot(); });
ipcMain.handle('refresh-quota', async () => { await refreshQuota(true); return snapshot(); });
ipcMain.handle('save-preferences', async (_event, payload) => {
  const next = preferences({ ...loadSettings(), ...payload });
  if (next.defaultCwd && !fs.statSync(next.defaultCwd).isDirectory()) throw new Error('默认项目不是文件夹');
  // Grok reads this section for its own automatic compaction as well.
  const config = path.join(grokHome(), 'config.toml');
  const raw = (fs.existsSync(config) ? fs.readFileSync(config, 'utf8').trimEnd() : '') + '\n';
  const section = /(^\[session\][^\n]*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  const key = `auto_compact_threshold_percent = ${next.autoCompact}`;
  const match = raw.match(section);
  let configNext;
  if (match) {
    const body = /^\s*auto_compact_threshold_percent\s*=.*$/m.test(match[2]) ? match[2].replace(/^\s*auto_compact_threshold_percent\s*=.*$/m, key) : `${key}\n${match[2]}`;
    configNext = raw.replace(section, () => match[1] + body);
  } else configNext = raw.trimEnd() + `\n\n[session]\n${key}\n`;
  atomicWrite(config, configNext);
  saveSettings(next);
  state.permissionMode = next.permissionMode;
  // The preference is a default for new sessions. The current model selector
  // is the only action that changes an existing session's model.
  refreshContext(); send('state', snapshot()); return snapshot();
});
ipcMain.handle('review', (_event, cwd) => reviewService.review(cwd || state.cwd));
ipcMain.handle('review-diff', (_event, { cwd, file }) => reviewService.diff(cwd || state.cwd, file));
ipcMain.handle('review-stage', (_event, { cwd, files, unstage, all }) => lockedProject(cwd || state.cwd, () => reviewService.stage(cwd || state.cwd, all ? true : files, unstage)));
ipcMain.handle('review-commit', (_event, { cwd, message }) => lockedProject(cwd || state.cwd, () => reviewService.commit(cwd || state.cwd, message)));
ipcMain.handle('review-sync', (_event, { cwd } = {}) => lockedProject(cwd || state.cwd, () => reviewService.sync(cwd || state.cwd)));
ipcMain.handle('checkpoints', (_event, cwd) => reviewService.checkpointList(app.getPath('userData'), cwd || state.cwd));
ipcMain.handle('create-checkpoint', (_event, { cwd, label }) => lockedProject(cwd || state.cwd, () => reviewService.checkpoint(app.getPath('userData'), cwd || state.cwd, label, state.sessionId)));
ipcMain.handle('preview-restore', (_event, { cwd, id }) => reviewService.restorePreview(app.getPath('userData'), cwd || state.cwd, id));
async function rewindPoints(sessionId, cwd) {
  await attachSession(sessionId, cwd);
  const result = await acp.request('_x.ai/rewind/points', { sessionId }, { timeoutMs: 15000 });
  return (result.rewind_points || result.rewindPoints || []).map((row, index) => ({
    index: row.prompt_index ?? row.promptIndex ?? index,
    label: row.prompt_preview ?? row.user_message ?? row.userMessage ?? row.prompt ?? row.preview ?? `第 ${index + 1} 轮`,
    at: row.created_at ?? row.createdAt ?? null,
  }));
}
ipcMain.handle('rewind-points', (_event, { sessionId, cwd }) => rewindPoints(sessionId, cwd || cwdOfSession(sessionId)));
ipcMain.handle('rewind-execute', async (_event, { sessionId, cwd, index }) => {
  const target = cwd || cwdOfSession(sessionId);
  return lockedProject(target, async () => {
    const points = await rewindPoints(sessionId, target);
    if (!points.some(p => p.index === index)) throw new Error('回退点已改变，请刷新');
    const answer = await dialog.showMessageBox(win, { type: 'warning', title: '回退对话', message: `回到第 ${index + 1} 轮之前？`, detail: '后续对话将被移除，磁盘上的代码不会回退。原始会话将在本机备份。', buttons: ['取消', '回退对话'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return { canceled: true };
    const dir = sessionDir(target, sessionId);
    if (!dir) throw new Error('找不到原始会话，无法备份');
    const backup = dataFile(`rewind-backups/${sessionId}-${Date.now()}`);
    fs.cpSync(dir, backup, { recursive: true, filter: file => !/\.lock$/.test(file) });
    if (!fs.existsSync(path.join(backup, 'summary.json'))) throw new Error('会话备份失败，未执行回退');
    const result = await acp.request('_x.ai/rewind/execute', { sessionId, targetPromptIndex: index, mode: 'conversation_only' }, { timeoutMs: 30000 });
    if (result?.success === false) throw new Error(result.error || '对话回退未完成');
    const messages = readTranscript(target, sessionId);
    send('transcript', { sessionId, messages });
    refreshSessions(); refreshContext(); send('state', snapshot());
    return { backup };
  });
});
ipcMain.handle('restore-checkpoint', async (_event, { cwd, id, fingerprint }) => {
  const target = cwd || state.cwd;
  return lockedProject(target, async () => {
    const preview = await reviewService.restorePreview(app.getPath('userData'), target, id);
    if (preview.fingerprint !== fingerprint) throw new Error('文件已变化，请重新预览');
    const confirm = await dialog.showMessageBox(win, { type: 'warning', title: '恢复检查点', message: `将恢复 ${preview.files.length} 个文件。`, detail: '工作区文件会被替换；Git 暂存区和对话历史保持原状。恢复前会建立备份检查点。', buttons: ['取消', '恢复文件'], defaultId: 0, cancelId: 0 });
    if (confirm.response !== 1) return { canceled: true };
    return reviewService.restoreCheckpoint(app.getPath('userData'), target, id, fingerprint);
  });
});
ipcMain.handle('export-chat', async (_event, { cwd, sessionId, format }) => {
  if (!['md', 'json', 'html'].includes(format)) throw new Error('不支持的导出格式');
  if (live.get(sessionId)?.running) throw new Error('对话还在运行，请完成后导出');
  const target = cwd || cwdOfSession(sessionId);
  const title = state.projects.flatMap(p => p.sessions || []).find(s => s.id === sessionId)?.title || '对话';
  const messages = readTranscript(target, sessionId);
  const result = await dialog.showSaveDialog(win, { title: '导出对话', defaultPath: `${title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (result.canceled || !result.filePath) return null;
  atomicWrite(result.filePath, archives.exportTranscript(messages, title, format));
  return { path: result.filePath };
});
let backupSelection = null;
ipcMain.handle('backup-create', async () => {
  if (runningIds().length) throw new Error('请等待正在运行的任务结束后备份');
  const result = await dialog.showSaveDialog(win, { title: '备份 Halora', defaultPath: `halora-${new Date().toISOString().slice(0, 10)}.halora`, filters: [{ name: 'Halora 备份', extensions: ['halora'] }] });
  if (result.canceled || !result.filePath) return null;
  return archives.createBackup(app.getPath('userData'), grokHome(), result.filePath);
});
ipcMain.handle('backup-inspect', async () => {
  const result = await dialog.showOpenDialog(win, { title: '选择 Halora 备份', properties: ['openFile'], filters: [{ name: 'Halora 备份', extensions: ['halora'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const bundle = archives.parseBackup(result.filePaths[0]);
  backupSelection = { path: result.filePaths[0], fingerprint: bundle.fingerprint };
  return { at: bundle.at, count: bundle.files.length, path: backupSelection.path };
});
ipcMain.handle('backup-restore', async () => {
  if (!backupSelection) throw new Error('先选择备份');
  if (runningIds().length) throw new Error('请先停止所有运行中的任务');
  const answer = await dialog.showMessageBox(win, { type: 'warning', title: '恢复备份', message: '恢复对话、技能和设置？', detail: '同路径的数据将被覆盖，其它现有数据保留。恢复前会备份当前数据，完成后自动重启 Halora。登录凭据不在备份中。', buttons: ['取消', '恢复并重启'], defaultId: 0, cancelId: 0 });
  if (answer.response !== 1) return null;
  if (runningIds().length || projectLocks.size) throw new Error('还有任务或文件操作在运行，请稍后恢复');
  maintenance = true;
  try {
    stopSessionWatch(); stopQuotaTimers(); acp.stop();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const result = archives.restoreBackup(app.getPath('userData'), grokHome(), backupSelection.path, backupSelection.fingerprint);
    quitting = true; app.relaunch(); app.exit(0);
    return result;
  } catch (error) { watchSessions(); throw error; }
  finally { maintenance = false; }
});

app.setName("Halora");
app.setAppUserModelId("local.halora");
const primaryInstance = process.env.SMOKE_TEST === '1' || app.requestSingleInstanceLock?.() !== false;
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

if (process.env.SMOKE_TEST === "1") {
  app.whenReady().then(() => {
    const ok = typeof app === "object" && typeof ipcMain.handle === "function";
    process.stdout.write(`SMOKE ${ok ? "OK" : "FAIL"} grok=${findGrokBinary() || "missing"}\n`);
    app.quit();
  });
} else if (primaryInstance) {
  app.whenReady().then(() => {
    markInterrupted();
    hydrateQuota();
    createWindow();
    state.grokBin = findGrokBinary();
    ensureAgent().then(() => send("state", snapshot())).catch(() => send("state", snapshot()));
    refreshQuota();
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = setInterval(() => refreshQuota(), 5 * 60 * 1000);
  });
}

app.on("window-all-closed", () => {
  stopSessionWatch();
  stopQuotaTimers();
  acp.stop();
  app.quit();
});

app.on("before-quit", () => {
  if (!quitting && process.env.SMOKE_TEST !== '1') markInterrupted();
  quitting = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopSessionWatch();
  stopQuotaTimers();
  acp.stop();
});
