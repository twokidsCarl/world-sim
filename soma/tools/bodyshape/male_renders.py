"""
男性皮肤包的补充渲染：两侧腋下（自前下方）、胸（乳头）、脐、颈。
Extra renders of the male skin package: both axillae from below and in front, chest (nipples), navel, neck.

    python tools/bodyshape/male_renders.py [包目录 = male-skin]   -> closeup-axilla-below-front.png, closeup-chest-nipples.png, closeup-navel.png, closeup-neck.png
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402
from measure import bone_landmarks  # noqa: E402


def main():
    name = sys.argv[2] if len(sys.argv) > 2 else 'male'   # 第二个参数是身体名（也用于女性）/ second argument: the body (also used for the female)
    d = os.path.join(RAW, 'out', sys.argv[1] if len(sys.argv) > 1 else 'male-skin')
    st = np.load(os.path.join(d, 'fit-state-final.npz'))
    lod = int(st['lod'])
    F = mhrlib.faces(lod)
    V = mhrlib.run(st['identity'], st['mp'], lod, True)[0] + st['offsets']
    L = bone_landmarks(Body(name))
    skin = (0.87, 0.72, 0.62)
    sh = 0.5 * (L['shoulder_L'] + L['shoulder_R'])
    hip = 0.5 * (L['hip_L'] + L['hip_R'])
    # 自前下方看：绕左右轴把身体向后仰 50 度，再按正面渲染 / from below and in front: the body tipped back 50 degrees about the left-right axis, then rendered as a front view
    a = np.radians(50.0)
    R = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    keep = (V[:, 1] > sh[1] - 0.30) & (V[:, 1] < sh[1] + 0.10)
    Fk = F[keep[F].all(1)]
    Vr = (V - sh) @ R.T + sh
    render_closeup([(Vr, Fk, skin)], os.path.join(d, 'closeup-axilla-below-front.png'), [sh[0] - 0.36, float(Vr[keep][:, 1].min()) - 0.01, -9], [sh[0] + 0.36, float(Vr[keep][:, 1].max()) + 0.01, 9], views=('front',), height=900)
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-chest-nipples.png'), [sh[0] - 0.22, sh[1] - 0.28, -0.05], [sh[0] + 0.22, sh[1] - 0.02, 0.4], views=('front', 'side'), height=800)
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-navel.png'), [hip[0] - 0.14, hip[1] - 0.02, -0.02], [hip[0] + 0.14, hip[1] + 0.24, 0.4], views=('front', 'side'), height=800)
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-neck.png'), [sh[0] - 0.17, sh[1] - 0.06, -0.10], [sh[0] + 0.17, sh[1] + 0.17, 0.4], views=('front', 'side'), height=800)

    # 手、足、头的侧面 / hands, feet, head in profile
    for S in 'LR':
        w = L['wrist_' + S]
        render_closeup([(V, F, skin)], os.path.join(d, f'closeup-hand-{S}.png'), [w[0] - 0.13, w[1] - 0.22, w[2] - 0.13], [w[0] + 0.13, w[1] + 0.04, w[2] + 0.16], views=('front', 'side'), height=800)
    an = 0.5 * (L['ankle_L'] + L['ankle_R'])
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-feet.png'), [an[0] - 0.20, V[:, 1].min() - 0.005, an[2] - 0.10], [an[0] + 0.20, an[1] + 0.06, an[2] + 0.24], views=('front', 'side'), height=700)
    a2 = np.radians(55.0)
    R2 = np.array([[1, 0, 0], [0, np.cos(a2), -np.sin(a2)], [0, np.sin(a2), np.cos(a2)]])
    kf = V[:, 1] < an[1] + 0.06
    Vf = (V - an) @ R2.T + an
    render_closeup([(Vf, F[kf[F].all(1)], skin)], os.path.join(d, 'closeup-feet-above.png'), [an[0] - 0.20, float(Vf[kf][:, 1].min()) - 0.01, -9], [an[0] + 0.20, float(Vf[kf][:, 1].max()) + 0.01, 9], views=('front',), height=800)
    top = V[:, 1].max()
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-head-profile.png'), [-1, top - 0.30, -1], [1, top + 0.01, 1], views=('side',), height=900)


if __name__ == '__main__':
    main()
