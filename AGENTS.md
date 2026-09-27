<!-- context-eng:start -->
Memory keeps mistakes, decisions, preferences and habits so you do not relearn them every chat. Search when that past could help this task. `memory_search` retrieves it. Narrow with `categories` and `filters.scope`. Optional `hints` (topics, tags, links, categories) boost ranking. Search returns promoted memory. Staging stays hidden unless `includeStaging: true`. New writes may wait in staging until `memory_promote`. If search returns `no matching memory` nothing matched. Continue without writing. `memory_create` after work, for one new claim that is not already stored. `memory_edit` when a hit is close but stale. `memory_list_categories` when you need names. Prefer this project over global. Prefer newer hits; an older one can be stale depending on when it was updated. Full contract: `system_prompts/rules.md`.
| Tool | One word | When |
|------|----------|------|
| `memory_search` | retrieve | Past memory for this task. `query`, optional `categories` and `hints` (boost only). `project` or `both` needs `projectPath`, `--project`, or `memory_bind`; else `PROJECT_NOT_BOUND`, then retry with `projectPath`. `global` needs none. |
| `memory_create` | save | Memory worth keeping. One sentence, one claim |
| `memory_edit` | patch | Memory is close but stale. Sharpen `content`, labels, or category. `currentCategory` and `id` |
| `memory_bind` | attach | Project memory is unbound, or you switched repos and the binding is wrong |
| `memory_list_categories` | inspect | You need category names before a named search or write |
| `memory_map` | index | it contains list of categories and all memory lines and use when you have the text but not the id . |
| `memory_promote` | graduate | A staging memory proved useful and should be searchable. `category` and `id` |
| `memory_demote` | waitlist | A searchable memory should leave default search |
| `memory_delete` | discard | User rejects a staging memory. Demote first if it is already live |
<!-- context-eng:end -->
