// 头的形变：她的颅骨、牙和头部软组织变形进参数化头模型自己的女性头里（方向与以前相反：以前是让皮肤去贴她的颅骨）。
//   1. 重新摆位：头的骨绕寰枕关节刚性前屈一个钉住的角（见 headPose.ts）。
//   2. 形变场 W（作用在摆位之后的坐标上）：仿射 + 径向基（φ = −r，三维双调和样条，带逐点正则）。约束：
//        标志点   骨标志点 → 皮肤标志点沿皮肤外法线向内退一个软组织厚度（厚度表见 DEPTHS，逐条注明出处）；
//        稠密面   头部皮肤上每隔约 10 mm 取一点，沿内法线射到骨面：那一点的骨应在皮肤下“该处的厚度均值”处
//                 （厚度场由各标志点的值按距离插值）；骨面离皮肤不足下限或在皮肤外的顶点另加约束；
//        寰枕关节 枕骨上贴着寰椎的一圈（枕髁、枕骨大孔缘）不动；
//        牙       上下牙列合在一起只做一个刚体运动（取 W 在牙上的最佳刚体近似），咬合关系因此不变；
//        眼球     眼球中心移到皮肤给的目标，周围 15 mm 的一圈跟着平移，所以骨性眼眶在眼球周围近似刚性；
//      迭代若干遍（每遍重新射线、重新取牙的刚体）。
//      眼球本身（不是骨）最后整体平移，使角膜顶点（不是中心）落到左右对称的目标上：目标 = 中心目标 + 两侧“角膜顶点 − 中心”
//      的镜像平均，所以大小不同的两个眼球前表面对齐，各自的大小不变。
//   3. 软组织：头的骨、牙、眼球之外的部件按权重 w 在“随头走”和“不动”之间过渡，
//      w 由到头的骨和到不动的结构（颈椎、舌骨、喉软骨、甲状腺、锁骨、肩胛骨、上位肋骨）的距离定。
//      舌骨、喉、甲状腺、颈椎一律不动。神经的中心线过同一个映射后重建管状网格。
//   4. 检查：每块骨的位移、颅骨径线的变化、雅可比、寰枕关节、颞下颌关节、咬合、眼眶、各标志点处的软组织厚度、
//      骨在皮肤下的深度、颈部结构是否仍在皮肤之内。
// 皮肤来自 tools/bodyshape/head_outline.py 写出的目录（skin-with-new-head.obj、landmarks.json）；目录不存在时这一步不做。
//
// The head warp: her skull, teeth and the soft parts of her head are deformed INTO the parametric head model's own
// female head (the reverse of before, when the skin was draped over her skull).
//   1. Re-pose: the bones of the head are flexed rigidly about the atlanto-occipital joint by a pinned angle (headPose.ts).
//   2. The field W (acting on re-posed coordinates): affine + radial basis (φ = −r, the 3-D biharmonic spline, with a
//      regularisation per point). Constraints:
//        landmarks  a bony landmark → the skin landmark moved inwards along the skin normal by a soft-tissue depth
//                   (the depths are in DEPTHS, each with its source);
//        dense      from skin points about 10 mm apart on the head a ray goes inwards to the bone: the bone met there
//                   should lie under the skin at the mean depth of that place (a depth field interpolated from the
//                   landmark values by distance); bone vertices closer to the skin than the lower bound, or outside
//                   it, get constraints of their own;
//        atlanto-occipital joint  the part of the occipital bone lying on the atlas (condyles, rim of the foramen
//                   magnum) stays;
//        teeth      both dental arches together make one rigid motion (the best rigid approximation of W over the
//                   teeth), so the occlusion does not change;
//        globes     each globe centre goes to the target the skin gives and a shell 15 mm round it is translated with
//                   it, so the bony orbit is nearly rigid round the globe;
//      iterated (new rays and a new rigid motion of the teeth each time).
//      The eyeballs themselves (not bones) are translated as a whole at the end so that the corneal APEX (not the centre)
//      lands on a left–right symmetric target: target = centre target + the mirrored mean of both sides' "apex − centre",
//      so two globes of different size line up in front, each keeping its own size.
//   3. Soft tissue: every part other than head bones, teeth and globes passes between "goes with the head" and "stays"
//      by a weight w from its distances to the head bones and to what stays (cervical vertebrae, hyoid, laryngeal
//      cartilages, thyroid gland, clavicles, scapulae, upper ribs). Hyoid, larynx, thyroid and cervical spine never
//      move. Nerve centrelines go through the same map and the tubes are rebuilt.
//   4. Checks: displacement per bone, change of the cranial dimensions, Jacobian, atlanto-occipital joint,
//      temporomandibular joints, occlusion, orbits, soft-tissue depth at the landmarks, depth of bone under the skin,
//      and whether the structures of the neck are still inside the skin.
// The skin comes from the directory written by tools/bodyshape/head_outline.py (skin-with-new-head.obj,
// landmarks.json); without that directory the stage does nothing.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeNormals, measure, type Mesh } from './geometry.ts'
import { atlantoOccipitalJoint, frankfurtPlane, HEAD_BONE, headFlexion, PINNED_FEMALE_STATURE, PINNED_HEAD_FLEXION, type AtlantoOccipital } from './headPose.ts'
import { applyRigid, fitRigid, InsideTester, PointIndex, rotationAngle, surfacePoints, thinPoints, voxelSubsample } from './register.ts'
import { applyT, applyToPoints, contactZone, type RigidT, type V3 } from './shoulder.ts'
import { parseSkinObj, SurfaceDistance } from './skinPackage.ts'
import { jacobianStats } from './standard.ts'
import type { Polyline } from './tube.ts'

/**
 * head_outline.py --posture level --stature 1.608 --head-shift 3.5,0,-25.2,0.6,1.0 --vault-percentile 90 写出的目录（相对项目根）：颅盖加高到
 * ANSUR II 女性“耳屏点—头顶”的第 90 百分位，脸因此在她的颅骨上低 8 mm，颅骨不必再压扁（颅顶—鼻根 −7.1 % → −2.7 %）；身高 1.608 m 在钉住的
 * 1.606 ± 0.003 m 之内。female-head-outline-s1606 是上一版（身高 1.606、颅盖不加高）。
 * the directory written by head_outline.py --posture level --stature 1.608 --head-shift 3.5,0,-25.2,0.6,1.0 --vault-percentile 90 (relative to the
 * project root): the vault raised to the 90th percentile of tragion-to-top-of-head of ANSUR II women, which puts the face 8 mm lower on her skull so
 * the skull no longer has to be squashed (vertex to nasion -7.1 % -> -2.7 %); a stature of 1.608 m is within the pinned 1.606 +/- 0.003 m.
 * female-head-outline-s1606 is the previous one (stature 1.606, vault as the model has it).
 */
export const HEAD_OUTLINE_DIR = 'data/raw/bodyshape/out/female-head-outline-v3'
/**
 * 头形变之后体形重塑所用的目标包（相对项目根）：深层包络的头部要按新头和形变后的颅骨重做，身体部分沿用 female-face-target。
 * 这个包由皮肤作者提供；不存在时体形重塑不做（见 femaleShape.ts 的 matchTarget：包必须是按本次骨架做的）。
 * The target package the body-shape stage uses once the head is warped (relative to the project root): the head part of the deep
 * envelope has to be remade from the new head and the warped skull, the body keeps that of female-face-target. The skin's
 * author provides it; without it the body-shape stage does not run (matchTarget of femaleShape.ts: a package must have been
 * made for this build's skeleton).
 */
// v3：按 female-head-outline-v3 和本版形变做的（上一版 female-face-target-outline 按 s1606） / v3: made for female-head-outline-v3 and this version of the warp (the previous female-face-target-outline was made for s1606)
export const HEAD_SHAPE_TARGET_DIR = 'data/raw/bodyshape/out/female-face-target-outline-v3'
/** 算法或参数一改就加一（写进报告） / raised whenever the algorithm or its parameters change (goes into the report) */
export const HEAD_WARP_VERSION = 4

const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d
const mm = (v: number, d = 1) => r1(v * 1000, d)
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
const concat = (list: Float32Array[]): Float32Array => {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of list) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const quantile = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : NaN
}

// ── 软组织厚度表 / the soft-tissue depth table ─────────────────────────────────────────────────────────────

const SRC_PARK = 'Park, Chang & Park 2023, Int J Environ Res Public Health 20(3):2658, doi:10.3390/ijerph20032658, Table 2: Korean women aged 20-29, skeletal Class I (n = 18), CBCT; CC BY 4.0; as parsed in data/curated/reference/published-statistics.json'
const SRC_MORI = 'Moritsugui et al. 2022, PLoS One 17(7):e0270980, doi:10.1371/journal.pone.0270980, Table 3: Brazilian women (n = 56), CBCT, seated; CC BY 4.0; as parsed in data/curated/reference/published-statistics.json'
const SRC_ADEG = 'Adegbite et al. 2026, Int J Legal Med, doi:10.1007/s00414-026-03794-1, Tables 5 and 6: Nigerian women aged 18-95 (n = 32), CT, supine; CC BY 4.0; as parsed in data/curated/reference/published-statistics.json'
const SRC_TT = 'Hona & Stephan 2024, Int J Legal Med 138:519-535, doi:10.1007/s00414-023-03087-x, adult 2023 T-Table (pooled over sexes and populations); value and SD as carried by tools/bodyshape/head_outline.py; not opened again here'

export interface DepthEntry {
  /** landmarks.json 里皮肤标志点的键 / key of the skin landmark in landmarks.json */
  skin: string
  /** 骨标志点的名称（boneLandmarks 的键）；null = 只用于厚度场，不作标志点约束 / name of the bony landmark (a key of boneLandmarks); null = used for the depth field only, no landmark constraint */
  bone: string | null
  meanMm: number
  sdMm: number
  source: string
  /** 表里的点与这里所用的点怎么对应、哪里是假定 / how the tabled point corresponds to the one used here, and what is assumed */
  note?: string
  /** 作标志点约束时的权重；0 = 不作约束（配对太松），只用于检查 / weight as a landmark constraint; 0 = no constraint (the pairing is too loose), checked only */
  weight: number
}

/**
 * 厚度表：正中线用 Park 2023（韩国 20–29 岁女性），成对的点用 Moritsugui 2022（巴西女性），两处取 Adegbite 2026（尼日利亚女性）；
 * 表里没有的两处（颅后点、颅侧点）沿用 head_outline.py 的值，乳突是假定。没有一张表来自她所代表的人群（中国年轻女性）。
 * The depth table: Park 2023 (Korean women aged 20-29) on the midline, Moritsugui 2022 (Brazilian women) for the
 * bilateral points, Adegbite 2026 (Nigerian women) at two places; opisthocranion and euryon, which none of them
 * tables, keep the values of head_outline.py, and the mastoid is an assumption. None of the tables is from the
 * population she stands for (young Chinese women).
 */
