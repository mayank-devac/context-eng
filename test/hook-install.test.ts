import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, readlinkSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { installRecallHooks, recallHookCommand, type RecallInstallOptions } from "../src/hook-install.js";
import { writeConfigAtomically } from "../src/harness.js";
import type { RecallHarness } from "../src/hooks.js";

let root: string;
let options: RecallInstallOptions;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ce-hook-install-")));
  const project = path.join(root, "project ' space");
  mkdirSync(project);
  const entry = path.join(root, "runtime ' entry.js");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  options = {
    harness: "codex", mode: "manual", scope: "global", home: root, projectPath: project,
    runtime: { nodePath: process.execPath, entryPath: entry },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function configPath(harness: RecallHarness) {
  return path.join(root, harness === "codex" ? ".codex/hooks.json" : ".claude/settings.json");
}

describe.skipIf(process.platform === "win32")("recall installation", () => {
  it.each<RecallHarness>(["claude", "codex"])("installs, updates and removes %s recall while preserving other hooks", (harness) => {
    const file = configPath(harness);
    mkdirSync(path.dirname(file), { recursive: true });
    const other = { type: "command", command: "other-hook", timeout: 42 };
    writeFileSync(file, JSON.stringify({ theme: "dark", hooks: {
      UserPromptSubmit: [{ matcher: "custom", hooks: [other] }],
      Stop: [{ hooks: [{ type: "command", command: "keep-stop" }] }],
    } }));
    const input = { ...options, harness };
    expect(installRecallHooks(input).files.length).toBeGreaterThan(0);
    const installed = JSON.parse(readFileSync(file, "utf8"));
    expect(installed.theme).toBe("dark");
    expect(installed.hooks.UserPromptSubmit[0]).toEqual({ matcher: "custom", hooks: [other] });
    expect(installed.hooks.UserPromptSubmit).toHaveLength(2);
    expect(installed.hooks.UserPromptSubmit[1].hooks[0].timeout).toBe(5);
    expect(installRecallHooks(input).files).toEqual([]);
    installRecallHooks({ ...input, mode: "automatic" });
    const updated = JSON.parse(readFileSync(file, "utf8"));
    expect(updated.hooks.UserPromptSubmit).toHaveLength(2);
    expect(updated.hooks.UserPromptSubmit[1].hooks[0].command).toContain("automatic");

    const skill = path.join(root, harness === "claude" ? ".claude" : ".agents", "skills/recall/SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("Do not call memory_search");
    if (harness === "codex") expect(readFileSync(path.join(path.dirname(skill), "agents/openai.yaml"), "utf8")).toContain("allow_implicit_invocation: false");
    installRecallHooks({ ...input, mode: "off" });
    expect(existsSync(skill)).toBe(false);
    const removed = JSON.parse(readFileSync(file, "utf8"));
    expect(removed.hooks.UserPromptSubmit).toEqual([{ matcher: "custom", hooks: [other] }]);
    expect(removed.hooks.Stop).toEqual(installed.hooks.Stop);
    expect(removed.theme).toBe("dark");
    expect(installRecallHooks({ ...input, mode: "off" }).files).toEqual([]);
  });

  it("refuses a conflicting skill or malformed config before writing anything", () => {
    const skill = path.join(root, ".agents/skills/recall/SKILL.md");
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, "User's own recall skill.");
    expect(() => installRecallHooks(options)).toThrow("different recall skill");
    expect(existsSync(configPath("codex"))).toBe(false);
    expect(readFileSync(skill, "utf8")).toBe("User's own recall skill.");
    expect(installRecallHooks({ ...options, mode: "off" }).files).toEqual([]);
    mkdirSync(path.dirname(configPath("codex")), { recursive: true });
    writeFileSync(configPath("codex"), '{"hooks":{"UserPromptSubmit":"invalid"}}');
    expect(() => installRecallHooks(options)).toThrow("must be an array");
    expect(readFileSync(configPath("codex"), "utf8")).toBe('{"hooks":{"UserPromptSubmit":"invalid"}}');
  });

  it("prevents duplicate global/project hooks and binds project hooks to their root", () => {
    installRecallHooks(options);
    expect(() => installRecallHooks({ ...options, scope: "project" })).toThrow("already installed");
    expect(existsSync(path.join(options.projectPath, ".codex/hooks.json"))).toBe(false);
    installRecallHooks({ ...options, mode: "off" });
    installRecallHooks({ ...options, scope: "project" });
    const config = JSON.parse(readFileSync(path.join(options.projectPath, ".codex/hooks.json"), "utf8"));
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--project");
    expect(() => installRecallHooks(options)).toThrow("already installed");
  });

  it("quotes runtime and project paths safely in the actual shell command", () => {
    const command = recallHookCommand({ ...options, scope: "project", local: true });
    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "hook", "--harness", "codex", "--mode", "manual", "--project", options.projectPath, "--local", "--context-eng-recall",
    ]);
  });

  it("rejects temporary npm-cache runtimes before installing hooks", () => {
    expect(() => installRecallHooks({
      ...options, runtime: { nodePath: process.execPath, entryPath: path.join(root, "_npx/hash/cli.js") },
    })).toThrow("temporary package cache");
    expect(existsSync(configPath("codex"))).toBe(false);
  });

  it("removes newly created files when a fresh installation write fails, then allows a retry", () => {
    let writes = 0;
    expect(() => installRecallHooks({
      ...options,
      fileOps: {
        write: (file, content) => {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          writeConfigAtomically(file, content);
        },
      },
    })).toThrow("injected write failure");
    expect(existsSync(path.join(root, ".agents/skills/recall/SKILL.md"))).toBe(false);
    expect(existsSync(path.join(root, ".agents/skills/recall/agents/openai.yaml"))).toBe(false);
    expect(existsSync(configPath("codex"))).toBe(false);
    expect(installRecallHooks(options).files).toHaveLength(3);
  });

  it("restores existing owned files and unrelated Stop handlers after an update failure", () => {
    mkdirSync(path.dirname(configPath("codex")), { recursive: true });
    writeFileSync(configPath("codex"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-stop" }] }] } }));
    installRecallHooks(options);
    const skill = path.join(root, ".agents/skills/recall/SKILL.md");
    const agent = path.join(root, ".agents/skills/recall/agents/openai.yaml");
    writeFileSync(skill, "context-eng:recall old skill\n");
    writeFileSync(agent, "context-eng:recall old agent\n");
    const before = new Map([skill, agent, configPath("codex")].map((file) => [file, readFileSync(file, "utf8")]));
    let writes = 0;
    expect(() => installRecallHooks({
      ...options, mode: "automatic",
      fileOps: {
        write: (file, content) => {
          writes += 1;
          if (writes === 3) throw new Error("injected update failure");
          writeConfigAtomically(file, content);
        },
      },
    })).toThrow("injected update failure");
    for (const [file, content] of before) expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("restores removal files, preserves a concurrent edit, and reports the rollback conflict", () => {
    installRecallHooks(options);
    const skill = path.join(root, ".agents/skills/recall/SKILL.md");
    let removals = 0;
    expect(() => installRecallHooks({
      ...options, mode: "off",
      fileOps: {
        remove: (file) => {
          removals += 1;
          if (removals === 2) {
            writeFileSync(configPath("codex"), "concurrent config edit\n");
            throw new Error("injected removal failure");
          }
          unlinkSync(file);
        },
      },
    })).toThrow(/injected removal failure.*rollback conflict/i);
    expect(readFileSync(configPath("codex"), "utf8")).toBe("concurrent config edit\n");
    expect(readFileSync(skill, "utf8")).toContain("context-eng:recall");
    expect(existsSync(path.join(root, ".agents/skills/recall/agents/openai.yaml"))).toBe(true);
  });

  it.each([false, true])("handles update rollback when a symlink is redirected: %s", (redirected) => {
    installRecallHooks(options);
    const skill = path.join(root, ".agents/skills/recall/SKILL.md");
    const originalTarget = path.join(root, "original-skill.md");
    const replacementTarget = path.join(root, "replacement-skill.md");
    const installedContent = readFileSync(skill, "utf8");
    const oldContent = "context-eng:recall old skill\n";
    writeFileSync(originalTarget, oldContent);
    writeFileSync(replacementTarget, installedContent);
    unlinkSync(skill);
    symlinkSync(originalTarget, skill);
    const configBefore = readFileSync(configPath("codex"), "utf8");

    expect(() => installRecallHooks({
      ...options, mode: "automatic",
      fileOps: {
        write: (file, content) => {
          if (file === configPath("codex")) {
            if (redirected) {
              unlinkSync(skill);
              symlinkSync(replacementTarget, skill);
            }
            throw new Error("injected update failure");
          }
          writeConfigAtomically(file, content);
        },
      },
    })).toThrow(redirected
      ? /injected update failure.*rollback conflict/i
      : /injected update failure.*rollback restored completed files/i);

    expect(readlinkSync(skill)).toBe(redirected ? replacementTarget : originalTarget);
    expect(readFileSync(replacementTarget, "utf8")).toBe(installedContent);
    expect(readFileSync(originalTarget, "utf8")).toBe(redirected ? installedContent : oldContent);
    expect(readFileSync(configPath("codex"), "utf8")).toBe(configBefore);
  });

  it("restores a removed owned skill symlink when a later removal fails", () => {
    installRecallHooks(options);
    const skill = path.join(root, ".agents/skills/recall/SKILL.md");
    const target = path.join(root, "owned-skill.md");
    writeFileSync(target, readFileSync(skill, "utf8"));
    unlinkSync(skill);
    symlinkSync(target, skill);
    unlinkSync(configPath("codex"));
    let removals = 0;

    expect(() => installRecallHooks({
      ...options, mode: "off",
      fileOps: {
        remove: (file) => {
          removals += 1;
          if (removals === 2) throw new Error("injected removal failure");
          unlinkSync(file);
        },
      },
    })).toThrow("injected removal failure");

    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skill)).toBe(target);
    expect(readFileSync(skill, "utf8")).toContain("context-eng:recall");
  });

  it("wires project-scoped installation and removal through the public init command", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const original = process.argv;
    try {
      const args = ["--harness", "codex", "--scope", "project", "--project", options.projectPath, "--local"];
      process.argv = [process.execPath, "context-eng", "init", "--recall", "manual", ...args];
      await main();
      const file = path.join(options.projectPath, ".codex/hooks.json");
      const config = JSON.parse(readFileSync(file, "utf8"));
      expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--local");
      expect(existsSync(configPath("codex"))).toBe(false);
      process.argv = [process.execPath, "context-eng", "init", "--recall", "off", ...args];
      await main();
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
      expect(existsSync(path.join(options.projectPath, ".agents/skills/recall/SKILL.md"))).toBe(false);
    } finally {
      process.argv = original;
    }
  });
});
