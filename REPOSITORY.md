# opencode-audio-tool

A self-contained copy of the Piper helper and the queue, for other agents and machines.

## Layout

```
audioq.py        client + drainer (say / enqueue / list / status / clear / drain)
piperd.py        resident daemon; paths now resolve relative to this directory
piper/           pinned binary (2023.11.14-2 build)
voices/          model files, including the pinned voice.onnx
audio-replies/   snapshot of the live queue from /tmp/opencode/audio-replies
AGENTS.md        agent usage: enable audio mode, per-reply workflow, queue rules
audiomode.example.jsonc   template for ./.dev/audiomode.jsonc (git-ignored copy)
docs/remote-audio-pairing.md  away profile over a tunnel: pairing, QR, back-port plan
```

Start with `AGENTS.md` if you are an agent. The reply config is per project,
resolved from the current directory (`.dev/audiomode.jsonc`, `$AUDIOQ_CONFIG`,
or `--config PATH`); `.dev/` holds one user's preferences and should be
git-ignored rather than committed.

`audio-replies/queue/` holds the runtime format: items waiting, `playing/`,
`played/`, `failed/`, and `drain.log`. Sockets and lock files are not archived.

## Run

```sh
python3 audioq.py say "hello"
python3 piperd.py --serve --drain      # one process: daemon + single drainer
python3 audioq.py status
```

## Speaker preamble

Replies can announce which session is talking, because several agent sessions
share one voice. The field lives in a project's JSONC reply config
(`.dev/audiomode.jsonc`, or `--config PATH`, or `$AUDIOQ_CONFIG`):

```jsonc
"preamble": {
  "enabled": true,          // false = never prefix
  "session": "auto",        // "auto" = OpenCode session title; or a literal name
  "template": "{session}, here: {msg}"   // {session} speaker, {msg} reply text
}
```

Only `preamble` is read by the code. The full file — `name`, `version`,
`tool`, `trigger`, `delivery`, `profiles` (`home` / `away`), `tunnel`,
`toolchain`, `synthesis`, `output` (`directory` + `runtime_queue`),
`reply_format`, `script_style`, `fallbacks`, `playback`, `streaming`, `daemon`,
`gotchas`, `preferences_log` — is documented in `AGENTS.md` and shipped as
`audiomode.example.jsonc`. `version` tracks the schema as
`opencode-audio-tool/cfg@N`; bump it when keys or their meaning change.

`--no-preamble`, `--session NAME`, `--preamble TEMPLATE`, `--config PATH` and
`--dry-run` override it per call. With no config file the text is spoken
unchanged, so existing callers are unaffected.

Paths: `piperd.py` honours `PIPER_BIN` and `PIPER_MODEL`; `audioq.py` honours
`AUDIOQ_DIR`, `AUDIOQ_SOCK`, `AUDIOQ_PLAYER` and `AUDIOQ_CONFIG`, but its
one-shot fallback still defaults to `/media/share/linux-piper-helper`, so a
clone elsewhere needs the daemon or exported `PIPER_BIN`/`PIPER_MODEL`.

## Provenance

Copied from `/media/share/linux-piper-helper` and `/tmp/opencode/audio-replies`
on 2026-11-24. Binary and voice hashes are in `SHA256SUMS`. The original
absolute paths in `piperd.py` were changed to resolve beside this file; no
other behaviour changed.
