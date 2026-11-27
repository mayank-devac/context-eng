#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { MAX_HITS } from "./categories.js";
import { Engine } from "./engine.js";
import {
  currentHookRuntime,
  installRecallHooks,
  validateDurableRuntime,
  validateHookRuntime,
  type HookRuntime,
} from "./hook-install.js";
import {
  RECALL_HARNESSES,
  parseRecallHarness,
  parseRecallMode,
  runRecallHook,
  type RecallHarness,
  type RecallMode,
} from "./hooks.js";
import {
  detectHarnesses,
  formatHarnessReport,
  installDetectedHarnesses,
  pathHasCommand,
  promptHarnessChoice,
  type DurableRuntime,
  type HarnessId,
} from "./harness.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { runStdio } from "./mcp.js";
import { installOpencodeCommand, opencodeRulesFile, type OpencodeRulesFile } from "./opencode.js";
import { resolveProjectPath } from "./paths.js";
import { MARKER_END, MARKER_START, memoryInstructions } from "./pointer-block.js";
import { installPostsessionHook, parsePostsessionMode, runPostsessionHook } from "./postsession.js";
import { renderMemoryContext, retrieveMemories } from "./retrieval.js";
import { ensureTypeSafeKey, loadTypeSafeApiKey, openOsKeychain } from "./secrets.js";
import { TypeSafeRelevanceEvaluator } from "./typesafe.js";


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
  context-eng doctor [--project <path>]
  context-eng recall --query <text> [--project <path>] [--scope global|project|both] [--limit <1-50>] [--local]
  context-eng init [--project <path>] [--yes]
  context-eng init --recall manual|automatic|off [--harness claude|codex|opencode] [--scope global|project] [--project <path>] [--local] [--yes]
  context-eng init --postsession manual|off [--harness claude|codex|opencode] [--scope global|project] [--project <path>] [--yes]
  context-eng init --codex-only
  context-eng init --opencode-only
  context-eng init --cursor-only [--scope global|project|both] [--project <path>]
  context-eng init --claude-only [--scope global|project|both] [--project <path>]
  context-eng hook --harness claude|codex --mode manual|automatic [--project <path>] [--local]
`;

interface CliOptions {
  project?: string;
  scope?: string;
  query?: string;
  limit?: string;
  local?: boolean;
  recall?: string;
  postsession?: string;
  harness?: string;
  mode?: string;
  help?: boolean;
  yes?: boolean;
  "context-eng-recall"?: boolean;
  "context-eng-postsession"?: boolean;
  "codex-only"?: boolean;
  "cursor-only"?: boolean;
  "claude-only"?: boolean;
  "opencode-only"?: boolean;
}

const ONLY_FLAGS = ["claude-only", "codex-only", "cursor-only", "opencode-only"] as const;

/** True when any --<harness>-only flag was passed. */
function anyOnlyFlag(values: CliOptions): boolean {
  return ONLY_FLAGS.some((flag) => values[flag] === true);
}

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

export function agentPointerBlock(): string {
  return `${MARKER_START}\n${memoryInstructions()}\n${MARKER_END}\n`;
}

function writePointer(file: string, block: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  writeFileSync(file, upsertMarkedBlock(existing, block), "utf8");
}

/** Creates the file's folder if needed, writes the pointer block, and returns the file. */
export function writePointerFile(block: string, file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writePointer(file, block);
  return file;
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
  return writePointerFile(block, codexAgentsPath(home));
}

/**
 * Writes into the global rules file OpenCode actually loads (see
 * opencodeRulesFile): AGENTS.md, or ~/.claude/CLAUDE.md while OpenCode falls
 * back to it, since creating AGENTS.md would hide that file's instructions.
 */
export function writeOpencodeAgentsPointer(
  block: string, home = os.homedir(), env: NodeJS.ProcessEnv = process.env,
): OpencodeRulesFile {
  const rules = opencodeRulesFile(home, env);
  writePointerFile(block, rules.file);
  return rules;
}

function formatOpencodePointer(written: OpencodeRulesFile): string {
  return written.claudeFallback
    ? `${written.file} (OpenCode reads it while ${written.agentsFile} is absent; Claude Code reads it too. ` +
      "If you create that AGENTS.md later, rerun context-eng init --opencode-only)"
    : written.file;
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
  return writePointerFile(block, globalClaudeAgentsPath(home));
}

export function claudeRulePath(projectPath: string): string {
  return path.join(projectPath, ".claude", "rules", CLAUDE_RULE_FILE);
}

export function writeClaudeRule(block: string, projectPath: string): string {
  return writePointerFile(block, claudeRulePath(projectPath));
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
    files.push(writePointerFile(block, claudeRulePath(resolveProjectPath(opts.project))));
  }
  return files;
}

// The installed node + cli-entry.js, if this run is a stable install.
// Returns undefined for a temporary npx/dlx cache or a tsx dev run, so init
// falls back to npx and prints a warning.
function durableMcpRuntime(): DurableRuntime | undefined {
  try {
    const runtime = currentHookRuntime();
    validateDurableRuntime(runtime);
    if (runtime.loader !== undefined) return undefined;
    return { nodePath: runtime.nodePath, entryPath: runtime.entryPath };
  } catch {
    return undefined;
  }
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

type HookSetup = { kind: "recall"; mode: RecallMode } | { kind: "postsession"; enabled: boolean };

export interface InteractiveHookSetup {
  recall: RecallMode;
  postsession: boolean;
}

export async function promptHookSetup(
  options: {
    ask?: (question: string) => Promise<string>;
    log?: (line: string) => void;
    runtime?: HookRuntime;
  } = {},
): Promise<InteractiveHookSetup | undefined> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    validateHookRuntime(options.runtime ?? currentHookRuntime());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Prompt-box hook setup skipped: ${message}`);
    if (process.platform !== "win32") {
      log("For a durable installation, run npm install -g context-eng, then context-eng init to choose your hooks.");
    }
    return undefined;
  }
  const prompt = options.ask === undefined
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const ask = options.ask ?? ((question: string) => prompt!.question(question));
  try {
    const install = await ask("Install prompt-box hooks? [y/N] ");
    if (!/^y(?:es)?$/i.test(install.trim())) return undefined;

    let recall: RecallMode | undefined;
    while (recall === undefined) {
      const answer = (await ask("Recall mode: [m]anual, [a]utomatic, or [o]ff (default: manual) ")).trim().toLowerCase();
      if (answer === "" || answer === "m" || answer === "manual") recall = "manual";
      else if (answer === "a" || answer === "automatic") recall = "automatic";
      else if (answer === "o" || answer === "off") recall = "off";
      else log("Choose manual, automatic, or off.");
    }
    const postsession = await ask("Install manual postsession saving ($postsession in Codex, /postsession in Claude or OpenCode)? [y/N] ");
    return { recall, postsession: /^y(?:es)?$/i.test(postsession.trim()) };
  } finally {
    prompt?.close();
  }
}

