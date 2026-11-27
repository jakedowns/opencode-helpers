# Plan — Mac host mode, local playback, runtime mode switch

Status: implemented on branch `mac-host-mode` (2026-11-27). The upstream macOS
release archive turned out to be broken (x86_64 binary, missing dylibs), so
`fetch-macos.sh` installs the native `piper-tts` wheel instead and `piperd.py`
falls back to one-shot synthesis when `--json-input` is absent. Companion to
`docs/remote-audio-pairing.md` and `plugin/PROPOSAL.md`.

Repo: `packages/audio-tool` in the `opencode-helpers` monorepo
(`/media/share/opencode-helpers`), also reachable at
`/media/share/opencode-audio-tool` (relative symlink, VM only; macOS does not
traverse it over SMB — use the canonical path on the Mac).

Working rule: **one session edits at a time.** The VM session and the Mac
session share this working tree; concurrent edits have already collided once
(a `stats` field appeared mid-edit and a `log` field was lost). Create a branch
on the Mac and tell the VM session to stop editing.

---

## Current state (do not rebuild)

- `packages/audio-tool/plugin` — server part with tools, auto-speak, RPC, host/client modes.
- **Local playback on the client** is implemented: panel switch "Play on this
  Mac (local cache)", flag in `.client-playback.json`, host skips enqueue while
  enabled, client copies new index entries to `~/.cache/opencode-audio-tool`
  and plays them with `afplay`.
- `mode` is resolved once at `setup`: `auto` = Linux with executable
  `piper/piper` → host, otherwise client. There is **no runtime switch**.
- The `piper/` directory holds the **Linux aarch64** binary; it cannot run on macOS.
- `AUDIO_ROOT` is hardcoded to `/media/share/tmp/audio` (cache/purge), which is
  invalid on macOS.

## Goal

1. Verify playback-on-Mac end to end.
2. Let the Mac synthesise + drain + (optionally) transcode, so the tool still
   works with the VM gone.
3. Add a runtime **host ↔ client** toggle in the panel.

---

## Phase 0 — verify playback-on-Mac (30 min)

1. On the Mac, set plugin options:

   ```jsonc
   {
     "root": "/Users/<you>/<share>/opencode-helpers/packages/audio-tool",
     "sharedRoot": "/Users/<you>/<share>",
     "mode": "client",
     "auto": true
   }
   ```

   `sharedRoot` maps index paths `/media/share/...` to the Mac's share view.
   Without it the plugin only derives the path when `root` ends with
   `/opencode-helpers/packages/audio-tool`.

2. Open the audio panel, enable **Play on this Mac**, generate a reply (VM tool
   call or `/voice-repeat`).
3. Expect: audio from the Mac speakers; `.voice-log.jsonl` gains `play ok …`;
   `~/.cache/opencode-audio-tool/` contains the file; VM queue stays empty
   (host skipped enqueue).

Acceptance: audible on the Mac with VM sink muted; log shows `play ok`.
If it logs `cannot map <path>`, the `sharedRoot` mapping is wrong — fix before
moving on.

---

## Phase 1 — macOS piper, host mode

### 1.1 `fetch-macos.sh`

New script beside `fetch.sh`:

- Download `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_aarch64.tar.gz`
  (verified HTTP 200; pick `piper_macos_x64.tar.gz` on Intel).
- Extract into **`piper-macos/`** — never over `piper/`, which is the Linux copy
  used by the VM.
- If macOS quarantines it: `xattr -d com.apple.quarantine piper-macos/piper`.
- Smoke test: `piper-macos/piper --model voices/voice.onnx --output_file /tmp/t.wav <<< "test"`.
- Add the archive's SHA-256 to `SHA256SUMS` once measured on the Mac (the Linux
  pin must stay).

### 1.2 `piperBin` option

In `plugin/index.ts`:

- Add `piperBin?: string` to `Options` and `ReplyConfig.synthesis`.
- Resolution order: option → `PIPER_BIN` → `root/piper/piper`.
- Use it in `speakDurable` (`spawn(piperBin, …)`) and pass
  `PIPER_BIN`/`PIPER_MODEL` in the environment of the daemon spawn.

`ensureDaemon` currently spawns `python3 piperd.py --serve --drain` with no env.
Add an `env` argument:

```ts
spawn("python3", [path.join(root, "piperd.py"), "--serve", "--drain"], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PIPER_BIN: piperBin,
    PIPER_MODEL: model,
    AUDIOQ_PLAYER: player,   // afplay on macOS
    AUDIOQ_DIR: queueDir,    // local queue on the Mac
    AUDIOQ_SOCK: sock,
  },
})
```

`piperd.py` already honours `PIPER_BIN`/`PIPER_MODEL`; `audioq.py` honours the
`AUDIOQ_*` variables.

### 1.3 Player and queue on the Mac

