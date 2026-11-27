---
name: context-memory
description: How to use the context-eng memory tools (memory_search, memory_create, memory_edit, memory_map, promote, demote, delete). Use when starting a task where past decisions or mistakes may matter, when the user mentions memories, notes, staging, promote or demote, or when a memory tool returns an error you need to fix.
---

# Context memory

context-eng keeps short, one-sentence memories in a local notebook under `~/.context/`. Use the MCP tools only; never open the SQLite files or edit `map.md` by hand.

## The loop

```text
search → work → maybe create one memory
```

1. **Search** at the start of a task when past context could help. Pass the user's request as `query` and the absolute project root as `projectPath`.
2. **Work** with the hits as background. They are history: the user's current instructions win. Prefer project hits over global ones, and newer over older.
3. **Create** at most one memory if something lasting happened: a decision, constraint, mistake and its fix, workflow, or confirmed preference.

A search result that starts with `no matching memory` means nothing matched. Carry on without stored context.

## Which tool

| Tool | Use it when |
|------|-------------|
| `memory_search` | You need past context. |
| `memory_create` | You are saving one new lasting claim. |
| `memory_edit` | A memory is close but out of date. Needs `currentCategory` and `id`. |
| `memory_map` | You need ids, category names, counts, or the newest staging notes. |
| `memory_list_categories` | You need valid category names before a filtered search or a write. |
| `memory_promote` | A staging memory should become searchable. |
| `memory_demote` | A searchable memory should leave default search. |
| `memory_delete` | The user rejects a staging memory. |
| `memory_bind` | You switched repositories, or an id-based tool returned `PROJECT_NOT_BOUND`. |

## Search

- Omit `categories` to search everything. Pass 1–4 existing names to narrow.
- `filters.scope` is `both` (default), `project`, or `global`. `project` and `both` need a bound project or `projectPath`.
- Staging is hidden unless `filters.includeStaging` is `true`.
- `hints` (topics, tags, links, categories) only boost ranking; they never filter.

## Write

- **One sentence, one claim.** Two sentences are rejected (`NOT_ONE_SENTENCE`); over about 800 tokens is rejected (`TOO_LONG`).
- `scope` is `project` (this repository) or `global` (every repository).
- Built-in categories: `instruction`, `mistake`, `preference`, `decision`, `constraint`, `workflow`.
- These are searchable at once: `instruction`, `decision`, `constraint`, `mistake`.
- These start in staging and need `memory_promote`: `preference`, `workflow`, and every custom category.
- A new category name very close to an existing one returns `NEAR_CATEGORY`. Use the existing one, or retry with `confirmNewCategory: true`.

Do not save task recaps, temporary debugging notes, secrets, or facts the repository already records.

## Staging

```text
create ──► staging ──memory_promote──► searchable
              ▲                            │
              └───────memory_demote────────┘
staging ──memory_delete──► gone   (a searchable memory must be demoted first)
```

## Errors

Search returns plain text. Write tools return JSON; failures look like `{ "error": "<CODE>", "message": "..." }`.

| Code | Fix |
|------|-----|
| `PROJECT_NOT_BOUND` | Retry with `projectPath`, or call `memory_bind` for id-based tools. |
| `INVALID_CATEGORY` | Call `memory_list_categories` and use an existing name. |
| `NOT_ONE_SENTENCE` / `TOO_LONG` | Shorten to one sentence. |
| `NOT_FOUND` | Get the right id from `memory_map`. |
| `NOT_STAGING` | Call `memory_demote` before `memory_delete`. |

## Reference

Full tool contract, limits, and every error code: `references/rules.md` next to this skill (in the context-eng repository: `system_prompts/rules.md`).
