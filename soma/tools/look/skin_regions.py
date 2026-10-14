"""把各部位的黑色素、血量倍数烘焙成 MHR UV 图集上的一张贴图（写实皮肤用）。
Bake the per-region melanin and blood multipliers into one texture on the MHR UV atlas (for the lifelike skin).

    data/raw/bodyshape/.venv/bin/python -I tools/look/skin_regions.py [male|female ...]
    -> public/anatomy/<body>/look/skin-regions.png   1024² RGBA；第 0 行是 v = 0（与 DataTexture 的次序相同，人看是上下颠倒的）
                                                      1024² RGBA; row 0 is v = 0 (the order of a DataTexture; upside down to the eye)
    -> public/anatomy/<body>/look/skin-colour.json   运行时的说明（查找表、色调、贴图编码）/ runtime description (table, tone, map encoding)
    -> data/raw/skin/maps/<body>-*.png               检查用的预览（不入库）/ previews for checking (not in git)

通道 / channels
    R  黑色素倍数 m：m = 2^((R − 128) / 32) / melanin multiplier
    G  血量倍数 b：b = 2^((G − 128) / 32) / blood multiplier
    B  手足掌权重 p：黑色素在对数空间里拉向一个与肤色无关的固定值，Cm = Cm^(1−p) · Cmpalm^p
       palmoplantar weight p: melanin is pulled in log space to a fixed value independent of skin tone
    A  粗糙度 × 255 / roughness × 255

做法 / How
    · 在 UV 图集上逐个 MHR LOD0 三角形光栅化，每个纹素得到它在静止姿势下的三维位置和法线；部位都是这个位置的函数
      （到唇、睑、乳头、关节、移植片的距离，法线朝向），所以接缝两边的值天然一致。
      Every MHR LOD0 triangle is rasterised into the atlas, giving each texel its rest-pose position and normal;
      every region is a function of that position (distance to lips, lids, nipples, joints, grafts; normal
      direction), so both sides of a seam agree by construction.
    · 移植片（足趾、外生殖器）的 UV 是投影到最近 MHR 面上的，所以它们取的就是最近 MHR 表面的值。
      The grafts (toes, external genitalia) have UVs projected onto the nearest MHR face, so they take the value of
      the nearest MHR surface.
    · 岛外的纹素用推拉（push-pull）平滑填满，避免 mipmap 和双线性在岛边混进默认值，接缝处看不出线。
      Texels outside the islands are filled smoothly by push-pull, so mipmaps and bilinear filtering never mix
      in a default at island borders and seams show no line.
    · 部位按从大到小的次序叠上去：v = v·(1 − w) + v_r·w。
      Regions are layered from broad to specific: v = v·(1 − w) + v_r·w.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

SIZE = 1024
COLOUR = 'data/curated/look/skin-colour.json'
MHR_UV = 'data/raw/look/mhr-lod0-uv.bin'
PREVIEW = 'data/raw/skin/maps'
LOG_SCALE = 32.0  # 每个倍频程 32 级 / 32 steps per octave


def read_mhr_uv(path):
    b = open(path, 'rb').read()
    nv, nf, nt = np.frombuffer(b[:12], '<u4')
    o = 12
    faces = np.frombuffer(b[o:o + nf * 12], '<u4').reshape(-1, 3).astype(np.int64)
    o += nf * 12
    uvf = np.frombuffer(b[o:o + nf * 12], '<u4').reshape(-1, 3).astype(np.int64)
    o += nf * 12
    uv = np.frombuffer(b[o:o + nt * 8], '<f4').reshape(-1, 2).astype(np.float64)
    return int(nv), faces, uvf, uv


def read_obj_positions(path):
    out = []
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                p = line.split()
                out.append((float(p[1]), float(p[2]), float(p[3])))
    return np.array(out)


def vertex_normals(P, F):
    n = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
    vn = np.zeros_like(P)
    for k in range(3):
        np.add.at(vn, F[:, k], n)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def rasterise(F, UVF, UV, size):
    """每个被覆盖的纹素：所在三角形和重心坐标 / For each covered texel: its triangle and barycentrics."""
    tri = UV[UVF] * size  # [f][3][2]，v 向上；行 = v·size / v up; row = v·size
    lo = np.floor(tri.min(axis=1) - 0.5).astype(int)
    hi = np.ceil(tri.max(axis=1) - 0.5).astype(int)
    lo = np.clip(lo, 0, size - 1)
    hi = np.clip(hi, 0, size - 1)
    w = hi[:, 0] - lo[:, 0] + 1
    h = hi[:, 1] - lo[:, 1] + 1
    cnt = w * h
    fid = np.repeat(np.arange(len(F)), cnt)
    start = np.repeat(np.cumsum(cnt) - cnt, cnt)
    k = np.arange(cnt.sum()) - start
    px = lo[fid, 0] + k % w[fid]
    py = lo[fid, 1] + k // w[fid]
    cx, cy = px + 0.5, py + 0.5
    a, b, c = tri[fid, 0], tri[fid, 1], tri[fid, 2]
    d = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    ok = np.abs(d) > 1e-12
    d = np.where(ok, d, 1)
    l0 = ((b[:, 1] - c[:, 1]) * (cx - c[:, 0]) + (c[:, 0] - b[:, 0]) * (cy - c[:, 1])) / d
    l1 = ((c[:, 1] - a[:, 1]) * (cx - c[:, 0]) + (a[:, 0] - c[:, 0]) * (cy - c[:, 1])) / d
    l2 = 1 - l0 - l1
    eps = -1e-6
    inside = ok & (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
    # 同一纹素落在几个三角形里（岛的边界）时取第一个 / a texel in several triangles (island borders) takes the first
    idx = py[inside] * size + px[inside]
    _, first = np.unique(idx, return_index=True)
    sel = np.flatnonzero(inside)[first]
    return py[sel] * size + px[sel], fid[sel], np.stack([l0[sel], l1[sel], l2[sel]], axis=1)


def push_pull(img, mask):
    """用推拉法把 mask 外的纹素平滑填满 / Fill the texels outside mask smoothly by push-pull."""
    if mask.all() or img.shape[0] <= 1:
        return img
    h, w = mask.shape
    m = mask.astype(np.float64)
    wimg = img * m[..., None]
    # 下采样：带权平均 / down: weighted mean
    m2 = m.reshape(h // 2, 2, w // 2, 2).sum(axis=(1, 3))
    s2 = wimg.reshape(h // 2, 2, w // 2, 2, -1).sum(axis=(1, 3))
    low = np.where(m2[..., None] > 0, s2 / np.maximum(m2[..., None], 1e-12), 0)
    low = push_pull(low, m2 > 0)
    up = np.repeat(np.repeat(low, 2, axis=0), 2, axis=1)
    return np.where(mask[..., None], img, up)


def soft(d, r0, r1):
    """d ≤ r0 → 1，d ≥ r1 → 0，中间平滑 / 1 for d ≤ r0, 0 for d ≥ r1, smooth between."""
    t = np.clip((r1 - d) / (r1 - r0), 0, 1)
    return t * t * (3 - 2 * t)


def ramp(x, a, b):
    """x ≤ a → 0，x ≥ b → 1，中间平滑 / 0 for x ≤ a, 1 for x ≥ b, smooth between."""
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def seg_dist(P, a, b):
    """点到线段的距离和参数 t / distance from points to a segment and the parameter t."""
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1), ((P - a) @ ab) / max(ab @ ab, 1e-12)


def unit(v):
    return v / max(np.linalg.norm(v), 1e-12)


def perp(v, d):
    return v - (v @ d) * d


def value_noise(P, scale, seed):
    """三维值噪声（周期 64 格，平滑三线性插值），约在 [−1, 1] / 3-D value noise (period 64 cells, smooth trilinear), roughly in [−1, 1]."""
    rng = np.random.default_rng(seed)
    lat = rng.uniform(-1, 1, (64, 64, 64))
    q = P / scale + 17.0
    i = np.floor(q).astype(int)
    f = q - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * lat[(i[:, 0] + dx) % 64, (i[:, 1] + dy) % 64, (i[:, 2] + dz) % 64]
    return out * 1.6


def hand_frame(J, s):
    """手掌的掌心方向（由手指屈曲的方向定号）/ The palm normal of one hand (its sign set by the direction the fingers flex)."""
    a = J[f'mcp5_{s}'] - J[f'mcp2_{s}']
    b = J[f'mcp3_{s}'] - J[f'wrist_{s}']
    n = unit(np.cross(a, b))
    flex = (J[f'dip3_{s}'] - J[f'pip3_{s}']) - (J[f'pip3_{s}'] - J[f'mcp3_{s}'])
    if n @ flex < 0:
        n = -n
    return n


def digits(J, s):
    """每个指（趾）的关节链和指尖（远节按中节长度外推）/ The joint chain and tip of each digit (the distal phalanx extrapolated from the middle one)."""
    out = []
    out.append(('thumb', [J[f'cmc1_{s}'], J[f'mcp1_{s}'], J[f'ip1_{s}']], 0.75))
    for k in (2, 3, 4, 5):
        out.append(('finger', [J[f'mcp{k}_{s}'], J[f'pip{k}_{s}'], J[f'dip{k}_{s}']], 0.8))
    toes = [('toe', [J[f'mtp1_{s}'], J[f'tip1_{s}']], 0.7)]
    for k in (2, 3, 4, 5):
        toes.append(('toe', [J[f'mtp{k}_{s}'], J[f'tpip{k}_{s}'], J[f'tdip{k}_{s}']], 0.8))
    res = []
    for kind, chain, f in out + toes:
        tip = chain[-1] + (chain[-1] - chain[-2]) * f
        res.append((kind, chain + [tip]))
    return res


class Layers:
    """按次序叠加的部位层 / Regions layered in order."""

    def __init__(self, n):
        self.mel = np.zeros(n)     # log2 黑色素倍数 / log2 melanin multiplier
        self.blood = np.zeros(n)   # log2 血量倍数 / log2 blood multiplier
        self.palm = np.zeros(n)
        self.rough = np.full(n, 0.5)
        self.ids = np.zeros(n, dtype=np.int16)  # 预览用：最后盖上去的部位 / for the preview: the last region laid on
        self.names = ['skin']

    def add(self, name, w, r, palm=None):
        w = np.clip(w, 0, 1)
        self.mel = self.mel * (1 - w) + np.log2(r['melanin']) * w
        self.blood = self.blood * (1 - w) + np.log2(r['blood']) * w
        self.rough = self.rough * (1 - w) + r.get('roughness', 0.5) * w
        if palm is not None:
            self.palm = self.palm * (1 - w) + palm * w
        self.names.append(name)
        self.ids[w > 0.5] = len(self.names) - 1


def bake(body, colour):
    bdir = f'public/anatomy/{body}'
    report = json.load(open(f'{bdir}/pipeline-report.json'))['skinPackage']
    pkg = report['dir']
    nv, F, UVF, UV = read_mhr_uv(MHR_UV)
    Ppkg = read_obj_positions(f'{pkg}/skin.obj')
    P = Ppkg[:nv]
    VN = vertex_normals(P, F)
    src = np.fromfile(f'{bdir}/skin-source.u32', dtype='<u4').astype(np.int64)
    pieces = np.fromfile(f'{bdir}/skin-pieces.u8', dtype=np.uint8)
    anatomy = json.load(open(f'{bdir}/anatomy.json'))
    skin_id = json.load(open(f'{bdir}/display.json'))['skin']['part']
    skin_part = next(p for p in anatomy['parts'] if p['id'] == skin_id)
    comp = skin_part['composition']
    face = json.load(open(f'{bdir}/face.json'))
    openings = json.load(open(f'{bdir}/face/openings.json'))
    J = {j['id']: np.array(j['center']) for j in json.load(open(f'{bdir}/rig.json'))['joints']}
    shipped = Ppkg[src]
    R = colour['regions']

    texel, fid, bary = rasterise(F, UVF, UV, SIZE)
    corners = F[fid]
    X = np.einsum('nk,nkj->nj', bary, P[corners])
    N = np.einsum('nk,nkj->nj', bary, VN[corners])
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    L = Layers(len(texel))
    x, y, z = X[:, 0], X[:, 1], X[:, 2]

    # ── 面部 / face ──
    lm = face['landmarks']
    eyes = {e['side']: e for e in lm['eyes']}
    eye_y = (eyes['L']['globe'][1] + eyes['R']['globe'][1]) / 2
    globe_z = (eyes['L']['globe'][2] + eyes['R']['globe'][2]) / 2
    stom = lm['stomionY']['skin']
    mid_x = lm['midX']
    pts = openings['points']
    corner_l, corner_r = shipped[pts['mouthCornerL']], shipped[pts['mouthCornerR']]
    chin_y = stom - 0.055
    # 面部的红在颞部、发际和颌下逐渐淡出（宽的过渡，免得出现边界）/ facial redness fades out gradually towards the temples, hairline and under the jaw (wide transitions, so no edge shows)
    front = ramp(N[:, 2], -0.15, 0.5)
    on_head = ramp(y, chin_y - 0.035, chin_y + 0.01)
    face_w = front * on_head * soft(np.abs(x - mid_x), 0.045, 0.085) * soft(y, eye_y + 0.05, eye_y + 0.1) * ramp(z, globe_z - 0.08, globe_z - 0.03)
    L.add('cheek', face_w, R['cheek'])
    L.add('forehead', face_w * ramp(y, eye_y + 0.012, eye_y + 0.03), R['forehead'])
    # 鼻：鼻根到鼻尖的胶囊 / nose: a capsule from the root to the tip
    sel = (np.abs(P[:, 0] - mid_x) < 0.012) & (P[:, 1] > stom) & (P[:, 1] < eye_y)
    tip = P[sel][np.argmax(P[sel, 2])]
    root = np.array([mid_x, eye_y, tip[2] - 0.03])
    dn, _ = seg_dist(X, root, tip)
    nose_w = soft(dn, 0.012, 0.02) * (z > globe_z - 0.01)
    L.add('nose', nose_w, R['nose'])
    # 耳：头部在眼高附近最靠外的点向内 1 cm 处的椭球 / ears: an ellipsoid 1 cm inside the outermost head point near eye height
    for side in (1, -1):
        s = (np.abs(P[:, 1] - eye_y + 0.015) < 0.03) & (side * P[:, 0] > 0.05) & (P[:, 1] > stom)
        e = P[s][np.argmax(side * P[s, 0])]
        c = e - np.array([side * 0.012, 0.0, 0.0])
        d = np.sqrt(((X - c) / np.array([0.022, 0.036, 0.024])) ** 2 @ np.ones(3))
        L.add('ears', soft(d, 0.85, 1.15), R['ears'])
    # 眼睑：睑裂上 11 mm、下 6 mm，左右各外延 4 mm / eyelids: 11 mm above and 6 mm below the fissure, 4 mm beyond each end
    for side in ('L', 'R'):
        f = eyes[side]['skinFissure']
        g = np.array(eyes[side]['globe'])
        x0, x1 = min(f['x0'], f['x1']), max(f['x0'], f['x1'])
        cx, hw = (x0 + x1) / 2, (x1 - x0) / 2 + 0.004
        u = np.clip(np.abs(x - cx) / hw, 0, 1.5)
        top = f['upperY'] + 0.011 * np.sqrt(np.clip(1 - u ** 2, 0, 1))
        bot = f['lowerY'] - 0.006 * np.sqrt(np.clip(1 - u ** 2, 0, 1))
        w = ramp(-np.abs(x - cx), -hw - 0.002, -hw + 0.002) * ramp(top - y, -0.0015, 0.0015) * ramp(y - bot, -0.0015, 0.0015)
        w = w * (np.linalg.norm(X - g, axis=1) < eyes[side]['radius'] + 0.012)
        L.add('eyelids', w, R['eyelids'])
    # 唇红：口角之间，上唇中线高 8 mm、下唇 10 mm，向口角收成椭圆（Farkas 的成人量值附近；形状是假设）
    # vermilion: between the mouth corners, 8 mm high at the midline of the upper lip and 10 mm of the lower, closing to the corners as an ellipse (near Farkas's adult values; the shape is assumed)
    hw = abs(corner_l[0] - corner_r[0]) / 2
    cxm = (corner_l[0] + corner_r[0]) / 2
    u = np.clip(np.abs(x - cxm) / hw, 0, 1.5)
    shape = np.sqrt(np.clip(1 - u ** 2, 0, 1))
    up = stom + 0.008 * shape
    lo = stom - 0.010 * shape
    lip_w = ramp(up - y, -0.0012, 0.0012) * ramp(y - lo, -0.0012, 0.0012) * (u < 1.05) * ramp(z, min(corner_l[2], corner_r[2]) - 0.012, min(corner_l[2], corner_r[2]) - 0.006)
    L.add('lips', lip_w, R['lips'])

    # ── 四肢 / limbs ──
    regions_hand = {}
    for s in ('L', 'R'):
        palm_n = hand_frame(J, s)
        elbow, wrist = J[f'elbow_{s}'], J[f'wrist_{s}']
        fa = unit(wrist - elbow)
        ua = unit(elbow - J[f'gh_{s}'])
        ant = perp(fa - ua, ua)
        ant = unit(ant) if np.linalg.norm(ant) > 0.02 else np.array([0, 0, 1.0])
        # 前臂背侧（日晒）/ dorsal forearm (sun-exposed)
        d_fa, t_fa = seg_dist(X, elbow, wrist)
        dors = unit(perp(-palm_n, fa))
        w = soft(d_fa, 0.05, 0.07) * ramp(t_fa, 0.1, 0.35) * soft(t_fa, 1.0, 1.08) * ramp(N @ dors, 0.0, 0.5)
        L.add('dorsalForearm', w, R['dorsalForearm'])
        # 肘伸侧 / extensor elbow
        w = soft(np.linalg.norm(X - (elbow - 0.01 * ant), axis=1), 0.025, 0.05) * ramp(-(N @ ant), 0.1, 0.5)
        L.add('elbowsKnees', w, R['elbowsKnees'])
        # 手：腕以远、离手骨架近的点；掌侧/背侧按最近一段骨的掌侧方向分 / hand: beyond the wrist and near the hand skeleton; palmar or dorsal by the palmar direction of the nearest bone
        segs, vol = [], []
        hand_digits = [d for d in digits(J, s) if d[0] != 'toe']
        for k in (2, 3, 4, 5):
            segs.append((wrist, J[f'mcp{k}_{s}']))
            vol.append(palm_n)
        segs.append((J[f'wrist_{s}'], J[f'cmc1_{s}']))
        vol.append(palm_n)
        for kind, chain in hand_digits:
            for a, b in zip(chain[:-1], chain[1:]):
                segs.append((a, b))
                vol.append(unit(perp(palm_n, unit(b - a))))
        dist = np.stack([seg_dist(X, a, b)[0] for a, b in segs], axis=1)
        dmin = dist.min(axis=1)
        # 掌侧方向按到各段骨的距离做软加权（2.5 mm），段与段之间没有跳变 / the palmar direction is a soft weighting over the bones by distance (2.5 mm), so it never jumps between segments
        wseg = np.exp(-(dist - dmin[:, None]) / 0.0025)
        volar = wseg @ np.array(vol)
        volar /= np.maximum(np.linalg.norm(volar, axis=1, keepdims=True), 1e-9)
        beyond = ramp((X - wrist) @ fa, -0.015, 0.01)
        in_hand = beyond * soft(dmin, 0.025, 0.04)
        side_v = np.einsum('ij,ij->i', N, volar)
        L.add('backOfHand', in_hand * ramp(-side_v, -0.2, 0.2), R['backOfHand'])
        L.add('palmsSoles', in_hand * ramp(side_v, -0.2, 0.2), R['palmsSoles'], palm=1.0)
        regions_hand[s] = (palm_n, hand_digits)
        # 指腹：远节一圈血更多，指尖偏红（假设）/ fingertips: more blood all round the distal phalanx, so the tips look redder (assumed)
        for kind, chain in hand_digits:
            d, t = seg_dist(X, chain[-2], chain[-1])
            L.add('fingertips', soft(d, 0.012, 0.016) * ramp(t, 0.2, 0.6) * in_hand, R['fingertips'], palm=None)
        # 指甲：远节背侧 / nails: the dorsal side of the distal phalanx
        for kind, chain in hand_digits:
            a, b = chain[-2], chain[-1]
            d, t = seg_dist(X, a, b)
            dd = unit(b - a)
            v = unit(perp(palm_n, dd))
            w = soft(d, 0.011, 0.015) * ramp(t, 0.4, 0.55) * soft(t, 1.0, 1.15) * ramp(-(N @ v), 0.35, 0.65)
            L.add('nails', w, R['nails'])
        # 膝前 / anterior knee
        pat, knee = J[f'patella_{s}'], J[f'knee_{s}']
        kant = unit(pat - knee)
        w = soft(np.linalg.norm(X - pat, axis=1), 0.03, 0.06) * ramp(N @ kant, 0.2, 0.6)
        L.add('elbowsKnees', w, R['elbowsKnees'])
        # 足底：踝以下、法线朝下 / sole: below the ankle with the normal facing down
        ankle = J[f'ankle_{s}']
        foot_axis_end = J[f'mtp3_{s}']
        df, _ = seg_dist(X, ankle, foot_axis_end)
        w = soft(df, 0.07, 0.1) * soft(y, ankle[1] - 0.02, ankle[1] + 0.01) * ramp(-N[:, 1], 0.35, 0.7)
        L.add('palmsSoles', w, R['palmsSoles'], palm=1.0)
        # 趾甲：远节背侧（法线朝上）/ toenails: the dorsal side of the distal phalanx (normal up)
        for kind, chain in [d for d in digits(J, s) if d[0] == 'toe']:
            a, b = chain[-2], chain[-1]
            d, t = seg_dist(X, a, b)
            w = soft(d, 0.012, 0.017) * ramp(t, 0.35, 0.5) * soft(t, 1.1, 1.3) * ramp(N[:, 1], 0.45, 0.75)
            L.add('nails', w, R['nails'])

    # ── 躯干 / trunk ──
    if body == 'male':
        man = json.load(open(f'{pkg}/manifest.json'))
        nip = [np.array(man['scanDetails']['details'][k]['onFinalSkin']['centre']) for k in ('nippleL', 'nippleR')]
        areola_r = 0.0135  # 男性乳晕直径约 2.7 cm（假设）/ male areola about 2.7 cm across (assumed)
    else:
        parts = {p['id']: p for p in anatomy['parts']}
        nip = [np.array(parts[k]['centroid']) for k in ('HRA_nipple_L', 'HRA_nipple_R')]
        areola_r = 0.019  # 女性乳晕直径约 3.8 cm（假设）/ female areola about 3.8 cm across (assumed)
    for c in nip:
        c = P[np.argmin(np.linalg.norm(P - c, axis=1))]
        L.add('areola', soft(np.linalg.norm(X - c, axis=1), areola_r - 0.002, areola_r + 0.002), R['areola'])
    # 外生殖器 / external genitalia
    gen_piece = [i for i, c in enumerate(comp) if 'genital' in c['what']['en'].lower()]
    if gen_piece:
        gv = shipped[np.isin(pieces, gen_piece)]
        dg, _ = cKDTree(gv).query(X)
        L.add('genitalia', soft(dg, 0.004, 0.02), R['genitalia'])
    else:
        parts = {p['id']: p for p in anatomy['parts']}
        cl = np.array(parts['WU_cavernous_body_of_clitoris']['centroid'])
        pb = np.array(parts['WU_perineal_body']['centroid'])
        a = np.array([mid_x, cl[1] + 0.012, cl[2] + 0.03])
        b = np.array([mid_x, pb[1] - 0.005, pb[2] + 0.005])
        dg, _ = seg_dist(X, a, b)
        L.add('genitalia', soft(dg, 0.024, 0.036) * soft(np.abs(x - mid_x), 0.03, 0.045), R['genitalia'])

    # ── 低频斑驳 / low-frequency mottling ──
    mo = R['mottling']
    nm = 0.7 * value_noise(X, 0.035, 11) + 0.5 * value_noise(X, 0.11, 12)
    nb = 0.7 * value_noise(X, 0.03, 21) + 0.5 * value_noise(X, 0.09, 22)
    mel = L.mel + np.log2(1 + mo['melanin'] * np.clip(nm, -1.2, 1.2))
    blood = L.blood + np.log2(1 + mo['blood'] * np.clip(nb, -1.2, 1.2))

    vals = np.stack([128 + LOG_SCALE * mel, 128 + LOG_SCALE * blood, 255 * L.palm, 255 * L.rough], axis=1)
    img = np.zeros((SIZE * SIZE, 4))
    mask = np.zeros(SIZE * SIZE, bool)
    img[texel] = vals
    mask[texel] = True
    img = push_pull(img.reshape(SIZE, SIZE, 4), mask.reshape(SIZE, SIZE))
    out = np.clip(np.round(img), 0, 255).astype(np.uint8)
    os.makedirs(f'{bdir}/look', exist_ok=True)
    Image.fromarray(out, 'RGBA').save(f'{bdir}/look/skin-regions.png', optimize=True)

    # ── 运行时说明 / runtime description ──
    meta = {
        'schema': 1,
        'skin': skin_id,
        'lut': {'file': 'skin-lut.bin', **{k: colour['lut'][k] for k in ('size', 'cmMax', 'chdMax')}},
        'regions': {'file': 'skin-regions.png', 'size': SIZE, 'logScale': LOG_SCALE, 'rowOrder': 'row 0 is v = 0',
                    'palmMelanin': R['palmsSoles']['palmMelanin']},
        'tone': {k: colour['tone'][k] for k in ('cmMax', 'default', 'nistMax', 'bloodChd')},
        'surfaceReflection': colour['model']['fixed']['surfaceReflection']['value'],
        'source': {
            'zh': '底色由两层皮肤光谱模型算出，模型按 NIST 人体皮肤反射参考数据（Cooksey 等 2017）拟合；各部位的倍数部分由文献的色度数据反推、部分是假设，详见 data/curated/look/skin-colour.json。由 tools/look/skin_colour.py 和 skin_regions.py 生成。',
            'en': 'The albedo comes from a two-layer spectral skin model fitted to the NIST reference data set of human skin reflectance (Cooksey et al. 2017); the region multipliers are partly inverted from published colorimetry and partly assumed, see data/curated/look/skin-colour.json. Built by tools/look/skin_colour.py and skin_regions.py.',
        },
    }
    with open(f'{bdir}/look/skin-colour.json', 'w') as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
        f.write('\n')

    # ── 预览（不入库）/ previews (not in git) ──
    os.makedirs(PREVIEW, exist_ok=True)
    flip = lambda a: a[::-1]  # 人看的方向：v 向上 / for the eye: v up
    Image.fromarray(flip(out[..., 0])).save(f'{PREVIEW}/{body}-melanin.png')
    Image.fromarray(flip(out[..., 1])).save(f'{PREVIEW}/{body}-blood.png')
    ids = np.zeros(SIZE * SIZE, dtype=np.int16)
    ids[texel] = L.ids
    pal = np.array([[200, 200, 200]] + [list(np.random.default_rng(i).integers(40, 255, 3)) for i in range(1, len(L.names))], dtype=np.uint8)
    Image.fromarray(flip(pal[ids].reshape(SIZE, SIZE, 3))).save(f'{PREVIEW}/{body}-regions.png')
    counts = {n: int((L.ids == i).sum()) for i, n in enumerate(L.names)}
    size_kb = os.path.getsize(f'{bdir}/look/skin-regions.png') / 1024
    print(f'{body}: {len(texel)} texels covered ({100 * len(texel) / SIZE ** 2:.1f}%), png {size_kb:.0f} kB')
    print('  texels per region:', {k: v for k, v in counts.items() if v})


def main():
    bodies = sys.argv[1:] or ['male', 'female']
    if not os.path.exists(COLOUR):
        sys.exit(f'{COLOUR} is missing: run tools/look/skin_colour.py first')
    if not os.path.exists(MHR_UV):
        sys.exit(f'{MHR_UV} is missing: run tools/look/mhr_uv.py first')
    colour = json.load(open(COLOUR))
    for b in bodies:
        bake(b, colour)


if __name__ == '__main__':
    main()
