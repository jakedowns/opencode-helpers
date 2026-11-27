#!/bin/sh
# install-headless-service — run once as root in the guest:
#
#   sudo /media/share/opencode-helpers/packages/audio-tool/install-headless-service.sh
#
# Why: the voice plugin normally spawns piperd.py from whatever terminal or app
# opened it. That process lives in the graphical session's scope, so switching
# to headless kills it (and its logind ACL on /dev/snd goes away with the
# session). This installs the same daemon as a system service running as the
# guest user with the audio group, so it survives the desktop and can still
# open the sound card. The plugin sees the existing socket and does not spawn
# a duplicate.
set -eu

[ "$(id -u)" = "0" ] || {
    echo "run as root: sudo $0" >&2
    exit 1
}

ROOT=/media/share/opencode-helpers/packages/audio-tool
UNIT=/etc/systemd/system/opencode-piperd.service
LINGER_USER=${1:-ubuntu}
RUNTIME_DIR=/run/user/$(id -u "$LINGER_USER")

[ -x "$ROOT/piperd.py" ] || [ -f "$ROOT/piperd.py" ] || {
    echo "piperd.py not found under $ROOT" >&2
    exit 1
}

cat > "$UNIT" <<EOF
[Unit]
Description=Piper TTS daemon and reply queue drainer (headless-capable)
After=sound.target
Wants=sound.target

[Service]
Type=simple
User=$LINGER_USER
Group=$LINGER_USER
SupplementaryGroups=audio
Environment=HOME=/home/$LINGER_USER
Environment=XDG_RUNTIME_DIR=$RUNTIME_DIR
Environment="AUDIOQ_PLAYER=aplay -q"
ExecStart=/usr/bin/python3 $ROOT/piperd.py --serve --drain
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Stop the session-scoped daemon, if one is running, so the unit owns the
# socket. Remove its pid lock too: the plugin treats a live pid as "already
# running" and would skip its own liveness check.
systemctl stop opencode-piperd.service 2>/dev/null || true
pkill -u "$LINGER_USER" -f 'packages/audio-tool/piperd.py' 2>/dev/null || true
pkill -u "$LINGER_USER" -f 'packages/audio-tool/piper/piper' 2>/dev/null || true
sleep 1
rm -f /tmp/opencode/audio-replies/piperd.sock \
      /tmp/opencode/audio-replies/queue/.voice-plugin.pid

# The unit gets the audio group immediately via SupplementaryGroups=. Adding
# the user to the group as well lets pipewire/wireplumber open the card after
# the next boot, when no logind ACL exists.
usermod -aG audio "$LINGER_USER"

systemctl daemon-reload
systemctl enable --now opencode-piperd.service

systemctl --no-pager --lines=0 status opencode-piperd.service || true
echo
echo "installed. Verify the device access without a session:"
echo "  sudo -u $LINGER_USER sg audio -c 'aplay -l'"
echo "  systemctl status opencode-piperd"
