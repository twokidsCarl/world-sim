"""皮肤颜色的光谱模型：拟合 NIST 前臂反射光谱，生成"黑色素 × 血量 → 漫反射底色"的查找表和各部位的倍数。
The spectral skin colour model: fitted to the NIST forearm reflectance spectra, it yields the lookup
table "melanin × blood → diffuse albedo" and the per-region multipliers.

    data/raw/bodyshape/.venv/bin/python -I tools/look/skin_colour.py
    -> data/curated/look/skin-colour.json            拟合的参数、出处、误差、部位倍数 / fitted parameters, provenance, errors, region multipliers
    -> public/anatomy/<body>/look/skin-lut.bin       64×64 RGBA half-float，线性 sRGB 漫反射底色 / linear-sRGB diffuse albedo
    之后运行 tools/look/skin_regions.py 烘焙部位贴图 / then run tools/look/skin_regions.py to bake the region maps

输入（都不入库，放在 data/raw/skin/；下载地址见 README 的出处表）/ inputs (none in git; under data/raw/skin/;
where to get them is in the sources table of the README):
    nist/skinrefl-v3.csv          NIST 人体皮肤反射参考数据（Cooksey 等 2017，doi:10.18434/M38597）：100 人右前臂内侧，
                                  8°/半球反射因子，250–2500 nm / NIST reference data set of human skin reflectance (Cooksey
                                  et al. 2017): 100 subjects' inner right forearm, 8°/hemispherical reflectance factor
    omlc/hemoglobin.txt           血红蛋白摩尔消光系数（Prahl 汇编，OMLC；没有写明许可，只在本地用，只提交算出来的数）/
                                  haemoglobin molar extinction (Prahl's compilation, OMLC; no stated licence: used locally,
                                  only numbers computed from it are committed)
    omlc/carotene.txt             β-胡萝卜素吸收谱（PhotochemCAD，经 OMLC；同上）/ β-carotene absorption (PhotochemCAD via OMLC; likewise)
    cie/CIE_xyz_1931_2deg.csv     CIE 1931 2° 配色函数（CIE，CC BY-SA 4.0）/ CIE 1931 2° colour matching functions (CIE, CC BY-SA 4.0)
    cie/CIE_std_illum_D65.csv     CIE D65 标准光源（CIE，CC BY-SA 4.0）/ CIE standard illuminant D65 (CIE, CC BY-SA 4.0)

模型 / the model
    两层皮肤（Donner 等 2008）：表皮（厚 0.25 mm）含黑色素、少量血、胡萝卜素和基线吸收；真皮（半无限）含血和基线吸收。
    两层用 Kubelka–Munk 合成（K = 2μa，S = ¾μs'），表面用 Saunderson 修正（外反射 rs = 8° 菲涅尔，内反射 ri =
    半球平均菲涅尔，n = 1.4）。血在血管里，强吸收波段按血管包装效应打折（Svaasand 等 1995）。
    Two-layer skin (Donner et al. 2008): the epidermis (0.25 mm) holds melanin, a little blood, carotene and the
    baseline absorption; the semi-infinite dermis holds blood and the baseline. The layers are combined by
    Kubelka–Munk (K = 2μa, S = ¾μs'), the surface by Saunderson's correction (external reflection rs = Fresnel
    at 8°, internal reflection ri = the hemispherically averaged Fresnel, n = 1.4). Blood sits in vessels, so
    its strong bands are discounted by the vessel packaging effect (Svaasand et al. 1995).

    每条光谱自己的参数只有 Cm（表皮黑色素体积分数）和 Chd（真皮血液体积分数）——正好是查找表的两个轴；其余参数全体
    共用、一起拟合。查找表存去掉表面外反射 rs 之后的漫反射（镜面由材质的菲涅尔项给）。
    Each spectrum has only two parameters of its own, Cm (epidermal melanin volume fraction) and Chd (dermal
    blood volume fraction) — the two axes of the table; the others are shared and fitted together. The table
    holds the reflectance with the external surface reflection rs removed (the material's Fresnel gives the specular).

部位倍数 / region multipliers
    用同一个模型反推文献里各部位的 CIELAB 均值：先求出参照部位（上臂内侧或颊部）的 (Cm, Chd)，再求出该部位的
    (Cm, Chd)，两者之比就是倍数。没有文献数值的部位在 REGIONS 里标为 assumed。
    The same model inverts the CIELAB means that studies report per site: find (Cm, Chd) of the reference site
    (inner arm or cheek), then of the site; their ratio is the multiplier. Regions without published numbers are
    marked assumed in REGIONS.
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

RAW = 'data/raw/skin'
OUT_JSON = 'data/curated/look/skin-colour.json'
BODIES = ['male', 'female']
LUT_N = 64
CM_MAX = 0.5    # 查找表的 Cm 上限 / the table's Cm limit
CHD_MAX = 0.3   # 查找表的 Chd 上限 / the table's Chd limit

# 拟合用 NIST 的 3 nm 网格 400–778 nm；算颜色用 379–781 nm / the fit uses NIST's 3 nm grid 400–778 nm; colour uses 379–781 nm
WL = np.arange(400, 779, 3, dtype=float)
WL_XYZ = np.arange(379, 782, 3, dtype=float)

# ── 固定的常数（有出处）/ fixed constants (sourced) ──────────────────────────────────────────────
GAMMA = 0.7          # 血氧饱和度（Donner 等 2008）/ oxygen saturation (Donner et al. 2008)
D_EPI = 0.25         # 表皮厚度 mm（Donner 等 2008：含部分乳头层真皮）/ epidermis thickness mm (Donner et al. 2008; includes part of the papillary dermis)
N_SKIN = 1.4         # 折射率（Donner 等 2008）/ refractive index (Donner et al. 2008)
HB_GPL = 150.0       # 全血血红蛋白 g/L（Prahl 的常用值）/ whole-blood haemoglobin g/L (Prahl's usual value)
HB_MW = 64500.0      # 血红蛋白摩尔质量 g/mol（Prahl）/ haemoglobin molar mass g/mol (Prahl)


def read_nist(path):
    """每人的平均光谱和三次重复 / Each subject's average spectrum and three repeats."""
    rows = []
    with open(path, encoding='latin-1') as f:
        for line in f:
            p = line.rstrip('\n').split(',')
            if p and p[0].strip().isdigit():
                rows.append([float(x) if x.strip() else np.nan for x in p])
    a = np.array([r[:401] for r in rows if len(r) >= 401])
    wl = a[:, 0]
    avg = a[:, 4::4]  # 每人 R1 R2 R3 Average / per subject R1 R2 R3 Average
    reps = np.stack([a[:, 1::4], a[:, 2::4], a[:, 3::4]], axis=0)
    return wl, avg.T, reps.transpose(0, 2, 1)


