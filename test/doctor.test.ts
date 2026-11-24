import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLaunch, formatDoctor, runDoctor, shellWords } from "../src/doctor.js";
import { checkSpawnDepth, DEPTH_VARIABLE, MAX_DEPTH } from "../src/spawn-guard.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ce-doctor-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkSpawnDepth", () => {
  it("allows a normal start and passes depth + 1 to children", () => {
    expect(checkSpawnDepth({})).toEqual({ ok: true, nextDepth: "1" });
    expect(checkSpawnDepth({ [DEPTH_VARIABLE]: "1" })).toEqual({ ok: true, nextDepth: "2" });
  });

  it("refuses once the nesting limit is reached", () => {
    const result = checkSpawnDepth({ [DEPTH_VARIABLE]: String(MAX_DEPTH) });
    expect(result.ok).toBe(false);
  });

  it("treats junk values as depth 0", () => {
    expect(checkSpawnDepth({ [DEPTH_VARIABLE]: "abc" })).toEqual({ ok: true, nextDepth: "1" });
    expect(checkSpawnDepth({ [DEPTH_VARIABLE]: "-5" })).toEqual({ ok: true, nextDepth: "1" });
  });
});

describe("doctor", () => {
  const exists = (file: string) => file.startsWith("/good/");

  it("flags npx, missing paths, and accepts good absolute paths", () => {
    expect(checkLaunch("f", "MCP server", ["npx", "-y", "context-eng", "mcp"], exists).level).toBe("warn");
    expect(checkLaunch("f", "MCP server", ["pnpm", "dlx", "context-eng", "mcp"], exists).level).toBe("warn");
    expect(checkLaunch("f", "MCP server", ["/gone/node", "/good/cli-entry.js", "mcp"], exists)).toMatchObject({
      level: "error", message: expect.stringContaining("/gone/node"),
    });
    expect(checkLaunch("f", "MCP server", ["/good/node", "/good/cli-entry.js", "mcp"], exists).level).toBe("ok");
  });

  it("splits quoted hook commands", () => {
    expect(shellWords("'/a b/node' '/x/cli-entry.js' 'hook' --context-eng-recall")).toEqual([
      "/a b/node", "/x/cli-entry.js", "hook", "--context-eng-recall",
    ]);
  });

  it("reads Claude, Cursor, Codex servers and hooks from a home folder", () => {
    const home = tempDir();
    const project = tempDir();
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "context-eng": { type: "stdio", command: "/good/node", args: ["/good/cli-entry.js", "mcp"] },
    } }));
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
      other: { command: "npx" },
      "context-eng": { command: "npx", args: ["-y", "context-eng", "mcp"] },
    } }));
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.context-eng]",
      'command = "/gone/node"',
      'args = ["/good/cli-entry.js", "mcp"]',
      "[mcp_servers.other]",
      'command = "npx"',
    ].join("\n"));
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
      { type: "command", command: "'/good/node' '/good/cli-entry.js' 'hook' --context-eng-recall" },
      { type: "command", command: "echo unrelated" },
    ] }] } }));

    const findings = runDoctor({ home, projectPath: project, exists });
    expect(findings.map((item) => [item.file.replace(home, "~"), item.what, item.level])).toEqual([
      ["~/.claude.json", "MCP server", "ok"],
      ["~/.cursor/mcp.json", "MCP server", "warn"],
      ["~/.codex/config.toml", "MCP server", "error"],
      ["~/.claude/settings.json", "hook", "ok"],
    ]);
    expect(formatDoctor(findings)).toContain("2 problem(s) found.");
  });

  it("says so when nothing is configured", () => {
    expect(formatDoctor(runDoctor({ home: tempDir(), projectPath: tempDir() }))).toContain("no context-eng launches found");
  });
});
