# Repository map

- Purpose of this file:
  - Provide a quick guide to the repository's `src` directory.
  - Explain what each source file does, what it contains, and where it is used.
  - Help future work start at the smallest relevant file instead of scanning the whole project.

- Main source flow:
  - `src/cli-entry.ts` starts the command-line application; `src/cli.ts` implements its commands.
  - `src/mcp.ts` exposes the memory features as MCP tools.
  - `src/engine.ts` implements the memory operations used by both CLI and MCP.
  - `src/db.ts` stores memories in SQLite with FTS5 search indexes.
  - `src/map.ts` creates Markdown and JSON summaries from the databases.
  - `src/typesafe.ts` applies the external semantic relevance check to search results.

- `src/categories.ts`:
  - Use: Defines built-in category behavior, extensible category validation/normalization, storage scopes, staging, and search/filter limits.
  - Useful/used by: `engine.ts` for category routing and adaptive-search limits, `mcp.ts` for schemas, and `index.ts` for public exports.
  - Contains: Built-in `CATEGORIES`/`AUTO_PROMOTE`, canonical/display normalization, and hard limits for content, categories, Jev candidates/batches, filters, returned hits, and tokens.

- `src/cli.ts`:
  - Use: Implements `context-eng mcp`, `init`, `recall`, and the host-facing `hook` entry point without auto-running on import.
  - Useful/used by: `cli-entry.ts` calls `main`; init validates the project, writes agent pointers, selects clients, and invokes `harness.ts` to register their servers.
  - Contains: Argument parsing, usage validation, marked-block insertion/replacement, project initialization, global Codex and Claude pointers, client selection, conflict confirmation, an interactive recall/manual-saving wizard, terminal recall, manual/automatic/off recall setup, manual/off postsession setup with a deprecated on alias, and host/scope validation.

- `src/hooks.ts`:
  - Use: Retrieves context before Codex or Claude processes a submitted prompt.
  - Useful/used by: `cli.ts` dispatches `hook`; `hook-install.ts` shares host/mode types and the timeout.
  - Contains: Bounded stdin JSON parsing, explicit recall recognition, per-prompt automatic recall, lightweight read-only engine opening, short semantic deadlines with local fallback, exact model-visible context budgeting, bounded provenance-bearing context, and non-blocking error handling.

- `src/hook-install.ts`:
  - Use: Installs, updates, and removes the owned prompt-box skills and UserPromptSubmit handlers.
  - Useful/used by: `cli.ts` dispatches recall init; `postsession.ts` reuses the installation transaction; hook/installer tests use isolated homes and projects.
  - Contains: JSON-preserving command-hook merges for UserPromptSubmit/Stop, owned-file snapshots with reverse rollback and concurrent-edit conflict reporting, separate ownership markers, conflict checks, global/project layouts, safely quoted durable runtime commands, source-checkout loaders, and temporary-cache rejection.

- `src/postsession.ts`:
  - Use: Installs explicit-only postsession skills and migrates legacy automatic saving.
  - Useful/used by: `cli.ts` dispatches manual/off setup and the legacy no-op handler; `hook-install.ts` supplies shared transactions and configuration helpers.
  - Contains: Owned skill installation/removal with project binding, explicit-only host metadata, deliberate cleanup of legacy owned Stop handlers, and a non-blocking compatibility handler. Shared saving instructions ship in `system_prompts/postsession.md` and are rendered into host templates under `system_prompts/postsession/`.

- `src/cli-entry.ts`:
  - Use: Executable entry point for the package and npm scripts.
  - Useful/used by: `package.json` points the built binary at `dist/cli-entry.js`.
  - Contains: Shebang, unconditional `main` call, and process-level error reporting.

- `src/harness.ts`:
  - Use: Detects installed MCP clients and manages their user-level server registrations.
  - Useful/used by: `cli.ts` uses it after init selection, `hook-install.ts` reuses atomic configuration writing, and `test/harness.test.ts` covers config preservation and replacement.
  - Contains: Cursor, Claude, and Codex detection; npm/pnpm launch selection; JSON and TOML updates; atomic writes beside resolved config targets; preservation of identical or conflicting existing registrations; and install reporting.

- `src/db.ts`:
  - Use: Opens category databases and scope catalogs, maintaining structured-label indexes and synchronized FTS5 content.
  - Useful/used by: `engine.ts` registers categories, routes databases, migrates legacy rows, and maintains labels; `map.ts` reads open category databases.
  - Contains: Category/catalog schemas, memory and label tables, FTS5 triggers, WAL with a 5000 ms busy timeout, category registry/metadata helpers, timestamp normalization, and label replacement.

