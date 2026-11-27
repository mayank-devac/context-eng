#!/usr/bin/env node
// Checks the multi-host plugin in plugins/context-eng without network access:
// manifests for Claude Code, Cursor, Codex, Antigravity and OpenCode, the MCP
// configs, hooks, skills, rules, marketplaces, and that every version matches
// package.json. With --cli it also runs the host validators that are installed
// (`claude plugin validate`, `agy plugin validate`).
//
//   node scripts/validate-plugins.mjs [--cli] [--quiet]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Allowed top-level manifest keys, from each host's schema or reference.
const CLAUDE_KEYS = ["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "metadata", "defaultEnabled", "engines", "dependencies", "userConfig", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles"];
const CURSOR_KEYS = ["name", "displayName", "description", "version", "minClientVersions", "author", "publisher", "homepage", "repository", "license", "logo", "keywords", "category", "tags", "commands", "agents", "skills", "rules", "hooks", "variables", "mcpServers"];
const CODEX_KEYS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "mcpServers", "apps", "hooks", "interface", "extensions"];
const ANTIGRAVITY_KEYS = ["$schema", "name", "displayName", "description", "version", "logo", "suggestedPrompts", "skills", "disabled", "author", "homepage", "repository", "license", "keywords", "extensions"];

function readJson(file, problems) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${path.relative(REPO, file)}: ${error.message}`);
    return null;
  }
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

function checkKeys(label, manifest, allowed, problems) {
  for (const key of Object.keys(manifest)) {
    if (!allowed.includes(key)) problems.push(`${label}: unknown key "${key}"`);
  }
}

function checkPath(label, root, relative, problems) {
  if (typeof relative !== "string") return;
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root)) problems.push(`${label}: path ${relative} leaves the plugin folder`);
  else if (!existsSync(resolved)) problems.push(`${label}: path ${relative} does not exist`);
}

function checkMcp(label, root, config, variable, problems) {
  const server = config?.mcpServers?.["context-eng"];
  if (!server) return problems.push(`${label}: no mcpServers.context-eng entry`);
  if (typeof server.command !== "string") problems.push(`${label}: command must be a string`);
  if (!Array.isArray(server.args)) return problems.push(`${label}: args must be an array`);
  const launcher = server.args.find((arg) => arg.includes("scripts/mcp.mjs"));
  if (variable) {
    if (!launcher?.startsWith(`\${${variable}}/`)) problems.push(`${label}: launcher must start with \${${variable}}/`);
    else checkPath(label, root, launcher.slice(`\${${variable}}/`.length), problems);
  }
}

/** Validates the plugin folder `root` (default plugins/context-eng); returns a list of problems. */
export function validatePlugin(root = path.join(REPO, "plugins", "context-eng")) {
  const problems = [];
  const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  const manifests = {
    claude: ".claude-plugin/plugin.json",
    cursor: ".cursor-plugin/plugin.json",
    codex: ".codex-plugin/plugin.json",
    antigravity: ".antigravity-plugin/plugin.json",
    opencode: "package.json",
  };
  const loaded = {};
  for (const [host, file] of Object.entries(manifests)) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      problems.push(`${host}: missing ${file}`);
      continue;
    }
    const manifest = readJson(absolute, problems);
    if (!manifest) continue;
    loaded[host] = manifest;
    if (manifest.version !== version) problems.push(`${host}: version ${manifest.version} does not match package.json ${version}`);
    if (host !== "opencode" && manifest.name !== "context-eng") problems.push(`${host}: name must be "context-eng"`);
    if (host !== "opencode" && !KEBAB.test(manifest.name ?? "")) problems.push(`${host}: name must be kebab-case`);
  }

  if (loaded.claude) checkKeys("claude manifest", loaded.claude, CLAUDE_KEYS, problems);
  if (loaded.cursor) {
    checkKeys("cursor manifest", loaded.cursor, CURSOR_KEYS, problems);
    for (const key of ["skills", "rules"]) checkPath(`cursor ${key}`, root, loaded.cursor[key], problems);
    const command = loaded.cursor.mcpServers?.["context-eng"]?.command;
    if (!command) problems.push("cursor manifest: mcpServers.context-eng.command is missing");
  }
  if (loaded.codex) {
    checkKeys("codex manifest", loaded.codex, CODEX_KEYS, problems);
    for (const key of ["skills", "mcpServers"]) checkPath(`codex ${key}`, root, loaded.codex[key], problems);
  }
  if (loaded.antigravity) {
    checkKeys("antigravity manifest", loaded.antigravity, ANTIGRAVITY_KEYS, problems);
    if ((loaded.antigravity.suggestedPrompts ?? []).length > 3) problems.push("antigravity manifest: at most 3 suggestedPrompts");
  }
  if (loaded.opencode) {
    if (loaded.opencode.type !== "module") problems.push("opencode package.json: type must be module");
    checkPath("opencode main", root, loaded.opencode.main, problems);
    // OpenCode 2 loads a plugin folder from server.js or index.js, not from "main".
    if (!existsSync(path.join(root, "server.js"))) problems.push("opencode: missing server.js entry at the plugin root");
  }

  const claudeMcp = existsSync(path.join(root, ".mcp.json")) ? readJson(path.join(root, ".mcp.json"), problems) : null;
  checkMcp("claude .mcp.json", root, claudeMcp, "CLAUDE_PLUGIN_ROOT", problems);
  const codexMcp = existsSync(path.join(root, "mcp.json")) ? readJson(path.join(root, "mcp.json"), problems) : null;
  checkMcp("codex mcp.json", root, codexMcp, "PLUGIN_ROOT", problems);
  const agyMcp = existsSync(path.join(root, "mcp_config.json")) ? readJson(path.join(root, "mcp_config.json"), problems) : null;
  checkMcp("antigravity mcp_config.json", root, agyMcp, "PLUGIN_ROOT", problems);

  const hooksFile = path.join(root, "hooks", "hooks.json");
  const hooks = existsSync(hooksFile) ? readJson(hooksFile, problems) : null;
  if (!hooks?.hooks || typeof hooks.hooks !== "object") problems.push("hooks/hooks.json: needs a top-level \"hooks\" object");
  for (const group of hooks?.hooks?.SessionStart ?? []) {
    for (const handler of group.hooks ?? []) {
      const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(handler.command ?? "")?.[1];
      if (!script) problems.push("hooks/hooks.json: SessionStart command must use ${CLAUDE_PLUGIN_ROOT}");
      else checkPath("hooks/hooks.json", root, script, problems);
    }
  }

  const skillsDir = path.join(root, "skills");
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    if (!statSync(path.join(skillsDir, name)).isDirectory()) continue;
    const file = path.join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`skills/${name}: missing SKILL.md`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const fields = frontmatter(text);
    if (!fields) problems.push(`skills/${name}/SKILL.md: missing YAML frontmatter`);
    else {
      if (fields.name !== name) problems.push(`skills/${name}/SKILL.md: name "${fields.name}" must equal its folder name`);
      if (!fields.description || fields.description.length > 1024) problems.push(`skills/${name}/SKILL.md: description must be 1-1024 characters`);
    }
    if (text.includes("{{")) problems.push(`skills/${name}/SKILL.md: unfilled {{placeholder}}`);
  }

  for (const rule of ["rules/AGENTS.md", "rules/context-eng.mdc"]) {
    const file = path.join(root, rule);
    if (!existsSync(file)) problems.push(`missing ${rule}`);
    else if (!readFileSync(file, "utf8").includes("<!-- context-eng:start -->")) problems.push(`${rule}: missing instructions block`);
  }
  if (existsSync(path.join(root, "rules", "context-eng.mdc")) && frontmatter(readFileSync(path.join(root, "rules", "context-eng.mdc"), "utf8"))?.alwaysApply !== "true") {
    problems.push("rules/context-eng.mdc: needs alwaysApply: true");
  }
  if (existsSync(path.join(root, "CLAUDE.md"))) problems.push("CLAUDE.md at the plugin root is not loaded by Claude Code; use rules/AGENTS.md");

  const relativeRoot = path.relative(REPO, root).split(path.sep).join("/");
  const marketplaces = {
    ".claude-plugin/marketplace.json": (entry) => entry.source === `./${relativeRoot}`,
    ".cursor-plugin/marketplace.json": (entry) => entry.source === relativeRoot,
    ".agents/plugins/marketplace.json": (entry) => entry.source?.path === `./${relativeRoot}`,
  };
  for (const [file, matches] of Object.entries(marketplaces)) {
    const absolute = path.join(REPO, file);
    if (!existsSync(absolute)) {
      problems.push(`missing marketplace ${file}`);
      continue;
    }
    const market = readJson(absolute, problems);
    const entry = market?.plugins?.find((plugin) => plugin.name === "context-eng");
    if (!entry) problems.push(`${file}: no context-eng plugin entry`);
    else if (!matches(entry)) problems.push(`${file}: context-eng source must point at ${relativeRoot}`);
    if (entry?.version !== undefined && entry.version !== version) problems.push(`${file}: version ${entry.version} does not match package.json ${version}`);
  }
  return problems;
}

function runCli(command, args) {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
  if (which.status !== 0) return { skipped: true };
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  return { skipped: false, ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function main(argv) {
  const quiet = argv.includes("--quiet");
  const root = path.join(REPO, "plugins", "context-eng");
  const problems = validatePlugin(root);
  if (argv.includes("--cli")) {
    for (const [command, args] of [["claude", ["plugin", "validate", root]], ["agy", ["plugin", "validate", root]]]) {
      const result = runCli(command, args);
      if (result.skipped) console.log(`validate-plugins: ${command} not installed; skipped its validator`);
      else {
        console.log(`validate-plugins: ${command} plugin validate ${result.ok ? "passed" : "FAILED"}\n${result.output}`);
        if (!result.ok) problems.push(`${command} plugin validate failed`);
      }
    }
  }
  for (const problem of problems) console.error(`validate-plugins: ${problem}`);
  if (!problems.length && !quiet) console.log("validate-plugins: plugins/context-eng is valid for Claude Code, Cursor, Codex, Antigravity, and OpenCode");
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
