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
    # 胸壁 = 除 HRA 乳腺部件以外的深部结构 / chest wall = the deep parts other than the HRA mammary parts
    DV, DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary' and not p['id'].startswith('HRA_'))
    import igl
    out, lines, xf = {}, [], {}
    # 导出的 HRA 部件已经带着管线现在施加的那套摆放（breast-placement-installed.json）；先把它撤掉，这样给出的数字仍是针对原始部件的。
    # The exported HRA parts already carry the placement the pipeline applies now (breast-placement-installed.json); it is
    # undone first, so the numbers given here still refer to the original parts.
    inst = json.load(open(os.path.join(d, 'breast-placement-installed.json')))['sides'] if os.path.exists(os.path.join(d, 'breast-placement-installed.json')) else None

    def mesh0(p):
        v = fb.mesh(p)[0]
        if inst is None:
            return v
        o = inst[p['id'][-1]]
        A0, T0 = np.array(o['aboutPoint']), np.array(o['translationM'])
        if p['id'] in o['nippleAndAreola']['parts']:
            v = v - np.array(o['nippleAndAreola']['extraTranslationM'])
        return A0 + (v - A0 - T0) / o['scale']
    # --common-scale：第二遍，两侧用同一个缩放（上一遍两侧建议值中较小的那个）/ second pass with one scale for both sides (the smaller of the two recommended in the first pass)
    force = None
    if '--common-scale' in sys.argv:
        prev = json.load(open(os.path.join(d, 'breast-placement.json')))['sides']
        force = min(prev[S]['scale'] for S in 'LR' if prev[S]['scale'])
    for S, sg in (('L', 1), ('R', -1)):
        parts = [p for p in fb.parts if p['id'].startswith('HRA_') and p['id'].endswith('_' + S) and p['system'] == 'integumentary']   # 只取乳腺部件（HRA 还有卵巢韧带等）/ mammary parts only (HRA also has ovarian ligaments and the like)
        inner = np.vstack([mesh0(p) for p in parts if p['tissue'] != 'skin'])
        nip = np.vstack([mesh0(p) for p in parts if 'nipple' in p['id']])
        fat = np.vstack([mesh0(p) for p in parts if p['id'].startswith('HRA_fat')])
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
        if force is not None:
            dgf = signed_distance(A + T + force * (inner - A), V, F) * 1000
            best = (float(force), float(np.percentile(dgf, 99)), float(dgf.max()))
        dg0 = signed_distance(A + T + s_n * (inner - A), V, F) * 1000
        sc_use = best[0] if best else s_n
        tip_new = A + T + sc_use * (tip - A)
        tip_sd = float(signed_distance(tip_new[None], V, F)[0] * 1000)
        # 乳头、乳晕部件另给一个平移：缩小后它们落在皮肤下面；把乳晕移到皮肤面上（乳晕各点到皮肤的有符号距离中位数为 0），乳头随之露出。
        # A separate translation for the nipple and areola parts: after the reduced scale they lie under the skin; the
        # areola is moved onto the skin (median signed distance of its points 0) and the nipple then stands out of it.
        sk_parts = [p for p in parts if p['tissue'] == 'skin' or 'nipple' in p['id'] or 'areola' in p['id']]
        sv = A + T + sc_use * (np.vstack([mesh0(p) for p in sk_parts]) - A)
        ar = [p for p in parts if 'areola' in p['id']] or sk_parts
        av = A + T + sc_use * (np.vstack([mesh0(p) for p in ar]) - A)
        c2 = igl.point_mesh_squared_distance(np.ascontiguousarray(tip_new[None]), np.ascontiguousarray(V), np.ascontiguousarray(F))[2][0]
        dirn = (c2 - tip_new) / max(np.linalg.norm(c2 - tip_new), 1e-9) * (1.0 if tip_sd < 0 else -1.0)
        noff = -float(np.median(signed_distance(av, V, F))) * dirn
        for _ in range(3):
            noff = noff - float(np.median(signed_distance(av + noff, V, F))) * dirn
        sd_ar = signed_distance(av + noff, V, F) * 1000
        sd_tip = float(signed_distance((tip_new + noff)[None], V, F)[0] * 1000)
        xf[S] = (A, T, sc_use, noff, {p['id'] for p in sk_parts}, parts)
        nip_info = {'parts': [p['id'] for p in sk_parts], 'extraTranslationM': [round(float(x), 4) for x in noff],
                    'areolaToSkinMm': {'median': round(float(np.median(sd_ar)), 1), 'p5': round(float(np.percentile(sd_ar, 5)), 1), 'p95': round(float(np.percentile(sd_ar, 95)), 1)},
                    'nippleTipOutsideSkinMm': round(sd_tip, 1)}
        out[S] = {'aboutPoint': [round(float(x), 4) for x in A], 'translationM': [round(float(x), 4) for x in T],
                  'scaleNippleOnApex': round(s_n, 3), 'glandAtThatScale': {'p99Mm': round(float(np.percentile(dg0, 99)), 1), 'maxMm': round(float(dg0.max()), 1)},
                  'scale': round(best[0], 3) if best else None, 'glandAtScale': {'p99Mm': round(best[1], 1), 'maxMm': round(best[2], 1)} if best else None,
                  'nippleTipAfterMm': {'position': [round(float(x), 4) for x in tip_new], 'signedDistanceToSkin': round(tip_sd, 1)},
                  'nippleAndAreola': nip_info,
                  'skinApex': [round(float(x), 4) for x in apex], 'chestWallBehindApex': [round(float(x), 4) for x in wall],
                  'skinBreastProjectionMm': round(float((apex[2] - wall[2]) * 1000), 1), 'hraProjectionMm': round(float((tip[2] - A[2]) * 1000), 1)}
        o = out[S]
        lines.append(f'breast {S}: about A = {o["aboutPoint"]} m; translation T = {o["translationM"]} m; skin breast projects {o["skinBreastProjectionMm"]} mm from the chest wall, '
                     f'the HRA breast {o["hraProjectionMm"]} mm; scale {o["scaleNippleOnApex"]} puts the nipple tip on the apex (gland p99 {o["glandAtThatScale"]["p99Mm"]:+.1f} mm, max {o["glandAtThatScale"]["maxMm"]:+.1f} mm); '
                     f'recommended scale {o["scale"]} gives gland p99 {o["glandAtScale"]["p99Mm"] if best else "n/a"} mm, nipple tip {tip_sd:+.1f} mm from the skin; '
                     f'nipple and areola parts {nip_info["parts"]} get the extra translation {nip_info["extraTranslationM"]} m: areola median {nip_info["areolaToSkinMm"]["median"]:+.1f} mm from the skin, nipple tip {sd_tip:+.1f} mm outside')
    json.dump({'transform': "p' = aboutPoint + translationM + scale * (p - aboutPoint), applied to every HRA part of that side; the parts listed under nippleAndAreola.parts then also get + extraTranslationM",
               'note': {'zh': '有符号距离：正 = 在皮肤外。skin 为 female-skin/skin.obj。', 'en': 'signed distances: positive = outside the skin. The skin is female-skin/skin.obj.'},
               'sides': out}, open(os.path.join(d, 'breast-placement.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'breast-placement.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))
    # 胸部特写：皮肤半透明，下面是按上面的变换摆好的 HRA 乳腺部件和胸壁 / chest close-up: the skin semi-transparent over the HRA mammary parts placed by the transform above, and the chest wall
    from bodylib import render_closeup
    layers = [(V, F, (0.87, 0.72, 0.62))]
    for S in 'LR':
        A, T, sc, noff, skin_ids, parts = xf[S]
        for p in parts:
            v, f = mesh0(p), fb.mesh(p)[1]
            v2 = A + T + sc * (v - A) + (noff if p['id'] in skin_ids else 0.0)
            layers.append((v2, f, (0.55, 0.25, 0.2) if p['id'] in skin_ids else ((0.95, 0.6, 0.7) if p['tissue'] == 'gland' else (0.95, 0.85, 0.5))))
    layers.append((np.asarray(DV), np.asarray(DF), (0.75, 0.3, 0.3)))
    sy = float(np.mean([xf[S][0][1] + xf[S][1][1] for S in 'LR']))
    lo, hi = [-0.22, sy - 0.16, -0.05], [0.22, sy + 0.20, 0.32]
    render_closeup(layers, os.path.join(d, 'closeup-chest-gland.png'), lo, hi, views=('front', 'side'), height=900, alpha=0.5)
    render_closeup(layers[:1], os.path.join(d, 'closeup-chest-skin-only.png'), lo, hi, views=('front', 'side'), height=900)


if __name__ == '__main__':
    main()
