import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Engine } from "./engine.js";
import {
  detectHarnesses,
  formatHarnessReport,
  installDetectedHarnesses,
  pathHasCommand,
  promptHarnessChoice,
  type HarnessId,
} from "./harness.js";
import { runStdio } from "./mcp.js";
import { resolveProjectPath } from "./paths.js";
import { ensureTypeSafeKey, loadTypeSafeApiKey, openOsKeychain } from "./secrets.js";
import { TypeSafeRelevanceEvaluator } from "./typesafe.js";

const MARKER_START = "<!-- context-eng:start -->";
const MARKER_END = "<!-- context-eng:end -->";

const CURSOR_RULE_FILE = "context-eng-memory.mdc";
const CURSOR_RULE_FRONTMATTER = `---
description: Use context-eng MCP memory tools for local project memory.
alwaysApply: true
---
`;

const RULE_SCOPES = ["global", "project", "both"] as const;
type RuleScope = (typeof RULE_SCOPES)[number];
const CLAUDE_RULE_FILE = "context-eng-memory.md";

const USAGE = `Usage:
  context-eng mcp [--project <path>]
  context-eng init [--project <path>] [--yes]
  context-eng init --codex-only
  context-eng init --cursor-only [--scope global|project|both] [--project <path>]
  context-eng init --claude-only [--scope global|project|both] [--project <path>]
`;

export function upsertMarkedBlock(existing: string | null, block: string): string {
  const unit = block.trimEnd();
  if (existing == null || existing.trim() === "") {
    return `${unit}\n`;
  }
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MARKER_END.length);
    const out = `${before}${unit}${after}`;
    return out.endsWith("\n") ? out : `${out}\n`;
  }
  const head = existing.replace(/\s+$/, "");
  return `${head}\n\n${unit}\n`;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function agentPointerBlock(): string {
  const raw = readFileSync(path.join(repoRoot(), "system_prompts", "AGENTS.md"), "utf8");
  const start = raw.indexOf(MARKER_START);
  const end = raw.indexOf(MARKER_END);
  const inner = start !== -1 && end !== -1 && end > start
    ? raw.slice(start + MARKER_START.length, end)
    : raw;
  const adapted = inner
    .replaceAll("memory.search", "memory_search")
    .replaceAll("memory.create", "memory_create")
    .replaceAll("memory.delete", "memory_delete")
    .replaceAll("memory.edit", "memory_edit")
    .replaceAll("memory.map", "memory_map")
    .replaceAll("memory.promote", "memory_promote")
    .replaceAll("memory.demote", "memory_demote")
    .trim();
  return `${MARKER_START}\n${adapted}\n${MARKER_END}\n`;
}

function writePointer(file: string, block: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  writeFileSync(file, upsertMarkedBlock(existing, block), "utf8");
}

export function updateExistingPointer(file: string, block: string): boolean {
  if (!existsSync(file)) return false;
  writePointer(file, block);
  return true;
}

function usage(exitCode = 1): never {
  (exitCode === 0 ? console.log : console.error)(USAGE);
  process.exit(exitCode);
}

function engineOpts(project: string | undefined): ConstructorParameters<typeof Engine>[0] {
  if (project !== undefined) return { projectPath: project };
  return {};
}

export function codexAgentsPath(home = os.homedir()): string {
  return path.join(home, ".codex", "AGENTS.md");
}

export function writeCodexAgentsPointer(block: string, home = os.homedir()): string {
  const file = codexAgentsPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writePointer(file, block);
  return file;
}

export function globalCursorRulePath(home = os.homedir()): string {
  return path.join(home, ".cursor", "rules", CURSOR_RULE_FILE);
}

export function cursorRulePath(projectPath: string): string {
  return path.join(projectPath, ".cursor", "rules", CURSOR_RULE_FILE);
}

