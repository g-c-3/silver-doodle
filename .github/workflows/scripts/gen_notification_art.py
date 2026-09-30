#!/usr/bin/env python3
"""Generates the artwork used by the twice-a-day reminder notifications
(client/src/js/notifications.js) and drops it into the CI-generated Android
project as plain drawable resources.

Why this exists: client/android/ is never committed (see docs/DECISIONS.md's
"android/ generated fresh in CI" entry), so binary artwork can't live there,
and hand-committing six PNGs from a phone is needless friction. Same
"generated fresh every run" pattern as the app icon.

What it produces, under client/android/app/src/main/res/:
  drawable-nodpi/notif_board_1.png ... notif_board_6.png
      192x192 "screenshot" of a game board with a match one swap away:
      a tile grid of emoji on the app's dark background, a neon frame, and
      a glowing ring + arrow on the pair of tiles that completes a
      three-in-a-row. Six different emoji sets so consecutive notifications
      look different. Shown as the notification's large icon.
  drawable/ic_stat_match.xml
      White three-dot "match" silhouette for the status-bar small icon.
      Android requires small icons to be single-colour alpha shapes; the
      launcher icon would render as a solid blob.

Deliberately 192x192, not a wide banner: the notification plugin
(@capacitor/local-notifications 8.x) builds the notification ahead of time
and hands the whole object to AlarmManager inside a PendingIntent, and it
exposes no big-picture style on Android. A wide bitmap there would need a
native patch of the plugin that cannot be compiled or tested from this
repo's CI-only workflow. See docs/DECISIONS.md.

Requires: Pillow, and the Noto Color Emoji font (apt: fonts-noto-color-emoji).
Fails loudly if either is missing -- a build with no art should not ship
silently, since the notification would then reference drawables that do not
exist.
"""
import pathlib
import random
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RES = pathlib.Path("client/android/app/src/main/res")
SIZE = 192          # final PNG edge, px
SS = 2              # supersampling factor for smooth edges
GRID = 4            # 4x4 tiles reads clearly at thumbnail size
BG = (20, 18, 31)           # --bg      #14121f
PANEL = (36, 32, 56)        # slightly lighter tile panel
PINK = (255, 111, 145)      # --accent  #ff6f91
VIOLET = (124, 111, 255)    # --accent-2 #7c6fff
GOLD = (245, 185, 66)       # --gold    #f5b942

# Six sets of 6 emoji, all Emoji <= 12 so they render on the build font and
# on older Android alike (same reasoning as attempt.js's THEMES).
SETS = [
    ["🍒", "🍋", "🍇", "🍊", "🍓", "🥝"],   # fruit
    ["🐶", "🐱", "🐸", "🐼", "🦊", "🐵"],   # animals
    ["💜", "💙", "💚", "💛", "🧡", "❤️"],   # hearts (VS16 stripped below)
    ["🌙", "⭐", "☀️", "🪐", "🌈", "☁️"],   # sky
    ["🍕", "🍩", "🍔", "🍦", "🍪", "🍉"],   # snacks
    ["🐙", "🐠", "🐳", "🦀", "🐚", "🐢"],   # sea
]


