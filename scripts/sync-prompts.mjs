#!/usr/bin/env node
// Keeps copies of the same prompt text identical across hosts.
//
// Each group below lists files that must share one piece of text: a marked
// block, a named region, the body after the YAML frontmatter, or the whole
// file. Edit any one copy and run this script (the pre-commit hook does it for
// you): the copy you changed becomes the source, and every other copy is
// rewritten to match it.
//
//   node scripts/sync-prompts.mjs            sync the working tree
//   node scripts/sync-prompts.mjs --stage    pre-commit mode: sync, then `git add` what changed
//   node scripts/sync-prompts.mjs --check    only report drift; exit 1 if any group differs
//   node scripts/sync-prompts.mjs --from F   force file F as the source for its groups
//
// The source of a drifted group is the copy whose shared text differs from its
// last commit (HEAD). If several copies changed in different ways, or none
// changed, the script stops and asks for --from.
//
// A named region looks like this inside a Markdown file:
//   <!-- sync:recall-show -->
//   ...shared text...
//   <!-- /sync:recall-show -->
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECALL = [
  "system_prompts/recall/claude/SKILL.md",
  "system_prompts/recall/codex/SKILL.md",
  "system_prompts/recall/opencode/recall.md",
  "plugins/context-eng/skills/recall/SKILL.md",
  ".agents/skills/recall/SKILL.md",
];

/** Every set of files that must share text. `part` is the default for files that give none. */
export const GROUPS = [
  {
    name: "instructions block (context-eng:start … context-eng:end)",
    part: { markers: ["<!-- context-eng:start -->", "<!-- context-eng:end -->"] },
    files: [
      "system_prompts/AGENTS.md",
      "system_prompts/CLAUDE.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".cursor/rules/context-eng-memory.mdc",
      "plugins/context-eng/rules/AGENTS.md",
      "plugins/context-eng/rules/context-eng.mdc",
    ],
  },
  { name: "recall intro", part: { region: "recall-intro" }, files: RECALL },
  { name: "recall output rules", part: { region: "recall-show" }, files: RECALL },
  {
    name: "postsession instructions",
    files: [
      { path: "system_prompts/postsession.md", part: "whole" },
      { path: "plugins/context-eng/skills/postsession/SKILL.md", part: { region: "postsession" } },
      { path: ".agents/skills/postsession/SKILL.md", part: { region: "postsession" } },
    ],
  },
  {
    name: "postsession host templates",
    part: "body",
    files: [
      "system_prompts/postsession/claude/SKILL.md",
      "system_prompts/postsession/codex/SKILL.md",
      "system_prompts/postsession/opencode/postsession.md",
    ],
  },
  {
    name: "memory tool contract",
    part: "whole",
    files: ["system_prompts/rules.md", "plugins/context-eng/skills/context-memory/references/rules.md"],
  },
  {
    name: "context-memory skill",
    part: "whole",
    files: [".agent/SKILL.md", "plugins/context-eng/skills/context-memory/SKILL.md"],
  },
];

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

function regionMarkers(part) {
  if (part.markers) return part.markers;
  return [`<!-- sync:${part.region} -->`, `<!-- /sync:${part.region} -->`];
}

function trimNewlines(text) {
  return text.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/** Returns the shared text of `part` inside `text`, or throws when the part is missing. */
export function extract(text, part, label = "file") {
  if (part === "whole") return trimNewlines(text);
  if (part === "body") return trimNewlines(text.replace(FRONTMATTER, ""));
  const [start, end] = regionMarkers(part);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`${label}: missing ${start} … ${end}`);
  return trimNewlines(text.slice(from + start.length, to));
}

