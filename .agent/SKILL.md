---
name: context-memory
description: Uses context-eng MCP memory tools to search, save, and manage local project notes in ~/.context/. Use when starting tasks in a context-eng project, when the user mentions memories, notes, staging, promote/demote, or when AGENTS.md/CLAUDE.md reference memory_search.
---

# Context memory

Local notebook at `~/.context/`. Agents use MCP tools only — never read SQLite files.

## Task loop

```
search → work → maybe create
```

1. Project DB is already open from MCP `--project` or `projectPath` on a call; **bind** only after switching repos.
2. **Search** with the user's request at task start.
3. **Work** using returned notes as context (0–50 hits, ~4000 tokens total).
4. **Create** at most one note if something durable changed.

Skip search hits when the tool says `no matching memory.`

## When to use each tool

| Tool | Verb | Use when |
|------|------|----------|
| `memory_bind` | attach | User switched repos mid-session (engine already created the DB) |
| `memory_map` | index | Need category names, counts, staging, or `map.md` paths |
| `memory_search` | retrieve | Every task start; pass the user's request as `query` |
| `memory_create` | save | A decision, constraint, mistake, preference, or workflow worth keeping |
| `memory_edit` | patch | Correct text, labels, or category of an existing note |
| `memory_promote` | graduate | User confirms a staging note should be searchable |
| `memory_demote` | waitlist | Hide a searchable note from default search |
| `memory_delete` | discard | Remove a staging note the user rejects |

**Do not write** task recaps, transient debugging, or facts already in the repo.

## Search

- Omit `categories` to search all; pass 1–4 names to narrow.
- Default `filters.scope`: `both` (global habits + this project).
- Staging is excluded unless `includeStaging: true`.
- Prefer project hits over global; prefer newer over older.

## Write

- **One sentence, one claim.** Hard cap 800 tokens; aim much shorter.
- `scope`: `global` (cross-project habits) or `project` (this repo).
- Built-in categories: `instruction`, `mistake`, `preference`, `decision`, `constraint`, `workflow`.
- **Auto-promote** on create: `instruction`, `decision`, `constraint`, `mistake`.
- **Stay in staging** on create: `preference`, `workflow`, custom categories.

## Staging lifecycle

```text
create → staging
  auto-promote (decision/constraint/mistake/instruction) → searchable
  memory_promote (user) → searchable
  memory_delete → gone
memory_demote → back to staging
```

Promoted rows cannot be deleted; demote first.

## Errors

Search returns plain text. Write tools return JSON. On failure: `{ "error": "<CODE>", "message": "..." }`.

Common codes: `EMPTY_CONTENT`, `NOT_ONE_SENTENCE`, `TOO_LONG`, `INVALID_CATEGORY`, `NOT_FOUND`, `NOT_STAGING`.

## Reference

Full tool contract: [system_prompts/rules.md](../../system_prompts/rules.md)
