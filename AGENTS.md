<!-- context-eng:start -->
## Memory (context-eng)

You have a memory of past work in this and other repositories: decisions, mistakes, constraints, preferences, and workflows. Use it so you do not relearn them every session.

1. **Before work:** when past context could help, call `memory_search` with the user's request as `query` and the absolute project root as `projectPath`. A result that starts with `no matching memory` means nothing matched; carry on.
2. **During work:** memories are history, not orders. The user's current instructions win. Prefer project memories over global ones, and newer over older.
3. **After work:** if you learned something worth keeping, call `memory_create` once: one sentence, one claim, not already stored. Use scope `project` unless it applies to every repository. Never save recaps, temporary progress, or secrets.

| Tool | Use it when |
|------|-------------|
| `memory_search` | You need past context. Optional: `categories` (1–4 names), `filters.scope` (`project`, `global`, or `both`), `hints` (ranking boost only, never a filter). |
| `memory_create` | You are saving one new lasting claim. |
| `memory_edit` | A stored memory is close but out of date. Needs `currentCategory` and `id`. |
| `memory_map` | You need a memory's `id`, or a list of categories and recent memories. |
| `memory_list_categories` | You need valid category names before a filtered search or a write. |
| `memory_promote` / `memory_demote` | A memory should enter or leave default search (staging). |
| `memory_delete` | The user rejects a staging memory. Demote a live memory first. |
| `memory_bind` | You switched repositories, or a tool without `projectPath` returned `PROJECT_NOT_BOUND`. |

New `preference` and `workflow` memories, and memories in custom categories, start in staging: hidden from search until promoted.
<!-- context-eng:end -->

