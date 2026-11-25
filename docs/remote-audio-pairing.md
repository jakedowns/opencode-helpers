# Remote audio access — design sketch

Status: draft. Sections marked **(research pending)** are filled in from the
two research tracks: OpenCode's pairing implementation, and tunnel/QR options.

## Goal

Let the user listen to replies while away from the machine, without third-party
file upload, without hosting infrastructure, and without a sync service.

The audio file stays on this machine. The user reaches it over a tunnel that
they open, and authorises with a device key minted by a short-lived pairing
code. Links are private and expire; nothing is copied to a relay, and the
relay never holds the file.

## Requirements

1. **No upload.** The WAV is served from `output.directory`
   (`/media/share/tmp/audio/<project>`); no third party stores it.
2. **No self-hosting.** No always-on VPS, DNS zone, or certificate to renew.
   The tunnel is opened on demand and closed when done.
3. **One-time pairing.** A QR code carries a short-lived, single-use pairing
   code; scanning it mints a per-device key. Accepting a code invalidates it.
4. **Per-device identity.** Each paired phone has its own key, name, and
   revocation switch; revoking one does not disturb the others.
5. **Private by default.** Unauthenticated requests get no directory listing
   and no content — 404, not 401, so the server does not confirm what exists.
6. **Expiry everywhere.** Pairing codes and session tokens expire on a short
   clock; served links carry their own expiry and die with the tunnel/session.
7. **Works from a phone.** QR must be scannable from a terminal or a rendered
   image; the URL must be one tap.

## Non-goals

- Syncing the audio library between machines.
- Streaming live while synthesising (a reply is a finished file).
- Multi-user accounts; this is one person with several devices.

## Threat model (draft)

| Adversary | Sees | Mitigation |
|---|---|---|
| Tunnel/relay operator | TLS-terminated traffic if it terminates; otherwise SNI, sizes, timing | authenticate inside TLS where possible; unguessable paths; short TTL; no listing |
| Someone who photographs the QR | the pairing URL and code until first use | single use, ~2 min TTL, bound to the current tunnel session |
| Stolen/wiped phone | its own device key | per-device revocation; keys server-side, not derivable from a global secret |
| Network scanner | the tunnel hostname | no listing, 404 by default, auth required before any byte |

## Sketch

```
phone ──https──> tunnel endpoint ──> 127.0.0.1:PORT ──> file server
                                                        │
                                       serves only output.directory
                                       checks device key + link expiry
```

- **File server** (new, small, stdlib-only): binds `127.0.0.1`, serves GET for
  known `reply-*.wav` names only, honours `Range`, sets short `Cache-Control`.
- **Pairing**: `audioq.py pair` prints a URL + QR; the code is stored hashed
  with a TTL and a "used" flag; first successful redemption mints a device key.
- **Sessions**: device key exchanged for a session token (short TTL); tokens
  are what the phone actually sends.
- **Tunnel**: `(research pending)` — opentunnel class tool or fallback.
- **Integration**: `away` profile gains `tunnel: {...}`; the reply link is the
  tunnel URL for the file plus the session token, inline in the message.

## What OpenCode does (v2.3.2, read from the shipped binary)

OpenCode has no source checkout here; the pairing logic is minified but
readable JS embedded in `/home/ubuntu/.opencode/bin/opencode` (aarch64 ELF,
not stripped). Offsets: `~178.1 MB` session tokens, `~178.76 MB` pairing
service, `~123.4 MB` OpenAPI schema.

| Aspect | Implementation |
|---|---|
| Pairing code | `randomBytes(16).toString("base64url")` — 128 bits, 22 chars; no word list, no short code |
| Storage | in-memory Effect cache, capacity 1000; nothing in `opencode.db` |
| TTL | 5 minutes (minutes→ms helper `Ec(5)`) |
| Single use | `consume` invalidates the cache entry only on a successful lookup, so wrong guesses do not burn it |
| Attempt limits | none found in the read regions — TTL is the only limiter |
| Redeem | `server.connect(code)` → JSON `{token}` for API clients, or an httpOnly, sameSite=lax session cookie for `Accept: text/html` |
| Token | `<exp_unix>.<base64url(HMAC-SHA256(HMAC-SHA256(password,"opencode-session-v1"), exp))>`; expiry is inside the signed value, so verification is stateless |
| Token TTL | 30 days; matches the cookie `maxAge` |
| Device identity | **none** — every device derives the same token from the one server password; no registry, no per-device revocation |
| Revocation | change the server password, which invalidates all tokens at once |
| Transport | plain Node/Bun HTTP on the bound port; no TLS, no relay, no tunnel (the user supplies the network) |
| Cookie name | `opencode_session_<port>` (or `opencode_session`), so two local servers do not collide |

