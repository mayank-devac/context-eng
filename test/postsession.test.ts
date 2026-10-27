import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { hookConfigPath, installRecallHooks, type HookRuntime } from "../src/hook-install.js";
import { installPostsessionHook, postsessionHook } from "../src/postsession.js";
import type { RecallHarness } from "../src/hooks.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
let root: string;
let project: string;
let runtime: HookRuntime;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ce-postsession-")));
  project = path.join(root, "project");
  mkdirSync(project);
  const entryPath = path.join(root, "runtime.js");
  writeFileSync(entryPath, "");
  runtime = { nodePath: process.execPath, entryPath };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function stop(overrides: Record<string, unknown> = {}) {
  return { hook_event_name: "Stop", cwd: project, session_id: "test", stop_hook_active: false, last_assistant_message: "Task complete.", ...overrides };
}

describe("postsession protocol", () => {
  it("asks the same working model to save one useful claim and confirm promotion", () => {
    const result = postsessionHook(stop());
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("same conversation and your current model");
    expect(result.reason).toContain("memory_create");
    expect(result.reason).toContain("memory_promote");
    expect(result.reason).toContain("confirm promotion succeeded");
    expect(result.reason).toContain(JSON.stringify(project));
    const other = path.join(root, "bound root");
    expect(postsessionHook(stop(), other).reason).toContain(JSON.stringify(other));
  });

  it("allows a continued, empty, or unrelated event to finish without another saving pass", () => {
    expect(postsessionHook(stop({ stop_hook_active: true }))).toEqual({});
    expect(postsessionHook(stop({ stop_hook_active: undefined }))).toEqual({});
    expect(postsessionHook(stop({ last_assistant_message: " " }))).toEqual({});
    expect(postsessionHook(stop({ hook_event_name: "SessionEnd" }))).toEqual({});
    expect(postsessionHook(stop({ hook_event_name: "SubagentStop" }))).toEqual({});
  });

  it("speaks the real stdin JSON protocol and lets malformed input finish safely", () => {
    const args = [TSX, path.join(REPO, "src/cli-entry.ts"), "postsession", "--harness", "codex"];
    const first = spawnSync(process.execPath, args, { input: JSON.stringify(stop()), encoding: "utf8", timeout: 10_000 });
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout).decision).toBe("block");
    const resumed = spawnSync(process.execPath, args, { input: JSON.stringify(stop({ stop_hook_active: true })), encoding: "utf8", timeout: 10_000 });
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({});
    const invalid = spawnSync(process.execPath, args, { input: "invalid JSON", encoding: "utf8", timeout: 10_000 });
    expect(invalid.status).toBe(0);
    expect(JSON.parse(invalid.stdout)).toEqual({});
    expect(invalid.stderr).toContain("allowing the task to finish");
  });
});

describe.skipIf(process.platform === "win32")("postsession setup", () => {
  it.each<RecallHarness>(["claude", "codex"])("coexists with recall and unrelated %s Stop hooks", (harness) => {
    const common = { harness, home: root, projectPath: project, scope: "global" as const, runtime };
    const file = hookConfigPath(common);
    mkdirSync(path.dirname(file), { recursive: true });
    const other = { hooks: [{ type: "command", command: "user-stop-hook" }] };
    writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { Stop: [other] } }));
    installRecallHooks({ ...common, mode: "automatic" });
    const recall = JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit;
    expect(installPostsessionHook({ ...common, enabled: true })).toEqual([file]);
    expect(installPostsessionHook({ ...common, enabled: true })).toEqual([]);
    const installed = JSON.parse(readFileSync(file, "utf8"));
    expect(installed.hooks.Stop).toHaveLength(2);
    expect(installed.hooks.Stop[0]).toEqual(other);
    expect(installed.hooks.UserPromptSubmit).toEqual(recall);
    expect(installed.hooks.Stop[1].hooks[0].command).toContain("--context-eng-postsession");
    installPostsessionHook({ ...common, enabled: false });
    const removed = JSON.parse(readFileSync(file, "utf8"));
    expect(removed.hooks.Stop).toEqual([other]);
    expect(removed.hooks.UserPromptSubmit).toEqual(recall);
    expect(removed.theme).toBe("dark");
    expect(installPostsessionHook({ ...common, enabled: false })).toEqual([]);
  });

  it("does not create a config when disabled, and refuses duplicate scopes or malformed Stop hooks", () => {
    const common = { harness: "codex" as const, home: root, projectPath: project, scope: "global" as const, runtime };
    const file = hookConfigPath(common);
    expect(installPostsessionHook({ ...common, enabled: false })).toEqual([]);
    expect(existsSync(file)).toBe(false);
    installPostsessionHook({ ...common, enabled: true });
    expect(() => installPostsessionHook({ ...common, scope: "project", enabled: true })).toThrow("already installed");
    installPostsessionHook({ ...common, enabled: false });
    writeFileSync(file, '{"hooks":{"Stop":"invalid"}}');
    expect(() => installPostsessionHook({ ...common, enabled: true })).toThrow("Stop must be an array");
    expect(readFileSync(file, "utf8")).toBe('{"hooks":{"Stop":"invalid"}}');
  });

  it("installs and disables through init without touching live host configuration", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const original = process.argv;
    try {
      const args = ["--harness", "codex", "--scope", "project", "--project", project];
      process.argv = [process.execPath, "context-eng", "init", "--postsession", "on", ...args];
      await main();
      const file = path.join(project, ".codex/hooks.json");
      expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toHaveLength(1);
      process.argv = [process.execPath, "context-eng", "init", "--postsession", "off", ...args];
      await main();
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
      expect(existsSync(path.join(root, ".codex/hooks.json"))).toBe(false);
    } finally {
      process.argv = original;
    }
  });
});
