#!/usr/bin/env python3
"""Render a `tmux capture-pane -e -p` ANSI dump to PNG (cell-accurate approximation, not Ghostty itself).

usage: ansi-png.py INPUT.ansi OUTPUT.png [--cols 110] [--bg #0a0e0a] [--fg #62ff94]
"""
import os
import re
import sys
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
src, dst = args[0], args[1]
opt = {args[i][2:]: args[i + 1] for i in range(2, len(args) - 1, 2)}
COLS = int(opt.get("cols", 110))
BG = opt.get("bg", "#0a0e0a")
FG = opt.get("fg", "#c8d6c8")
FONT = opt.get("font", os.path.expanduser("~/Library/Fonts/JetBrainsMonoNLNerdFontMono-Regular.ttf"))
BOLD = FONT.replace("Regular", "Bold")
SIZE = 15
regular = ImageFont.truetype(FONT, SIZE)
try:
    bold = ImageFont.truetype(BOLD, SIZE)
except OSError:
    bold = regular
cell_w = int(regular.getlength("M"))
cell_h = int(SIZE * 1.45)

# Terminals draw glyphs missing from the main font with a system fallback font; do the same here.
FALLBACKS = []
for path in ["/System/Library/Fonts/Apple Symbols.ttf", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/Menlo.ttc"]:
    try:
        FALLBACKS.append(ImageFont.truetype(path, SIZE))
    except OSError:
        pass
NOTDEF = bytes(regular.getmask("￿"))
_font_cache = {}


def font_for(ch, bold_state):
    key = (ch, bold_state)
    if key not in _font_cache:
        chosen = bold if bold_state else regular
        if ch.strip() and bytes(regular.getmask(ch)) == NOTDEF:
            for fallback in FALLBACKS:
                if bytes(fallback.getmask(ch)) != bytes(fallback.getmask("￿")):
                    chosen = fallback
                    break
        _font_cache[key] = chosen
    return _font_cache[key]

PALETTE_16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
              "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]


def xterm256(n):
    if n < 16:
        return PALETTE_16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


lines = open(src, encoding="utf-8", errors="replace").read().split("\n")
img = Image.new("RGB", (COLS * cell_w + 24, max(1, len(lines)) * cell_h + 24), BG)
draw = ImageDraw.Draw(img)
sgr = re.compile(r"\x1b\[([0-9;]*)m")

for row, line in enumerate(lines):
    state = {"fg": FG, "bg": None, "bold": False, "dim": False, "inverse": False}
    col = 0
    pos = 0
    for match in list(sgr.finditer(line)) + [None]:
        text = line[pos: match.start() if match else len(line)]
        for ch in text:
            fg, bg = state["fg"], state["bg"]
            if state["inverse"]:
                fg, bg = (bg or BG), fg
            x, y = 12 + col * cell_w, 12 + row * cell_h
            if bg:
                draw.rectangle([x, y, x + cell_w, y + cell_h], fill=bg)
            if state["dim"]:
                r, g, b = int(fg[1:3], 16), int(fg[3:5], 16), int(fg[5:7], 16)
                fg = "#%02x%02x%02x" % (r * 6 // 10, g * 6 // 10, b * 6 // 10)
            draw.text((x, y + 2), ch, font=font_for(ch, state["bold"]), fill=fg)
            col += 1
        if not match:
            break
        pos = match.end()
        codes = [int(c) if c else 0 for c in match.group(1).split(";")] or [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                state = {"fg": FG, "bg": None, "bold": False, "dim": False, "inverse": False}
            elif c == 1:
                state["bold"] = True
            elif c == 2:
                state["dim"] = True
            elif c == 7:
                state["inverse"] = True
            elif c == 22:
                state["bold"] = state["dim"] = False
            elif c == 27:
                state["inverse"] = False
            elif c == 39:
                state["fg"] = FG
            elif c == 49:
                state["bg"] = None
            elif 30 <= c <= 37:
                state["fg"] = PALETTE_16[c - 30]
            elif 90 <= c <= 97:
                state["fg"] = PALETTE_16[c - 90 + 8]
            elif 40 <= c <= 47:
                state["bg"] = PALETTE_16[c - 40]
            elif c in (38, 48) and i + 1 < len(codes):
                key = "fg" if c == 38 else "bg"
                if codes[i + 1] == 2 and i + 4 < len(codes):
                    state[key] = "#%02x%02x%02x" % tuple(codes[i + 2:i + 5])
                    i += 4
                elif codes[i + 1] == 5 and i + 2 < len(codes):
                    state[key] = xterm256(codes[i + 2])
                    i += 2
            i += 1
img.save(dst)
print(dst, img.size)