def read_table(path):
    out = []
    for line in open(path, encoding='latin-1'):
        if line.startswith('#') or not line.strip():
            continue
        try:
            out.append([float(x) for x in line.replace(',', ' ').split()])
        except ValueError:
            continue
    return np.array(out)


class Spectra:
    """各吸收体的吸收系数（mm⁻¹）/ Absorption coefficients of the absorbers (mm⁻¹)."""

    def __init__(self, wl):
        self.wl = wl
        hb = read_table(f'{RAW}/omlc/hemoglobin.txt')
        k = 2.303 * HB_GPL / HB_MW / 10.0  # ε [cm⁻¹/M] → 全血 μa [mm⁻¹] / ε → μa of whole blood
        self.hbo2 = np.interp(wl, hb[:, 0], hb[:, 1]) * k
        self.hb = np.interp(wl, hb[:, 0], hb[:, 2]) * k
        bc = read_table(f'{RAW}/omlc/carotene.txt')
        bc = bc[np.argsort(bc[:, 0])]
        # β-胡萝卜素按 451 nm 归一的形状；量是共用的拟合参数 / β-carotene shape normalised at 451 nm; its amount is a shared fitted parameter
        self.bc = np.interp(wl, bc[:, 0], bc[:, 1]) / np.interp(451.0, bc[:, 0], bc[:, 1])
        # Donner & Jensen 2006：真黑素、褐黑素、基线（mm⁻¹）/ eumelanin, pheomelanin, baseline (mm⁻¹)
        self.eu = 6.6e10 * wl ** -3.33
        self.pheo = 2.9e14 * wl ** -4.75
        self.base = 0.0244 + 8.53 * np.exp(-(wl - 154.0) / 66.2)


def fresnel(n, cos_i):
    s = np.sqrt(np.clip(1 - cos_i ** 2, 0, 1))
    st = s / n
    ct = np.sqrt(1 - st ** 2)
    rs = ((cos_i - n * ct) / (cos_i + n * ct)) ** 2
    rp = ((ct - n * cos_i) / (ct + n * cos_i)) ** 2
    return 0.5 * (rs + rp)


def internal_reflectance(n):
    """漫射光从折射率 n 的介质射向空气时的半球平均菲涅尔反射率 / Hemispherically averaged Fresnel reflectance of diffuse light leaving a medium of index n."""
    th = np.linspace(0, np.pi / 2, 20001)[:-1]
    s, c = np.sin(th), np.cos(th)
    st = n * s
    r = np.ones_like(th)
    ok = st < 1
    ct = np.sqrt(1 - st[ok] ** 2)
    r[ok] = 0.5 * (((n * c[ok] - ct) / (n * c[ok] + ct)) ** 2 + ((n * ct - c[ok]) / (n * ct + c[ok])) ** 2)
    w = 2 * s * c
    return float(np.trapezoid(r * w, th) / np.trapezoid(w, th))


RI = internal_reflectance(N_SKIN)
RS = float(fresnel(N_SKIN, np.cos(np.radians(8.0))))  # NIST 的 8° 入射 / NIST's 8° incidence


def km_layer(K, S, d):
    a = 1 + K / S
    b = np.sqrt(a * a - 1)
    x = b * S * d
    sh, ch = np.sinh(x), np.cosh(x)
    den = a * sh + b * ch
    return sh / den, b / den


# 共用的拟合参数 / the shared fitted parameters
G_NAMES = ['betaM', 'scatterA500', 'scatterPower', 'epidermalBloodRatio', 'caroteneMuA451', 'vesselRadiusMm']
G_NOTES = {
    'betaM': ('真黑素在黑色素中的比例（Donner 等 2008 的 βm）', 'eumelanin share of melanin (βm of Donner et al. 2008)'),
    'scatterA500': ('表皮 500 nm 处的约化散射系数 mm⁻¹（真皮取一半）', 'epidermal reduced scattering at 500 nm, mm⁻¹ (half in the dermis)'),
    'scatterPower': ('约化散射的幂律指数 μs\' ∝ (λ/500)^−b（Jacques 2013 的形式）', 'power of the reduced scattering, μs\' ∝ (λ/500)^−b (the form of Jacques 2013)'),
    'epidermalBloodRatio': ('表皮血量与真皮血量之比（Donner 等 2008 的 Che 表示表皮—真皮交界的起伏）', 'ratio of epidermal to dermal blood (Che of Donner et al. 2008, standing for the corrugated junction)'),
    'caroteneMuA451': ('β-胡萝卜素在 451 nm 的吸收系数 mm⁻¹', 'β-carotene absorption at 451 nm, mm⁻¹'),
    'vesselRadiusMm': ('血管包装效应的等效血管半径 mm', 'effective vessel radius of the packaging effect, mm'),
}
G0 = np.array([0.7, 4.6, 1.4, 0.1, 0.05, 0.01])
G_LO = np.array([0.0, 0.5, 0.0, 0.0, 0.0, 0.0005])
G_HI = np.array([1.0, 30.0, 4.0, 0.5, 2.0, 0.1])


