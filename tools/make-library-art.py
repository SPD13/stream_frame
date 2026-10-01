#!/usr/bin/env python3
"""Render Stream Frame's Steam library artwork and app icons from the app logo,
assets/raw_icons/app_logo.jpeg (headset emblem, "STREAM FRAME" wordmark and tagline on a
dark gradient).

Writes, at the sizes Steam asks for:
  assets/library/capsule.png   600x900    portrait capsule (library grid)
  assets/library/wide.png      920x430    wide capsule (recent games, landscape views)
  assets/library/hero.png      3840x1240  banner at the top of the app page (no text)
  assets/library/logo.png      transparent, at most 1280x720, drawn by Steam over the hero
  assets/icon.png              256x256    library shortcut icon (transparent)
  extension/icons/icon128.png  128x128    helper extension and start page icon

The emblem, wordmark and tagline are cut out of the logo against the background colour
around each of them ("colour to alpha"); the artwork's own gradient supplies the glow.
Needs Pillow 10.3+ (pip install pillow). Re-run after changing the logo.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath, ImageStat

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/raw_icons/app_logo.jpeg"
LIB = ROOT / "assets/library"

BG_EDGE = (25, 26, 31)  # the logo's background at the edges
BG_GLOW = (27, 40, 54)  # the soft blue glow behind the emblem

# Parts of the logo (left, top, right, bottom) in source pixels, with room for the glow.
PARTS = {
    "emblem": (940, 290, 1880, 960),
    "wordmark": (745, 965, 2075, 1120),
    "tagline": (890, 1126, 1950, 1198),
}


def border_colour(part, ring=12):
    """Mean colour of the outer ring of a crop: the logo's background right there."""
    w, h = part.size
    strips = [part.crop(b) for b in ((0, 0, w, ring), (0, h - ring, w, h), (0, 0, ring, h), (w - ring, 0, w, h))]
    sums = [sum(ImageStat.Stat(s).mean[i] * s.width * s.height for s in strips) for i in range(3)]
    n = sum(s.width * s.height for s in strips)
    return tuple(round(v / n) for v in sums)


def cut_out(img, box, feather=16, solid=False, glow=True):
    """The part of the logo in `box` as RGBA: alpha from the distance to the background
    colour around it, colour un-mixed from that background, crop edges faded out.
    solid: fill the shape's outline so dark parts close to the background stay opaque.
    glow=False (with solid): only the filled shape, without the soft halo around it."""
    part = img.crop(box)
    bgc = border_colour(part)
    chans = []
    for ch, bg in zip(part.split(), bgc):
        # how far this channel is from the background (lighter or darker, same scale: the
        # background is dark, so scaling darker pixels by 255/bg would amplify the vignette)
        chans.append(ImageMath.lambda_eval(
            lambda a, bg=bg: abs(a["c"] - bg) * 255 / (255 - bg), c=ch))
    alpha = ImageMath.lambda_eval(lambda a: a["max"](a["max"](a["r"], a["g"]), a["b"]), r=chans[0], g=chans[1], b=chans[2])
    # ignore JPEG noise and the faint vignette, then rescale
    alpha = ImageMath.lambda_eval(lambda a: (a["x"] - 10) * 255 / 245, x=alpha).convert("L")
    rgb = []
    for ch, bg in zip(part.split(), bgc):
        # c = bg + (src - bg) / alpha
        rgb.append(ImageMath.lambda_eval(
            lambda a, bg=bg: a["min"](a["max"](bg + (a["c"] - bg) * 255 / a["max"](a["al"], 1), 0), 255),
            c=ch, al=alpha).convert("L"))
    out = Image.merge("RGB", rgb)
    if solid:
        # The headset's dark navy body is close to the background colour, so colour-to-alpha
        # leaves it see-through: find the outline, fill it, keep the original colours inside.
        # The outline is darker than the background and the glow lighter, so here darker pixels
        # count on a much finer scale than lighter ones.
        diffs = [ImageMath.lambda_eval(lambda a, bg=bg: a["max"]((a["c"] - bg) * 255 / (255 - bg), (bg - a["c"]) * 255 / bg), c=ch)
                 for ch, bg in zip(part.split(), bgc)]
        strength = ImageMath.lambda_eval(lambda a: a["max"](a["max"](a["r"], a["g"]), a["b"]),
                                         r=diffs[0], g=diffs[1], b=diffs[2]).convert("L")
        shape = strength.point(lambda v: 255 if v > 60 else 0)
        shape = shape.filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.MinFilter(13))  # close small gaps
        ImageDraw.Draw(shape).rectangle((0, 0, shape.width - 1, shape.height - 1), outline=0, width=feather)  # crop edge is outside
        ImageDraw.floodfill(shape, (0, 0), 128)  # everything reachable from the edge is outside
        body = shape.point(lambda v: 0 if v == 128 else 255)
        body = body.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))  # drop specks
        # round off ragged edges: blur, then re-sharpen to a clean anti-aliased edge
        body = body.filter(ImageFilter.GaussianBlur(4)).point(lambda v: max(0, min(255, (v - 96) * 4)))
        out = Image.composite(part, out, body)
        alpha = ImageChops.lighter(alpha, body) if glow else body
    edge = Image.new("L", part.size, 0)
    ImageDraw.Draw(edge).rectangle((feather, feather, part.width - feather, part.height - feather), fill=255)
    alpha = ImageChops.multiply(alpha, edge.filter(ImageFilter.GaussianBlur(feather / 2)))
    out.putalpha(alpha)
    return out.crop(out.getbbox() or (0, 0, *out.size))