export function resolveRuleScope(
  scope: string | undefined,
  project: string | undefined,
): RuleScope {
  if (scope !== undefined) {
    if (!(RULE_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`scope must be one of: ${RULE_SCOPES.join(", ")}`);
    }
    return scope as RuleScope;
  }
  if (project !== undefined) return "project";
  return "global";
}

export const resolveCursorRuleScope = resolveRuleScope;

function splitCursorRule(existing: string): { frontmatter: string; body: string } {
  if (existing.startsWith("---\n")) {
    const end = existing.indexOf("\n---\n", 4);
    if (end !== -1) {
      return {
        frontmatter: existing.slice(0, end + 5),
        body: existing.slice(end + 5),
      };
    }
  }
  return { frontmatter: CURSOR_RULE_FRONTMATTER.trimEnd(), body: existing };
}

export function writeCursorRuleFile(block: string, file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (existing == null || existing.trim() === "") {
    writeFileSync(file, `${CURSOR_RULE_FRONTMATTER}\n${block.trimEnd()}\n`, "utf8");
    return file;
  }
  const { frontmatter, body } = splitCursorRule(existing);
  const nextBody = upsertMarkedBlock(body.trim() === "" ? null : body, block);
  writeFileSync(file, `${frontmatter}\n${nextBody}`, "utf8");
  return file;
}

export function writeCursorRule(block: string, projectPath: string): string {
  return writeCursorRuleFile(block, cursorRulePath(projectPath));
}

export function writeCursorRules(
  block: string,
  opts: { scope: RuleScope; project?: string; home?: string },
): string[] {
  const files: string[] = [];
  const home = opts.home ?? os.homedir();
  if (opts.scope === "global" || opts.scope === "both") {
    files.push(writeCursorRuleFile(block, globalCursorRulePath(home)));
  }
  if (opts.scope === "project" || opts.scope === "both") {
    if (opts.project === undefined) {
      throw new Error("scope project or both requires --project <path>");
    }
    files.push(writeCursorRuleFile(block, cursorRulePath(resolveProjectPath(opts.project))));
  }
  return files;
}

export function globalClaudeAgentsPath(home = os.homedir()): string {
  return path.join(home, ".claude", "CLAUDE.md");
}

export function writeGlobalClaudePointer(block: string, home = os.homedir()): string {
  const file = globalClaudeAgentsPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writePointer(file, block);
  return file;
}

export function claudeRulePath(projectPath: string): string {
  return path.join(projectPath, ".claude", "rules", CLAUDE_RULE_FILE);
}

export function writeClaudeRuleFile(block: string, file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writePointer(file, block);
  return file;
}

export function writeClaudeRule(block: string, projectPath: string): string {
  return writeClaudeRuleFile(block, claudeRulePath(projectPath));
}

export function writeClaudeRules(
  block: string,
  opts: { scope: RuleScope; project?: string; home?: string },
): string[] {
  const files: string[] = [];
  const home = opts.home ?? os.homedir();
  if (opts.scope === "global" || opts.scope === "both") {
    files.push(writeGlobalClaudePointer(block, home));
  }
  if (opts.scope === "project" || opts.scope === "both") {
    if (opts.project === undefined) {
      throw new Error("scope project or both requires --project <path>");
    }
    files.push(writeClaudeRuleFile(block, claudeRulePath(resolveProjectPath(opts.project))));
  }
  return files;
}

async function confirmHarnessReplacement(id: HarnessId, file: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${id} already has a different context-eng server in ${file}. Replace it? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    prompt.close();
  }
}

