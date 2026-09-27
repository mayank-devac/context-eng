import {
  budgetHits,
  sortHits,
  type SearchHit,
  type SearchResult,
} from "./engine.js";
import { MAX_JEV_BATCHES, MAX_JEV_CANDIDATES } from "./categories.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** @context-eng-locked Jev request deadline. Do not change unless the user asks. */
export const DEFAULT_JEV_TIMEOUT_MS = 20_000;

export const RELEVANCE_THRESHOLD = 0.5;
export const NOT_RELEVANT_MESSAGE =
  "no matching memory. after work, memory_create if something happened like a decision , preferences , workflow , mistakes , instructions and you need to save it for later.";
export const TOO_LARGE_TO_EVALUATE_MESSAGE = "Memory is too large to evaluate.";
export const MAX_JEV_EVALUATE_COUNT = MAX_JEV_CANDIDATES * MAX_JEV_BATCHES;

export interface RelevanceEvaluator {
  available?(): boolean;
  evaluate(query: string, candidates: SearchHit[]): Promise<number[]>;
}

export interface RelevantSearchHit extends SearchHit {
  relevance: number;
}

export interface RelevantSearchResult extends Omit<SearchResult, "hits"> {
  hits: RelevantSearchHit[];
  rejected_count: number;
  message?: string;
}

export class TypeSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeSafeError";
  }
}

interface TypeSafeOptions {
  apiKey?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class TypeSafeRelevanceEvaluator implements RelevanceEvaluator {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TypeSafeOptions = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
    this.endpoint = options.endpoint?.trim() || process.env.TYPESAFE_API_URL?.trim() || DEFAULT_ENDPOINT;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
  }

  available(): boolean {
    return this.apiKey.length > 0;
  }

  async evaluate(query: string, candidates: SearchHit[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    if (!this.available()) throw new TypeSafeError("TYPESAFE_API_KEY is not configured.");
    const limited = limitJevCandidates(candidates);

    const batches: SearchHit[][] = [];
    for (let index = 0; index < limited.length; index += MAX_JEV_CANDIDATES) {
      batches.push(limited.slice(index, index + MAX_JEV_CANDIDATES));
    }
    const scores = await Promise.all(batches.map((batch) => this.evaluateBatch(query, batch)));
    return scores.flat();
  }

  private async evaluateBatch(query: string, candidates: SearchHit[]): Promise<number[]> {
    const questions = Object.fromEntries(
      candidates.map((_, index) => [
        `context_${index}`,
        {
          type: "noul",
          instructions: [
            `Decide whether contexts[${index}] is directly useful for answering or completing agent_prompt.`,
            "Judge semantic usefulness, not merely shared words.",
          ],
          criteria: {
            true: "The context meaningfully helps complete the agent prompt.",
            false: "The context is unrelated, incidental, or too weak to help.",
          },
        },
      ]),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: {
            agent_prompt: query,
            contexts: candidates.map((candidate) => candidate.content),
          },
          model: "jev-latest",
          questions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TypeSafeError(`TypeSafe relevance evaluation failed with HTTP ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new TypeSafeError("TypeSafe relevance evaluation returned invalid JSON.");
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        throw new TypeSafeError("TypeSafe relevance evaluation returned an invalid response.");
      }
      const answers = body.answers;

      return candidates.map((_, index) => {
        const answer = answers[`context_${index}`];
        if (
          !isRecord(answer) ||
          answer.type !== "noul" ||
          typeof answer.noul !== "number" ||
          !Number.isFinite(answer.noul) ||
          answer.noul < 0 ||
          answer.noul > 1
        ) {
          throw new TypeSafeError(`TypeSafe relevance evaluation omitted context_${index}.`);
        }
        return answer.noul;
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TypeSafeError(`TypeSafe relevance evaluation timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof TypeSafeError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new TypeSafeError(`TypeSafe relevance evaluation failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_JEV_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  return Math.floor(value);
}

export async function applyRelevanceGate(
  result: SearchResult,
  evaluator: RelevanceEvaluator,
): Promise<RelevantSearchResult> {
  if (result.hits.length === 0) {
    return { ...result, hits: [], rejected_count: 0, message: NOT_RELEVANT_MESSAGE };
  }
  const truncated = result.hits.length > MAX_JEV_EVALUATE_COUNT;
  const candidates = limitJevCandidates(result.hits);
  const scores = await evaluator.evaluate(result.query, candidates);
  if (scores.length !== candidates.length) {
    throw new TypeSafeError("TypeSafe relevance evaluation returned the wrong number of scores.");
  }

  const approved: RelevantSearchHit[] = [];
  for (const [index, hit] of candidates.entries()) {
    const relevance = scores[index];
    if (relevance !== undefined && relevance > RELEVANCE_THRESHOLD) {
      const rounded = round(relevance);
      approved.push({ ...hit, score: rounded, relevance: rounded });
    }
  }
  const sorted = sortHits(approved, result.sort);
  const hits = budgetHits(sorted, result.budget.max_hits, result.budget.max_tokens);
  const filtered: RelevantSearchResult = {
    ...result,
    hits,
    total_tokens: hits.reduce((sum, hit) => sum + hit.tokens, 0),
    rejected_count: result.hits.length - approved.length,
  };
  if (truncated && hits.length > 0) filtered.message = TOO_LARGE_TO_EVALUATE_MESSAGE;
  else if (hits.length === 0) filtered.message = NOT_RELEVANT_MESSAGE;
  return filtered;
}

function limitJevCandidates<T>(candidates: readonly T[]): T[] {
  return candidates.slice(0, MAX_JEV_EVALUATE_COUNT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