- `src/engine.ts`:
  - Use: Implements explicit project binding, category-routed memory operations, custom-category creation, legacy migration, structured filters, two-mode Jev candidate preparation, and local fallback.
  - Useful/used by: `cli.ts` owns the normal engine lifecycle, `hooks.ts` uses its lightweight retrieval opening, `mcp.ts` uses its Jev-preparation and local-search paths, and `index.ts` exports its public contracts.
  - Contains: An optional project layout guarded by one `PROJECT_NOT_BOUND` gate, a lightweight open mode that skips unchanged map rewrites while still refreshing after migrations and mutations, global-only aggregate behavior while unbound, scope catalogs/category connection management, staged legacy migration, cross-database moves, the 60-row/12,000-token mode switch, typo retry, FTS/label/fill merging, token budgets, project binding, and aggregated maps.

- `src/index.ts`:
  - Use: Acts as the package's public barrel file so consumers can import the main constants, types, `Engine`, and `EngineError` from one module.
  - Useful/used by: Library consumers importing the package API; it does not implement runtime behavior itself.
  - Contains: Re-exports from `categories.ts` and `engine.ts`, including category/scope types and engine input/result types.

- `src/map.ts`:
  - Use: Aggregates all category databases in one scope into category-discovery and staging maps with aligned memory IDs.
  - Useful/used by: `engine.ts` regenerates global/project maps after routed mutations, migration, and binding.
  - Contains: Per-category promoted/staging counts, metadata-weighted keywords, one-line summaries with aligned IDs, staging categories, bullet Markdown rendering, and atomic Markdown/JSON writes.

- `src/mcp.ts`:
  - Use: Exposes category-routed memory tools, optional search hints, retrieval diagnostics, and the batched Jev/local-fallback contract over MCP stdio.
  - Useful/used by: `cli.ts` starts it; MCP clients may narrow searches by category, while omitted categories search every available category; mutations still require routing categories.
  - Contains: Schemas for structured filters/metadata, project binding, MCP text/error responses using shared retrieval, missing-key detection, and server lifecycle handling.

- `src/retrieval.ts`:
  - Use: Shares memory retrieval and plain-text context rendering between MCP and terminal recall.
  - Useful/used by: `mcp.ts` and the `recall` command in `cli.ts`.
  - Contains: Semantic evaluation with local fallback, fallback diagnostics, retrieval counts, memory provenance, and empty-result messages.

- `src/search.ts`:
  - Use: Normalizes search inputs, resolves scope/category sources, applies hard filters, merges FTS5 and exact-label signals, and enforces result ordering and read budgets.
  - Useful/used by: `engine.ts` uses it for exhaustive-small and bounded-large candidate collection; `typesafe.ts` reuses its result sorting and budgeting through `engine.ts` exports.
  - Contains: Hint validation, Unicode-aware lexical coverage, label/category boosts, candidate deduplication/fill, project/newer precedence, retrieval metadata, and hit/token limits.

- `src/paths.ts`:
  - Use: Resolves safe global storage independently from an optional bound-project layout, plus catalog, category database, legacy recovery, and map paths.
  - Useful/used by: `engine.ts` opens global storage immediately and creates a project layout only after explicit startup/bind input; environment variables can override the home/project.
  - Contains: `GlobalLayout`, bound-project `Layout`, project resolution/keying, and slug-and-hash category filenames.

- `src/text.ts`:
  - Use: Normalizes searchable words and structured labels and safely creates FTS5 query expressions.
  - Useful/used by: `engine.ts` uses sentence detection, label normalization/serialization, and FTS query creation; `map.ts` uses keywords and labels for summaries.
  - Contains: Stopword filtering, keyword extraction, conservative Unicode Damerau-Levenshtein typo correction, one-sentence detection, label normalization, serialization, and quoted FTS5 query construction.

- `src/tokens.ts`:
  - Use: Provides a dependency-free approximate token count for enforcing memory size and search-read budgets.
  - Useful/used by: `engine.ts` uses `approxTokens` when validating content, returning memories, and accumulating search results.
  - Contains: The `approxTokens` character/word-based estimator.

- `src/typesafe.ts`:
  - Use: Sends plain content strings to Jev in 30-context batches, scores the first 90 ordered candidates, and applies the final result budget.
  - Useful/used by: `mcp.ts` checks evaluator availability and falls back locally on failure; tests can inject a custom evaluator.
  - Contains: API-key availability, 20-second request cancellation, a 90-candidate slice with a too-large message when hits survive, minimal Jev state, response validation, the strict `0.5` gate, explicit sorting, and 50-hit/4000-token budgeting.
