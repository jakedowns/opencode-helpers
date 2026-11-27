#!/bin/sh
# Populate `piper-macos/` with a Piper binary this Mac can run.
#
# The 2023.11.14-2 release archives for macOS are unusable as published: both
# `piper_macos_aarch64.tar.gz` and `piper_macos_x64.tar.gz` contain an x86_64
# `piper` with no `libespeak-ng` / `libpiper_phonemize` / `libonnxruntime`
# beside it, so it aborts in dyld before writing a WAV. This script therefore
# prefers the Python `piper-tts` wheel (native arm64, self-contained) and keeps
# the release download as an opt-in (`PIPER_MACOS_RELEASE=1`) in case upstream
# ships a fixed archive later.
#
# Never writes to `piper/`, which is the Linux copy the VM uses.
set -eu
cd "$(dirname "$0")"

PIPER_VERSION=1.8.0
RELEASE_URL=https://github.com/rhasspy/piper/releases/download/2023.11.14-2
# Measured 2026-11-27; the release asset itself is broken, see header.
AARCH64_SHA=6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc
X64_SHA=ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b

MODEL="$(pwd)/voices/voice.onnx"
SMOKE=/tmp/opencode-piper-macos-smoke.wav

smoke() {
    rm -f "$SMOKE"
    printf 'macOS piper smoke test\n' | "$1" \
        --model "$MODEL" --output_file "$SMOKE" --length_scale 0.67 >/dev/null 2>&1 || return 1
    [ -s "$SMOKE" ] || return 1
    rm -f "$SMOKE"
    return 0
}

if [ -x piper-macos/piper ] && smoke piper-macos/piper; then
    echo "fetch-macos: piper-macos/piper already works"
    exit 0
fi

if [ ! -f voices/voice.onnx ]; then
    echo "fetch-macos: voices/voice.onnx is missing; run ./fetch.sh first" >&2
    exit 1
fi

if [ "${PIPER_MACOS_RELEASE:-0}" = "1" ]; then
    case "$(uname -m)" in
        arm64) ARCH=aarch64; SHA=$AARCH64_SHA ;;
        x86_64) ARCH=x64; SHA=$X64_SHA ;;
        *) echo "fetch-macos: unsupported arch $(uname -m)" >&2; exit 1 ;;
    esac
    echo "fetch-macos: release piper_macos_$ARCH (2023.11.14-2)"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL -o "$tmp/piper.tgz" "$RELEASE_URL/piper_macos_$ARCH.tar.gz"
    actual=$(shasum -a 256 "$tmp/piper.tgz" | awk '{print $1}')
    if [ "$actual" != "$SHA" ]; then
        echo "fetch-macos: sha256 mismatch for piper_macos_$ARCH.tar.gz" >&2
        echo "  expected $SHA" >&2
        echo "  actual   $actual" >&2
        exit 1
    fi
    tar xzf "$tmp/piper.tgz" -C "$tmp"
    rm -rf piper-macos
    mv "$tmp/piper" piper-macos
    rm -rf "$tmp"
    trap - EXIT
    xattr -d com.apple.quarantine piper-macos/piper 2>/dev/null || true
    chmod +x piper-macos/piper
    if smoke piper-macos/piper; then
        echo "fetch-macos: release build installed in piper-macos/"
        exit 0
    fi
    echo "fetch-macos: release build cannot run on this Mac; falling back to pip" >&2
    rm -rf piper-macos
fi

# Native fallback: the piper-tts wheel, wrapped by a stable `piper-macos/piper`
# path so piperd.py and the plugin can keep treating it like the release binary.
echo "fetch-macos: installing piper-tts==$PIPER_VERSION (Python wheel)"
python3 -m venv piper-macos/venv
piper-macos/venv/bin/python -m pip install --quiet --upgrade pip
piper-macos/venv/bin/python -m pip install --quiet "piper-tts==$PIPER_VERSION"

cat >piper-macos/piper <<'EOF'
#!/bin/sh
# Stable launcher for the pip-installed piper (no --json-input; piperd.py
# detects that and synthesises one process per request).
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/venv/bin/piper" "$@"
EOF
chmod +x piper-macos/piper

if ! smoke piper-macos/piper; then
    echo "fetch-macos: pip piper installed but wrote no WAV" >&2
    exit 1
fi

echo "fetch-macos: piper-tts $PIPER_VERSION installed in piper-macos/"
echo "  note: this build has no --json-input; piperd.py falls back to one-shot"