def body_reflectance(sp, cm, chd, g):
    """表面以下的漫反射（已含表面透射和内反射，不含外反射 rs），可以广播 / Reflectance below the surface (surface transmission and internal reflection included, external rs not); broadcasts."""
    beta, sa, sb, rhe, bc, rv = g
    cm = np.asarray(cm, float)[..., None]
    chd = np.asarray(chd, float)[..., None]
    che = rhe * chd
    blood = GAMMA * sp.hbo2 + (1 - GAMMA) * sp.hb
    # 血管包装效应：血集中在半径 rv 的血管里，强吸收波段的有效吸收打折（Svaasand 等 1995；van Veen 等 2002）
    # vessel packaging: blood sits in vessels of radius rv, which discounts the effective absorption in strong bands (Svaasand et al. 1995; van Veen et al. 2002)
    x = 2 * blood * rv
    blood = blood * (1 - np.exp(-x)) / x
    mua_e = cm * (beta * sp.eu + (1 - beta) * sp.pheo) + che * blood + bc * sp.bc + (1 - cm - che) * sp.base
    mua_d = chd * blood + (1 - chd) * sp.base
    se = 0.75 * sa * (sp.wl / 500.0) ** -sb
    sd = 0.5 * se
    re, te = km_layer(2 * mua_e, se, D_EPI)
    a = 1 + 2 * mua_d / sd
    rd = a - np.sqrt(a * a - 1)
    rb = re + te * te * rd / (1 - re * rd)
    # Saunderson：进出表面的透射和内反射 / Saunderson: transmission through and internal reflection at the surface
    return (1 - RI) * rb / (1 - RI * rb)


def total_reflectance(sp, cm, chd, g):
    return RS + (1 - RS) * body_reflectance(sp, cm, chd, g)


# ── 颜色 / colour ────────────────────────────────────────────────────────────────────────────
class Colorimetry:
    def __init__(self, wl):
        cmf = read_table(f'{RAW}/cie/CIE_xyz_1931_2deg.csv')
        d65 = read_table(f'{RAW}/cie/CIE_std_illum_D65.csv')
        xyz = np.stack([np.interp(wl, cmf[:, 0], cmf[:, i]) for i in (1, 2, 3)], axis=1)
        self.w = xyz * np.interp(wl, d65[:, 0], d65[:, 1])[:, None]
        self.w /= self.w[:, 1].sum()
        self.white = self.w.sum(axis=0)
        # IEC 61966-2-1 的 sRGB 矩阵，按积分得到的白点归一，使平坦的 1 正好映到 (1,1,1)
        # the IEC 61966-2-1 sRGB matrix, renormalised to the integrated white so a flat 1 maps to exactly (1,1,1)
        m = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
        self.m = m / (m @ self.white)[:, None]

    def lin_rgb(self, r):
        return (r @ self.w) @ self.m.T

    def lab(self, r):
        return xyz_to_lab(r @ self.w, self.white)

    def rgb_to_lab(self, rgb):
        return xyz_to_lab(np.asarray(rgb) @ np.linalg.inv(self.m).T, self.white)


def xyz_to_lab(xyz, white):
    t = xyz / white
    d = 6 / 29
    f = np.where(t > d ** 3, np.cbrt(np.maximum(t, 0)), t / (3 * d * d) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def de2000(lab1, lab2):
    """CIEDE2000（Sharma、Wu、Dalal 2005）/ CIEDE2000 (Sharma, Wu & Dalal 2005)."""
    L1, a1, b1 = np.moveaxis(np.asarray(lab1, float), -1, 0)
    L2, a2, b2 = np.moveaxis(np.asarray(lab2, float), -1, 0)
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dh = np.where(C1p * C2p == 0, 0, np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)))
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    hs = h1p + h2p
    hbp = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = 1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp)) + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63))
    dtheta = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dtheta)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def ita(lab):
    """个体类型角 ITA° = atan((L* − 50)/b*)（Chardon 等 1991）/ individual typology angle (Chardon et al. 1991)."""
    return np.degrees(np.arctan2(lab[..., 0] - 50, lab[..., 2]))


# Chardon 等 1991、Del Bino 等 2006 的 ITA° 分组 / the ITA° groups of Chardon et al. 1991 and Del Bino et al. 2006
ITA_GROUPS = [('very light', 55, 90), ('light', 41, 55), ('intermediate', 28, 41), ('tan', 10, 28), ('brown', -30, 10), ('dark', -90, -30)]


def fit_nist(sp, meas, weight):
    n = meas.shape[0]
    ng = len(G0)
    x0 = np.concatenate([G0, np.tile([0.05, 0.02], n)])
    lo = np.concatenate([G_LO, np.tile([1e-4, 1e-4], n)])
    hi = np.concatenate([G_HI, np.tile([CM_MAX, CHD_MAX], n)])

    def resid(x):
        return ((total_reflectance(sp, x[ng::2], x[ng + 1::2], x[:ng]) - meas) * weight).ravel()

    m = len(sp.wl)
    J = lil_matrix((n * m, ng + 2 * n), dtype=int)
    J[:, :ng] = 1
    for i in range(n):
        J[i * m:(i + 1) * m, ng + 2 * i:ng + 2 * i + 2] = 1
    r = least_squares(resid, x0, bounds=(lo, hi), jac_sparsity=J, x_scale='jac', max_nfev=600)
    return r.x[:ng], r.x[ng::2], r.x[ng + 1::2], r


def invert_lab(sp, col, g, lab, x0=(0.01, 0.03), cm_fixed=None):
    """求使模型（含表面反射）的 CIELAB 最接近 lab 的 (Cm, Chd)；给了 cm_fixed 就只求 Chd。
    Find the (Cm, Chd) whose model CIELAB (surface included) is closest to lab; with cm_fixed only Chd is solved."""
    if cm_fixed is not None:
        def resid1(x):
            return col.lab(total_reflectance(sp, cm_fixed, np.exp(x[0]), g)) - lab
        r = least_squares(resid1, [np.log(x0[1])], bounds=([np.log(1e-4)], [np.log(CHD_MAX)]))
        cm, chd = cm_fixed, float(np.exp(r.x[0]))
    else:
        def resid(x):
            return col.lab(total_reflectance(sp, np.exp(x[0]), np.exp(x[1]), g)) - lab
        r = least_squares(resid, np.log(x0), bounds=(np.log([1e-4, 1e-4]), np.log([CM_MAX, CHD_MAX])))
        cm, chd = np.exp(r.x)
    return float(cm), float(chd), float(de2000(lab, col.lab(total_reflectance(sp, cm, chd, g))))


