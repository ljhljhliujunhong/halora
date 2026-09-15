function normalizeMode(mode) {
  return ["agent", "plan", "yolo"].includes(mode) ? mode : "agent";
}

function agentSpawnArgs() {
  return ["--permission-mode", "default", "agent", "--no-leader", "stdio"];
}

function sessionMeta(mode) {
  return { yoloMode: normalizeMode(mode) === "yolo" };
}

function modeSyncCommands(from, to) {
  const have = normalizeMode(from);
  const want = normalizeMode(to);
  if (have === want) return [];
  const cmds = [];
  if ((have === "yolo") !== (want === "yolo")) cmds.push("/always-approve");
  if ((have === "plan") !== (want === "plan")) cmds.push("/plan");
  return cmds;
}

module.exports = { normalizeMode, agentSpawnArgs, sessionMeta, modeSyncCommands };
