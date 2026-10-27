import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { hookConfigPath, installRecallHooks, type HookRuntime } from "../src/hook-install.js";
import { writeConfigAtomically } from "../src/harness.js";
import { installPostsessionHook, parsePostsessionMode, postsessionHook } from "../src/postsession.js";
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

function options(harness: RecallHarness = "codex") {
  return { harness, home: root, projectPath: project, scope: "project" as const, enabled: true };
}
function skillPath(harness: RecallHarness = "codex", base = project) {
  return path.join(base, harness === "codex" ? ".agents" : ".claude", "skills/postsession/SKILL.md");
}
function legacyConfig(harness: RecallHarness = "codex") {
  const file = hookConfigPath(options(harness));
  mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ theme: "dark", hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "recall --context-eng-recall" }] }],
    Stop: [{ matcher: "keep-matcher", hooks: [
      { type: "command", command: "user-stop-hook" },
      { type: "command", command: "legacy postsession --context-eng-postsession" },
    ] }],
  } });
  writeFileSync(file, original);
  return { file, original };
}

describe("legacy postsession protocol", () => {
  it("never blocks and keeps manual/off plus the deprecated on alias", () => {
    expect(postsessionHook()).toEqual({});
    expect(parsePostsessionMode("manual")).toBe(true);
    expect(parsePostsessionMode("on")).toBe(true);
    expect(parsePostsessionMode("off")).toBe(false);
    expect(() => parsePostsessionMode("automatic")).toThrow("manual or off");
  });

  it.each(["codex", "claude"])("lets old %s Stop commands finish even with malformed input", (harness) => {
    for (const input of [JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, cwd: project, last_assistant_message: "Done" }), "invalid JSON"]) {
      const result = spawnSync(process.execPath, [TSX, path.join(REPO, "src/cli-entry.ts"), "postsession", "--harness", harness,
        "--project", project, "--context-eng-postsession"], { input, encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(result.stderr).toBe("");
    }
  });
});

