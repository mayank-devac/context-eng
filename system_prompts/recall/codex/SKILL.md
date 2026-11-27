---
name: recall
description: Show stored memories about a task or topic, without starting the task.
---
<!-- context-eng:recall -->

<!-- sync:recall-intro -->
The user wants to see what memory holds about a topic. This is a lookup, not a request to do the task: do not start it, run commands, or edit files.
<!-- /sync:recall-intro -->

## Get the memories

The context-eng `UserPromptSubmit` hook has already searched memory and added a `<context_eng_recall>` block to this prompt. Use that block. Do not call memory_search or run `context-eng recall` yourself.

If this prompt has no `<context_eng_recall>` block, the hook is not installed or not trusted. Tell the user to run `context-eng init --recall manual --harness codex` from a global install, review the hook in `/hooks`, and restart Codex. Do not claim recall worked.

<!-- sync:recall-show -->
## Show the memories

- List each memory on its own line with its category, project, and last-updated date. Keep the wording faithful; do not merge or reinterpret memories.
- If nothing matched, say that no matching memory was found.
- If you received a usage message or an error instead, show it as it is.

Then stop and wait for the user's next instruction.
<!-- /sync:recall-show -->
