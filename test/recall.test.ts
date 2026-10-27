import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "context-eng-recall-"));
  home = path.join(root, "memory");
  project = path.join(root, "project");
  mkdirSync(project);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function recall(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, CONTEXT_ENG_HOME: home, TYPESAFE_API_KEY: "" };
  delete env.CONTEXT_ENG_PROJECT;
  return spawnSync(process.execPath, [TSX, path.join(REPO, "src", "cli-entry.ts"), "recall", ...args], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("recall command", () => {
  it("prints promoted project and global memories with provenance, excluding staging", () => {
    const engine = new Engine({ home, projectPath: project });
    try {
      engine.create({ scope: "project", category: "decision", content: "Login uses secure cookies." });
      engine.create({ scope: "project", category: "decision", content: "Login sessions expire after inactivity." });
      engine.create({ scope: "global", category: "instruction", content: "Login changes need clear error messages." });
      engine.create({ scope: "project", category: "preference", content: "Login should use a blue button." });
    } finally {
      engine.close();
    }

    const result = recall(["--query", "login", "--project", project, "--local"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Login uses secure cookies.");
    expect(result.stdout).toContain("Login changes need clear error messages.");
    expect(result.stdout).not.toContain("blue button");
    expect(result.stdout).toContain("last updated:");
    expect(result.stdout).toContain("category: decision");
    expect(result.stdout).toContain(`project: ${engine.projectPath}`);
    expect(result.stdout).toContain("project: global");

    const limited = recall(["--query", "login", "--scope", "project", "--limit", "1", "--local"]);
    expect(limited.status).toBe(0);
    expect(limited.stdout.match(/\[last updated:/g)).toHaveLength(1);
    expect(limited.stdout).not.toContain("clear error messages");
  });

  it("searches global memories without creating a project catalog", () => {
    const engine = new Engine({ home, deferProject: true });
    try {
      engine.create({ scope: "global", category: "decision", content: "Login requires secure cookies." });
    } finally {
      engine.close();
    }

    const result = recall(["--query", "login", "--scope", "global", "--local"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Login requires secure cookies.");
    expect(existsSync(path.join(home, "projects"))).toBe(false);
  });

  it("returns a successful empty result when no memories match", () => {
    const result = recall(["--query", "login"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("no matching memory.");
  });

  it.each([
    { args: ["--query", " "], message: "requires --query" },
    { args: ["--query", "login", "--scope", "unknown"], message: "--scope must be" },
    { args: ["--query", "login", "--limit", "0"], message: "--limit must be" },
  ])("rejects $args before creating storage", ({ args, message }) => {
    const result = recall(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(existsSync(home)).toBe(false);
  });

  it("rejects a missing project before creating storage", () => {
    const result = recall(["--query", "login", "--project", path.join(root, "missing")]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("existing directory");
    expect(existsSync(home)).toBe(false);
  });
});
