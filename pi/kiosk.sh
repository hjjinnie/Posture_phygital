#!/usr/bin/env bash
# Opens the posture screen page full screen on the Pi's display.
# Chromium is "chromium" on Raspberry Pi OS Trixie and "chromium-browser" on Bookworm.
BROWSER="$(command -v chromium || command -v chromium-browser)"
# Wait for the server (it starts at boot alongside the desktop).
for _ in $(seq 30); do
  curl -sf -o /dev/null http://localhost:8790/ && break
  sleep 1
done
# Raspberry Pi OS's desktop is Wayland (labwc); say so, or Chromium may look for an X server.
PLATFORM=()
[ -n "${WAYLAND_DISPLAY:-}" ] && PLATFORM=(--ozone-platform=wayland)
exec "$BROWSER" "${PLATFORM[@]}" --kiosk --noerrdialogs --disable-infobars --no-first-run --password-store=basic \
  --disable-session-crashed-bubble --disable-features=Translate --check-for-update-interval=31536000 \
  --user-data-dir="$HOME/.config/posture-display-chromium" http://localhost:8790/
