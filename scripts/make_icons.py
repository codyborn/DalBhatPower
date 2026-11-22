#!/usr/bin/env python3
# Usage: python3 scripts/make_icons.py public/icons   (needs Pillow)
# Dal Bhat Power app icon v2: top-down steel thali in front of a snowy peak, on turmeric.
import sys, math, random
from PIL import Image, ImageDraw, ImageFilter

S = 2048  # draw big, downsample for crisp edges
random.seed(7)

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def radial(size, inner, outer, center=(0.5, 0.5)):
    """Radial gradient image (RGBA)."""
    g = Image.new('RGBA', (size, size))
    px = g.load()
    cx, cy = center[0] * size, center[1] * size
    maxd = size * 0.75
    for y in range(0, size, 4):
        for x in range(0, size, 4):
            t = min(1, math.hypot(x - cx, y - cy) / maxd)
            c = lerp(inner, outer, t)
            for dy in range(4):
                for dx in range(4):
                    if x + dx < size and y + dy < size: px[x + dx, y + dy] = c
    return g

def draw_icon(maskable):
    img = radial(S, (230, 140, 40, 255), (168, 72, 10, 255), (0.5, 0.35))
    d = ImageDraw.Draw(img)
    k = 0.82 if maskable else 0.94          # keep maskable content inside the safe zone
    def P(x, y): return (S / 2 + (x - .5) * S * k, S / 2 + (y - .5) * S * k)

    # Mountain range behind the plate
    back = [P(-.2, .62), P(.12, .42), P(.24, .5), P(.5, .14), P(.7, .38), P(.82, .3), P(1.2, .55), P(1.2, 1.3), P(-.2, 1.3)]
    d.polygon(back, fill=(120, 48, 8, 255))
    # Lower foothill ridge for depth
    d.polygon([P(-.2, .78), P(.15, .66), P(.35, .74), P(.6, .62), P(.85, .72), P(1.2, .64), P(1.2, 1.3), P(-.2, 1.3)], fill=(96, 36, 6, 255))
    snow = [P(.5, .14), P(.41, .27), P(.45, .26), P(.48, .3), P(.52, .25), P(.56, .29), P(.59, .27)]
    d.polygon(snow, fill=(255, 250, 242, 255))
    snow2 = [P(.82, .3), P(.77, .36), P(.8, .355), P(.83, .38), P(.86, .35)]
    d.polygon(snow2, fill=(255, 250, 242, 255))

    # Plate shadow
    cx, cy = P(.5, .6)
    R = S * k * .34
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - R, cy - R + R * .08, cx + R, cy + R + R * .08], fill=(60, 20, 0, 120))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * .015)))
    d = ImageDraw.Draw(img)

    # Steel plate: rim with a soft highlight, inner well
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(203, 206, 210, 255))
    hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).arc([cx - R * .97, cy - R * .97, cx + R * .97, cy + R * .97], 200, 300, fill=(255, 255, 255, 170), width=int(R * .05))
    img.alpha_composite(hl.filter(ImageFilter.GaussianBlur(S * .004)))
    d = ImageDraw.Draw(img)
    r2 = R * .84
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(232, 234, 236, 255))

    # Rice mound with grain texture
    rr = R * .38
    rx, ry = cx - R * .2, cy + R * .2
    d.ellipse([rx - rr, ry - rr, rx + rr, ry + rr], fill=(255, 255, 252, 255))
    for _ in range(140):
        a = random.uniform(0, 2 * math.pi); rad = rr * math.sqrt(random.uniform(0, .85))
        gx, gy = rx + rad * math.cos(a), ry + rad * math.sin(a)
        L = rr * .07; ang = random.uniform(0, math.pi)
        d.line([gx - L * math.cos(ang), gy - L * math.sin(ang), gx + L * math.cos(ang), gy + L * math.sin(ang)],
               fill=(232, 228, 214, 255), width=max(2, int(S * .003)))

    # Katori bowls: dal, saag, achar, tarkari
    def katori(bx, by, br, fill, edge):
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=(178, 182, 188, 255))
        d.ellipse([bx - br * .9, by - br * .9, bx + br * .9, by + br * .9], fill=(214, 217, 221, 255))
        ib = br * .74
        d.ellipse([bx - ib, by - ib, bx + ib, by + ib], fill=fill)
        d.ellipse([bx - ib * .55, by - ib * .7, bx - ib * .05, by - ib * .35], fill=edge)  # glossy fleck
    katori(cx + R * .4, cy - R * .36, R * .3, (242, 176, 30, 255), (255, 214, 120, 255))   # dal
    katori(cx - R * .3, cy - R * .5, R * .22, (74, 122, 20, 255), (120, 168, 60, 255))    # saag
    katori(cx + R * .52, cy + R * .3, R * .19, (190, 30, 30, 255), (235, 90, 80, 255))     # achar
    # Papad leaning on the rim
    pr = R * .2
    px_, py_ = cx - R * .52, cy + R * .1
    d.ellipse([px_ - pr, py_ - pr, px_ + pr, py_ + pr], fill=(236, 205, 140, 255))
    for _ in range(14):
        a = random.uniform(0, 2 * math.pi); rad = pr * random.uniform(.1, .8)
        dx, dy = px_ + rad * math.cos(a), py_ + rad * math.sin(a)
        d.ellipse([dx - pr * .05, dy - pr * .05, dx + pr * .05, dy + pr * .05], fill=(200, 160, 90, 255))
    return img

out = sys.argv[1]
any_icon = draw_icon(False)
mask_icon = draw_icon(True)
for name, src, size in [('icon-192.png', any_icon, 192), ('icon-512.png', any_icon, 512),
                        ('maskable-512.png', mask_icon, 512), ('apple-touch-icon.png', any_icon, 180),
                        ]:
    src.resize((size, size), Image.LANCZOS).convert('RGB').save(f'{out}/{name}', optimize=True)
print('ok')
