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
    rs = rig_shape(model, meas)
    for sx in 'FM':
        lines.append(f'\n== rig-shape {sx}: segment  bStature  legLength  centralBuild  standard mm  as-built ratio')
        ab = rs['sexes'][sx]['presets'][1]['segmentFactors']
        for g in rs['sexes'][sx]['segments']:
            lines.append(f'   {g["id"]:14s} {g["bStature"]:7.3f} {g["legLength"]:+8.4f} {g["centralBuild"]:+8.4f} {g["standardLengthMm"]:8.1f}   {ab.get(g["id"], float("nan")):.3f}  (fit err {g["fitErrorMax"]:.4f})')
        lines.append('   girths standard mm: ' + ', '.join(f'{g["id"]} {g["standardMm"]:.0f}' for g in rs['sexes'][sx]['girths']))
        lines.append('   fat standard mm: ' + ', '.join(f'{g["id"]} {g["standardMm"]:.1f}' for g in rs['sexes'][sx]['fat']))
    open(os.path.join(RAW, 'out', 'shape-examples.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


# ------------------------------------------------------------------ 运行时格式 / the runtime format (proposed Rig.shape data)

# 肢段 -> 解剖学关节（rig.json 的关节 id，不带左右）/ segment -> anatomical joints (rig.json ids without side)
SEGMENT_JOINTS = {
    'headNeck': ('length', 'C7', 'skull', '沿 C7 至颅顶：分摊到 C7…C1 各椎间关节，并等比缩放颅骨（长度量到颅顶，不止到寰枕关节）', 'C7 to the vertex: spread over the C7...C1 joints, skull scaled uniformly (the length runs to the top of the head, beyond the atlanto-occipital joint)'),
    'trunk': ('length', 'hip', 'C7', '髋关节中心高度至 C7：分摊到 L5…T1 各椎间关节', 'hip-centre level to C7: spread over the L5...T1 joints'),
    'thigh': ('length', 'hip', 'knee', '沿股骨轴', 'along the femur'),
    'shank': ('length', 'knee', 'ankle', '沿胫骨轴', 'along the tibia'),
    'ankleHeight': ('length', 'ankle', None, '足的竖向尺寸：踝关节到地面（to 为空表示地面，不是关节）', 'vertical size of the foot: ankle joint to the floor (to = null means the floor, not a joint)'),
    'foot': ('length', 'ankle', 'mtp2', '足的前后尺寸：整只足沿足跟–趾尖方向缩放（长度量的是足跟到最长趾尖）', 'antero-posterior size of the foot: the whole foot scales along the heel-toe axis (the length is heel to longest toe)'),
    'upperArm': ('length', 'gh', 'elbow', '沿肱骨轴', 'along the humerus'),
    'forearm': ('length', 'elbow', 'wrist', '沿桡尺骨轴', 'along radius and ulna'),
    'hand': ('length', 'wrist', 'mcp3', '手的整体尺寸：整只手等比缩放（长度量的是腕横纹到中指尖）', 'overall size of the hand: the whole hand scales uniformly (the length is wrist crease to middle fingertip)'),
    'shoulderWidth': ('breadth', 'gh_R', 'gh_L', '左右盂肱关节间距：缩放胸锁关节到盂肱关节的横向偏移', 'between the glenohumeral joints: scales the lateral offset sternoclavicular -> glenohumeral'),
    'pelvisWidth': ('breadth', 'hip_R', 'hip_L', '左右髋关节间距：骨盆横向缩放', 'between the hip joints: transverse scale of the pelvis'),
}
# 默认参考人群（协调者已确认）：中国 20–24 岁均值（2020 年国民体质监测）；比例修正来自 GB/T 10000-1988 P50 与模型的对比
# default reference population (confirmed): Chinese 20-24 means (2020 fitness surveillance); proportion
# corrections from the comparison of GB/T 10000-1988 P50 with the model
DEFAULT = {'F': {'stature': 1.606, 'bmi': 21.6}, 'M': {'stature': 1.726, 'bmi': 23.6}}
CN_LEG = -1.0          # 腿长因子：中国人坐高比模型高 +1.0 至 +1.1 个标准差 / sitting height +1.0 to +1.1 SD
CN_FOREARM = 0.93      # 前臂：比模型短 17–18 mm（约 7 %）/ forearm 17-18 mm (about 7 %) shorter


def power_fit(model, sex, comb):
    """把肢段长度拟合成 ln L = a + b ln(S/S0) + l1 f1 + l2 f2（BMI 固定为 22）。
    Fit a segment length as ln L = a + b ln(S/S0) + l1 f1 + l2 f2 (BMI fixed at 22)."""
    rows, y = [], []
    for S in np.linspace(1450, 1950, 11):
        for f1 in (-2, -1, 0, 1, 2):
            for f2 in (-2, 0, 2):
                rows.append([1, np.log(S / S0), f1, f2])
                y.append(np.log(seg_len(model, sex, comb, S, 22.0, (f1, f2))))
    c, *_ = np.linalg.lstsq(np.array(rows), np.array(y), rcond=None)
    err = np.exp(np.abs(np.array(rows) @ c - np.array(y)).max()) - 1
    return c, err


def rig_shape(model, meas):
    out = {
        'schema': 1,
        'description': {
            'zh': '建议的 Rig.shape 数据（运行时读取）。控制量 -> 各肢段缩放、围度目标、皮下脂肪厚度、皮肤位移场。缩放都取“相对静止值的比”。',
            'en': 'Proposed Rig.shape data (read by the runtime). Controls -> segment scales, girth targets, subcutaneous-fat thickness, skin displacement fields. All scales are ratios to the rest values.'},
        'formulas': {
            'segmentScale': 'scale = (stature / rest.stature) ^ bStature * exp(legLength * (legLength - rest.legLength) + centralBuild * (centralBuild - rest.centralBuild))',
            'girthMm': 'exp(a + bStature * ln(statureMm / 1650) + cBmi * ln(bmi / 22) + legLength * legLength + centralBuild * centralBuild)',
            'fatThicknessMm': 'max(min, a + b * bmi)',
            'skin': 'position += m(bmi) * fatField, clamped per vertex to shape-limit; m from fields.bmiToFieldUnits',
            'fatPart': 'position += followsSkin * (skin displacement at the nearest skin point); followsSkin = dEnvelope / (dEnvelope + dSkin)',
            'muscleRadiusMm': 'girthMm / (2 * pi) - fatThicknessMm - 2 (skin); muscle cross-section scale = radius(controls) / radius(rest)',
        },
        'sexes': {},
    }
    for sex, body in (('F', 'female'), ('M', 'male')):
        d = DEFAULT[sex]
        rest = {'stature': d['stature'], 'bmi': d['bmi'], 'legLength': CN_LEG, 'centralBuild': 0.0}
        segs = []
        for sid, zh, en, comb in SEGMENTS:
            c, err = power_fit(model, sex, comb)
            kind, a, b, hz, he = SEGMENT_JOINTS[sid]
            std = float(np.exp(c[0] + c[1] * np.log(rest['stature'] * 1000 / S0) + c[2] * rest['legLength']))
            if sid == 'forearm':
                std *= CN_FOREARM
            segs.append({'id': sid, 'name': {'zh': zh, 'en': en}, 'kind': kind, 'from': a, 'to': b, 'apply': {'zh': hz, 'en': he},
                         'bStature': round(float(c[1]), 4), 'legLength': round(float(c[2]), 5), 'centralBuild': round(float(c[3]), 5),
                         'fitErrorMax': round(float(err), 4), 'standardLengthMm': round(std, 1)})
        girths = []
        for gid, zh, en, ds, var in GIRTHS:
            m = model['nhanes']['sexes'][sex]['outputs'][var] if ds == 'nhanes' else model['sexes'][sex]['outputs'][var]
            fl = m.get('factorLoadings', [0, 0])
            girths.append({'id': gid, 'name': {'zh': zh, 'en': en}, 'dataset': ds, 'a': m['a'], 'bStature': m['bStature'], 'cBmi': m['cBmi'],
                           'legLength': fl[0], 'centralBuild': fl[1],
                           'standardMm': round(girth(model, sex, ds, var, rest['stature'] * 1000, rest['bmi'], (rest['legLength'], 0)), 1)})
        fat = [{'id': f[0], 'name': {'zh': f[1], 'en': f[2]}, 'a': (f[3] if sex == 'F' else f[4])[0], 'b': (f[3] if sex == 'F' else f[4])[1], 'min': f[5],
                'standardMm': round(max(f[5], (f[3] if sex == 'F' else f[4])[0] + (f[3] if sex == 'F' else f[4])[1] * rest['bmi']), 1), 'quality': f[7]} for f in FAT]
        # asBuilt 预设：女性取管线报告里供体的测量值（standard.donorMm，标准化之前的她）；男性取现在这具模型的测量值。
        # 女性没有手长、足长的供体值（手足是形变的男性结构），这两项不给。
        # asBuilt preset: for the female, the donor's measures from the pipeline report (standard.donorMm, i.e. before
        # standardisation); for the male, the body as now built. The donor has no hand or foot length (hers are warped male parts).
        sk = dict(meas[body]['skeletal'])
        basis = 'tools/bodyshape/measure.py on public/anatomy/male as now built'
        rp = os.path.join('public/anatomy', body, 'pipeline-report.json')
        if sex == 'F' and os.path.exists(rp):
            donor = json.load(open(rp)).get('standard', {}).get('donorMm')
            if donor:
                sk = {k: float(v) for k, v in donor.items()}
                basis = 'public/anatomy/female/pipeline-report.json standard.donorMm (the donor before standardisation)'
        own = {'headNeck': sk['stature'] - sk['cervicaleheight'], 'trunk': sk['cervicaleheight'] - sk['trochanterionheight'],
               'thigh': sk['trochanterionheight'] - sk['lateralfemoralepicondyleheight'],
               'shank': sk['lateralfemoralepicondyleheight'] - sk['lateralmalleolusheight'], 'ankleHeight': sk['lateralmalleolusheight'],
               'upperArm': sk['acromionradialelength'], 'forearm': sk['radialestylionlength'], 'hand': sk.get('handlength', np.nan),
               'shoulderWidth': sk['biacromialbreadth'], 'pelvisWidth': sk['bicristalbreadth']}
        # 比值在“原骨架自己的身高”下求：asBuilt 预设把身高设为原身高，再乘这些比值
        # ratios are taken at the as-built stature: the asBuilt preset sets that stature and applies them on top
        at_own = {s_['id']: s_['standardLengthMm'] * (sk['stature'] / (rest['stature'] * 1000)) ** s_['bStature'] for s_ in segs}
        as_built = {s_['id']: round(own[s_['id']] / at_own[s_['id']], 3) for s_ in segs if s_['id'] in own and not np.isnan(own[s_['id']])}
        fields = None
        fp = os.path.join(RAW, 'out', f'{body}-skin', 'shape-fields.json')
        if os.path.exists(fp):
            sf = json.load(open(fp))
            fields = {'topology': 'MHR LOD0', 'vertices': sf['vertices'], 'fat': 'shape-fat.f32', 'sex': 'shape-sex.f32', 'limit': 'shape-limit.f32', 'central': 'shape-central.f32',
                      'fittedAtBmi': sf['restBmi'], 'bmiToFieldUnits': sf['bmiToFieldUnits']['table'],
                      'mhrDirectionPerBmiPoint': sf['fatFieldDirectionPerBmiPoint']['mhrIdentityCoefficients1to6']}
        out['sexes'][sex] = {
            'controls': [
                {'id': 'stature', 'name': {'zh': '身高', 'en': 'Stature'}, 'unit': 'm', 'min': 1.40, 'max': 2.00, 'rest': rest['stature']},
                {'id': 'bmi', 'name': {'zh': '体重指数（胖瘦）', 'en': 'Body-mass index (fatness)'}, 'unit': 'kg/m2', 'min': 16, 'max': 40, 'rest': rest['bmi']},
                {'id': 'legLength', 'name': {'zh': '腿长比例', 'en': 'Relative leg length'}, 'unit': 'sd', 'min': -3, 'max': 2, 'rest': rest['legLength']},
                {'id': 'centralBuild', 'name': {'zh': '体型分布（腰腹型–四肢型）', 'en': 'Mass distribution (waist-heavy vs limb-heavy)'}, 'unit': 'sd', 'min': -2, 'max': 2, 'rest': 0.0}],
            'restBasis': {'zh': '静止值 = 标准体：中国 20–24 岁均值的身高和 BMI；腿长因子 −1 和前臂 ×0.93 是对 ANSUR 比例的修正（依据 GB/T 10000-1988 P50 与模型的对比）；'
                                '其余比例和围度函数来自 ANSUR II / NHANES（美国数据），不是中国实测。',
                          'en': 'rest = the standard body: stature and BMI are the Chinese 20-24 means; leg-length factor -1 and forearm x0.93 are corrections to ANSUR proportions '
                                '(from GB/T 10000-1988 P50 against the model); all other proportion and girth functions come from ANSUR II / NHANES (US data), not Chinese measurements.'},
            'segments': segs, 'girths': girths, 'fat': fat, 'fields': fields,
            'presets': [
                {'id': 'standard', 'name': {'zh': '标准体（默认）', 'en': 'Standard (default)'}, 'values': rest, 'segmentFactors': {}},
                {'id': 'asBuilt', 'name': {'zh': '原始模型比例（供体/BodyParts3D）', 'en': 'As-built proportions (donor / BodyParts3D)'},
                 'values': {**rest, 'stature': round(sk['stature'] / 1000, 3)}, 'segmentFactors': as_built, 'basis': basis,
                 'note': {'zh': 'segmentFactors = 原骨架肢段长度 / 同身高标准长度；标准化时管线先烘焙它的倒数，再按身高缩放到默认身高。肩宽一项是按骨性肩峰点量的（见 REPORT 第 10 节）',
                          'en': 'segmentFactors = as-built segment length / standard length at the same stature; standardisation bakes the inverse, then scales to the default stature. Shoulder width here is from the bony acromion (REPORT section 10)'}},
                {'id': 'ansur', 'name': {'zh': 'ANSUR II 比例（美国军人）', 'en': 'ANSUR II proportions (US Army)'},
                 'values': {**rest, 'legLength': 0.0}, 'segmentFactors': {'forearm': round(1 / CN_FOREARM, 3)}}],
        }
    json.dump(out, open(os.path.join(CUR, 'rig-shape.json'), 'w'), ensure_ascii=False, indent=1)
    return out


if __name__ == '__main__':
    main()
