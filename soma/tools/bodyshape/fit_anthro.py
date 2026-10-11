"""拟合精简的人体测量模型：（身高、BMI、体型因子）-> 各项人体尺寸。
Fit the compact anthropometric model: (stature, BMI, build factors) -> body measurements.

    python -I tools/bodyshape/fit_anthro.py        (from the soma project root, in the tools venv)

Inputs  data/raw/bodyshape/ansur2/*.csv, data/raw/bodyshape/nhanes/*.xpt  (download.sh)
Outputs data/curated/bodyshape/anthro-model.json   the model + fit quality + presets
        data/raw/bodyshape/out/anthro-fit-report.txt  the tables quoted in REPORT.md

Model, per sex and per output k (all lengths in mm, BMI in kg/m2):

    ln y_k = a_k + b_k ln(S / S0) + c_k ln(B / B0) + sum_j L_kj f_j + e_k

S 身高，B 体重指数，f_j 体型因子（单位方差，在拟合样本中与 S、B 不相关），e_k 其余个体差异（对数单位的标准差 sd_k）。
S stature, B body-mass index, f_j the build factors (unit variance, uncorrelated with S and B
in the fitting sample), e_k the remaining individual variation (sd_k, log units).
"""
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

RAW = 'data/raw/bodyshape'
OUT = 'data/curated/bodyshape/anthro-model.json'
REP = os.path.join(RAW, 'out', 'anthro-fit-report.txt')
S0, B0 = 1650.0, 22.0
N_FACTORS = 2

