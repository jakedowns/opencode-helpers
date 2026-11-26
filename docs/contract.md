# Shared nudge contract

Phase 0 freezes the producer ↔ adapter boundary.

## Invariants

1. **One channel.** The adapter writes one standing context key (`nudge`) per
   session. Producers never write `progress-reminder` directly.
2. **One gate.** Mute, gap, grace, cap, duplicate, priority, and replace
   suppression are adapter policy, not producer policy.
3. **Producers detect signals only.** They render text and submit a
   `NudgeCandidate`; they do not schedule, dedupe, or deliver.
4. **Synthetic is exceptional.** Block may synthesise; warn/info default to
   context. The synthetic-delivery experiment is explicit and reversible.
5. **Config is shared.** `nudge.json` owns defaults/rules; legacy progress
   options are mapped once by the progress adapter.
6. **State is shared.** `nudge-state.json` is versioned, locked, and written
   atomically. A schema-major mismatch must refuse to write, not corrupt state.

## Candidate

A candidate carries producer, ruleId, severity, text, channel, optional dedupe
key/target, timestamp, and metadata. See
`packages/nudge-core/src/contract.ts`.

## Gate result

`applied` plus a reason (`muted`, `gap`, `grace`, `cap`, `duplicate`,
`lower-priority`, `custom-replace`). The adapter records the reason in
telemetry.

## Producer checklist

- [ ] detect one signal
- [ ] build a compact target-aware candidate
- [ ] call `adapter.submit`
- [ ] respect `adapter.clear` / `touch` at compliance points
- [ ] do not import another producer's policy

## Wording variation

Core may own template pools, but producers supply product-specific templates.
Variation is deterministic hash rotation, not model-generated. The severity
prefix and required action never vary.