def radial(size, inner=BG_GLOW, outer=BG_EDGE, centre=(0.5, 0.45), radius=0.75):
    """Background like the logo's: a soft glow fading to the edge colour."""
    w, h = size
    small = Image.new("RGB", (max(w // 8, 1), max(h // 8, 1)))
    cx, cy = small.width * centre[0], small.height * centre[1]
    rmax = radius * max(small.width, small.height)
    px = []
    for y in range(small.height):
        for x in range(small.width):
            t = min(1.0, ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / rmax)
            t = t * t * (3 - 2 * t)  # smoothstep
            px.append(tuple(round(a + (b - a) * t) for a, b in zip(inner, outer)))
    small.putdata(px)
    return small.resize(size, Image.BICUBIC)


def fit(part, width=None, height=None):
    k = min(width / part.width if width else 1e9, height / part.height if height else 1e9)
    return part.resize((round(part.width * k), round(part.height * k)), Image.LANCZOS)


def paste_centre(canvas, part, cx, cy):
    canvas.alpha_composite(part, (round(cx - part.width / 2), round(cy - part.height / 2)))


def capsule(p):
    c = radial((600, 900), centre=(0.5, 0.4)).convert("RGBA")
    paste_centre(c, fit(p["emblem"], width=500), 300, 380)
    paste_centre(c, fit(p["wordmark"], width=540), 300, 665)
    paste_centre(c, fit(p["tagline"], width=470), 300, 725)
    return c


def wide(p):
    c = radial((920, 430), centre=(0.27, 0.5), radius=0.6).convert("RGBA")
    paste_centre(c, fit(p["emblem"], height=270), 235, 215)
    paste_centre(c, fit(p["wordmark"], width=430), 665, 195)
    paste_centre(c, fit(p["tagline"], width=380), 665, 250)
    return c


def hero(p):
    """No text or logo (Steam draws logo.png over it, bottom left): the logo's blue light,
    on the right."""
    return radial((3840, 1240), inner=(30, 62, 96), centre=(0.68, 0.55), radius=0.42).convert("RGBA")


def logo(p):
    em, wm = fit(p["emblem"], width=820), fit(p["wordmark"], width=1260)
    c = Image.new("RGBA", (max(em.width, wm.width), em.height + wm.height + 10), (0, 0, 0, 0))
    paste_centre(c, em, c.width / 2, em.height / 2)
    paste_centre(c, wm, c.width / 2, em.height + 10 + wm.height / 2)
    return fit(c, width=1280, height=720)


def icon(p, size):
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    paste_centre(c, fit(p["icon"], width=size * 0.98, height=size * 0.98), size / 2, size / 2)
    return c


if __name__ == "__main__":
    src = Image.open(SRC).convert("RGB")
    parts = {name: cut_out(src, box, solid=name == "emblem") for name, box in PARTS.items()}
    parts["icon"] = cut_out(src, PARTS["emblem"], solid=True, glow=False)  # clean on light backgrounds too
    LIB.mkdir(parents=True, exist_ok=True)
    outputs = {
        LIB / "capsule.png": capsule(parts),
        LIB / "wide.png": wide(parts),
        LIB / "hero.png": hero(parts),
        LIB / "logo.png": logo(parts),
        ROOT / "assets/icon.png": icon(parts, 256),
        ROOT / "extension/icons/icon128.png": icon(parts, 128),
    }
    for path, img in outputs.items():
        if path.name in ("capsule.png", "wide.png", "hero.png"):
            img = img.convert("RGB")  # opaque artwork
        img.save(path, optimize=True)
        print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}  {path.stat().st_size // 1024} KB")
