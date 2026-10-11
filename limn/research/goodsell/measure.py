"""把 limn 的出图和 Goodsell 的原画放在一起量。
Measure limn's pictures against Goodsell's paintings.

两张图不可能逐像素对齐（他画的分子位置是他安排的），所以量的是画法的统计量：
The two can never be aligned pixel by pixel (where his molecules sit is his own arrangement), so
what is measured are statistics of the way of drawing:

  paper     白纸占画面的比例 / share of the frame that is blank paper
  ink       线条像素占主体的比例 / share of the subject that is line
  ink_L     线条的明度（0 黑，1 白）/ lightness of the lines (0 black, 1 white)
  ink_C     线条的彩度：纯黑线是 0，同色深线明显大于 0 / chroma of the lines: 0 for pure black, clearly above 0 for dark lines of the fill's own hue
  bumps     细碎起伏：2 像素以下的明度变化相对于 2-6 像素的 / fine relief: lightness variation below 2 px relative to that at 2-6 px
  flat      平涂程度：主体里与周围 5×5 的中位色几乎相同的像素比例 / flatness: share of subject pixels almost equal to the median colour of their 5x5 surroundings
  L, C      主体的平均明度和彩度 / mean lightness and chroma of the subject
  palette   与参考图的主色距离（OKLab 里各聚 8 类，算搬运距离；只对 limn 的图有）/ distance between dominant colours and the reference's (8 clusters each in OKLab, earth mover's distance; for limn's pictures only)

用法 / usage:
  uv run --no-project --with numpy --with scipy --with pillow python -I research/goodsell/measure.py <轮次 / round>
它读 research/goodsell/pairs.json，从 .cache/snapshots/<round>-<name>.png 取 limn 的图，
把并排图写到 research/goodsell/out/，并打印一张表。
It reads research/goodsell/pairs.json, takes limn's pictures from .cache/snapshots/<round>-<name>.png,
writes side-by-side images to research/goodsell/out/, and prints a table.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.cluster.vq import kmeans2
from scipy.optimize import linprog

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def oklab(rgb):
    """sRGB (0-255) -> OKLab."""
    c = rgb.astype(np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    l = 0.4122214708 * c[..., 0] + 0.5363325363 * c[..., 1] + 0.0514459929 * c[..., 2]
    m = 0.2119034982 * c[..., 0] + 0.6806995451 * c[..., 1] + 0.1073969566 * c[..., 2]
    s = 0.0883024619 * c[..., 0] + 0.2817188376 * c[..., 1] + 0.6299787005 * c[..., 2]
    l, m, s = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    return np.stack([0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                     1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                     0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s], axis=-1)


def load(path, long_side=800):
    im = Image.open(path).convert('RGB')
    k = long_side / max(im.size)
    return np.asarray(im.resize((round(im.size[0] * k), round(im.size[1] * k)), Image.LANCZOS))


def palette(lab, subject, k=8, seed=1):
    pts = lab[subject]
    if len(pts) > 40000:
        pts = pts[np.random.default_rng(seed).choice(len(pts), 40000, replace=False)]
    centres, labels = kmeans2(pts, k, minit='++', seed=seed)
    w = np.bincount(labels, minlength=k) / len(labels)
    return centres, w


def emd(ca, wa, cb, wb):
    """两组带权重的颜色之间的搬运距离 / earth mover's distance between two weighted sets of colours"""
    n, m = len(wa), len(wb)
    cost = np.linalg.norm(ca[:, None, :] - cb[None, :, :], axis=2).ravel()
    a_eq = np.zeros((n + m, n * m))
    for i in range(n):
        a_eq[i, i * m:(i + 1) * m] = 1
    for j in range(m):
        a_eq[n + j, j::m] = 1
    res = linprog(cost, A_eq=a_eq, b_eq=np.concatenate([wa, wb]), bounds=(0, None), method='highs')
    return float(res.fun)


def measure(rgb):
    lab = oklab(rgb)
    L = lab[..., 0]
    C = np.hypot(lab[..., 1], lab[..., 2])
    paper = (L > 0.93) & (C < 0.03)
    subject = ~paper
    # 线：比周围 7×7 的中位明度暗得多的像素 / line: pixels much darker than the median lightness of their 7x7 surroundings
    med = ndimage.median_filter(L, size=7)
    ink = subject & (med - L > 0.12)
    fine = np.abs(L - ndimage.gaussian_filter(L, 2))
    coarse = np.abs(ndimage.gaussian_filter(L, 2) - ndimage.gaussian_filter(L, 6))
    body = subject & ~ndimage.binary_dilation(ink, iterations=1)
    med3 = np.stack([ndimage.median_filter(lab[..., i], size=5) for i in range(3)], axis=-1)
    flat = np.linalg.norm(lab - med3, axis=2) < 0.012
    n = max(1, subject.sum())
    return {
        'paper': float(paper.mean()),
        'ink': float(ink.sum() / n),
        'ink_L': float(L[ink].mean()) if ink.any() else float('nan'),
        'ink_C': float(C[ink].mean()) if ink.any() else float('nan'),
        'bumps': float(fine[body].mean() / max(1e-6, coarse[body].mean())) if body.any() else float('nan'),
        'flat': float(flat[body].mean()) if body.any() else float('nan'),
        'L': float(L[subject].mean()),
        'C': float(C[subject].mean()),
    }, lab, subject


def main():
    rnd = sys.argv[1] if len(sys.argv) > 1 else 'g0'
    pairs = json.load(open(os.path.join(HERE, 'pairs.json')))['pairs']
    # 第二个参数只量一种画法的对照：painted 或 illustrate / a second argument restricts to pairs of one drawing: painted or illustrate
    if len(sys.argv) > 2:
        pairs = [p for p in pairs if p.get('drawing', 'painted') == sys.argv[2]]
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    keys = ['paper', 'ink', 'ink_L', 'ink_C', 'bumps', 'flat', 'L', 'C']
    print('| ' + ' | '.join(['pair', 'which'] + keys + ['palette']) + ' |')
    print('|' + '---|' * (len(keys) + 3))
    rows = {}
    for p in pairs:
        ref = load(os.path.join(HERE, p['ref']))
        mine_path = os.path.join(ROOT, '.cache', 'snapshots', f"{rnd}-{p['name']}.png")
        if not os.path.exists(mine_path):
            continue
        mine = load(mine_path)
        (mr, labr, subr), (mm, labm, subm) = measure(ref), measure(mine)
        cr, wr = palette(labr, subr)
        cm, wm = palette(labm, subm)
        mm['palette'] = emd(cm, wm, cr, wr)
        rows[p['name']] = {'ref': mr, 'limn': mm}
        for which, m in (('Goodsell', mr), ('limn', mm)):
            print('| ' + ' | '.join([p['name'], which] + [f'{m[k]:.3f}' for k in keys] + [f"{m['palette']:.3f}" if 'palette' in m else '']) + ' |')
        # 并排图：左边参考，右边 limn / side by side: the reference on the left, limn on the right
        h = 800
        a = Image.fromarray(ref)
        b = Image.fromarray(mine)
        a = a.resize((round(a.width * h / a.height), h), Image.LANCZOS)
        b = b.resize((round(b.width * h / b.height), h), Image.LANCZOS)
        both = Image.new('RGB', (a.width + b.width + 16, h), 'white')
        both.paste(a, (0, 0))
        both.paste(b, (a.width + 16, 0))
        both.save(os.path.join(HERE, 'out', f"{rnd}-{p['name']}.jpg"), quality=88)
    json.dump(rows, open(os.path.join(HERE, 'out', f'{rnd}.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
