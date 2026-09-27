import type { Engine } from "./engine.js";
import type {
  SearchCandidate,
  SearchDebugSnapshot,
  SearchHit,
  SearchInput,
  SearchResult,
} from "./search.js";
import {
  applyRelevanceGate,
  MAX_JEV_EVALUATE_COUNT,
  RELEVANCE_THRESHOLD,
  TypeSafeError,
  TypeSafeRelevanceEvaluator,
  type RelevantSearchResult,
  type RelevanceEvaluator,
} from "./typesafe.js";

export type JevDecision = "kept" | "rejected" | "budgeted_out" | "not_evaluated";

export interface SearchInspectionCandidate extends SearchCandidate {
  position: number;
}

export interface SearchInspectionReport {
  input: SearchInput;
  result: SearchResult;
  eligible: SearchHit[];
  candidates: SearchInspectionCandidate[];
  corrected_query?: string;
  jev: {
    status: "not_requested" | "unavailable" | "evaluated" | "failed";
    evaluated_count: number;
    decisions: Array<{
      position: number;
      id: string;
      score?: number;
      decision: JevDecision;
    }>;
    kept_ids: string[];
    error?: string;
  };
  relevance?: RelevantSearchResult;
  local_fallback?: SearchResult;
}

export async function runSearchInspection(
  engine: Engine,
  input: SearchInput,
  options: { evaluateJev?: boolean; evaluator?: RelevanceEvaluator } = {},
): Promise<SearchInspectionReport> {
  const inspection = inspectionReport(input, engine.prepareSearchDebug(input));
  if (!options.evaluateJev) return withJevStatus(inspection, "not_requested");

  const evaluator = options.evaluator ?? new TypeSafeRelevanceEvaluator();
  if (evaluator.available?.() === false) {
    return {
      ...withJevStatus(inspection, "unavailable"),
      local_fallback: engine.search(input),
    };
  }

  let evaluatedScores: number[] = [];
  const scoreById = new Map<string, number>();
  const recordingEvaluator: RelevanceEvaluator = {
    evaluate: async (query, candidates) => {
      evaluatedScores = await evaluator.evaluate(query, candidates);
      scoreById.clear();
      for (const [index, hit] of candidates.entries()) {
        const score = evaluatedScores[index];
        if (score !== undefined) scoreById.set(hit.id, score);
      }
      return evaluatedScores;
    },
  };
  try {
    const relevance = await applyRelevanceGate(inspection.result, recordingEvaluator);
    const keptIds = new Set(relevance.hits.map((hit) => hit.id));
    const decisions = inspection.candidates.map((candidate) => {
      const score = scoreById.get(candidate.hit.id);
      if (score === undefined) {
        return { position: candidate.position, id: candidate.hit.id, decision: "not_evaluated" as const };
      }
      const rounded = round(score);
      const decision = score <= RELEVANCE_THRESHOLD
        ? "rejected" as const
        : keptIds.has(candidate.hit.id)
          ? "kept" as const
          : "budgeted_out" as const;
      return { position: candidate.position, id: candidate.hit.id, score: rounded, decision };
    });
    return {
      ...inspection,
      relevance,
      jev: {
        status: "evaluated",
        evaluated_count: evaluatedScores.length,
        decisions,
        kept_ids: relevance.hits.map((hit) => hit.id),
      },
    };
  } catch (error) {
    if (!(error instanceof TypeSafeError)) throw error;
    return {
      ...withJevStatus(inspection, "failed", error instanceof Error ? error.message : String(error)),
      local_fallback: engine.search(input),
    };
  }
}

