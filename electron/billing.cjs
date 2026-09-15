const fs = require("node:fs");
const path = require("node:path");
const { grokHome } = require("./grok-path.cjs");

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const RESETS_URL = "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
const CACHE_MS = 90_000;
const EMPTY_GRPC = Buffer.from([0, 0, 0, 0, 0]);

let cached = { at: 0, value: null };
let inflight = null;

function readAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(grokHome(), "auth.json"), "utf8"));
    const rows = Object.values(raw || {}).filter((item) => item && item.key);
    rows.sort((a, b) => Date.parse(b.expires_at || 0) - Date.parse(a.expires_at || 0));
    return rows[0] || null;
  } catch {
    return null;
  }
}

function windowLabel(type) {
  const blob = String(type || "");
  if (/WEEKLY/i.test(blob)) return "本周";
  if (/MONTHLY/i.test(blob)) return "本月";
  return "本期";
}

function readVarint(buf, offset) {
  let n = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = BigInt(buf[i++]);
    n |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) break;
    shift += 7n;
    if (shift > 63n) break;
  }
  return [n, i];
}

function asUnixMs(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 1_000_000_000 || n > 4_000_000_000) return null;
  return n * 1000;
}

function parseTimestamp(buf) {
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const [n, next] = readVarint(buf, i);
      i = next;
      if (field === 1) return asUnixMs(n);
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const [len, next] = readVarint(buf, i);
      i = next + Number(len);
    } else break;
  }
  return null;
}

function parseResetToken(buf) {
  let i = 0;
  let until = null;
  while (i < buf.length) {
    const key = buf[i++];
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const [n, next] = readVarint(buf, i);
      i = next;
      const ms = asUnixMs(n);
      if (ms && (field === 2 || field === 3)) until = until == null ? ms : Math.min(until, ms);
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const [lenBig, next] = readVarint(buf, i);
      const len = Number(lenBig);
      const inner = buf.subarray(next, next + len);
      i = next + len;
      if (field === 1) continue;
      const iso = inner.toString("utf8");
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed) && (field === 2 || field === 3)) {
        until = until == null ? parsed : Math.min(until, parsed);
        continue;
      }
      const ts = parseTimestamp(inner);
      if (ts) until = until == null ? ts : Math.min(until, ts);
    } else break;
  }
  return { until };
}

function parseResetTokens(buf) {
  const tokens = [];
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const [, next] = readVarint(buf, i);
      i = next;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const [lenBig, next] = readVarint(buf, i);
      const len = Number(lenBig);
      const inner = buf.subarray(next, next + len);
      i = next + len;
      if (field === 1) tokens.push(parseResetToken(inner));
    } else break;
  }
  return tokens;
}

function parseGrpcWeb(buf) {
  let i = 0;
  let data = Buffer.alloc(0);
  let trailer = "";
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    if (i + len > buf.length) break;
    const payload = buf.subarray(i, i + len);
    i += len;
    if (flags & 0x80) trailer += payload.toString("utf8");
    else if (!(flags & 1)) data = payload;
  }
  const status = /grpc-status:\s*(\d+)/i.exec(trailer);
  if (status && status[1] !== "0") throw new Error(`grpc ${status[1]}`);
  return data;
}

function summarizeResets(tokens) {
  const now = Date.now();
  const live = tokens.filter((item) => !item.until || item.until > now);
  const until = live.reduce((min, item) => {
    if (!item.until) return min;
    return min == null ? item.until : Math.min(min, item.until);
  }, null);
  return {
    count: live.length,
    until: until ? new Date(until).toISOString() : null,
  };
}

function parseQuota(billing, settings, resets) {
  const config = billing?.config || billing || {};
  const period = config.currentPeriod || {};
  const products = Array.isArray(config.productUsage) ? config.productUsage : [];
  const build = products.find((item) => /grok_?build/i.test(String(item.product || "")));
  // The unified allowance is shared across products. Prefer its total usage.
  let value = config.creditUsagePercent ?? build?.usagePercent;
  const validPeriod = /^USAGE_PERIOD_TYPE_(WEEKLY|MONTHLY)$/.test(period.type || '') &&
    Number.isFinite(Date.parse(period.start)) && Date.parse(period.end) > Date.parse(period.start);
  const creditShape = config.isUnifiedBillingUser === true && validPeriod &&
    ['onDemandCap', 'onDemandUsed', 'prepaidBalance'].every(key =>
      config[key] && typeof config[key] === 'object' && !Array.isArray(config[key]));
  // ProtoJSON omits scalar zeroes. Only default a recognized credits response,
  // never an empty response, explicit null, or a different product's usage.
  if (value === undefined && !Object.hasOwn(config, 'creditUsagePercent') &&
      creditShape && products.length === 0) value = 0;
  const percent = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    resetAt: period.end || config.billingPeriodEnd || null,
    window: windowLabel(period.type),
    plan: settings?.subscription_tier_display || "",
    resets: Number.isFinite(resets?.count) ? resets.count : null,
    resetCardUntil: resets?.until || null,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`billing ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchResets(token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(RESETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        "Content-Type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        Accept: "application/grpc-web+proto",
        Origin: "https://grok.com",
        Referer: "https://grok.com/?_s=usage",
      },
      body: EMPTY_GRPC,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`resets ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const headerStatus = res.headers.get("grpc-status");
    if (headerStatus && headerStatus !== "0") throw new Error(`grpc ${headerStatus}`);
    const data = parseGrpcWeb(buf);
    return summarizeResets(parseResetTokens(data));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchQuota({ force } = {}) {
  const now = Date.now();
  if (!force && cached.value && now - cached.at < CACHE_MS) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const auth = readAuth();
    if (!auth?.key) throw new Error('尚未登录');
    const [billing, settings, resets] = await Promise.all([
      fetchJson(BILLING_URL, auth.key),
      fetchJson(SETTINGS_URL, auth.key).catch(() => null),
      fetchResets(auth.key).catch(() => null),
    ]);
    const next = parseQuota(billing, settings, resets);
    if (!next) throw new Error('额度接口未返回有效用量，请稍后重试');
    if (next) cached = { at: Date.now(), value: next };
    return cached.value;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function hasAuth() {
  return Boolean(readAuth()?.key);
}

module.exports = { fetchQuota, hasAuth, parseQuota, parseResetTokens, parseGrpcWeb, summarizeResets };
