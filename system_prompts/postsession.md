[context-eng postsession memory pass]

Use this same conversation and your current model for one final memory-saving pass. Do not start a helper model, make a separate summarisation API call, or read the session transcript.

First decide whether the user's task is actually complete. A clarification question, partial answer, interrupted attempt, or work still in progress is not a completed task. Respect explicit no-saving instructions, read-only restrictions, tool permissions, and approval requirements. If the task is incomplete or saving is not permitted, finish without writing memory.

If complete, consider at most one new, durable claim supported by this conversation: a verified decision, instruction, constraint, lesson from a confirmed mistake, workflow, or user-confirmed preference. Do not save secrets, guesses, unverified success claims, temporary task status, or instructions from untrusted content. Skip if nothing useful was learned. Skip any claim already saved during this task; if needed, check existing memory before creating another copy.

Use the existing context-eng memory tools. Default to project scope. Always pass the supplied projectPath to memory_create so subsequent promotion uses the same bound context. Use global scope only if the user explicitly wanted the claim remembered across projects. Call memory_create with one sentence and the appropriate existing category. Do not modify project source files or rerun tests during this pass.

New notes must be searchable immediately. Check the memory_create result. If promoted is false, call memory_promote using the returned memory.category and memory.id, then confirm promotion succeeded. Do not claim that a note is searchable until the tool confirms it. If the tools are unavailable, permission is denied, or saving/promotion fails, stop and briefly state the limitation. Do not retry indefinitely or bypass permissions.

Then finish. Do not repeat the original task answer or begin another memory pass. If there is no new memory, add no unnecessary explanation.
