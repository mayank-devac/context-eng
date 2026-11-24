import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const PACKAGE_NAME = "context-eng";

export type HarnessId = "cursor" | "claude" | "codex" | "opencode";

export const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/** OpenCode keeps its global config, rules and commands in $XDG_CONFIG_HOME/opencode, by default ~/.config/opencode. */
export function opencodeConfigDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  return path.join(base, "opencode");
}

export interface McpLaunch {
  command: string;
  args: string[];
}

export interface HarnessHit {
  id: HarnessId;
  installed: boolean;
  via: string;
}

export interface HarnessWrite extends HarnessHit {
  file?: string;
  error?: string;
  skipped?: boolean;
  unchanged?: boolean;
  preserved?: boolean;
}

export interface HarnessChoice {
  ids: HarnessId[];
  cursor: number;
  selected: boolean[];
}

export interface HarnessReport {
  launch: McpLaunch;
  harnesses: HarnessWrite[];
}

/** An installed node binary plus the installed cli-entry.js file. */
export interface DurableRuntime {
  nodePath: string;
  entryPath: string;
}

export const NPX_FALLBACK_WARNING =
  "warning: using npx to start context-eng; install it globally (npm i -g context-eng) and rerun init for a stable launch.";

// Prefer fixed absolute paths. npx finds the package by name starting from the
// current folder, so inside a folder whose package.json is also named
// "context-eng" it runs that folder's code instead of the installed package.
export function mcpLaunch(
  hasCommand: (name: string) => boolean,
  durable?: DurableRuntime,
  platform: NodeJS.Platform = process.platform,
): McpLaunch {
  if (durable !== undefined) {
    return { command: durable.nodePath, args: [durable.entryPath, "mcp"] };
  }
  const runner = hasCommand("pnpm") && !hasCommand("npx")
    ? { command: "pnpm", args: ["dlx", PACKAGE_NAME, "mcp"] }
    : { command: "npx", args: ["-y", PACKAGE_NAME, "mcp"] };
  // On Windows npx and pnpm are .cmd scripts, which a host cannot start
  // directly without a shell, so run them through cmd /c.
  return platform === "win32" ? { command: "cmd", args: ["/c", runner.command, ...runner.args] } : runner;
}

/** True when the launch goes through npx / pnpm dlx, directly or via cmd /c. */
export function usesPackageRunner(launch: McpLaunch): boolean {
  const program = launch.command === "cmd" && launch.args[0] === "/c" ? launch.args[1] : launch.command;
  return program === "npx" || program === "pnpm";
}

