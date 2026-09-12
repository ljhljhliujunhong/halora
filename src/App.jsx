import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown.js";
import { applyUpdate } from "./transcript.js";
import {
  collectMentions,
  compactHint,
  filterCommands,
  findCommand,
  formatCount,
  formatDuration,
  formatTokens,
  mentionAt,
  mergeCommands,
  parseSlash,
  slashQuery,
} from "./composer.js";
import { looksLikeFile, extractFileHint } from "./resource-hint.mjs";
import brandIcon from "./brand.png";
import { Workbench } from './Workbench.jsx';

const api = window.workshop;
function storedComposer() {
  try { return JSON.parse(localStorage.getItem('halora.composer') || '{}'); } catch { return {}; }
}
function brandStorage(suffix) {
  const key = `halora.${suffix}`;
  if (localStorage.getItem(key) != null) return localStorage.getItem(key);
  for (const old of Object.keys(localStorage)) {
    if (old !== key && old.endsWith(`.${suffix}`)) {
      const value = localStorage.getItem(old);
      localStorage.setItem(key, value); localStorage.removeItem(old);
      return value;
    }
  }
  return null;
}
const PreviewContext = createContext(null);

function usePreview() {
  return useContext(PreviewContext);
}

function folderName(cwd) {
  if (!cwd) return "";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

function projectKey(cwd) {
  return String(cwd || "").replace(/\\/g, "/").toLowerCase();
}

function sameFolder(a, b) {
  return projectKey(a) === projectKey(b);
}

function placeKeys(keys, fromKey, overKey, edge) {
  if (!fromKey || !overKey) return null;
  const from = keys.indexOf(fromKey);
  let insert = keys.indexOf(overKey);
  if (from < 0 || insert < 0) return null;
  if (edge === "after") insert += 1;
  const next = keys.filter((key) => key !== fromKey);
  if (from < insert) insert -= 1;
  insert = Math.max(0, Math.min(next.length, insert));
  next.splice(insert, 0, fromKey);
  if (next.length === keys.length && next.every((key, index) => key === keys[index])) return null;
  return next;
}

function readOpenProjects() {
  try {
    const rows = JSON.parse(brandStorage('projectsOpen') || "[]");
    return new Set(Array.isArray(rows) ? rows.map(projectKey) : []);
  } catch {
    return new Set();
  }
}

function writeOpenProjects(open) {
  try {
    localStorage.setItem("halora.projectsOpen", JSON.stringify([...open]));
  } catch {
    // ignore
  }
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function optionLabel(option) {
  const kind = String(option.kind || "").toLowerCase();
  if (kind.includes("allow_once") || option.name === "Allow once") return "允许一次";
  if (kind.includes("allow_always") || option.name === "Allow always") return "始终允许";
  if (kind.includes("reject_once") || option.name === "Reject once") return "拒绝";
  if (kind.includes("reject_always") || option.name === "Reject always") return "始终拒绝";
  return option.name || "确定";
}

function optionTone(option) {
  const kind = String(option.kind || option.name || "").toLowerCase();
  if (kind.includes("reject") || kind.includes("deny")) return "ghost";
  if (kind.includes("always")) return "gold";
  return "primary";
}

function toolStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "完成";
  if (value === "failed" || value === "error") return "失败";
  return "进行中";
}

function friendlyError(err) {
  const raw = String(err?.message || err || "");
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/i, "") || "出了点问题";
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(filePath || "").split(/[?#]/)[0]);
}

function resolveLocalPath(filePath, cwd) {
  const raw = String(filePath || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return raw;
  if (!cwd) return raw;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${String(cwd).replace(/[\\/]+$/, "")}${sep}${raw.replace(/^[\\/]+/, "")}`;
}

function resourceHintFromEvent(event) {
  const root = event.currentTarget;
  const target = event.target;
  if (!target || !root?.contains(target)) return "";
  const node = target.closest?.("img, a[href], code, .file-pill, .chip, .chat-img");
  if (!node || !root.contains(node)) return "";
  if (node.matches("img, .chat-img")) {
    const stored = String(node.getAttribute("data-path") || "").trim();
    if (stored) return stored;
    return looksLikeFile(node.getAttribute("alt")) || looksLikeFile(node.getAttribute("title")) || "";
  }
  if (node.matches(".file-pill, .chip")) {
    const stored = String(node.getAttribute("data-path") || "").trim();
    if (stored) return stored;
    return extractFileHint(node.textContent);
  }
  if (node.matches("a[href]")) {
    const href = node.getAttribute("href") || "";
    if (/^file:/i.test(href)) return href;
    return looksLikeFile(href) || extractFileHint(node.textContent);
  }
  if (node.matches("code") && !node.closest("pre")) return extractFileHint(node.textContent);
  return "";
}

function ChatImage({ image, cwd }) {
  const openPreview = usePreview();
  const [src, setSrc] = useState(image.src || "");
  useEffect(() => {
    if (image.src) {
      setSrc(image.src);
      return;
    }
    if (image.data) {
      setSrc(`data:${image.mime || "image/png"};base64,${image.data}`);
      return;
    }
    const filePath = resolveLocalPath(image.path, cwd);
    if (!filePath) return;
    let alive = true;
    api
      .mediaSrc(filePath)
      .then((next) => {
        if (alive && next) setSrc(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [image.path, image.data, image.mime, image.src, cwd]);
  if (!src) return null;
  return (
    <img
      className="chat-img"
      src={src}
      alt={image.name || ""}
      data-path={image.path || ""}
      onClick={() => openPreview?.({ src, name: image.name || "" })}
    />
  );
}

function onMarkdownClick(event, openPreview) {
  const img = event.target.closest("img");
  if (img && event.currentTarget.contains(img) && img.getAttribute("src")) {
    event.preventDefault();
    openPreview?.({ src: img.src, name: img.getAttribute("alt") || "" });
    return;
  }
  const link = event.target.closest("a[href]");
  if (!link || !event.currentTarget.contains(link)) return;
  const href = link.getAttribute("href") || "";
  if (href.startsWith("#")) return;
  event.preventDefault();
  api.openExternal?.(href);
}

function MarkdownView({ text }) {
  const openPreview = usePreview();
  if (!text) return null;
  return (
    <div
      className="md"
      onClick={(event) => onMarkdownClick(event, openPreview)}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function isImageFile(file) {
  if (!file) return false;
  if (String(file.type || "").startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || "");
}

function attachmentKey(item) {
  if (item?.path) return `p:${String(item.path).toLowerCase()}`;
  if (item?.data) return `d:${item.data.length}:${(item.data || "").slice(0, 48)}`;
  if (item?.src) return `s:${item.src.slice(0, 64)}`;
  return item?.id || "";
}

function mergeAttachments(prev, next) {
  const out = [...prev];
  const seen = new Set(out.map(attachmentKey).filter(Boolean));
  for (const item of next) {
    const key = attachmentKey(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(item);
  }
  return out.slice(0, 16);
}

function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function droppedFiles(dt) {
  const fromItems = [];
  for (const item of [...(dt?.items || [])]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file) fromItems.push(file);
  }
  if (fromItems.length) return fromItems;
  return [...(dt?.files || [])].filter(Boolean);
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      const data = src.includes(",") ? src.split(",")[1] : src;
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified || 0}`,
        kind: "image",
        name: file.name,
        mime: file.type || "image/png",
        data,
        src,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function IconPaperclip() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M21.44 11.05l-8.49 8.49a5.25 5.25 0 01-7.42-7.42l8.48-8.49a3.5 3.5 0 014.95 4.95l-8.48 8.49a1.75 1.75 0 01-2.48-2.48l7.78-7.78"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPlan() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" />
    </svg>
  );
}

const MODES = [
  { id: "agent", label: "代理", hint: "直接动手，敏感操作再问你", Icon: IconAgent },
  { id: "plan", label: "规划", hint: "先出方案，改文件和命令等你点头", Icon: IconPlan },
  { id: "yolo", label: "自动通过", hint: "一律放行", Icon: IconBolt },
];

function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevron({ left, down }) {
  const d = left ? "M15 6l-6 6 6 6" : down ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6";
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClose({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BrandMark() {
  return <img className="brand-mark" src={brandIcon} alt="" />;
}

function IconSkill() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M5 12l5 5L20 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const SKILL_HUES = ["#2eb8c9", "#3aa8d8", "#5b8def", "#6a7ee8", "#3db89a", "#4f9ec7"];

function skillHue(name) {
  let hash = 0;
  for (const ch of String(name || "")) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return SKILL_HUES[hash % SKILL_HUES.length];
}

function skillSourceLabel(source) {
  if (source === "bundled") return "内置";
  if (source === "local") return "项目";
  if (source === "user") return "个人";
  return "";
}

function IconPin() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        d="M15 4l5 5-2.2 1.1-4.2 4.2V18l-3.5-3.5H7.5L8.6 12l4.2-4.2L15 4z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CtxRing({ percent }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, Number(percent) || 0)) / 100) * c;
  return (
    <svg className="ctx-ring" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <circle className="ctx-ring-track" cx="9" cy="9" r={r} fill="none" strokeWidth="2.4" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        className="ctx-ring-progress"
        opacity={dash > 0 ? 1 : 0}
        strokeWidth="2.4"
        strokeDasharray={`${dash} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

function formatReset(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { when: "", left: "" };
  const when = `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return { when, left: "即将重置" };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const left = days >= 1 ? `还有 ${days} 天` : `还有 ${Math.max(1, hours)} 小时`;
  return { when, left };
}

function CtxRow({ label, value, note }) {
  return (
    <div className="ctx-row">
      <span>
        {label}
        {note ? <em> {note}</em> : null}
      </span>
      <b>{value}</b>
    </div>
  );
}

function inputPreview(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  return (
    input.target_file ||
    input.path ||
    input.command ||
    input.target_directory ||
    input.query ||
    JSON.stringify(input)
  );
}

function classifyTool(tool) {
  const blob = `${tool.kind || ""} ${tool.title || ""}`.toLowerCase();
  if (/\b(todo_write|todo)\b/.test(blob)) return "todo";
  if (
    /\b(read_file|list_dir|grep|search_files|glob|read `|list `|explored)\b/.test(blob) ||
    /^(read|list|grep|search)\b/.test(blob)
  ) {
    return "explore";
  }
  if (
    /\b(run_terminal|shell|execute|bash|command)\b/.test(blob) ||
    /^(running command|ran |command)\b/.test(blob)
  ) {
    return "command";
  }
  if (
    /\b(search_replace|write|edit|apply_patch)\b/.test(blob) ||
    /^(edited|wrote|replaced|write|edit)\b/.test(blob)
  ) {
    return "edit";
  }
  return "other";
}

function toolRunning(tool) {
  const status = String(tool.status || "").toLowerCase();
  return Boolean(status) && status !== "completed" && status !== "failed" && status !== "error";
}

function unifiedDiffStats(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const marked = raw.match(/(?:^|\n)\s*\+(\d+)\s+[−\-]\s*(\d+)\s*(?:\n|$)/);
  if (marked) return { plus: Number(marked[1]), minus: Number(marked[2]) };
  if (!/^(--- |\+\+\+ |@@ )/m.test(raw)) return null;
  let plus = 0;
  let minus = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\+[^+]/.test(line)) plus += 1;
    else if (/^-[^-]/.test(line)) minus += 1;
  }
  if (!plus && !minus) return null;
  return { plus, minus };
}

function lineDiffStats(before, after) {
  const oldLines = String(before || "").split(/\r?\n/);
  const newLines = String(after || "").split(/\r?\n/);
  if (!before && after) return { plus: newLines.length, minus: 0 };
  if (before && !after) return { plus: 0, minus: oldLines.length };
  const oldCount = new Map();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) || 0) + 1);
  let plus = 0;
  let minus = 0;
  const newCount = new Map();
  for (const line of newLines) newCount.set(line, (newCount.get(line) || 0) + 1);
  for (const line of new Set([...oldCount.keys(), ...newCount.keys()])) {
    const a = oldCount.get(line) || 0;
    const b = newCount.get(line) || 0;
    if (b > a) plus += b - a;
    if (a > b) minus += a - b;
  }
  if (!plus && !minus) return null;
  return { plus, minus };
}

function toolPath(tool) {
  const input = tool.input;
  if (input && typeof input === "object") {
    return input.file_path || input.target_file || input.path || "";
  }
  const tick = String(tool.title || "").match(/`([^`]+)`/);
  return tick ? tick[1] : "";
}

function collectToolImages(tool) {
  const images = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    const img = typeof item === "string" ? { path: item } : item;
    const filePath = img.path || "";
    if (filePath && !isImagePath(filePath) && !img.src && !img.data) return;
    const key = img.src || img.data?.slice(0, 48) || filePath.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    images.push(img);
  };
  for (const img of tool.images || []) push(img);
  push(toolPath(tool));
  const tick = String(tool.title || "").match(/`([^`]+)`/);
  if (tick) push(tick[1]);
  const output = String(tool.output || "").trim();
  const readLine = output.match(/^Read image file:\s*(.+)$/im);
  if (readLine) push(readLine[1].trim());
  if (output.startsWith("{") || output.startsWith("[")) {
    try {
      const parsed = JSON.parse(output);
      const pathValue = parsed?.path || parsed?.filename;
      if (pathValue) push(parsed.path || pathValue);
    } catch {
      // ignore
    }
  }
  return images;
}

function isImageOnlyOutput(output) {
  const text = String(output || "").trim();
  if (!text) return true;
  if (/^Read image file:\s*.+/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed?.path && isImagePath(parsed.path));
  } catch {
    return false;
  }
}

