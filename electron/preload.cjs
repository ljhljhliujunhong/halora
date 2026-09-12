const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("workshop", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveComposer: (payload) => ipcRenderer.invoke('save-composer', payload),
  saveComposerSync: (payload) => ipcRenderer.sendSync('save-composer-sync', payload),
  savePreferences: (value) => ipcRenderer.invoke('save-preferences', value),
  reconnect: () => ipcRenderer.invoke('reconnect'),
  dismissRecovery: (id) => ipcRenderer.invoke('dismiss-recovery', id),
  refreshQuota: () => ipcRenderer.invoke('refresh-quota'),
  review: (cwd) => ipcRenderer.invoke('review', cwd),
  reviewDiff: (value) => ipcRenderer.invoke('review-diff', value),
  reviewStage: (value) => ipcRenderer.invoke('review-stage', value),
  reviewCommit: (value) => ipcRenderer.invoke('review-commit', value),
  reviewSync: (value) => ipcRenderer.invoke('review-sync', value),
  checkpoints: (cwd) => ipcRenderer.invoke('checkpoints', cwd),
  createCheckpoint: (value) => ipcRenderer.invoke('create-checkpoint', value),
  previewRestore: (value) => ipcRenderer.invoke('preview-restore', value),
  restoreCheckpoint: (value) => ipcRenderer.invoke('restore-checkpoint', value),
  rewindPoints: (value) => ipcRenderer.invoke('rewind-points', value),
  rewindExecute: (value) => ipcRenderer.invoke('rewind-execute', value),
  exportChat: (value) => ipcRenderer.invoke('export-chat', value),
  backupCreate: () => ipcRenderer.invoke('backup-create'),
  backupInspect: () => ipcRenderer.invoke('backup-inspect'),
  backupRestore: () => ipcRenderer.invoke('backup-restore'),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openProject: (cwd) => ipcRenderer.invoke("open-project", cwd),
  newChat: (cwd) => ipcRenderer.invoke("new-chat", cwd || null),
  loadChat: (id, cwd) => ipcRenderer.invoke("load-chat", { id, cwd }),
  renameChat: (id, title, cwd) => ipcRenderer.invoke("rename-chat", { id, title, cwd }),
  pinProject: (cwd, pinned) => ipcRenderer.invoke("pin-project", { cwd, pinned }),
  renameProject: (cwd, name) => ipcRenderer.invoke("rename-project", { cwd, name }),
  hideProject: (cwd) => ipcRenderer.invoke("hide-project", { cwd }),
  pinChat: (id, pinned) => ipcRenderer.invoke("pin-chat", { id, pinned }),
  deleteChat: (id, cwd) => ipcRenderer.invoke("delete-chat", { id, cwd }),
  reorderProjects: (order) => ipcRenderer.invoke("reorder-projects", order),
  reorderChats: (cwd, order) => ipcRenderer.invoke("reorder-chats", { cwd, order }),
  setSidebar: (collapsed) => ipcRenderer.invoke("set-sidebar", collapsed),
  pickSkillFolder: () => ipcRenderer.invoke("pick-skill-folder"),
  importSkills: (from, replace) => ipcRenderer.invoke("import-skills", { from, replace }),
  removeSkill: (name) => ipcRenderer.invoke("remove-skill", name),
  searchFiles: (query, opts) =>
    ipcRenderer.invoke("search-files", { query, hidden: Boolean(opts?.hidden) }),
  send: (payload) => ipcRenderer.invoke("send-prompt", payload),
  compact: (hint, sessionId) =>
    ipcRenderer.invoke("compact", sessionId ? { hint, sessionId } : hint),
  pickImages: () => ipcRenderer.invoke("pick-files"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  resolveDrops: (paths) => ipcRenderer.invoke("resolve-drops", paths),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  mediaSrc: (filePath) => ipcRenderer.invoke("media-src", filePath),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFolder: (hint, cwd) =>
    ipcRenderer.invoke("show-in-folder", typeof hint === "object" ? hint : { hint, cwd }),
  openPath: (hint, cwd) =>
    ipcRenderer.invoke("open-path", typeof hint === "object" ? hint : { hint, cwd }),
  cancel: (sessionId) => ipcRenderer.invoke("cancel", sessionId),
  setModel: (id) => ipcRenderer.invoke("set-model", id),
  setPermissionMode: (mode) => ipcRenderer.invoke("set-permission-mode", mode),
  answerPermission: (requestId, optionId) =>
    ipcRenderer.invoke("answer-permission", { requestId, optionId }),
  login: () => ipcRenderer.invoke("login"),
  onEvent: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("workshop-event", listen);
    return () => ipcRenderer.removeListener("workshop-event", listen);
  },
});
