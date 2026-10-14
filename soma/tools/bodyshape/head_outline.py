"""
女性头部的外形（方向反过来）：外形取参数化头模型自己的女性头，不再去贴她的颅骨；颅骨、牙和面部软组织以后由几何管线变形进来。
The outer shape of the female head (direction reversed): the outer shape is the parametric head model's own female head and
no longer follows her skull; skull, teeth and facial soft parts are warped INTO it later by the geometry pipeline.

    python tools/bodyshape/head_outline.py [--sex 1.0] [--strengths 0.5,1,1.5] [--out female-head-outline]

只读 female-skin/（以及渲染用的 male-skin/）；只写 data/raw/bodyshape/out/<--out>/。运行前后对三个已发布的包目录求散列，写进报告。
Reads female-skin/ (and male-skin/ for the renders) only; writes data/raw/bodyshape/out/<--out>/ only. The three shipped
package directories are hashed before and after and the hashes go into the report.

步骤 / steps
  1 性别方向：MakeHuman 的“女性减中性”形状差（经 Anny；资产 CC0，代码 Apache-2.0；美术建模，不是测量数据）投影到 MHR 头部身份分量 20–39 上，
    所以结果留在 MHR 自己的形状空间里（眼睑带、唇间口袋保持模型自己的形状）。
    the sex direction: MakeHuman's "female minus neutral" shape difference (through Anny; assets CC0, code Apache-2.0; artist-made,
    not measured data) projected onto MHR's head identity components 20-39, so the result stays inside MHR's own shape space (the
    lid strip and the pocket between the lips keep the model's own shape).
  2 大小（下面这段是 --fit-identity 的做法；默认只用整头缩放 + 各轴至多 ±4 % 的修正，身份分量 = 强度 × 性别分量，见 solve_identity）：头部身份分量再按 ANSUR II 女性（公开数据，data/raw/bodyshape/ansur2）在她的身高处的期望值做岭回归（先验 = 强度 × 性别方向），
    外加一个整头等比缩放。量：头宽、头长、耳屏点—头顶高、两颧宽、颏下点—鼻根点长、瞳距。
    size (what follows is the --fit-identity variant; by default only a whole-head scale with a per-axis correction of at most +/-4 % is used and
    the identity is strength x sex component, see solve_identity): the head identity is then ridge-fitted (prior = strength x sex direction) to the values ANSUR II women (public data,
    data/raw/bodyshape/ansur2) have at her stature, with one isotropic scale of the whole head. Measures: head breadth, head length,
    tragion to top of head, bizygomatic breadth, menton-sellion length, interpupillary breadth.
  3 姿势（--posture level 的做法；默认 fitted 见 POSE 处的说明）：头回到模型静止时的朝向（平视、不歪不转），头顶保持在原来的高度（身高不变）；只动头关节和颈长，颈的姿势不变。
    pose (the --posture level variant; for the default, fitted, see the note at POSE): the head returns to the orientation it has in the model's rest pose (level, no lean, no turn), the top of the head stays at
    its present height (stature unchanged); only the head joint and the neck length change, the neck keeps its pose.
     颈部的深层结构（胸锁乳突肌、斜方肌上部、颈阔肌）在新头下面没有再做外推：试过，下颌下面被顶出一圈台阶；它们露出多少写在报告里。
     The deep parts of the neck (sternocleidomastoid, upper trapezius, platysma) get no new push under the new head: it was tried and raised a
     stepped collar under the jaw; how far they lie outside is in the report.
  4 接缝：颈部下段一条带内，由原皮肤过渡到新头（同一拓扑，按顶点混合）。
    join: inside a band low on the neck the shipped skin is blended into the new head (same topology, per vertex).
  5 标志点、颅骨到新皮肤的距离、量度、渲染、报告。landmarks, skull-to-new-skin distances, measurements, renders and reports.

软组织厚度 / soft-tissue depths（只写打开读到的 / only what was opened and read）
  正中 9 点 / nine midline points: Park, Chang & Park 2023, IJERPH 20(3):2658, doi:10.3390/ijerph20032658, 女性骨性 I 类 / females, skeletal Class I
      (n = 18, Korean, in their twenties, CBCT)；本轮在 PMC（PMC9914978）打开；许可声明原文：“open access article distributed under the terms and
      conditions of the Creative Commons Attribution (CC BY) license”（读到的文字里没有版本号）。
      opened this round on PMC (PMC9914978); licence statement as read: "open access article distributed under the terms and conditions of
      the Creative Commons Attribution (CC BY) license" (no version number in the text read).
  其余 / the others: Hona & Stephan 2024, Int J Legal Med 138:519-535, doi:10.1007/s00414-023-03087-x, 表 3（成人 2023 T-Table，不分性别和人群）；
      本轮在 PMC（PMC10861615）打开读到均值；许可 CC BY 4.0（在出版社页面读到）。标准差取自知识库审计的记录。
      Table 3 (adult 2023 T-Table, pooled over sexes and populations); means opened and read this round on PMC (PMC10861615); licence CC BY
      4.0 (read on the publisher's page). SDs are those recorded by the knowledge audit.
  T-Table 里没有颅侧点、额结节、乳突：这三处是假定值，逐条标明。
  The T-Table has no euryon, frontal eminence or mastoid: those three are assumptions and labelled as such.
"""
import csv
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import face_female as FFACE  # noqa: E402
import face_r2 as R2  # noqa: E402
import final_female as FF  # noqa: E402
import head_landmarks as HL  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import signed_distance  # noqa: E402
from fit_skin import vertex_normals, write_obj  # noqa: E402

SHIPPED = ('female-skin', 'female-skin-grafted', 'female-skin-open')
SRC_PARK = ('Park, Chang & Park 2023, Int J Environ Res Public Health 20(3):2658, doi:10.3390/ijerph20032658: females, skeletal Class I '
            '(n = 18, Korean, in their twenties, CBCT); opened on PMC (PMC9914978); licence statement read: Creative Commons Attribution (CC BY)')
SRC_TT = ('Hona & Stephan 2024, Int J Legal Med 138:519-535, doi:10.1007/s00414-023-03087-x, Table 3 adult 2023 T-Table (sex- and population-pooled, '
          'rounded to 0.5 mm); mean opened on PMC (PMC10861615); CC BY 4.0; SD as recorded by data/curated/knowledge/citation-audit.json')
ASSUMED = 'ASSUMPTION: no table opened gives this point; value chosen by analogy with %s'
# 皮肤标志点 -> (骨标志点, 厚度 mm, 标准差, 来源) / skin landmark -> (bony landmark, depth mm, SD, source)
DEPTH = {
    'glabella': ('glabella', 5.57, 0.68, SRC_PARK), 'sellion': ('nasion', 6.16, 1.48, SRC_PARK), 'rhinionSkin': ('rhinion', 3.10, 1.6, SRC_PARK),
    'subnasale': ('subspinale / anterior nasal spine region', 13.53, 1.2, SRC_PARK), 'labraleSuperius': ('prosthion', 14.19, 1.69, SRC_PARK),
    'labraleInferius': ('infradentale', 14.94, 1.65, SRC_PARK), 'labiomentale': ('supramentale (B point)', 11.99, 0.92, SRC_PARK),
    'pogonion': ('pogonion', 12.44, 1.83, SRC_PARK), 'gnathion': ('gnathion', 7.53, 1.92, SRC_PARK), 'menton': ('menton', 7.0, 2.5, SRC_TT),
    'vertex': ('vertex', 5.0, 1.5, SRC_TT), 'opisthocranion': ('opisthocranion', 6.0, 2.0, SRC_TT),
    'superciliare': ('mid-supraorbital margin', 7.0, 2.0, SRC_TT), 'infraorbitalSkin': ('mid-infraorbital margin', 6.5, 3.0, SRC_TT),
    'zygion': ('zygion', 7.5, 3.0, SRC_TT), 'gonion': ('gonion', 12.5, 6.0, SRC_TT), 'midRamus': ('mid-ramus', 19.5, 5.0, SRC_TT),
    'euryon': ('euryon', 6.0, None, ASSUMED % 'vertex 5.0 and opisthocranion 6.0 of the T-Table (scalp over the vault)'),
    'frontalEminence': ('frontal eminence', 5.5, None, ASSUMED % 'glabella 5.5 of the T-Table (forehead)'),
    'mastoid': ('mastoid process (lateral surface)', 9.0, None, ASSUMED % 'nothing tabled; skin, fat and the tendon of sternocleidomastoid behind the auricle'),
    'earCanal': ('porion (upper rim of the bony external acoustic meatus)', 20.0, None,
                 'ASSUMPTION, and not a soft-tissue depth: the bony meatus is taken 20 mm medial to the canal opening found on the skin (cartilaginous canal); '
                 'for orientation (Frankfort plane) rather than for cover'),
}
BONE_KEY = {'glabella': 'glabella', 'sellion': 'nasion', 'rhinionSkin': 'rhinion', 'subnasale': 'subnasale', 'labraleSuperius': 'labraleSuperius', 'labraleInferius': 'labraleInferius',
            'labiomentale': 'labiomentale', 'pogonion': 'pogonion', 'gnathion': 'gnathion', 'menton': 'menton', 'superciliare': 'midSupraorbital', 'infraorbitalSkin': 'midInfraorbital',
            'zygion': 'zygion', 'gonion': 'gonion', 'midRamus': 'midRamus'}