Reusable as-is: code and token are different objects (capability vs
credential), expiry is signed rather than stored, comparison is constant-time,
and the code survives failed guesses.

Worth improving on: no per-device identity or revocation, no attempt limiting,
and a 30-day bearer token is far too long for a link that is pasted into chat.

## Proposed protocol (v1)

Adopts OpenCode's shapes where they are sound, adds the per-device layer our
`away` profile needs, and keeps everything local.

### Pairing

1. `audioq.py pair` issues a **pairing code** with OpenCode's entropy:
   `secrets.token_urlsafe(16)` (128 bits, 22 URL-safe chars). Stored as
   `sha256(code)` with `created_at`, `expires_at = now + 300 s`, and the current
   tunnel instance id. The plaintext exists only in the QR/URL printed now.
2. The QR encodes `https://<tunnel>/pair#<code>`; the code rides in the URL
   fragment so it never appears in a relay's request line.
3. The phone POSTs the code to `/pair`. Constant-time compare; TTL; per-source
   failed-attempt counter (5 tries, then the code is burned — an improvement on
   OpenCode). On success the server mints a **device key**: 32 random bytes,
   returned once as base64url, stored only as `sha256(key)` with `device_id`,
   `name` ("phone-N" unless the client supplies one), `created_at`,
   `last_seen`.
4. Success burns the code. Failure is indistinguishable from an unknown or
   expired code (404), and is rate-limited per source address.

### Sessions

5. `POST /session` with `Authorization: Device <key>` returns a **session
   token** in OpenCode's format, with the device bound in:
   `<exp>.<base64url(HMAC-SHA256(HMAC-SHA256(server_secret, "audioq-session-v1"), device_id + ":" + exp))>`,
   TTL 15 min. Verification is stateless, and a deleted device row invalidates
   its tokens immediately.
6. File requests use `GET /a/<name>?t=<token>`. Tokens are reusable within the
   15-minute TTL (range requests), and die with the device, the secret, or the
   tunnel.
7. Files are served only when `<name>` matches `^reply-[A-Za-z0-9._-]+\.wav$`
   and resolves inside `output.directory` (no traversal, no symlink escape).
   No listing; unknown names and bad tokens both return 404.

### Storage

- `.dev/audio-pairing.json`, mode `0600`, git-ignored like the rest of `.dev/`:
  `{"devices": [{"id", "name", "key_sha256", "created_at", "last_seen"}]}`.
- Pairing codes live in memory only (like OpenCode): a restart expires them.
- The HMAC secret is a 32-byte file next to the device registry; rotating it
  logs every device out without unpairing.
- Devices persist until revoked; revocation deletes the row, which kills every
  token derived for it.

### CLI

```
audioq.py pair [--ttl 300] [--qr] [--name phone]   # print URL + QR, wait for use
audioq.py devices                                   # list, last seen, created
audioq.py revoke <device_id>                        # immediate, drops sessions
audioq.py serve [--tunnel auto|none|CMD]            # local server (+ tunnel)
```

`pair` blocks until the code is used or expires and then prints the new device,
so the user confirms it in the terminal where they can see it.

### Expiry rules

| Thing | TTL | Bound to |
|---|---|---|
| Pairing code | 300 s, single use, max 5 failed tries | tunnel instance |
| Device key | until revoked | one phone |
| Session token | 15 min, signed | device + server secret |
| File link | session token | the served file path |

## Tunnel

**(research pending)** — opentunnel class tool or fallback; must relay bytes
only, never store the file, and support TLS so the token is not sent in clear.

## Open questions

- What `opentunnel` is and whether it relays plaintext; aarch64 support.
- Best fallback tunnel that needs no account, and whether it can do TLS.
- Which QR tool is already installed; terminal rendering vs PNG.
