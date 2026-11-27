#!/usr/bin/env node
// SessionStart hook for Claude Code and Codex: adds the context-eng memory
// instructions (rules/AGENTS.md) to the session, plus the project root the
// agent should pass as projectPath. Never blocks the session: on any error it
// prints nothing and exits 0.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

try {
  const input = readStdin();
  const rules = readFileSync(path.join(root, "rules", "AGENTS.md"), "utf8").trim();
  const project = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const context = `${rules}\n\nThis session's project root is \`${project}\`. Pass it as \`projectPath\` to project-scoped memory tools.`;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  })}\n`);
} catch {
  // Fail open: missing instructions must never stop a session.
}
process.exit(0);
