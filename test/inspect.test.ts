import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { renderSearchInspection, runSearchInspection } from "../src/inspect.js";
import { TypeSafeError, type RelevanceEvaluator } from "../src/typesafe.js";
import { openIsolatedEngine } from "./harness.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("search inspection", () => {
  it("shows every eligible memory, candidate context, and eligibility reasons", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    context.engine.create({
      scope: "project",
      category: "instruction",
      content: "Keep memory creation to one claim.",
      importance: 0.9,
    });
    context.engine.create({
      scope: "project",
      category: "decision",
      content: "Store durable project context.",
    });
    context.engine.create({
      scope: "project",
      category: "preference",
      content: "Prefer concise memory output.",
    });

    const report = await runSearchInspection(context.engine, {
      query: "memory creation rules",
      filters: { scope: "project" },
    });

    expect(report.result.retrieval.mode).toBe("small");
    expect(report.eligible).toHaveLength(2);
    expect(report.candidates).toHaveLength(2);
    expect(report.eligible.every((hit) => hit.staging === false)).toBe(true);
    expect(report.candidates.every((candidate) => candidate.channels.includes("all"))).toBe(true);
    const rendered = renderSearchInspection(report);
    expect(rendered).toContain("ELIGIBLE MEMORIES (2)");
    expect(rendered).toContain("CANDIDATE CONTEXT SENT TO JEV (2)");
    expect(rendered).toContain("state: promoted");
    expect(rendered).toContain("context:");
  });

  it("shows every Jev score and the final kept IDs", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    const kept = context.engine.create({
      scope: "project",
      category: "instruction",
      content: "Keep memory creation to one claim.",
      importance: 0.9,
    });
    context.engine.create({
      scope: "project",
      category: "decision",
      content: "Use SQLite for durable storage.",
    });
    const evaluator: RelevanceEvaluator = {
      available: () => true,
      evaluate: async (_query, candidates) => candidates.map((candidate) => candidate.id === kept.memory.id ? 0.9 : 0.1),
    };

    const report = await runSearchInspection(
      context.engine,
      { query: "memory creation rules", filters: { scope: "project" } },
      { evaluateJev: true, evaluator },
    );

    expect(report.jev.status).toBe("evaluated");
    expect(report.jev.decisions.map((decision) => decision.decision)).toEqual(expect.arrayContaining(["kept", "rejected"]));
    expect(report.jev.kept_ids).toEqual([kept.memory.id]);
    expect(report.relevance?.hits.map((hit) => hit.id)).toEqual([kept.memory.id]);
    expect(report.relevance?.hits[0]?.relevance).toBe(0.9);
    expect(report.relevance?.rejected_count).toBe(1);
    expect(renderSearchInspection(report)).toContain("score 0.900");
  });

  it("reports merge-time fts, label, and fill channels in large mode", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    const fts = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Keep the inspection lexical needle visible.",
    });
    const labeled = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Keep exact diagnostic labels visible.",
      topics: ["inspect-channel"],
    });
    for (let index = 0; index < 59; index += 1) {
      context.engine.create({
        scope: "project",
        category: "decision",
        content: `Large padding row ${index}.`,
      });
    }

    const report = await runSearchInspection(context.engine, {
      query: "inspection lexical needle",
      categories: ["decision"],
      hints: { topics: ["inspect-channel"] },
    });

    expect(report.result.retrieval.mode).toBe("large");
    expect(report.candidates.find((candidate) => candidate.hit.id === fts.memory.id)?.channels).toContain("fts");
    const labelCandidate = report.candidates.find((candidate) => candidate.hit.id === labeled.memory.id);
    expect(labelCandidate?.channels).toContain("labels");
    expect(labelCandidate?.matchedLabels).toEqual(["topic:inspect-channel"]);
    expect(report.candidates.some((candidate) => candidate.channels.includes("fill"))).toBe(true);
  });

  it("reports the corrected typo channel in large mode", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    const target = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Keep memory retrieval dependable.",
    });
    for (let index = 0; index < 60; index += 1) {
      context.engine.create({
        scope: "project",
        category: "decision",
        content: `Unrelated inspection typo padding ${index}.`,
      });
    }

    const report = await runSearchInspection(context.engine, {
      query: "memroy",
      categories: ["decision"],
    });

    expect(report.corrected_query).toBe("memory");
    expect(report.candidates.find((candidate) => candidate.hit.id === target.memory.id)?.channels).toEqual(
      expect.arrayContaining(["fts", "typo"]),
    );
  });

  it("uses local search when Jev is unavailable", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    const target = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Use SQLite fallback search.",
    });
    const evaluator: RelevanceEvaluator = {
      available: () => false,
      evaluate: async () => {
        throw new Error("should not evaluate");
      },
    };

    const report = await runSearchInspection(
      context.engine,
      { query: "SQLite fallback", categories: ["decision"] },
      { evaluateJev: true, evaluator },
    );

    expect(report.jev.status).toBe("unavailable");
    expect(report.local_fallback?.hits.map((hit) => hit.id)).toContain(target.memory.id);
  });

  it("uses local search when the production Jev gate fails", async () => {
    const context = openIsolatedEngine();
    cleanup = context.cleanup;
    const target = context.engine.create({
      scope: "project",
      category: "decision",
      content: "Use SQLite failure fallback search.",
    });
    const evaluator: RelevanceEvaluator = {
      available: () => true,
      evaluate: async () => {
        throw new TypeSafeError("temporary Jev failure");
      },
    };

    const report = await runSearchInspection(
      context.engine,
      { query: "SQLite failure fallback", categories: ["decision"] },
      { evaluateJev: true, evaluator },
    );

    expect(report.jev.status).toBe("failed");
    expect(report.jev.error).toBe("temporary Jev failure");
    expect(report.local_fallback?.hits.map((hit) => hit.id)).toContain(target.memory.id);
  });

  it("accepts a validated SearchInput through the CLI --input flag", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ce-inspect-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "ce-inspect-project-"));
    try {
      const engine = new Engine({ home, projectPath: project });
      try {
        engine.create({
          scope: "project",
          category: "decision",
          content: "Keep CLI input inspection available.",
        });
      } finally {
        engine.close();
      }

      const result = spawnSync(
        process.execPath,
        [
          TSX,
          path.join(REPO, "src", "inspect-cli.ts"),
          "--project",
          project,
          "--input",
          JSON.stringify({
            query: "CLI input inspection",
            categories: ["decision"],
            filters: { scope: "project" },
          }),
          "--json",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, CONTEXT_ENG_HOME: home },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as { input: { query: string }; candidates: unknown[] };
      expect(report.input.query).toBe("CLI input inspection");
      expect(report.candidates).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
