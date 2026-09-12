const fs = require("node:fs");
const path = require("node:path");
const { grokHome } = require("./grok-path.cjs");
const { collectImages, stripImageJson } = require("./media.cjs");

function encodeCwd(cwd) {
  return encodeURIComponent(cwd);
}

function cwdVariants(cwd) {
  const resolved = path.resolve(cwd);
  const lowerDrive = resolved.replace(/^([A-Z]):/, (_m, d) => `${d.toLowerCase()}:`);
  const upperDrive = resolved.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  return [...new Set([resolved, lowerDrive, upperDrive].flatMap(value => [value, value.replace(/\\/g, '/')]))];
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function canonicalCwd(cwd) {
  if (!cwd) return "";
  try {
    return path.resolve(cwd).replace(/^([A-Z]):/, (_m, d) => `${d.toLowerCase()}:`);
  } catch {
    return String(cwd).toLowerCase();
  }
}

function preferExisting(cwd) {
  let resolved = String(cwd || "");
  try {
    resolved = path.resolve(cwd);
  } catch {
    return resolved;
  }
  if (fs.existsSync(resolved)) return resolved;
  const flipped = resolved.replace(/^([a-zA-Z]):/, (_m, d) => {
    const other = d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase();
    return `${other}:`;
  });
  if (flipped !== resolved && fs.existsSync(flipped)) return flipped;
  return resolved;
}

function folderNameOf(cwd) {
  const cleaned = String(cwd || "").replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

function decodeCwdKey(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}

function sessionsRoot() {
  return path.join(grokHome(), "sessions");
}

function readSummary(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function shortenTitle(text) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const chars = [...cleaned];
  if (chars.length <= 28) return cleaned;
  return `${chars.slice(0, 28).join("").replace(/[，。、,.!?…\s]+$/u, "")}…`;
}

function firstUserTitle(dir) {
  const file = path.join(dir, "updates.jsonl");
  if (!fs.existsSync(file)) return "";
  let raw = "";
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const size = Math.min(stat.size, 256 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row.params?.update || row.update;
    if (update?.sessionUpdate !== "user_message_chunk") continue;
    text += update.content?.text || "";
    if (text.length >= 80) break;
  }
  return shortenTitle(text);
}

function sessionTitle(summary, overlay, dir) {
  if (overlay) return overlay;
  if (summary?.user_title) return summary.user_title;
  if (summary?.title_is_manual && summary.generated_title) return summary.generated_title;
  if (summary?.generated_title) return summary.generated_title;
  if (summary?.auto_title) return summary.auto_title;
  if (summary?.session_summary) return summary.session_summary;
  return firstUserTitle(dir) || "新对话";
}

function listSessionsForCwd(cwd, titles = {}) {
  const root = path.join(grokHome(), "sessions");
  if (!fs.existsSync(root)) return [];

  const dirs = new Set();
  for (const variant of cwdVariants(cwd)) {
    const group = path.join(root, encodeCwd(variant));
    if (fs.existsSync(group)) dirs.add(group);
  }

  const sessions = [];
  const seen = new Set();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summaryPath = path.join(dir, entry.name, "summary.json");
      const summary = readSummary(summaryPath);
      if (!summary?.info?.id) continue;
      if (seen.has(summary.info.id)) continue;
      if (summary.info.cwd && !samePath(summary.info.cwd, cwd)) continue;
      seen.add(summary.info.id);
      const id = summary.info.id;
      sessions.push({
        id,
        title: sessionTitle(summary, titles[id], path.join(dir, entry.name)),
        updatedAt: summary.last_active_at || summary.updated_at || summary.created_at,
        createdAt: summary.created_at,
        model: summary.current_model_id,
        messages: summary.num_chat_messages || 0,
      });
    }
  }

  sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return sessions;
}

function pinRank(list, value) {
  const index = list.indexOf(value);
  return index === -1 ? 10000 : index;
}