export const DEPTHS: DepthEntry[] = [
  { skin: 'glabella', bone: 'glabella', meanMm: 5.57, sdMm: 0.68, source: SRC_PARK, weight: 3 },
  { skin: 'sellion', bone: 'nasion', meanMm: 6.16, sdMm: 1.48, source: SRC_PARK, weight: 3 },
  { skin: 'rhinionSkin', bone: 'rhinion', meanMm: 3.1, sdMm: 1.6, source: SRC_PARK, note: 'the skin point is ASSUMED (40 % of the way down the dorsum from sellion to pronasale)', weight: 1 },
  { skin: 'subnasale', bone: 'subspinale', meanMm: 13.53, sdMm: 1.2, source: SRC_PARK, note: 'ASSUMPTION: the table\'s Sn depth is taken as subnasale to subspinale (A point), the deepest point of the maxillary profile between the anterior nasal spine and prosthion; the definition in the paper was not checked', weight: 2 },
  { skin: 'labraleSuperius', bone: 'upperIncisorLabial', meanMm: 14.19, sdMm: 1.69, source: SRC_PARK, note: 'ASSUMPTION: the bone-side point is the most anterior point of the upper central incisors', weight: 1.5 },
  { skin: 'labraleInferius', bone: 'lowerIncisorLabial', meanMm: 14.94, sdMm: 1.65, source: SRC_PARK, note: 'ASSUMPTION: the bone-side point is the most anterior point of the lower central incisors', weight: 1 },
  { skin: 'labiomentale', bone: 'supramentale', meanMm: 11.99, sdMm: 0.92, source: SRC_PARK, weight: 1 },
  { skin: 'pogonion', bone: 'pogonion', meanMm: 12.44, sdMm: 1.83, source: SRC_PARK, weight: 3 },
  { skin: 'gnathion', bone: 'gnathion', meanMm: 7.53, sdMm: 1.92, source: SRC_PARK, weight: 2 },
  { skin: 'menton', bone: 'menton', meanMm: 7.0, sdMm: 1.73, source: SRC_MORI, weight: 3 },
  { skin: 'superciliare_L', bone: 'midSupraorbital_L', meanMm: 6.4, sdMm: 1.37, source: SRC_MORI, weight: 3 },
  { skin: 'superciliare_R', bone: 'midSupraorbital_R', meanMm: 6.5, sdMm: 1.27, source: SRC_MORI, weight: 3 },
  { skin: 'infraorbitalSkin_L', bone: 'midInfraorbital_L', meanMm: 5.5, sdMm: 1.58, source: SRC_MORI, note: 'the skin point is ASSUMED (17 mm below the eye centre under the pupil)', weight: 1.5 },
  { skin: 'infraorbitalSkin_R', bone: 'midInfraorbital_R', meanMm: 5.3, sdMm: 1.47, source: SRC_MORI, note: 'the skin point is ASSUMED (17 mm below the eye centre under the pupil)', weight: 1.5 },
  { skin: 'frontalEminence_L', bone: 'frontalEminence_L', meanMm: 4.2, sdMm: 1.11, source: SRC_MORI, note: 'skin and bone points are both ASSUMED positions (28 mm from the midline, 38 mm above glabella)', weight: 0 },
  { skin: 'frontalEminence_R', bone: 'frontalEminence_R', meanMm: 4.1, sdMm: 0.89, source: SRC_MORI, note: 'skin and bone points are both ASSUMED positions (28 mm from the midline, 38 mm above glabella)', weight: 0 },
  { skin: 'zygion_L', bone: 'zygion_L', meanMm: 7.8, sdMm: 1.9, source: SRC_MORI, note: 'loose pairing: the widest skin point and the most lateral point of the zygomatic arch need not lie over one another', weight: 0 },
  { skin: 'zygion_R', bone: 'zygion_R', meanMm: 7.8, sdMm: 1.79, source: SRC_MORI, note: 'loose pairing: the widest skin point and the most lateral point of the zygomatic arch need not lie over one another', weight: 0 },
  { skin: 'gonion_L', bone: 'gonion_L', meanMm: 13.0, sdMm: 3.88, source: SRC_MORI, note: 'loose pairing: the skin point is the sharpest turn of the outline of the lower face', weight: 0 },
  { skin: 'gonion_R', bone: 'gonion_R', meanMm: 12.8, sdMm: 3.65, source: SRC_MORI, note: 'loose pairing: the skin point is the sharpest turn of the outline of the lower face', weight: 0 },
  { skin: 'midRamus_L', bone: 'midRamus_L', meanMm: 20.98, sdMm: 5.28, source: SRC_ADEG, note: 'the table\'s mid-masseter point; supine subjects', weight: 0 },
  { skin: 'midRamus_R', bone: 'midRamus_R', meanMm: 20.22, sdMm: 5.63, source: SRC_ADEG, note: 'the table\'s mid-masseter point; supine subjects', weight: 0 },
  { skin: 'vertex', bone: 'vertex', meanMm: 5.54, sdMm: 2.51, source: SRC_ADEG, note: 'the highest point is not a material landmark: no landmark constraint, the dense constraints act there', weight: 0 },
  { skin: 'opisthocranion', bone: 'opisthocranion', meanMm: 6.0, sdMm: 2.0, source: SRC_TT, note: 'not sex-specific; no landmark constraint (an extreme point, not a material one)', weight: 0 },
  { skin: 'euryon_L', bone: 'euryon_L', meanMm: 6.0, sdMm: 2.0, source: 'ASSUMPTION carried over from head_outline.py (by analogy with vertex and opisthocranion); the SD is assumed too', weight: 0 },
  { skin: 'euryon_R', bone: 'euryon_R', meanMm: 6.0, sdMm: 2.0, source: 'ASSUMPTION carried over from head_outline.py (by analogy with vertex and opisthocranion); the SD is assumed too', weight: 0 },
  { skin: 'mastoid_L', bone: 'mastoid_L', meanMm: 9.0, sdMm: 3.0, source: 'ASSUMPTION carried over from head_outline.py (nothing tabled); skin position assumed, SD assumed', weight: 0 },
  { skin: 'mastoid_R', bone: 'mastoid_R', meanMm: 9.0, sdMm: 3.0, source: 'ASSUMPTION carried over from head_outline.py (nothing tabled); skin position assumed, SD assumed', weight: 0 },
]

// ── 骨上的标志点 / landmarks on the bones ─────────────────────────────────────────────────────────────────

export type BonePoints = (name: string) => Float32Array

const argBest = (p: Float32Array, keep: (x: number, y: number, z: number) => boolean, score: (x: number, y: number, z: number) => number): V3 | null => {
  let best: V3 | null = null
  let s = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    const z = p[i + 2]!
    if (!keep(x, y, z)) continue
    const v = score(x, y, z)
    if (v > s) {
      s = v
      best = [x, y, z]
    }
  }
  return best
}

/**
 * 骨性标志点，按几何在骨表面的采样点上找（规则多数沿用 tools/bodyshape/face_female.py，改进的几处逐条写明）。
 * `pts(name)` 返回该名称的骨（或牙）表面的采样点；`globe` 是两个眼球的中心。
 * Bony landmarks found by geometry on surface samples of the bones (most rules are those of
 * tools/bodyshape/face_female.py; what was improved is said at each). `pts(name)` returns surface samples of the bone
 * (or tooth) of that name; `globe` holds the centres of both globes.
 */
export function boneLandmarks(pts: BonePoints, globe: { L: V3; R: V3 }): Record<string, V3> {
  const two = (a: string, b: string) => concat([pts(a), pts(b)])
  const na = two('Left nasal bone', 'Right nasal bone')
  const mx = two('Left maxilla', 'Right maxilla')
  const fr = pts('Frontal bone')
  const md = pts('Mandible')
  const occ = pts('Occipital bone')
  const ui = two('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')
  const li = two('Left lower central secondary incisor tooth', 'Right lower central secondary incisor tooth')
  const xs = Array.from({ length: na.length / 3 }, (_, i) => na[3 * i]!).sort((a, b) => a - b)
  const xc = xs[xs.length >> 1]!
  const mid = (w: number) => (x: number) => Math.abs(x - xc) < w
  const need = (v: V3 | null, what: string): V3 => {
    if (!v) throw new Error(`head warp: bony landmark not found: ${what}`)
    return v
  }
  const L: Record<string, V3> = {}
  const onMid = (v: V3): V3 => [xc, v[1], v[2]]
  L.nasion = onMid(need(argBest(na, mid(0.004), (_x, y) => y), 'nasion'))
  L.glabella = onMid(need(argBest(fr, (x, y) => mid(0.004)(x) && y > L.nasion![1] && y < L.nasion![1] + 0.025, (_x, _y, z) => z), 'glabella'))
  {
    const ys = Array.from({ length: na.length / 3 }, (_, i) => na[3 * i + 1]!).sort((a, b) => a - b)
    const cut = ys[Math.floor(0.12 * ys.length)]!
    L.rhinion = onMid(need(argBest(na, (_x, y) => y <= cut, (_x, _y, z) => z), 'rhinion'))
  }
  // 上颌正中的前面轮廓：每 1 mm 高度取最前的点。前鼻棘 = 轮廓上半最前的点；上牙槽缘点（prosthion）= 轮廓最低处；
  // 上牙槽座点（subspinale，A 点）= 两者之间最靠后的点。face_female.py 把整个轮廓上最前的点当“鼻下点”，那可能落在牙槽突上。
  // the anterior profile of the maxilla on the midline: the most anterior point per millimetre of height. Anterior nasal
  // spine = the most anterior point of its upper half; prosthion = its lowest point; subspinale (A point) = the most
  // posterior point between the two. face_female.py took the most anterior point of the whole profile as "subnasale",
  // which may fall on the alveolar process.
  {
    const prof: V3[] = []
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < mx.length; i += 3) if (mid(0.005)(mx[i]!)) {
      y0 = Math.min(y0, mx[i + 1]!)
      y1 = Math.max(y1, mx[i + 1]!)
    }
    y1 = Math.min(y1, y0 + 0.03)
    for (let y = y0 + 0.0005; y < y1; y += 0.001) {
      const p = argBest(mx, (x, yy) => mid(0.005)(x) && Math.abs(yy - y) < 0.00075, (_x, _y, z) => z)
      if (p) prof.push(p)
    }
    if (prof.length < 8) throw new Error('head warp: no midline profile of the maxilla')
    L.prosthion = onMid(prof[0]!)
    let ans = prof.length - 1
    for (let i = prof.length >> 1; i < prof.length; i++) if (prof[i]![2] > prof[ans]![2]) ans = i
    L.anteriorNasalSpine = onMid(prof[ans]!)
    let a = 1
    for (let i = 1; i < ans; i++) if (prof[i]![2] < prof[a]![2]) a = i
    L.subspinale = onMid(prof[a]!)
  }
  L.upperIncisorLabial = onMid(need(argBest(ui, () => true, (_x, _y, z) => z), 'upper incisors'))
  L.lowerIncisorLabial = onMid(need(argBest(li, () => true, (_x, _y, z) => z), 'lower incisors'))
  L.upperIncisalEdge = onMid(need(argBest(ui, () => true, (_x, y) => -y), 'upper incisal edge'))
  {
    // 下颌正中的前面轮廓 / the anterior profile of the mandible on the midline
    let y0 = Infinity
    for (let i = 0; i < md.length; i += 3) if (mid(0.006)(md[i]!)) y0 = Math.min(y0, md[i + 1]!)
    // 上界取下牙槽缘点（infradentale）：正中、下颌骨前面 12 mm 以内最高的点。face_female.py 用的是下切牙的最低点，
    // 而那是埋在骨里的牙根尖，轮廓因此只剩最下面几毫米。
    // the upper end is infradentale: the highest midline point within 12 mm of the front of the mandible. face_female.py
    // used the lowest point of the lower incisors, which is the root apex inside the bone, and its profile was only the
    // lowest few millimetres.
    let zFront = -Infinity
    for (let i = 0; i < md.length; i += 3) if (mid(0.006)(md[i]!)) zFront = Math.max(zFront, md[i + 2]!)
    const infra = need(argBest(md, (x, _y, z) => mid(0.006)(x) && z > zFront - 0.012, (_x, y) => y), 'infradentale')
    L.infradentale = onMid(infra)
    const yTop = infra[1] - 0.001
    const prof: V3[] = []
    for (let y = y0 + 0.002; y < yTop; y += 0.001) {
      const p = argBest(md, (x, yy) => mid(0.006)(x) && Math.abs(yy - y) < 0.00075, (_x, _y, z) => z)
      if (p) prof.push(p)
    }
    if (prof.length < 8) throw new Error('head warp: no midline profile of the mandible')
    let ip = 0
    for (let i = 0; i < Math.floor(prof.length * 0.6); i++) if (prof[i]![2] > prof[ip]![2]) ip = i
    L.pogonion = onMid(prof[ip]!)
    let ib = ip
    for (let i = ip; i < prof.length; i++) if (prof[i]![2] < prof[ib]![2]) ib = i
    // 骨面上没有颏唇沟的凹陷：取颏前点到下牙槽之间 45 % 高度处 / no concavity on the bone: taken 45 % of the way from pogonion to the lower alveolus
    if (ib - ip < 3) ib = ip + Math.floor(0.45 * (prof.length - 1 - ip))
    L.supramentale = onMid(prof[ib]!)
    L.menton = onMid(need(argBest(md, mid(0.006), (_x, y) => -y), 'menton'))
    L.gnathion = onMid(need(argBest(md, mid(0.006), (_x, y, z) => z - y), 'gnathion'))
  }
  for (const [S, sg, Side] of [['L', 1, 'Left'], ['R', -1, 'Right']] as const) {
    const e = globe[S]
    const zy = pts(`${Side} zygomatic bone`)
    const tb = pts(`${Side} temporal bone`)
    L[`midSupraorbital_${S}`] = need(argBest(fr, (x, y) => Math.abs(x - e[0]) < 0.003 && y < e[1] + 0.03 && y > e[1] + 0.008, (_x, y, z) => z - y), 'mid-supraorbital margin')
    L[`midInfraorbital_${S}`] = need(argBest(concat([mx, zy]), (x, y) => Math.abs(x - e[0]) < 0.003 && y < e[1] - 0.008 && y > e[1] - 0.028, (_x, y, z) => z + y), 'mid-infraorbital margin')
    // 额结节没有可靠的几何定义：取额骨前面上离中线 28 mm、眉间上方 38 mm 处（与皮肤上的假定位置相同的规则）
    // the frontal eminence has no reliable geometric definition: the point of the front of the frontal bone 28 mm from the midline and 38 mm above glabella (the rule of the assumed skin position)
    L[`frontalEminence_${S}`] = need(argBest(fr, (x, y) => Math.abs(x - (xc + sg * 0.028)) < 0.003 && Math.abs(y - (L.glabella![1] + 0.038)) < 0.003, (_x, _y, z) => z), 'frontal eminence')
    // 乳突尖：颞骨外侧部分（离中线 45 mm 以外，茎突在内侧）最低的点 / mastoid tip: the lowest point of the lateral part of the temporal bone (beyond 45 mm from the midline; the styloid process lies medially)
    L[`mastoid_${S}`] = need(argBest(tb, (x) => sg * (x - xc) > 0.045, (_x, y) => -y), 'mastoid')
    // 颧点：颧弓（颧骨 + 颞骨颧突）上最靠外的点，只看乳突尖前方 15 mm 以前、颧骨高度范围内的点
    // zygion: the most lateral point of the zygomatic arch (zygomatic bone + zygomatic process of the temporal bone), among points more than 15 mm in front of the mastoid tip and within the height of the zygomatic bone
    let zy0 = Infinity
    let zy1 = -Infinity
    for (let i = 1; i < zy.length; i += 3) {
      zy0 = Math.min(zy0, zy[i]!)
      zy1 = Math.max(zy1, zy[i]!)
    }
    const zLat = need(argBest(zy, () => true, (x) => sg * x), 'zygomatic bone')
    L[`zygion_${S}`] = need(argBest(concat([zy, tb]), (_x, y, z) => y > Math.max(zy0, zLat[1] - 0.01) && y < Math.min(zy1, zLat[1] + 0.01) && z > L[`mastoid_${S}`]![2] + 0.015, (x) => sg * x), 'zygion')
    // 下颌角点：下颌骨外侧部分 (y + z) 最小的点；下颌支中点：下颌角点与髁突顶之间一半高度处最靠外的点
    // gonion: the point of the lateral part of the mandible with the least (y + z); mid-ramus: the most lateral point half-way in height between gonion and the top of the condyle
    const go = need(argBest(md, (x) => sg * (x - xc) > 0.03, (_x, y, z) => -(y + z)), 'gonion')
    L[`gonion_${S}`] = go
    const top = need(argBest(md, (x) => sg * (x - xc) > 0.03, (_x, y) => y), 'condyle')
    L[`condylion_${S}`] = top
    L[`midRamus_${S}`] = need(argBest(md, (x, y, z) => sg * (x - xc) > 0.03 && Math.abs(y - 0.5 * (go[1] + top[1])) < 0.004 && z < go[2] + 0.03, (x) => sg * x), 'mid-ramus')
  }
  // 颅顶、颅后、颅侧：极值点，不是实质性的标志点 / vertex, opisthocranion, euryon: extreme points, not material landmarks
  const vault = concat([fr, occ, pts('Left parietal bone'), pts('Right parietal bone'), pts('Left temporal bone'), pts('Right temporal bone')])
  L.vertex = need(argBest(vault, () => true, (_x, y) => y), 'vertex')
  L.opisthocranion = need(argBest(occ, mid(0.006), (x, y, z) => dist([x, y, z], L.glabella!)), 'opisthocranion')
  L.euryon_L = need(argBest(vault, () => true, (x) => x), 'euryon')
  L.euryon_R = need(argBest(vault, () => true, (x) => -x), 'euryon')
  return L
}