function toolDiff(tool) {
  const input = tool.input && typeof tool.input === "object" ? tool.input : null;
  if (input && (input.old_string != null || input.new_string != null)) {
    return lineDiffStats(input.old_string, input.new_string);
  }
  if (input && typeof input.patch === "string") {
    const fromPatch = unifiedDiffStats(input.patch);
    if (fromPatch) return fromPatch;
  }
  if (classifyTool(tool) !== "edit") return null;
  if (input?.content != null) {
    const plus = String(input.content).split(/\r?\n/).length;
    return plus ? { plus, minus: 0 } : null;
  }
  return unifiedDiffStats(tool.output);
}

function addDiff(a, b) {
  if (!b) return a;
  if (!a) return { plus: b.plus, minus: b.minus };
  return { plus: a.plus + b.plus, minus: a.minus + b.minus };
}

function groupTools(tools) {
  const groups = [];
  for (const tool of tools || []) {
    const kind = classifyTool(tool);
    const running = toolRunning(tool);
    const last = groups[groups.length - 1];
    const merge =
      last &&
      !last.running &&
      !running &&
      kind !== "other" &&
      last.kind !== "other";
    if (merge) {
      last.tools.push(tool);
      last.kinds.add(kind);
    } else {
      groups.push({
        id: tool.id,
        tools: [tool],
        kinds: new Set([kind]),
        kind,
        running,
      });
    }
  }
  return groups;
}

function groupSummary(group) {
  const tools = group.tools;
  let explore = 0;
  let commands = 0;
  const files = new Set();
  let stats = null;
  for (const tool of tools) {
    const kind = classifyTool(tool);
    if (kind === "explore") explore += 1;
    else if (kind === "command") commands += 1;
    else if (kind === "edit") {
      files.add((toolPath(tool) || tool.id).toLowerCase());
    }
    stats = addDiff(stats, toolDiff(tool));
  }
  const edits = files.size;
  const running = tools.some(toolRunning);
  if (tools.length === 1 && classifyTool(tools[0]) === "command") {
    return {
      label: running ? "正在执行" : "已执行",
      icon: "command",
      stats,
    };
  }
  const parts = [];
  if (edits) parts.push(`改了 ${edits} 个文件`);
  if (commands) parts.push(`跑了 ${commands} 条命令`);
  if (explore) parts.push(`看了 ${explore} 项`);
  if (!parts.length) {
    return { label: tools[0]?.title || "工具", icon: "other", stats };
  }
  return {
    label: `${parts.join("，")}${running ? "…" : ""}`,
    icon: edits ? "edit" : commands && !explore ? "command" : "explore",
    stats,
  };
}

function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 7l6 5-6 5M12 17h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconProcess() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="14.2" cy="12" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function DiffStats({ stats }) {
  if (!stats || (!stats.plus && !stats.minus)) return null;
  return (
    <span className="activity-stats">
      {stats.plus ? <span className="plus">+{stats.plus}</span> : null}
      {stats.minus ? <span className="minus">−{stats.minus}</span> : null}
    </span>
  );
}

