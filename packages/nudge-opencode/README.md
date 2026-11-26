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

**Phase 2c (done):**
- `attachNudge(ctx, options)`: host wiring, one 5s timer, prompt reset,
  idle/tool callbacks, first-loader `nudge` tool registration
- 16 adapter tests (gate + tool + config + host)

**Still to do:** cross-process concurrency stress and producer integration.

Tests: 8 adapter cases (`npm test` once dependencies are installed).