/**
 * 颅骨的常用径线（毫米）。`L` 是标志点（形变之后传入的是形变之前找到的点经映射后的位置，即同一批实质点）；
 * 几个宽度和极值点（颅宽、颧宽、髁间宽、颅顶、颅后点）不是实质点，在给定的骨上按同一规则重新找。
 * The usual cranial dimensions (mm). `L` holds the landmarks (after the warp: the points found before it, carried
 * through the map, i.e. the same material points); a few breadths and extreme points (cranial and bizygomatic
 * breadth, bicondylar breadth, vertex, opisthocranion) are not material points and are found anew on the given bones
 * by the same rules.
 */
export function cranialDimensions(pts: BonePoints, L: Record<string, V3>, globe: { L: V3; R: V3 }): Record<string, number> {
  const X = boneLandmarks(pts, globe)
  const d = (a: string, b: string) => mm(dist(L[a]!, L[b]!))
  const md = pts('Mandible')
  let c0 = Infinity
  let c1 = -Infinity
  let yTop = -Infinity
  for (let i = 1; i < md.length; i += 3) yTop = Math.max(yTop, md[i]!)
  for (let i = 0; i < md.length; i += 3) if (md[i + 1]! > yTop - 0.012) {
    c0 = Math.min(c0, md[i]!)
    c1 = Math.max(c1, md[i]!)
  }
  return {
    maximumCranialBreadth: mm(X.euryon_L![0] - X.euryon_R![0]),
    maximumCranialLength_glabellaOpisthocranion: mm(dist(L.glabella!, X.opisthocranion!)),
    bizygomaticBreadth: mm(X.zygion_L![0] - X.zygion_R![0]),
    bigonialBreadth: d('gonion_L', 'gonion_R'),
    bicondylarBreadth_mandible: mm(c1 - c0),
    bimastoidBreadth: d('mastoid_L', 'mastoid_R'),
    interGlobeDistance: mm(dist(globe.L, globe.R)),
    faceHeight_nasionMenton: d('nasion', 'menton'),
    upperFaceHeight_nasionProsthion: d('nasion', 'prosthion'),
    nasalHeight_nasionSubspinale: d('nasion', 'subspinale'),
    vertexToNasion: mm(dist(X.vertex!, L.nasion!)),
    vertexToMenton: mm(dist(X.vertex!, L.menton!)),
    orbitalHeight_L_midSupraToMidInfra: d('midSupraorbital_L', 'midInfraorbital_L'),
    orbitalHeight_R_midSupraToMidInfra: d('midSupraorbital_R', 'midInfraorbital_R'),
    ramusHeight_L_gonionCondylion: d('gonion_L', 'condylion_L'),
    ramusHeight_R_gonionCondylion: d('gonion_R', 'condylion_R'),
    mandibularBodyLength_L_gonionPogonion: d('gonion_L', 'pogonion'),
    mandibularBodyLength_R_gonionPogonion: d('gonion_R', 'pogonion'),
    chinHeight_infradentaleMenton: d('infradentale', 'menton'),
    glabellaToMastoid_L: d('glabella', 'mastoid_L'),
    glabellaToMastoid_R: d('glabella', 'mastoid_R'),
  }
}

// ── 径向基样条 / the radial-basis spline ───────────────────────────────────────────────────────────────────

/**
 * x ↦ x + A·[1, x] + Σ wⱼ φ(|x − cⱼ|)，φ(r) = −r（三维双调和样条；线性多项式部分使它对仿射运动无罚）。
 * 拟合：(Φ + diag(λᵢ)) w + P a = d，Pᵀ w = 0，d 是各约束点的位移；λᵢ 越小该点越硬。
 * x ↦ x + A·[1, x] + Σ wⱼ φ(|x − cⱼ|) with φ(r) = −r (the 3-D biharmonic spline; its linear polynomial part leaves
 * affine motion unpenalised). Fit: (Φ + diag(λᵢ)) w + P a = d, Pᵀ w = 0, d the displacements at the constraint
 * points; the smaller λᵢ, the harder the point.
 */
export class RbfWarp {
  private constructor(private readonly c: Float64Array, private readonly w: Float64Array, private readonly a: Float64Array, private readonly origin: V3) {}

  static identity(): RbfWarp {
    return new RbfWarp(new Float64Array(0), new Float64Array(0), new Float64Array(12), [0, 0, 0])
  }

  static fit(src: ArrayLike<number>, dst: ArrayLike<number>, lambda: ArrayLike<number>): RbfWarp {
    const n = lambda.length
    const o: V3 = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) o[k] = o[k]! + src[3 * i + k]! / n
    const c = new Float64Array(3 * n)
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[3 * i + k] = src[3 * i + k]! - o[k]!
    const m = n + 4
    const M = new Float64Array(m * m)
    const B = new Float64Array(m * 3)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        const v = -Math.hypot(c[3 * i]! - c[3 * j]!, c[3 * i + 1]! - c[3 * j + 1]!, c[3 * i + 2]! - c[3 * j + 2]!)
        M[i * m + j] = v
        M[j * m + i] = v
      }
      M[i * m + i] = lambda[i]!
      M[i * m + n] = 1
      M[n * m + i] = 1
      for (let k = 0; k < 3; k++) {
        M[i * m + n + 1 + k] = c[3 * i + k]!
        M[(n + 1 + k) * m + i] = c[3 * i + k]!
        B[i * 3 + k] = dst[3 * i + k]! - src[3 * i + k]!
      }
    }
    // 高斯消元（部分选主元），三个右端一起做 / Gaussian elimination with partial pivoting, the three right-hand sides together
    for (let col = 0; col < m; col++) {
      let p = col
      for (let r = col + 1; r < m; r++) if (Math.abs(M[r * m + col]!) > Math.abs(M[p * m + col]!)) p = r
      if (p !== col) {
        for (let k = col; k < m; k++) [M[col * m + k], M[p * m + k]] = [M[p * m + k]!, M[col * m + k]!]
        for (let k = 0; k < 3; k++) [B[col * 3 + k], B[p * 3 + k]] = [B[p * 3 + k]!, B[col * 3 + k]!]
      }
      const d = M[col * m + col]! || 1e-30
      for (let r = col + 1; r < m; r++) {
        const f = M[r * m + col]! / d
        if (!f) continue
        for (let k = col; k < m; k++) M[r * m + k] = M[r * m + k]! - f * M[col * m + k]!
        for (let k = 0; k < 3; k++) B[r * 3 + k] = B[r * 3 + k]! - f * B[col * 3 + k]!
      }
    }
    const X = new Float64Array(m * 3)
    for (let r = m - 1; r >= 0; r--) for (let k = 0; k < 3; k++) {
      let s = B[r * 3 + k]!
      for (let j = r + 1; j < m; j++) s -= M[r * m + j]! * X[j * 3 + k]!
      X[r * 3 + k] = s / (M[r * m + r]! || 1e-30)
    }
    return new RbfWarp(c, X.slice(0, 3 * n), X.slice(3 * n), o)
  }

  apply(pts: ArrayLike<number>): Float32Array {
    const out = new Float32Array(pts.length)
    const { c, w, a, origin } = this
    const n = c.length / 3
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]! - origin[0]
      const y = pts[i + 1]! - origin[1]
      const z = pts[i + 2]! - origin[2]
      let ux = a[0]! + a[3]! * x + a[6]! * y + a[9]! * z
      let uy = a[1]! + a[4]! * x + a[7]! * y + a[10]! * z
      let uz = a[2]! + a[5]! * x + a[8]! * y + a[11]! * z
      for (let j = 0; j < n; j++) {
        const r = -Math.hypot(x - c[3 * j]!, y - c[3 * j + 1]!, z - c[3 * j + 2]!)
        ux += w[3 * j]! * r
        uy += w[3 * j + 1]! * r
        uz += w[3 * j + 2]! * r
      }
      out[i] = pts[i]! + ux
      out[i + 1] = pts[i + 1]! + uy
      out[i + 2] = pts[i + 2]! + uz
    }
    return out
  }
}

// ── 射线 / rays ─────────────────────────────────────────────────────────────────────────────────────────

interface Soup {
  /** 三角形顶点的当前位置和形变之前（摆位之后）的位置，每个三角形 9 个数 / present and pre-warp (re-posed) positions of the triangle corners, 9 numbers a triangle */
  now: Float32Array
  src: Float32Array
  /** 每个三角形：1 = 牙（只挡射线，不作约束） / per triangle: 1 = tooth (blocks the ray, gives no constraint) */
  tooth: Uint8Array
}

/** 射线与三角形汤的第一个交点（Möller–Trumbore，逐个三角形）：返回 t、三角形下标和重心坐标；没有交点时为 null / first hit of a ray on a triangle soup (Möller–Trumbore, triangle by triangle): t, the triangle and the barycentric coordinates; null without a hit */
function firstHit(s: Soup, o: V3, d: V3, tMax: number): { t: number; tri: number; u: number; v: number } | null {
  const p = s.now
  let best: { t: number; tri: number; u: number; v: number } | null = null
  let tBest = tMax
  for (let i = 0, tri = 0; i < p.length; i += 9, tri++) {
    const e1x = p[i + 3]! - p[i]!, e1y = p[i + 4]! - p[i + 1]!, e1z = p[i + 5]! - p[i + 2]!
    const e2x = p[i + 6]! - p[i]!, e2y = p[i + 7]! - p[i + 1]!, e2z = p[i + 8]! - p[i + 2]!
    const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x
    const a = e1x * hx + e1y * hy + e1z * hz
    if (a > -1e-14 && a < 1e-14) continue
    const f = 1 / a
    const sx = o[0] - p[i]!, sy = o[1] - p[i + 1]!, sz = o[2] - p[i + 2]!
    const u = f * (sx * hx + sy * hy + sz * hz)
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
    const v = f * (d[0] * qx + d[1] * qy + d[2] * qz)
    if (v < 0 || u + v > 1) continue
    const t = f * (e2x * qx + e2y * qy + e2z * qz)
    if (t > 0 && t < tBest) {
      tBest = t
      best = { t, tri, u, v }
    }
  }
  return best
}

// ── 输入、参数、结果 / input, options, result ──────────────────────────────────────────────────────────────

export interface HeadWarpPart {
  id: string
  name: string
  tissue: string
  system: string
  mesh: Mesh
  centrelines?: Polyline[]
}

