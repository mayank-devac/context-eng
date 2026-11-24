import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { existingOpencodeServer, PACKAGE_NAME } from "./harness.js";
import { plainObject } from "./json-config.js";

// `context-eng doctor`: read-only check of every place that launches
// context-eng (MCP servers and prompt hooks). It reports two problems:
//   - a launch through npx / pnpm dlx, which can run the wrong code
//   - an absolute path that no longer exists (for example after a Node upgrade)

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
  level: DoctorLevel;
  file: string;
  what: string;
  message: string;
}

type Exists = (file: string) => boolean;

const NPX_HINT = "uses npx/pnpm dlx; inside a folder whose package.json is named context-eng that runs the folder's code. " +
  "Install globally (npm i -g context-eng) and rerun context-eng init.";
const MISSING_HINT = "rerun context-eng init (and context-eng init --recall ...) from your current install.";

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The path functions doctor needs; tests pass path.win32 to check Windows rules on any OS. */
export type PathApi = Pick<typeof path, "isAbsolute">;

const PACKAGE_RUNNER = /^(?:npx|pnpm)(?:\.cmd|\.exe|\.ps1)?$/i;
const CMD_SHELL = /^cmd(?:\.exe)?$/i;

// win32 basename splits on both / and \, so it reads POSIX and Windows paths alike.
function programName(word: string | undefined): string {
  return path.win32.basename(word ?? "");
}

// `cmd /c npx ...` (the wrapper Windows needs for .cmd launchers) -> `npx ...`.
// Dropping the cmd switches also keeps `/c` from counting as a rooted path on Windows.
function unwrapCmd(words: readonly string[]): readonly string[] {
  if (!CMD_SHELL.test(programName(words[0]))) return words;
  const run = words.findIndex((word) => /^\/[ck]$/i.test(word));
  return run === -1 ? words : words.slice(run + 1);
}

/** Checks one launch, given as its separate words (command first). */
export function checkLaunch(
  file: string,
  what: string,
  launch: readonly string[],
  exists: Exists,
  paths: PathApi = path,
): DoctorFinding {
  const words = unwrapCmd(launch);
  if (PACKAGE_RUNNER.test(programName(words[0])) || words.includes("dlx")) {
    return { level: "warn", file, what, message: NPX_HINT };
  }
  const missing = words.filter((word) => paths.isAbsolute(word) && !exists(word));
  if (missing.length > 0) {
    return { level: "error", file, what, message: `missing ${missing.join(", ")}; ${MISSING_HINT}` };
  }
  return { level: "ok", file, what, message: launch.join(" ") };
}