function lookupOrder(map, cwd) {
  if (!map || typeof map !== "object") return [];
  const key = canonicalCwd(cwd);
  if (Array.isArray(map[key])) return map[key];
  for (const [raw, value] of Object.entries(map)) {
    if (canonicalCwd(raw) === key && Array.isArray(value)) return value;
  }
  return [];
}

function sortWithOrder(items, order, getKey, fallback) {
  const list = [...items];
  if (!order?.length) {
    list.sort(fallback);
    return list;
  }
  const rank = new Map();
  for (let i = 0; i < order.length; i += 1) {
    const key = order[i];
    if (key && !rank.has(key)) rank.set(key, i);
  }
  const known = [];
  const unknown = [];
  for (const item of list) {
    if (rank.has(getKey(item))) known.push(item);
    else unknown.push(item);
  }
  unknown.sort(fallback);
  known.sort((a, b) => rank.get(getKey(a)) - rank.get(getKey(b)));
  return [...unknown, ...known];
}

function listProjects(options = {}) {
  const known = options.known || [];
  const titles = options.titles || {};
  const hidden = new Set((options.hidden || []).map(canonicalCwd).filter(Boolean));
  const pinnedProjects = (options.pinnedProjects || []).map(canonicalCwd).filter(Boolean);
  const pinnedChats = options.pinnedChats || [];
  const projectNames = {};
  for (const [key, value] of Object.entries(options.projectNames || {})) {
    const canon = canonicalCwd(key);
    if (canon && value) projectNames[canon] = String(value);
  }

  const root = sessionsRoot();
  const buckets = new Map();

  const take = (cwd) => {
    if (!cwd) return null;
    const resolved = preferExisting(cwd);
    const key = canonicalCwd(resolved);
    if (!key) return null;
    if (!buckets.has(key)) {
      buckets.set(key, {
        cwd: resolved,
        name: projectNames[key] || folderNameOf(resolved),
        folderName: folderNameOf(resolved),
        exists: fs.existsSync(resolved),
        pinned: pinRank(pinnedProjects, key) < 10000,
        sessions: [],
        seen: new Set(),
        updatedAt: "",
      });
    }
    return buckets.get(key);
  };

  if (fs.existsSync(root)) {
    let groups = [];
    try {
      groups = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      groups = [];
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const decoded = decodeCwdKey(group.name);
      if (!decoded) continue;
      const groupDir = path.join(root, group.name);
      let entries = [];
      try {
        entries = fs.readdirSync(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      let added = false;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(groupDir, entry.name);
        const summary = readSummary(path.join(dir, "summary.json"));
        if (!summary?.info?.id) continue;
        const project = take(summary.info.cwd || decoded);
        if (!project || project.seen.has(summary.info.id)) continue;
        project.seen.add(summary.info.id);
        added = true;
        const id = summary.info.id;
        project.sessions.push({
          id,
          cwd: project.cwd,
          title: sessionTitle(summary, titles[id], dir),
          updatedAt: summary.last_active_at || summary.updated_at || summary.created_at,
          createdAt: summary.created_at,
          model: summary.current_model_id,
          messages: summary.num_chat_messages || 0,
          pinned: pinRank(pinnedChats, id) < 10000,
        });
      }
      if (!added) take(decoded);
    }
  }

  for (const cwd of known) take(cwd);

  const projects = [];
  for (const project of buckets.values()) {
    const key = canonicalCwd(project.cwd);
    if (hidden.has(key)) continue;
    if (!project.exists && !project.sessions.length) continue;
    project.sessions = sortWithOrder(
      project.sessions,
      lookupOrder(options.chatOrder, key),
      (session) => session.id,
      (a, b) => {
        const pin = pinRank(pinnedChats, a.id) - pinRank(pinnedChats, b.id);
        if (pin) return pin;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      }
    );
    const latest = [...project.sessions].sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    )[0];
    project.updatedAt = latest?.updatedAt || "";
    delete project.seen;
    projects.push(project);
  }

  const projectOrder = (options.projectOrder || []).map(canonicalCwd).filter(Boolean);
  return sortWithOrder(projects, projectOrder, (item) => canonicalCwd(item.cwd), (a, b) => {
    const pin = pinRank(pinnedProjects, canonicalCwd(a.cwd)) - pinRank(pinnedProjects, canonicalCwd(b.cwd));
    if (pin) return pin;
    const byTime = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (byTime) return byTime;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh");
  });
}

