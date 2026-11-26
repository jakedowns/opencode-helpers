# @jakedowns/opencode-nudge

Shared host adapter for the nudge engine.

**Phase 2a (done):** `createNudgeAdapter(host, options)`

- shared `~/.config/opencode/nudge-state.json` with atomic lock
- one standing `nudge` key, legacy `progress-reminder` cleanup
- mute, gap, grace, per-session cap, duplicate/priority
- context delivery; synthetic only for `block`
- per-session touch/clear/status
- basic fire/suppress telemetry through `host.log`

**Still to do:** OpenCode hook wiring, one shared timer, one `nudge` agent tool,
registration race handling, config loader, cross-process concurrency stress.

Tests: 8 adapter cases (`npm test` once dependencies are installed).
