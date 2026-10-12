"""
面部复核（两个身体通用）：头面部各深部结构上的覆盖、眼和口的对位，以及眼口区特写。
Face checks (either body): cover over the deep parts of head and face, registration of eyes and mouth, close-ups of the eye and mouth region.

    python tools/bodyshape/face_checks.py male|female   -> <包>/face-checks.json / .txt, closeup-face-skin.png, closeup-face-muscles.png
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402
from fit_check import signed_distance  # noqa: E402

KEYS = ('orbicularis oculi', 'orbicularis oris', 'zygomaticus major', 'zygomaticus minor', 'frontal', 'masseter', 'buccinator', 'mentalis', 'levator labii', 'depressor anguli',
        'nasalis', 'procerus', 'corrugator', 'risorius', 'cornea', 'lip')


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else f'{name}-skin')
    st = np.load(os.path.join(d, 'fit-state-final.npz'))
    lod = int(st['lod'])
    F, jn = mhrlib.faces(lod), mhrlib.joint_names(lod)
    Vm, P, _ = mhrlib.run(st['identity'], st['mp'], lod, True)
    V = Vm + st['offsets']
    fb = Body(name)
    skip = ES.excluded_face_parts(fb)
    rep, lines = {'eyes': {}, 'cover': {}}, [f'{name}: face checks on {os.path.basename(d)}']
    for S, j, part in (('L', 'l_eye', 'Left vitreous body'), ('R', 'r_eye', 'Right vitreous body')):
        c = fb.verts(part).mean(0)
        o = (P[jn.index(j)] - c) * 1000
        rep['eyes'][S] = {'eyeJointToEyeballCentreMm': round(float(np.linalg.norm(o)), 1), 'offsetXYZMm': np.round(o, 1).tolist()}
        lines.append(f'  eye {S}: MHR eye joint to the centre of the eyeball {np.linalg.norm(o):.1f} mm, offset (x, y, z) {np.round(o, 1).tolist()}')
    groups = {'vault': ['Frontal bone', 'Left parietal bone', 'Right parietal bone', 'Occipital bone'], 'zygomatic bones': ['Left zygomatic bone', 'Right zygomatic bone'],
              'nasal bones': ['Left nasal bone', 'Right nasal bone'], 'mandible': ['Mandible']}
    for p in fb.deep_parts():
        n = p['name'].lower()
        for key in KEYS:
            if key in n and not ('lip' == key and ('labii' in n or 'elliptical' in n)):
                k = key
                if key == 'orbicularis oculi':   # 按几何分内环、外环 / inner and outer ring by geometry
                    k = 'orbicularis oculi, inner ring (lid margins; not enclosed)' if p['id'] in skip else 'orbicularis oculi, outer ring'
                groups.setdefault(k, []).append(p['name'])
    lines.append('  cover under the skin, mm (negative = outside the skin): min / p5 / median')
    for key, names in groups.items():
        pts = np.vstack([fb.verts(n) for n in names])
        s = -signed_distance(pts, V, F) * 1000
        if key in ('vault', 'mandible', 'zygomatic bones', 'nasal bones'):
            s = np.sort(s)[:max(10, int(0.3 * len(s)))]   # 朝外的一面 / the outward face
        rep['cover'][key] = {'min': round(float(s.min()), 1), 'p5': round(float(np.percentile(s, 5)), 1), 'median': round(float(np.median(s)), 1)}
        lines.append(f'    {key:58s} {s.min():6.1f} {np.percentile(s, 5):6.1f} {np.median(s):6.1f}')
    json.dump(rep, open(os.path.join(d, 'face-checks.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'face-checks.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    e = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    lo, hi = [e[0] - 0.085, e[1] - 0.125, e[2] - 0.06], [e[0] + 0.085, e[1] + 0.06, e[2] + 0.12]
    skin = (0.87, 0.72, 0.62)
    MV, MF = fb.merged(lambda p: p['tissue'] in ('muscle', 'tendon') and p['system'] != 'integumentary')
    EV, EF = fb.merged(lambda p: p['id'] in skip)
    render_closeup([(V, F, skin)], os.path.join(d, 'closeup-face-skin.png'), lo, hi, views=('front', 'side'), height=1000)
    render_closeup([(V, F, skin), (MV, MF, (0.75, 0.2, 0.2)), (EV, EF, (0.3, 0.45, 0.8))], os.path.join(d, 'closeup-face-muscles.png'), lo, hi, views=('front', 'side'), height=1000, alpha=0.45)
    # 头：正面和四分之三侧面（绕竖轴转 35 度后按正面渲染）/ head: front and three-quarter view (turned 35 degrees about the vertical axis, rendered as a front view)
    top = V[:, 1].max()
    c0 = np.array([e[0], 0.0, e[2] - 0.08])
    a = np.radians(-35.0)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    hv = V[:, 1] > top - 0.34
    Fh = F[hv[F].all(1)]
    Vr = (V - c0) @ R.T + c0
    lo2, hi2 = [e[0] - 0.16, top - 0.30, -1.0], [e[0] + 0.16, top + 0.01, 1.0]
    render_closeup([(V, Fh, skin)], os.path.join(d, 'closeup-head-front.png'), lo2, hi2, views=('front',), height=1000)
    render_closeup([(Vr, Fh, skin)], os.path.join(d, 'closeup-head-threequarter.png'), lo2, hi2, views=('front',), height=1000)


if __name__ == '__main__':
    main()
