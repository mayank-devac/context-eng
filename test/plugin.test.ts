import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(REPO, "plugins/context-eng");

interface CommandEntry { name: string; description: string; execute(input: { sessionID: string; prompt: { text: string }; delivery: string }): Promise<void> }
interface Editor<T> { get(name: string): T | undefined; set(name: string, value: T): void; add(value: T): void }
type SystemPart = { type: string; text: string };

function editor<T>(initial: Record<string, T> = {}) {
  const items = new Map(Object.entries(initial));
  const added: T[] = [];
  const api: Editor<T> = {
    get: (name) => items.get(name),
    set: (name, value) => void items.set(name, value),
    add: (value) => void added.push(value),
  };
  return { api, items, added };
}

describe("context-eng plugin", () => {
  it("passes the static validation for every host", async () => {
    const { validatePlugin } = (await import(pathToFileURL(path.join(REPO, "scripts/validate-plugins.mjs")).href)) as { validatePlugin(): string[] };
    expect(validatePlugin()).toEqual([]);
  });

  it("SessionStart hook returns the instructions block and the project root", () => {
    const result = spawnSync(process.execPath, [path.join(PLUGIN, "scripts/session-start.mjs")], {
      input: JSON.stringify({ cwd: "/work/repo" }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("<!-- context-eng:start -->");
    expect(output.hookSpecificOutput.additionalContext).toContain("`/work/repo`");
  });

  it("SessionStart hook fails open on bad input", () => {
    const result = spawnSync(process.execPath, [path.join(PLUGIN, "scripts/session-start.mjs")], { input: "not json", encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("OpenCode entry adds the MCP server, both commands, and the instructions once", async () => {
    const plugin = (await import(pathToFileURL(path.join(PLUGIN, "server.js")).href)) as {
      default: { id: string; setup(ctx: unknown): Promise<void> };
    };
    expect(plugin.default.id).toBe("context-eng");

    const mcp = editor<{ type: string; command: string[] }>();
    const commands = editor<CommandEntry>();
    let contextHook: ((event: { system: SystemPart[] }) => Promise<void>) | undefined;
    const prompts: { text: string }[] = [];
    await plugin.default.setup({
      mcp: { transform: async (fn: (e: Editor<{ type: string; command: string[] }>) => void) => fn(mcp.api) },
      command: { transform: async (fn: (e: Editor<CommandEntry>) => void) => fn(commands.api) },
      session: {
        hook: async (name: string, fn: (event: { system: SystemPart[] }) => Promise<void>) => { if (name === "context") contextHook = fn; },
        prompt: async (input: { text: string }) => void prompts.push(input),
      },
    });

    const server = mcp.items.get("context-eng");
    expect(server?.type).toBe("local");
    expect(server?.command.at(-2)).toBe(path.join(PLUGIN, "scripts/mcp.mjs"));

    expect(commands.added.map((command) => command.name)).toEqual(["context-eng:recall", "context-eng:postsession"]);
    await commands.added[0]!.execute({ sessionID: "s1", prompt: { text: " auth flow " }, delivery: "immediate" });
    expect(prompts[0]!.text).toContain("memory_search");
    expect(prompts[0]!.text.endsWith("Topic: auth flow")).toBe(true);

    const fresh = { system: [{ type: "text", text: "base" }] };
    await contextHook?.(fresh);
    expect(fresh.system).toHaveLength(2);
    expect(fresh.system[1]!.text).toBe(readFileSync(path.join(PLUGIN, "rules/AGENTS.md"), "utf8").trim());

    const already = { system: [{ type: "text", text: "<!-- context-eng:start -->\nmine" }] };
    await contextHook?.(already);
    expect(already.system).toHaveLength(1);
  });

  it("OpenCode 1.x server() adds the server, commands, and instructions through config hooks", async () => {
    const plugin = (await import(pathToFileURL(path.join(PLUGIN, "server.js")).href)) as {
      default: { server(): Promise<Record<string, (...args: never[]) => Promise<void>>> };
    };
    const hooks = (await plugin.default.server()) as unknown as {
      config(config: { mcp?: Record<string, { command: string[] }>; command?: Record<string, { template: string }> }): Promise<void>;
      "experimental.chat.system.transform"(input: unknown, output: { system: string[] }): Promise<void>;
    };
    const config: { mcp?: Record<string, { command: string[] }>; command?: Record<string, { template: string }> } = {};
    await hooks.config(config);
    expect(config.mcp?.["context-eng"]?.command.at(-2)).toBe(path.join(PLUGIN, "scripts/mcp.mjs"));
    expect(config.command?.["context-eng:recall"]?.template).toContain("Topic: $ARGUMENTS");
    expect(config.command?.["context-eng:postsession"]?.template).toContain("memory_create");
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({}, output);
    expect(output.system[1]).toContain("<!-- context-eng:start -->");
  });

  it("OpenCode entry keeps a context-eng server the user already configured", async () => {
    const plugin = (await import(pathToFileURL(path.join(PLUGIN, "server.js")).href)) as { default: { setup(ctx: unknown): Promise<void> } };
    const existing = { type: "local", command: ["/abs/node", "/abs/cli-entry.js", "mcp"] };
    const mcp = editor({ "context-eng": existing });
    await plugin.default.setup({ mcp: { transform: async (fn: (e: Editor<typeof existing>) => void) => fn(mcp.api) } });
    expect(mcp.items.get("context-eng")).toBe(existing);
  });
});