export async function main(): Promise<void> {
  let values: {
    project?: string;
    scope?: string;
    help?: boolean;
    yes?: boolean;
    "codex-only"?: boolean;
    "cursor-only"?: boolean;
    "claude-only"?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        project: { type: "string" },
        scope: { type: "string" },
        help: { type: "boolean", short: "h" },
        yes: { type: "boolean" },
        "codex-only": { type: "boolean" },
        "cursor-only": { type: "boolean" },
        "claude-only": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    usage();
  }

  if (values.help) usage(0);
  if (positionals.length !== 1) {
    usage();
  }

  const command = positionals[0];
  if (command !== "mcp" && command !== "init") {
    usage();
  }

  if (command === "mcp") {
    const loaded = await loadTypeSafeApiKey();
    if (loaded.warning) console.error(loaded.warning);
    const engine = new Engine({
      ...engineOpts(values.project),
      deferProject: values.project === undefined,
    });
    await runStdio(engine, new TypeSafeRelevanceEvaluator({ apiKey: loaded.apiKey }));
    return;
  }

  if (values["codex-only"] || values["cursor-only"] || values["claude-only"]) {
    const block = agentPointerBlock();
    if (values["codex-only"]) {
      console.log(`Updated ${writeCodexAgentsPointer(block)}`);
    }
    const scopedOpts = values.project === undefined
      ? undefined
      : { project: values.project };
    if (values["cursor-only"]) {
      const scope = resolveRuleScope(values.scope, values.project);
      const cursorOpts = scopedOpts === undefined ? { scope } : { scope, ...scopedOpts };
      for (const file of writeCursorRules(block, cursorOpts)) {
        console.log(`Updated ${file}`);
      }
    }
    if (values["claude-only"]) {
      const scope = resolveRuleScope(values.scope, values.project);
      const claudeOpts = scopedOpts === undefined ? { scope } : { scope, ...scopedOpts };
      for (const file of writeClaudeRules(block, claudeOpts)) {
        console.log(`Updated ${file}`);
      }
    }
    return;
  }

  const projectPath = resolveProjectPath(values.project);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`project path must be an existing directory: ${projectPath}`);
  }

  await ensureTypeSafeKey({
    store: await openOsKeychain(),
    interactive: process.stdin.isTTY === true,
  });

  const engine = new Engine({ projectPath });
  try {
    const block = agentPointerBlock();
    const projectAgents = path.join(engine.layout.projectPath, "AGENTS.md");
    const projectClaude = path.join(engine.layout.projectPath, "CLAUDE.md");
    const canWriteGlobal = process.stdin.isTTY === true || values.yes === true;
    const globalCodexAgents = canWriteGlobal ? writeCodexAgentsPointer(block) : undefined;
    const projectAgentsUpdated = updateExistingPointer(projectAgents, block);
    const projectClaudeUpdated = updateExistingPointer(projectClaude, block);
    console.log("");
    console.log("Agent pointers");
    if (projectAgentsUpdated) console.log(`  project AGENTS.md: ${projectAgents}`);
    if (projectClaudeUpdated) console.log(`  project CLAUDE.md: ${projectClaude}`);
    if (globalCodexAgents) console.log(`  codex AGENTS.md: ${globalCodexAgents}`);
    console.log("");
    console.log("Data layout");
    console.log(`  home: ${engine.layout.home}`);
    console.log(`  projectDir: ${engine.layout.projectDir}`);
    console.log(`  projectKey: ${engine.layout.projectKey}`);
    console.log("");
    const home = os.homedir();
    const installed = detectHarnesses({ home, hasCommand: pathHasCommand })
      .filter((hit) => hit.installed)
      .map((hit) => hit.id);
    const selected = values.yes === true
      ? installed
      : process.stdin.isTTY === true
        ? await promptHarnessChoice(installed)
        : [];
    const report = await installDetectedHarnesses({
      home,
      hasCommand: pathHasCommand,
      selected,
      ...(process.stdin.isTTY === true && values.yes !== true
        ? { confirmReplace: confirmHarnessReplacement }
        : {}),
    });
    const claude = report.harnesses.find((item) => item.id === "claude");
    if (canWriteGlobal && claude?.installed && !claude.skipped && !claude.error && !claude.preserved) {
      console.log(`  global Claude instructions: ${writeGlobalClaudePointer(block, home)}`);
    }
    console.log(formatHarnessReport(report));
  } finally {
    engine.close();
  }
}
