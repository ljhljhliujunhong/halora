const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { agentSpawnArgs, sessionMeta } = require("./permission-mode.cjs");

class AcpClient extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.nextId = 0;
    this.pending = new Map();
    this.draining = new Map();
    this.idleMs = 5 * 60 * 1000;
    this.cancelGraceMs = 5000;
  }

  get alive() {
    return Boolean(this.proc && !this.proc.killed);
  }

  start(bin) {
    this.stop();
    this.proc = spawn(bin, agentSpawnArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    const proc = this.proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => { if (this.proc === proc) this.onLine(line); });

    this.proc.stderr.on("data", (buf) => {
      this.emit("stderr", buf.toString());
    });

    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.proc = null;
      this.emit("exit", null);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      const err = new Error(`Grok 已退出 (${code ?? "?"})`);
      for (const item of this.pending.values()) item.reject(err);
      this.pending.clear();
      this.proc = null;
      this.emit("exit", code);
    });
  }

  stop() {
    for (const finish of this.draining.values()) finish();
    this.draining.clear();
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    for (const item of this.pending.values()) {
      item.reject(new Error("已断开"));
    }
    this.pending.clear();
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }

  onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit("bad-line", trimmed.slice(0, 200));
      return;
    }

    if (msg.method && msg.id != null) {
      this.handleIncoming(msg);
      return;
    }

    if (msg.method) {
      for (const item of this.pending.values()) {
        if (item.sessionId === msg.params?.sessionId) item.touch?.();
      }
      this.emit("notification", msg.method, msg.params || {});
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const item = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        item.reject(Object.assign(new Error(msg.error.message || "ACP error"), { payload: msg.error }));
      } else {
        item.resolve(msg.result);
      }
    }
    if (msg.id != null) this.draining.get(msg.id)?.();
  }

  handleIncoming(msg) {
    if (msg.method === "session/request_permission") {
      for (const item of this.pending.values()) if (item.sessionId === msg.params?.sessionId) item.touch?.(30 * 60 * 1000);
      this.emit("permission", { requestId: msg.id, params: msg.params || {} });
      return;
    }
    this.respondError(msg.id, -32601, `未实现 ${msg.method}`);
  }

  send(obj) {
    if (!this.proc?.stdin?.writable) throw new Error("Grok 还没连上");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, { timeoutMs, idle = false } = {}) {
    const id = ++this.nextId;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      let timer;
      const touch = (ms = timeoutMs) => {
        clearTimeout(timer);
        if (ms > 0) timer = setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id);
                reject(new Error(`${method} 超时`));
                if (idle) { this.stop(); this.emit('exit', 'timeout'); }
              }
            }, ms);
      };
      touch();
      this.pending.set(id, {
        sessionId: params?.sessionId, method, touch: idle ? touch : null,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  answerPermission(requestId, optionId) {
    if (optionId === "__cancel__") {
      this.respond(requestId, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.respond(requestId, {
      outcome: { outcome: "selected", optionId },
    });
  }

  initialize() {
    return this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "halora", title: "Halora", version: require('../package.json').version },
        clientCapabilities: {},
      },
      { timeoutMs: 20000 }
    );
  }

  newSession(cwd, mode) {
    return this.request("session/new", { cwd, mcpServers: [], _meta: sessionMeta(mode) }, { timeoutMs: 20000 });
  }

  loadSession(sessionId, cwd, mode) {
    return this.request(
      "session/load",
      { sessionId, cwd, mcpServers: [], _meta: sessionMeta(mode) },
      { timeoutMs: 20000 }
    );
  }

  setModel(sessionId, modelId) {
    return this.request("session/set_model", { sessionId, modelId }, { timeoutMs: 10000 });
  }

  async setConfigOption(sessionId, configId, value) {
    const raw = String(value?.value ?? value ?? "");
    try {
      return await this.request("session/set_config_option", { sessionId, configId, value: raw }, { timeoutMs: 10000 });
    } catch (err) {
      if (!/invalid params|unknown/i.test(String(err.message || err))) throw err;
      return this.request(
        "session/set_config_option",
        { sessionId, configId, type: "id", value: raw },
        { timeoutMs: 10000 }
      );
    }
  }

  async prompt(sessionId, text, images = [], files = []) {
    await Promise.all([...this.draining.values()].filter(f => f.sessionId === sessionId).map(f => f.done));
    const blocks = [];
    const trimmed = String(text || "").trim();
    if (trimmed) blocks.push({ type: "text", text: trimmed });
    for (const img of images) {
      if (!img?.data) continue;
      blocks.push({
        type: "image",
        mimeType: img.mime || "image/png",
        data: img.data,
      });
    }
    for (const file of files) {
      if (!file?.path) continue;
      blocks.push({
        type: "resource_link",
        uri: pathToFileURL(file.path).href,
        name: file.name || path.basename(file.path),
      });
    }
    if (!blocks.length) throw new Error("先写点什么，或加一张图");
    return this.request("session/prompt", { sessionId, prompt: blocks }, { timeoutMs: this.idleMs, idle: true });
  }

  compact(sessionId, hint) {
    const note = String(hint || "").trim();
    return this.prompt(sessionId, note ? `/compact ${note}` : "/compact");
  }

  cancel(sessionId) {
    this.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });
    for (const [id, item] of this.pending) {
      if (item.sessionId !== sessionId || item.method !== 'session/prompt') continue;
      this.pending.delete(id);
      item.reject(new Error('任务已取消'));
      let resolve;
      const done = new Promise(r => { resolve = r; });
      const finish = () => { clearTimeout(timer); this.draining.delete(id); resolve(); this.emit('settled', sessionId); };
      finish.done = done; finish.sessionId = sessionId;
      const timer = setTimeout(() => { this.stop(); this.emit('exit', 'cancel-timeout'); }, this.cancelGraceMs);
      this.draining.set(id, finish);
    }
  }
}

module.exports = { AcpClient, agentSpawnArgs, sessionMeta };