- Player: `afplay` (audioq's default is `aplay -q`, absent on macOS). Add a
  `player` option defaulting to `afplay` on `darwin`, `aplay -q` elsewhere.
- Queue: keep the per-machine default `/tmp/opencode/audio-replies/queue`; the
  shared `.voice-state.json`/index stay in `root`.
- Prerequisite: `python3` on the Mac (Xcode CLT usually provides it). Verify
  `python3 -c 'import wave'`. If missing, document `xcode-select --install`.

### 1.4 `AUDIO_ROOT` must be machine-local

Cache, sweep and replay currently use `/media/share/tmp/audio`. Refactor to a
function:

```ts
function audioRoot(opts: Options): string {
  if (opts.sharedRoot) return path.join(opts.sharedRoot, "tmp", "audio")
  return "/media/share/tmp/audio"
}
```

Pass it into `cacheUsage`, `purgeGenerated` and the retention timer. On the Mac
it becomes `<share>/tmp/audio`; on the VM it is unchanged.

### 1.5 Mode detection

Extend `resolveMode`: `auto` on `darwin` should resolve to **host** only if a
usable piper binary exists (option, `PIPER_BIN`, `piper-macos/piper`, or
`piper/piper` that is executable *for this OS*). Otherwise client. Do not probe
by executing on every setup — `accessSync(X_OK)` plus platform is enough; a
wrong-arch binary fails later with a clear "piper wrote no file" log.

### 1.6 Output format

Home profile keeps WAV, which `afplay` plays natively. Away links need a
transcoder: document `brew install ffmpeg` (or a portable static build) and let
`output.ffmpeg` point at it. Without it, away falls back to linking the WAV and
logs the failure.

### Phase 1 acceptance

- `mode: "host"` on the Mac: `voice_speak` produces `reply-*.wav` under
  `output.directory`, plays locally, and `.voice-log.jsonl` shows no errors.
- Daemon: one `piperd.py --serve --drain` process, socket answers; a second
  plugin instance does not spawn another (pid file).
- Retention: files older than 30 min disappear from the Mac's mapped audio root.
- Replay and purge work; `free space` is reported.

---

## Phase 2 — runtime host ↔ client toggle

### 2.1 Refactor setup around `applyMode`

Today `setup` branches once. Extract the mode-specific pieces:

```ts
let mode: ResolvedMode
let stopHost: (() => void) | undefined
let stopClient: (() => void) | undefined

function applyMode(next) {
  stopHost?.(); stopClient?.()
  mode = next
  if (next === "host") {
    stopHost = startHostPieces()   // watcher, retention timer, stats, daemon
  } else if (next === "client") {
    stopClient = startClientPlayback(...)
  }
}
```

Keep tools, hooks, RPC and command registration outside this function; they
must stay registered across switches. Replace the captured `const mode` in all
call sites with the `mode` variable (auto-speak branch, tool branch,
`voiceState` source).

### 2.2 Per-machine mode override

Do **not** reuse `.voice-state.json` (host stat writes clobber it — the
client-playback flag had exactly that bug). Add:

```
.mode-override.json   { "hosts": { "<hostname>": { "at": …, "mode": "host" | "client" | "auto" } } }
```

The plugin root is a shared folder, so the entry is keyed by hostname; each
machine reads only its own and writes it back without touching the other's.
- RPC `setMode { mode, directory, sessionID }` writes it, calls `applyMode`,
  returns state.
- State reports `mode`, `modeOverride`, and a `hostHeartbeat` (see below).

### 2.3 Panel switch

Under `Mode: …` in the audio panel, add a select/checkbox:
**Run as host on this machine** (off = client). Show the effective mode plus
where it came from (`option`, `override`, `auto`). Switching surfaces a toast if
the mode could not apply (e.g. host requested but no piper binary).

### 2.4 Avoid two active hosts

Both machines writing `.voice-state.json` is fine; both synthesising and playing
is not. Add to state on every host stats tick:

```json
"hostHeartbeat": { "machine": "<hostname>", "at": 179… }
```

Panel shows a warning when another heartbeat is younger than 15 s and mode is
host on both. Do not auto-disable; make it visible.

Nothing else coordinates hosts today — the queue lives on `/tmp` per machine,
so two hosts play independently.

---

## Phase 3 — docs and release

- Update `plugin/README.md` (host on macOS, `piperBin`, `player`, `sharedRoot`,
  cache dir, mode override), `AGENTS.md` if config keys change, `REPOSITORY.md`
  for `piper-macos/`.
- Bump the package patch version; tag `assistant-voice-opencode-plugin@x.y.z`;
  the release workflow builds TUI+GUI and publishes via trusted publishing.
- `.gitignore`: `piper-macos/`, `.mode-override.json`.

## Test matrix (Mac)

| Case | Expect |
|---|---|
| tool speak, home | WAV in output dir, local playback, log ok |
| `/voice-repeat` with text | replay plays |
| `/voice-repeat` on empty session | log `empty`, toast? (currently panel line only) |
| away profile + ffmpeg | m4a link, no local queue |
| retention 30 min | old files swept, cache number drops |
| purge old / all | counts reported |
| toggle client → host → client | daemon starts/stops, playback follows switch |
| daemon killed | one-shot fallback, restart backoff |

## Pitfalls already hit

- Two sessions editing the shared tree (lost `log`, surprise `stats`).
- `.voice-state.json` is rewritten by hosts; per-user flags belong in their own file.
- macOS/SMB does not follow the `opencode-audio-tool` symlink — use canonical paths.
- `piper/piper` is Linux; never overwrite it with the macOS build.
- `AUDIO_ROOT` hardcoding breaks any Mac-side retention/cache code.
- The audio daemon has different lifetimes by design; the pid file is in the
  queue dir, which is per machine.