export function pathHasCommand(name: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(finder, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectHarnesses(input: {
  home: string;
  hasCommand: (name: string) => boolean;
  exists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): HarnessHit[] {
  const exists = input.exists ?? existsSync;
  const present = (rel: string) => exists(path.join(input.home, rel));
  const opencodeDir = opencodeConfigDir(input.home, input.env);
  return [
    locate("cursor", [
      [input.hasCommand("cursor"), "cursor on PATH"],
      [present(".cursor"), "~/.cursor"],
    ]),
    locate("claude", [
      [input.hasCommand("claude"), "claude on PATH"],
      [present(".claude"), "~/.claude"],
      [present(".claude.json"), "~/.claude.json"],
    ]),
    locate("codex", [
      [input.hasCommand("codex"), "codex on PATH"],
      [present(".codex"), "~/.codex"],
    ]),
    locate("opencode", [
      [input.hasCommand("opencode"), "opencode on PATH"],
      [exists(opencodeDir), displayHomePath(input.home, opencodeDir)],
      [present(".opencode"), "~/.opencode"],
    ]),
  ];
}

function displayHomePath(home: string, file: string): string {
  const rel = path.relative(home, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : file;
}

function parseJsonObject(existing: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON (${message})`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `mcp.servers` is the V2 server map, not a legacy server that happens to be named "servers". */
function hasV2Servers(mcp: Record<string, unknown>): boolean {
  return plainObject(mcp.servers) && typeof mcp.servers.type !== "string";
}

/** The context-eng entry OpenCode would load: V2 `mcp.servers` first, then the legacy direct entry. */
export function existingOpencodeServer(existing: string | null): { found: boolean; value?: unknown } {
  if (existing === null || existing.trim() === "") return { found: false };
  const root = parseJsonObject(existing, "OpenCode config");
  if (root.mcp === undefined) return { found: false };
  if (!plainObject(root.mcp)) throw new Error("mcp must be a JSON object");
  const mcp = root.mcp;
  if (hasV2Servers(mcp)) {
    const servers = mcp.servers as Record<string, unknown>;
    if (Object.hasOwn(servers, PACKAGE_NAME)) return { found: true, value: servers[PACKAGE_NAME] };
  }
  return Object.hasOwn(mcp, PACKAGE_NAME) ? { found: true, value: mcp[PACKAGE_NAME] } : { found: false };
}

/**
 * Writes the server where this file already keeps servers. A file that uses the
 * V2 `mcp.servers` map gets the entry there (and loses any legacy duplicate);
 * otherwise the legacy direct `mcp.<name>` entry is used, which OpenCode V1
 * reads and V2 still accepts and migrates.
 */
export function upsertOpencodeJson(existing: string | null, server: Record<string, unknown>): string {
  const blank = existing === null || existing.trim() === "";
  const root: Record<string, unknown> = blank
    ? { $schema: OPENCODE_SCHEMA }
    : { ...parseJsonObject(existing, "OpenCode config") };
  if (root.mcp !== undefined && !plainObject(root.mcp)) throw new Error("mcp must be a JSON object");
  const mcp: Record<string, unknown> = { ...(root.mcp as Record<string, unknown> | undefined) };
  if (hasV2Servers(mcp)) {
    mcp.servers = { ...(mcp.servers as Record<string, unknown>), [PACKAGE_NAME]: server };
    delete mcp[PACKAGE_NAME];
  } else {
    mcp[PACKAGE_NAME] = server;
  }
  root.mcp = mcp;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function upsertMcpJson(
  existing: string | null,
  serverName: string,
  server: Record<string, unknown>,
): string {
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSON (${message})`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("MCP config must be a JSON object");
    }
    root = { ...(parsed as Record<string, unknown>) };
  }
  const current = root.mcpServers;
  const servers = typeof current === "object" && current !== null && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  servers[serverName] = server;
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function upsertTomlSection(existing: string, header: string, body: string[]): string {
  const title = `[${header}]`;
  const block = [title, ...body];
  const source = existing.replace(/\s+$/, "");
  if (source === "") return `${block.join("\n")}\n`;
  const lines = source.split("\n");
  const section = findTomlSection(lines, title);
  if (section === undefined) {
    return `${source}\n\n${block.join("\n")}\n`;
  }
  const next = [...lines.slice(0, section.start), ...block, ...lines.slice(section.end)];
  return `${next.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function findTomlSection(lines: string[], title: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => {
    const heading = line.trim();
    if (title === "[mcp_servers.context-eng]") {
      return /^\[\s*mcp_servers\s*\.\s*(?:context-eng|"context-eng"|'context-eng')\s*\](?:\s*#.*)?$/.test(heading);
    }
    return heading === title;
  });
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

export function initialHarnessChoice(ids: readonly HarnessId[]): HarnessChoice {
  return { ids: [...ids], cursor: 0, selected: ids.map(() => true) };
}

export function applyHarnessChoiceKey(
  choice: HarnessChoice,
  key: string,
): { choice: HarnessChoice; done: boolean } {
  if (key === "\u0003") throw new Error("Harness prompt aborted");
  if (key === "\r" || key === "\n") return { choice, done: true };
  if (key === " ") {
    const selected = choice.selected.slice();
    const at = choice.cursor;
    selected[at] = !selected[at];
    return { choice: { ...choice, selected }, done: false };
  }
  if (key === "\u001b[A" || key === "k") {
    const cursor = choice.cursor === 0 ? choice.ids.length - 1 : choice.cursor - 1;
    return { choice: { ...choice, cursor }, done: false };
  }
  if (key === "\u001b[B" || key === "j") {
    const cursor = (choice.cursor + 1) % choice.ids.length;
    return { choice: { ...choice, cursor }, done: false };
  }
  return { choice, done: false };
}

export function chosenHarnessIds(choice: HarnessChoice): HarnessId[] {
  return choice.ids.filter((_, index) => choice.selected[index] === true);
}

export function renderHarnessChoice(choice: HarnessChoice): string {
  const lines = ["Select harnesses. Space toggles, Enter confirms. All start selected."];
  choice.ids.forEach((id, index) => {
    const mark = choice.selected[index] === true ? "x" : " ";
    const pointer = index === choice.cursor ? ">" : " ";
    lines.push(`${pointer} [${mark}] ${id}`);
  });
  return lines.join("\n");
}

export function promptHarnessChoice(
  ids: readonly HarnessId[],
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<HarnessId[]> {
  if (ids.length === 0) return Promise.resolve([]);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve([...ids]);
  return new Promise((resolve, reject) => {
    let choice = initialHarnessChoice(ids);
    let drawn = 0;
    let pending = "";
    let settled = false;
    const paint = () => {
      const text = renderHarnessChoice(choice);
      if (drawn > 0) output.write(`\x1b[${drawn}A\x1b[J`);
      output.write(`${text}\n`);
      drawn = text.split("\n").length;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (pending.length > 0) {
        const key = takeKey(pending);
        if (key === null) return;
        pending = pending.slice(key.length);
        try {
          const next = applyHarnessChoiceKey(choice, key);
          choice = next.choice;
          if (next.done) {
            finish(() => resolve(chosenHarnessIds(choice)));
            return;
          }
          paint();
        } catch (error) {
          const aborted = error instanceof Error ? error : new Error(String(error), { cause: error });
          finish(() => reject(aborted));
        }
      }
    };
    paint();
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function installDetectedHarnesses(input: {
  home: string;
  hasCommand: (name: string) => boolean;
  exists?: (file: string) => boolean;
  selected?: readonly HarnessId[];
  confirmReplace?: (id: HarnessId, file: string) => Promise<boolean> | boolean;
  durable?: DurableRuntime;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<HarnessReport> {
  const launch = mcpLaunch(input.hasCommand, input.durable, input.platform);
  const exists = input.exists ?? existsSync;
  const allowed = input.selected === undefined ? null : new Set(input.selected);
  const harnesses: HarnessWrite[] = [];
  for (const hit of detectHarnesses(input)) {
    if (!hit.installed) {
      harnesses.push(hit);
      continue;
    }
    if (allowed !== null && !allowed.has(hit.id)) {
      harnesses.push({ ...hit, skipped: true });
      continue;
    }
    try {
      const result = hit.id === "opencode"
        ? await writeOpencode(input.home, launch, exists, input.env, input.confirmReplace)
        : await writeHarness(hit.id, input.home, launch, exists, input.confirmReplace);
      harnesses.push({ ...hit, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      harnesses.push({ ...hit, error: message });
    }
  }
  return { launch, harnesses };
}

export function formatHarnessReport(report: HarnessReport): string {
  const lines = ["Harnesses"];
  for (const item of report.harnesses) {
    if (!item.installed) {
      lines.push(`  ${item.id}: not installed`);
      continue;
    }
    if (item.skipped) {
      lines.push(`  ${item.id}: installed (${item.via}) - not selected`);
      continue;
    }
    if (item.error) {
      lines.push(`  ${item.id}: installed (${item.via}) - ${item.error}`);
      continue;
    }
    if (item.preserved) {
      lines.push(`  ${item.id}: installed (${item.via}) - kept existing setup in ${item.file}`);
      continue;
    }
    if (item.unchanged) {
      lines.push(`  ${item.id}: installed (${item.via}) - already configured in ${item.file}`);
      continue;
    }
    lines.push(`  ${item.id}: installed (${item.via}) -> ${item.file}`);
  }
  lines.push(`  server: ${report.launch.command} ${report.launch.args.join(" ")}`);
  if (usesPackageRunner(report.launch)) lines.push(NPX_FALLBACK_WARNING);
  return lines.join("\n");
}

function takeKey(pending: string): string | null {
  if (!pending.startsWith("\u001b")) return pending.slice(0, 1);
  if (pending.length === 1) return null;
  if (pending[1] !== "[") return pending.slice(0, 1);
  if (pending.length < 3) return null;
  return pending.slice(0, 3);
}

function locate(id: HarnessId, checks: Array<[boolean, string]>): HarnessHit {
  const found = checks.find(([ok]) => ok);
  if (!found) return { id, installed: false, via: "not installed" };
  return { id, installed: true, via: found[1] };
}

export function writeConfigAtomically(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const realFile = isLink
    ? realpathSync(file)
    : path.join(realpathSync(path.dirname(file)), path.basename(file));
  const mode = existsSync(realFile) ? statSync(realFile).mode & 0o777 : 0o600;
  const temp = path.join(path.dirname(realFile), `.${path.basename(realFile)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode });
    chmodSync(temp, mode);
    renameSync(temp, realFile);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type HarnessWriteResult = Pick<HarnessWrite, "file" | "unchanged" | "preserved">;
type ConfirmReplace = (id: HarnessId, file: string) => Promise<boolean> | boolean;

/** The global OpenCode config file init edits: opencode.json, else an existing opencode.jsonc. */
export function opencodeConfigFile(
  home: string, exists: (file: string) => boolean = existsSync, env?: NodeJS.ProcessEnv,
): string {
  const dir = opencodeConfigDir(home, env);
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  return !exists(json) && exists(jsonc) ? jsonc : json;
}

async function writeOpencode(
  home: string,
  launch: McpLaunch,
  exists: (file: string) => boolean,
  env?: NodeJS.ProcessEnv,
  confirmReplace?: ConfirmReplace,
): Promise<HarnessWriteResult> {
  const file = opencodeConfigFile(home, exists, env);
  const server = { type: "local", command: [launch.command, ...launch.args] };
  const existing = exists(file) ? readFileSync(file, "utf8") : null;
  let current: { found: boolean; value?: unknown };
  try {
    current = existingOpencodeServer(existing);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = file.endsWith(".jsonc") ? "; JSONC comments are not edited, add the server by hand" : "";
    throw new Error(`${message}${hint}`, { cause: error });
  }
  if (current.found) {
    if (isDeepStrictEqual(current.value, server)) return { file, unchanged: true };
    if (await confirmReplace?.("opencode", file) !== true) return { file, preserved: true };
  }
  writeConfigAtomically(file, upsertOpencodeJson(existing, server));
  return { file };
}

async function writeHarness(
  id: Exclude<HarnessId, "opencode">,
  home: string,
  launch: McpLaunch,
  exists: (file: string) => boolean,
  confirmReplace?: ConfirmReplace,
): Promise<HarnessWriteResult> {
  if (id === "codex") return writeCodex(home, launch, exists, confirmReplace);
  const file = id === "cursor"
    ? path.join(home, ".cursor", "mcp.json")
    : path.join(home, ".claude.json");
  const server = id === "claude"
    ? { type: "stdio", command: launch.command, args: launch.args }
    : { command: launch.command, args: launch.args };
  const existing = exists(file) ? readFileSync(file, "utf8") : null;
  const current = existingMcpServer(existing);
  if (current.found) {
    if (isDeepStrictEqual(current.value, server)) return { file, unchanged: true };
    if (await confirmReplace?.(id, file) !== true) return { file, preserved: true };
  }
  writeConfigAtomically(file, upsertMcpJson(existing, PACKAGE_NAME, server));
  return { file };
}

function existingMcpServer(existing: string | null): { found: boolean; value?: unknown } {
  if (existing === null || existing.trim() === "") return { found: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON (${message})`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP config must be a JSON object");
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) return { found: false };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("mcpServers must be a JSON object");
  }
  const entries = servers as Record<string, unknown>;
  return Object.hasOwn(entries, PACKAGE_NAME)
    ? { found: true, value: entries[PACKAGE_NAME] }
    : { found: false };
}

async function writeCodex(
  home: string,
  launch: McpLaunch,
  exists: (file: string) => boolean,
  confirmReplace?: ConfirmReplace,
): Promise<HarnessWriteResult> {
  const file = path.join(home, ".codex", "config.toml");
  const existing = exists(file) ? readFileSync(file, "utf8") : "";
  const args = launch.args.map((arg) => JSON.stringify(arg)).join(", ");
  const body = [
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${args}]`,
  ];
  const lines = existing.split("\n");
  const section = findTomlSection(lines, "[mcp_servers.context-eng]");
  if (section !== undefined) {
    const current = lines.slice(section.start + 1, section.end)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (current.length === body.length && body.every((line) => current.includes(line))) {
      return { file, unchanged: true };
    }
    if (await confirmReplace?.("codex", file) !== true) return { file, preserved: true };
  }
  const next = upsertTomlSection(existing, "mcp_servers.context-eng", body);
  writeConfigAtomically(file, next);
  return { file };
}