def find_emoji_font() -> str:
    candidates = [
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf",
    ]
    try:
        out = subprocess.run(
            ["fc-match", "-f", "%{file}", "Noto Color Emoji"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
        if out:
            candidates.insert(0, out)
    except FileNotFoundError:
        pass
    for c in candidates:
        if c and pathlib.Path(c).exists() and "Emoji" in c:
            return c
    sys.exit(
        "ART FAILED: Noto Color Emoji font not found. Install it in the "
        "workflow first (apt-get install -y fonts-noto-color-emoji)."
    )


FONT_PATH = find_emoji_font()
# CBDT bitmap font: only size 109 is valid; scale the rendered glyph after.
EMOJI_FONT = ImageFont.truetype(FONT_PATH, 109)


def glyph(ch: str, px: int) -> Image.Image:
    """Render one emoji to an RGBA image `px` wide."""
    ch = ch.replace("\ufe0f", "")  # keep font lookup simple; glyph is the same
    canvas = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((0, 0), ch, font=EMOJI_FONT, embedded_color=True)
    bbox = canvas.getbbox()
    if bbox is None:
        sys.exit(f"ART FAILED: font produced an empty glyph for {ch!r}.")
    canvas = canvas.crop(bbox)
    scale = px / max(canvas.size)
    return canvas.resize(
        (max(1, round(canvas.width * scale)), max(1, round(canvas.height * scale))),
        Image.LANCZOS,
    )


def has_match(b) -> bool:
    n = len(b)
    for r in range(n):
        for c in range(n):
            if c + 2 < n and b[r][c] == b[r][c + 1] == b[r][c + 2]:
                return True
            if r + 2 < n and b[r][c] == b[r + 1][c] == b[r + 2][c]:
                return True
    return False


def build_board(rng: random.Random):
    """Return (board, (r1,c1), (r2,c2)): a board with NO existing match and
    exactly the staged swap that would complete three in a row."""
    for _ in range(500):
        b = [[rng.randrange(6) for _ in range(GRID)] for _ in range(GRID)]
        hero = rng.randrange(6)
        r = rng.randrange(0, GRID - 1)          # row that gets the pair
        c = rng.randrange(0, GRID - 2)          # pair sits at c, c+1
        # Row r:  H H X .   and the tile below X's column is H (swap up).
        b[r][c] = hero
        b[r][c + 1] = hero
        x = (hero + 1 + rng.randrange(5)) % 6   # anything but hero
        b[r][c + 2] = x
        b[r + 1][c + 2] = hero
        if has_match(b):
            continue
        return b, (r, c + 2), (r + 1, c + 2)
    sys.exit("ART FAILED: could not build a match-free staged board.")


def glow_ring(size, box, color, width):
    """Soft neon ring around `box` on a transparent layer of `size`."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=14 * SS, outline=color + (255,), width=width)
    blur = layer.filter(ImageFilter.GaussianBlur(5 * SS))
    return Image.alpha_composite(blur, layer)


def render(index: int, emoji_set) -> Image.Image:
    rng = random.Random(1000 + index)
    board, a, b = build_board(rng)
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), BG + (255,))
    d = ImageDraw.Draw(img)

    # Soft diagonal violet->pink wash behind the board.
    wash = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wash)
    for i in range(W):
        t = i / W
        col = (
            int(VIOLET[0] * (1 - t) + PINK[0] * t),
            int(VIOLET[1] * (1 - t) + PINK[1] * t),
            int(VIOLET[2] * (1 - t) + PINK[2] * t),
            60,
        )
        wd.line([(i, 0), (0, i)], fill=col, width=2)
        wd.line([(W, i), (i, W)], fill=col, width=2)
    img = Image.alpha_composite(img, wash)
    d = ImageDraw.Draw(img)

    pad = 12 * SS
    gap = 4 * SS
    tile = (W - 2 * pad - (GRID - 1) * gap) // GRID

    def cell_box(r, c):
        x0 = pad + c * (tile + gap)
        y0 = pad + r * (tile + gap)
        return (x0, y0, x0 + tile, y0 + tile)

    for r in range(GRID):
        for c in range(GRID):
            box = cell_box(r, c)
            d.rounded_rectangle(box, radius=10 * SS, fill=PANEL + (255,))
            g = glyph(emoji_set[board[r][c]], int(tile * 0.74))
            gx = box[0] + (tile - g.width) // 2
            gy = box[1] + (tile - g.height) // 2
            img.alpha_composite(g, (gx, gy))

    # Highlight the swap pair: glowing gold rings on both tiles and a
    # vertical double arrow between them.
    for cell in (a, b):
        bx = cell_box(*cell)
        pad2 = 2 * SS
        ring_box = (bx[0] - pad2, bx[1] - pad2, bx[2] + pad2, bx[3] + pad2)
        img = Image.alpha_composite(img, glow_ring((W, W), ring_box, GOLD, 3 * SS))
    d = ImageDraw.Draw(img)
    ax = (cell_box(*a)[0] + cell_box(*a)[2]) // 2
    ay = (cell_box(*a)[3] + cell_box(*b)[1]) // 2
    d.polygon([(ax, ay - 5 * SS), (ax - 5 * SS, ay + 1 * SS), (ax + 5 * SS, ay + 1 * SS)],
              fill=GOLD + (255,))
    d.polygon([(ax, ay + 5 * SS), (ax - 5 * SS, ay - 1 * SS), (ax + 5 * SS, ay - 1 * SS)],
              fill=GOLD + (255,))

    # Neon frame around the whole board.
    frame = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((3 * SS, 3 * SS, W - 3 * SS, W - 3 * SS),
                         radius=22 * SS, outline=PINK + (255,), width=3 * SS)
    img = Image.alpha_composite(img, frame.filter(ImageFilter.GaussianBlur(4 * SS)))
    img = Image.alpha_composite(img, frame)

    # Round the outer corners so it reads as a card, then downsample.
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W, W), radius=26 * SS, fill=255)
    out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out.resize((SIZE, SIZE), Image.LANCZOS)


SMALL_ICON_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by .github/workflows/scripts/gen_notification_art.py.
     White silhouette only: Android tints/masks status-bar icons by alpha. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M5,8.5m-3.2,0a3.2,3.2 0,1 1,6.4 0a3.2,3.2 0,1 1,-6.4 0" />
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,8.5m-3.2,0a3.2,3.2 0,1 1,6.4 0a3.2,3.2 0,1 1,-6.4 0" />
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M19,8.5m-3.2,0a3.2,3.2 0,1 1,6.4 0a3.2,3.2 0,1 1,-6.4 0" />
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M5,17.5m-3.2,0a3.2,3.2 0,1 1,6.4 0a3.2,3.2 0,1 1,-6.4 0" />
</vector>
"""


def main() -> None:
    if not RES.parent.exists():
        sys.exit(
            "ART FAILED: client/android/app/src/main not found -- run this "
            "after `npx cap add android`."
        )
    nodpi = RES / "drawable-nodpi"
    nodpi.mkdir(parents=True, exist_ok=True)
    (RES / "drawable").mkdir(parents=True, exist_ok=True)

    for i, emoji_set in enumerate(SETS, start=1):
        target = nodpi / f"notif_board_{i}.png"
        render(i, emoji_set).save(target, optimize=True)
        print(f"wrote {target} ({target.stat().st_size} bytes)")

    icon = RES / "drawable" / "ic_stat_match.xml"
    icon.write_text(SMALL_ICON_XML)
    print(f"wrote {icon}")


if __name__ == "__main__":
    main()
