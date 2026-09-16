function normalizeMode(mode) {
  return ["agent", "plan", "yolo"].includes(mode) ? mode : "agent";
}

function agentSpawnArgs() {
  return ["--permission-mode", "default", "agent", "--no-leader", "stdio"];
}

function sessionMeta(mode) {
  return { yoloMode: normalizeMode(mode) === "yolo" };
}

// Grok exposes plan mode as an ACP session mode ("plan" / "default") and
// always-approve as a separate flag. Halora's picker is exclusive, so switching
// into plan turns always-approve off and vice versa.
function grokModeId(mode) {
  return normalizeMode(mode) === "plan" ? "plan" : "default";
}

function modeSyncSteps(from, to) {
  const have = normalizeMode(from);
  const want = normalizeMode(to);
  const steps = {};
  if ((have === "yolo") !== (want === "yolo")) steps.yolo = want === "yolo";
  if ((have === "plan") !== (want === "plan")) steps.mode = grokModeId(want);
  return steps;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

// Grok's x.ai methods mix ACP camelCase with Rust snake_case. Accept both,
// and fall back to the in-flight prompt's session when the request omits it.
function incomingSessionId(params, fallback) {
  return String(pick(params, "sessionId", "session_id") || fallback || "");
}

function planRequest(params, fallbackSessionId) {
  const src = params && typeof params === "object" ? params : {};
  return {
    sessionId: incomingSessionId(src, fallbackSessionId),
    toolCallId: pick(src, "toolCallId", "tool_call_id") || null,
    planContent: String(pick(src, "planContent", "plan_content", "plan") || ""),
    planFilePath: pick(src, "planFilePath", "plan_file_path") || "",
  };
}

function questionRequest(params, fallbackSessionId) {
  const src = params && typeof params === "object" ? params : {};
  const raw = src.questions || src.input?.questions || [];
  const questions = (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      question: String(item?.question || "").trim(),
      multiSelect: Boolean(item?.multiSelect ?? item?.multi_select),
      options: (item?.options || [])
        .map((opt) => ({
          label: String(opt?.label || "").trim(),
          description: String(opt?.description || "").trim(),
        }))
        .filter((opt) => opt.label),
    }))
    .filter((item) => item.question);
  return {
    sessionId: incomingSessionId(src, fallbackSessionId),
    toolCallId: pick(src, "toolCallId", "tool_call_id") || null,
    questions,
  };
}

// ExitPlanModeExtResponse is a two-field struct. Always send both so a
// required `feedback` field does not reject an otherwise valid decision.
function planReply(outcome, feedback) {
  const decision = ["approved", "revise", "abandoned"].includes(outcome) ? outcome : "revise";
  return { outcome: decision, feedback: String(feedback || "") };
}

// AskUserQuestionExtResponse is internally tagged. Include both the Rust
// variant name and a snake_case `outcome` so either tag still parses.
function questionReply(outcome, answers) {
  if (outcome === "accepted") {
    return {
      type: "Accepted",
      outcome: "accepted",
      answers: answers && typeof answers === "object" ? answers : {},
      partial_answers: {},
    };
  }
  if (outcome === "skip_interview") return { type: "SkipInterview", outcome: "skip_interview" };
  return { type: "ChatAboutThis", outcome: "chat_about_this" };
}

module.exports = {
  normalizeMode,
  agentSpawnArgs,
  sessionMeta,
  grokModeId,
  modeSyncSteps,
  incomingSessionId,
  planRequest,
  questionRequest,
  planReply,
  questionReply,
};
