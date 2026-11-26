# assistant-voice-opencode-plugin

Local text-to-speech for OpenCode, built on `audioq.py`. v0.0.1 is a **stub**:
the tool works end to end; auto-speak is wired but disabled; the sidebar, mute
scopes, and daemon pid file are not implemented yet.

Design and decisions: [`PROPOSAL.md`](./PROPOSAL.md).

## Load it locally

`opencode.jsonc` in this repository points at the plugin:

```jsonc
{
  "plugins": [
    {
      "package": "./plugin",
      "options": {
        "root": "/media/share/opencode-audio-tool",
        "auto": false
      }
    }
  ]
}
```

OpenCode loads the TypeScript directly; there is nothing to build or install.
Changing `opencode.jsonc` reloads the plugin. `opencode plugin list` should show
`assistant-voice local …/opencode-audio-tool/plugin`.

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
  `session`, `project`, or `global` scope. Any active mute silences; state is
  persisted in plugin storage, so it survives reloads.
- Daemon: if the socket is missing, `setup` starts `piperd.py --serve --drain`
  once, guarded by `<queue>/.voice-plugin.pid` created with `O_EXCL`, retrying
  on a 1 s / 5 s / 30 s backoff. A stale pid file is replaced only after its
  owner is confirmed dead.
- Failures are logged and returned as tool content; nothing throws into a turn.

## What is not implemented yet

- `/voice` slash commands. The mutes work today through `voice_control`; the
  commands land with the TUI part, which can show a toast instead of injecting
  a synthetic message.
- Sidebar list of recent audio (`sidebar.content` slot + `.voice-index.json`).
- Unit tests for the sanitiser and mute precedence.

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