/** Hosts that `init --recall` / `init --postsession` can set up: hook hosts plus OpenCode commands. */
type SetupHarness = RecallHarness | "opencode";
const SETUP_HARNESSES: readonly SetupHarness[] = [...RECALL_HARNESSES, "opencode"];

function isSetupHarness(id: string): id is SetupHarness {
  return (SETUP_HARNESSES as readonly string[]).includes(id);
}

function parseSetupHarness(value: string): SetupHarness {
  if (!isSetupHarness(value)) throw new Error("hook setup supports --harness claude, codex, or opencode");
  return value;
}

function installedSetupHarnesses(home: string): SetupHarness[] {
  return detectHarnesses({ home, hasCommand: pathHasCommand })
    .filter((hit) => hit.installed)
    .map((hit) => hit.id)
    .filter(isSetupHarness);
}

async function chooseSetupHarnesses(ids: readonly SetupHarness[]): Promise<SetupHarness[]> {
  return (await promptHarnessChoice(ids)).filter(isSetupHarness);
}

async function configureMemoryHooks(
  values: CliOptions, setup: HookSetup, selectedHarnesses?: readonly SetupHarness[],
): Promise<void> {
  if (values.query !== undefined || values.limit !== undefined) throw new Error("hook setup does not accept --query or --limit");
  if (setup.kind === "postsession" && values.local !== undefined) throw new Error("postsession uses the harness model; --local only applies to recall");
  if (values["cursor-only"]) throw new Error("This integration supports Claude Code, Codex, and OpenCode; select one with --harness");
  const scope = values.scope ?? "global";
  if (scope !== "global" && scope !== "project") throw new Error("hook setup scope must be global or project");
  if (scope === "project" && values.project === undefined) throw new Error("project hook setup requires --project <path>");
  const projectPath = resolveProjectPath(values.project);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new Error("hook setup requires an existing project directory");
  const disabled = setup.kind === "recall" ? setup.mode === "off" : !setup.enabled;
  const only = [
    values["claude-only"] ? "claude" : undefined,
    values["codex-only"] ? "codex" : undefined,
    values["opencode-only"] ? "opencode" : undefined,
  ].filter((id): id is SetupHarness => id !== undefined);
  if (values.harness && only.length) throw new Error("use --harness or the --*-only flags, not both");
  const home = os.homedir();
  const explicit = selectedHarnesses === undefined && (values.harness !== undefined || only.length > 0);
  let selected: readonly SetupHarness[];
  if (selectedHarnesses !== undefined) selected = selectedHarnesses;
  else if (values.harness !== undefined) selected = [parseSetupHarness(values.harness)];
  else if (only.length) selected = only;
  else if (disabled) selected = SETUP_HARNESSES;
  else {
    const installed = installedSetupHarnesses(home);
    selected = process.stdin.isTTY === true && values.yes !== true ? await chooseSetupHarnesses(installed) : installed;
  }
  if (!selected.length) throw new Error("No hook host selected. Use --harness claude, codex, or opencode.");
  const automatic = setup.kind === "recall" && setup.mode === "automatic";
  if (automatic && explicit && selected.includes("opencode")) {
    throw new Error("OpenCode has no prompt hook, so its recall is manual only. Use --recall manual for --harness opencode.");
  }
  for (const id of selected) {
    const opencode = id === "opencode";
    const files = opencode
      ? installOpencodeCommand({ name: setup.kind, enabled: !disabled, scope, home, projectPath })
      : setup.kind === "recall"
        ? installRecallHooks({
          harness: id, scope, home, projectPath, mode: setup.mode, ...(values.local === undefined ? {} : { local: values.local }),
        }).files
        : installPostsessionHook({ harness: id, scope, home, projectPath, enabled: setup.enabled });
    // OpenCode has no prompt hook, so its enabled recall is always the manual /recall command.
    const mode = disabled ? "off" : opencode || setup.kind === "postsession" ? "manual" : setup.mode;
    const note = opencode && automatic ? " (OpenCode has no prompt hook; installed manual /recall instead)" : "";
    console.log(`${id} ${setup.kind}: ${mode}${files.length ? "" : " (unchanged)"}${note}`);
    for (const file of files) console.log(`  ${file}`);
    if (opencode && setup.kind === "recall" && !disabled && values.local !== undefined) {
      console.log("  --local does not apply to OpenCode; its /recall uses the context-eng MCP server.");
    }
  }
  if (!disabled) {
    console.log(setup.kind === "recall"
      ? "Restart the selected host. In Codex, review and trust the hook using /hooks."
      : "Restart the selected host to load the postsession skill or command and reload any removed Stop hook.");
    console.log(setup.kind === "recall"
      ? "Manual recall: /recall <topic> in Claude or OpenCode, or $recall <topic> in Codex."
      : "Manual saving: $postsession in Codex or /postsession in Claude or OpenCode. Requires connected, permitted memory tools; Saved is reported only after confirmed creation/promotion.");
  }
}

