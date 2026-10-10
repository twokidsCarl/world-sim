"""Style study of the Goodsell reference images.

Reads research/gallery/*.tif and writes research/out/:
  stats.json        per-image palette, hue-sector shares, lightness/chroma
                    ranges, background colour, ink coverage and line width
  preview/<name>.png  1400 px previews for looking at
  palettes.png      one swatch strip per image

Run:  uv run --no-project --with numpy --with scipy --with pillow python -I research/analyze.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.cluster.vq import kmeans2

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
GALLERY = HERE / "gallery"
OUT = HERE / "out"

# Hue sectors in OKLCh degrees, named after Goodsell's own five groups.
# Boundaries were set by eye from where his pigments fall, not from a source.
SECTORS = [
    ("red-orange-yellow", 20.0, 110.0),
    ("green", 110.0, 165.0),
    ("blue-green-blue", 165.0, 275.0),
    ("purple-magenta", 275.0, 380.0),  # wraps past 360 to 20
]
EARTH_CHROMA = 0.075  # warm colours below this chroma read as earth tones
NEUTRAL_CHROMA = 0.025


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb: float array (..., 3) in 0..1 sRGB. Returns OKLab (..., 3)."""
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m1 = np.array(
        [
            [0.4122214708, 0.5363325363, 0.0514459929],
            [0.2119034982, 0.6806995451, 0.1073969566],
            [0.0883024619, 0.2817188376, 0.6299787005],
        ]
    )
    m2 = np.array(
        [
            [0.2104542553, 0.7936177850, -0.0040720468],
            [1.9779984951, -2.4285922050, 0.4505937099],
            [0.0259040371, 0.7827717662, -0.8086757660],
        ]
    )
    lms = np.cbrt(lin @ m1.T)
    return lms @ m2.T


def oklab_to_srgb(lab: np.ndarray) -> np.ndarray:
    m2i = np.array(
        [
            [1.0, 0.3963377774, 0.2158037573],
            [1.0, -0.1055613458, -0.0638541728],
            [1.0, -0.0894841775, -1.2914855480],
        ]
    )
    m1i = np.array(
        [
            [4.0767416621, -3.3077115913, 0.2309699292],
            [-1.2684380046, 2.6097574011, -0.3413193965],
            [-0.0041960863, -0.7034186147, 1.7076147010],
        ]
    )
    lin = ((lab @ m2i.T) ** 3) @ m1i.T
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def to_hex(rgb: np.ndarray) -> str:
    r, g, b = (np.clip(rgb, 0, 1) * 255 + 0.5).astype(int)
    return f"#{r:02X}{g:02X}{b:02X}"


def sector_of(hue_deg: float, chroma: float, light: float) -> str:
    if chroma < NEUTRAL_CHROMA:
        return "neutral"
    h = hue_deg % 360.0
    if h < 20.0:
        h += 360.0
    for name, lo, hi in SECTORS:
        if lo <= h < hi:
            if name == "red-orange-yellow" and chroma < EARTH_CHROMA and light < 0.85:
                return "earth"
            return name
    return "neutral"


def load_rgb(path: Path) -> np.ndarray:
    im = Image.open(path)
    im = im.convert("RGB")
    return im


def line_width(mask: np.ndarray) -> float:
    """Mean stroke width in pixels: twice the mean distance-to-edge on the
    stroke's ridge (local maxima of the distance transform)."""
    if mask.sum() < 50:
        return 0.0
    dt = ndimage.distance_transform_edt(mask)
    ridge = (dt == ndimage.maximum_filter(dt, size=3)) & mask
    if ridge.sum() == 0:
        return 0.0
    return float(2.0 * dt[ridge].mean() - 1.0)


