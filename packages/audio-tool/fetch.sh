#!/bin/sh
# Populate the parts of this repo that git deliberately does not carry:
# the pinned Piper binary and the default voice. Everything else (the queue,
# reply WAVs) is generated at runtime and needs no fetch.
#
# Safe to re-run: existing files are left alone, and every hash is verified
# against SHA256SUMS at the end.
set -eu
cd "$(dirname "$0")"

PIPER_URL=https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz
VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium

for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "fetch: missing required tool: $tool" >&2
        exit 1
    }
done

if [ ! -x piper/piper ]; then
    echo "fetch: piper binary (2023.11.14-2)"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL -o "$tmp/piper.tgz" "$PIPER_URL"
    tar xzf "$tmp/piper.tgz"          # extracts ./piper
    rm -rf "$tmp"
    trap - EXIT
fi

mkdir -p voices
if [ ! -f voices/voice.onnx ]; then
    echo "fetch: default voice (en_US-lessac-medium)"
    curl -fsSL -o voices/voice.onnx "$VOICE_URL/en_US-lessac-medium.onnx"
fi
if [ ! -f voices/voice.onnx.json ]; then
    curl -fsSL -o voices/voice.onnx.json "$VOICE_URL/en_US-lessac-medium.onnx.json"
fi

sha256sum -c SHA256SUMS

cat <<'EOF'

Optional voices (not pinned here; pick one tier per voice):
  https://huggingface.co/rhasspy/piper-voices/tree/main/en
  en_US/lessac/low|medium|high, en_GB/alan|alim, en_GB/cori,
  en_GB/northern_english_male (does NOT work with the 2023 binary)

Run the daemon and verify:
  python3 piperd.py --serve --drain &
  python3 audioq.py say "hello"
EOF
