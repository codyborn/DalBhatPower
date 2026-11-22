#!/usr/bin/env python3
# Dal Bhat Power app icon: a plate of rice and dal on fire ("dal bhat power").
# Usage: python3 scripts/make_icons.py public/icons   (needs Pillow)
import sys, math
from PIL import Image, ImageDraw, ImageFilter

S = 2048

def radial(inner, outer, center=(0.5, 0.42), reach=0.8):
    small = 256
    g = Image.new('RGB', (small, small))
    px = g.load()
    for y in range(small):
        for x in range(small):
            t = min(1, math.hypot(x / small - center[0], y / small - center[1]) / reach)
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(3))
    return g.resize((S, S), Image.BICUBIC).convert('RGBA')

def flame(cx, base_y, w, h, lean=0.0, steps=160):
    """Teardrop flame: round bottom at base_y, pointed tip at base_y - h, tip curving by `lean`."""
    pts = []
    for i in range(steps + 1):
        t = 2 * math.pi * i / steps
        up = (1 - math.cos(t)) / 2                          # 0 at the bottom … 1 at the tip
        width = math.sin(t) * abs(math.cos(t / 2)) ** 1.3   # round bottom, zero width at the tip
        px = cx + w * width + lean * w * up ** 2.2
        py = base_y - h * up
        pts.append((px, py))
    return pts

def draw(maskable):
    img = radial((150, 40, 12), (52, 10, 6))
    d = ImageDraw.Draw(img)
    k = 0.80 if maskable else 0.95
    def X(v): return S / 2 + (v - 0.5) * S * k
    def Y(v): return S / 2 + (v - 0.5) * S * k
    u = S * k

    # Glow behind the fire
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([X(.18), Y(.12), X(.82), Y(.78)], fill=(255, 140, 20, 120))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(S * .06)))

    # Flames: three layers (red → orange → yellow), several tongues
    base = Y(.70)
    # (x, width, height, lean) — overlapping tongues read as one fire
    tongues = [(.5, .44, .66, 0.15), (.36, .32, .50, -0.7), (.64, .32, .52, 0.7),
               (.25, .22, .34, -0.9), (.75, .22, .36, 0.9)]
    layers = [((226, 58, 18, 255), 1.0), ((248, 132, 18, 255), .74), ((255, 210, 64, 255), .48)]
    fire = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fire)
    for color, scale in layers:
        for x, w, h, lean in tongues:
            fd.polygon(flame(X(x), base, u * w * scale / 2, u * h * scale, lean), fill=color)
    img.alpha_composite(fire.filter(ImageFilter.GaussianBlur(S * .002)))
    d = ImageDraw.Draw(img)

    # Plate (side-on view, like the curry-rice emoji)
    cx = X(.5)
    rim_top, rim_h, rim_w = Y(.60), u * .13, u * .40
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - rim_w, rim_top + rim_h * .55, cx + rim_w, rim_top + rim_h * 1.65], fill=(0, 0, 0, 120))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * .015)))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - rim_w * .62, rim_top + rim_h * .55, cx + rim_w * .62, rim_top + rim_h * 1.25], fill=(150, 155, 162, 255))   # foot
    d.ellipse([cx - rim_w, rim_top, cx + rim_w, rim_top + rim_h], fill=(214, 218, 224, 255))                                     # rim
    d.ellipse([cx - rim_w * .86, rim_top + rim_h * .12, cx + rim_w * .86, rim_top + rim_h * .86], fill=(240, 242, 245, 255))     # well

    # Rice dome
    rw, rh = rim_w * .58, u * .2
    ry = rim_top + rim_h * .5
    d.pieslice([cx - rw - u * .04, ry - rh, cx + rw - u * .04, ry + rh], 180, 360, fill=(255, 255, 252, 255))
    d.ellipse([cx - rw - u * .04, ry - rh * .12, cx + rw - u * .04, ry + rh * .14], fill=(255, 255, 252, 255))

    # Dal poured over the right of the rice, pooling on the plate (kept inside rice + plate well)
    dal = Image.new('L', (S, S), 0)
    dd = ImageDraw.Draw(dal)
    dd.ellipse([cx - u * .02, ry - rh * .78, cx + u * .3, ry + rh * .2], fill=255)
    dd.ellipse([cx - u * .06, ry - rh * .02, cx + rim_w * .84, ry + rh * .2], fill=255)
    clip = Image.new('L', (S, S), 0)
    cd = ImageDraw.Draw(clip)
    cd.pieslice([cx - rw - u * .04, ry - rh, cx + rw - u * .04, ry + rh], 180, 360, fill=255)
    cd.ellipse([cx - rim_w * .86, rim_top + rim_h * .12, cx + rim_w * .86, rim_top + rim_h * .86], fill=255)
    from PIL import ImageChops
    dal = ImageChops.multiply(dal, clip).filter(ImageFilter.GaussianBlur(S * .002))
    img.paste((228, 152, 20, 255), (0, 0), dal)
    d = ImageDraw.Draw(img)
    d.ellipse([cx + u * .1, ry - rh * .6, cx + u * .18, ry - rh * .45], fill=(255, 210, 120, 255))   # shine
    # Saag and achar on the plate
    d.ellipse([cx - rim_w * .82, ry - rh * .02, cx - rim_w * .52, ry + rh * .17], fill=(72, 120, 22, 255))
    d.ellipse([cx + rim_w * .5, ry + rh * .02, cx + rim_w * .7, ry + rh * .15], fill=(190, 30, 30, 255))
    return img

out = sys.argv[1]
a, m = draw(False), draw(True)
for name, src, size in [('icon-192.png', a, 192), ('icon-512.png', a, 512), ('maskable-512.png', m, 512), ('apple-touch-icon.png', a, 180)]:
    src.resize((size, size), Image.LANCZOS).convert('RGB').save(f'{out}/{name}', optimize=True)
print('ok')