# 作为输出保留的 ANSUR II 变量。group：L 长度/高度，B 宽/厚，G 围度
# ANSUR II variables kept as outputs.  group: L length/height, B breadth/depth, G girth.
OUTPUTS = [
    # name, group, zh, en, how it is taken (short)
    ('cervicaleheight', 'L', '颈椎点高', 'Cervicale (C7) height', 'floor to C7 spinous tip, standing'),
    ('acromialheight', 'L', '肩峰高', 'Acromial height', 'floor to acromion, standing'),
    ('suprasternaleheight', 'L', '胸骨上点高', 'Suprasternale height', 'floor to jugular notch'),
    ('axillaheight', 'L', '腋窝高', 'Axilla height', 'floor to anterior axillary fold'),
    ('chestheight', 'L', '乳头点高', 'Chest (bust point) height', 'floor to nipple / bust point'),
    ('tenthribheight', 'L', '第十肋高', 'Tenth rib height', 'floor to lowest point of rib 10'),
    ('waistheightomphalion', 'L', '脐高', 'Waist (navel) height', 'floor to navel'),
    ('iliocristaleheight', 'L', '髂嵴点高', 'Iliocristale height', 'floor to top of iliac crest'),
    ('buttockheight', 'L', '臀突点高', 'Buttock height', 'floor to most posterior point of buttock'),
    ('trochanterionheight', 'L', '大转子点高', 'Trochanterion height', 'floor to tip of greater trochanter'),
    ('crotchheight', 'L', '会阴高', 'Crotch height', 'floor to crotch'),
    ('tibialheight', 'L', '胫骨点高', 'Tibiale height', 'floor to medial tibial plateau edge'),
    ('lateralfemoralepicondyleheight', 'L', '股骨外上髁高', 'Lateral femoral epicondyle height', 'floor to lateral femoral epicondyle'),
    ('kneeheightmidpatella', 'L', '髌骨中点高', 'Mid-patella height', 'floor to centre of patella'),
    ('lateralmalleolusheight', 'L', '外踝高', 'Lateral malleolus height', 'floor to lateral malleolus'),
    ('sittingheight', 'L', '坐高', 'Sitting height', 'seat to vertex, sitting erect'),
    ('acromionradialelength', 'L', '上臂长（肩峰–桡骨点）', 'Acromion-radiale length', 'acromion to radiale'),
    ('radialestylionlength', 'L', '前臂长（桡骨点–茎突点）', 'Radiale-stylion length', 'radiale to radial styloid tip'),
    ('shoulderelbowlength', 'L', '肩肘长', 'Shoulder-elbow length', 'acromion to olecranon, elbow at 90 deg'),
    ('handlength', 'L', '手长', 'Hand length', 'wrist crease to tip of middle finger'),
    ('footlength', 'L', '足长', 'Foot length', 'heel to longest toe'),
    ('span', 'L', '两臂展开宽', 'Arm span', 'fingertip to fingertip, arms horizontal'),
    ('wristheight', 'L', '腕高（茎突点高）', 'Wrist (stylion) height', 'floor to stylion, arm hanging'),
    ('biacromialbreadth', 'B', '肩宽（肩峰间距）', 'Biacromial breadth', 'between acromia'),
    ('bideltoidbreadth', 'B', '最大肩宽', 'Bideltoid breadth', 'across deltoids, arms at sides'),
    ('chestbreadth', 'B', '胸宽', 'Chest breadth', 'at nipple level'),
    ('chestdepth', 'B', '胸厚', 'Chest depth', 'at nipple level'),
    ('waistbreadth', 'B', '腰宽', 'Waist breadth', 'at navel level'),
    ('waistdepth', 'B', '腰厚', 'Waist depth', 'at navel level'),
    ('bicristalbreadth', 'B', '髂嵴间宽', 'Bicristal breadth', 'between iliac crests, compressed to bone'),
    ('hipbreadth', 'B', '臀宽', 'Hip breadth', 'widest point of hips, standing'),
    ('buttockdepth', 'B', '臀厚', 'Buttock depth', 'at buttock level'),
    ('footbreadthhorizontal', 'B', '足宽', 'Foot breadth', 'across metatarsal heads'),
    ('handbreadth', 'B', '手宽', 'Hand breadth', 'across metacarpal heads'),
    ('headbreadth', 'B', '头宽', 'Head breadth', 'maximum, above ears'),
    ('headlength', 'B', '头长', 'Head length', 'glabella to opisthocranion'),
    ('headcircumference', 'G', '头围', 'Head circumference', 'above brow ridges'),
    ('neckcircumference', 'G', '颈围', 'Neck circumference', 'at infrathyroid level, perpendicular to neck'),
    ('neckcircumferencebase', 'G', '颈根围', 'Neck-base circumference', 'around base of neck'),
    ('shouldercircumference', 'G', '肩围', 'Shoulder circumference', 'around deltoids, horizontal'),
    ('chestcircumference', 'G', '胸围', 'Chest circumference', 'horizontal at nipple / bust point'),
    ('waistcircumference', 'G', '腰围（脐水平）', 'Waist circumference (navel level)', 'horizontal at navel'),
    ('buttockcircumference', 'G', '臀围', 'Buttock (hip) circumference', 'horizontal at most posterior point of buttock'),
    ('thighcircumference', 'G', '大腿围（臀沟下）', 'Thigh circumference (proximal)', 'just below gluteal furrow, perpendicular to thigh'),
    ('lowerthighcircumference', 'G', '大腿下围', 'Lower thigh circumference', 'just above patella'),
    ('calfcircumference', 'G', '小腿围', 'Calf circumference', 'maximum, horizontal'),
    ('anklecircumference', 'G', '踝围', 'Ankle circumference', 'minimum, above malleoli'),
    ('bicepscircumferenceflexed', 'G', '上臂围（屈肘）', 'Biceps circumference, flexed', 'elbow at 90 deg, fist clenched'),
    ('forearmcircumferenceflexed', 'G', '前臂围（屈肘）', 'Forearm circumference, flexed', 'maximum, elbow at 90 deg, fist clenched'),
    ('wristcircumference', 'G', '腕围', 'Wrist circumference', 'at stylion'),
]
# 测量定义的中文（与 OUTPUTS 第 5 列一一对应）/ Chinese wording of the definitions in OUTPUTS
DEF_ZH = {
    'cervicaleheight': '站立，地面至第七颈椎棘突尖', 'acromialheight': '站立，地面至肩峰点', 'suprasternaleheight': '地面至胸骨上切迹',
    'axillaheight': '地面至腋前襞', 'chestheight': '地面至乳头点', 'tenthribheight': '地面至第十肋最低点', 'waistheightomphalion': '地面至脐',
    'iliocristaleheight': '地面至髂嵴最高点', 'buttockheight': '地面至臀部最后突点', 'trochanterionheight': '地面至大转子尖',
    'crotchheight': '地面至会阴', 'tibialheight': '地面至胫骨内侧髁上缘', 'lateralfemoralepicondyleheight': '地面至股骨外上髁',
    'kneeheightmidpatella': '地面至髌骨中心', 'lateralmalleolusheight': '地面至外踝', 'sittingheight': '挺直坐姿，座面至头顶',
    'acromionradialelength': '肩峰点至桡骨点', 'radialestylionlength': '桡骨点至桡骨茎突尖', 'shoulderelbowlength': '屈肘 90 度，肩峰至鹰嘴',
    'handlength': '腕横纹至中指尖', 'footlength': '足跟至最长趾尖', 'span': '两臂平伸，指尖至指尖', 'wristheight': '上肢下垂，地面至桡骨茎突',
    'biacromialbreadth': '两肩峰点间距', 'bideltoidbreadth': '上肢下垂，两侧三角肌最外点间距', 'chestbreadth': '乳头水平的胸宽',
    'chestdepth': '乳头水平的胸厚', 'waistbreadth': '脐水平的腰宽', 'waistdepth': '脐水平的腰厚', 'bicristalbreadth': '两髂嵴间距（压至骨面）',
    'hipbreadth': '站立，臀部最宽处', 'buttockdepth': '臀突水平的厚度', 'footbreadthhorizontal': '跖骨头处足宽', 'handbreadth': '掌骨头处手宽',
    'headbreadth': '耳上方头最大宽', 'headlength': '眉间点至枕后点', 'headcircumference': '经眉弓上方的头围',
    'neckcircumference': '甲状软骨下方、垂直于颈轴的围度', 'neckcircumferencebase': '颈根部围度', 'shouldercircumference': '经三角肌的水平围度',
    'chestcircumference': '乳头点水平的水平围度', 'waistcircumference': '脐水平的水平围度', 'buttockcircumference': '臀部最后突点水平的水平围度',
    'thighcircumference': '臀沟下方、垂直于大腿轴的围度', 'lowerthighcircumference': '髌骨上缘处围度', 'calfcircumference': '小腿最大水平围度',
    'anklecircumference': '踝上最小围度', 'bicepscircumferenceflexed': '屈肘 90 度握拳时的上臂围', 'forearmcircumferenceflexed': '屈肘 90 度握拳时的前臂最大围',
    'wristcircumference': '桡骨茎突处腕围',
}
NAMES = [o[0] for o in OUTPUTS]
GROUP = {o[0]: o[1] for o in OUTPUTS}

