import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentPointerBlock,
  claudeRulePath,
  codexAgentsPath,
  cursorRulePath,
  globalClaudeAgentsPath,
  globalCursorRulePath,
  resolveCursorRuleScope,
  upsertMarkedBlock,
  updateExistingPointer,
  writeClaudeRule,
  writeClaudeRules,
  writeCodexAgentsPointer,
  writeCursorRule,
  writeCursorRules,
  writeGlobalClaudePointer,
} from "../src/cli.js";
import { resolveProjectPath } from "../src/paths.js";

const BLOCK = `<!-- context-eng:start -->
Use the memory MCP tools.
<!-- context-eng:end -->`;

describe("upsertMarkedBlock", () => {
  it("creates a file that contains only the marked pointer", () => {
    expect(upsertMarkedBlock(null, BLOCK)).toBe(`${BLOCK}\n`);
    expect(upsertMarkedBlock("   ", BLOCK)).toBe(`${BLOCK}\n`);
  });

  it("replaces an existing marked block and leaves the rest of the file", () => {
    const existing = `# Agents\n\nHello.\n${BLOCK}\nKeep me.\n`;
    const next = `<!-- context-eng:start -->\nNew pointer.\n<!-- context-eng:end -->`;
    expect(upsertMarkedBlock(existing, next)).toBe(
      `# Agents\n\nHello.\n${next}\nKeep me.\n`,
    );
  });

  it("appends the block when the file has no markers", () => {
    expect(upsertMarkedBlock("# Agents\n\nHello.\n", BLOCK)).toBe(
      `# Agents\n\nHello.\n\n${BLOCK}\n`,
    );
  });
});

describe("updateExistingPointer", () => {
  it("edits an existing file and does not create a missing one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "context-eng-pointer-"));
    const existing = path.join(dir, "AGENTS.md");
    const missing = path.join(dir, "CLAUDE.md");
    writeFileSync(existing, "# Keep\n\nHello.\n", "utf8");

    expect(updateExistingPointer(existing, BLOCK)).toBe(true);
    expect(updateExistingPointer(missing, BLOCK)).toBe(false);
    expect(readFileSync(existing, "utf8")).toContain("# Keep");
    expect(readFileSync(existing, "utf8")).toContain("Use the memory MCP tools.");
    expect(existsSync(missing)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("agentPointerBlock", () => {
  it("loads the system_prompts AGENTS.md template once, with MCP underscores", () => {
    const block = agentPointerBlock();
    expect(block.startsWith("<!-- context-eng:start -->\n")).toBe(true);
    expect(block.endsWith("<!-- context-eng:end -->\n")).toBe(true);
    expect(block).toContain("memory_search");
    expect(block).not.toContain("memory.search");
    expect(block.split("<!-- context-eng:start -->")).toHaveLength(2);
  });
});

describe("codexAgentsPath", () => {
  it("points at ~/.codex/AGENTS.md", () => {
    expect(codexAgentsPath("/tmp/home")).toBe(path.join("/tmp/home", ".codex", "AGENTS.md"));
    expect(codexAgentsPath()).toBe(path.join(os.homedir(), ".codex", "AGENTS.md"));
  });
});

describe("writeCodexAgentsPointer", () => {
  it("upserts only the marked block into ~/.codex/AGENTS.md", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "context-eng-home-"));
    const existing = `# Codex\n\nKeep me.\n${BLOCK}\nTail.\n`;
    const codexDir = path.join(home, ".codex");
    const file = path.join(codexDir, "AGENTS.md");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(file, existing, "utf8");

    const updated = writeCodexAgentsPointer(agentPointerBlock(), home);
    const next = readFileSync(updated, "utf8");

    expect(updated).toBe(file);
    expect(next).toContain("# Codex");
    expect(next).toContain("Keep me.");
    expect(next).toContain("Tail.");
    expect(next).toContain("memory_search");
    expect(next.split("<!-- context-eng:start -->")).toHaveLength(2);

    rmSync(home, { recursive: true, force: true });
  });
});

describe("cursorRulePath", () => {
  it("points at .cursor/rules/context-eng-memory.mdc in the project", () => {
    expect(cursorRulePath("/workspaces/demo")).toBe(
      path.join("/workspaces/demo", ".cursor", "rules", "context-eng-memory.mdc"),
    );
  });
});

describe("globalCursorRulePath", () => {
  it("points at ~/.cursor/rules/context-eng-memory.mdc", () => {
    expect(globalCursorRulePath("/tmp/home")).toBe(
      path.join("/tmp/home", ".cursor", "rules", "context-eng-memory.mdc"),
    );
  });
});

describe("resolveCursorRuleScope", () => {
  it("defaults to global without project, project with project, and honors explicit scope", () => {
    expect(resolveCursorRuleScope(undefined, undefined)).toBe("global");
    expect(resolveCursorRuleScope(undefined, "/workspaces/demo")).toBe("project");
    expect(resolveCursorRuleScope("both", "/workspaces/demo")).toBe("both");
    expect(resolveCursorRuleScope("global", "/workspaces/demo")).toBe("global");
  });
});

describe("writeCursorRules", () => {
  it("writes global, project, or both rule files", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "context-eng-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "context-eng-project-"));

    expect(writeCursorRules(BLOCK, { scope: "global", home })).toEqual([globalCursorRulePath(home)]);
    const resolvedProject = resolveProjectPath(project);
    expect(writeCursorRules(BLOCK, { scope: "project", project })).toEqual([
      cursorRulePath(resolvedProject),
    ]);
    expect(writeCursorRules(BLOCK, { scope: "both", project, home }).sort()).toEqual(
      [globalCursorRulePath(home), cursorRulePath(resolvedProject)].sort(),
    );

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});

describe("writeCursorRule", () => {
  it("creates a Cursor rule with frontmatter and upserts the marked block on update", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "context-eng-project-"));
    const file = cursorRulePath(project);
    const first = writeCursorRule(BLOCK, project);
    const created = readFileSync(first, "utf8");

    expect(first).toBe(file);
    expect(created).toContain("alwaysApply: true");
    expect(created).toContain("Use the memory MCP tools.");

    const updated = writeCursorRule(agentPointerBlock(), project);
    const next = readFileSync(updated, "utf8");

    expect(updated).toBe(file);
    expect(next).toContain("alwaysApply: true");
    expect(next).toContain("memory_search");
    expect(next.split("<!-- context-eng:start -->")).toHaveLength(2);

    rmSync(project, { recursive: true, force: true });
  });
});

