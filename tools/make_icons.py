#!/usr/bin/env python3
"""Generate the PWA PNG icons (no dependencies — hand-rolled PNG encoder).

Draws the same artwork as icons/icon.svg: paper-white tile with four
rounded bars, the third one record-red. Run from the repo root:

    python3 tools/make_icons.py
"""
import os
import struct
import zlib

PAPER = (247, 246, 243)
BAR = (215, 213, 208)
RED = (255, 59, 48)

# artwork in a 512-unit design space: (x, y, w, h, color), bar height 44, radius 22
BARS = [
    (118, 114, 276, 44, BAR),
    (118, 194, 212, 44, BAR),
    (118, 274, 252, 44, RED),
    (118, 354, 180, 44, BAR),
]
CORNER_R = 116  # rounded tile corner for non-maskable icons


def rounded_rect_dist(px, py, x, y, w, h, r):
    """Signed distance to a rounded rectangle (negative = inside)."""
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def render(size, maskable=False):
    """Render RGBA rows. Maskable icons are full-bleed; others have rounded corners."""
    s = size / 512.0
    ss = 3  # supersampling grid
    rows = []
    # maskable: shrink artwork toward center so it survives the safe zone crop
    art_scale = 0.78 if maskable else 1.0
    off = (1 - art_scale) * 256

    for j in range(size):
        row = bytearray()
        for i in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sj in range(ss):
                for si in range(ss):
                    # sample point in 512-space
                    px = (i + (si + 0.5) / ss) / s
                    py = (j + (sj + 0.5) / ss) / s
                    if maskable:
                        tile_a = 1.0
                    else:
                        d = rounded_rect_dist(px, py, 0, 0, 512, 512, CORNER_R)
                        tile_a = min(1.0, max(0.0, 0.5 - d * s))
                    if tile_a <= 0:
                        continue
                    r_, g_, b_ = PAPER
                    for (bx, by, bw, bh, col) in BARS:
                        ax = off + bx * art_scale
                        ay = off + by * art_scale
                        aw = bw * art_scale
                        ah = bh * art_scale
                        d = rounded_rect_dist(px, py, ax, ay, aw, ah, ah / 2)
                        a = min(1.0, max(0.0, 0.5 - d * s))
                        if a > 0:
                            r_ = r_ + (col[0] - r_) * a
                            g_ = g_ + (col[1] - g_) * a
                            b_ = b_ + (col[2] - b_) * a
                            break
                    acc[0] += r_ * tile_a
                    acc[1] += g_ * tile_a
                    acc[2] += b_ * tile_a
                    acc[3] += tile_a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                row += bytes((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(a * 255)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        raw = tag + data
        return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b"".join(b"\x00" + r for r in rows)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for name, size, maskable in [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),  # iOS applies its own corner mask
    ]:
        write_png(os.path.join(out, name), size, render(size, maskable))


if __name__ == "__main__":
    main()