export interface HeadOutline {
  dir: string
  skin: Mesh
  skinSha1: string
  landmarks: Record<string, { position: number[]; outwardNormal: number[] }>
  globes: { radiusMm: number; L: V3; R: V3; rule: string }
  /** 口裂中点（皮肤上） / the middle of the oral fissure (on the skin) */
  stomion: V3 | null
  /** head_outline.py 的报告里写的头的摆放（平移、混合带） / the placement of the head as its report states it (translation, blend band) */
  placement: Record<string, unknown> | null
  /** landmarks.json 的 browStandIn：渲染用的眉的替身（假定值），browPose.ts 用 / browStandIn of landmarks.json: the stand-in eyebrow of the renders (an assumption), used by browPose.ts */
  browStandIn?: unknown
}

/** 读 head_outline.py 写出的目录；目录或文件不全时返回 null / reads the directory written by head_outline.py; null when it or one of its files is missing */
export function loadHeadOutline(root: string, dir = HEAD_OUTLINE_DIR): HeadOutline | null {
  const skinFile = join(root, dir, 'skin-with-new-head.obj')
  const lmFile = join(root, dir, 'landmarks.json')
  if (!existsSync(skinFile) || !existsSync(lmFile)) return null
  const text = readFileSync(skinFile, 'utf8')
  const lm = JSON.parse(readFileSync(lmFile, 'utf8')) as { landmarks: HeadOutline['landmarks']; globes: { alternative_keepPresentRadius: { radiusMm: number; L: number[]; R: number[]; rule: string } }; oralFissure?: { stomion?: number[] } }
  const alt = lm.globes.alternative_keepPresentRadius
  let placement: Record<string, unknown> | null = null
  try {
    const rep = JSON.parse(readFileSync(join(root, dir, 'report.json'), 'utf8')) as { pose?: Record<string, unknown>; sameTopologyAsShipped?: { statureM?: unknown }; sexStrength?: unknown; headScale_xyz?: unknown }
    placement = { posture: rep.pose?.posture, headShiftMm_xyz: rep.pose?.rigidShiftOfTheHeadMm_xyz, blendBand_neckAxisFraction: rep.pose?.blendBand_neckAxisFraction, statureM: rep.sameTopologyAsShipped?.statureM, sexStrength: rep.sexStrength, headScale_xyz: rep.headScale_xyz }
  } catch {
    // 没有报告：只是少记一项 / no report: one record less
  }
  return { dir, skin: parseSkinObj(text), skinSha1: createHash('sha1').update(text).digest('hex').slice(0, 16), landmarks: lm.landmarks, globes: { radiusMm: alt.radiusMm, L: alt.L as V3, R: alt.R as V3, rule: alt.rule }, stomion: (lm.oralFissure?.stomion as V3 | undefined) ?? null, placement, ...((lm as { browStandIn?: unknown }).browStandIn ? { browStandIn: (lm as { browStandIn?: unknown }).browStandIn } : {}) }
}

/**
 * 牙列的均匀缩放（钉住的常数）。她的牙是男性的牙形变来的；牙冠近远中径男性比女性大。
 * 依据：Silva, Lopes, Martins-Filho, Biazevic & Michel-Crosato 2019, J Forensic Odontostomatol 37(1):2-19（PMID 31187738，PMC6875240；
 * 系统综述和荟萃分析，31 项研究、6481 人），表 3 各牙位近远中径性别二态性的中位数：上颌 11–17 为 2.74、2.71、4.64、2.30、2.15、2.64、3.22 %，
 * 下颌 41–47 为 2.04、2.45、5.64、2.14、2.37、3.09、3.51 %（2026-10-14 打开网页读到的数）。十四个牙位的中位数是 2.675 %，
 * 所以女/男 = 1 / 1.02675 = 0.974。整个牙列（上下牙一起）只乘这一个数：是相似变换，咬合关系按同一比例缩小而不改变。
 * 假定：(1) 二态性按“(男 − 女) / 女”计；(2) 一个均匀的比例代替各牙位各自的比例（尖牙实际差得更多）；(3) 牙冠高度、牙弓宽度按同一比例。
 * 上限也就是这个数：不许比它缩得更多。
 * The uniform scale of the dentition (a pinned constant). Her teeth are the male's teeth, warped; mesiodistal crown diameters are larger
 * in men. Basis: Silva, Lopes, Martins-Filho, Biazevic & Michel-Crosato 2019, J Forensic Odontostomatol 37(1):2-19 (PMID 31187738,
 * PMC6875240; a systematic review and meta-analysis of 31 studies, 6481 people), Table 3, median sexual dimorphism of the mesiodistal
 * diameter per tooth: upper 11-17 2.74, 2.71, 4.64, 2.30, 2.15, 2.64, 3.22 %, lower 41-47 2.04, 2.45, 5.64, 2.14, 2.37, 3.09, 3.51 %
 * (figures as read from the web page opened on 2026-10-14). The median over the fourteen teeth is 2.675 %, hence female / male =
 * 1 / 1.02675 = 0.974. Both arches together take this one factor: a similarity, under which the occlusion shrinks in proportion and is
 * otherwise unchanged. ASSUMPTIONS: (1) the dimorphism is (male - female) / female; (2) one uniform ratio stands in for the ratio of
 * each tooth (the canines really differ more); (3) crown height and arch breadth follow the same ratio. It is also the bound: no
 * smaller scale is allowed.
 */
export const PINNED_TOOTH_SCALE = { scale: 0.974, medianDimorphismPercent: 2.675, source: 'Silva et al. 2019, J Forensic Odontostomatol 37(1):2-19, PMID 31187738 (PMC6875240), Table 3: median sexual dimorphism of mesiodistal crown diameters, 31 studies, 6481 people', assumptions: 'dimorphism taken as (male - female) / female; one uniform ratio for every tooth and for crown height and arch breadth' } as const
/** 静止时口裂在上中切牙切缘上方这么多（米；假定，沿用 head_outline.py 的 INCISOR_SHOW） / at rest the oral fissure lies this far above the upper incisal edge (m; an assumption, INCISOR_SHOW of head_outline.py) */
export const INCISOR_SHOW = 0.002

/**
 * 绕 `centre` 的均匀缩放（纯函数） / a uniform scale about `centre` (pure)
 */
export function scaleAbout(pts: ArrayLike<number>, centre: V3, scale: number): Float32Array {
  const out = new Float32Array(pts.length)
  for (let i = 0; i < pts.length; i++) out[i] = centre[i % 3]! + scale * (pts[i]! - centre[i % 3]!)
  return out
}
export interface HeadWarpOptions {
  flexionDeg: number
  /** 稠密约束：皮肤采样间距、迭代遍数、每遍最多移动（米） / dense constraints: spacing of the skin samples, passes, largest move per pass (m) */
  denseSpacing: number
  passes: number
  maxStep: number
  /** 稠密约束的容许带：均值 ± band × SD / the band the dense constraints accept: mean ± band × SD */
  band: number
  /** 正则：λ = lambda / 权重 / regularisation: λ = lambda / weight */
  lambda: number
  weights: { dense: number; shallow: number; joint: number; teeth: number; globe: number }
  /** 骨在皮肤下至少这么深：max(floorMin, 均值 − floorSd × SD)（米） / the least depth of bone under the skin: max(floorMin, mean − floorSd × SD) (m) */
  floorMin: number
  floorSd: number
  /** 枕骨上离寰枕关节这么近的点不动（米） / points of the occipital bone this close to the atlanto-occipital joint stay (m) */
  jointRadius: number
  /** 眼球周围随它平移的一圈的半径（米） / radius of the shell translated with each globe (m) */
  globeShell: number
  /** 软组织的权重：到头的骨超过 fade[0] 开始减弱、fade[1] 处为零（米）；幂 / soft-tissue weight: fading from fade[0] to zero at fade[1] from the head bones (m); the power */
  fade: [number, number]
  power: number
  /** 只处理最高点在寰枕关节下方这么多以上的部件（米） / only parts reaching above this far below the atlanto-occipital joint are treated (m) */
  reachBelow: number
  /** 某条径线的变化超过它就报错（比例） / the build fails when a cranial dimension changes by more than this (ratio) */
  maxDimensionChange: number
  /** 牙列的均匀缩放（缺省 1；不得小于 PINNED_TOOTH_SCALE.scale） / uniform scale of the dentition (1 when absent; never below PINNED_TOOTH_SCALE.scale) */
  toothScale?: number
  /** 牙列是否按口裂和上唇摆放（见 warpHead 里的说明） / whether the dentition is placed by the oral fissure and the upper lip (see the note in warpHead) */
  placeTeeth?: boolean
}

export const HEAD_WARP_DEFAULTS: HeadWarpOptions = {
  flexionDeg: PINNED_HEAD_FLEXION.angleDeg,
  denseSpacing: 0.01,
  passes: 8,
  maxStep: 0.006,
  band: 0.8,
  lambda: 8e-3,
  weights: { dense: 1, shallow: 4, joint: 30, teeth: 6, globe: 4 },
  floorMin: 0.0015,
  floorSd: 2,
  jointRadius: 0.022,
  globeShell: 0.015,
  fade: [0.06, 0.14],
  power: 3,
  reachBelow: 0.22,
  maxDimensionChange: 0.15,
  toothScale: PINNED_TOOTH_SCALE.scale,
  placeTeeth: true,
}

export interface HeadWarpResult {
  moved: Map<string, { mesh: Mesh; centrelines?: Polyline[] }>
  report: Record<string, unknown>
}

/** 不动的结构：颈椎以下的骨、舌骨、喉和气管的软骨、甲状腺、椎间盘 / what stays: the bones from the atlas down, the hyoid, the cartilages of larynx and trachea, the thyroid gland, the intervertebral disks */
const STAY_NAME = /thyroid|cricoid|arytenoid|epiglottis|corniculate|cuneiform cartilage|trache|hyoid|intervertebral dis[ck]/i
const EYEBALL = /eyeball|choroid|corona ciliaris|cornea|\biris\b|\blens\b|retina|sclera|vitreous/i
const NASAL_CARTILAGE = /nasal cartilage|alar cartilage/i
/** 鼻软骨在皮肤下至少这么深（米；假定值） / the least depth of the nasal cartilages under the skin (m; an assumption) */
const NASAL_COVER = 0.001
/** 牙冠占牙长的比例（刚性）和其后过渡段的比例（假定值） / share of a tooth's length that is crown (rigid) and of the transition after it (assumptions) */
const TOOTH_CROWN = 0.4
const TOOTH_BLEND = 0.3
const sideOf = (name: string): 'L' | 'R' | null => (/\bleft\b/i.test(name) ? 'L' : /\bright\b/i.test(name) ? 'R' : null)

/**
 * 头的重新摆位和形变。`parts` 是全部部件（不被改写）；返回发生变化的部件的新几何和报告。
 * `rebuildNerve` 由中心线重建神经的管状网格（female.ts 传 nerveCourse.ts 的 nerveTubes）。
 * Re-poses and warps the head. `parts` is every part (not modified); returns the new geometry of the parts that
 * changed, and the report. `rebuildNerve` rebuilds a nerve's tube mesh from its centrelines (female.ts passes
 * nerveTubes of nerveCourse.ts).
 */
