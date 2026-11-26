# @jakedowns/opencode-nudge

Shared host adapter for the nudge engine.

**Phase 2a (done):** `createNudgeAdapter(host, options)`

- shared `~/.config/opencode/nudge-state.json` with atomic lock
- one standing `nudge` key, legacy `progress-reminder` cleanup
- mute, gap, grace, per-session cap, duplicate/priority
- context delivery; synthetic only for `block`
- per-session touch/clear/status
- basic fire/suppress telemetry through `host.log`

**Phase 2b (done):**
- generic `nudge` agent tool (`status|mute|unmute|clear`) in `tool.ts`
- unified `nudge.json` loader with global/project merge and legacy fallback
- 14 adapter tests (gate + tool + config)

**Still to do:** OpenCode hook wiring, one shared timer, registration race
handling, cross-process concurrency stress, and producer integration.

Tests: 8 adapter cases (`npm test` once dependencies are installed).
