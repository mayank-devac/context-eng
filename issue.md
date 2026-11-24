# Open issues from the OpenCode review

Leftover work from the review of the OpenCode commits (up to `f403c40`).
The small, safe fixes are already done:

- One `anyOnlyFlag()` helper now replaces the four hand-written
  `--*-only` checks in `src/cli.ts`.
- `writeClaudeRuleFile` was renamed to `writePointerFile`. All four pointer
  writers (Claude global, Claude project rule, Codex, OpenCode) now use it.

The two items below are larger, and each one gets its own change.

---

## 1. One spec record per harness (high priority)

### Problem

A *harness* is one AI tool we support: `claude`, `codex`, `cursor`,
`opencode` (`HarnessId` in `src/harness.ts:21`). Facts about each tool are
spread across files as `id === "..."` checks:

| File | Checks on a harness name |
|---|---|
| `src/harness.ts` | 16 |
| `src/cli.ts` | 9 |
| `src/hooks.ts` | 4 |
| `src/hook-install.ts` | 4 |
| `src/postsession.ts` | 3 |

Adding OpenCode needed changes in about six files. The next harness will
need the same, and if one place is missed, nothing fails loudly.

Examples of the same fact repeated:

- Skill files per harness: `src/postsession.ts:60` and
  `src/hook-install.ts:278` both say
  `harness === "codex" ? ["SKILL.md", "agents/openai.yaml"] : ["SKILL.md"]`.
- Skill folder: `src/postsession.ts:72` picks `.agents` vs `.claude` inline.
- Hooks file: `src/hook-install.ts:165` picks `.codex/hooks.json` inline.
- Which harnesses support hooks: `RECALL_HARNESSES` in `src/hooks.ts:9`,
  plus the check at `src/hooks.ts:42`, plus `SETUP_HARNESSES` in `src/cli.ts`.
- The `--*-only` flags: `CliOptions` in `src/cli.ts`, the parse options
  (`"opencode-only": { type: "boolean" }`), `ONLY_FLAGS`, the `only` list in
  `configureMemoryHooks`, and the per-flag branches in the `init` pointer
  section.
- MCP config writer: the `writeHarness` switch in `src/harness.ts`
  (`if (id === "codex") return writeCodex(...)`).

### Suggested fix

Add a single table, such as `HARNESS_SPECS: Record<HarnessId, HarnessSpec>`,
in a new `src/harness-spec.ts`. One record holds everything about one tool:

```ts
interface HarnessSpec {
  id: HarnessId;
  label: string;                    // "OpenCode"
  onlyFlag: `${HarnessId}-only`;    // CLI flag name
  detect: { commands: string[]; dirs: (home: string) => string[] };
  writeMcpConfig: (ctx: WriteCtx) => Promise<HarnessWriteResult>;
  globalPointerFile?: (home: string, env: NodeJS.ProcessEnv) => string;
  hooks?: {                         // absent = no hook support (cursor)
    file: (base: string) => string;
    skillDir: string;               // ".claude" | ".agents"
    skillFiles: string[];
  };
}
```

Then switch the call sites to read the table instead of checking names:

1. `detectHarnesses` loops over the specs.
2. `writeHarness` calls `spec.writeMcpConfig`.
3. `RECALL_HARNESSES` / `SETUP_HARNESSES` become "specs that have `hooks`".
4. `ONLY_FLAGS` and the `only` list are built from `spec.onlyFlag`.
5. `postsession.ts` and `hook-install.ts` read `spec.hooks.skillFiles` and
   `spec.hooks.skillDir`.

Do it in steps, one commit per step, and keep tests green after each one.
Start with the hooks data (smallest, most repeated), then detection, then
the MCP writers.

### Watch out for

- Keep the config writers in `src/harness.ts`. Moving `writeOpencode` into
  `src/opencode.ts` creates a circular import through `writeConfigAtomically`.
- `parseArgs` options need fixed keys. Build the `--*-only` entries from the
  specs, but check that the `CliOptions` type still lists each flag.
- `cursor` has no hooks and rejects `--harness` in hook setup
  (`configureMemoryHooks`). Keep that error message.

### Done when

- Adding a fifth harness means adding one record and its writer function,
  and no other file changes.
- `grep -rnE '=== "(claude|codex|cursor|opencode)"' src` returns only the
  spec file (or nothing).

---

## 2. Detect harnesses once per `init` run (low priority)

### Problem

One `init` run checks which tools are installed more than once. Each check
runs `which` for every tool:

- `src/cli.ts` (`init`): `detectHarnesses(...)` to build the choice menu.
- `src/harness.ts` (`installDetectedHarnesses`): calls `detectHarnesses`
  again.
- `src/cli.ts` (`configureInteractiveHooks` → `installedSetupHarnesses`):
  a third time.

The cost is a few milliseconds, so users won't notice. It matters mostly
for tidiness.

### Suggested fix

Let `installDetectedHarnesses` accept optional `hits` (the result of an
earlier `detectHarnesses` call). `init` then detects once and passes the
result down, including to `configureInteractiveHooks`. Calls that pass no
`hits` keep today's behavior, so existing tests don't change.

This is easier after issue 1, because detection will then live in one place.

---

## Reviewed and left as is (no action)

- **Parsing the OpenCode config three times in `writeOpencode`.** The files
  are tiny, and merging the parses would complicate `upsertOpencodeJson`.
- **Removing `claudeFallback`** (`src/opencode.ts`). It equals
  `file !== agentsFile`, but the named field reads more clearly.
- **Sharing one "project binding" text** between OpenCode and postsession.
  The wording differs on purpose, and changing it would change prompt files
  users already have installed.
- **Making `promptHarnessChoice` generic.** Nothing else needs this menu yet.