export function warpHead(parts: HeadWarpPart[], outline: HeadOutline, rebuildNerve: (lines: Polyline[]) => Mesh | null, opts: HeadWarpOptions = HEAD_WARP_DEFAULTS, log: (line: string) => void = () => {}): HeadWarpResult {
  if (!(opts.flexionDeg >= -PINNED_HEAD_FLEXION.maxDeg && opts.flexionDeg <= PINNED_HEAD_FLEXION.maxDeg)) throw new Error(`head warp: a flexion of ${opts.flexionDeg}° is beyond ±${PINNED_HEAD_FLEXION.maxDeg}°`)
  const byName = new Map<string, HeadWarpPart>()
  for (const p of parts) if (!byName.has(p.name)) byName.set(p.name, p)
  const meshOf = (name: string): Mesh => {
    const p = byName.get(name)
    if (!p) throw new Error(`head warp: no part named ${name}`)
    return p.mesh
  }
  const centroidOf = (name: string): V3 => measure(meshOf(name)).centroid as V3
  const headBones = parts.filter((p) => p.tissue === 'bone' && HEAD_BONE.test(p.name))
  const teeth = parts.filter((p) => p.tissue === 'tooth')
  const headIds = new Set(headBones.map((p) => p.id))
  const toothIds = new Set(teeth.map((p) => p.id))

  // ── 1. 重新摆位 / the re-pose
  const joint: AtlantoOccipital = atlantoOccipitalJoint(meshOf('Occipital bone'), meshOf('Atlas'))
  const pivot: V3 = [(joint.left[0] + joint.right[0]) / 2, (joint.left[1] + joint.right[1]) / 2, (joint.left[2] + joint.right[2]) / 2]
  const flex: RigidT = headFlexion(joint, opts.flexionDeg)
  const flexed = (m: Mesh): Mesh => ({ positions: applyToPoints(flex, m.positions), indices: m.indices })
  const globe0 = { L: centroidOf('Left vitreous body'), R: centroidOf('Right vitreous body') }
  const globeF = { L: applyT(flex, globe0.L), R: applyT(flex, globe0.R) }
  const fhOf = (f: (m: Mesh) => Mesh, g: { L: V3; R: V3 }) => frankfurtPlane({ temporalL: f(meshOf('Left temporal bone')), temporalR: f(meshOf('Right temporal bone')), infraorbitalL: [f(meshOf('Left maxilla')), f(meshOf('Left zygomatic bone'))], infraorbitalR: [f(meshOf('Right maxilla')), f(meshOf('Right zygomatic bone'))], globeL: g.L, globeR: g.R })
  const fhBefore = fhOf((m) => m, globe0)
  // 摆位之后的倾角用同一批点刚性变换后算：重新找点时外耳道的凹陷会换一个 / the tilt after the re-pose is that of the same points moved rigidly: found anew, another pit of the meatus may be picked
  const riseOf = (p: V3, o: V3) => (Math.atan2(applyT(flex, o)[1] - applyT(flex, p)[1], applyT(flex, o)[2] - applyT(flex, p)[2]) * 180) / Math.PI
  const fhAfterL = riseOf(fhBefore.porion.left, fhBefore.orbitale.left)
  const fhAfterR = riseOf(fhBefore.porion.right, fhBefore.orbitale.right)
  const fhAfter = { riseDeg: { left: r1(fhAfterL, 2), right: r1(fhAfterR, 2), mean: r1((fhAfterL + fhAfterR) / 2, 2) } }
  log(`re-pose: flexion ${opts.flexionDeg}° about the atlanto-occipital joint (centres L ${joint.left.map((v) => mm(v)).join(', ')} / R ${joint.right.map((v) => mm(v)).join(', ')} mm); Frankfurt plane rises ${fhBefore.riseDeg.mean}° → ${fhAfter.riseDeg.mean}° towards the front`)

  // 摆位之后的头骨和牙：采样点（找标志点用）和三角形汤（射线用） / head bones and teeth after the re-pose: samples (for the landmarks) and the triangle soup (for the rays)
  const srcMesh = new Map<string, Mesh>()
  for (const p of [...headBones, ...teeth]) srcMesh.set(p.id, flexed(p.mesh))
  const samplesOf = (get: (p: HeadWarpPart) => Mesh): BonePoints => {
    const cache = new Map<string, Float32Array>()
    return (name: string) => {
      let v = cache.get(name)
      if (!v) {
        const p = byName.get(name)
        if (!p) throw new Error(`head warp: no part named ${name}`)
        cache.set(name, (v = thinPoints(surfacePoints(get(p), 0.0007), 0.0005)))
      }
      return v
    }
  }
  const lmSrc = boneLandmarks(samplesOf((p) => srcMesh.get(p.id)!), globeF)

  // ── 2. 约束 / the constraints
  const skin = outline.skin
  const skinN = computeNormals(skin)
  const tester = new InsideTester(skin, 256)
  const surface = new SurfaceDistance(skin)
  /** 在皮肤下的深度（米；负 = 在皮肤外） / depth under the skin (m; negative = outside it) */
  const depthAt = (x: number, y: number, z: number) => (tester.contains(x, y, z) ? 1 : -1) * surface.distance(x, y, z, 0.08)
  const skinLm = (key: string) => {
    const e = outline.landmarks[key]
    if (!e) throw new Error(`head warp: landmarks.json has no ${key}`)
    return e
  }
  // 厚度场：各标志点的均值和 SD 按到皮肤标志点距离的四次方反比插值 / the depth field: means and SDs of the landmarks interpolated by the inverse fourth power of the distance to the skin landmarks
  const fieldPts = DEPTHS.map((d) => ({ p: skinLm(d.skin).position, mean: d.meanMm / 1000, sd: d.sdMm / 1000 }))
  const depthField = (x: number, y: number, z: number): { mean: number; sd: number } => {
    let w = 0
    let m = 0
    let s = 0
    for (const f of fieldPts) {
      const d2 = (x - f.p[0]!) ** 2 + (y - f.p[1]!) ** 2 + (z - f.p[2]!) ** 2 + 1e-5
      const wi = 1 / (d2 * d2)
      w += wi
      m += wi * f.mean
      s += wi * f.sd
    }
    return { mean: m / w, sd: s / w }
  }
  // 头部皮肤的采样点：寰枕关节下方 65 mm 以上，离耳道口 32 mm 以外（耳廓下面没有贴着的骨）；寰枕关节下方 20 mm 以下、
  // 朝下的皮肤（颏下、颌下）不取：那里是新头与原来的颈部皮肤混合的带，不是头模型自己的形状。
  // skin samples of the head: above 65 mm below the atlanto-occipital joint and more than 32 mm from the ear canal openings (no bone
  // lies under the auricle); skin facing down (under the chin and the jaw) lower than 20 mm below the joint is left out: that is
  // the band where the new head is blended into the shipped neck skin, not the head model's own shape.
  const ears = ['earCanal_L', 'earCanal_R'].map((k) => skinLm(k).position)
  const cand: number[] = []
  const candIdx: number[] = []
  for (let v = 0; v < skin.positions.length / 3; v++) {
    const x = skin.positions[3 * v]!
    const y = skin.positions[3 * v + 1]!
    const z = skin.positions[3 * v + 2]!
    if (y < pivot[1] - 0.065 || ears.some((e) => dist(e, [x, y, z]) < 0.032)) continue
    if (y < pivot[1] - 0.02 && skinN[3 * v + 1]! < -0.5) continue
    cand.push(x, y, z)
    candIdx.push(v)
  }
  const pick = voxelSubsample(Float32Array.from(cand), opts.denseSpacing)
  const skinSamples = Array.from(pick, (i) => {
    const v = candIdx[i]!
    const p: V3 = [skin.positions[3 * v]!, skin.positions[3 * v + 1]!, skin.positions[3 * v + 2]!]
    const n: V3 = [skinN[3 * v]!, skinN[3 * v + 1]!, skinN[3 * v + 2]!]
    return { p, n, ...depthField(p[0], p[1], p[2]) }
  })

  // 固定的约束：标志点、寰枕关节、眼球 / the fixed constraints: landmarks, the joint, the globes
  interface Constraint { src: V3; dst: V3; weight: number }
  const fixed: Constraint[] = []
  const lmRows: { skin: string; bone: string; weight: number; src: V3; dst: V3 }[] = []
  for (const d of DEPTHS) {
    if (!d.bone || d.weight <= 0) continue
    const s = skinLm(d.skin)
    const src = lmSrc[d.bone]
    if (!src) throw new Error(`head warp: no bony landmark ${d.bone}`)
    const dst: V3 = [s.position[0]! - (d.meanMm / 1000) * s.outwardNormal[0]!, s.position[1]! - (d.meanMm / 1000) * s.outwardNormal[1]!, s.position[2]! - (d.meanMm / 1000) * s.outwardNormal[2]!]
    fixed.push({ src, dst, weight: d.weight })
    lmRows.push({ skin: d.skin, bone: d.bone, weight: d.weight, src, dst })
  }
  const occF = srcMesh.get(byName.get('Occipital bone')!.id)!
  const jointPts = thinPoints(surfacePoints(occF, 0.002), 0.004)
  let jointN = 0
  for (let i = 0; i < jointPts.length; i += 3) {
    const p: V3 = [jointPts[i]!, jointPts[i + 1]!, jointPts[i + 2]!]
    if (Math.min(dist(p, joint.left), dist(p, joint.right), dist(p, pivot)) > opts.jointRadius) continue
    fixed.push({ src: p, dst: p, weight: opts.weights.joint })
    jointN++
  }
  const globeTarget = { L: outline.globes.L, R: outline.globes.R }
  const SHELL: V3[] = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) SHELL.push([sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3)])
  for (const S of ['L', 'R'] as const) for (const u of SHELL) {
    const src: V3 = [globeF[S][0] + opts.globeShell * u[0], globeF[S][1] + opts.globeShell * u[1], globeF[S][2] + opts.globeShell * u[2]]
    fixed.push({ src, dst: [src[0] + globeTarget[S][0] - globeF[S][0], src[1] + globeTarget[S][1] - globeF[S][1], src[2] + globeTarget[S][2] - globeF[S][2]], weight: opts.weights.globe })
  }
  const toothPts = thinPoints(concat(teeth.map((p) => surfacePoints(srcMesh.get(p.id)!, 0.003))), 0.006)
  const boneVerts = thinPoints(concat(headBones.map((p) => srcMesh.get(p.id)!.positions)), 0.005)

  // 三角形汤 / the triangle soup
  const soupParts = [...headBones, ...teeth]
  const nTri = soupParts.reduce((s, p) => s + p.mesh.indices.length / 3, 0)
  const soup: Soup = { now: new Float32Array(nTri * 9), src: new Float32Array(nTri * 9), tooth: new Uint8Array(nTri) }
  {
    let t = 0
    for (const p of soupParts) {
      const m = srcMesh.get(p.id)!
      for (let i = 0; i < m.indices.length; i += 3, t++) {
        for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) soup.src[9 * t + 3 * k + a] = m.positions[3 * m.indices[i + k]! + a]!
        soup.tooth[t] = p.tissue === 'tooth' ? 1 : 0
      }
    }
  }
  const fitWith = (extra: Constraint[]): RbfWarp => {
    const all = [...fixed, ...extra]
    const src = new Float64Array(all.length * 3)
    const dst = new Float64Array(all.length * 3)
    const lam = new Float64Array(all.length)
    all.forEach((c, i) => {
      for (let k = 0; k < 3; k++) {
        src[3 * i + k] = c.src[k]!
        dst[3 * i + k] = c.dst[k]!
      }
      lam[i] = opts.lambda / c.weight
    })
    return RbfWarp.fit(src, dst, lam)
  }
  // 牙列：先绕自己的中心均匀缩小（钉住的性别比，见 PINNED_TOOTH_SCALE），再做一个刚体运动——合起来是相似变换
  // the dentition: first shrunk uniformly about its own centre (the pinned sex ratio, see PINNED_TOOTH_SCALE), then one rigid motion - together a similarity
  const toothScale = opts.toothScale ?? 1
  if (!(toothScale >= PINNED_TOOTH_SCALE.scale - 1e-9 && toothScale <= 1)) throw new Error(`head warp: a tooth scale of ${toothScale} is outside ${PINNED_TOOTH_SCALE.scale}…1`)
  const toothCentre: V3 = [0, 0, 0]
  for (let i = 0; i < toothPts.length; i++) toothCentre[i % 3] = toothCentre[i % 3]! + toothPts[i]! / (toothPts.length / 3)
  const scaled = (pts: ArrayLike<number>): Float32Array => scaleAbout(pts, toothCentre, toothScale)
  const toothPtsS = scaled(toothPts)
  let W = fitWith([])
  let toothRigid = fitRigid(toothPtsS, W.apply(toothPts))
  // 牙列的摆放：上中切牙切缘在口裂（stomion）下方 INCISOR_SHOW，唇面在上唇点（labrale superius）下“表里的唇厚”处（只取前后分量）。
  // 以前牙只是跟着形变场的最佳刚体走，而形变场又被牙的约束拉在原地，切缘因此比口裂低 5 mm、靠后 4 mm。现在每一遍把牙列朝这个位置平移
  // （每遍不超过 maxStep），牙槽骨由形变场跟着牙走。
  // Placing the dentition: the upper incisal edge INCISOR_SHOW below stomion, the labial face under labrale superius at the tabled lip
  // thickness (its fore-aft component only). Before, the teeth merely followed the best rigid motion of the field while their own
  // constraints held the field in place, which left the edge 5 mm below the fissure and 4 mm behind it. Now each pass translates the
  // dentition towards that position (by at most maxStep a pass) and the field brings the alveolar bone after the teeth.
  const labialRow = lmRows.find((r) => r.bone === 'upperIncisorLabial')
  const toothWanted = (rigid: typeof toothRigid): V3 => {
    if (!opts.placeTeeth || !outline.stomion || !labialRow) return [0, 0, 0]
    const e = applyRigid(rigid, scaled(lmSrc.upperIncisalEdge!))
    const l = applyRigid(rigid, scaled(lmSrc.upperIncisorLabial!))
    return [0, outline.stomion[1] - INCISOR_SHOW - e[1]!, labialRow.dst[2] - l[2]!]
  }
  const passRows: Record<string, unknown>[] = []
  let denseCount = 0
  /** 曾经太浅的骨顶点：以后各遍都留着约束（够深了就约束在原地），免得一放开又弹回去 / bone vertices that were once too shallow keep a constraint in every later pass (holding them where they are once deep enough), or they spring back when released */
  const sticky = new Set<number>()
  for (let pass = 0; pass <= opts.passes; pass++) {
    soup.now.set(W.apply(soup.src))
    // 牙在汤里按刚体放 / the teeth sit in the soup by their rigid motion
    for (let t = 0; t < nTri; t++) if (soup.tooth[t]) soup.now.set(applyRigid(toothRigid, scaled(soup.src.subarray(9 * t, 9 * t + 9))), 9 * t)
    const extra: Constraint[] = []
    const errs: number[] = []
    for (const s of skinSamples) {
      const o: V3 = [s.p[0] - 0.0005 * s.n[0], s.p[1] - 0.0005 * s.n[1], s.p[2] - 0.0005 * s.n[2]]
      const d: V3 = [-s.n[0], -s.n[1], -s.n[2]]
      const h = firstHit(soup, o, d, 2.2 * s.mean + 0.006)
      if (!h || soup.tooth[h.tri]) continue
      const i = 9 * h.tri
      const w0 = 1 - h.u - h.v
      const src: V3 = [0, 1, 2].map((a) => w0 * soup.src[i + a]! + h.u * soup.src[i + 3 + a]! + h.v * soup.src[i + 6 + a]!) as V3
      const cur = h.t + 0.0005
      errs.push(cur - s.mean)
      // 目标不是均值，而是“均值 ± band × SD”这个带里离现在最近的值：骨只在太浅或太深时才动，动到带的边上为止
      // the target is not the mean but the value nearest the present one inside mean ± band × SD: bone moves only where it is too shallow or too deep, and only to the edge of the band
      const want = Math.max(s.mean - opts.band * s.sd, Math.min(s.mean + opts.band * s.sd, cur))
      const step = Math.max(-opts.maxStep, Math.min(opts.maxStep, cur - want))
      // 现在的交点沿皮肤法线移动 step（正 = 朝皮肤） / the present hit moved by `step` along the skin normal (positive = towards the skin)
      const hit: V3 = [o[0] + h.t * d[0], o[1] + h.t * d[1], o[2] + h.t * d[2]]
      extra.push({ src, dst: [hit[0] + step * s.n[0], hit[1] + step * s.n[1], hit[2] + step * s.n[2]], weight: cur < s.mean - s.sd ? opts.weights.shallow : opts.weights.dense })
    }
    denseCount = extra.length
    // 离皮肤不足下限或在皮肤外的骨顶点：沿指向最近皮肤点的反方向推到下限以内 1 mm
    // bone vertices closer to the skin than the lower bound, or outside it: pushed away from the nearest skin point to 1 mm inside the bound
    const nowVerts = W.apply(boneVerts)
    let shallow = 0
    let minDepth = Infinity
    for (let i = 0; i < nowVerts.length; i += 3) {
      const x = nowVerts[i]!
      const y = nowVerts[i + 1]!
      const z = nowVerts[i + 2]!
      if (y < pivot[1] - 0.065) continue
      const dep = depthAt(x, y, z)
      if (dep < minDepth) minDepth = dep
      const f = depthField(x, y, z)
      const floor = Math.max(opts.floorMin, f.mean - opts.floorSd * f.sd)
      if (dep >= floor + 0.0005) {
        if (sticky.has(i)) extra.push({ src: [boneVerts[i]!, boneVerts[i + 1]!, boneVerts[i + 2]!], dst: [x, y, z], weight: opts.weights.shallow })
        continue
      }
      sticky.add(i)
      if (dep < floor) shallow++
      // 最近皮肤点的方向：无符号距离的数值梯度 / the direction of the nearest skin point: the numeric gradient of the unsigned distance
      const H = 0.0005
      const g: V3 = [surface.distance(x + H, y, z, 0.08) - surface.distance(x - H, y, z, 0.08), surface.distance(x, y + H, z, 0.08) - surface.distance(x, y - H, z, 0.08), surface.distance(x, y, z + H, 0.08) - surface.distance(x, y, z - H, 0.08)]
      const gl = Math.hypot(g[0], g[1], g[2]) || 1
      // 在皮肤内：朝距离增大的方向（远离皮肤）；在皮肤外：朝距离减小的方向（回到皮肤里） / inside: towards growing distance (away from the skin); outside: towards shrinking distance (back inside)
      const sgn = dep >= 0 ? 1 : -1
      const stepLen = Math.min(opts.maxStep, floor + 0.001 - dep)
      extra.push({ src: [boneVerts[i]!, boneVerts[i + 1]!, boneVerts[i + 2]!], dst: [x + (sgn * stepLen * g[0]) / gl, y + (sgn * stepLen * g[1]) / gl, z + (sgn * stepLen * g[2]) / gl], weight: opts.weights.shallow })
    }
    // 眼眶要容得下眼球：落在“眼球半径 + 1 mm”以内的骨顶点沿径向推到半径 + 1.5 mm 处
    // the orbit must hold the globe: bone vertices within the globe's radius + 1 mm are pushed out radially to radius + 1.5 mm
    let inOrbit = 0
    const rg = outline.globes.radiusMm / 1000
    for (let i = 0; i < nowVerts.length; i += 3) for (const S of ['L', 'R'] as const) {
      const c = globeTarget[S]
      const dx = nowVerts[i]! - c[0]
      const dy = nowVerts[i + 1]! - c[1]
      const dz = nowVerts[i + 2]! - c[2]
      const r = Math.hypot(dx, dy, dz)
      if (r >= rg + 0.001 || r < 1e-6) continue
      const k = (rg + 0.0015) / r
      extra.push({ src: [boneVerts[i]!, boneVerts[i + 1]!, boneVerts[i + 2]!], dst: [c[0] + k * dx, c[1] + k * dy, c[2] + k * dz], weight: opts.weights.shallow })
      inOrbit++
    }
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / Math.max(1, errs.length))
    passRows.push({ pass, denseHits: errs.length, depthMinusMeanMm: { rms: mm(rms, 2), p05: mm(quantile(errs, 0.05)), median: mm(quantile(errs, 0.5)), p95: mm(quantile(errs, 0.95)) }, boneVerticesBelowTheFloor: shallow, boneVerticesInsideAGlobe: inOrbit, leastBoneDepthMm: mm(minDepth, 2) })
    log(`  pass ${pass}: ${errs.length} rays met bone; depth − mean rms ${mm(rms, 2)} mm (5 % ${mm(quantile(errs, 0.05))}, median ${mm(quantile(errs, 0.5))}, 95 % ${mm(quantile(errs, 0.95))}); ${shallow} bone vertices under the floor, ${inOrbit} within a globe, least depth ${mm(minDepth, 2)} mm`)
    if (pass === opts.passes) break
    // 牙：按现在的 W 的最佳刚体 / the teeth: by the best rigid motion of the present W
    const tNow = applyRigid(toothRigid, toothPtsS)
    const want = toothWanted(toothRigid).map((v) => Math.max(-opts.maxStep, Math.min(opts.maxStep, v))) as V3
    for (let i = 0; i < toothPts.length; i += 3) extra.push({ src: [toothPts[i]!, toothPts[i + 1]!, toothPts[i + 2]!], dst: [tNow[i]! + want[0], tNow[i + 1]! + want[1], tNow[i + 2]! + want[2]], weight: opts.weights.teeth })
    W = fitWith(extra)
    // 牙的刚体：上一遍的位置加上这一遍的平移，转动取形变场的最佳刚体的转动（平移不再交给形变场去“平均”，否则到不了位）
    // the rigid motion of the teeth: last pass's position plus this pass's translation, the rotation that of the field's best rigid motion (the translation is no longer left to the field to average, or the teeth never arrive)
    const fitted = fitRigid(toothPtsS, W.apply(toothPts))
    if (opts.placeTeeth && outline.stomion && labialRow) {
      const a = applyRigid(fitted, toothPtsS)
      const shift: V3 = [0, 0, 0]
      for (let i = 0; i < a.length; i++) shift[i % 3] = shift[i % 3]! + (tNow[i]! + want[i % 3]! - a[i]!) / (a.length / 3)
      // 平移并进刚体：先用拟合的刚体，再把重心移到要去的地方 / the shift is folded into the rigid motion: the fitted motion, then its centroid moved to where it should be
      toothRigid = fitRigid(toothPtsS, Float32Array.from(a, (v, i) => v + shift[i % 3]!))
    } else toothRigid = fitted
  }

  // ── 3. 应用 / applying it
  // 头的映射 H = W ∘ 前屈；软组织 x' = x + w(x)·(H(x) − x)
  // the head's map H = W ∘ flexion; soft tissue x' = x + w(x)·(H(x) − x)
  const H = (pts: Float32Array): Float32Array => W.apply(applyToPoints(flex, pts))
  const yLow = pivot[1] - opts.reachBelow
  const stays = (p: HeadWarpPart) => !headIds.has(p.id) && !toothIds.has(p.id) && (p.tissue === 'bone' || ((p.tissue === 'cartilage' || p.tissue === 'gland' || p.tissue === 'organ') && STAY_NAME.test(p.name)))
  const inReach = (p: HeadWarpPart) => measure(p.mesh).bbox[4] > yLow
  const stayParts = parts.filter((p) => stays(p) && inReach(p) && !NASAL_CARTILAGE.test(p.name))
  const stayIds = new Set(stayParts.map((p) => p.id))
  const headIndex = new PointIndex(thinPoints(concat([...headBones, ...teeth].map((p) => surfacePoints(p.mesh, 0.003))), 0.003), 0.01)
  const stayIndex = new PointIndex(thinPoints(concat(stayParts.map((p) => surfacePoints(p.mesh, 0.003))), 0.003), 0.01)
  const EPS = 0.002
  const weightAt = (x: number, y: number, z: number): number => {
    const dh = headIndex.distance(x, y, z, opts.fade[1])
    if (!(dh < opts.fade[1])) return 0
    const ds = stayIndex.distance(x, y, z, 0.3)
    const ratio = ((dh + EPS) / (Math.min(ds, 0.3) + EPS)) ** opts.power
    const t = dh <= opts.fade[0] ? 1 : 1 - (dh - opts.fade[0]) / (opts.fade[1] - opts.fade[0])
    return (t * t * (3 - 2 * t)) / (1 + ratio)
  }
  const blend = (pts: Float32Array): Float32Array => {
    // 只对权重不为零的点求 H / H is evaluated only where the weight is not zero
    const out = Float32Array.from(pts)
    const w = new Float32Array(pts.length / 3)
    const live: number[] = []
    for (let i = 0; i < pts.length; i += 3) {
      w[i / 3] = pts[i + 1]! < yLow ? 0 : weightAt(pts[i]!, pts[i + 1]!, pts[i + 2]!)
      if (w[i / 3]! > 0) live.push(i)
    }
    const q = new Float32Array(live.length * 3)
    live.forEach((i, j) => q.set(pts.subarray(i, i + 3), 3 * j))
    const h = H(q)
    live.forEach((i, j) => {
      for (let k = 0; k < 3; k++) out[i + k] = pts[i + k]! + w[i / 3]! * (h[3 * j + k]! - pts[i + k]!)
    })
    return out
  }
  const toothTotal = (pts: Float32Array) => applyRigid(toothRigid, scaled(applyToPoints(flex, pts)))
  // 眼球的平移：角膜顶点（摆位之后最靠前的点）落到对称的目标上。目标 = 中心目标 + 两侧“顶点 − 中心”的镜像平均
  // （x 分量左右反号）。她的左眼球比右眼球大（巩膜半径约 12.4 对 12.0 mm），按中心对齐时左角膜要靠前约 0.85 mm。
  // 这一步只动眼球，不动骨（骨的形变场仍按中心目标），所以骨架指纹不变。
  // The translation of the eyeballs: the corneal apex (the most anterior point after the re-pose) goes to a symmetric target.
  // Target = centre target + the mirrored mean of both sides' "apex − centre" (x component of opposite sign on the two sides).
  // Her left globe is larger than the right (sclera radius about 12.4 against 12.0 mm); aligned by the centres the left cornea
  // stood about 0.85 mm further forward. Only the eyeballs move here, not the bones (the warp of the bones still uses the
  // centre targets), so the skeleton fingerprint does not change.
  const apexOf = (S: 'Left' | 'Right'): V3 => {
    const c = applyToPoints(flex, meshOf(`${S} cornea`).positions)
    let k = 0
    for (let i = 0; i < c.length; i += 3) if (c[i + 2]! > c[k + 2]!) k = i
    return [c[k]!, c[k + 1]!, c[k + 2]!]
  }
  const apexF = { L: apexOf('Left'), R: apexOf('Right') }
  const offL = [0, 1, 2].map((k) => apexF.L[k]! - globeF.L[k]!)
  const offR = [0, 1, 2].map((k) => apexF.R[k]! - globeF.R[k]!)
  const offMean: V3 = [(offL[0]! - offR[0]!) / 2, (offL[1]! + offR[1]!) / 2, (offL[2]! + offR[2]!) / 2]
  const apexTarget = { L: [globeTarget.L[0] + offMean[0], globeTarget.L[1] + offMean[1], globeTarget.L[2] + offMean[2]] as V3, R: [globeTarget.R[0] - offMean[0], globeTarget.R[1] + offMean[1], globeTarget.R[2] + offMean[2]] as V3 }
  const globeShift = { L: [0, 1, 2].map((k) => apexTarget.L[k]! - apexF.L[k]!) as V3, R: [0, 1, 2].map((k) => apexTarget.R[k]! - apexF.R[k]!) as V3 }
  const moved = new Map<string, { mesh: Mesh; centrelines?: Polyline[] }>()
  const nasalRows: Record<string, unknown>[] = []
  let rootMove = 0
  const kinds: Record<string, number> = { headBone: 0, tooth: 0, eyeball: 0, blended: 0, nerve: 0 }
  const maxMove = (a: Float32Array, b: Float32Array) => {
    let m = 0
    for (let i = 0; i < a.length; i += 3) m = Math.max(m, Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!, a[i + 2]! - b[i + 2]!))
    return m
  }
  for (const p of parts) {
    if (stayIds.has(p.id) || !inReach(p)) continue
    if (p.tissue === 'bone' && !headIds.has(p.id)) continue
    let positions: Float32Array
    let centrelines: Polyline[] | undefined
    let mesh: Mesh | null = null
    if (headIds.has(p.id)) {
      positions = H(p.mesh.positions)
      kinds.headBone = kinds.headBone! + 1
    } else if (toothIds.has(p.id)) {
      // 牙冠（从切缘或咬合面起占牙长的 40 %）严格按刚体走，咬合不变；牙根在其后 30 % 的牙长内过渡到随牙槽骨的形变走，
      // 否则颏部变矮之后刚性的长牙根会从下颌骨里穿出来（第一次试建时看到的）。
      // the crown (40 % of the tooth's length from the incisal edge or occlusal surface) follows the rigid motion exactly, so the
      // occlusion is unchanged; over the next 30 % of the length the root passes to the warp of the alveolar bone, or the long
      // rigid roots come out of the mandible once the chin is lower (seen in the first trial build).
      const rigid = toothTotal(p.mesh.positions)
      const soft = H(p.mesh.positions)
      const upper = /\bupper\b/i.test(p.name)
      let y0 = Infinity
      let y1 = -Infinity
      for (let i = 1; i < p.mesh.positions.length; i += 3) {
        y0 = Math.min(y0, p.mesh.positions[i]!)
        y1 = Math.max(y1, p.mesh.positions[i]!)
      }
      positions = new Float32Array(rigid.length)
      for (let i = 0; i < rigid.length; i += 3) {
        const h = (upper ? p.mesh.positions[i + 1]! - y0 : y1 - p.mesh.positions[i + 1]!) / Math.max(1e-6, y1 - y0)
        const t = Math.max(0, Math.min(1, (h - TOOTH_CROWN) / TOOTH_BLEND))
        const k = t * t * (3 - 2 * t)
        for (let a = 0; a < 3; a++) positions[i + a] = rigid[i + a]! + k * (soft[i + a]! - rigid[i + a]!)
        rootMove = Math.max(rootMove, k * Math.hypot(soft[i]! - rigid[i]!, soft[i + 1]! - rigid[i + 1]!, soft[i + 2]! - rigid[i + 2]!))
      }
      kinds.tooth = kinds.tooth! + 1
    } else if (EYEBALL.test(p.name) && sideOf(p.name)) {
      const s = globeShift[sideOf(p.name)!]
      const f = applyToPoints(flex, p.mesh.positions)
      positions = Float32Array.from(f, (v, i) => v + s[i % 3]!)
      kinds.eyeball = kinds.eyeball! + 1
    } else {
      positions = blend(p.mesh.positions)
      if (maxMove(positions, p.mesh.positions) < 1e-6) continue
      if (NASAL_CARTILAGE.test(p.name)) {
        // 鼻软骨收进新鼻子里：离皮肤不足 1 mm 或在皮肤外的顶点沿离开皮肤的方向移到皮肤下 1 mm（最多三遍）
        // the nasal cartilages are brought inside the new nose: vertices less than 1 mm under the skin, or outside it, move away from the skin to 1 mm under it (three passes at most)
        const row = { name: p.name, vertices: positions.length / 3, movedVertices: 0, maxMoveMm: 0, leastDepthBeforeMm: Infinity, leastDepthAfterMm: Infinity }
        for (let i = 0; i < positions.length; i += 3) {
          const start: V3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!]
          let q: V3 = [...start]
          let dep = depthAt(q[0], q[1], q[2])
          row.leastDepthBeforeMm = Math.min(row.leastDepthBeforeMm, dep * 1000)
          for (let it = 0; it < 3 && dep < NASAL_COVER; it++) {
            const Hh = 0.0005
            const g: V3 = [surface.distance(q[0] + Hh, q[1], q[2], 0.08) - surface.distance(q[0] - Hh, q[1], q[2], 0.08), surface.distance(q[0], q[1] + Hh, q[2], 0.08) - surface.distance(q[0], q[1] - Hh, q[2], 0.08), surface.distance(q[0], q[1], q[2] + Hh, 0.08) - surface.distance(q[0], q[1], q[2] - Hh, 0.08)]
            const gl = Math.hypot(g[0], g[1], g[2]) || 1
            const k = ((dep >= 0 ? 1 : -1) * (NASAL_COVER + 0.0002 - dep)) / gl
            q = [q[0] + k * g[0], q[1] + k * g[1], q[2] + k * g[2]]
            dep = depthAt(q[0], q[1], q[2])
          }
          row.leastDepthAfterMm = Math.min(row.leastDepthAfterMm, dep * 1000)
          const d = dist(q, start)
          if (d > 1e-7) {
            row.movedVertices++
            row.maxMoveMm = Math.max(row.maxMoveMm, d * 1000)
            positions.set(q, i)
          }
        }
        nasalRows.push({ ...row, maxMoveMm: r1(row.maxMoveMm), leastDepthBeforeMm: r1(row.leastDepthBeforeMm), leastDepthAfterMm: r1(row.leastDepthAfterMm) })
      }
      if (p.tissue === 'nerve' && p.centrelines?.length) {
        centrelines = p.centrelines.map((l) => ({ points: blend(l.points), radius: l.radius }))
        mesh = rebuildNerve(centrelines)
        kinds.nerve = kinds.nerve! + 1
      } else {
        if (p.centrelines) centrelines = p.centrelines.map((l) => ({ points: blend(l.points), radius: l.radius }))
        kinds.blended = kinds.blended! + 1
      }
    }
    moved.set(p.id, { mesh: mesh ?? { positions, indices: p.mesh.indices }, ...(centrelines ? { centrelines } : {}) })
  }
  const after = (p: HeadWarpPart): Mesh => moved.get(p.id)?.mesh ?? p.mesh
  const afterByName = (name: string) => after(byName.get(name)!)

  // ── 4. 检查 / the checks
  // 每块骨的位移：摆位、形变（相对摆位之后）、合计 / per bone: the re-pose, the warp (against the re-posed bone), the total
  const boneRows = [...headBones].sort((a, b) => (a.name < b.name ? -1 : 1)).map((p) => {
    const f = srcMesh.get(p.id)!.positions
    const a = after(p).positions
    const st = (x: Float32Array, y: Float32Array) => {
      let s = 0
      let m = 0
      for (let i = 0; i < x.length; i += 3) {
        const d = Math.hypot(x[i]! - y[i]!, x[i + 1]! - y[i + 1]!, x[i + 2]! - y[i + 2]!)
        s += d * d
        m = Math.max(m, d)
      }
      return { maxMm: mm(m), rmsMm: mm(Math.sqrt(s / (x.length / 3))) }
    }
    return { id: p.id, name: p.name, rePose: st(p.mesh.positions, f), warp: st(f, a), total: st(p.mesh.positions, a) }
  })
  // 实质点：摆位之后找到的标志点过 W（刚性摆位不改变距离） / material points: the landmarks found after the re-pose, carried through W (the rigid re-pose changes no distance)
  const lmMapped: Record<string, V3> = {}
  for (const [k, v] of Object.entries(lmSrc)) {
    const q = W.apply(Float32Array.from(v))
    lmMapped[k] = [q[0]!, q[1]!, q[2]!]
  }
  const dimsBefore = cranialDimensions(samplesOf((p) => srcMesh.get(p.id)!), lmSrc, globeF)
  const dimsAfter = cranialDimensions(samplesOf(after), lmMapped, globeTarget)
  const dims = Object.keys(dimsBefore).map((k) => ({ dimension: k, beforeMm: dimsBefore[k]!, afterMm: dimsAfter[k]!, changePercent: r1(100 * (dimsAfter[k]! / dimsBefore[k]! - 1)) }))
  const over = (t: number) => dims.filter((d) => Math.abs(d.changePercent) > t).map((d) => `${d.dimension} ${d.changePercent > 0 ? '+' : ''}${d.changePercent} %`)
  // 雅可比：W 在头骨附近的点上；合成映射在头颈所有被移动的部件附近 / Jacobian: of W at points near the head bones; of the composed map near every moved part of head and neck
  const jacW = jacobianStats((q) => W.apply(q), thinPoints(concat(headBones.map((p) => srcMesh.get(p.id)!.positions)), 0.008), 0.002)
  const movedPts = thinPoints(concat(parts.filter((p) => moved.has(p.id) && !headIds.has(p.id) && !toothIds.has(p.id)).map((p) => thinPoints(p.mesh.positions, 0.008))), 0.008)
  const jacAll = jacobianStats(blend, movedPts, 0.002)
  // 行列式最小的几处在哪块骨附近（定位折叠用） / near which bone the smallest determinants lie (to locate a fold)
  const worstJacobian = (() => {
    const q = thinPoints(concat(headBones.map((p) => srcMesh.get(p.id)!.positions)), 0.008)
    const owner = headBones.map((p) => ({ name: p.name, index: new PointIndex(thinPoints(srcMesh.get(p.id)!.positions, 0.004), 0.01) }))
    const rows: { det: number; atMm: number[]; nearest: string }[] = []
    for (let i = 0; i < q.length; i += 3) {
      const det = jacobianStats((x) => W.apply(x), q.subarray(i, i + 3), 0.002).min
      if (det > 0.3) continue
      let best = ''
      let bd = Infinity
      for (const o of owner) {
        const d = o.index.distance(q[i]!, q[i + 1]!, q[i + 2]!, bd)
        if (d < bd) {
          bd = d
          best = o.name
        }
      }
      rows.push({ det, atMm: [mm(q[i]!), mm(q[i + 1]!), mm(q[i + 2]!)], nearest: best })
    }
    return rows.sort((a, b) => a.det - b.det).slice(0, 12)
  })()
  // 寰枕关节 / the atlanto-occipital joint
  const jointAfter = atlantoOccipitalJoint(afterByName('Occipital bone'), meshOf('Atlas'))
  const insideShare = (a: Mesh, b: Mesh) => {
    const t = new InsideTester(b, 96)
    const s = thinPoints(surfacePoints(a, 0.001), 0.001)
    let n = 0
    for (let i = 0; i < s.length; i += 3) if (t.contains(s[i]!, s[i + 1]!, s[i + 2]!)) n++
    return { samples: s.length / 3, inside: n }
  }
  const aoPen = { before: insideShare(meshOf('Occipital bone'), meshOf('Atlas')), after: insideShare(afterByName('Occipital bone'), meshOf('Atlas')), againstAxisAfter: insideShare(afterByName('Occipital bone'), meshOf('Axis')) }
  // 颞下颌关节：下颌骨顶部 14 mm 与颞骨的接触区 / the temporomandibular joints: contact zone of the top 14 mm of the mandible with the temporal bone
  const tmj = (get: (name: string) => Mesh, S: 'Left' | 'Right') => {
    const md = thinPoints(surfacePoints(get('Mandible'), 0.001), 0.0008)
    const sg = S === 'Left' ? 1 : -1
    let top = -Infinity
    for (let i = 0; i < md.length; i += 3) if (sg * md[i]! > 0.03 && md[i + 1]! > top) top = md[i + 1]!
    const c: number[] = []
    for (let i = 0; i < md.length; i += 3) if (sg * md[i]! > 0.03 && md[i + 1]! > top - 0.014) c.push(md[i]!, md[i + 1]!, md[i + 2]!)
    const z = contactZone(Float32Array.from(c), new PointIndex(thinPoints(surfacePoints(get(`${S} temporal bone`), 0.001), 0.0008), 0.004), 0.002, 0.02)
    const pen = insideShare({ positions: Float32Array.from(c), indices: new Uint32Array(0) }, get(`${S} temporal bone`))
    return { minGapMm: mm(z.min, 2), medianGapMm: mm(z.median, 2), zonePoints: z.points.length / 3, condyleSamplesInsideTemporalBone: pen.inside }
  }
  const tmjRows = { left: { before: tmj(meshOf, 'Left'), after: tmj(afterByName, 'Left') }, right: { before: tmj(meshOf, 'Right'), after: tmj(afterByName, 'Right') } }
  // 咬合：全部牙同一个刚体运动，上下牙之间的相对位置不变；牙槽骨（W）与牙（刚体）在牙表面处相差多少
  // occlusion: one rigid motion for every tooth, so upper and lower teeth keep their relative position; how far the alveolar bone (W) and the teeth (rigid) differ at the tooth surfaces
  const tW = W.apply(toothPts)
  const tR = applyRigid(toothRigid, toothPtsS)
  const socket: number[] = []
  for (let i = 0; i < tW.length; i += 3) socket.push(Math.hypot(tW[i]! - tR[i]!, tW[i + 1]! - tR[i + 1]!, tW[i + 2]! - tR[i + 2]!))
  // 眼眶：巩膜的采样点有没有落进头骨里，离骨最近多少 / the orbits: whether samples of the sclera fall inside a head bone, and their least distance to bone
  const orbit = (get: (p: HeadWarpPart) => Mesh, S: 'Left' | 'Right') => {
    const scl = thinPoints(surfacePoints(get(byName.get(`${S} sclera`)!), 0.001), 0.001)
    const near = headBones.filter((p) => /frontal|maxilla|zygomatic|sphenoid|ethmoid|lacrimal|palatine/i.test(p.name))
    const ix = new PointIndex(thinPoints(concat(near.map((p) => surfacePoints(get(p), 0.001))), 0.0008), 0.004)
    const testers = near.map((p) => new InsideTester(get(p), 64))
    let inside = 0
    let least = Infinity
    for (let i = 0; i < scl.length; i += 3) {
      if (testers.some((t) => t.contains(scl[i]!, scl[i + 1]!, scl[i + 2]!))) inside++
      least = Math.min(least, ix.distance(scl[i]!, scl[i + 1]!, scl[i + 2]!, 0.03))
    }
    return { scleraSamples: scl.length / 3, insideBone: inside, leastDistanceToBoneMm: mm(least, 2) }
  }
  const orbits = { left: { before: orbit((p) => p.mesh, 'Left'), after: orbit(after, 'Left') }, right: { before: orbit((p) => p.mesh, 'Right'), after: orbit(after, 'Right') } }
  // 眼睑会不会张着：角膜最前点在皮肤下多深（负 = 露在闭合的皮肤之外；皮肤的睑裂是用一条带封着的）
  // do the lids gape: how deep the most anterior point of the cornea lies under the skin (negative = outside the closed skin, whose palpebral fissure is sealed by a strip)
  const cornea = (S: 'Left' | 'Right') => {
    const c = after(byName.get(`${S} cornea`)!).positions
    let k = 0
    for (let i = 0; i < c.length; i += 3) if (c[i + 2]! > c[k + 2]!) k = i
    return mm(depthAt(c[k]!, c[k + 1]!, c[k + 2]!), 2)
  }
  // 标志点处的软组织厚度：形变后的骨上按同一规则重新找点，量到皮肤的距离 / soft-tissue depth at the landmarks: found anew on the warped bones by the same rules, distance to the skin
  const depthRows = DEPTHS.filter((d) => d.bone).map((d) => {
    const b = lmMapped[d.bone!]!
    const sk = skinLm(d.skin).position
    const paired = d.weight > 0
    const got = (paired ? dist(b, sk) : depthAt(b[0], b[1], b[2])) * 1000
    return { skinLandmark: d.skin, boneLandmark: d.bone!, tableMeanMm: d.meanMm, tableSdMm: d.sdMm, depthMm: r1(got), measuredAs: paired ? 'bone landmark to skin landmark' : 'bone landmark to the nearest skin', z: r1((got - d.meanMm) / d.sdMm, 2), withinOneSd: Math.abs(got - d.meanMm) <= d.sdMm, usedAsLandmarkConstraint: paired, source: d.source, ...(d.note ? { note: d.note } : {}) }
  })
  const lmResidual = lmRows.map((r) => {
    const q = W.apply(Float32Array.from(r.src))
    return { skin: r.skin, bone: r.bone, weight: r.weight, moveWantedMm: mm(dist(r.src, r.dst)), residualMm: mm(dist(q, r.dst)), residualMm_xyz: [mm(q[0]! - r.dst[0]), mm(q[1]! - r.dst[1]), mm(q[2]! - r.dst[2])] }
  })
  // 头骨和牙在皮肤下的深度（全部顶点） / depth of head bones and teeth under the skin (every vertex)
  const under = (list: HeadWarpPart[]) => {
    const d: number[] = []
    const worst: { name: string; outsideMm: number }[] = []
    for (const p of list) {
      const v = after(p).positions
      let m = Infinity
      for (let i = 0; i < v.length; i += 3) {
        const dep = depthAt(v[i]!, v[i + 1]!, v[i + 2]!)
        d.push(dep)
        m = Math.min(m, dep)
      }
      if (m < 0) worst.push({ name: p.name, outsideMm: mm(-m) })
    }
    return { vertices: d.length, outsideTheSkin: d.filter((x) => x < 0).length, shallowerThan1p5mm: d.filter((x) => x < 0.0015).length, leastDepthMm: mm(Math.min(...d), 2), p05Mm: mm(quantile(d, 0.05)), medianMm: mm(quantile(d, 0.5)), partsOutside: worst.sort((a, b) => b.outsideMm - a.outsideMm) }
  }
  // 颈部：不动的结构和颈肌相对新皮肤 / the neck: what stays, and the neck muscles, against the new skin
  const NECK = /thyroid|hyoid|cricoid|sternocleidomastoid|trapezius|splenius|platysma|levator scapulae|semispinalis|scalenus|omohyoid|sternohyoid|sternothyroid|thyrohyoid|digastric|mylohyoid|stylohyoid|geniohyoid|cervical vertebra|^Atlas$|^Axis$|trachea|epiglottis/i
  const neckRows = parts.filter((p) => NECK.test(p.name) && inReach(p) && (p.tissue === 'muscle' || p.tissue === 'bone' || p.tissue === 'cartilage' || p.tissue === 'gland')).map((p) => {
    const rowOf = (m: Mesh) => {
      const v = thinPoints(concat([m.positions, surfacePoints(m, 0.003)]), 0.002)
      let out = 0
      let worst = Infinity
      let n = 0
      for (let i = 0; i < v.length; i += 3) {
        if (v[i + 1]! < yLow) continue
        n++
        const dep = depthAt(v[i]!, v[i + 1]!, v[i + 2]!)
        if (dep < 0) out++
        worst = Math.min(worst, dep)
      }
      return { share: n ? r1(out / n, 3) : 0, maxOutsideMm: n ? mm(-worst) : 0 }
    }
    const b = rowOf(p.mesh)
    const a = rowOf(after(p))
    return { id: p.id, name: p.name, tissue: p.tissue, moved: moved.has(p.id), outsideBefore: b, outsideAfter: a }
  }).filter((r) => r.outsideAfter.maxOutsideMm > 0 || r.outsideBefore.maxOutsideMm > 0).sort((x, y) => y.outsideAfter.maxOutsideMm - x.outsideAfter.maxOutsideMm)
  const tooFar = over(opts.maxDimensionChange * 100)
  const rep: Record<string, unknown> = {
    applied: true,
    version: HEAD_WARP_VERSION,
    outline: { dir: outline.dir, skin: 'skin-with-new-head.obj', skinSha1: outline.skinSha1, placement: outline.placement },
    rePose: {
      pinned: PINNED_HEAD_FLEXION,
      pinnedStature: PINNED_FEMALE_STATURE,
      angleDeg: opts.flexionDeg,
      atlantoOccipitalJoint: { leftCentreMm: joint.left.map((v) => mm(v)), rightCentreMm: joint.right.map((v) => mm(v)), axis: joint.axis.map((v) => r1(v, 4)), rule: 'contact zones of the occipital bone with the atlas (within the least gap + 2 mm), one on each side; the axis runs through both centres' },
      frankfurt: { rule: 'porion = upper rim of the pit of the bony external acoustic meatus on a lateral depth map of the temporal bone; orbitale = lowest point of the crest of the infraorbital margin under the globe', before: { riseDeg: fhBefore.riseDeg, meatusPitDepthMm: fhBefore.meatusPitDepthMm }, after: { riseDeg: fhAfter.riseDeg }, note: 'supporting evidence only: the temporal bones are coarse and porion is uncertain by a few millimetres' },
      globeCentresAfterMm: { L: globeF.L.map((v) => mm(v)), R: globeF.R.map((v) => mm(v)) },
    },
    options: opts,
    constraints: { landmarks: lmRows.length, jointPoints: jointN, globePoints: 2 * SHELL.length, toothPoints: toothPts.length / 3, skinSamples: skinSamples.length, denseInTheLastPass: denseCount },
    passes: passRows,
    landmarkResiduals: lmResidual,
    parts: { moved: moved.size, ...kinds, stay: stayParts.map((p) => p.name).sort() },
    bones: boneRows,
    cranialDimensions: { rule: 'distances between landmarks: the points found on the re-posed bones, and the same material points carried through the warp; breadths and the extreme points (cranial, bizygomatic and bicondylar breadth, vertex, opisthocranion) are found anew on the warped bones by the same rule', rows: dims, over5Percent: over(5), over10Percent: over(10), over15Percent: tooFar },
    jacobian: { ofTheWarpNearTheHeadBones: { ...jacW, localScale: { min: r1(Math.cbrt(Math.max(0, jacW.min)), 3), max: r1(Math.cbrt(jacW.max), 3) } }, ofTheComposedMapNearMovedSoftParts: { ...jacAll, localScale: { min: r1(Math.cbrt(Math.max(0, jacAll.min)), 3), max: r1(Math.cbrt(jacAll.max), 3) } }, smallestOfTheWarp: worstJacobian },
    atlantoOccipital: { gapMm: { before: joint.gapMm, after: jointAfter.gapMm }, occipitalSamplesInsideTheAtlas: aoPen },
    temporomandibular: tmjRows,
    occlusion: { rule: `the crowns of every tooth of both arches (${TOOTH_CROWN * 100} % of each tooth's length from its incisal edge or occlusal surface) take one rigid motion, after a uniform scale about the centre of the dentition; its rotation is that of the best rigid approximation of the warp over the tooth surfaces, its translation puts the upper incisal edge under the oral fissure; the roots pass to the warp of the alveolar bone over the next ${TOOTH_BLEND * 100} % of the length`, relativeChangeBetweenUpperAndLowerTeethMm: 0, relativeChangeIs: 'between the crowns, after the uniform scale: every distance between crowns is multiplied by scale and nothing else changes', scale: toothScale, pinnedToothScale: PINNED_TOOTH_SCALE, placedByTheFissure: !!(opts.placeTeeth && outline.stomion && labialRow), residualOfThePlacementMm: toothWanted(toothRigid).map((v) => mm(v, 2)), rootsDepartFromTheRigidMotionByUpToMm: mm(rootMove, 2), rigidRotationDeg: r1((rotationAngle(toothRigid) * 180) / Math.PI, 2), teeth: teeth.length, alveolarBoneAgainstTheTeethMm: { median: mm(quantile(socket, 0.5), 2), p95: mm(quantile(socket, 0.95), 2), max: mm(Math.max(...socket), 2), what: 'distance between where the warp carries the bone at a tooth surface and where the rigid motion puts the tooth' } },
    incisors: (() => {
      const e = lmSrc.upperIncisalEdge!
      const q = applyRigid(toothRigid, scaled(e))
      return outline.stomion
        ? { rule: 'upper incisal edge (lowest point of the upper central incisors, carried by the rigid motion of the teeth) against stomion, the middle of the oral fissure of the new skin; head_outline.py assumes the edge 2 mm below stomion at rest', edgeBelowStomionMm: mm(outline.stomion[1] - q[1]!), edgeBehindStomionMm: mm(outline.stomion[2] - q[2]!) }
        : null
    })(),
    nasalCartilages: { coverWantedMm: NASAL_COVER * 1000, coverIs: 'an assumption', rows: nasalRows },
    globes: { radiusKeptMm: outline.globes.radiusMm, rule: outline.globes.rule, placedBy: 'corneal apex: each eyeball is translated so that its corneal apex (most anterior point after the re-pose) lands on the centre target plus the mirrored mean of both sides\' apex − centre; the warp of the bones uses the centre targets', apexMinusCentreMm: { L: offL.map((v) => mm(v, 2)), R: offR.map((v) => mm(v, 2)), mirroredMean: offMean.map((v) => mm(v, 2)) }, apexTargetMm: { L: apexTarget.L.map((v) => mm(v, 2)), R: apexTarget.R.map((v) => mm(v, 2)) }, centreAfterMm: { L: [0, 1, 2].map((k) => mm(globeF.L[k]! + globeShift.L[k]!, 2)), R: [0, 1, 2].map((k) => mm(globeF.R[k]! + globeShift.R[k]!, 2)) }, centreTargetMm: { L: globeTarget.L.map((v) => mm(v, 2)), R: globeTarget.R.map((v) => mm(v, 2)) }, moveMm: { L: globeShift.L.map((v) => mm(v)), R: globeShift.R.map((v) => mm(v)) }, moveIs: 'after the re-pose; a translation of every part of the eyeball, no scale', orbits, corneaApexUnderTheClosedSkinMm: { left: cornea('Left'), right: cornea('Right') } },
    softTissueDepthAtLandmarks: { rule: 'the bony landmark found on the re-posed bone, carried through the warp; where landmark pairs are constraints the depth is the distance to the skin landmark, at the loosely paired points it is the distance to the nearest skin', rows: depthRows, outsideOneSd: depthRows.filter((r) => !r.withinOneSd).map((r) => `${r.boneLandmark} ${r.depthMm} mm (table ${r.tableMeanMm} ± ${r.tableSdMm})`) },
    boneUnderSkin: { headBones: under(headBones), teeth: under(teeth) },
    neckAgainstTheNewSkin: neckRows,
  }
  // 径线变化超过上限时由调用者决定（female.ts 报错停下，除非明确要求照做） / what to do beyond the limit is the caller's decision (female.ts fails unless told to go on)
  return { moved, report: rep }
}
