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

    # Steel thali in three-quarter view: rice mound, katoris of dal and tarkari, saag, achar, papad
    cx = X(.5)
    pcy = Y(.735)                      # plate centre
    R = u * .43                        # plate radius (x)
    sq = .5                            # perspective squash (y/x)
    def ell(x, y, rx, ry):             # box for an ellipse centred at x, y
        return [x - rx, y - ry, x + rx, y + ry]

    # shadow + plate body (side band) + rim + floor
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse(ell(cx, pcy + R * sq * .35, R * 1.02, R * sq * 1.02), fill=(0, 0, 0, 130))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * .016)))
    d = ImageDraw.Draw(img)
    d.ellipse(ell(cx, pcy + u * .03, R, R * sq), fill=(140, 146, 154, 255))           # plate edge (depth)
    d.ellipse(ell(cx, pcy, R, R * sq), fill=(206, 211, 218, 255))                      # rim
    d.ellipse(ell(cx, pcy + u * .006, R * .86, R * sq * .84), fill=(236, 239, 242, 255))  # floor
    hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).arc(ell(cx, pcy, R * .95, R * sq * .93), 195, 300, fill=(255, 255, 255, 200), width=int(u * .012))
    img.alpha_composite(hl.filter(ImageFilter.GaussianBlur(S * .003)))
    d = ImageDraw.Draw(img)

    def katori(x, y, r, liquid, lines=None):
        """Small steel bowl: body band, rim, liquid surface."""
        h = r * .55
        d.ellipse(ell(x, y + h * .9, r * .82, r * sq * .8), fill=(120, 126, 134, 255))     # base
        d.rectangle([x - r * .9, y, x + r * .9, y + h * .9], fill=(176, 182, 190, 255))     # side
        d.ellipse(ell(x, y + h * .9, r * .9, r * sq * .85), fill=(176, 182, 190, 255))
        d.ellipse(ell(x, y, r, r * sq), fill=(220, 224, 230, 255))                         # rim
        d.ellipse(ell(x, y + r * sq * .08, r * .82, r * sq * .74), fill=liquid)            # dal / curry
        d.ellipse(ell(x - r * .3, y - r * sq * .25, r * .22, r * sq * .14), fill=(255, 255, 255, 110))  # gloss
        for (ox, oy, rr, c) in (lines or []):
            d.ellipse(ell(x + ox * r, y + oy * r * sq, rr * r, rr * r * sq), fill=c)

    # Papad standing up behind the rice
    pr = R * .2
    pp = (cx + R * .02, pcy - R * sq * .55)
    d.ellipse(ell(pp[0], pp[1], pr, pr * .9), fill=(232, 196, 126, 255))
    random_dots = [(-.4, -.3), (.3, -.2), (.1, .35), (-.2, .15), (.45, .25), (-.05, -.55)]
    for (ox, oy) in random_dots:
        d.ellipse(ell(pp[0] + ox * pr, pp[1] + oy * pr, pr * .06, pr * .06), fill=(190, 140, 70, 255))

    # Back row first (painter's order): tarkari (left), dal (right)
    katori(cx - R * .5, pcy - R * sq * .42, R * .26, (214, 150, 40, 255),
           [(-.3, .05, .16, (240, 210, 120, 255)), (.25, -.1, .14, (236, 196, 96, 255)), (.05, .3, .13, (120, 160, 40, 255))])
    katori(cx + R * .46, pcy - R * sq * .45, R * .3, (238, 178, 34, 255),
           [(.2, .15, .07, (200, 130, 20, 255)), (-.15, -.05, .05, (200, 130, 20, 255))])

    # Rice mound (centre-front), with grain texture
    rx, ry_ = cx - R * .02, pcy + R * sq * .12
    rw, rh = R * .42, u * .15
    d.pieslice(ell(rx, ry_, rw, rh), 180, 360, fill=(255, 255, 251, 255))
    d.ellipse(ell(rx, ry_, rw, rw * sq * .5), fill=(255, 255, 251, 255))
    import random
    random.seed(4)
    for _ in range(90):
        a = random.uniform(math.pi, 2 * math.pi); rad = random.uniform(.05, .9)
        gx = rx + rw * rad * math.cos(a); gy = ry_ + rh * rad * math.sin(a)
        L = u * .012; ang = random.uniform(0, math.pi)
        d.line([gx - L * math.cos(ang), gy - L * math.sin(ang), gx + L * math.cos(ang), gy + L * math.sin(ang)],
               fill=(228, 224, 210, 255), width=max(2, int(S * .0025)))
    d.arc(ell(rx, ry_, rw * .7, rh * .75), 205, 250, fill=(255, 255, 255, 255), width=int(u * .01))

    # Saag pile (front-left), achar (front-right), papad (leaning at the back-centre)
    for (ox, oy, rr) in ((-.62, .25, .13), (-.5, .33, .12), (-.7, .36, .1), (-.58, .42, .09)):
        d.ellipse(ell(cx + R * ox, pcy + R * sq * oy, R * rr, R * rr * .7), fill=(58, 108, 24, 255))
    d.ellipse(ell(cx + R * -.56, pcy + R * sq * .28, R * .05, R * .03), fill=(110, 160, 50, 255))
    d.ellipse(ell(cx + R * .55, pcy + R * sq * .38, R * .13, R * .085), fill=(196, 40, 24, 255))
    d.ellipse(ell(cx + R * .51, pcy + R * sq * .34, R * .04, R * .025), fill=(240, 110, 80, 255))
    return img

out = sys.argv[1]
a, m = draw(False), draw(True)
for name, src, size in [('icon-192.png', a, 192), ('icon-512.png', a, 512), ('maskable-512.png', m, 512), ('apple-touch-icon.png', a, 180)]:
    src.resize((size, size), Image.LANCZOS).convert('RGB').save(f'{out}/{name}', optimize=True)
print('ok')
