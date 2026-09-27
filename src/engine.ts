import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  AUTO_PROMOTE,
  CATEGORIES,
  MAX_EXHAUSTIVE_SEARCH_ROWS,
  MAX_EXHAUSTIVE_SEARCH_TOKENS,
  MAX_READ_TOKENS,
  MAX_TOKENS,
  STAGING,
  NEAR_CATEGORY_SIMILARITY,
  categoryNameSimilarity,
  canonicalCategory,
  displayCategory,
  isCategory,
  isScope,
  type Category,
  type Scope,
} from "./categories.js";
import {
  categoryRecord,
  insertRow,
  listCategories,
  nowSeconds,
  openCatalog,
  openCategoryDb,
  registerCategory,
  replaceLabels,
  updateRow,
  type CategoryRecord,
  type Db,
  type MemoryRow,
} from "./db.js";
import { buildIndex, writeMapFiles, type CategoryDbSource, type MapIndex } from "./map.js";
import { migrateLegacy } from "./migrate.js";
import {
  categoryFileName,
  contextHome,
  globalLayoutFor,
  layoutFor,
  resolveProjectPath,
  type GlobalLayout,
  type Layout,
} from "./paths.js";
import {
  EngineError,
  budgetHits,
  mergeSearchCandidates,
  normalizeImportance,
  normalizeSearch,
  normalizeStoredLabels,
  normalizeSubject,
  readAllEligible,
  readFtsCandidates,
  searchResult,
  searchSources,
  sortHits,
  type SearchAccess,
  type SearchCandidate,
  type SearchDebugSnapshot,
  type SearchHit,
  type SearchInput,
  type SearchResult,
} from "./search.js";
import { correctTypoQuery, hasMultipleSentences, parseLabels, serializeLabels } from "./text.js";
import { approxTokens } from "./tokens.js";

export { EngineError, budgetHits, sortHits };
export type { EngineErrorCode, ListFilter, MatchMode, SearchFilters, SearchHints, SearchHit, SearchInput, SearchResult, SearchSort, TimeFilter } from "./search.js";

export interface Memory {
  id: string;
  scope: Scope;
  category: Category;
  content: string;
  subject?: string;
  topics: string[];
  tags: string[];
  links: string[];
  importance: number;
  staging: boolean;
  active: boolean;
  tokens: number;
  created_at: number;
  updated_at: number;
}

export interface CreateInput {
  scope: Scope;
  category: Category;
  confirmNewCategory?: boolean;
  content: string;
  subject?: string;
  topics?: string[];
  tags?: string[];
  links?: string[];
  importance?: number;
}

export interface CreateResult {
  memory: Memory;
  promoted: boolean;
  projectPath?: string;
  projectKey?: string;
}

export interface BindResult {
  projectPath: string;
  projectKey: string;
  created: boolean;
  maps: { global: string; project: string };
}

export interface CategoryListResult {
  global?: string[];
  project?: {
    projectPath: string;
    categories: string[];
  };
}

export interface MemoryMapResult {
  global: MapIndex;
  project?: MapIndex;
}

export interface EditInput {
  content?: string;
  category?: Category;
  confirmNewCategory?: boolean;
  subject?: string | null;
  topics?: string[];
  tags?: string[];
  links?: string[];
  importance?: number;
}

export interface EngineOptions {
  projectPath?: string;
  home?: string;
  deferProject?: boolean;
}

interface Located {
  db: Db;
  scope: Scope;
  row: MemoryRow;
  canonical: string;
}

interface ResolvedSearch {
  result: SearchResult;
  eligible: SearchHit[];
  candidates: SearchCandidate[];
  correctedQuery?: string;
}

export class Engine {
  private readonly globalLayout: GlobalLayout;
  private projectLayout: Layout | null = null;
  private readonly globalCatalog: Db;
  private projectCatalog: Db | null = null;
  private readonly categoryDbs = new Map<string, Db>();

