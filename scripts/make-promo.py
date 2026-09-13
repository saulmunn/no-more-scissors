#!/usr/bin/env python3
"""Generates placeholder Chrome Web Store art with Pillow:

  store/promo-tile-440x280.png   small promo tile
  store/marquee-1400x560.png     marquee tile
  store/screenshot-1280x800.png  mock timeline screenshot

They are placeholders: replace the screenshot with a capture of a real timeline before submitting.
Fonts: Helvetica / SF from macOS when present, else Pillow's default."""
from PIL import Image, ImageDraw, ImageFont
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "store")
ICON = os.path.join(ROOT, "icons", "icon128.png")

DARK = (28, 28, 33)        # #1c1c21, the icon's background
BLACK = (0, 0, 0)          # X dark theme
WHITE = (247, 249, 249)    # X primary text
MUTED = (139, 152, 165)    # X secondary text (lightened a touch for legibility at small sizes)
LINE = (47, 51, 54)        # X hairline
RULE = (70, 76, 82)        # left rule beside a rewrite
BLUE = (29, 155, 240)      # X blue, "Show original"
AVATAR = (58, 58, 68)
TAGLINE = "Your timeline, without the heat"

FONT_FILES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(size, bold=False):
    want = "Bold" if bold else "Regular"
    for path in FONT_FILES:
        if not os.path.exists(path):
            continue
        for idx in range(12):  # .ttc collections: walk the faces until the style matches
            try:
                f = ImageFont.truetype(path, size, index=idx)
            except Exception:
                break
            style = f.getname()[1]
            if style == want or (want == "Regular" and style in ("Book", "Roman", "Medium")):
                return f
        try:  # variable fonts (SFNS.ttf)
            f = ImageFont.truetype(path, size)
            f.set_variation_by_name(want)
            return f
        except Exception:
            pass
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


def score_color(s):
    # Mirrors the popup slider gradient: green -> yellow -> orange -> red.
    stops = [(0, (40, 189, 40)), (33, (220, 220, 24)), (66, (236, 128, 19)), (100, (223, 32, 32))]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if s <= b:
            t = (s - a) / (b - a)
            return tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))
    return stops[-1][1]


def dotted_underline(d, x0, x1, y, color, gap=4, r=1):
    x = x0
    while x <= x1:
        d.ellipse((x - r, y - r, x + r, y + r), fill=color)
        x += gap


def fonts_for(k):
    return {
        "name": font(round(15 * k), bold=True),
        "meta": font(round(15 * k)),
        "body": font(round(16 * k)),
        "small": font(round(13 * k)),
    }


def draw_post(d, x, y, w, p, k=1.0, fonts=None, hairline=True):
    """Draws one mock post like the extension renders it. Returns the bottom y."""
    fonts = fonts or fonts_for(k)
    fb, fr, fbody, fsmall = fonts["name"], fonts["meta"], fonts["body"], fonts["small"]
    pad, av, gap = round(16 * k), round(48 * k), round(12 * k)
    cx, cy = x + pad + av + gap, y + pad
    d.ellipse((x + pad, y + pad, x + pad + av, y + pad + av), fill=AVATAR)

    # Header: name, then "@handle · 4h · ● 72" in X's secondary colour, like our badge.
    d.text((cx, cy), p["name"], font=fb, fill=WHITE)
    hx = cx + fb.getlength(p["name"]) + round(8 * k)
    meta = f"@{p['handle']} · {p['age']} · "
    d.text((hx, cy), meta, font=fr, fill=MUTED)
    hx += fr.getlength(meta)
    asc = fr.getmetrics()[0]
    r = fr.size * 0.27
    dot_cy = cy + asc * 0.64
    d.ellipse((hx, dot_cy - r, hx + 2 * r, dot_cy + r), fill=score_color(p["score"]))
    d.text((hx + 2 * r + round(5 * k), cy), str(p["score"]), font=fr, fill=MUTED)

    line_h = round(fbody.size * 1.38)
    ty = cy + round(fr.size * 1.6)
    if p["mode"] == "collapsed":
        s1 = f"Hidden · {p['score']} · {p['reason']}"
        d.text((cx, ty), s1, font=fr, fill=MUTED)
        d.text((cx + fr.getlength(s1) + round(14 * k), ty), "Show anyway", font=fr, fill=BLUE)
        bottom = ty + line_h
    else:
        for i, line in enumerate(p["lines"]):
            d.text((cx, ty + i * line_h), line, font=fbody, fill=WHITE)
        bottom = ty + len(p["lines"]) * line_h
        if p["mode"] == "rewritten":
            rx = cx - round(11 * k)
            d.rounded_rectangle((rx - k, ty + round(3 * k), rx + k, bottom - round(4 * k)), radius=round(k), fill=RULE)
            if p.get("phrase"):
                li, prefix, phrase = p["phrase"]
                x0 = cx + fbody.getlength(prefix)
                x1 = x0 + fbody.getlength(phrase)
                uy = ty + li * line_h + fbody.getmetrics()[0] + round(3 * k)
                dotted_underline(d, x0, x1, uy, MUTED, gap=round(4 * k), r=max(1, round(1.1 * k)))
            d.text((cx, bottom + round(4 * k)), "Show original", font=fr, fill=BLUE)
            bottom += line_h

    # Action bar: a few muted circles with counts, enough to read as X's reply / repost / like row.
    ay = bottom + round(12 * k)
    r = round(7 * k)
    for i, n in enumerate(p.get("actions", ("", "", ""))):
        ax = cx + i * round(110 * k)
        d.ellipse((ax, ay, ax + 2 * r, ay + 2 * r), outline=MUTED, width=max(1, round(1.4 * k)))
        d.text((ax + 2 * r + round(6 * k), ay - round(1 * k)), n, font=fsmall, fill=MUTED)
    end = ay + round(30 * k)
    if hairline:
        d.line((x, end, x + w, end), fill=LINE, width=1)
    return end


