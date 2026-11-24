import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { opencodeConfigDir } from "./harness.js";
import { applyInstallChanges, RECALL_OWNER, type RecallInstallScope } from "./hook-install.js";
import { resolveProjectPath } from "./paths.js";
import { fillTemplate, POSTSESSION_OWNER, postsessionInstructions } from "./postsession.js";

// OpenCode has no shell prompt hook, so recall and postsession are installed as
// custom commands (markdown templates) that ask the model to use the MCP tools.

export type OpencodeCommandName = "recall" | "postsession";

export interface OpencodeCommandOptions {
  name: OpencodeCommandName;
  enabled: boolean;
  scope: RecallInstallScope;
  home: string;
  projectPath: string;
  env?: NodeJS.ProcessEnv;
}

const OWNERS: Record<OpencodeCommandName, string> = {
  recall: RECALL_OWNER,
  postsession: POSTSESSION_OWNER,
};

const PROJECT_BINDING = "Resolve the root of the project open in this OpenCode session. Pass that absolute projectPath to every " +
  "project-scoped memory tool, even from a nested working directory. If the correct root is unclear, ask before writing; " +
  "never reuse another project's binding.";

export function opencodeCommandsDir(
  options: Pick<OpencodeCommandOptions, "scope" | "home" | "projectPath" | "env">,
): string {
  return options.scope === "global"
    ? path.join(opencodeConfigDir(options.home, options.env), "commands")
    : path.join(resolveProjectPath(options.projectPath), ".opencode", "commands");
}

function envFlagSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export interface OpencodeRulesFile {
  /** The global rules file OpenCode loads. */
  file: string;
  /** OpenCode's own global AGENTS.md, whether or not it exists. */
  agentsFile: string;
  /** True when OpenCode reads ~/.claude/CLAUDE.md because its AGENTS.md is absent. */
  claudeFallback: boolean;
}

/**
 * OpenCode's global rules file: its AGENTS.md, or ~/.claude/CLAUDE.md while
 * AGENTS.md is absent and the Claude Code fallback is not turned off.
 */
export function opencodeRulesFile(home: string, env: NodeJS.ProcessEnv = process.env): OpencodeRulesFile {
  const agentsFile = path.join(opencodeConfigDir(home, env), "AGENTS.md");
  const claude = path.join(home, ".claude", "CLAUDE.md");
  const fallbackDisabled = envFlagSet(env.OPENCODE_DISABLE_CLAUDE_CODE) || envFlagSet(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT);
  const claudeFallback = !existsSync(agentsFile) && existsSync(claude) && !fallbackDisabled;
  return { file: claudeFallback ? claude : agentsFile, agentsFile, claudeFallback };
}

function template(name: OpencodeCommandName): string {
  const text = readFileSync(new URL(`../system_prompts/${name}/opencode/${name}.md`, import.meta.url), "utf8");
  return name === "recall"
    ? text
    : fillTemplate(text, { instructions: postsessionInstructions(), project_binding: PROJECT_BINDING });
}

/** Installs (or with enabled false, removes) one owned OpenCode command file. Returns the files changed. */
export function installOpencodeCommand(options: OpencodeCommandOptions): string[] {
  if (options.scope === "project" && !statSync(resolveProjectPath(options.projectPath)).isDirectory()) {
    throw new Error(`Project ${options.name} setup requires an existing project directory`);
  }
  const file = path.join(opencodeCommandsDir(options), `${options.name}.md`);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current !== null && !current.includes(OWNERS[options.name])) {
    if (options.enabled) throw new Error(`A different ${options.name} command owns ${file}; left unchanged`);
    return [];
  }
  const content = options.enabled ? template(options.name) : null;
  if (current === content) return [];
  applyInstallChanges([{ file, content }], `OpenCode ${options.name} command`);
  return [file];
}
