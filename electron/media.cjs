const fs = require("node:fs");
const path = require("node:path");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_BYTES = 20 * 1024 * 1024;

function extFromMime(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  return ".png";
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function isImagePath(filePath) {
  return IMAGE_EXT.has(path.extname(String(filePath || "")).toLowerCase());
}

function fileToImage(filePath) {
  const resolved = path.resolve(filePath);
  if (!isImagePath(resolved) || !fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const mime = mimeFromPath(resolved);
  const data = fs.readFileSync(resolved).toString("base64");
  return {
    name: path.basename(resolved),
    mime,
    data,
    path: resolved,
    src: `data:${mime};base64,${data}`,
  };
}

function toDataUrl(filePath) {
  const img = fileToImage(filePath);
  return img?.src || "";
}

function collectImages(update) {
  const images = [];
  const seen = new Set();

  const push = (img) => {
    if (!img) return;
    const key = img.path || img.src || (img.data ? img.data.slice(0, 48) : "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    images.push(img);
  };

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (node.type === "image") {
      if (node.data) {
        const mime = node.mimeType || node.mime || "image/png";
        push({ mime, data: node.data, src: `data:${mime};base64,${node.data}` });
      }
      if (typeof node.url === "string") {
        if (node.url.startsWith("data:")) push({ src: node.url });
        else if (isImagePath(node.url)) push({ path: node.url });
      }
      if (node.uri && isImagePath(node.uri)) push({ path: node.uri });
    }
    if (node.content) walk(node.content);
  };

  walk(update.content);

  const raw = update.rawOutput;
  if (raw && typeof raw === "object") {
    if (raw.type === "ImageGen" && raw.path) {
      push({ path: raw.path, name: raw.filename || path.basename(raw.path) });
    }
    if (typeof raw.path === "string" && isImagePath(raw.path)) {
      push({ path: raw.path, name: raw.filename || path.basename(raw.path) });
    }
  }

  const textBits = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const text = item?.content?.text || item?.text;
      if (text) textBits.push(text);
    }
  }
  for (const text of textBits) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.path && isImagePath(parsed.path)) {
        push({ path: parsed.path, name: parsed.filename || path.basename(parsed.path) });
      }
    } catch {
      // not json
    }
  }

  return images;
}

function stripImageJson(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed?.path && parsed?.filename) return "";
  } catch {
    // keep
  }
  return text;
}

module.exports = {
  extFromMime,
  mimeFromPath,
  isImagePath,
  fileToImage,
  toDataUrl,
  collectImages,
  stripImageJson,
  MAX_BYTES,
};
