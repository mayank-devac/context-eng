#!/usr/bin/env node
// Points git at .githooks/ so the pre-commit prompt sync runs. Runs from the
// npm `prepare` script; does nothing outside a git checkout of this repo or
// when the user already chose a different hooks folder.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

try {
  if (!existsSync(path.join(root, ".githooks", "pre-commit"))) process.exit(0);
  if (git("rev-parse", "--show-toplevel") !== root) process.exit(0);
  let current = "";
  try {
    current = git("config", "--get", "core.hooksPath");
  } catch {
    // Not set.
  }
  if (current && current !== ".githooks") {
    console.log(`install-git-hooks: core.hooksPath is already ${current}; left unchanged. Run .githooks/pre-commit from your own hook to keep prompts in sync.`);
    process.exit(0);
  }
  if (current !== ".githooks") git("config", "core.hooksPath", ".githooks");
} catch {
  // Not a git checkout (for example an npm tarball): nothing to install.
}
