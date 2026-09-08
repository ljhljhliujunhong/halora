const fs = require("node:fs");
const path = require("node:path");
const { grokHome } = require("./grok-path.cjs");

function userSkillsRoot() {
  return path.join(grokHome(), "skills");
}

function insideDir(child, parent) {
  const a = path.resolve(child).replace(/[\\/]+$/, "").toLowerCase();
  const b = path.resolve(parent).replace(/[\\/]+$/, "").toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

function parseFrontmatter(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "", hint: "", invocable: true };
  const body = match[1];
  const get = (key) => {
    const block = body.match(
      new RegExp(`^${key}:\\s*[>|]-?\\s*\\n([\\s\\S]*?)(?=\\n[\\w-]+:|$)`, "m")
    );
    if (block) {
      return block[1]
        .split(/\n/)
        .map((line) => line.replace(/^\s{2,}/, "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/^["']|["']$/g, "");
    }
    const line = body.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!line) return "";
    const value = line[1].trim();
    if (value === "|" || value === ">" || value === ">-" || value === "|-") return "";
    return value.replace(/^["']|["']$/g, "");
  };
  const invocable = !/^\s*user-invocable:\s*false\s*$/m.test(body);
  const short = get("short-description") || "";
  const nested = body.match(/short-description:\s*["']?([^"'\n]+)/);
  return {
    name: get("name"),
    description: get("description") || (nested ? nested[1] : "") || short,
    hint: get("argument-hint"),
    invocable,
  };
}

function prettyLabel(name, metaName) {
  const raw = String(metaName || name || "").trim();
  if (!raw) return "Skill";
  if (/[^\u0000-\u007F]/.test(raw)) return raw;
  return raw.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function safeSkillName(value) {
  const name = String(value || "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name || name.length > 64) return "";
  return name;
}

function addSkill(file, source, out, seen) {
  if (!file.endsWith("SKILL.md") && !file.endsWith("skill.md")) return;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const meta = parseFrontmatter(raw);
  if (!meta.invocable) return;
  const dir = path.dirname(file);
  const dirName = path.basename(dir);
  if (dirName === "shared") return;
  const name = safeSkillName(meta.name || dirName);
  if (!name || seen.has(name)) return;
  seen.add(name);
  const description = String(meta.description || "")
    .replace(/\s+/g, " ")
    .trim();
  out.push({
    name,
    title: description.slice(0, 48) || name,
    label: prettyLabel(name, meta.name),
    description,
    hint: meta.hint || "",
    kind: "skill",
    source,
    dir,
    removable: source === "user" && insideDir(dir, userSkillsRoot()),
  });
}

function walk(dir, source, out, seen, depth) {
  if (depth > 5 || !fs.existsSync(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const skillFile = entries.find((item) => item.isFile() && /^skill\.md$/i.test(item.name));
  if (skillFile) addSkill(path.join(dir, skillFile.name), source, out, seen);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "shared" || entry.name === ".git") continue;
    walk(path.join(dir, entry.name), source, out, seen, depth + 1);
  }
}

function walkCommands(dir, source, out, seen) {
  if (!fs.existsSync(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const stem = name.replace(/\.md$/i, "").toLowerCase();
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    out.push({
      name: stem,
      title: stem,
      label: prettyLabel(stem),
      description: "",
      hint: "",
      kind: "skill",
      source,
    });
  }
}

function listSkills(cwd) {
  const home = grokHome();
  const out = [];
  const seen = new Set();
  const roots = [
    [cwd && path.join(cwd, ".grok", "skills"), "local"],
    [cwd && path.join(cwd, ".agents", "skills"), "local"],
    [cwd && path.join(cwd, ".claude", "skills"), "local"],
    [path.join(home, "skills"), "user"],
    [path.join(home, "bundled", "skills"), "bundled"],
  ];
  for (const [dir, source] of roots) {
    if (dir) walk(dir, source, out, seen, 0);
  }
  walkCommands(cwd && path.join(cwd, ".grok", "commands"), "local", out, seen);
  walkCommands(path.join(home, "commands"), "user", out, seen);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function listSkillLibrary(cwd) {
  return listSkills(cwd).filter((item) => item.dir);
}

function skillFileIn(dir) {
  const upper = path.join(dir, "SKILL.md");
  const lower = path.join(dir, "skill.md");
  if (fs.existsSync(upper)) return upper;
  if (fs.existsSync(lower)) return lower;
  return "";
}

function findSkillDirs(root) {
  const start = path.resolve(root);
  if (!fs.existsSync(start)) return [];
  if (skillFileIn(start)) return [start];
  let entries = [];
  try {
    entries = fs.readdirSync(start, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const next = path.join(start, entry.name);
    if (skillFileIn(next)) dirs.push(next);
  }
  return dirs;
}

function skillNameFromDir(dir) {
  const file = skillFileIn(dir);
  let metaName = "";
  if (file) {
    try {
      metaName = parseFrontmatter(fs.readFileSync(file, "utf8")).name;
    } catch {
      metaName = "";
    }
  }
  return safeSkillName(metaName || path.basename(dir));
}

function copySkill(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const base = path.basename(from);
      return base !== "node_modules" && base !== ".git";
    },
  });
}

function importSkillsFrom(from, { replace } = {}) {
  const dirs = findSkillDirs(from);
  if (!dirs.length) return { imported: [], exists: [], error: "这里没有技能" };
  const imported = [];
  const exists = [];
  const home = userSkillsRoot();
  for (const dir of dirs) {
    const name = skillNameFromDir(dir);
    if (!name) continue;
    const dest = path.join(home, name);
    if (insideDir(dir, dest) && insideDir(dest, dir)) {
      imported.push(name);
      continue;
    }
    if (fs.existsSync(dest) && !replace) {
      exists.push(name);
      continue;
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copySkill(dir, dest);
    imported.push(name);
  }
  return { imported, exists };
}

function removeUserSkill(target) {
  const dest = path.resolve(String(target || ""));
  const root = path.resolve(userSkillsRoot());
  if (!insideDir(dest, root) || dest === root) {
    throw new Error("只能去掉个人技能");
  }
  if (!fs.existsSync(dest)) throw new Error("找不到这个技能");
  fs.rmSync(dest, { recursive: true, force: true });
  return dest;
}

function listWorkflows(cwd) {
  const names = [];
  const dirs = [
    path.join(grokHome(), "bundled", "workflows"),
    path.join(grokHome(), "workflows"),
    cwd && path.join(cwd, ".grok", "workflows"),
  ].filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".rhai")) names.push(name.replace(/\.rhai$/i, ""));
    }
  }
  return [...new Set(names)];
}

module.exports = {
  listSkills,
  listSkillLibrary,
  listWorkflows,
  importSkillsFrom,
  removeUserSkill,
};
