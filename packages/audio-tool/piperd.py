#!/usr/bin/env python3
"""piperd — keep the Piper model resident and synthesise on demand.

The CLI loads the model on every invocation (measured: ~0.2 s of the ~0.27 s
wall time for a one-word clip). A long-lived process with `--json-input` loads
it once and writes one WAV per request.

Protocol (newline-delimited JSON over a Unix socket):
    {"text": "...", "out": "/abs/path.wav"}  ->  {"ok": true, "seconds": 3.2}

The same process can also own the reply queue drainer:

    python3 piperd.py --serve --drain          # daemon + one drainer thread
    python3 piperd.py --drain                  # foreground drainer
    python3 piperd.py --drain --once --dry-run # inspect a queue safely

Plain `python3 piperd.py` still runs the original three-request self-test.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import wave

BASE = os.path.dirname(os.path.abspath(__file__))
PIPER = os.environ.get("PIPER_BIN") or os.path.join(BASE, "piper", "piper")
MODEL = os.environ.get("PIPER_MODEL") or os.path.join(BASE, "voices", "voice.onnx")
SOCK = "/tmp/opencode/audio-replies/piperd.sock"


class PiperDaemon:
    def __init__(self, length_scale="0.67"):
        self.proc = subprocess.Popen(
            [PIPER, "--model", MODEL, "--json-input", "--length_scale", length_scale],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, text=True, bufsize=1)
        self.done = 0
        self.cv = threading.Condition()
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        for line in self.proc.stderr:
            if "Real-time factor" in line:
                with self.cv:
                    self.done += 1
                    self.cv.notify_all()

    def synth(self, text, out):
        with self.cv:
            target = self.done + 1
        self.proc.stdin.write(json.dumps({"text": text, "output_file": out}) + "\n")
        self.proc.stdin.flush()
        with self.cv:
            if not self.cv.wait_for(lambda: self.done >= target, timeout=120):
                raise TimeoutError("synthesis did not finish")
        with wave.open(out) as w:
            return w.getnframes() / w.getframerate()


def _supports_json_input():
    """True when this piper build has the resident `--json-input` protocol.

    The 2023 Linux build does; the Python `piper` wheel (the working macOS
    install) does not. Probing once at startup keeps the daemon available on
    both instead of spawning a piper that exits immediately.
    """
    try:
        proc = subprocess.run(
            [PIPER, "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=30)
    except Exception:
        return False
    return proc.returncode == 0 and "--json-input" in (proc.stdout or "")


class OneShotPiper:
    """Same socket protocol, one piper process per request.

    Slower than the resident model (the wheel reloads onnxruntime each time)
    but it is the only option for builds without `--json-input`.
    """

    def __init__(self, length_scale="0.67"):
        self.length_scale = length_scale

    def synth(self, text, out):
        proc = subprocess.run(
            [PIPER, "--model", MODEL, "--output_file", out,
             "--length_scale", self.length_scale],
            input=text if text.endswith("\n") else text + "\n",
            text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=120)
        if proc.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
            tail = (proc.stderr or "").strip().splitlines()
            raise RuntimeError(tail[-1] if tail else f"piper exited {proc.returncode}")
        with wave.open(out) as w:
            return w.getnframes() / w.getframerate()


def serve(daemon, sock=SOCK):
    parent = os.path.dirname(sock)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.exists(sock):
        os.unlink(sock)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock)
    srv.listen(4)
    while True:
        conn, _ = srv.accept()
        with conn, conn.makefile("rw") as f:
            for line in f:
                try:
                    req = json.loads(line)
                    secs = daemon.synth(req["text"], req["out"])
                    f.write(json.dumps({"ok": True, "seconds": round(secs, 2)}) + "\n")
                except Exception as e:
                    f.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
                f.flush()


def _selftest():
    import time
    d = PiperDaemon()
    for i, text in enumerate(["First request.", "Second request.", "Third request."], 1):
        out = f"/tmp/opencode/audio-replies/daemon-{i}.wav"
        t0 = time.time()
        secs = d.synth(text, out)
        print(f"request {i}: {time.time()-t0:.3f}s wall, {secs:.1f}s audio")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="piperd.py",
        description="Resident Piper daemon and/or reply-queue drainer.")
    parser.add_argument("--serve", action="store_true",
                        help="serve the Unix-socket synthesis protocol")
    parser.add_argument("--drain", action="store_true",
                        help="run the audioq drainer (foreground unless --serve)")
    parser.add_argument("--once", action="store_true",
                        help="with the drainer: drain what is queued, then exit")
    parser.add_argument("--dry-run", action="store_true",
                        help="with the drainer: log actions instead of playing")
    parser.add_argument("--queue-dir", default=None,
                        help="audioq queue directory (default: $AUDIOQ_DIR)")
    parser.add_argument("--player", default=None,
                        help="player command (default: $AUDIOQ_PLAYER or 'aplay -q')")
    parser.add_argument("--socket", default=None,
                        help="daemon socket for --serve (default: " + SOCK + ")")
    args = parser.parse_args(argv)

    wants_drain = args.drain or args.once or args.dry_run

    if args.serve:
        daemon = PiperDaemon() if _supports_json_input() else OneShotPiper()
        if wants_drain:
            from audioq import drain, resolve_queue_dir
            threading.Thread(
                target=drain,
                kwargs={
                    "queue_dir": resolve_queue_dir(args.queue_dir),
                    "player": args.player,
                    "once": args.once,
                    "dry_run": args.dry_run,
                },
                name="audioq-drain",
                daemon=True,
            ).start()
        serve(daemon, args.socket or os.environ.get("AUDIOQ_SOCK") or SOCK)
        return 0

    if wants_drain:
        from audioq import drain, resolve_queue_dir
        return drain(resolve_queue_dir(args.queue_dir), args.player,
                     once=args.once, dry_run=args.dry_run)

    # Original behaviour: `python3 piperd.py` with no args is the self-test.
    _selftest()
    return 0


if __name__ == "__main__":
    sys.exit(main())
