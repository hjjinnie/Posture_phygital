#!/usr/bin/env bash
# Keeps the USB-cable network from running out of addresses. Run once on the Pi:  sudo bash fix-usb-net.sh
#
# rpi-usb-gadget gives the Pi 10.12.194.1/28 and hands out only 12 addresses (10.12.194.3–14), each held for an
# hour. Every time the Pi restarts or is plugged into a computer, that computer shows up with a new hardware address and
# takes another one, so after a dozen replugs or moves between laptops the Pi answers every computer with
# "no address available" and the cable network stays dead until old leases expire. Worse, the Pi has no clock battery:
# after a power cut its clock can jump backwards, so old leases can look current for hours or days.
#
# This widens the pool to 240 addresses, holds each for 2 minutes, and forgets old leases at every boot.
# The Pi stays at 10.12.194.1.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }
CONN="USB Gadget (shared)"
LEASES=/var/lib/NetworkManager/dnsmasq-usb0.leases

nmcli connection modify "$CONN" ipv4.addresses 10.12.194.1/24 \
  ipv4.shared-dhcp-range 10.12.194.10,10.12.194.250 ipv4.shared-dhcp-lease-time 120
echo "r $LEASES" > /etc/tmpfiles.d/posture-usb-leases.conf   # removed at every boot
rm -f "$LEASES"
echo "USB network: 240 addresses, 2-minute leases, old leases cleared at boot."

# rpi-usb-gadget's switcher (rpi-usb-gadget-ics) is what brings the cable network up at boot, so it must stay on.
# (An earlier version of this script turned it off, which left the link dead after the next restart: undo that.)
systemctl enable --now rpi-usb-gadget-ics.service >/dev/null 2>&1 || true

# Apply now. This briefly drops the cable link (and an ssh session over it), so do it a moment after this script ends.
systemd-run --quiet --on-active=2 /bin/sh -c "nmcli connection down 'USB Gadget (client)' 2>/dev/null; nmcli connection up '$CONN'"
echo "Restarting the USB network in 2 s; the computer reconnects by itself within a few seconds."
