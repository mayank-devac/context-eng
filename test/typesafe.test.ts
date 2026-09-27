import { describe, expect, it } from "vitest";
import type { SearchHit, SearchResult } from "../src/engine.js";
import { MAX_HITS, MAX_READ_TOKENS } from "../src/categories.js";
import {
  DEFAULT_JEV_TIMEOUT_MS,
  MAX_JEV_EVALUATE_COUNT,
  NOT_RELEVANT_MESSAGE,
  TOO_LARGE_TO_EVALUATE_MESSAGE,
  TypeSafeRelevanceEvaluator,
  applyRelevanceGate,
  type RelevanceEvaluator,
} from "../src/typesafe.js";

function hit(id: string): SearchHit {
  return {
    id,
    scope: "project",
    category: "decision",
    content: `Memory ${id} is useful.`,
    topics: [],
    tags: [],
    links: [],
    importance: 0.5,
    staging: false,
    active: true,
    tokens: 5,
    created_at: 1,
    updated_at: 1,
    score: 0.7,
  };
}

function result(): SearchResult {
  return {
    query: "useful memory",
    hits: [hit("above"), hit("boundary"), hit("below")],
    total_tokens: 15,
    budget: { max_hits: MAX_HITS, max_tokens: MAX_READ_TOKENS },
    sort: { by: "relevance", order: "desc" },
    eligible_count: 3,
    used_fts: false,
    retrieval: {
      mode: "small",
      candidate_count: 3,
      eligible_tokens: 15,
      channels: ["all"],
    },
  };
}

