import {
  MAX_FILTER_VALUE_LENGTH,
  MAX_FILTER_VALUES,
  MAX_HITS,
  MAX_JEV_BATCHES,
  MAX_JEV_CANDIDATES,
  MAX_SEARCH_CATEGORIES,
  isCategory,
  isScope,
  canonicalCategory,
  type Category,
  type Scope,
} from "./categories.js";
import type { CategoryRecord, Db, MemoryRow } from "./db.js";
import { listCategories } from "./db.js";
import { buildFtsQuery, keywords, lexicalQueryTerms, normalizeLabel, normalizeLabels } from "./text.js";
import type { Memory } from "./engine.js";

export type EngineErrorCode =
  | "INVALID_CATEGORY"
  | "INVALID_CATEGORIES"
  | "NEAR_CATEGORY"
  | "INVALID_SCOPE"
  | "INVALID_FILTER"
  | "INVALID_TIME"
  | "INVALID_SORT"
  | "EMPTY_CONTENT"
  | "TOO_LONG"
  | "NOT_ONE_SENTENCE"
  | "NOT_FOUND"
  | "AMBIGUOUS_LINE"
  | "LINE_ID_MISMATCH"
  | "NOT_STAGING"
  | "INVALID_PROJECT_PATH"
  | "PROJECT_NOT_BOUND"
  | "INVALID_IMPORTANCE";

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
    public readonly near?: { requested: string; existing: string },
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface SearchHit extends Memory {
  score: number;
}

export type MatchMode = "any" | "all";
export interface ListFilter {
  values: string[];
  match?: MatchMode | undefined;
}
export interface TimeFilter {
  field?: "created" | "updated" | undefined;
  preset?: "this_week" | "this_month" | undefined;
  from?: string | undefined;
  to?: string | undefined;
}
export interface SearchFilters {
  scope?: "both" | Scope | undefined;
  includeStaging?: boolean | undefined;
  minImportance?: number | undefined;
  subject?: string | undefined;
  topics?: ListFilter | undefined;
  tags?: ListFilter | undefined;
  links?: ListFilter | undefined;
  time?: TimeFilter | undefined;
}
export interface SearchHints {
  topics?: string[] | undefined;
  tags?: string[] | undefined;
  links?: string[] | undefined;
  categories?: Category[] | undefined;
}
export interface SearchSort {
  by: "relevance" | "updated" | "created" | "importance";
  order?: "asc" | "desc" | undefined;
}
export interface SearchInput {
  query: string;
  /** Omit to search every category available in the selected scope(s). */
  categories?: Category[] | undefined;
  filters?: SearchFilters;
  hints?: SearchHints;
  sort?: SearchSort;
  limit?: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  total_tokens: number;
  budget: { max_hits: number; max_tokens: number };
  sort: Required<SearchSort>;
  eligible_count: number;
  used_fts: boolean;
  retrieval: {
    mode: "small" | "large";
    candidate_count: number;
    eligible_tokens: number;
    channels: RetrievalChannel[];
  };
}

export type RetrievalChannel = "all" | "fts" | "labels" | "typo" | "fill";

export interface SearchCandidate {
  hit: SearchHit;
  channels: RetrievalChannel[];
  matchedLabels: string[];
  categoryHintBoosted: boolean;
}

export interface SearchDebugSnapshot {
  result: SearchResult;
  eligible: SearchHit[];
  candidates: SearchCandidate[];
  correctedQuery?: string;
}

export interface SearchSource {
  db: Db;
  scope: Scope;
  record: CategoryRecord;
}

export interface NormalizedSearch {
  input: SearchInput;
  categories: string[];
  allCategories: boolean;
  filters: SearchFilters;
  hints: {
    topics: string[];
    tags: string[];
    links: string[];
    categories: string[];
  };
  sort: Required<SearchSort>;
  limit: number;
  scopes: Scope[];
  time?: { field: "created_at" | "updated_at"; from?: number; to?: number };
}

export interface SearchAccess {
  catalogFor(scope: Scope): Db;
  dbForRecord(scope: Scope, record: CategoryRecord): Db;
  recordFor(scope: Scope, category: Category): CategoryRecord | undefined;
  toHit(row: MemoryRow, scope: Scope): SearchHit;
}

export function normalizeImportance(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new EngineError("INVALID_IMPORTANCE", "importance must be a number between 0 and 1");
  }
  return value;
}

