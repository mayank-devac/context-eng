import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfigAtomically } from "./harness.js";
import { HOOK_TIMEOUT_SECONDS, type RecallHarness, type RecallMode } from "./hooks.js";
import { resolveProjectPath } from "./paths.js";

const OWNER = "context-eng:recall";
const OWNER_ARGUMENT = " --context-eng-recall";
export type RecallInstallScope = "global" | "project";
type JsonObject = Record<string, unknown>;

export interface HookRuntime {
  nodePath: string;
  entryPath: string;
  loader?: string;
}

export interface RecallInstallOptions {
  harness: RecallHarness;
  mode: RecallMode;
  scope: RecallInstallScope;
  home: string;
  projectPath: string;
  local?: boolean;
  runtime?: HookRuntime;
  /** Test-only filesystem seam for fault-injection coverage. */
  fileOps?: Partial<RecallInstallFileOps>;
}

export interface RecallInstallFileOps {
  write(file: string, content: string): void;
  remove(file: string): void;
  symlink(target: string, file: string): void;
}

export interface RecallInstallResult {
  harness: RecallHarness;
  mode: RecallMode;
  files: string[];
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object; left unchanged`);
  }
  return value as JsonObject;
}

type CommandHookEvent = "UserPromptSubmit" | "Stop";

function hookConfig(existing: string | null, eventName: CommandHookEvent) {
  let parsed: unknown = {};
  if (existing !== null) {
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error("Hook configuration is invalid JSON; left unchanged");
    }
  }
  const root = object(parsed, "Hook configuration");
  const hooks = root.hooks === undefined ? {} : object(root.hooks, "hooks");
  const event = hooks[eventName] === undefined ? [] : hooks[eventName];
  if (!Array.isArray(event)) throw new Error(`${eventName} must be an array; left unchanged`);
  const groups = event.map((value: unknown) => {
    const group = object(value, "Hook matcher group");
    if (!Array.isArray(group.hooks)) throw new Error("Hook handlers must be an array; left unchanged");
    return { ...group, hooks: group.hooks.map((handler: unknown) => object(handler, "Hook handler")) };
  });
  return { root, hooks, groups };
}

function ownedHandler(handler: JsonObject, ownerArgument: string): boolean {
  return typeof handler.command === "string" && handler.command.trimEnd().endsWith(ownerArgument);
}

export function hasCommandHook(existing: string | null, eventName: CommandHookEvent, ownerArgument: string): boolean {
  return hookConfig(existing, eventName).groups.some((group) => group.hooks.some((handler) => ownedHandler(handler, ownerArgument)));
}

export function mergeCommandHookConfig(
  existing: string | null, command: string | undefined, eventName: CommandHookEvent, ownerArgument: string,
): string {
  const { root, hooks, groups } = hookConfig(existing, eventName);
  const kept = groups.flatMap((group) => {
    if (!group.hooks.some((handler) => ownedHandler(handler, ownerArgument))) return [group];
    const handlers = group.hooks.filter((handler) => !ownedHandler(handler, ownerArgument));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
  if (command !== undefined) {
    kept.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  const nextHooks = { ...hooks };
  if (kept.length) nextHooks[eventName] = kept;
  else delete nextHooks[eventName];
  const next = { ...root };
  if (Object.keys(nextHooks).length) next.hooks = nextHooks;
  else delete next.hooks;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function mergeRecallHookConfig(existing: string | null, command?: string): string {
  return mergeCommandHookConfig(existing, command, "UserPromptSubmit", OWNER_ARGUMENT);
}

function hasRecallHook(existing: string | null): boolean {
  return hasCommandHook(existing, "UserPromptSubmit", OWNER_ARGUMENT);
}

export function currentHookRuntime(): HookRuntime {
  const source = import.meta.url.endsWith(".ts");
  return {
    nodePath: process.execPath,
    entryPath: fileURLToPath(new URL(source ? "./cli-entry.ts" : "./cli-entry.js", import.meta.url)),
    ...(source ? { loader: import.meta.resolve("tsx") } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function validateHookRuntime(runtime: HookRuntime): void {
  if (process.platform === "win32") throw new Error("Hook installation currently supports macOS and Linux");
  if ([runtime.entryPath, runtime.nodePath, runtime.loader ?? ""].some((value) => /[/\\](?:_npx|dlx)[/\\]/.test(value))) {
    throw new Error("The current runtime is in a temporary package cache. Install context-eng globally, then rerun hook setup.");
  }
  for (const file of [runtime.nodePath, runtime.entryPath]) {
    if (!path.isAbsolute(file) || !existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Hooks need a durable, existing runtime file: ${file}`);
    }
  }
}

export function hookRuntimeCommand(runtime: HookRuntime, args: readonly string[], ownerArgument: string): string {
  validateHookRuntime(runtime);
  const invocation = [
    runtime.nodePath,
    ...(runtime.loader ? ["--import", runtime.loader] : []),
    runtime.entryPath,
    ...args,
  ];
  return invocation.map(shellQuote).join(" ") + ownerArgument;
}

export function recallHookCommand(options: RecallInstallOptions): string {
  return hookRuntimeCommand(options.runtime ?? currentHookRuntime(), [
    "hook", "--harness", options.harness, "--mode", options.mode,
    ...(options.scope === "project" ? ["--project", resolveProjectPath(options.projectPath)] : []),
    ...(options.local ? ["--local"] : []),
  ], OWNER_ARGUMENT);
}