describe("claudeRulePath", () => {
  it("points at .claude/rules/context-eng-memory.md in the project", () => {
    expect(claudeRulePath("/workspaces/demo")).toBe(
      path.join("/workspaces/demo", ".claude", "rules", "context-eng-memory.md"),
    );
  });
});

describe("globalClaudeAgentsPath", () => {
  it("points at ~/.claude/CLAUDE.md", () => {
    expect(globalClaudeAgentsPath("/tmp/home")).toBe(
      path.join("/tmp/home", ".claude", "CLAUDE.md"),
    );
  });
});

describe("writeGlobalClaudePointer", () => {
  it("keeps existing global Claude instructions around the marked block", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "context-eng-home-"));
    const file = globalClaudeAgentsPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `# Claude\nKeep me.\n${BLOCK}\nTail.\n`, "utf8");

    expect(writeGlobalClaudePointer(agentPointerBlock(), home)).toBe(file);
    const updated = readFileSync(file, "utf8");
    expect(updated).toContain("Keep me.");
    expect(updated).toContain("Tail.");
    expect(updated).toContain("memory_search");
    expect(updated.split("<!-- context-eng:start -->")).toHaveLength(2);

    rmSync(home, { recursive: true, force: true });
  });
});

describe("writeClaudeRules", () => {
  it("writes global CLAUDE.md, project rules, or both", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "context-eng-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "context-eng-project-"));
    const resolvedProject = resolveProjectPath(project);

    expect(writeClaudeRules(BLOCK, { scope: "global", home })).toEqual([globalClaudeAgentsPath(home)]);
    expect(writeClaudeRules(BLOCK, { scope: "project", project })).toEqual([
      claudeRulePath(resolvedProject),
    ]);
    expect(writeClaudeRules(BLOCK, { scope: "both", project, home }).sort()).toEqual(
      [globalClaudeAgentsPath(home), claudeRulePath(resolvedProject)].sort(),
    );

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});

describe("writeClaudeRule", () => {
  it("upserts the marked block without Cursor frontmatter", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "context-eng-project-"));
    const file = claudeRulePath(project);
    const first = writeClaudeRule(BLOCK, project);
    const created = readFileSync(first, "utf8");

    expect(first).toBe(file);
    expect(created).not.toContain("alwaysApply");
    expect(created).toContain("Use the memory MCP tools.");

    const updated = writeClaudeRule(agentPointerBlock(), project);
    const next = readFileSync(updated, "utf8");

    expect(next).toContain("memory_search");
    expect(next.split("<!-- context-eng:start -->")).toHaveLength(2);

    rmSync(project, { recursive: true, force: true });
  });
});