describe("TypeSafe relevance gate", () => {
  it("returns only contexts strictly above 50 percent", async () => {
    const evaluator: RelevanceEvaluator = { evaluate: async () => [0.501, 0.5, 0.1] };
    const gated = await applyRelevanceGate(result(), evaluator);
    expect(gated.hits.map((candidate) => candidate.id)).toEqual(["above"]);
    expect(gated.hits[0]?.relevance).toBe(0.501);
    expect(gated.rejected_count).toBe(2);
    expect(gated.total_tokens).toBe(5);
  });

  it("returns the not-relevant message when no context passes", async () => {
    const evaluator: RelevanceEvaluator = { evaluate: async () => [0.5, 0.2, 0] };
    const gated = await applyRelevanceGate(result(), evaluator);
    expect(gated.hits).toEqual([]);
    expect(gated.message).toBe(NOT_RELEVANT_MESSAGE);
  });

  it("sends Jev only the agent prompt and context strings", async () => {
    let request: unknown;
    const evaluator = new TypeSafeRelevanceEvaluator({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            answers: {
              context_0: { type: "noul", noul: 0.8 },
              context_1: { type: "noul", noul: 0.7 },
              context_2: { type: "noul", noul: 0.6 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await evaluator.evaluate(result().query, result().hits);
    expect(request).toMatchObject({
      model: "jev-latest",
      state: {
        agent_prompt: "useful memory",
        contexts: [
          "Memory above is useful.",
          "Memory boundary is useful.",
          "Memory below is useful.",
        ],
      },
      questions: {
        context_0: { type: "noul" },
        context_1: { type: "noul" },
        context_2: { type: "noul" },
      },
    });
    expect(JSON.stringify(request)).not.toContain("importance");
    expect(JSON.stringify(request)).not.toContain("category");
  });

  it("reports whether an API key is configured", () => {
    expect(new TypeSafeRelevanceEvaluator({ apiKey: "" }).available()).toBe(false);
    expect(new TypeSafeRelevanceEvaluator({ apiKey: "x" }).available()).toBe(true);
  });

  it("evaluates more than 30 candidates in independent batches", async () => {
    const batchSizes: number[] = [];
    const evaluator = new TypeSafeRelevanceEvaluator({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          state: { contexts: string[] };
        };
        batchSizes.push(request.state.contexts.length);
        const answers = Object.fromEntries(
          request.state.contexts.map((_, index) => [`context_${index}`, { type: "noul", noul: 0.9 }]),
        );
        return new Response(JSON.stringify({ answers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const candidates = Array.from({ length: 31 }, (_, index) => hit(`candidate-${index}`));

    await expect(evaluator.evaluate("find every related memory", candidates)).resolves.toHaveLength(31);
    expect(batchSizes.sort((a, b) => a - b)).toEqual([1, 30]);
  });

  it("evaluates 90 candidates in three Jev batches", async () => {
    const batchSizes: number[] = [];
    const evaluator = new TypeSafeRelevanceEvaluator({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          state: { contexts: string[] };
        };
        batchSizes.push(request.state.contexts.length);
        const answers = Object.fromEntries(
          request.state.contexts.map((_, index) => [`context_${index}`, { type: "noul", noul: 0.9 }]),
        );
        return new Response(JSON.stringify({ answers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const candidates = Array.from({ length: MAX_JEV_EVALUATE_COUNT }, (_, index) =>
      hit(`candidate-${index}`),
    );

    await expect(evaluator.evaluate("find every related memory", candidates)).resolves.toHaveLength(90);
    expect(batchSizes.sort((a, b) => a - b)).toEqual([30, 30, 30]);
  });

  it("evaluates only the first 90 candidates and skips the rest", async () => {
    const batchSizes: number[] = [];
    const evaluator = new TypeSafeRelevanceEvaluator({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          state: { contexts: string[] };
        };
        batchSizes.push(request.state.contexts.length);
        const answers = Object.fromEntries(
          request.state.contexts.map((_, index) => [`context_${index}`, { type: "noul", noul: 0.9 }]),
        );
        return new Response(JSON.stringify({ answers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const candidates = Array.from({ length: MAX_JEV_EVALUATE_COUNT + 1 }, (_, index) =>
      hit(`candidate-${index}`),
    );

    await expect(evaluator.evaluate("find every related memory", candidates)).resolves.toHaveLength(90);
    expect(batchSizes.sort((a, b) => a - b)).toEqual([30, 30, 30]);
  });

  it("returns gated hits from a 90-candidate Jev run", async () => {
    const scores = Array.from({ length: MAX_JEV_EVALUATE_COUNT }, (_, index) =>
      index === 0 ? 0.9 : 0.1,
    );
    const evaluator: RelevanceEvaluator = { evaluate: async () => scores };
    const gated = await applyRelevanceGate(
      { ...result(), hits: Array.from({ length: MAX_JEV_EVALUATE_COUNT }, (_, index) => hit(`c-${index}`)) },
      evaluator,
    );
    expect(gated.hits.map((candidate) => candidate.id)).toEqual(["c-0"]);
    expect(gated.message).toBeUndefined();
  });

  it("evaluates the first 90 above the cap and appends the too-large message", async () => {
    let received = 0;
    const evaluator: RelevanceEvaluator = {
      evaluate: async (_query, candidates) => {
        received = candidates.length;
        return candidates.map((_, index) => (index === 0 ? 0.9 : 0.1));
      },
    };
    const gated = await applyRelevanceGate(
      {
        ...result(),
        hits: Array.from({ length: MAX_JEV_EVALUATE_COUNT + 1 }, (_, index) => hit(`c-${index}`)),
      },
      evaluator,
    );
    expect(received).toBe(90);
    expect(gated.hits.map((candidate) => candidate.id)).toEqual(["c-0"]);
    expect(gated.message).toBe(TOO_LARGE_TO_EVALUATE_MESSAGE);
    expect(gated.rejected_count).toBe(90);
  });

  it("returns not-relevant when the 90 Jev scores all fail the gate", async () => {
    const evaluator: RelevanceEvaluator = {
      evaluate: async (_query, candidates) => candidates.map(() => 0.1),
    };
    const gated = await applyRelevanceGate(
      {
        ...result(),
        hits: Array.from({ length: MAX_JEV_EVALUATE_COUNT + 1 }, (_, index) => hit(`c-${index}`)),
      },
      evaluator,
    );
    expect(gated.hits).toEqual([]);
    expect(gated.message).toBe(NOT_RELEVANT_MESSAGE);
  });

  it("returns 50 gated notes plus too-large when more than 90 pass", async () => {
    const evaluator: RelevanceEvaluator = {
      evaluate: async (_query, candidates) => candidates.map(() => 0.9),
    };
    const gated = await applyRelevanceGate(
      {
        ...result(),
        hits: Array.from({ length: MAX_JEV_EVALUATE_COUNT + 1 }, (_, index) => hit(`c-${index}`)),
      },
      evaluator,
    );
    expect(gated.hits).toHaveLength(50);
    expect(gated.message).toBe(TOO_LARGE_TO_EVALUATE_MESSAGE);
  });

  it("aborts a Jev request after its configured deadline", async () => {
    const evaluator = new TypeSafeRelevanceEvaluator({
      apiKey: "test-key",
      timeoutMs: 5,
      fetcher: async (_input, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return new Response();
      },
    });

    await expect(evaluator.evaluate("useful memory", [hit("slow")])).rejects.toThrow(
      "TypeSafe relevance evaluation timed out after 5ms.",
    );
    expect(DEFAULT_JEV_TIMEOUT_MS).toBe(20_000);
  });
});
