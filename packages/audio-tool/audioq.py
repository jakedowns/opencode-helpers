#!/usr/bin/env python3
"""audioq — an atomic Piper reply queue and the one drainer that plays it.

Agents call ``audioq.py say`` instead of writing their own WAV and calling
aplay.  Synthesis is complete before an item becomes visible, enqueueing is
atomic, and a single drainer plays items in filename (FIFO) order.

Layout under the queue directory (default /tmp/opencode/audio-replies/queue):

    <id>.wav          ready to play
    <id>.json         text, created_at, pid, seconds, gen (written first)
    playing/          the one item currently being played
    played/           successful items, pruned to the newest 100
    failed/           failed items, each with <id>.err
    .drain.lock       held by the single drainer
    .play.lock        serialises playback with legacy aplay callers
    .dedupe.lock      only used when --dedupe is active
    drain.log         one line per action, rotated at 1 MiB
"""

import argparse
import contextlib
import fcntl
import json
import os
import secrets
import shutil
import sqlite3
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import wave

ROOT = "/media/share/linux-piper-helper"
# A clone elsewhere (or a Mac with the pip piper) exports these rather than
# editing the fallback path.
PIPER = os.environ.get("PIPER_BIN") or os.path.join(ROOT, "piper", "piper")
MODEL = os.environ.get("PIPER_MODEL") or os.path.join(ROOT, "voices", "voice.onnx")
LENGTH_SCALE = "0.67"

DEFAULT_QUEUE_DIR = "/tmp/opencode/audio-replies/queue"
DEFAULT_SOCK = "/tmp/opencode/audio-replies/piperd.sock"
DEFAULT_PLAYER = "afplay" if sys.platform == "darwin" else "aplay -q"

# Managed playback: the drainer publishes what it is playing and polls a small
# control file, so the panel can pause/resume/seek without owning the process.
CONTROL_NAME = ".playback-control.json"
PROGRESS_NAME = ".playing.json"
SEEK_DIR = ".seek"
PLAYER_POLL = 0.1
PROGRESS_INTERVAL = 0.5

POLL_SECONDS = 0.25
MAX_PLAYED = 100
LOG_MAX_BYTES = 1024 * 1024
PART_MAX_AGE = 6 * 60 * 60
ORPHAN_JSON_AGE = 60


# ---------------------------------------------------------------------------
# Small path/JSON helpers
# ---------------------------------------------------------------------------

def resolve_queue_dir(explicit=None):
    return os.path.abspath(explicit or os.environ.get("AUDIOQ_DIR") or DEFAULT_QUEUE_DIR)


def resolve_socket(explicit=None):
    return os.path.abspath(explicit or os.environ.get("AUDIOQ_SOCK") or DEFAULT_SOCK)


def ensure_queue(queue_dir):
    queue_dir = os.path.abspath(queue_dir)
    for sub in ("", "playing", "played", "failed"):
        os.makedirs(os.path.join(queue_dir, sub), exist_ok=True)
    return queue_dir


def sidecar_path(wav_path):
    return wav_path[:-4] + ".json" if wav_path.endswith(".wav") else wav_path + ".json"


# ---------------------------------------------------------------------------
# Preamble: announce which session/tab is speaking
#
# Multiple agents can share one Piper voice, so each reply opens with the
# speaker's name. The default template is "<session>, here: <msg>". The
# session name comes from the reply config (.dev/audiomode.jsonc, see
# load_reply_config) or, when it says "auto", from the OpenCode session title.
# ---------------------------------------------------------------------------

DEFAULT_PREAMBLE_TEMPLATE = "{session}, here: {msg}"
OPENCODE_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")


def _strip_jsonc(text):
    """Drop // and /* */ comments outside strings so json.loads can parse."""
    out = []
    i = 0
    n = len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def load_reply_config(explicit=None):
    """Load the JSONC reply config, default ./.dev/audiomode.jsonc.

    Returns {} when there is no config, so a project without one is unchanged.
    """
    path = explicit or os.environ.get("AUDIOQ_CONFIG")
    if not path:
        candidate = os.path.join(os.getcwd(), ".dev", "audiomode.jsonc")
        if os.path.exists(candidate):
            path = candidate
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return {}
    candidates = [raw, _strip_jsonc(raw)]
    candidates.append(candidates[-1].replace(",}", "}").replace(",]", "]"))
    for text in candidates:
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return {}


