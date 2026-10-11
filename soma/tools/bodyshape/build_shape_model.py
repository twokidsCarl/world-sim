"""把体型模型方案写成数据：控制量、肢段长度/围度函数、皮下脂肪厚度函数，以及几个算例。
Write the body-shape model proposal as data: controls, segment length / girth functions,
subcutaneous-fat thickness functions, and worked examples.

    python -I tools/bodyshape/build_shape_model.py
    <- data/curated/bodyshape/anthro-model.json, data/raw/bodyshape/out/measure-*.json
    -> data/curated/bodyshape/shape-model.json, data/raw/bodyshape/out/shape-examples.txt

运行时的用法（比例形式）：scale = f(控制量) / f(静止控制量)，静止时恒为 1。
Runtime use (ratio form): scale = f(controls) / f(rest controls), exactly 1 at rest.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bodylib import CUR, RAW  # noqa: E402

S0, B0 = 1650.0, 22.0

# 肢段：名称、绑定的关节（由骨架组定名）、长度 = 若干 ANSUR 量的线性组合
# segments: name, the joints it spans (to be named by the rig), length = linear combination of ANSUR outputs
SEGMENTS = [
    ('headNeck', '头颈', 'Head and neck', {'stature': 1, 'cervicaleheight': -1}),
    ('trunk', '躯干（C7 至大转子）', 'Trunk (C7 to trochanterion)', {'cervicaleheight': 1, 'trochanterionheight': -1}),
    ('thigh', '大腿', 'Thigh', {'trochanterionheight': 1, 'lateralfemoralepicondyleheight': -1}),
    ('shank', '小腿', 'Lower leg', {'lateralfemoralepicondyleheight': 1, 'lateralmalleolusheight': -1}),
    ('ankleHeight', '踝高', 'Ankle height', {'lateralmalleolusheight': 1}),
    ('foot', '足长', 'Foot length', {'footlength': 1}),
    ('upperArm', '上臂', 'Upper arm', {'acromionradialelength': 1}),
    ('forearm', '前臂', 'Forearm', {'radialestylionlength': 1}),
    ('hand', '手长', 'Hand length', {'handlength': 1}),
    ('shoulderWidth', '肩宽（肩峰间）', 'Shoulder width (biacromial)', {'biacromialbreadth': 1}),
    ('pelvisWidth', '骨盆宽（髂嵴间）', 'Pelvis width (bicristal)', {'bicristalbreadth': 1}),
]
# 围度位置 -> (数据集, 变量)。NHANES 的优先用于 BMI 超出 ANSUR 范围时。
# girth sites -> (dataset, variable). NHANES fits are preferred outside the ANSUR BMI range.
GIRTHS = [
    ('neck', '颈', 'Neck', 'ansur', 'neckcircumference'), ('chest', '胸', 'Chest / bust', 'ansur', 'chestcircumference'),
    ('waist', '腰（脐水平）', 'Waist (navel level)', 'ansur', 'waistcircumference'), ('waistIliac', '腰（髂嵴上缘）', 'Waist (above iliac crest)', 'nhanes', 'waist'),
    ('hip', '臀', 'Hip / buttock', 'nhanes', 'hip'), ('thighProximal', '大腿根', 'Proximal thigh', 'ansur', 'thighcircumference'),
    ('thighMid', '大腿中部', 'Mid-thigh', 'nhanes', 'thigh'), ('thighLower', '大腿下部', 'Lower thigh', 'ansur', 'lowerthighcircumference'),
    ('calf', '小腿', 'Calf', 'nhanes', 'calf'), ('ankle', '踝', 'Ankle', 'ansur', 'anklecircumference'),
    ('upperArm', '上臂（放松）', 'Upper arm, relaxed', 'nhanes', 'armcirc'), ('forearm', '前臂', 'Forearm', 'ansur', 'forearmcircumferenceflexed'),
    ('wrist', '腕', 'Wrist', 'ansur', 'wristcircumference'),
]
# 皮下脂肪厚度 t = max(min, a + b * BMI)（毫米，不含皮肤）。来源见 fat-literature.json。
# subcutaneous fat thickness t = max(min, a + b * BMI), mm, skin excluded. Sources: fat-literature.json.
FAT = [
    # site, zh, en, F(a, b), M(a, b), min, basis, quality
    ('abdomen', '腹前壁', 'Anterior abdomen', (-8.47, 1.14), (-13.82, 1.14), 3.0, 'sim2014 regression at age 22 (Korean adults with type-2 diabetes, ultrasound)', 'measured regression, both sexes'),
    ('upperArmPosterior', '上臂后侧', 'Posterior upper arm', (2.09, 0.403), (-1.25, 0.403), 2.0, 'sim2014 regression at age 22', 'measured regression, both sexes'),
    ('deltoid', '三角肌区', 'Deltoid', (-2.1, 0.40), (-3.9, 0.39), 2.0, 'kowatari2023 (Japanese, age 22, ultrasound)', 'measured regression, both sexes'),
    ('thighAnterior', '大腿前侧', 'Anterior thigh', (-4.79, 0.710), (-7.10, 0.647), 2.0, 'jain2013 class means, line fitted here (Indian adults, small cells)', 'derived from class means'),
    ('buttock', '臀部', 'Buttock', (11.5, 0.239), (5.8, 0.239), 5.0, 'gibney2010 pooled class means, line fitted here, +/- half the sex difference (5.7 mm)', 'derived; sex and BMI never stratified together'),
    ('calf', '小腿', 'Calf', (-7.7, 0.495), (-5.1, 0.33), 1.5, 'stoerchle2018: 10 men, 2.8 mm at BMI 24, slope 0.33/BMI; women taken as 1.5 x men (one woman measured 4.0 mm)', 'weak: men n=10; female factor assumed'),
    ('forearm', '前臂', 'Forearm', (0.4, 0.075), (0.0, 0.05), 1.0, 'stoerchle2018 men 1.15 mm, slope 0.05/BMI; women 1.5 x (one woman measured 2.2 mm)', 'weak'),
    ('chestAnterior', '胸前壁（乳房以外）', 'Anterior chest (outside the breast)', (-2.7, 0.405), (-1.8, 0.27), 2.0, 'stoerchle2018 anterior trunk men 4.7 mm, slope 0.27/BMI; women 1.5 x assumed', 'weak; female factor assumed'),
    ('back', '背部', 'Back', (0.7, 0.21), (0.4, 0.14), 2.0, 'stoerchle2018 posterior trunk men 3.8 mm, slope 0.14/BMI; women 1.5 x assumed', 'weak; female factor assumed'),
]


def pred(m, S, B, f=(0, 0)):
    v = m['a'] + m['bStature'] * np.log(S / S0) + m['cBmi'] * np.log(B / B0)
    v += sum(l * x for l, x in zip(m.get('factorLoadings', ()), f))
    return float(np.exp(v))


def seg_len(model, sex, comb, S, B, f=(0, 0)):
    ms = model['sexes'][sex]['outputs']
    return sum(w * (S if k == 'stature' else pred(ms[k], S, B, f)) for k, w in comb.items())


def girth(model, sex, ds, var, S, B, f=(0, 0)):
    if ds == 'nhanes':
        return pred(model['nhanes']['sexes'][sex]['outputs'][var], S, B)
    return pred(model['sexes'][sex]['outputs'][var], S, B, f)


def main():
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    lines = []
    out = {
        'schema': 1,
        'description': {
            'zh': '体型模型方案（Rig.shape 的建议内容）。控制量经人体测量模型换算成各肢段长度、各部位围度和皮下脂肪厚度；运行时取相对静止值的比值。详见 tools/bodyshape/REPORT.md。',
            'en': 'Proposed body-shape model (what Rig.shape would hold). Controls are turned into segment lengths, girths and subcutaneous-fat '
                  'thickness through the anthropometric model; the runtime uses ratios to the rest values. See tools/bodyshape/REPORT.md.'},
        'controls': [
            {'id': 'stature', 'name': {'zh': '身高', 'en': 'Stature'}, 'unit': 'm', 'min': 1.40, 'max': 2.00, 'rest': {'F': 1.670, 'M': 1.720}},
            {'id': 'bmi', 'name': {'zh': '体重指数（胖瘦）', 'en': 'Body-mass index (fatness)'}, 'unit': 'kg/m2', 'min': 16, 'max': 40,
             'rest': {'F': None, 'M': 23.9}, 'note': {'zh': '男性静止值由皮肤体积得出；女性取决于换用哪张皮肤（参考体表为 22）', 'en': 'male rest value from the skin volume; female depends on the skin adopted (22 for the reference surface)'}},
            {'id': 'legLength', 'name': {'zh': '腿长比例', 'en': 'Relative leg length'}, 'unit': 'sd', 'min': -2, 'max': 2, 'rest': {'F': 0, 'M': 0}},
            {'id': 'centralBuild', 'name': {'zh': '体型分布（腰腹型–四肢型）', 'en': 'Mass distribution (waist-heavy vs limb-heavy)'}, 'unit': 'sd', 'min': -2, 'max': 2, 'rest': {'F': 0, 'M': 0}},
        ],
        'formula': {'zh': 'ln y = a + bStature*ln(S/1650) + cBmi*ln(B/22) + L1*legLength + L2*centralBuild（系数在 anthro-model.json）；scale = y(控制量)/y(静止)',
                    'en': 'ln y = a + bStature*ln(S/1650) + cBmi*ln(B/22) + L1*legLength + L2*centralBuild (coefficients in anthro-model.json); scale = y(controls) / y(rest)'},
        'segments': [{'id': s[0], 'name': {'zh': s[1], 'en': s[2]}, 'lengthMm': s[3]} for s in SEGMENTS],
        'girthSites': [{'id': g[0], 'name': {'zh': g[1], 'en': g[2]}, 'dataset': g[3], 'variable': g[4]} for g in GIRTHS],
        'fatSites': [{'id': f[0], 'name': {'zh': f[1], 'en': f[2]}, 'thicknessMm': {'F': {'a': f[3][0], 'b': f[3][1]}, 'M': {'a': f[4][0], 'b': f[4][1]}, 'min': f[5]},
                      'basis': f[6], 'quality': f[7]} for f in FAT],
        'fatFormula': {'zh': 't = max(min, a + b*BMI)，毫米，不含皮肤（皮肤另加约 2 mm）', 'en': 't = max(min, a + b*BMI), mm, skin excluded (add about 2 mm of skin)'},
        'examples': {},
    }
    meas = {n: json.load(open(os.path.join(RAW, 'out', f'measure-{n}.json'))) for n in ('female', 'male')}
    for sex, body, S in (('F', 'female', 1606.0), ('M', 'male', 1726.0)):
        ex = {'statureMm': S, 'note': {'zh': '身高取中国 20–24 岁均值（2020 国民体质监测）', 'en': 'stature = Chinese 20-24 mean (2020 fitness surveillance)'}, 'byBmi': {}}
        lines.append(f'\n== {sex}: stature {S:.0f} mm; segment lengths (mm) and girths (mm) by BMI; fat thickness (mm)')
        hdr = f'{"":22s}' + ''.join(f'{b:>9.1f}' for b in (18.5, 22, 25, 30, 35))
        lines.append(hdr)
        rows = {}
        for b in (18.5, 22.0, 25.0, 30.0, 35.0):
            e = {'segmentsMm': {s[0]: round(seg_len(model, sex, s[3], S, b), 1) for s in SEGMENTS},
                 'girthsMm': {g[0]: round(girth(model, sex, g[3], g[4], S, b), 1) for g in GIRTHS},
                 'fatMm': {f[0]: round(max(f[5], (f[3] if sex == 'F' else f[4])[0] + (f[3] if sex == 'F' else f[4])[1] * b), 1) for f in FAT}}
            ex['byBmi'][str(b)] = e
            for grp in e:
                for k, v in e[grp].items():
                    rows.setdefault((grp, k), []).append(v)
        for (grp, k), v in rows.items():
            lines.append(f'{grp[:4]:5s}{k:17s}' + ''.join(f'{x:9.1f}' for x in v))
        # 腿长与体型分布因子的效果 / effect of the two build factors at BMI 22
        lines.append('  build factors at BMI 22 (value at -1.5 sd / 0 / +1.5 sd):')
        for fname, idx in (('legLength', 0), ('centralBuild', 1)):
            for key, comb in (('thigh', SEGMENTS[2][3]), ('shank', SEGMENTS[3][3]), ('trunk', SEGMENTS[1][3])):
                vals = [seg_len(model, sex, comb, S, 22.0, tuple(v if i == idx else 0 for i in range(2))) for v in (-1.5, 0, 1.5)]
                lines.append(f'    {fname:13s} {key:8s} ' + ' / '.join(f'{x:.0f}' for x in vals))
            for g in ('waistcircumference', 'calfcircumference', 'bicepscircumferenceflexed', 'biacromialbreadth', 'sittingheight', 'crotchheight'):
                m = model['sexes'][sex]['outputs'][g]
                vals = [pred(m, S, 22.0, tuple(v if i == idx else 0 for i in range(2))) for v in (-1.5, 0, 1.5)]
                lines.append(f'    {fname:13s} {g:26s} ' + ' / '.join(f'{x:.0f}' for x in vals))
        # 我们的骨骼相对“同身高标准”的肢段比 / our skeleton against the standard for its own stature
        sk = meas[body]['skeletal']
        own = {'headNeck': sk['stature'] - sk['cervicaleheight'], 'trunk': sk['cervicaleheight'] - sk['trochanterionheight'],
               'thigh': sk['trochanterionheight'] - sk['lateralfemoralepicondyleheight'],
               'shank': sk['lateralfemoralepicondyleheight'] - sk['lateralmalleolusheight'], 'ankleHeight': sk['lateralmalleolusheight'],
               'upperArm': sk['acromionradialelength'], 'forearm': sk['radialestylionlength'], 'hand': sk.get('handlength', np.nan),
               'shoulderWidth': sk['biacromialbreadth'], 'pelvisWidth': sk['bicristalbreadth']}
        lines.append(f'  our {body} skeleton vs the model at its own stature ({sk["stature"]:.0f} mm), BMI 22: measured / expected / ratio')
        ex['ourSkeletonVsStandard'] = {}
        for s in SEGMENTS:
            if s[0] in own:
                exp = seg_len(model, sex, s[3], sk['stature'], 22.0)
                ex['ourSkeletonVsStandard'][s[0]] = {'measuredMm': round(own[s[0]], 1), 'expectedMm': round(exp, 1), 'ratio': round(own[s[0]] / exp, 3)}
                lines.append(f'    {s[0]:14s} {own[s[0]]:7.1f} / {exp:7.1f} / {own[s[0]] / exp:.3f}')
        out['examples'][sex] = ex
    json.dump(out, open(os.path.join(CUR, 'shape-model.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(RAW, 'out', 'shape-examples.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