# 用其残差定义体型因子的测量项（骨架 + 软组织分布）
# Measures whose residuals define the build factors (frame + soft-tissue distribution).
FACTOR_SET = [n for n in NAMES if n not in ('headbreadth', 'headlength', 'headcircumference', 'span', 'wristheight',
                                            'shoulderelbowlength', 'footbreadthhorizontal', 'handbreadth')]


NHANES_DEF_ZH = {'waist': '水平，紧贴右髂嵴最上外侧缘上方', 'hip': '臀部最大后突处的水平围度', 'thigh': '腹股沟皱襞与髌骨上缘连线中点处', 'calf': '最大围度', 'armcirc': '肩峰与鹰嘴连线中点，上肢下垂', 'armlen': '屈肘 90 度，肩峰至鹰嘴', 'upperleglen': '坐姿，腹股沟皱襞至髌骨上缘', 'sad': '仰卧，髂嵴水平'}


def load_ansur():
    out = {}
    for sex, f in (('F', 'FEMALE'), ('M', 'MALE')):
        d = pd.read_csv(f'{RAW}/ansur2/ANSUR_II_{f}_Public.csv', encoding='latin-1')
        d.columns = [c.lower() for c in d.columns]
        d['weight'] = d['weightkg'] / 10.0  # stored in 0.1 kg
        d['bmi'] = d['weight'] / (d['stature'] / 1000.0) ** 2
        out[sex] = d
    return out


def load_nhanes():
    rows = []
    for bf in sorted(glob.glob(f'{RAW}/nhanes/*BMX*.xpt')):
        df_ = bf.replace('BMX', 'DEMO')
        b = pd.read_sas(bf, format='xport')
        d = pd.read_sas(df_, format='xport')
        m = b.merge(d, on='SEQN')
        cyc = os.path.basename(bf).replace('.xpt', '')
        w = 'WTMECPRP' if 'WTMECPRP' in m else 'WTMEC2YR'
        r = pd.DataFrame({
            'cycle': cyc, 'sex': np.where(m['RIAGENDR'] == 2, 'F', 'M'), 'age': m['RIDAGEYR'],
            'preg': m['RIDEXPRG'] if 'RIDEXPRG' in m else np.nan, 'wt': m[w],
            'weight': m['BMXWT'], 'stature': m['BMXHT'] * 10, 'bmi': m['BMXBMI'],
        })
        for src, dst in (('BMXWAIST', 'waist'), ('BMXHIP', 'hip'), ('BMXARMC', 'armcirc'), ('BMXARML', 'armlen'),
                         ('BMXLEG', 'upperleglen'), ('BMXTHICR', 'thigh'), ('BMXCALF', 'calf'),
                         ('BMXTRI', 'triceps_sf'), ('BMXSUB', 'subscap_sf'), ('BMDAVSAD', 'sad')):
            r[dst] = m[src] * (1 if dst.endswith('_sf') else 10) if src in m else np.nan
        if 'RIDRETH3' in m:
            r['asian'] = (m['RIDRETH3'] == 6)
        else:
            r['asian'] = False
        rows.append(r)
    n = pd.concat(rows, ignore_index=True)
    n = n[(n.age >= 20) & (n.preg != 1) & n.stature.notna() & n.bmi.notna()]
    # P_BMX（2017–2020.3）已包含 2017–18 周期（BMX_J）：去掉重复
    # P_BMX (2017-Mar 2020) contains the 2017-18 cycle (BMX_J): drop the duplicate.
    n = n[n.cycle != 'BMX_J']
    return n


def design(S, B):
    return np.column_stack([np.ones(len(S)), np.log(S / S0), np.log(B / B0)])


