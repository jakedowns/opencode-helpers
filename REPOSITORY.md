# opencode-audio-tool

A self-contained copy of the Piper helper and the queue, for other agents and machines.

## Layout

```
audioq.py        client + drainer (say / enqueue / list / status / clear / drain)
piperd.py        resident daemon; paths now resolve relative to this directory
piper/           pinned binary (2023.11.14-2 build)
voices/          model files, including the pinned voice.onnx
audio-replies/   snapshot of the live queue from /tmp/opencode/audio-replies
```

`audio-replies/queue/` holds the runtime format: items waiting, `playing/`,
`played/`, `failed/`, and `drain.log`. Sockets and lock files are not archived.

## Run

```sh
python3 audioq.py say "hello"
python3 piperd.py --serve --drain      # one process: daemon + single drainer
python3 audioq.py status
```

Paths can be overridden with `PIPER_BIN`, `PIPER_MODEL`, `AUDIOQ_DIR`,
`AUDIOQ_SOCK`, and `AUDIOQ_PLAYER`.

## Provenance

Copied from `/media/share/linux-piper-helper` and `/tmp/opencode/audio-replies`
on 2026-11-24. Binary and voice hashes are in `SHA256SUMS`. The original
absolute paths in `piperd.py` were changed to resolve beside this file; no
other behaviour changed.
