# @jakedowns/opencode-nudge

OpenCode host adapter for the shared nudge engine.

Phase 0 exposes the adapter contract. Phase 2 implements:

- host hooks (prompt, context/steps, tool.execute.after, idle)
- one shared timer
- shared state file with atomic lock
- one `nudge` standing context key
- synthetic delivery for block (and experiment arms)
- one `nudge` agent tool

Do not add producer signal logic here.