export function renderSearchInspection(report: SearchInspectionReport): string {
  const lines = [
    "SEARCH INSPECTION",
    `query: ${report.input.query}`,
    `retrieval: ${report.result.retrieval.mode}`,
    `eligible: ${report.result.eligible_count}`,
    `eligible tokens: ${report.result.retrieval.eligible_tokens}`,
    `candidates: ${report.result.retrieval.candidate_count}`,
    `channels: ${report.result.retrieval.channels.join("+") || "none"}`,
  ];
  if (report.corrected_query) lines.push(`corrected query: ${report.corrected_query}`);

  lines.push("", `ELIGIBLE MEMORIES (${report.eligible.length})`);
  for (const [index, hit] of report.eligible.entries()) {
    lines.push(
      `[${index + 1}] ${hit.id} · ${hit.scope}/${hit.category} · importance ${hit.importance}`,
      `state: ${hit.staging ? "staging" : "promoted"} · tokens ${hit.tokens}`,
      `content: ${hit.content}`,
      "",
    );
  }

  lines.push(`CANDIDATE CONTEXT SENT TO JEV (${Math.min(report.candidates.length, MAX_JEV_EVALUATE_COUNT)})`);
  for (const candidate of report.candidates) {
    const sent = candidate.position <= MAX_JEV_EVALUATE_COUNT;
    lines.push(
      `[${candidate.position}] ${candidate.hit.id} · ${sent ? "sent" : "past Jev cap"} · ${candidate.channels.join("+")}`,
      `why candidate: ${candidateReasons(candidate).join("; ")}`,
      `context: ${candidate.hit.content}`,
      "",
    );
  }

  lines.push(`JEV: ${report.jev.status} · evaluated ${report.jev.evaluated_count}`);
  if (report.jev.error) lines.push(`error: ${report.jev.error}`);
  if (report.relevance) {
    lines.push(`production rejected: ${report.relevance.rejected_count}`);
    lines.push(`production tokens: ${report.relevance.total_tokens}`);
    if (report.relevance.message) lines.push(`production message: ${report.relevance.message}`);
  }
  for (const decision of report.jev.decisions) {
    const score = decision.score === undefined ? "n/a" : decision.score.toFixed(3);
    lines.push(`[${decision.position}] ${decision.id} · ${decision.decision} · score ${score}`);
  }
  if (report.jev.kept_ids.length > 0) lines.push(`kept IDs: ${report.jev.kept_ids.join(", ")}`);
  if (report.local_fallback) {
    lines.push(`local fallback IDs: ${report.local_fallback.hits.map((hit) => hit.id).join(", ") || "none"}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function withJevStatus(
  inspection: Omit<SearchInspectionReport, "jev">,
  status: SearchInspectionReport["jev"]["status"],
  error?: string,
): SearchInspectionReport {
  return {
    ...inspection,
    jev: {
      status,
      evaluated_count: 0,
      decisions: inspection.candidates.map((candidate) => ({
        position: candidate.position,
        id: candidate.hit.id,
        decision: "not_evaluated" as const,
      })),
      kept_ids: [],
      ...(error !== undefined ? { error } : {}),
    },
  };
}

function inspectionReport(input: SearchInput, snapshot: SearchDebugSnapshot): Omit<SearchInspectionReport, "jev"> {
  return {
    input,
    result: snapshot.result,
    eligible: snapshot.eligible,
    candidates: snapshot.candidates.map((candidate, index) => ({ ...candidate, position: index + 1 })),
    ...(snapshot.correctedQuery !== undefined ? { corrected_query: snapshot.correctedQuery } : {}),
  };
}

function candidateReasons(candidate: SearchInspectionCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.channels.includes("all")) reasons.push("small mode sends every eligible memory to Jev");
  if (candidate.channels.includes("fts")) reasons.push("FTS5 matched the lexical query");
  if (candidate.matchedLabels.length > 0) {
    reasons.push(`exact hint labels matched: ${candidate.matchedLabels.join(", ")}`);
  }
  if (candidate.channels.includes("typo")) reasons.push("matched the one-pass corrected typo query");
  if (candidate.channels.includes("fill")) reasons.push("filled an unused large-mode Jev slot by priority");
  if (candidate.categoryHintBoosted) reasons.push(`category hint boosted ${candidate.hit.category} before Jev`);
  return reasons;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
