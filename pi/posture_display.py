#!/usr/bin/env python3
"""Shows the posture visual on the Raspberry Pi's HDMI screen.

Two ways in:
  USB cable (or Wi-Fi): the computer renders each frame and sends it here as a JPEG over a WebSocket
    (ws://<pi>:8790/source). The full-screen Chromium page on the Pi (http://localhost:8790/) picks up the newest frame
    from ws://localhost:8790/screen and draws it, so decoding and scaling use the Pi's GPU.
  Bluetooth: posture_ble.py receives the posture and screen settings and passes each message here (UDP on this
    machine, port 8789); the screen page gets them from ws://localhost:8790/live and draws the visual itself (live.js,
    with the app's visuals from ../src and three.js from vendor/).

Standard library only, so nothing needs installing (the Pi often has no internet over USB).
"""
import asyncio, base64, hashlib, json, os, struct, sys, time

PORT = int(os.environ.get("POSTURE_DISPLAY_PORT", 8790))
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_MESSAGE = 8 << 20
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

latest = None                 # newest JPEG from the Mac
latest_id = 0
new_frame = asyncio.Event()
screens = set()
screen_stats = {"fps": 0.0, "drawMs": 0.0}   # plus width/height once a screen reports them

# Bluetooth path: the newest settings and posture, and the screen pages drawing them.
LIVE_PORT = 8789
live_screens = set()
live_last = {}                # b"C" -> newest settings message, b"S" -> newest posture message
live_stats = {"fps": 0.0, "w": 0, "h": 0}

# Files the screen page loads for the Bluetooth path: its own script, three.js, and the app's visuals.
ROOT = os.path.dirname(HERE)
STATIC = {"/live.js": os.path.join(HERE, "live.js")}
for name in ("visuals.js", "blob.js", "ema.js"):
    STATIC[f"/src/{name}"] = os.path.join(ROOT, "src", name)
for rel in ("build/three.module.js", "build/three.core.js", "examples/jsm/controls/OrbitControls.js"):
    STATIC[f"/vendor/three/{rel}"] = os.path.join(HERE, "vendor", "three", rel)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---- minimal WebSocket (RFC 6455) ----

