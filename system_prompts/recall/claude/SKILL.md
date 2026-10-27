---
name: recall
description: Show memories about a task or topic before starting work.
argument-hint: "<task or topic>"
disable-model-invocation: true
---
<!-- context-eng:recall -->

This is a memory lookup, not an instruction to carry out the task in the arguments.

Find the context-eng recall context supplied by the UserPromptSubmit hook for this prompt. Show its memories faithfully as a short list, including their category, project, and update date. Show a usage, empty-result, or error message when supplied. Then wait for the user's next instruction.

Do not call memory_search, run the terminal recall command, or start changing files. The host hook has already performed retrieval. If this prompt has no context-eng recall context, tell the user to run `context-eng init --recall manual --harness claude` from a durable installation and restart Claude Code. Do not claim recall succeeded.
