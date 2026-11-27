#!/usr/bin/env node
// Starts the context-eng MCP server for a plugin host (Claude Code, Codex,
// Antigravity, OpenCode). It picks the first of:
//   1. $CONTEXT_ENG_ENTRY: an explicit path to context-eng's dist/cli-entry.js
//   2. the global npm install (`npm install -g context-eng`), run with this Node
//   3. a `context-eng` command on PATH (pnpm, yarn, or another global install)
//   4. `npx -y context-eng@latest`, run from the temp folder so npx never
//      resolves a local package that happens to share the name
// stdin/stdout pass straight through, because MCP speaks JSON-RPC over stdio.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const args = process.argv.length > 2 ? process.argv.slice(2) : ["mcp"];

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function globalEntry() {
  const result = spawnSync(isWindows ? "npm.cmd" : "npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: isWindows,
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const prefix = result.stdout.trim();
  const modules = isWindows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const entry = path.join(modules, "context-eng", "dist", "cli-entry.js");
  return isFile(entry) ? entry : null;
}

function commandOnPath() {
  const names = isWindows ? ["context-eng.cmd", "context-eng.exe"] : ["context-eng"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      if (isFile(file)) return file;
    }
  }
  return null;
}

function pickLaunch() {
  const explicit = process.env.CONTEXT_ENG_ENTRY;
  if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit, ...args] };
  const entry = globalEntry();
  if (entry) return { command: process.execPath, args: [entry, ...args] };
  const onPath = commandOnPath();
  if (onPath) return { command: onPath, args, shell: isWindows };
  return {
    command: isWindows ? "npx.cmd" : "npx",
    args: ["-y", "context-eng@latest", ...args],
    cwd: os.tmpdir(),
    shell: isWindows,
  };
}

const launch = pickLaunch();
const child = spawn(launch.command, launch.args, {
  stdio: "inherit",
  cwd: launch.cwd ?? process.cwd(),
  shell: launch.shell ?? false,
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`context-eng plugin: could not start the MCP server (${error.message}). Install Node.js 20+ and run: npm install -g context-eng\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