/** Splits a hook command written by hookRuntimeCommand: 'quoted' words or bare words. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g)) {
    words.push(match[1] !== undefined ? match[1].replaceAll(`'"'"'`, "'") : match[2] ?? "");
  }
  return words;
}

function jsonServer(file: string, exists: Exists): DoctorFinding[] {
  const text = readOptional(file);
  if (text === null) return [];
  let server: unknown;
  try {
    server = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers?.["context-eng"];
  } catch {
    return [{ level: "error", file, what: "MCP server", message: "config is not valid JSON" }];
  }
  if (server === undefined || server === null || typeof server !== "object") return [];
  const { command, args } = server as { command?: unknown; args?: unknown };
  const words = [String(command ?? ""), ...(Array.isArray(args) ? args.map(String) : [])];
  return [checkLaunch(file, "MCP server", words, exists)];
}

function codexServer(file: string, exists: Exists): DoctorFinding[] {
  const text = readOptional(file);
  if (text === null) return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[\s*mcp_servers\.(?:context-eng|"context-eng")\s*\]\s*$/.test(line));
  if (start === -1) return [];
  let command = "";
  let args: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const commandMatch = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (commandMatch?.[1] !== undefined) command = JSON.parse(`"${commandMatch[1]}"`) as string;
    const argsMatch = /^\s*args\s*=\s*(\[.*\])\s*$/.exec(line);
    if (argsMatch?.[1] !== undefined) {
      try {
        args = (JSON.parse(argsMatch[1]) as unknown[]).map(String);
      } catch {
        return [{ level: "warn", file, what: "MCP server", message: "could not read args; check it by hand" }];
      }
    }
  }
  return [checkLaunch(file, "MCP server", [command, ...args], exists)];
}

function opencodeServer(file: string, exists: Exists): DoctorFinding[] {
  const text = readOptional(file);
  if (text === null) return [];
  let current: { found: boolean; value?: unknown };
  try {
    // The same lookup init uses: JSONC-tolerant, V2 `mcp.servers` first, then the legacy entry.
    current = existingOpencodeServer(text);
  } catch (error) {
    // A broken config that never mentions context-eng is OpenCode's problem, not a context-eng launch.
    if (!text.includes(PACKAGE_NAME)) return [];
    const message = error instanceof Error ? error.message : String(error);
    return [{ level: "error", file, what: "MCP server", message }];
  }
  if (!current.found || !plainObject(current.value)) return [];
  // A remote server is reached over its URL; there is no local command to check.
  if (current.value.type === "remote") {
    return [{ level: "ok", file, what: "MCP server", message: "remote server; no local launch to check" }];
  }
  const { command } = current.value;
  if (!Array.isArray(command) || command.length === 0) {
    return [{ level: "error", file, what: "MCP server", message: "command must be a non-empty array" }];
  }
  return [checkLaunch(file, "MCP server", command.map(String), exists)];
}

function hookCommands(value: unknown, found: string[]): string[] {
  if (Array.isArray(value)) {
    for (const item of value) hookCommands(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" && typeof item === "string" && item.includes("context-eng")) found.push(item);
      else hookCommands(item, found);
    }
  }
  return found;
}

function hookFile(file: string, exists: Exists): DoctorFinding[] {
  const text = readOptional(file);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ level: "error", file, what: "hooks", message: "config is not valid JSON" }];
  }
  return hookCommands(parsed, []).map((command) => checkLaunch(file, "hook", shellWords(command), exists));
}

export function runDoctor(input: {
  home: string; projectPath: string; exists?: Exists; opencodeDir?: string;
}): DoctorFinding[] {
  const exists = input.exists ?? existsSync;
  const { home, projectPath } = input;
  const opencodeDir = input.opencodeDir ?? path.join(home, ".config", "opencode");
  const opencodeFiles = [...new Set([opencodeDir, projectPath, path.join(projectPath, ".opencode")]
    .flatMap((dir) => ["opencode.json", "opencode.jsonc"].map((name) => path.join(dir, name))))];
  return [
    ...jsonServer(path.join(home, ".claude.json"), exists),
    ...jsonServer(path.join(home, ".cursor", "mcp.json"), exists),
    ...jsonServer(path.join(projectPath, ".cursor", "mcp.json"), exists),
    ...codexServer(path.join(home, ".codex", "config.toml"), exists),
    ...opencodeFiles.flatMap((file) => opencodeServer(file, exists)),
    ...hookFile(path.join(home, ".claude", "settings.json"), exists),
    ...hookFile(path.join(projectPath, ".claude", "settings.json"), exists),
    ...hookFile(path.join(projectPath, ".claude", "settings.local.json"), exists),
    ...hookFile(path.join(home, ".codex", "hooks.json"), exists),
    ...hookFile(path.join(projectPath, ".codex", "hooks.json"), exists),
  ];
}

export function formatDoctor(findings: readonly DoctorFinding[]): string {
  if (findings.length === 0) return "context-eng doctor: no context-eng launches found. Run context-eng init.";
  const mark: Record<DoctorLevel, string> = { ok: "ok   ", warn: "WARN ", error: "ERROR" };
  const lines = ["context-eng doctor"];
  for (const item of findings) lines.push(`  ${mark[item.level]} ${item.what} in ${item.file}: ${item.message}`);
  const problems = findings.filter((item) => item.level !== "ok").length;
  lines.push(problems === 0 ? "All launches look healthy." : `${problems} problem(s) found.`);
  return lines.join("\n");
}