async def ws_recv(reader, writer):
    """Returns (opcode, payload) for the next whole message, or None when the peer closes."""
    op0, parts = None, []
    while True:
        b0, b1 = await reader.readexactly(2)
        fin, op, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
        if n == 126:
            n, = struct.unpack(">H", await reader.readexactly(2))
        elif n == 127:
            n, = struct.unpack(">Q", await reader.readexactly(8))
        if n > MAX_MESSAGE:
            raise ConnectionError("message too large")
        mask = await reader.readexactly(4) if b1 & 0x80 else None
        data = await reader.readexactly(n)
        if mask:  # XOR as one big integer: C speed, unlike a Python byte loop
            key = (mask * (n // 4 + 1))[:n]
            data = (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")
        if op == 0x8:
            return None
        if op == 0x9:
            await ws_send(writer, 0xA, data)
            continue
        if op == 0xA:
            continue
        if op:
            op0 = op
        parts.append(data)
        if fin:
            return op0, b"".join(parts)


async def ws_send(writer, op, payload):
    n = len(payload)
    head = bytes([0x80 | op])
    head += bytes([n]) if n < 126 else (bytes([126]) + struct.pack(">H", n) if n < 65536 else bytes([127]) + struct.pack(">Q", n))
    writer.write(head + payload)
    await writer.drain()


# ---- the two kinds of WebSocket client ----

async def handle_source(reader, writer, peer):
    """The Mac. Each binary message is a JPEG; it's acknowledged at once so the next can be in flight."""
    global latest, latest_id
    log("source connected", peer)
    frames, nbytes, t0 = 0, 0, time.monotonic()
    try:
        while (msg := await ws_recv(reader, writer)) is not None:
            op, data = msg
            if op != 0x2:
                continue
            latest, latest_id = data, latest_id + 1
            new_frame.set()
            frames, nbytes = frames + 1, nbytes + len(data)
            await ws_send(writer, 0x1, json.dumps({"screens": len(screens), **screen_stats}).encode())
            if (dt := time.monotonic() - t0) >= 10:
                log(f"receiving {frames / dt:.1f} fps, {nbytes / frames / 1024:.1f} KB/frame; "
                    f"screen {screen_stats['fps']:.1f} fps, draw {screen_stats['drawMs']:.0f} ms")
                frames, nbytes, t0 = 0, 0, time.monotonic()
    finally:
        log("source disconnected", peer)


async def handle_screen(reader, writer, peer):
    """The Chromium page. It reports its size, then draws each frame it gets and answers "ok <ms>" when
    ready for the next, so a slow screen skips frames instead of queueing them."""
    log("screen connected", peer)
    screens.add(writer)
    ready = asyncio.Event()
    ready.set()
    count = {"drawn": 0, "t0": time.monotonic()}

    async def read_loop():
        while (msg := await ws_recv(reader, writer)) is not None:
            op, data = msg
            if op != 0x1:
                continue
            if data.startswith(b"ok"):
                screen_stats["drawMs"] = float(data[3:] or 0)
                count["drawn"] += 1
                if (dt := time.monotonic() - count["t0"]) >= 2:   # frames drawn per second, over 2 s windows
                    screen_stats["fps"] = count["drawn"] / dt
                    count.update(drawn=0, t0=time.monotonic())
                ready.set()
            elif data.startswith(b"size "):
                w, h = (int(v) for v in data[5:].split(b"x"))
                screen_stats.update(width=w, height=h)
                log(f"screen size {w}x{h}")

    reader_task = asyncio.create_task(read_loop())
    sent_id = 0
    try:
        while True:
            waiter = asyncio.create_task(ready.wait())
            await asyncio.wait({waiter, reader_task}, return_when=asyncio.FIRST_COMPLETED)
            while not reader_task.done() and (latest is None or latest_id == sent_id):
                new_frame.clear()
                waiter = asyncio.create_task(new_frame.wait())
                await asyncio.wait({waiter, reader_task}, return_when=asyncio.FIRST_COMPLETED)
            if reader_task.done():
                waiter.cancel()
                break
            ready.clear()
            sent_id = latest_id
            await ws_send(writer, 0x2, latest)
    finally:
        reader_task.cancel()
        screens.discard(writer)
        log("screen disconnected", peer)


async def handle_live(reader, writer, peer):
    """A screen page drawing the visual itself. It gets the newest settings and posture at once, then each new one;
    it reports "stats <fps> <width> <height>" every couple of seconds."""
    log("live screen connected", peer)
    live_screens.add(writer)
    try:
        for kind in (b"C", b"S"):
            if kind in live_last:
                await ws_send(writer, 0x2, live_last[kind])
        while (msg := await ws_recv(reader, writer)) is not None:
            op, data = msg
            if op == 0x1 and data.startswith(b"stats "):
                fps, w, h = data[6:].split()[:3]
                live_stats.update(fps=float(fps), w=int(w), h=int(h))
    finally:
        live_screens.discard(writer)
        log("live screen disconnected", peer)


class LiveRelay(asyncio.DatagramProtocol):
    """Messages from posture_ble.py: b"S" + posture or b"C" + settings. Passed on to every live screen page; a page
    that has fallen behind skips messages rather than queueing them."""
    def datagram_received(self, data, addr):
        if not data or data[:1] not in (b"C", b"S"):
            return
        live_last[data[:1]] = data
        n = len(data)
        frame = bytes([0x82, n]) + data if n < 126 else bytes([0x82, 126]) + struct.pack(">H", n) + data
        for w in list(live_screens):
            if w.transport.get_write_buffer_size() < 16384:
                w.write(frame)


# ---- HTTP: serves the screen page and upgrades WebSocket requests ----

async def handle(reader, writer):
    peer = writer.get_extra_info("peername")
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin-1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
        path = path.split("?", 1)[0]

        if headers.get("upgrade", "").lower() == "websocket" and path in ("/source", "/screen", "/live"):
            accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + WS_GUID).digest()).decode()
            writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
            await writer.drain()
            await {"/source": handle_source, "/screen": handle_screen, "/live": handle_live}[path](reader, writer, peer)
        elif method == "GET" and (path in ("/", "/screen.html", "/stats") or path in STATIC):
            if path == "/stats":   # how the screen pages are doing (posture_ble.py reports it to the app)
                body, kind = json.dumps({"screens": len(screens), **screen_stats, "liveScreens": len(live_screens),
                                         "live": live_stats}).encode(), "application/json"
            else:
                with open(STATIC.get(path) or os.path.join(HERE, "screen.html"), "rb") as f:
                    body = f.read()
                kind = "text/javascript" if path in STATIC else "text/html"
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {kind}; charset=utf-8\r\nCache-Control: no-store\r\n".encode()
                         + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
            await writer.drain()
        else:
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, KeyError, FileNotFoundError):
        pass
    finally:
        writer.close()


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", PORT, limit=1 << 16)
    await asyncio.get_running_loop().create_datagram_endpoint(LiveRelay, local_addr=("127.0.0.1", LIVE_PORT))
    log(f"Posture display listening on port {PORT} (Bluetooth relay on 127.0.0.1:{LIVE_PORT})")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
