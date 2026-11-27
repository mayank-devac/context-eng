import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");

type Part = "whole" | "body" | { region: string } | { markers: [string, string] };
interface Group { name: string; part?: Part; files: (string | { path: string; part: Part })[] }
interface SyncResult { changed: string[]; drift: string[]; errors: string[] }
interface SyncModule {
  GROUPS: Group[];
  extract(text: string, part: Part): string;
  replace(text: string, part: Part, content: string): string;
  sync(root: string, options?: { check?: boolean; stage?: boolean; from?: string; groups?: Group[] }): SyncResult;
}

let mod: SyncModule;
beforeAll(async () => {
  mod = (await import(pathToFileURL(path.join(REPO, "scripts/sync-prompts.mjs")).href)) as SyncModule;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ce-sync-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const MARKERS: Part = { markers: ["<!-- s -->", "<!-- e -->"] };
const groups: Group[] = [{ name: "block", part: MARKERS, files: ["a.md", "b.md", "c.md"] }];
const block = (inner: string, extra = "") => `${extra}<!-- s -->\n${inner}\n<!-- e -->\n`;

describe("sync-prompts", () => {
  it("keeps the repository's shared prompt text in sync", () => {
    const result = mod.sync(REPO, { check: true });
    expect(result.errors).toEqual([]);
  });

  it("extracts and replaces each kind of part", () => {
    const doc = "---\nname: x\n---\nintro\n<!-- sync:r -->\nold\n<!-- /sync:r -->\ntail\n";
    expect(mod.extract(doc, { region: "r" })).toBe("old");
    expect(mod.replace(doc, { region: "r" }, "new")).toBe("---\nname: x\n---\nintro\n<!-- sync:r -->\nnew\n<!-- /sync:r -->\ntail\n");
    expect(mod.extract(doc, "body")).toContain("intro");
    expect(mod.replace(doc, "body", "fresh")).toBe("---\nname: x\n---\nfresh\n");
    expect(mod.extract("\n\nall\n\n", "whole")).toBe("all");
    expect(() => mod.extract("no markers", { region: "r" })).toThrow(/missing/);
  });

  it("copies the one edited file's text to every other copy and keeps their own text", () => {
    const root = repoWith({ "a.md": block("v1", "# A\n"), "b.md": block("v1", "# B\n"), "c.md": block("v1") });
    writeFileSync(path.join(root, "b.md"), block("v2 from b", "# B\n"));
    const result = mod.sync(root, { groups });
    expect(result.errors).toEqual([]);
    expect(readFileSync(path.join(root, "a.md"), "utf8")).toBe(block("v2 from b", "# A\n"));
    expect(readFileSync(path.join(root, "c.md"), "utf8")).toBe(block("v2 from b"));
    expect(mod.sync(root, { groups, check: true }).errors).toEqual([]);
  });

  it("stops when two copies were edited differently, unless --from picks one", () => {
    const root = repoWith({ "a.md": block("v1"), "b.md": block("v1"), "c.md": block("v1") });
    writeFileSync(path.join(root, "a.md"), block("from a"));
    writeFileSync(path.join(root, "b.md"), block("from b"));
    const conflict = mod.sync(root, { groups });
    expect(conflict.errors.join("\n")).toMatch(/changed differently/);
    expect(readFileSync(path.join(root, "c.md"), "utf8")).toBe(block("v1"));

    expect(mod.sync(root, { groups, from: "a.md" }).errors).toEqual([]);
    expect(readFileSync(path.join(root, "b.md"), "utf8")).toBe(block("from a"));
  });

  it("stages rewritten copies in pre-commit mode and refuses copies with unstaged edits", () => {
    const root = repoWith({ "a.md": block("v1"), "b.md": block("v1", "# B\n"), "c.md": block("v1") });
    writeFileSync(path.join(root, "a.md"), block("v2"));
    git(root, "add", "a.md");
    expect(mod.sync(root, { groups, stage: true }).errors).toEqual([]);
    expect(git(root, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual(["a.md", "b.md", "c.md"]);

    git(root, "commit", "-q", "-m", "v2");
    writeFileSync(path.join(root, "a.md"), block("v3"));
    git(root, "add", "a.md");
    writeFileSync(path.join(root, "b.md"), block("v2", "# B changed\n"));
    const refused = mod.sync(root, { groups, stage: true });
    expect(refused.errors.join("\n")).toMatch(/b\.md has unstaged edits/);
  });

  it("lists every recall and instructions copy, including the plugin", () => {
    const all = mod.GROUPS.flatMap((group) => group.files.map((file) => (typeof file === "string" ? file : file.path)));
    expect(all).toEqual(expect.arrayContaining([
      "system_prompts/AGENTS.md",
      "system_prompts/CLAUDE.md",
      "AGENTS.md",
      "CLAUDE.md",
      "plugins/context-eng/rules/AGENTS.md",
      "plugins/context-eng/skills/recall/SKILL.md",
      "plugins/context-eng/skills/postsession/SKILL.md",
    ]));
  });
});