REWRITTEN = {
    "name": "Dan Ortiz", "handle": "danortiz", "age": "4h", "score": 72, "mode": "rewritten",
    "lines": ["This policy is a serious mistake, and the people", "defending it should look at the evidence again."],
    "phrase": (0, "This policy is ", "a serious mistake"),
    "actions": ("48", "12", "210"),
}
PLAIN = {
    "name": "Maya Chen", "handle": "mayachen", "age": "2h", "score": 12, "mode": "plain",
    "lines": ["New paper out today on how cities recover after floods.", "Short version: the ones that planned ahead did better,", "and the gap is bigger than we expected."],
    "actions": ("9", "31", "142"),
}
COLLAPSED = {
    "name": "Sam Reilly", "handle": "samreilly", "age": "5h", "score": 92, "mode": "collapsed",
    "reason": "dehumanizing language",
    "actions": ("", "", ""),
}


def centered(d, cx, y, text, f, fill):
    d.text((cx - f.getlength(text) / 2, y), text, font=f, fill=fill)


def promo_tile():
    W, H = 440, 280
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)
    icon = Image.open(ICON).convert("RGBA").resize((96, 96), Image.LANCZOS)
    img.paste(icon, ((W - 96) // 2, 38), icon)
    centered(d, W / 2, 152, "No More Scissors", font(30, bold=True), WHITE)
    centered(d, W / 2, 198, TAGLINE, font(16), MUTED)
    return img


def marquee():
    W, H = 1400, 560
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)
    icon = Image.open(ICON).convert("RGBA").resize((136, 136), Image.LANCZOS)
    img.paste(icon, (110, 132), icon)
    d.text((110, 296), "No More Scissors", font=font(54, bold=True), fill=WHITE)
    d.text((112, 372), TAGLINE, font=font(26), fill=MUTED)

    # Mock post card on the right.
    k = 1.25
    cw, ch = 590, 296
    cx0, cy0 = W - cw - 100, (H - ch) // 2
    d.rounded_rectangle((cx0, cy0, cx0 + cw, cy0 + ch), radius=22, fill=BLACK, outline=LINE, width=2)
    draw_post(d, cx0 + 8, cy0 + 12, cw - 16, REWRITTEN, k=k, hairline=False)
    return img


def screenshot():
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), BLACK)
    d = ImageDraw.Draw(img)

    # Left nav.
    nav = font(19)
    nav_b = font(19, bold=True)
    d.text((186, 26), "X", font=font(30, bold=True), fill=WHITE)
    for i, item in enumerate(["Home", "Explore", "Notifications", "Messages", "Bookmarks", "Profile"]):
        d.text((186, 92 + i * 48), item, font=nav_b if i == 0 else nav, fill=WHITE)

    # Timeline column.
    col_x, col_w = 400, 600
    d.line((col_x, 0, col_x, H), fill=LINE, width=1)
    d.line((col_x + col_w, 0, col_x + col_w, H), fill=LINE, width=1)
    d.text((col_x + 16, 16), "Home", font=font(20, bold=True), fill=WHITE)
    d.line((col_x, 56, col_x + col_w, 56), fill=LINE, width=1)

    y = 57
    for p in (PLAIN, REWRITTEN, COLLAPSED):
        y = draw_post(d, col_x, y, col_w, p, k=1.0) + 1

    # A post still being scored: blurred placeholder bars.
    pad, av = 16, 48
    d.ellipse((col_x + pad, y + pad, col_x + pad + av, y + pad + av), fill=AVATAR)
    tx = col_x + pad + av + 12
    d.rounded_rectangle((tx, y + 18, tx + 180, y + 32), radius=7, fill=(40, 43, 47))
    for i, w in enumerate((470, 430, 260)):
        d.rounded_rectangle((tx, y + 46 + i * 24, tx + w, y + 60 + i * 24), radius=7, fill=(32, 35, 39))

    # Right column: search box.
    d.rounded_rectangle((1030, 12, 1260, 54), radius=21, fill=(32, 35, 39))
    d.text((1050, 23), "Search", font=font(15), fill=MUTED)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = {
        "promo-tile-440x280.png": (promo_tile, (440, 280)),
        "marquee-1400x560.png": (marquee, (1400, 560)),
        "screenshot-1280x800.png": (screenshot, (1280, 800)),
    }
    ok = True
    for name, (fn, size) in targets.items():
        img = fn()
        assert img.size == size, (name, img.size)
        path = os.path.join(OUT, name)
        img.save(path, optimize=True)
        got = Image.open(path).size
        ok &= got == size
        print(f"{os.path.relpath(path, ROOT)}  {got[0]}x{got[1]}  {os.path.getsize(path) // 1024} KB")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
