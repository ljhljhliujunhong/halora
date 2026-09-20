const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const LABELS = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
  max: "最高",
};

function normalizeEffort(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!raw) return "";
  if (raw === "extrahigh" || raw === "max" || raw === "最高" || raw === "极高") return "xhigh";
  if (raw === "off" || raw === "disabled" || raw === "关闭") return "none";
  if (raw === "最低") return "minimal";
  if (raw === "低") return "low";
  if (raw === "中" || raw === "中等") return "medium";
  if (raw === "高") return "high";
  return ORDER.includes(raw) ? raw : "";
}

function labelFor(id) {
  return LABELS[id] || id;
}

function sortOptions(list) {
  return [...list].sort((a, b) => {
    const ia = ORDER.indexOf(a.id);
    const ib = ORDER.indexOf(b.id);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  });
}

function defaultEffortOptions() {
  return sortOptions(["low", "medium", "high", "xhigh"].map((id) => ({ id, label: labelFor(id) })));
}

function optionList(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = normalizeEffort(item?.value ?? item?.id ?? item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: labelFor(id) });
  }
  return sortOptions(out);
}

function optionSource(raw) {
  if (!raw || typeof raw !== "object") return [];
  return raw.options || raw.kind?.options || raw.value?.options || [];
}

function currentSource(raw) {
  if (!raw || typeof raw !== "object") return "";
  return raw.currentValue ?? raw.kind?.currentValue ?? raw.value?.value ?? raw.value ?? raw.current;
}

function clampEffort(want, options) {
  const id = normalizeEffort(want);
  if (!id) return "";
  const ids = (Array.isArray(options) ? options : []).map((item) => item?.id || item).filter(Boolean);
  const list = ids.length ? ids : defaultEffortOptions().map((item) => item.id);
  if (list.includes(id)) return id;
  if (id === "none" || id === "minimal") return list[0] || "";
  if (id === "max") return list[list.length - 1] || "";
  const target = ORDER.indexOf(id);
  let best = list[0] || "";
  let bestDist = Infinity;
  for (const item of list) {
    const dist = Math.abs(ORDER.indexOf(item) - target);
    if (dist < bestDist) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

function parseConfigOptions(list) {
  const items = Array.isArray(list) ? list : [];
  const raw = items.find((item) => {
    const id = String(item?.configId || item?.id || "");
    const category = String(item?.category || item?.kind?.category || "");
    return id === "reasoning_effort" || id === "thought_level" || category === "thought_level";
  });
  if (!raw) return null;
  const parsed = optionList(optionSource(raw));
  const options = parsed.length ? parsed : defaultEffortOptions();
  const current = normalizeEffort(currentSource(raw));
  return {
    current: current && options.some((item) => item.id === current) ? current : "",
    options,
  };
}

function configFromResult(result) {
  if (!result) return null;
  if (Array.isArray(result)) return parseConfigOptions(result);
  return parseConfigOptions(result.configOptions || result.config_options);
}

function effortFromSummary(summary) {
  const current = normalizeEffort(summary?.reasoning_effort);
  if (!current) return null;
  const options = defaultEffortOptions();
  if (!options.some((item) => item.id === current)) options.push({ id: current, label: labelFor(current) });
  return { current, options: sortOptions(options) };
}

module.exports = {
  ORDER,
  normalizeEffort,
  labelFor,
  defaultEffortOptions,
  clampEffort,
  parseConfigOptions,
  configFromResult,
  effortFromSummary,
};