export function normalizeSubject(value: string | undefined): string {
  if (value === undefined) return "";
  const normalized = normalizeLabel(value);
  if (normalized.length > MAX_FILTER_VALUE_LENGTH) {
    throw new EngineError("INVALID_FILTER", `subject must be at most ${MAX_FILTER_VALUE_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeStoredLabels(name: string, values: readonly string[] | undefined): string[] {
  const normalized = normalizeLabels(values);
  if (normalized.length > MAX_FILTER_VALUES) {
    throw new EngineError("INVALID_FILTER", `${name} accepts at most ${MAX_FILTER_VALUES} values`);
  }
  if (normalized.some((value) => value.length > MAX_FILTER_VALUE_LENGTH)) {
    throw new EngineError("INVALID_FILTER", `${name} values must be at most ${MAX_FILTER_VALUE_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeSearch(input: SearchInput): NormalizedSearch {
  const requestedCategories = input.categories;
  const allCategories = requestedCategories === undefined;
  let categories: string[] = [];
  if (requestedCategories !== undefined) {
    if (requestedCategories.length < 1 || requestedCategories.length > MAX_SEARCH_CATEGORIES) {
      throw new EngineError(
        "INVALID_CATEGORIES",
        `categories must contain 1 to ${MAX_SEARCH_CATEGORIES} values when provided`,
      );
    }
    if (!requestedCategories.every(isCategory)) {
      throw new EngineError("INVALID_CATEGORY", "each category must be 1 to 64 characters");
    }
    categories = requestedCategories.map(canonicalCategory);
    if (new Set(categories).size !== categories.length) {
      throw new EngineError("INVALID_CATEGORIES", "categories must be unique after normalization");
    }
  }
  const filters = input.filters ?? {};
  const hints = normalizeHints(input.hints);
  const scope = filters.scope ?? "both";
  if (scope !== "both" && !isScope(scope)) {
    throw new EngineError("INVALID_SCOPE", "filter scope must be both, global, or project");
  }
  if (filters.minImportance !== undefined) normalizeImportance(filters.minImportance);
  if (filters.subject !== undefined) normalizeSubject(filters.subject);
  for (const [name, filter] of [
    ["topics", filters.topics],
    ["tags", filters.tags],
    ["links", filters.links],
  ] as const) {
    if (!filter) continue;
    normalizeStoredLabels(name, filter.values);
    if (filter.match !== undefined && filter.match !== "any" && filter.match !== "all") {
      throw new EngineError("INVALID_FILTER", `${name}.match must be any or all`);
    }
  }
  const sort: Required<SearchSort> = {
    by: input.sort?.by ?? "relevance",
    order: input.sort?.order ?? "desc",
  };
  if (!["relevance", "updated", "created", "importance"].includes(sort.by)) {
    throw new EngineError("INVALID_SORT", "invalid sort field");
  }
  if (sort.order !== "asc" && sort.order !== "desc") {
    throw new EngineError("INVALID_SORT", "sort order must be asc or desc");
  }
  const limit = Math.max(1, Math.min(input.limit ?? MAX_HITS, MAX_HITS));
  const scopes: Scope[] = scope === "both" ? ["global", "project"] : [scope];
  const time = normalizeTime(filters.time);
  return {
    input,
    categories,
    allCategories,
    filters,
    hints,
    sort,
    limit,
    scopes,
    ...(time !== undefined ? { time } : {}),
  };
}

function normalizeHints(hints: SearchHints | undefined): NormalizedSearch["hints"] {
  const topics = normalizeHintLabels("hints.topics", hints?.topics);
  const tags = normalizeHintLabels("hints.tags", hints?.tags);
  const links = normalizeHintLabels("hints.links", hints?.links);
  const rawCategories = hints?.categories;
  let categories: string[] = [];
  if (rawCategories !== undefined) {
    if (rawCategories.length < 1 || rawCategories.length > MAX_SEARCH_CATEGORIES) {
      throw new EngineError("INVALID_FILTER", `hints.categories accepts 1 to ${MAX_SEARCH_CATEGORIES} values`);
    }
    if (!rawCategories.every(isCategory)) {
      throw new EngineError("INVALID_FILTER", "hints.categories values must be 1 to 64 characters");
    }
    categories = [...new Set(rawCategories.map(canonicalCategory))];
    if (categories.length !== rawCategories.length) {
      throw new EngineError("INVALID_FILTER", "hints.categories values must be unique after normalization");
    }
  }
  return { topics, tags, links, categories };
}

function normalizeHintLabels(name: string, values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (values.length < 1) throw new EngineError("INVALID_FILTER", `${name} must not be empty when provided`);
  const normalized = normalizeStoredLabels(name, values);
  if (normalized.length !== values.length) {
    throw new EngineError("INVALID_FILTER", `${name} values must be unique and non-empty after normalization`);
  }
  return normalized;
}

function normalizeTime(time: TimeFilter | undefined): NormalizedSearch["time"] {
  if (!time) return undefined;
  if (time.preset && (time.from || time.to)) {
    throw new EngineError("INVALID_TIME", "time preset cannot be combined with from or to");
  }
  const field = time.field === "created" ? "created_at" : "updated_at";
  if (time.field !== undefined && time.field !== "created" && time.field !== "updated") {
    throw new EngineError("INVALID_TIME", "time field must be created or updated");
  }
  if (time.preset) {
    const now = new Date();
    const start = new Date(now);
    if (time.preset === "this_month") {
      start.setHours(0, 0, 0, 0);
      start.setDate(1);
    } else if (time.preset === "this_week") {
      const day = start.getDay();
      start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
      start.setHours(0, 0, 0, 0);
    } else {
      throw new EngineError("INVALID_TIME", "time preset must be this_week or this_month");
    }
    return { field, from: Math.floor(start.getTime() / 1000), to: Math.floor(now.getTime() / 1000) };
  }
  const from = parseIsoTime(time.from, "from");
  const to = parseIsoTime(time.to, "to");
  if (from !== undefined && to !== undefined && from > to) {
    throw new EngineError("INVALID_TIME", "time.from must not be after time.to");
  }
  return { field, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

function parseIsoTime(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new EngineError("INVALID_TIME", `time.${name} must be ISO-8601`);
  return Math.floor(milliseconds / 1000);
}

export function sqlFilter(search: NormalizedSearch, alias: string): { sql: string; params: unknown[] } {
  const clauses = [`${alias}.active = 1`];
  const params: unknown[] = [];
  if (!search.filters.includeStaging) clauses.push(`${alias}.chat_id IS NULL`);
  if (search.filters.minImportance !== undefined) {
    clauses.push(`${alias}.importance >= ?`);
    params.push(search.filters.minImportance);
  }
  if (search.filters.subject !== undefined) {
    clauses.push(`${alias}.subject = ?`);
    params.push(normalizeSubject(search.filters.subject));
  }
  if (search.time?.from !== undefined) {
    clauses.push(`${alias}.${search.time.field} >= ?`);
    params.push(search.time.from);
  }
  if (search.time?.to !== undefined) {
    clauses.push(`${alias}.${search.time.field} <= ?`);
    params.push(search.time.to);
  }
  for (const [kind, filter] of [
    ["topic", search.filters.topics],
    ["tag", search.filters.tags],
    ["link", search.filters.links],
  ] as const) {
    if (!filter) continue;
    const values = normalizeStoredLabels(`${kind}s`, filter.values);
    if (values.length === 0) continue;
    const placeholders = values.map(() => "?").join(", ");
    if ((filter.match ?? "any") === "all") {
      clauses.push(
        `(SELECT COUNT(DISTINCT label.value) FROM memory_labels label
          WHERE label.memory_id = ${alias}.id AND label.kind = ? AND label.value IN (${placeholders})) = ?`,
      );
      params.push(kind, ...values, values.length);
    } else {
      clauses.push(
        `EXISTS (SELECT 1 FROM memory_labels label
                 WHERE label.memory_id = ${alias}.id AND label.kind = ? AND label.value IN (${placeholders}))`,
      );
      params.push(kind, ...values);
    }
  }
  return { sql: clauses.join(" AND "), params };
}

export function searchSources(search: NormalizedSearch, access: SearchAccess): SearchSource[] {
  const sources: SearchSource[] = [];
  if (search.allCategories) {
    for (const scope of search.scopes) {
      for (const record of listCategories(access.catalogFor(scope))) {
        sources.push({ db: access.dbForRecord(scope, record), scope, record });
      }
    }
    return sources;
  }
  for (const canonical of search.categories) {
    let found = false;
    for (const scope of search.scopes) {
      const record = access.recordFor(scope, canonical);
      if (!record) continue;
      found = true;
      sources.push({ db: access.dbForRecord(scope, record), scope, record });
    }
    if (!found) throw new EngineError("INVALID_CATEGORY", `unknown category: ${canonical}`);
  }
  return sources;
}

export function countEligible(source: SearchSource, search: NormalizedSearch): number {
  const filter = sqlFilter(search, "m");
  const row = source.db
    .prepare(`SELECT COUNT(*) AS count FROM memories m WHERE ${filter.sql}`)
    .get(...filter.params) as { count: number };
  return row.count;
}

export function readAllEligible(sources: SearchSource[], search: NormalizedSearch, access: SearchAccess): SearchHit[] {
  return sources.flatMap((source) => {
    const filter = sqlFilter(search, "m");
    const rows = source.db
      .prepare(`SELECT m.* FROM memories m WHERE ${filter.sql}`)
      .all(...filter.params) as MemoryRow[];
    return rows.map((row) => ({ ...access.toHit(row, source.scope), score: row.importance }));
  });
}

export function readFtsCandidates(
  sources: SearchSource[],
  search: NormalizedSearch,
  access: SearchAccess,
  query = search.input.query,
): SearchHit[] {
  const match = buildFtsQuery(query);
  if (!match) return [];
  const queryTerms = lexicalQueryTerms(query);
  const candidates: Array<{ row: MemoryRow; scope: Scope; lexical: number; coverage: number }> = [];
  for (const source of sources) {
    const filter = sqlFilter(search, "m");
    const rows = source.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 1.0, 0.7, 0.5, 0.5, 0.4) AS rank
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${filter.sql}
         ORDER BY rank`,
      )
      .all(match, ...filter.params) as Array<MemoryRow & { rank: number }>;
    for (const { rank, ...row } of rows) {
      const coverage = lexicalCoverage(queryTerms, row);
      if (queryTerms.length >= 4 && coverage < 0.25) continue;
      candidates.push({ row, scope: source.scope, lexical: Math.max(0, -rank), coverage });
    }
  }
  const maxLexical = Math.max(...candidates.map((candidate) => candidate.lexical), 0) || 1;
  const ranked = candidates
    .map(({ row, scope, lexical, coverage }) => ({
      ...access.toHit(row, scope),
      score: round(0.75 * (lexical / maxLexical) + 0.15 * coverage + 0.1 * row.importance),
    }))
    .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  return ranked;
}

export function mergeSearchCandidates(
  eligible: readonly SearchHit[],
  ftsHits: readonly SearchHit[],
  search: NormalizedSearch,
  options: { fill: boolean; usedTypo: boolean },
): { hits: SearchHit[]; candidates: SearchCandidate[]; channels: RetrievalChannel[] } {
  const ftsById = new Map(ftsHits.map((hit) => [hit.id, hit]));
  const totalLabelHints = search.hints.topics.length + search.hints.tags.length + search.hints.links.length;
  const signaled = eligible.flatMap((hit) => {
    const fts = ftsById.get(hit.id);
    const matchedLabels = matchingHintLabels(hit, search.hints);
    if (!fts && matchedLabels.length === 0) return [];
    const bucket = fts && matchedLabels.length > 0 ? 3 : matchedLabels.length > 0 ? 2 : 1;
    const signal = fts?.score ?? (totalLabelHints > 0 ? matchedLabels.length / totalLabelHints : 0);
    const categoryHintBoosted = search.hints.categories.includes(canonicalCategory(hit.category));
    const channels: RetrievalChannel[] = [];
    if (fts) channels.push("fts");
    if (matchedLabels.length > 0) channels.push("labels");
    if (fts && options.usedTypo) channels.push("typo");
    return [{
      hit: { ...hit, score: bucket + signal + (categoryHintBoosted ? 0.05 : 0) },
      channels,
      matchedLabels,
      categoryHintBoosted,
    }];
  });
  signaled.sort((left, right) => candidateOrder(left.hit, right.hit));

  const channels: RetrievalChannel[] = [];
  if (signaled.some((candidate) => candidate.channels.includes("fts"))) channels.push("fts");
  if (signaled.some((candidate) => candidate.channels.includes("labels"))) channels.push("labels");
  if (signaled.some((candidate) => candidate.channels.includes("typo"))) channels.push("typo");

  if (!options.fill || signaled.length >= MAX_JEV_CANDIDATES * MAX_JEV_BATCHES) {
    return { hits: signaled.map((candidate) => candidate.hit), candidates: signaled, channels };
  }

  const selected = [...signaled];
  const selectedIds = new Set(selected.map((candidate) => candidate.hit.id));
  const remaining = eligible
    .filter((hit) => !selectedIds.has(hit.id))
    .sort((a, b) =>
      compareScope(a, b) ||
      Number(search.hints.categories.includes(canonicalCategory(b.category))) -
        Number(search.hints.categories.includes(canonicalCategory(a.category))) ||
      b.importance - a.importance ||
      b.updated_at - a.updated_at ||
      a.id.localeCompare(b.id),
    );
  const fillCount = MAX_JEV_CANDIDATES * MAX_JEV_BATCHES - selected.length;
  for (const hit of remaining.slice(0, fillCount)) {
    selected.push({
      hit: { ...hit, score: hit.importance * 0.1 },
      channels: ["fill"],
      matchedLabels: [],
      categoryHintBoosted: search.hints.categories.includes(canonicalCategory(hit.category)),
    });
  }
  if (selected.length > signaled.length) channels.push("fill");
  return { hits: selected.map((candidate) => candidate.hit), candidates: selected, channels };
}

export function searchResult(
  normalized: NormalizedSearch,
  candidates: SearchHit[],
  eligibleCount: number,
  usedFts: boolean,
  applyBudget: boolean,
  maxTokens: number,
  retrieval: Omit<SearchResult["retrieval"], "candidate_count">,
): SearchResult {
  const sorted = sortHits(candidates, normalized.sort);
  const hits = applyBudget ? budgetHits(sorted, normalized.limit, maxTokens) : sorted;
  return {
    query: normalized.input.query,
    hits,
    total_tokens: hits.reduce((sum, hit) => sum + hit.tokens, 0),
    budget: { max_hits: normalized.limit, max_tokens: maxTokens },
    sort: normalized.sort,
    eligible_count: eligibleCount,
    used_fts: usedFts,
    retrieval: { ...retrieval, candidate_count: candidates.length },
  };
}

export function sortHits<T extends SearchHit>(hits: readonly T[], sort: Required<SearchSort>): T[] {
  const direction = sort.order === "asc" ? 1 : -1;
  const sorted = [...hits].sort((a, b) => {
    const av = sort.by === "relevance" ? a.score
      : sort.by === "updated" ? a.updated_at
      : sort.by === "created" ? a.created_at
      : a.importance;
    const bv = sort.by === "relevance" ? b.score
      : sort.by === "updated" ? b.updated_at
      : sort.by === "created" ? b.created_at
      : b.importance;
    return direction * (av - bv) || compareScope(a, b) || b.updated_at - a.updated_at || a.id.localeCompare(b.id);
  });
  return sort.by === "relevance" ? applySubjectPrecedence(sorted) : sorted;
}

export function budgetHits<T extends SearchHit>(hits: readonly T[], limit: number, maxTokens: number): T[] {
  const selected: T[] = [];
  let tokens = 0;
  for (const hit of hits) {
    if (selected.length >= limit) break;
    if (tokens + hit.tokens > maxTokens) continue;
    selected.push(hit);
    tokens += hit.tokens;
  }
  return selected;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function lexicalCoverage(queryTerms: readonly string[], row: MemoryRow): number {
  if (queryTerms.length === 0) return 1;
  const searchable = keywords(
    [row.content, row.subject, row.topics, row.tags, row.links].filter(Boolean).join(" "),
  );
  const available = new Set(searchable);
  const matched = queryTerms.filter((term) => available.has(term)).length;
  return matched / queryTerms.length;
}

export function matchingHintLabels(hit: SearchHit, hints: NormalizedSearch["hints"]): string[] {
  return [
    ...intersectionValues("topic", hit.topics, hints.topics),
    ...intersectionValues("tag", hit.tags, hints.tags),
    ...intersectionValues("link", hit.links, hints.links),
  ];
}

function intersectionValues(kind: string, values: readonly string[], hints: readonly string[]): string[] {
  if (values.length === 0 || hints.length === 0) return [];
  const available = new Set(values.map(normalizeLabel));
  return hints.filter((hint) => available.has(hint)).map((hint) => `${kind}:${hint}`);
}

function candidateOrder(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || compareScope(a, b) || b.importance - a.importance ||
    b.updated_at - a.updated_at || a.id.localeCompare(b.id);
}

function applySubjectPrecedence<T extends SearchHit>(hits: T[]): T[] {
  const indexesBySubject = new Map<string, number[]>();
  for (const [index, hit] of hits.entries()) {
    if (!hit.subject) continue;
    const subject = normalizeLabel(hit.subject);
    if (subject.length === 0) continue;
    const indexes = indexesBySubject.get(subject) ?? [];
    indexes.push(index);
    indexesBySubject.set(subject, indexes);
  }

  const ordered = [...hits];
  for (const indexes of indexesBySubject.values()) {
    if (indexes.length < 2) continue;
    const group = indexes
      .map((index) => hits[index]!)
      .sort((a, b) => compareScope(a, b) || b.updated_at - a.updated_at || b.score - a.score);
    indexes.forEach((index, groupIndex) => {
      ordered[index] = group[groupIndex]!;
    });
  }
  return ordered;
}

function compareScope(a: SearchHit, b: SearchHit): number {
  if (a.scope === b.scope) return 0;
  return a.scope === "project" ? -1 : 1;
}
