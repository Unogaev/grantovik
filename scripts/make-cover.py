#!/usr/bin/env python3
"""Генерирует обложки 1200x675 PNG для статей, у которых их ещё нет.
Дзен требует картинку шириной от 700 px. Запуск: python3 scripts/make-cover.py
Нужен Pillow: pip install pillow
"""
import os, re, glob, textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = os.getcwd()
FONT_DIR = os.path.join(ROOT, "assets", "fonts")
OUT = os.path.join(ROOT, "blog", "covers")
W, H = 1200, 675
BG, INK, RED, MUTED = (244, 239, 230), (21, 21, 21), (215, 38, 30), (93, 88, 80)

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    ["a","b","v","g","d","e","e","zh","z","i","y","k","l","m","n","o","p","r","s","t","u","f","h","ts","ch","sh","sch","","y","","e","yu","ya"]))

def translit(s):
    s = "".join(TR.get(c, c) for c in s.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60]

def meta(path):
    raw = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    d = {}
    for line in (m.group(1) if m else "").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            d[k.strip()] = v.strip().strip('"')
    d.setdefault("slug", translit(d.get("title", "")))
    return d

def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)

def fit_title(draw, text, max_w, max_lines):
    for size in range(76, 38, -4):
        f = font("Inter-Bold.otf", size)
        avg = f.getlength("абвгдеж") / 7
        lines = textwrap.wrap(text, width=max(8, int(max_w / avg)))
        if len(lines) <= max_lines and all(draw.textlength(l, font=f) <= max_w for l in lines):
            return f, lines, size
    f = font("Inter-Bold.otf", 40)
    return f, textwrap.wrap(text, width=int(max_w / (f.getlength("абвгдеж") / 7)))[:max_lines], 40

def make(d):
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    pad = 72
    # логотип
    lf = font("Inter-Bold.otf", 34)
    dr.text((pad, pad - 6), "Грантовик", font=lf, fill=INK)
    lw = dr.textlength("Грантовик", font=lf)
    dr.ellipse((pad + lw + 6, pad + 24, pad + lw + 18, pad + 36), fill=RED)
    # тег
    tag = (d.get("tags", "").split(",")[0] or "гранты").strip().upper()
    tf = font("Inter-Medium.otf", 22)
    tw = dr.textlength(tag, font=tf)
    dr.rounded_rectangle((W - pad - tw - 32, pad - 4, W - pad, pad + 38), radius=19, outline=INK, width=2)
    dr.text((W - pad - tw - 16, pad + 2), tag, font=tf, fill=INK)
    # заголовок
    f, lines, size = fit_title(dr, d.get("cover_title") or d["title"], W - 2 * pad, 4)
    lh = int(size * 1.14)
    y = H - pad - 30 - lh * len(lines)
    for l in lines:
        dr.text((pad, y), l, font=f, fill=INK)
        y += lh
    dr.rectangle((pad, H - pad - 6, pad + 120, H - pad), fill=RED)
    dr.text((pad + 140, H - pad - 22), "grantovik.ru", font=font("Inter-Medium.otf", 22), fill=MUTED)
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, d["slug"] + ".png")
    img.save(out, optimize=True)
    return out

if __name__ == "__main__":
    n = 0
    for p in sorted(glob.glob(os.path.join(ROOT, "content", "articles", "*.md"))):
        d = meta(p)
        if not os.path.exists(os.path.join(OUT, d["slug"] + ".png")) or os.environ.get("FORCE"):
            print("cover:", make(d)); n += 1
    print(f"Новых обложек: {n}")
