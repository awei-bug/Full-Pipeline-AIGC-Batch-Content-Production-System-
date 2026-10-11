"""Generate the app icon: rounded-square gradient + white four-point sparkle.

The artwork is rendered on a 1024px canvas (4x supersampled) and then written
out as a multi-size ICO. Re-run this script whenever the artwork changes:

    python scripts/make-app-icon.py

The ICO is assembled by hand rather than left to Pillow's default writer,
because the frame format matters: small frames are written as 32bpp BMP (the
native ICO payload - .NET's System.Drawing.Icon loads these unconditionally,
which the tray icon depends on) while large frames use PNG (much smaller, and
fine for the sizes modern shells read).

Outputs
-------
apps/studio-web/public/favicon.ico
    Browser tab icon.
apps/studio-web/public/app-icon.ico
    Desktop / Start Menu shortcut icon, and the tray icon. Deliberately a
    separate file from favicon.ico: Windows caches shortcut icons by path, so
    changing the artwork under the same name can keep showing the old picture
    until the cache is rebuilt. A new file name forces a fresh read.
.local-stack/icons/icon-preview.png
    Handy preview (not shipped).

Requires Pillow.
"""
from __future__ import annotations

import io
import math
import os
import struct

from PIL import Image, ImageDraw, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "apps", "studio-web", "public")
PREVIEW_DIR = os.path.join(ROOT, ".local-stack", "icons")

S = 1024                                  # master canvas
C1 = (99, 102, 241)                       # #6366F1 brand indigo
C2 = (168, 85, 247)                       # #A855F7 purple
W = (255, 255, 255, 255)

CORNER_RATIO = 0.225                      # rounded-square radius
STAR_CENTER = (0.500, 0.505)
STAR_RADIUS = 0.330                       # of canvas
STAR_CTRL = 0.115                         # arm fullness; bigger = rounder arms

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
BMP_MAX = 48                              # frames up to this size: BMP payload


def gradient(size: int, c1: tuple, c2: tuple) -> Image.Image:
    """Diagonal gradient, computed small then upscaled (fast and banding-free)."""
    small = Image.new("RGB", (192, 192))
    for y in range(192):
        for x in range(192):
            t = (x + y) / 382.0
            small.putpixel((x, y), tuple(int(a + (b - a) * t) for a, b in zip(c1, c2)))
    return small.resize((size, size), Image.BICUBIC)


def rounded_mask(size: int, ratio: float = CORNER_RATIO) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * ratio), fill=255
    )
    return m


def sparkle(cx: float, cy: float, r: float, ctrl: float, steps: int = 48):
    """Four-point star with concave cubic-bezier arms."""
    pts = []
    for i in range(4):
        a0 = math.radians(-90 + i * 90)
        a1 = math.radians(-90 + (i + 1) * 90)
        am = math.radians(-90 + i * 90 + 45)
        p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
        p3 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
        c = r * ctrl
        p1 = p2 = (cx + c * math.cos(am), cy + c * math.sin(am))
        for s in range(steps):
            t = s / steps
            mt = 1 - t
            pts.append((
                mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
                mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
            ))
    return pts


def build() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(gradient(S, C1, C2).convert("RGBA"), (0, 0))

    # Soft highlight from the top-left corner adds depth on flat backgrounds.
    glow_src = ImageOps.invert(Image.radial_gradient("L"))
    gsize = int(S * 1.5)
    glow = Image.new("L", (S, S), 0)
    glow.paste(glow_src.resize((gsize, gsize), Image.BICUBIC), (-int(S * 0.45), -int(S * 0.45)))
    glow = glow.point(lambda v: int(v * 0.15))
    soft = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    soft.putalpha(glow)
    img.alpha_composite(soft)

    img.putalpha(rounded_mask(S))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(layer).polygon(
        sparkle(S * STAR_CENTER[0], S * STAR_CENTER[1], S * STAR_RADIUS, STAR_CTRL), fill=W
    )
    img.alpha_composite(layer)
    return img


def bmp_frame(img: Image.Image) -> bytes:
    """32bpp DIB payload as stored inside an ICO."""
    w, h = img.size
    px = img.convert("RGBA").load()

    # BITMAPINFOHEADER; height is doubled because the DIB carries both the
    # colour bitmap and the 1bpp AND mask.
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)

    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))

    # AND mask: one bit per pixel, rows padded to 4 bytes, set where transparent.
    row_bytes = ((w + 31) // 32) * 4
    andmask = bytearray()
    for y in range(h - 1, -1, -1):
        bits = bytearray(row_bytes)
        for x in range(w):
            if px[x, y][3] < 128:
                bits[x // 8] |= 0x80 >> (x % 8)
        andmask += bits

    return header + bytes(xor) + bytes(andmask)


def png_frame(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: str, frames) -> None:
    """frames: list of (width, height, payload)."""
    count = len(frames)
    offset = 6 + count * 16
    entries = bytearray()
    blob = bytearray()
    for w, h, payload in frames:
        entries += struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0,
            h if h < 256 else 0,
            0,        # colour count: 0 means truecolour
            0,        # reserved
            1,        # colour planes
            32,       # bits per pixel
            len(payload),
            offset,
        )
        offset += len(payload)
        blob += payload
    with open(path, "wb") as fh:
        fh.write(struct.pack("<HHH", 0, 1, count))   # reserved, type=icon, count
        fh.write(bytes(entries))
        fh.write(bytes(blob))


def main() -> None:
    img = build()
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(PREVIEW_DIR, "icon-preview.png"))

    frames = []
    for size in ICO_SIZES:
        frame = img.resize((size, size), Image.LANCZOS)
        payload = bmp_frame(frame) if size <= BMP_MAX else png_frame(frame)
        frames.append((size, size, payload))

    for name in ("favicon.ico", "app-icon.ico"):
        path = os.path.join(PUBLIC, name)
        write_ico(path, frames)
        print("wrote", os.path.relpath(path, ROOT), os.path.getsize(path), "bytes")

    # Report what actually landed inside the file.
    with open(os.path.join(PUBLIC, "app-icon.ico"), "rb") as fh:
        data = fh.read()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    for i in range(count):
        off = 6 + i * 16
        w = data[off] or 256
        size, offset = struct.unpack("<II", data[off + 8:off + 16])
        sig = data[offset:offset + 8]
        fmt = "PNG" if sig == b"\x89PNG\r\n\x1a\n" else "BMP"
        print(f"  frame {w:>3}x{w:<3} {fmt}")


if __name__ == "__main__":
    main()
