import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "../src/engine.js";
import { openIsolatedEngine } from "./harness.js";

let cleanup: (() => void) | undefined;
let engine: Engine;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function start(): Engine {
  const ctx = openIsolatedEngine();
  cleanup = ctx.cleanup;
  engine = ctx.engine;
  return engine;
}

describe("generated maps", () => {
  it("writes empty bullet maps on first open", () => {
    const e = start();
    expect(readFileSync(e.layout.globalMapMd, "utf8")).toBe("- global\n  - (empty)\n");
    expect(readFileSync(e.layout.projectMapMd, "utf8")).toBe("- project\n  - (empty)\n");
    expect(existsSync(e.layout.globalMapJson)).toBe(true);
    expect(existsSync(e.layout.projectMapJson)).toBe(true);
  });

  it("indexes counts and nested one-liners under each collection", () => {
    const e = start();
    e.create({
      scope: "project",
      category: "decision",
      content: "Store memories in SQLite with FTS5.",
      tags: ["sqlite", "router"],
    });
    const second = e.create({
      scope: "project",
      category: "decision",
      content: "Keep categories as a column, not separate databases.",
      tags: ["sqlite", "router"],
    });
    const staged = e.create({
      scope: "project",
      category: "preference",
      content: "Prefer minimal UI with muted colors.",
    });

    const md = readFileSync(e.layout.projectMapMd, "utf8");
    const lines = md.split("\n").filter((line) => line.length > 0);
    expect(lines[0]).toBe("- project");
    for (const line of lines) expect(line).toMatch(/^( {2}| {4})?- /);
    expect(md).toContain("  - decision (2)");
    expect(md).toContain("    - Store memories in SQLite with FTS5.");
    expect(md).toContain("    - Keep categories as a column, not separate databases.");
    expect(md).toContain("  - staging (1) — not searched");
    expect(md).toContain("    - Prefer minimal UI with muted colors.");

    const json = JSON.parse(readFileSync(e.layout.projectMapJson, "utf8")) as {
      counts: Record<string, number>;
      staging: { searched: boolean; lines: string[]; lines_ids: string[]; lines_categories: string[] };
      collections: Array<{ name: string; keywords: string[]; lines: string[]; lines_ids: string[] }>;
    };
    expect(json.counts.decision).toBe(2);
    expect(json.counts.staging).toBe(1);
    expect(json.staging.searched).toBe(false);
    expect(json.staging.lines).toEqual(["Prefer minimal UI with muted colors."]);
    expect(json.staging.lines_ids).toEqual([staged.memory.id]);
    expect(json.staging.lines_categories).toEqual(["preference"]);
    const decisions = json.collections.find((c) => c.name === "decision");
    expect(decisions?.keywords).toContain("sqlite");
    expect(decisions?.lines).toHaveLength(2);
    expect(decisions?.lines_ids).toContain(second.memory.id);
  });

  it("rewrites the map after promote, demote, and delete", () => {
    const e = start();
    const a = e.create({
      scope: "project",
      category: "preference",
      content: "Prefer muted colors in the UI.",
    });
    const b = e.create({
      scope: "project",
      category: "decision",
      content: "Use SQLite for the memory store.",
    });
    const c = e.create({
      scope: "project",
      category: "decision",
      content: "Keep one staging bucket per project.",
    });

    e.promote("preference", a.memory.id);
    let md = readFileSync(e.layout.projectMapMd, "utf8");
    expect(md).toContain("  - preference (1)");
    expect(md).toContain("  - decision (2)");
    expect(md).not.toContain("  - staging");

    e.demote("decision", b.memory.id);
    md = readFileSync(e.layout.projectMapMd, "utf8");
    expect(md).toContain("  - decision (1, 1 staging)");
    expect(md).toContain("  - staging (1) — not searched");

    e.delete("decision", b.memory.id);
    md = readFileSync(e.layout.projectMapMd, "utf8");
    expect(md).toContain("  - preference (1)");
    expect(md).toContain("    - Prefer muted colors in the UI.");
    expect(md).toContain("  - decision (1)");
    expect(md).toContain("    - Keep one staging bucket per project.");
    expect(md).not.toContain("  - staging");
    expect(c.memory.content).toBe("Keep one staging bucket per project.");
  });
});
