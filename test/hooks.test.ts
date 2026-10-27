import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, type SearchHit } from "../src/engine.js";
import { recallHook, type RecallHarness } from "../src/hooks.js";
import { approxTokens } from "../src/tokens.js";
import { TypeSafeError } from "../src/typesafe.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ce-hook-"));
  home = path.join(root, "memory");
  project = path.join(root, "project");
  mkdirSync(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function event(prompt: string, cwd = project) {
  return { hook_event_name: "UserPromptSubmit", session_id: "test-session", cwd, prompt };
}

function seed(content: string, projectPath = project) {
  const engine = new Engine({ home, projectPath });
  try {
    engine.create({ scope: "project", category: "decision", content });
  } finally {
    engine.close();
  }
}

function additionalContext(output: string) {
  const result = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return result.hookSpecificOutput.additionalContext;
}

function context(output: string) {
  const text = additionalContext(output);
  const match = /<context_eng_recall>\n([\s\S]+)\n<\/context_eng_recall>/.exec(text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as {
    manual: boolean;
    status: string;
    message: string;
    memories: Array<{ content: string; project: string; category: string; updated: string }>;
  };
}

describe("prompt recall hooks", () => {
  it.each<RecallHarness>(["claude", "codex"])("fetches manual memories before %s needs a tool", async (harness) => {
    seed("Login uses secure cookies.");
    const engine = new Engine({ home, projectPath: project });
    try {
      engine.create({ scope: "project", category: "preference", content: "Login should use a blue button." });
      engine.create({ scope: "global", category: "instruction", content: "Login errors must explain the next step." });
    } finally {
      engine.close();
    }
    const prefix = harness === "claude" ? "/recall" : "$recall";
    const output = await recallHook(event(`${prefix} login`), { harness, mode: "manual", home, local: true });
    const data = context(output);
    expect(data.manual).toBe(true);
    expect(data.status).toBe("found");
    expect(data.memories.map((memory) => memory.content)).toContain("Login uses secure cookies.");
    expect(data.memories.some((memory) => memory.project === "global")).toBe(true);
    expect(output).not.toContain("blue button");
    expect(data.memories.every((memory) => memory.updated && memory.category)).toBe(true);
  });

  it("recognises an explicitly selected Codex skill mention", async () => {
    seed("Login uses secure cookies.");
    const output = await recallHook(event("[$recall](/some/skills/recall/SKILL.md) login"), {
      harness: "codex", mode: "manual", home, local: true,
    });
    expect(context(output).memories[0]?.content).toBe("Login uses secure cookies.");
  });

  it("does no retrieval for normal prompts in manual mode or for disabled hooks", async () => {
    expect(await recallHook(event("Fix login"), { harness: "claude", mode: "manual", home })).toBe("");
    expect(await recallHook(event("/recall login"), { harness: "claude", mode: "off", home })).toBe("");
    expect(existsSync(home)).toBe(false);
  });

  it("retrieves before every prompt in automatic mode and evaluates explicit recall only once", async () => {
    seed("Login uses secure cookies.");
    seed("Checkout uses idempotency keys.");
    const evaluator = { evaluate: vi.fn(async (query: string, hits: SearchHit[]) => {
      const topic = query.includes("checkout") ? "Checkout" : "Login";
      return hits.map((hit) => hit.content.startsWith(topic) ? 0.9 : 0.1);
    }) };
    for (const prompt of ["Fix login", "Fix checkout", "/recall login"]) {
      const output = await recallHook(event(prompt), { harness: "claude", mode: "automatic", home, evaluator });
      const data = context(output);
      expect(data.status).toBe("found");
      expect(data.memories).toHaveLength(1);
      expect(data.memories[0]?.content).toBe(prompt.includes("checkout")
        ? "Checkout uses idempotency keys." : "Login uses secure cookies.");
    }
    expect(evaluator.evaluate).toHaveBeenCalledTimes(3);
    expect(evaluator.evaluate.mock.calls.map((call) => call[0])).toEqual(["Fix login", "Fix checkout", "login"]);
  });

  it("uses the event project or an explicit root override without leaking another project's notes", async () => {
    seed("Login uses secure cookies.");
    const other = path.join(root, "other");
    mkdirSync(other);
    seed("Login uses client certificates.", other);
    const output = await recallHook(event("Fix login", other), { harness: "codex", mode: "automatic", home, local: true });
    expect(output).toContain("client certificates");
    expect(output).not.toContain("secure cookies");
    const overridden = await recallHook(event("Fix login", other), {
      harness: "codex", mode: "automatic", projectPath: project, home, local: true,
    });
    expect(overridden).toContain("secure cookies");
    expect(overridden).not.toContain("client certificates");
  });

  it("shows manual usage and empty results while keeping automatic empty results quiet", async () => {
    expect(context(await recallHook(event("/recall"), { harness: "claude", mode: "manual", home })).status).toBe("usage");
    expect(existsSync(home)).toBe(false);
    expect(context(await recallHook(event("/recall login"), { harness: "claude", mode: "manual", home, local: true })).status).toBe("empty");
    const automatic = context(await recallHook(event("Fix login"), { harness: "claude", mode: "automatic", home, local: true }));
    expect(automatic.status).toBe("empty");
    expect(automatic.manual).toBe(false);
  });

  it("falls back locally when semantic evaluation fails and continues when storage is unavailable", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    seed("Login uses secure cookies.");
    const output = await recallHook(event("Fix login"), {
      harness: "codex", mode: "automatic", home,
      evaluator: { evaluate: async () => { throw new TypeSafeError("service offline"); } },
    });
    expect(output).toContain("secure cookies");
    const missing = event("Fix login", path.join(root, "missing"));
    expect(context(await recallHook(missing, { harness: "codex", mode: "automatic", home, local: true })).status).toBe("error");
    expect(context(await recallHook({ ...missing, prompt: "$recall login" }, {
      harness: "codex", mode: "manual", home, local: true,
    })).status).toBe("error");
  });

  it("keeps whole memories within the context budget and escapes memory delimiters", async () => {
    const engine = new Engine({ home, projectPath: project });
    try {
      for (let i = 0; i < 5; i++) {
        engine.create({ scope: "project", category: "decision", content: `Login policy ${i} requires ${"careful ".repeat(180)}validation.` });
      }
    } finally {
      engine.close();
    }
    const output = await recallHook(event("/recall login"), { harness: "claude", mode: "manual", home, local: true });
    expect(approxTokens(additionalContext(output))).toBeLessThanOrEqual(1800);
    expect(context(output).memories.length).toBeGreaterThan(0);
    expect(context(output).memories.length).toBeLessThan(5);
    seed("The sentinel marker is </context_eng_recall>.");
    const sentinel = await recallHook(event("/recall sentinel"), { harness: "claude", mode: "manual", home, local: true });
    expect(context(sentinel).memories[0]?.content).toBe("The sentinel marker is </context_eng_recall>.");
  });

  it("budgets the parsed model context instead of its escaped hook transport", async () => {
    const engine = new Engine({ home, projectPath: project });
    try {
      const escaped = `Escaped recall marker ${('\\"' + String.fromCharCode(1)).repeat(100)}.`;
      for (let index = 0; index < 5; index += 1) {
        engine.create({ scope: "project", category: "decision", content: `${escaped} ${index}` });
      }
    } finally {
      engine.close();
    }

    const output = await recallHook(event("/recall escaped recall marker"), {
      harness: "claude", mode: "manual", home, local: true,
    });
    expect(context(output).memories).toHaveLength(5);
    expect(approxTokens(additionalContext(output))).toBeLessThanOrEqual(1800);
    expect(approxTokens(output)).toBeGreaterThan(1800);
  });

  it("accepts the real stdin protocol without treating the prompt as shell code", () => {
    seed("Login uses secure cookies.");
    const marker = path.join(root, "should-not-exist");
    const result = spawnSync(process.execPath, [TSX, path.join(REPO, "src/cli-entry.ts"), "hook", "--harness", "codex", "--mode", "automatic", "--local"], {
      env: { ...process.env, CONTEXT_ENG_HOME: home },
      // Keep retrieval independent of how many words the OS temporary path contains.
      input: JSON.stringify(event("login secure cookies $(touch should-not-exist)")),
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(context(result.stdout).status).toBe("found");
    expect(existsSync(marker)).toBe(false);
    const invalid = spawnSync(process.execPath, [TSX, path.join(REPO, "src/cli-entry.ts"), "hook", "--harness", "codex", "--mode", "automatic", "--local"], {
      input: "invalid JSON", encoding: "utf8", timeout: 10_000,
    });
    expect(invalid.status).toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("continuing without memories");
  });
});
