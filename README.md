# linux-piper-helper

A durable home for local text-to-speech. Nothing here is required by the OMI
project; it exists so that audio replies survive a reboot and a fresh clone.

**Why not `/tmp`:** the first version lived in `/tmp/opencode/piper` and broke on
every reboot — the script was durable, its dependencies were not. This directory
is on `/media/share` (105 GB free at install) and holds the binary, the voices,
and the daemon together.

## Layout

```
linux-piper-helper/
  piper/            extracted piper 2023.11.14-2 (binary + bundled libs + espeak-ng data)
  voices/           *.onnx and *.onnx.json, one pair per voice
  piperd.py         resident-model daemon (json-input, unix socket)
  audioq.py         atomic reply queue + the single drainer that plays it
```

Size on disk: ~522 MB.

## Pins

| Item | Version | SHA-256 |
|---|---|---|
| `piper/piper` | piper 2023.11.14-2, linux aarch64 static | `0c44a6360a21367b5d03b8656c3e274f4de715f6533245d8c1f17c242631912b` |
| `voices/voice.onnx` | en_US-lessac-medium | `5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f` |

Voice source: `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx` (plus `.onnx.json`).

## Voices present

| File | Language / accent | Notes |
|---|---|---|
| `voice.onnx` | en_US, female | default; medium tier |
| `alan.onnx` | en_GB, male | medium |
| `cori.onnx` | en_GB, female | **high** tier, ~109 MB, ~6× slower |
| `lessac-low.onnx` | en_US, female | low tier; only ~15% faster than medium |
| `lessac-high.onnx` | en_US, female | high tier |
| `northern_english_male.onnx` | en_GB, male | **incompatible — crashes** (see below) |

## Usage

```sh
# one file
cat reply.txt | ./piper/piper --model voices/voice.onnx \
  --output_file /tmp/opencode/audio-replies/x.wav --length_scale 0.67

# streaming playback: start hearing before synthesis ends
cat reply.txt | ./piper/piper --model voices/voice.onnx --output_raw --length_scale 0.67 \
  | tee raw.pcm | aplay -q -f S16_LE -r 22050 -c 1

# resident daemon
python3 piperd.py --serve &          # unix socket: /tmp/opencode/audio-replies/piperd.sock
python3 piperd.py                    # self-test, three requests
```

`0.67` ≈ 1.5× playback. Measured on 4 cores: RTF ~0.07 for medium, ~0.34 for high.

## Queue

Several agents can synthesise at once. Writing one shared WAV and calling
`aplay` directly lets two replies overlap, or lets the next reply overwrite a
file while it is still playing. `audioq.py` fixes that with an atomic enqueue
and exactly one drainer.

**Preferred: synthesise to the stable reply path, then enqueue that file.**

```sh
Q=/media/share/linux-piper-helper/audioq.py
OUT=/tmp/opencode/audio-replies/reply-topic-fast.wav
python3 "$Q" enqueue "$OUT" --text "the transcript"
# -> {"id":"...","path":".../queue/....wav","source":"...reply-topic-fast.wav","seconds":72.78,"queued":true}
```

The queue entry is a hardlink where the filesystem allows it (copy otherwise),
so the `**Audio:**` link keeps working after the drainer archives its own name.
The original file is never moved.

**Or let the queue synthesise**, when no stable link is needed:

```sh
python3 "$Q" say "The queue is working."
python3 "$Q" say --file /tmp/opencode/audio-replies/reply.txt
```

`say` uses the resident daemon when its socket answers (30 s timeout), otherwise
falls back to one-shot `piper/piper`. It prints exactly one JSON line; the
spoken text is not duplicated on stdout. A `say` item lives in the queue and
then moves to `played/`, so do not use its path as the reply link.

Other commands:

```sh
python3 "$Q" list                      # JSONL, filename/play order
python3 "$Q" status                    # queued/playing/played/failed + socket_exists
python3 "$Q" enqueue FILE --text "..."  # queue an existing WAV (link survives)
python3 "$Q" clear --failed            # delete failed/ (also --played)
python3 "$Q" drain --once              # drain what is queued now
python3 "$Q" drain                     # foreground drainer (cron/systemd)
python3 piperd.py --drain              # same drainer, from the daemon script
python3 piperd.py --serve --drain      # one long-lived process, drainer thread
```

Flags: `--dedupe SECONDS` skips text already queued, or played within the
window, and prints the existing id with `"deduped": true`; `--queue-dir` /
`AUDIOQ_DIR` move the queue; `AUDIOQ_PLAYER` changes the player (default
`aplay -q`); `AUDIOQ_SOCK` / `--socket` select the daemon socket. Drainer flags
are `--once`, `--dry-run`, `--queue-dir`, `--player`.