export function hookConfigPath(options: Pick<RecallInstallOptions, "harness" | "home" | "projectPath" | "scope">): string {
  const base = options.scope === "global" ? options.home : resolveProjectPath(options.projectPath);
  if (options.harness === "codex") return path.join(base, ".codex", "hooks.json");
  return path.join(base, ".claude", options.scope === "global" ? "settings.json" : "settings.local.json");
}

function installPaths(options: RecallInstallOptions, scope = options.scope) {
  const base = scope === "global" ? options.home : resolveProjectPath(options.projectPath);
  const claude = options.harness === "claude";
  return {
    config: hookConfigPath({ ...options, scope }),
    skill: path.join(base, claude ? ".claude" : ".agents", "skills", "recall"),
  };
}

function readOptional(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

interface FileSnapshot {
  file: string;
  content: string | null;
  mode?: number;
  kind?: "file" | "symlink" | "other";
  linkTarget?: string;
}

interface FileChange {
  file: string;
  content: string | null;
}

function snapshotFile(file: string): FileSnapshot {
  try {
    const info = lstatSync(file);
    const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other";
    return {
      file,
      content: readFileSync(file, "utf8"),
      mode: statSync(file).mode & 0o777,
      kind,
      ...(kind === "symlink" ? { linkTarget: readlinkSync(file) } : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { file, content: null };
    throw error;
  }
}

function fileKind(file: string): FileSnapshot["kind"] | undefined {
  try {
    const info = lstatSync(file);
    return info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function rollbackChanges(
  completed: readonly FileChange[], snapshots: ReadonlyMap<string, FileSnapshot>, fileOps: RecallInstallFileOps,
): string[] {
  const problems: string[] = [];
  for (const change of [...completed].reverse()) {
    const snapshot = snapshots.get(change.file)!;
    try {
      const current = readOptional(change.file);
      const kind = fileKind(change.file);
      const sameLinkTarget = kind !== "symlink" || readlinkSync(change.file) === snapshot.linkTarget;
      const unchangedSinceWrite = change.content === null
        ? current === null && kind === undefined
        : current === change.content && kind === (snapshot.kind ?? "file") && sameLinkTarget;
      if (!unchangedSinceWrite) {
        problems.push(`${change.file}: rollback conflict; preserved newer content or link target`);
        continue;
      }
      if (snapshot.content === null) {
        fileOps.remove(change.file);
      } else if (snapshot.kind === "symlink" && kind === undefined) {
        if (snapshot.linkTarget === undefined) throw new Error("symlink snapshot has no target");
        fileOps.symlink(snapshot.linkTarget, change.file);
      } else {
        fileOps.write(change.file, snapshot.content);
        if (snapshot.mode !== undefined) chmodSync(change.file, snapshot.mode);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${change.file}: rollback failed (${message})`);
    }
  }
  return problems;
}

export function installRecallHooks(options: RecallInstallOptions): RecallInstallResult {
  if (options.scope === "project" && !statSync(resolveProjectPath(options.projectPath)).isDirectory()) {
    throw new Error("Project recall requires an existing project directory");
  }
  const locations = installPaths(options);
  const existing = readOptional(locations.config);
  const active = options.mode !== "off";
  const command = active ? recallHookCommand(options) : undefined;
  const nextConfig = active || hasRecallHook(existing)
    ? mergeRecallHookConfig(existing, command)
    : existing;
  if (active) {
    const other = installPaths(options, options.scope === "global" ? "project" : "global");
    if (hasRecallHook(readOptional(other.config))) {
      throw new Error(`Recall is already installed in ${other.config}. Disable that scope first to avoid duplicate retrieval.`);
    }
  }

  const templateRoot = fileURLToPath(new URL(`../system_prompts/recall/${options.harness}/`, import.meta.url));
  const names = options.harness === "codex" ? ["SKILL.md", "agents/openai.yaml"] : ["SKILL.md"];
  const changes: FileChange[] = [];
  for (const name of names) {
    const file = path.join(locations.skill, name);
    const current = readOptional(file);
    if (current !== null && !current.includes(OWNER)) {
      if (active) throw new Error(`A different recall skill owns ${file}; left unchanged`);
      continue;
    }
    const content = active ? readFileSync(path.join(templateRoot, name), "utf8") : null;
    if (current !== content) changes.push({ file, content });
  }
  const configChange = nextConfig !== existing && nextConfig !== null
    ? { file: locations.config, content: nextConfig }
    : undefined;
  if (configChange) active ? changes.push(configChange) : changes.unshift(configChange);
  const fileOps: RecallInstallFileOps = {
    write: options.fileOps?.write ?? writeConfigAtomically,
    remove: options.fileOps?.remove ?? unlinkSync,
    symlink: options.fileOps?.symlink ?? symlinkSync,
  };
  const snapshots = new Map(changes.map((change) => [change.file, snapshotFile(change.file)]));
  const completed: FileChange[] = [];
  try {
    for (const change of changes) {
      if (change.content === null) fileOps.remove(change.file);
      else fileOps.write(change.file, change.content);
      completed.push(change);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackProblems = rollbackChanges(completed, snapshots, fileOps);
    const rollback = rollbackProblems.length ? ` Rollback: ${rollbackProblems.join("; ")}` : " Rollback restored completed files.";
    throw new Error(`Recall hook installation failed (${message}).${rollback}`, { cause: error });
  }
  return { harness: options.harness, mode: options.mode, files: changes.map((change) => change.file) };
}
