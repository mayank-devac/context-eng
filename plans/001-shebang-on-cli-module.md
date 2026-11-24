# Plan 001: Make `dist/cli.js` safe to execute directly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8cbd312..HEAD -- src/cli.ts src/cli-entry.ts package.json test/cli.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8cbd312`, 2026-11-24

## Why this matters

On 2026-11-24 this package fork-bombed a Mac (about 3,000 processes, 100% CPU, only a reboot cleared it).
An old npx cache entry still linked the `context-eng` command to `dist/cli.js` (an earlier `bin` target).
`dist/cli.js` has no `#!` first line. When a file without `#!` is run as a command, macOS refuses it and `sh` then reads the file **as a shell script**.
The usage text in `cli.ts` contains lines like `  context-eng mcp [--project <path>]` and `context-eng hook --harness claude|codex --mode manual|automatic`.
`sh` runs each of those lines as commands. `context-eng` runs the same file again, and `|codex --mode manual` starts the Codex CLI.
About 9 lines each start a new copy, so the number of processes grows exponentially.
Adding a `#!/usr/bin/env node` first line to `src/cli.ts` means any old or wrong link to `dist/cli.js` runs Node instead of `sh`. Node only loads the module and exits, because `cli.ts` exports `main` and never calls it.

## Current state

- `src/cli-entry.ts` — the real `bin` target; already has a shebang:
  ```ts
  // src/cli-entry.ts:1-7
  #!/usr/bin/env node
  import { main } from "./cli.js";

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  ```
- `src/cli.ts` — the CLI module; starts directly with imports, no shebang:
  ```ts
  // src/cli.ts:1-3
  import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  ```
  Its usage text (compiled to `dist/cli.js` lines ~29-37) includes lines that begin with `context-eng ` and contain `|`.
- `package.json` — `"bin": { "context-eng": "./dist/cli-entry.js" }`, `"type": "module"`, build is `tsc -p tsconfig.json` (TypeScript keeps a leading shebang in its output).
- `cli.ts` must **not** call `main()` itself — `cli-entry.ts` does that. Keep it that way so running `dist/cli.js` directly is a harmless no-op.
- Tests use Vitest; see `test/cli.test.ts` for the existing CLI test style.

## Commands you will need

| Purpose   | Command                     | Expected on success |
|-----------|-----------------------------|---------------------|
| Build     | `npm run build`             | exit 0              |
| Typecheck | `npm run typecheck`         | exit 0              |
| Tests     | `npx vitest run test/cli.test.ts` | all pass      |
| Lint      | `npm run lint`              | exit 0              |

**Never** run `npx context-eng ...` from inside this repo while testing — that is the exact command that triggered the loop.

## Scope

**In scope**:
- `src/cli.ts` (add one first line only)
- `test/cli.test.ts` (add tests)

**Out of scope**:
- `src/harness.ts` and the npx launch command — plan 002 covers that.
- `package.json` `bin` — already correct.
- Deleting anything under `~/.npm/_npx` — user machine state, not repo code.

## Git workflow

- Branch: `advisor/001-cli-shebang`
- One commit, short imperative subject matching `git log` style, e.g. `Add shebang to cli module so stale links run node`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Add the shebang

Insert `#!/usr/bin/env node` as line 1 of `src/cli.ts`. Change nothing else.

**Verify**: `head -1 src/cli.ts` → `#!/usr/bin/env node`

### Step 2: Build and confirm output

**Verify**: `npm run build && head -1 dist/cli.js` → `#!/usr/bin/env node`
**Verify**: `npm run typecheck && npm run lint` → both exit 0

### Step 3: Prove direct execution is harmless

`chmod +x dist/cli.js` is not required; test via `sh`, which is what npm does:

**Verify**: `sh -c 'node dist/cli.js mcp' </dev/null; echo exit=$?` → prints `exit=0` immediately, nothing else.

### Step 4: Add regression tests

In `test/cli.test.ts`, add a `describe("bin safety", ...)` block with:
1. Every `.ts` file in `src/` whose compiled `.js` file could be a command target (`cli-entry.ts`, `cli.ts`) starts with `#!/usr/bin/env node` — read with `readFileSync`.
2. `package.json` `bin` values all point to a file whose source starts with `#!` (map `./dist/X.js` → `src/X.ts`).

**Verify**: `npx vitest run test/cli.test.ts` → all pass, including the 2 new tests.

## Test plan

- The two tests in Step 4.
- Manual negative check (do not commit): temporarily remove the shebang, confirm test 1 fails, restore it.

## Done criteria

- [ ] `head -1 src/cli.ts` prints `#!/usr/bin/env node`
- [ ] `npm run build && head -1 dist/cli.js` prints `#!/usr/bin/env node`
- [ ] `npm run typecheck`, `npm run lint`, `npm test` exit 0
- [ ] `git status` shows only `src/cli.ts`, `test/cli.test.ts`, and `plans/README.md` changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- `src/cli.ts` calls `main()` at the top level (then running it directly would start the CLI — report instead).
- TypeScript strips the shebang from `dist/cli.js`.
- Any step's command tries to start `npx context-eng` inside the repo.

## Maintenance notes

- Any new file that may ever become a `bin` target needs a shebang. The Step 4 test enforces this for `package.json` `bin`.
- Usage text with `|` and command-like lines is only dangerous when a file is read by `sh`. Do not rely on rewording the usage text; the shebang is the real fix.
- Plan 002 removes the npx launch path that exposed this; both are needed (defense in depth).
