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
| Nudges | **Parallel workstream**, separate plugin; not a dependency (see below) |
| Mute | Three explicit scopes: `/voice off-session`, `off-project`, `off-global` |
| Daemon failure | One-shot fallback, logged, with a bounded restart backoff |
| Audio links | **TUI sidebar panel** of recent audio, not a synthetic message |
| Done bar | Offline unit + integration tests, plus one real manual session |

As built in the stub: mutes are `voice_control` tool actions and palette
commands with the same three scopes, stored in `.voice-state.json` at the plugin
root (shared with the TUI, git-ignored); slash commands are still deferred. The
sidebar list and its palette toggle are implemented, along with the audio tool
page and the mute toggles; daemon guard and backoff are in place. Unit tests
remain.

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
| Command | `/voice on\|off\|status\|say <text>` — mute scopes and manual speech |
| TUI | `sidebar.content` slot: the 20 most recent generated audio items, with duration and age |
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
`profiles.active === "home"` → no mute in effect → message not already spoken →
sanitised text within `maxChars` → synthesis succeeded. Dedupe is by message
id, held in `ctx.storage` so a plugin reload does not repeat a reply.

Mutes are explicit and ordered, narrowest first:

| Command | Scope | Stored in |
|---|---|---|
| `/voice off` (= `off-session`) | this session only | plugin storage, keyed by session |
| `/voice off-project` | every session in this project | `.dev/voice-state.json` (git-ignored) |
| `/voice off-global` | every project | plugin storage, global key |

Any active mute silences auto-speak; `/voice on` clears the narrowest active
mute, `/voice on <scope>` clears exactly that one. `/voice status` reports each
scope and where it was set, so "why is it quiet" is answerable in one command.

Two deliberate choices:

- **No synthetic message on failure.** A failed WAV must not turn into an agent
  turn; log once per session and continue.
- **One voice per machine.** The queue serialises playback, so two sessions
  finishing together talk in order, not over each other.

### Speakable text

Speech is not markdown. The popular OpenCode voice plugins converge on the same
filter, so 0.0.1 adopts their conventions rather than inventing new ones:
`neurono-ml/opencode-voice` keeps text parts and strips fenced code, URLs and
paths; `beltranrengifo/agent-voice` also drops inline code and tables and
discards sentences that lose too much; `fahrim/opencode-speak-tts` rewrites
camelCase, spells acronyms and drops hashes; `semirhuduti/opencode-tts-voice`
caps each chunk.

| Input | Spoken form |
|---|---|
| reasoning / thinking parts | never spoken |
| fenced code block | dropped; replaced by "a code block" only when it is the whole answer |
| inline code | short identifiers kept and split (`retryCount` → "retry count"); punctuation-heavy ones dropped |
| URL | dropped entirely |
| file path | basename only ("the file audioq dot py") |
| commit hash / UUID | dropped |
| markdown table | dropped whole |
| headings, bullets, bold, links | read as plain sentences |
| arrows and operators (`->`, `>=`, `&&`) | words ("to", "at least", "and") |

Two guards on top: a sentence that loses more than half its characters to the
filter is dropped rather than read as a fragment (the `agent-voice` rule), and
the **sanitised** text must fit `maxChars` (default 2000, compared after
filtering). Above that the reply is skipped with a logged reason — truncating
mid-thought is worse than silence, and summarisation is a 0.2 feature. If
filtering removes everything (a reply that is only code or tables), the plugin
speaks one short sentence instead of nothing — "The response was all code, so
there is nothing to read aloud." — and logs the original length. Silence with
no explanation is indistinguishable from a broken plugin.

### Where the audio link lives

A plugin cannot edit the assistant's finished text, and a synthetic message
would add a turn (and can loop with the idle hook). So no synthetic links:
the plugin writes each item to a small index next to the audio
(`<output.directory>/.voice-index.json`, atomic replace, newest 50), and the
**TUI part** renders it in the `sidebar.content` slot as a compact list:

```
voice
  reply-wait-3f2a.wav   34.2s   2m ago
  reply-build-91c0.wav   12.8s   1h ago
```

The `voice_speak` tool still returns `path`, so an agent that wants an inline
`**Audio:**` line can quote it; auto-speak only logs and indexes. Reading the
index from disk keeps server and TUI decoupled for a local-only plugin; a typed
RPC part replaces it if the TUI ever has to talk to a remote server.

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
synthesis — slower, but the reply still works. A daemon failure is a symptom,
so it is logged and retried with a bounded backoff: 1 s, 5 s, 30 s, then stop
attempting for the rest of the server run (the next `setup` resets it). Every
attempt logs the reason (socket missing, pid dead, spawn error); auto-speak
never blocks a reply on this.