async function configureInteractiveHooks(values: CliOptions): Promise<void> {
  if (process.stdin.isTTY !== true || values.yes === true) return;
  const setup = await promptHookSetup();
  if (!setup) return;
  const selected = await chooseSetupHarnesses(installedSetupHarnesses(os.homedir()));
  if (!selected.length) {
    console.log("No prompt-box hook host selected; skipped hook setup.");
    return;
  }
  await configureMemoryHooks(values, { kind: "recall", mode: setup.recall }, selected);
  await configureMemoryHooks(values, { kind: "postsession", enabled: setup.postsession }, selected);
}

export async function main(): Promise<void> {
  let values: CliOptions;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        project: { type: "string" },
        scope: { type: "string" },
        query: { type: "string" },
        limit: { type: "string" },
        local: { type: "boolean" },
        recall: { type: "string" },
        postsession: { type: "string" },
        harness: { type: "string" },
        mode: { type: "string" },
        "context-eng-recall": { type: "boolean" },
        "context-eng-postsession": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        yes: { type: "boolean" },
        "codex-only": { type: "boolean" },
        "cursor-only": { type: "boolean" },
        "claude-only": { type: "boolean" },
        "opencode-only": { type: "boolean" },
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
  if (command !== "mcp" && command !== "init" && command !== "recall" && command !== "hook" && command !== "postsession" &&
    command !== "doctor") {
    usage();
  }

  if (command === "doctor") {
    const findings = runDoctor({ home: os.homedir(), projectPath: resolveProjectPath(values.project), env: process.env });
    console.log(formatDoctor(findings));
    process.exitCode = findings.some((item) => item.level !== "ok") ? 1 : 0;
    return;
  }

  if (command === "postsession") {
    if (values.scope !== undefined || values.query !== undefined || values.limit !== undefined || values.local !== undefined ||
      values.mode !== undefined || values.recall !== undefined || values.postsession !== undefined || values["context-eng-recall"] !== undefined ||
      values.yes || anyOnlyFlag(values)) {
      throw new Error("postsession only accepts --harness and --project");
    }
    if (!values.harness) throw new Error("postsession requires --harness claude or codex");
    parseRecallHarness(values.harness);
    await runPostsessionHook();
    return;
  }
  if (values["context-eng-postsession"] !== undefined) throw new Error("--context-eng-postsession is only supported by postsession");

  if (command === "hook") {
    if (values.scope !== undefined || values.query !== undefined || values.limit !== undefined || values.recall !== undefined || values.postsession !== undefined ||
      values.yes || anyOnlyFlag(values)) {
      throw new Error("hook only accepts --harness, --mode, --project, and --local");
    }
    if (!values.harness) throw new Error("hook requires --harness claude or codex");
    await runRecallHook({
      harness: parseRecallHarness(values.harness), mode: parseRecallMode(values.mode ?? "manual"),
      ...(values.project === undefined ? {} : { projectPath: resolveProjectPath(values.project) }),
      ...(values.local === undefined ? {} : { local: values.local }),
    });
    // A timed-out keychain read can still hold a native worker; exit so the host is not kept waiting.
    process.exit(0);
  }
  if (values.mode !== undefined || values["context-eng-recall"] !== undefined) {
    throw new Error("--mode and --context-eng-recall are only supported by hook");
  }
  if (values.recall !== undefined && values.postsession !== undefined) throw new Error("Configure recall and postsession separately");
  if (command === "init" && values.postsession !== undefined) {
    const enabled = parsePostsessionMode(values.postsession);
    if (values.postsession === "on") console.log("--postsession on is deprecated; installing manual postsession. Use --postsession manual.");
    await configureMemoryHooks(values, { kind: "postsession", enabled });
    return;
  }
  if (command === "init" && values.recall !== undefined) {
    await configureMemoryHooks(values, { kind: "recall", mode: parseRecallMode(values.recall) });
    return;
  }
  if (values.recall !== undefined || values.postsession !== undefined || values.harness !== undefined) {
    throw new Error("Hook configuration flags require init --recall or init --postsession");
  }

  if (command === "recall") {
    if (values.yes || anyOnlyFlag(values)) {
      throw new Error("recall does not accept init options");
    }
    if (!values.query?.trim()) throw new Error("recall requires --query <text>");
    const scope = values.scope ?? "both";
    if (scope !== "global" && scope !== "project" && scope !== "both") {
      throw new Error("--scope must be global, project, or both");
    }
    const limit = values.limit === undefined ? MAX_HITS : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HITS) {
      throw new Error(`--limit must be an integer from 1 to ${MAX_HITS}`);
    }
    const projectPath = scope === "global" ? undefined : resolveProjectPath(values.project);
    if (projectPath !== undefined && (!existsSync(projectPath) || !statSync(projectPath).isDirectory())) {
      throw new Error(`project path must be an existing directory: ${projectPath}`);
    }
    const engine = new Engine(projectPath === undefined ? { deferProject: true } : { projectPath });
    try {
      const loaded = values.local ? undefined : await loadTypeSafeApiKey();
      if (loaded?.warning) console.error(loaded.warning);
      const evaluator = loaded === undefined ? undefined : new TypeSafeRelevanceEvaluator({ apiKey: loaded.apiKey });
      const result = await retrieveMemories(engine, { query: values.query, filters: { scope }, limit }, evaluator);
      process.stdout.write(`${renderMemoryContext(result, engine.projectPath)}\n`);
    } finally {
      engine.close();
    }
    return;
  }

  if (values.query !== undefined || values.limit !== undefined || values.local !== undefined) {
    throw new Error("--query, --limit, and --local are only supported by recall");
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

  if (anyOnlyFlag(values)) {
    const block = agentPointerBlock();
    if (values["codex-only"]) {
      console.log(`Updated ${writeCodexAgentsPointer(block)}`);
    }
    if (values["opencode-only"]) {
      console.log(`Updated ${formatOpencodePointer(writeOpencodeAgentsPointer(block))}`);
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
    const durable = durableMcpRuntime();
    const report = await installDetectedHarnesses({
      home,
      hasCommand: pathHasCommand,
      selected,
      ...(durable !== undefined ? { durable } : {}),
      ...(process.stdin.isTTY === true && values.yes !== true
        ? { confirmReplace: confirmHarnessReplacement }
        : {}),
    });
    // Global instructions go only to hosts whose MCP server this run registered or found in place.
    const registered = (id: HarnessId) => {
      const hit = report.harnesses.find((item) => item.id === id);
      return canWriteGlobal && hit?.installed === true && !hit.skipped && !hit.error && !hit.preserved;
    };
    if (registered("claude")) {
      console.log(`  global Claude instructions: ${writeGlobalClaudePointer(block, home)}`);
    }
    if (registered("opencode")) {
      console.log(`  global OpenCode instructions: ${formatOpencodePointer(writeOpencodeAgentsPointer(block, home))}`);
    }
    console.log(formatHarnessReport(report));
    await configureInteractiveHooks(values);
    if (process.stdin.isTTY !== true || values.yes === true) {
      console.log("For prompt-box memory recall, run context-eng init --recall manual or --recall automatic.");
    }
  } finally {
    engine.close();
  }
}
