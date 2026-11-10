#!/usr/bin/env bash
# Sets up a Raspberry Pi (Raspberry Pi OS with desktop) as the Posture Flower screen. No sudo needed:
#   - posture_display.py runs as a user service (port 8790), started with your login
#   - Chromium opens the full-screen screen page when the desktop starts
# Run on the Pi from this folder:  ./install.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$DIR/kiosk.sh" "$DIR/posture_display.py"

echo "Installing the display server as a user service…"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/posture-display.service" <<UNIT
[Unit]
Description=Posture Flower display server

[Service]
ExecStart=/usr/bin/python3 $DIR/posture_display.py
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable posture-display.service
systemctl --user restart posture-display.service

echo "Adding the full-screen page to the desktop's autostart…"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/posture-display.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Posture Flower display
Exec=$DIR/kiosk.sh
DESKTOP

echo "Hiding the mouse pointer when the screen page opens…"
# labwc reads ~/.config/labwc/rc.xml instead of the system one, so start from a copy of the system file.
RC="$HOME/.config/labwc/rc.xml"
mkdir -p "$(dirname "$RC")"
[ -f "$RC" ] || cp /etc/xdg/labwc/rc.xml "$RC"
python3 - "$RC" <<'PY'
import sys
path = sys.argv[1]
xml = open(path).read()
if "posture-display" not in xml:
    # Chromium gets the pointer only after it moves, so park it in a corner and hide it when the page opens.
    rule = """    <!-- posture-display: no mouse pointer on the Posture Flower screen -->
    <windowRule identifier="chromium*">
      <action name="WarpCursor" to="output" x="-1" y="-1" />
      <action name="HideCursor" />
    </windowRule>
"""
    if "</windowRules>" in xml:
        xml = xml.replace("</windowRules>", rule + "  </windowRules>", 1)
    else:
        xml = xml.replace("</openbox_config>", "  <windowRules>\n" + rule + "  </windowRules>\n</openbox_config>", 1)
    open(path, "w").write(xml)
PY
labwc --reconfigure 2>/dev/null || true   # applies now if the desktop is running

echo
echo "Done. The server is $(systemctl --user is-active posture-display.service)."
echo "The screen page opens by itself when the desktop starts; to open it now, run:  $DIR/kiosk.sh &"