Items live under `$AUDIOQ_DIR` (default `/tmp/opencode/audio-replies/queue`):

```
<id>.wav + <id>.json   queued, FIFO by filename
playing/               the item currently being played
played/                successful items, newest 100 kept by mtime
failed/                failures, each with <id>.err
drain.log              one line per action, rotated at 1 MiB
```

`<id>` is a zero-padded `time.time_ns()`, pid, and six random hex characters, so
producers never collide. The WAV is written as `.part`, its JSON sidecar is
installed first, and only then is the WAV renamed into place: a visible WAV
always has its text. A visible item is never rewritten.

**Single-drainer guarantee:** a non-blocking `flock` on `<queue>/.drain.lock`
lets exactly one drainer run; a second prints one line and exits 0. The drainer
renames the WAV into `playing/` before playback, so it cannot be claimed twice,
then moves it to `played/` or `failed/`. Playback itself also holds
`<queue>/.play.lock`; a legacy direct-`aplay` caller should use that same lock
(e.g. `flock "$AUDIOQ_DIR/.play.lock" aplay -q FILE`) to avoid overlapping with
the queue. If the old parent lock (`/tmp/opencode/audio-replies/.play.lock`)
already exists, the drainer holds that too, so the audiomode template serialises
without being edited.

Retention is bounded: `played/` is pruned to 100, `drain.log` rotates at 1 MiB,
and stale `.part`/orphan sidecars are cleaned by the drainer. `failed/` is kept
until `clear --failed`.

## Speaker preamble

Several agent sessions can share one Piper voice, so a reply can announce who
is speaking. `audioq.py say` prefixes the text when a reply config is present:

```
Portal Test Chamber regression test, here: the sweep finished
```

The config is JSONC, taken from `--config PATH`, `$AUDIOQ_CONFIG`, or
`./.dev/audiomode.jsonc` (in that order). With no config, nothing is prefixed.

```jsonc
"preamble": {
  "enabled": true,
  // "auto" = the OpenCode session title for $OPENCODE_SESSION_ID,
  // read from ~/.local/share/opencode/opencode.db at speak time.
  "session": "auto",
  // {session} = speaker, {msg} = reply text. No {msg} -> bare prefix.
  "template": "{session}, here: {msg}"
}
```

Overrides, per call:

```
audioq.py say --session "ogf-omi" "text"      # literal speaker
audioq.py say --preamble "{session}, here: {msg}" "text"
audioq.py say --no-preamble "text"            # skip the announcement
audioq.py say --dry-run "text"                # print what would be spoken
```

The session title is resolved on the command line, never stored, so renaming a
tab changes the announcement. A project that wants a fixed name sets
`"session"` to a literal string.

## Measured

| Operation | Time |
|---|---|
| Per-call model load | ~0.2 s of ~0.27 s wall for a tiny clip |
| Daemon steady state | 0.077–0.090 s per request |
| Daemon first request after cold cache | up to ~5.8 s |
| First streamed audio | ~0.52 s for a 32 s clip |

## Gotchas

1. **The path is `piper/piper`.** The tarball extracts a directory named `piper` containing a binary named `piper`; `/tmp/opencode/piper/piper` is a directory. This caused one `EACCES` debugging round.
2. **Voice/binary compatibility.** Newer voice models ship a newer phoneme map and crash this 2023 binary: `northern_english_male` fails with `"aɪ" is not a single codepoint (phoneme id map)`. Voices must match the binary generation, or piper must be upgraded.
3. **`length_scale` is a startup flag**, not per-request; changing speed means restarting the daemon.
4. **No thread or quality flags.** The whole option set is model, length/noise scales, sentence silence, speaker id, raw output. Speed comes from model tier.
5. **WAV needs its final length**, so a file only finalises when synthesis ends; stream with `--output_raw` and wrap afterwards if both are wanted.

## Reinstall

```sh
mkdir -p /media/share/linux-piper-helper/{piper,voices} && cd /media/share/linux-piper-helper
curl -sSL -o p.tgz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz
tar xzf p.tgz && rm p.tgz
V=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
curl -sSL -o voices/voice.onnx "$V/en_US-lessac-medium.onnx"
curl -sSL -o voices/voice.onnx.json "$V/en_US-lessac-medium.onnx.json"
sha256sum piper/piper voices/voice.onnx   # compare against the pins above
```

A compatibility symlink exists at `/tmp/opencode/piper` for old commands; it does not survive a reboot and nothing depends on it.