def analyse(path: Path) -> dict:
    full = load_rgb(path)
    w, h = full.size

    # Colour statistics on a downscaled copy (area-averaged).
    scale = 1400 / max(w, h)
    small = full.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    (OUT / "preview").mkdir(parents=True, exist_ok=True)
    small.save(OUT / "preview" / (path.stem + ".png"))

    # Line statistics need native pixels: take a central crop.
    cw, ch = min(w, 1600), min(h, 1600)
    crop = full.crop(((w - cw) // 2, (h - ch) // 2, (w + cw) // 2, (h + ch) // 2))
    crop.save(OUT / "preview" / (path.stem + "_crop.png"))
    crop_lab = srgb_to_oklab(np.asarray(crop, dtype=np.float64) / 255.0)
    crop_c = np.hypot(crop_lab[..., 1], crop_lab[..., 2])
    ink_full = (crop_lab[..., 0] < 0.36) & (crop_c < 0.06)

    rgb = np.asarray(small, dtype=np.float64) / 255.0
    lab = srgb_to_oklab(rgb)
    L = lab[..., 0]
    C = np.hypot(lab[..., 1], lab[..., 2])
    H = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360.0
    ink = (L < 0.36) & (C < 0.06)

    # Background: most common quantised colour along the border.
    border = np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3), rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
    q = (border * 31).round().astype(int)
    keys, counts = np.unique(q, axis=0, return_counts=True)
    bg_q = keys[counts.argmax()]
    bg = border[(q == bg_q).all(axis=1)].mean(axis=0)
    bg_share = float(counts.max() / counts.sum())

    fill = ~ink
    fl = lab[fill]
    rng = np.random.default_rng(0)
    sample = fl[rng.choice(len(fl), size=min(len(fl), 120_000), replace=False)]
    k = 14
    cent, lbl = kmeans2(sample, k, minit="++", seed=1, iter=40)
    share = np.bincount(lbl, minlength=k) / len(lbl)
    order = np.argsort(-share)
    palette = []
    for i in order:
        if share[i] < 0.004:
            continue
        cl, ca, cb = cent[i]
        chroma = float(np.hypot(ca, cb))
        hue = float(np.degrees(np.arctan2(cb, ca)) % 360.0)
        palette.append(
            {
                "hex": to_hex(oklab_to_srgb(cent[i])),
                "share": round(float(share[i]), 4),
                "L": round(float(cl), 3),
                "C": round(chroma, 3),
                "h": round(hue, 1),
                "sector": sector_of(hue, chroma, float(cl)),
            }
        )

    # Sector shares over all non-ink pixels.
    names = ["red-orange-yellow", "earth", "green", "blue-green-blue", "purple-magenta", "neutral"]
    sec = {n: 0 for n in names}
    hs, cs, ls = H[fill], C[fill], L[fill]
    hh = np.where(hs < 20.0, hs + 360.0, hs)
    neutral = cs < NEUTRAL_CHROMA
    sec["neutral"] = int(neutral.sum())
    for name, lo, hi in SECTORS:
        m = (~neutral) & (hh >= lo) & (hh < hi)
        if name == "red-orange-yellow":
            earth = m & (cs < EARTH_CHROMA) & (ls < 0.85)
            sec["earth"] = int(earth.sum())
            m = m & ~earth
        sec[name] = int(m.sum())
    total = sum(sec.values())
    sec = {n: round(v / total, 4) for n, v in sec.items()}

    pct = lambda a: [round(float(x), 3) for x in np.percentile(a, [5, 25, 50, 75, 95])]
    return {
        "file": path.name,
        "size": [w, h],
        "background": {"hex": to_hex(bg), "border_share": round(bg_share, 3)},
        "ink_coverage": round(float(ink_full.mean()), 4),
        "line_width_px": round(line_width(ink_full), 2),
        "line_width_rel": round(line_width(ink_full) / max(w, h) * 1000, 3),
        "fill_L_pct": pct(ls),
        "fill_C_pct": pct(cs),
        "sectors": sec,
        "palette": palette,
    }


def swatches(stats: list[dict]) -> None:
    row, pad, label = 56, 6, 330
    width = label + 14 * 64
    img = Image.new("RGB", (width, len(stats) * (row + pad) + pad), "white")
    d = ImageDraw.Draw(img)
    for r, s in enumerate(stats):
        y = pad + r * (row + pad)
        d.text((8, y + 20), s["file"][:50], fill="black")
        x = label
        for p in s["palette"]:
            wpx = max(6, round(p["share"] * 14 * 64))
            d.rectangle([x, y, x + wpx, y + row], fill=p["hex"])
            x += wpx
    img.save(OUT / "palettes.png")


def main() -> int:
    OUT.mkdir(exist_ok=True)
    files = sorted(GALLERY.glob("*.tif"))
    if not files:
        print("no images in research/gallery; run research/fetch_gallery.sh", file=sys.stderr)
        return 1
    stats = []
    for f in files:
        s = analyse(f)
        stats.append(s)
        print(f"{s['file']}: bg {s['background']['hex']} ink {s['ink_coverage']:.3f} line {s['line_width_px']}px", flush=True)
    (OUT / "stats.json").write_text(json.dumps(stats, indent=1))
    swatches(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