/** Returns `text` with the shared text of `part` replaced by `content`. */
export function replace(text, part, content, label = "file") {
  if (part === "whole") return `${content}\n`;
  if (part === "body") {
    const head = FRONTMATTER.exec(text)?.[0] ?? "";
    return `${head}${content}\n`;
  }
  const [start, end] = regionMarkers(part);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`${label}: missing ${start} … ${end}`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function normalizeFiles(group) {
  return group.files.map((file) => (typeof file === "string" ? { path: file, part: group.part } : file));
}

/**
 * Syncs every group under `root`. Options: `check` (report only), `from` (forced source path),
 * `stage` (git add rewritten files; refuses files with unstaged edits), `groups` (override GROUPS).
 * Returns `{ changed, drift, errors }`: rewritten paths, out-of-sync group names, and messages.
 */
export function sync(root, options = {}) {
  const groups = options.groups ?? GROUPS;
  const forced = options.from ? path.relative(root, path.resolve(root, options.from)).split(path.sep).join("/") : null;
  const changed = [];
  const drift = [];
  const errors = [];

  for (const group of groups) {
    const files = normalizeFiles(group);
    const copies = [];
    try {
      for (const file of files) {
        const absolute = path.join(root, file.path);
        if (!existsSync(absolute)) throw new Error(`${file.path}: file is missing`);
        const text = readFileSync(absolute, "utf8");
        copies.push({ ...file, absolute, text, shared: extract(text, file.part, file.path) });
      }
    } catch (error) {
      errors.push(`[${group.name}] ${error.message}`);
      continue;
    }

    const distinct = new Set(copies.map((copy) => copy.shared));
    if (distinct.size === 1) continue;
    drift.push(group.name);
    if (options.check) {
      errors.push(`[${group.name}] copies differ: ${copies.map((copy) => copy.path).join(", ")}`);
      continue;
    }

    let source = forced ? copies.find((copy) => copy.path === forced) : undefined;
    if (!source) {
      const edited = copies.filter((copy) => {
        const committed = git(root, ["show", `HEAD:${copy.path}`]);
        if (committed === null) return true;
        try {
          return extract(committed, copy.part, copy.path) !== copy.shared;
        } catch {
          return true;
        }
      });
      const versions = new Set(edited.map((copy) => copy.shared));
      if (versions.size !== 1) {
        const why = versions.size === 0
          ? "no copy changed since the last commit, so the source is unclear"
          : `several copies changed differently (${edited.map((copy) => copy.path).join(", ")})`;
        errors.push(`[${group.name}] ${why}. Rerun with --from <file> to choose the source.`);
        continue;
      }
      source = edited[0];
    }

    for (const copy of copies) {
      if (copy.shared === source.shared) continue;
      if (options.stage) {
        const unstaged = git(root, ["diff", "--name-only", "--", copy.path]);
        if (unstaged && unstaged.trim()) {
          errors.push(`[${group.name}] ${copy.path} has unstaged edits; stage or stash them, then commit again.`);
          continue;
        }
      }
      writeFileSync(copy.absolute, replace(copy.text, copy.part, source.shared, copy.path), "utf8");
      if (options.stage) git(root, ["add", "--", copy.path]);
      changed.push(`${copy.path} (from ${source.path})`);
    }
  }
  return { changed, drift, errors };
}

function main(argv) {
  const options = { check: false, stage: false, from: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--stage") options.stage = true;
    else if (arg === "--from") options.from = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/sync-prompts.mjs [--check | --stage] [--from <file>]\n");
      return 0;
    } else {
      process.stderr.write(`sync-prompts: unknown argument ${arg}\n`);
      return 2;
    }
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { changed, drift, errors } = sync(root, options);
  for (const line of changed) process.stdout.write(`sync-prompts: updated ${line}\n`);
  for (const line of errors) process.stderr.write(`sync-prompts: ${line}\n`);
  if (options.check && !errors.length) process.stdout.write(`sync-prompts: all ${GROUPS.length} groups in sync\n`);
  else if (!options.check && !drift.length && !errors.length) process.stdout.write("sync-prompts: nothing to sync\n");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
