# Fix recall findings 2, 3, and 4 safely

## Task and authorization

Work in `/Users/mayank/development/context_eng`. Mayank explicitly requested this new session to implement the three fixes below. Implement them directly; do not repeat the approval discussion or reopen the whole audit. Read the repository's `AGENTS.md` first and use its concrete explanation style.

This is a live working tree with uncommitted and untracked implementation files. Preserve them. Another session added post-session memory saving during the previous investigation. Do not reset, clean, discard, or replace that work. Re-read current source before editing because line numbers and helper names may have moved.

No permission has been given to run tests, builds, linters, type checks, installations, publishing, or live host reconfiguration. Implement source and focused tests, inspect the actual diff, and give Mayank the smallest verification commands to run. Do not claim tests or real-host checks passed. Do not spawn subagents, commit, push, or publish.

## Existing behaviour and decisions

- `src/cli.ts` dispatches MCP, terminal recall, prompt-box hook setup, and the post-session hook. Inspect its current command names rather than assuming the original version.
- `src/hooks.ts` handles `UserPromptSubmit`, recognises explicit recall requests, retrieves through `src/retrieval.ts`, and emits `hookSpecificOutput.additionalContext`.
- Automatic recall runs before every prompt when enabled. Manual recall remains available. Claude Code uses `/recall <topic>`; Codex uses `$recall <topic>` or its skill picker.
- `src/hook-install.ts` installs the owned recall skill files and merges the owned handler into host configuration. Its shared helpers are also used by `src/postsession.ts`; preserve that integration.
- Post-session saving uses the working harness model. New saved notes must become searchable immediately. This is existing separate work, not a new feature to redesign in this task.
- This project's `.codex/hooks.json` already has both `UserPromptSubmit` and `Stop`. Recall is automatic with `--local`. The recall command files are installed under `.agents/skills/recall`. Do not rewrite these live files while fixing source.
- The runtime uses SQLite, TypeScript/ES modules, Node >=20, Vitest, and existing dependencies. Add no dependency.
- Do not open `.env`, credentials, private keys, or keystores. Use fixture data and source code, never real memory contents or full session logs.

## Fix 2: avoid rebuilding summary maps during recall

Current source to verify:

```ts
// src/engine.ts, constructor
this.openProject();
this.refreshMaps();
```

`src/hooks.ts` constructs a new `Engine` for each submitted prompt. Engine startup calls map regeneration. `src/map.ts:buildIndex` reads all active rows, computes keywords/counts, and creates summaries. `writeMapFiles` rewrites `map.md` and `map.json` for the global/project stores. These are summary files; recall searches the databases directly.

Make a minimal, explicit lightweight-open path for recall. An optional engine construction option with the existing behaviour as its default is acceptable. Wire the hook to skip unnecessary map rebuilding, without changing normal setup/MCP behaviour. Preserve required schema/legacy migrations and regeneration after actual memory mutations. If migration changes memory data, handle its map freshness deliberately rather than blindly suppressing all updates.

Likely files: `src/engine.ts`, `src/hooks.ts`, `test/engine.test.ts`, `test/hooks.test.ts`. Read `src/map.ts` and `src/paths.ts` for the real storage flow; change them only if the fix actually requires it.

Add focused tests showing that a recall against an existing store returns the expected notes without rewriting unchanged summary files, and that create/edit/promote/demote/delete still refresh the summaries as required. Use isolated stores; preserve the engine's existing default behaviour for other callers. Do not promise or invent a latency measurement.

## Fix 3: recover from a failed multi-file installation

Current source to verify:

```ts
// src/hook-install.ts, installRecallHooks
for (const change of changes) {
  if (change.content === null) unlinkSync(change.file);
  else writeConfigAtomically(change.file, change.content);
}
```

Each individual write is atomic, but the whole installation is not. For example, a fresh Codex installation can create `SKILL.md` and `agents/openai.yaml`, then fail to write `.codex/hooks.json`, leaving an unusable partial installation.

Before applying an installation/update/removal, capture the previous contents and necessary file metadata for the exact files it will touch. If a later operation fails, undo completed operations in reverse order: restore files that existed before this attempt and remove only files created by this attempt. Never remove unrelated hooks, settings, skills, or directory contents. Preserve the shared `Stop` handler when updating or rolling back recall.

