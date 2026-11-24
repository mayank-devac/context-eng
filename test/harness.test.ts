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
  NPX_FALLBACK_WARNING,
  opencodeConfigDir,
  opencodeConfigFile,
  upsertMcpJson,
  upsertOpencodeJson,
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
    expect(mcpLaunch((name) => name === "npx" || name === "pnpm", undefined, "linux")).toEqual({
      command: "npx",
      args: ["-y", "context-eng", "mcp"],
    });
  });

  it("uses pnpm dlx when npx is missing", () => {
    expect(mcpLaunch((name) => name === "pnpm", undefined, "linux")).toEqual({
      command: "pnpm",
      args: ["dlx", "context-eng", "mcp"],
    });
  });

  it("wraps npx and pnpm dlx in cmd /c on Windows", () => {
    expect(mcpLaunch((name) => name === "npx", undefined, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "context-eng", "mcp"],
    });
    expect(mcpLaunch((name) => name === "pnpm", undefined, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "pnpm", "dlx", "context-eng", "mcp"],
    });
  });

  it("uses node.exe directly on Windows when a durable runtime is given", () => {
    const durable = {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\context-eng\\dist\\cli-entry.js",
    };
    expect(mcpLaunch((name) => name === "npx", durable, "win32")).toEqual({
      command: durable.nodePath,
      args: [durable.entryPath, "mcp"],
    });
  });

  it("writes the cmd /c wrapper to Claude and Codex configs and still warns", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx", platform: "win32" });
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers["context-eng"]).toEqual({
      type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "context-eng", "mcp"],
    });
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8"))
      .toContain('args = ["/c", "npx", "-y", "context-eng", "mcp"]');
    expect(formatHarnessReport(report)).toContain(NPX_FALLBACK_WARNING);
  });

  it("uses absolute node + entry paths when a durable runtime is given", () => {
    const durable = { nodePath: "/opt/node/bin/node", entryPath: "/opt/lib/context-eng/dist/cli-entry.js" };
    expect(mcpLaunch((name) => name === "npx", durable)).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/lib/context-eng/dist/cli-entry.js", "mcp"],
    });
  });
});

