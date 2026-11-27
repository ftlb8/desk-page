# Draws the Desk icon as PNG files with no outside libraries: rounded rectangles with smooth edges.
import zlib, struct, sys, os

def hexc(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))
BG, CARD, LINE = hexc("#161614"), hexc("#2b2b27"), hexc("#f1efe8")
ORGS = [hexc("#a990f5"), hexc("#55c98a"), hexc("#6fa8ee")]

def cover(px, py, x, y, w, h, r):
    # how much of the pixel centre (px, py) lies inside the rounded rectangle, 0..1
    cx, cy = x + w / 2, y + h / 2
    dx, dy = abs(px - cx) - (w / 2 - r), abs(py - cy) - (h / 2 - r)
    ox, oy = max(dx, 0), max(dy, 0)
    d = (ox * ox + oy * oy) ** 0.5 + min(max(dx, dy), 0) - r
    return min(1.0, max(0.0, 0.5 - d))

def shapes(size, maskable):
    k = size / 512
    s = []  # (x, y, w, h, r, colour)
    grow = 1.0 if maskable else 1.16           # the plain icon uses more of the tile
    cw, ch, gap = 288 * grow, 72 * grow, 24 * grow
    x0, y0 = (512 - cw) / 2, (512 - (3 * ch + 2 * gap)) / 2
    for i, col in enumerate(ORGS):
        y = y0 + i * (ch + gap)
        s.append((x0, y, cw, ch, 18 * grow, col))                               # the card in its organisation colour
        s.append((x0 + 16 * grow, y - 1, cw - 16 * grow + 1, ch + 2, 19 * grow, CARD))  # its body, leaving the colour bar at the left
        s.append((x0 + 16 * grow, y - 1, 20 * grow, ch + 2, 0, CARD))                    # square off the body's left side
        lw = (176, 132, 152)[i] * grow
        s.append((x0 + 44 * grow, y + ch / 2 - 8 * grow, lw, 16 * grow, 8 * grow, LINE))
    return [(a * k, b * k, c * k, d * k, e * k, col) for a, b, c, d, e, col in s]

def draw(size, maskable, path):
    sh = shapes(size, maskable)
    tile_r = 0 if maskable else size * 0.22
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            cxp, cyp = px + 0.5, py + 0.5
            a = cover(cxp, cyp, 0, 0, size, size, tile_r)
            r, g, b = BG
            for (x, y, w, h, rad, col) in sh:
                if cyp < y - 1 or cyp > y + h + 1 or cxp < x - 1 or cxp > x + w + 1: continue
                c = cover(cxp, cyp, x, y, w, h, rad)
                if c > 0:
                    r, g, b = r + (col[0] - r) * c, g + (col[1] - g) * c, b + (col[2] - b) * c
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a * 255 + 0.5)))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    open(path, "wb").write(png)

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for name, size, mask in [("icon-512.png", 512, False), ("icon-192.png", 192, False), ("icon-180.png", 180, False), ("icon-32.png", 32, False), ("icon-maskable-512.png", 512, True)]:
    draw(size, mask, os.path.join(out, name))
    print(name, os.path.getsize(os.path.join(out, name)))
