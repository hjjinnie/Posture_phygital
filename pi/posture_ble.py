#!/usr/bin/env python3
"""Bluetooth LE link: lets the app reach the Pi's screen without any network.

The Pi shows up as "Posture Buddy" (a BLE GATT peripheral, via BlueZ over D-Bus). The app (Chrome or Edge, Web Bluetooth)
writes the posture the visual should show ~30 times a second, plus the screen settings when they change; this passes
each write on to posture_display.py (UDP on this machine), which hands it to the screen page, which draws the visual
itself (live.js). Once a second it reads how the screen page is doing from posture_display.py and notifies the app.

  STATE   write without response   20 bytes: int16 LE x10, see live.js (decoded only there)
  CONFIG  write                     4 bytes: visual index, orientation index, brightness x10, 0
  STATUS  read, notify              6 bytes: uint8 fps, uint16 LE width, uint16 LE height, uint8 screens

Standard library plus python3-dbus and python3-gi, both part of Raspberry Pi OS with desktop. Runs as the desktop user.
"""
import json, socket, struct, sys, time, urllib.request

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

NAME = "Posture Buddy"
SERVICE = "8f6a0001-5c1e-4f0a-9b8e-7f2a3c4d5e60"
STATE = "8f6a0002-5c1e-4f0a-9b8e-7f2a3c4d5e60"
CONFIG = "8f6a0003-5c1e-4f0a-9b8e-7f2a3c4d5e60"
STATUS = "8f6a0004-5c1e-4f0a-9b8e-7f2a3c4d5e60"
DISPLAY = ("127.0.0.1", 8789)                  # posture_display.py's relay for the screen page
STATS_URL = "http://127.0.0.1:8790/stats"

BLUEZ = "org.bluez"
OM = "org.freedesktop.DBus.ObjectManager"
PROPS = "org.freedesktop.DBus.Properties"
GATT_SERVICE = "org.bluez.GattService1"
GATT_CHRC = "org.bluez.GattCharacteristic1"
ADVERT = "org.bluez.LEAdvertisement1"
ROOT = "/org/bluez/posturebuddy"

udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
counts = {"state": 0, "config": 0}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class NotSupported(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = dbus.ObjectPath(ROOT)
        self.services = []
        super().__init__(bus, self.path)

    @dbus.service.method(OM, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        objs = {}
        for s in self.services:
            objs[s.path] = s.properties()
            for c in s.chars:
                objs[c.path] = c.properties()
        return objs


class Service(dbus.service.Object):
    def __init__(self, bus, uuid):
        self.path = dbus.ObjectPath(ROOT + "/service0")
        self.uuid, self.chars = uuid, []
        super().__init__(bus, self.path)

    def properties(self):
        return {GATT_SERVICE: {"UUID": self.uuid, "Primary": True,
                               "Characteristics": dbus.Array([c.path for c in self.chars], signature="o")}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.properties()[GATT_SERVICE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, service, uuid, flags, on_write=None):
        self.path = dbus.ObjectPath(f"{service.path}/char{len(service.chars)}")
        self.service, self.uuid, self.flags, self.on_write = service, uuid, flags, on_write
        self.value, self.notifying = b"", False
        super().__init__(bus, self.path)
        service.chars.append(self)

    def properties(self):
        return {GATT_CHRC: {"Service": self.service.path, "UUID": self.uuid, "Flags": dbus.Array(self.flags, signature="s")}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.properties()[GATT_CHRC]

    @dbus.service.method(GATT_CHRC, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        if "read" not in self.flags:
            raise NotSupported()
        return dbus.Array(self.value, signature="y")

    @dbus.service.method(GATT_CHRC, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        if not self.on_write:
            raise NotSupported()
        self.on_write(bytes(value))

    @dbus.service.method(GATT_CHRC)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC)
    def StopNotify(self):
        self.notifying = False

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    def set_value(self, value):
        self.value = value
        if self.notifying:
            self.PropertiesChanged(GATT_CHRC, {"Value": dbus.Array(value, signature="y")}, [])


class Advertisement(dbus.service.Object):
    def __init__(self, bus):
        self.path = dbus.ObjectPath(ROOT + "/advert0")
        super().__init__(bus, self.path)

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return {"Type": "peripheral", "ServiceUUIDs": dbus.Array([SERVICE], signature="s"), "LocalName": NAME}

    @dbus.service.method(ADVERT)
    def Release(self):
        log("advertisement released")


def forward(kind):
    def on_write(data):
        counts[kind] += 1
        udp.sendto((b"S" if kind == "state" else b"C") + data, DISPLAY)
        if kind == "config":
            log("settings", list(data))
    return on_write


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path = next((p for p, ifs in dbus.Interface(bus.get_object(BLUEZ, "/"), OM).GetManagedObjects().items()
                         if "org.bluez.GattManager1" in ifs and "org.bluez.LEAdvertisingManager1" in ifs), None)
    if not adapter_path:
        log("no Bluetooth LE adapter found"); sys.exit(1)
    adapter = bus.get_object(BLUEZ, adapter_path)
    props = dbus.Interface(adapter, PROPS)
    try:
        if not props.Get("org.bluez.Adapter1", "Powered"):
            props.Set("org.bluez.Adapter1", "Powered", dbus.Boolean(True))
    except dbus.exceptions.DBusException as e:
        log("couldn't power on Bluetooth:", e.get_dbus_message())

    app = Application(bus)
    svc = Service(bus, SERVICE)
    Characteristic(bus, svc, STATE, ["write-without-response", "write"], forward("state"))
    Characteristic(bus, svc, CONFIG, ["write"], forward("config"))
    status = Characteristic(bus, svc, STATUS, ["read", "notify"])
    status.value = bytes(6)
    app.services.append(svc)
    advert = Advertisement(bus)

    loop = GLib.MainLoop()
    fail = lambda what: (lambda e: (log(f"{what} failed:", e.get_dbus_message()), loop.quit()))
    dbus.Interface(adapter, "org.bluez.GattManager1").RegisterApplication(
        app.path, {}, reply_handler=lambda: log("Bluetooth service ready"),
        error_handler=fail("registering the service"))
    dbus.Interface(adapter, "org.bluez.LEAdvertisingManager1").RegisterAdvertisement(
        advert.path, {}, reply_handler=lambda: log(f'advertising as "{NAME}"'), error_handler=fail("advertising"))

    last = {"t": time.monotonic(), "state": 0}

    def poll_status():
        try:
            with urllib.request.urlopen(STATS_URL, timeout=0.3) as r:
                s = json.load(r)
            live = s.get("live") or {}
            status.set_value(struct.pack("<BHHB", min(255, round(live.get("fps", 0))), live.get("w", 0), live.get("h", 0),
                                         min(255, s.get("liveScreens", 0))))
        except Exception:
            pass
        now = time.monotonic()
        if now - last["t"] >= 10:
            rate = (counts["state"] - last["state"]) / (now - last["t"])
            if rate:
                log(f"receiving {rate:.1f} updates/s")
            last.update(t=now, state=counts["state"])
        return True

    GLib.timeout_add(1000, poll_status)
    # If bluetoothd restarts, our registration is gone: exit and let systemd start us again.
    bus.watch_name_owner(BLUEZ, lambda owner: owner or (log("bluetoothd went away"), loop.quit()))
    loop.run()
    sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
