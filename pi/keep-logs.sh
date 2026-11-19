#!/usr/bin/env bash
# Keep the Pi's system log across restarts (Raspberry Pi OS keeps it in memory only), then restart to test the link.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
mkdir -p /etc/systemd/journald.conf.d /var/log/journal
cat > /etc/systemd/journald.conf.d/90-posture-persistent.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
EOF
systemctl restart systemd-journald
journalctl --flush
echo "Logs are now kept across restarts. Restarting the Pi in 2 s to test the cable link..."
systemd-run --quiet --on-active=2 systemctl reboot
