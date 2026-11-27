# assistant-voice-opencode-plugin

[![npm version](https://img.shields.io/npm/v/@jakedowns/assistant-voice-opencode-plugin.svg)](https://www.npmjs.com/package/@jakedowns/assistant-voice-opencode-plugin)

Published as [`@jakedowns/assistant-voice-opencode-plugin`](https://www.npmjs.com/package/@jakedowns/assistant-voice-opencode-plugin)
on npm.

Local text-to-speech for OpenCode, built on `audioq.py`. v0.0.1 is a **stub**:
the tool and the TUI surface exist, but the sanitiser, mutes, and queue paths
still need tests before the label changes.

Design and decisions: [`PROPOSAL.md`](./PROPOSAL.md).

## Install

From npm:

```sh
opencode plugin add @jakedowns/assistant-voice-opencode-plugin
# or pin it yourself: npm install @jakedowns/assistant-voice-opencode-plugin
```

Then add it to the **global** config (`~/.config/opencode/opencode.json`), with
the same `options`:
```jsonc
{
  "plugins": [{ "package": "@jakedowns/assistant-voice-opencode-plugin", "options": { "auto": true } }]
}
```

## Load it locally

For development, point at the checkout instead of the registry:

```jsonc
{
  "plugins": [
    {
      "package": "/media/share/opencode-audio-tool/plugin",
      "options": {
        "root": "/media/share/opencode-audio-tool",
        "auto": true,
        "maxChars": 2000
      }
    }
  ]
}
```

A global entry is deliberate: a project-local entry loads the server part, but
the TUI part only becomes visible after the TUI re-reads its plugin list, so one
global entry avoids project-vs-global ordering surprises. Auto-speak still
follows the per-project `.dev/audiomode.jsonc`, so projects without one stay
silent.

The server part is loaded from `index.ts` directly. The TUI and GUI parts ship
prebuilt at the package root, because a local plugin directory without
`name`/`exports` resolves parts **by file name**: `index.ts` (server), `tui.js`,
`rpc.ts`, and `gui-experimental.cjs`. That convention is deliberate — the
exports-map path silently dropped `rpc` and `gui` for this package, while the
file-name path reports all four parts.

```sh
cd plugin
npm install
npm run build          # tui.js (esbuild) + gui-experimental.cjs (vite)
```

Sources live in `src/` (`tui.tsx`, `gui.tsx`); the built files at the root are
what OpenCode loads, so rebuild after editing and reload the client.

The GUI part contributes:

- a **Voice** group in the desktop command palette and the composer `/` menu
  (`/voice` with `open`, `status`, `mute|unmute [session|project|global]`);
- an **Audio** tab in a session's side panel (recent replies, duration, age,
  mute toggles);
- an **Audio** launcher on the side panel's New tab page;
- RPC (`./rpc`) so the window can read state and toggle mutes without touching
  the filesystem.

A server-side `/voice` command is registered too, so the command exists even if
the client-side parts are disabled.

## Modes

| Mode | Runs on | What it does |
|---|---|---|
| `auto` (default) | anywhere | Linux with an executable `piper/piper`, or macOS with `piper-macos/piper` (or `piperBin` / `PIPER_BIN`) → `host`; everything else → `client` |
| `host` | the machine with piper | synthesises, enqueues, plays; watches `.voice-requests/`; publishes stats every 2 s |
| `client` | a machine sharing the folder (e.g. the Mac) | never runs piper; writes request files and reads the host's stats from the shared state |
| `remote` | any machine without a shared folder | refuses; the tunnel design in `docs/remote-audio-pairing.md` is not built yet |

`auto` checks the file header instead of running piper: a Linux ELF is not
accepted on macOS, so the shared `piper/` copy does not make a Mac a host by
accident. The effective mode and its origin (`option`, `override`, `auto`) are
shown in the desktop audio panel, where **Run as host on this machine** flips
between host and client without restarting the plugin. The override is stored
per hostname in `.mode-override.json` (the plugin root is shared, so each
machine reads only its own entry; git-ignored). Use the **Auto** button to
forget it.

Client and host talk through the shared directory only — no network, no RPC across
machines:

```
<root>/.voice-requests/req-<id>.json   client -> host { text, sessionID }
<root>/.voice-index.json               host -> clients (latest 50, newest first)
<root>/.voice-state.json               mute state + host stats/heartbeat, shared
<root>/.mode-override.json             per-machine host/client choice (not shared state)
<root>/.client-playback.json           per-machine "play on this Mac" flag
```

The host polls the request directory every 2 s (SMB/virtiofs events are not
reliable), speaks each request through the normal queue, and records the result.
Each host claims a request by renaming it to `req-<id>.json.processing` before
reading it. Rename is atomic across processes, so two host-mode servers (for
example the desktop app and a `opencode serve --service`) cannot both speak the
same request. A claim older than 15 minutes is re-queued, so a crash
mid-synthesis does not strand it.

On a VM whose audio device is passed through, the Mac client needs nothing else:
the VM plays, the Mac sees the entry.

Mac (client) config, using the canonical Mac-side path to the shared folder
(macOS does not follow the `opencode-audio-tool` symlink over SMB):

```jsonc
{
  "plugins": [
    {
      "package": "/Users/<you>/<shared>/opencode-helpers/packages/audio-tool/plugin",
      "options": {
        "mode": "client",
        "root": "/Users/<you>/<shared>/opencode-helpers/packages/audio-tool",
        "sharedRoot": "/Users/<you>/<shared>",
        "auto": true
      }
    }
  ]
}
```

`sharedRoot` is the Mac's view of the SMB share; it maps canonical
`/media/share/...` index and output paths to local paths. Without it the plugin
only derives it when `root` ends with `/opencode-helpers/packages/audio-tool`.

Client mode needs no piper and no Python: it only reads and writes the shared
files. macOS also ships no `aplay`, and does not need one — playback stays on
the host.

## Host on macOS

```sh
cd packages/audio-tool
./fetch-macos.sh          # piper-macos/piper, native arm64 or x64
./fetch.sh                # voices/voice.onnx if you have not fetched it yet
```

`fetch-macos.sh` never touches `piper/` (the Linux copy). The published
2023.11.14-2 macOS archives are broken (x86_64 binary with the shared libraries
missing), so the script prefers the self-contained `piper-tts` wheel and falls
back to the release archive only with `PIPER_MACOS_RELEASE=1`. The pip wheel has
no `--json-input`; `piperd.py` detects that and serves the same socket with one
piper process per request.

Host mode on the Mac then works like the VM: `voice_speak` writes a WAV under
`output.directory`, enqueues it in the per-machine queue
(`/tmp/opencode/audio-replies/queue`), and the drainer plays it with `afplay`.
`output.directory` and the cache root are canonical `/media/share/...` paths in
the shared index, but bytes are written under `<sharedRoot>/tmp/audio/...`.

Prerequisites: `python3` (Xcode Command Line Tools are enough; install with
`xcode-select --install` if `python3 -c 'import wave'` fails) and `afplay`
(built in). For the away profile, install `ffmpeg` (`brew install ffmpeg`) or
point `output.ffmpeg` at a static build; home keeps the WAV and needs neither.

## Options

| Option | Default | Meaning |
|---|---|---|
| `root` | `/media/share/opencode-audio-tool` | where `audioq.py`, `piper/` and `voices/` live |
| `mode` | `auto` | `auto`, `host`, `client`, or `remote`; a per-machine override wins at runtime |
| `sharedRoot` | derived when `root` matches the monorepo layout | this machine's view of the SMB share, used to map `/media/share/...` paths |
| `cacheDir` | `~/.cache/opencode-audio-tool` | where client playback copies new replies |
| `player` | `afplay` on macOS, `aplay -q` elsewhere | player command for client playback and the drainer |
| `piperBin` | option → `PIPER_BIN` → `piper-macos/piper` (macOS) → `piper/piper` | Piper binary for this machine |
| `auto` | `true` when `.dev/audiomode.jsonc` exists | speak each finished reply |
| `maxChars` | `2000` | split longer replies into sequential chunks (sentence boundaries first) |
| `emptyNotice` | `{session} here: my last message was untranscribable, check the app` | spoken when sanitising removes everything |
| `autoUnmute` | `false` | on host start, unmute the default sink (and lift it off zero) when it would play silently |

## What works

- `voice_speak` (Code Mode `tools.voice.speak`): the agent's text is spoken
  verbatim, preamble applied by `audioq.py`, synthesised to `output.directory`,
  then enqueued so the returned path survives playback.
- Auto-speak hook (`experimental.idle`): picks the last assistant message, skips
  reasoning parts, sanitises markdown, dedupes by message id, and speaks.
  Replies longer than `maxChars` are split into sequential chunks at sentence,
  clause, or word boundaries instead of being skipped. When nothing is
  speakable it announces the session name and says the message was
  untranscribable instead of going silent. Every
  turn is counted in `.voice-state.json` as spoken or skipped (`noText`,
  `tooLong`, `duplicate`, `muted`, `subagent`, `remote`, `error`).
- `voice_control` (`tools.voice.control`): `mute`, `unmute`, `status` with
  `session`, `project`, or `global` scope. Any active mute silences; state lives
  in `.voice-state.json` at the plugin root (git-ignored), shared with the TUI.
- TUI part: a **Voice** group in the command palette (open audio tool, toggle
  the sidebar, toggle mute for each scope, status toast), a clickable
  `🎙 voice` button in `sidebar.content` and on the new-tab footer, and an
  audio tool page (route `voice`) listing recent items with per-scope mute
  toggles. The sidebar list reads `.voice-index.json` (newest 4, with duration
  and age) and can be hidden with **Voice: toggle audio sidebar**.

### `/voice` slash commands

Palette entries and the `/voice` dispatcher are generated from one definition in
`plugin/commands.ts` (`VOICE_PALETTE`, `VOICE_SLASH`), so the GUI and TUI cannot
drift. The only intentional difference is `sidebar`, which is TUI-only:

| Palette entry | GUI | TUI |
|---|---|---|
| open audio tool, status, repeat, summary | ✓ | ✓ |
| toggle mute (session / project / all) | ✓ | ✓ |
| purge older (retention), purge all | ✓ | ✓ |
| toggle audio sidebar | — | ✓ |

The dispatcher itself:

| Command | Effect |
|---|---|
| `/voice` (or `/audio`) | open the audio tool page |
| `/voice status` | toast the session/project/global mute state |
| `/voice mute [scope]` | mute; scope defaults to `session` |
| `/voice unmute [scope]` | unmute that scope |
| `/voice toggle [scope]` | flip that scope |
| `/voice sidebar` | show or hide the sidebar section |
| `/voice repeat` (alias `last`) | speak the most recent text reply again |
| `/voice summary` (alias `summarize`) | ask the model for a 70-word status and speak it |
- Daemon: if the socket is missing, `setup` starts `piperd.py --serve --drain`
  once, guarded by `<queue>/.voice-plugin.pid` created with `O_EXCL`, retrying
  on a 1 s / 5 s / 30 s backoff. A stale pid file is replaced only after its
  owner is confirmed dead.
- Failures are logged and returned as tool content; nothing throws into a turn.

## Diagnostics

Every repeat/summary/replay transition is appended to `.voice-log.jsonl` at the
package root (git-ignored):

```sh
tail -f /media/share/opencode-audio-tool/.voice-log.jsonl
{"at":"…","kind":"repeat","status":"running"}
{"at":"…","kind":"repeat","status":"ok","detail":"11.51s"}
```

The same outcome appears in the panel as `Last: repeat ✓ 11.51s`. Queue playback
history lives in `/tmp/opencode/audio-replies/queue/drain.log`. The **Clear**
button in the panel's Log header truncates `.voice-log.jsonl` and reports the
number of lines removed in the `Last:` row.

The build is also defensive about this share: piper's output is polled for up to
2 s before enqueue, and a "no such file" enqueue is retried once, because SMB
writeback can lag the process exit.

## Playing on the client

In client mode the panel gains **Play on this Mac (local cache)**. When on:

1. the host still synthesises and writes the index entry, but skips enqueueing
   (no VM playback, no duplicate audio);
2. the client polls the shared index every 2 s, copies each new reply into
   `~/.cache/opencode-audio-tool/` (override with the `cacheDir` option) and
   plays it with `afplay` on macOS (`aplay` elsewhere, override with `player`);
3. playback progress is recorded in the same `.voice-log.jsonl`
   (`kind: "play"`), so failures are visible in the panel log.

Path mapping assumes the Mac sees the share at `<sharedRoot>/opencode-helpers/
packages/audio-tool`; set the plugin option `sharedRoot` (for example
`/Users/you/share`) when the layout differs. Without a mapping the log records
`cannot map <path>` instead of failing silently.

This is playback-only while the machine is a client. Flip **Run as host on this
machine** in the panel to let the Mac synthesise, enqueue, and play locally with
`piper-macos/piper` and `afplay` (see **Host on macOS**); switching back to
client starts the local-cache player again. Hosts publish
`hostHeartbeat`/`hosts` in the shared state every 2 s, and the panel warns when a
different machine's heartbeat is younger than 15 s, so two active hosts are
visible. Nothing disables them automatically: the queues are per machine, so if
both synthesise they will both speak.

## Playback controls

While something is playing, the panel adds a **Pause/Play** button and a seek
bar under the queue line, with elapsed/total time and the item label. The bar
interpolates between the 2 s state polls, so it moves smoothly.

- **Host**: `audioq.py` publishes `<queue>/.playing.json` every 0.5 s and polls
  `<queue>/.playback-control.json`. Pause/resume uses `SIGSTOP`/`SIGCONT`; seek
  trims the WAV with Python's `wave` module (no ffmpeg) and restarts the player
  at that offset. Seeking while paused stays paused.
- **Client with Play on this Mac**: the panel drives the local `afplay` process
  directly, with the same pause and seek semantics (the cached WAV is trimmed
  into a temporary file).
- **Client without local playback** (or a host whose own queue is idle while the
  other machine is playing): actions are forwarded to the machine that owns the
  sound through `.voice-requests` (`kind: "playback"`), and the audible host
  publishes the playback position in `.voice-state.json`.
- The machine that owns the speaker must run the current server build; an older
  host has no `.playing.json`, so the panel simply shows no playback row.

## Subagents

A subagent is a session with a `parentID`. Auto-speak skips those by default
(`playback.speak_subagents: false`, or plugin option `speakSubagents`); an
explicit `voice_speak` from a subagent still works, because the agent asked for
it. Muting a parent session now also silences its subagents — the mute check
walks the parent chain (up to 8 levels) — while project/global mutes apply as
before. Entries produced by a child are prefixed `↳` in both panels.

## Voices

`output`/`synthesis` in the reply config choose the voice. `voice_per_session`
(default true) hashes the session id into `synthesis.voices`, so concurrent
sessions keep distinguishable voices; `voice_speak` accepts `voice: "alan.onnx"`
to override one call. Voices must match this piper generation
(`northern_english_male` crashes it).

Verified by synthesising one sentence four times: `alan.onnx` and the automatic
per-session pick had identical duration (2.586 s), while `voice.onnx` (2.691 s)
and `lessac-low.onnx` (2.916 s) differed.

## Format and retention

`output.format: "auto"` means **no encoding on the golden path**: a `home`
profile keeps the WAV that piper wrote, links it, and never invokes ffmpeg. Only
an `away` profile (sharing a link with another device) encodes, using
`output.link_format` — **m4a/AAC 96k** by default, because iOS Safari will not
play a bare WAV and AAC is ~30–40% smaller than MP3 at equal quality. MP3 stays
available as `link_format`; explicit `format: "wav" | "mp3" | "m4a"` overrides
`auto`. If the encoder fails, the plugin logs and links the WAV instead.

Measured on one 3.7 s reply: WAV 163 KB, m4a 47 KB (AAC 103 kbps). AAC encoding
uses more CPU than libmp3lame, but for a minute of speech it is under a second
here — and only `away` links pay it.

```jsonc
"output": {
  "format": "auto",             // auto: home=wav, away=link_format
  "link_format": "m4a",         // or "mp3"
  "link_bitrate": "96k",
  "ffmpeg": "/media/share/tmp/tools/ffmpeg/ffmpeg",
  "retention": {
    "auto_purge_minutes": 30,   // 0 disables automatic purging
    "max_age_days": 14,         // hard ceiling if auto purge is off
    "max_files": 200,
    "sweep_on_start": true,
    "sweep_interval_minutes": 5
  }
}
```

Both `reply-*.mp3` and `reply-*.m4a` count as cached audio alongside WAV.

A host sweeps every 5 minutes (and 30 s after start). `auto_purge_minutes`
wins over `max_age_days` when it is smaller — the default is 30 minutes, so
generated audio does not accumulate. Scheduled sweeps cover the whole shared
audio root (`/media/share/tmp/audio` and its project subdirectories); manual
purge only touches the current project. `max_files` still caps the count. Manual purge, all three clients:

| Where | Command |
|---|---|
| palette | **Voice: purge generated audio** |
| slash | `/voice purge [days]` — omit days to purge everything |
| tool | `voice_purge` with optional `days` |

The result is written to `.voice-state.json`: `lastPurge` records the last run
that actually deleted files, `lastAttempt` every run (including "nothing to
remove"), so a racing empty purge cannot erase a real result. The Audio panel
shows "removed N files, freed X MB", or "nothing to remove · previous freed X"
when the latest attempt found nothing.

From a client, purge and per-row delete are delegated to the host through
`.voice-requests/` (`kind: "purge"` / `"remove"`); the client polls the shared
state for the result. A client never deletes files on its own filesystem, where
the configured output path does not exist.

Both clients also show live state in the GUI Audio panel and TUI sidebar:

```
Mode: host · Data: local (5s old) · Auto-speak: on   ← clickable: mute all / turn on
Cache: 4.3 MB · 7 files
Queue: 0 queued · 1 playing · 2 generating — Agent Voice Tool
Voice: this 12 turns · 5 spoken · 3 missed | 24h 219 turns · 31 spoken · 12 missed
Volume [==========|-------] 70%       ← slider; "host" on a client
Last purge: removed 2 files, freed 919.3 KB
```

`generating` counts synthesis in flight (active speaks plus claimed
`.voice-requests`). When nothing is playing, the queue line keeps the most
recent speaker as `latest: <name>` instead of going blank.

The `Voice:` line counts auto-speak hook turns, not agent tool calls. `spoken`
means a durable reply (or a client request) was produced; `missed` sums
`noText`, `tooLong`, `error`, and `remote`. Hover it for the full per-reason
breakdown for this session and the rolling 24 h window. Muted and subagent
turns are counted as turns but not as missed; `duplicate` is a legitimate
skip. Because the counters live in the plugin, a plugin that fails to load
contributes no turns at all — cross-check `session_message` idle rows if the
numbers go suspiciously quiet.

`Data` names where the panel's numbers came from: `local` for a host that
measured them itself, `host` for a client reading the shared state, followed by
the age of the oldest statistic. Flip-flopping values with a changing label is
the signature of two hosts publishing different stats.

`cache` is one canonical number: all `reply-*.wav|mp3` under
`/media/share/tmp/audio` (the shared audio root and its project subdirectories),
so two hosts or two projects cannot publish different totals for the same tree.
`queue` comes from the audioq queue directories, and `audio` from
`wpctl get-volume` on the default sink. A host refreshes all three every 15 s; a client reads the host's published
values from `.voice-state.json` instead of measuring its own zeroes, and shows
`Volume: host` when the audio device belongs to the other machine.

Mute buttons show their state — `✓ session muted` vs `○ session on`. The
"Mode: host · Auto-speak: …" line is a button: when anything is muted it clears
global, project and session mutes in one click; when on, it mutes globally.
The queue line names the session whose reply is playing, using `--session` on
`audioq.py enqueue`. A client-supplied title is carried through the request file
(`sessionTitle`) and used for both the preamble and the queue sidecar, so the
Mac's session name survives the hop. Host stats refresh every 5 s. Clicking a row replays it. A WAV reply is enqueued as-is. An encoded link
prefers the queue's archived WAV (same basename, last 100 items) so replay is
bit-exact and needs no ffmpeg; only after that archive is pruned is the link
transcoded to a temporary WAV. Each row also has an **✕** that deletes that reply from disk and from the
index (click it, not the row; it stops propagation). Only paths present in the
index can be replayed or removed, and both `.wav`/`.mp3` variants of that
basename go on delete. The TUI audio page supports the same row click.

Purge is split in two styled buttons: **Purge older** applies the retention
policy, **Purge all** ignores it and is marked as destructive (red border).
Mute toggles, the auto-speak toggle, Refresh and the per-row ✕ share the same
button style, with hover/active states and pressed styling for active mutes.

## What is not implemented yet

- `/voice` slash commands. Palette commands and the `voice_control` tool cover
  the same ground today.
- Unit tests for the sanitiser, mute file, and index writer.

## Verify by hand

```sh
opencode plugin list                       # should list assistant-voice local
python3 audioq.py status                   # queue + daemon socket
```

Then ask the agent to call `tools.voice.speak` with a short sentence. A
successful call returns:

```json
{"ok":true,"path":"/media/share/tmp/audio/opencode-audio-tool/reply-…wav","queue":"/tmp/opencode/audio-replies/queue/….wav","id":"…","seconds":4.34,"gen":1.2,"via":"piper+enqueue"}
```

Synthesis time (`gen`) is measured, not assumed: it is slow when the machine is
loaded (for example while another process runs an emulator), so ignore a large
value if `seconds` is small and the daemon is warm.
