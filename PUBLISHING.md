# Publishing the plugin

This repo is already a marketplace, so anyone can install the plugin with `claude plugin marketplace add mayank-devac/context-eng` (see [INSTALL.md](INSTALL.md)). To show up in each host's official directory, you submit to each host on its own. They all review submissions by hand.

## Before any submission

- [ ] `npm test`, `npm run typecheck`, `npm run typecheck:test`, `npm run lint`, and `npm run validate:plugins` all pass.
- [ ] The version matches in `package.json`, every `plugins/context-eng/*/plugin.json`, and every `marketplace.json`, and a git tag exists for it.
- [ ] The plugin has an icon: a square PNG, 512 to 2048 px per side, under 2 MB, at `plugins/context-eng/.claude-plugin/icon.png`. The Claude directory keeps the icon from your first save or submission, so add it before then. *(Missing right now.)*
- [x] Network hosts are declared under `network.hosts` in the Claude `plugin.json`: `api.typesafe.ai` (memory search relevance; search falls back to local search without it) and `registry.npmjs.org` (the `npx` fallback in `scripts/mcp.mjs`). Update the list if the code starts calling a new host.
- [ ] `plugins/context-eng/README.md` says what the plugin does, what it stores (a local SQLite memory), and how to uninstall it.
- [ ] `LICENSE` is present (MIT).

## Per host

| Host | Submit at | Requirements | Status |
|------|-----------|--------------|--------|
| Claude Code | [claude.ai/directory/manage](https://claude.com/docs/plugins/submit), then "Submit new" | A paid Claude plan. You submit a GitHub repo. The old Console form is retired. | Ready once the icon is added |
| Codex / ChatGPT | [OpenAI plugin submission portal](https://developers.openai.com/codex/submit-plugins) | A ZIP with `.codex-plugin/plugin.json` and no sibling files. A verified OpenAI org with plugin submission access. | **Blocked**, see below |
| Cursor | [cursor.com/marketplace/publish](https://cursor.com/docs/plugins) | `.cursor-plugin/plugin.json`, plus `.cursor-plugin/marketplace.json` at the repo root | Ready. Submit once: a second submission only makes a duplicate |
| Antigravity, OpenCode | No official directory found | — | Users install from this repo |

### Codex blockers

OpenAI's public directory rejects two things this plugin uses:

| Blocker | Status |
|---------|--------|
| **Lifecycle hooks** must be removed, and we ship `hooks/hooks.json` | ✅ Solved, see below |
| **A local MCP server.** The normal portal wants a remote HTTPS server, and ours runs `node scripts/mcp.mjs`. OpenAI sends plugins with a local server through a separate desktop-only path. | ❌ Open |

### Replacing the hook

The SessionStart hook only adds the memory rules (`rules/AGENTS.md`) and the project root to the session. A build without hooks gets the same rules three other ways:

```
                 ┌─ MCP `instructions`  → sent when the server connects (src/mcp.ts)
memory rules ────┼─ context-memory skill → loads when memory comes up
                 └─ ~/.codex/AGENTS.md   → written by `context-eng init`
```

- **MCP `instructions`:** the server sends the rules from `system_prompts/AGENTS.md` when a client connects. Hosts that pass server instructions to the model get them without a hook.
- **Project root:** without the hook, the server falls back to its working directory, and the agent can pass `projectPath` or call `memory_bind`.

| Build | Hooks | Where |
|-------|-------|-------|
| Codex directory | Removed: leave `hooks/` out of the ZIP | OpenAI portal |
| This repo's marketplace | Kept. Codex runs command hooks, and ours is one | `codex plugin marketplace add mayank-devac/context-eng` |

## After you are listed

- Bump the version everywhere and tag the release for every update.
- Users of this repo's marketplace get updates with `claude plugin marketplace update context-eng` or `codex plugin marketplace upgrade context-eng`.
- Each directory may need an update submitted again. Check that host's portal.
