#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const repo = path.join(root, "vendor", "telegram-mcp");

const env = { ...process.env };
const forwardedArgs = process.argv.slice(2);
env.TELEGRAM_API_ID = env.TELEGRAM_API_ID || env.TG_API_ID || "";
env.TELEGRAM_API_HASH = env.TELEGRAM_API_HASH || env.TG_API_HASH || "";
env.TELEGRAM_SESSION_STRING = env.TELEGRAM_SESSION_STRING || env.TG_USER_SESSION || "";

let command;
let args = [];
let cwd = repo;

function exists(file) {
  try {
    fs.accessSync(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function commandSucceeds(cmd, cmdArgs, options = {}) {
  if (!exists(cmd)) return false;
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd || repo,
    env: options.env || env,
    stdio: "ignore",
  });
  return !result.error && (result.status ?? 1) === 0;
}

function hasUsableLinuxVenv(venvPython, venvExe) {
  return (
    exists(venvPython) &&
    exists(venvExe) &&
    commandSucceeds(venvPython, ["--version"]) &&
    commandSucceeds(venvPython, [
      "-c",
      "import telegram_mcp, mcp, telethon",
    ])
  );
}

if (process.platform === "win32") {
  command = path.join(repo, ".venv-runtime", "Scripts", "python.exe");
  args = [path.join(repo, "main.py"), ...forwardedArgs];
} else {
  const venvDir = path.join(repo, ".venv-linux");
  const exe = path.join(venvDir, "bin", "telegram-mcp");
  const python = path.join(venvDir, "bin", "python");
  const uv = path.join(root, "vendor", "uv", "linux", "uv");

  env.UV_PROJECT_ENVIRONMENT = venvDir;
  env.UV_PYTHON_INSTALL_DIR = path.join(root, "vendor", "uv", "python");
  env.UV_LINK_MODE = "copy";

  if (hasUsableLinuxVenv(python, exe)) {
    command = exe;
    args = forwardedArgs;
  } else {
    command = uv;
    args = ["run", "--project", repo, "telegram-mcp", ...forwardedArgs];
  }
}

if (!command || !exists(command)) {
  console.error(`telegram-mcp launcher missing command: ${command || "<unset>"}`);
  process.exit(1);
}

const child = spawn(command, args, {
  cwd,
  env,
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error(`telegram-mcp launcher failed to start ${command}: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