MEAS = ['headBreadth', 'headLength_glabellaOpisthocranion', 'earCanalToTopOfHead', 'bizygomaticBreadth', 'mentonSellionLength', 'ipd']
ANSUR = ['headbreadth', 'headlength', 'tragiontopofhead', 'bizygomaticbreadth', 'mentonsellionlength', 'interpupillarybreadth']
# 性别分量 = 强度 × (MakeHuman 方向 + EXTRA)。EXTRA：逐个渲染 MHR 头部分量（±2.5）后看到，分量 20 取负是“小而纤细的女性头”，取正是“大而重的男性头”；
# 分量 21 取负时唇厚、下半脸柔和。MakeHuman 的差在相减前去掉了大小，所以它在分量 20 上的投影是 0。这两个系数是看图定的，是假定值。
# sex component = strength x (MakeHuman direction + EXTRA). EXTRA: rendering MHR's head components one by one (+/-2.5) shows component 20
# negative as a small gracile female head and positive as a large heavy male one; component 21 negative gives fuller lips and a softer
# lower face. Size is removed from the MakeHuman difference before the subtraction, so its projection on component 20 is 0. The two
# coefficients were chosen by eye and are assumptions.
EXTRA = np.zeros(20)
EXTRA[0], EXTRA[1] = -1.95, -1.35
# MakeHuman 方向在高阶分量（32–39）上的系数减半：全量时口角两侧出现小凹坑 / the MakeHuman direction is halved on the high components (32-39): at full weight small dimples appeared beside the mouth corners
ANISO = 0.04
# 只解头关节的三个转角和颈长：颈的姿势不动，她的颈部内部结构留在原皮肤下面。试过同时把两眼中点在前后方向上按在她现在的眼球上：
# 颈被向后推了 0.27 弧度，带内新旧皮肤相差到 41 mm，舌骨、甲状腺、胸锁乳突肌露出皮肤 7–12 mm。头绕头关节点头，颅骨以后跟着点头即可。
# (The 28 mm by which the levelled head then lies in front of her skull is removed by a translation of the head, see build.)
# Only the three rotations of the head joint and the neck length are solved: the neck keeps its pose and her neck internals stay under the
# shipped skin. Holding the eye midpoint over her present globes in z as well was tried: the neck was pushed back by 0.27 rad, new and
# shipped skin differed by up to 41 mm in the band and hyoid, thyroid and sternocleidomastoid came 7-12 mm through the skin. The head nods
# about the head joint; the skull can nod with it later.
# --posture fitted（默认）：头保持原拟合的朝向和全部姿势参数（她的颅骨相对颈椎后仰约 11°，这是供体的姿势），整头平移到两眼中点对上她的眼球中点；身高随之略降；颅骨、颈椎、喉都不用动。
#   放平是姿势，不是形状：运行时转头关节即可，颅骨绑在头关节上会跟着转。
# --posture level：头放平再平移回她的颅骨处。试过：面部与颅骨对得上，但新头的颈前面比她的喉靠后，甲状腺、甲状软骨露出皮肤 16–23 mm。
# --posture fitted (default): the head keeps the orientation of the shipped fit (her skull is extended about 11 degrees on the cervical spine,
#   the donor's posture) and every pose parameter; the whole head is translated until the eye midpoint is on the midpoint of her globes, and the
#   stature comes out slightly lower; skull, cervical spine and larynx need not move. Levelling
#   is a pose, not a shape: at run time the head joint is turned and the skull, bound to it, turns with it.
# --posture level: the head is levelled and translated back onto her skull. Tried: face and skull agree, but the front of the new neck then lies
#   behind her larynx and thyroid gland and thyroid cartilage come 16-23 mm through the skin.
POSE = ['head_twist', 'head_lean', 'head_bend', 'scale_neck_length']
T0, T1 = 0.10, 0.70   # 混合带在颈轴上的范围 / extent of the blend band along the neck axis
DAMP = 0.5 * np.r_[np.ones(12), 0.5 * np.ones(8)]   # MakeHuman 方向整体取 0.5：单独用它（1.5 倍）读作男性，它只作细节 / the MakeHuman direction enters at 0.5 overall: alone (at 1.5) it reads male, so it only adds detail
# 钉住的身高（米）：新头的 --stature 用它。项目的标准女性身高是 1.606 m（中国 20–24 岁女性 2020 年均值，见 REPORT.md）；已发布的皮肤是 1.6155 m，
# 只因为原来的头是贴着她偏高的颅顶做的。头在竖直方向放开、头的转角也放开时，面部和眶周标志点的最小二乘（tools/pipeline/headPose.ts 的说明里有做法）
# 会把头一直往下放到 1.5955 m（并前屈 5.6°）；协调者定的范围是 1.606 m ± 3 mm。在这个范围里取 1.606 m 本身：这时最吻合的转角是 −0.06°，即不必转头，
# 残差均方根 6.2 mm（守住 1.6155 m、后伸 5° 时是 10.1 mm）。她的颅顶仍比模型的高，这 11 mm 左右改由颅顶的形变吸收，面颅相对寰枕关节、舌骨和喉不再上移。
# The pinned stature (m), used with --stature for the new head. The project's standard female stature is 1.606 m (mean of Chinese women aged
# 20-24 in 2020, see REPORT.md); the shipped skin stands 1.6155 m only because the old head was draped over her tall vault. With the head free
# to move vertically and free to turn, the least-squares match of the face and orbit landmarks (described in tools/pipeline/headPose.ts) keeps
# lowering the head down to 1.5955 m (with 5.6 deg of flexion); the coordinator set the range 1.606 m +/- 3 mm. Inside it 1.606 m itself is
# taken: there the best rotation is -0.06 deg, i.e. the head need not be turned, RMS residual 6.2 mm (10.1 mm with 1.6155 m held and 5 deg
# of extension). Her vault is still taller than the model's; those 11 mm or so are now taken up by the warp of the vault, and the facial
# skeleton is no longer moved up against the atlanto-occipital joint, the hyoid and the larynx.
PINNED_STATURE = {'statureM': 1.606, 'toleranceM': 0.003, 'standard': 'project standard female stature 1.606 m (China 20-24, 2020 means)',
                  'fitWhenPinned': {'statureM_bestRotationDeg_rmsMm': [[1.609, -1.67, 7.4], [1.6075, -0.87, 6.8], [1.606, -0.06, 6.2], [1.6045, 0.74, 5.6], [1.603, 1.54, 5.1]],
                                    'unbounded': {'statureM': 1.5954, 'rotationDeg': 5.59, 'rmsMm': 3.8}, 'statureHeldAt1p6155': {'rotationDeg': -5.16, 'rmsMm': 10.1},
                                    'vertexBoneAboveItsTargetMm_at1p606_rotation0': 11.2}}
INCISOR_SHOW = 0.002   # 静止时口裂在上中切牙切缘上方 2 mm（假定，沿用 final_female.py）/ at rest the fissure lies 2 mm above the upper incisal edge (assumption, as in final_female.py)


def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


def tree_hash(d):
    """目录里所有文件的 sha256（按相对路径排序）/ sha256 over every file of a directory (sorted by relative path)"""
    h = hashlib.sha256()
    n = 0
    for root, _, files in sorted(os.walk(d)):
        for f in sorted(files):
            p = os.path.join(root, f)
            h.update(os.path.relpath(p, d).encode())
            h.update(hashlib.sha256(open(p, 'rb').read()).digest())
            n += 1
    return {'files': n, 'sha256': h.hexdigest()}


def ansur_norms(stature_mm):
    """ANSUR II 女性：均值、标准差、对身高回归在该身高处的值和残差标准差（mm）/ ANSUR II women: mean, SD, value of the regression on stature at that stature, residual SD (mm)"""
    R = list(csv.DictReader(open(os.path.join(RAW, 'ansur2', 'ANSUR_II_FEMALE_Public.csv'), encoding='latin-1')))
    st = np.array([float(r['stature']) for r in R])
    out = {}
    for k in ANSUR + ['headcircumference', 'earlength', 'earbreadth', 'neckcircumference']:
        y = np.array([float(r[k]) for r in R]) * (0.1 if k == 'interpupillarybreadth' else 1.0)
        b = np.polyfit(st, y, 1)
        out[k] = {'n': len(y), 'mean': float(y.mean()), 'sd': float(y.std(ddof=1)), 'atStature': float(np.polyval(b, stature_mm)), 'residSd': float((y - np.polyval(b, st)).std(ddof=2)), 'values': y}
    return out


def pct(norm, v):
    """v 在 ANSUR II 女性样本里的经验百分位 / empirical percentile of v among ANSUR II women"""
    return round(float((norm['values'] < v).mean() * 100), 1)


