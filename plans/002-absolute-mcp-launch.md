# Plan 002: Write an absolute `node` + entry path into MCP configs instead of `npx`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8cbd312..HEAD -- src/harness.ts src/hook-install.ts test/harness.test.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes what `context-eng init` writes into users' Claude/Codex/Cursor config)
- **Depends on**: none (plan 001 is independent; do both)
- **Category**: bug
- **Planned at**: commit `8cbd312`, 2026-11-24

## Why this matters

`context-eng init` writes `npx -y context-eng mcp` into `~/.claude.json`, `~/.codex/config.toml` and `~/.cursor/mcp.json`.
Those are global configs, so the host runs that command in **whatever folder the session is in**.
Inside this repo, `package.json` is also named `context-eng`, so `npx` uses the local project. It links it through a cache entry under `~/.npm/_npx/` that can be stale.
On 2026-11-24 that stale link pointed at a file without a shebang. The result was a self-copying loop of about 3,000 processes that survived quitting Claude.
Even without that bug, `npx` adds a network or cache lookup to every MCP start, and it picks different code depending on the folder.
The hook installer already avoids all of this. It writes an absolute `node` path plus an absolute `cli-entry.js` path and refuses temporary npx caches. MCP launch should do the same.

## Current state

- `src/harness.ts:52-57` — how the MCP command is chosen today:
  ```ts
  export function mcpLaunch(hasCommand: (name: string) => boolean): McpLaunch {
    if (hasCommand("pnpm") && !hasCommand("npx")) {
      return { command: "pnpm", args: ["dlx", PACKAGE_NAME, "mcp"] };
    }
    return { command: "npx", args: ["-y", PACKAGE_NAME, "mcp"] };
  }
  ```
- `src/harness.ts:256` — `installDetectedHarnesses` calls `const launch = mcpLaunch(input.hasCommand);` and passes `launch` to `writeHarness` / `writeCodex`, which write `command` + `args`. They already ask `confirmReplace` when an existing entry differs, so old `npx` entries will be offered for replacement automatically.
- `src/hook-install.ts:113-136` — the pattern to reuse:
  ```ts
  export function currentHookRuntime(): HookRuntime {
    const source = import.meta.url.endsWith(".ts");
    return {
      nodePath: process.execPath,
      entryPath: fileURLToPath(new URL(source ? "./cli-entry.ts" : "./cli-entry.js", import.meta.url)),
      ...(source ? { loader: import.meta.resolve("tsx") } : {}),
    };
  }

  export function validateHookRuntime(runtime: HookRuntime): void {
    if (process.platform === "win32") throw new Error("Hook installation currently supports macOS and Linux");
    if ([runtime.entryPath, runtime.nodePath, runtime.loader ?? ""].some((value) => /[/\\](?:_npx|dlx)[/\\]/.test(value))) {
      throw new Error("The current runtime is in a temporary package cache. Install context-eng globally, then rerun hook setup.");
    }
    ...
  }
  ```