function deleteSession(cwd, sessionId) {
  if (!cwd || !sessionId) return false;
  const root = sessionsRoot();
  let deleted = false;
  for (const variant of cwdVariants(cwd)) {
    const dir = path.join(root, encodeCwd(variant), sessionId);
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    deleted = true;
  }
  return deleted;
}

function sessionGroupDirs(cwd) {
  const root = path.join(grokHome(), "sessions");
  const dirs = [];
  for (const variant of cwdVariants(cwd)) {
    const group = path.join(root, encodeCwd(variant));
    if (fs.existsSync(group)) dirs.push(group);
  }
  return dirs;
}

function sessionDir(cwd, sessionId) {
  const root = path.join(grokHome(), "sessions");
  for (const variant of cwdVariants(cwd)) {
    const dir = path.join(root, encodeCwd(variant), sessionId);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function readContext(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return null;
  const signals = readSummary(path.join(dir, "signals.json"));
  if (!signals) return null;
  const used = Number(signals.contextTokensUsed) || 0;
  const total = Number(signals.contextWindowTokens) || 500000;
  const percent =
    signals.contextWindowUsage != null
      ? Number(signals.contextWindowUsage)
      : total
        ? Math.round((used / total) * 100)
        : 0;
  return {
    used,
    total,
    percent: Math.max(0, Math.min(100, percent)),
    turns: Number(signals.turnCount) || 0,
    compactionCount: Number(signals.compactionCount) || 0,
  };
}

function extractToolOutput(update) {
  const content = update.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      const text = item?.content?.text || item?.text;
      if (text) parts.push(text);
    }
    if (parts.length) return parts.join("\n");
  }
  const raw = update.rawOutput;
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  const nested =
    raw.FileContent?.content_concise ||
    raw.FileContent?.content ||
    raw.Content?.content ||
    raw.lines;
  if (typeof nested === "string") return nested;
  if (typeof nested === "number") return String(nested);
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return "";
  }
}

function foldUpdates(updates) {
  const messages = [];
  const last = () => messages[messages.length - 1];
  const ensureAssistant = () => {
    if (last()?.role !== "assistant") {
      messages.push({
        id: `a-${messages.length}`,
        role: "assistant",
        text: "",
        thought: "",
        tools: [],
        images: [],
      });
    }
    return last();
  };

  for (const update of updates) {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      const chunk = update.content?.text || "";
      const imgs = collectImages(update);
      if (last()?.role !== "user") {
        messages.push({ id: `u-${messages.length}`, role: "user", text: chunk, images: imgs });
      } else {
        last().text += chunk;
        if (imgs.length) last().images = [...(last().images || []), ...imgs];
      }
    } else if (kind === "agent_thought_chunk") {
      ensureAssistant().thought += update.content?.text || "";
    } else if (kind === "agent_message_chunk") {
      ensureAssistant().text += update.content?.text || "";
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const assistant = ensureAssistant();
      const id = update.toolCallId;
      if (!id) continue;
      let tool = assistant.tools.find((t) => t.id === id);
      if (!tool) {
        tool = {
          id,
          title: update.title || "工具",
          status: update.status || "pending",
          kind: update.kind || "",
          input: update.rawInput || null,
          output: "",
        };
        assistant.tools.push(tool);
      }
      if (update.title) tool.title = update.title;
      if (update.status) tool.status = update.status;
      if (update.kind) tool.kind = update.kind;
      if (update.rawInput) tool.input = update.rawInput;
      const textOut = stripImageJson(extractToolOutput(update));
      if (textOut) tool.output = textOut;
      const imgs = collectImages(update);
      if (imgs.length) {
        tool.images = [...(tool.images || []), ...imgs];
        assistant.images = [...(assistant.images || []), ...imgs];
      }
    }
  }

  return messages;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip a broken line
    }
  }
  return rows;
}

