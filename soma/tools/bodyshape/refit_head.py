"""
男性：只重做头。把 MHR 的眼关节对到他的眼球中心上，再把眼以上的颅部缩放到盖住颅盖；身体的拟合不动。
Male: the head only. MHR's eye joints are brought onto the centres of his eyeballs and the cranium above the eyes is
scaled to cover the vault; the fit of the body is untouched.

    python tools/bodyshape/refit_head.py male     -> 改写 male-skin/fit-state.npz（原件留作 fit-state-before-head.npz）
                                                     rewrites male-skin/fit-state.npz (the original is kept as fit-state-before-head.npz)
    python tools/bodyshape/enclose_skin.py male   -> 之后重新包住、写包 / then enclose again and write the package

原因：原来的拟合是对他旧皮肤的外形做的，头顶对上了，眼关节却比他的眼球中心高 14 mm（MHR 平均头眼以上矮）；
于是眼球露在 MHR 的眼睑下方，外推把眼区顶成了一个包（最多 30 mm）。头部顶点上原来对旧皮肤的残差偏移随之作废，置零。
Why: the original fit matched the outline of his old skin, so the crown agreed but the eye joints sat 14 mm above the
centres of his eyeballs (MHR's average head is short above the eyes); the globes then showed below MHR's lids and the
push raised the eye region into a lump (up to 30 mm). The residual offsets towards the old skin on the head vertices no
longer apply and are set to zero.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_target as BT  # noqa: E402
import final_female as FF  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body  # noqa: E402


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else f'{name}-skin')
    src, keep = os.path.join(d, 'fit-state.npz'), os.path.join(d, 'fit-state-before-head.npz')
    if not os.path.exists(keep):
        shutil.copy(src, keep)
    st = np.load(keep)
    ident, mp, off, lod = st['identity'].copy(), st['mp'].copy(), st['offsets'].copy(), int(st['lod'])
    fb = Body(name)
    log = [f'{name}: head refit']
    ident, mp2, hs, info = FF.fit_head(ident, mp, fb, log)
    F, jn = mhrlib.faces(lod), mhrlib.joint_names(lod)
    Vm, P, _ = mhrlib.run(ident, mp2, lod, True)
    wh = FF.head_weight(lod)
    # 头和颈上原来对旧皮肤的残差偏移作废（颈的姿势也变了；留着它在胸骨上切迹处成了一个锯齿状的坑）：按“头 + 颈”的蒙皮权重置零，边缘抹平。
    # The residual offsets towards the old skin are void on head and neck (the neck pose changed too; left in place they
    # made a jagged pit at the jugular notch): set to zero by the skin weight of head + neck, smoothed at the rim.
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    nk = np.array([n.startswith(FF.HEAD_JOINTS + ('c_neck',)) for n in jn])
    whn = np.zeros(len(Vm))
    np.add.at(whn, vi, w * nk[ji])
    import enclose_skin as ES
    A = ES.adjacency(len(Vm), F)
    whn = np.clip(whn, 0, 1)
    for _ in range(6):
        whn = np.maximum(whn, 0.5 * whn + 0.5 * (A @ whn))
    off2 = off * (1 - whn)[:, None]
    for _ in range(4):
        sm = A @ off2
        band = ((whn > 0.02) & (whn < 0.98))[:, None]
        off2 = np.where(band, 0.5 * off2 + 0.5 * sm, off2)
    V = Vm + off2
    # 颅盖上的头皮取 5 mm（原来按 6 mm 缩放，量出来中位数 8.1 mm，颅顶显得高而鼓；2023 T-Table：颅顶 5.0、枕后点 6.0 mm）
    # scalp over the vault taken as 5 mm (scaled for 6 mm before, which measured a median of 8.1 mm and a high, domed crown; 2023 T-Table: vertex 5.0, opisthocranion 6.0 mm)
    BT.SCALP = 0.0045
    V = BT.head_scale(V, F, P, jn, lod, fb, log)(V)
    V, eye_info = FF.eye_warp(V, F, P, jn, wh, fb, lod, log)
    pivot = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
    V = FF.face_scale(V, F, pivot, wh, fb, log, FF.face_landmarks(ident, lod))(V)
    info = dict(info, eyes=eye_info)
    np.savez(src, identity=ident, mp=mp2, offsets=V - Vm, lod=lod)
    json.dump(info, open(os.path.join(d, 'head-refit.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'head-refit.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
