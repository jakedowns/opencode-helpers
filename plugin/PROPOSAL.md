# Proposal: `assistant-voice-opencode-plugin` v0.0.1 (MVP)

Status: proposal, decisions recorded below. Not implemented.
Target: OpenCode V2 plugin API (`@opencode/plugin`, `Plugin.define`).

## Decisions (settled)

| Question | Decision |
|---|---|
| Explicit tool vs auto-speak | **Hybrid**: auto-speak the finished reply, plus a `voice_speak` tool for ad hoc text |
| Plugin vs CLI | **Thin shell**: the plugin calls `audioq.py`; Python stays the single implementation |
| Daemon ownership | **Plugin spawns** `piperd.py --serve --drain`, guarded by a pid file it owns |
| Config location | **`./.dev/audiomode.jsonc`** from the working directory, same cfg@3 schema |
| Distribution | **Local `./plugin` only**; publish after the contract survives a release |
| `away` profile | **Refuse clearly** in 0.0.1; tunnelling is 0.2 |
| Nudges | Separate concern, extraction proposed but **not blocking** (see below) |

## Problem

Today the voice tooling is a pseudo-skill: `AGENTS.md` tells an agent to read
`.dev/audiomode.jsonc`, run `audioq.py say`, and quote the result. It works, but
every new agent session has to re-learn it, every session writes its own shell
incantation, and nothing enforces the queue, the preamble, or playback order.
The behaviour is documentation, not code.

## Goals (v0.0.1)

1. **Auto-speak** the completed assistant reply when the reply config says audio
   mode is active, with a per-session mute and a message-length cap.
2. Register a `voice_speak` tool for ad hoc text ("say this out loud"), sharing
   the same synthesis path as auto-speak.
3. Respect `.dev/audiomode.jsonc`: preamble, `output.directory`,
   `length_scale`, `profiles.active`, and the `home` playback rules.
4. Start the resident daemon and single drainer once, and never start a second.
5. Stay a thin shell over the tested CLI. No Python rewrite, no second queue.
6. Fail loudly but without breaking the reply: tool errors are content, and an
   auto-speak failure is logged, never thrown into the turn.

## Non-goals (v0.0.1)

- The `away` profile and tunnelling (specified in
  `docs/remote-audio-pairing.md`; plugin 0.2).
- Streaming playback, voice selection UI, and a TUI part.
- Replacing `AGENTS.md`; it stays the guide for agents without the plugin.

## MVP surface

| Piece | Detail |
|---|---|
| Hook | `ctx.session.hook("experimental.idle")` — turn end, speak the last assistant text |
| Tool | `voice_speak` (namespace `voice`), input `{ text, session?, no_preamble? }` |
| Command | `/voice on\|off\|status\|say <text>` — per-session toggle and manual speech |
| Result | `{"path","seconds","gen","via","spoken","spoken_id"}`; `spoken` is the prefixed transcript |
| Side effect | WAV under `output.directory`, enqueued through `audioq.py`, played by the drainer |
| Config | `.dev/audiomode.jsonc` (cfg@3) resolved from `ctx.location.directory` |
| Lifecycle | `setup` verifies the toolchain, starts the daemon if the socket is stale, returns cleanup |

### Auto-speak

The progress plugin already establishes the pattern: on
`experimental.idle` (used at `index.ts:1159` of `progress-tool-linux-vm`),
read `ctx.session.context({ sessionID })`, take the last assistant message, and
extract its `text` parts. Auto-speak reuses that shape.

```ts
await ctx.session.hook("experimental.idle", async (event) => {
  const messages = await ctx.session.context({ sessionID: event.sessionID })
  const last = [...messages].reverse().find(m => m.type === "assistant")
  if (!last || spoken.has(last.id)) return          // speak each message once
  const text = textParts(last).join("\n").trim()
  if (!text || text.length > maxChars) return        // skip, log reason
  if (!enabledFor(event.sessionID)) return           // profile + mute
  spoken.add(last.id)
  await speak({ root, config, text, sessionID: event.sessionID })
})
```

Guards, in order: plugin enabled globally → config present and
`profiles.active === "home"` → session not muted → message not already spoken →
text within `maxChars` (default 4000) → synthesis succeeded. Dedupe is by
message id, held in `ctx.storage` so a plugin reload does not repeat a reply.

Two deliberate choices:

- **No synthetic message on failure.** A failed WAV must not turn into an agent
  turn; log once per session and continue.
- **One voice per machine.** The queue serialises playback, so two sessions
  finishing together talk in order, not over each other.

### Tool sketch

```ts
editor.add({
  name: "speak",
  description: "Synthesise text and enqueue it for local playback.",
  input: {
    type: "object",
    properties: {
      text: { type: "string" },
      session: { type: "string" },
      no_preamble: { type: "boolean" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  options: { namespace: "voice", codemode: true },
  execute: async (input, context) => speak({ ...input, signal: context.signal }),
})
```

Preamble formatting is not reimplemented: `audioq.py say --dry-run` prints the
exact spoken form, which keeps one source of truth for `{session}`/`{msg}`.

### Daemon lifecycle

1. Socket answers → nothing to do.
2. Socket missing → spawn `python3 piperd.py --serve --drain` detached,
   `stdio: "ignore"`, wait up to 10 s for the socket.
3. Record the pid in `<queue>/.voice-plugin.pid` **under an exclusive-create
   lock**; a second plugin instance sees the live pid and does not spawn.
