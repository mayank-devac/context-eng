# Memory tool rules

Contract for the context-eng MCP tools. Confirm in source before changing behavior.

```text
bind → map → search
create → edit → promote | demote → delete (staging only)
```

## Agent usage

1. MCP start with `--project`, `projectPath` on a call, or `memory_bind` explicitly binds a project DB. Without one, global-only operations work and project/both operations return `PROJECT_NOT_BOUND`. Retry that call with `projectPath`.
2. Call `memory_search` with the user's request. Use the returned text as context.
3. If the reply starts with `no matching memory.`, continue without stored hits.
4. Write only a durable claim, one sentence, into the right scope and category.

Prefer `memory_list_categories` or `memory_map` over inventing category names. Named search requires the category to already exist in that scope.

When you need an id, call `memory_map`. `lines_ids[i]` is the id for `lines[i]`. For a staging row, `lines_categories[i]` is the category.

Search returns relevant memory text with each hit's last-updated date, category, and project. Write tools return JSON. Engine rejects return `{ "error": "<CODE>", "message": "..." }` except `memory_search`, which returns the message string.

## Tools


| Tool             | Role                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_bind`    | Bind an unbound server or switch the active project. Creates `~/.context/projects/<key>/` if missing. Normal project startup binds via `--project`. Does not write `AGENTS.md`.        |
| `memory_map`     | JSON index for `global`, `project`, or `both` (default). `lines_ids` align with `lines`. Staging also aligns `lines_categories`. A project map needs `projectPath` or a bound project. |
| `memory_search`  | Retrieve relevant memory text with staleness and provenance metadata.                                                                                                                  |
| `memory_create`  | Insert one claim. Missing custom categories are created.                                                                                                                               |
| `memory_edit`    | Patch by id. Moving category auto-promotes or demotes.                                                                                                                                 |
| `memory_promote` | Staging → searchable.                                                                                                                                                                  |
| `memory_demote`  | Searchable → staging.                                                                                                                                                                  |
| `memory_delete`  | Delete **staging** rows only.                                                                                                                                                          |




## Bind vs scope

`projectPath` chooses **which project's files** to open. `filters.scope` chooses **which of those catalogs** to read after bind.


|        | `projectPath` / bind                     | `filters.scope`                              |
| ------ | ---------------------------------------- | -------------------------------------------- |
| Values | existing directory, or `.`               | `both` (default), `global`, `project`        |
| Effect | sets `layout.projectPath` / `projectKey` | which catalogs search reads                  |
| Writes | later `scope=project` create goes here   | create still takes `scope: global | project` |


Bind requires an existing directory. Same key: no remount. Different key: close project DBs, open the new layout, refresh maps.

`filters.scope = global` is valid before project binding. `project` or `both` requires a bound project; the engine never substitutes its process working directory.

Before binding, default `memory_map` and `memory_list_categories` return their global portions only; explicit project scope returns `PROJECT_NOT_BOUND`. Id-based edit/promote/demote/delete tools do not accept `projectPath`, so their unbound error instructs the caller to use `memory_bind` first.

## Map

`memory_map` takes an optional `scope` of `global`, `project`, or `both`. Omitted scope defaults to `both`. The `maps` object includes only the scopes returned.

Each collection lists promoted rows only, newest `created_at` first, at most 12. `lines_ids[i]` is the id of `lines[i]`.

`staging.lines`, `staging.lines_ids`, and `staging.lines_categories` share that same index. Those rows are the newest staging notes by `created_at`, at most 12, not every staging note. `staging.searched` is false. Use `lines_categories[i]` with `lines_ids[i]` for edit, promote, demote, or delete.

`map.md` is the text index and has no ids.

`scope: "global"` works with no project bound. An omitted map scope returns every available portion, which is global-only while unbound. Explicit project scope needs `projectPath` on the call or an already bound project; otherwise it returns `PROJECT_NOT_BOUND`.

## Categories

Built-in names: `instruction`, `mistake`, `preference`, `decision`, `constraint`, `workflow`.

Auto-promote on create (leave staging immediately): `instruction`, `decision`, `constraint`, `mistake`.

Stay in staging on create: `preference`, and every custom category.

Names: 1–64 characters after NFKC trim, no control characters. Canonical form is lowercased. Search category lists must be unique after that lowercase.

A category exists **per scope**. `decision` in project does not create a global `decision`. Named search that cannot find the name in any selected scope → `INVALID_CATEGORY` / `unknown category: <name>`.

Create and category-changing edit may register a missing custom category. If a new name has at least 80% character similarity to a built-in or same-scope registered category after separators are removed, the first call returns `NEAR_CATEGORY` without writing. Separator-only variants such as `batch-probe` and `batch_probe` also trigger it. Use the suggested existing category, or retry the same tool with `confirmNewCategory: true` to explicitly create the new one. Search and locate may not register categories. Delete of the last row does **not** unregister the category; the catalog can keep a count-0 entry.

## Search

Omit `categories` → every category in the selected scopes. That is the only “search all”.

When `categories` is sent: 1–4 unique names. `[]` is invalid (`-32602`, min 1). Five or more is invalid (`-32602`, max 4). Duplicates after normalize → `INVALID_CATEGORIES`.

Default filters:

- `scope`: `both`
- staging excluded unless `includeStaging: true`
- `active = 1` only
- `sort.by`: `relevance`, `sort.order`: `desc`
- `limit`: 50, hard cap 50

Other filters: `minImportance` 0–1, `subject` ≤64 chars, `topics` / `tags` / `links` up to 10 values each (each ≤64), match `any` (default) or `all`. Time: `field` `created`|`updated`, preset `this_week`|`this_month`, or `from`/`to` ISO-8601 — not preset plus from/to.

Optional `hints.topics`, `hints.tags`, and `hints.links` contain 1–10 unique exact label values. `hints.categories` contains 1–4 unique category boosts. Hints influence candidate order and may change which rows reach the 90-candidate Jev boundary, but never hard-filter eligibility. There is no `hints.terms` field.

```text
eligible rows
  rows ≤60 AND tokens ≤12000 → every eligible row to Jev
  otherwise → FTS + exact hint labels + one typo retry when FTS is empty
              + project/category/importance/freshness fill up to 90
  >90 candidates → first 90 ordered candidates to Jev