# ── 部位：文献里的 CIELAB 均值（参照部位 → 该部位）/ regions: published CIELAB means (reference site → site) ──
# Xiao 等 2017（Skin Res Technol 23:21，doi:10.1111/srt.12295）表 2：CM-2600d，d/8，含镜面，D65/2°；参照是上臂内侧
# Xiao et al. 2017, table 2: CM-2600d, d/8, specular included, D65/2°; the reference is the inner arm
XIAO_2017 = {
    'Caucasian (n=187)': {'innerArm': (63.0, 5.6, 14.0), 'forehead': (59.2, 11.6, 15.1), 'cheek': (59.6, 11.8, 14.6), 'backOfHand': (60.1, 7.4, 14.7)},
    'Chinese (n=202)': {'innerArm': (60.9, 7.0, 15.0), 'forehead': (56.4, 11.7, 16.3), 'cheek': (58.9, 11.4, 14.2), 'backOfHand': (57.9, 9.3, 16.1)},
    'Kurdish (n=145)': {'innerArm': (60.6, 6.5, 16.4), 'forehead': (56.1, 11.3, 16.4), 'cheek': (58.0, 11.7, 15.8), 'backOfHand': (57.3, 8.6, 16.5)},
    'Thai (n=426)': {'innerArm': (61.9, 7.1, 17.4), 'forehead': (56.8, 11.6, 17.7), 'cheek': (60.7, 10.5, 17.2), 'backOfHand': (57.6, 9.4, 19.0)},
}
# 唇红与颊部（202 名中国志愿者，CM-700d；《中国组织工程研究》，WPRIM wpr-698623，只读到摘要）
# vermilion vs cheek (202 Chinese volunteers, CM-700d; Chinese Journal of Tissue Engineering Research, WPRIM wpr-698623, abstract only)
LIP_STUDY = {'cheek': (61.87, 7.21, 12.98), 'vermilion': (53.25, 11.19, 8.77)}
# Phan 等 2022（J Biomed Opt 27:036002，doi:10.1117/1.JBO.27.3.036002）：15 人 Fitzpatrick I–VI，CR-400；手掌 L* 60.8 ± 4.6，
# 前臂掌侧 54.6 ± 10.1；手掌的吸收几乎不随肤色变。只给了 L*，所以手掌只标定黑色素的固定值（血量倍数是假设）
# Phan et al. 2022: 15 subjects, Fitzpatrick I–VI, CR-400; palm L* 60.8 ± 4.6, ventral forearm 54.6 ± 10.1; palm
# absorption hardly changes with skin tone. Only L* is given, so only the palm's fixed melanin is calibrated (its blood multiplier is assumed)
PALM_L = 60.8

# 每个部位：黑色素倍数、血量倍数、粗糙度、手足掌权重（把黑色素拉向固定值）、出处
# each region: melanin multiplier, blood multiplier, roughness, palmoplantar weight (pulls melanin to a fixed value), source
# 'computed' = 用模型从文献的 CIELAB 反推；'assumed' = 没有找到数值，按定性描述设的
# 'computed' = inverted with the model from published CIELAB; 'assumed' = no numbers found, set from qualitative accounts
ASSUMED_REGIONS = {
    'nose': {'melanin': 'cheek', 'blood': 1.15, 'roughness': 0.42, 'note': ('鼻部：取颊部的值，血量再加 15%、皮脂多更光（假设）', 'nose: the cheek values, 15% more blood and oilier, so glossier (assumed)')},
    'ears': {'melanin': 1.1, 'blood': 1.5, 'roughness': 0.5, 'note': ('耳廓：皮薄、血管浅（假设）', 'auricle: thin skin with shallow vessels (assumed)')},
    'eyelids': {'melanin': 1.3, 'blood': 1.4, 'roughness': 0.45, 'note': ('眼睑：最薄的皮肤，色素和静脉显得更深（假设）', 'eyelids: the thinnest skin; pigment and veins show darker (assumed)')},
    'fingertips': {'melanin': 1.0, 'blood': 1.6, 'roughness': 0.5, 'note': ('指尖：远节血管丰富，照片里明显更红（假设；没有找到数值）', 'fingertips: the richly vascular distal phalanx looks clearly redder in photographs (assumed; no numbers found)')},
    'nails': {'melanin': 0.3, 'blood': 2.0, 'roughness': 0.3, 'note': ('甲床：透过甲板看到的粉色甲床，甲板光滑（假设；没有找到数值）', 'nail beds: the pink bed seen through a smooth nail plate (assumed; no numbers found)')},
    'areola': {'melanin': 2.5, 'blood': 1.3, 'roughness': 0.5, 'note': ('乳晕：明显更深（方向见 Pawson 和 Petrakis 1975、Silva 等 2020 的新生儿数据；成人倍数是假设）', 'areola: clearly darker (direction from Pawson & Petrakis 1975 and the neonatal data of Silva et al. 2020; the adult multiplier is assumed)')},
    'genitalia': {'melanin': 1.8, 'blood': 1.4, 'roughness': 0.5, 'note': ('外生殖器（阴囊、阴茎、大阴唇）：色素沉着（假设；没有找到数值）', 'external genitalia (scrotum, penis, labia majora): hyperpigmented (assumed; no numbers found)')},
    'elbowsKnees': {'melanin': 1.3, 'blood': 1.2, 'roughness': 0.55, 'note': ('肘、膝伸侧：色素和红斑指数更高（Lee 等 2024 只给了排序，倍数是假设）', 'extensor elbows and knees: higher melanin and erythema indices (Lee et al. 2024 give only the ranking; the multipliers are assumed)')},
    'dorsalForearm': {'melanin': 1.3, 'blood': 1.1, 'roughness': 0.5, 'note': ('前臂背侧等日晒部位：黑色素更多（Alaluf 等 2002 说最多到 2 倍；取 1.3 是假设）', 'dorsal forearm and other sun-exposed sites: more melanin (Alaluf et al. 2002 report up to 2×; 1.3 is assumed)')},
    'palmsSoles': {'melanin': 1.0, 'blood': 1.2, 'roughness': 0.6, 'note': ('手掌、足底：黑色素拉向一个与肤色无关的浅值（Phan 等 2022），角质厚、较粗糙；血量倍数是假设', 'palms and soles: melanin pulled to a light value independent of skin tone (Phan et al. 2022), thick and rough stratum corneum; the blood multiplier is assumed')},
    'mottling': {'melanin': 0.08, 'blood': 0.15, 'note': ('低频斑驳：黑色素 ±8%、血量 ±15%，3–10 cm 尺度（假设）', 'low-frequency mottling: melanin ±8%, blood ±15%, 3–10 cm scales (assumed)')},
}