function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content) return extractText(content.content);
  }
  return "";
}

function visibleUserText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^This session is being continued from a previous conversation/i.test(raw)) return "";
  const queries = [];
  const re = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi;
  let match;
  while ((match = re.exec(raw))) {
    if (match[1].trim()) queries.push(match[1].trim());
  }
  if (queries.length) return cleanUserFacing(queries.join("\n\n"));
  if (
    /<(user_info|agent_rules|available_skills|system-reminder|system_reminder|work_policy)/i.test(
      raw
    )
  ) {
    return "";
  }
  return cleanUserFacing(raw);
}

function cleanUserFacing(text) {
  return String(text || "")
    .replace(/\[Image #\d+\]\s*\([^)]*\)/gi, "")
    .replace(/\(image-[^)]*local staged copy[^)]*\)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function findSessionImage(dir, name) {
  if (!dir || !name) return "";
  const base = path.basename(String(name).split(/[?#]/)[0].trim());
  if (!base) return "";
  for (const folder of ["assets", "images"]) {
    const file = path.join(dir, folder, base);
    if (fs.existsSync(file)) return file;
  }
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  return "";
}

function collectHistoryImages(text, dir) {
  const images = [];
  const seen = new Set();
  const push = (filePath) => {
    const resolved = findSessionImage(dir, filePath);
    if (!resolved || seen.has(resolved.toLowerCase())) return;
    seen.add(resolved.toLowerCase());
    images.push({ path: resolved, name: path.basename(resolved) });
  };
  const raw = String(text || "");
  for (const match of raw.matchAll(/\[Image #\d+\]\s*\(([^)\s]+)/gi)) {
    push(match[1]);
  }
  for (const match of raw.matchAll(/^\s*\d+\.\s+(.+\.(?:png|jpe?g|gif|webp|bmp))\s*$/gim)) {
    push(match[1].trim());
  }
  for (const match of raw.matchAll(/([A-Za-z]:\\[^\s<>"]+\.(?:png|jpe?g|gif|webp|bmp))/gi)) {
    push(match[1]);
  }
  return images;
}

function collectContentImages(content, dir) {
  const images = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (node.type === "image") {
      const filePath = node.path || node.uri || node.url || "";
      const resolved = findSessionImage(dir, filePath);
      const key = resolved || node.data?.slice(0, 48) || "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      if (resolved) images.push({ path: resolved, name: path.basename(resolved) });
      else if (node.data) {
        const mime = node.mimeType || node.mime || "image/png";
        images.push({ mime, data: node.data, src: `data:${mime};base64,${node.data}` });
      }
    }
    if (node.content) walk(node.content);
  };
  walk(content);
  return images;
}

function messageFingerprint(msg) {
  if (msg?.role === "user") {
    const text = normText(msg.text);
    if (text) return `u:${text.slice(0, 240)}`;
    const imgs = (msg.images || []).map((item) => item.path || item.name || "").join("|");
    return imgs ? `uimg:${imgs}` : "";
  }
  if (msg?.role === "assistant") {
    const text = normText(msg.text);
    return text ? `a:${text.slice(0, 180)}` : "";
  }
  return "";
}

function pushUniqueMessage(list, msg) {
  const fp = messageFingerprint(msg);
  if (fp && list.some((item) => messageFingerprint(item) === fp)) return;
  list.push({
    ...msg,
    id: `${msg.role === "user" ? "u" : "a"}-${list.length}`,
  });
}

function listSegmentFiles(dir) {
  const folder = path.join(dir, "compaction");
  if (!fs.existsSync(folder)) return [];
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^segment_\d+\.md$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(folder, name));
}

function parseMarkdownTools(body) {
  const tools = [];
  const re =
    /\[tool_request:\s*([^\]]+)\]\s*([\s\S]*?)(?=\n\[tool_request:|\n\[backend |\n\[tool_response\]|$)/g;
  let match;
  let index = 0;
  while ((match = re.exec(body))) {
    const name = match[1].trim();
    const input = {};
    for (const line of String(match[2] || "").split(/\n/)) {
      const kv = line.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/);
      if (kv) input[kv[1]] = kv[2];
    }
    index += 1;
    tools.push({
      id: `seg-${index}-${name}`,
      title: toolTitleFromCall(name, input),
      status: "completed",
      kind: name,
      input,
      output: "",
    });
  }
  return tools;
}

function foldSegmentMarkdown(md, dir) {
  const messages = [];
  const header = /^### Turn \d+ \((Human|Assistant|Function|System)\)\s*$/gm;
  const hits = [];
  let match;
  while ((match = header.exec(md))) {
    hits.push({ role: match[1], start: match.index + match[0].length, at: match.index });
  }
  const last = () => messages[messages.length - 1];
  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].at : md.length;
    const body = md.slice(hits[i].start, end).trim();
    const role = hits[i].role;
    if (role === "System") continue;
    if (role === "Human") {
      const text = visibleUserText(body);
      const images = collectHistoryImages(body, dir);
      if (!text && !images.length) continue;
      messages.push({
        id: `u-${messages.length}`,
        role: "user",
        text,
        images,
      });
      continue;
    }
    if (role === "Assistant") {
      const tools = parseMarkdownTools(body);
      let text = body;
      const cut = body.search(/\n\[tool_request:|\n\[backend |\n\[tool_response\]/);
      if (cut >= 0) text = body.slice(0, cut);
      if (/^\[(tool_request:|backend )/i.test(text.trim())) text = "";
      text = text.replace(/\[tool_request:[^\]]+\][\s\S]*$/g, "").trim();
      if (!text && !tools.length) continue;
      const prev = last();
      if (prev?.role === "assistant") {
        if (text) prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
        if (tools.length) prev.tools = [...(prev.tools || []), ...tools];
      } else {
        messages.push({
          id: `a-${messages.length}`,
          role: "assistant",
          text,
          thought: "",
          tools,
          images: [],
        });
      }
      continue;
    }
    if (role === "Function") {
      const out = body.replace(/^\[tool_response\]\s*/i, "").slice(0, 1500);
      for (let j = messages.length - 1; j >= 0; j -= 1) {
        const tools = messages[j].tools || [];
        const tool = [...tools].reverse().find((item) => !item.output);
        if (tool) {
          tool.output = out;
          tool.status = "completed";
          break;
        }
      }
    }
  }
  return messages;
}

function foldCompaction(dir) {
  const messages = [];
  for (const file of listSegmentFiles(dir)) {
    let md = "";
    try {
      md = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const msg of foldSegmentMarkdown(md, dir)) pushUniqueMessage(messages, msg);
  }
  return messages;
}

function parseToolArgs(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { command: String(raw) };
  }
}

function toolTitleFromCall(name, input) {
  const file =
    input?.target_file || input?.file_path || input?.path || input?.target_directory || "";
  if (name === "read_file") return file ? `Read \`${file}\`` : "Read";
  if (name === "list_dir") return file ? `List \`${file}\`` : "List";
  if (name === "grep") return input?.pattern ? `Grep \`${input.pattern}\`` : "Grep";
  if (name === "write") return file ? `Write \`${file}\`` : "Write";
  if (name === "search_replace") return file ? `Edit \`${file}\`` : "Edit";
  if (name === "run_terminal_command") {
    const cmd = String(input?.command || "").replace(/\s+/g, " ").trim();
    return cmd ? cmd.slice(0, 88) : "Command";
  }
  if (name === "todo_write") return "Todo";
  return name || "工具";
}

function foldChatHistory(rows, dir) {
  const messages = [];
  let pendingThought = "";
  const last = () => messages[messages.length - 1];

  for (const row of rows) {
    const kind = row?.type;
    if (!kind || kind === "system" || kind === "backend_tool_call") continue;
    if (kind === "tool_result") {
      const out = extractText(row.content).slice(0, 4000);
      const id = row.tool_call_id;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const tool = (messages[i].tools || []).find((item) => item.id === id);
        if (tool) {
          tool.output = out;
          tool.status = "completed";
          break;
        }
      }
      continue;
    }
    if (kind === "reasoning") {
      const bits = Array.isArray(row.summary)
        ? row.summary.map((item) => item?.text || "").filter(Boolean)
        : [];
      if (bits.length) pendingThought += bits.join("\n");
      continue;
    }
    if (kind === "user") {
      if (row.synthetic_reason === "compaction_meta" || row.synthetic_reason === "system_reminder") {
        continue;
      }
      const raw = extractText(row.content);
      const text = visibleUserText(raw);
      const images = [
        ...collectContentImages(row.content, dir),
        ...collectHistoryImages(raw, dir),
      ];
      if (!text && !images.length) continue;
      messages.push({
        id: `u-${messages.length}`,
        role: "user",
        text,
        images,
      });
      continue;
    }
    if (kind === "assistant") {
      const text = extractText(row.content).trim();
      const tools = (row.tool_calls || []).map((call) => {
        const input = parseToolArgs(call.arguments);
        return {
          id: call.id,
          title: toolTitleFromCall(call.name, input),
          status: "completed",
          kind: call.name || "",
          input,
          output: "",
        };
      });
      if (!text && !tools.length) continue;
      const prev = last();
      if (prev?.role === "assistant") {
        if (text) prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
        if (tools.length) prev.tools = [...(prev.tools || []), ...tools];
        if (pendingThought) {
          prev.thought = prev.thought ? `${prev.thought}\n${pendingThought}` : pendingThought;
        }
      } else {
        messages.push({
          id: `a-${messages.length}`,
          role: "assistant",
          text,
          thought: pendingThought,
          tools,
          images: [],
        });
      }
      pendingThought = "";
    }
  }
  return messages;
}

const TURNS_FILE = "halora-turns.jsonl";

function parseTime(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : value;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function previewKey(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function readEventDurations(dir) {
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return { durations: [], open: false };
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { durations: [], open: false };
  }
  const durations = [];
  let open = 0;
  for (const line of raw.split(/\n/)) {
    if (!line.includes("turn_started") && !line.includes("turn_ended")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTime(row.ts);
    if (!ts) continue;
    if (row.type === "turn_started") {
      if (open) durations.push(Math.max(0, ts - open));
      open = ts;
    } else if (row.type === "turn_ended" && open) {
      durations.push(Math.max(0, ts - open));
      open = 0;
    }
  }
  return { durations, open: Boolean(open) };
}

function readRecordedDurations(dir) {
  const file = path.join(dir, TURNS_FILE);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const row of readJsonl(file)) {
    const durationMs = Number(row?.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    rows.push({
      durationMs: Math.round(durationMs),
      startedAt: Number(row.startedAt) || 0,
      endedAt: Number(row.endedAt) || 0,
      user: previewKey(row.user),
    });
  }
  return rows;
}

function applyDuration(message, rec) {
  if (!message || !rec) return;
  const ms = Number(rec.durationMs);
  if (!Number.isFinite(ms) || ms < 0) return;
  message.durationMs = Math.round(ms);
  if (rec.startedAt) message.startedAt = rec.startedAt;
  if (rec.endedAt) message.endedAt = rec.endedAt;
}

function userMatches(message, key) {
  if (!key) return false;
  const text = previewKey(message?.text);
  if (!text) return false;
  return text.startsWith(key) || key.startsWith(text) || text.includes(key);
}

function attachTurnDurations(messages, dir) {
  if (!messages?.length || !dir) return messages;
  const recorded = readRecordedDurations(dir);
  const { durations: inferred, open } = readEventDurations(dir);
  if (!recorded.length && !inferred.length) return messages;

  const used = new Set();
  if (recorded.length) {
    let cursor = 0;
    for (const rec of recorded) {
      let found = -1;
      if (rec.user) {
        for (let i = cursor; i < messages.length; i += 1) {
          if (messages[i].role === "user" && userMatches(messages[i], rec.user)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) continue;
      cursor = found + 1;
      for (let j = found + 1; j < messages.length; j += 1) {
        if (messages[j].role === "assistant") {
          applyDuration(messages[j], rec);
          used.add(j);
          break;
        }
      }
    }
    if (!used.size) {
      let ri = recorded.length - 1;
      for (let i = messages.length - 1; i >= 0 && ri >= 0; i -= 1) {
        if (messages[i].role !== "assistant") continue;
        applyDuration(messages[i], recorded[ri]);
        used.add(i);
        ri -= 1;
      }
    }
  }

  const targets = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === "assistant" && messages[i].durationMs == null) targets.push(i);
  }
  if (open && messages[messages.length - 1]?.role === "assistant" && targets.length) {
    targets.pop();
  }
  let di = inferred.length - 1 - used.size;
  for (let t = targets.length - 1; t >= 0 && di >= 0; t -= 1, di -= 1) {
    applyDuration(messages[targets[t]], { durationMs: inferred[di] });
  }
  return messages;
}

function recordTurnDuration(cwd, sessionId, turn) {
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return false;
  const ms = Number(turn?.durationMs);
  if (!Number.isFinite(ms) || ms < 0) return false;
  const row = {
    startedAt: Number(turn.startedAt) || 0,
    endedAt: Number(turn.endedAt) || Date.now(),
    durationMs: Math.round(ms),
    user: previewKey(turn.user),
  };
  try {
    fs.appendFileSync(path.join(dir, TURNS_FILE), `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

function readTranscript(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return [];
  const messages = foldCompaction(dir);
  const historyFile = path.join(dir, "chat_history.jsonl");
  if (fs.existsSync(historyFile)) {
    for (const msg of foldChatHistory(readJsonl(historyFile), dir)) {
      pushUniqueMessage(messages, msg);
    }
    return attachTurnDurations(messages, dir);
  }
  if (messages.length) return attachTurnDurations(messages, dir);
  const file = path.join(dir, "updates.jsonl");
  if (!fs.existsSync(file)) return [];
  const updates = [];
  for (const row of readJsonl(file)) {
    const update = row.params?.update || row.update;
    if (!update) continue;
    const kind = update.sessionUpdate;
    if (
      kind === "user_message_chunk" ||
      kind === "agent_message_chunk" ||
      kind === "agent_thought_chunk" ||
      kind === "tool_call" ||
      kind === "tool_call_update"
    ) {
      updates.push(update);
    }
  }
  return attachTurnDurations(foldUpdates(updates), dir);
}

function renameSession(cwd, sessionId, title) {
  const name = String(title || "").trim();
  if (!name) throw new Error("名字不能为空");
  const dir = sessionDir(cwd, sessionId);
  if (!dir) throw new Error("找不到这次对话");
  const file = path.join(dir, "summary.json");
  const summary = readSummary(file);
  if (!summary) throw new Error("找不到这次对话");
  summary.user_title = name;
  summary.generated_title = name;
  summary.title_is_manual = true;
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return name;
}

function setAutoTitle(cwd, sessionId, title) {
  const name = shortenTitle(title);
  if (!name) return false;
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return false;
  const file = path.join(dir, "summary.json");
  const summary = readSummary(file);
  if (!summary) return false;
  if (summary.title_is_manual || summary.user_title) return false;
  if (summary.generated_title || summary.auto_title) return false;
  summary.auto_title = name;
  try {
    fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  listSessionsForCwd,
  listProjects,
  readTranscript,
  foldUpdates,
  renameSession,
  deleteSession,
  setAutoTitle,
  sessionDir,
  sessionGroupDirs,
  sessionsRoot,
  shortenTitle,
  readContext,
  samePath,
  canonicalCwd,
  lookupOrder,
  recordTurnDuration,
  attachTurnDurations,
  readEventDurations,
};
