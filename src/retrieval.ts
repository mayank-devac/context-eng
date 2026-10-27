import { MAX_JEV_BATCHES, MAX_JEV_CANDIDATES } from "./categories.js";
import type { Engine, SearchInput, SearchResult } from "./engine.js";
import {
  NOT_RELEVANT_MESSAGE,
  TypeSafeError,
  applyRelevanceGate,
  type RelevanceEvaluator,
} from "./typesafe.js";

export type MemoryContext = SearchResult & { message?: string };

export async function retrieveMemories(
  engine: Engine,
  input: SearchInput,
  evaluator?: RelevanceEvaluator,
): Promise<MemoryContext> {
  if (!evaluator || evaluator.available?.() === false) return engine.search(input);
  try {
    return await applyRelevanceGate(engine.prepareSearch(input), evaluator);
  } catch (error) {
    if (!(error instanceof TypeSafeError)) throw error;
    process.stderr.write(`[context-eng] Jev unavailable; using FTS5 fallback: ${error.message}\n`);
    return engine.search(input);
  }
}

export function renderMemoryContext(result: MemoryContext, projectPath: string | undefined): string {
  const evaluatedCandidates = Math.min(
    result.retrieval.candidate_count,
    MAX_JEV_CANDIDATES * MAX_JEV_BATCHES,
  );
  const channels = result.retrieval.channels.join("+") || "none";
  const retrieval = result.retrieval.mode === "small"
    ? `retrieval: small · eligible ${result.eligible_count}`
    : `retrieval: large · ${evaluatedCandidates} candidates · ${channels}`;
  const context = result.hits
    .map((hit) => {
      const project = hit.scope === "global" ? "global" : projectPath ?? "unbound";
      const updated = new Date(hit.updated_at * 1000).toISOString();
      return `[last updated: ${updated} | category: ${hit.category} | project: ${project}]\n${hit.content}`;
    })
    .join("\n\n");
  return [retrieval, context, result.message || (context ? undefined : NOT_RELEVANT_MESSAGE)]
    .filter(Boolean)
    .join("\n\n");
}