class Model:
    """静止姿势下的头：基、性别方向、量度对身份分量的导数（缓存在输出目录）。
    The head in the rest pose: basis, sex direction, derivative of the measures by identity component (cached in the output directory)."""

    def __init__(self, ident, lod, cache, log):
        self.lod, self.F, self.jn, self.wh = lod, mhrlib.faces(lod), mhrlib.joint_names(lod), FF.head_weight(lod)
        self.ident = ident.copy()
        self.ident[20:40] = 0
        if os.path.exists(cache):
            z = np.load(cache)
            self.c_sex, self.J, self.m0, self.explained = z['c_sex'], z['J'], z['m0'], float(z['explained'])
            return
        z0 = np.zeros(204)
        V0, P, _ = mhrlib.run(self.ident, z0, lod, True)
        B = np.zeros((20,) + V0.shape)
        for j in range(20):
            c = self.ident.copy()
            c[20 + j] = 1
            B[j] = mhrlib.run(c, z0, lod, True)[0] - V0
        em = 0.5 * (P[self.jn.index('l_eye')] + P[self.jn.index('r_eye')])
        D = R2.dimorphism_field(V0, self.F, self.wh, em, log)
        m = self.wh > 0.5
        A_, y = B[:, m].reshape(20, -1).T, D[m].ravel()
        self.c_sex = np.linalg.lstsq(A_, y, rcond=None)[0]
        self.explained = float(1 - np.sum((y - A_ @ self.c_sex) ** 2) / np.sum(y ** 2))
        self.m0 = self.measure(np.zeros(20))[0]
        self.J = np.zeros((20, len(MEAS)))
        for j in range(20):
            h = np.zeros(20)
            h[j] = 1.5
            self.J[j] = (self.measure(h)[0] - self.m0) / 1.5
        np.savez(cache, c_sex=self.c_sex, J=self.J, m0=self.m0, explained=self.explained)

    def rest(self, h):
        i2 = self.ident.copy()
        i2[20:40] = h
        V, P, _ = mhrlib.run(i2, np.zeros(204), self.lod, True)
        lips, me = FF.face_landmarks(i2, self.lod)
        L, fiss, ear = HL.head_landmarks(V, self.F, P, self.jn, self.wh, lips, me)
        # 鼻骨下端在皮肤上没有自己的特征：取鼻根点到鼻尖点的鼻背上 40 % 处（假定）/ rhinion has no feature of its own on the skin: taken 40 % of the way down the dorsum from sellion to pronasale (assumption)
        q = V[L['sellion']] + 0.4 * (V[L['pronasale']] - V[L['sellion']])
        mid = np.where((np.abs(V[:, 0]) < 0.0007) & (self.wh > 0.5) & (V[:, 2] > q[2] - 0.01))[0]
        L['rhinionSkin'] = int(mid[np.argmin(np.abs(V[mid, 1] - q[1]))])
        return i2, V, P, L, fiss, ear

    def measure(self, h):
        i2, V, P, L, fiss, ear = self.rest(h)
        m = HL.measures(V, L, ear, self.wh)
        m['ipd'] = round(float(np.linalg.norm(P[self.jn.index('l_eye')] - P[self.jn.index('r_eye')]) * 1000), 1)
        return np.array([m[k] for k in MEAS]), m


def solve_identity(M, k, norms, log, ridge=0.35, bound=2.5):
    """头部身份分量和整头缩放：对 ANSUR II 女性在她身高处的期望值，先验为 k × 性别方向。两步（第二步用实测的量度修正线性化的误差）。
    Head identity and whole-head scale against what ANSUR II women have at her stature, with k x the sex direction as the prior. Two
    passes (the second corrects the linearisation with the measures actually obtained)."""
    from scipy.optimize import lsq_linear
    T = np.array([norms[a]['atStature'] for a in ANSUR])
    sd = np.array([norms[a]['residSd'] for a in ANSUR])
    prior = np.clip(k * (M.c_sex * DAMP + EXTRA), -3.0, 3.0)
    if '--fit-identity' not in sys.argv:
        # 默认：身份分量只取先验（性别方向），大小只用一个整头缩放去对 ANSUR（按残差标准差加权的最小二乘）。
        # 试过让 20 个分量都去凑 ANSUR 的五个量：两颧收窄、面颊出现凹坑，读作消瘦的男性。
        # Default: the identity is the prior alone (the sex direction) and size is matched to ANSUR by the single whole-head scale (least
        # squares weighted by the residual SDs). Letting all 20 components chase the five ANSUR measures was tried: the cheeks narrowed
        # and dimpled and the face read as a gaunt man.
        got = M.measure(prior)[0]
        use = np.array([m_ != 'bizygomaticBreadth' for m_ in MEAS])   # 两颧宽不参与定大小：皮肤上量到的最宽处不等于卡尺压在颧弓上的读数（MHR 的平均头量出来是 155 mm）/ bizygomatic breadth is left out of the size fit: the widest skin point is not what a caliper pressed on the arch reads (MHR's average head measures 155 mm this way)
        s = float(np.sum((got * T / sd ** 2)[use]) / np.sum((got ** 2 / sd ** 2)[use]))
        # 各轴再各自修正，至多 ±4 %（假定的上限，为了不改坏模型自己的眼睑和唇）：x 用头宽和瞳距，y 用耳屏点—头顶高和颏下点—鼻根点长，z 用头长。
        # then one correction per axis, at most +/-4 % (an assumed limit, so that the model's own lids and lips are not distorted): x from head
        # breadth and interpupillary breadth, y from tragion-top of head and menton-sellion length, z from head length.
        ax = []
        for keys in (('headBreadth', 'ipd'), ('earCanalToTopOfHead', 'mentonSellionLength'), ('headLength_glabellaOpisthocranion',)):
            u_ = np.array([m_ in keys for m_ in MEAS])
            ax.append(float(np.sum((got * T / sd ** 2)[u_]) / np.sum((got ** 2 / sd ** 2)[u_])))
        s3 = s * np.clip(np.array(ax) / s, 1 - ANISO, 1 + ANISO)
        log.append(f'  identity for sex strength {k}: isotropic scale {s:.3f}, per-axis scale wanted {np.round(ax, 3).tolist()}, used {np.round(s3, 3).tolist()} (x, y, z); head components {np.round(prior, 2).tolist()}')
        return prior, s3
    best = None
    for s in np.arange(0.90, 1.0001, 0.005):
        A_ = np.vstack([s * M.J.T / sd[:, None], ridge * np.eye(20)])
        b = np.r_[(T - s * M.m0) / sd, ridge * prior]
        r = lsq_linear(A_, b, bounds=(-bound, bound))
        if best is None or r.cost < best[0]:
            best = (r.cost, s, r.x)
    _, s, h = best
    got = M.measure(h)[0]
    A_ = np.vstack([s * M.J.T / sd[:, None], ridge * np.eye(20)])
    b = np.r_[(T - s * got) / sd, ridge * (prior - h)]
    h = np.clip(h + lsq_linear(A_, b, bounds=(-bound - h, bound - h)).x, -bound, bound)
    log.append(f'  identity for sex strength {k}: scale {s:.3f}; head components {np.round(h, 2).tolist()}')
    return h, np.full(3, float(s))


