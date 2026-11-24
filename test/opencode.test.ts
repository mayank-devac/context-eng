import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fillTemplate, installOpencodeCommand, opencodeCommandsDir } from "../src/opencode.js";
import { resolveProjectPath } from "../src/paths.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ce-opencode-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("opencodeCommandsDir", () => {
  it("uses the global config dir or the project's .opencode/commands", () => {
    const home = tempDir();
    const project = tempDir();
    expect(opencodeCommandsDir({ scope: "global", home, projectPath: project, env: {} }))
      .toBe(path.join(home, ".config", "opencode", "commands"));
    expect(opencodeCommandsDir({ scope: "project", home, projectPath: project, env: {} }))
      .toBe(path.join(resolveProjectPath(project), ".opencode", "commands"));
  });
});

describe("fillTemplate", () => {
  it("inserts values literally, even ones containing $ replacement patterns", () => {
    expect(fillTemplate("A {{x}} B {{y}} {{missing}}", { x: "cost $& and $$5 $' $`", y: "ok" }))
      .toBe("A cost $& and $$5 $' $` B ok {{missing}}");
  });
});

describe("installOpencodeCommand", () => {
  it("installs /recall globally as a model-driven memory_search lookup, idempotently", () => {
    const home = tempDir();
    const options = { name: "recall" as const, enabled: true, scope: "global" as const, home, projectPath: tempDir(), env: {} };
    const file = path.join(home, ".config", "opencode", "commands", "recall.md");
    expect(installOpencodeCommand(options)).toEqual([file]);
    const content = readFileSync(file, "utf8");
    expect(content.startsWith("---\ndescription: ")).toBe(true);
    expect(content).toContain("<!-- context-eng:recall -->");
    expect(content).toContain("$ARGUMENTS");
    expect(content).toContain("memory_search");
    expect(content).not.toContain("!`");
    expect(installOpencodeCommand(options)).toEqual([]);
  });

  it("installs /postsession in a project with the shared instructions filled in", () => {
    const project = tempDir();
    const file = path.join(resolveProjectPath(project), ".opencode", "commands", "postsession.md");
    expect(installOpencodeCommand({ name: "postsession", enabled: true, scope: "project", home: tempDir(), projectPath: project }))
      .toEqual([file]);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("<!-- context-eng:postsession -->");
    expect(content).toContain("memory_create");
    expect(content).toContain("OpenCode session");
    expect(content).not.toContain("{{");
  });

  it("refuses to overwrite a user's own command and leaves it when disabling", () => {
    const home = tempDir();
    const file = path.join(home, ".config", "opencode", "commands", "recall.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "my own recall\n", "utf8");
    const base = { name: "recall" as const, scope: "global" as const, home, projectPath: tempDir(), env: {} };
    expect(() => installOpencodeCommand({ ...base, enabled: true })).toThrow("A different recall command owns");
    expect(installOpencodeCommand({ ...base, enabled: false })).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("my own recall\n");
  });

  it("removes only its own command when turned off", () => {
    const home = tempDir();
    const base = { name: "postsession" as const, scope: "global" as const, home, projectPath: tempDir(), env: {} };
    const [file] = installOpencodeCommand({ ...base, enabled: true });
    expect(installOpencodeCommand({ ...base, enabled: false })).toEqual([file]);
    expect(existsSync(file!)).toBe(false);
    expect(installOpencodeCommand({ ...base, enabled: false })).toEqual([]);
  });
});
