"""Send JPEG files to the PostureBuddy sketch and report throughput.

Usage: python lcd_test.py /dev/cu.usbmodemXXXX frame1.jpg [frame2.jpg ...] [--n 100]
Needs pyserial (pip install pyserial).
"""
import argparse
import struct
import time

import serial

STATUS = {0: "ok", 1: "too big", 2: "short read", 3: "bad jpeg"}


def read_reply(port, timeout=2.0):
    """Wait for b'OK' + status + uint16 total ms + uint16 draw ms."""
    end = time.time() + timeout
    window = b""
    while time.time() < end:
        b = port.read(1)
        if not b:
            continue
        window = (window + b)[-2:]
        if window == b"OK":
            rest = port.read(5)
            if len(rest) == 5:
                return (rest[0], *struct.unpack("<HH", rest[1:]))
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--n", type=int, default=60)
    args = ap.parse_args()

    frames = [open(f, "rb").read() for f in args.files]
    with serial.Serial(args.port, 921600, timeout=0.05) as port:
        time.sleep(0.5)
        port.reset_input_buffer()
        total_ms, draw_ms, round_ms, errors = [], [], [], {}
        t_start = time.time()
        for i in range(args.n):
            jpg = frames[i % len(frames)]
            t0 = time.time()
            port.write(b"FLWR" + struct.pack("<I", len(jpg)) + jpg)
            r = read_reply(port)
            round_ms.append((time.time() - t0) * 1000)
            if r is None:
                errors["no reply"] = errors.get("no reply", 0) + 1
                continue
            status, total, draw = r
            if status:
                errors[STATUS[status]] = errors.get(STATUS[status], 0) + 1
            total_ms.append(total)
            draw_ms.append(draw)
        elapsed = time.time() - t_start

    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else float("nan")
    sizes = ", ".join(f"{len(f) / 1024:.1f} KB" for f in frames)
    print(f"frames {args.n}  sizes [{sizes}]  {args.n / elapsed:.1f} fps")
    print(f"board decode+draw median {med(total_ms)} ms (LCD push {med(draw_ms)} ms)   "
          f"round trip median {med(round_ms):.1f} ms")
    print(f"errors {errors or 'none'}")


if __name__ == "__main__":
    main()
