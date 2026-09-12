const FILE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "heic", "tif", "tiff",
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "webm", "mov", "avi", "mkv", "m4v",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "rtf",
  "txt", "md", "markdown", "log", "json", "jsonl", "toml", "yaml", "yml", "xml", "html", "htm",
  "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "lua", "sql", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "zip", "7z", "rar", "tar", "gz", "tgz",
  "exe", "dll", "so", "dylib", "wasm",
  "lock", "map", "env", "ini", "conf", "cfg",
  "ttf", "otf", "woff", "woff2",
  "psd", "ai", "fig", "blend", "fbx", "obj", "gltf", "glb",
  "ipynb", "tex",
]);

function extOf(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return match ? match[1].toLowerCase() : "";
}

function looksLikeFile(text) {
  const raw = String(text || "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "");
  if (!raw || raw.length > 400) return "";
  if (/^(https?:|mailto:|data:|#)/i.test(raw)) return "";
  if (raw.includes("@")) return "";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return raw;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (FILE_EXTS.has(extOf(raw))) return raw;
  return "";
}

function extractFileHint(text) {
  const raw = String(text || "").trim();
  const direct = looksLikeFile(raw);
  if (direct) return direct;
  const tick = /`([^`]+)`/.exec(raw);
  if (tick) return looksLikeFile(tick[1]);
  return "";
}

export { looksLikeFile, extractFileHint, FILE_EXTS };
