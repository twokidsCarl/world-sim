"""汇总参数化模型的标定结果：各模型在不同体型下与真人人体测量的偏差。
Summarise the calibration sweeps: how far each parametric model is from measured anthropometry,
by body type.

    python -I tools/bodyshape/calibration_report.py
    <- data/raw/bodyshape/out/anny-sweep.json, mhr-sweep.json
    -> data/curated/bodyshape/model-calibration.json, data/raw/bodyshape/out/calibration.txt
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bodylib import CUR, RAW  # noqa: E402

KEYS = ['crotchHeight', 'chestHeight', 'buttockHeight', 'footLength', 'chestBreadth', 'chestDepth', 'waistNavelBreadth', 'waistNavelDepth',
        'hipBreadth', 'buttockDepth', 'neckMinGirth', 'chestGirth', 'waistNavelGirth', 'buttockGirth', 'thighProximalGirth',
        'thighLowerGirth', 'calfMaxGirth', 'ankleMinGirth', 'forearmMaxGirth', 'wristMinGirth',
        'nhanes:waist', 'nhanes:hip', 'nhanes:thigh', 'nhanes:calf', 'nhanes:armcirc']
BMI_CLASSES = [('<18.5', 0, 18.5), ('18.5-25', 18.5, 25), ('25-30', 25, 30), ('30-40', 30, 40), ('>=40', 40, 999)]


def table(rows, getz, lines, title):
    """按 BMI 分级的平均 z 与平均差（毫米）/ mean z and mean difference (mm) by BMI class."""
    out = {}
    lines.append(f'\n-- {title}: mean z (mean diff mm) by BMI class of the mesh; n per class: ' +
                 ', '.join(f'{c}:{sum(1 for r in rows if lo <= r["measures"]["bmiFromVolume"] < hi)}' for c, lo, hi in BMI_CLASSES))
    lines.append(f'{"measure":22s}' + ''.join(f'{c:>16s}' for c, _, _ in BMI_CLASSES) + f'{"all |z| mean":>14s}')
    for k in KEYS:
        s = f'{k:22s}'
        out[k] = {}
        allz = []
        for c, lo, hi in BMI_CLASSES:
            zs = [getz(r).get(k) for r in rows if lo <= r['measures']['bmiFromVolume'] < hi]
            zs = [z for z in zs if z]
            if len(zs) >= 2:
                mz, md = np.mean([z['z'] for z in zs]), np.mean([z['diffMm'] for z in zs])
                out[k][c] = {'meanZ': round(float(mz), 2), 'meanDiffMm': round(float(md), 1), 'n': len(zs)}
                s += f'{mz:+7.2f} ({md:+5.0f})'
                allz += [abs(z['z']) for z in zs]
            else:
                s += f'{"":16s}'
        if allz:
            out[k]['meanAbsZ'] = round(float(np.mean(allz)), 2)
            s += f'{np.mean(allz):14.2f}'
        lines.append(s)
    return out


def main():
    lines = []
    res = {'schema': 1, 'description': {
        'zh': '参数化人体模型的标定：用同一测量程序量出各样本，与“同身高、同 BMI 的真人”（ANSUR II / NHANES 回归）比较。z 以人群残差标准差为单位，'
              '|z|<1 表示在真人常见范围内。网格 BMI 由体积按 1010 kg/m3 换算。',
        'en': 'Calibration of the parametric body models: every sample is measured with the same measurer and compared with real people of the '
              'same stature and BMI (ANSUR II / NHANES regressions). z is in population residual SDs; |z| < 1 is within the usual human range. '
              'Mesh BMI is from volume at 1010 kg/m3.'}, 'models': {}}
    p = os.path.join(RAW, 'out', 'anny-sweep.json')
    if os.path.exists(p):
        rows = json.load(open(p))
        A = {'source': 'Anny 0.6.1 (MakeHuman/MPFB2 CC0 targets)', 'samples': len(rows), 'bySex': {}}
        for sex in 'FM':
            rs = [r for r in rows if r['sex'] == sex and abs(r['phenotype'].get('age', 0.667) - 0.667) < 0.01
                  and r['phenotype'].get('proportions', 0.5) == 0.5 and 'cupsize' not in r['phenotype']]
            lines.append(f'\n================ Anny {sex}: macro parameters -> stature (mm) / BMI')
            lines.append('weight  muscle  ' + '  '.join(f'height={h}' for h in (0.0, 0.5, 1.0)))
            mp = []
            for w in (0.0, 0.25, 0.5, 0.75, 1.0):
                for mu in (0.0, 0.5, 1.0):
                    s = f'{w:5.2f}  {mu:5.1f}   '
                    for h in (0.0, 0.5, 1.0):
                        r = [x for x in rs if x['phenotype']['weight'] == w and x['phenotype']['muscle'] == mu and x['phenotype']['height'] == h]
                        if r:
                            m = r[0]['measures']
                            s += f'{m["stature"]:5.0f}/{m["bmiFromVolume"]:4.1f}   '
                            mp.append({'weight': w, 'muscle': mu, 'height': h, 'statureMm': m['stature'], 'bmi': round(m['bmiFromVolume'], 1)})
                    lines.append(s)
            adult = [r for r in rs if r['phenotype']['height'] >= 0.5]
            A['bySex'][sex] = {'parameterMap': mp,
                               'bias': table(adult, lambda r: r['vsModel'], lines, f'Anny {sex} (height >= 0.5, young adult, {len(adult)} bodies)')}
            # 单因素：比例、年龄、罩杯 / one-factor sweeps
            base = [r for r in rows if r['sex'] == sex and r['phenotype'].get('weight') == 0.5 and r['phenotype'].get('muscle') == 0.5
                    and r['phenotype'].get('height') == 0.5]
            for r in base:
                ph, m = r['phenotype'], r['measures']
                lines.append(f'   one-factor {sex}: prop={ph.get("proportions")} age={ph.get("age"):.2f} cup={ph.get("cupsize", "-")}: stature {m["stature"]:.0f} BMI {m["bmiFromVolume"]:.1f} '
                             f'crotch/stature {m["crotchHeight"] / m["stature"]:.3f} chest {m["chestGirth"]:.0f} underbust {m.get("underbustGirth", 0):.0f} waistMin {m["waistMinGirth"]:.0f} '
                             f'hip {m["buttockGirth"]:.0f} shoulderJointSep {m["shoulderJointSeparation"]:.0f} hipBreadth {m["hipBreadth"]:.0f}')
        res['models']['anny'] = A
    p = os.path.join(RAW, 'out', 'mhr-sweep.json')
    if os.path.exists(p):
        rows = json.load(open(p))
        M = {'source': 'MHR v1.0.1 LOD1 (Apache-2.0), identity components 1-20', 'samples': len(rows), 'bySex': {}}
        X = np.array([r['identity'] for r in rows])
        lines.append(f'\n================ MHR: {len(rows)} samples')
        # 身份系数 -> 测量 的线性回归 / linear regression identity -> measurements
        Xd = np.c_[np.ones(len(X)), X]
        reg = {}
        for k in ('bmiFromVolume', 'stature', 'chestGirth', 'underbustGirth', 'waistNavelGirth', 'buttockGirth', 'thighProximalGirth', 'calfMaxGirth',
                  'upperArmMidGirth', 'hipBreadth', 'shoulderJointSeparation', 'crotchHeight'):
            y = np.array([r['measures'].get(k, np.nan) for r in rows], float)
            ok = ~np.isnan(y)
            c, *_ = np.linalg.lstsq(Xd[ok], y[ok], rcond=None)
            r2 = 1 - ((y[ok] - Xd[ok] @ c) ** 2).sum() / ((y[ok] - y[ok].mean()) ** 2).sum()
            reg[k] = {'intercept': round(float(c[0]), 2), 'perComponent': [round(float(x), 2) for x in c[1:9]], 'r2': round(float(r2), 3)}
            lines.append(f'  {k:24s} = {c[0]:8.1f} ' + ' '.join(f'{x:+7.1f}' for x in c[1:7]) + f'  (c1..c6)   R2={r2:.2f}')
        M['linearMap'] = {'note': {'zh': '各测量值对前 8 个身份系数的线性回归（毫米；BMI 为 kg/m2）', 'en': 'measurement = intercept + sum_i perComponent[i] * identity[i] (mm; BMI in kg/m2), first 8 components shown'}, 'fits': reg}
        st = [r['measures']['stature'] for r in rows]
        lines.append(f'  stature range over all samples: {min(st):.0f}-{max(st):.0f} mm (identity does not change height)')
        for sex in 'FM':
            rs = [r for r in rows if r['sexAssumed'] == sex and abs(r['identity'][1]) >= 0.5]
            M['bySex'][sex] = {'bias': table(rs, lambda r, sex=sex: r['vsModel'][sex], lines, f'MHR, component 2 {"> 0.5 (female side)" if sex == "F" else "< -0.5 (male side)"}, vs {sex} model, {len(rs)} bodies')}
        res['models']['mhr'] = M
    json.dump(res, open(os.path.join(CUR, 'model-calibration.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(RAW, 'out', 'calibration.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
