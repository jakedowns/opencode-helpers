# @jakedowns/opencode-nudge-core

Pure, host-agnostic nudge policy.

**Phase 1:** policy extracted from the progress plugin:
- severity, dedupe, age/gap/grace (`reminders.ts`)
- strict / wall-clock / idle decisions (`monitor.ts`)
- say-nudge decisions (`say-monitor.ts`)
- custom rule schema, matcher, scheduler, stores (`custom-nudges.ts`)

Still hosted here but scheduled to move behind injected store adapters:
filesystem reads/writes and JSON paths in `custom-nudges.ts`.

Product message builders are temporarily colocated for regression parity; a
later phase can move copy back into the producer plugins.

No OpenCode imports. No consumer plugin imports these modules directly except
through `@jakedowns/opencode-nudge`.
