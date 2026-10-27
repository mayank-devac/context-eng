import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  applyInstallChanges, hookConfigPath, hasCommandHook, mergeCommandHookConfig,
  type FileChange, type RecallInstallFileOps, type RecallInstallScope,
} from "./hook-install.js";
import type { RecallHarness } from "./hooks.js";
import { resolveProjectPath } from "./paths.js";

const OWNER = "context-eng:postsession";
const LEGACY_ARGUMENT = " --context-eng-postsession";

export function parsePostsessionMode(value: string): boolean {
  if (value !== "manual" && value !== "on" && value !== "off") throw new Error("postsession must be manual or off (on is a deprecated alias for manual)");
  return value !== "off";
}

/** Old installed Stop commands must never block, even before deliberate migration. */
export function postsessionHook(): Record<string, unknown> {
  return {};
}

export async function runPostsessionHook(): Promise<void> {
  process.stdout.write(`${JSON.stringify(postsessionHook())}\n`);
}

export interface PostsessionInstallOptions {
  harness: RecallHarness;
  enabled: boolean;
  scope: RecallInstallScope;
  home: string;
  projectPath: string;
  fileOps?: Partial<RecallInstallFileOps>;
}

export function installPostsessionHook(options: PostsessionInstallOptions): string[] {
  const project = resolveProjectPath(options.projectPath);
  if (options.scope === "project" && !statSync(project).isDirectory()) {
    throw new Error("Project postsession setup requires an existing directory");
  }
  const config = hookConfigPath(options);
  const existing = existsSync(config) ? readFileSync(config, "utf8") : null;
  // Validate before changing any skills, but do not create/reformat unrelated config.
  const next = hasCommandHook(existing, "Stop", LEGACY_ARGUMENT)
    ? mergeCommandHookConfig(existing, undefined, "Stop", LEGACY_ARGUMENT)
    : existing;
  const base = options.scope === "global" ? options.home : project;
  const skill = path.join(base, options.harness === "claude" ? ".claude" : ".agents", "skills/postsession");
  const names = options.harness === "codex" ? ["SKILL.md", "agents/openai.yaml"] : ["SKILL.md"];
  const changes: FileChange[] = [];
  const contents = names.map((name) => {
    const file = path.join(skill, name);
    return { file, name, current: existsSync(file) ? readFileSync(file, "utf8") : null };
  });
  const conflict = contents.find(({ current }) => current !== null && !current.includes(OWNER));
  if (conflict && options.enabled) throw new Error(`A different postsession skill owns ${conflict.file}; left unchanged`);
  // Off preserves the entire managed skill if any managed file is user-owned.
  if (!conflict) {
    const instructions = options.enabled
      ? readFileSync(new URL("../system_prompts/postsession.md", import.meta.url), "utf8").trim()
      : "";
    const binding = options.scope === "project"
      ? `Resolve projectPath from this installed skill's location: <root>/${options.harness === "codex" ? ".agents" : ".claude"}/skills/postsession/SKILL.md belongs to <root>. Use that absolute root for every project-scoped memory tool, even from a nested working directory. Do not use the current directory or another project's binding. If the skill's project root is unclear or is not the current project, stop and report the mismatch before writing.`
      : "Resolve the current project root from the conversation and workspace. Pass that absolute projectPath to every project-scoped memory tool. If the correct root is unclear, ask before writing; never reuse another project's binding.";
    for (const { file, name, current } of contents) {
      const content = options.enabled
        ? readFileSync(new URL(`../system_prompts/postsession/${options.harness}/${name}`, import.meta.url), "utf8")
          .replace("{{instructions}}", instructions).replace("{{project_binding}}", binding)
        : null;
      if (current !== content) changes.push({ file, content });
    }
  }
  if (next !== existing && next !== null) {
    const cleanup = { file: config, content: next };
    if (options.enabled) changes.push(cleanup);
    else changes.unshift(cleanup);
  }
  applyInstallChanges(changes, "Postsession skill", options.fileOps);
  return changes.map(({ file }) => file);
}
