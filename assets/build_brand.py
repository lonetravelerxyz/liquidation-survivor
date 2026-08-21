#!/usr/bin/env python3
"""Generate Liquidation Survivor brand assets (wordmark, banners) as portable SVG.

Derived from the Dark Survivor brand kit (same owl, palette and Space Grotesk type); text is outlined to
vector paths so the SVGs render anywhere without the font installed.
Run from assets/:  python3 build_brand.py   (needs fonttools; Pillow + qlmanage optional for PNGs)
"""
import os
import subprocess

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = {
    "bold": TTFont(os.path.join(HERE, "fonts/SpaceGrotesk-Bold.ttf")),
    "medium": TTFont(os.path.join(HERE, "fonts/SpaceGrotesk-Medium.ttf")),
}

DARK = "#0A0F0D"
GREEN = "#2ED47A"
AMBER = "#F5B841"
INK = "#EAF0EC"
MUTE = "#8AA79B"

OWL = """<g fill="none" stroke="{g}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
<path d="M352 470 L372 372"/><path d="M672 470 L652 372"/>
<path d="M336 452 Q512 512 512 540"/><path d="M688 452 Q512 512 512 540"/>
<circle cx="426" cy="556" r="86"/><circle cx="598" cy="556" r="86"/></g>
<circle cx="444" cy="568" r="30" fill="{a}"/><circle cx="580" cy="568" r="30" fill="{a}"/>
<path d="M492 626 L532 626 L512 668 Z" fill="{g}"/>""".format(g=GREEN, a=AMBER)
OWL_BBOX = (323, 359, 701, 668)

NAME = "Liquidation Survivor"
TAG = "GUARD · WATCH · SURVIVE"
BY = "by Dark Survivor"


def owl_group(cx, cy, height):
    x0, y0, x1, y1 = OWL_BBOX
    ow, oh = x1 - x0, y1 - y0
    s = height / oh
    ocx, ocy = (x0 + x1) / 2, (y0 + y1) / 2
    return f'<g transform="translate({cx},{cy}) scale({s}) translate({-ocx},{-ocy})">{OWL}</g>', ow * s


def text_paths(text, weight, size_px, color, x, baseline, tracking_px=0):
    font = FONTS[weight]
    upm = font["head"].unitsPerEm
    s = size_px / upm
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    track_u = tracking_px / s
    penx = 0
    parts = []
    for ch in text:
        gname = cmap.get(ord(ch)) or ".notdef"
        adv = hmtx[gname][0]
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({penx},0)" d="{d}"/>')
        penx += adv + track_u
    width = (penx - track_u) * s if text else 0
    g = f'<g fill="{color}" transform="translate({x},{baseline}) scale({s},{-s})">' + "".join(parts) + "</g>"
    return g, width


def ctext(text, weight, size, color, cx, baseline, tracking_px=0):
    _, w = text_paths(text, weight, size, color, 0, 0, tracking_px)
    g, _ = text_paths(text, weight, size, color, cx - w / 2, baseline, tracking_px)
    return g, w


def svg(w, h, body, bg=None, rx=0):
    b = f'<rect width="{w}" height="{h}" rx="{rx}" fill="{bg}"/>' if bg else ""
    return (
        '<?xml version="1.0" encoding="utf-8" ?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{b}{body}</svg>\n'
    )


def write(name, content):
    p = os.path.join(HERE, name)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    open(p, "w").write(content)
    print("wrote", name)


def rasterize(W, H, body, out_png, bg=None, rx=0):
    try:
        from PIL import Image
    except ImportError:
        return
    tmp = os.path.join(HERE, "exports/_tmp")
    os.makedirs(tmp, exist_ok=True)
    S = max(W, H)
    b = f'<rect width="{W}" height="{H}" rx="{rx}" fill="{bg}"/>' if bg else ""
    sq = f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">{b}{body}</svg>'
    src = os.path.join(tmp, "sq.svg")
    open(src, "w").write(sq)
    r = subprocess.run(["qlmanage", "-t", "-s", str(S), "-o", tmp, src], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    png = os.path.join(tmp, "sq.svg.png")
    if r.returncode != 0 or not os.path.exists(png):
        return
    im = Image.open(png).convert("RGBA").crop((0, 0, W, H))
    op = os.path.join(HERE, out_png)
    os.makedirs(os.path.dirname(op), exist_ok=True)
    im.save(op)
    print("rendered", out_png, im.size)


def build_horizontal():
    H, pad, owl_h = 300, 56, 190
    owl_g, owl_w = owl_group(pad + owl_h * 0.62, H / 2, owl_h)
    tx = pad + owl_w + 40
    baseline = H / 2 + 0.35 * 110 - 14
    name_g, name_w = text_paths(NAME, "bold", 110, INK, tx, baseline)
    tag_g, tag_w = text_paths(TAG, "medium", 30, GREEN, tx + 2, baseline + 50, tracking_px=7)
    W = int(tx + max(name_w, tag_w) + pad)
    body = owl_g + name_g + tag_g
    write("wordmark-horizontal.svg", svg(W, H, body))
    write("wordmark-horizontal-dark.svg", svg(W, H, body, bg=DARK, rx=28))


def build_readme():
    W, H = 1280, 440
    cx = W / 2
    owl_g, _ = owl_group(cx, 128, 150)
    name_g, _ = ctext(NAME, "bold", 92, INK, cx, 300)
    tag_g, _ = ctext(TAG, "medium", 26, GREEN, cx, 344, tracking_px=7)
    sub_g, _ = ctext("AI-explained, contract-enforced liquidation protection for Aave V3 on X Layer", "medium", 25, MUTE, cx, 392)
    by_g, _ = ctext(BY, "medium", 20, MUTE, cx, 424)
    body = owl_g + name_g + tag_g + sub_g + by_g
    write("banner-readme.svg", svg(W, H, body, bg=DARK))
    rasterize(W, H, body, "exports/banner-readme.png", bg=DARK)


def build_og():
    W, H = 1200, 630
    cx = W / 2
    owl_g, _ = owl_group(cx, 200, 200)
    name_g, _ = ctext(NAME, "bold", 96, INK, cx, 400)
    tag_g, _ = ctext(TAG, "medium", 28, GREEN, cx, 448, tracking_px=8)
    sub_g, _ = ctext("Survive the dip. A contract that can only ever repay your own debt.", "medium", 27, MUTE, cx, 524)
    by_g, _ = ctext(BY + " · Built on X Layer", "medium", 22, MUTE, cx, 570)
    body = owl_g + name_g + tag_g + sub_g + by_g
    write("banner-og.svg", svg(W, H, body, bg=DARK))
    rasterize(W, H, body, "exports/og-1200x630.png", bg=DARK)


def build_xheader():
    W, H = 1500, 500
    owl_g, _ = owl_group(880, 200, 180)
    name_g, _ = ctext(NAME, "bold", 88, INK, 880, 370)
    tag_g, _ = ctext(TAG, "medium", 26, GREEN, 880, 416, tracking_px=8)
    body = owl_g + name_g + tag_g
    write("banner-x-header.svg", svg(W, H, body, bg=DARK))
    rasterize(W, H, body, "exports/x-header-1500x500.png", bg=DARK)


if __name__ == "__main__":
    build_horizontal()
    build_readme()
    build_og()
    build_xheader()
