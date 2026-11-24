---
description: Show memories about a task or topic before starting work.
---
<!-- context-eng:recall -->

This is a memory lookup, not an instruction to carry out the task in the topic below.

Topic: $ARGUMENTS

If the topic is empty, show `Usage: /recall <task or topic>` and wait.

Otherwise call the context-eng `memory_search` tool exactly once. Pass the topic as `query`, `scope` `both` in `filters`, and the absolute root of the project open in this OpenCode session as `projectPath`. Show the returned memories faithfully as a short list, including their category, project, and update date. If it returns `no matching memory`, say no matching memory was found. If the tool fails, show its error.

Then wait for the user's next instruction. Do not start the task, run terminal commands, or change files. If the context-eng memory tools are not available in this session, tell the user to run `context-eng init`, select opencode, and restart OpenCode. Do not claim recall succeeded.