describe("manual postsession setup", () => {
  it.each<RecallHarness>(["claude", "codex"])("migrates %s without changing recall or unrelated Stop handlers", (harness) => {
    const common = options(harness);
    const { file } = legacyConfig(harness);
    installRecallHooks({ ...common, runtime, mode: "automatic" });
    const recall = JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit;
    expect(installPostsessionHook(common)).toContain(skillPath(harness));
    expect(installPostsessionHook(common)).toEqual([]);
    const installed = JSON.parse(readFileSync(file, "utf8"));
    expect(installed.hooks.Stop).toEqual([{ matcher: "keep-matcher", hooks: [{ type: "command", command: "user-stop-hook" }] }]);
    expect(installed.hooks.UserPromptSubmit).toEqual(recall);
    expect(installed.theme).toBe("dark");
    const skill = readFileSync(skillPath(harness), "utf8");
    expect(skill).toContain(`<root>/${harness === "codex" ? ".agents" : ".claude"}/skills/postsession/SKILL.md`);
    expect(skill).not.toContain(project);
    expect(skill).not.toContain("{{");
    if (harness === "claude") expect(skill).toContain("disable-model-invocation: true");
    else expect(readFileSync(path.join(path.dirname(skillPath()), "agents/openai.yaml"), "utf8")).toContain("allow_implicit_invocation: false");
    writeFileSync(skillPath(harness), "<!-- context-eng:postsession --> old skill");
    expect(installPostsessionHook(common)).toEqual([skillPath(harness)]);
    installPostsessionHook({ ...common, enabled: false });
    expect(existsSync(skillPath(harness))).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(installed);
    expect(installPostsessionHook({ ...common, enabled: false })).toEqual([]);
  });

  it("installs only a skill, binds each project independently, and leaves other scopes/hosts alone", () => {
    const common = options();
    const { file: claudeFile, original } = legacyConfig("claude");
    installPostsessionHook({ ...common, scope: "global" });
    const global = readFileSync(skillPath("codex", root), "utf8");
    expect(global).toContain("Resolve the current project root");
    expect(global).not.toContain(JSON.stringify(project));
    installPostsessionHook(common);
    expect(existsSync(hookConfigPath(common))).toBe(false);
    expect(readFileSync(claudeFile, "utf8")).toBe(original);
    installPostsessionHook({ ...common, enabled: false });
    expect(readFileSync(skillPath("codex", root), "utf8")).toBe(global);
    expect(existsSync(skillPath())).toBe(false);
  });

  it("preserves user-owned skills on off, cleans only the legacy hook, and refuses overwriting conflicts", () => {
    const common = options();
    const { file, original } = legacyConfig();
    const skill = skillPath();
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, "My own postsession skill");
    expect(() => installPostsessionHook(common)).toThrow("different postsession skill");
    expect(readFileSync(file, "utf8")).toBe(original);
    installPostsessionHook({ ...common, enabled: false });
    expect(readFileSync(skill, "utf8")).toBe("My own postsession skill");
    expect(readFileSync(file, "utf8")).not.toContain("--context-eng-postsession");
  });

  it.each(['{"hooks":{"Stop":"invalid"}}', 'not json'])("leaves malformed configuration untouched: %s", (content) => {
    const { file } = legacyConfig();
    writeFileSync(file, content);
    expect(() => installPostsessionHook(options())).toThrow("left unchanged");
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(existsSync(skillPath())).toBe(false);
  });

  it("off on a fresh project creates neither a hook config nor a skill", () => {
    expect(installPostsessionHook({ ...options(), enabled: false })).toEqual([]);
    expect(existsSync(skillPath())).toBe(false);
    expect(existsSync(hookConfigPath(options()))).toBe(false);
  });

  it("removes new skills and restores old files when migration cleanup fails", () => {
    const { file, original } = legacyConfig();
    const common = options();
    const fail = { write: (target: string, content: string) => {
      if (target === file) throw new Error("cleanup failed");
      writeConfigAtomically(target, content);
    } };
    expect(() => installPostsessionHook({ ...common, fileOps: fail })).toThrow("Rollback restored");
    expect(existsSync(skillPath())).toBe(false);
    expect(existsSync(path.join(path.dirname(skillPath()), "agents/openai.yaml"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(original);
    installPostsessionHook(common);
    writeFileSync(skillPath(), "context-eng:postsession old skill");
    writeFileSync(file, original);
    expect(() => installPostsessionHook({ ...common, fileOps: fail })).toThrow("Rollback restored");
    expect(readFileSync(skillPath(), "utf8")).toBe("context-eng:postsession old skill");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("restores removed skills and the pre-migration config if disabling fails", () => {
    const common = options();
    installPostsessionHook(common);
    const { file, original } = legacyConfig();
    const before = readFileSync(skillPath(), "utf8");
    let removals = 0;
    expect(() => installPostsessionHook({ ...common, enabled: false, fileOps: { remove: (target) => {
      if (++removals === 2) throw new Error("removal failed");
      unlinkSync(target);
    } } })).toThrow("Rollback restored");
    expect(readFileSync(skillPath(), "utf8")).toBe(before);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it.skipIf(process.platform === "win32").each([false, true])("protects a symlink target during migration rollback (redirected: %s)", (redirected) => {
    const { file } = legacyConfig();
    const skill = skillPath();
    mkdirSync(path.dirname(skill), { recursive: true });
    const old = "context-eng:postsession old skill";
    const target = path.join(root, "old.md");
    const replacement = path.join(root, "new.md");
    writeFileSync(target, old);
    writeFileSync(replacement, "User's other skill");
    symlinkSync(target, skill);
    expect(() => installPostsessionHook({ ...options(), fileOps: { write: (destination, content) => {
      if (destination === file) {
        if (redirected) {
          unlinkSync(skill);
          symlinkSync(replacement, skill);
        }
        throw new Error("cleanup failed");
      }
      writeConfigAtomically(destination, content);
    } } })).toThrow(redirected ? /rollback conflict/i : /Rollback restored/);
    expect(readlinkSync(skill)).toBe(redirected ? replacement : target);
    expect(readFileSync(replacement, "utf8")).toBe("User's other skill");
    if (!redirected) expect(readFileSync(target, "utf8")).toBe(old);
  });

  it.each(["manual", "on"])("wires init --postsession %s and off with accurate guidance", async (mode) => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const original = process.argv;
    try {
      const args = ["--harness", "codex", "--scope", "project", "--project", project];
      process.argv = [process.execPath, "context-eng", "init", "--postsession", mode, ...args];
      await main();
      expect(readFileSync(skillPath(), "utf8")).toContain("memory_create");
      expect(existsSync(hookConfigPath(options()))).toBe(false);
      expect(log.mock.calls.flat().join("\n")).toContain("$postsession");
      if (mode === "on") expect(log.mock.calls.flat().join("\n")).toContain("deprecated");
      process.argv = [process.execPath, "context-eng", "init", "--postsession", "off", ...args];
      await main();
      expect(existsSync(skillPath())).toBe(false);
      expect(existsSync(skillPath("codex", root))).toBe(false);
    } finally {
      process.argv = original;
    }
  });

  it("renders one shared saving contract for both hosts, including staging and failure outcomes", () => {
    const contract = readFileSync(path.join(REPO, "system_prompts/postsession.md"), "utf8").trim();
    for (const harness of ["codex", "claude"] as const) {
      installPostsessionHook(options(harness));
      expect(readFileSync(skillPath(harness), "utf8")).toContain(contract);
    }
    for (const outcome of ["Saved: <claim>", "Nothing new worth saving", "Could not save: <reason>", "remains in staging", "memory_promote", "memory.category", "memory.id"]) {
      expect(contract).toContain(outcome);
    }
  });
});
