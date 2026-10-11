"""皮肤与内部结构（骨、肌肉）是否相容：逐区域统计内部结构到皮肤表面的有符号距离。
Does a skin surface contain the internal model? Signed distance from bone and muscle vertices to
a closed skin surface, summarised per body region.

    正值 = 在皮肤之外（穿出）；负值 = 在皮肤之内（其绝对值即该点上方的软组织厚度）
    positive = outside the skin (pokes out); negative = inside (|d| = soft tissue above the point)

供 reference_female.py 调用；也可单独运行查看我们自己的皮肤（无符号距离，因为我们的皮肤是双层薄壳）：
Used by reference_female.py; standalone it reports our own skins (unsigned distance, because our
skin mesh is a thin double-walled shell):
    python -I tools/bodyshape/fit_check.py male female
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bodylib import RAW, Body  # noqa: E402
from measure import bone_landmarks  # noqa: E402

REGIONS = [
    ('head', '头部', 'Head'), ('neck', '颈部', 'Neck'), ('shoulder', '肩部', 'Shoulder girdle'), ('chest', '胸部', 'Chest'),
    ('abdomen', '腹部', 'Abdomen'), ('pelvis', '骨盆/臀部', 'Pelvis and buttock'), ('thigh', '大腿', 'Thigh'), ('knee', '膝部', 'Knee'),
    ('calf', '小腿', 'Lower leg'), ('foot', '足', 'Foot'), ('upperArm', '上臂', 'Upper arm'), ('forearm', '前臂', 'Forearm'), ('hand', '手', 'Hand'),
]


def _seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1), t


def classify(P, L):
    """按骨性标志把点分到身体区域。P (n,3)；L: bone_landmarks 的结果。
    Assign points to body regions from bony landmarks. Returns an array of region ids."""
    n = len(P)
    reg = np.full(n, 'chest', dtype=object)
    y = P[:, 1]
    c7 = L['cervicale'][1]
    ss = L['suprasternale'][1]
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1])
    hipy = 0.5 * (L['hip_L'][1] + L['hip_R'][1])
    isch = 0.5 * (L['ischialTuberosity_L'][1] + L['ischialTuberosity_R'][1])
    xi = ss - 0.62 * (ss - ilio) * 0.55  # 约剑突/肋弓水平 / about xiphoid-costal margin level
    reg[y > c7 + 0.035] = 'head'
    reg[(y <= c7 + 0.035) & (y > ss + 0.01)] = 'neck'
    reg[(y <= ss + 0.01) & (y > xi)] = 'chest'
    reg[(y <= xi) & (y > ilio)] = 'abdomen'
    reg[(y <= ilio) & (y > isch - 0.03)] = 'pelvis'
    # 肢体：到肢段轴线的距离最近者 / limbs: nearest limb segment axis
    best = np.full(n, np.inf)
    lab = np.full(n, '', dtype=object)
    for s in 'LR':
        segs = [('upperArm', L['shoulder_' + s], L['elbow_' + s], 0.075), ('forearm', L['elbow_' + s], L['wrist_' + s], 0.065),
                ('hand', L['wrist_' + s], L['wrist_' + s] + 1.0 * (L['wrist_' + s] - L['elbow_' + s]), 0.07),
                ('thigh', L['hip_' + s], L['knee_' + s], 0.13), ('calf', L['knee_' + s], L['ankle_' + s], 0.10)]
        for name, a, b, rad in segs:
            d, t = _seg_dist(P, a, b)
            m = (d < best) & (d < rad)
            if name == 'thigh':
                m &= y < isch - 0.03
            if name == 'upperArm':
                # 上臂只取肩关节以下、且在肩关节外侧或其下 / below the shoulder joint only
                m &= (t > 0.12)
            best[m] = d[m]
            lab[m] = name
        knee = L['knee_' + s]
        m = (np.abs(y - knee[1]) < 0.05) & (np.linalg.norm(P[:, [0, 2]] - knee[[0, 2]], axis=1) < 0.11)
        lab[m] = 'knee'
        ank = L['ankle_' + s]
        m = (y < ank[1] + 0.02) & (np.abs(P[:, 0] - ank[0]) < 0.09)
        lab[m] = 'foot'
    reg[lab != ''] = lab[lab != '']
    # 肩带：胸部高度、位于肩关节内外 6 cm 以外侧 / shoulder girdle: lateral part at chest height
    shx = min(abs(L['shoulder_L'][0]), abs(L['shoulder_R'][0]))
    m = (reg == 'chest') & (np.abs(P[:, 0]) > shx - 0.045) & (y > L['shoulder_L'][1] - 0.09)
    reg[m] = 'shoulder'
    m = (reg == 'neck') & (np.abs(P[:, 0]) > 0.075)
    reg[m] = 'shoulder'
    return reg


def summarise(d, reg):
    """d: 有符号距离（米）/ signed distance (m). Returns per-region stats in mm."""
    out = {}
    for rid, zh, en in REGIONS:
        m = reg == rid
        if m.sum() < 20:
            continue
        x = d[m] * 1000
        out[rid] = {'name': {'zh': zh, 'en': en}, 'n': int(m.sum()),
                    'outsideFraction': round(float((x > 0).mean()), 3), 'outsideOver5mmFraction': round(float((x > 5).mean()), 3),
                    'p50': round(float(np.percentile(x, 50)), 1), 'p90': round(float(np.percentile(x, 90)), 1),
                    'p99': round(float(np.percentile(x, 99)), 1), 'max': round(float(x.max()), 1),
                    'depthP10': round(float(np.percentile(-x, 10)), 1)}
    return out


def signed_distance(P, V, F):
    """到闭合曲面的有符号距离（外正内负）。用伪法线判号：在手臂与躯干、两腿之间的窄缝旁，
    快速环绕数的近似会判错内外。
    Signed distance to a closed surface (+ outside). The sign comes from pseudonormals: next to narrow
    gaps (arm against trunk, thigh against thigh) the fast winding number approximation gets inside
    and outside wrong."""
    import igl
    s = igl.signed_distance(np.ascontiguousarray(P, dtype=np.float64), np.ascontiguousarray(V, dtype=np.float64),
                            np.ascontiguousarray(F, dtype=np.int64), igl.SIGNED_DISTANCE_TYPE_PSEUDONORMAL)
    return s[0]


def internal_points(b, kind):
    if kind == 'muscle':
        return b.merged(lambda p: p['system'] == 'muscular' and p['tissue'] == 'muscle')[0]
    return b.merged(lambda p: p['system'] == 'skeletal' and p['tissue'] == 'bone')[0]


def fmt(stats):
    lines = [f'{"region":10s} {"n":>7s} {"out%":>6s} {">5mm%":>6s} {"p50":>7s} {"p90":>7s} {"p99":>7s} {"max":>7s}']
    for k, s in stats.items():
        lines.append(f'{k:10s} {s["n"]:7d} {100 * s["outsideFraction"]:6.1f} {100 * s["outsideOver5mmFraction"]:6.1f} {s["p50"]:7.1f} {s["p90"]:7.1f} {s["p99"]:7.1f} {s["max"]:7.1f}')
    return '\n'.join(lines)


if __name__ == '__main__':
    import igl
    res = {}
    for name in sys.argv[1:]:
        b = Body(name)
        L = bone_landmarks(b)
        V, F = b.skin()
        for kind in ('muscle', 'bone'):
            P = internal_points(b, kind)
            d = igl.signed_distance(P, V, F, igl.SIGNED_DISTANCE_TYPE_UNSIGNED)[0]
            st = summarise(-np.abs(d), classify(P, L))
            res[f'{name}:{kind}'] = st
            print(f'== {name} {kind}: depth below own skin (shown negative), mm\n{fmt(st)}')
    json.dump(res, open(os.path.join(RAW, 'out', 'fit-own-skin.json'), 'w'), ensure_ascii=False, indent=1)