def wquant(x, w, q):
    o = np.argsort(x)
    x, w = np.asarray(x)[o], np.asarray(w)[o]
    c = (np.cumsum(w) - 0.5 * w) / w.sum()
    return float(np.interp(q, c, x))


def fit_sex(d, rng, lines):
    n = len(d)
    idx = rng.permutation(n)
    test, train = idx[: n // 5], idx[n // 5:]
    X = design(d['stature'].values, d['bmi'].values)
    Y = np.log(d[NAMES].values.astype(float))
    coef, *_ = np.linalg.lstsq(X[train], Y[train], rcond=None)
    res = Y - X @ coef
    sd = res[train].std(0)
    # 体型因子：对 FACTOR_SET 的标准化残差做主成分分析，再做方差最大旋转
    # build factors: PCA of standardised residuals over FACTOR_SET, varimax-rotated
    fi = [NAMES.index(k) for k in FACTOR_SET]
    Z = res[train][:, fi] / sd[fi]
    C = np.corrcoef(Z.T)
    w, v = np.linalg.eigh(C)
    o = np.argsort(w)[::-1]
    w, v = w[o], v[:, o]
    A = v[:, :N_FACTORS] * np.sqrt(w[:N_FACTORS])
    R = varimax(A)
    A = A @ R
    # 定向：f1 为正 = 腿长（会阴高增大），f2 为正 = 腰粗
    # orient: f1 positive = long legs (crotch height up), f2 positive = thicker waist
    for j, ref in ((0, 'crotchheight'), (1, 'waistcircumference')):
        if A[FACTOR_SET.index(ref), j] < 0:
            A[:, j] *= -1
    # 用回归法（Thurstone）求因子得分，再求全部输出对得分的载荷
    # scores by regression (Thurstone) on FACTOR_SET, then loadings of ALL outputs on the scores
    Wsc = np.linalg.solve(C, A)

    def scores(rows):
        return (res[rows][:, fi] / sd[fi]) @ Wsc

    Ftr = scores(train)
    fmean, fsd = Ftr.mean(0), Ftr.std(0)
    Ftr = (Ftr - fmean) / fsd
    L, *_ = np.linalg.lstsq(Ftr, res[train], rcond=None)  # (N_FACTORS, n_out), log units
    Fte = (scores(test) - fmean) / fsd
    out = {}
    lines.append(f'{"measure":34s} {"med":>6s} {"b_S":>6s} {"c_B":>6s} {"R2tr":>5s} {"R2te":>5s} {"sdmm":>5s} '
                 f'{"+f1":>5s} {"+f2":>5s} {"R2te+f":>6s} {"sd+f":>5s}  linR2te')
    Xlin = np.column_stack([np.ones(n), d['stature'].values, d['bmi'].values])
    for k, name in enumerate(NAMES):
        y = d[name].values.astype(float)
        pred0 = np.exp(X @ coef[:, k])
        pred1 = np.exp(X[test] @ coef[:, k] + Fte @ L[:, k])
        sst = ((y[test] - y[test].mean()) ** 2).sum()
        r2te = 1 - ((y[test] - pred0[test]) ** 2).sum() / sst
        r2tr = 1 - ((y[train] - pred0[train]) ** 2).sum() / ((y[train] - y[train].mean()) ** 2).sum()
        r2tef = 1 - ((y[test] - pred1) ** 2).sum() / sst
        sdmm = float((y[test] - pred0[test]).std())
        sdmmf = float((y[test] - pred1).std())
        cl, *_ = np.linalg.lstsq(Xlin[train], y[train], rcond=None)
        r2lin = 1 - ((y[test] - Xlin[test] @ cl) ** 2).sum() / sst
        med = float(np.median(y))
        out[name] = {
            'a': round(float(coef[0, k]), 5), 'bStature': round(float(coef[1, k]), 4), 'cBmi': round(float(coef[2, k]), 4),
            'factorLoadings': [round(float(x), 5) for x in L[:, k]],
            'residualSdLog': round(float((res[train][:, k] - Ftr @ L[:, k]).std()), 5),
            'fit': {'r2Train': round(float(r2tr), 3), 'r2Test': round(float(r2te), 3), 'residualSdMmTest': round(sdmm, 1),
                    'r2TestWithFactors': round(float(r2tef), 3), 'residualSdMmTestWithFactors': round(sdmmf, 1)},
            'sampleMedianMm': round(med, 1),
        }
        lines.append(f'{name:34s} {med:6.0f} {coef[1, k]:6.2f} {coef[2, k]:6.2f} {r2tr:5.2f} {r2te:5.2f} {sdmm:5.1f} '
                     f'{100 * L[0, k]:5.1f} {100 * L[1, k]:5.1f} {r2tef:6.2f} {sdmmf:5.1f}  {r2lin:5.2f}')
    expl = (w[:6] / w.sum()).round(3).tolist()
    lines.append(f'residual PCA eigen-share (first 6): {expl}')
    lines.append('rotated loadings on FACTOR_SET (correlation units):')
    for j in range(N_FACTORS):
        o = np.argsort(-np.abs(A[:, j]))[:12]
        lines.append(f'  f{j + 1}: ' + ', '.join(f'{FACTOR_SET[i]} {A[i, j]:+.2f}' for i in o))
    meta = {
        'n': int(n), 'nTrain': int(len(train)), 'nTest': int(len(test)),
        'statureMm': {q: round(float(np.percentile(d['stature'], p)), 0) for q, p in (('p5', 5), ('p50', 50), ('p95', 95))},
        'bmi': {q: round(float(np.percentile(d['bmi'], p)), 1) for q, p in (('p1', 1), ('p5', 5), ('p50', 50), ('p95', 95), ('p99', 99))},
        'ageMedian': float(d['age'].median()),
        'factorScoring': {
            'note': {'zh': '因子得分 score_j = ((z @ W)[j] - mean[j]) / sd[j]，z 为扣除身高、BMI 后各测量项的标准化残差',
                     'en': 'score_j = ((z @ W)[j] - mean[j]) / sd[j], z = residual_k / sd_k over `measures` after the stature+BMI fit'},
            'measures': FACTOR_SET, 'residualSdLog': [round(float(x), 5) for x in sd[fi]],
            'W': np.round(Wsc, 5).tolist(), 'mean': np.round(fmean, 5).tolist(), 'sd': np.round(fsd, 5).tolist(),
        },
        'residualPcaShare': expl,
    }
    return out, meta, coef, (sd, fi, Wsc, fmean, fsd, L)


def varimax(A, it=200):
    p, k = A.shape
    R = np.eye(k)
    for _ in range(it):
        B = A @ R
        u, s, vt = np.linalg.svd(A.T @ (B ** 3 - B @ np.diag((B ** 2).sum(0)) / p))
        R = u @ vt
    return R


def predict(model_sex, S, B, f=None):
    """给定身高 S（毫米）、BMI 和体型因子 f，各输出的中位预测值（毫米）。
    Median prediction (mm) of every output for stature S (mm), BMI B and build factors f."""
    out = {}
    for k, m in model_sex['outputs'].items():
        v = m['a'] + m['bStature'] * np.log(S / S0) + m['cBmi'] * np.log(B / B0)
        if f is not None:
            v = v + sum(l * x for l, x in zip(m['factorLoadings'], f))
        out[k] = float(np.exp(v))
    return out


def main():
    os.makedirs(os.path.dirname(REP), exist_ok=True)
    rng = np.random.default_rng(20261011)
    ansur = load_ansur()
    nh = load_nhanes()
    lines = []
    model = {
        'schema': 1,
        'description': {
            'zh': '精简人体测量模型：ln y = a + bStature*ln(S/S0) + cBmi*ln(B/B0) + sum_j factorLoadings[j]*f_j。y、S 单位毫米，B 为 kg/m2。'
                  '用 ANSUR II（美国陆军，2012）拟合；说明见 tools/bodyshape/REPORT.md。',
            'en': 'Compact anthropometric model: ln y = a + bStature*ln(S/S0) + cBmi*ln(B/B0) + sum_j factorLoadings[j]*f_j. '
                  'y and S in mm, B in kg/m2. Fitted to ANSUR II (US Army, 2012); see tools/bodyshape/REPORT.md.'},
        'S0': S0, 'B0': B0,
        'controls': [
            {'id': 'stature', 'name': {'zh': '身高', 'en': 'Stature'}, 'unit': 'mm'},
            {'id': 'bmi', 'name': {'zh': '体重指数（胖瘦）', 'en': 'Body-mass index (fatness)'}, 'unit': 'kg/m2'},
            {'id': 'legLength', 'name': {'zh': '腿长比例（腿长–躯干长）', 'en': 'Relative leg length (long legs vs long trunk)'}, 'unit': 'sd',
             'note': {'zh': '体型因子 f1：身高、BMI 不变时，+1 使会阴高增加约 2.5 %、坐高减少约 2 %',
                      'en': 'build factor f1: at fixed stature and BMI, +1 raises crotch height by about 2.5 % and lowers sitting height by about 2 %'}},
            {'id': 'centralBuild', 'name': {'zh': '体型分布（腰腹型–四肢/肩臂型）', 'en': 'Mass distribution (waist-heavy vs limb/shoulder-heavy)'}, 'unit': 'sd',
             'note': {'zh': '体型因子 f2：身高、BMI 不变时，+1 使腰围增加约 4 %，四肢围度减少 1–3 %（女性：大腿下部、小腿；男性：上臂、前臂、肩）。'
                            '可近似理解为同体重下“偏软”与“偏肌肉”的差别。',
                      'en': 'build factor f2: at fixed stature and BMI, +1 adds about 4 % to waist girth and takes 1-3 % off limb girths '
                            '(women: lower thigh, calf; men: upper arm, forearm, shoulders). A proxy for soft vs muscular build at equal weight.'}},
        ],
        'outputs': [{'id': o[0], 'group': {'L': 'length', 'B': 'breadth', 'G': 'girth'}[o[1]], 'name': {'zh': o[2], 'en': o[3]},
                     'definition': {'zh': DEF_ZH[o[0]], 'en': o[4]}} for o in OUTPUTS],
        'sexes': {},
    }
    fits = {}
    for sex in ('F', 'M'):
        lines.append(f'\n================ ANSUR II {sex}  n={len(ansur[sex])} ================')
        outs, meta, coef, extra = fit_sex(ansur[sex], rng, lines)
        model['sexes'][sex] = {'source': 'ANSUR II', **meta, 'outputs': outs}
        fits[sex] = (coef, extra)

    # ---- NHANES：对共有测量项的平民人群拟合，以及跨数据集检验
    # ---- NHANES: civilian fits for the overlapping measures, and cross-dataset validation
    lines.append('\n================ NHANES (adults 20+, not pregnant) ================')
    nmodel = {}
    pairs = [('waist', 'waistcircumference'), ('hip', 'buttockcircumference'), ('calf', 'calfcircumference'),
             ('thigh', 'thighcircumference'), ('armcirc', 'bicepscircumferenceflexed'), ('armlen', 'shoulderelbowlength')]
    for sex in ('F', 'M'):
        d = nh[nh.sex == sex]
        nmodel[sex] = {'n': int(len(d)), 'outputs': {}}
        lines.append(f'--- {sex}: n={len(d)}  cycles={sorted(d.cycle.unique())}')
        for v, zh, en, defi in (
                ('waist', '腰围（髂嵴上缘水平）', 'Waist circumference (NHANES: just above iliac crest)', 'horizontal, just above the uppermost lateral border of the right ilium'),
                ('hip', '臀围', 'Hip circumference', 'horizontal at maximum extension of the buttocks'),
                ('thigh', '大腿中部围', 'Mid-thigh circumference', 'midway between inguinal crease and proximal patella'),
                ('calf', '小腿围', 'Maximal calf circumference', 'maximum'),
                ('armcirc', '上臂围（放松）', 'Mid-upper-arm circumference, relaxed', 'midway between acromion and olecranon, arm hanging'),
                ('armlen', '上臂长', 'Upper arm length', 'acromion to olecranon, elbow at 90 deg'),
                ('upperleglen', '大腿长', 'Upper leg length', 'inguinal crease to proximal patella, seated'),
                ('sad', '腹部矢状径（仰卧）', 'Sagittal abdominal diameter, supine', 'at iliac crest level, supine')):
            dd = d[d[v].notna()]
            if len(dd) < 500:
                continue
            idx = rng.permutation(len(dd))
            te, tr = idx[: len(dd) // 5], idx[len(dd) // 5:]
            X = design(dd.stature.values, dd.bmi.values)
            y = dd[v].values
            c, *_ = np.linalg.lstsq(X[tr], np.log(y[tr]), rcond=None)
            p = np.exp(X @ c)
            r2 = 1 - ((y[te] - p[te]) ** 2).sum() / ((y[te] - y[te].mean()) ** 2).sum()
            sdm = float((y[te] - p[te]).std())
            # 年龄对残差的影响（每十年），仅供参考 / age effect on the residual (per decade), informative only
            ar = np.polyfit(dd.age.values[tr], (np.log(y) - X @ c)[tr], 1)[0] * 10
            nmodel[sex]['outputs'][v] = {
                'name': {'zh': zh, 'en': en}, 'definition': {'zh': NHANES_DEF_ZH[v], 'en': defi}, 'n': int(len(dd)),
                'a': round(float(c[0]), 5), 'bStature': round(float(c[1]), 4), 'cBmi': round(float(c[2]), 4),
                'residualSdLog': round(float((np.log(y[tr]) - X[tr] @ c).std()), 5),
                'fit': {'r2Test': round(float(r2), 3), 'residualSdMmTest': round(sdm, 1)},
                'agePerDecadeLog': round(float(ar), 4),
            }
            lines.append(f'  NHANES fit {v:12s} n={len(dd):6d} a={c[0]:.3f} b_S={c[1]:5.2f} c_B={c[2]:5.2f} R2te={r2:.2f} sd={sdm:5.1f}mm  age/decade={100 * ar:+.1f}%')
        lines.append('  cross-dataset: ANSUR-fitted model applied to NHANES people (same sex), by BMI class: bias mm (pred-meas), RMSE mm, R2')
        for v, a in pairs:
            dd = d[d[v].notna()]
            if len(dd) < 500:
                continue
            k = NAMES.index(a)
            p = np.exp(design(dd.stature.values, dd.bmi.values) @ fits[sex][0][:, k])
            y = dd[v].values
            s = f'    {v:8s} <- {a:26s}'
            for lo, hi in ((0, 18.5), (18.5, 25), (25, 30), (30, 35), (35, 99)):
                m = (dd.bmi.values >= lo) & (dd.bmi.values < hi)
                if m.sum() > 30:
                    s += f' | {lo}-{hi}: {np.mean(p[m] - y[m]):+6.0f} / {np.sqrt(np.mean((p[m] - y[m]) ** 2)):4.0f}'
            r2 = 1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum()
            s += f' | all R2={r2:.2f} n={len(dd)}'
            lines.append(s)
        # 与 ANSUR 相近的人群范围（20–45 岁，BMI 在 ANSUR 的 1–99 百分位内）
        # same people range as ANSUR (age 20-45, BMI inside ANSUR's 1-99 % range)
        lo, hi = model['sexes'][sex]['bmi']['p1'], model['sexes'][sex]['bmi']['p99']
        for v, a in pairs:
            dd = d[d[v].notna() & (d.age <= 45) & (d.bmi >= lo) & (d.bmi <= hi)]
            if len(dd) < 300:
                continue
            k = NAMES.index(a)
            p = np.exp(design(dd.stature.values, dd.bmi.values) @ fits[sex][0][:, k])
            lines.append(f'    age<=45 & BMI {lo}-{hi}: {v:8s} bias {np.mean(p - dd[v].values):+6.1f} mm  rmse {np.sqrt(np.mean((p - dd[v].values) ** 2)):5.1f} mm  n={len(dd)}')
    model['nhanes'] = {
        'description': {
            'zh': '同一函数形式，用 NHANES 1999–2023 成人（20 岁以上、未孕）对 NHANES 有的测量项拟合。平民人群、BMI 范围完整；'
                  '超出 ANSUR 的 BMI 范围时围度用这一组。部分定义与 ANSUR 不同（见各项）。',
            'en': 'Same functional form fitted to NHANES 1999-2023 adults (20+, not pregnant) for the measures NHANES takes. '
                  'Civilian, full BMI range; use these for girths outside the ANSUR BMI range. Definitions differ from ANSUR where noted.'},
        'sexes': nmodel,
    }

    # ---- 人群预设 / presets
    presets = []
    for sex in ('F', 'M'):
        d = ansur[sex]
        presets.append({'id': f'ansur2-{sex}', 'sex': sex, 'name': {'zh': f'ANSUR II 美国陆军{"女" if sex == "F" else "男"}性中位数', 'en': f'ANSUR II US Army {"female" if sex == "F" else "male"} median'},
                        'statureMm': float(d.stature.median()), 'bmi': round(float(d.bmi.median()), 1), 'weightKg': round(float(d.weight.median()), 1),
                        'source': 'ANSUR II public release (2012), computed here', 'n': int(len(d))})
        recent = nh[(nh.sex == sex) & nh.cycle.isin(['P_BMX', 'BMX_L'])]
        for lab, sub, zh in (('20-39', recent[(recent.age < 40)], '20–39 岁'), ('20+', recent, '20 岁以上')):
            presets.append({'id': f'nhanes-{sex}-{lab}', 'sex': sex,
                            'name': {'zh': f'NHANES 美国{"女" if sex == "F" else "男"}性 {zh} 中位数（2017–2023）', 'en': f'NHANES US {"female" if sex == "F" else "male"} {lab} median (2017-2023)'},
                            'statureMm': round(wquant(sub.stature, sub.wt, .5), 0), 'bmi': round(wquant(sub.bmi, sub.wt, .5), 1),
                            'weightKg': round(wquant(sub.weight, sub.wt, .5), 1),
                            'waistMm': round(wquant(sub.waist.dropna(), sub.wt[sub.waist.notna()], .5), 0),
                            'hipMm': round(wquant(sub.hip.dropna(), sub.wt[sub.hip.notna()], .5), 0),
                            'source': 'NHANES 2017-Mar 2020 + Aug 2021-Aug 2023, MEC-weighted, computed here', 'n': int(len(sub))})
        asn = recent[recent.asian & (recent.age < 40)]
        presets.append({'id': f'nhanes-asian-{sex}-20-39', 'sex': sex,
                        'name': {'zh': f'NHANES 美国亚裔{"女" if sex == "F" else "男"}性 20–39 岁中位数', 'en': f'NHANES US non-Hispanic Asian {"female" if sex == "F" else "male"} 20-39 median'},
                        'statureMm': round(wquant(asn.stature, asn.wt, .5), 0), 'bmi': round(wquant(asn.bmi, asn.wt, .5), 1),
                        'weightKg': round(wquant(asn.weight, asn.wt, .5), 1),
                        'source': 'NHANES 2017-2023, RIDRETH3 = 6, MEC-weighted, computed here', 'n': int(len(asn))})
    # ---- 中国参考人群：预设 + 用中国数据对模型做跨人群检验
    # ---- Chinese reference populations: presets + a cross-population check of the model
    cn_path = 'data/curated/bodyshape/refpop-china.json'
    if os.path.exists(cn_path):
        cn = json.load(open(cn_path))
        mean = {(m['sex'], m['ageGroup'], m['measure_en']): m['mean'] for m in cn['means'] if m['sourceId'] == 'cn-fitness-2020'}
        p50 = {(q['sex'], q['measure_en']): q.get('P50') for q in cn['percentiles'] if q['sourceId'] == 'gbt10000-1988-reprint-sun'}
        lines.append('\n================ China cross-check (model prediction at the Chinese stature and BMI vs the Chinese value)')
        for sex in ('F', 'M'):
            zh = '女' if sex == 'F' else '男'
            en = 'female' if sex == 'F' else 'male'
            for ag in ('20-24', '25-29'):
                h, w = mean[(sex, ag, 'stature')] * 10, mean[(sex, ag, 'body mass')]
                b = w / (h / 1000) ** 2
                presets.append({'id': f'cn-fitness2020-{sex}-{ag}', 'sex': sex,
                                'name': {'zh': f'中国{zh}性 {ag} 岁均值（第五次国民体质监测，2020）', 'en': f'China {en} {ag} mean (5th National Physical Fitness Surveillance, 2020)'},
                                'statureMm': h, 'bmi': round(b, 1), 'weightKg': w, 'waistMm': mean[(sex, ag, 'waist circumference')] * 10,
                                'hipMm': mean[(sex, ag, 'hip circumference')] * 10,
                                'source': 'refpop-china.json: cn-fitness-2020 (means, not medians; BMI here = mean weight / mean stature^2)'})
                nm = nmodel[sex]['outputs']
                for v, key in (('waist', 'waist circumference'), ('hip', 'hip circumference')):
                    pr = float(np.exp(design(np.array([h]), np.array([b])) @ np.array([nm[v]['a'], nm[v]['bStature'], nm[v]['cBmi']]))[0])
                    lines.append(f'  CN 2020 {sex} {ag}: S={h:.0f} BMI={b:.1f}  {v:5s} measured {mean[(sex, ag, key)] * 10:.0f}  NHANES-fit {pr:.0f}  ({pr - mean[(sex, ag, key)] * 10:+.0f} mm)')
            h, w = p50[(sex, 'stature')], p50[(sex, 'body mass')]
            b = w / (h / 1000) ** 2
            presets.append({'id': f'cn-gbt10000-1988-{sex}', 'sex': sex,
                            'name': {'zh': f'中国成年{zh}性 P50（GB/T 10000-1988，1986–87 年调查）', 'en': f'Chinese adult {en} P50 (GB/T 10000-1988, 1986-87 survey)'},
                            'statureMm': h, 'bmi': round(b, 1), 'weightKg': w,
                            'source': 'refpop-china.json: gbt10000-1988-reprint-sun (secondary reprint; superseded by GB/T 10000-2023, whose tables we could not obtain)'})
            ms = model['sexes'][sex]['outputs']
            for cnm, av in (('shoulder (acromion) height', 'acromialheight'), ('crotch height', 'crotchheight'), ('tibial height', 'tibialheight'),
                            ('sitting height', 'sittingheight'), ('biacromial breadth', 'biacromialbreadth'), ('bideltoid breadth', 'bideltoidbreadth'),
                            ('hip breadth, standing', 'hipbreadth'), ('chest breadth', 'chestbreadth'), ('chest depth', 'chestdepth'),
                            ('chest circumference', 'chestcircumference'), ('waist circumference', 'waistcircumference'),
                            ('hip circumference', 'buttockcircumference'), ('upper arm length', 'acromionradialelength'),
                            ('forearm length', 'radialestylionlength')):
                if p50.get((sex, cnm)):
                    m = ms[av]
                    pr = float(np.exp(m['a'] + m['bStature'] * np.log(h / S0) + m['cBmi'] * np.log(b / B0)))
                    sd = np.sqrt(m['residualSdLog'] ** 2 + sum(l * l for l in m['factorLoadings']))
                    lines.append(f'  GB/T 10000-1988 {sex} P50 (S={h:.0f}, BMI={b:.1f}): {cnm:28s} CN {p50[(sex, cnm)]:6.0f}  ANSUR-fit {pr:6.0f}  ({pr - p50[(sex, cnm)]:+5.0f} mm, {np.log(p50[(sex, cnm)] / pr) / sd:+.1f} sd)')
    model['presets'] = presets
    lines.append('\npresets: ' + json.dumps(presets, ensure_ascii=False, indent=1))
    json.dump(model, open(OUT, 'w'), ensure_ascii=False, indent=1)
    open(REP, 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
