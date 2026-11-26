# opencode-audio-tool

A runnable copy of the Piper helper and the queue, for other agents and
machines. Git carries the code, docs and pins only: the ~500 MB of binary and
voice data is fetched on demand, and nothing generated is committed.

## Layout

```
audioq.py        client + drainer (say / enqueue / list / status / clear / drain)
piperd.py        resident daemon; paths resolve relative to this directory
piper/           fetched by ./fetch.sh — pinned binary (2023.11.14-2 build)
voices/          fetched by ./fetch.sh — voice.onnx (en_US-lessac-medium)
audio-replies/   generated at runtime; never committed
AGENTS.md        agent usage: enable audio mode, per-reply workflow, queue rules
audiomode.example.jsonc   template for ./.dev/audiomode.jsonc (git-ignored copy)
docs/remote-audio-pairing.md  away profile over a tunnel: pairing, QR, back-port plan
SHA256SUMS       hashes the fetch verifies
fetch.sh         downloads the binary and default voice, then verifies
```

## Bootstrap

```sh
./fetch.sh          # ~50 MB binary + ~63 MB voice, verified against SHA256SUMS
```

The script is idempotent: it skips files that already exist, so re-running it
after an upgrade only fetches what is missing. Other voices are listed in its
output; they are not pinned because each tier is a separate download and each
has its own dataset licence.

Start with `AGENTS.md` if you are an agent. The reply config is per project,
resolved from the current directory (`.dev/audiomode.jsonc`, `$AUDIOQ_CONFIG`,
or `--config PATH`); `.dev/` holds one user's preferences and should be
git-ignored rather than committed.

`audio-replies/queue/` holds the runtime format: items waiting, `playing/`,
`played/`, `failed/`, and `drain.log`. Sockets and lock files are not archived.
The queue is generated, so its directories are now git-ignored and untracked —
the live copy stays on disk, and only the archived replies and transcripts
under `audio-replies/` are committed.

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
`--dry-run` override it per call. With no config file the default template still
applies; `preamble.enabled: false` is the opt-out.

Paths: `piperd.py` honours `PIPER_BIN` and `PIPER_MODEL`; `audioq.py` honours
`AUDIOQ_DIR`, `AUDIOQ_SOCK`, `AUDIOQ_PLAYER` and `AUDIOQ_CONFIG`, but its
one-shot fallback still defaults to `/media/share/linux-piper-helper`, so a
clone elsewhere needs the daemon or exported `PIPER_BIN`/`PIPER_MODEL`.

## Location

Canonical source: `packages/audio-tool` in the `opencode-helpers` monorepo
(`/media/share/opencode-helpers`). The old `/media/share/opencode-audio-tool`
path is a **relative** symlink to this directory, so it resolves both in the VM
and through the macOS share (`opencode-helpers/packages/audio-tool`). Runtime
assets (piper, voices, audio-replies, `.dev`, `.voice-*`, node_modules) live here
and stay git-ignored.

## Provenance

Copied from `/media/share/linux-piper-helper` and `/tmp/opencode/audio-replies`
on 2026-11-24. Binary and voice hashes are in `SHA256SUMS`. The original
absolute paths in `piperd.py` were changed to resolve beside this file; no
other behaviour changed.
