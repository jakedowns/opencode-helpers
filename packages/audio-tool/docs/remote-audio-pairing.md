# Remote audio access — design

Status: decided; implementation not started. Pairing was derived from
OpenCode v2.3.2 (read out of its shipped binary) and cross-checked against
what it deliberately leaves out; transport was chosen after comparing relayed
and tailnet options.

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
3. **TLS terminated here.** A relay may forward bytes; it must not be able to
   read them. That rules out certificate-terminating tunnels.
4. **One-time pairing.** A QR code carries a short-lived, single-use pairing
   code; scanning it mints a per-device key. Accepting a code invalidates it.
5. **Per-device identity.** Each paired phone has its own key, name, and
   revocation switch; revoking one does not disturb the others.
6. **Private by default.** Unauthenticated requests get no directory listing
   and no content — 404, not 401, so the server does not confirm what exists.
7. **Expiry everywhere.** Pairing codes and session tokens expire on a short
   clock; served links carry their own expiry and die with the tunnel/session.
8. **Works from a phone.** QR must be scannable from a terminal or a rendered
   image; the URL must be one tap.

## Non-goals

- Syncing the audio library between machines.
- Streaming live while synthesising (a reply is a finished file).
- Multi-user accounts; this is one person with several devices.

## Threat model

| Adversary | Sees | Mitigation |
|---|---|---|
| Tunnel/relay operator | SNI, sizes, timing. Content only if it terminates TLS | TLS terminated on this box (opentunnel / tailnet), so the file stays ciphertext; unguessable route; no listing |
| Someone who photographs the QR | the pairing URL and code until first use | single use, 5 min TTL, burned on success, bound to the tunnel instance |
| Stolen/wiped phone | its own device key | per-device revocation; keys stored hashed, not derivable from a global secret |
| Network scanner | the tunnel hostname | no listing, 404 by default, auth before any byte |
| Malicious page in a paired browser | the session token in the link | 15 min token, bound to one device, dies with the tunnel |

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
- **Tunnel**: opentunnel, TLS terminated here; Tailscale `serve` as fallback;
  expired by killing the process and removing the route.
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

The tunnel carries bytes and nothing else. The file never leaves the machine,
so the tunnel must not become a copy: no relay storage, no account-bound
"upload", and TLS terminated **on this box** so a relay operator cannot read
the WAV or the token.

### Primary: opentunnel

[github.com/anomalyco/opentunnel](https://github.com/anomalyco/opentunnel)
(MIT, Rust CLI, arm64 releases) is the right shape for this. Its public
endpoint reads only the TLS ClientHello and bridges the connection back to the
client over a WebSocket; **the leaf certificate's private key stays on this
machine**, so the relay sees SNI, sizes and timing but not content. Routes are
random 16-character names under `opentunnel.xyz`; traffic resolves to the
hosted bridge, not to a CDN that could terminate TLS.

Two things it deliberately does not do, and we supply both:

- **No authentication** — its own docs say anyone with the route URL can reach
  the target. Our pairing code and device keys are the auth layer.
- **No expiry** — routes live until removed. We kill the tunnel and the route
  with `timeout` plus an explicit `route remove`, so the exposure window equals
  the reply's session, and nothing outlives it.

Use the native arm64 binary, not the npm SDK: the SDK needs node ≥ 22 or Bun,
and this machine has node 18.

Stated risks: one maintainer, the repo does not accept pull requests, the npm
download figures contradict a one-day-old publish date, and the hosted bridge
is unverified end to end. Verify the privacy claim once, from outside, before
trusting it: if the leaf issuer seen through the tunnel is our ZeroSSL
certificate, TLS terminates here; if it is Cloudflare or Google Trust, the
relay can read everything.

### Fallback: Tailscale `serve`

No public surface at all: the phone joins the tailnet once (the app is the
"pairing"), and `tailscale serve` exposes the audio directory only to devices
in that tailnet, over WireGuard, with nothing reachable from the internet. It
is the strongest privacy option and needs no TTL, because the public internet
cannot address it. The cost is one app install and a tailnet login on the
phone, and it does not work through a browser-only device.

### Rejected for private audio

`cloudflared` quick tunnels, ngrok, localtunnel and pinggy all terminate TLS
at the provider, so the operator can read the WAV — they are content-visible
relays, not transport. `bore.pub` does not encrypt at all. Any of them is
acceptable only if the file is encrypted before it leaves (`openssl enc
-aes-256-cbc -pbkdf2`), which then needs a decrypting step on the phone.

### "Private" has to mean one thing

In the `away` profile, "private" means **TLS terminated on this machine**
(opentunnel) or **tailnet-only** (Tailscale) — not merely "unguessable URL".
A provider that can decrypt the stream does not qualify, however long its
token is.

## QR pairing

The QR encodes the pairing URL; the code travels in the URL fragment
(`...#<code>`), so it never reaches the tunnel in a request line, and the
first redemption burns it.

`qrencode` is **not installed** on this machine but is packaged for arm64
(`qrencode 4.1.1-1build2`); `pip`/`venv` do not bootstrap here, so apt is the
path of least resistance:

```sh
sudo apt install -y qrencode
qrencode -t ANSIUTF8 "https://<route>.opentunnel.xyz/pair#<code>"   # scannable off the screen
qrencode -o /tmp/pair.png -t PNG -s 6 "https://..."                 # or attach it
```

A QR code is an affordance, not a security boundary: anyone who photographs
the screen holds the code until it is used or expires (5 minutes, single use).
That is why the code is short-lived and burned on first success, and why the
device key it mints is what actually persists.

## Back-port plan

Everything below is additive to `audioq.py`; `say`, `enqueue` and the drainer
keep their current behaviour when no tunnel is in use.

| Phase | Work | Files | Done when |
|---|---|---|---|
| 1 | Local HTTP server: `GET`/`HEAD` only, `Range`, name whitelist `^reply-[A-Za-z0-9._-]+\.wav$`, resolves inside `output.directory`, cover 404 for everything else, binds `127.0.0.1` | `audioq.py` (or new `share.py`) | `curl` fetches a reply, `/` and `../etc/passwd` both 404, range requests resume |
| 2 | Device registry + pairing: hashed codes, 300 s TTL, burn on success, per-source attempt limit; `pair`, `devices`, `revoke`; `.dev/audio-pairing.json` mode 0600, secret beside it | `audioq.py` | second redeem of a code fails; revoked device's token stops working before its TTL |
| 3 | Session tokens: signed `<exp>.<hmac>` with device id, 15 min; `POST /session`; token accepted only for its device | `audioq.py` | tampered token rejected; expired token rejected; other device's token rejected |
| 4 | Tunnel control: `--tunnel opentunnel\|tailscale\|none`, spawn, wait for the route, print URL, kill and `route remove` on exit or `--ttl` | `audioq.py` | process exit leaves no live route; URL dies with it |
| 5 | QR: `qrencode -t ANSIUTF8` when present, PNG with `-o`, otherwise print the URL and the apt hint | `audioq.py` | scanning the terminal code opens the pairing page once |
| 6 | Config wiring: top-level `tunnel` section, `away` profile uses it; `audioq.py share FILE` prints the inline link for the transcript | `audiomode.example.jsonc`, `AGENTS.md` | `away` never uploads by default; `home` unchanged |

Tests: unit tests for token verify/expiry/revocation and for the path
whitelist; two simulated devices where one is revoked; a fake tunnel command
that records spawn/kill so CI never needs the network.

Out of scope for the first cut: a browser UI, multi-file browsing, uploads in
either direction, and any change to the queue or the preamble.


