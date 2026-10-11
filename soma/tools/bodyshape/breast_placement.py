"""HRA 乳腺部件的摆放建议：每侧一个平移加一个等比缩放，使乳头尖落在皮肤的乳房最前点上、
其余部件在皮肤下至少 3 mm。只给数字，由管线去应用；本脚本不改任何部件。
Placement proposal for the HRA mammary parts: per side one translation plus one uniform scale that
puts the nipple tip on the most anterior point of the skin's breast and keeps everything else at
least 3 mm under the skin. Numbers only, for the pipeline to apply; this script changes no part.

    python tools/bodyshape/breast_placement.py   -> data/raw/bodyshape/out/female-skin/breast-placement.json / .txt

变换 / transform:  p' = A + T + s * (p - A)
  A  现在的胸壁附着点：该侧 HRA 脂肪体最靠后的 15 % 顶点的形心
     present chest-wall attachment: centroid of the most posterior 15 % of that side's HRA fat body
  T  把附着点移到皮肤乳房最前点正后方的胸壁（深部结构表面）上
     moves the attachment onto the chest wall (deep surface) straight behind the skin's breast apex
  s  使乳头尖到达皮肤最前点的缩放；若此时腺体覆盖不足 3 mm，则再缩小到够为止
     the scale that brings the nipple tip to the apex; reduced further if the gland then has less than 3 mm of cover
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import signed_distance  # noqa: E402


def main():
    d = os.path.join(RAW, 'out', 'female-skin')
    st = np.load(os.path.join(d, 'fit-state-final.npz'))
    lod = int(st['lod'])
    V = mhrlib.run(st['identity'], st['mp'], lod, True)[0] + st['offsets']
    F = mhrlib.faces(lod)
    fb = Body('female')
    DV, DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary')
    import igl
    out, lines = {}, []
    for S, sg in (('L', 1), ('R', -1)):
        parts = [p for p in fb.parts if p['id'].startswith('HRA_') and p['id'].endswith('_' + S)]
        inner = np.vstack([fb.mesh(p)[0] for p in parts if p['tissue'] != 'skin'])
        nip = np.vstack([fb.mesh(p)[0] for p in parts if 'nipple' in p['id']])
        fat = np.vstack([fb.mesh(p)[0] for p in parts if p['id'].startswith('HRA_fat')])
        A = fat[fat[:, 2] <= np.percentile(fat[:, 2], 15)].mean(0)
        tip = nip[np.argmax(nip[:, 2])]
        # 皮肤乳房最前点：该侧、附着点上下 9 cm、离正中 3–17 cm 范围内最靠前的皮肤顶点
        # apex of the skin breast: most anterior skin vertex on that side within 9 cm above/below the attachment and 3-17 cm from the midline
        m = (sg * V[:, 0] > 0.03) & (sg * V[:, 0] < 0.16) & (np.abs(V[:, 1] - A[1]) < 0.07) & (V[:, 2] > A[2] - 0.02)
        apex = V[m][np.argmax(V[m][:, 2])]
        # 最前点正后方的胸壁：沿 -z 找最近的深部结构表面 / chest wall straight behind the apex: first deep surface along -z
        zs = np.arange(apex[2] - 0.004, apex[2] - 0.12, -0.002)
        q = np.stack([np.full(len(zs), apex[0]), np.full(len(zs), apex[1]), zs], 1)
        dd = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(q), np.ascontiguousarray(DV), np.ascontiguousarray(DF))[0])
        wall = q[np.argmax(dd < 0.002)] if (dd < 0.002).any() else q[np.argmin(dd)]
        T = wall - A
        s_n = float((apex[2] - wall[2]) / (tip[2] - A[2]))
        best = None
        for sc in np.arange(s_n, 0.2, -0.01):
            dg = signed_distance(A + T + sc * (inner - A), V, F) * 1000
            if np.percentile(dg, 99) <= -3.0:
                best = (float(sc), float(np.percentile(dg, 99)), float(dg.max()))
                break
        dg0 = signed_distance(A + T + s_n * (inner - A), V, F) * 1000
        tip_new = A + T + (best[0] if best else s_n) * (tip - A)
        tip_sd = float(signed_distance(tip_new[None], V, F)[0] * 1000)
        out[S] = {'aboutPoint': [round(float(x), 4) for x in A], 'translationM': [round(float(x), 4) for x in T],
                  'scaleNippleOnApex': round(s_n, 3), 'glandAtThatScale': {'p99Mm': round(float(np.percentile(dg0, 99)), 1), 'maxMm': round(float(dg0.max()), 1)},
                  'scale': round(best[0], 3) if best else None, 'glandAtScale': {'p99Mm': round(best[1], 1), 'maxMm': round(best[2], 1)} if best else None,
                  'nippleTipAfterMm': {'position': [round(float(x), 4) for x in tip_new], 'signedDistanceToSkin': round(tip_sd, 1)},
                  'skinApex': [round(float(x), 4) for x in apex], 'chestWallBehindApex': [round(float(x), 4) for x in wall],
                  'skinBreastProjectionMm': round(float((apex[2] - wall[2]) * 1000), 1), 'hraProjectionMm': round(float((tip[2] - A[2]) * 1000), 1)}
        o = out[S]
        lines.append(f'breast {S}: about A = {o["aboutPoint"]} m; translation T = {o["translationM"]} m; skin breast projects {o["skinBreastProjectionMm"]} mm from the chest wall, '
                     f'the HRA breast {o["hraProjectionMm"]} mm; scale {o["scaleNippleOnApex"]} puts the nipple tip on the apex (gland p99 {o["glandAtThatScale"]["p99Mm"]:+.1f} mm, max {o["glandAtThatScale"]["maxMm"]:+.1f} mm); '
                     f'recommended scale {o["scale"]} gives gland p99 {o["glandAtScale"]["p99Mm"] if best else "n/a"} mm, nipple tip {tip_sd:+.1f} mm from the skin')
    json.dump({'transform': "p' = aboutPoint + translationM + scale * (p - aboutPoint), applied to every HRA part of that side",
               'note': {'zh': '有符号距离：正 = 在皮肤外。skin 为 female-skin/skin.obj。', 'en': 'signed distances: positive = outside the skin. The skin is female-skin/skin.obj.'},
               'sides': out}, open(os.path.join(d, 'breast-placement.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'breast-placement.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
