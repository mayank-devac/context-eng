import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, EngineError } from "../src/engine.js";
import { layoutFor, resolveProjectPath } from "../src/paths.js";
import { openIsolatedEngine } from "./harness.js";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function start(): Engine {
  const context = openIsolatedEngine();
  cleanup = context.cleanup;
  return context.engine;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
  }
}

describe("category databases", () => {
  it("creates safe category files and preserves the first display spelling", () => {
    const engine = start();
    const created = engine.create({
      scope: "project",
      category: " Release / Notes ",
      content: "Keep the public release notes concise.",
    });
    expect(created.memory.category).toBe("Release / Notes");
    expect(created.memory.staging).toBe(true);

    const file = engine.categoryDatabasePath("project", "release / notes");
    expect(file.startsWith(engine.layout.projectCategoriesDir + path.sep)).toBe(true);
    expect(path.basename(file)).toMatch(/^release-notes-[a-f0-9]{12}\.db$/);
    expect(existsSync(file)).toBe(true);
    expect(engine.map("project").project.collections.map((item) => item.category)).toContain("Release / Notes");
  });

  it("keeps built-in auto-promotion and leaves custom categories in staging", () => {
    const engine = start();
    expect(engine.create({ scope: "project", category: "decision", content: "Use SQLite." }).promoted).toBe(true);
    expect(engine.create({ scope: "project", category: "research", content: "Compare local indexes." }).promoted).toBe(false);
  });

  it("requires confirmation before creating a category close to an existing name", () => {
    const engine = start();
    engine.create({ scope: "project", category: "decision", content: "Use SQLite." });

    try {
      engine.create({ scope: "project", category: "decisions", content: "Keep plural decisions separate." });
      throw new Error("expected NEAR_CATEGORY");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe("NEAR_CATEGORY");
      expect((error as EngineError).near).toEqual({ requested: "decisions", existing: "decision" });
      expect((error as Error).message).toContain('Use category "decision"');
      expect((error as Error).message).not.toContain("memory_create");
      expect((error as Error).message).not.toContain("confirmNewCategory");
    }
    expect(engine.listCategoryNames("project").project?.categories).toEqual(["decision"]);

    const confirmed = engine.create({
      scope: "project",
      category: "decisions",
      confirmNewCategory: true,
      content: "Keep plural decisions separate.",
    });
    expect(confirmed.memory.category).toBe("decisions");
    expect(engine.listCategoryNames("project").project?.categories).toEqual(["decision", "decisions"]);
  });

  it("treats separator-only category variants as near duplicates", () => {
    const engine = start();
    engine.create({ scope: "project", category: "batch-probe", content: "Keep batch probes isolated." });

    expectCode(
      () => engine.create({ scope: "project", category: "batch_probe", content: "Keep batch probes separate." }),
      "NEAR_CATEGORY",
    );
    expect(engine.listCategoryNames("project").project?.categories).toEqual(["batch-probe"]);
  });

  it("lists category names by scope and includes the project path by default", () => {
    const engine = start();
    engine.create({ scope: "global", category: "instruction", content: "Keep global guidance concise." });
    engine.create({ scope: "project", category: "Research", content: "Compare local indexes." });

    expect(engine.listCategoryNames()).toEqual({
      global: ["instruction"],
      project: {
        projectPath: engine.layout.projectPath,
        categories: ["Research"],
      },
    });
    expect(engine.listCategoryNames("global")).toEqual({ global: ["instruction"] });
    expect(engine.listCategoryNames("project")).toEqual({
      project: {
        projectPath: engine.layout.projectPath,
        categories: ["Research"],
      },
    });
  });

  it("searches every category when omitted and validates explicit category lists", () => {
    const engine = start();
    const decision = engine.create({ scope: "project", category: "decision", content: "Use SQLite." });
    const mistake = engine.create({ scope: "project", category: "mistake", content: "Close SQLite handles." });
    expect(engine.search({ query: "sqlite" }).hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining([decision.memory.id, mistake.memory.id]),
    );
    expectCode(() => engine.search({ query: "sqlite", categories: [] }), "INVALID_CATEGORIES");
    engine.create({ scope: "project", category: "instruction", content: "Keep SQLite local." });
    engine.create({ scope: "project", category: "constraint", content: "Cap SQLite writes." });
    expect(
      engine.search({
        query: "sqlite",
        categories: ["decision", "mistake", "instruction", "constraint"],
      }).hits.map((hit) => hit.id),
    ).toEqual(expect.arrayContaining([decision.memory.id, mistake.memory.id]));
    expectCode(
      () => engine.search({ query: "sqlite", categories: ["a", "b", "c", "d", "e"] }),
      "INVALID_CATEGORIES",
    );
    expectCode(
      () => engine.search({ query: "sqlite", categories: ["Decision", "decision"] }),
      "INVALID_CATEGORIES",
    );
    expectCode(() => engine.search({ query: "sqlite", categories: ["missing"] }), "INVALID_CATEGORY");
  });
});

