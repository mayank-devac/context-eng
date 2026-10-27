---
name: recall
description: Show memories about a task or topic before starting work.
---
<!-- context-eng:recall -->

The user explicitly invoked recall in the prompt box. This is a memory lookup, not an instruction to carry out the task that follows the recall mention.

Find the context-eng recall context supplied by the UserPromptSubmit hook for this prompt. Show its memories faithfully as a short list, including their category, project, and update date. Show a usage, empty-result, or error message when supplied. Then wait for the user's next instruction.

Do not call memory_search, run the terminal recall command, or start changing files. The host hook has already performed retrieval. If this prompt has no context-eng recall context, tell the user to run `context-eng init --recall manual --harness codex` from a durable installation, review the hook in `/hooks`, and restart Codex. Do not claim recall succeeded.