Keep using the existing atomic writer where appropriate. A rollback must not silently overwrite a file another actor changed after our write. Compare it with the content/type we wrote; if it differs, preserve the other actor's change and report the conflict and any remaining partial changes. Report rollback failures honestly. Do not claim a transaction succeeded when it did not.

Likely files: `src/hook-install.ts`, `test/hook-install.test.ts`; touch `src/harness.ts` only if its atomic writer actually needs a small reusable change. Keep `src/postsession.ts` compatible without redesigning it.

Add fault-injection tests that fail after an earlier file operation, including fresh install, update of existing owned files, and removal. Verify exact previous contents are restored, newly created files are cleaned up, unrelated configuration survives, a concurrent edit is preserved, and a subsequent retry works. Existing successful install/update/off/idempotency cases must remain valid. Do not test against the live `.codex` or `.agents` folders.

## Fix 4: measure the context the agent actually receives

Current source to verify:

```ts
// src/hooks.ts
return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
// Later in recallHook:
while (memories.length && approxTokens(hookOutput(context)) > MAX_CONTEXT_TOKENS) memories.pop();
```

`hookOutput` returns the whole escaped JSON transport response. The harness parses it and supplies only the `additionalContext` string to the model. Counting the transport includes routing field names and another level of JSON escaping, so useful notes can be omitted too early.

Separate rendering the actual context string from serialising the transport response. Apply the existing approximate 1800-token limit to the exact `additionalContext` string, including the headers, note metadata, and any inner JSON the model really receives. Then serialise the outer response once. Do not count only note content, raise the limit, delete stored memories, change the five-note maximum, or remove delimiter escaping.

Likely files: `src/hooks.ts`, `test/hooks.test.ts`. Add a regression with quotation marks/backslashes/control-character escaping where the outer JSON is larger than the actual context. Inspect the parsed output's real `additionalContext` in assertions. Retain whole-note trimming, result ordering, provenance, manual usage/errors, quiet automatic status, and valid protocol output for both hosts. Revisit any existing test that bounds the outer response length rather than the actual model-visible text.

## Execution order and boundaries

1. Read `AGENTS.md`, relevant `.agent/memory.md`/`.agent/repo_map.md` entries, and current versions of the affected source/tests. Give a brief concrete file-by-file plan, then implement without asking again for these three fixes.
2. Fix context measurement and add its regression tests.
3. Fix installation recovery and add failure-path tests.
4. Add the lightweight recall-open path and regression coverage for map freshness.
5. Update the relevant README/repository-map descriptions if behaviour or navigation changed. Inspect the actual source diff and all newly created files. Preserve unrelated work.

Out of scope: new task-end functionality, changing automatic/manual product decisions, replacing the memory store, broad search refactors, new dependencies, live hook reconfiguration, changing the default 20-second MCP relevance deadline, or implementing finding 1 as an automated real-agent test project. Document that live host verification remains a separate user check.

## Verification commands to give Mayank

These commands are verification gates, not permission to run them in this session:

```sh
npm run typecheck:test
npm test -- test/hooks.test.ts test/hook-install.test.ts test/engine.test.ts test/recall.test.ts test/mcp.test.ts
```

Expected results: type checking exits 0 and the focused suites pass. Narrow the test list if current source proves some suites are unrelated; explain that choice. Do not run repeated broad checks without a new reason.

For real host checks, use the walkthrough in `README.md` under "Test an unpublished checkout". Fresh chats are necessary so the answer does not come from earlier chat text. A later memory lookup by the post-session saving pass is separate from recall before the first answer. Codex requires project/hook trust through `/hooks`; post-session saving requires `memory_create` and `memory_promote` to be connected and permitted. Do not change live host configuration without a further explicit request.

## Final report

Explain each fix using concrete objects and a small example: which summary files no longer get rewritten on lookup; what exact files are restored after a failed installation; and what exact text now counts against the prompt budget. State what was changed, inspected, and left unverified. Provide the focused commands above and do not call the feature production-ready without real host evidence.

Stop and report rather than improvising if the relevant code has changed enough to invalidate these findings, preserving another actor's files is uncertain, or the fix requires changing product policy or unrelated modules.
