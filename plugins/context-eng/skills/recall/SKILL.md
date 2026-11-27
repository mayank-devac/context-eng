---
name: recall
description: Show stored context-eng memories about a task or topic, without starting the task.
argument-hint: "<task or topic>"
disable-model-invocation: true
---

<!-- sync:recall-intro -->
The user wants to see what memory holds about a topic. This is a lookup, not a request to do the task: do not start it, run commands, or edit files.
<!-- /sync:recall-intro -->

## Get the memories

The topic is the text the user wrote after invoking recall. If it is empty, show `Usage: recall <task or topic>` and wait.

Otherwise call the context-eng `memory_search` tool exactly once with:
- `query`: the topic
- `filters`: `{ "scope": "both" }`
- `projectPath`: the absolute root of the current project

If the memory tools are not available, tell the user the context-eng plugin's MCP server did not start: check that Node.js 20 or newer is installed, then restart the app. Do not claim recall worked.

<!-- sync:recall-show -->
## Show the memories

- List each memory on its own line with its category, project, and last-updated date. Keep the wording faithful; do not merge or reinterpret memories.
- If nothing matched, say that no matching memory was found.
- If you received a usage message or an error instead, show it as it is.

Then stop and wait for the user's next instruction.
<!-- /sync:recall-show -->