def opencode_session_title(session_id=None):
    """Title of the current OpenCode session, or None if it cannot be read."""
    sid = session_id or os.environ.get("OPENCODE_SESSION_ID")
    if not sid:
        return None
    db = os.environ.get("OPENCODE_DB") or OPENCODE_DB
    if not os.path.exists(db):
        return None
    try:
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=0.25)
        try:
            row = con.execute("select title from session_v2 where id = ?", (sid,)).fetchone()
        finally:
            con.close()
    except Exception:
        return None
    title = (row[0] or "").strip() if row else ""
    return title or None


def resolve_preamble(args, config):
    """Return the tone prefix for this reply, or None for none."""
    if getattr(args, "no_preamble", False):
        return None
    template = getattr(args, "preamble", None)
    session = getattr(args, "session", None)
    if template is None:
        section = config.get("preamble") if isinstance(config, dict) else None
        if isinstance(section, dict):
            if section.get("enabled", True) is False:
                return None
            template = section.get("template") or DEFAULT_PREAMBLE_TEMPLATE
            session = session or section.get("session")
        else:
            # No config at all is not an opt-out: announce the session with the
            # default template. `preamble.enabled: false` is the opt-out.
            template = DEFAULT_PREAMBLE_TEMPLATE
    if not template:
        return None
    if not session:
        session = opencode_session_title()
    if not session or str(session).lower() == "auto":
        session = opencode_session_title() or "audio"
    return template, session


def apply_preamble(text, args, config):
    """Prefix the spoken text with the speaker announcement."""
    resolved = resolve_preamble(args, config)
    if not resolved:
        return text
    template, session = resolved
    values = {"session": session, "title": session, "msg": text, "text": text}
    if "{msg}" in template or "{text}" in template:
        try:
            return template.format(**values)
        except (KeyError, IndexError, ValueError):
            return text
    template = template.rstrip()
    return ("%s %s" % (template, text)) if template else text


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else None
    except (OSError, ValueError):
        return None


def _write_json_atomic(path, obj):
    tmp = path + ".part"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _safe_unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _fsync_file(path):
    try:
        with open(path, "rb") as f:
            os.fsync(f.fileno())
    except OSError:
        pass


def wav_seconds(path):
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            return w.getnframes() / rate if rate else 0.0
    except (OSError, EOFError, wave.Error):
        return 0.0


def normalise_text(text):
    """Whitespace- and case-insensitive identity used only by --dedupe."""
    return " ".join(text.split()).casefold()


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------

def _synth_daemon(text, out, sock_path, timeout=30.0):
    deadline = time.monotonic() + timeout
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(sock_path)
        payload = json.dumps({"text": text, "out": os.path.abspath(out)}) + "\n"
        s.settimeout(max(0.001, deadline - time.monotonic()))
        s.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("daemon request timed out")
            s.settimeout(remaining)
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        if not buf:
            raise RuntimeError("daemon closed the connection without a reply")
        reply = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
        if not reply.get("ok"):
            raise RuntimeError(str(reply.get("error") or "daemon error"))
    finally:
        s.close()
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        raise RuntimeError("daemon reported success but wrote no WAV")


