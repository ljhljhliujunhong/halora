function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(filePath || ""));
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
    if (raw.path && isImagePath(raw.path)) {
      push({ path: raw.path, name: raw.filename });
    }
  }
  const bits = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const text = item?.content?.text || item?.text;
      if (text) bits.push(text);
    }
  }
  for (const text of bits) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.path && isImagePath(parsed.path)) {
        push({ path: parsed.path, name: parsed.filename });
      }
    } catch {
      // ignore
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

function lastOf(messages) {
  return messages[messages.length - 1];
}

function cloneMessages(messages) {
  return messages.map((message) =>
    message.role === "assistant"
      ? {
          ...message,
          tools: (message.tools || []).map((tool) => ({ ...tool, images: [...(tool.images || [])] })),
          images: [...(message.images || [])],
        }
      : { ...message, images: [...(message.images || [])] }
  );
}

function ensureAssistant(messages) {
  const last = lastOf(messages);
  if (last?.role === "assistant") return last;
  const next = {
    id: `a-${messages.length}-${Date.now()}`,
    role: "assistant",
    text: "",
    thought: "",
    tools: [],
    images: [],
  };
  messages.push(next);
  return next;
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
  return "";
}

export function applyUpdate(messages, update) {
  if (!update) return messages;
  const kind = update.sessionUpdate;
  if (
    kind === "available_commands_update" ||
    kind === "current_mode_update" ||
    kind === "session_info_update"
  ) {
    return messages;
  }
  const next = cloneMessages(messages);

  if (kind === "user_message_chunk") {
    const chunk = update.content?.text || "";
    const imgs = collectImages(update);
    const last = lastOf(next);
    if (last?.role === "user" && last.id?.startsWith("local-")) {
      last.text = last.text || chunk;
      if (chunk && !last.text.includes(chunk) && !chunk.includes(last.text)) last.text = chunk;
      if (imgs.length && !(last.images || []).length) last.images = imgs;
    } else if (last?.role === "user") {
      last.text += chunk;
      if (imgs.length) last.images = [...(last.images || []), ...imgs];
    } else {
      next.push({
        id: `u-${next.length}-${Date.now()}`,
        role: "user",
        text: chunk,
        images: imgs,
      });
    }
    return next;
  }

  if (kind === "agent_thought_chunk") {
    ensureAssistant(next).thought += update.content?.text || "";
    return next;
  }

  if (kind === "agent_message_chunk") {
    ensureAssistant(next).text += update.content?.text || "";
    return next;
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const assistant = ensureAssistant(next);
    const id = update.toolCallId;
    if (!id) return next;
    let tool = assistant.tools.find((item) => item.id === id);
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
    const output = stripImageJson(extractToolOutput(update));
    if (output) tool.output = output;
    const imgs = collectImages(update);
    if (imgs.length) {
      tool.images = [...(tool.images || []), ...imgs];
      assistant.images = [...(assistant.images || []), ...imgs];
    }
    return next;
  }

  return messages;
}
