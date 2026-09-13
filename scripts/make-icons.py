#!/usr/bin/env python3
"""Draws the toolbar/store icons with Pillow: a pair of scissors, crossed out, on a dark rounded square."""
from PIL import Image, ImageDraw
import math, os

S = 512
BG = (28, 28, 33, 255)
WHITE = (255, 255, 255, 255)
RED = (255, 92, 92, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, S - 1, S - 1), radius=112, fill=BG)

w = 30  # stroke width
# Two blades meeting at a pivot, opening toward the upper right.
pivot = (236, 268)
for ang in (-62, -18):
    a = math.radians(ang)
    tip = (pivot[0] + 200 * math.cos(a), pivot[1] + 200 * math.sin(a))
    d.line([pivot, tip], fill=WHITE, width=w)
    d.ellipse((tip[0] - w / 2, tip[1] - w / 2, tip[0] + w / 2, tip[1] + w / 2), fill=WHITE)
# Handles: two rings below/left of the pivot.
for cx, cy in ((120, 372), (218, 428)):
    r = 54
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=WHITE, width=w)
d.ellipse((pivot[0] - 22, pivot[1] - 22, pivot[0] + 22, pivot[1] + 22), fill=BG)
d.ellipse((pivot[0] - 22, pivot[1] - 22, pivot[0] + 22, pivot[1] + 22), outline=WHITE, width=16)

# The "no": a diagonal bar with a soft gap behind it so it reads on top of the scissors.
gap = Image.new("RGBA", (S, S), (0, 0, 0, 0))
g = ImageDraw.Draw(gap)
g.line([(112, 112), (400, 400)], fill=BG, width=w + 34)
img.alpha_composite(gap)
d.line([(112, 112), (400, 400)], fill=RED, width=w + 6)
for x, y in ((112, 112), (400, 400)):
    r = (w + 6) / 2
    d.ellipse((x - r, y - r, x + r, y + r), fill=RED)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(out, exist_ok=True)
for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(out, f"icon{size}.png"))
print("icons written to", os.path.abspath(out))
