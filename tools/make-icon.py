#!/usr/bin/env python3
"""Render the Stream Frame icon (curved screen with a play triangle) as PNGs.

Stdlib only. Writes assets/icon.png (256 px), extension/icons/icon128.png and
extension/probe.png (1x1, used by web/boot.html to detect the helper extension).
"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SS = 4  # supersampling factor


def write_png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes(row) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def inside_rounded(x, y, r):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def sample(x, y):
    """Colour (r, g, b, a) at normalised coordinates x, y in [0, 1]."""
    if not inside_rounded(x, y, 0.22):
        return (0, 0, 0, 0)
    # background: vertical gradient
    t = y
    bg = (int(27 + (11 - 27) * t), int(40 + (12 - 40) * t), int(56 + (16 - 56) * t))
    # curved screen: between two arcs, x in [0.14, 0.86]
    if 0.14 <= x <= 0.86:
        bow = 0.05 * (1 - ((x - 0.5) / 0.36) ** 2)
        top = 0.26 + bow
        bottom = 0.64 - bow
        if top <= y <= bottom:
            # play triangle centred in the screen
            px, py = (x - 0.5) / 0.13, (y - 0.45) / 0.13
            if -0.6 <= px <= 0.9 and abs(py) <= (0.9 - px) * 0.577 * 1.0:
                return (*bg, 255)
            glow = 1 - abs(x - 0.5) * 0.5
            return (int(102 * glow + 40), int(192 * glow + 20), int(244 * glow + 11), 255)
    # stage glow under the screen
    if 0.70 <= y <= 0.76 and 0.30 <= x <= 0.70:
        return (60, 100, 130, 255)
    return (*bg, 255)


def render(size):
    rows = []
    n = SS * SS
    for j in range(size):
        row = []
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(SS):
                for si in range(SS):
                    c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size)
                    a = c[3]
                    acc[0] += c[0] * a
                    acc[1] += c[1] * a
                    acc[2] += c[2] * a
                    acc[3] += a
            a = acc[3]
            row += [acc[0] // a, acc[1] // a, acc[2] // a, a // n] if a else [0, 0, 0, 0]
        rows.append(row)
    return rows


if __name__ == "__main__":
    write_png(ROOT / "assets/icon.png", 256, render(256))
    write_png(ROOT / "extension/icons/icon128.png", 128, render(128))
    write_png(ROOT / "extension/probe.png", 1, [[0, 0, 0, 0]])
    print("icons written")
