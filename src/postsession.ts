import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  currentHookRuntime, hasCommandHook, hookConfigPath, hookRuntimeCommand, mergeCommandHookConfig,
  type HookRuntime, type RecallInstallScope,
} from "./hook-install.js";
import { writeConfigAtomically } from "./harness.js";
import { readHookInput, type RecallHarness } from "./hooks.js";
import { resolveProjectPath } from "./paths.js";

const OWNER_ARGUMENT = " --context-eng-postsession";

export function parsePostsessionMode(value: string): boolean {
  if (value !== "on" && value !== "off") throw new Error("postsession must be on or off");
  return value === "on";
}

export function postsessionHook(raw: unknown, projectOverride?: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("hook input must be an object");
  const event = raw as Record<string, unknown>;
  if (event.hook_event_name !== "Stop" || event.stop_hook_active !== false) return {};
  if (typeof event.last_assistant_message !== "string" || !event.last_assistant_message.trim()) return {};
  if (typeof event.cwd !== "string" || !isAbsolute(event.cwd)) throw new Error("Stop requires an absolute cwd");
  const project = resolveProjectPath(projectOverride ?? event.cwd);
  const instructions = readFileSync(new URL("../system_prompts/postsession.md", import.meta.url), "utf8").trim();
  return {
    decision: "block",
    reason: `${instructions}\n\nProject path for project-scoped memory writes (JSON string): ${JSON.stringify(project)}.`,
  };
}

export async function runPostsessionHook(projectOverride?: string): Promise<void> {
  try {
    const result = postsessionHook(await readHookInput(), projectOverride);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`[context-eng] Postsession hook skipped (${name}); allowing the task to finish.\n`);
    process.stdout.write("{}\n");
  }
}

export interface PostsessionInstallOptions {
  harness: RecallHarness;
  enabled: boolean;
  scope: RecallInstallScope;
  home: string;
  projectPath: string;
  runtime?: HookRuntime;
}

export function installPostsessionHook(options: PostsessionInstallOptions): string[] {
  if (options.scope === "project" && !statSync(resolveProjectPath(options.projectPath)).isDirectory()) {
    throw new Error("Project postsession setup requires an existing directory");
  }
  const file = hookConfigPath(options);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (!options.enabled && !hasCommandHook(existing, "Stop", OWNER_ARGUMENT)) return [];
  let command: string | undefined;
  if (options.enabled) {
    const other = hookConfigPath({ ...options, scope: options.scope === "global" ? "project" : "global" });
    const opposite = existsSync(other) ? readFileSync(other, "utf8") : null;
    if (hasCommandHook(opposite, "Stop", OWNER_ARGUMENT)) {
      throw new Error(`Postsession is already installed in ${other}; disable that scope first.`);
    }
    command = hookRuntimeCommand(options.runtime ?? currentHookRuntime(), [
      "postsession", "--harness", options.harness,
      ...(options.scope === "project" ? ["--project", resolveProjectPath(options.projectPath)] : []),
    ], OWNER_ARGUMENT);
  }
  const next = mergeCommandHookConfig(existing, command, "Stop", OWNER_ARGUMENT);
  if (next === existing) return [];
  writeConfigAtomically(file, next);
  return [file];
}
