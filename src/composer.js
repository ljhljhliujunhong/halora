const COMMAND_TITLES = {
  compact: "压缩对话",
  "always-approve": "始终允许",
  context: "上下文",
  "session-info": "会话信息",
  "deep-research": "深度调研",
  workflow: "工作流",
  goal: "目标",
  plan: "规划",
  imagine: "生图",
  "imagine-video": "生成视频",
  usage: "用量",
  effort: "思考力度",
  feedback: "反馈",
  new: "新对话",
  rename: "改名",
  rewind: "回到上一步",
  remember: "记一笔",
};

const LOCAL_COMMANDS = [
  { name: "new", aliases: ["clear"], title: "新对话", local: "new", kind: "cmd" },
  { name: "rename", aliases: ["title"], title: "改名", local: "rename", hint: "新名字", kind: "cmd" },
  { name: "compact", title: "压缩对话", hint: "要保留的内容", kind: "cmd" },
  { name: "context", title: "上下文", local: "context", kind: "cmd" },
  { name: "session-info", aliases: ["status", "info"], title: "会话信息", local: "context", kind: "cmd" },
  { name: "plan", title: "规划", kind: "cmd" },
  { name: "effort", title: "思考力度", hint: "low|medium|high", kind: "cmd" },
  { name: "always-approve", title: "始终允许", kind: "cmd" },
  { name: "imagine", title: "生图", hint: "画面描述", kind: "cmd" },
  { name: "usage", title: "用量", kind: "cmd" },
  { name: "rewind", aliases: ["undo"], title: "回到上一步", kind: "cmd" },
];

export function mergeCommands(fromAgent, fromSkills) {
  const map = new Map();
  for (const item of LOCAL_COMMANDS) map.set(item.name, { ...item });
  for (const item of fromAgent || []) {
    if (!item?.name) continue;
    const prev = map.get(item.name) || { name: item.name, kind: "cmd" };
    map.set(item.name, {
      ...prev,
      name: item.name,
      kind: prev.kind || "cmd",
      title: COMMAND_TITLES[item.name] || prev.title || item.name,
      hint: item.hint || item.input?.hint || prev.hint || "",
      description: item.description || prev.description || "",
    });
  }
  for (const item of fromSkills || []) {
    if (!item?.name || map.has(item.name)) continue;
    map.set(item.name, {
      name: item.name,
      kind: "skill",
      title: item.title || item.name,
      hint: item.hint || "",
      description: item.description || "",
      source: item.source || "",
    });
  }
  const cmds = [];
  const skills = [];
  for (const item of map.values()) {
    const next = {
      ...item,
      title: COMMAND_TITLES[item.name] || item.title || item.name,
    };
    if (next.kind === "skill") skills.push(next);
    else cmds.push(next);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return [...cmds, ...skills];
}

export function filterCommands(list, query) {
  const q = String(query || "").toLowerCase().replace(/^\//, "");
  const hits = list.filter((item) => {
    if (!q) return true;
    const name = item.name.toLowerCase();
    if (name.startsWith(q) || name.includes(q)) return true;
    if ((item.aliases || []).some((alias) => alias.toLowerCase().startsWith(q))) return true;
    if ((item.title || "").toLowerCase().includes(q)) return true;
    if ((item.description || "").toLowerCase().includes(q)) return true;
    return false;
  });
  if (!q) return hits;
  hits.sort((a, b) => {
    const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (as !== bs) return as - bs;
    return a.name.localeCompare(b.name);
  });
  return hits;
}

export function slashQuery(text) {
  const first = String(text || "").split(/\n/, 1)[0];
  const match = first.match(/^\/(\S*)$/);
  if (!match) return null;
  return match[1];
}

export function parseSlash(text) {
  const match = String(text || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], rest: (match[2] || "").trim() };
}

export function findCommand(list, name) {
  const q = String(name || "").toLowerCase();
  if (!q) return null;
  return (
    (list || []).find((item) => {
      if (item.name.toLowerCase() === q) return true;
      return (item.aliases || []).some((alias) => String(alias).toLowerCase() === q);
    }) || null
  );
}

export function compactHint(text) {
  const parsed = parseSlash(text);
  if (!parsed || parsed.name.toLowerCase() !== "compact") return null;
  return parsed.rest;
}

export function mentionAt(text, caret) {
  const before = String(text || "").slice(0, caret ?? String(text || "").length);
  const match = before.match(/(^|[\s])(@!?)([^\s]*)$/);
  if (!match) return null;
  return {
    hidden: match[2] === "@!",
    query: match[3],
    start: before.length - match[2].length - match[3].length,
    prefix: match[2],
  };
}

export function collectMentions(text) {
  const out = [];
  const re = /@!?([^\s]+)/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const rel = match[1].replace(/:[0-9]+(-[0-9]+)?$/, "");
    if (rel) out.push(rel);
  }
  return out;
}

export function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function formatCount(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "";
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分钟`);
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return `用时 ${parts.join(" ")}`;
}
