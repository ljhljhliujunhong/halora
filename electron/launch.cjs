const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const extraArgs = process.argv.slice(2);
const child = spawn(electronPath, [".", ...extraArgs], {
  cwd: path.join(__dirname, ".."),
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (code === null) process.exit(signal ? 1 : 0);
  process.exit(code);
});
