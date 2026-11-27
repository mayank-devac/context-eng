// Markers around the context-eng instructions block that init writes into
// rules files (AGENTS.md, CLAUDE.md, ...). doctor looks for the same start marker.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER_START = "<!-- context-eng:start -->";
export const MARKER_END = "<!-- context-eng:end -->";

/** Package root: one level above src/ (tests) or dist/ (npm install). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The memory instructions from system_prompts/AGENTS.md, without markers.
 * init writes them into rules files; the MCP server sends them as its
 * `instructions`, so hosts without hooks (like the Codex directory) still get them.
 */
export function memoryInstructions(): string {
  const raw = readFileSync(path.join(packageRoot(), "system_prompts", "AGENTS.md"), "utf8");
  const start = raw.indexOf(MARKER_START);
  const end = raw.indexOf(MARKER_END);
  const inner = start !== -1 && end !== -1 && end > start
    ? raw.slice(start + MARKER_START.length, end)
    : raw;
  return inner
    .replaceAll("memory.search", "memory_search")
    .replaceAll("memory.create", "memory_create")
    .replaceAll("memory.delete", "memory_delete")
    .replaceAll("memory.edit", "memory_edit")
    .replaceAll("memory.map", "memory_map")
    .replaceAll("memory.promote", "memory_promote")
    .replaceAll("memory.demote", "memory_demote")
    .trim();
}
