# assistant-voice-opencode-plugin

Local text-to-speech for OpenCode, built on `audioq.py`. v0.0.1 is a **stub**:
the tool and the TUI surface exist, but the sanitiser, mutes, and queue paths
still need tests before the label changes.

Design and decisions: [`PROPOSAL.md`](./PROPOSAL.md).

## Load it locally

Add the package to the **global** config (`~/.config/opencode/opencode.json`):

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
| `host` (default) | the machine with piper | synthesises, enqueues, plays; also watches `.voice-requests/` |
| `client` | a machine sharing the folder (e.g. the Mac) | never runs piper; writes a request file, reads the shared index for its panel |
| `remote` | any machine without a shared folder | refuses; the tunnel design in `docs/remote-audio-pairing.md` is not built yet |

Client and host talk through the shared directory only — no network, no RPC across
machines:

```
<root>/.voice-requests/req-<id>.json   client -> host { text, sessionID }
<root>/.voice-index.json               host -> clients (latest 50, newest first)
<root>/.voice-state.json               mute state, shared by both
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

Mac (client) config, using the Mac-side path to the shared folder:

```jsonc
{
  "plugins": [
    {
      "package": "/Users/<you>/<shared>/opencode-audio-tool/plugin",
      "options": {
        "mode": "client",
        "root": "/Users/<you>/<shared>/opencode-audio-tool",
        "auto": true
      }
    }
  ]
}
```

Client mode needs no piper and no Python: it only reads and writes the shared
files. macOS also ships no `aplay`, and does not need one — playback stays on
the host.

## Options

| Option | Default | Meaning |
|---|---|---|
| `root` | `/media/share/opencode-audio-tool` | where `audioq.py`, `piper/` and `voices/` live |
| `auto` | `true` when `.dev/audiomode.jsonc` exists | speak each finished reply |
| `maxChars` | `2000` | skip replies whose sanitised text is longer |
| `emptyNotice` | `{session} here: my last message was untranscribable, check the app` | spoken when sanitising removes everything |
| `autoUnmute` | `false` | on host start, unmute the default sink (and lift it off zero) when it would play silently |

## What works

- `voice_speak` (Code Mode `tools.voice.speak`): the agent's text is spoken
  verbatim, preamble applied by `audioq.py`, synthesised to `output.directory`,
  then enqueued so the returned path survives playback.
- Auto-speak hook (`experimental.idle`): picks the last assistant message, skips
  reasoning parts, sanitises markdown, dedupes by message id, caps at
  `maxChars`, and speaks. When nothing is speakable it announces the session
  name and says the message was untranscribable instead of going silent.
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

The palette group and the slash command share one dispatcher:

| Command | Effect |
|---|---|
| `/voice` (or `/audio`) | open the audio tool page |
| `/voice status` | toast the session/project/global mute state |
| `/voice mute [scope]` | mute; scope defaults to `session` |
| `/voice unmute [scope]` | unmute that scope |
| `/voice toggle [scope]` | flip that scope |
| `/voice sidebar` | show or hide the sidebar section |
- Daemon: if the socket is missing, `setup` starts `piperd.py --serve --drain`
  once, guarded by `<queue>/.voice-plugin.pid` created with `O_EXCL`, retrying
  on a 1 s / 5 s / 30 s backoff. A stale pid file is replaced only after its
  owner is confirmed dead.
- Failures are logged and returned as tool content; nothing throws into a turn.

## Format and retention

Links default to **MP3** (`output.format`), because iOS Safari will not play a
bare WAV reliably. Playback and the queue still use WAV: piper writes the WAV,
`audioq.py` enqueues it, ffmpeg derives the MP3, and the WAV is unlinked once the
queue owns its link. If ffmpeg is missing the plugin logs and links the WAV
instead of failing.

```jsonc
"output": {
  "format": "mp3",              // or "wav"
  "mp3_bitrate": "128k",
  "ffmpeg": "/media/share/tmp/tools/ffmpeg/ffmpeg",
  "retention": {
    "max_age_days": 14,
    "max_files": 200,
    "sweep_on_start": true,
    "sweep_interval_minutes": 60
  }
}
```

A host sweeps `reply-*.wav`/`reply-*.mp3` in `output.directory` on start (after
30 s) and on the interval, deleting anything older than `max_age_days` and then
trimming to `max_files`. Manual purge, all three clients:

| Where | Command |
|---|---|
| palette | **Voice: purge generated audio** |
| slash | `/voice purge [days]` — omit days to purge everything |
| tool | `voice_purge` with optional `days` |

The result is written to `.voice-state.json` (`lastPurge`) so every client can
show "removed N files, freed X MB"; the slash/palette path in the TUI and GUI
shows it immediately, and the Audio panel displays the last result.

Both clients also show live state in the GUI Audio panel and TUI sidebar:

```
Cache: 4.3 MB · 7 files
Queue: 0 queued · 0 playing
Output: 70%            # or "muted"
```

`cache` comes from the reply files in `output.directory`, `queue` from the
audioq queue directories, and `audio` from `wpctl get-volume` on the default
sink. The GUI reads them over RPC; the TUI reads `.voice-state.json`, which the
host refreshes after every speak, purge and sweep.

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
