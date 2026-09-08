const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findGrokBinary() {
  const candidates = [
    process.env.GROK_BINARY,
    path.join(os.homedir(), ".grok", "bin", "grok.exe"),
    path.join(os.homedir(), ".grok", "bin", "grok"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const exe = path.join(dir, process.platform === "win32" ? "grok.exe" : "grok");
    if (fs.existsSync(exe)) return exe;
  }

  return null;
}

function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

module.exports = { findGrokBinary, grokHome };
