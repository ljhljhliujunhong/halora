const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const { fileToImage } = require("./media.cjs");

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  "Agent缓存文件",
]);

function gitFiles(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "ls-files"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

function walk(dir, root, out, hidden, limit) {
  if (out.length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const name = entry.name;
    if (!hidden && name.startsWith(".")) continue;
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      walk(full, root, out, hidden, limit);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function score(query, rel) {
  const q = query.toLowerCase();
  const p = rel.toLowerCase();
  const base = path.posix.basename(p);
  if (!q) return 1;
  if (base === q) return 100;
  if (base.startsWith(q)) return 80;
  if (p.startsWith(q)) return 70;
  if (base.includes(q)) return 50;
  if (p.includes(q)) return 30;
  let i = 0;
  for (const ch of p) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 10;
  }
  return 0;
}

function searchFiles(cwd, query = "", { hidden = false } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const q = String(query || "").replace(/^!/, "");
  let files = gitFiles(cwd);
  if (!files) {
    files = [];
    walk(cwd, cwd, files, hidden, 2500);
  } else if (hidden) {
    const extra = [];
    walk(cwd, cwd, extra, true, 800);
    const seen = new Set(files.map((item) => item.replace(/\\/g, "/")));
    for (const item of extra) {
      if (!seen.has(item)) files.push(item);
    }
  }
  const ranked = [];
  for (const rel of files) {
    const normalized = rel.replace(/\\/g, "/");
    const s = score(q, normalized);
    if (s <= 0) continue;
    ranked.push({ path: normalized, name: path.posix.basename(normalized), score: s });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranked.slice(0, 24);
}

function collectMentions(text) {
  const out = [];
  const re = /@!?([^\s]+)/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const rel = match[1].replace(/:[0-9]+(-[0-9]+)?$/, "");
    if (rel) out.push(rel);
  }
  return out;
}

function resolveMentions(cwd, rels) {
  if (!cwd) return [];
  const out = [];
  const seen = new Set();
  for (const rel of rels || []) {
    const clean = String(rel || "").replace(/:[0-9]+(-[0-9]+)?$/, "");
    if (!clean) continue;
    const abs = path.resolve(cwd, clean);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    seen.add(key);
    out.push({ name: clean.replace(/\\/g, "/"), path: abs });
  }
  return out;
}

function classifyDroppedPath(filePath) {
  if (!filePath) return null;
  let resolved = "";
  try {
    resolved = path.resolve(String(filePath));
  } catch {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  const name = path.basename(resolved);
  const idBase = resolved.toLowerCase();
  if (stat.isDirectory()) {
    return { kind: "folder", name, path: resolved, id: `folder:${idBase}` };
  }
  if (!stat.isFile()) return null;
  const img = fileToImage(resolved);
  if (img) return { kind: "image", ...img, id: `image:${idBase}` };
  return { kind: "file", name, path: resolved, id: `file:${idBase}` };
}

function stripResourceHint(raw) {
  let value = String(raw || "").trim();
  value = value.replace(/^['"`]+|['"`]+$/g, "");
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      value = value.replace(/^file:\/\//i, "");
    }
  }
  return value.replace(/[?#].*$/, "").trim();
}

function findByBasename(root, base, limit = 5000) {
  const target = String(base || "").toLowerCase();
  if (!root || !target) return null;
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === target) return full;
    }
  }
  return null;
}

function locateResource(cwd, hint) {
  const raw = stripResourceHint(hint);
  if (!raw || raw.length > 500) return null;
  const candidates = [];
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    candidates.push(raw);
  }
  if (cwd) candidates.push(path.resolve(cwd, raw));
  for (const item of candidates) {
    try {
      if (item && fs.existsSync(item)) return path.resolve(item);
    } catch {
      // skip a malformed path
    }
  }
  if (!cwd) return null;
  const base = path.basename(raw);
  if (!base || base === "." || base === "..") return null;
  const hits = searchFiles(cwd, base, { hidden: true });
  const exact = hits.find((item) => String(item.name || "").toLowerCase() === base.toLowerCase());
  if (exact?.path) return path.resolve(cwd, exact.path);
  return findByBasename(cwd, base);
}

function classifyDroppedPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const item of paths || []) {
    const next = classifyDroppedPath(item);
    if (!next?.path) continue;
    const key = String(next.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out.slice(0, 16);
}

module.exports = {
  searchFiles,
  resolveMentions,
  collectMentions,
  classifyDroppedPath,
  classifyDroppedPaths,
  locateResource,
  stripResourceHint,
};