describe("detectHarnesses", () => {
  it("lists every harness and marks only the ones present", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".claude.json"), "{}\n", "utf8");
    const hits = detectHarnesses({ home, hasCommand: () => false, env: {} });
    expect(hits).toEqual([
      { id: "cursor", installed: true, via: "~/.cursor" },
      { id: "claude", installed: true, via: "~/.claude.json" },
      { id: "codex", installed: false, via: "not installed" },
      { id: "opencode", installed: false, via: "not installed" },
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
    const report = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx", env: {} });
    expect(formatHarnessReport(report)).toBe([
      "Harnesses",
      `  cursor: installed (~/.cursor) -> ${path.join(home, ".cursor", "mcp.json")}`,
      "  claude: not installed",
      `  codex: installed (~/.codex) -> ${path.join(home, ".codex", "config.toml")}`,
      "  opencode: not installed",
      "  server: npx -y context-eng mcp",
      NPX_FALLBACK_WARNING,
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

  it("replaces an old npx Claude server with the absolute launch only after confirmation", async () => {
    const home = tempHome();
    const file = path.join(home, ".claude.json");
    const original = JSON.stringify({ mcpServers: {
      "context-eng": { type: "stdio", command: "npx", args: ["-y", "context-eng", "mcp"] },
    } });
    writeFileSync(file, original, "utf8");
    const durable = { nodePath: "/opt/node/bin/node", entryPath: "/opt/lib/context-eng/dist/cli-entry.js" };

    const kept = await installDetectedHarnesses({ home, hasCommand: (name) => name === "npx", durable });
    expect(kept.harnesses[1]).toMatchObject({ preserved: true, file });
    expect(readFileSync(file, "utf8")).toBe(original);

    const asked: string[] = [];
    const replaced = await installDetectedHarnesses({
      home,
      hasCommand: (name) => name === "npx",
      durable,
      confirmReplace: (id) => { asked.push(id); return true; },
    });
    expect(asked).toEqual(["claude"]);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["context-eng"]).toEqual({
      type: "stdio", command: "/opt/node/bin/node", args: ["/opt/lib/context-eng/dist/cli-entry.js", "mcp"],
    });
    expect(formatHarnessReport(replaced)).not.toContain("warning:");
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

describe("OpenCode", () => {
  const npx = (name: string) => name === "npx";
  const server = { type: "local", command: ["npx", "-y", "context-eng", "mcp"] };

  function opencodeFile(home: string, name = "opencode.json"): string {
    return path.join(home, ".config", "opencode", name);
  }

  it("detects OpenCode on PATH, by config dir, by ~/.opencode, and under XDG_CONFIG_HOME", () => {
    const home = tempHome();
    const find = (env: NodeJS.ProcessEnv, hasCommand: (name: string) => boolean = () => false) =>
      detectHarnesses({ home, hasCommand, env }).find((hit) => hit.id === "opencode");
    expect(find({})).toEqual({ id: "opencode", installed: false, via: "not installed" });
    expect(find({}, (name: string) => name === "opencode")).toMatchObject({ installed: true, via: "opencode on PATH" });
    mkdirSync(path.join(home, ".opencode"));
    expect(find({})).toMatchObject({ installed: true, via: "~/.opencode" });
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    expect(find({})).toMatchObject({ installed: true, via: "~/.config/opencode" });
    const xdg = tempHome();
    mkdirSync(path.join(xdg, "opencode"));
    expect(opencodeConfigDir(home, { XDG_CONFIG_HOME: xdg })).toBe(path.join(xdg, "opencode"));
    expect(opencodeConfigDir(home, { XDG_CONFIG_HOME: "relative" })).toBe(path.join(home, ".config", "opencode"));
    expect(find({ XDG_CONFIG_HOME: xdg })).toMatchObject({ installed: true, via: path.join(xdg, "opencode") });
  });

  it("creates opencode.json with $schema and the legacy entry both V1 and V2 accept", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".opencode"));
    const report = await installDetectedHarnesses({ home, hasCommand: npx, env: {} });
    expect(report.harnesses[3]).toMatchObject({ id: "opencode", file: opencodeFile(home) });
    expect(JSON.parse(readFileSync(opencodeFile(home), "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { "context-eng": server },
    });
  });

  it("writes into mcp.servers when the file already uses the V2 shape and drops a legacy duplicate", () => {
    const next = JSON.parse(upsertOpencodeJson(JSON.stringify({
      plugins: ["./plugins/a.js"],
      mcp: { timeout: { startup: 1000 }, servers: { other: { type: "local", command: ["x"] } }, "context-eng": { type: "local", command: ["old"] } },
    }), server)) as Record<string, unknown>;
    expect(next).toEqual({
      plugins: ["./plugins/a.js"],
      mcp: { timeout: { startup: 1000 }, servers: { other: { type: "local", command: ["x"] }, "context-eng": server } },
    });
  });

  it("keeps other legacy servers and settings", () => {
    const next = JSON.parse(upsertOpencodeJson(JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: ["./p.js"],
      mcp: { blender: { type: "local", command: ["uv"], enabled: true } },
    }), server)) as Record<string, unknown>;
    expect(next).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: ["./p.js"],
      mcp: { blender: { type: "local", command: ["uv"], enabled: true }, "context-eng": server },
    });
  });

  it("treats a legacy server literally named servers as a server, not the V2 map", () => {
    const legacy = { servers: { type: "local", command: ["s"] } };
    const next = JSON.parse(upsertOpencodeJson(JSON.stringify({ mcp: legacy }), server)) as { mcp: Record<string, unknown> };
    expect(next.mcp).toEqual({ ...legacy, "context-eng": server });
  });

  it("leaves an identical entry alone and preserves a different one until replacement is accepted", async () => {
    const home = tempHome();
    const file = opencodeFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const same = JSON.stringify({ mcp: { servers: { "context-eng": server } } });
    writeFileSync(file, same, "utf8");
    chmodSync(file, 0o600);
    expect((await installDetectedHarnesses({ home, hasCommand: npx, env: {} })).harnesses[3])
      .toMatchObject({ unchanged: true, file });
    expect(readFileSync(file, "utf8")).toBe(same);

    const different = JSON.stringify({ mcp: { "context-eng": { type: "local", command: ["node", "custom.js"] } } });
    writeFileSync(file, different, "utf8");
    expect((await installDetectedHarnesses({ home, hasCommand: npx, env: {} })).harnesses[3])
      .toMatchObject({ preserved: true, file });
    expect(readFileSync(file, "utf8")).toBe(different);

    await installDetectedHarnesses({ home, hasCommand: npx, env: {}, confirmReplace: (id) => id === "opencode" });
    expect(JSON.parse(readFileSync(file, "utf8")).mcp["context-eng"]).toEqual(server);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("uses an existing opencode.jsonc but never edits one with comments", async () => {
    const home = tempHome();
    const file = opencodeFile(home, "opencode.jsonc");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ "$schema": "https://opencode.ai/config.json" }', "utf8");
    expect((await installDetectedHarnesses({ home, hasCommand: npx, env: {} })).harnesses[3]).toMatchObject({ file });
    expect(JSON.parse(readFileSync(file, "utf8")).mcp["context-eng"]).toEqual(server);

    const commented = '{\n  // my servers\n  "mcp": {}\n}\n';
    writeFileSync(file, commented, "utf8");
    const report = await installDetectedHarnesses({ home, hasCommand: npx, env: {} });
    expect(report.harnesses[3]?.error).toContain("add the server by hand");
    expect(readFileSync(file, "utf8")).toBe(commented);
  });

  it("reads comments in a plain opencode.json: unchanged when current, hand-edit error otherwise", async () => {
    const home = tempHome();
    const file = opencodeFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const current = `{\n  // mine\n  "mcp": { "context-eng": ${JSON.stringify(server)}, },\n}\n`;
    writeFileSync(file, current, "utf8");
    expect((await installDetectedHarnesses({ home, hasCommand: npx, env: {} })).harnesses[3])
      .toMatchObject({ file, unchanged: true });

    const missing = '{\n  // mine\n  "mcp": {}\n}\n';
    writeFileSync(file, missing, "utf8");
    const report = await installDetectedHarnesses({ home, hasCommand: npx, env: {} });
    expect(report.harnesses[3]?.error).toContain("add the server by hand");
    expect(report.harnesses[3]?.error).toContain('"context-eng"');
    expect(readFileSync(file, "utf8")).toBe(missing);
  });

  it("prefers opencode.json when both files exist and reports invalid JSON untouched", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeFile(home, "opencode.jsonc"), "{}", "utf8");
    writeFileSync(opencodeFile(home), "{", "utf8");
    expect(opencodeConfigFile(home, undefined, {})).toBe(opencodeFile(home));
    const report = await installDetectedHarnesses({ home, hasCommand: npx, env: {} });
    expect(report.harnesses[3]?.error).toContain("invalid JSON");
    expect(readFileSync(opencodeFile(home), "utf8")).toBe("{");
  });

  it("writes the durable node + entry launch as one command array", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".opencode"));
    const durable = { nodePath: "/opt/node/bin/node", entryPath: "/opt/lib/context-eng/dist/cli-entry.js" };
    await installDetectedHarnesses({ home, hasCommand: npx, env: {}, durable });
    expect(JSON.parse(readFileSync(opencodeFile(home), "utf8")).mcp["context-eng"]).toEqual({
      type: "local", command: ["/opt/node/bin/node", "/opt/lib/context-eng/dist/cli-entry.js", "mcp"],
    });
  });
});
