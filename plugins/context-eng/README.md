# context-eng plugin

One plugin folder that gives Claude Code, Cursor, Codex, OpenCode, and Antigravity (`agy`) the context-eng memory: the MCP server, the always-on memory instructions, and the `recall`, `postsession`, and `context-memory` skills.

Use **either** this plugin **or** `context-eng init`'s MCP setup for a given app, not both. Both start a `context-eng` server, so with both you get every memory tool twice.

## What each app gets

| App | Manifest | MCP server | Always-on instructions | Skills / commands |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `.mcp.json` | `SessionStart` hook (`hooks/hooks.json`) | `/context-eng:recall`, `/context-eng:postsession`, `context-memory` |
| Codex | `.codex-plugin/plugin.json` | `mcp.json` | `SessionStart` hook (after you trust it in `/hooks`) | `$recall`, `$postsession`, `context-memory` |
| Cursor | `.cursor-plugin/plugin.json` | inline in the manifest (`npx -y context-eng@latest mcp`) | `rules/context-eng.mdc` (`alwaysApply`) | skills from `skills/` |
| Antigravity | `.antigravity-plugin/plugin.json` | `mcp_config.json` | `rules/AGENTS.md` | `/recall`, `/postsession`, `/context-memory` |
| OpenCode 2.x | `package.json` + `server.js` | added by `opencode/plugin.mjs` | added to each session's system prompt | `/context-eng:recall`, `/context-eng:postsession` |

Every host except Cursor starts the server through `scripts/mcp.mjs`. That launcher uses, in order: `$CONTEXT_ENG_ENTRY`, the global npm install (`npm install -g context-eng`), a `context-eng` command on `PATH`, and finally `npx -y context-eng@latest` run from the temp folder. Cursor does not expand plugin-root variables in MCP config, so it calls `npx` directly.

The TypeSafe semantic filter needs the key that `context-eng init` stores in your keychain. Without it, search falls back to local keyword search.

## Install

Claude Code:

```bash
claude plugin marketplace add mayank-devac/context-eng
```

```bash
claude plugin install context-eng@context-eng
```

Codex:

```bash
codex plugin marketplace add mayank-devac/context-eng
```

```bash
codex plugin add context-eng@context-eng
```

Then restart Codex and trust the plugin's `SessionStart` hook in `/hooks`.

Cursor: copy or clone this folder to `~/.cursor/plugins/local/context-eng/`, then run **Developer: Reload Window**.

Antigravity:

```bash
agy plugin install https://github.com/mayank-devac/context-eng
```

For a local checkout, run `agy plugin install ./plugins/context-eng` instead.

OpenCode 2.x: copy this folder (a real folder, not a symlink) to `~/.config/opencode/plugins/context-eng/` or `<project>/.opencode/plugins/context-eng/`. OpenCode loads it from `server.js`.

## Test from a checkout

```bash
claude --plugin-dir plugins/context-eng
```

```bash
npm run validate:plugins
```

`validate:plugins` checks every manifest, MCP config, hook, skill, rule, and marketplace entry, checks that every version matches `package.json`, and runs `claude plugin validate` and `agy plugin validate` when those commands are installed. Expect `agy plugin validate --strict` to warn about the files meant for other hosts (`.mcp.json`, `mcp.json`, `hooks/hooks.json`); the normal mode passes.

## Editing

The instructions, recall, postsession, and memory-contract text here are copies of files in `system_prompts/`. Edit any copy and commit: the pre-commit hook (`scripts/sync-prompts.mjs`) copies your change to every other copy. See the main README's "Prompt files" section.

## Publishing

To list the plugin in each host's official directory, follow the checklist in [PUBLISHING.md](../../PUBLISHING.md).
