"""
内部结构的姿势变了（男性两上肢外展 6.5 度）以后：保留原来的身份系数和对他旧皮肤的残差偏移，只重新解姿势和骨架缩放。
After the pose of the internals changed (the male's upper limbs abducted by 6.5 degrees): the identity and the residual offsets towards
his old skin are kept and only pose and skeleton scales are solved again.

    python tools/bodyshape/refit_pose.py male     -> male-skin/fit-state-before-head.npz（原件留作 fit-state-pose-before.npz / the original kept as fit-state-pose-before.npz）
    之后 / then: refit_head.py male ; enclose_skin.py male ; scan_details 在 enclose_skin 里 / scan_details runs inside enclose_skin

不重新对旧皮肤做外形拟合：那张扫描皮肤的手臂还在原来的位置上。残差偏移是世界坐标里的小位移（中位数约 1 mm），手臂转 6.5 度对它的影响约 11 %，忽略。
The outline is not fitted to the old skin again: the arms of that scanned skin are still where they were. The residual offsets are small
world-space displacements (median about 1 mm); turning the arm by 6.5 degrees changes them by about 11 %, which is ignored.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit_skin as FS  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import classify  # noqa: E402
from fit_skin import Fit, joint_targets, stale_guard, subcutaneous_points  # noqa: E402
from measure import bone_landmarks  # noqa: E402


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else f'{name}-skin')
    stale_guard(name)
    src, keep = os.path.join(d, 'fit-state-before-head.npz'), os.path.join(d, 'fit-state-pose-before.npz')
    if not os.path.exists(keep):
        shutil.copy(src, keep)
    st = np.load(keep)
    ident, mp, off, lod = st['identity'].copy(), st['mp'].copy(), st['offsets'].copy(), int(st['lod'])
    fb = Body(name)
    L = bone_landmarks(fb)
    log = [f'{name}: pose refit with the identity kept']
    jt, src_note = joint_targets(name, fb, L)
    Pb = fb.merged(lambda p: p['tissue'] == 'bone')[0]
    Pb = Pb[~np.isin(classify(Pb, L), ['hand', 'foot'])]
    Pb = Pb[np.random.default_rng(3).choice(len(Pb), 4000, replace=False)]
    fit = Fit(name, 'targets', fb, L, jt, bone_pts=Pb, top_floor=(L['vertex'][1], L['floor'][1]), subcut=subcutaneous_points(fb))
    fit.identity = ident.copy()
    # 只放开上臂、肘、前臂、腕的姿势参数；其余（躯干、腿、足、锁骨、手指、骨架缩放）固定在原值上。
    # 第一次全部放开时，没有皮肤外形约束的足和躯干跑偏了（足部 60 % 的骨和肌肉露出，最远 62 mm）。
    # Only the pose parameters of upper arm, elbow, forearm and wrist are free; everything else (trunk, legs, feet, clavicles, fingers,
    # skeleton scales) is held at its value. With everything free the feet and trunk, no longer held by the outline of the skin, drifted
    # (60 % of the bone and muscle of the feet outside the skin, by up to 62 mm).
    x0 = mp[fit.pidx].copy()
    fingers = ('thumb', 'index', 'middle', 'ring', 'pinky')
    free = np.array([(any(t in n for t in ('uparm', 'elbow', 'lowarm', 'wrist')) and not n.startswith('scale')) or any(t in n for t in fingers) for n in fit.pnames])   # 手指连同各节长度缩放也放开 / fingers too, with their per-segment length scales
    fit.lo[~free], fit.hi[~free] = x0[~free] - 1e-9, x0[~free] + 1e-9
    log.append(f'free parameters: {int(free.sum())} (upper arm, elbow, forearm, wrist, fingers with segment scales)')
    x = fit.solve(14, log, x0)
    mp[fit.pidx] = x
    res = fit.joint_residuals(x)
    log.append('joint residuals (mm): ' + json.dumps(res))
    np.savez(src, identity=ident, mp=mp, offsets=off, lod=lod)
    json.dump({'jointTargetsFrom': src_note, 'jointResidualMm': res}, open(os.path.join(d, 'pose-refit.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'pose-refit.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
