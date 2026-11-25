# Proposal: `assistant-voice-opencode-plugin` v0.0.1 (MVP)

Status: proposal, not implemented.
Target: OpenCode V2 plugin API (`@opencode/plugin`, `Plugin.define`).

## Problem

Today the voice tooling is a pseudo-skill: `AGENTS.md` tells an agent to read
`.dev/audiomode.jsonc`, run `audioq.py say`, and quote the result. It works, but
every new agent session has to re-learn it, every session writes its own shell
incantation, and nothing enforces the queue or the preamble. The behaviour is
documentation, not code.

The plugin turns the documented loop into one tool the model can call, with the
same config file and the same audio pipeline underneath.

## Goals (v0.0.1)

1. Register a `voice_speak` tool that synthesises text and enqueues it with the
   existing `audioq.py`, returning the path, duration and generation time.
2. Respect `.dev/audiomode.jsonc`: preamble (`enabled`, `session`, `template`),
   `output.directory`, `length_scale`, and the `home` profile's playback rules.
3. Start the resident daemon and single drainer once per server process when
   the socket is absent, and never start a second drainer.
4. Stay a thin shell over the tested CLI. No Python rewrite, no second queue.
5. Fail loudly but without breaking the reply: if synthesis or playback fails,
   return the error as tool content; never throw into the agent loop.

## Non-goals (v0.0.1)

- The `away` profile and tunnelling (specified in
  `docs/remote-audio-pairing.md`; plugin 0.2).
- Auto-speaking every assistant message. MVP is explicit tool calls only.
- Streaming playback, voice selection UI, or a TUI part.
- Replacing `AGENTS.md`; it stays the guide for agents that do not load plugins.

## MVP surface

| Piece | Detail |
|---|---|
| Tool | `voice_speak` (namespace `voice`), input `{ text: string, session?: string }` |
| Tool result | one text block: `{"path","seconds","gen","via","spoken"}`; `spoken` is the prefixed transcript |
| Side effect | WAV in `output.directory`, enqueued through `audioq.py`, played by the drainer |
| Command | optional `/voice` slash command in 0.0.1: speaks the last assistant message |
| Config | `.dev/audiomode.jsonc` from `ctx.location.directory`, or `options.config` |
| Lifecycle | `setup` verifies the toolchain, starts `piperd.py --serve --drain` if the socket is missing, returns a cleanup that leaves it running |

### Tool sketch

```ts
import { Plugin } from "@opencode/plugin"
import { spawn, execFile } from "node:child_process"

export default Plugin.define({
  id: "assistant-voice",
  async setup(ctx) {
    const root = ctx.options.root ?? "/media/share/opencode-audio-tool"
    const config = await loadReplyConfig(ctx.location.directory, ctx.options.config)

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "voice", description: "Speak a reply through the local Piper queue" })
      editor.add({
        name: "speak",
        description: "Synthesise text and enqueue it for local playback. Returns the WAV path and duration.",
        input: {
          type: "object",
          properties: { text: { type: "string" }, session: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "voice", codemode: true },
        execute: async ({ text, session }, context) =>
          speak({ root, config, text, session, signal: context.signal }),
      })
    })
  },
})
```

`speak` resolves the binary and model, applies the preamble by calling the CLI
(`audioq.py say --dry-run` gives the exact spoken form; do not reimplement the
template), synthesises to `output.directory/reply-<slug>.wav`, then
`audioq.py enqueue`. Parsing the single JSON line the CLI already prints keeps
one source of truth.

### Daemon lifecycle

On `setup`:

1. If `piperd.sock` exists → nothing to do.
2. Else spawn `python3 piperd.py --serve --drain` detached with `stdio: "ignore"`,
   wait up to 10 s for the socket, and record the pid in `ctx.storage`.
3. If it never appears, log once and let `audioq.py say` fall back to one-shot
   synthesis (slower, already supported).

The plugin must never kill a daemon it did not start; `cleanup` only stops the
process whose pid it recorded.

## Package layout

```
plugin/
  package.json
  index.ts            # server part: tool + optional command
```

`package.json`:

```json
{
  "name": "assistant-voice-opencode-plugin",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "dependencies": { "@opencode/plugin": "latest" }
}
```

Loading, for local development:

```jsonc
// opencode.jsonc
{ "plugins": [{ "package": "./plugin", "options": { "root": "/media/share/opencode-audio-tool" } }] }
```

No build step: the server loads TypeScript directly. Publishing is deferred
until the API surface survives a release (non-goal for 0.0.1).

## Config contract

Reused as-is from `audiomode.example.jsonc` (cfg@3). The plugin reads:

| Key | Use |
|---|---|
| `preamble.enabled/session/template` | spoken prefix; `"auto"` resolves the session title |
| `output.directory` | where the linked WAV goes |
| `synthesis.length_scale`, `.model` | passed to the CLI/daemon |
| `profiles.active` | `home` = enqueue; `away` → v0.0.1 returns "not implemented yet" |
| `delivery.allow_remote_upload` | must stay false; the tool never uploads |

Missing config means "no preamble, defaults", exactly like the CLI.

## Acceptance criteria

1. In a project with `.dev/audiomode.jsonc` (`session: "auto"`), calling
   `voice_speak` produces a WAV, enqueues it, and the audio starts within one
   second when a drainer is already running.
2. The returned `spoken` text matches `audioq.py say --dry-run` byte for byte.
3. Calling it twice concurrently produces two queue items in call order, with
   no overlapping playback.
4. A missing binary returns an actionable error as tool content, not a throw,
   and the agent can continue in text.
5. `profiles.active: "away"` refuses with "remote profile not implemented in
   0.0.1".
6. No WAV, socket or lock is written inside the repository.

## Test plan

- Unit: preamble resolution against a temp config (enabled/disabled, literal
  session, `{msg}`-less template, missing config).
- Unit: slugging and path containment (`../` rejected).
- Integration: temp queue dir + `--player true` so CI never touches audio; call
  the tool, assert one enqueued item and its sidecar.
- Manual: one real session with `OPENCODE_LOG_LEVEL=DEBUG` to confirm plugin
  load and tool registration.

## Risks and open questions

1. **`audioq.py` still hardcodes `/media/share/linux-piper-helper`** for the
   one-shot path. The plugin should pass explicit paths, or we fix that first;
   the daemon path already resolves beside `piperd.py`.
2. **Runtime**: the server runs on Bun; `node:child_process` works, but the
   plugin must not assume a login shell or `PATH` beyond `/usr/bin/env`.
3. **Session title lookup** for `"auto"` preamble duplicates logic that lives
   in `audioq.py`; call the CLI rather than read `opencode.db` from the plugin.
4. **Auto-speak** is the obvious next ask; doing it in 0.0.1 would make every
   reply audible and every failure visible. It belongs behind an explicit
   config flag once the tool is stable.
5. **Multiple servers**: a plugin instance per location could start two
   daemons. The socket check plus the queue's own drainer lock prevents
   duplicate playback, not duplicate daemons; use a pid file under the queue
   before shipping.

## Roadmap after 0.0.1

- 0.1: `away` profile, tunnel control and QR pairing from
  `docs/remote-audio-pairing.md`.
- 0.2: optional auto-speak on assistant message completion, with a per-session
  toggle and a global kill switch.
- 0.3: TUI part for "mute", "replay last", and queue status.