- `test/harness.test.ts:30-44` — existing `mcpLaunch` tests expect the npx / pnpm output; they will change.
- Known-good shape (what the user's machine now has, set by hand on 2026-11-24):
  ```json
  "context-eng": { "type": "stdio", "command": "<abs>/bin/node", "args": ["<abs>/lib/node_modules/context-eng/dist/cli-entry.js", "mcp"] }
  ```

## Commands you will need

| Purpose   | Command                                 | Expected |
|-----------|-----------------------------------------|----------|
| Typecheck | `npm run typecheck`                     | exit 0   |
| Tests     | `npx vitest run test/harness.test.ts`   | all pass |
| All tests | `npm test`                              | all pass |
| Lint      | `npm run lint`                          | exit 0   |

**Never** run `npx context-eng ...` or `context-eng init` against your real home folder while testing. Tests must use the temp `home` helper already in `test/harness.test.ts`.

## Scope

**In scope**:
- `src/harness.ts` (`mcpLaunch`, `installDetectedHarnesses`)
- `test/harness.test.ts`
- `README.md` (the section that documents what `init` writes, if one exists)

**Out of scope**:
- `src/hook-install.ts` — reuse its exported helpers; do not change them.
- Windows support — keep the existing npx path for `win32`.
- Editing any real user config file.

## Git workflow

- Branch: `advisor/002-absolute-mcp-launch`
- Commits per step; subjects in the repo's short imperative style.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Make `mcpLaunch` prefer the durable runtime

Change `mcpLaunch` to accept an optional runtime: `mcpLaunch(hasCommand, runtime = currentHookRuntime())`.
- On macOS/Linux, if the runtime passes `validateHookRuntime` and has no `loader`, return
  `{ command: runtime.nodePath, args: [runtime.entryPath, "mcp"] }`.
- Otherwise (temporary cache, tsx loader, Windows, or validation throws), fall back to the current npx/pnpm behavior.
- Import `currentHookRuntime` and `validateHookRuntime` from `./hook-install.js`. Check for an import cycle first (`grep -n "harness" src/hook-install.ts`). If one exists, STOP.

**Verify**: `npm run typecheck` → exit 0

### Step 2: Update and add tests

In `test/harness.test.ts` `describe("mcpLaunch")`:
1. Durable runtime (create a temp `node` file and a temp `cli-entry.js` file in a temp dir) → returns `{ command: <node>, args: [<entry>, "mcp"] }`.
2. Runtime whose `entryPath` contains `/_npx/` → falls back to `npx -y context-eng mcp`.
3. Keep the existing pnpm-fallback test, passing a cache-path runtime so it reaches the fallback.
4. In the `installDetectedHarnesses` tests, assert that a Claude entry with `"command": "npx"` already present triggers `confirmReplace` and, when it returns `true`, is replaced with the absolute launch.

**Verify**: `npx vitest run test/harness.test.ts` → all pass, including the new ones.

### Step 3: Print a warning on fallback

When `init` falls back to npx, print one line:
`warning: using npx to start context-eng; install it globally (npm i -g context-eng) and rerun init for a stable launch.`
Put it wherever `formatHarnessReport` output is built, matching how other warnings print there.

**Verify**: `npm test` → all pass; `npm run lint` → exit 0

### Step 4: Document it

In `README.md`, where `init` or MCP setup is described, say that `init` writes absolute paths and that `npx` is only a fallback. Explain why: npx inside a folder whose `package.json` has the same name runs that folder's code.

**Verify**: `grep -n "npx" README.md` → each mention is described as a fallback.

## Test plan

Covered by Step 2: durable runtime, cache runtime fallback, pnpm fallback, and migrating an existing npx entry through `confirmReplace`. Follow the temp-home pattern at the top of `test/harness.test.ts` (`tempHome()` + `afterEach` cleanup).

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm test` exit 0
- [ ] `grep -n '"-y", PACKAGE_NAME' src/harness.ts` appears only inside the fallback branch
- [ ] New tests from Step 2 exist and pass
- [ ] `git status` shows only in-scope files and `plans/README.md` changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- Importing from `hook-install.ts` into `harness.ts` creates a circular import.
- `writeCodex` / `writeHarness` no longer call `confirmReplace` for differing entries. Silently overwriting user config is not acceptable.
- Any test would read or write the real `~/.claude.json`, `~/.codex/config.toml` or `~/.cursor/mcp.json`.

## Maintenance notes

- Absolute paths break when the user upgrades Node through a version manager (for example vite-plus moves to `node/24.x.y`). Rerunning `init` fixes it. A later `context-eng doctor` command could detect a missing path, but that is deferred.
- Reviewers: check that the Windows branch still uses npx, and that dev runs (`tsx`, `loader` set) never write a `.ts` entry into a real config.