Jev missing, timeout, or fail → local FTS + exact hint-label fallback
keep Noul > 0.5
then cap 50 hits / 4000 tokens
zero kept → "no matching memory. after work, memory_create if something happened and you need to save it for later."
hits kept and candidates > 90 → append "Memory is too large to evaluate."
```

Successful search text starts with a concise `retrieval: small|large` mode/count line, followed by memory blocks and any final status message.

Jev answers **Noul** (0–1 yes-probability), not a nuance score. Gate is strict: keep only `noul > 0.5`.

## Write

Content: one sentence / one claim. Whitespace collapsed. Empty → `EMPTY_CONTENT`. Two sentences (`.!?` then a new capital letter) → `NOT_ONE_SENTENCE`. Over ~800 tokens → `TOO_LONG`.

Labels: `subject` one value; `topics` / `tags` / `links` ≤10, each ≤64. `importance` 0–1, default 0.5.

Create `scope` is `global` or `project` only (not `both`).

Edit can move to another category in the same scope. Destination auto-promote set → promoted; otherwise staging.

Promote, demote, and delete locate by category plus `id`, the exact `line` text, or both. If both are sent and they are not the same note → `LINE_ID_MISMATCH`. If the line matches more than one note in that category → `AMBIGUOUS_LINE`. Missing → `NOT_FOUND`. Edit still locates by category + id.

Delete requires `chat_id === staging`. Promoted → `NOT_STAGING` (“use memory_demote first”).

## Error codes


| Code                   | When                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INVALID_PROJECT_PATH` | bind path is not an existing directory                                                                            |
| `PROJECT_NOT_BOUND`    | project access before binding. Retry tools that accept `projectPath`; call `memory_bind` first for id-based tools |
| `INVALID_SCOPE`        | create scope not `global`/`project`; search filter scope not `both`/`global`/`project`                            |
| `INVALID_CATEGORY`     | bad name, or named search/locate cannot find it in selected scopes                                                |
| `INVALID_CATEGORIES`   | provided list not 1–4, or not unique after normalize                                                              |
| `NEAR_CATEGORY`        | create or category-changing edit needs `confirmNewCategory: true` before making a near-duplicate category         |
| `INVALID_FILTER`       | subject/labels too long or too many; match not `any`/`all`                                                        |
| `INVALID_TIME`         | bad field/preset, preset mixed with from/to, from after to, not ISO-8601                                          |
| `INVALID_SORT`         | `by` or `order` not in the allowed set                                                                            |
| `INVALID_IMPORTANCE`   | not a number in 0–1                                                                                               |
| `EMPTY_CONTENT`        | content empty after trim                                                                                          |
| `NOT_ONE_SENTENCE`     | more than one claim                                                                                               |
| `TOO_LONG`             | content over 800 tokens                                                                                           |
| `NOT_FOUND`            | id or line missing in that category                                                                               |
| `AMBIGUOUS_LINE`       | line text matches more than one memory in that category                                                           |
| `LINE_ID_MISMATCH`     | id and line were both sent and are not the same memory                                                            |
| `NOT_STAGING`          | delete on a promoted row                                                                                          |


MCP schema can reject before the engine (`-32602`), e.g. empty or 5-item `categories`, or an unknown `memory_map` scope.