const fs = require("node:fs");
const path = require("node:path");
const { grokHome } = require("./grok-path.cjs");
const { sessionDir } = require("./sessions.cjs");
const { listSkills, listWorkflows } = require("./skills.cjs");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function estimateTokens(text) {
  const str = String(text || "");
  if (!str) return 0;
  return Math.max(1, Math.round(str.length / 4));
}

function readTail(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function sessionUsage(sessionId) {
  if (!sessionId) return { input: 0, output: 0, cache: 0, reasoning: 0 };
  const file = path.join(grokHome(), "logs", "unified.jsonl");
  const text = readTail(file, 3 * 1024 * 1024);
  let input = 0;
  let output = 0;
  let cache = 0;
  let reasoning = 0;
  for (const line of text.split(/\n/)) {
    if (!line.includes(sessionId) || !line.includes("inference_done")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.sid !== sessionId) continue;
    const ctx = row.ctx || {};
    input += Number(ctx.prompt_tokens) || 0;
    output += Number(ctx.completion_tokens) || 0;
    cache += Number(ctx.cached_prompt_tokens) || 0;
    reasoning = Number(ctx.reasoning_tokens) || reasoning;
  }
  return { input, output, cache, reasoning };
}

function autoCompactPercent() {
  try {
    const raw = fs.readFileSync(path.join(grokHome(), "config.toml"), "utf8");
    const match = raw.match(/auto_compact_threshold_percent\s*=\s*(\d+)/);
    if (match) return Number(match[1]);
  } catch {
    // default
  }
  return 85;
}

const compactEvents = new Map();
const compactScans = new Map();
const completedKinds = new Set(["auto_compact_completed", "compaction_completed", "context_compact"]);

function tokenCount(value) {
  if (value == null || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return { time: stat.mtimeMs, size: stat.size };
  } catch {
    return { time: 0, size: 0 };
  }
}

function recordCompaction(dir, params, timestamp = Date.now()) {
  const update = params?.update || {};
  if (!dir || !completedKinds.has(update.sessionUpdate)) return;
  const at = Number(params._meta?.agentTimestampMs) || timestamp;
  if ((compactEvents.get(dir)?.at || 0) > at) return;
  compactEvents.set(dir, {
    at,
    before: tokenCount(update.tokens_before ?? update.tokensBefore),
    after: tokenCount(update.tokens_after ?? update.tokensAfter),
  });
}

function rememberCompaction(cwd, sessionId, params) {
  recordCompaction(sessionDir(cwd, sessionId), params);
}

function latestCompaction(dir, sessionId) {
  const file = path.join(dir, "updates.jsonl");
  const stamp = fileStamp(file);
  const signature = `${stamp.time}:${stamp.size}`;
  if (compactScans.get(dir) !== signature) {
    compactScans.set(dir, signature);
    for (const line of readTail(file, 1024 * 1024).split(/\n/)) {
      if (![...completedKinds].some((kind) => line.includes(kind))) continue;
      try {
        const row = JSON.parse(line);
        const params = row.params || row;
        if (params.sessionId && params.sessionId !== sessionId) continue;
        recordCompaction(dir, params, Number(row.timestamp) * 1000 || stamp.time);
      } catch {
        // A writer may still be appending the final JSONL record.
      }
    }
  }
  return compactEvents.get(dir);
}

function activeHistoryTokens(dir) {
  try {
    const history = fs.readFileSync(path.join(dir, "chat_history.jsonl"), "utf8");
    // Estimate the active model history, never the archived transcript/segments.
    let bytes = 0;
    for (const line of history.split(/\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      bytes += Buffer.byteLength(JSON.stringify(row.content ?? row), "utf8");
    }
    const system = fs.existsSync(path.join(dir, "system_prompt.txt"))
      ? fs.readFileSync(path.join(dir, "system_prompt.txt")) : Buffer.alloc(0);
    return Math.ceil((bytes + system.length) / 4);
  } catch {
    return null;
  }
}

function buildContext(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  const signals = dir ? readJson(path.join(dir, "signals.json")) : null;
  let used = Number(signals?.contextTokensUsed) || 0;
  let estimated = false;
  const compact = dir ? latestCompaction(dir, sessionId) : null;
  if (compact) {
    const signalsTime = fileStamp(path.join(dir, "signals.json")).time;
    // Some Grok versions rewrite the same pre-compaction count. Do not let it
    // replace the compacted context until a fresh usage measurement arrives.
    const freshSignals = signalsTime > compact.at && used !== compact.before;
    if (!freshSignals) {
      const reliable = compact.after != null &&
        (compact.before == null || compact.after < compact.before || compact.after === 0);
      const historyChanged = fileStamp(path.join(dir, "chat_history.jsonl")).time > compact.at + 1000;
      const estimate = (!reliable || historyChanged) ? activeHistoryTokens(dir) : null;
      if (estimate != null) {
        used = estimate;
        estimated = true;
      } else if (reliable) {
        used = compact.after;
      }
    }
  }
  const total = Number(signals?.contextWindowTokens) || 500000;
  const percent = total ? Math.round((used / total) * 100) : 0;
  const skills = listSkills(cwd);
  const workflows = listWorkflows(cwd);
  const tools = Array.isArray(signals?.toolsUsed) ? signals.toolsUsed : [];
  const usage = sessionUsage(sessionId);
  let system = 0;
  if (dir) {
    try {
      system = estimateTokens(fs.readFileSync(path.join(dir, "system_prompt.txt"), "utf8"));
    } catch {
      system = 0;
    }
  }
  const skillTokens = Math.min(12000, skills.length * 100);
  const toolTokens = tools.length * 340;
  const workflowTokens = workflows.length * 90;
  const reasoning = usage.reasoning ? Math.min(used, usage.reasoning) : Math.round(used * 0.12);
  const free = Math.max(0, total - used);
  const messages = Math.max(0, used - system - reasoning);
  return {
    used,
    estimated,
    total,
    percent: Math.max(0, Math.min(100, percent)),
    turns: Number(signals?.turnCount) || 0,
    compactionCount: Number(signals?.compactionCount) || 0,
    autoCompact: autoCompactPercent(),
    system,
    messages,
    reasoning,
    free,
    tools: { count: tools.length, tokens: toolTokens },
    skills: { count: skills.length, tokens: skillTokens },
    workflows: { count: workflows.length, tokens: workflowTokens },
    sessionInput: usage.input,
    sessionCache: usage.cache,
    sessionOutput: usage.output,
  };
}

module.exports = { buildContext, rememberCompaction, listSkills, listWorkflows };