def half(a):
    return np.asarray(a, dtype='<f2')


def lut_lookup(lut, cm, chd):
    """与着色器相同的双线性查表（轴是平方根）/ The shader's bilinear lookup (square-root axes)."""
    x = np.sqrt(np.clip(np.asarray(cm) / CM_MAX, 0, 1)) * (LUT_N - 1)
    y = np.sqrt(np.clip(np.asarray(chd) / CHD_MAX, 0, 1)) * (LUT_N - 1)
    x0 = np.minimum(np.floor(x).astype(int), LUT_N - 2)
    y0 = np.minimum(np.floor(y).astype(int), LUT_N - 2)
    tx, ty = (x - x0)[..., None], (y - y0)[..., None]
    L = lut[..., :3]
    return L[y0, x0] * (1 - tx) * (1 - ty) + L[y0, x0 + 1] * tx * (1 - ty) + L[y0 + 1, x0] * (1 - tx) * ty + L[y0 + 1, x0 + 1] * tx * ty


def r4(x, n=4):
    return float(round(float(x), n))


def main():
    nist_path = f'{RAW}/nist/skinrefl-v3.csv'
    for p in [nist_path, f'{RAW}/omlc/hemoglobin.txt', f'{RAW}/omlc/carotene.txt', f'{RAW}/cie/CIE_xyz_1931_2deg.csv', f'{RAW}/cie/CIE_std_illum_D65.csv']:
        if not os.path.exists(p):
            sys.exit(f'{p} is missing: see the sources table in README.md for where to get it')
    wl_n, avg, reps = read_nist(nist_path)
    meas = np.stack([np.interp(WL, wl_n, s) for s in avg])
    meas_xyz = np.stack([np.interp(WL_XYZ, wl_n, s) for s in avg])
    sp, sp_xyz = Spectra(WL), Spectra(WL_XYZ)
    col, col_fit = Colorimetry(WL_XYZ), Colorimetry(WL)
    # 按配色函数加权（加一个底），颜色上要紧的波段拟合得更好 / weight by the colour matching functions (plus a floor) so the bands that matter for colour fit better
    wsum = col_fit.w.sum(axis=1)
    weight = np.sqrt(0.25 + wsum / wsum.max())
    g, cm, chd, res = fit_nist(sp, meas, weight)
    model = total_reflectance(sp, cm, chd, g)
    vis = (WL >= 400) & (WL <= 700)
    rms = np.sqrt(np.mean((model - meas)[:, vis] ** 2, axis=1))
    lab_m = col.lab(meas_xyz)
    lab_f = col.lab(total_reflectance(sp_xyz, cm, chd, g))
    de = de2000(lab_m, lab_f)
    itas = ita(lab_m)
    # 同一人三次测量之间的色差：仪器加摆放的噪声底 / colour difference between a subject's three scans: the noise floor of instrument plus placement
    rep_lab = np.stack([col.lab(np.stack([np.interp(WL_XYZ, wl_n, s) for s in reps[k]])) for k in range(3)])
    de_rep = np.mean([de2000(rep_lab[i], rep_lab[j]) for i, j in [(0, 1), (0, 2), (1, 2)]], axis=0)

    # ── 查找表：Cm = CM_MAX·u²，Chd = CHD_MAX·v²（低值处更密）/ the table: Cm = CM_MAX·u², Chd = CHD_MAX·v² (denser at low values) ──
    u = np.arange(LUT_N) / (LUT_N - 1)
    body = body_reflectance(sp_xyz, (CM_MAX * u ** 2)[None, :], (CHD_MAX * u ** 2)[:, None], g)  # [v][u][λ]
    lut = np.ones((LUT_N, LUT_N, 4))
    lut[..., :3] = np.clip(col.lin_rgb(body), 0, 1)
    lut16 = half(lut)
    for b in BODIES:
        os.makedirs(f'public/anatomy/{b}/look', exist_ok=True)
        open(f'public/anatomy/{b}/look/skin-lut.bin', 'wb').write(lut16.tobytes())
    lutf = lut16.astype(float)
    # 查表往返：从表里取回每人的颜色（加回表面反射 rs）/ the round trip through the table: each subject's colour looked up (rs added back)
    lab_lut = col.rgb_to_lab(lut_lookup(lutf, cm, chd) + RS)
    de_lut = de2000(lab_m, lab_lut)

    groups = []
    for name, a, b in ITA_GROUPS:
        sel = (itas >= a) & (itas < b)
        e = {'group': name, 'itaRange': [a, b], 'n': int(sel.sum())}
        if sel.any():
            e.update({'spectralRmsMean': r4(rms[sel].mean()), 'spectralRmsMax': r4(rms[sel].max()),
                      'dE2000Mean': r4(de[sel].mean(), 2), 'dE2000Max': r4(de[sel].max(), 2),
                      'lutDE2000Mean': r4(de_lut[sel].mean(), 2), 'lutDE2000Max': r4(de_lut[sel].max(), 2)})
        groups.append(e)

    # ── 部位倍数 / region multipliers ──
    # 不同仪器的绝对 CIELAB 有系统差（孔径、几何），所以只用部位之间的差：把文献里"该部位 − 参照部位"的
    # ΔL*Δa*Δb* 加到 NIST 中位数那一点的颜色上再反推 / instruments differ systematically in absolute CIELAB
    # (aperture, geometry), so only the differences between sites are used: the published ΔL*Δa*Δb* "site − reference"
    # is added to the colour of the NIST median point and inverted
    med_cm, med_chd = float(np.median(cm)), float(np.median(chd))
    lab0 = col.lab(total_reflectance(sp_xyz, med_cm, med_chd, g))
    regions = {}
    per_group = {}
    for grp, sites in XIAO_2017.items():
        per_group[grp] = {}
        for site in ('forehead', 'cheek', 'backOfHand'):
            target = lab0 + np.array(sites[site]) - np.array(sites['innerArm'])
            # 面部：Xiao 的 b* 几乎不变，黑色素倍数定为 1（假设），只反推血量；手背两个都反推
            # face: b* barely changes in Xiao's data, so melanin is held at 1 (assumed) and only blood is inverted; the back of the hand inverts both
            c1, h1, e1 = invert_lab(sp_xyz, col, g, target, (med_cm, med_chd), med_cm if site != 'backOfHand' else None)
            per_group[grp][site] = {'melanin': r4(c1 / med_cm, 3), 'blood': r4(h1 / med_chd, 3), 'dE2000': r4(e1, 2)}
    for site in ('forehead', 'cheek', 'backOfHand'):
        mm = np.exp(np.mean([np.log(per_group[k][site]['melanin']) for k in per_group]))
        bb = np.exp(np.mean([np.log(per_group[k][site]['blood']) for k in per_group]))
        regions[site] = {'melanin': r4(mm, 3), 'blood': r4(bb, 3), 'roughness': 0.45 if site != 'backOfHand' else 0.5,
                         'provenance': 'computed' if site == 'backOfHand' else 'computed (blood) / assumed (melanin)',
                         'source': 'Xiao et al. 2017, Skin Res Technol 23:21, table 2 (geometric mean of the four groups)',
                         'note': {'zh': '把 Xiao 等 2017 表 2 中该部位相对上臂内侧的 ΔL*Δa*Δb* 加到 NIST 中位数的颜色上，用本模型反推，四个人群取几何平均。额头和颊部的黑色素倍数定为 1（假设；它们的 b* 几乎不变），只反推血量；模型的血量变化给不出那么大的 a*，残差见 regionFits。粗糙度是假设', 'en': 'the ΔL*Δa*Δb* of this site relative to the inner arm in table 2 of Xiao et al. 2017, added to the colour of the NIST median and inverted with this model, geometric mean of the four groups. For forehead and cheek melanin is held at 1 (assumed; their b* barely changes) and only blood is inverted; the model\'s blood cannot produce that much a*, see the residuals in regionFits. The roughness is assumed'}}
    xiao_cheek = np.mean([np.array(v['cheek']) - np.array(v['innerArm']) for v in XIAO_2017.values()], axis=0)
    lab_cheek = lab0 + xiao_cheek
    cmc, chc, ec = invert_lab(sp_xyz, col, g, lab_cheek, (med_cm, med_chd), med_cm)
    # 唇红：黑色素取颊部的 0.7（Sun 等 2025 综述：唇红黑素细胞较少；深肤色的唇也有色素，倍数是假设），只反推血量
    # vermilion: melanin 0.7 of the cheek's (Sun et al. 2025 review: fewer melanocytes in the vermilion; deep-toned lips are pigmented too; the factor is assumed), only blood is inverted
    cml, chl, el = invert_lab(sp_xyz, col, g, lab_cheek + np.array(LIP_STUDY['vermilion']) - np.array(LIP_STUDY['cheek']), (cmc, chc), 0.7 * cmc)
    regions['lips'] = {'melanin': r4(cml / med_cm, 3), 'blood': r4(chl / med_chd, 3), 'roughness': 0.35,
                       'source': 'Chinese Journal of Tissue Engineering Research, WPRIM wpr-698623 (abstract): vermilion vs cheek, n=202; cheek vs inner arm from Xiao et al. 2017',
                       'fit': {'cheek': {'dE2000': r4(ec, 2)}, 'vermilion': {'dE2000': r4(el, 2)}},
                       'provenance': 'computed (blood) / assumed (melanin, roughness)',
                       'note': {'zh': '颊部相对上臂内侧取 Xiao 等 2017 四个人群的平均差，唇红相对颊部取摘要里的差，加到 NIST 中位数的颜色上，只反推血量；黑色素取颊部的 0.7（Sun 等 2025 综述：唇红黑素细胞较少，倍数是假设），粗糙度 0.35 是假设', 'en': 'cheek vs inner arm: the mean difference over the four groups of Xiao et al. 2017; vermilion vs cheek: the difference in the abstract; added to the colour of the NIST median, only blood inverted; melanin 0.7 of the cheek\'s (Sun et al. 2025 review: fewer melanocytes in the vermilion; the factor is assumed), roughness 0.35 assumed'}}
    # 手掌：Cm 取使 L* = 60.8 的值（血量取 NIST 中位数 × 1.2）/ palm: the Cm that gives L* = 60.8 (blood: NIST median × 1.2)
    palm_blood = ASSUMED_REGIONS['palmsSoles']['blood']

    def palm_resid(x):
        return [col.lab(total_reflectance(sp_xyz, np.exp(x[0]), med_chd * palm_blood, g))[0] - PALM_L]
    palm_cm = float(np.exp(least_squares(palm_resid, [np.log(0.01)], bounds=([np.log(1e-4)], [np.log(CM_MAX)])).x[0]))
    for k, v in ASSUMED_REGIONS.items():
        e = {kk: vv for kk, vv in v.items() if kk != 'note'}
        if e.get('melanin') == 'cheek':
            e['melanin'] = regions['cheek']['melanin']
            e['blood'] = r4(regions['cheek']['blood'] * v['blood'], 3)
        e['provenance'] = 'assumed'
        e['note'] = {'zh': v['note'][0], 'en': v['note'][1]}
        regions[k] = e
    regions['palmsSoles']['palmMelanin'] = r4(palm_cm, 5)
    regions['palmsSoles']['provenance'] = 'computed (melanin) / assumed (blood, roughness)'
    regions['palmsSoles']['source'] = 'Phan et al. 2022, J Biomed Opt 27:036002 (palm L* 60.8, n=15)'

    # ── 色调滑块 / the tone slider ──
    # Cm = toneMax·t²（t = tone/100）；toneMax 让最深一端在 NIST 的中位血量下 ITA° ≈ −55（Del Bino 等 2006 的"深色"组）
    # Cm = toneMax·t² (t = tone/100); toneMax puts the deep end at ITA° ≈ −55 (the "dark" group of Del Bino et al. 2006) at NIST's median blood
    def ita_at(c):
        return float(ita(col.lab(total_reflectance(sp_xyz, c, med_chd, g))))
    lo, hi = 0.05, CM_MAX
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ita_at(mid) > -55 else (lo, mid)
    tone_max = r4((lo + hi) / 2, 4)
    # 缺省色调：NIST 100 人 Cm 的中位数（上臂内侧这种不晒太阳的部位）/ the default tone: the median Cm of the 100 NIST subjects (an unexposed site like the inner arm)
    tone_default = int(round(100 * np.sqrt(np.median(cm) / tone_max)))
    tone_nist_max = float(100 * np.sqrt(cm.max() / tone_max))

    tol = 3.5
    out = {
        '_doc': {
            'zh': '写实皮肤的颜色模型：拟合 NIST 前臂反射光谱得到的参数、各部位的倍数和色调滑块的范围。由 tools/look/skin_colour.py 生成；每个数都标了 sourced（文献）、assumed（假设）或 computed（本工具算出）。查找表在 public/anatomy/<body>/look/skin-lut.bin。',
            'en': 'The colour model of the lifelike skin: parameters fitted to the NIST forearm reflectance spectra, the region multipliers and the range of the tone slider. Built by tools/look/skin_colour.py; every number is marked sourced (literature), assumed or computed (by this tool). The lookup table is public/anatomy/<body>/look/skin-lut.bin.',
        },
        'calibration': {
            'data': 'NIST Reference Data Set of Human Skin Reflectance (Cooksey, Allen & Tsai 2017, J Res NIST 122:26, doi:10.6028/jres.122.026; data doi:10.18434/M38597)',
            'credit': {'zh': '数据来自美国国家标准与技术研究院（NIST）；这里只用了它的光谱算出下面的数，没有改动或再分发原始数据。', 'en': 'Data from the National Institute of Standards and Technology (NIST); its spectra were only used to compute the numbers below; the original data are neither modified nor redistributed.'},
            'site': 'inner right forearm, 25 mm circle; 8°/hemispherical reflectance factor',
            'subjects': len(cm),
            'fitRange': [float(WL[0]), float(WL[-1])],
            'note': {'zh': '模型（含表面反射）对每人拟合 Cm、Chd，其余参数全体共用。ITA° 分组按 Del Bino 等 2006；NIST 里没有 ITA° < −30 的人，深色一端是外推。', 'en': 'The model (surface reflection included) fits Cm and Chd per subject; the other parameters are shared. ITA° groups after Del Bino et al. 2006; NIST has nobody with ITA° < −30, so the deep end is extrapolated.'},
            'spectralRms400to700': {'mean': r4(rms.mean()), 'median': r4(np.median(rms)), 'max': r4(rms.max())},
            'dE2000': {'mean': r4(de.mean(), 2), 'median': r4(np.median(de), 2), 'max': r4(de.max(), 2)},
            'lutDE2000': {'mean': r4(de_lut.mean(), 2), 'max': r4(de_lut.max(), 2), 'tolerance': tol},
            'repeatScanDE2000': {'mean': r4(de_rep.mean(), 2), 'max': r4(de_rep.max(), 2), 'note': {'zh': '同一人三次扫描之间的平均色差：测量本身的噪声底', 'en': 'mean colour difference between one subject\'s three scans: the noise floor of the measurement'}},
            'groups': groups,
            'worst': [{'subject': int(i) + 1, 'dE2000': r4(de[i], 2), 'spectralRms': r4(rms[i]), 'ita': r4(itas[i], 1)} for i in np.argsort(-de)[:5]],
        },
        'model': {
            'fixed': {
                'oxygenSaturation': {'value': GAMMA, 'provenance': 'sourced', 'source': 'Donner et al. 2008'},
                'epidermisThicknessMm': {'value': D_EPI, 'provenance': 'sourced', 'source': 'Donner et al. 2008'},
                'refractiveIndex': {'value': N_SKIN, 'provenance': 'sourced', 'source': 'Donner et al. 2008'},
                'surfaceReflection': {'value': r4(RS, 5), 'provenance': 'computed', 'note': {'zh': 'n = 1.4、8° 入射的菲涅尔反射率', 'en': 'Fresnel reflectance at 8° incidence for n = 1.4'}},
                'internalReflection': {'value': r4(RI, 5), 'provenance': 'computed', 'note': {'zh': 'n = 1.4 的半球平均菲涅尔反射率（Saunderson 修正用）', 'en': 'hemispherically averaged Fresnel reflectance for n = 1.4 (for Saunderson\'s correction)'}},
                'bloodHaemoglobinGPerL': {'value': HB_GPL, 'provenance': 'sourced', 'source': 'Prahl, OMLC hemoglobin compilation'},
                'melaninSpectra': {'value': 'eu 6.6e10·λ^−3.33, pheo 2.9e14·λ^−4.75, baseline 0.0244 + 8.53·exp(−(λ−154)/66.2) mm⁻¹', 'provenance': 'sourced', 'source': 'Donner & Jensen 2006'},
                'haemoglobinSpectra': {'value': 'Gratzer/Kollias molar extinction compiled by Prahl (OMLC); used locally, not committed', 'provenance': 'sourced'},
            },
            'fitted': {k: {'value': r4(v, 5), 'provenance': 'computed', 'lowerBound': float(G_LO[i]), 'upperBound': float(G_HI[i]),
                           'atBound': bool(v <= G_LO[i] + 1e-6 or v >= G_HI[i] - 1e-6), 'note': {'zh': G_NOTES[k][0], 'en': G_NOTES[k][1]}} for i, (k, v) in enumerate(zip(G_NAMES, g))},
            'fittedNote': {
                'zh': '共用参数是使 100 条光谱整体残差最小的"等效值"，不是各自的生理测量：βm 落到 0（拟合要比真黑素更陡的吸收谱），散射幂律指数很小（比 Jacques 2013 的 1.4 平得多）。把它们固定到文献值会让平均色差从约 1 升到 2–3 ΔE00。查找表只在 NIST 的范围内是标定过的。',
                'en': 'The shared parameters are the "effective" values that minimise the residual over all 100 spectra, not physiological measurements each: βm goes to 0 (the fit wants an absorption steeper than eumelanin\'s) and the scattering power is small (much flatter than Jacques 2013\'s 1.4). Pinning them to literature values raises the mean colour difference from about 1 to 2–3 ΔE00. The table is calibrated only within the NIST range.',
            },
        },
        'lut': {'file': 'skin-lut.bin', 'size': LUT_N, 'format': 'RGBA half-float, row v (blood) by column u (melanin), linear sRGB, alpha 1',
                'cmMax': CM_MAX, 'chdMax': CHD_MAX, 'axes': 'Cm = cmMax·u², Chd = chdMax·v²', 'content': 'diffuse reflectance below the surface (rs removed), D65, CIE 1931 2°'},
        'colorimetry': {
            'rgbToXyz': [[r4(v, 7) for v in row] for row in np.linalg.inv(col.m)], 'whiteXyz': [r4(v, 7) for v in col.white],
            'note': {'zh': '线性 sRGB → XYZ 的矩阵（IEC 61966-2-1，按 D65 × CIE 1931 2° 积分得到的白点归一）和 CIELAB 用的白点；测试用它把查找表的颜色换回 CIELAB', 'en': 'the linear-sRGB → XYZ matrix (IEC 61966-2-1, renormalised to the white integrated from D65 × CIE 1931 2°) and the white used for CIELAB; the tests use it to turn table colours back into CIELAB'},
        },
        'tone': {'cmMax': tone_max, 'default': tone_default, 'nistMax': r4(tone_nist_max, 1), 'bloodChd': r4(med_chd, 5),
                 'mapping': 'Cm = cmMax·(tone/100)²', 'provenance': 'computed',
                 'note': {'zh': f'缺省 {tone_default} 是 NIST 100 人 Cm 的中位数；血量取 NIST 中位数。tone 高于 {tone_nist_max:.0f} 超出 NIST 的范围，是外推。', 'en': f'The default {tone_default} is the median Cm of the 100 NIST subjects; blood is the NIST median. Tone above {tone_nist_max:.0f} lies beyond the NIST range and is extrapolated.'}},
        'regions': regions,
        'regionFits': per_group,
        'subjects': [{'subject': i + 1, 'cm': r4(cm[i], 5), 'chd': r4(chd[i], 5), 'lab': [r4(x, 2) for x in lab_m[i]], 'ita': r4(itas[i], 1),
                      'spectralRms': r4(rms[i]), 'dE2000': r4(de[i], 2), 'lutDE2000': r4(de_lut[i], 2), 'repeatDE2000': r4(de_rep[i], 2)} for i in range(len(cm))],
        'sources': [
            'Cooksey CC, Allen DW, Tsai BK (2017) Reference data set of human skin reflectance. J Res NIST 122:26. doi:10.6028/jres.122.026; data doi:10.18434/M38597',
            'Donner C, Jensen HW (2006) A spectral BSSRDF for shading human skin. EGSR 2006. doi:10.2312/EGWR/EGSR06/409-417',
            'Donner C, Weyrich T, d\'Eon E, Ramamoorthi R, Rusinkiewicz S (2008) A layered, heterogeneous reflectance model for acquiring and rendering human skin. ACM TOG 27(5):140',
            'Jacques SL (2013) Optical properties of biological tissues: a review. Phys Med Biol 58:R37. doi:10.1088/0031-9155/58/11/R37',
            'Svaasand LO et al. (1995) Tissue parameters determining the visual appearance of normal skin and port-wine stains. Lasers Med Sci 10:55',
            'Saunderson JL (1942) Calculation of the color of pigmented plastics. JOSA 32:727',
            'Prahl S, Tabulated molar extinction coefficient for hemoglobin in water (OMLC), compiled from Gratzer and Kollias',
            'CIE 1931 2° colour matching functions and CIE D65 (CIE datasets, CC BY-SA 4.0)',
            'Sharma G, Wu W, Dalal EN (2005) The CIEDE2000 color-difference formula. Color Res Appl 30:21',
            'Chardon A et al. (1991) Skin colour typology and suntanning pathways. Int J Cosmet Sci 13:191; Del Bino S et al. (2006) Pigment Cell Res 19:606',
            'Xiao K et al. (2017) Characterising the variations in ethnic skin colours: a new calibrated data base for human skin. Skin Res Technol 23:21. doi:10.1111/srt.12295',
            'Measurement and correlation analysis of vermilion and facial skin color. Chinese Journal of Tissue Engineering Research (WPRIM wpr-698623; abstract)',
            'Phan T et al. (2022) Quantifying the confounding effect of pigmentation on measured skin tissue optical properties. J Biomed Opt 27:036002. doi:10.1117/1.JBO.27.3.036002',
            'Sun F, Liu Y, Zhang T (2025) Aging of the human lip. J Cosmet Dermatol 24:e70310. doi:10.1111/jocd.70310',
            'Lee EJ et al. (2024) Skin color analysis of various body parts in 53 Korean women. J Clin Med 13:2500. doi:10.3390/jcm13092500',
            'Alaluf S et al. (2002) Ethnic variation in melanin content and composition in photoexposed and photoprotected human skin. Pigment Cell Res 15:112',
            'Pawson IG, Petrakis NL (1975) Comparisons of breast pigmentation among women of different racial groups. Hum Biol 47:441; Silva PC et al. (2020) Melanin index in the skin of preterm newborns. Skin Res Technol 26:356',
        ],
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write('\n')
    # 本地的诊断数据（不入库）/ local diagnostics (not in git)
    with open(f'{RAW}/fit-spectra.json', 'w') as f:
        json.dump({'wl': WL.tolist(), 'measured': np.round(meas, 4).tolist(), 'model': np.round(model, 4).tolist()}, f)
    c = out['calibration']
    print(f"shared: {dict(zip(G_NAMES, np.round(g, 4)))}")
    print(f"spectral RMS {c['spectralRms400to700']}, dE00 {c['dE2000']}, LUT dE00 {c['lutDE2000']}, repeat {c['repeatScanDE2000']['mean']}")
    for e in groups:
        print('  ', e)
    print('regions:', {k: (v.get('melanin'), v.get('blood')) for k, v in regions.items()})
    print('tone:', out['tone'])
    if de_lut.max() > tol:
        sys.exit(f'LUT round trip {de_lut.max():.2f} exceeds the tolerance {tol}')


if __name__ == '__main__':
    main()
