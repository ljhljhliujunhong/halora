const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

module.exports = { searchFiles, resolveMentions, collectMentions };