  constructor(opts: EngineOptions = {}) {
    const home = opts.home ?? contextHome();
    this.globalLayout = globalLayoutFor(home);
    this.globalCatalog = openCatalog(this.globalLayout.globalCatalogDb);
    this.migrateScope("global");
    const bindAtStart = opts.projectPath !== undefined || !opts.deferProject;
    if (bindAtStart) {
      this.projectLayout = layoutFor(resolveProjectPath(opts.projectPath), home);
      this.openProject();
      this.refreshMaps();
    } else {
      this.refreshGlobalMap();
    }
  }

  get layout(): Layout {
    return this.requireProjectLayout("call memory_bind before reading the project layout");
  }

  get projectPath(): string | undefined {
    return this.projectLayout?.projectPath;
  }

  get globalMapPath(): string {
    return this.globalLayout.globalMapMd;
  }

  get projectMapPath(): string {
    return this.requireProjectLayout("project map path requires memory_bind or projectPath").projectMapMd;
  }

  close(): void {
    for (const db of this.categoryDbs.values()) db.close();
    this.categoryDbs.clear();
    this.projectCatalog?.close();
    this.globalCatalog.close();
  }

  bind(projectPath: string): BindResult {
    const resolved = resolveProjectPath(projectPath);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new EngineError("INVALID_PROJECT_PATH", `project path must be an existing directory: ${resolved}`);
    }
    const next = layoutFor(resolved, this.globalLayout.home);
    if (next.projectKey === this.projectLayout?.projectKey) {
      const created = !existsSync(next.projectCatalogDb);
      if (this.projectCatalog === null) this.openProject();
      return this.bindResult(created);
    }
    const created = !existsSync(next.projectCatalogDb);
    this.closeProject();
    this.projectLayout = next;
    this.openProject();
    this.refreshMaps();
    return this.bindResult(created);
  }

  create(input: CreateInput): CreateResult {
    if (!isScope(input.scope)) {
      throw new EngineError("INVALID_SCOPE", "scope must be one of: global, project");
    }
    const record = this.ensureCategory(input.scope, input.category, input.confirmNewCategory === true);
    const content = normalizeContent(input.content);
    const importance = normalizeImportance(input.importance ?? 0.5);
    const subject = normalizeSubject(input.subject);
    const topics = normalizeStoredLabels("topics", input.topics);
    const tags = normalizeStoredLabels("tags", input.tags);
    const links = normalizeStoredLabels("links", input.links);
    const promoted = AUTO_PROMOTE.has(record.canonical);
    const now = nowSeconds();
    const row: MemoryRow = {
      id: randomUUID(),
      project_id: input.scope === "global" ? "global" : this.requireProjectLayout().projectKey,
      chat_id: promoted ? null : STAGING,
      category: record.display_name,
      content,
      subject: subject || null,
      topics: serializeLabels(topics),
      tags: serializeLabels(tags),
      links: serializeLabels(links),
      importance,
      active: 1,
      created_at: now,
      updated_at: now,
    };
    const db = this.dbForRecord(input.scope, record);
    db.transaction(() => {
      insertRow(db, row);
      replaceLabels(db, row.id, { topics, tags, links });
    })();
    this.refreshAvailableMaps();
    return {
      memory: toMemory(row, input.scope),
      promoted,
      ...(this.projectLayout === null ? {} : {
        projectPath: this.projectLayout.projectPath,
        projectKey: this.projectLayout.projectKey,
      }),
    };
  }

  edit(currentCategory: Category, id: string, patch: EditInput): Memory {
    const located = this.locate(currentCategory, id);
    const destination = patch.category === undefined
      ? this.recordFor(located.scope, located.canonical)
      : this.ensureCategory(located.scope, patch.category, patch.confirmNewCategory === true);
    if (!destination) throw new EngineError("INVALID_CATEGORY", `unknown category: ${currentCategory}`);

    const next: MemoryRow = { ...located.row };
    if (patch.content !== undefined) next.content = normalizeContent(patch.content);
    if (patch.subject !== undefined) next.subject = normalizeSubject(patch.subject ?? undefined) || null;
    if (patch.topics !== undefined) next.topics = serializeLabels(normalizeStoredLabels("topics", patch.topics));
    if (patch.tags !== undefined) next.tags = serializeLabels(normalizeStoredLabels("tags", patch.tags));
    if (patch.links !== undefined) next.links = serializeLabels(normalizeStoredLabels("links", patch.links));
    if (patch.importance !== undefined) next.importance = normalizeImportance(patch.importance);
    next.category = destination.display_name;
    next.updated_at = nowSeconds();
    if (destination.canonical !== located.canonical) {
      next.chat_id = AUTO_PROMOTE.has(destination.canonical) ? null : STAGING;
      this.moveRow(located, destination, next);
    } else {
      located.db.transaction(() => {
        updateRow(located.db, next);
        replaceLabels(located.db, next.id, labelsFromRow(next));
      })();
    }
    this.refreshAvailableMaps();
    return toMemory(next, located.scope);
  }

  get(category: Category, id: string): Memory {
    const { scope, row } = this.locate(category, id);
    return toMemory(row, scope);
  }

  promote(category: Category, target: string | { id?: string; line?: string }): Memory {
    return this.setChatLocated(this.locateSelector(category, target), null);
  }

  demote(category: Category, target: string | { id?: string; line?: string }): Memory {
    return this.setChatLocated(this.locateSelector(category, target), STAGING);
  }

  delete(category: Category, target: string | { id?: string; line?: string }): { id: string; deleted: true } {
    const { db, row } = this.locateSelector(category, target);
    if (row.chat_id !== STAGING) {
      throw new EngineError("NOT_STAGING", `memory ${row.id} is promoted; use memory_demote first`);
    }
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
    this.refreshAvailableMaps();
    return { id: row.id, deleted: true };
  }

  /** Candidates for Jev: exhaustive for small notebooks, bounded signals plus fill for large notebooks. */
  prepareSearch(input: SearchInput): SearchResult {
    return this.runSearch(input, true);
  }

  /** Raw selection data for diagnostics; formatting and relevance decisions stay outside Engine. */
  prepareSearchDebug(input: SearchInput): SearchDebugSnapshot {
    const resolved = this.resolveSearch(input, true);
    return {
      result: resolved.result,
      eligible: resolved.eligible,
      candidates: resolved.candidates,
      ...(resolved.correctedQuery !== undefined ? { correctedQuery: resolved.correctedQuery } : {}),
    };
  }

  /** Complete local fallback: lexical and exact-label candidates plus final sorting and read budget. */
  search(input: SearchInput): SearchResult {
    return this.runSearch(input, false);
  }

  private runSearch(input: SearchInput, forJev: boolean): SearchResult {
    return this.resolveSearch(input, forJev).result;
  }

  private resolveSearch(input: SearchInput, forJev: boolean): ResolvedSearch {
    const normalized = normalizeSearch(input);
    const access = this.searchAccess();
    const sources = searchSources(normalized, access);
    const eligible = readAllEligible(sources, normalized, access);
    const eligibleTokens = eligible.reduce((sum, hit) => sum + hit.tokens, 0);
    const mode = eligible.length <= MAX_EXHAUSTIVE_SEARCH_ROWS &&
      eligibleTokens <= MAX_EXHAUSTIVE_SEARCH_TOKENS ? "small" : "large";

    if (forJev && mode === "small") {
      const result = searchResult(normalized, eligible, eligible.length, false, false, MAX_READ_TOKENS, {
        mode,
        eligible_tokens: eligibleTokens,
        channels: ["all"],
      });
      return {
        result,
        eligible,
        candidates: eligible.map((hit) => ({
          hit,
          channels: ["all"],
          matchedLabels: [],
          categoryHintBoosted: false,
        })),
      };
    }

    let ftsHits = readFtsCandidates(sources, normalized, access);
    let usedTypo = false;
    let correctedQuery: string | undefined;
    if (mode === "large" && ftsHits.length === 0) {
      const vocabulary = eligible.map((hit) =>
        [hit.content, hit.subject, ...hit.topics, ...hit.tags, ...hit.links].filter(Boolean).join(" "),
      );
      const correction = correctTypoQuery(normalized.input.query, vocabulary);
      if (correction !== null) {
        correctedQuery = correction;
        ftsHits = readFtsCandidates(sources, normalized, access, correctedQuery);
        usedTypo = ftsHits.length > 0;
      }
    }
    const selected = mergeSearchCandidates(eligible, ftsHits, normalized, {
      fill: mode === "large",
      usedTypo,
    });
    const result = searchResult(normalized, selected.hits, eligible.length, ftsHits.length > 0, !forJev, MAX_READ_TOKENS, {
      mode,
      eligible_tokens: eligibleTokens,
      channels: selected.channels,
    });
    return {
      result,
      eligible,
      candidates: selected.candidates,
      ...(correctedQuery !== undefined ? { correctedQuery } : {}),
    };
  }

  map(): MemoryMapResult;
  map(scope: "global"): { global: MapIndex };
  map(scope: "project"): { project: MapIndex };
  map(scope?: Scope): { global?: MapIndex; project?: MapIndex } {
    const result: { global?: MapIndex; project?: MapIndex } = {};
    if (scope === undefined || scope === "global") {
      result.global = buildIndex(this.mapSources("global"), "global");
    }
    if (scope === "project") {
      const layout = this.requireProjectLayout();
      result.project = buildIndex(this.mapSources("project"), "project", {
        projectKey: layout.projectKey,
        projectPath: layout.projectPath,
      });
    } else if (scope === undefined && this.projectLayout !== null) {
      result.project = buildIndex(this.mapSources("project"), "project", {
        projectKey: this.projectLayout.projectKey,
        projectPath: this.projectLayout.projectPath,
      });
    }
    return result;
  }

  listCategoryNames(scope?: Scope): CategoryListResult {
    const result: CategoryListResult = {};
    if (scope === undefined || scope === "global") {
      result.global = listCategories(this.catalogFor("global")).map((record) => record.display_name);
    }
    if (scope === "project") {
      const layout = this.requireProjectLayout();
      result.project = {
        projectPath: layout.projectPath,
        categories: listCategories(this.catalogFor("project")).map((record) => record.display_name),
      };
    } else if (scope === undefined && this.projectLayout !== null) {
      result.project = {
        projectPath: this.projectLayout.projectPath,
        categories: listCategories(this.catalogFor("project")).map((record) => record.display_name),
      };
    }
    return result;
  }

  refreshMaps(): { global: MapIndex; project: MapIndex } {
    const layout = this.requireProjectLayout();
    const global = buildIndex(this.mapSources("global"), "global");
    const project = buildIndex(this.mapSources("project"), "project", {
      projectKey: layout.projectKey,
      projectPath: layout.projectPath,
    });
    writeMapFiles(global, this.globalLayout.globalMapMd, this.globalLayout.globalMapJson);
    writeMapFiles(project, layout.projectMapMd, layout.projectMapJson);
    return { global, project };
  }

  listStaging(scope: Scope, category?: Category): Memory[] {
    const records = category === undefined
      ? listCategories(this.catalogFor(scope))
      : [this.requireRecord(scope, category)];
    return records.flatMap((record) => {
      const rows = this.dbForRecord(scope, record)
        .prepare(`SELECT * FROM memories WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC`)
        .all(STAGING) as MemoryRow[];
      return rows.map((row) => toMemory(row, scope));
    });
  }

  categoryDatabasePath(scope: Scope, category: Category): string {
    const record = this.requireRecord(scope, category);
    return path.join(this.categoriesDir(scope), record.db_file);
  }

  private searchAccess(): SearchAccess {
    return {
      catalogFor: (scope) => this.catalogFor(scope),
      dbForRecord: (scope, record) => this.dbForRecord(scope, record),
      recordFor: (scope, category) => this.recordFor(scope, category),
      toHit: (row, scope) => ({ ...toMemory(row, scope), score: 0 }),
    };
  }

  private mapSources(scope: Scope): CategoryDbSource[] {
    return listCategories(this.catalogFor(scope)).map((record) => ({
      category: record.display_name,
      db: this.dbForRecord(scope, record),
    }));
  }

  private refreshGlobalMap(): MapIndex {
    const index = buildIndex(this.mapSources("global"), "global");
    writeMapFiles(index, this.globalLayout.globalMapMd, this.globalLayout.globalMapJson);
    return index;
  }

  private refreshAvailableMaps(): void {
    if (this.projectLayout !== null) this.refreshMaps();
    else this.refreshGlobalMap();
  }

  private openProject(): void {
    const layout = this.requireProjectLayout();
    this.projectCatalog = openCatalog(layout.projectCatalogDb);
    this.migrateScope("project");
  }

  private closeProject(): void {
    for (const [key, db] of this.categoryDbs) {
      if (key.startsWith("project:")) {
        db.close();
        this.categoryDbs.delete(key);
      }
    }
    this.projectCatalog?.close();
    this.projectCatalog = null;
    this.projectLayout = null;
  }

  private catalogFor(scope: Scope): Db {
    if (scope === "global") return this.globalCatalog;
    this.requireProjectLayout();
    if (this.projectCatalog === null) {
      throw new EngineError("PROJECT_NOT_BOUND", "call memory_bind before using project memory");
    }
    return this.projectCatalog as Db;
  }

  private categoriesDir(scope: Scope): string {
    return scope === "global" ? this.globalLayout.globalCategoriesDir : this.requireProjectLayout().projectCategoriesDir;
  }

  private recordFor(scope: Scope, category: Category): CategoryRecord | undefined {
    if (!isCategory(category)) return undefined;
    return categoryRecord(this.catalogFor(scope), canonicalCategory(category));
  }

  private requireRecord(scope: Scope, category: Category): CategoryRecord {
    if (!isCategory(category)) throw new EngineError("INVALID_CATEGORY", "category must be 1 to 64 characters");
    const record = this.recordFor(scope, category);
    if (!record) throw new EngineError("INVALID_CATEGORY", `unknown category: ${displayCategory(category)}`);
    return record;
  }

  private ensureCategory(scope: Scope, category: Category, confirmNewCategory = false): CategoryRecord {
    if (!isCategory(category)) throw new EngineError("INVALID_CATEGORY", "category must be 1 to 64 characters");
    const canonical = canonicalCategory(category);
    const catalog = this.catalogFor(scope);
    const existing = categoryRecord(catalog, canonical);
    if (existing) return existing;
    if (!confirmNewCategory) {
      const requested = displayCategory(category);
      const candidates = [
        ...CATEGORIES,
        ...listCategories(catalog).map((record) => record.display_name),
      ].filter((candidate, index, all) => all.indexOf(candidate) === index);
      const near = candidates
        .map((candidate) => ({ candidate, similarity: categoryNameSimilarity(requested, candidate) }))
        .filter(({ candidate, similarity }) => (
          similarity >= NEAR_CATEGORY_SIMILARITY && canonicalCategory(candidate) !== canonical
        ))
        .sort((left, right) => right.similarity - left.similarity || left.candidate.localeCompare(right.candidate))[0];
      if (near) {
        throw new EngineError(
          "NEAR_CATEGORY",
          `"${requested}" is too close to existing category "${near.candidate}". Use category "${near.candidate}". No memory was written.`,
          { requested, existing: near.candidate },
        );
      }
    }
    const record: CategoryRecord = {
      canonical,
      display_name: displayCategory(category),
      db_file: categoryFileName(canonical),
      created_at: nowSeconds(),
    };
    const db = openCategoryDb(path.join(this.categoriesDir(scope), record.db_file));
    db.close();
    return registerCategory(catalog, record);
  }

  private dbForRecord(scope: Scope, record: CategoryRecord): Db {
    const key = this.dbCacheKey(scope, record.canonical);
    const cached = this.categoryDbs.get(key);
    if (cached) return cached;
    const db = openCategoryDb(path.join(this.categoriesDir(scope), record.db_file));
    this.categoryDbs.set(key, db);
    return db;
  }

  private dbCacheKey(scope: Scope, canonical: string): string {
    return `${scope}:${scope === "project" ? this.requireProjectLayout().projectKey : "global"}:${canonical}`;
  }

  private locate(category: Category, id: string): Located {
    if (!isCategory(category)) throw new EngineError("INVALID_CATEGORY", "category must be 1 to 64 characters");
    this.requireProjectLayout("call memory_bind before using id-based memory tools");
    const canonical = canonicalCategory(category);
    let known = false;
    for (const scope of ["project", "global"] as const) {
      const record = this.recordFor(scope, canonical);
      if (!record) continue;
      known = true;
      const db = this.dbForRecord(scope, record);
      const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
      if (row) return { db, scope, row, canonical };
    }
    if (!known) throw new EngineError("INVALID_CATEGORY", `unknown category: ${displayCategory(category)}`);
    throw new EngineError("NOT_FOUND", `memory ${id} not found in category ${displayCategory(category)}`);
  }

  private locateSelector(category: Category, target: string | { id?: string; line?: string }): Located {
    const selector = typeof target === "string" ? { id: target } : target;
    const id = selector.id?.trim() ?? "";
    const line = selector.line?.trim() ?? "";
    if (id === "" && line === "") {
      throw new EngineError("INVALID_FILTER", "pass id or line");
    }
    const byId = id === "" ? undefined : this.locate(category, id);
    const byLine = line === "" ? [] : this.locateByLine(category, line);
    if (byLine.length > 1) {
      throw new EngineError(
        "AMBIGUOUS_LINE",
        `line matches ${byLine.length} memories in category ${displayCategory(category)}; pass id`,
      );
    }
    const lineMatch = byLine[0];
    if (byId && lineMatch && byId.row.id !== lineMatch.row.id) {
      throw new EngineError("LINE_ID_MISMATCH", `line does not match id ${byId.row.id}`);
    }
    if (byId && line !== "" && !lineMatch) {
      throw new EngineError("LINE_ID_MISMATCH", `line does not match id ${byId.row.id}`);
    }
    const located = byId ?? lineMatch;
    if (!located) throw new EngineError("NOT_FOUND", `memory not found in category ${displayCategory(category)}`);
    return located;
  }

  private locateByLine(category: Category, line: string): Located[] {
    this.requireProjectLayout("call memory_bind before using id-based memory tools");
    if (!isCategory(category)) throw new EngineError("INVALID_CATEGORY", "category must be 1 to 64 characters");
    const canonical = canonicalCategory(category);
    const found: Located[] = [];
    let known = false;
    for (const scope of ["project", "global"] as const) {
      const record = this.recordFor(scope, canonical);
      if (!record) continue;
      known = true;
      const db = this.dbForRecord(scope, record);
      const rows = db.prepare(`SELECT * FROM memories WHERE content = ?`).all(line) as MemoryRow[];
      for (const row of rows) found.push({ db, scope, row, canonical });
    }
    if (!known) throw new EngineError("INVALID_CATEGORY", `unknown category: ${displayCategory(category)}`);
    return found;
  }

  private setChatLocated(located: Located, chatId: string | null): Memory {
    const { db, scope, row } = located;
    const updated = nowSeconds();
    db.prepare(`UPDATE memories SET chat_id = ?, updated_at = ? WHERE id = ?`).run(chatId, updated, row.id);
    this.refreshAvailableMaps();
    return toMemory({ ...row, chat_id: chatId, updated_at: updated }, scope);
  }

  private moveRow(located: Located, destination: CategoryRecord, next: MemoryRow): void {
    const destinationPath = path.join(this.categoriesDir(located.scope), destination.db_file);
    const destinationDb = this.dbForRecord(located.scope, destination);
    destinationDb.close();
    this.categoryDbs.delete(this.dbCacheKey(located.scope, destination.canonical));
    located.db.prepare(`ATTACH DATABASE ? AS destination`).run(destinationPath);
    try {
      located.db.exec("BEGIN IMMEDIATE");
      located.db
        .prepare(
          `INSERT INTO destination.memories
           (id, project_id, chat_id, category, content, subject, topics, tags, links,
            importance, active, created_at, updated_at)
           VALUES (@id, @project_id, @chat_id, @category, @content, @subject, @topics, @tags, @links,
                   @importance, @active, @created_at, @updated_at)`,
        )
        .run(next);
      const insertLabel = located.db.prepare(
        `INSERT INTO destination.memory_labels (memory_id, kind, value) VALUES (?, ?, ?)`,
      );
      const labels = labelsFromRow(next);
      for (const value of labels.topics) insertLabel.run(next.id, "topic", value);
      for (const value of labels.tags) insertLabel.run(next.id, "tag", value);
      for (const value of labels.links) insertLabel.run(next.id, "link", value);
      const deleted = located.db.prepare(`DELETE FROM main.memories WHERE id = ?`).run(next.id);
      if (deleted.changes !== 1) throw new Error(`source memory ${next.id} disappeared during move`);
      located.db.exec("COMMIT");
    } catch (error) {
      if (located.db.inTransaction) located.db.exec("ROLLBACK");
      throw error;
    } finally {
      located.db.exec("DETACH DATABASE destination");
    }
  }

  private migrateScope(scope: Scope): void {
    const catalog = scope === "global" ? this.globalCatalog : this.projectCatalog;
    if (!catalog) throw new EngineError("PROJECT_NOT_BOUND", "call memory_bind before using project memory");
    migrateLegacy({
      catalog,
      categoriesDir: this.categoriesDir(scope),
      legacyFile: scope === "global" ? this.globalLayout.globalDb : this.requireProjectLayout().projectDb,
    });
  }

  private bindResult(created: boolean): BindResult {
    const layout = this.requireProjectLayout();
    return {
      projectPath: layout.projectPath,
      projectKey: layout.projectKey,
      created,
      maps: { global: this.globalLayout.globalMapMd, project: layout.projectMapMd },
    };
  }

  private requireProjectLayout(message = "pass projectPath or call memory_bind before using project memory"): Layout {
    if (this.projectLayout === null) throw new EngineError("PROJECT_NOT_BOUND", message);
    return this.projectLayout;
  }
}