## Package layout

```
plugin/
  package.json
  index.ts            # server part: hook, tool, command
  tui.tsx             # TUI part: sidebar list of recent audio
```

```json
{
  "name": "assistant-voice-opencode-plugin",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": "./index.ts", "./tui": "./tui.tsx" },
  "dependencies": { "@opencode/plugin": "latest" },
  "peerDependencies": {
    "@opentui/core": ">=0.6.6",
    "@opentui/solid": ">=0.6.6",
    "solid-js": ">=1.9.0"
  }
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

Recommendation (adopted): run it as a **parallel workstream**, not a dependency.
Auto-speak needs one idle hook and a mute flag, so voice 0.0.1 does not import
the manager and cannot be blocked by its refactor. The extraction starts at
`/media/share/nudge-manager-opencode-plugin/plugin/PROPOSAL.md`, taking the
store, scheduler, triggers, cooldowns and delivery modes, with an SPI for
conditions and text. Progress becomes a consumer that registers its tree
evaluator, `say-monitor` a second consumer, and voice registers "turn ended,
speak it" as a third once the manager exists.

## Acceptance criteria

1. With a config (`session: "auto"`, `active: "home"`), finishing a turn
   produces one WAV and one enqueued item; a second idle event for the same
   message speaks nothing.
2. `spoken` matches `audioq.py say --dry-run` byte for byte.
3. Each mute scope works independently: `off-session` silences only that
   session, `off-project` every session in the project, `off-global` all;
   `/voice status` names the active scope, and mutes survive a restart.
4. Two concurrent `voice_speak` calls queue two items in call order, no overlap.
5. A reply containing fenced code, URLs and a table speaks only its prose; a
   sentence that loses over half its characters is dropped, and no reply is
   truncated mid-sentence.
6. Sanitised text over `maxChars` is skipped with a logged reason, and the log
   names the original and sanitised lengths.
7. Missing binary or daemon failure returns an actionable tool error (manual
   call) or a single log line (auto); the daemon is retried on the 1 s / 5 s /
   30 s backoff and then left alone; the text reply is unaffected.
8. `profiles.active: "away"` refuses with "remote profile not implemented in
   0.0.1".
9. The sidebar slot lists the newest items with duration and age, newest first,
   capped at 50, and the list survives a TUI restart.
10. No WAV, socket, or lock is written inside the repository.

## Test plan

- Unit: preamble resolution against a temp config; message selection and
  dedupe; mute precedence across the three scopes; length cap.
- Unit: sanitiser fixtures — fenced block, inline code, URL, path, table,
  hash, arrows, and the "sentence loses half its content" drop rule.
- Unit: path containment (`../` rejected) and slugging; index writer keeps 50
  entries and replaces atomically.
- Integration: temp queue + `--player true`, fire two idle events with the same
  message id, assert exactly one item; fire with a new id, assert two.
- Integration: stale pid file with a dead pid is replaced; live pid is honoured;
  a failing daemon triggers the backoff and then one-shot synthesis.
- Manual: one real session with `OPENCODE_LOG_LEVEL=DEBUG` to confirm the hook
  registers, the daemon survives a plugin reload, and the sidebar renders.

## Risks and open questions

1. **`experimental.idle` is experimental.** Isolate it in one module so a hook
   rename is a one-file fix, and keep the tool path working regardless.
2. **`audioq.py` hardcodes `/media/share/linux-piper-helper`** for the one-shot
   path. Fix the path resolution before shipping, or pass explicit paths.
3. **Speaking everything is noisy.** Three mute scopes, `maxChars`, and `auto:
   false` are the escape hatches; watch for sessions that only ever need tools.
4. **Sanitisation can hollow out a reply.** The sentence-drop rule keeps
   fragments off the speaker, but a code-heavy answer may end up silent; log
   that outcome instead of guessing.
5. **Duplicate daemons** across plugin instances — solved by the pid file and
   exclusive create, but only if both instances share the queue directory.
6. **TUI slot churn.** `sidebar.content` and the TUI context are younger than
   the server API; keep the sidebar a pure reader of the index file so a slot
   change costs a small file, not the pipeline.

## Roadmap after 0.0.1

- 0.1: `away` profile, tunnel control, QR pairing (`docs/remote-audio-pairing.md`).
- 0.2: summarise long replies instead of skipping them; replay and open-from-
  sidebar (`session.panel`); typed RPC if the TUI must work against a remote
  server.
- Parallel: `nudge-manager-opencode-plugin` with a condition SPI; voice
  registers "turn ended" when it lands.