function ToolGroups({ tools, cwd }) {
  const groups = groupTools(tools);
  if (!groups.length) return null;
  return (
    <div className="tools">
      {groups.map((group) => {
        const summary = groupSummary(group);
        return (
          <details key={group.id} className={`activity ${group.running ? "running" : ""}`}>
            <summary>
              <span className="activity-ico">
                {summary.icon === "command" ? <IconTerminal /> : <IconFolder />}
              </span>
              <span className="activity-label">{summary.label}</span>
              <DiffStats stats={summary.stats} />
              <span className="activity-caret">›</span>
            </summary>
            <div className="activity-body">
              {group.tools.map((tool) => {
                const images = collectToolImages(tool);
                return (
                  <details
                    key={tool.id}
                    className={`tool ${String(tool.status || "").toLowerCase()}`}
                    defaultOpen={images.length > 0}
                  >
                    <summary>
                      <span>{tool.title}</span>
                      <em>{toolStatus(tool.status)}</em>
                    </summary>
                    {inputPreview(tool.input) && !images.length ? (
                      <code>{inputPreview(tool.input)}</code>
                    ) : null}
                    {images.length ? (
                      <div className="pics">
                        {images.map((image, index) => (
                          <ChatImage
                            key={image.path || image.src || index}
                            image={image}
                            cwd={cwd}
                          />
                        ))}
                      </div>
                    ) : null}
                    {tool.output && !isImageOnlyOutput(tool.output) ? (
                      <pre>{tool.output.slice(0, 4000)}</pre>
                    ) : null}
                  </details>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function runSummary(thought, tools, running) {
  const hasThought = Boolean(String(thought || "").trim());
  let explore = 0;
  let commands = 0;
  const files = new Set();
  let stats = null;
  for (const tool of tools || []) {
    const kind = classifyTool(tool);
    if (kind === "explore") explore += 1;
    else if (kind === "command") commands += 1;
    else if (kind === "edit") files.add((toolPath(tool) || tool.id).toLowerCase());
    stats = addDiff(stats, toolDiff(tool));
  }
  const parts = [];
  if (hasThought) parts.push(running && !(tools || []).length ? "正在思考" : "思考");
  if (files.size) parts.push(`改了 ${files.size} 个文件`);
  if (commands) parts.push(`跑了 ${commands} 条命令`);
  if (explore) parts.push(`看了 ${explore} 项`);
  if (!parts.length) parts.push(running ? "正在处理" : "已处理");
  return {
    label: `${parts.join("，")}${running ? "…" : ""}`,
    stats,
  };
}

function messageDuration(message, running, now, turnStart) {
  if (running) return formatDuration(now - (message.startedAt || turnStart || now));
  return formatDuration(message.durationMs);
}

function RunFold({ thought, tools, cwd, running, duration }) {
  const hasThought = Boolean(String(thought || "").trim());
  const hasTools = Boolean(tools?.length);
  if (!hasThought && !hasTools) return null;
  const summary = runSummary(thought, tools, running);
  return (
    <details className={`run-fold ${running ? "running" : ""}`}>
      <summary>
        <span className="activity-ico">
          <IconProcess />
        </span>
        <span className="activity-label">{summary.label}</span>
        <DiffStats stats={summary.stats} />
        {duration ? <span className="turn-time">{duration}</span> : null}
        <span className="activity-caret">›</span>
      </summary>
      <div className="run-fold-body">
        {hasThought ? (
          <details className="thought">
            <summary>思考</summary>
            <pre>{thought}</pre>
          </details>
        ) : null}
        {hasTools ? <ToolGroups tools={tools} cwd={cwd} /> : null}
      </div>
    </details>
  );
}

export function App() {
  const [appState, setAppState] = useState({
    cwd: null,
    sessionId: null,
    ready: false,
    running: false,
    runningIds: [],
    models: [],
    modelId: "grok-4.6",
    sessions: [],
    projects: [],
    grokFound: true,
    commands: [],
    skills: [],
    skillLibrary: [],
    context: null,
    quota: null,
    permissionMode: "agent",
  });
  const [threads, setThreads] = useState({});
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [permissionError, setPermissionError] = useState('');
  const [error, setError] = useState("");
  const [workbenchPage, setWorkbenchPage] = useState('');
  const [permissionItems, setPermissionItems] = useState([]);
  const [selectedPermission, setSelectedPermission] = useState(null);
  const [composerReady, setComposerReady] = useState(false);
  const composerSaveRef = useRef(null);
  const composerKeyRef = useRef(null);
  const steeringStore = useRef({});
  const recoveredComposers = useRef(storedComposer());
  const prefs = appState.preferences || {};
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches || false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [renameId, setRenameId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [renameProjectCwd, setRenameProjectCwd] = useState("");
  const [renameProjectDraft, setRenameProjectDraft] = useState("");
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [drag, setDrag] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return brandStorage('sidebar') === "1";
    } catch {
      return false;
    }
  });
  const [openProjects, setOpenProjects] = useState(readOpenProjects);
  const [caret, setCaret] = useState(0);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [fileHits, setFileHits] = useState([]);
  const [showContext, setShowContext] = useState(false);
  const [showQuota, setShowQuota] = useState(false);
  const [showMode, setShowMode] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [pendingImport, setPendingImport] = useState("");
  const [queue, setQueue] = useState([]);
  const [compactPhases, setCompactPhases] = useState({});
  const scroller = useRef(null);
  const stickBottom = useRef(true);
  const pinLock = useRef(0);
  const parkedRef = useRef(false);
  const scrollPos = useRef(0);
  const sessionIdRef = useRef(null);
  const cwdRef = useRef(null);
  const draftsRef = useRef({});
  const filesRef = useRef({});
  const queuesStore = useRef({});
  const sendingStore = useRef({});
  const turnStartRef = useRef({});
  const prevRunningRef = useRef(new Set());
  const runningRef = useRef(new Set());
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);
  const renameRef = useRef(null);
  const skipRenameBlur = useRef(false);
  const skipProjectRenameBlur = useRef(false);
  const menuRef = useRef(null);
  const ctxRef = useRef(null);
  const quotaRef = useRef(null);
  const modeRef = useRef(null);
  const modelRef = useRef(null);
  const suggestRef = useRef(null);
  const dragLive = useRef(null);
  const skipClick = useRef(false);
  const queueRef = useRef([]);
  const addDroppedRef = useRef(async () => {});
  sessionIdRef.current = appState.sessionId;
  cwdRef.current = appState.cwd;
  runningRef.current = new Set(appState.runningIds || []);
  if (appState.running && appState.sessionId) runningRef.current.add(appState.sessionId);
  const messages = threads[appState.sessionId] || [];
  const compactPhase = compactPhases[appState.sessionId] || "";

  useEffect(() => {
    let off = () => {};
    (async () => {
      try {
        const next = await api.getState();
        setAppState((prev) => ({ ...prev, ...next }));
        const saved = { ...(next.composers || {}) };
        for (const [key, row] of Object.entries(recoveredComposers.current)) {
          if (!saved[key] || row.updatedAt > saved[key].updatedAt) saved[key] = row;
        }
        recoveredComposers.current = saved;
        for (const [key, row] of Object.entries(saved)) {
          draftsRef.current[key] = row.draft || '';
          filesRef.current[key] = row.attachments || [];
          queuesStore.current[key] = (row.queue || []).filter(item => !(next.acceptedItems || []).includes(item.id) && !(next.interrupted || []).some(t => t.itemId && t.itemId === item.id));
        }
        const key = next.sessionId || `project:${next.cwd || ''}`;
        composerKeyRef.current = key;
        setDraft(draftsRef.current[key] || '');
        setAttachments(filesRef.current[key] || []);
        setQueue(queuesStore.current[key] || []);
        queueRef.current = queuesStore.current[key] || [];
        setPermissionItems(next.permissions || []);
        setComposerReady(true);
        if (typeof next.sidebarCollapsed === "boolean") setCollapsed(next.sidebarCollapsed);
      } catch (err) {
        setError(friendlyError(err));
      }
    })();
    off = api.onEvent((event) => {
      if (event.type === "state") {
        setAppState((prev) => ({ ...prev, ...event.payload }));
        if (typeof event.payload?.sidebarCollapsed === "boolean") {
          setCollapsed(event.payload.sidebarCollapsed);
        }
      }
      if (event.type === 'permissions') setPermissionItems(event.payload || []);
      if (event.type === "transcript") {
        const payload = event.payload;
        const sid = payload?.sessionId || sessionIdRef.current;
        const msgs = Array.isArray(payload) ? payload : payload?.messages || [];
        const keepLive = Boolean(payload?.live) || runningRef.current.has(sid);
        if (sid === sessionIdRef.current) {
          stickBottom.current = true;
          pinLock.current = Date.now() + 800;
        }
        if (sid) {
          setCompactPhases((prev) => ({ ...prev, [sid]: "" }));
          setThreads((prev) => {
            if (keepLive && prev[sid]?.length) return prev;
            return { ...prev, [sid]: msgs };
          });
        }
      }
      if (event.type === "update") {
        const payload = event.payload || {};
        const update = payload.update || payload;
        const sid = payload.sessionId || sessionIdRef.current;
        const chunk = update?.content?.text || "";
        if (update?.sessionUpdate === "user_message_chunk" && compactHint(chunk) != null) return;
        if (!sid) return;
        setThreads((prev) => {
          const list = applyUpdate(prev[sid] || [], update);
          const start = turnStartRef.current[sid];
          if (start) {
            const last = [...list].reverse().find((item) => item.role === "assistant");
            if (last && !last.startedAt && !last.endedAt) last.startedAt = start;
          }
          return { ...prev, [sid]: list };
        });
      }
      if (event.type === "compact") {
        const payload = event.payload || {};
        const sid = payload.sessionId || sessionIdRef.current;
        if (payload.phase === "start") {
          if (sid) setCompactPhases((prev) => ({ ...prev, [sid]: "start" }));
          return;
        }
        if (payload.phase === "fail") {
          if (sid) setCompactPhases((prev) => ({ ...prev, [sid]: "" }));
          setError(payload.message || "压缩没完成");
          return;
        }
        if (payload.phase === "done") {
          if (sid) setCompactPhases((prev) => ({ ...prev, [sid]: "" }));
          const before = Number(payload.tokensBefore);
          const after = Number(payload.tokensAfter);
          if (
            sid === sessionIdRef.current &&
            payload.tokensAfter != null &&
            Number.isFinite(after) &&
            after >= 0
          ) {
            setAppState((prev) => {
              const ctx = prev.context;
              if (!ctx) return prev;
              const total = ctx.total || 500000;
              return {
                ...prev,
                context: {
                  ...ctx,
                  used: after,
                  estimated: Boolean(payload.estimated),
                  free: Math.max(0, total - after),
                  percent: Math.max(0, Math.min(100, Math.round((after / total) * 100))),
                },
              };
            });
          }
          if (sid === sessionIdRef.current) stickBottom.current = true;
          if (sid) {
            setThreads((prev) => {
              const list = prev[sid] || [];
              const last = list[list.length - 1];
              if (
                last?.kind === "compact" &&
                last.before === before &&
                last.after === after
              ) {
                return prev;
              }
              return {
                ...prev,
                [sid]: [
                  ...list,
                  {
                    id: `compact-${Date.now()}`,
                    role: "system",
                    kind: "compact",
                    before: Number.isFinite(before) ? before : null,
                    after: Number.isFinite(after) ? after : null,
                    estimated: Boolean(payload.estimated),
                  },
                ],
              };
            });
          }
        }
      }
      if (event.type === "error") setError(event.payload?.message || "出了点问题");
    });
    return () => off();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange); return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!composerReady) return;
    const key = appState.sessionId || `project:${appState.cwd || ''}`;
    if (composerKeyRef.current !== key) {
      if (!busy && composerKeyRef.current?.startsWith('project:') && appState.sessionId) composerKeyRef.current = key;
      else return;
    }
    const value = { draft, attachments, queue, cwd: appState.cwd, updatedAt: Date.now() };
    recoveredComposers.current[key] = value;
    composerSaveRef.current = { key, value };
    try { localStorage.setItem('halora.composer', JSON.stringify(recoveredComposers.current)); } catch {}
    const timer = setTimeout(() => api.saveComposer?.({ key, value }).catch(e => setError(`草稿保存失败：${friendlyError(e)}`)), 250);
    return () => { clearTimeout(timer); api.saveComposer?.({ key, value }).catch(() => {}); };
  }, [draft, attachments, queue, appState.sessionId, appState.cwd, composerReady, busy]);
  useEffect(() => {
    const flush = () => { if (composerSaveRef.current) api.saveComposerSync?.(composerSaveRef.current); };
    window.addEventListener('beforeunload', flush); return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => {
    if (!appState.running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [appState.running, appState.sessionId]);

  useEffect(() => {
    const next = new Set(appState.runningIds || []);
    if (appState.running && appState.sessionId) next.add(appState.sessionId);
    const prev = prevRunningRef.current;
    for (const id of prev) {
      if (next.has(id)) continue;
      const started = turnStartRef.current[id];
      const ended = Date.now();
      setThreads((current) => {
        const list = current[id];
        if (!list?.length) return current;
        const copy = list.map((item) => ({ ...item }));
        let target = -1;
        for (let i = copy.length - 1; i >= 0; i -= 1) {
          if (copy[i].role !== "assistant") continue;
          if (copy[i].endedAt) break;
          if (copy[i].startedAt || started) {
            target = i;
            break;
          }
        }
        if (target < 0) return current;
        const startAt = copy[target].startedAt || started || ended;
        copy[target] = {
          ...copy[target],
          startedAt: startAt,
          endedAt: ended,
          durationMs: Math.max(0, ended - startAt),
        };
        return { ...current, [id]: copy };
      });
      delete turnStartRef.current[id];
    }
    prevRunningRef.current = next;
  }, [appState.running, appState.runningIds, appState.sessionId]);

  const pinToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    pinLock.current = Math.max(pinLock.current, Date.now() + 80);
    el.scrollTop = el.scrollHeight;
  };

  const saveThreadScroll = () => {
    const el = scroller.current;
    if (el && !parkedRef.current) scrollPos.current = el.scrollTop;
  };

  const openWorkbench = (page) => {
    saveThreadScroll();
    setShowSkills(false);
    setWorkbenchPage(page);
  };

  const closeWorkbench = () => setWorkbenchPage("");

  const paneParked = Boolean(workbenchPage) || showSkills;
  parkedRef.current = paneParked;

  useLayoutEffect(() => {
    if (paneParked) return;
    const el = scroller.current;
    if (!el) return;
    if (stickBottom.current) pinToBottom();
    else el.scrollTop = scrollPos.current;
  }, [paneParked]);

  useLayoutEffect(() => {
    if (!stickBottom.current) return;
    pinToBottom();
  }, [messages, appState.running, appState.sessionId]);

  useEffect(() => {
    if (!stickBottom.current) return;
    const el = scroller.current;
    if (!el) return;
    pinToBottom();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!parkedRef.current && stickBottom.current) pinToBottom();
          });
    if (ro) {
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    }
    const frame = requestAnimationFrame(() => {
      pinToBottom();
      requestAnimationFrame(pinToBottom);
    });
    const later = setTimeout(pinToBottom, 160);
    const last = setTimeout(pinToBottom, 480);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(later);
      clearTimeout(last);
    };
  }, [messages, appState.sessionId]);

  const project = folderName(appState.cwd);
  const liveAssistant = appState.running
    ? [...messages].reverse().find((item) => item.role === "assistant" && item.startedAt && !item.endedAt)
    : null;
  const liveAssistantId = liveAssistant?.id || "";
  const pendingDuration = appState.running
    ? formatDuration(now - (turnStartRef.current[appState.sessionId] || now))
    : "";
  const projects = appState.projects?.length
    ? appState.projects
    : appState.cwd
      ? [{ cwd: appState.cwd, name: project, exists: true, sessions: appState.sessions || [] }]
      : [];
  const allSessions = projects.flatMap((item) => item.sessions || []);

  const startDrag = (event, payload) => {
    if (event.target.closest("button, input")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", payload.key);
    dragLive.current = { ...payload, overKey: "", overEdge: "", moved: false };
    setDrag(dragLive.current);
  };

  const hoverDrag = (event, payload) => {
    const current = dragLive.current;
    if (!current || current.type !== payload.type) return;
    if (current.type === "chat" && !sameFolder(current.cwd, payload.cwd)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (current.overKey === payload.key && current.overEdge === edge) return;
    dragLive.current = { ...current, overKey: payload.key, overEdge: edge, moved: true };
    setDrag(dragLive.current);
  };

  const finishDrag = async (event) => {
    event.preventDefault();
    const current = dragLive.current;
    dragLive.current = null;
    setDrag(null);
    if (!current?.moved || !current.overKey) return;
    skipClick.current = true;
    try {
      if (current.type === "project") {
        const keys = projects.map((item) => projectKey(item.cwd));
        const nextKeys = placeKeys(keys, current.key, current.overKey, current.overEdge);
        if (!nextKeys) return;
        const byKey = new Map(projects.map((item) => [projectKey(item.cwd), item]));
        const nextProjects = nextKeys.map((key) => byKey.get(key)).filter(Boolean);
        setAppState((prev) => ({ ...prev, projects: nextProjects }));
        const snapshot = await api.reorderProjects(nextProjects.map((item) => item.cwd));
        setAppState((prev) => ({ ...prev, ...snapshot }));
        return;
      }
      const projectRow = projects.find((item) => sameFolder(item.cwd, current.cwd));
      const sessions = projectRow?.sessions || [];
      const nextIds = placeKeys(
        sessions.map((session) => session.id),
        current.key,
        current.overKey,
        current.overEdge
      );
      if (!nextIds) return;
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const nextSessions = nextIds.map((id) => byId.get(id)).filter(Boolean);
      setAppState((prev) => ({
        ...prev,
        projects: (prev.projects || []).map((item) =>
          sameFolder(item.cwd, current.cwd) ? { ...item, sessions: nextSessions } : item
        ),
      }));
      const snapshot = await api.reorderChats(current.cwd, nextIds);
      setAppState((prev) => ({ ...prev, ...snapshot }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const cancelDrag = () => {
    if (dragLive.current?.moved) skipClick.current = true;
    dragLive.current = null;
    setDrag(null);
  };
  const canSend = Boolean(appState.cwd) && (draft.trim() || attachments.length) && !busy;
  const commands = useMemo(
    () => mergeCommands(appState.commands, appState.skills),
    [appState.commands, appState.skills]
  );
  const skillLibrary = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    const rows = (appState.skillLibrary || []).filter((item) => item?.name);
    if (!q) return rows;
    return rows.filter((item) => {
      const blob = `${item.label || ""} ${item.name} ${item.description || ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [appState.skillLibrary, skillQuery]);
  const slash = slashQuery(draft);
  const slashHits = slash != null ? filterCommands(commands, slash) : [];
  const mention = mentionAt(draft, caret);
  const menuItems = mention ? fileHits : slashHits;
  const menuOpen = Boolean(menuItems.length);
  const context = appState.context;
  const quota = appState.quota;
  const permission = permissionItems.find(p => p.requestId === selectedPermission) || permissionItems[0];
  const quotaReset = quota?.resetAt ? formatReset(quota.resetAt) : { when: "", left: "" };
  const permissionMode = appState.permissionMode || "agent";
  const currentMode = MODES.find((item) => item.id === permissionMode) || MODES[0];
  const ModeIcon = currentMode.Icon;

  useEffect(() => {
    if (!mention || !appState.cwd) {
      setFileHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const rows = await api.searchFiles(mention.query, { hidden: mention.hidden });
        if (alive) {
          setFileHits(rows || []);
          setSuggestIndex(0);
        }
      } catch {
        if (alive) setFileHits([]);
      }
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mention?.query, mention?.hidden, mention?.start, appState.cwd]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [slash, mention?.start]);

  useEffect(() => {
    const list = suggestRef.current;
    if (!list || !menuOpen) return;
    const item = list.children[suggestIndex];
    if (!(item instanceof HTMLElement)) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.bottom - listRect.bottom;
    } else if (itemRect.top < listRect.top) {
      list.scrollTop -= listRect.top - itemRect.top;
    }
  }, [suggestIndex, menuOpen, menuItems.length]);

  useEffect(() => {
    if (!showContext) return;
    const onDown = (event) => {
      if (!ctxRef.current?.contains(event.target)) setShowContext(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showContext]);

  useEffect(() => {
    if (!showQuota) return;
    const onDown = (event) => {
      if (!quotaRef.current?.contains(event.target)) setShowQuota(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showQuota]);

  useEffect(() => {
    if (!showMode) return;
    const onDown = (event) => {
      if (!modeRef.current?.contains(event.target)) setShowMode(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showMode]);

  useEffect(() => {
    if (!showModel) return;
    const onDown = (event) => {
      if (!modelRef.current?.contains(event.target)) setShowModel(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showModel]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenu(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  const addFiles = async (files) => {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return;
    const next = [];
    for (const file of list) {
      if (isImageFile(file)) {
        next.push(await fileToAttachment(file));
        continue;
      }
      const filePath = api.pathForFile?.(file) || "";
      if (!filePath) continue;
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified || 0}`,
        kind: "file",
        name: file.name,
        path: filePath,
      });
    }
    if (!next.length) return;
    setAttachments((prev) => mergeAttachments(prev, next));
  };

  const addDropped = async (dt) => {
    const list = droppedFiles(dt);
    if (!list.length) return;
    const paths = [];
    const blobs = [];
    for (const file of list) {
      const filePath = api.pathForFile?.(file) || "";
      if (filePath) paths.push(filePath);
      else if (isImageFile(file)) blobs.push(file);
    }
    const resolved = paths.length && api.resolveDrops ? await api.resolveDrops(paths) : [];
    const next = [...(resolved || [])];
    for (const file of blobs) next.push(await fileToAttachment(file));
    if (!next.length) return;
    setAttachments((prev) => mergeAttachments(prev, next));
  };
  addDroppedRef.current = addDropped;

  useEffect(() => {
    const over = (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const drop = async (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      await addDroppedRef.current(event.dataTransfer);
    };
    const end = () => setDragging(false);
    const leave = (event) => {
      if (!event.relatedTarget) end();
    };
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end, true);
    window.addEventListener("dragleave", leave, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("dragleave", leave, true);
    };
  }, []);

  const setProjectOpen = (cwd, force) => {
    const key = projectKey(cwd);
    if (!key) return;
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (force === true) next.add(key);
      else if (force === false) next.delete(key);
      else if (next.has(key)) next.delete(key);
      else next.add(key);
      writeOpenProjects(next);
      return next;
    });
  };

  useEffect(() => {
    if (!appState.cwd) return;
    setOpenProjects((prev) => {
      const key = projectKey(appState.cwd);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      writeOpenProjects(next);
      return next;
    });
  }, [appState.cwd]);

  const setQueueAndRef = (updater) => {
    setQueue((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      queueRef.current = next;
      const id = sessionIdRef.current;
      if (id) queuesStore.current[id] = next;
      return next;
    });
  };

  const queueFor = (id, updater) => {
    const cur = queuesStore.current[id] || [];
    const next = typeof updater === "function" ? updater(cur) : updater;
    queuesStore.current[id] = next;
    if (id) {
      const value = { ...(recoveredComposers.current[id] || {}), queue: next, updatedAt: Date.now() };
      recoveredComposers.current[id] = value;
      api.saveComposer?.({key:id,value}).catch(e => setError(friendlyError(e)));
      try { localStorage.setItem('halora.composer', JSON.stringify(recoveredComposers.current)); } catch {}
    }
    if (id === sessionIdRef.current) setQueueAndRef(next);
    return next;
  };

  const parkComposer = (id) => {
    id ||= `project:${appState.cwd || ''}`;
    draftsRef.current[id] = draft;
    filesRef.current[id] = attachments;
    queuesStore.current[id] = queueRef.current;
  };

  const restoreComposer = (id) => {
    id ||= `project:${appState.cwd || ''}`;
    composerKeyRef.current = id;
    setDraft(id ? draftsRef.current[id] || "" : "");
    setAttachments(id ? filesRef.current[id] || [] : []);
    const next = id ? queuesStore.current[id] || [] : [];
    queueRef.current = next;
    setQueue(next);
  };

  const sessionBusy = (id) =>
    Boolean(id && (sendingStore.current[id] || (appState.runningIds || []).includes(id) || (id === appState.sessionId && appState.running)));

  const stopRun = async () => {
    const id = sessionIdRef.current;
    if (!sessionBusy(id)) return;
    try {
      await api.cancel(id);
    } catch {
      // ignore
    }
  };

  const openFolder = async () => {
    setWorkbenchPage('');
    setShowSkills(false);
    setError("");
    const cwd = await api.pickFolder();
    if (!cwd) return;
    parkComposer(appState.sessionId);
    setBusy(true);
    try {
      const next = await api.openProject(cwd);
      restoreComposer(`project:${cwd}`);
      setAppState((prev) => ({ ...prev, ...next }));
      setProjectOpen(cwd, true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const newChat = async (cwd) => {
    setWorkbenchPage('');
    setShowSkills(false);
    const target = cwd || appState.cwd;
    if (!target) return;
    setError("");
    parkComposer(appState.sessionId);
    setBusy(true);
    try {
      const next = await api.newChat(target);
      setAppState((prev) => ({ ...prev, ...next }));
      restoreComposer(next.sessionId);
      if (next.sessionId) {
        setThreads((prev) => ({ ...prev, [next.sessionId]: prev[next.sessionId] || [] }));
      }
      setProjectOpen(target, true);
      inputRef.current?.focus();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("halora.sidebar", next ? "1" : "0");
      } catch {
        // ignore
      }
      api.setSidebar?.(next);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadChat = async (id, cwd) => {
    setWorkbenchPage('');
    if (!id || id === appState.sessionId) return;
    setShowSkills(false);
    setError("");
    stickBottom.current = true;
    pinLock.current = Date.now() + 800;
    parkComposer(appState.sessionId);
    setBusy(true);
    try {
      const next = await api.loadChat(id, cwd);
      restoreComposer(id);
      setAppState((prev) => ({ ...prev, ...next }));
      if (cwd) setProjectOpen(cwd, true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const takeComposer = (override) => {
    const usingDraft = override == null;
    const text = String(override ?? draft).trim();
    const images = usingDraft
      ? attachments
          .filter((item) => item.kind === "image")
          .map((item) => ({
            name: item.name,
            mime: item.mime,
            data: item.data,
            path: item.path,
            src: item.src,
          }))
      : [];
    const files = usingDraft
      ? attachments
          .filter((item) => (item.kind === "file" || item.kind === "folder") && item.path)
          .map((item) => ({ name: item.name, path: item.path, kind: item.kind }))
      : [];
    if (!text && !images.length && !files.length) return null;
    let outbound = text;
    if (usingDraft && appState.permissionMode === "plan" && text && !text.startsWith("/")) {
      outbound = `/plan ${text}`;
    }
    return {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sessionIdRef.current,
      cwd: cwdRef.current,
      text,
      outbound,
      images,
      files,
      mentions: collectMentions(text),
    };
  };

  const isCancelError = (err) => {
    const msg = String(err?.message || err || "").toLowerCase();
    return /cancel|abort|取消/.test(msg);
  };

  const deliver = async (item, sid) => {
    const id = sid || item.sessionId || sessionIdRef.current;
    const cwd = item.cwd || cwdRef.current;
    setError("");
    if (!item.compact && id) turnStartRef.current[id] = Date.now();
    if (item.compact) {
      if (id) setCompactPhases((prev) => ({ ...prev, [id]: "start" }));
      try {
        await api.compact(item.hint || "", id);
      } catch (err) {
        if (!isCancelError(err)) setError(friendlyError(err));
        return false;
      } finally {
        setCompactPhases((prev) => (prev[id] === "start" ? { ...prev, [id]: "" } : prev));
      }
      return true;
    }
    if (id) {
      setThreads((prev) => ({
        ...prev,
        [id]: [
          ...(prev[id] || []),
          {
            id: `local-${Date.now()}`,
            role: "user",
            text: item.text,
            images: item.images,
            files: item.files,
          },
        ],
      }));
    }
    try {
      await api.send({
        text: item.outbound,
        images: item.images,
        files: item.files,
        mentions: item.mentions,
        sessionId: id,
        cwd,
        itemId: item.id,
      });
      return true;
    } catch (err) {
      if (!isCancelError(err)) setError(friendlyError(err));
      return false;
    }
  };

  const sendNow = async (item, sid) => {
    if (!item) return;
    const id = sid || item.sessionId || sessionIdRef.current;
    if (sendingStore.current[id]) {
      queueFor(id, (prev) => [...prev, item]);
      return;
    }
    sendingStore.current[id] = true;
    let success = false;
    try {
      success = await deliver(item, id);
    } finally {
      sendingStore.current[id] = false;
    }
    const steering = steeringStore.current[id];
    delete steeringStore.current[id];
    if (!success && !steering) return;
    const next = (queuesStore.current[id] || [])[0];
    if (!next) return;
    queueFor(id, (prev) => prev.slice(1));
    await sendNow(next, id);
  };

  const compactChat = (hint = "") => {
    if (!appState.cwd || busy || !appState.sessionId) return;
    setDraft("");
    setFileHits([]);
    setShowContext(false);
    setShowQuota(false);
    setShowMode(false);
    setShowModel(false);
    sendNow({
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sessionIdRef.current,
      cwd: cwdRef.current,
      compact: true,
      hint: String(hint || "").trim(),
      text: "",
      outbound: "",
      images: [],
      files: [],
      mentions: [],
    });
  };

  const sendPrompt = async (override) => {
    if (!appState.cwd || busy) return;
    const usingDraft = override == null;
    const parsed = parseSlash(override ?? draft);
    if (parsed && (override != null || !attachments.length)) {
      const cmd = findCommand(commands, parsed.name);
      if (cmd?.local === "new") {
        if (usingDraft) {
          setDraft("");
          setAttachments([]);
        }
        newChat();
        return;
      }
      if (cmd?.local === "rename") {
        if (usingDraft) {
          setDraft("");
          setAttachments([]);
        }
        const session = allSessions.find((item) => item.id === appState.sessionId);
        if (parsed.rest) {
          api.renameChat(appState.sessionId, parsed.rest, session?.cwd).then((next) => {
            setAppState((prev) => ({ ...prev, ...next }));
          }).catch((err) => setError(friendlyError(err)));
          return;
        }
        if (session) startRename(session);
        return;
      }
      if (cmd?.local === "context") {
        if (usingDraft) {
          setDraft("");
          setAttachments([]);
        }
        setShowContext(true);
        return;
      }
      if (cmd?.name === "compact") {
        if (usingDraft) {
          setDraft("");
          setAttachments([]);
        }
        compactChat(parsed.rest);
        return;
      }
      if (cmd?.name === "rewind") {
        setDraft("");
        openWorkbench("checkpoints");
        return;
      }
    }
    const item = takeComposer(override);
    if (!item) return;
    let targetId = appState.sessionId;
    if (!targetId) {
      setBusy(true);
      try {
        const next = await api.newChat(appState.cwd);
        targetId = next.sessionId;
        item.sessionId = targetId;
        composerKeyRef.current = targetId;
        setAppState(prev => ({...prev,...next}));
      } catch (error) { setError(friendlyError(error)); return; }
      finally { setBusy(false); }
    }
    if (usingDraft) {
      setDraft("");
      setAttachments([]);
    }
    setFileHits([]);
    setShowContext(false);
    setShowQuota(false);
    setShowMode(false);
    setShowModel(false);
    if (sessionBusy(targetId)) {
      setQueueAndRef((prev) => [...prev, item]);
      return;
    }
    sendNow(item, targetId);
  };

  const send = () => sendPrompt();

  const steer = async (id) => {
    const sid = sessionIdRef.current;
    const item = queueRef.current.find(row => row.id === id);
    if (!item) return;
    if (sendingStore.current[sid]) {
      queueFor(sid, rows => [item, ...rows.filter(row => row.id !== id)]);
      steeringStore.current[sid] = true;
      await stopRun();
    } else {
      await stopRun();
      queueFor(sid, rows => rows.filter(row => row.id !== id));
      sendNow(item, sid);
    }
  };

  const removeQueued = (id) => {
    setQueueAndRef((prev) => prev.filter((row) => row.id !== id));
  };

  const insertMention = (hit) => {
    if (!mention || !hit?.path) return;
    const next = `${draft.slice(0, mention.start)}${mention.prefix}${hit.path} ${draft.slice(caret)}`;
    const pos = mention.start + mention.prefix.length + hit.path.length + 1;
    setDraft(next);
    setFileHits([]);
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
      setCaret(pos);
    }, 0);
  };

  const fillSlash = (cmd) => {
    if (!cmd) return;
    const rest = draft.replace(/^\/\S*/, "").trim();
    const next = rest ? `/${cmd.name} ${rest}` : `/${cmd.name} `;
    setDraft(next);
    setSuggestIndex(0);
    setFileHits([]);
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = next.length;
      setCaret(next.length);
    }, 0);
  };

  const onKeyDown = (event) => {
    if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSuggestIndex((index) => (index + delta + menuItems.length) % menuItems.length);
      return;
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setFileHits([]);
      return;
    }
    if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      if (mention) insertMention(menuItems[suggestIndex] || menuItems[0]);
      else fillSlash(menuItems[suggestIndex] || menuItems[0]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && (prefs.sendKey !== 'ctrl-enter' || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = async (event) => {
    const dt = event.clipboardData;
    if (!dt) return;
    const fromFiles = [...(dt.files || [])].filter(isImageFile);
    const fromItems = [...(dt.items || [])]
      .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    const images = fromFiles.length ? fromFiles : fromItems;
    if (!images.length) return;
    event.preventDefault();
    const seen = new Set();
    const unique = images.filter((file) => {
      const key = `${file.type}:${file.size}:${file.lastModified}:${file.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await addFiles(unique);
  };

  const pickFiles = async () => {
    const next = await api.pickFiles();
    if (!next?.length) return;
    setAttachments((prev) =>
      mergeAttachments(
        prev,
        next.map((item) => ({
          ...item,
          kind: item.kind || (item.data || item.src ? "image" : "file"),
          id: item.id || `${item.path || item.name}-${Date.now()}`,
        }))
      )
    );
  };

  const startRename = (session) => {
    skipRenameBlur.current = false;
    skipProjectRenameBlur.current = true;
    setRenameProjectCwd("");
    setRenameId(session.id);
    setRenameDraft(session.title || "");
    setMenu(null);
    setTimeout(() => renameRef.current?.select(), 0);
  };

  const startProjectRename = (item) => {
    skipProjectRenameBlur.current = false;
    skipRenameBlur.current = true;
    setRenameId("");
    setRenameProjectCwd(item.cwd);
    setRenameProjectDraft(item.name || "");
    setMenu(null);
    setTimeout(() => renameRef.current?.select(), 0);
  };

  const openMenu = (event, payload) => {
    event.preventDefault();
    event.stopPropagation();
    const width = payload?.kind === "file" ? 176 : 168;
    const height = payload?.kind === "file" ? 120 : 132;
    const x = Math.min(event.clientX, window.innerWidth - width - 8);
    const y = Math.min(event.clientY, window.innerHeight - height - 8);
    setMenu({ ...payload, x: Math.max(8, x), y: Math.max(8, y) });
  };

  const onResourceMenu = (event) => {
    const hint = resourceHintFromEvent(event);
    if (!hint) return;
    openMenu(event, { kind: "file", hint });
  };

  const cancelRename = () => {
    setRenameId("");
    setRenameDraft("");
  };

  const commitRename = async () => {
    if (skipRenameBlur.current) {
      skipRenameBlur.current = false;
      return;
    }
    const id = renameId;
    const title = renameDraft.trim();
    if (!id) return;
    if (!title) {
      cancelRename();
      return;
    }
    const current = allSessions.find((session) => session.id === id);
    if (current && current.title === title) {
      cancelRename();
      return;
    }
    try {
      const next = await api.renameChat(id, title, current?.cwd);
      setAppState((prev) => ({ ...prev, ...next }));
      setRenameId((open) => (open === id ? "" : open));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const cancelProjectRename = () => {
    setRenameProjectCwd("");
    setRenameProjectDraft("");
  };

  const commitProjectRename = async () => {
    if (skipProjectRenameBlur.current) {
      skipProjectRenameBlur.current = false;
      return;
    }
    const cwd = renameProjectCwd;
    const title = renameProjectDraft.trim();
    if (!cwd) return;
    const current = projects.find((item) => sameFolder(item.cwd, cwd));
    if (current && current.name === title) {
      cancelProjectRename();
      return;
    }
    try {
      const next = await api.renameProject(cwd, title);
      setAppState((prev) => ({ ...prev, ...next }));
      setRenameProjectCwd((open) => (sameFolder(open, cwd) ? "" : open));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const runMenu = async (action) => {
    const current = menu;
    setMenu(null);
    try {
      if (action === "show-in-folder") {
        await api.showInFolder({ hint: current?.hint, cwd: appState.cwd });
        return;
      }
      if (action === "open-path") {
        await api.openPath({ hint: current?.hint, cwd: appState.cwd });
        return;
      }
      if (action === "copy-path") {
        const text = current?.hint || "";
        if (text) await navigator.clipboard.writeText(text);
        return;
      }
      if (action === "pin-project") {
        const next = await api.pinProject(current.cwd, !current.pinned);
        setAppState((prev) => ({ ...prev, ...next }));
        return;
      }
      if (action === "edit-project") {
        const item = projects.find((row) => sameFolder(row.cwd, current.cwd));
        if (item) startProjectRename(item);
        return;
      }
      if (action === "delete-project") {
        setConfirm({
          kind: "project",
          cwd: current.cwd,
          title: `删除「${current.name}」？`,
          detail: "只从列表里拿掉，文件夹不会删。",
        });
        return;
      }
      if (action === "pin-chat") {
        const next = await api.pinChat(current.id, !current.pinned);
        setAppState((prev) => ({ ...prev, ...next }));
        return;
      }
      if (action === "edit-chat") {
        const session = allSessions.find((row) => row.id === current.id);
        if (session) startRename(session);
        return;
      }
      if (action === "delete-chat") {
        setConfirm({
          kind: "chat",
          id: current.id,
          cwd: current.cwd,
          title: `删除「${current.name}」？`,
          detail: "删掉后不能恢复。",
        });
      }
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const applyConfirm = async () => {
    const job = confirm;
    if (!job) return;
    setConfirm(null);
    setBusy(true);
    try {
      if (job.kind === "project") {
        const next = await api.hideProject(job.cwd);
        setAppState((prev) => ({ ...prev, ...next }));
        if (sameFolder(job.cwd, appState.cwd)) {
          setThreads((prev) => {
            const next = { ...prev };
            for (const session of allSessions) {
              if (sameFolder(session.cwd || job.cwd, job.cwd)) delete next[session.id];
            }
            return next;
          });
        }
        return;
      }
      if (job.kind === "skill") {
        const next = await api.removeSkill(job.dir);
        setAppState((prev) => ({ ...prev, ...next }));
        return;
      }
      if (job.kind === "replace-skill") {
        const next = await api.importSkills(job.from, true);
        setAppState((prev) => ({ ...prev, ...next }));
        setPendingImport("");
        return;
      }
      const next = await api.deleteChat(job.id, job.cwd);
      setAppState((prev) => ({ ...prev, ...next }));
      setThreads((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const importSkills = async () => {
    setError("");
    try {
      const from = await api.pickSkillFolder();
      if (!from) return;
      setPendingImport(from);
      const next = await api.importSkills(from, false);
      setAppState((prev) => ({ ...prev, ...next }));
      const result = next.importResult || {};
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.exists?.length) {
        setConfirm({
          kind: "replace-skill",
          from,
          title:
            result.exists.length === 1
              ? `「${result.exists[0]}」已经有了，换掉吗？`
              : `有 ${result.exists.length} 个技能已经有了，换掉吗？`,
          ok: "替换",
        });
      } else {
        setPendingImport("");
      }
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const changeModel = async (id) => {
    setShowModel(false);
    if (!id || id === appState.modelId) return;
    try {
      const next = await api.setModel(id);
      setAppState((prev) => ({ ...prev, ...next }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const changeMode = async (id) => {
    setShowMode(false);
    try {
      const next = await api.setPermissionMode(id);
      setAppState((prev) => ({ ...prev, ...next }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const modelList = appState.models.length
    ? appState.models
    : appState.modelId
      ? [{ id: appState.modelId, name: appState.modelId }]
      : [];
  const currentModel =
    modelList.find((model) => model.id === appState.modelId) || modelList[0] || null;

  const headerRight = (
    <div className="top-actions">
      {appState.cwd && currentModel ? (
        <div className="model-wrap" ref={modelRef}>
          <button
            type="button"
            className={`model-btn ${showModel ? "open" : ""}`}
            onClick={() => {
              setShowMode(false);
              setShowModel((open) => !open);
            }}
            aria-label="切换模型"
          >
            <span className="model-name">{currentModel.name || currentModel.id}</span>
            <span className="model-chev">
              <IconChevron down />
            </span>
          </button>
          {showModel ? (
            <div className="model-pop">
              {modelList.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  className={`model-item ${model.id === appState.modelId ? "active" : ""}`}
                  onClick={() => changeModel(model.id)}
                >
                  <span>{model.name || model.id}</span>
                  <span className="mode-check">{model.id === appState.modelId ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {appState.running ? (
        <button className="btn ghost" onClick={() => api.cancel(appState.sessionId)}>
          停止
        </button>
      ) : null}
    </div>
  );

  return (
    <PreviewContext.Provider value={setPreview}>
    <div className={`app ${collapsed ? "collapsed" : ""}`} data-theme={prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme || 'light'} style={{ '--chat-font': `${prefs.fontSize || 14}px` }}>
      <aside className={`side ${collapsed ? "collapsed" : ""}`}>
        <div className="side-top">
          <div className="brand">
            <BrandMark />
            <div className="side-wide">
              <strong>Halora</strong>
              <span>{project || "还没打开项目"}</span>
            </div>
          </div>
        </div>

        {collapsed ? (
          <button
            type="button"
            className="side-new-chat"
            onClick={() => newChat()}
            disabled={!appState.cwd || busy}
            title="新对话"
            aria-label="新对话"
          >
            <IconPlus />
          </button>
        ) : (
          <button
            type="button"
            className="side-new"
            onClick={openFolder}
            disabled={busy}
            title="新建项目"
          >
            <IconPlus />
            <span>新建项目</span>
          </button>
        )}

        <div className="session-list side-wide" onContextMenu={(event) => event.preventDefault()}>
          {projects.map((item) => {
            const itemKey = projectKey(item.cwd);
            const open = openProjects.has(itemKey);
            const current = sameFolder(item.cwd, appState.cwd);
            const projectDragging = drag?.type === "project" && drag.key === itemKey;
            const projectDrop =
              drag?.type === "project" && drag.key !== itemKey && drag.overKey === itemKey
                ? drag.overEdge
                : "";
            return (
              <div
                key={itemKey}
                className={`project ${current ? "current" : ""} ${projectDragging ? "is-dragging" : ""} ${
                  projectDrop ? `drop-${projectDrop}` : ""
                }`}
                onDragOver={(event) => hoverDrag(event, { type: "project", key: itemKey })}
                onDrop={finishDrag}
              >
                <div
                  className={`project-head ${current ? "current" : ""}`}
                  title={item.cwd}
                  draggable={!sameFolder(renameProjectCwd, item.cwd)}
                  onDragStart={(event) => startDrag(event, { type: "project", key: itemKey })}
                  onDragEnd={cancelDrag}
                  onClick={() => {
                    if (skipClick.current) {
                      skipClick.current = false;
                      return;
                    }
                    if (renameProjectCwd && sameFolder(renameProjectCwd, item.cwd)) return;
                    setProjectOpen(item.cwd);
                  }}
                  onContextMenu={(event) =>
                    openMenu(event, {
                      kind: "project",
                      cwd: item.cwd,
                      name: item.name,
                      pinned: Boolean(item.pinned),
                    })
                  }
                >
                  <span className="project-caret">
                    <IconChevron down={open} />
                  </span>
                  {sameFolder(renameProjectCwd, item.cwd) ? (
                    <input
                      ref={renameRef}
                      className="session-input"
                      value={renameProjectDraft}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setRenameProjectDraft(event.target.value)}
                      onBlur={commitProjectRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          skipProjectRenameBlur.current = true;
                          cancelProjectRename();
                        }
                      }}
                    />
                  ) : (
                    <span className="project-name">
                      {item.pinned ? <IconPin /> : null}
                      {item.name}
                    </span>
                  )}
                  <button
                    type="button"
                    className="project-add"
                    title="新对话"
                    aria-label="新对话"
                    disabled={!item.exists || busy}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      newChat(item.cwd);
                    }}
                  >
                    <IconPlus />
                  </button>
                </div>
                {open
                  ? (item.sessions || []).map((session) => {
                      const chatDragging = drag?.type === "chat" && drag.key === session.id;
                      const chatDrop =
                        drag?.type === "chat" &&
                        drag.key !== session.id &&
                        drag.overKey === session.id &&
                        sameFolder(drag.cwd, session.cwd || item.cwd)
                          ? drag.overEdge
                          : "";
                      return (
                      <div
                        key={session.id}
                        className={`session ${session.id === appState.sessionId ? "active" : ""} ${
                          renameId === session.id ? "editing" : ""
                        } ${(appState.runningIds || []).includes(session.id) ? "working" : ""} ${chatDragging ? "is-dragging" : ""} ${chatDrop ? `drop-${chatDrop}` : ""}`}
                        draggable={renameId !== session.id}
                        onDragStart={(event) =>
                          startDrag(event, {
                            type: "chat",
                            key: session.id,
                            cwd: session.cwd || item.cwd,
                          })
                        }
                        onDragOver={(event) => {
                          hoverDrag(event, {
                            type: "chat",
                            key: session.id,
                            cwd: session.cwd || item.cwd,
                          });
                          if (dragLive.current?.type === "chat") event.stopPropagation();
                        }}
                        onDrop={(event) => {
                          if (dragLive.current?.type === "chat") event.stopPropagation();
                          finishDrag(event);
                        }}
                        onDragEnd={cancelDrag}
                        onContextMenu={(event) =>
                          openMenu(event, {
                            kind: "chat",
                            id: session.id,
                            cwd: session.cwd || item.cwd,
                            name: session.title,
                            pinned: Boolean(session.pinned),
                          })
                        }
                      >
                        {renameId === session.id ? (
                          <input
                            ref={renameRef}
                            className="session-input"
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                skipRenameBlur.current = true;
                                cancelRename();
                              }
                            }}
                          />
                        ) : (
                          <>
                            <div
                              className="session-main"
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                if (skipClick.current) {
                                  skipClick.current = false;
                                  return;
                                }
                                loadChat(session.id, session.cwd || item.cwd);
                              }}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                startRename(session);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  loadChat(session.id, session.cwd || item.cwd);
                                }
                              }}
                            >
                              <b>
                                {session.pinned ? <IconPin /> : null}
                                <span className="session-title">{session.title}</span>
                                {(appState.runningIds || []).includes(session.id) ? (
                                  <span className="live-dot" aria-hidden="true" />
                                ) : null}
                              </b>
                              <small>{formatTime(session.updatedAt)}</small>
                            </div>
                            <button
                              type="button"
                              className="session-rename"
                              title="改名"
                              aria-label="改名"
                              onClick={(event) => {
                                event.stopPropagation();
                                startRename(session);
                              }}
                            >
                              <IconPencil />
                            </button>
                          </>
                        )}
                      </div>
                      );
                    })
                  : null}
              </div>
            );
          })}
        </div>
        <nav className="side-tools" aria-label="工作区工具">{[['review', '改动审查'], ['checkpoints', '检查点'], ['archives', '导出备份'], ['settings', '设置']].map(([key, label]) => <button key={key} className={workbenchPage === key ? 'active' : ''} onClick={() => openWorkbench(key)}>{label}</button>)}</nav>
        <div className="side-foot">
          <button
            type="button"
            className={`side-skills ${showSkills ? "active" : ""}`}
            onClick={() => {
              if (!showSkills) saveThreadScroll();
              setWorkbenchPage("");
              setShowSkills((open) => !open);
            }}
            title="技能"
            aria-label="技能"
          >
            <IconSkill />
            <span className="side-wide">技能</span>
          </button>
          <button
            type="button"
            className="btn ghost side-toggle"
            onClick={toggleSidebar}
            title={collapsed ? "展开" : "收起"}
            aria-label={collapsed ? "展开" : "收起"}
          >
            <IconChevron left={!collapsed} />
          </button>
        </div>
      </aside>

      <main className="main" onContextMenu={onResourceMenu}>
        {appState.connection === 'disconnected' && <div className="recovery-bar"><span>{appState.everReady ? 'Grok 连接已断开，已保存当前对话。' : appState.grokFound ? '还没连上 Grok。' : '还没找到 Grok Build。'}</span><button className="btn ghost" onClick={() => api.reconnect().then(next => setAppState(p => ({ ...p, ...next }))).catch(e => setError(friendlyError(e)))}>重新连接</button></div>}
        {(appState.interrupted || []).map(turn => <div className="recovery-bar" key={turn.id}><span>上次任务中断：{turn.prompt?.slice(0, 60) || (turn.compact ? '压缩对话' : '执行任务')}</span><button className="btn ghost" onClick={async () => { await loadChat(turn.id, turn.cwd); }}>查看对话</button><button className="btn ghost" onClick={async () => { await loadChat(turn.id, turn.cwd); setDraft('请检查上次任务的执行进度，继续完成尚未完成的部分。'); inputRef.current?.focus(); }}>准备继续</button><button className="btn ghost" onClick={() => api.dismissRecovery(turn.id).then(next => setAppState(p => ({ ...p, ...next }))).catch(e => setError(friendlyError(e)))}>忽略</button></div>)}
        {workbenchPage ? <Workbench key={`${workbenchPage}:${appState.cwd}:${appState.sessionId}`} page={workbenchPage} state={appState} onState={next => setAppState(p => ({ ...p, ...next }))} onClose={closeWorkbench} /> : null}
        {showSkills && !workbenchPage ? (
          <section className="skills-page">
            <div className="skills-head">
              <h1>技能</h1>
              <button type="button" className="btn primary" onClick={importSkills}>
                导入
              </button>
            </div>
            <input
              className="skills-search"
              value={skillQuery}
              onChange={(event) => setSkillQuery(event.target.value)}
              placeholder="搜索技能"
            />
            <div className="skills-sec">已安装</div>
            {skillLibrary.length ? (
              <div className="skill-grid">
                {skillLibrary.map((item) => (
                  <div className="skill-card" key={`${item.source}-${item.name}`}>
                    <span className="skill-mark" style={{ background: skillHue(item.name) }}>
                      {(item.label || item.name).slice(0, 1)}
                    </span>
                    <div className="skill-copy">
                      <b>{item.label || item.name}</b>
                      <small>{item.description || item.name}</small>
                    </div>
                    <div className="skill-meta">
                      {skillSourceLabel(item.source) ? (
                        <em className="skill-src">{skillSourceLabel(item.source)}</em>
                      ) : null}
                      <span className={`skill-check ${item.removable ? "idle" : ""}`}>
                        <IconCheck />
                      </span>
                      {item.removable ? (
                        <button
                          type="button"
                          className="skill-remove"
                          title="删除"
                          onClick={() =>
                            setConfirm({
                              kind: "skill",
                              dir: item.dir,
                              title: `删除「${item.label || item.name}」？`,
                              detail: "删掉后不能恢复。",
                            })
                          }
                        >
                          <IconClose />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="skills-empty">
                <p>{skillQuery.trim() ? "没有匹配的技能" : "还没有技能"}</p>
                {skillQuery.trim() ? null : (
                  <button type="button" className="btn primary" onClick={importSkills}>
                    导入
                  </button>
                )}
              </div>
            )}
          </section>
        ) : null}
        <div className={paneParked ? "chat-pane is-parked" : "chat-pane"} aria-hidden={paneParked || undefined}>
        <header className="top">
          <div className="crumb">{appState.cwd || "选择一个项目"}</div>
          {headerRight}
        </header>

        {!appState.grokFound ? (
          <section className="blank">
            <h1>还没找到 Grok Build</h1>
            <p>先在这台电脑上装好 Grok，再打开 Halora。</p>
          </section>
        ) : !appState.cwd ? (
          <section className="blank">
            <h1>从这儿开始</h1>
            <p>选一个项目，就可以直接跟它说话。</p>
            <button className="btn primary" onClick={openFolder}>
              新建项目
            </button>
          </section>
        ) : (
          <>
            <div
              className="thread"
              ref={scroller}
              onScroll={(event) => {
                if (parkedRef.current || Date.now() < pinLock.current) return;
                const el = event.currentTarget;
                if (el.clientHeight < 32) return;
                stickBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 96;
              }}
            >
              {messages.length === 0 && !appState.running ? (
                <div className="blank in-thread">
                  <h1>{project}</h1>
                  <p>想改什么，直接说。</p>
                </div>
              ) : null}

              {messages.map((message) =>
                message.kind === "compact" ? (
                  <div key={message.id} className="compact-note">
                    {message.before != null &&
                    message.after != null &&
                    message.after < message.before
                      ? `已压缩 ${formatTokens(message.before)} → ${message.estimated ? "约 " : ""}${formatTokens(message.after)}`
                      : "压缩完成"}
                  </div>
                ) : message.role === "user" ? (
                  <article key={message.id} className="bubble user">
                    {message.images?.length ? (
                      <div className="pics">
                        {message.images.map((image, index) => (
                          <ChatImage
                            key={image.path || image.src || index}
                            image={image}
                            cwd={appState.cwd}
                          />
                        ))}
                      </div>
                    ) : null}
                    {message.files?.length ? (
                      <div className="file-pills">
                        {message.files.map((file, index) => (
                          <span
                            key={file.path || index}
                            className="file-pill"
                            data-path={file.path || ""}
                          >
                            {file.name || file.path}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {message.text ? <div className="md">{message.text}</div> : null}
                  </article>
                ) : (
                  <article key={message.id} className="bubble assistant">
                    {(() => {
                      const runningTurn = message.id === liveAssistantId;
                      const duration = messageDuration(
                        message,
                        runningTurn,
                        now,
                        turnStartRef.current[appState.sessionId]
                      );
                      const folded = Boolean(String(message.thought || "").trim() || message.tools?.length);
                      return (
                        <>
                          <RunFold
                            thought={message.thought}
                            tools={message.tools}
                            cwd={appState.cwd}
                            running={runningTurn}
                            duration={duration}
                          />
                          {!folded && duration ? <div className="turn-time">{duration}</div> : null}
                        </>
                      );
                    })()}
                    {message.images?.length ? (
                      <div className="pics">
                        {message.images.map((image, index) => (
                          <ChatImage
                            key={image.path || image.src || index}
                            image={image}
                            cwd={appState.cwd}
                          />
                        ))}
                      </div>
                    ) : null}
                    <MarkdownView text={message.text} />
                  </article>
                )
              )}

              {compactPhase === "start" ? (
                <div className="pulse">正在压缩</div>
              ) : appState.running && !liveAssistantId ? (
                <div className="turn-time">{pendingDuration || "用时 0秒"}</div>
              ) : null}
            </div>

            {error ? <div className="toast">{error}</div> : null}

            <form
              className={`composer-wrap ${dragging ? "drag" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
              onPaste={onPaste}
            >
              {attachments.length ? (
                <div className="chips">
                  {attachments.map((item) => (
                    <div
                      key={item.id}
                      className={`chip ${item.kind === "file" || item.kind === "folder" ? "file" : ""}`}
                      data-path={item.path || ""}
                    >
                      {item.kind === "file" || item.kind === "folder" ? (
                        <span className="chip-name">
                          {item.kind === "folder" ? <IconFolder /> : null}
                          <span>{item.name}</span>
                        </span>
                      ) : (
                        <ChatImage image={item} />
                      )}
                      <button
                        type="button"
                        className="chip-x"
                        aria-label="去掉"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((one) => one.id !== item.id))
                        }
                      >
                        <IconClose size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {queue.length ? (
                <div className="queue">
                  {!appState.running && <button type="button" className="btn ghost" onClick={() => { const first = queue[0]; queueFor(appState.sessionId, rows => rows.slice(1)); sendNow(first, appState.sessionId); }}>继续发送队列（{queue.length}）</button>}
                  {queue.map((item) => (
                    <div key={item.id} className="queue-row">
                      <div className="queue-main">
                        {item.images?.[0]?.src ? <img src={item.images[0].src} alt="" /> : null}
                        <span>
                          {item.compact
                            ? "压缩对话"
                            : item.text || item.files?.[0]?.name || item.images?.[0]?.name || "附件"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="queue-steer"
                        onClick={() => steer(item.id)}
                      >
                        马上发
                      </button>
                      <button
                        type="button"
                        className="queue-x"
                        aria-label="去掉"
                        onClick={() => removeQueued(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {menuOpen ? (
                <div className="suggest" ref={suggestRef}>
                  {mention
                    ? fileHits.map((item, index) => (
                        <button
                          type="button"
                          key={item.path}
                          className={index === suggestIndex ? "active" : ""}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            insertMention(item);
                          }}
                        >
                          <b>{item.name}</b>
                          <small>{item.path}</small>
                        </button>
                      ))
                    : slashHits.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.kind}-${item.name}`}
                          className={index === suggestIndex ? "active" : ""}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            fillSlash(item);
                          }}
                        >
                          <b>/{item.name}</b>
                          <small>
                            {item.kind === "skill" ? "skill · " : ""}
                            {item.title}
                          </small>
                        </button>
                      ))}
                </div>
              ) : null}
              <div className="composer-card">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setCaret(event.target.selectionStart || 0);
                  }}
                  onClick={(event) => setCaret(event.target.selectionStart || 0)}
                  onKeyUp={(event) => setCaret(event.target.selectionStart || 0)}
                  onKeyDown={onKeyDown}
                  placeholder="想让我做什么"
                  rows={2}
                  disabled={!appState.cwd}
                />
                <div className="composer-bar">
                  {quota ? (
                    <div className="ctx-wrap" ref={quotaRef}>
                      <button
                        type="button"
                        className={`ctx-chip ${quota.percent >= 80 ? "hot" : ""}`}
                        onClick={() => {
                          setShowContext(false);
                          setShowQuota((open) => !open);
                        }}
                        title="额度"
                      >
                        <CtxRing percent={quota.percent ?? 0} />
                        <span>
                          {quota.percent == null ? '额度暂不可用' : `${quota.window || '额度'} ${quota.percent}%${quota.status === 'stale' ? ' · 缓存' : ''}`}
                        </span>
                      </button>
                      {showQuota ? (
                        <div className="ctx-pop quota-pop">
                          <div className="ctx-head">
                            <span>{quota.window}已用</span>
                            <b>{quota.percent == null ? '未知' : `${quota.percent}%`}</b>
                          </div>
                          {quota.plan ? <CtxRow label="方案" value={quota.plan} /> : null}
                          {quota.percent != null && <CtxRow label="剩余" value={`${Math.max(0, 100 - quota.percent)}%`} />}
                          {quota.error && <p className="ctx-note">{quota.error}</p>}
                          {quota.updatedAt && <CtxRow label="更新于" value={new Date(quota.updatedAt).toLocaleString()} />}
                          <button type="button" className="ctx-compact" onClick={() => api.refreshQuota().then(next => setAppState(p => ({ ...p, ...next }))).catch(e => setError(friendlyError(e)))}>刷新额度</button>
                          {Number.isFinite(quota.resets) ? (
                            <CtxRow label="重置卡" value={`${quota.resets} 张`} />
                          ) : null}
                          {quota.resets > 0 && quota.resetCardUntil ? (
                            <CtxRow
                              label={quota.resets > 1 ? "最近到期" : "有效至"}
                              value={formatReset(quota.resetCardUntil).when}
                            />
                          ) : null}
                          {quotaReset.when ? (
                            <>
                              <div className="ctx-sec">下次重置</div>
                              <CtxRow label={quotaReset.when} value={quotaReset.left} />
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {quota ? <span className="composer-split" aria-hidden="true" /> : null}
                  <button
                    type="button"
                    className="btn icon"
                    onClick={pickFiles}
                    disabled={!appState.cwd}
                    title="添加附件"
                    aria-label="添加附件"
                  >
                    <IconPlus />
                  </button>
                  {context ? (
                    <div className="ctx-wrap" ref={ctxRef}>
                      <button
                        type="button"
                        className={`ctx-chip ${context.percent >= (context.autoCompact || 85) ? "hot" : ""}`}
                        onClick={() => {
                          setShowQuota(false);
                          setShowContext((open) => !open);
                        }}
                        title="上下文"
                      >
                        <CtxRing percent={context.percent} />
                        <span>
                          {context.estimated ? "约 " : ""}{formatTokens(context.used)}/{formatTokens(context.total)}
                        </span>
                      </button>
                      {showContext ? (
                        <div className="ctx-pop">
                          <div className="ctx-head">
                            <span>已用</span>
                            <b>
                              {context.estimated ? "约 " : ""}{formatCount(context.used)} / {formatCount(context.total)} ({context.percent}%)
                            </b>
                          </div>
                          <button
                            type="button"
                            className="ctx-compact"
                            onClick={() => compactChat()}
                            disabled={busy || appState.running || !appState.sessionId}
                          >
                            压缩对话
                          </button>
                          <div className="ctx-sec">当前窗口</div>
                          <CtxRow label="系统" value={formatCount(context.system)} />
                          <CtxRow label="对话" value={formatCount(context.messages)} />
                          <CtxRow label="思考" value={formatCount(context.reasoning)} />
                          <CtxRow label="空闲" value={formatCount(context.free)} />
                          <div className="ctx-note">到 {context.autoCompact || 85}% 自动压缩</div>
                          <div className="ctx-sec">已计入上面</div>
                          <CtxRow
                            label="工具"
                            note={context.tools?.count ? `(${context.tools.count})` : ""}
                            value={formatCount(context.tools?.tokens)}
                          />
                          <CtxRow
                            label="Skills"
                            note={context.skills?.count ? `(${context.skills.count})` : ""}
                            value={formatCount(context.skills?.tokens)}
                          />
                          <CtxRow
                            label="工作流"
                            note={context.workflows?.count ? `(${context.workflows.count})` : ""}
                            value={formatCount(context.workflows?.tokens)}
                          />
                          {context.sessionInput || context.sessionOutput ? (
                            <>
                              <div className="ctx-sec">本会话</div>
                              <CtxRow label="输入" value={formatCount(context.sessionInput)} />
                              {context.sessionCache ? (
                                <CtxRow label="缓存命中" value={formatCount(context.sessionCache)} />
                              ) : null}
                              <CtxRow label="输出" value={formatCount(context.sessionOutput)} />
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="composer-spacer" />
                  <div className="mode-wrap" ref={modeRef}>
                    <button
                      type="button"
                      className={`mode-btn ${showMode ? "open" : ""}`}
                      onClick={() => setShowMode((open) => !open)}
                    >
                      <ModeIcon />
                      {currentMode.label}
                    </button>
                    {showMode ? (
                      <div className="mode-pop">
                        {MODES.map((item) => {
                          const ItemIcon = item.Icon;
                          return (
                            <button
                              type="button"
                              key={item.id}
                              className={`mode-item ${item.id === permissionMode ? "active" : ""}`}
                              onClick={() => changeMode(item.id)}
                            >
                              <span className="mode-ico">
                                <ItemIcon />
                              </span>
                              <span>
                                <b>{item.label}</b>
                                <small>{item.hint}</small>
                              </span>
                              <span className="mode-check">{item.id === permissionMode ? "✓" : ""}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  <button className="send-btn" disabled={!canSend} aria-label="发送">
                    <IconSend />
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
        </div>
      </main>

      {menu ? (
        <div
          ref={menuRef}
          className="menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          {menu.kind === "project" ? (
            <>
              <button type="button" onMouseDown={() => runMenu("pin-project")}>
                {menu.pinned ? "取消置顶" : "置顶"}
              </button>
              <button type="button" onMouseDown={() => runMenu("edit-project")}>
                编辑
              </button>
              <button type="button" className="danger" onMouseDown={() => runMenu("delete-project")}>
                删除
              </button>
            </>
          ) : menu.kind === "file" ? (
            <>
              <button type="button" onMouseDown={() => runMenu("open-path")}>
                打开
              </button>
              <button type="button" onMouseDown={() => runMenu("show-in-folder")}>
                在文件夹中显示
              </button>
              <button type="button" onMouseDown={() => runMenu("copy-path")}>
                复制路径
              </button>
            </>
          ) : (
            <>
              <button type="button" onMouseDown={() => runMenu("pin-chat")}>
                {menu.pinned ? "取消置顶" : "置顶"}
              </button>
              <button type="button" onMouseDown={() => runMenu("edit-chat")}>
                编辑
              </button>
              <button type="button" className="danger" onMouseDown={() => runMenu("delete-chat")}>
                删除
              </button>
            </>
          )}
        </div>
      ) : null}

      {confirm ? (
        <div className="overlay">
          <div className="modal">
            <h2>{confirm.title}</h2>
            {confirm.detail ? <p className="modal-note">{confirm.detail}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className={`btn ${confirm.kind === "replace-skill" ? "primary" : "danger"}`}
                onClick={applyConfirm}
              >
                {confirm.ok || "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {permission ? (
        <div className="overlay">
          <div className="modal">
            <div className="permission-tabs">{permissionItems.map(item => <button key={item.requestId} className={`btn ${item === permission ? 'primary' : 'ghost'}`} onClick={() => { setSelectedPermission(item.requestId); setPermissionError(''); }}>{item.sessionTitle || item.sessionId?.slice(0, 8) || '当前对话'}</button>)}</div>
            <p className="permission-origin">{permission.cwd} · {permissionItems.length} 项待处理</p>
            <h2>{permission.title}</h2>
            {permissionError && <p role="alert">{permissionError}</p>}
            {inputPreview(permission.input) ? <code>{inputPreview(permission.input)}</code> : null}
            <div className="modal-actions">
              {(permission.options?.length
                ? permission.options
                : [
                    { id: "__cancel__", name: "取消请求", kind: "reject_once" },
                  ]
              ).map((option) => (
                <button
                  key={option.id}
                  className={`btn ${optionTone(option)}`}
                  onClick={() => api.answerPermission(permission.requestId, option.id).catch(e => setPermissionError(friendlyError(e)))}
                >
                  {optionLabel(option)}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <button
            type="button"
            className="lightbox-x"
            aria-label="关闭"
            onClick={(event) => {
              event.stopPropagation();
              setPreview(null);
            }}
          >
            <IconClose />
          </button>
          <img
            className="lightbox-img"
            src={preview.src}
            alt={preview.name || ""}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
    </PreviewContext.Provider>
  );
}