def _synth_oneshot(text, out):
    cmd = [PIPER, "--model", MODEL, "--output_file", os.path.abspath(out),
           "--length_scale", LENGTH_SCALE]
    proc = subprocess.run(
        cmd,
        input=text if text.endswith("\n") else text + "\n",
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if proc.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
        tail = (proc.stderr or "").strip().splitlines()
        detail = tail[-1] if tail else f"exit {proc.returncode}"
        raise RuntimeError(detail)


def _synthesise(text, queue_dir, item_id, sock_path, timeout=30.0):
    """Return (temp_wav, seconds, gen_seconds, via)."""
    started = time.time()
    daemon_tmp = os.path.join(queue_dir, item_id + ".daemon.part")
    oneshot_tmp = os.path.join(queue_dir, item_id + ".oneshot.part")
    daemon_error = None

    if sock_path and os.path.exists(sock_path):
        try:
            _synth_daemon(text, daemon_tmp, sock_path, timeout=timeout)
            seconds = wav_seconds(daemon_tmp)
            if seconds <= 0:
                raise RuntimeError("daemon wrote an empty or unreadable WAV")
            return daemon_tmp, seconds, time.time() - started, "daemon"
        except Exception as exc:  # timeout, refused socket, daemon error
            daemon_error = exc
            _safe_unlink(daemon_tmp)

    try:
        _synth_oneshot(text, oneshot_tmp)
        seconds = wav_seconds(oneshot_tmp)
        if seconds <= 0:
            raise RuntimeError("one-shot piper wrote an empty or unreadable WAV")
        return oneshot_tmp, seconds, time.time() - started, "oneshot"
    except Exception as exc:
        _safe_unlink(oneshot_tmp)
        raise RuntimeError(
            f"synthesis failed (daemon: {daemon_error}; one-shot: {exc})"
        ) from exc


# ---------------------------------------------------------------------------
# Dedupe
# ---------------------------------------------------------------------------

def _entry_for(base, wav, data, folder):
    return {
        "id": base,
        "path": wav,
        "folder": folder,
        "data": data or {},
    }


def _scan_sidecars(folder, norm, window=None):
    try:
        names = sorted(e.name for e in os.scandir(folder)
                       if e.is_file(follow_symlinks=False) and e.name.endswith(".json"))
    except FileNotFoundError:
        return None

    candidates = []
    for name in names:
        data = _read_json(os.path.join(folder, name))
        if not data:
            continue
        base = name[:-5]
        wav = os.path.join(folder, base + ".wav")
        if not os.path.isfile(wav):
            continue
        candidate_norm = data.get("norm") or normalise_text(str(data.get("text", "")))
        if candidate_norm != norm:
            continue
        if window is not None:
            try:
                if time.time() - os.path.getmtime(wav) > window:
                    continue
            except OSError:
                continue
        candidates.append(_entry_for(base, wav, data, folder))

    if not candidates:
        return None
    if folder.endswith(os.sep + "played") or os.path.basename(folder) == "played":
        def _mtime(c):
            try:
                return os.path.getmtime(c["path"])
            except OSError:
                return 0.0
        candidates.sort(key=_mtime, reverse=True)
    return candidates[0]


def find_duplicate(queue_dir, norm, window):
    """Return the most relevant already-queued/played entry, or None."""
    for folder in (os.path.join(queue_dir, "playing"),
                   queue_dir,
                   os.path.join(queue_dir, "played")):
        found = _scan_sidecars(folder, norm, window=window if folder.endswith("played") else None)
        if found:
            return found
    return None


def _deduped_result(entry):
    data = entry["data"]
    return {
        "id": entry["id"],
        "path": entry["path"],
        "seconds": round(float(data.get("seconds", 0.0)), 2),
        "gen": round(float(data.get("gen", 0.0)), 3),
        "deduped": True,
    }


@contextlib.contextmanager
def _file_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------

def enqueue(text, queue_dir=None, dedupe=0.0, sock_path=None, timeout=30.0):
    queue_dir = ensure_queue(resolve_queue_dir(queue_dir))
    sock_path = resolve_socket(sock_path) if sock_path is not None else resolve_socket()
    norm = normalise_text(text)

    if dedupe and dedupe > 0:
        found = find_duplicate(queue_dir, norm, float(dedupe))
        if found:
            return _deduped_result(found)

    # The work id only names temporary files; the final id is minted at the
    # moment of enqueue so filename order is enqueue order even when one
    # producer synthesises much more slowly than another.
    work_id = f"{time.time_ns():020d}-{os.getpid()}-{secrets.token_hex(3)}"
    tmp, seconds, gen, via = _synthesise(text, queue_dir, work_id, sock_path,
                                        timeout=timeout)

    def place():
        item_id = f"{time.time_ns():020d}-{os.getpid()}-{secrets.token_hex(3)}"
        final = os.path.join(queue_dir, item_id + ".wav")
        sidecar = os.path.join(queue_dir, item_id + ".json")
        data = {
            "text": text,
            "norm": norm,
            "created_at": time.time(),
            "pid": os.getpid(),
            "seconds": round(seconds, 3),
            "gen": round(gen, 3),
            "length_scale": float(LENGTH_SCALE),
            "via": via,
        }
        _write_json_atomic(sidecar, data)
        try:
            _fsync_file(tmp)
            os.replace(tmp, final)
        except BaseException:
            _safe_unlink(sidecar)
            raise
        return item_id, final

    try:
        if dedupe and dedupe > 0:
            # Close the check-then-enqueue race without holding the lock while
            # synthesising (the early check already avoided most duplicate work).
            with _file_lock(os.path.join(queue_dir, ".dedupe.lock")):
                found = find_duplicate(queue_dir, norm, float(dedupe))
                if found:
                    _safe_unlink(tmp)
                    return _deduped_result(found)
                item_id, final = place()
        else:
            item_id, final = place()
    except BaseException:
        _safe_unlink(tmp)
        raise

    return {
        "id": item_id,
        "path": final,
        "seconds": round(seconds, 2),
        "gen": round(gen, 3),
    }


# ---------------------------------------------------------------------------
# List / status / clear
# ---------------------------------------------------------------------------

def list_items(queue_dir=None):
    queue_dir = resolve_queue_dir(queue_dir)
    rows = []
    try:
        names = sorted(e.name for e in os.scandir(queue_dir)
                       if e.is_file(follow_symlinks=False) and e.name.endswith(".wav"))
    except FileNotFoundError:
        return rows
    for name in names:
        path = os.path.join(queue_dir, name)
        data = _read_json(sidecar_path(path)) or {}
        text = " ".join(str(data.get("text", "")).split())
        rows.append({
            "id": name[:-4],
            "seconds": round(float(data.get("seconds", wav_seconds(path))), 2),
            "text": text[:60],
        })
    return rows


def queue_status(queue_dir=None, sock_path=None):
    queue_dir = resolve_queue_dir(queue_dir)
    sock_path = resolve_socket(sock_path) if sock_path is not None else resolve_socket()

    def count(sub):
        folder = os.path.join(queue_dir, sub) if sub else queue_dir
        try:
            return sum(1 for e in os.scandir(folder)
                       if e.is_file(follow_symlinks=False) and e.name.endswith(".wav"))
        except FileNotFoundError:
            return 0

    return {
        "queued": count(""),
        "playing": count("playing"),
        "played": count("played"),
        "failed": count("failed"),
        "socket": sock_path,
        "socket_exists": os.path.exists(sock_path),
    }


def clear_queue(queue_dir=None, failed=False, played=False):
    queue_dir = resolve_queue_dir(queue_dir)
    removed = {}
    for sub, enabled in (("failed", failed), ("played", played)):
        if not enabled:
            continue
        folder = os.path.join(queue_dir, sub)
        n = 0
        try:
            entries = list(os.scandir(folder))
        except FileNotFoundError:
            entries = []
        for entry in entries:
            if not entry.is_file(follow_symlinks=False):
                continue
            try:
                os.unlink(entry.path)
                n += 1
            except OSError:
                pass
        removed[sub] = n
    return removed


# ---------------------------------------------------------------------------
# Drainer
# ---------------------------------------------------------------------------

def _log(queue_dir, line):
    path = os.path.join(queue_dir, "drain.log")
    try:
        if os.path.exists(path) and os.path.getsize(path) >= LOG_MAX_BYTES:
            os.replace(path, path + ".1")
    except OSError:
        pass
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{stamp} {line}\n")
    except OSError:
        pass


def _sorted_wavs(folder):
    try:
        return sorted(e.name for e in os.scandir(folder)
                      if e.is_file(follow_symlinks=False) and e.name.endswith(".wav"))
    except FileNotFoundError:
        return []


def _cleanup_orphans(queue_dir):
    """Remove old abandoned .part files and sidecars whose WAV never appeared."""
    now = time.time()
    for sub in ("", "playing"):
        folder = os.path.join(queue_dir, sub) if sub else queue_dir
        try:
            entries = list(os.scandir(folder))
        except FileNotFoundError:
            continue
        for entry in entries:
            if not entry.is_file(follow_symlinks=False):
                continue
            try:
                age = now - entry.stat(follow_symlinks=False).st_mtime
            except OSError:
                continue
            if entry.name.endswith(".part") and age > PART_MAX_AGE:
                _safe_unlink(entry.path)
            elif sub == "" and entry.name.endswith(".json") and age > ORPHAN_JSON_AGE:
                wav = os.path.join(queue_dir, entry.name[:-5] + ".wav")
                if not os.path.exists(wav):
                    _safe_unlink(entry.path)


def _claim(queue_dir, name):
    src = os.path.join(queue_dir, name)
    dst = os.path.join(queue_dir, "playing", name)
    try:
        os.replace(src, dst)
    except FileNotFoundError:
        return None
    json_name = name[:-4] + ".json"
    try:
        os.replace(os.path.join(queue_dir, json_name),
                   os.path.join(queue_dir, "playing", json_name))
    except FileNotFoundError:
        pass
    return dst


def _finish(queue_dir, name, sub, error=None):
    base = name[:-4]
    for ext in (".wav", ".json"):
        src = os.path.join(queue_dir, "playing", base + ext)
        dst = os.path.join(queue_dir, sub, base + ext)
        try:
            os.replace(src, dst)
        except FileNotFoundError:
            continue
        if ext == ".wav" and sub == "played":
            try:
                os.utime(dst, None)  # mtime is the playback time for pruning
            except OSError:
                pass
    if error:
        try:
            with open(os.path.join(queue_dir, "failed", base + ".err"),
                      "w", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {error}\n")
        except OSError:
            pass


def _recover_playing(queue_dir):
    """Never replay an item that a previous drainer may have partly played."""
    for name in _sorted_wavs(os.path.join(queue_dir, "playing")):
        _finish(queue_dir, name, "failed",
                error="stale playing item from a previous drainer")
        _log(queue_dir, f"stale {name[:-4]}")


def _prune_played(queue_dir):
    folder = os.path.join(queue_dir, "played")
    try:
        entries = [e for e in os.scandir(folder) if e.is_file(follow_symlinks=False)]
    except FileNotFoundError:
        return
    groups = {}
    newest = {}
    for entry in entries:
        base = entry.name.rsplit(".", 1)[0]
        groups.setdefault(base, []).append(entry.name)
        try:
            mt = entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            mt = 0.0
        newest[base] = max(newest.get(base, 0.0), mt)

    order = sorted(groups, key=lambda base: newest[base], reverse=True)
    for base in order[MAX_PLAYED:]:
        for name in groups[base]:
            _safe_unlink(os.path.join(folder, name))
        _log(queue_dir, f"prune {base}")


def _play_lock_paths(queue_dir):
    """The queue lock, plus the legacy parent lock when one already exists.

    The old audiomode command locked /tmp/opencode/audio-replies/.play.lock,
    while the queue lives one level below it.  Taking both (only if the legacy
    file is already present) keeps new and old callers from overlapping.
    """
    paths = [os.path.join(queue_dir, ".play.lock")]
    legacy = os.path.join(os.path.dirname(queue_dir), ".play.lock")
    if os.path.isfile(legacy) and os.path.abspath(legacy) not in paths:
        paths.append(legacy)
    return sorted(paths)


def _read_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else None
    except (OSError, ValueError):
        return None


def _progress_path(queue_dir):
    """Where the currently-playing item is published.

    `AUDIOQ_PROGRESS_FILE` lets a host write to the shared folder so clients
    that cannot see its /tmp queue can still render the position.
    """
    return os.environ.get("AUDIOQ_PROGRESS_FILE") or os.path.join(queue_dir, PROGRESS_NAME)


def _write_progress(path, payload):
    try:
        _write_json_atomic(path, payload)
    except OSError:
        pass


def _trim_wav(src, start_seconds, dest):
    """Write `src` from `start_seconds` to `dest`, header included."""
    with wave.open(src, "rb") as reader:
        params = reader.getparams()
        rate = reader.getframerate()
        total = reader.getnframes()
        first = max(0, min(total, int(max(0.0, start_seconds) * rate)))
        reader.setpos(first)
        frames = total - first
        with wave.open(dest, "wb") as writer:
            writer.setparams(params)
            writer.writeframes(reader.readframes(frames))
    return frames / float(rate) if rate else 0.0


def _stop_player(proc):
    """Terminate a player that may be paused (SIGSTOP blocks SIGTERM)."""
    try:
        proc.send_signal(signal.SIGCONT)
    except OSError:
        pass
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _cleanup_seeks(queue_dir):
    folder = os.path.join(queue_dir, SEEK_DIR)
    try:
        entries = list(os.scandir(folder))
    except FileNotFoundError:
        return
    cutoff = time.time() - PART_MAX_AGE
    for entry in entries:
        try:
            if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                _safe_unlink(entry.path)
        except OSError:
            continue


def _play(queue_dir, wav, player, dry_run=False):
    if dry_run:
        return 0, ""
    if isinstance(player, (list, tuple)):
        cmd = list(player)
    else:
        cmd = shlex.split(player or "")
    if not cmd:
        return 127, "no player configured"

    control_path = os.path.join(queue_dir, CONTROL_NAME)
    progress_path = _progress_path(queue_dir)
    meta = _read_json_file(sidecar_path(wav)) or {}
    try:
        total = float(meta.get("seconds") or 0)
    except (TypeError, ValueError):
        total = 0.0
    if total <= 0:
        total = wav_seconds(wav) or 0.0
    seek_dir = os.path.join(queue_dir, SEEK_DIR)

    fds = []
    proc = None
    temp = None
    try:
        for lock_path in _play_lock_paths(queue_dir):
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
            fds.append(fd)
        for fd in fds:
            fcntl.flock(fd, fcntl.LOCK_EX)

        offset = 0.0
        started = time.time()
        paused_total = 0.0
        paused_at = None
        ack = 0.0
        last_publish = 0.0
        try:
            proc = subprocess.Popen(
                cmd + [wav], stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, text=True)
        except OSError as exc:
            return 127, str(exc)

        while True:
            rc = proc.poll()
            now = time.time()
            base = paused_at if paused_at is not None else now
            position = offset + max(0.0, base - started - paused_total)
            if total > 0:
                position = min(position, total)
            if now - last_publish >= PROGRESS_INTERVAL or rc is not None:
                _write_progress(progress_path, {
                    "at": int(now * 1000),
                    "file": wav,
                    "source": str(meta.get("source") or wav),
                    "session": str(meta.get("session") or ""),
                    "seconds": round(total, 3),
                    "position": round(position, 3),
                    "paused": paused_at is not None,
                    "offset": round(offset, 3),
                    "ack": int(ack),
                })
                last_publish = now
            if rc is not None:
                break

            control = _read_json_file(control_path)
            try:
                stamp = float(control.get("at") or 0) if control else 0.0
            except (TypeError, ValueError):
                stamp = 0.0
            if control and stamp > ack:
                ack = stamp
                action = str(control.get("action") or "")
                if action == "pause" and paused_at is None:
                    try:
                        proc.send_signal(signal.SIGSTOP)
                        paused_at = time.time()
                    except OSError:
                        pass
                elif action == "resume" and paused_at is not None:
                    try:
                        proc.send_signal(signal.SIGCONT)
                        paused_total += time.time() - paused_at
                        paused_at = None
                    except OSError:
                        pass
                elif action == "seek":
                    try:
                        target = float(control.get("position") or 0)
                    except (TypeError, ValueError):
                        target = 0.0
                    target = max(0.0, min(total, target)) if total > 0 else max(0.0, target)
                    was_paused = paused_at is not None
                    _stop_player(proc)
                    os.makedirs(seek_dir, exist_ok=True)
                    if temp:
                        _safe_unlink(temp)
                    temp = os.path.join(
                        seek_dir, f"seek-{os.getpid()}-{int(time.time() * 1000)}.wav")
                    try:
                        _trim_wav(wav, target, temp)
                        proc = subprocess.Popen(
                            cmd + [temp], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True)
                    except (OSError, wave.Error) as exc:
                        # Seeking failed (foreign/odd WAV): restart from the top
                        # rather than dropping the reply on the floor.
                        _safe_unlink(temp)
                        temp = None
                        target = 0.0
                        try:
                            proc = subprocess.Popen(
                                cmd + [wav], stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, text=True)
                        except OSError as exc2:
                            return 127, f"seek failed ({exc}); restart failed ({exc2})"
                    offset = target
                    started = time.time()
                    paused_total = 0.0
                    paused_at = None
                    if was_paused:
                        # Seeking a paused reply keeps it paused at the new spot.
                        try:
                            proc.send_signal(signal.SIGSTOP)
                            paused_at = time.time()
                        except OSError:
                            pass
            time.sleep(PLAYER_POLL)

        rc = proc.wait()
        err = ""
        try:
            err = (proc.stderr.read() or "").strip()
        except (OSError, ValueError):
            pass
        if rc == 0:
            return 0, ""
        lines = err.splitlines()
        return rc, (lines[-1] if lines else f"exit {rc}")[:500]
    finally:
        if temp:
            _safe_unlink(temp)
        _safe_unlink(progress_path)
        # Commands are per-item; a leftover pause must not freeze the next one.
        _safe_unlink(control_path)
        try:
            os.rmdir(seek_dir)
        except OSError:
            pass
        for fd in reversed(fds):
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)


def drain(queue_dir=None, player=None, once=False, dry_run=False, stop_event=None):
    """Drain the queue in filename order until stopped, or once if requested.

    A non-blocking flock on <queue>/.drain.lock makes this the only drainer.
    Returns 0 in every normal case, including 'another drainer is running'.
    """
    queue_dir = ensure_queue(resolve_queue_dir(queue_dir))
    if player is None:
        player = os.environ.get("AUDIOQ_PLAYER") or DEFAULT_PLAYER

    lock_path = os.path.join(queue_dir, ".drain.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"audioq: another drainer already holds {lock_path}; exiting")
            return 0

        stop = stop_event if stop_event is not None else threading.Event()
        old_handlers = []
        if threading.current_thread() is threading.main_thread():
            def _on_signal(_signum, _frame):
                stop.set()
            for sig in (signal.SIGTERM, signal.SIGINT):
                try:
                    old_handlers.append((sig, signal.signal(sig, _on_signal)))
                except (OSError, ValueError):
                    pass

        try:
            _cleanup_orphans(queue_dir)
            _cleanup_seeks(queue_dir)
            _recover_playing(queue_dir)
            _prune_played(queue_dir)

            while not stop.is_set():
                names = _sorted_wavs(queue_dir)
                if not names:
                    if once:
                        break
                    stop.wait(POLL_SECONDS)
                    continue

                for name in names:
                    if stop.is_set():
                        break
                    if _claim(queue_dir, name) is None:
                        continue
                    item_id = name[:-4]
                    if dry_run:
                        _log(queue_dir, f"dry-run {item_id}")
                        _finish(queue_dir, name, "played")
                    else:
                        rc, err = _play(queue_dir,
                                        os.path.join(queue_dir, "playing", name),
                                        player)
                        if rc == 0:
                            _log(queue_dir, f"played {item_id}")
                            _finish(queue_dir, name, "played")
                        else:
                            _log(queue_dir, f"failed {item_id} rc={rc} {err}")
                            _finish(queue_dir, name, "failed",
                                    error=f"rc={rc} {err}")
                    _prune_played(queue_dir)

                if once:
                    break
                if not stop.is_set():
                    stop.wait(POLL_SECONDS)
        finally:
            for sig, handler in old_handlers:
                try:
                    signal.signal(sig, handler)
                except (OSError, ValueError):
                    pass
        return 0
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(lock_fd)


def enqueue_file(path, queue_dir=None, text="", dedupe=0.0, gen=0.0, session=None):
    """Queue an existing WAV without moving or copying its original.

    The queue entry is a hardlink where the filesystem allows it, so the
    caller keeps a stable path for the reply link while the drainer plays and
    archives the queued name.
    """
    src = os.path.abspath(path)
    if not os.path.isfile(src):
        raise SystemExit(f"audioq: no such file: {src}")
    with wave.open(src) as w:
        seconds = w.getnframes() / w.getframerate()
    queue_dir = ensure_queue(resolve_queue_dir(queue_dir))
    norm = normalise_text(text)
    if dedupe and dedupe > 0 and norm:
        found = find_duplicate(queue_dir, norm, float(dedupe))
        if found:
            return _deduped_result(found)

    item_id = f"{time.time_ns():020d}-{os.getpid()}-{secrets.token_hex(3)}"
    final = os.path.join(queue_dir, item_id + ".wav")
    tmp = final + ".part"
    try:
        os.link(src, tmp)
        via = "hardlink"
    except OSError:
        shutil.copy2(src, tmp)
        via = "copy"
    sidecar = os.path.join(queue_dir, item_id + ".json")
    data = {
        "text": text,
        "norm": norm,
        "created_at": time.time(),
        "pid": os.getpid(),
        "seconds": round(seconds, 3),
        "gen": round(gen, 3),
        "length_scale": float(LENGTH_SCALE),
        "via": via,
        "source": src,
        "session": session or "",
    }
    _write_json_atomic(sidecar, data)
    try:
        _fsync_file(tmp)
        os.replace(tmp, final)
    except BaseException:
        _safe_unlink(sidecar)
        _safe_unlink(tmp)
        raise
    return {
        "id": item_id,
        "path": final,
        "source": src,
        "seconds": round(seconds, 2),
        "queued": True,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _add_queue_arg(parser):
    parser.add_argument("--queue-dir", default=None,
                        help="queue directory (default: $AUDIOQ_DIR or "
                             + DEFAULT_QUEUE_DIR + ")")


def _cmd_say(args):
    if args.file:
        if args.text is not None:
            raise SystemExit("audioq: give TEXT or --file, not both")
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    else:
        if args.text is None:
            raise SystemExit("audioq: say requires TEXT or --file PATH")
        text = args.text
    text = text.strip()
    if not text:
        raise SystemExit("audioq: refusing to enqueue empty text")

    config = load_reply_config(getattr(args, "config", None))
    text = apply_preamble(text, args, config)
    if getattr(args, "dry_run", False):
        print(text)
        return 0

    result = enqueue(
        text,
        queue_dir=args.queue_dir,
        dedupe=args.dedupe,
        sock_path=args.socket,
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def _cmd_enqueue(args):
    result = enqueue_file(args.path, queue_dir=args.queue_dir,
                          text=args.text or "", dedupe=args.dedupe,
                          session=getattr(args, "session", None))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def _cmd_list(args):
    for row in list_items(args.queue_dir):
        print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    return 0


def _cmd_status(args):
    print(json.dumps(queue_status(args.queue_dir, args.socket),
                     ensure_ascii=False, separators=(",", ":")))
    return 0


def _cmd_clear(args):
    if not (args.failed or args.played):
        raise SystemExit("audioq: clear requires --failed and/or --played")
    removed = clear_queue(args.queue_dir, failed=args.failed, played=args.played)
    print(json.dumps({"cleared": removed}, separators=(",", ":")))
    return 0


def _cmd_drain(args):
    return drain(args.queue_dir, args.player, once=args.once, dry_run=args.dry_run)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="audioq.py",
        description="Atomic Piper reply queue with exactly one drainer.")
    sub = parser.add_subparsers(dest="command", required=True)

    say = sub.add_parser("say", help="synthesise and enqueue one reply")
    say.add_argument("text", nargs="?", help="text to speak")
    say.add_argument("--file", metavar="PATH", help="read text from PATH")
    say.add_argument("--dedupe", type=float, default=0.0, metavar="SECONDS",
                     help="skip text already queued or played within SECONDS")
    say.add_argument("--socket", default=None,
                     help="daemon socket (default: $AUDIOQ_SOCK or " + DEFAULT_SOCK + ")")
    say.add_argument("--preamble", metavar="TEMPLATE",
                     help="speaker prefix template, e.g. '{session}, here: {msg}' "
                          "(default: from .dev/audiomode.jsonc)")
    say.add_argument("--session", metavar="NAME",
                     help="speaker name for the preamble; 'auto' = OpenCode session title")
    say.add_argument("--no-preamble", action="store_true",
                     help="speak the text without the speaker announcement")
    say.add_argument("--config", metavar="PATH",
                     help="JSONC reply config (default: $AUDIOQ_CONFIG or ./.dev/audiomode.jsonc)")
    say.add_argument("--dry-run", action="store_true",
                     help="print the text that would be spoken and exit")
    _add_queue_arg(say)
    say.set_defaults(func=_cmd_say)

    enq = sub.add_parser("enqueue", help="queue an existing WAV without re-synthesising")
    enq.add_argument("path", help="path to an existing WAV")
    enq.add_argument("--text", default="", help="transcript for the sidecar")
    enq.add_argument("--session", default=None,
                     help="speaking session title, stored in the sidecar")
    enq.add_argument("--dedupe", type=float, default=0.0, metavar="SECONDS")
    _add_queue_arg(enq)
    enq.set_defaults(func=_cmd_enqueue)

    lst = sub.add_parser("list", help="list queued items in play order")
    _add_queue_arg(lst)
    lst.set_defaults(func=_cmd_list)

    status = sub.add_parser("status", help="show queue counts and daemon socket state")
    status.add_argument("--socket", default=None,
                        help="daemon socket to report on")
    _add_queue_arg(status)
    status.set_defaults(func=_cmd_status)

    clear = sub.add_parser("clear", help="remove failed or played items")
    clear.add_argument("--failed", action="store_true", help="remove failed/")
    clear.add_argument("--played", action="store_true", help="remove played/")
    _add_queue_arg(clear)
    clear.set_defaults(func=_cmd_clear)

    dr = sub.add_parser("drain", help="run the queue drainer")
    dr.add_argument("--once", action="store_true", help="drain what is queued, then exit")
    dr.add_argument("--dry-run", action="store_true", help="log actions without playing")
    dr.add_argument("--player", default=None,
                    help="player command (default: $AUDIOQ_PLAYER or 'aplay -q')")
    _add_queue_arg(dr)
    dr.set_defaults(func=_cmd_drain)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
