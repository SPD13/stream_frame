#!/usr/bin/env python3
"""Render the start-page tiles for the built-in services from the high-resolution
source icons in assets/raw_icons/ into extension/logos/<id>.png (960x540, 16:9,
twice the on-panel tile size).

Each tile is full bleed: the canvas is filled with the icon's own background colour
and the icon is centred on it, so the icon's edges disappear into the tile.
Needs Pillow 11.2+ for the AVIF source (pip install pillow). Re-run after changing a source icon.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/raw_icons"
OUT = ROOT / "extension/logos"
W, H = 960, 540

# id: (source file, background colour, mode, scale)
#   mode "contain": scale the icon to fit inside the tile, then multiply by `scale`
#                   (> 1 crops the icon's own plain background, which matches the tile).
#   mode "vignette": like contain, with feathered edges, over a radial gradient sampled
#                   from the icon's own centre and corner colours (for gradient backgrounds).
#   mode "whiten":  like contain, and near-white pixels become pure white (JPEG noise).
TILES = {
    "netflix": ("netflix.png", (0, 0, 0), "contain", 1.0),
    "max": ("hbo_max.png", (9, 14, 24), "vignette", 0.95),
    "hulu": ("hulu.png", (0, 0, 0), "contain", 1.3),
    "disneyplus": ("disney_plus.png", (0, 99, 229), "contain", 1.2),  # pushes the rounded corners out of frame
    "appletv": ("apple_tv.png", (0, 0, 0), "contain", 1.6),
    "primevideo": ("prime_video.png", (5, 120, 255), "contain", 1.4),  # pushes the rounded corners out of frame
    "youtube": ("youtube.jpg", (255, 255, 255), "whiten", 0.85),
    "crunchyroll": ("crunchyroll.png", (255, 255, 255), "contain", 0.8),
    "paramountplus": ("paramount_plus.jpeg", (1, 100, 232), "contain", 1.4),  # crops the wide banner to fill the tile
    "peacock": ("peacock.avif", (13, 13, 13), "contain", 1.1),
    "tubi": ("tubi.jpeg", (100, 0, 190), "contain", 1.2),  # crops the wide banner to fill the tile
    "plutotv": ("pluto_tv.webp", (13, 13, 13), "contain", 1.15),
}


def scaled(icon, k):
    return icon.resize((round(icon.width * k), round(icon.height * k)), Image.LANCZOS)


def feather(icon, radius):
    """Alpha mask fading the icon's outer `radius` pixels to transparent."""
    mask = Image.new("L", icon.size, 0)
    ImageDraw.Draw(mask).rectangle((radius, radius, icon.width - radius, icon.height - radius), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(radius / 2))


def radial(inner, outer):
    """Tile-sized radial gradient, `inner` at the centre to `outer` at the corners."""
    small = Image.new("RGB", (W // 8, H // 8))
    cx, cy = small.width / 2, small.height / 2
    rmax = (cx * cx + cy * cy) ** 0.5
    small.putdata([
        tuple(round(a + (b - a) * min(1, ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / rmax)) for a, b in zip(inner, outer))
        for y in range(small.height) for x in range(small.width)
    ])
    return small.resize((W, H), Image.BICUBIC)


def render(src, bg, mode, scale):
    icon = Image.open(SRC / src).convert("RGBA")
    if mode == "whiten":
        icon = icon.point(lambda v: 255 if v > 235 else v)
    tile = Image.new("RGB", (W, H), bg)
    if mode == "vignette":
        inner = icon.getpixel((icon.width // 2, icon.height // 12))[:3]
        outer = icon.getpixel((2, 2))[:3]
        tile = radial(inner, outer)
    icon = scaled(icon, min(W / icon.width, H / icon.height) * scale)
    if mode == "vignette":
        icon.putalpha(feather(icon, 60))
    # paste() accepts negative offsets, which crops an icon larger than the tile.
    tile.paste(icon, ((W - icon.width) // 2, (H - icon.height) // 2), icon)
    return tile


if __name__ == "__main__":
    for tid, (src, bg, mode, scale) in TILES.items():
        out = OUT / f"{tid}.png"
        render(src, bg, mode, scale).save(out, optimize=True)
        print(f"{out.relative_to(ROOT)}  bg #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}  {out.stat().st_size // 1024} KB")
