"""在 Anny/MakeHuman 的参数范围内取样、用同一把“尺子”测量，并与人体测量模型比较。
Sample the Anny / MakeHuman parameter range, measure every body with the same measurer as ours,
and compare with the anthropometric model (ANSUR II / NHANES).

    python tools/bodyshape/calibrate_anny.py
    -> data/raw/bodyshape/out/anny-sweep.json          每个样本的测量值 / all measurements
       data/curated/bodyshape/anny-calibration.json    参数->(身高, BMI) 映射与偏差表 / mapping + bias table

每个网格的 BMI 由体积得到（密度 1010 kg/m3），再问：真人在这个身高和 BMI 下各围度是多少？
Each mesh's BMI comes from its volume (1010 kg/m3); the question is then what real people of that
stature and BMI measure, and how far the artist-built mesh is from that (z = residual SDs).
"""
import itertools
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import annylib  # noqa: E402
from bodylib import CUR, RAW  # noqa: E402
from compare import NHANES, SURFACE, pred  # noqa: E402
from measure import surface_measures  # noqa: E402

PAIRS = [p for p in SURFACE if p[0] not in ('footBreadth',)]


def joint_lengths(J):
    d = lambda a, b: float(np.linalg.norm(J[a] - J[b]) * 1000)
    avg = lambda f: 0.5 * (f('L') + f('R'))
    return {
        'shoulderJointHeight': avg(lambda s: J['shoulder_' + s][1] * 1000),
        'hipJointHeight': avg(lambda s: J['hip_' + s][1] * 1000),
        'kneeJointHeight': avg(lambda s: J['knee_' + s][1] * 1000),
        'ankleJointHeight': avg(lambda s: J['ankle_' + s][1] * 1000),
        'upperArmJointLength': avg(lambda s: d('shoulder_' + s, 'elbow_' + s)),
        'forearmJointLength': avg(lambda s: d('elbow_' + s, 'wrist_' + s)),
        'thighJointLength': avg(lambda s: d('hip_' + s, 'knee_' + s)),
        'shankJointLength': avg(lambda s: d('knee_' + s, 'ankle_' + s)),
        'shoulderJointSeparation': d('shoulder_L', 'shoulder_R'),
        'hipJointSeparation': d('hip_L', 'hip_R'),
    }


def zrow(vals, sex, model):
    S, B = vals['stature'], vals['bmiFromVolume']
    ms = model['sexes'][sex]['outputs']
    z = {}
    for ours, av, _ in PAIRS:
        if ours in vals and not np.isnan(vals[ours]):
            m = ms[av]
            sd = np.sqrt(m['residualSdLog'] ** 2 + sum(l * l for l in m['factorLoadings']))
            z[ours] = {'z': round(float(np.log(vals[ours] / pred(m, S, B)) / sd), 2),
                       'diffMm': round(float(vals[ours] - pred(m, S, B)), 1)}
    nm = model['nhanes']['sexes'][sex]['outputs']
    for ours, nv in NHANES:
        if ours in vals and nv in nm and not np.isnan(vals[ours]):
            m = nm[nv]
            z['nhanes:' + nv] = {'z': round(float(np.log(vals[ours] / pred(m, S, B)) / m['residualSdLog']), 2),
                                 'diffMm': round(float(vals[ours] - pred(m, S, B)), 1)}
    return z


def main():
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    rows = []
    grid = list(itertools.product((1.0, 0.0), (0.0, 0.25, 0.5, 0.75, 1.0), (0.0, 0.5, 1.0), (0.0, 0.5, 1.0), (0.5,), (2 / 3,)))
    # 另加比例、年龄、罩杯的单因素扫描 / plus one-factor sweeps of proportions, age, cup size
    for g in (1.0, 0.0):
        grid += [(g, 0.5, 0.5, 0.5, 0.0, 2 / 3), (g, 0.5, 0.5, 0.5, 1.0, 2 / 3), (g, 0.5, 0.5, 0.5, 0.5, 1.0), (g, 0.5, 0.5, 0.5, 0.5, 5 / 6)]
    extra = [dict(gender=1.0, weight=w, muscle=0.5, height=0.5, proportions=0.5, age=2 / 3, cupsize=c)
             for w in (0.25, 0.5, 0.75) for c in (0.0, 1.0)]
    todo = [dict(gender=g, weight=w, muscle=mu, height=h, proportions=p, age=a) for g, w, mu, h, p, a in grid] + extra
    for i, ph in enumerate(todo):
        b = annylib.body(ph)
        vals = surface_measures(b['V'], b['F'], b['joints'])
        vals = {k: float(v) for k, v in vals.items()}
        vals.update(joint_lengths(b['joints']))
        sex = 'F' if ph['gender'] > 0.5 else 'M'
        rows.append({'phenotype': ph, 'sex': sex, 'measures': {k: round(v, 1) for k, v in vals.items()}, 'vsModel': zrow(vals, sex, model)})
        if i % 10 == 9:
            json.dump(rows, open(os.path.join(RAW, 'out', 'anny-sweep.json'), 'w'), indent=0)
        print(i, len(todo), sex, {k: round(v, 2) for k, v in ph.items()}, round(vals['stature']), round(vals['bmiFromVolume'], 1), flush=True)
    os.makedirs(os.path.join(RAW, 'out'), exist_ok=True)
    json.dump(rows, open(os.path.join(RAW, 'out', 'anny-sweep.json'), 'w'), indent=0)


if __name__ == '__main__':
    main()
