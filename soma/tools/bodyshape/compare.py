"""把一个身体的测量值放进参考分布里：给出百分位和 z 分数。
Place one body's measurements in the reference distributions: percentiles and z-scores.

    python -I tools/bodyshape/compare.py male female
    -> data/curated/bodyshape/our-bodies.json, data/raw/bodyshape/out/compare-<body>.txt

三种比较 / three comparisons, per measurement:
  pct   在同性别 ANSUR II 样本中的经验百分位（不考虑身高体重）
        empirical percentile in the same-sex ANSUR II sample (unconditional)
  z|S,B 相对于“同身高、同 BMI”预测值的 z 分数（残差标准差为单位）
        z-score against the prediction for the same stature and BMI (residual SD units)
  d22   与“同身高、BMI 22”预测值之差（毫米）
        difference from the prediction for the same stature at BMI 22 (mm)
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bodylib import CUR, RAW  # noqa: E402

S0, B0 = 1650.0, 22.0

# 我们的测量名 -> ANSUR II 变量；note 说明定义差异
# our measure -> ANSUR II variable; note = definition difference
SKELETAL = ['cervicaleheight', 'suprasternaleheight', 'acromialheight', 'iliocristaleheight', 'trochanterionheight',
            'tibialheight', 'lateralfemoralepicondyleheight', 'kneeheightmidpatella', 'lateralmalleolusheight',
            'acromionradialelength', 'radialestylionlength', 'handlength', 'biacromialbreadth', 'bicristalbreadth']
SURFACE = [
    ('crotchHeight', 'crotchheight', ''),
    ('chestHeight', 'chestheight', 'level of greatest anterior protrusion'),
    ('buttockHeight', 'buttockheight', ''),
    ('footLength', 'footlength', ''),
    ('footBreadth', 'footbreadthhorizontal', ''),
    ('chestBreadth', 'chestbreadth', 'arms cut off at the axillary folds'),
    ('chestDepth', 'chestdepth', ''),
    ('waistNavelBreadth', 'waistbreadth', 'navel level taken as 0.601 x stature'),
    ('waistNavelDepth', 'waistdepth', ''),
    ('hipBreadth', 'hipbreadth', ''),
    ('buttockDepth', 'buttockdepth', ''),
    ('neckMinGirth', 'neckcircumference', 'horizontal minimum; ANSUR plane is tilted'),
    ('chestGirth', 'chestcircumference', ''),
    ('waistNavelGirth', 'waistcircumference', ''),
    ('buttockGirth', 'buttockcircumference', ''),
    ('thighProximalGirth', 'thighcircumference', ''),
    ('thighLowerGirth', 'lowerthighcircumference', ''),
    ('calfMaxGirth', 'calfcircumference', ''),
    ('ankleMinGirth', 'anklecircumference', ''),
    ('forearmMaxGirth', 'forearmcircumferenceflexed', 'ours relaxed; ANSUR flexed with fist (larger)'),
    ('wristMinGirth', 'wristcircumference', ''),
]
NHANES = [('waistIliacGirth', 'waist'), ('buttockGirth', 'hip'), ('thighMidGirth', 'thigh'), ('calfMaxGirth', 'calf'),
          ('upperArmMidGirth', 'armcirc')]


def load_ansur(sex):
    f = 'FEMALE' if sex == 'F' else 'MALE'
    d = pd.read_csv(f'{RAW}/ansur2/ANSUR_II_{f}_Public.csv', encoding='latin-1')
    d.columns = [c.lower() for c in d.columns]
    return d


def pred(m, S, B):
    return float(np.exp(m['a'] + m['bStature'] * np.log(S / S0) + m['cBmi'] * np.log(B / B0)))


def compare(values, sex, S, B, model, ansur, pairs, nh_pairs=()):
    """values: {our name: mm}; returns rows."""
    rows = []
    ms = model['sexes'][sex]['outputs']
    for ours, av, note in pairs:
        if ours not in values or values[ours] is None or np.isnan(values[ours]):
            continue
        v = values[ours]
        m = ms[av]
        p = pred(m, S, B)
        sd = np.sqrt(m['residualSdLog'] ** 2 + sum(l * l for l in m['factorLoadings']))
        rows.append({'measure': ours, 'reference': 'ANSUR II ' + av, 'valueMm': round(v, 1),
                     'percentileUnconditional': round(float((ansur[av].values < v).mean() * 100), 1),
                     'predictedMm': round(p, 1), 'z': round(float(np.log(v / p) / sd), 2),
                     'predictedAtBmi22Mm': round(pred(m, S, 22.0), 1), 'diffFromBmi22Mm': round(v - pred(m, S, 22.0), 1),
                     'note': note})
    nm = model['nhanes']['sexes'][sex]['outputs']
    for ours, nv in nh_pairs:
        if ours not in values or nv not in nm or np.isnan(values[ours]):
            continue
        v, m = values[ours], nm[nv]
        p = pred(m, S, B)
        rows.append({'measure': ours, 'reference': 'NHANES ' + nv, 'valueMm': round(v, 1), 'percentileUnconditional': None,
                     'predictedMm': round(p, 1), 'z': round(float(np.log(v / p) / m['residualSdLog']), 2),
                     'predictedAtBmi22Mm': round(pred(m, S, 22.0), 1), 'diffFromBmi22Mm': round(v - pred(m, S, 22.0), 1), 'note': ''})
    return rows


def fmt(rows):
    out = [f'{"measure":24s} {"reference":40s} {"value":>7s} {"pct":>5s} {"pred":>7s} {"z":>6s} {"@BMI22":>7s} {"d22":>6s}  note']
    for r in rows:
        pc = '' if r['percentileUnconditional'] is None else f'{r["percentileUnconditional"]:5.1f}'
        out.append(f'{r["measure"]:24s} {r["reference"]:40s} {r["valueMm"]:7.1f} {pc:>5s} {r["predictedMm"]:7.1f} {r["z"]:+6.2f} '
                   f'{r["predictedAtBmi22Mm"]:7.1f} {r["diffFromBmi22Mm"]:+6.1f}  {r["note"]}')
    return '\n'.join(out)


def main():
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    res = {}
    for name in sys.argv[1:]:
        sex = 'F' if name == 'female' else 'M'
        meas = json.load(open(os.path.join(RAW, 'out', f'measure-{name}.json')))
        ansur = load_ansur(sex)
        S = meas['skeletal']['stature']
        B = meas['surface']['bmiFromVolume']
        sk = compare(meas['skeletal'], sex, S, B, model, ansur, [(k, k, 'bony point') for k in SKELETAL])
        su = compare(meas['surface'], sex, S, B, model, ansur, SURFACE, NHANES)
        txt = (f'== {name}  stature {S:.0f} mm (ANSUR {sex} percentile {(ansur.stature.values < S).mean() * 100:.0f}), '
               f'skin volume {meas["surface"]["volumeL"]:.1f} L -> BMI {B:.1f} at {1010} kg/m3\n'
               f'-- skeleton (prediction for her/his stature and that BMI)\n{fmt(sk)}\n-- skin\n{fmt(su)}\n')
        print(txt)
        open(os.path.join(RAW, 'out', f'compare-{name}.txt'), 'w').write(txt)
        res[name] = {'sex': sex, 'statureMm': round(S, 1), 'skinVolumeL': round(meas['surface']['volumeL'], 1),
                     'bmiFromSkinVolume': round(B, 1), 'skeletal': sk, 'surface': su,
                     'pose': {k: round(v, 1) for k, v in meas['skeletal'].items() if 'Deg' in k},
                     'otherMm': {k: round(v, 1) for k, v in meas['skeletal'].items()
                                 if k in ('bitrochantericBreadthBone', 'hipJointSeparation', 'vertexToIschium', 'femurLength',
                                          'tibiaLength', 'humerusLength', 'radiusLength', 'wristheight')}}
    json.dump({'schema': 1,
               'description': {'zh': '我们的男、女模型在参考分布中的位置（由 tools/bodyshape/compare.py 生成）。z 为相对同身高、同 BMI 预测值的标准分。',
                               'en': 'Where our male and female bodies sit in the reference distributions (written by tools/bodyshape/compare.py). '
                                     'z is relative to the prediction for the same stature and BMI.'},
               'bodies': res}, open(os.path.join(CUR, 'our-bodies.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
