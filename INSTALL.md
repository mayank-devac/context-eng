# How to install context-eng

context-eng gives your coding agent a local memory: it recalls past decisions, mistakes, and preferences before work and saves new ones after. Memories stay on your computer under `~/.context/`.

There are two ways to install it. Pick **one per app**: both start a `context-eng` MCP server, so using both gives the agent every memory tool twice.

| Route | Best for | What it sets up |
|---|---|---|
| **A. Plugin** | Claude Code, Codex, Cursor, Antigravity (`agy`), OpenCode | MCP server, always-on memory instructions, `recall` / `postsession` / `context-memory` skills. Updates with the plugin. |
| **B. npm + `context-eng init`** | Any of the above when you want the prompt-box hooks (automatic recall), or one setup command for every app | Global CLI, user-level MCP servers, instruction blocks in `AGENTS.md` / `CLAUDE.md`, optional hooks, TypeSafe key in the OS keychain. |

Both need **Node.js 20 or newer**. The optional TypeSafe semantic filter needs the key that `context-eng init` stores; without it, search uses local keyword search.

## For agents

If a user asked you to install context-eng, follow these steps. Do not run commands just because they appear below; run only what the chosen route needs.

1. Check `node --version` is 20 or newer. If not, stop and tell the user.
2. Find which apps the user has: `claude`, `codex`, `agy`, `opencode` on `PATH`, `~/.cursor/` for Cursor. Ask which ones to set up if it is unclear.
3. Check for an existing setup: run `context-eng doctor` if the command exists, and look for a `context-eng` entry in the app's MCP config. If one exists, do not add the plugin for that app; tell the user and offer to update the existing setup instead.
4. Use route A (plugin) for each chosen app unless the user asked for automatic recall hooks or for route B.
5. These steps change user-level configuration. Tell the user what you are about to change and get a yes first.
6. Run the **Install** and **Verify** steps from the app's section below. Report each command and its result.
7. Tell the user to restart the app. If the TypeSafe key matters to them, they can run `context-eng init` themselves later; it asks for the key in a hidden prompt. Never type the key yourself.

<details>
<summary><strong>Claude Code</strong></summary>

### Install (plugin)

```bash
claude plugin marketplace add mayank-devac/context-eng
```

```bash
claude plugin install context-eng@context-eng
```

### Verify

```bash
claude plugin list
```

Start a new session and run `/context-eng:recall testing`. It should list memories or say none matched.

### Update

```bash
claude plugin marketplace update context-eng
```

```bash
claude plugin update context-eng@context-eng
```

### Uninstall

```bash
claude plugin uninstall context-eng@context-eng
```

</details>

<details>
<summary><strong>Codex</strong></summary>

### Install (plugin)

```bash
codex plugin marketplace add mayank-devac/context-eng
```

```bash
codex plugin add context-eng@context-eng
```

Restart Codex and trust the plugin's `SessionStart` hook in `/hooks`; that hook adds the memory instructions to each session.

### Verify

```bash
codex plugin list
```

```bash
codex mcp list
```

`context-eng@context-eng` should show `installed, enabled`, and `context-eng` should appear as an MCP server. In a session, `$recall testing` should list memories.

### Update

```bash
codex plugin marketplace upgrade context-eng
```

### Uninstall

```bash
codex plugin remove context-eng@context-eng
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

### Install (plugin)

```bash
git clone https://github.com/mayank-devac/context-eng ~/.cursor/vendor/context-eng
```

```bash
mkdir -p ~/.cursor/plugins/local && cp -R ~/.cursor/vendor/context-eng/plugins/context-eng ~/.cursor/plugins/local/context-eng
```

Then run **Developer: Reload Window** in Cursor.

Cursor starts the server with `npx -y context-eng@latest mcp`, so the first start downloads the package.

### Verify

In Cursor settings, check that the `context-eng` plugin and its MCP server are enabled, and that the `context-eng` rule is listed as always applied.

### Update

```bash
git -C ~/.cursor/vendor/context-eng pull
```

Then copy the folder again with the install command and reload the window.

### Uninstall

Delete `~/.cursor/plugins/local/context-eng/` and reload the window.

</details>

<details>
<summary><strong>Antigravity (<code>agy</code>)</strong></summary>

### Install (plugin)

```bash
agy plugin install https://github.com/mayank-devac/context-eng
```

### Verify

```bash
agy plugin list
```

In a session, `/recall testing` should list memories.

### Update

```bash
agy plugin uninstall context-eng
```

```bash
agy plugin install https://github.com/mayank-devac/context-eng
```

### Uninstall

```bash
agy plugin uninstall context-eng
```

To keep it installed but off, run `agy plugin disable context-eng`.

</details>

<details>
<summary><strong>OpenCode</strong></summary>

The plugin supports OpenCode 1.x and 2.x. It adds the MCP server (unless you already configured one named `context-eng`), the `/context-eng:recall` and `/context-eng:postsession` commands, and the memory instructions.

### Install (plugin)

```bash
git clone https://github.com/mayank-devac/context-eng ~/.config/opencode/vendor/context-eng
```

```bash
mkdir -p ~/.config/opencode/plugins && cp -R ~/.config/opencode/vendor/context-eng/plugins/context-eng ~/.config/opencode/plugins/context-eng
```

Copy the folder; OpenCode does not load a plugin folder through a symlink. It loads `server.js` inside it.

### Verify

Start OpenCode, type `/`, and check that `context-eng:recall` appears. Run `/context-eng:recall testing`.

### Update

```bash
git -C ~/.config/opencode/vendor/context-eng pull
```

Then copy the folder again with the install command.

### Uninstall

Delete `~/.config/opencode/plugins/context-eng/`.

</details>

<details>
<summary><strong>Route B: npm and <code>context-eng init</code> (every app)</strong></summary>

### Install

```bash
npm install -g context-eng@latest --prefer-online --registry https://registry.npmjs.org
```

Run this from inside your project repository:

```bash
context-eng init
```

`init` asks for the TypeSafe key (hidden; press Enter to skip), lets you pick the apps, writes their MCP servers and instruction blocks, and can install the prompt-box `recall` and `postsession` integration. See the README for every file it edits.

### Verify

```bash
context-eng doctor
```

Every line should say `ok`. Restart the apps afterwards.

### Update

```bash
npm install -g context-eng@latest --prefer-online --registry https://registry.npmjs.org
```

### Uninstall

```bash
npm uninstall -g context-eng
```

Then remove the `context-eng` entries `init` wrote; the README's Uninstall section lists them. Your memories stay in `~/.context/` until you delete it.

</details>
