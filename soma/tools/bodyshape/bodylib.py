"""tools/bodyshape 的公用函数：读取导出的人体、切片、渲染。
Shared helpers for tools/bodyshape: loading exported bodies, slicing, rendering.

坐标系统一为：米，Y 向上，前 +Z，受试者左侧 +X。各工具都在 soma 项目根目录下运行。
Frame everywhere: metres, Y up, anterior +Z, subject's left +X.
Run the tools from the soma project root.
"""
import json
import os
import numpy as np

RAW = 'data/raw/bodyshape'
CUR = 'data/curated/bodyshape'


class Body:
    """我们某一个人体的皮肤、骨、肌肉网格（由 export-parts.ts 导出）。
    Skin / bone / muscle meshes of one of our bodies (written by export-parts.ts)."""

    def __init__(self, name, root=None):
        # 环境变量 SOMA_BODIES=<目录>：改读另一处的导出（例如一次试建的导出，见 export-parts.ts）；不设时与原来相同
        # the environment variable SOMA_BODIES=<directory> reads the exports from elsewhere (e.g. those of a scratch build, see export-parts.ts); unset, nothing changes
        d = os.path.join(root or os.environ.get('SOMA_BODIES') or os.path.join(RAW, 'bodies'), name)
        self.name = name
        idx = json.load(open(os.path.join(d, 'index.json')))
        self.parts = idx['parts']
        self._v = {}
        self._i = {}
        for s in idx.get('systems', ('integumentary', 'skeletal', 'muscular')):
            self._v[s] = np.fromfile(os.path.join(d, s + '.f32'), dtype=np.float32).reshape(-1, 3).astype(np.float64)
            self._i[s] = np.fromfile(os.path.join(d, s + '.u32'), dtype=np.uint32).reshape(-1, 3).astype(np.int64)
        self.by_name = {}
        for p in self.parts:
            self.by_name.setdefault(p['name'].lower(), []).append(p)

    def mesh(self, part):
        v = self._v[part['system']][part['v0']:part['v0'] + part['nv']]
        f = self._i[part['system']][part['i0'] // 3:(part['i0'] + part['ni']) // 3]
        return v, f

    def find(self, name):
        """名称等于 `name` 的部件（不分大小写）。
        Parts whose name equals `name` (case-insensitive)."""
        return self.by_name.get(name.lower(), [])

    def verts(self, name):
        ps = self.find(name)
        if not ps:
            raise KeyError(name)
        return np.vstack([self.mesh(p)[0] for p in ps])

    def merged(self, pred):
        """把 pred(part) 为真的部件合并成一个 (V, F)。
        One (V, F) soup of every part for which pred(part) is true."""
        vs, fs, n = [], [], 0
        for p in self.parts:
            if pred(p):
                v, f = self.mesh(p)
                vs.append(v)
                fs.append(f + n)
                n += len(v)
        return np.vstack(vs), np.vstack(fs)

    def skin(self):
        return self.merged(lambda p: p['name'] == 'Skin')

    # 管线判定“深部结构”的组织类型（tools/pipeline/fat.ts 的 FAT_DEEP_TISSUES），不含皮肤系统
    # tissues the pipeline counts as deep parts (FAT_DEEP_TISSUES in tools/pipeline/fat.ts), integumentary system excluded
    DEEP = ('muscle', 'bone', 'cartilage', 'organ', 'brain', 'heart', 'gland', 'tendon', 'tooth')

    def deep_parts(self):
        return [p for p in self.parts if p['tissue'] in self.DEEP and p['system'] != 'integumentary']


# ---------------------------------------------------------------- 切片
# ---------------------------------------------------------------- slicing

def slice_segments(V, F, origin, normal):
    """三角网格与平面求交，返回 (n, 2, 3) 线段。
    Intersect a triangle soup with a plane; returns (n, 2, 3) segments."""
    d = (V - origin) @ normal
    df = d[F]
    s = df > 0
    cut = (s.any(1)) & (~s.all(1))
    Fc, dc = F[cut], df[cut]
    segs = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        da, db = dc[:, a], dc[:, b]
        cross = (da > 0) != (db > 0)
        t = np.where(cross, da / np.where(cross, da - db, 1), 0)
        p = V[Fc[:, a]] + t[:, None] * (V[Fc[:, b]] - V[Fc[:, a]])
        segs.append((cross, p))
    out = np.zeros((len(Fc), 2, 3))
    k = np.zeros(len(Fc), dtype=int)
    for cross, p in segs:
        idx = np.where(cross)[0]
        out[idx, k[idx]] = p[idx]
        k[idx] += 1
    return out[k == 2]


def plane_basis(normal):
    n = normal / np.linalg.norm(normal)
    a = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 0, 1.0])
    u = np.cross(n, a)
    u /= np.linalg.norm(u)
    w = np.cross(n, u)
    return u, w


