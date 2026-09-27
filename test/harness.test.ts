import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHarnessChoiceKey,
  chosenHarnessIds,
  detectHarnesses,
  formatHarnessReport,
  initialHarnessChoice,
  installDetectedHarnesses,
  mcpLaunch,
  upsertMcpJson,
  upsertTomlSection,
  writeConfigAtomically,
} from "../src/harness.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "ce-harness-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("mcpLaunch", () => {
  it("uses npx when npx is available", () => {
    expect(mcpLaunch((name) => name === "npx" || name === "pnpm")).toEqual({
      command: "npx",
      args: ["-y", "context-eng", "mcp"],
    });
  });

  it("uses pnpm dlx when npx is missing", () => {
    expect(mcpLaunch((name) => name === "pnpm")).toEqual({
      command: "pnpm",
      args: ["dlx", "context-eng", "mcp"],
    });
  });
});

describe("detectHarnesses", () => {
  it("lists every harness and marks only the ones present", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".claude.json"), "{}\n", "utf8");
    const hits = detectHarnesses({ home, hasCommand: () => false });
    expect(hits).toEqual([
      { id: "cursor", installed: true, via: "~/.cursor" },
      { id: "claude", installed: true, via: "~/.claude.json" },
      { id: "codex", installed: false, via: "not installed" },
    ]);
  });

  it("prefers a command on PATH over a config directory", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    expect(detectHarnesses({ home, hasCommand: (name) => name === "codex" })[2]).toEqual({
      id: "codex",
      installed: true,
      via: "codex on PATH",
    });
  });
});

describe("config merges", () => {
  it("keeps other Cursor servers and other Claude settings", () => {
    expect(upsertMcpJson(
      JSON.stringify({ mcpServers: { other: { command: "other" } } }),
      "context-eng",
      { command: "npx", args: ["-y", "context-eng", "mcp"] },
    )).toBe(`${JSON.stringify({
      mcpServers: {
        other: { command: "other" },
        "context-eng": { command: "npx", args: ["-y", "context-eng", "mcp"] },
      },
    }, null, 2)}\n`);

    const claude = upsertMcpJson(
      JSON.stringify({ theme: "dark", mcpServers: {} }),
      "context-eng",
      { type: "stdio", command: "npx", args: ["-y", "context-eng", "mcp"] },
    );
    expect(JSON.parse(claude)).toMatchObject({ theme: "dark" });
  });

  it("replaces the Codex server table and keeps the next table", () => {
    const next = upsertTomlSection(
      "model = \"gpt\"\n\n[mcp_servers.context-eng]\ncommand = \"node\"\n\n[other]\nkeep = true\n",
      "mcp_servers.context-eng",
      ['command = "npx"', 'args = ["-y", "context-eng", "mcp"]'],
    );
    expect(next).toContain('model = "gpt"');
    expect(next).toContain('command = "npx"');
    expect(next).not.toContain('command = "node"');
    expect(next).toContain("[other]\nkeep = true");
  });
});

