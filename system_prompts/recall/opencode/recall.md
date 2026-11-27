---
description: Show stored memories about a task or topic, without starting the task.
---
<!-- context-eng:recall -->

<!-- sync:recall-intro -->
The user wants to see what memory holds about a topic. This is a lookup, not a request to do the task: do not start it, run commands, or edit files.
<!-- /sync:recall-intro -->

Topic: $ARGUMENTS

## Get the memories

If the topic is empty, show `Usage: /recall <task or topic>` and wait.

Otherwise call the context-eng `memory_search` tool exactly once with:
- `query`: the topic
- `filters`: `{ "scope": "both" }`
- `projectPath`: the absolute root of the project open in this OpenCode session

If the memory tools are not available, tell the user to run `context-eng init`, select OpenCode, and restart it. Do not claim recall worked.

<!-- sync:recall-show -->
## Show the memories

- List each memory on its own line with its category, project, and last-updated date. Keep the wording faithful; do not merge or reinterpret memories.
- If nothing matched, say that no matching memory was found.
- If you received a usage message or an error instead, show it as it is.

Then stop and wait for the user's next instruction.
<!-- /sync:recall-show -->
