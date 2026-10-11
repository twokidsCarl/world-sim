"""
眼区、口区：是什么把皮肤顶出去的（两个身体）。
Orbital and oral regions: what pushes the skin out there (both bodies).

    python tools/bodyshape/face_diag.py male|female [--dir <package dir>]   -> <dir>/face-diag.txt

对包里的拟合状态量：区内各阶段的位移；以及哪些深部部件（不做任何排除）在“外推之前的皮肤”之外或离它不足 2.5 mm。
For the fit state in the package: the displacement of each stage inside the regions, and which deep parts (nothing
excluded) lie outside the skin as it was before the push, or within 2.5 mm of it.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import signed_distance  # noqa: E402


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else f'{name}-skin')
    st, fin = np.load(os.path.join(d, 'fit-state.npz')), np.load(os.path.join(d, 'fit-state-final.npz'))
    lod = int(st['lod'])
    F = mhrlib.faces(lod)
    Vm, P, _ = mhrlib.run(fin['identity'], fin['mp'], lod, True)
    V0, V1 = Vm + st['offsets'], Vm + fin['offsets']
    pw, reg = ES.face_protect(lod)
    fb = Body(name)
    skip = ES.excluded_face_parts(fb)
    jn = mhrlib.joint_names(lod)
    lines = [f'{name}: package {os.path.basename(d)}']
    for S, j, part in (('L', 'l_eye', 'Left vitreous body'), ('R', 'r_eye', 'Right vitreous body')):
        try:
            c = fb.verts(part).mean(0)
            lines.append(f'  eye joint {S} to the centre of the eyeball ({part}): {np.linalg.norm(P[jn.index(j)] - c) * 1000:.1f} mm, offset (x, y, z) {np.round((P[jn.index(j)] - c) * 1000, 1).tolist()}')
        except Exception as ex:
            lines.append(f'  no {part}: {ex}')
    from scipy.spatial import cKDTree
    tree = cKDTree(V0)
    lab = np.full(len(V0), -1)
    keys = list(reg)
    for i, k in enumerate(keys):
        lab[reg[k]] = i
    a, b = np.linalg.norm(V0 - Vm, axis=1) * 1000, np.linalg.norm(V1 - V0, axis=1) * 1000
    for i, k in enumerate(keys):
        m = lab == i
        lines.append(f'  {k}: {int(m.sum())} vertices; offsets before the enclosure (fit residual / relaxation) median {np.median(a[m]):.1f}, p95 {np.percentile(a[m], 95):.1f}, max {a[m].max():.1f} mm; '
                     f'enclosure push median {np.median(b[m]):.1f}, p95 {np.percentile(b[m], 95):.1f}, max {b[m].max():.1f} mm')
    rows = []
    for p in fb.deep_parts():
        v = fb.mesh(p)[0]
        _, near = tree.query(v)
        for i, k in enumerate(keys):
            m = lab[near] == i
            if m.sum() >= 3:
                s = signed_distance(v[m], V0, F) * 1000
                if s.max() > -2.5:
                    rows.append((float(s.max()), k, p['name'], p['tissue'], float((s > -2.5).mean()), p['id'] in skip))
    rows.sort(key=lambda r: -r[0])
    lines.append('  deep parts under these regions that reach within 2.5 mm of the skin before the push or beyond it (max mm outside, region, part, share of its points there that push, now excluded?):')
    for r in rows[:45]:
        lines.append(f'    {r[0]:+6.1f}  {r[1]:6s} {r[2]} [{r[3]}]  {100 * r[4]:.0f} %  {"EXCLUDED" if r[5] else "kept"}')
    open(os.path.join(d, 'face-diag.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
