# Agent guide — opencode-audio-tool

How an agent uses this repo to speak replies aloud. Read this before
synthesising anything; the human-facing detail (pins, measurements, queue
internals) stays in `README.md`, and the portability notes in `REPOSITORY.md`.

## 1. Set up the reply config

Audio mode is per project and opt-in. It is driven by a JSONC file that
`audioq.py` resolves, in order, from `--config PATH`, `$AUDIOQ_CONFIG`, then
`./.dev/audiomode.jsonc` (relative to the **current directory**, not to this
repo). With no config, `say` still uses the default preamble template; set
`preamble.enabled: false` to speak without a prefix.

To enable it in a project:

```sh
cd /path/to/that/project
mkdir -p .dev
cp /media/share/opencode-audio-tool/audiomode.example.jsonc .dev/audiomode.jsonc
# edit: "tool.root" if this repo was cloned elsewhere, "preamble.session" if
# this project should use a fixed speaker name instead of "auto"
printf '\n.dev/\n' >> .gitignore     # if not already ignored
```

**`.dev/` must be git-ignored.** It records one user's preferences, not project
behaviour; committing it would ship someone's paths and speaker name to
everyone else. This repo ignores it too. The shared, reviewable copy is
`audiomode.example.jsonc` at the repo root — edit the template, not a
committed config.

Check the result without making noise:

```sh
cd /path/to/that/project
python3 /media/share/opencode-audio-tool/audioq.py say --dry-run "hello"
# -> "Agent Voice Tool, here: hello"
```

## 2. What the code reads, and what is advice

`audioq.py` reads **only** the `preamble` object:

| Key | Effect |
|---|---|
| `preamble.enabled` | `false` disables the prefix for this project |
| `preamble.session` | `"auto"` = OpenCode session title at speak time; a string pins the name |
| `preamble.template` | `{session}`, `{msg}`, `{text}`; a template without `{msg}` is a bare prefix |

Everything else in the config is a contract for the agent reading it: trigger
phrases, paths, output rules, reply format, playback and streaming commands,
fallbacks. They are not validated by any program, so follow them literally.
Two of them are load-bearing even though no code reads them:

- `output.directory` is the **durable** directory that the `**Audio:**` link
  must point at (`/media/share/tmp/audio/<project>` by default, so a cleanup in
  one project cannot break another's links). It can be the shared root
  `/media/share/tmp/audio` instead, if you put the project in the filename.
  `output.runtime_queue` is the ephemeral queue under `/tmp`, which a reboot
  may empty.
- `delivery.local_only` / `delivery.allow_remote_upload` decide whether a reply
  may leave the machine at all; uploads are off by default, and asking for one
  needs the user's explicit consent, per `delivery.if_upload_is_requested`.
  Remote listening is meant to work through the tunnel, not through an upload.

Per-call overrides beat the config:

```sh
audioq.py say --session "ogf-omi" "text"        # literal speaker
audioq.py say --preamble "{session}, here: {msg}" "text"
audioq.py say --no-preamble "text"              # skip the announcement
audioq.py say --dry-run "text"                  # print what would be spoken
```

## 3. Profiles (home / away)

`profiles.active` selects the situation; each profile overrides `playback`,
`streaming` and `delivery` by key, and inherits anything it does not mention
from the top-level sections. A direct instruction from the user beats the file.

| Profile | Local playback | Queue | Remote path | Link |
|---|---|---|---|---|
| `home` (default) | on, through the drainer | yes | none; `local_only: true` | bottom of the reply |
| `away` | off; no queueing, no streaming | no | on-demand tunnel to this machine (`tunnel.ttl_minutes`, default 30) | inline in the reply |

`away` exists because there is no speaker to feed and no reachable local path:
synthesise the WAV, publish it through the tunnel for a single expiring
session, and put that link inline. There is no upload: the file stays here and
the tunnel only forwards bytes. "Private" means TLS terminates on this machine
(opentunnel) or the file is reachable only inside the tailnet (Tailscale
`serve`); a provider that can decrypt the stream does not qualify. If no
tunnel can be opened, say so and ask — never fall back to a public upload or to
a local path the user cannot reach.

**This path is specified but not implemented yet.** Until `audioq.py share`
exists, `away` means text replies; see `docs/remote-audio-pairing.md` for the
protocol, the tunnel choice, and the back-port plan.

Switching: edit `profiles.active`, or just tell the agent "I'm away today".
Because no code reads this section, the agent must actually honour it — check
`profiles.active` before choosing between enqueue and tunnel.

## 4. Config versions

The config is a versioned pseudo-package, `opencode-audio-tool/cfg@N`, so a
future agent can tell whether a local copy still matches this repo.

| `version` | Date | Schema |
|---|---|---|
| 1 | 2026-11-25 | `name`, `version`, `scope`, `tool`, `trigger`, `delivery`, `toolchain`, `synthesis`, `output` (incl. `runtime_queue`), `preamble`, `reply_format`, `script_style`, `fallbacks`, `playback`, `streaming`, `daemon`, `gotchas`, `preferences_log` |
| 2 | 2026-11-25 | adds `profiles` (`active` + `home`/`away` overrides for `playback`, `streaming`, `delivery`, `link_style`); `output.directory` is per project by default |
| 3 | 2026-11-25 | adds `tunnel`; `away` serves over the tunnel and stops preferring uploads (`allow_remote_upload: false`) |
| 4 | 2026-11-26 | `output.format` (mp3 default), `output.mp3_bitrate`, `output.ffmpeg`, `output.retention` (14 days / 200 files) |
| 5 | 2026-11-26 | `synthesis.voice_per_session` and `synthesis.voices`; explicit `voice` on `voice_speak` |
| 6 | 2026-11-26 | `playback.speak_subagents` (false); parent session mutes cover subagents |
| 7 | 2026-11-26 | `output.retention.auto_purge_minutes` (30); sweeps run every 5 minutes |
| 8 | 2026-11-26 | `output.format: auto` (home = WAV, no encode); `link_format` m4a/96k for away; replay reuses archived WAV |

Rules:

- Bump `version` in the same commit that adds, removes, or changes the meaning
  of a key; note the reason in `preferences_log` and in the table above.
- Adding a purely informational section does not need a bump; changing what a
  key *means* does.
- An agent handed a config whose `version` is higher than this table should
  stop and ask, not guess. A lower one is fine: absent keys mean defaults.

## 5. Per-reply workflow

If `piper/piper` or `voices/voice.onnx` is missing, run `./fetch.sh` from the
repo root first; it downloads the pinned binary and default voice and verifies
their hashes.

```sh
REPO=/media/share/opencode-audio-tool
OUT=/media/share/tmp/audio/opencode-audio-tool/reply-topic-fast.wav

# 1. synthesise to a stable path (the path you will link)
printf '%s\n' "the transcript" | "$REPO/piper/piper" \
  --model "$REPO/voices/voice.onnx" --output_file "$OUT" --length_scale 0.67

# 2. enqueue that file (hardlink: the link keeps working after playback)
python3 "$REPO/audioq.py" enqueue "$OUT" --text "the transcript"

# or let the queue synthesise (item then moves to played/, so do not link it)
python3 "$REPO/audioq.py" say "the transcript"
```

Start the player once per session; `--serve --drain` runs the resident model
and the single drainer in one process:

```sh
python3 "$REPO/piperd.py" --serve --drain &
```

Check state with `audioq.py status` and `audioq.py list`.

Quote the audio at the bottom of the reply, with duration, speed and generation
time — no timestamps:

```
**Audio:** `/media/share/tmp/audio/opencode-audio-tool/reply-topic-fast.wav` (34.2 s · 1.5× · gen 1.8 s)
```

Never block the text reply on playback, and never treat a missing sound device
as an error in the reply.

Under the `away` profile, steps 2 and the drainer do not apply: skip
`enqueue`, do not start `--serve --drain`, and upload the WAV once through a
private, expiring link; put that link inline in the reply.

## 6. Queue etiquette (the invariants that matter)

- Exactly one drainer: a non-blocking `flock` on `<queue>/.drain.lock`; a second
  drainer prints one line and exits 0. Do not try to "help" by running another.
- One item plays at a time: the drainer holds `.play.lock` (and the legacy
  parent `.play.lock` when it exists). A direct `aplay` caller must take the
  same lock: `flock "$AUDIOQ_DIR/.play.lock" aplay -q FILE`.
- Synthesis completes before an item is visible, and a visible item is never
  rewritten. Enqueue is atomic; do not hand-place files in the queue.
- An item found in `playing/` at startup is moved to `failed/` and never
  replayed — a half-played reply must not repeat.
- `played/` keeps the newest 100, `drain.log` rotates at 1 MiB, stale `.part`
  files and orphan sidecars are cleaned. `failed/` is kept until
  `audioq.py clear --failed`.
- Several agents may produce at once; that is safe. Just do not share one
  output WAV path across concurrent replies.

## 7. Gotchas

- The binary is `piper/piper` (a directory named `piper` containing a binary
  named `piper`).
- Only voices from this 2023.11 generation work; `northern_english_male.onnx`
  crashes the binary with a phoneme-map error.
- `length_scale` is a startup flag, not per request; the daemon must be
  restarted to change speed. `0.67` ≈ 1.5× and is the agreed floor.
- `/tmp` is volatile: write the WAV you link to `output.directory`
  (`/media/share/tmp/audio/<project>`); `/tmp` holds only the queue.
- Keep replies to roughly 20–120 s; WAV is ~10 MB/min.
- `audioq.py` still defaults its one-shot fallback to
  `/media/share/linux-piper-helper`, so a clone at another path should either
  run the daemon (which resolves beside `piperd.py`) or export `PIPER_BIN` and
  `PIPER_MODEL` — see the note in `REPOSITORY.md`.

## 8. When audio mode is off

Reply in text. Do not synthesise "just in case", do not offer a WAV the user
did not ask for, and do not remind them every turn; the trigger phrases in the
config are the whole activation mechanism.
