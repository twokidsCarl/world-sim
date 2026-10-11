"""在 MHR 身份空间取样、测量，并与人体测量模型比较。
Sample MHR's identity space, measure every body with our measurer, compare with the
anthropometric model.

    python tools/bodyshape/calibrate_mhr.py  -> data/raw/bodyshape/out/mhr-sweep.json

MHR 没有性别和胖瘦标签：第 1 主成分是胖瘦，第 2 主成分是性别（由渲染图确认，见 REPORT）。
MHR has no sex or fatness labels: component 1 is fatness and component 2 is sex (confirmed on
renders, see REPORT). A body is compared with the female model when component 2 > 0.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import CUR, RAW  # noqa: E402
from calibrate_anny import joint_lengths, zrow  # noqa: E402
from measure import surface_measures  # noqa: E402


def main():
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    rng = np.random.default_rng(7)
    ids = []
    for a in (-2.5, -1.5, -0.75, 0, 0.75, 1.5, 2.5):
        for b in (-2, -1, 0, 1, 2):
            v = np.zeros(20)
            v[0], v[1] = a, b
            ids.append(v)
    for c in range(2, 8):
        for s in (-2, 2):
            for b in (-1.5, 1.5):
                v = np.zeros(20)
                v[c], v[1] = s, b
                ids.append(v)
    for _ in range(60):
        ids.append(rng.normal(size=20))
    rows = []
    for i, v in enumerate(ids):
        b = mhrlib.body(v)
        vals = {k: float(x) for k, x in surface_measures(b['V'], b['F'], b['joints']).items()}
        vals.update(joint_lengths(b['joints']))
        sex = 'F' if v[1] > 0 else 'M'
        rows.append({'identity': [round(float(x), 3) for x in v], 'sexAssumed': sex,
                     'measures': {k: round(x, 1) for k, x in vals.items()},
                     'vsModel': {'F': zrow(vals, 'F', model), 'M': zrow(vals, 'M', model)}})
        if i % 10 == 9 or i == len(ids) - 1:
            json.dump(rows, open(os.path.join(RAW, 'out', 'mhr-sweep.json'), 'w'), indent=0)
        print(i, len(ids), np.round(v[:3], 2), round(vals['stature']), round(vals['bmiFromVolume'], 1), flush=True)


if __name__ == '__main__':
    main()