function normalizeContent(raw: string): string {
  const content = (raw ?? "").replace(/\s+/g, " ").trim();
  if (content.length === 0) throw new EngineError("EMPTY_CONTENT", "content is empty");
  if (hasMultipleSentences(content)) {
    throw new EngineError("NOT_ONE_SENTENCE", "content must be one sentence / one claim");
  }
  const tokens = approxTokens(content);
  if (tokens > MAX_TOKENS) {
    throw new EngineError("TOO_LONG", `content is ~${tokens} tokens; hard cap is ${MAX_TOKENS}`);
  }
  return content;
}

function labelsFromRow(row: MemoryRow): { topics: string[]; tags: string[]; links: string[] } {
  return { topics: parseLabels(row.topics), tags: parseLabels(row.tags), links: parseLabels(row.links) };
}

function toMemory(row: MemoryRow, scope: Scope): Memory {
  const memory: Memory = {
    id: row.id,
    scope,
    category: row.category,
    content: row.content,
    topics: parseLabels(row.topics),
    tags: parseLabels(row.tags),
    links: parseLabels(row.links),
    importance: row.importance,
    staging: row.chat_id === STAGING,
    active: row.active === 1,
    tokens: approxTokens(row.content),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.subject) memory.subject = row.subject;
  return memory;
}
