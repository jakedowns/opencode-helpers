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

The server part is loaded from `index.ts` directly. The TUI part ships prebuilt
(`dist/tui.js`) because the TUI does not transpile TSX for local packages;
rebuild it after editing `tui.tsx`:

```sh
cd plugin
npx esbuild tui.tsx --bundle --format=esm --platform=node --target=node20 \
  --external:@opencode/plugin/tui --external:solid-js --external:'solid-js/*' \
  --external:'@opentui/*' --outfile=dist/tui.js
```

After changing either part, run `/reload` in the TUI (or restart it) so the
client re-reads its plugin list; the server part alone hot-reloads on config
saves. `opencode plugin list` should show `assistant-voice local
…/opencode-audio-tool/plugin`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `root` | `/media/share/opencode-audio-tool` | where `audioq.py`, `piper/` and `voices/` live |
| `auto` | `true` when `.dev/audiomode.jsonc` exists | speak each finished reply |
| `maxChars` | `2000` | skip replies whose sanitised text is longer |
| `emptyNotice` | `{session} here: my last message was untranscribable, check the app` | spoken when sanitising removes everything |

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