def solve_pose(i2, mp, s, top_y, globe_mid, lod, log):
    """头颈姿势：头的朝向 = 静止朝向；头顶高度 = top_y。
    Head pose: head orientation = rest orientation; top of the head at top_y."""
    from scipy.optimize import least_squares
    from scipy.spatial.transform import Rotation as Rot
    names, jn, wh = mhrlib.param_names(), mhrlib.joint_names(lod), FF.head_weight(lod)
    level = arg('--posture', 'fitted') == 'level'
    idx = [names.index(n) for n in (POSE if level else [])]
    Vr = mhrlib.run(i2, np.zeros(204), lod, True)[0]
    core = wh > 0.999

    def state(x):
        m2 = mp.copy()
        m2[idx] = x
        V, P, _ = mhrlib.run(i2, m2, lod, False)
        V = FF.scale_head(V, P, jn, wh, s)
        piv = P[jn.index('c_head')]
        eye = piv + s * (0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')]) - piv)
        _, R, _ = R2._procrustes(Vr[core], V[core])
        return Rot.from_matrix(R).as_rotvec(), float(V[wh > 0.5][:, 1].max()), eye, m2

    def resid(x):
        rv, top, eye, _ = state(x)
        return np.r_[rv * 20.0, (top - top_y) / 0.001, (x - mp[idx]) * 0.05]
    x0 = mp[idx].copy()
    r = least_squares(resid, x0, diff_step=2e-3, max_nfev=120) if level else type('R', (), {'x': x0})()
    rv0, top0, eye0, _ = state(x0)
    rv, top, eye, m2 = state(r.x)
    info = {'parameters': dict(zip(POSE if level else [], np.round(r.x, 4).tolist())), 'posture': 'level' if level else 'fitted', 'parametersBefore': dict(zip(POSE if level else [], np.round(x0, 4).tolist())),
            'headRotationFromRestDeg_before_xyz': np.round(np.degrees(rv0), 2).tolist(), 'headRotationFromRestDeg_after_xyz': np.round(np.degrees(rv), 2).tolist(),
            'topOfHeadMm': {'target': round(top_y * 1000, 1), 'got': round(top * 1000, 1)},
            'eyeMidpointMinusGlobeMidpointMm_xyz': np.round((eye - globe_mid) * 1000, 1).tolist()}
    log.append(f'  pose: head rotation from the rest orientation {info["headRotationFromRestDeg_before_xyz"]} -> {info["headRotationFromRestDeg_after_xyz"]} deg (x = pitch, negative = face up); '
               f'eye midpoint minus her globe midpoint {info["eyeMidpointMinusGlobeMidpointMm_xyz"]} mm')
    return m2, info


def join_weight(V, P, jn, lod, A, t0=T0, t1=T1):
    """接缝权重：0 = 原皮肤，1 = 新头。沿颈轴（颈关节到头关节）的归一化高度 t，在 t0–t1 之间平滑过渡；只对头颈蒙皮的顶点。
    Join weight: 0 = shipped skin, 1 = new head. Smooth step between t0 and t1 of the normalised height t along the neck axis (neck
    joint to head joint); head-and-neck-skinned vertices only."""
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    hn = np.array([n.startswith(('c_neck', 'c_head', 'c_jaw', 'c_teeth', 'c_tongue', 'l_eye', 'r_eye')) for n in jn]) * 1.0
    wn = np.zeros(len(V))
    np.add.at(wn, vi, w * hn[ji])
    a = P[jn.index('c_head')] - P[jn.index('c_neck')]
    t = (V - P[jn.index('c_neck')]) @ a / (a @ a)
    u = np.clip((t - t0) / (t1 - t0), 0, 1)
    b = u * u * (3 - 2 * u) * np.clip(2 * wn, 0, 1)
    for _ in range(6):
        b = 0.5 * b + 0.5 * (A @ b)
    return np.clip(b, 0, 1), t


def brow_faces(Vr, Pr, jn, F, sex='F'):
    """渲染用的眉毛替身：静止头上、眼关节上方一条带内的皮肤三角形（返回面下标）。不是解剖部件，也不是交付物。
    女：眉头在眼中心上方 21.8 mm，眉峰在外侧 14 mm 处高 25.6 mm，眉梢 21.5 mm；宽约 4 -> 1.4 mm（假定值，见报告）。
    The stand-in eyebrow of the renders: the skin triangles inside a band above the eye joint on the rest head (face indices). Neither an
    anatomical part nor a deliverable. Female: head of the brow 21.8 mm above the eye centre, peak 25.6 mm at 14 mm lateral, tail 21.5 mm;
    about 4 -> 1.4 mm wide (assumptions; see the report)."""
    C = Vr[F].mean(1)
    out = np.zeros(len(F), bool)
    for sg, j in ((1, 'l_eye'), (-1, 'r_eye')):
        e = Pr[jn.index(j)]
        u, v = (C[:, 0] - e[0]) * sg * 1000, (C[:, 1] - e[1]) * 1000
        v0 = np.interp(u, [-16, -8, 0, 8, 14, 20, 27], [21.8, 22.8, 23.9, 25.0, 25.6, 24.6, 21.5])
        hw = np.interp(u, [-16, -8, 14, 27], [1.9, 2.1, 1.5, 0.7])
        out |= (u > -16) & (u < 27) & (np.abs(v - v0) < hw) & (C[:, 2] > e[2])
    return np.where(out)[0]


def membrane(V, F, lod):
    """封住睑裂的三角形带（用开口工具自己的函数找）；找不到就抛出异常 —— 这同时是“开口工具能在这张皮肤上找到线”的检查。
    The strips of triangles closing the palpebral fissures, found with the opening tool's own function; raises if it fails, which makes
    this the check that the opening tool finds its lines on this skin."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'skinopen'))
    import open_skin as OS
    reg = ES.face_protect(lod)[1]
    hm = OS.half_edge_map(F)
    path, sharp = OS.find_oral_fissure(V, F, reg['lips'])
    out = {'oralFissure': path, 'sharp': sharp}
    for S_ in 'LR':
        strip, loop, ends = OS.find_eye_membrane(V, F, reg['lids' + S_], hm)
        out[S_] = (np.asarray(strip), np.asarray(loop))
    return out


def build(M, k, st, V_ship, fb, norms, A, log):
    """强度 k 的新头：返回全身皮肤（顶点顺序不变）和各种中间量 / the new head at strength k: the whole-body skin (vertex order unchanged) and the intermediates"""
    lod, F, jn, wh = M.lod, M.F, M.jn, M.wh
    h, s = solve_identity(M, k, norms, log)
    i2, Vr, Pr, L, fiss, ear = M.rest(h)
    gl, gr = fb.verts('Left vitreous body').mean(0), fb.verts('Right vitreous body').mean(0)
    mp2, pose = solve_pose(i2, st['mp'].astype(float), s, float(V_ship[:, 1].max()), 0.5 * (gl + gr), 1, log)
    # 头不带 MHR 的姿势修正形：颈后仰、头前屈相抵的这组参数会触发修正形，在口角两侧和下颊留下凹坑（头上最多 6 mm；看图确认）
    # the head is taken without MHR's pose correctives: the opposing neck and head bends of this pose trigger them and they leave dents beside the
    # mouth corners and on the lower cheek (up to 6 mm on the head; confirmed in renders)
    Vm, P, _ = mhrlib.run(i2, mp2, lod, False)
    H = FF.scale_head(Vm, P, jn, wh, s)
    piv = P[jn.index('c_head')]
    eyes = {S_: piv + s * (P[jn.index(j)] - piv) for S_, j in (('L', 'l_eye'), ('R', 'r_eye'))}
    # --vault-percentile <P>：颅盖加高，使“耳屏点—头顶”落在 ANSUR II 女性的第 P 百分位（经验分布）。理由：模型的颅盖比她的颅骨矮，
    # 不加高就得把她的颅骨压扁（颅顶—鼻根 −7 %，颅顶处头皮只剩 2 mm）；脸不动，头发盖住颅盖。做法：眼关节上方 12 mm 以上的头部顶点
    # 竖直上移 Δ·g(t)，t 为该点在这个高度到头顶之间的比例，g(t) = 2t² − t³（起点处斜率为零，单调）；Δ = 目标值 − 现在的值。
    # 给了 --stature 时整头再下移 Δ，头顶仍落在钉住的身高上，于是脸相对她的颅骨低了 Δ。不给这个选项时与原来完全相同。
    # --vault-percentile <P>: the vault is made taller so that tragion-to-top-of-head lies at the P-th percentile of ANSUR II women (the
    # empirical distribution). Reason: the model's vault is lower than her skull, and without this her skull has to be squashed (vertex
    # to nasion -7 %, 2 mm of scalp left at the vertex); the face is not touched and hair covers the vault. Head vertices more than
    # 12 mm above the eye joints move up by D*g(t), t their fraction of the way from that level to the top, g(t) = 2t^2 - t^3 (zero slope
    # at the start, monotone); D = wanted value - present value. With --stature the whole head then moves down by D so that its top
    # still stands at the pinned stature, which puts the face D lower on her skull. Without the option nothing changes.
    vault_up = 0.0
    if arg('--vault-percentile') is not None:
        pv = float(arg('--vault-percentile'))
        assert 40 <= pv <= 90, 'vault percentile outside 40-90'
        hv = wh > 0.5
        yb = float(np.mean([e_[1] for e_ in eyes.values()])) + 0.012
        top = float(H[hv][:, 1].max())
        now = M.measure(h)[0][MEAS.index('earCanalToTopOfHead')] * s[1]
        want = float(np.percentile(norms['tragiontopofhead']['values'], pv))
        vault_up = (want - now) / 1000
        assert 0 <= vault_up < 0.012, f'vault change {vault_up * 1000:.1f} mm outside 0-12 mm'
        tt = np.clip((H[:, 1] - yb) / (top - yb), 0, 1)
        H = H.copy()
        H[:, 1] += np.where(hv, 1.0, 0.0) * vault_up * (2 * tt ** 2 - tt ** 3)
        pose['vault'] = {'percentileWanted': pv, 'tragionToTopWantedMm': round(want, 1), 'tragionToTopBeforeMm': round(float(now), 1), 'raisedByMm': round(vault_up * 1000, 1), 'fromHeightAboveTheEyeJointsMm': 12.0,
                         'largestLocalVerticalStretch': round(float(vault_up / (top - yb) * 4 / 3), 3), 'rule': 'head vertices above that level move up by D*(2t^2 - t^3); the face is not touched', 'norm': 'ANSUR II women, tragiontopofhead, empirical percentile'}
        log.append(f'  vault: {json.dumps(pose["vault"])}')
    # 放平以后的头在这条颈上比她的颅骨靠前约 28 mm（两眼中点对她的眼球中点）。颈椎不会动，所以头整体平移回她颅骨所在的地方（只移 x、z），
    # 这段平移由混合带吸收：带以上是平移后的干净的头，带以下是原皮肤。
    # Levelled on this neck, the head lies about 28 mm in front of her skull (eye midpoint against the midpoint of her globes). The cervical
    # spine is not going to move, so the whole head is translated back to where her skull is (x and z only); the blend band takes up the
    # shift: above it the clean head, translated, below it the shipped skin.
    # fitted：三个方向都移（两眼中点落在她眼球中点上；她的面颅、下颌、舌骨相对颈椎的高度不变，身高由此而定）；level：只移 x、z（头顶高度已解出）
    # fitted: all three directions (the eye midpoint lands on the midpoint of her globes; her facial skeleton, mandible and hyoid keep their height on the
    # cervical spine and the stature follows from that); level: x and z only (the height of the top was solved)
    shift = (0.5 * (gl + gr) - 0.5 * (eyes['L'] + eyes['R'])) * ([1, 0, 1] if arg('--posture', 'fitted') == 'level' else [1, 1, 1])
    # --head-shift "x,y,z[,t0,t1]"（毫米）：不按她现在的眼球定平移，直接给出整头的平移（几何管线把颅骨重新摆位之后用）；后两个数可选，
    # 是混合带在颈轴上的范围（缺省 T0、T1）。不给这个选项时与原来完全相同。
    # --head-shift "x,y,z[,t0,t1]" (mm): the translation of the whole head is given outright instead of being taken from her present globes
    # (for use once the geometry pipeline has re-posed the skull); the optional last two numbers are the extent of the blend band along the
    # neck axis (T0 and T1 when absent). Without the option nothing changes.
    hs = [float(x) for x in arg('--head-shift').split(',')] if arg('--head-shift') is not None else None
    if hs is not None:
        shift = np.array(hs[:3]) / 1000
    # --stature <米>：整头上下平移到头顶落在这个身高处（脚底不动），取代平移的 y 分量。放平的头在解姿势时头顶守在原皮肤的高度，
    # 所以 y = 目标身高 − 原皮肤的身高。钉住的值和理由见 PINNED_STATURE；不给这个选项时与原来完全相同。
    # --stature <m>: the whole head is moved vertically until its top is at this stature (the soles stay), replacing the y component of the
    # translation. The levelled head was solved with its top held at the shipped height, so y = wanted stature - shipped stature. The pinned
    # value and its reason are in PINNED_STATURE; without the option nothing changes.
    if arg('--stature') is not None:
        shift = np.array([shift[0], float(arg('--stature')) - float(np.ptp(V_ship[:, 1])) - vault_up, shift[2]])
        pose['statureWantedM'] = float(arg('--stature'))
        pose['pinnedStature'] = PINNED_STATURE
    H = H + shift
    eyes = {k_: v + shift for k_, v in eyes.items()}
    pose['rigidShiftOfTheHeadMm_xyz'] = np.round(shift * 1000, 1).tolist()
    log.append(f'  head translated by {pose["rigidShiftOfTheHeadMm_xyz"]} mm (x, z) onto her globes; taken up by the blend band')
    b, t = join_weight(V_ship, P, jn, lod, A, *(hs[3:5] if hs is not None and len(hs) >= 5 else (T0, T1)))
    pose['blendBand_neckAxisFraction'] = [float(x) for x in (hs[3:5] if hs is not None and len(hs) >= 5 else (T0, T1))]
    V = V_ship + b[:, None] * (H - V_ship)
    # 带内再做几遍位置平滑（权重 4b(1-b)，两端为 0）：原皮肤在这里带着外推留下的细小起伏，混合后在颈前正中成了一块粗糙面
    # a few passes of position smoothing inside the band (weight 4b(1-b), zero at both ends): the shipped skin carries the fine relief of its
    # enclosure push here, which the blend turned into a rough patch at the front of the neck
    wsm = (4 * b * (1 - b))[:, None]
    for _ in range(10):
        V = V + 0.5 * wsm * (A @ V - V)
    return {'k': k, 'h': h, 's': s, 'ident': i2, 'mp': mp2, 'pose': pose, 'V': V, 'H': H, 'P': P, 'b': b, 't': t, 'L': L, 'fiss': fiss, 'ear': ear, 'eyes': eyes,
            'Vr': Vr, 'Pr': Pr, 'restMeasures': M.measure(h)[1]}


def pitched(layers, c, deg):
    """只为显示：把各图层绕过 c 的左右轴转 deg 度 / for display only: every layer turned by deg about the left-right axis through c"""
    a = np.radians(deg)
    R = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    return [((l[0] - c) @ R.T + c, *l[1:]) for l in layers]


def head_layers(V, F, lod, brow=None, eyes=None, radius=0.012, fb=None, drop=True):
    """一个头的渲染图层：皮肤（去掉封住睑裂的带）、眉、眼球。fb 给定时用那副人体自己的眉毛部件和巩膜、角膜。
    Render layers of one head: skin (without the strips over the fissures), brow, globes. With fb, that body's own eyebrow part, sclera and cornea are used."""
    keep = np.ones(len(F), bool)
    if drop:
        try:
            mb = membrane(V, F, lod)
            keep[mb['L'][0]] = keep[mb['R'][0]] = False
        except Exception as e:   # 发布的头上眼睑带可能已变形 / the lid strip of a shipped head may have been deformed
            print('  membrane not found for a render layer:', e)
    layers = [(V, F[keep], HL.SKIN)]
    if brow is not None:
        n = vertex_normals(V, F)
        layers.append((V + 0.0006 * n, F[brow], (0.22, 0.16, 0.11)))
    if fb is not None:
        v, f = fb.mesh(fb.find('Eyebrow')[0])
        layers.append((v, f, (0.22, 0.16, 0.11)))
        for p in fb.parts:
            nm = p['name'].lower()
            if 'sclera' in nm or 'cornea' in nm:
                layers.append((*fb.mesh(p), (0.95, 0.95, 0.95) if 'sclera' in nm else (0.25, 0.2, 0.18)))
    if eyes is not None:
        for c in eyes.values():
            layers.append((*HL.sphere(c, radius), (0.95, 0.95, 0.95)))
            layers.append((*HL.sphere(c + [0, 0, radius - 0.0042], 0.0062, 12), (0.25, 0.2, 0.18)))
    return layers


def skull_points(fb):
    """她现在颅骨上的标志点：face_female / face_r2 找到的那些，加上颅顶点、颅后点、颅侧点、乳突尖（按几何）。
    Landmarks on her present skull: those found by face_female / face_r2, plus vertex, opisthocranion, euryon and mastoid tip (by geometry)."""
    lm = R2.fix_landmarks(FFACE.landmarks(fb), fb)
    B = {k: np.asarray(v['bone'], float) for k, v in lm.items()}
    vault = np.vstack([fb.verts(n) for n in ('Frontal bone', 'Occipital bone', 'Left parietal bone', 'Right parietal bone', 'Left temporal bone', 'Right temporal bone')])
    occ = fb.verts('Occipital bone')
    B['vertex'] = vault[np.argmax(vault[:, 1])]
    om = occ[np.abs(occ[:, 0] - B['nasion'][0]) < 0.006]
    B['opisthocranion'] = om[np.argmax(np.linalg.norm(om - B['glabella'], axis=1))]
    B['euryon_L'], B['euryon_R'] = vault[np.argmax(vault[:, 0])], vault[np.argmin(vault[:, 0])]
    for S_, n in (('L', 'Left temporal bone'), ('R', 'Right temporal bone')):
        tb = fb.verts(n)
        sg = 1 if S_ == 'L' else -1
        lat = tb[(tb[:, 0] - B['nasion'][0]) * sg > 0.045]   # 茎突在内侧，不算 / the styloid process lies medially and is left out
        B['mastoid_' + S_] = lat[np.argmin(lat[:, 1])]
        # 颧点：颧弓（颧骨 + 颞骨颧突）上最靠外的点；face_female 的 zygion 只在颧骨上找，偏前
        # zygion: the most lateral point of the zygomatic arch (zygomatic bone + zygomatic process of the temporal); face_female looks on the zygomatic bone only, which is too far forward
        zb = np.vstack([tb, fb.verts(n.replace('temporal', 'zygomatic'))])
        y0 = B['zygion_' + S_][1]
        arch = zb[(zb[:, 1] > y0 - 0.008) & (zb[:, 1] < y0 + 0.008) & (zb[:, 2] > B['mastoid_' + S_][2] + 0.015)]
        B['zygion_' + S_] = arch[np.argmax(arch[:, 0] * sg)]
    return B


def main():
    out_name = arg('--out', 'female-head-outline')
    assert out_name.startswith('female-head-outline'), 'this tool writes female-head-outline* directories only'
    out = os.path.join(RAW, 'out', out_name)
    os.makedirs(out, exist_ok=True)
    for tok in [t for t in arg('--extra', '').split(',') if t]:   # --extra "0:-1.0,1:-0.5"：改 EXTRA / overrides EXTRA
        EXTRA[int(tok.split(':')[0])] = float(tok.split(':')[1])
    k_main = float(arg('--sex', '1.0'))
    strengths = [float(x) for x in arg('--strengths', '0.5,1,1.5').split(',')]
    before = {d: tree_hash(os.path.join(RAW, 'out', d)) for d in SHIPPED}
    log = [f'female head outline: sex strength {k_main}; written to {out_name}/']
    src = os.path.join(RAW, 'out', 'female-skin')
    st = np.load(os.path.join(src, 'fit-state-final.npz'))
    lod = int(st['lod'])
    V_ship, F_obj = __import__('reissue_r2').load_obj(os.path.join(src, 'skin.obj'))
    F = mhrlib.faces(lod)
    assert np.array_equal(F_obj, F), 'faces of the shipped skin differ from MHR'
    fb = Body('female')
    A = ES.adjacency(len(V_ship), F)
    stature = float(np.ptp(V_ship[:, 1]))
    # 给了 --stature 时，头的大小按新的身高处 ANSUR 的期望值定 / with --stature the head is sized to what ANSUR expects at the new stature
    norms = ansur_norms((float(arg('--stature')) if arg('--stature') is not None else stature) * 1000)
    M = Model(st['identity'].astype(float), lod, os.path.join(out, 'model-cache.npz'), log)
    log.append(f'  sex direction: MakeHuman female-minus-neutral projected on MHR head components 20-39, explains {100 * M.explained:.0f} % of the field on the head; '
               f'coefficients per unit strength {np.round(M.c_sex, 2).tolist()}')
    jn, wh = M.jn, M.wh

    # ---- 各强度的头和对比图 / heads at the strengths and the comparison sheets
    R = {k: build(M, k, st, V_ship, fb, norms, A, log) for k in sorted(set(strengths + [k_main]))}
    r = R[k_main]
    V, L, P = r['V'], r['L'], r['P']
    reg = ES.face_protect(lod)[1]
    mb = membrane(V, F, lod)   # 开口工具的线在新皮肤上找得到 / the opening tool's lines are found on the new skin
    rad = {}
    for S_ in 'LR':
        d = np.linalg.norm(V[mb[S_][1]] - r['eyes'][S_], axis=1) * 1000
        rad[S_] = {'lidMarginToEyeJointMm': {'min': round(float(d.min()), 2), 'median': round(float(np.median(d)), 2), 'max': round(float(d.max()), 2)}, 'marginVertices': int(len(d)),
                   'membraneTriangles': int(len(mb[S_][0]))}
    # 眼球半径：睑缘（皮肤外表面）到眼关节的最小距离减 1 mm（假定：睑缘内唇在外表面内约 1 mm 处贴着眼球）
    # globe radius: least distance from the lid margin (outer skin surface) to the eye joint minus 1 mm (assumption: the inner lip of the margin lies on the globe about 1 mm inside the outer surface)
    globe_r = float(np.mean([rad[S_]['lidMarginToEyeJointMm']['min'] for S_ in 'LR']) - 1.0) / 1000
    scl = fb.verts('Left sclera')
    r_now = float(np.median(np.linalg.norm(scl - scl.mean(0), axis=1)))
    # 另一种给法：眼球保持她现在的半径，球心沿前后方向放在睑缘之后（睑缘各点到球心的距离的最小值 = 半径 + 1 mm）
    # the alternative: the globe keeps its present radius and its centre is placed behind the lid margins along z (least distance from the margin points to the centre = radius + 1 mm)
    alt = {}
    for S_ in 'LR':
        c = r['eyes'][S_].copy()
        mv = V[mb[S_][1]]
        zs = np.linspace(0, 0.006, 121)
        dmin = np.array([np.linalg.norm(mv - (c + [0, 0, z]), axis=1).min() for z in zs])
        alt[S_] = c + [0, 0, float(zs[np.argmin(np.abs(dmin - (r_now + 0.001)))])]
    em = 0.5 * (r['eyes']['L'] + r['eyes']['R'])
    top = float(V[:, 1].max())
    brow = brow_faces(r['Vr'], r['Pr'], jn, F)
    Vmale = __import__('reissue_r2').load_obj(os.path.join(RAW, 'out', 'male-skin', 'skin.obj'))[0]
    mbody = Body('male')
    eye_of = lambda b_: 0.5 * (b_.verts('Left vitreous body').mean(0) + b_.verts('Right vitreous body').mean(0))
    tilt = -float(r['pose']['headRotationFromRestDeg_after_xyz'][0])
    new_l = head_layers(V, F, lod, brow, r['eyes'], globe_r)
    rows = [(f'NEW female head (sex strength {k_main}), as it stands on her neck; brow = stand-in strip, globes = target spheres', new_l, em, top),
            (f'NEW female head, the same, turned {tilt:.1f} deg about the left-right axis FOR DISPLAY ONLY (head level)', pitched(new_l, em, tilt), em, top),
            ('female, shipped package (her own eyebrow part and globes)', head_layers(V_ship, F, lod, fb=fb), eye_of(fb), float(V_ship[:, 1].max())),
            ('male, shipped package', head_layers(Vmale, F, lod, fb=mbody), eye_of(mbody), float(Vmale[:, 1].max()))]
    HL.sheet(rows, os.path.join(out, 'heads_new-shipped-male.png'), height=1000)
    rows = []
    for k in strengths:
        q = R[k]
        qe = 0.5 * (q['eyes']['L'] + q['eyes']['R'])
        rows.append((f'new head, sex strength {k} (scale x, y, z {np.round(q["s"], 3).tolist()}), turned level for display', pitched(head_layers(q['V'], F, lod, brow_faces(q['Vr'], q['Pr'], jn, F), q['eyes'], globe_r), qe, tilt),
                     qe, float(q['V'][:, 1].max())))
    HL.sheet(rows, os.path.join(out, 'heads_sex-strengths.png'), height=800)

    # ---- 量度 / measurements
    p = lambda name: V[L[name]]
    m_new = HL.measures(V, L, r['ear'], wh)
    m_new['ipd'] = round(float(np.linalg.norm(r['eyes']['L'] - r['eyes']['R']) * 1000), 1)
    st_old = st['identity'].astype(float)
    io, Vro, Pro, Lo, fo, earo = M.__class__.rest(type('X', (), {'ident': st_old, 'lod': lod, 'F': F, 'jn': jn, 'wh': wh})(), st_old[20:40])
    m_old = HL.measures(V_ship, Lo, earo, wh)   # 发布的头：同一批顶点下标读在发布的皮肤上（它在身份拟合之后又变形过，所以只是近似）/ shipped head: the same vertex indices read on the shipped skin (warped after its identity fit, so approximate)
    m_old['ipd'] = round(float(np.linalg.norm(fb.verts('Left vitreous body').mean(0) - fb.verts('Right vitreous body').mean(0)) * 1000), 1)
    m_male = HL.measures(Vmale, M.rest(np.zeros(20))[3], r['ear'], wh)
    meas = {}
    for mk, ak in zip(MEAS, ANSUR):
        nrm = norms[ak]
        meas[mk] = {'shippedFemaleMm': m_old.get(mk), 'newMm': m_new[mk], 'ansurFemale': {'variable': ak, 'mean': round(nrm['mean'], 1), 'sd': round(nrm['sd'], 2), 'expectedAtHerStature': round(nrm['atStature'], 1)},
                    'percentileAmongAnsurWomen': {'shipped': pct(nrm, m_old[mk]) if mk in m_old else None, 'new': pct(nrm, m_new[mk])}}
    for mk in m_new:
        if mk not in meas:
            meas[mk] = {'shippedFemaleMm': m_old.get(mk), 'newMm': m_new[mk], 'maleShippedMm_sameVertexIndices': m_male.get(mk)}
    meas['headHeightOverStature_mentonToTop'] = {'shipped': round(m_old['mentonToTopOfHead'] / stature / 1000, 4), 'new': round(m_new['mentonToTopOfHead'] / float(np.ptp(V[:, 1])) / 1000, 4)}

    # ---- 接缝 / the join
    b = r['b']
    band = (b > 0.01) & (b < 0.99)
    ring = np.where(np.abs(b - 0.5) < 0.08)[0]
    n_new, n_ship, n_head = vertex_normals(V, F), vertex_normals(V_ship, F), vertex_normals(r['H'], F)
    angd = lambda a_, b_: np.degrees(np.arccos(np.clip(np.einsum('ij,ij->i', a_, b_), -1, 1)))
    low, high = (b <= 0.01) & (A @ (b > 0.01).astype(float) > 0), (b >= 0.99) & (A @ (b < 0.99).astype(float) > 0)
    gap = np.linalg.norm(r['H'] - V_ship, axis=1) * 1000
    # 相邻顶点法线夹角：带内与两侧原样的面相比 / angle between the normals of neighbouring vertices: inside the band against the two surfaces as they are
    E = np.array(A.nonzero()).T
    eb = E[band[E].all(1)]
    rough = lambda nn: float(np.percentile(angd(nn[eb[:, 0]], nn[eb[:, 1]]), 99))
    join = {'band': {'neckAxisFraction_from_to': [T0, T1], 'vertices': int(band.sum()), 'heightMm_min_max': [round(float(V[band, 1].min() * 1000), 1), round(float(V[band, 1].max() * 1000), 1)]},
            'ring_halfWeightLine': {'vertices': int(len(ring)), 'meanHeightMm': round(float(V[ring, 1].mean() * 1000), 1), 'centre': np.round(V[ring].mean(0), 4).tolist(),
                                    'heightBelowMentonMm': round(float((p('menton')[1] - V[ring, 1].mean()) * 1000), 1)},
            'positionResidualMm': {'atLowerEdge_newMinusShipped_max': round(float(np.linalg.norm(V - V_ship, axis=1)[low].max() * 1000), 3),
                                   'atUpperEdge_newMinusCleanHead_max': round(float(np.linalg.norm(V - r['H'], axis=1)[high].max() * 1000), 3)},
            'normalResidualDeg': {'atLowerEdge_newVsShipped_max': round(float(angd(n_new, n_ship)[low].max()), 2), 'atUpperEdge_newVsCleanHead_max': round(float(angd(n_new, n_head)[high].max()), 2)},
            'cleanHeadMinusShippedInBandMm': {'median': round(float(np.median(gap[band])), 2), 'p95': round(float(np.percentile(gap[band], 95)), 2), 'max': round(float(gap[band].max()), 2)},
            'neighbourNormalAngleInBandDeg_p99': {'new': round(rough(n_new), 2), 'shipped': round(rough(n_ship), 2), 'cleanHead': round(rough(n_head), 2)},
            'verticesUnchangedBelowTheBand': int((np.linalg.norm(V - V_ship, axis=1) < 1e-9).sum()), 'verticesTotal': int(len(V))}

    # ---- 颈部深层结构是否仍被包住（颈部内部结构不会被变形）/ are the deep parts of the neck still enclosed (the neck internals are not going to be warped)
    Pd, grp, pid, parts = ES.deep_samples(fb)
    nb = (Pd[:, 1] > V[band, 1].min() - 0.01) & (Pd[:, 1] < p('menton')[1] + 0.01)
    s_new, s_old = signed_distance(Pd[nb], V, F) * 1000, signed_distance(Pd[nb], V_ship, F) * 1000
    hn = FF.head_blend(lod, A, V_ship, fb)
    rows_n = []
    for kk in np.unique(pid[nb]):
        mk_ = pid[nb] == kk
        if s_new[mk_].max() > 0 and s_new[mk_].max() > s_old[mk_].max() + 0.2:
            rows_n.append({'id': parts[kk]['id'], 'name': parts[kk]['name'], 'tissue': parts[kk]['tissue'], 'maxOutsideShippedMm': round(float(s_old[mk_].max()), 1),
                           'maxOutsideNewMm': round(float(s_new[mk_].max()), 1), 'shareOutsideNew': round(float((s_new[mk_] > 0).mean()), 3)})
    rows_n.sort(key=lambda q: -q['maxOutsideNewMm'])

    # ---- 标志点、厚度、她现在的颅骨到新皮肤 / landmarks, depths and her present skull against the new skin
    B = skull_points(fb)
    lm_out, pairs = {}, []
    for name, vi_ in sorted(L.items()):
        base = name.split('_')[0]
        side = name[len(base):]
        pos, nrm = V[vi_], n_new[vi_]
        e = {'vertexIndex': int(vi_), 'position': np.round(pos, 5).tolist(), 'outwardNormal': np.round(nrm, 4).tolist()}
        if base in DEPTH:
            bone, dmm, sd, srcd = DEPTH[base]
            e.update({'bonyLandmark': bone + (' ' + side[1:] if side else ''), 'softTissueDepthMm': dmm, 'depthSdMm': sd, 'depthSource': srcd, 'assumedDepth': srcd.startswith('ASSUMPTION'),
                      'boneTarget_skinMinusDepthAlongNormal': np.round(pos - dmm / 1000 * nrm, 5).tolist()})
            bk = BONE_KEY.get(base, base) + side
            if bk in B and base != 'earCanal':
                cur = B[bk]
                tgt = pos - dmm / 1000 * nrm
                e['presentBone'] = {'position': np.round(cur, 5).tolist(), 'signedDistanceToNewSkinMm_negativeInside': round(float(signed_distance(cur[None], V, F)[0] * 1000), 1),
                                    'signedDistanceToShippedSkinMm': round(float(signed_distance(cur[None], V_ship, F)[0] * 1000), 1),
                                    'moveToTargetMm_xyz': np.round((tgt - cur) * 1000, 1).tolist(), 'moveToTargetMm': round(float(np.linalg.norm(tgt - cur) * 1000), 1)}
                pairs.append((name, cur, tgt))
            else:
                e['presentBone'] = None
        else:
            e['note'] = 'skin landmark without a tabled depth; given for orientation and measurement'
        lm_out[name] = e
    X, Y = np.array([q[1] for q in pairs]), np.array([q[2] for q in pairs])
    s_sim, R_sim, t_sim = R2._procrustes(X, Y)
    from scipy.spatial.transform import Rotation as Rot
    res = (s_sim * X @ R_sim.T + t_sim) - Y
    for (name, _, _), d in zip(pairs, res):
        lm_out[name]['presentBone']['residualAfterBestSimilarityMm'] = round(float(np.linalg.norm(d) * 1000), 1)
        lm_out[name]['presentBone']['residualAfterBestSimilarityMm_xyz'] = np.round(-d * 1000, 1).tolist()
    T = {q[0]: q[2] for q in pairs}
    dist = lambda D_, a_, b_: float(np.linalg.norm(D_[a_] - D_[b_]) * 1000)
    Bp = {q[0]: q[1] for q in pairs}
    dims = {}
    for nm, a_, b_ in (('cranialBreadth_euryon', 'euryon_L', 'euryon_R'), ('cranialLength_glabellaOpisthocranion', 'glabella', 'opisthocranion'), ('bizygomatic', 'zygion_L', 'zygion_R'),
                       ('bigonial', 'gonion_L', 'gonion_R'), ('faceHeight_nasionMenton', 'sellion', 'menton'), ('vertexToMenton', 'vertex', 'menton'), ('vertexToNasion', 'vertex', 'sellion'),
                       ('upperFace_nasionSubnasale', 'sellion', 'subnasale'), ('midRamusBreadth', 'midRamus_L', 'midRamus_R'), ('biorbital_midSupraorbital', 'superciliare_L', 'superciliare_R')):
        now, want = dist(Bp, a_, b_), dist(T, a_, b_)
        dims[nm] = {'presentBoneMm': round(now, 1), 'impliedByNewSkinMm': round(want, 1), 'changePercent': round(100 * (want / now - 1), 1), 'flagOver10Percent': bool(abs(want / now - 1) > 0.10)}
    gl, gr = fb.verts('Left vitreous body').mean(0), fb.verts('Right vitreous body').mean(0)
    globes = {'targetRadiusMm': round(globe_r * 1000, 2), 'radiusRule': 'least distance from the lid margin (outer skin surface, found by the opening tool) to the eye joint, mean of both sides, minus 1 mm (ASSUMPTION)',
              'presentScleraRadiusMm_medianDistanceToItsCentroid': round(r_now * 1000, 2), 'scaleForTheGlobes': round(globe_r / r_now, 3), 'lids': rad,
              'L': {'targetCentre': np.round(r['eyes']['L'], 5).tolist(), 'presentCentre_vitreousCentroid': np.round(gl, 5).tolist(), 'moveMm_xyz': np.round((r['eyes']['L'] - gl) * 1000, 1).tolist()},
              'R': {'targetCentre': np.round(r['eyes']['R'], 5).tolist(), 'presentCentre_vitreousCentroid': np.round(gr, 5).tolist(), 'moveMm_xyz': np.round((r['eyes']['R'] - gr) * 1000, 1).tolist()},
              'alternative_keepPresentRadius': {'radiusMm': round(r_now * 1000, 2), 'L': np.round(alt['L'], 5).tolist(), 'R': np.round(alt['R'], 5).tolist(),
                                                'forwardOfTheEyeJointMm': round(float((alt['L'][2] - r['eyes']['L'][2]) * 1000), 2),
                                                'rule': 'present globe radius kept; centre moved forward from the eye joint until the nearest lid-margin point is radius + 1 mm away (ASSUMPTION)'},
              'interGlobeMm': {'present': round(float(np.linalg.norm(gl - gr) * 1000), 1), 'target': m_new['ipd']},
              'note': 'the target centre is the MHR eye joint of the new head (the centre the model turns its eye about); the lids of the clean model are shaped round a globe there'}
    ui = np.vstack([fb.verts(n) for n in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')])
    edge = ui[np.argmin(ui[:, 1])]
    path = mb['oralFissure']
    sto = V[path[len(path) // 2]]
    oral = {'fissureVertexIndices_rightCornerToLeft': [int(x) for x in path], 'fissurePositions': np.round(V[path], 5).tolist(), 'stomion': np.round(sto, 5).tolist(),
            'lengthMm': round(float(np.linalg.norm(np.diff(V[path], axis=0), axis=1).sum() * 1000), 1), 'sharpnessDeg_median': round(float(np.median(mb['sharp'][path])), 1),
            'incisalRelation': {'rule': 'at rest the oral fissure (stomion) lies 2 mm above the incisal edge of the upper central incisors (ASSUMPTION carried over from final_female.py; the usual clinical statement '
                                        'is a resting display of 1-3 mm, not checked against a source); the labial face of the upper incisors lies behind labrale superius by the upper-lip depth',
                                'targetUpperIncisalEdge': np.round([sto[0], sto[1] - INCISOR_SHOW, p('labraleSuperius')[2] - DEPTH['labraleSuperius'][1] / 1000], 5).tolist(),
                                'presentUpperIncisalEdge_lowestPointOfTheUpperCentralIncisors': np.round(edge, 5).tolist(),
                                'moveMm_xyz': np.round((np.array([sto[0], sto[1] - INCISOR_SHOW, p('labraleSuperius')[2] - DEPTH['labraleSuperius'][1] / 1000]) - edge) * 1000, 1).tolist()}}
    brow_spec = {'standInOnly': True, 'what': 'skin triangles of the new head inside a band above the eye joint, drawn dark 0.6 mm outside the skin in the renders; not a part, not a deliverable',
                 'bandOnTheRestHead_mmFromEyeJoint': {'lateralOffset_u': [-16, -8, 0, 8, 14, 20, 27], 'centreHeightAboveEyeCentre': [21.8, 22.8, 23.9, 25.0, 25.6, 24.6, 21.5], 'halfWidth_at_u': {'-16': 1.9, '-8': 2.1, '14': 1.5, '27': 0.7}},
                 'relationToSupraorbitalMargin': 'the skin point over the mid-supraorbital margin (superciliare) of this head lies %.1f mm above the eye centre (rest head); the band centre above the pupil is 23.9 mm, '
                                                 'i.e. the stand-in brow lies above that point, arching to its highest about 14 mm lateral to the pupil. UNVERIFIED: no published female brow-position table was opened.'
                                                 % float((r['Vr'][L['superciliare_L']][1] - r['Pr'][jn.index('l_eye')][1]) * 1000), 'triangles': int(len(brow))}

    # ---- 写文件 / write
    idx = np.where(b > 0.01)[0]
    remap = -np.ones(len(V), int)
    remap[idx] = np.arange(len(idx))
    Fh = F[(b[F] > 0.01).all(1)]
    note = 'MHR LOD%d topology (Meta MHR, Apache-2.0); metres, Y up, +Z anterior, +X body left' % lod
    write_obj(os.path.join(out, 'head-skin.obj'), V[idx], remap[Fh], 'female head and neck patch (open at the neck), ' + note + '; vertex i = vertex head-skin-vertex.u32[i] of the whole skin')
    idx.astype('<u4').tofile(os.path.join(out, 'head-skin-vertex.u32'))
    write_obj(os.path.join(out, 'skin-with-new-head.obj'), V, F, 'female skin with the new head joined, same vertex order and count as female-skin/skin.obj; ' + note)
    Vm_new = FF.scale_head(*mhrlib.run(r['ident'], r['mp'], lod, False)[:2], jn, wh, r['s'])
    np.savez(os.path.join(out, 'fit-state-outline.npz'), identity=r['ident'], mp=r['mp'], headScale_xyz=r['s'], offsets=V - Vm_new, offsetsAreRelativeToTheModelWithoutPoseCorrectivesAfterTheHeadScale=True, headShift=np.array(r['pose']['rigidShiftOfTheHeadMm_xyz']) / 1000, lod=lod, joinWeight=b.astype(np.float32))
    for f in ('LICENSE-MHR.txt', 'NOTICE-MHR.txt'):
        open(os.path.join(out, f), 'wb').write(open(os.path.join(src, f), 'rb').read())
    Vchk, Fchk = __import__('reissue_r2').load_obj(os.path.join(out, 'skin-with-new-head.obj'))
    same = {'vertexCount': [int(len(V_ship)), int(len(Vchk))], 'faceCount': [int(len(F)), int(len(Fchk))], 'facesIdentical': bool(np.array_equal(Fchk, F)), 'closed': bool(ES.is_closed(F)),
            'statureM': {'shipped': round(stature, 4), 'new': round(float(np.ptp(V[:, 1])), 4)}, 'movedVertices': int((np.linalg.norm(V - V_ship, axis=1) > 1e-6).sum())}
    json.dump({'schema': 1, 'frame': 'metres, Y up, +Z anterior, +X body left; same origin as public/anatomy/female', 'skin': 'skin-with-new-head.obj',
               'use': 'correspondences for warping her skull, teeth and facial soft parts into the new head: each landmark gives the point on the NEW skin, the bony landmark it stands over, the soft-tissue '
                      'depth with its source, and boneTarget = skin point minus depth along the outward skin normal (the direction is an ASSUMPTION; the tables measure roughly perpendicular to the bone)',
               'landmarkDefinitions': 'found by geometry on the rest head of the model (see tools/bodyshape/head_landmarks.py); superciliare = most prominent skin point above the pupil (stands over the '
                                      'mid-supraorbital margin); infraorbitalSkin = skin 17 mm below the eye centre under the pupil (ASSUMED position of the mid-infraorbital margin); frontalEminence = skin 28 mm '
                                      'from the midline, 38 mm above glabella (ASSUMED position); mastoid = skin 12 mm below and 24 mm behind the ear canal opening (ASSUMED position); midRamus = skin over the '
                                      'midpoint between gonion and a point 8 mm in front of the ear canal; gonion = sharpest turn of the frontal outline of the lower face in front of the ear; rhinionSkin = 40 % '
                                      'of the way down the dorsum from sellion to pronasale (ASSUMED); earCanal = deepest point of the concha seen from lateral',
               'landmarks': lm_out, 'globes': globes, 'oralFissure': oral, 'browStandIn': brow_spec,
               'bestSimilarityOfPresentBoneToTargets': {'scale': round(float(s_sim), 4), 'rotationDeg_xyz': np.round(Rot.from_matrix(R_sim).as_euler('xyz', degrees=True), 2).tolist(),
                                                        'translationOfTheCentroidMm_xyz': np.round((Y.mean(0) - X.mean(0)) * 1000, 1).tolist(), 'rmsResidualMm': round(float(np.sqrt((res ** 2).sum(1).mean()) * 1000), 1),
                                                        'landmarksUsed': len(pairs)}}, open(os.path.join(out, 'landmarks.json'), 'w'), ensure_ascii=False, indent=1)
    after = {d: tree_hash(os.path.join(RAW, 'out', d)) for d in SHIPPED}
    rep = {'schema': 1, 'sexStrength': k_main, 'headScale_xyz': np.round(r['s'], 4).tolist(), 'headIdentity20to39': np.round(r['h'], 3).tolist(), 'sexDirectionPerUnit': np.round(M.c_sex, 3).tolist(),
           'sexDirectionExplainsShareOfTheMakeHumanField': round(M.explained, 3), 'pose': r['pose'], 'measurements': meas, 'join': join, 'sameTopologyAsShipped': same,
           'neckPartsFurtherOutsideThanInTheShippedSkin': rows_n, 'skullDimensionsImplied': dims,
           'bestSimilarityOfPresentBoneToTargets': json.load(open(os.path.join(out, 'landmarks.json')))['bestSimilarityOfPresentBoneToTargets'],
           'openingToolLines': {'oralFissureVertices': int(len(path)), 'oralFissureSharpnessDeg_median': oral['sharpnessDeg_median'], 'eyeMembraneTriangles': {S_: rad[S_]['membraneTriangles'] for S_ in 'LR'},
                                'note': 'find_oral_fissure and find_eye_membrane of tools/skinopen/open_skin.py run on skin-with-new-head.obj with the usual lip and lid regions; the full tool was not run'},
           'globes': globes, 'shippedPackagesUntouched': {d: {'before': before[d], 'after': after[d], 'identical': before[d] == after[d]} for d in SHIPPED},
           'otherStrengths': {str(k): {'headScale_xyz': np.round(R[k]['s'], 4).tolist(), 'headIdentity20to39': np.round(R[k]['h'], 2).tolist(), 'bigonialOverBizygomatic': R[k]['restMeasures']['bigonialOverBizygomatic']} for k in R}}
    json.dump(rep, open(os.path.join(out, 'report.json'), 'w'), ensure_ascii=False, indent=1)

    log.append(f'  same topology: {same}')
    log.append('\nmeasure (mm)                                     shipped      new   ANSUR II women: mean (SD), expected at her stature; percentile shipped / new')
    for mk, v in meas.items():
        if 'ansurFemale' in v:
            a_ = v['ansurFemale']
            log.append(f'  {mk:44s} {str(v["shippedFemaleMm"]):>8s} {v["newMm"]:8.1f}   {a_["mean"]:.1f} ({a_["sd"]:.1f}), {a_["expectedAtHerStature"]:.1f}; P{v["percentileAmongAnsurWomen"]["shipped"]} / P{v["percentileAmongAnsurWomen"]["new"]}')
    log.append('measure (mm)                                     shipped      new     male (same vertex indices on the male skin)')
    for mk, v in meas.items():
        if 'newMm' in v and 'ansurFemale' not in v:
            log.append(f'  {mk:44s} {str(v["shippedFemaleMm"]):>8s} {str(v["newMm"]):>8s} {str(v["maleShippedMm_sameVertexIndices"]):>8s}')
    log.append(f'  head height (menton to top) / stature: {meas["headHeightOverStature_mentonToTop"]}')
    log.append('\njoin: ' + json.dumps(join))
    log.append(f'\nneck: {len(rows_n)} deep parts between the band and the chin lie further outside the new skin than outside the shipped one' +
               ''.join(f'\n   {q["maxOutsideShippedMm"]:6.1f} -> {q["maxOutsideNewMm"]:5.1f} mm  {100 * q["shareOutsideNew"]:5.1f} %  {q["name"]} [{q["tissue"]}]' for q in rows_n[:40]))
    log.append('\nlandmark                 bony landmark                         depth mm   present bone to NEW skin (mm, - = inside) / to its target (mm) / after best similarity (mm)   depth source')
    for name, e in lm_out.items():
        if 'softTissueDepthMm' in e:
            pb = e['presentBone']
            log.append(f'  {name:22s} {e["bonyLandmark"][:36]:36s} {e["softTissueDepthMm"]:6.2f}{"*" if e["assumedDepth"] else " "}   ' +
                       (f'{pb["signedDistanceToNewSkinMm_negativeInside"]:7.1f} / {pb["moveToTargetMm"]:5.1f} {str(pb["moveToTargetMm_xyz"]):22s} / {pb["residualAfterBestSimilarityMm"]:5.1f}' if pb else '   (no bone point located by geometry)                 ') +
                       '   ' + ('assumed' if e['assumedDepth'] else 'Park 2023 F' if e['depthSource'].startswith('Park') else 'T-Table 2023'))
    log.append('  * = assumed depth')
    log.append(f'  bone points of face_female.py for reference (m): nasion {np.round(B["nasion"], 4).tolist()}, "subnasale" (most anterior midline point of the maxilla; may be the alveolar process rather than the anterior nasal spine) {np.round(B["subnasale"], 4).tolist()}, upper incisor front {np.round(B["labraleSuperius"], 4).tolist()}')
    log.append(f'\nbest similarity taking her present bone landmarks onto the targets: {rep["bestSimilarityOfPresentBoneToTargets"]}')
    log.append('skull dimensions the new skin implies (target points = skin minus depth):')
    for nm, v in dims.items():
        log.append(f'  {nm:40s} {v["presentBoneMm"]:7.1f} -> {v["impliedByNewSkinMm"]:7.1f} mm  {v["changePercent"]:+6.1f} %{"   << over 10 %" if v["flagOver10Percent"] else ""}')
    log.append(f'\nglobes: {json.dumps({k_: v for k_, v in globes.items() if k_ != "lids"})}')
    log.append(f'lids: {json.dumps(rad)}')
    log.append(f'oral fissure: {len(path)} vertices, {oral["lengthMm"]} mm, median sharpness {oral["sharpnessDeg_median"]} deg; incisal relation {json.dumps(oral["incisalRelation"]["moveMm_xyz"])} mm to move the present incisal edge')
    log.append(f'\nshipped packages untouched: {json.dumps({d: before[d] == after[d] for d in SHIPPED})}; hashes in report.json')
    open(os.path.join(out, 'report.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