describe("writeConfigAtomically", () => {
  it.skipIf(process.platform === "win32")("keeps a config symlink and the target's mode", () => {
    const home = tempHome();
    const target = path.join(home, "real", "config.json");
    const link = path.join(home, ".claude.json");
    mkdirSync(path.dirname(target));
    writeFileSync(target, "old", "utf8");
    chmodSync(target, 0o600);
    symlinkSync(target, link);

    writeConfigAtomically(link, "new");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("harness choice", () => {
  it("starts with every harness selected and drops the one toggled off", () => {
    let choice = initialHarnessChoice(["cursor", "claude", "codex"]);
    expect(chosenHarnessIds(choice)).toEqual(["cursor", "claude", "codex"]);
    choice = applyHarnessChoiceKey(choice, "\u001b[B").choice;
    choice = applyHarnessChoiceKey(choice, " ").choice;
    expect(applyHarnessChoiceKey(choice, "\n")).toMatchObject({ done: true });
    expect(chosenHarnessIds(choice)).toEqual(["cursor", "codex"]);
  });
});

describe("installDetectedHarnesses", () => {
  it("writes only installed harnesses and lists the rest", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    mkdirSync(path.join(home, ".codex"));
    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });
    expect(formatHarnessReport(report)).toBe([
      "Harnesses",
      `  cursor: installed (~/.cursor) -> ${path.join(home, ".cursor", "mcp.json")}`,
      "  claude: not installed",
      `  codex: installed (~/.codex) -> ${path.join(home, ".codex", "config.toml")}`,
      "  server: npx -y context-eng mcp",
    ].join("\n"));
    expect(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        "context-eng": { command: "npx", args: ["-y", "context-eng", "mcp"] },
      },
    });
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.context-eng]");
    expect(report.harnesses.some((item) => item.file?.includes(".claude.json"))).toBe(false);
  });

  it("leaves an invalid Cursor config untouched", async () => {
    const home = tempHome();
    const file = path.join(home, ".cursor", "mcp.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{", "utf8");
    const report = await installDetectedHarnesses({ home, hasCommand: () => false });
    const cursor = report.harnesses[0];
    expect(cursor?.error).toContain("invalid JSON");
    expect(readFileSync(file, "utf8")).toBe("{");
  });

  it("uses pnpm dlx in the written server when npx is absent", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"));
    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "pnpm" });
    const saved = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers: { "context-eng": { command: string; args: string[] } };
    };
    expect(saved.mcpServers["context-eng"]).toEqual({
      type: "stdio",
      command: "pnpm",
      args: ["dlx", "context-eng", "mcp"],
    });
    expect(report.launch.command).toBe("pnpm");
  });

  it("does not write a harness the user turned off", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    mkdirSync(path.join(home, ".codex"));
    const report = await installDetectedHarnesses({
      home,
      hasCommand: () => false,
      selected: ["cursor"],
    });
    expect(formatHarnessReport(report)).toContain("codex: installed (~/.codex) - not selected");
    expect(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).toContain("context-eng");
    expect(() => readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toThrow();
  });

  it("keeps an identical Claude server without rewriting the config", async () => {
    const home = tempHome();
    const file = path.join(home, ".claude.json");
    const original = JSON.stringify({
      theme: "dark",
      mcpServers: {
        "context-eng": { type: "stdio", command: "npx", args: ["-y", "context-eng", "mcp"] },
      },
    });
    writeFileSync(file, original, "utf8");

    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });

    expect(report.harnesses[1]).toMatchObject({ unchanged: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("keeps a different Claude server unless replacement is accepted", async () => {
    const home = tempHome();
    const file = path.join(home, ".claude.json");
    const original = JSON.stringify({ mcpServers: {
      "context-eng": { type: "stdio", command: "node", args: ["custom.js", "mcp", "--project", "/repo"] },
    } });
    writeFileSync(file, original, "utf8");

    const kept = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });
    expect(kept.harnesses[1]).toMatchObject({ preserved: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);

    const replaced = await installDetectedHarnesses({
      home,
      hasCommand: (name) => name === "npx",
      confirmReplace: (id, target) => id === "claude" && target === file,
    });
    expect(replaced.harnesses[1]).toMatchObject({ file });
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["context-eng"]).toEqual({
      type: "stdio", command: "npx", args: ["-y", "context-eng", "mcp"],
    });
  });

  it("keeps a different Codex server and its tool approvals until replacement is accepted", async () => {
    const home = tempHome();
    const file = path.join(home, ".codex", "config.toml");
    const original = '[mcp_servers.context-eng]\ncommand = "node"\nargs = ["custom.js"]\n\n[mcp_servers.context-eng.tools.memory_search]\napproval_mode = "approve"\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original, "utf8");

    const kept = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });
    expect(kept.harnesses[2]).toMatchObject({ preserved: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);

    await installDetectedHarnesses({
      home,
      hasCommand: (name) => name === "npx",
      confirmReplace: (id) => id === "codex",
    });
    const updated = readFileSync(file, "utf8");
    expect(updated).toContain('command = "npx"');
    expect(updated).toContain('[mcp_servers.context-eng.tools.memory_search]\napproval_mode = "approve"');
  });

  it("leaves an identical Codex server and its tool approvals untouched", async () => {
    const home = tempHome();
    const file = path.join(home, ".codex", "config.toml");
    const original = '[mcp_servers.context-eng]\ncommand = "npx"\nargs = ["-y", "context-eng", "mcp"]\n\n[mcp_servers.context-eng.tools.memory_search]\napproval_mode = "approve"\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original, "utf8");

    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });
    expect(report.harnesses[2]).toMatchObject({ unchanged: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("recognizes a quoted Codex server name before writing", async () => {
    const home = tempHome();
    const file = path.join(home, ".codex", "config.toml");
    const original = '[mcp_servers."context-eng"]\ncommand = "node"\nargs = ["custom.js"]\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original, "utf8");

    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx" });
    expect(report.harnesses[2]).toMatchObject({ preserved: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});