describe("deferred project binding", () => {
  it("allows global memory but rejects project access until an explicit bind", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ce-unbound-home-"));
    const engine = new Engine({ home, deferProject: true });
    try {
      expect(engine.projectPath).toBeUndefined();
      expect(existsSync(path.join(home, "projects"))).toBe(false);
      const global = engine.create({
        scope: "global",
        category: "instruction",
        content: "Keep global memory available before project binding.",
      });
      expect(global.projectPath).toBeUndefined();
      expect(global.projectKey).toBeUndefined();
      expect(
        engine.search({ query: "global memory", filters: { scope: "global" } }).hits.map((hit) => hit.id),
      ).toContain(global.memory.id);
      expect(engine.map("global").global.collections[0]?.lines_ids).toContain(global.memory.id);
      const unboundMap = engine.map();
      expect(unboundMap.global.collections[0]?.lines_ids).toContain(global.memory.id);
      expect(unboundMap.project).toBeUndefined();
      expect(engine.listCategoryNames()).toEqual({ global: ["instruction"] });

      expectCode(() => engine.search({ query: "project memory", filters: { scope: "project" } }), "PROJECT_NOT_BOUND");
      expectCode(() => engine.search({ query: "project memory" }), "PROJECT_NOT_BOUND");
      expectCode(() => engine.map("project"), "PROJECT_NOT_BOUND");
      expectCode(() => engine.listCategoryNames("project"), "PROJECT_NOT_BOUND");
      expectCode(
        () => engine.create({ scope: "project", category: "decision", content: "Do not create this row." }),
        "PROJECT_NOT_BOUND",
      );
      expectCode(() => engine.get("instruction", global.memory.id), "PROJECT_NOT_BOUND");
      expectCode(() => engine.edit("instruction", global.memory.id, { importance: 0.8 }), "PROJECT_NOT_BOUND");
      expectCode(() => engine.promote("instruction", global.memory.id), "PROJECT_NOT_BOUND");
      expectCode(() => engine.demote("instruction", global.memory.id), "PROJECT_NOT_BOUND");
      expectCode(() => engine.delete("instruction", global.memory.id), "PROJECT_NOT_BOUND");
      expect(existsSync(path.join(home, "projects"))).toBe(false);

      engine.bind(resolveProjectPath());
      expect(engine.projectPath).toBe(resolveProjectPath());
      const bound = engine.create({
        scope: "project",
        category: "decision",
        content: "Use the explicitly bound project memory.",
      });
      expect(
        engine.search({ query: "bound project", filters: { scope: "project" } }).hits.map((hit) => hit.id),
      ).toContain(bound.memory.id);
    } finally {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("adaptive retrieval", () => {
  it("sends every eligible row to Jev in small mode even when FTS matches", () => {
    const engine = start();
    const exact = engine.create({
      scope: "project",
      category: "decision",
      content: "Keep the lexical boundary marker.",
    });
    const paraphrase = engine.create({
      scope: "project",
      category: "decision",
      content: "Preserve meaning even when wording differs.",
    });

    const result = engine.prepareSearch({ query: "lexical boundary marker", categories: ["decision"] });
    expect(result.retrieval.mode).toBe("small");
    expect(result.retrieval.channels).toEqual(["all"]);
    expect(result.hits.map((hit) => hit.id)).toEqual(expect.arrayContaining([exact.memory.id, paraphrase.memory.id]));
  });

  it("switches to large mode above 60 eligible rows", () => {
    const engine = start();
    for (let index = 0; index < 61; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Large row boundary marker ${index}.`,
      });
    }
    const result = engine.prepareSearch({ query: "large row boundary", categories: ["decision"] });
    expect(result.eligible_count).toBe(61);
    expect(result.retrieval.mode).toBe("large");
  });

  it("switches to large mode above 12000 estimated eligible tokens", () => {
    const engine = start();
    for (let index = 0; index < 16; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Token threshold ${index} ${"word ".repeat(600)}`,
      });
    }
    const result = engine.prepareSearch({ query: "token threshold", categories: ["decision"] });
    expect(result.eligible_count).toBe(16);
    expect(result.retrieval.eligible_tokens).toBeGreaterThan(12_000);
    expect(result.retrieval.mode).toBe("large");
  });

  it("merges exact hint labels, deduplicates IDs, and preserves them in local fallback", () => {
    const engine = start();
    const target = engine.create({
      scope: "project",
      category: "decision",
      content: "Revoke object URLs after export.",
      topics: ["browser memory"],
    });
    for (let index = 0; index < 60; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Unrelated large label padding ${index}.`,
      });
    }
    const input = {
      query: "different lexical request",
      categories: ["decision"],
      hints: { topics: ["browser memory"] },
    };

    const prepared = engine.prepareSearch(input);
    expect(prepared.retrieval.mode).toBe("large");
    expect(prepared.retrieval.channels).toEqual(expect.arrayContaining(["labels", "fill"]));
    expect(prepared.hits.filter((hit) => hit.id === target.memory.id)).toHaveLength(1);
    expect(engine.search(input).hits[0]?.id).toBe(target.memory.id);
  });

  it("uses category hints before the 90-candidate Jev cutoff without hard filtering", () => {
    const engine = start();
    for (let index = 0; index < 90; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Common category boundary marker ${index}.`,
      });
    }
    const hinted = engine.create({
      scope: "project",
      category: "constraint",
      content: "Common category boundary marker hinted.",
    });
    const result = engine.prepareSearch({
      query: "common category boundary marker",
      hints: { categories: ["constraint"] },
    });

    expect(result.hits).toHaveLength(91);
    expect(result.hits.slice(0, 90).map((hit) => hit.id)).toContain(hinted.memory.id);
    expect(result.hits.some((hit) => hit.category === "decision")).toBe(true);
  });

  it("runs one in-memory typo retry only when large-mode FTS is empty", () => {
    const engine = start();
    const target = engine.create({
      scope: "project",
      category: "decision",
      content: "Keep memory retrieval dependable.",
    });
    for (let index = 0; index < 60; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Unrelated typo padding ${index}.`,
      });
    }
    const result = engine.prepareSearch({ query: "memroy", categories: ["decision"] });
    expect(result.retrieval.channels).toEqual(expect.arrayContaining(["fts", "typo"]));
    expect(result.hits[0]?.id).toBe(target.memory.id);
  });

  it("fills large Jev candidates only when FTS and labels provide fewer than 90 IDs", () => {
    const engine = start();
    for (let index = 0; index < 91; index += 1) {
      engine.create({
        scope: "project",
        category: "decision",
        content: `Fill boundary marker ${index}.`,
      });
    }
    const full = engine.prepareSearch({ query: "fill boundary marker", categories: ["decision"] });
    expect(full.retrieval.channels).not.toContain("fill");

    const thin = engine.prepareSearch({ query: "90", categories: ["decision"] });
    expect(thin.retrieval.channels).toContain("fill");
  });

  it("FTS5 fallback searches content and metadata and respects the final budget", () => {
    const engine = start();
    for (let index = 0; index < 51; index += 1) {
      engine.create({
        scope: "project",
        category: "mistake",
        content: `Revoke object URL variant ${index}.`,
        subject: "canvas export",
        topics: ["browser memory"],
        tags: ["blob-url"],
        links: ["cli.ts"],
      });
    }
    expect(engine.search({ query: "blob-url", categories: ["mistake"] }).hits).toHaveLength(50);
    expect(engine.search({ query: "canvas export", categories: ["mistake"] }).hits).toHaveLength(50);
    expect(engine.search({ query: "cli.ts", categories: ["mistake"] }).hits).toHaveLength(50);
  });

  it("searches Hindi and Chinese text in local fallback", () => {
    const engine = start();
    const hindi = engine.create({
      scope: "project",
      category: "decision",
      content: "हिंदी खोज स्मृति सुरक्षित रखती है।",
    });
    const chinese = engine.create({
      scope: "project",
      category: "decision",
      content: "中文 搜索 记忆 保持 可用。",
    });

    expect(engine.search({ query: "हिंदी स्मृति", categories: ["decision"] }).hits.map((hit) => hit.id)).toContain(
      hindi.memory.id,
    );
    expect(engine.search({ query: "中文 记忆", categories: ["decision"] }).hits.map((hit) => hit.id)).toContain(
      chinese.memory.id,
    );
  });

  it("preserves query polarity and rejects weak long-query matches", () => {
    const engine = start();
    const negative = engine.create({
      scope: "project",
      category: "constraint",
      content: "Never commit secrets.",
    });
    engine.create({
      scope: "project",
      category: "constraint",
      content: "Always commit secrets.",
    });
    const strong = engine.create({
      scope: "project",
      category: "decision",
      content: "Keep project database migration reversible.",
    });
    const weak = engine.create({
      scope: "project",
      category: "decision",
      content: "Keep project colors accessible.",
    });

    expect(engine.search({ query: "never commit secrets", categories: ["constraint"] }).hits.map((hit) => hit.id)).toEqual([
      negative.memory.id,
    ]);
    const coverage = engine.search({
      query: "project database migration caching deployment",
      categories: ["decision"],
    });
    expect(coverage.hits.map((hit) => hit.id)).toContain(strong.memory.id);
    expect(coverage.hits.map((hit) => hit.id)).not.toContain(weak.memory.id);
  });

  it("applies project and newer precedence to memories with the same subject", () => {
    const engine = start();
    engine.create({
      scope: "global",
      category: "decision",
      subject: "state management",
      content: "Always use Redux for shared state.",
    });
    const project = engine.create({
      scope: "project",
      category: "decision",
      subject: "state management",
      content: "Never use Redux for project state.",
    });
    const older = engine.create({
      scope: "project",
      category: "decision",
      subject: "database policy",
      content: "Keep database policy marker old.",
    });
    const newer = engine.create({
      scope: "project",
      category: "decision",
      subject: "database policy",
      content: "Keep database policy marker current.",
    });
    const db = new Database(engine.categoryDatabasePath("project", "decision"));
    db.prepare(`UPDATE memories SET updated_at = 100 WHERE id = ?`).run(older.memory.id);
    db.prepare(`UPDATE memories SET updated_at = 200 WHERE id = ?`).run(newer.memory.id);
    db.close();

    expect(engine.search({ query: "redux state", categories: ["decision"] }).hits[0]?.id).toBe(project.memory.id);
    expect(engine.search({ query: "database policy marker", categories: ["decision"] }).hits[0]?.id).toBe(
      newer.memory.id,
    );
  });

  it("sorts every lexical match before applying an explicit result limit", () => {
    const engine = start();
    const created = Array.from({ length: 35 }, (_, index) =>
      engine.create({
        scope: "project",
        category: "decision",
        content: `Shared ordering marker variant ${index}.`,
      }),
    );
    const target = created[34]!;
    const db = new Database(engine.categoryDatabasePath("project", "decision"));
    db.prepare(`UPDATE memories SET updated_at = 9999999999 WHERE id = ?`).run(target.memory.id);
    db.close();

    const sorted = engine.search({
      query: "shared ordering marker",
      categories: ["decision"],
      sort: { by: "updated", order: "desc" },
      limit: 1,
    });
    expect(sorted.hits.map((hit) => hit.id)).toEqual([target.memory.id]);
  });

  it("applies scope, staging, importance, structured, time, any/all, and sort filters", () => {
    const engine = start();
    const global = engine.create({
      scope: "global",
      category: "decision",
      content: "Use the shared alpha renderer.",
      subject: "rendering",
      topics: ["canvas", "export"],
      tags: ["alpha", "stable"],
      links: ["cli.ts", "repo_md"],
      importance: 0.9,
    });
    const project = engine.create({
      scope: "project",
      category: "decision",
      content: "Use the project alpha renderer.",
      subject: "rendering",
      topics: ["canvas"],
      tags: ["alpha"],
      links: ["cli.ts"],
      importance: 0.6,
    });
    const staged = engine.create({
      scope: "project",
      category: "preference",
      content: "Prefer the alpha renderer controls.",
      subject: "rendering",
      importance: 0.8,
    });

    const filtered = engine.prepareSearch({
      query: "alpha renderer",
      categories: ["decision"],
      filters: {
        scope: "both",
        minImportance: 0.7,
        subject: "Rendering",
        topics: { values: ["canvas", "export"], match: "all" },
        tags: { values: ["stable", "missing"], match: "any" },
        links: { values: ["cli.ts", "repo_md"], match: "all" },
        time: { field: "created", preset: "this_week" },
      },
      sort: { by: "importance", order: "desc" },
    });
    expect(filtered.hits.map((hit) => hit.id)).toEqual([global.memory.id]);

    const scoped = engine.prepareSearch({
      query: "alpha renderer",
      categories: ["decision"],
      filters: { scope: "project" },
    });
    expect(scoped.hits.map((hit) => hit.id)).toEqual([project.memory.id]);

    expect(
      engine.prepareSearch({
        query: "alpha renderer",
        categories: ["preference"],
        filters: { includeStaging: true },
      }).hits.map((hit) => hit.id),
    ).toEqual([staged.memory.id]);
    expect(engine.prepareSearch({ query: "alpha", categories: ["preference"] }).hits).toEqual([]);
  });

  it("supports exact time ranges and every explicit sort field", () => {
    const engine = start();
    const older = engine.create({
      scope: "project",
      category: "decision",
      content: "Sort marker older.",
      importance: 0.2,
    });
    const newer = engine.create({
      scope: "project",
      category: "decision",
      content: "Sort marker newer.",
      importance: 0.9,
    });
    const db = new Database(engine.categoryDatabasePath("project", "decision"));
    db.prepare(`UPDATE memories SET created_at = 100, updated_at = 200 WHERE id = ?`).run(older.memory.id);
    db.prepare(`UPDATE memories SET created_at = 300, updated_at = 400 WHERE id = ?`).run(newer.memory.id);
    db.close();

    const base = { query: "sort marker", categories: ["decision"] };
    expect(
      engine.prepareSearch({ ...base, sort: { by: "created", order: "asc" } }).hits.map((hit) => hit.id),
    ).toEqual([older.memory.id, newer.memory.id]);
    expect(
      engine.prepareSearch({ ...base, sort: { by: "updated", order: "desc" } }).hits.map((hit) => hit.id),
    ).toEqual([newer.memory.id, older.memory.id]);
    expect(
      engine.prepareSearch({ ...base, sort: { by: "importance", order: "desc" } }).hits.map((hit) => hit.id),
    ).toEqual([newer.memory.id, older.memory.id]);
    expect(
      engine.prepareSearch({ ...base, sort: { by: "relevance", order: "asc" } }).hits.map((hit) => hit.id),
    ).toEqual([older.memory.id, newer.memory.id]);

    const ranged = engine.prepareSearch({
      ...base,
      filters: {
        time: {
          field: "created",
          from: "1970-01-01T00:03:00.000Z",
          to: "1970-01-01T00:06:00.000Z",
        },
      },
    });
    expect(ranged.hits.map((hit) => hit.id)).toEqual([newer.memory.id]);
    expectCode(
      () =>
        engine.prepareSearch({
          ...base,
          filters: { time: { preset: "this_week", from: "2026-01-01T00:00:00Z" } },
        }),
      "INVALID_TIME",
    );
  });
});

describe("category-routed row operations", () => {
  it("requires confirmation before an edit creates a near-duplicate category", () => {
    const engine = start();
    const created = engine.create({
      scope: "project",
      category: "architecture",
      content: "Keep architecture notes focused.",
    });

    try {
      engine.edit("architecture", created.memory.id, { category: "architectures" });
      throw new Error("expected NEAR_CATEGORY");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe("NEAR_CATEGORY");
      expect((error as EngineError).near).toEqual({ requested: "architectures", existing: "architecture" });
      expect((error as Error).message).toContain('Use category "architecture"');
      expect((error as Error).message).not.toContain("memory_edit");
    }
    expect(engine.get("architecture", created.memory.id).category).toBe("architecture");
    expect(engine.listCategoryNames("project").project?.categories).toEqual(["architecture"]);

    const moved = engine.edit("architecture", created.memory.id, {
      category: "architectures",
      confirmNewCategory: true,
    });
    expect(moved.category).toBe("architectures");
  });

  it("requires the current category and moves edited rows to the destination database", () => {
    const engine = start();
    const created = engine.create({
      scope: "project",
      category: "preference",
      content: "Prefer muted colors.",
      tags: ["ui"],
    });
    expectCode(() => engine.get("decision", created.memory.id), "INVALID_CATEGORY");

    const moved = engine.edit("preference", created.memory.id, {
      category: "constraint",
      content: "Keep muted colors.",
      subject: "visual design",
      topics: ["accessibility"],
      links: [created.memory.id],
      importance: 0.8,
    });
    expect(moved.category).toBe("constraint");
    expect(moved.staging).toBe(false);
    expect(engine.get("constraint", created.memory.id).subject).toBe("visual design");
    expectCode(() => engine.get("preference", created.memory.id), "NOT_FOUND");
  });

  it("promotes, demotes, and only deletes staging rows", () => {
    const engine = start();
    const custom = engine.create({ scope: "project", category: "research", content: "Review FTS quality." });
    engine.promote("research", custom.memory.id);
    expect(engine.get("research", custom.memory.id).staging).toBe(false);
    expectCode(() => engine.delete("research", custom.memory.id), "NOT_STAGING");
    engine.demote("research", custom.memory.id);
    expect(engine.delete("research", custom.memory.id)).toEqual({ id: custom.memory.id, deleted: true });
  });

  it("promotes and deletes by exact line text and rejects a mismatched id", () => {
    const engine = start();
    const first = engine.create({ scope: "project", category: "research", content: "Keep the shared research line." });
    const second = engine.create({ scope: "project", category: "research", content: "Keep the shared research line." });
    const unique = engine.create({ scope: "project", category: "research", content: "Keep the unique research line." });

    expectCode(
      () => engine.promote("research", { line: "Keep the shared research line." }),
      "AMBIGUOUS_LINE",
    );
    expect(engine.promote("research", { line: "Keep the unique research line." }).id).toBe(unique.memory.id);
    expectCode(
      () => engine.demote("research", { id: first.memory.id, line: "Keep the unique research line." }),
      "LINE_ID_MISMATCH",
    );
    engine.demote("research", { id: unique.memory.id, line: "Keep the unique research line." });
    expect(engine.delete("research", { line: "Keep the unique research line." })).toEqual({
      id: unique.memory.id,
      deleted: true,
    });
    expect(engine.get("research", second.memory.id).staging).toBe(true);
    expectCode(() => engine.delete("research", {}), "INVALID_FILTER");
  });
});

describe("legacy migration and project binding", () => {
  it("copies legacy rows once, preserves data, and retains the old database", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ce-migrate-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "ce-migrate-project-"));
    const layout = layoutFor(resolveProjectPath(project), home);
    mkdirSync(layout.projectDir, { recursive: true });
    const legacy = new Database(layout.projectDb);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chat_id TEXT, category TEXT NOT NULL,
        content TEXT NOT NULL, tags TEXT, importance REAL, active INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(`INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-id", layout.projectKey, null, "decision", "Keep migrated memory.", "legacy", 0.8, 1, 1789322327852, 1789322607803);
    legacy.close();

    const engine = new Engine({ home, projectPath: project });
    try {
      const memory = engine.get("decision", "legacy-id");
      expect(memory.tags).toEqual(["legacy"]);
      expect(memory.created_at).toBe(1789322327);
      expect(memory.updated_at).toBe(1789322607);
      expect(existsSync(layout.projectDb)).toBe(true);
      expect(engine.categoryDatabasePath("project", "decision")).not.toBe(layout.projectDb);
    } finally {
      engine.close();
    }

    const reopened = new Engine({ home, projectPath: project });
    try {
      expect(reopened.get("decision", "legacy-id").content).toBe("Keep migrated memory.");
      const db = new Database(reopened.categoryDatabasePath("project", "decision"), { readonly: true });
      const count = db.prepare(`SELECT COUNT(*) AS count FROM memories`).get() as { count: number };
      db.close();
      expect(count.count).toBe(1);
    } finally {
      reopened.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("binds a different project without leaking category databases", () => {
    const context = openIsolatedEngine();
    const other = mkdtempSync(path.join(os.tmpdir(), "ce-other-"));
    cleanup = () => {
      context.cleanup();
      rmSync(other, { recursive: true, force: true });
    };
    const alpha = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Alpha project memory.",
    });
    context.engine.bind(other);
    const beta = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Beta project memory.",
    });
    expect(context.engine.search({ query: "beta", categories: ["decision"] }).hits.map((hit) => hit.id)).toContain(beta.memory.id);
    expect(context.engine.search({ query: "alpha", categories: ["decision"] }).hits.map((hit) => hit.id)).not.toContain(alpha.memory.id);
  });
});