def hull_perimeter(pts2):
    from scipy.spatial import ConvexHull
    if len(pts2) < 3:
        return 0.0, pts2
    try:
        h = ConvexHull(pts2)
    except Exception:
        return 0.0, pts2
    hp = pts2[h.vertices]
    return float(np.linalg.norm(hp - np.roll(hp, -1, axis=0), axis=1).sum()), hp


# ---------------------------------------------------------------- 渲染
# ---------------------------------------------------------------- rendering

def sample_surface(V, F, n, rng):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    nrm = np.cross(b - a, c - a)
    area = np.linalg.norm(nrm, axis=1)
    nrm = nrm / np.maximum(area, 1e-20)[:, None]
    idx = rng.choice(len(F), size=n, p=area / area.sum())
    r1 = np.sqrt(rng.random(n))
    r2 = rng.random(n)
    p = (1 - r1)[:, None] * a[idx] + (r1 * (1 - r2))[:, None] * b[idx] + (r1 * r2)[:, None] * c[idx]
    return p, nrm[idx]


def render_views(layers, path, views=('front', 'side', 'back'), height=1100, ylim=None, pad=0.03,
                 title=None, n_per_m2=2.5e6, annotations=None, bounds=None):
    """正交投影的点溅渲染。layers: (V, F, rgb) 列表；输出 PNG。
    Orthographic splat render. layers: list of (V, F, rgb[, alpha]). Writes a PNG."""
    from PIL import Image, ImageDraw
    rng = np.random.default_rng(1)
    allv = np.vstack([l[0] for l in layers])
    lo, hi = (allv.min(0), allv.max(0)) if bounds is None else (np.array(bounds[0], float), np.array(bounds[1], float))
    if ylim:
        lo[1], hi[1] = ylim
    scale = (height - 40) / (hi[1] - lo[1] + 2 * pad)
    imgs = []
    for view in views:
        # 屏幕横轴与深度轴（深度越大越靠近相机）
        # screen x axis and depth axis (larger depth = nearer the camera)
        if view == 'front':
            sx, dz, flip = 0, 2, -1  # viewer sees subject's left on the right? no: mirror like facing them
        elif view == 'back':
            sx, dz, flip = 0, 2, 1
        elif view == 'side':  # from subject's left
            sx, dz, flip = 2, 0, -1
        else:  # 'right'
            sx, dz, flip = 2, 0, 1
        wlo, whi = lo[sx], hi[sx]
        W = int((whi - wlo + 2 * pad) * scale)
        H = height
        zbuf = np.full((H, W), -1e9)
        img = np.ones((H, W, 3))
        for layer in layers:
            V, F, rgb = layer[0], layer[1], np.asarray(layer[2], float)
            if ylim:
                m = (V[F][:, :, 1].max(1) > lo[1] - 0.05) & (V[F][:, :, 1].min(1) < hi[1] + 0.05)
                F = F[m]
            if len(F) == 0:
                continue
            a = np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1).sum() / 2
            n = int(min(max(a * n_per_m2, 2e5), 8e6))
            p, nr = sample_surface(V, F, n, rng)
            depth = p[:, dz] * (1 if (view in ('front', 'side')) else -1)
            if view == 'front':
                x = (hi[sx] - p[:, sx] + pad) * scale  # subject's left on viewer's right
                x = W - 1 - x
                x = (p[:, sx] - wlo + pad) * scale
            elif view == 'back':
                x = (whi - p[:, sx] + pad) * scale
            elif view == 'side':
                x = (whi - p[:, sx] + pad) * scale
            else:
                x = (p[:, sx] - wlo + pad) * scale
            y = (hi[1] - p[:, 1] + pad) * scale
            xi, yi = x.astype(int), y.astype(int)
            ok = (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
            xi, yi, depth, nr = xi[ok], yi[ok], depth[ok], nr[ok]
            vdir = np.zeros(3)
            vdir[dz] = 1 if view in ('front', 'side') else -1
            light = vdir + np.array([0.3, 0.5, 0.0])
            light /= np.linalg.norm(light)
            sh = 0.35 + 0.65 * np.abs(nr @ light)
            flat = yi * W + xi
            order = np.argsort(depth)
            flat, depth, sh = flat[order], depth[order], sh[order]
            # 每个像素保留最近的采样点：按深度排序后取最后一个
            # keep the nearest sample per pixel: last occurrence after sorting by depth
            uniq, last = np.unique(flat[::-1], return_index=True)
            last = len(flat) - 1 - last
            zb = zbuf.reshape(-1)
            win = depth[last] > zb[uniq]
            u2, l2 = uniq[win], last[win]
            zb[u2] = depth[l2]
            img.reshape(-1, 3)[u2] = sh[l2][:, None] * rgb[None, :]
        im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
        if annotations:
            dr = ImageDraw.Draw(im)
            for (yy, label, col) in annotations:
                ypix = (hi[1] - yy + pad) * scale
                dr.line([(0, ypix), (W, ypix)], fill=col, width=1)
                if view == views[0]:
                    dr.text((2, ypix - 11), label, fill=col)
        imgs.append(im)
    Wt = sum(i.width for i in imgs)
    out = Image.new('RGB', (Wt, height + (24 if title else 0)), 'white')
    x = 0
    for i in imgs:
        out.paste(i, (x, 24 if title else 0))
        x += i.width
    if title:
        ImageDraw.Draw(out).text((6, 5), title, fill=(0, 0, 0))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out.save(path)
    return path


def render_overlay(skin, inner, path, alpha=0.45, **kw):
    """半透明皮肤叠在内部结构上：分别渲染后按 alpha 混合。skin: (V, F, rgb)；inner: 图层列表。
    Semi-transparent skin over the internal layers: both are rendered with the same framing and
    blended. skin: (V, F, rgb); inner: list of layers."""
    from PIL import Image
    allv = np.vstack([skin[0]] + [l[0] for l in inner])
    b = (allv.min(0), allv.max(0))
    a = Image.open(render_views(inner, path + '.inner.png', bounds=b, **kw)).convert('RGB')
    c = Image.open(render_views([skin], path + '.skin.png', bounds=b, **kw)).convert('RGB')
    Image.blend(a, c, alpha).save(path)
    os.remove(path + '.inner.png')
    os.remove(path + '.skin.png')
    return path


def crop(V, F, lo, hi):
    """只留重心落在盒子 [lo, hi] 内的三角形。Keep the triangles whose centroid lies in the box [lo, hi]."""
    c = V[F].mean(1)
    return V, F[((c >= np.asarray(lo)) & (c <= np.asarray(hi))).all(1)]


def render_closeup(layers, path, lo, hi, views=('front', 'side'), height=800, alpha=None, title=None):
    """局部特写：把各图层裁到盒子内再渲染。alpha 给定时，第一个图层（皮肤）半透明叠在其余图层上。
    Close-up: every layer is cropped to the box, then rendered. With alpha, the first layer (the skin)
    is blended over the others."""
    cl = [(*crop(l[0], l[1], lo, hi), l[2]) for l in layers]
    cl = [l for l in cl if len(l[1])]
    kw = dict(views=views, height=height, bounds=(lo, hi), n_per_m2=4e7, title=title)
    if alpha is None or len(cl) < 2:
        return render_views(cl, path, **kw)
    from PIL import Image
    a = Image.open(render_views(cl[1:], path + '.inner.png', **kw)).convert('RGB')
    c = Image.open(render_views(cl[:1], path + '.skin.png', **kw)).convert('RGB')
    Image.blend(a, c, alpha).save(path)
    os.remove(path + '.inner.png')
    os.remove(path + '.skin.png')
    return path


def render_bottom(layers, path, lo, hi, width=900, n=3000000):
    """自下向上看（会阴）：横轴为 x（受试者左侧在图右），纵轴为 z（前方在上）。
    View from below (perineum): x across (subject's left on the right of the picture), z up the picture (anterior at the top)."""
    from PIL import Image
    rng = np.random.default_rng(2)
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    sc = width / (hi[0] - lo[0])
    H = int((hi[2] - lo[2]) * sc)
    img = np.ones((H, width, 3))
    zb = np.full(H * width, 1e9)
    for l in layers:
        V, F = crop(l[0], l[1], lo, hi)
        if not len(F):
            continue
        p, nr = sample_surface(V, F, n, rng)
        xi = ((p[:, 0] - lo[0]) * sc).astype(int)
        yi = ((hi[2] - p[:, 2]) * sc).astype(int)
        ok = (xi >= 0) & (xi < width) & (yi >= 0) & (yi < H)
        xi, yi, y, nr = xi[ok], yi[ok], p[ok, 1], nr[ok]
        light = np.array([0.2, -1.0, 0.3])
        light /= np.linalg.norm(light)
        sh = 0.35 + 0.65 * np.abs(nr @ light)
        flat = yi * width + xi
        o = np.argsort(-y)  # 最低的最后写入 / the lowest sample is written last
        flat, y, sh = flat[o], y[o], sh[o]
        u, last = np.unique(flat[::-1], return_index=True)
        last = len(flat) - 1 - last
        win = y[last] < zb[u]
        zb[u[win]] = y[last][win]
        img.reshape(-1, 3)[u[win]] = sh[last][win][:, None] * np.asarray(l[2], float)[None, :]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(path)
    return path