4. Cleanup only stops the pid this plugin recorded; a stale pid file with a dead
   process is replaced, never trusted.

If the daemon never appears, `audioq.py say` already falls back to one-shot
synthesis — slower, but the reply still works.

## Package layout

```
plugin/
  package.json
  index.ts            # server part: hook, tool, command
```

```json
{
  "name": "assistant-voice-opencode-plugin",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "dependencies": { "@opencode/plugin": "latest" }
}
```

Local loading:

```jsonc
// opencode.jsonc
{ "plugins": [{ "package": "./plugin", "options": { "root": "/media/share/opencode-audio-tool" } }] }
```

No build step; the server loads TypeScript. Options: `root`, `config`, `auto`
(default true), `maxChars`, `daemon` (auto|never).

## Config contract

Reused as-is from `audiomode.example.jsonc` (cfg@3):

| Key | Use |
|---|---|
| `preamble.enabled/session/template` | spoken prefix; `"auto"` resolves the session title |
| `output.directory` | where the linked WAV goes |
| `synthesis.length_scale`, `.model` | passed to the CLI/daemon |
| `profiles.active` | `home` = speak locally; `away` = refuse in 0.0.1 |
| `delivery.allow_remote_upload` | must stay false; the plugin never uploads |

Missing config means no auto-speak and no preamble; the tool still works.

## Nudges: extract or not?

`progress-tool-linux-vm` has a generic-looking nudge engine: rule schema and
scopes (`custom-nudges.ts`, 962 lines), trigger types (interval / steps / event
/ either), cooldown, TTL, fire caps, and three delivery modes
(`context-replace`, `context-alongside`, `synthetic`) implemented on the
`context` hook and `ctx.session.synthetic`. `say-monitor.ts` is a second,
purely decision-logic policy.

**Coupling that blocks a clean extraction:** criteria are progress-shaped —
`statuses`, `staleAfterMs`, `noProgressAfter`, `tree`, `entryIds` — and the
rules are persisted next to the progress state, with TUI (`tui-nudges.ts`) and
RPC surfaces reading the same files. A generic manager needs a condition SPI so
consumers can register evaluators ("progress tree is stale", "three silent tool
calls", "assistant turn just ended"), not just a rule store.

Recommendation:

- **Do not block the voice plugin on it.** Auto-speak needs one `idle` hook and
  a mute flag, about 40 lines. Depending on a nudge refactor would couple two
  releases for no gain.
- **Extract later as `nudge-manager-opencode-plugin`**, taking the store,
  scheduler, triggers, cooldowns, and delivery modes, with an SPI for
  conditions and text. Progress becomes a consumer that registers its tree
  evaluator; `say-monitor` becomes a second consumer; the voice plugin could
  register "turn ended, speak it" as a third — though for 0.0.1 it simply calls
  the same `speak()` directly.
- Keep the extraction out of both MVPs. It is a multi-surface refactor (server,
  TUI, RPC, MCP) and the risk lands on the tool the user relies on daily.

## Acceptance criteria

1. With a config (`session: "auto"`, `active: "home"`), finishing a turn
   produces one WAV and one enqueued item; a second idle event for the same
   message speaks nothing.
2. `spoken` matches `audioq.py say --dry-run` byte for byte.
3. `/voice off` silences auto-speak for that session only; `/voice on` restores
   it; a restart keeps the toggle (storage-scoped per session).
4. Two concurrent `voice_speak` calls queue two items in call order, no overlap.
5. A message over `maxChars` is skipped with a logged reason, not truncated
   mid-word and not spoken in full.
6. Missing binary or daemon failure returns an actionable tool error (manual
   call) or a single log line (auto), and the text reply is unaffected.
7. `profiles.active: "away"` refuses with "remote profile not implemented in
   0.0.1".
8. No WAV, socket, or lock is written inside the repository.

## Test plan

- Unit: preamble resolution against a temp config; message selection and
  dedupe; length cap; mute state.
- Unit: path containment (`../` rejected) and slugging.
- Integration: temp queue + `--player true`, fire two idle events with the same
  message id, assert exactly one item; fire with a new id, assert two.
- Integration: stale pid file with a dead pid is replaced; live pid is honoured.
- Manual: one real session with `OPENCODE_LOG_LEVEL=DEBUG` to confirm the hook
  registers and the daemon survives a plugin reload.

## Risks and open questions

1. **`experimental.idle` is experimental.** Isolate it in one module so a hook
   rename is a one-file fix, and keep the tool path working regardless.
2. **`audioq.py` hardcodes `/media/share/linux-piper-helper`** for the one-shot
   path. Fix the path resolution before shipping, or pass explicit paths.
3. **Speaking everything is noisy.** `maxChars`, per-session mute, and `auto:
   false` are the escape hatches; watch for sessions that only ever need tools.
4. **Turn-end text can be long markdown.** Strip code fences and URLs before
   synthesis; the existing `reply_format.do_not` rules are the spec.
5. **Duplicate daemons** across plugin instances — solved by the pid file and
   exclusive create, but only if both instances share the queue directory.

## Roadmap after 0.0.1

- 0.1: `away` profile, tunnel control, QR pairing (`docs/remote-audio-pairing.md`).
- 0.2: extract `nudge-manager-opencode-plugin` with a condition SPI; voice and
  progress register as consumers.
- 0.3: TUI part for mute / replay last / queue status.
