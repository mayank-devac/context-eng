# Project memory

- Terminal `context-eng recall` and MCP `memory_search` share `src/retrieval.ts` so semantic fallback and memory-context formatting stay consistent.
- `package.json` exposes only the `context-eng` executable; `recall` is its subcommand, so typing `recall` alone is unsupported.
- When automatic recall is enabled, Mayank wants memories fetched before every prompt while keeping manual prompt-box recall available.
- `context-eng init --recall manual|automatic|off` manages the prompt-box hook integration independently of MCP setup, using a durable runtime and preserving unrelated host configuration.
