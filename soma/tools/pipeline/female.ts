// 女性身体：把男性模型配准到真实的女性锚点上。
//   bun tools/pipeline/female.ts [--out <dir>]
// 读取已构建的男性身体（public/anatomy/male —— 先运行男性管线）和女性锚点包
// （data/raw/female/out/anchors），写出 public/anatomy/female。
//
// 哪些是真实的、哪些不是（同时写入 pipeline-report.json 的 `notes`）：
//   scanned  她自己的骨（Visible Human Female CT），逐块骨做刚性移动，从仰卧扫描姿势变到
//            男性的站立姿势；以及来自同一 CT 的少数质量好的器官和躯干肌
//   curated  盆底、括约肌、会阴、尿道、阴道、肛门直肠、子宫和附件（Wu 等 2015，另一位女性）；
//            子宫血管、卵巢悬韧带、乳房（HRA）
//   warped   其余一切：男性几何经过一个把男性骨骼映射到她的骨骼上的平滑形变场带过来
//
// 步骤
//   1. pose      每块骨的刚性变换：扫描 → 站立（上肢：取自锚点包；下肢和足：每块骨绕其近端
//                关节中心转到男性对应骨的朝向；右前臂和右手：用左侧镜像，因为右侧被 CT 视野
//                截断）
//   2. field P   把同样的运动表示为平滑场，用于她跨关节的软组织
//   3. field D   男性 → 女性，来自每块男性骨到她摆好姿势的骨的相似变换拟合
//   4. parts     有一一对应且质量好的真实部件时用她的真实部件，否则用形变后的男性部件；
//                去掉男性特有的部件，加入 HRA 女性器官
//   5. clean-up  处理与她的骨的碰撞，由形变后的中心线重建神经管
//   6. 检查、邻接、树、输出
//
// Female body: the male model registered onto real female anchors.
//   bun tools/pipeline/female.ts [--out <dir>]
// Reads the built male body (public/anatomy/male — run the male pipeline first) and the female
// anchor package (data/raw/female/out/anchors), writes public/anatomy/female.
//
// What is real and what is not (also written to pipeline-report.json `notes`):
//   scanned  her own bones (Visible Human Female CT), moved rigidly, bone by bone, from the
//            supine scan pose into the male's standing pose; a few good-quality organs and trunk
//            muscles from the same CT
//   curated  pelvic floor, sphincters, perineum, urethra, vagina, anorectum, uterus and adnexa (Wu et al.
//            2015, another woman); uterine vessels, suspensory ligaments of ovary, breasts (HRA)
//   warped   everything else: male geometry carried through a smooth deformation that maps the
//            male skeleton onto hers
//
// Steps
//   1. pose      per-bone rigid transforms scan → standing (arms: from the anchor package; legs
//                and feet: each bone turned about its proximal joint centre to the male bone's
//                orientation; right forearm and hand: mirrored left ones, the right ones are
//                clipped by the CT field of view)
//   2. field P   the same motion as a smooth field, for her soft tissue that spans joints
//   3. field D   male → female, from similarity fits of every male bone onto her posed bone
//   4. parts     her real parts where one exists one-to-one in good quality, warped male parts
//                otherwise, male-only parts dropped, HRA female organs added
//   5. clean-up  collisions with her bones, nerve tubes rebuilt from warped centrelines
//   6. checks, adjacency, trees, output

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, Concept, NervePath, Part, Provenance, SourceInfo, SystemDef, SystemId, TissueId } from '../../src/anatomy/types.ts'
import { computeAdjacency } from './adjacency.ts'
import { loadBuiltBody } from './body.ts'
import { hasFemaleAnchors, loadFemaleAnchors, type FemaleItem } from './femaleAnchors.ts'
import { computeNormals, measure, simplifyMesh, weld, type Mesh, type MeshStats } from './geometry.ts'
import { writeSystemGlb, type GlbPart } from './glb.ts'
import { HARD_TISSUES, overlapWith, pushOutOfSolids, SOLID_TISSUES, SurfaceField, type ExistingPart } from './import3.ts'
import { canalFor, isaPathFromFma, NERVE_BUILD_DEFAULTS, warpNerveLines } from './importZa.ts'
import { deriveFat, FAT_DEEP_TISSUES, FAT_OPTIONS, FAT_REGIONS, fatRegionOfBone, isFatPart } from './fat.ts'
import { jointLocalWarp, type JointBone } from './jointFit.ts'
import { runLandmarkChecks, slabCentroid } from './landmarks.ts'
import { buildWuParts, HRA_REPLACED_BY_WU, pelvisChecks, perineumAgainstSkin, reconcilePelvis, SOURCE_WU, WU_NOT_SHIPPED, WU_SPECS, type WuBuildRow, type WuSpec } from './pelvis.ts'
import { spliceTendons } from './splice.ts'
import { depthOf, LAYERS } from './layers.ts'
import { signedVolume } from './meshRepair.ts'
import { applyRigid, buildDeformation, buildTwoLevelDeformation, fitRigid, fitSimilarity, icp, InsideTester, PointIndex, surfaceDistance, surfacePoints, thinPoints, type Deformation, type Rigid } from './register.ts'
import { checkSkinFit, edgeTopology, faceAgainstSkin, FACE_MUSCLE_NAME, FACE_REGION_RADIUS, faceRegionOfSkin, internalsKey, loadSkinPackage, notFittedAgainstSkin, signedDistanceToSkin, simplifySkinKeepingFace, skinResolution, SurfaceDistance, usedVertices, type SkinPackage } from './skinPackage.ts'
import { loadShapeTarget, medianDistanceToBone, reshapeIntoEnvelope, type ShapeRole } from './shape.ts'
import { buildSlimmer, sectionGirth, type SlimSegment } from './slim.ts'
import { anthro, anthroNhanes, anthroSd, boneLandmarks, mapPoints, planStandard, skeletalMeasures, type AnthroModel, type PointMap, type StandardPlan, type StandardTargets, type Vec3 } from './standard.ts'
import type { Polyline } from './tube.ts'
import { loadFmaNames } from './zanatomy.ts'

const ROOT = join(import.meta.dirname, '../..')
const MALE_DIR = join(ROOT, 'public/anatomy/male')

// ── 参数 / Parameters ────────────────────────────────────────────────────────────────────────────────
const FIELD = { minSigma: Number(process.env.SOMA_SIGMA ?? 0.012), k: Number(process.env.SOMA_K ?? 32) }
const TWO_LEVEL = { coarseSpacing: 0.025, coarseSigma: Number(process.env.SOMA_CS ?? 0.04), coarseK: 64, fineSigma: 0.012, fineK: 32, fadeDistance: Number(process.env.SOMA_FADE ?? 0.03) }
const ANCHOR_SPACING = 0.006
/**
 * 骨锚点：相似变换拟合之后，距她的骨表面在此距离以内的点被移到骨表面上
 * bone anchors: after the similarity fit, points are moved onto her bone surface within this distance
 */
const SNAP_DISTANCE = 0.012
/**
 * 男性骨到她的骨的相似变换拟合若差于此值（对称 p95），则不用作锚点
 * a male bone whose similarity fit onto her bone is worse than this (symmetric p95) is not used as an anchor
 */
const MAX_FIT_P95 = 0.012
/**
 * 软组织锚点（仅质心 + 尺度）相对于完美骨拟合的置信度
 * soft-tissue anchors (centroid + scale only) get this confidence relative to a perfect bone fit
 */
const SOFT_ANCHOR_CONFIDENCE = 0.2
/**
 * 摆姿势场对她的真实软组织部件的弯曲小于此值时，视为刚性移动（保持 "scanned"）
 * her real soft parts count as rigidly moved (stay "scanned") when the posing field bends them less than this
 */
const RIGID_TOLERANCE = 0.002
/**
 * 只有当两者质心相差在此值以内时，她的真实软组织部件才替换形变后的男性部件
 * her real soft part replaces the warped male one only when their centroids agree within this
 */
const REAL_SOFT_MAX_OFFSET = 0.03
const ADJACENCY = { threshold: 0.002, spacing: 0.002, maxDegree: 250 }
const SIMPLIFY = { perThickness: 0.08, min: 0.08e-3, max: 0.8e-3, minTriangles: 400, maxEdge: 0.012 }

/**
 * 女性身体中不应存在的男性部件：先按系统，再按名称。
 * Male parts that have no place in a female body: by system, then by name.
 */
const MALE_ONLY_NAME = /\bpenis\b|\btest(is|es|icular)\b|prostat|seminal|deferent|epididym|scrot|spermat|cremaster|^urethra$/i
const isMaleOnly = (p: Part) => p.system === 'reproductive' || MALE_ONLY_NAME.test(p.name)

/**
 * 她多出的那块腰椎没有自己的 FMA 类：在 "lumbar vertebra" 之下用一个合成概念。
 * Her extra lumbar vertebra has no FMA class of its own: a synthetic concept under "lumbar vertebra".
 */
const SUPERNUMERARY_CONCEPT = 'VFC_supernumerary_lumbar_vertebra'

const SOURCE_VHF: SourceInfo = {
  name: 'Visible Human Female CT',
  url: 'https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCT/',
  license: 'NLM Terms and Conditions (attribution required)',
  attribution: 'Courtesy of the U.S. National Library of Medicine. Segmented with TotalSegmentator 2.18.0 and MOOSE 3.2.2; bones moved rigidly from the supine scan pose to a standing pose by this project.',
}
/** 关节局部配准结果在骨内的表面比例上限 / cap on the share of surface in bone for a joint-local result */
const JOINT_MAX_IN_BONE = 0.25
/** 神经、血管被推出她真实肌腹的最大距离（米） / how far a nerve or a vessel may be pushed out of her real muscle bellies (m) */
const NERVE_MUSCLE_PUSH = 0.04
const VESSEL_MUSCLE_PUSH = 0.03
/** 形变后的软组织部件在她真实骨内的表面比例超过此值即不输出 / a warped soft part with more of its surface than this inside her real bones is not shipped */
const MISPLACED_IN_BONE = 0.5

const ANTHRO_MODEL = join(ROOT, 'data/curated/bodyshape/anthro-model.json')
const SHAPE_MODEL = join(ROOT, 'data/curated/bodyshape/shape-model.json')
const RIG_SHAPE = join(ROOT, 'data/curated/bodyshape/rig-shape.json')
/** 瘦身系数 λ 的下限：软组织到骨的深度最多减到原来的这个比例 / floor of the slimming factor λ: the depth of soft tissue over bone is cut to no less than this share */
const SLIM_MIN_LAMBDA = 0.6
/**
 * 项目默认的女性体型：中国 20–24 岁女性均值（2020 年国民体质监测公报）。
 * The project's default female build: mean of Chinese women aged 20–24 (2020 national fitness surveillance bulletin).
 */
const STANDARD = { statureMm: 1606, bmi: 21.6, boneBmi: 22, population: 'China 20-24 (2020 means)' }

/** 足底软组织厚度（最低的足骨到地面）和头皮厚度：定义骨架的“地面”和“头顶” / sole pad (lowest foot bone to the floor) and scalp: they define the skeleton's floor and vertex */
const SOLE_PAD = 0.008
/** 外部皮肤包的位置（相对项目根）和装入后皮肤部件的 id / where the external skin package lives (relative to the project root) and the skin part's id once installed */
const SKIN_PACKAGE_DIR = 'data/raw/bodyshape/out/female-skin'
const EXTERNAL_SKIN_ID = 'SOMA_skin'
/**
 * 皮肤作者报告、而管线自己量不出来的缺陷，按皮肤包所拟合的内部结构指纹登记（换了一版内部结构就不再引用）。
 * 出处：皮肤包里的 enclosure.txt “arm skin against the trunk skin facing it” 一节，右侧肱骨 0.25–0.40 段 insideCm2 = 33.3。
 * Defects reported by the skin's author that the pipeline cannot measure itself, filed under the
 * fingerprint of the internals the package was fitted to (not quoted for any other version).
 * Source: the section "arm skin against the trunk skin facing it" of enclosure.txt in the skin
 * package, right side, 0.25–0.40 of the humerus, insideCm2 = 33.3.
 */
const SKIN_AUTHOR_NOTES: Record<string, { zh: string; en: string }> = {
  d8e55b8725377511: {
    en: ' Under the right arm the skin of the axilla runs into the skin of the trunk (about 33 cm² between 25 % and 40 % of the length of the humerus).',
    zh: '右腋窝处上臂内侧的皮肤穿入了躯干的皮肤（肱骨长度 25–40 % 处约 33 cm²）。',
  },
}
/**
 * 体形目标包的位置（相对项目根）：目标体表和深层包络，见 shape.ts。不存在时跳过体形重塑。
 * Where the body-shape target package lives (relative to the project root): target skin and deep envelope, see shape.ts. Without it the body-shape stage is skipped.
 */
const SHAPE_TARGET_DIR = 'data/raw/bodyshape/out/female-target'
/** 表面到骨的距离中位数超过它的韧带算“游离”的，随软组织移动 / a ligament whose surface lies further than this from bone (median) spans free and moves with the soft tissue */
const FREE_LIGAMENT = 0.008
/**
 * 女性与男性骨骼肌量之比，用作由男性形变而来的肌的体积下限（她自己的肌不受此限）。
 * 出处：Janssen I, Heymsfield SB, Wang ZM, Ross R. Skeletal muscle mass and distribution in 468 men and women aged 18–88 yr.
 * J Appl Physiol 2000;89(1):81–88, doi:10.1152/jappl.2000.89.1.81。摘要原文：全身 MRI，男性骨骼肌 33.0 kg、女性 21.0 kg；
 * “性别差异上半身（40 %）大于下半身（33 %）”。只核对了摘要；上、下半身的分界在正文里，没有核对，这里取髂嵴最高点。
 * Ratio of female to male skeletal muscle mass, used as the volume floor of muscles warped from the male (her own muscles are not bound by it).
 * Source: Janssen I, Heymsfield SB, Wang ZM, Ross R. Skeletal muscle mass and distribution in 468 men and women aged 18–88 yr.
 * J Appl Physiol 2000;89(1):81–88, doi:10.1152/jappl.2000.89.1.81. From the abstract: whole-body MRI, skeletal muscle 33.0 kg in men and
 * 21.0 kg in women; "the gender differences were greater in the upper (40%) than lower (33%) body". Only the abstract was checked; where
 * the paper divides upper from lower body is in its full text and was not checked, so the top of the iliac crest is used here.
 */
const MUSCLE_SEX_RATIO = { source: 'Janssen et al. 2000, J Appl Physiol 89(1):81-88, doi:10.1152/jappl.2000.89.1.81 (abstract)', upperBody: 0.6, lowerBody: 0.67, division: 'top of the iliac crest (assumed; not taken from the paper)' }
/** 体形重塑的版本号：算法或参数一改就加一，内部结构指纹随之改变 / version of the body-shape stage: raised whenever the algorithm or its parameters change, which changes the internals fingerprint */
const SHAPE_STAGE_VERSION = 2
const SCALP = 0.006
const FOOT_BONE = /calcane|talus|cuboid|cuneiform|navicular|metatarsal/i
const HAND_BONE = /scaphoid|lunate|triquetr|pisiform|trapezi|trapezoid|capitate|hamate|metacarpal|finger|thumb/i
interface Standardised {
  targets: StandardTargets
  rows: Record<string, { donor: number; target: number; mean: number; sd: number }>
  handSd: number
  scales: Record<string, number>
  plan: StandardPlan
  report: Record<string, unknown>
}

const SOURCE_DENVER: SourceInfo = {
  name: 'University of Denver Visible Human lower extremity',
  url: 'https://doi.org/10.1038/s41597-022-01905-2',
  license: 'CC BY 4.0',
  attribution: 'University of Denver Center for Orthopaedic Biomechanics, Visible Human lower-extremity geometry, CC BY 4.0: Andreassen T.E. et al., Sci Data 10, 34 (2023), doi:10.1038/s41597-022-01905-2; derived from the Visible Human Female, Courtesy of the U.S. National Library of Medicine. Re-posed with her leg bones and scaled to standard proportions by this project.',
}
/**
 * 没有一对一男性对应物的 Denver 条目所用的概念（FMA 5.1.0 的不分侧类；分侧 id 另行生成）。
 * Concepts for Denver items without a one-to-one male counterpart (unsided FMA 5.1.0 classes; sided ids are minted).
 */
const DENVER_CONCEPTS: [RegExp, string][] = [
  [/^VD_mcl_/, 'FMA44600'],
  [/^VD_cartilage_femur_distal_/, 'FMA33188'],
  [/^VD_cartilage_femur_head_/, 'FMA51604'],
  [/^VD_cartilage_patella_/, 'FMA43640'],
  [/^VD_cartilage_talus_/, 'FMA44122'],
  [/^VD_cartilage_tibia_distal_/, 'FMA33931'],
  [/^VD_cartilage_tibia_lateral_/, 'FMA311399'],
  [/^VD_cartilage_tibia_medial_/, 'FMA311392'],
]
const SOURCE_HRA: SourceInfo = {
  name: 'Human Reference Atlas',
  url: 'https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/latest/assets/3d-vh-f-united.glb',
  license: 'CC BY 4.0',
  attribution: 'Human Reference Atlas 3D Reference Object Library (HuBMAP / HRA), CC BY 4.0; modelled from the Visible Human Female, Courtesy of the U.S. National Library of Medicine. Placed in the CT frame by a bone-driven field.',
}

interface FPart {
  id: string
  fma: string
  name: string
  system: SystemId
  tissue: TissueId
  depth: number
  side: 'L' | 'R' | 'M'
  provenance: Provenance
  source: string
  mesh: Mesh
  volume?: number
  /**
   * 该部件所对应的男性部件的 id（替换它，或由它形变而来）
   * id of the male part this one corresponds to (replaces or is warped from)
   */
  male?: string
  centrelines?: Polyline[]
  /** Wu 盆底结构的目录项（概念的父类、part-of 分组） / catalogue entry of a Wu pelvic-floor structure (concept parent, part-of group) */
  wu?: WuSpec
  /**
   * 几何已是最终形态（已简化的男性网格、重建的神经管）
   * geometry is final (already simplified male mesh, rebuilt nerve tube)
   */
  keepGeometry?: boolean
  /**
   * 简化时必须原样保留的顶点（1 = 保留）；用于装入的皮肤的面部区域，见 skinPackage.ts
   * vertices the simplifier must leave as they are (1 = keep): the face region of an installed skin, see skinPackage.ts
   */
  lockVertices?: Uint8Array
  note?: string
}

const round = (v: number, digits = 5) => Number(v.toFixed(digits))
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const mm = (v: number) => (v * 1000).toFixed(1)
const quantile = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
}
const concat = (arrays: Float32Array[]): Float32Array => {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const fromMatrix = (m: number[]): Rigid => ({ r: [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!], t: [m[3]!, m[7]!, m[11]!] })
const IDENT: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }
const apply3 = (m: Rigid, p: readonly number[]): [number, number, number] => [
  m.r[0]! * p[0]! + m.r[1]! * p[1]! + m.r[2]! * p[2]! + m.t[0],
  m.r[3]! * p[0]! + m.r[4]! * p[1]! + m.r[5]! * p[2]! + m.t[1],
  m.r[6]! * p[0]! + m.r[7]! * p[1]! + m.r[8]! * p[2]! + m.t[2],
]
/** 刚性变换 / x ↦ R(x − pivot) + target */
const about = (r: number[], pivot: readonly number[], target: readonly number[]): Rigid => ({
  r,
  t: [
    target[0]! - (r[0]! * pivot[0]! + r[1]! * pivot[1]! + r[2]! * pivot[2]!),
    target[1]! - (r[3]! * pivot[0]! + r[4]! * pivot[1]! + r[5]! * pivot[2]!),
    target[2]! - (r[6]! * pivot[0]! + r[7]! * pivot[1]! + r[8]! * pivot[2]!),
  ],
})
const compose = (a: Rigid, b: Rigid): Rigid => {
  // 复合 / a ∘ b
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = a.r[3 * i]! * b.r[j]! + a.r[3 * i + 1]! * b.r[3 + j]! + a.r[3 * i + 2]! * b.r[6 + j]!
  return { r, t: apply3(a, b.t) }
}
const transformMesh = (m: Mesh, t: Rigid): Mesh => ({ positions: applyRigid(t, m.positions), indices: m.indices })
const mirrorX = (m: Mesh): Mesh => {
  const positions = Float32Array.from(m.positions, (v, i) => (i % 3 === 0 ? -v : v))
  const indices = Uint32Array.from(m.indices)
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!]
  return { positions, indices }
}
const angleDeg = (r: number[]) => (Math.acos(Math.max(-1, Math.min(1, (r[0]! + r[4]! + r[8]! - 1) / 2))) * 180) / Math.PI

/**
 * 把 `source`（女性骨）转到 `target`（男性骨）朝向的旋转，不考虑大小。
 * Rotation that turns `source` (female bone) to the orientation of `target` (male bone), sizes aside.
 */
function orientationTo(source: Mesh, target: Mesh): { r: number[]; rms: number } {
  const tgt = thinPoints(surfacePoints(target, 0.003), 0.003)
  const src = thinPoints(surfacePoints(source, 0.004), 0.006)
  const res = icp(src, new PointIndex(tgt, 0.008), { maxIterations: 60, scale: true })
  const s = Math.cbrt(Math.abs(res.transform.r[0]! * (res.transform.r[4]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[7]!) - res.transform.r[1]! * (res.transform.r[3]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[6]!) + res.transform.r[2]! * (res.transform.r[3]! * res.transform.r[7]! - res.transform.r[4]! * res.transform.r[6]!)))
  return { r: res.transform.r.map((v) => v / s), rms: res.rms }
}

/**
 * 肋骨的中心线，表示为从椎骨端到前端的折线：表面点按其绕一条竖直轴的角度分箱
 * （该轴穿过胸廓中部；肋骨从后方绕过侧面到前方是单调扫过的），每个箱取一个质心。
 * 返回中心线上的点及其归一化弧长。
 *
 * Centreline of a rib as a polyline from its vertebral end to its anterior end: surface points
 * are binned by their angle round a vertical axis through the middle of the rib cage (a rib
 * sweeps monotonically from the back round the side to the front), one centroid per bin.
 * Returns the centreline points and their normalised arc length.
 */
function ribCentreline(points: Float32Array, axisZ: number): { c: number[][]; s: number[]; angleOf: (x: number, z: number) => number; a0: number; a1: number } {
  const angleOf = (x: number, z: number) => Math.atan2(Math.abs(x), -(z - axisZ))
  const BINS = 24
  let a0 = Infinity
  let a1 = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const a = angleOf(points[i]!, points[i + 2]!)
    if (a < a0) a0 = a
    if (a > a1) a1 = a
  }
  const sum = Array.from({ length: BINS }, () => [0, 0, 0, 0])
  for (let i = 0; i < points.length; i += 3) {
    const b = Math.min(BINS - 1, Math.floor(((angleOf(points[i]!, points[i + 2]!) - a0) / Math.max(1e-9, a1 - a0)) * BINS))
    const acc = sum[b]!
    acc[0] = acc[0]! + points[i]!
    acc[1] = acc[1]! + points[i + 1]!
    acc[2] = acc[2]! + points[i + 2]!
    acc[3] = acc[3]! + 1
  }
  const c = sum.filter((x) => x[3]! > 0).map((x) => [x[0]! / x[3]!, x[1]! / x[3]!, x[2]! / x[3]!])
  const s = [0]
  for (let i = 1; i < c.length; i++) s.push(s[i - 1]! + Math.hypot(c[i]![0]! - c[i - 1]![0]!, c[i]![1]! - c[i - 1]![1]!, c[i]![2]! - c[i - 1]![2]!))
  const total = s[s.length - 1]! || 1
  return { c, s: s.map((v) => v / total), angleOf, a0, a1 }
}

/** 中心线上归一化弧长为 t 处的点。 / Point of a centreline at normalised arc length t. */
function alongLine(line: { c: number[][]; s: number[] }, t: number): number[] {
  const { c, s } = line
  if (t <= 0) return c[0]!
  if (t >= 1) return c[c.length - 1]!
  let i = 1
  while (i < s.length - 1 && s[i]! < t) i++
  const u = (t - s[i - 1]!) / Math.max(1e-9, s[i]! - s[i - 1]!)
  return [0, 1, 2].map((k) => c[i - 1]![k]! + (c[i]![k]! - c[i - 1]![k]!) * u)
}

/** 一个点在中心线上的最近位置（归一化弧长）。 / Nearest centreline position (normalised arc length) of a point. */
function paramOf(line: { c: number[][]; s: number[] }, p: readonly number[]): number {
  let best = 0
  let bd = Infinity
  for (let i = 1; i < line.c.length; i++) {
    const a = line.c[i - 1]!
    const b = line.c[i]!
    const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const l2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]! || 1e-12
    let u = ((p[0]! - a[0]!) * d[0]! + (p[1]! - a[1]!) * d[1]! + (p[2]! - a[2]!) * d[2]!) / l2
    u = u < 0 ? 0 : u > 1 ? 1 : u
    const dist = Math.hypot(p[0]! - a[0]! - u * d[0]!, p[1]! - a[1]! - u * d[1]!, p[2]! - a[2]! - u * d[2]!)
    if (dist < bd) {
      bd = dist
      best = line.s[i - 1]! + u * (line.s[i]! - line.s[i - 1]!)
    }
  }
  return best
}

const unionMesh = (meshes: Mesh[]): Mesh => {
  const positions = concat(meshes.map((m) => m.positions))
  const indices = new Uint32Array(meshes.reduce((s, m) => s + m.indices.length, 0))
  let vo = 0
  let io = 0
  for (const m of meshes) {
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo
    vo += m.positions.length / 3
    io += m.indices.length
  }
  return { positions, indices }
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : join(ROOT, 'public/anatomy/female')
  const t0 = performance.now()
  const report: Record<string, unknown> = {}
  // 各阶段完成的次序写入报告（不含耗时，以保证输出逐字节可复现）；耗时只打印到日志。
  // 配合 SOMA_TRACE=1（逐部件打印）可以定位卡住的阶段和部件。
  // The order in which stages complete goes into the report (without times, so that the output stays
  // byte-identical); times are printed to the log only. With SOMA_TRACE=1 (one line per part) a
  // stalled stage and part can be located.
  const stages: string[] = []
  report.stages = stages
  const lap = (label: string) => {
    stages.push(label.replace(/[\d.]+ → [\d.]+ triangles/, 'triangles'))
    console.log(`  [${((performance.now() - t0) / 1000).toFixed(1)}s] ${label}`)
  }
  const notes: string[] = []
  if (!existsSync(join(MALE_DIR, 'anatomy.json'))) throw new Error('public/anatomy/male is missing: run `bun run pipeline` first')
  if (!hasFemaleAnchors()) throw new Error('data/raw/female/out/anchors is missing: run tools/register/run_anchors.sh first')

  const male = await loadBuiltBody(MALE_DIR)
  const fa = loadFemaleAnchors()
  // 条目的用途：CT 分割（VF_*）和 HRA 女性器官走原有流程；Denver（VD_*）的首选条目是要输出的
  // 真实部件，随其 `follows` 所列的骨摆姿势，不作为刚性锚点；HRA 皮肤不用（同一位肥胖供体，
  // 将由参数化的标准皮肤代替）。
  // What each item is for: CT segmentations (VF_*) and the HRA female organs go through the
  // original flow; the preferred Denver items (VD_*) are real parts to ship, posed with the bones
  // in their `follows`, never rigid anchors; the HRA skin is not used (same obese donor; a
  // parametric standard skin replaces it).
  const denver = fa.items.filter((i) => i.source === 'denver' && i.preferred !== false)
  // Wu 等（2015）的女性盆底：另一个体，已配准到供体骨盆上；按 pelvis.ts 的目录输出，其余条目不用
  // the female pelvic floor of Wu et al. 2015: another individual, registered to the donor's pelvis; shipped per the catalogue in pelvis.ts, the other items are not used
  const wuItems = fa.items.filter((i) => i.source === 'wu2015')
  if (!wuItems.length) throw new Error('the anchor package has no WU_* items (Wu et al. 2015 pelvic floor): rerun tools/register/run_anchors.sh')
  const wuShipped = new Set(WU_SPECS.map((sp) => `WU_${sp.item}`))
  {
    const usable = (i: FemaleItem) => i.id.startsWith('VF_') || (i.id.startsWith('HRA_') && !/skin/i.test(i.name) && i.kind !== 'surface')
    const unused = fa.items.filter((i) => !usable(i) && !denver.includes(i) && !(wuItems.includes(i) && wuShipped.has(i.id)))
    console.log(`  anchor package: ${denver.length} Denver items used as parts; ${unused.length} items not used (${unused.filter((i) => i.source === 'denver').length} Denver bones that duplicate CT bones, ${unused.filter((i) => i.source !== 'denver').map((i) => i.id).join(', ')})`)
    report.anchorItems = { denverUsed: denver.length, wuUsed: wuItems.filter((i) => wuShipped.has(i.id)).length, unused: unused.map((i) => i.id), wuNotShipped: Object.fromEntries(wuItems.filter((i) => !wuShipped.has(i.id)).map((i) => [i.id, WU_NOT_SHIPPED[i.id.slice(3)] ?? 'not in the catalogue'])) }
    fa.items = fa.items.filter(usable)
  }
  // 标准五腰椎：她多出的那块腰椎（六块中的第一块）不输出，其上方的全部结构下移一个椎节，
  // 使 T12 落在她的第二腰椎（即标准的 L1）之上。位移取自 L1、L2 质心之差。
  // A standard five-lumbar spine: her supernumerary lumbar vertebra (the first of six) is not
  // shipped, and everything above it moves down by one motion segment so that T12 sits on her
  // second lumbar vertebra (the standard L1). The shift is the difference of the L1 and L2 centroids.
  let RESTACK: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }
  {
    const l1 = fa.byId.get('VF_vertebrae_L1')
    const l2 = fa.byId.get('VF_vertebrae_L2')
    if (l1 && l2 && !process.env.SOMA_SIX_LUMBAR) {
      const c1 = measure(fa.scanned(l1)).centroid
      const c2 = measure(fa.scanned(l2)).centroid
      RESTACK = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]] }
      fa.items = fa.items.filter((i) => i !== l1)
      report.lumbar = { decision: 'five', removed: l1.id, removedVolumeMl: l1.volume_ml, upperBodyShiftMm: RESTACK.t.map((v) => round(v * 1000, 1)) }
      console.log(`  five-lumbar spine: ${l1.id} not shipped; everything above it shifted by (${RESTACK.t.map((v) => mm(v)).join(', ')}) mm`)
    }
  }
  /** 位于被去掉的腰椎之上、随上半身下移的 CT 条目 / CT items above the removed vertebra, which move down with the upper body */
  const LOWER_BLOCK = /^VF_(sacrum|hip_|vertebrae_L|femur|patella|tibia|fibula|tarsal|metatarsal|toes)/
  const isUpper = (i: FemaleItem) => i.source === 'vhf-ct' && !LOWER_BLOCK.test(i.id)
  const fmaNames = loadFmaNames()
  const maleByName = new Map<string, Part>()
  for (const p of male.data.parts) if (!maleByName.has(p.name)) maleByName.set(p.name, p)
  const maleMesh = (id: string) => male.meshes.get(id)!
  lap(`male body: ${male.data.parts.length} parts; female anchors: ${fa.items.length} items`)
  // 锚点包是对照较早的一次男性构建来解析 `male_parts` 的：此后已被替换的 id
  // 从对应关系中去掉（会写入报告），不算致命错误
  // the anchor package resolved `male_parts` against an earlier male build: ids that have since
  // been replaced are dropped from the correspondence (reported), not fatal
  const unknown = [...new Set(fa.items.flatMap((i) => i.male_parts.filter((id) => !male.parts.has(id))))]
  if (unknown.length) {
    console.log(`  WARNING the anchor package names ${unknown.length} male parts that no longer exist (${unknown.join(', ')}); ignored — rerun tools/register/run_anchors.sh to refresh`)
    for (const i of fa.items) i.male_parts = i.male_parts.filter((id) => male.parts.has(id))
  }
  report.staleMaleIds = unknown

  // ── 1. 姿势 / 1. Pose ─────────────────────────────────────────────────────────────────────────────────
  const item = (id: string): FemaleItem => {
    const it = fa.byId.get(id)
    if (!it) throw new Error(`anchor item ${id} missing`)
    return it
  }
  const scanned = (id: string) => fa.scanned(item(id))
  const maleUnion = (it: FemaleItem) => unionMesh(it.male_parts.map(maleMesh))
  /** 扫描 → 站立，尚未做最后的竖直平移 / scan → standing, before the final vertical shift */
  const pose = new Map<string, Rigid>()
  const poseNotes: Record<string, unknown> = {}
  for (const it of fa.items) if (it.repose) pose.set(it.id, fromMatrix(it.repose))
  for (const it of fa.items) if (isUpper(it) && (it.kind === 'bone' || it.kind === 'bone-group' || it.kind === 'cartilage' || it.kind === 'tooth')) pose.set(it.id, compose(RESTACK, pose.get(it.id) ?? IDENT))
  for (const side of ['left', 'right'] as const) {
    const jc = (n: string) => fa.jointCentres[`${n}_${side}`]!.scanned
    const femur = orientationTo(scanned(`VF_femur_${side}`), maleUnion(item(`VF_femur_${side}`)))
    const tFemur = about(femur.r, jc('hip'), jc('hip'))
    const tibia = orientationTo(scanned(`VF_tibia_${side}`), maleUnion(item(`VF_tibia_${side}`)))
    const tTibia = about(tibia.r, jc('knee'), apply3(tFemur, jc('knee')))
    const footF = unionMesh([scanned(`VF_tarsal_${side}`), scanned(`VF_metatarsal_${side}`)])
    const footM = unionMesh([maleUnion(item(`VF_tarsal_${side}`)), maleUnion(item(`VF_metatarsal_${side}`))])
    const foot = orientationTo(footF, footM)
    let tFoot = about(foot.r, jc('ankle'), apply3(tTibia, jc('ankle')))
    // 足放平：与男性足的朝向对齐之后，她的前足仍比足跟低（扫描时足是跖屈的）；绕过踝中心的
    // 左右轴再转一个小角度，使跟骨底与跖骨头等高。
    // Foot levelled: after matching the male foot's orientation her forefoot still sits lower than
    // her heel (the feet are plantar-flexed in the scan); a further small turn about the left-right
    // axis through the ankle centre brings the underside of the calcaneus and the metatarsal heads to one height.
    let levelDeg = 0
    {
      const tar = applyRigid(tFoot, scanned(`VF_tarsal_${side}`).positions)
      const met = applyRigid(tFoot, scanned(`VF_metatarsal_${side}`).positions)
      let z0 = Infinity
      let z1 = -Infinity
      for (let i = 2; i < tar.length; i += 3) {
        z0 = Math.min(z0, tar[i]!)
        z1 = Math.max(z1, tar[i]!)
      }
      const c = apply3(tTibia, jc('ankle'))
      // 转过 θ 之后足跟（跗骨后三分之一）最低点与跖骨最低点的高度差
      // height difference between the lowest point of the heel (posterior third of the tarsals) and of the metatarsals after a turn by θ
      const diff = (th: number) => {
        const cs = Math.cos(th)
        const sn = Math.sin(th)
        let heel = Infinity
        let fore = Infinity
        for (let i = 0; i < tar.length; i += 3) if (tar[i + 2]! < z0 + (z1 - z0) / 3) heel = Math.min(heel, c[1] + (tar[i + 1]! - c[1]) * cs - (tar[i + 2]! - c[2]) * sn)
        for (let i = 0; i < met.length; i += 3) fore = Math.min(fore, c[1] + (met[i + 1]! - c[1]) * cs - (met[i + 2]! - c[2]) * sn)
        return heel - fore
      }
      let lo = -0.35
      let hi = 0.35
      if (diff(lo) * diff(hi) < 0) {
        for (let it = 0; it < 40; it++) {
          const mid = (lo + hi) / 2
          if (diff(lo) * diff(mid) <= 0) hi = mid
          else lo = mid
        }
        const th = (lo + hi) / 2
        levelDeg = (th * 180) / Math.PI
        tFoot = compose(about([1, 0, 0, 0, Math.cos(th), -Math.sin(th), 0, Math.sin(th), Math.cos(th)], c, c), tFoot)
      }
    }
    pose.set(`VF_femur_${side}`, tFemur)
    pose.set(`VF_patella_${side}`, tFemur)
    pose.set(`VF_tibia_${side}`, tTibia)
    pose.set(`VF_fibula_${side}`, tTibia)
    for (const g of ['tarsal', 'metatarsal', 'toes']) pose.set(`VF_${g}_${side}`, tFoot)
    poseNotes[side] = { femurDeg: round(angleDeg(femur.r), 1), tibiaDeg: round(angleDeg(tibia.r), 1), footDeg: round(angleDeg(foot.r), 1), footLevelDeg: round(levelDeg, 1), fitRmsMm: [femur.rms, tibia.rms, foot.rms].map((v) => round(v * 1000, 1)) }
  }
  // 每个条目的目标网格，处于站立姿势
  // target meshes of every item, in the standing pose
  const target = new Map<string, Mesh>()
  for (const it of fa.items) {
    if (it.pose === 'scanned-only') continue
    if (!(it.kind === 'bone' || it.kind === 'bone-group' || it.kind === 'cartilage' || it.kind === 'tooth')) continue
    target.set(it.id, transformMesh(fa.scanned(it), pose.get(it.id) ?? IDENT))
  }
  // 右前臂和右手：被 CT 视野截断 → 用左侧镜像，挂在右肱骨上
  // right forearm and hand: clipped by the CT field of view → mirrored left ones, hung on the right humerus
  const MIRRORED = ['radius', 'ulna', 'carpal', 'metacarpal', 'fingers']
  {
    const leftHumerus = mirrorX(target.get('VF_humerus_left')!)
    const src = thinPoints(surfacePoints(leftHumerus, 0.003), 0.005)
    const tgt = thinPoints(surfacePoints(target.get('VF_humerus_right')!, 0.002), 0.002)
    const fit = icp(src, new PointIndex(tgt, 0.006), { maxIterations: 60 })
    for (const b of MIRRORED) target.set(`VF_${b}_right`, transformMesh(mirrorX(target.get(`VF_${b}_left`)!), fit.transform))
    poseNotes.rightForearm = { method: 'left radius, ulna and hand mirrored and attached by fitting the mirrored left humerus to the right humerus', humerusFitRmsMm: round(fit.rms * 1000, 2), rotationDeg: round(angleDeg(fit.transform.r), 1) }
  }
  // 左侧第 5–9 肋：CT 自动分割把这几根肋的前段互相标错（左第 8 肋比右侧向下多出 47 mm，第 9 肋短一截），
  // 按错的标签既放不对肋骨，也放不对肋间神经。改用右侧第 5–9 肋的镜像：整组镜像后对左侧第 5–9 肋的
  // 并集做一次刚性配准（整组的形状唯一，不会滑到相邻的肋上），再逐根取用。
  // Left ribs 5–9: the automatic CT segmentation mislabels the anterior parts of these ribs among
  // each other (left rib 8 reaches 47 mm lower than the right one, rib 9 is cut short); wrong labels
  // place neither ribs nor intercostal nerves. They are replaced by mirrored right ribs 5–9: the group
  // is mirrored and fitted rigidly, as one block, to the union of the left ribs 5–9 (the block's shape
  // is unique, so it cannot slide onto a neighbouring rib), then taken rib by rib.
  const MIRRORED_RIBS = [5, 6, 7, 8, 9].filter((n) => target.has(`VF_rib_left_${n}`) && target.has(`VF_rib_right_${n}`))
  if (MIRRORED_RIBS.length) {
    const mirroredRight = MIRRORED_RIBS.map((n) => mirrorX(target.get(`VF_rib_right_${n}`)!))
    const src = thinPoints(concat(mirroredRight.map((m) => surfacePoints(m, 0.003))), 0.004)
    const tgt = thinPoints(concat(MIRRORED_RIBS.map((n) => surfacePoints(target.get(`VF_rib_left_${n}`)!, 0.002))), 0.002)
    const fit = icp(src, new PointIndex(tgt, 0.006), { maxIterations: 60, initial: IDENT })
    MIRRORED_RIBS.forEach((n, i) => target.set(`VF_rib_left_${n}`, transformMesh(mirroredRight[i]!, fit.transform)))
    poseNotes.leftRibs = { method: 'left ribs 5-9 replaced by the mirrored right ribs 5-9, fitted rigidly as one block to the union of the left ribs 5-9', ribs: MIRRORED_RIBS, fitRmsMm: round(fit.rms * 1000, 2), rotationDeg: round(angleDeg(fit.transform.r), 1), shiftMm: round(Math.hypot(...fit.transform.t) * 1000, 1) }
  }
  const isMirrored = (id: string) => MIRRORED.some((b) => id === `VF_${b}_right`) || MIRRORED_RIBS.some((n) => id === `VF_rib_left_${n}`)
  // 站在男性的地面上：她双足的最低点与他的等高
  // stand on the male's floor: lowest point of her feet at the height of his
  const floorOf = (meshes: Mesh[]) => Math.min(...meshes.map((m) => measure(m).bbox[1]))
  const maleFloor = floorOf(male.data.parts.filter((p) => p.tissue === 'bone' && /toe|metatarsal|calcane|talus|cuboid|cuneiform|navicular/i.test(p.name)).map((p) => maleMesh(p.id)))
  const herFloor = floorOf(['left', 'right'].flatMap((s) => ['tarsal', 'metatarsal', 'toes'].map((g) => target.get(`VF_${g}_${s}`)!)))
  const dy = maleFloor - herFloor
  const SHIFT: Rigid = { r: [...IDENT.r], t: [0, dy, 0] }
  for (const [id, m] of target) target.set(id, transformMesh(m, SHIFT))
  const finalPose = (id: string): Rigid => compose(SHIFT, pose.get(id) ?? IDENT)

  // ── 1b. 骨架标准化：按参考女性的比例逐肢段缩放 / skeleton standardisation: per-segment scaling to the reference female's proportions
  // 目标：项目默认体型（中国 20–24 岁女性均值：身高 160.6 cm；骨的尺寸按 BMI 22 取值，
  // 因为人体测量模型里的“骨宽”随 BMI 增大的部分是软组织）。在建立男性→女性形变场之前，
  // 先把她摆好姿势的骨（目标网格）按 standard.ts 的方案变换：这样男性软组织直接贴到标准化
  // 之后的骨架上，不必再经受一次大的二次形变（肩带下移约 6 cm 会把肩胛骨与肋骨之间的组织折叠）。
  // 她自己的软组织（CT 器官、Denver 肌、HRA 器官）经摆姿势场一并带过去。
  // Target: the project's default build (mean of Chinese women aged 20–24: stature 160.6 cm; bone
  // dimensions evaluated at BMI 22, because what grows with BMI in the anthropometric model's
  // "bone breadths" is soft tissue). Her posed bones (the target meshes) are transformed by the plan
  // in standard.ts BEFORE the male → female field is built: the male soft tissue then lands on the
  // standardised skeleton directly instead of going through a second large deformation (lowering
  // the shoulder girdle by about 6 cm would fold the tissue between scapula and ribs).
  // Her own soft tissue (CT organs, Denver muscles, HRA organs) is carried along by the posing field.
  let standard: Standardised | null = null
  let stdMap = (_id: string): PointMap => (p) => p
  if (existsSync(ANTHRO_MODEL) && !process.env.SOMA_DONOR_PROPORTIONS) {
    const model = JSON.parse(readFileSync(ANTHRO_MODEL, 'utf8')) as AnthroModel
    const VF_OF: [RegExp, (side: string, m: RegExpExecArray) => string][] = [
      [/^Seventh cervical vertebra$/, () => 'VF_vertebrae_C7'],
      [/^Atlas$/, () => 'VF_vertebrae_C1'],
      [/^(Left|Right) (scapula|humerus|radius|ulna|femur|tibia|fibula)$/, (sd, m) => `VF_${m[2]}_${sd}`],
      [/^(Left|Right) clavicle$/, (sd) => `VF_clavicula_${sd}`],
      [/^(Left|Right) hip bone$/, (sd) => `VF_hip_${sd}`],
    ]
    const boneVerts = (name: string) => {
      for (const [rx, id] of VF_OF) {
        const m = rx.exec(name)
        if (!m) continue
        const t = target.get(id((m[1] ?? '').toLowerCase(), m))
        if (t) return t.positions
      }
      throw new Error(`standardisation: no target bone for ${name}`)
    }
    // 她的骨就是她的骨：标准化之前只做过刚性移动
    // her bones are her bones: before the standardisation they were only moved rigidly
    {
      let worst = 0
      let count = 0
      for (const [id, m] of target) {
        const it = fa.byId.get(id)
        if (!it || it.kind !== 'bone' || isMirrored(id)) continue
        const src = fa.scanned(it).positions
        const back = applyRigid(fitRigid(src, m.positions), src)
        for (let i = 0; i < back.length; i += 3) worst = Math.max(worst, Math.hypot(back[i]! - m.positions[i]!, back[i + 1]! - m.positions[i + 1]!, back[i + 2]! - m.positions[i + 2]!))
        count++
      }
      console.log(`\nHer scanned bones before standardisation: ${count} parts, largest deviation from a rigid motion of the scan ${(worst * 1e6).toFixed(1)} µm`)
      report.scannedBones = { parts: count, maxNonRigidDeviationM: worst, note: 'before the standardisation' }
    }
    const yOf = (rx: RegExp, k: 1 | 4) => [...target].filter(([id]) => rx.test(id)).map(([, m]) => measure(m).bbox[k])
    // 地面由承重的足骨（跗骨、跖骨）定；她的趾骨在扫描中下垂，不算
    // the floor is set by the weight-bearing foot bones (tarsals, metatarsals); her toes hang down in the scan and do not count
    const floor = Math.min(...yOf(/^VF_(tarsal|metatarsal)_/, 1)) - SOLE_PAD
    const vertex = Math.max(...yOf(/^VF_cranium$/, 4)) + SCALP
    const L0 = boneLandmarks(boneVerts, floor, vertex)
    const m0 = skeletalMeasures(L0)
    const S = STANDARD.statureMm
    const B = STANDARD.boneBmi
    const pred = (id: string) => anthro(model, 'F', id, S, B)
    const sd = (id: string) => anthroSd(model, 'F', id, S, B)
    // 宽度（肩宽、骨盆宽）基本是个体特征（R² 约 0.4–0.5）：只拉到均值 ± 0.5 SD 以内，保留她偏向的一侧
    // breadths (shoulders, pelvis) are essentially individual (R² about 0.4–0.5): pulled only to within
    // ±0.5 SD of the mean, on the side she is on
    const within = (id: string, measured: number) => pred(id) + Math.max(-0.5, Math.min(0.5, (measured - pred(id)) / sd(id))) * sd(id)
    // 足长：跗骨后缘到趾骨前端，加约 15 mm 软组织 / foot length: back of the tarsals to the front of the toe bones, plus about 15 mm of soft tissue
    const footLen = ['left', 'right'].map((s2) => {
      const b = ['tarsal', 'metatarsal', 'toes'].map((g) => measure(target.get(`VF_${g}_${s2}`)!).bbox)
      return (Math.max(...b.map((x) => x[5])) - Math.min(...b.map((x) => x[2]))) * 1000 + 15
    })
    // 目标取体型模型的静止体（rig-shape.json 的 standardLengthMm：中国 20–24 岁均值，腿长因子 −1，前臂 ×0.93），
    // 使存盘的人体恰好就是运行时的“标准”预设。各肢段长度是 ANSUR 标志点之间的量：
    // 头颈 = 身高 − 颈椎点高，躯干 = 颈椎点高 − 大转子点高，大腿 = 大转子点高 − 股骨外上髁高，
    // 小腿 = 外上髁高 − 外踝高，足高 = 外踝高，上臂 = 肩峰—桡骨点，前臂 = 桡骨点—茎突点。
    // Targets are the rest body of the shape model (standardLengthMm in rig-shape.json: Chinese 20–24
    // means, leg-length factor −1, forearm ×0.93), so that the stored body IS the runtime's "standard"
    // preset. Segment lengths are differences of ANSUR landmarks: head and neck = stature − cervicale
    // height, trunk = cervicale − trochanterion height, thigh = trochanterion − lateral epicondyle
    // height, shank = epicondyle − lateral malleolus height, ankle height = malleolus height, upper
    // arm = acromion–radiale, forearm = radiale–stylion.
    const rig = existsSync(RIG_SHAPE) ? (JSON.parse(readFileSync(RIG_SHAPE, 'utf8')) as { sexes: Record<string, { controls: { id: string; rest: number }[]; segments: { id: string; standardLengthMm: number }[] }> }).sexes.F! : null
    const seg = (id: string, fallback: number) => rig?.segments.find((x) => x.id === id)?.standardLengthMm ?? fallback
    const legFactor = rig?.controls.find((c) => c.id === 'legLength')?.rest ?? 0
    const predF = (id: string) => anthro(model, 'F', id, S, B, [legFactor, 0])
    const ankleH = seg('ankleHeight', pred('lateralmalleolusheight'))
    const epicondyleH = ankleH + seg('shank', pred('lateralfemoralepicondyleheight') - pred('lateralmalleolusheight'))
    const trochanterH = epicondyleH + seg('thigh', pred('trochanterionheight') - pred('lateralfemoralepicondyleheight'))
    const cervicaleH = trochanterH + seg('trunk', pred('cervicaleheight') - pred('trochanterionheight'))
    void within
    const targets: StandardTargets = {
      stature: cervicaleH + seg('headNeck', S - pred('cervicaleheight')),
      cervicaleheight: cervicaleH,
      // 肩峰高不在肢段表里：取同一腿长因子下的回归值 / acromial height is not in the segment table: the regression at the same leg-length factor
      acromialheight: predF('acromialheight'),
      trochanterionheight: trochanterH,
      lateralfemoralepicondyleheight: epicondyleH,
      lateralmalleolusheight: ankleH,
      acromionradialelength: seg('upperArm', pred('acromionradialelength')),
      radialestylionlength: seg('forearm', pred('radialestylionlength')),
      biacromialbreadth: seg('shoulderWidth', pred('biacromialbreadth')),
      bicristalbreadth: seg('pelvisWidth', pred('bicristalbreadth')),
      // 骨性指尖到皮肤指尖约 4 mm；手在零件装配完之后再缩放（见 5d）
      // about 4 mm from the bony fingertip to the skin; the hands are scaled after the parts are assembled (see 5d)
      handlengthBone: seg('hand', pred('handlength')) - 4,
    }
    const plan = planStandard(L0, targets, { thoraxWidth: (S / m0.stature!) ** 0.65, footLength: seg('foot', pred('footlength')) / ((footLen[0]! + footLen[1]!) / 2) })
    // VF 条目 id → 点映射：把 id 里的 left/right 和骨名交给 plan.boneMap，其余走中轴映射
    // VF item id → point map: the id's left/right and bone name go to plan.boneMap, everything else takes the axial map
    stdMap = (id: string) => plan.boneMap(id.replace(/^V[FD]_/, '').replace(/_/g, ' ')) ?? plan.axial
    for (const [id, mesh] of target) target.set(id, { positions: mapPoints(stdMap(id), mesh.positions), indices: mesh.indices })
    const rows: Standardised['rows'] = {}
    for (const k of Object.keys(targets) as (keyof StandardTargets)[]) {
      if (k === 'handlengthBone') continue
      // z 值相对于目标（标准体）计，SD 取该项测量的人群残差 / z is against the target (the standard body), the SD is the population residual of the measure
      rows[k] = { donor: m0[k]!, target: targets[k]!, mean: targets[k]!, sd: k === 'stature' ? NaN : sd(k) }
    }
    standard = {
      targets, rows, handSd: sd('handlength'), scales: Object.fromEntries(Object.entries(plan.scales).map(([k, v]) => [k, round(v, 4)])), plan,
      report: { targetsFrom: rig ? 'data/curated/bodyshape/rig-shape.json (sexes.F.segments[].standardLengthMm)' : 'anthro-model.json regressions', legLengthFactor: legFactor, donorMm: Object.fromEntries(Object.entries(m0).map(([k, v]) => [k, round(v, 1)])), statureMm: S, boneBmi: B, bmi: STANDARD.bmi, population: STANDARD.population, clamped: plan.clamped, solePadMm: SOLE_PAD * 1000, scalpMm: SCALP * 1000, joints: Object.fromEntries(Object.entries(plan.joints).map(([k, v]) => [k, v.map((x) => round(x, 5))])) },
    }
    console.log(`\nSkeleton standardised to stature ${S} mm (bone dimensions at BMI ${B}); scale factors: ${Object.entries(plan.scales).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`)
    if (plan.clamped.length) console.log(`  limited: ${plan.clamped.join('; ')}`)
  }
  /** 扫描空间的点 → 站立、标准化之后 / a point of the scan → standing and standardised */
  const finalMap = (id: string): PointMap => {
    const t = finalPose(id)
    const s = stdMap(id)
    return (p) => s(apply3(t, p))
  }
  console.log(`\nPose: leg bones turned about their proximal joint to the male bone's orientation — ${JSON.stringify(poseNotes)}; whole body shifted ${mm(dy)} mm in Y to stand on the male's floor`)
  report.pose = { ...poseNotes, verticalShiftM: round(dy) }

  // 2. field P：把姿势表示为平滑场（用于她的软组织和 HRA 器官）
  // 2. field P: the pose as a smooth field (for her soft tissue and the HRA organs)
  let fieldP: Deformation
  {
    const from: Float32Array[] = []
    const to: Float32Array[] = []
    for (const it of fa.items) {
      if (!(it.kind === 'bone' || it.kind === 'bone-group') || it.quality === 'poor' || it.pose === 'scanned-only') continue
      if (isMirrored(it.id)) continue
      const a = thinPoints(surfacePoints(fa.scanned(it), ANCHOR_SPACING), ANCHOR_SPACING)
      from.push(a)
      to.push(mapPoints(finalMap(it.id), a))
    }
    fieldP = buildDeformation(concat(from), concat(to), FIELD)
  }
  // 她的真实器官整体刚性移动（取摆姿势场在该器官上的最佳刚性近似），不被场压扁或拉长；
  // 其余软组织（肌、HRA 器官）随场走。
  // （做了骨架标准化时允许均匀缩放。）
  // Her real organs move rigidly as a whole (the best rigid approximation of the posing field over
  // the organ; with the skeleton standardised, a uniform scale is allowed), never squeezed or stretched by it; other soft tissue (muscles, HRA organs) follows the field.
  const posed = (it: FemaleItem): Mesh => {
    const src = fa.scanned(it)
    const moved = fieldP.apply(src.positions)
    if (it.source === 'vhf-ct' && it.kind === 'organ') return { positions: applyRigid(standard ? fitSimilarity(src.positions, moved) : fitRigid(src.positions, moved), src.positions), indices: src.indices }
    return { positions: moved, indices: src.indices }
  }
  lap('pose and posing field')

  // ── 3. Field D：男性 → 女性 / 3. Field D: male → female ───────────────────────────────────────────────────────────────
  interface Fit { id: string; kind: string; region: string; from: Float32Array; to: Float32Array; conf: number; p95: number; scale: number }
  const fits: Fit[] = []
  const regionOf = (it: FemaleItem): string => {
    const id = it.id
    if (/cranium|mandible|teeth/.test(id)) return 'head'
    if (/vertebrae_C|hyoid|thyroid|cricoid|scalene|sternocleido|levator/.test(id)) return 'neck'
    if (/vertebrae_T|rib_|sternum|clavicula|scapula|serratus/.test(id)) return 'thorax'
    if (/vertebrae_L|kidney|spleen|pancreas|gallbladder|adrenal|liver|rectus|oblique|quadratus|psoas/.test(id)) return 'abdomen'
    if (/sacrum|hip_|gluteus|iliacus|bladder/.test(id)) return 'pelvis'
    if (/humerus|radius|ulna/.test(id)) return 'arm'
    if (/carpal|fingers/.test(id)) return 'hand'
    if (/femur|patella|tibia|fibula/.test(id)) return 'leg'
    if (/tarsal|toes/.test(id)) return 'foot'
    return 'other'
  }
  // 肋骨绕之扫过的竖直轴，每个身体各一条：位于中线，在脊柱与胸骨的正中间
  // vertical axis the ribs sweep round, per body: midline, half-way between spine and sternum
  const midZ = (meshes: Mesh[]) => {
    const b = meshes.map((m) => measure(m).bbox)
    return (Math.min(...b.map((x) => x[2])) + Math.max(...b.map((x) => x[5]))) / 2
  }
  const ribItems = fa.items.filter((i) => /^VF_rib_/.test(i.id))
  const RIB_AXIS_Z_FEMALE = midZ(ribItems.map((i) => target.get(i.id)!))
  const RIB_AXIS_Z_MALE = midZ(ribItems.flatMap((i) => i.male_parts.map(maleMesh)))
  const softTargets = new Map<string, Mesh>()
  const fitOf = new Map<string, Rigid>()
  const rejected: { id: string; p95: number }[] = []
  // 先处理椎骨：每根肋骨的拟合以它所连椎骨的变换为初值
  // vertebrae first: each rib starts its fit from the transform of the vertebra it hangs on
  const ordered = [...fa.items].sort((a, b) => Number(/VF_rib_/.test(a.id)) - Number(/VF_rib_/.test(b.id)))
  for (const it of ordered) {
    if (!it.male_parts.length || it.pose === 'scanned-only') continue
    const hard = it.kind === 'bone' || it.kind === 'bone-group' || it.kind === 'cartilage'
    if (hard) {
      // 蜷曲的手指以及那个零碎的单一肋软骨标签与男性的形状不对应
      // curled fingers and the single fragmented costal-cartilage label do not correspond to the male shapes
      if (/fingers|costal_cartilages/.test(it.id)) continue
      const tm = target.get(it.id)!
      const m = maleUnion(it)
      const areaF = measure(tm).area
      const sp = Math.max(0.0015, Math.sqrt(areaF / 8000))
      const tgt = thinPoints(surfacePoints(tm, sp), sp * 0.8)
      const index = new PointIndex(tgt, sp * 1.5)
      const raw = surfacePoints(m, sp)
      const rib = /^VF_rib_(?:left|right)_(\d+)$/.exec(it.id)
      const initial = undefined
      const res = icp(thinPoints(raw, Math.max(0.002, Math.sqrt(measure(m).area / 600))), index, { maxIterations: 40, scale: true, initial })
      fitOf.set(it.id, res.transform)
      const dense = applyRigid(res.transform, thinPoints(raw, sp * 0.8))
      const p95 = Math.max(surfaceDistance(dense, index).p95, surfaceDistance(tgt, new PointIndex(dense, sp * 1.5)).p95)
      if (p95 > MAX_FIT_P95 && !rib) {
        rejected.push({ id: it.id, p95 })
        continue
      }
      const from = thinPoints(surfacePoints(m, ANCHOR_SPACING), ANCHOR_SPACING)
      const to = applyRigid(res.transform, from)
      if (rib) {
        // 肋骨：按沿肋骨的位置建立对应（见 ribCentreline），并沿用男性横截面上的偏移
        // ribs: correspondence by position along the rib (see ribCentreline), the male
        // cross-section offset carried over
        const lm = ribCentreline(raw, RIB_AXIS_Z_MALE)
        const lf = ribCentreline(tgt, RIB_AXIS_Z_FEMALE)
        for (let i = 0; i < from.length; i += 3) {
          const p = [from[i]!, from[i + 1]!, from[i + 2]!]
          const t = paramOf(lm, p)
          const cm = alongLine(lm, t)
          const cf = alongLine(lf, t)
          for (let k = 0; k < 3; k++) to[i + k] = cf[k]! + (p[k]! - cm[k]!)
        }
      }
      const fine = new PointIndex(thinPoints(surfacePoints(tm, 0.001), 0.0008), 0.003)
      const I = new Int32Array(1)
      const D2 = new Float64Array(1)
      for (let i = 0; i < to.length; i += 3) {
        if (!fine.nearest(to[i]!, to[i + 1]!, to[i + 2]!, 1, I, D2, SNAP_DISTANCE)) continue
        to[i] = fine.points[3 * I[0]!]!
        to[i + 1] = fine.points[3 * I[0]! + 1]!
        to[i + 2] = fine.points[3 * I[0]! + 2]!
      }
      const scale = Math.cbrt(Math.abs(res.transform.r[0]! * (res.transform.r[4]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[7]!) - res.transform.r[1]! * (res.transform.r[3]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[6]!) + res.transform.r[2]! * (res.transform.r[3]! * res.transform.r[7]! - res.transform.r[4]! * res.transform.r[6]!)))
      // 组标签（手、足、颅骨）作为目标比单块骨更粗
      // a group label (hand, foot, skull) is a coarser target than a single bone
      const conf = rib ? 0.6 : (it.correspondence === 'group' ? 0.6 : 1) / (1 + (p95 / 0.008) ** 2)
      fits.push({ id: it.id, kind: it.kind, region: regionOf(it), from, to, conf, p95, scale })
    } else if (!process.env.SOMA_NOSOFT && it.quality === 'good' && it.kind === (process.env.SOMA_SOFTALL ? it.kind : 'organ') && (it.kind === 'organ' || it.kind === 'muscle') && it.id !== 'VF_brain') {
      // 软组织：个体形状差异太大，无法建立表面对应；只沿用“这个器官在这里、有这么大”
      //  （质心和体积）
      // soft tissue: individual shapes differ too much for surface correspondences; only "this
      // organ sits here and is this big" is carried over (centroid and volume)
      const tm = posed(it)
      softTargets.set(it.id, tm)
      const m = maleUnion(it)
      const sM = measure(m)
      const sF = measure(tm)
      const volM = it.male_parts.reduce((s, id) => s + Math.abs(measure(maleMesh(id)).signedVolume), 0)
      const scale = Math.min(1.4, Math.max(0.7, Math.cbrt(Math.abs(sF.signedVolume) / Math.max(1e-9, volM))))
      const from = thinPoints(surfacePoints(m, 0.01), 0.01)
      const to = new Float32Array(from.length)
      for (let i = 0; i < from.length; i += 3) for (let k = 0; k < 3; k++) to[i + k] = sF.centroid[k]! + scale * (from[i + k]! - sM.centroid[k]!)
      fits.push({ id: it.id, kind: it.kind, region: regionOf(it), from, to, conf: SOFT_ANCHOR_CONFIDENCE, p95: NaN, scale })
    }
  }
  // CT 分割的肋骨标签并非都可靠（左侧第 5–9 肋与右侧的长度相差可达 17 %）：
  // 若一根肋骨的平均位移与其邻居（上下相邻的肋骨、对侧的同序肋骨、它的椎骨）不一致，
  // 就把它当作标错处理。
  // Rib labels of the CT segmentation are not all trustworthy (left ribs 5–9 differ from the right
  // ones by up to 17 % in length): a rib whose mean displacement disagrees with its neighbours
  // (the ribs above and below, its opposite number, its vertebra) is treated as mislabelled.
  const suspectRibs: { id: string; offMm: number }[] = []
  {
    const meanDisp = (f: Fit) => {
      const d = [0, 0, 0]
      for (let i = 0; i < f.from.length; i++) d[i % 3] = d[i % 3]! + (f.to[i]! - f.from[i]!) / (f.from.length / 3)
      return d
    }
    const disp = new Map(fits.map((f) => [f.id, meanDisp(f)]))
    for (const f of [...fits]) {
      const m = /^VF_rib_(left|right)_(\d+)$/.exec(f.id)
      if (!m) continue
      const n = Number(m[2])
      const other = m[1] === 'left' ? 'right' : 'left'
      const refs = [`VF_rib_${m[1]}_${n - 1}`, `VF_rib_${m[1]}_${n + 1}`, `VF_rib_${other}_${n}`, `VF_vertebrae_T${n}`].map((id) => disp.get(id)).filter((d): d is number[] => !!d)
      if (refs.length < 2) continue
      const med = [0, 1, 2].map((k) => quantile(refs.map((d) => d[k]!), 0.5))
      const own = disp.get(f.id)!
      // 对侧肋骨的 x 是镜像的，但这不影响 y 和 z 的中位数；比较这两个分量
      // mirrored x for the opposite rib does not matter for the median of y and z; compare those
      const off = Math.hypot(own[1]! - med[1]!, own[2]! - med[2]!)
      if (off > 0.02) suspectRibs.push({ id: f.id, offMm: round(off * 1000, 1) })
    }
    for (const s of suspectRibs) fits.splice(fits.findIndex((f) => f.id === s.id), 1)
  }
  const buildD = (list: Fit[]): Deformation => {
    const w: number[] = []
    for (const f of list) for (let i = 0; i < f.from.length / 3; i++) w.push(f.conf)
    return buildTwoLevelDeformation(concat(list.map((f) => f.from)), concat(list.map((f) => f.to)), { ...TWO_LEVEL, weights: Float32Array.from(w) })
  }
  const fieldD = buildD(fits)
  const errOf = (def: Deformation, f: Fit) => {
    const out = def.apply(f.from)
    let s = 0
    for (let i = 0; i < out.length; i += 3) s += Math.hypot(out[i]! - f.to[i]!, out[i + 1]! - f.to[i + 1]!, out[i + 2]! - f.to[i + 2]!)
    return s / (out.length / 3)
  }
  const hardFits = fits.filter((f) => f.kind !== 'organ' && f.kind !== 'muscle')
  const residual = new Map(hardFits.map((f) => [f.id, errOf(fieldD, f)]))
  const leaveOut = new Map<string, number>()
  for (let fold = 0; fold < 8; fold++) {
    const def = buildD(fits.filter((_, i) => i % 8 !== fold))
    fits.forEach((f, i) => {
      if (i % 8 === fold && f.kind !== 'organ' && f.kind !== 'muscle') leaveOut.set(f.id, errOf(def, f))
    })
  }
  lap(`male → female field: ${fits.length} anchor structures (${hardFits.length} bone/cartilage, ${fits.length - hardFits.length} soft), ${fits.reduce((s, f) => s + f.from.length / 3, 0)} points`)
  {
    console.log('\nMale → female registration (bone and cartilage anchors; mm, median / p90 / max)')
    console.log(`  ${pad('region', 10)}${pad('n', 5)}${pad('similarity fit p95', 24)}${pad('scale', 20)}${pad('field residual', 22)}leave-out error`)
    const rows: Record<string, unknown>[] = []
    for (const r of ['head', 'neck', 'thorax', 'abdomen', 'pelvis', 'arm', 'hand', 'leg', 'foot', 'all']) {
      const f = hardFits.filter((x) => r === 'all' || x.region === r)
      if (!f.length) continue
      const q3 = (v: number[], scale = 1000, d = 1) => `${(quantile(v, 0.5) * scale).toFixed(d)} / ${(quantile(v, 0.9) * scale).toFixed(d)} / ${(Math.max(...v) * scale).toFixed(d)}`
      const row = { region: r, n: f.length, fitP95: q3(f.map((x) => x.p95)), scale: q3(f.map((x) => x.scale), 1, 2), residual: q3(f.map((x) => residual.get(x.id)!)), leaveOut: q3(f.map((x) => leaveOut.get(x.id)!)) }
      console.log(`  ${pad(r, 10)}${pad(row.n, 5)}${pad(row.fitP95, 24)}${pad(row.scale, 20)}${pad(row.residual, 22)}${row.leaveOut}`)
      rows.push(row)
    }
    if (process.env.SOMA_DEBUG) for (const f of hardFits) console.log(`    ${pad(f.id, 30)}scale ${f.scale.toFixed(2)} fit p95 ${mm(f.p95)} conf ${f.conf.toFixed(2)} residual ${mm(residual.get(f.id)!)} leave-out ${mm(leaveOut.get(f.id)!)}`)
    const worst = [...leaveOut].sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`  worst leave-out: ${worst.map(([id, e]) => `${id} ${mm(e)}`).join(', ')}`)
    if (rejected.length) console.log(`  not used (similarity fit p95 > ${MAX_FIT_P95 * 1000} mm): ${rejected.map((r) => `${r.id} ${mm(r.p95)}`).join(', ')}`)
    if (suspectRibs.length) console.log(`  ribs not used as anchors (displacement disagrees with neighbours by > 20 mm: label suspect): ${suspectRibs.map((r) => `${r.id} ${r.offMm}`).join(', ')}`)
    const odd = hardFits.filter((f) => f.scale > 1.15 || f.scale < 0.85)
    console.log(`  size outliers among the anchors (similarity scale outside 0.85–1.15): ${odd.map((f) => `${f.id} ${f.scale.toFixed(2)}`).join(', ') || 'none'}`)
    report.registration = { anchors: fits.length, hard: hardFits.length, soft: fits.length - hardFits.length, byRegion: rows, suspectRibs, rejected: rejected.map((r) => ({ id: r.id, fitP95Mm: round(r.p95 * 1000, 1) })), perAnchor: hardFits.map((f) => ({ id: f.id, region: f.region, scale: round(f.scale, 3), fitP95Mm: round(f.p95 * 1000, 2), residualMm: round(residual.get(f.id)! * 1000, 2), leaveOutMm: round(leaveOut.get(f.id)! * 1000, 2) })), sizeOutliers: odd.map((f) => f.id) }
  }

  // 在覆盖男性身体的网格上计算该场的雅可比
  // Jacobian of the field on a grid over the male body
  {
    const all = concat(male.data.parts.filter((p) => p.tissue !== 'skin').map((p) => thinPoints(surfacePoints(maleMesh(p.id), 0.01), 0.01)))
    const near = new PointIndex(thinPoints(all, 0.01), 0.02)
    const boneNames = male.data.parts.filter((p) => p.tissue === 'bone')
    const bonePts = boneNames.map((p) => measure(maleMesh(p.id)).centroid)
    const h = 0.002
    const dets: number[] = []
    const bad: { det: number; at: number[] }[] = []
    const b = [-0.34, -0.08, -0.05, 0.34, 1.66, 0.25]
    const f = (x: number, y: number, z: number) => {
      const d = fieldD.displacementAt(x, y, z)
      return [x + d[0], y + d[1], z + d[2]]
    }
    for (let x = b[0]!; x <= b[3]!; x += 0.012) for (let y = b[1]!; y <= b[4]!; y += 0.012) for (let z = b[2]!; z <= b[5]!; z += 0.012) {
      if (near.distance(x, y, z, 0.012) > 0.012) continue
      const xp = f(x + h, y, z)
      const xm = f(x - h, y, z)
      const yp = f(x, y + h, z)
      const ym = f(x, y - h, z)
      const zp = f(x, y, z + h)
      const zm = f(x, y, z - h)
      const J = [0, 1, 2].map((i) => [(xp[i]! - xm[i]!) / (2 * h), (yp[i]! - ym[i]!) / (2 * h), (zp[i]! - zm[i]!) / (2 * h)])
      const det = J[0]![0]! * (J[1]![1]! * J[2]![2]! - J[1]![2]! * J[2]![1]!) - J[0]![1]! * (J[1]![0]! * J[2]![2]! - J[1]![2]! * J[2]![0]!) + J[0]![2]! * (J[1]![0]! * J[2]![1]! - J[1]![1]! * J[2]![0]!)
      dets.push(det)
      if (det <= 0.2 || det > 4) bad.push({ det, at: [x, y, z] })
    }
    const nearestBone = (p: number[]) => {
      let best = 0
      let bd = Infinity
      bonePts.forEach((c, i) => {
        const d = Math.hypot(c[0] - p[0]!, c[1] - p[1]!, c[2] - p[2]!)
        if (d < bd) {
          bd = d
          best = i
        }
      })
      return boneNames[best]!.name
    }
    const where = new Map<string, number>()
    for (const x of bad) where.set(nearestBone(x.at), (where.get(nearestBone(x.at)) ?? 0) + 1)
    if (process.env.SOMA_DEBUG) {
      const allFrom = concat(fits.map((f) => f.from))
      const owner: string[] = []
      const disp: number[][] = []
      for (const f of fits) for (let i = 0; i < f.from.length; i += 3) {
        owner.push(f.id)
        disp.push([f.to[i]! - f.from[i]!, f.to[i + 1]! - f.from[i + 1]!, f.to[i + 2]! - f.from[i + 2]!])
      }
      const ix = new PointIndex(allFrom, 0.02)
      const I = new Int32Array(12)
      const D = new Float64Array(12)
      for (const x of bad.filter((q) => q.det <= 0).sort((p, q) => p.det - q.det).filter((_, i) => i % 40 === 0).slice(0, 10)) {
        const n = ix.nearest(x.at[0]!, x.at[1]!, x.at[2]!, 12, I, D)
        const by = new Map<string, number[][]>()
        for (let k = 0; k < n; k++) by.set(owner[I[k]!]!, [...(by.get(owner[I[k]!]!) ?? []), [...disp[I[k]!]!, Math.sqrt(D[k]!)]])
        console.log(`  fold det ${x.det.toFixed(2)} at ${x.at.map((v) => (v * 1000).toFixed(0))} near ${nearestBone(x.at)}: ` + [...by].map(([id, v]) => `${id}×${v.length} d=(${[0, 1, 2].map((k) => ((v.reduce((s, q) => s + q[k]!, 0) / v.length) * 1000).toFixed(0)).join(',')}) @${(Math.min(...v.map((q) => q[3]!)) * 1000).toFixed(0)}mm`).join(' | '))
      }
    }
    const folded = dets.filter((d) => d <= 0).length
    const stats = { samples: dets.length, min: round(Math.min(...dets), 3), p01: round(quantile(dets, 0.01), 3), median: round(quantile(dets, 0.5), 3), p99: round(quantile(dets, 0.99), 3), max: round(Math.max(...dets), 3), folded, below02: dets.filter((d) => d <= 0.2).length, above4: dets.filter((d) => d > 4).length }
    const top = [...where].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(`\nJacobian determinant of the field (12 mm grid, ${stats.samples} samples within 12 mm of male tissue): min ${stats.min}, 1% ${stats.p01}, median ${stats.median}, 99% ${stats.p99}, max ${stats.max}; folded (≤ 0): ${folded}; ≤ 0.2: ${stats.below02}; > 4: ${stats.above4}`)
    console.log(`  extreme samples by nearest male bone: ${top.map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}`)
    report.jacobian = { ...stats, extremeByNearestBone: Object.fromEntries(top) }
  }
  lap('field checks')

  // ── 4. 部件 / 4. Parts ────────────────────────────────────────────────────────────────────────────────
  const parts: FPart[] = []
  const replaced = new Set<string>()
  const realNotes: Record<string, string> = {}
  const softOffsets: { id: string; name: string; offsetMm: number }[] = []
  const notUsed: { id: string; reason: string }[] = []
  const lumbarConcept = male.data.trees.isa.find((c) => c.name === 'lumbar vertebra')?.id ?? 'FMA9921'
  for (const it of fa.items) {
    if (it.source !== 'vhf-ct' || it.pose === 'scanned-only') continue
    const isBone = it.kind === 'bone' || it.kind === 'cartilage'
    const mirrored = isMirrored(it.id)
    if (it.id === 'VF_vertebrae_L1') {
      // 六块腰椎：她的第一块没有男性对应物
      // six lumbar vertebrae: her first one has no male counterpart
      parts.push({ id: it.id, fma: SUPERNUMERARY_CONCEPT, name: 'Supernumerary lumbar vertebra (first of six)', system: 'skeletal', tissue: 'bone', depth: depthOf('skeletal', 'bone'), side: 'M', provenance: 'scanned', source: SOURCE_VHF.name, mesh: target.get(it.id)!, volume: it.volume_ml })
      continue
    }
    if (it.correspondence !== 'one-to-one') continue
    // 同一结构另有 Denver 的冰冻切片模型且为首选：用 Denver 的
    // the same structure also exists as a preferred Denver cryosection model: that one is used
    if (it.preferred === false && it.alternatives?.some((a) => a.startsWith('VD_'))) {
      notUsed.push({ id: it.id, reason: `the Denver model of the same structure is used (${it.alternatives.join(', ')})` })
      continue
    }
    const m = male.parts.get(it.male_parts[0]!)!
    const base = { id: it.id, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, source: SOURCE_VHF.name, male: m.id, volume: it.volume_ml }
    if (isBone && (it.quality !== 'poor' || mirrored)) {
      if (mirrored) {
        const rib = /^VF_rib_left_/.test(it.id)
        parts.push({ ...base, provenance: 'warped', mesh: target.get(it.id)!, volume: undefined, note: rib ? 'mirrored right rib (the CT labels of left ribs 5-9 are mixed up)' : 'mirrored left bone (the right one is clipped by the CT field of view)' })
        realNotes[it.id] = rib ? 'mirrored right' : 'mirrored left'
      } else parts.push({ ...base, provenance: 'scanned', mesh: target.get(it.id)! })
      replaced.add(m.id)
    } else if (!isBone && it.quality === 'good' && (it.kind === 'organ' || it.kind === 'muscle')) {
      const mesh = softTargets.get(it.id) ?? posed(it)
      // 只有当她的真实部件与形变场给出的男性部件位置一致时才使用它；一块分割出来的肌
      // 若只是男性对应肌的一个碎片，或者离它很远，会破坏周围所有形变结构的连续性
      // her real part is used only where it agrees with where the field puts the male one;
      // a segmented muscle that is a fragment of, or far from, its male counterpart would break
      // the continuity of everything warped around it
      {
        const wm = { positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices }
        const ws = measure(wm)
        const rs = measure(mesh)
        const off = Math.hypot(ws.centroid[0] - rs.centroid[0], ws.centroid[1] - rs.centroid[1], ws.centroid[2] - rs.centroid[2])
        const vr = Math.abs(rs.signedVolume) / Math.max(1e-9, Math.abs(ws.signedVolume))
        if (off > REAL_SOFT_MAX_OFFSET || vr < 0.4 || vr > 2.5) {
          notUsed.push({ id: it.id, reason: `${mm(off)} mm from the warped male ${m.name.toLowerCase()}, volume ratio ${vr.toFixed(2)}` })
          continue
        }
      }
      // 摆姿势场对它的移动是刚性的吗？
      // did the posing field move it rigidly?
      const src = fa.scanned(it).positions
      const fit = fitRigid(src, mesh.positions)
      const back = applyRigid(fit, src)
      let bend = 0
      for (let i = 0; i < back.length; i += 3) bend = Math.max(bend, Math.hypot(back[i]! - mesh.positions[i]!, back[i + 1]! - mesh.positions[i + 1]!, back[i + 2]! - mesh.positions[i + 2]!))
      parts.push({ ...base, provenance: bend <= RIGID_TOLERANCE ? 'scanned' : 'warped', mesh, note: bend <= RIGID_TOLERANCE ? undefined : `re-posed non-rigidly with the bones it attaches to (bent by up to ${mm(bend)} mm)` })
      if (bend > RIGID_TOLERANCE) realNotes[it.id] = `bent ${mm(bend)} mm by re-posing`
      replaced.add(m.id)
      // 她的真实部件距形变场本会放置男性部件的位置有多远？
      // how far is her real part from where the field would have put the male one?
      const wc = measure({ positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices }).centroid
      const rc = measure(mesh).centroid
      softOffsets.push({ id: it.id, name: m.name, offsetMm: round(Math.hypot(wc[0] - rc[0], wc[1] - rc[1], wc[2] - rc[2]) * 1000, 1) })
    }
  }
  for (const it of fa.items) {
    if (it.source !== 'vhf-ct' || it.correspondence !== 'one-to-one' || parts.some((p) => p.id === it.id) || notUsed.some((n) => n.id === it.id)) continue
    notUsed.push({ id: it.id, reason: it.pose === 'scanned-only' ? 'supine body surface' : it.kind === 'vessel' ? 'vessel trunks are kept as one warped tree so that branches stay connected' : it.quality !== 'good' ? `quality ${it.quality}: ${it.quality_reasons[0] ?? ''}` : it.kind })
  }
  // ── Denver：同一供体下肢和骨盆的真实肌、单块跗骨、膝韧带、关节软骨 ─────────────────────────
  // ── Denver: the same donor's real leg and pelvis muscles, single tarsals, knee ligaments, articular cartilages
  // 每个条目随 `follows.bones` 所列的骨移动：每个顶点按到各骨（扫描姿势下）表面的距离
  // 以 1/d² 混合各骨的刚性变换，因此贴着某块骨的一端严格随该骨走，中间部分在两端之间过渡。
  // Each item moves with the bones in `follows.bones`: every vertex blends the bones' rigid
  // transforms by 1/d² of its distance to each bone's surface (in the scan pose), so an end lying
  // on a bone follows that bone exactly and the span in between passes from one end to the other.
  const denverRows: Record<string, unknown>[] = []
  let followBones!: (mesh: Mesh, boneIds: string[]) => Mesh
  {
    const boneIndex = new Map<string, PointIndex>()
    const indexOfBone = (id: string) => {
      let ix = boneIndex.get(id)
      if (!ix) boneIndex.set(id, (ix = new PointIndex(thinPoints(surfacePoints(fa.scanned(item(id)), 0.003), 0.002), 0.008)))
      return ix
    }
    const follow = (mesh: Mesh, boneIds: string[]): Mesh => {
      const ids = boneIds.filter((id) => fa.byId.has(id) && fa.items.includes(fa.byId.get(id)!))
      if (ids.length === 1) return { positions: mapPoints(finalMap(ids[0]!), mesh.positions), indices: mesh.indices }
      const out = new Float32Array(mesh.positions.length)
      const T = ids.map((id) => finalMap(id))
      const IX = ids.map(indexOfBone)
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const x = mesh.positions[i]!
        const y = mesh.positions[i + 1]!
        const z = mesh.positions[i + 2]!
        let ws = 0
        let ox = 0
        let oy = 0
        let oz = 0
        for (let b = 0; b < ids.length; b++) {
          const d = IX[b]!.distance(x, y, z, 0.25)
          const w = 1 / (Math.min(d, 0.25) + 0.001) ** 2
          const q = T[b]!([x, y, z])
          ws += w
          ox += w * q[0]
          oy += w * q[1]
          oz += w * q[2]
        }
        out[i] = ox / ws
        out[i + 1] = oy / ws
        out[i + 2] = oz / ws
      }
      return { positions: out, indices: mesh.indices }
    }
    followBones = follow
    const gapTo = (mesh: Mesh, bones: Mesh[]): number => {
      if (!bones.length) return NaN
      const ix = new PointIndex(concat(bones.map((b) => thinPoints(surfacePoints(b, 0.002), 0.0015))), 0.006)
      let d = Infinity
      for (let i = 0; i < mesh.positions.length; i += 3) d = Math.min(d, ix.distance(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!, d))
      return d
    }
    const titled = (it: FemaleItem) => {
      const n = it.name.replace(/\s+/g, ' ').replace(/ \((lateral|medial)\)/, '').trim()
      return n[0]!.toUpperCase() + n.slice(1)
    }
    // 先对所有肌试拼接：某一端需要接腱却接不干净的肌（左右任一侧），两侧都改用形变后的男性肌，
    // Denver 的肌腹不输出（只在报告里留下它的体积供对照）。
    // Splices are tried for every muscle first: a muscle with an end that needs a tendon but cannot be
    // spliced cleanly (on either side) falls back to the warped male muscle on both sides; its Denver
    // belly is not shipped (its volume stays in the report for comparison).
    const baseOf = (id: string) => id.replace(/_(left|right)$/, '')
    const noCleanSplice = new Set<string>()
    if (!process.env.SOMA_NO_SPLICE) {
      for (const it of denver) {
        if (it.kind !== 'muscle' || !it.follows?.bones.length) continue
        const males = it.male_parts.map((id) => male.parts.get(id)).filter((m): m is Part => !!m)
        if (!males.length) continue
        const wmale = unionMesh(males.map((m) => ({ positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices })))
        const sp = spliceTendons(follow(fa.scanned(it), it.follows.bones), wmale)
        if (sp.ends.some((e) => !e.attached && e.beyond >= 0.01)) noCleanSplice.add(baseOf(it.id))
      }
    }
    for (const it of denver) {
      const src = fa.scanned(it)
      const bones = it.follows?.bones ?? []
      if (!bones.length) continue
      if (noCleanSplice.has(baseOf(it.id))) {
        denverRows.push({ id: it.id, name: it.name, kind: it.kind, replaces: [], volumeMl: round(it.volume_ml, 1), kept: 'warped male muscle (no clean tendon splice)' })
        continue
      }
      let mesh = follow(src, bones)
      const males = it.male_parts.map((id) => male.parts.get(id)).filter((m): m is Part => !!m)
      // Denver 的肌只有肌腹：凡形变后的男性同名肌沿长轴超出肌腹 10 mm 以上的一端，接上男性肌的那一段（腱、腱膜）。
      // 切口处的横向错位超过 40 mm 的一端不接（拼接不干净），在报告中列出。
      // The Denver muscles are bellies only: at every end where the warped male muscle of the same name
      // extends more than 10 mm beyond the belly along the long axis, that stretch of the male muscle
      // (tendon, aponeurosis) is attached. An end whose cut would have to shift sideways by more than
      // 40 mm is left alone (no clean splice) and listed in the report.
      let splice: ReturnType<typeof spliceTendons> | null = null
      if (it.kind === 'muscle' && males.length && !process.env.SOMA_NO_SPLICE) {
        const wmale = unionMesh(males.map((m) => ({ positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices })))
        splice = spliceTendons(mesh, wmale)
        if (splice.ends.some((e) => e.attached)) mesh = splice.mesh
      }
      const cls: { system: SystemId; tissue: TissueId } = it.kind === 'muscle' ? { system: 'muscular', tissue: 'muscle' } : it.kind === 'ligament' ? { system: 'skeletal', tissue: 'ligament' } : it.kind === 'cartilage' ? { system: 'skeletal', tissue: 'cartilage' } : { system: 'skeletal', tissue: 'bone' }
      let part: FPart
      // 组对应中若有一个男性部件与本条目同名（大收肌 + 小收肌 → 大收肌），就沿用它的身份
      // in a group, a male part with this item's own name (adductor magnus + minimus → adductor magnus) gives its identity
      const primary = males.length === 1 && it.correspondence === 'one-to-one' ? males[0] : males.find((m) => m.name.toLowerCase() === titled(it).toLowerCase())
      if (primary) {
        const m = primary
        part = { id: it.id, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, provenance: 'scanned', source: SOURCE_DENVER.name, male: m.id, mesh, volume: it.volume_ml }
      } else {
        // 一个条目对应多个男性部件（如大收肌、胫侧副韧带），或没有男性对应物（关节软骨）
        // one item for several male parts (adductor magnus, tibial collateral ligament), or none (articular cartilages)
        const fma = it.fma ?? DENVER_CONCEPTS.find(([rx]) => rx.test(it.id))?.[1] ?? `VFC_${it.id.slice(3).replace(/_(left|right)$/, '')}`
        const sided = it.side === 'M' || /_(L|R)$/.test(fma) || (fmaNames?.label.get(fma) ?? '').toLowerCase().includes(it.side === 'L' ? 'left' : 'right') ? fma : `${fma}_${it.side}`
        part = { id: it.id, fma: sided, name: titled(it), system: cls.system, tissue: cls.tissue, depth: males[0]?.depth ?? depthOf(cls.system, cls.tissue), side: it.side, provenance: 'scanned', source: SOURCE_DENVER.name, mesh, volume: it.volume_ml }
      }
      parts.push(part)
      for (const m of males) replaced.add(m.id)
      // 与形变场本会放置的男性对应部件相比：质心距离和体积比
      // against the male counterpart where the field would have put it: centroid distance and volume ratio
      const row: Record<string, unknown> = { id: it.id, name: part.name, kind: it.kind, replaces: males.map((m) => m.id), volumeMl: round(it.volume_ml, 1) }
      if (splice) {
        row.tendons = splice.ends.map((e) => ({ end: e.end, maleBeyondBellyMm: round(e.beyond * 1000, 1), attached: e.attached, shiftAtCutMm: round(e.shift * 1000, 1), triangles: e.triangles }))
        if (splice.ends.some((e) => e.attached)) part.note = `belly from the Denver model; ${splice.ends.filter((e) => e.attached).length === 2 ? 'both tendons' : 'one tendon'} from the warped male muscle`
      }
      if (males.length) {
        const wm = unionMesh(males.map((m) => ({ positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices })))
        const ws = measure(wm)
        const rs = measure(mesh)
        const maleVol = males.reduce((a, m) => a + Math.abs(measure(maleMesh(m.id)).signedVolume), 0)
        Object.assign(row, { offsetFromWarpedMaleMm: round(Math.hypot(ws.centroid[0] - rs.centroid[0], ws.centroid[1] - rs.centroid[1], ws.centroid[2] - rs.centroid[2]) * 1000, 1), volumeVsMale: round(Math.abs(rs.signedVolume) / Math.max(1e-9, maleVol), 2) })
      }
      if (it.follows?.origin || it.follows?.insertion) {
        const ends: Record<string, unknown> = {}
        for (const end of ['origin', 'insertion'] as const) {
          const ids = (it.follows[end] ?? []).filter((id) => fa.byId.has(id) && fa.items.includes(fa.byId.get(id)!))
          if (!ids.length) continue
          ends[end] = { bones: ids, scannedGapMm: round(gapTo(src, ids.map((id) => fa.scanned(item(id)))) * 1000, 1), posedGapMm: round(gapTo(mesh, ids.map((id) => target.get(id)!)) * 1000, 1) }
        }
        row.ends = ends
      }
      denverRows.push(row)
    }
    const mus = denverRows.filter((r) => r.kind === 'muscle' && !r.kept)
    const keptMale = denverRows.filter((r) => r.kept).map((r) => r.name as string)
    const ratios = mus.map((r) => r.volumeVsMale as number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
    const endGaps = denverRows.flatMap((r) => Object.values((r.ends ?? {}) as Record<string, { posedGapMm: number; scannedGapMm: number }>))
    const worse = endGaps.filter((e) => e.posedGapMm > e.scannedGapMm + 1).length
    console.log(`\nDenver parts: ${denverRows.length} (${mus.length} muscles, ${denverRows.filter((r) => r.kind === 'ligament').length} ligaments, ${denverRows.filter((r) => r.kind === 'cartilage').length} cartilages, ${denverRows.filter((r) => r.kind === 'bone').length} tarsals) replacing ${denverRows.reduce((a, r) => a + (r.replaces as string[]).length, 0)} male parts; muscle volume vs the male muscle: median ${ratios[Math.floor(ratios.length / 2)]}, range ${ratios[0]}…${ratios[ratios.length - 1]}; ends: ${endGaps.length} checked, ${worse} more than 1 mm further from their bone after posing than in the scan (largest gap after posing ${Math.max(...endGaps.map((e) => e.posedGapMm))} mm)`)
    {
      type T = { end: string; maleBeyondBellyMm: number; attached: boolean; shiftAtCutMm: number }
      const withT = denverRows.filter((r) => r.tendons) as { name: string; tendons: T[] }[]
      const attached = withT.flatMap((r) => r.tendons.filter((t) => t.attached).map((t) => `${r.name} ${t.end} +${t.maleBeyondBellyMm} mm (shift ${t.shiftAtCutMm})`))
      const refused = withT.flatMap((r) => r.tendons.filter((t) => !t.attached && t.maleBeyondBellyMm >= 10).map((t) => `${r.name} ${t.end} +${t.maleBeyondBellyMm} mm (shift ${t.shiftAtCutMm})`))
      console.log(`  tendons from the warped male muscle: ${attached.length} ends attached on ${withT.filter((r) => r.tendons.some((t) => t.attached)).length} muscles; ${refused.length} ends not attached (no clean splice): ${refused.join(', ') || 'none'}`)
      console.log(`  Denver bellies not shipped, the warped male muscle kept instead (${keptMale.length}): ${keptMale.join(', ') || 'none'}`)
      report.denverTendons = { maleMuscleKept: keptMale, endsAttached: attached.length, muscles: withT.filter((r) => r.tendons.some((t) => t.attached)).length, attached, notAttached: refused }
    }
    report.denver = denverRows
  }
  // ── Wu 盆底：与 Denver 条目一样随 `follows.bones`（左右髋骨和骶骨）走，即同样的摆姿势和骨架标准化 ──
  // ── Wu pelvic floor: carried like the Denver items with the bones in `follows.bones` (both hip bones and the sacrum), i.e. through the same posing and skeleton standardisation
  const wuExtras = new Map<string, Mesh>()
  let wuRows: WuBuildRow[] = []
  const wuReplacedMale: { id: string; name: string; by: string }[] = []
  if (wuItems.length) {
    const carried = new Map<string, Mesh>()
    let dMean = 0
    let dMax = 0
    let dN = 0
    for (const it of wuItems) {
      const src = fa.scanned(it)
      const m = followBones(src, it.follows?.bones ?? ['VF_hip_left', 'VF_hip_right', 'VF_sacrum'])
      carried.set(it.id.slice(3), m)
      // 与摆姿势场（HRA 器官所用）给出的位置相比 / against where the posing field (used for the HRA organs) would put it
      if (!wuShipped.has(it.id)) continue
      const alt = fieldP.apply(src.positions)
      for (let i = 0; i < alt.length; i += 3) {
        const d = Math.hypot(alt[i]! - m.positions[i]!, alt[i + 1]! - m.positions[i + 1]!, alt[i + 2]! - m.positions[i + 2]!)
        dMean += d
        dMax = Math.max(dMax, d)
        dN++
      }
    }
    // 正中矢状面：中线结构（尿道、肛门内外括约肌、会阴体）质心 x 的中位数
    // midsagittal plane: median x of the centroids of midline structures (urethra, anal sphincters, perineal body)
    const mids = ['submucous_layer_of_urethra', 'internal_anal_sphincter', 'external_anal_sphincter', 'perineal_body', 'urethral_sphincter_proper'].map((k) => carried.get(k)).filter((m): m is Mesh => !!m).map((m) => measure(m).centroid[0])
    const xMid = quantile(mids, 0.5)
    const built = buildWuParts((k) => carried.get(k) ?? null, xMid)
    wuRows = built.rows
    for (const w of built.parts) {
      const m = w.male ? male.parts.get(w.male) : undefined
      const depth = m?.depth ?? depthOf(w.spec.system, w.spec.tissue)
      parts.push({ id: w.id, fma: m?.fma ?? w.concept, name: w.name, system: m?.system ?? w.spec.system, tissue: m?.tissue ?? w.spec.tissue, depth, side: w.side, provenance: 'curated', source: SOURCE_WU.name, mesh: w.mesh, male: m?.id, wu: w.spec, keepGeometry: true, note: w.spec.note })
      if (m) replaced.add(m.id)
    }
    for (const sp of WU_SPECS) for (const id of [...(sp.replaces ?? []), ...(sp.male ?? [])]) {
      const m = id ? male.parts.get(id) : undefined
      if (!m) continue
      replaced.add(m.id)
      wuReplacedMale.push({ id: m.id, name: m.name, by: `WU_${sp.item}` })
    }
    for (const [k, m] of carried) if (!wuShipped.has(`WU_${k}`)) wuExtras.set(k, m)
    // 被取代的男性直肠（经形变场）：只用来找乙状结肠的下端 / the replaced male rectum (through the field): only to locate the lower end of the sigmoid colon
    if (male.parts.has('FJ2571')) wuExtras.set('male_rectum', { positions: fieldD.apply(maleMesh('FJ2571').positions), indices: maleMesh('FJ2571').indices })
    const closed = built.parts.filter((w) => w.watertight).length
    console.log(`\nWu pelvic floor: ${built.parts.length} parts from ${built.rows.length} structures (${closed} closed manifolds); midsagittal plane at x = ${mm(xMid)} mm; carried with the pelvic bones — ${mm(dMean / dN)} mm mean, ${mm(dMax)} mm max from where the posing field would put them; male parts replaced: ${wuReplacedMale.map((r) => r.name).join(', ')}`)
    report.wu = { parts: built.parts.length, structures: built.rows.length, closedManifolds: closed, midsagittalXmm: round(xMid * 1000, 2), carriage: { method: 'blend of the rigid pose and standardisation maps of both hip bones and the sacrum (as the Denver items)', vsPosingFieldMeanMm: round((dMean / dN) * 1000, 2), vsPosingFieldMaxMm: round(dMax * 1000, 2) }, repair: wuRows, maleReplaced: wuReplacedMale }
  }
  const real = parts.length
  console.log(`\nHer real soft parts vs where the field puts the male counterpart (centroid distance, mm): ${softOffsets.map((o) => `${o.name} ${o.offsetMm}`).join(', ')}`)
  report.realSoftPartOffsets = softOffsets
  const dropped = male.data.parts.filter(isMaleOnly)
  const droppedIds = new Set(dropped.map((p) => p.id))
  // 把她的真实部件作为实体，用于所有形变部件的碰撞处理
  // her real parts as solids for collision handling of everything warped
  const solids: ExistingPart[] = parts.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: p.tissue }))
  const field = new SurfaceField(solids)
  const isHard = (i: number) => HARD_TISSUES.includes(field.parts[i]!.tissue)
  let pushedParts = 0
  const insideBone: { name: string; before: number; after: number }[] = []
  const boneSolid = (i: number) => field.parts[i]!.tissue === 'bone' || field.parts[i]!.tissue === 'cartilage'
  let nerveStats = { length: 0, boneBefore: 0, boneAfter: 0, canal: 0, muscleBefore: 0, muscleAfter: 0, points: 0, moved: 0 }
  // 关节局部配准所用的骨：男性的每块骨，去向由形变场给出；她有真实对应骨的，以其表面为目标
  // bones for the joint-local fit: every male bone, carried by the field; where she has the real
  // counterpart, its surface is the target
  const isJointPart = (m: Part) => m.system === 'skeletal' && (m.tissue === 'ligament' || m.tissue === 'fat' || m.tissue === 'fascia' || (m.tissue === 'cartilage' && /menisc/i.test(m.name)))
  const jointCache = new Map<string, never>() as unknown as Parameters<typeof jointLocalWarp>[2]
  const jointRows: Record<string, unknown>[] = []
  const vesselMuscle: { name: string; before: number; after: number }[] = []
  const misplaced: { id: string; name: string; inBone: number }[] = []
  let jointBoneList: JointBone[] | null = null
  const jointBones = (): JointBone[] => {
    if (jointBoneList) return jointBoneList
    const realOf = new Map(parts.filter((p) => p.male && p.tissue === 'bone').map((p) => [p.male!, p]))
    jointBoneList = male.data.parts.filter((m) => m.tissue === 'bone').map((m) => {
      const real = realOf.get(m.id)
      // 采样点和目标索引都在第一次用到时才建 / samples and target index are built on first use
      let pts: Float32Array | null = null
      let tgt: PointIndex | null = null
      const bone: JointBone = { id: m.id, points: () => (pts ??= thinPoints(surfacePoints(maleMesh(m.id), 0.001), 0.0008)), bbox: m.bbox, map: (q: Float32Array) => fieldD.apply(q) }
      if (real) Object.defineProperty(bone, 'target', { get: () => (tgt ??= new PointIndex(thinPoints(surfacePoints(real.mesh, 0.001), 0.0008), 0.003)), enumerable: true })
      return bone
    })
    return jointBoneList
  }
  for (const m of male.data.parts) {
    if (replaced.has(m.id) || droppedIds.has(m.id)) continue
    if (process.env.SOMA_TRACE) console.error(`warp ${m.id} ${m.name}`)
    // 皮下脂肪不做形变，稍后在她自己的皮肤和深部结构上重新推导 / the subcutaneous fat is not warped: it is derived again from her own skin and deep parts below
    if (isFatPart(m.id)) continue
    const base = { id: `W_${m.id}`, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, provenance: 'warped' as Provenance, source: m.source ?? male.data.sources[0]!.name, male: m.id }
    const lines = male.nerves.get(m.id)
    if (lines && m.tissue === 'nerve') {
      // 她真实的下肢肌（Denver）比男性肌腹厚：神经最多可被推出 40 mm（男性构建为 15 mm）
      // her real leg muscles (Denver) are thicker than the male bellies: a nerve may be pushed out by up to 40 mm (15 mm in the male build)
      const w = warpNerveLines(lines, fieldD, field, { ...NERVE_BUILD_DEFAULTS, step: 0.002, canal: canalFor(m.name), maxMusclePush: NERVE_MUSCLE_PUSH })
      if (w.mesh) {
        nerveStats = {
          length: nerveStats.length + w.before.length, boneBefore: nerveStats.boneBefore + w.before.inBone * w.before.length, boneAfter: nerveStats.boneAfter + w.after.inBone * w.after.length,
          canal: nerveStats.canal + w.after.inCanal * w.after.length, muscleBefore: nerveStats.muscleBefore + w.before.deepInMuscle * w.before.length, muscleAfter: nerveStats.muscleAfter + w.after.deepInMuscle * w.after.length,
          points: nerveStats.points + w.points, moved: nerveStats.moved + w.pushed,
        }
        parts.push({ ...base, mesh: w.mesh, centrelines: w.branches, keepGeometry: true })
        continue
      }
    }
    const src = maleMesh(m.id)
    let positions = fieldD.apply(src.positions)
    // 跨骨部件（韧带、半月板、关节囊、脂肪垫）：先试关节局部配准，让每一端随她的骨走；
    // 结果在骨内的比例不高于全身场的结果（且不超过上限）时采用
    // two-bone parts (ligaments, menisci, capsules, fat pads): the joint-local fit is tried first so
    // that each end follows her bone; it is used when no more of it lies in bone than the body-wide
    // field's result gives (and no more than the cap)
    if (isJointPart(m)) {
      const inBone = (pos: Float32Array) => {
        const mesh = { positions: pos, indices: src.indices }
        return overlapWith(thinPoints(surfacePoints(mesh, 0.004), 0.003), measure(mesh).bbox, field, 0.002, 0.004, boneSolid).insideAny
      }
      const j = jointLocalWarp(src, jointBones(), jointCache)
      const row: Record<string, unknown> = { id: m.id, name: m.name, bones: j ? j.bones.map((b) => male.parts.get(b.id)!.name) : [] }
      if (j) {
        const viaField = HARD_TISSUES.includes(m.tissue) ? positions : pushOutOfSolids(positions, measure({ positions, indices: src.indices }).bbox, field, isHard).positions
        const a = inBone(viaField)
        const pushed = HARD_TISSUES.includes(m.tissue) ? j.mesh.positions : pushOutOfSolids(j.mesh.positions, measure(j.mesh).bbox, field, isHard).positions
        const b = inBone(pushed)
        Object.assign(row, { inBoneField: round(a, 3), inBoneJoint: round(b, 3), used: b <= JOINT_MAX_IN_BONE && b <= a + 0.02 })
        if (row.used) {
          jointRows.push(row)
          if (b > MISPLACED_IN_BONE) misplaced.push({ id: m.id, name: m.name, inBone: round(b, 3) })
          else parts.push({ ...base, mesh: { positions: pushed, indices: src.indices }, keepGeometry: true, note: 'placed by its bones (joint-local fit)' })
          continue
        }
      }
      jointRows.push(row)
    }
    // 形变后的软组织部件不得位于她的真实骨内；形变后的骨（颅骨、手、足、胸骨）本身就是骨
    // warped soft parts must not sit in her real bones; warped bones (skull, hands, feet, sternum) are bones themselves
    if (!HARD_TISSUES.includes(m.tissue) && m.tissue !== 'skin') {
      const st = measure({ positions, indices: src.indices })
      const samples = thinPoints(surfacePoints({ positions, indices: src.indices }, 0.004), 0.003)
      // 血管还要避开她真实的肌（下肢的 Denver 肌、臀肌等）：男性血管并不是按这些肌贴合的
      // vessels must also clear her real muscles (the Denver leg muscles, the glutei, …): the male vessels were not fitted to them
      const vessel = m.tissue === 'artery' || m.tissue === 'vein'
      const solidHere = vessel ? (i: number) => isHard(i) || field.parts[i]!.tissue === 'muscle' : isHard
      const inMuscle = (pts: Float32Array, bb: number[]) => overlapWith(pts, bb as [number, number, number, number, number, number], field, 0.002, 0.004, (i) => field.parts[i]!.tissue === 'muscle').deepAny
      const muscleBefore = vessel ? inMuscle(samples, st.bbox) : 0
      const before = overlapWith(samples, st.bbox, field, 0.002, 0.004, boneSolid).insideAny
      if (before > 0 || muscleBefore > 0) {
        const push = pushOutOfSolids(positions, st.bbox, field, solidHere, vessel ? { clearance: 0.0004, maxPush: VESSEL_MUSCLE_PUSH, radius: 0.012, step: 0.0005 } : undefined)
        positions = push.positions
        if (push.moved) pushedParts++
        const afterPts = thinPoints(surfacePoints({ positions, indices: src.indices }, 0.004), 0.003)
        const afterBox = measure({ positions, indices: src.indices }).bbox
        const after = overlapWith(afterPts, afterBox, field, 0.002, 0.004, boneSolid).insideAny
        if (vessel && muscleBefore > 0) vesselMuscle.push({ name: m.name, before: muscleBefore, after: inMuscle(afterPts, afterBox) })
        // 推出之后仍大半在她的真实骨内的部件放错了位置：不输出
        // a part still mostly inside her real bones after the slide-out is misplaced: not shipped
        if (after > MISPLACED_IN_BONE) {
          misplaced.push({ id: m.id, name: m.name, inBone: round(after, 3) })
          continue
        }
        insideBone.push({ name: m.name, before, after })
      } else insideBone.push({ name: m.name, before: 0, after: 0 })
    }
    parts.push({ ...base, mesh: { positions, indices: src.indices }, keepGeometry: true })
  }
  // 一侧因放错位置而未输出时，另一侧的同名部件也不输出，保持左右成对
  // when one side was not shipped as misplaced, its twin on the other side is not shipped either: left and right stay paired
  for (const x of [...misplaced]) {
    const twin = /^Left /.test(x.name) ? x.name.replace(/^Left /, 'Right ') : /^Right /.test(x.name) ? x.name.replace(/^Right /, 'Left ') : null
    if (!twin) continue
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]!.name !== twin || parts[i]!.provenance !== 'warped' || !parts[i]!.id.startsWith('W_')) continue
      misplaced.push({ id: parts[i]!.male!, name: twin, inBone: NaN })
      parts.splice(i, 1)
    }
  }
  {
    const tried = jointRows.filter((r) => 'used' in r)
    const used = tried.filter((r) => r.used)
    const mean = (k: string, rows: Record<string, unknown>[]) => (rows.length ? rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length : 0)
    console.log(`\nJoint-local fit on her bones: ${jointRows.length} two-bone parts carried over from the male, ${tried.length} near a bone, ${used.length} placed by their bones (share of surface in her real bones, mean: body-wide field ${(mean('inBoneField', used) * 100).toFixed(1)}% → joint-local ${(mean('inBoneJoint', used) * 100).toFixed(1)}%); ${tried.length - used.length} kept from the field: ${tried.filter((r) => !r.used).map((r) => `${r.name} (${((r.inBoneField as number) * 100).toFixed(0)}% vs ${((r.inBoneJoint as number) * 100).toFixed(0)}%)`).slice(0, 12).join(', ')}`)
    report.jointLocal = { candidates: jointRows.length, nearBone: tried.length, used: used.length, rows: jointRows }
    console.log(`  not shipped, more than ${MISPLACED_IN_BONE * 100}% of the surface inside her real bones or cartilage (${misplaced.length}): ${misplaced.map((x) => (Number.isFinite(x.inBone) ? `${x.name} ${(x.inBone * 100).toFixed(0)}%` : `${x.name} (twin)`)).join(', ') || 'none'}`)
    report.misplaced = misplaced
    const vm = (k: 'before' | 'after') => (vesselMuscle.length ? vesselMuscle.reduce((a, x) => a + x[k], 0) / vesselMuscle.length : 0)
    console.log(`  vessels against her real muscles: ${vesselMuscle.length} vessels ran more than 4 mm deep in a muscle; mean share of their surface that deep ${(vm('before') * 100).toFixed(1)}% → ${(vm('after') * 100).toFixed(1)}% after the slide-out; worst after: ${[...vesselMuscle].sort((a, b) => b.after - a.after).slice(0, 6).map((x) => `${x.name} ${(x.after * 100).toFixed(0)}%`).join(', ')}`)
    report.vesselsInMuscle = { vessels: vesselMuscle.length, meanDeepBefore: round(vm('before'), 4), meanDeepAfter: round(vm('after'), 4), worst: [...vesselMuscle].sort((a, b) => b.after - a.after).slice(0, 10).map((x) => ({ name: x.name, before: round(x.before, 3), after: round(x.after, 3) })) }
  }
  lap(`${real} real female parts, ${parts.length - real} male parts warped, ${dropped.length} male-only parts dropped`)

  // HRA 女性器官 / HRA female organs
  const hraClass = (it: FemaleItem): { system: SystemId; tissue: TissueId } => {
    const n = it.id
    if (/artery/.test(n)) return { system: 'cardiovascular', tissue: 'artery' }
    if (/vein/.test(n)) return { system: 'cardiovascular', tissue: 'vein' }
    if (/HRA_fat_/.test(n)) return { system: 'integumentary', tissue: 'fat' }
    if (/nipple|areola/.test(n)) return { system: 'integumentary', tissue: 'skin' }
    if (/mammary|lactiferous/.test(n)) return { system: 'integumentary', tissue: 'gland' }
    if (/suspensory_ligaments_[LR]$/.test(n)) return { system: 'integumentary', tissue: 'ligament' }
    if (it.kind === 'ligament') return { system: 'reproductive', tissue: /pouch/.test(n) ? 'space' : 'ligament' }
    if (/ovary/.test(n)) return { system: 'reproductive', tissue: 'gland' }
    return { system: 'reproductive', tissue: 'organ' }
  }
  const hraName = (it: FemaleItem) => {
    const n = it.name.replace(/\s+/g, ' ').trim()
    const sided = /\b(left|right)\b/i.test(n) || it.side === 'M' ? n : `${it.side === 'L' ? 'left' : 'right'} ${n}`
    return sided[0]!.toUpperCase() + sided.slice(1)
  }
  // 两侧 HRA 条目都用到的概念 id，各得一个分侧的子概念（`<id>_L` / `<id>_R`）
  // concept ids used by HRA items of both sides get a sided child each (`<id>_L` / `<id>_R`)
  const hraConcept = (it: FemaleItem) => it.fma ?? (it.ontology_id ? it.ontology_id.replace(':', '_') : `HRAC_${it.id.replace(/^HRA_/, '').replace(/_[LR]$/, '').toLowerCase()}`)
  const hraSides = new Map<string, Set<string>>()
  for (const it of fa.items) if (it.source === 'hra' && it.side !== 'M') hraSides.set(hraConcept(it), (hraSides.get(hraConcept(it)) ?? new Set()).add(it.side))
  const hraReplaced: FPart[] = []
  for (const it of fa.items) {
    if (it.source !== 'hra') continue
    const cls = hraClass(it)
    const base = hraConcept(it)
    const fma = it.side !== 'M' && (hraSides.get(base)?.size ?? 0) > 1 ? `${base}_${it.side}` : base
    const w = weld(posed(it).positions, fa.scanned(it).indices)
    const part: FPart = { id: it.id, fma, name: hraName(it), system: cls.system, tissue: cls.tissue, depth: depthOf(cls.system, cls.tissue), side: it.side, provenance: 'curated', source: SOURCE_HRA.name, mesh: { positions: w.positions, indices: w.indices }, volume: it.volume_ml || undefined }
    // Wu 的子宫、附件和阴道取代 HRA 的同名器官；被取代的只留作数值对比
    // the Wu uterus, adnexa and vagina replace the HRA organs of the same name; the replaced ones are kept for the numeric comparison only
    if (wuItems.length && HRA_REPLACED_BY_WU.test(it.id)) hraReplaced.push(part)
    else parts.push(part)
  }
  const hra = parts.filter((p) => p.source === SOURCE_HRA.name)
  lap(`${hra.length} HRA parts added`)
  await finish({ parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed, lumbarConcept, dy, standard, restack: RESTACK, wuExtras, hraReplaced })
}

/**
 * 调试用的部件快照：parts.json（元数据和偏移）+ parts.bin（顶点、索引、中心线）。
 * Debugging snapshot of parts: parts.json (metadata and offsets) + parts.bin (vertices, indices, centrelines).
 */
function writePartSnapshot(dir: string, all: { p: FPart; kind: string }[]): void {
  mkdirSync(dir, { recursive: true })
  const chunks: Uint8Array[] = []
  let off = 0
  const put = (a: Float32Array | Uint32Array) => {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    chunks.push(Uint8Array.from(u))
    off += u.byteLength
    return off - u.byteLength
  }
  const meta = all.map(({ p, kind }) => ({ kind, id: p.id, fma: p.fma, name: p.name, system: p.system, tissue: p.tissue, side: p.side, provenance: p.provenance, source: p.source, male: p.male, nv: p.mesh.positions.length / 3, ni: p.mesh.indices.length, po: put(p.mesh.positions), io: put(p.mesh.indices), lines: (p.centrelines ?? []).map((l) => ({ n: l.radius.length, po: put(l.points), ro: put(l.radius) })) }))
  writeFileSync(join(dir, 'parts.json'), JSON.stringify(meta))
  writeFileSync(join(dir, 'parts.bin'), Buffer.concat(chunks))
}

interface FinishInput {
  parts: FPart[]
  male: Awaited<ReturnType<typeof loadBuiltBody>>
  fa: ReturnType<typeof loadFemaleAnchors>
  fmaNames: ReturnType<typeof loadFmaNames>
  report: Record<string, unknown>
  notes: string[]
  outDir: string
  lap: (s: string) => void
  dropped: Part[]
  realNotes: Record<string, string>
  insideBone: { name: string; before: number; after: number }[]
  pushedParts: number
  nerveStats: { length: number; boneBefore: number; boneAfter: number; canal: number; muscleBefore: number; muscleAfter: number; points: number; moved: number }
  hra: FPart[]
  notUsed: { id: string; reason: string }[]
  lumbarConcept: string
  dy: number
  standard: Standardised | null
  restack: Rigid
  /** 不输出、但用于对接和对比的 Wu 条目（膀胱壁、皮肤等），已带到她的骨盆上 / Wu items that are not shipped but serve joins and comparisons (bladder wall, skin, …), carried onto her pelvis */
  wuExtras: Map<string, Mesh>
  /** 被 Wu 结构取代的 HRA 器官，仅用于数值对比 / HRA organs replaced by Wu structures, for the numeric comparison only */
  hraReplaced: FPart[]
}

async function finish(input: FinishInput) {
  const { parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed, dy, standard, restack } = input
  const byName = (name: string) => parts.find((p) => p.name === name)
  const samplesOf = (m: Mesh, spacing = 0.003) => thinPoints(surfacePoints(m, spacing), spacing * 0.8)
  // 调试用：把进入盆腔协调之前的全部部件存盘（SOMA_PELVIS_SNAPSHOT=<目录>），便于单独重跑这一步；构建到此为止，不写输出
  // debugging aid: all parts as they enter the pelvic reconciliation are dumped (SOMA_PELVIS_SNAPSHOT=<dir>), so that this step can be rerun alone; the build stops there and writes no output
  if (process.env.SOMA_PELVIS_SNAPSHOT) {
    const dir = process.env.SOMA_PELVIS_SNAPSHOT
    writePartSnapshot(dir, [...parts.map((p) => ({ p, kind: 'part' })), ...input.hraReplaced.map((p) => ({ p, kind: 'hraReplaced' })), ...[...input.wuExtras].map(([k, mesh]) => ({ p: { id: `WUX_${k}`, name: k, mesh } as FPart, kind: 'wuExtra' }))])
    console.log(`  pelvis snapshot written to ${dir}; stopping here`)
    return
  }

  // ── 5. 女性小骨盆：以 Wu 的盆底为骨架，把其余结构接上去（见 pelvis.ts） / 5. The female lesser pelvis: the Wu pelvic floor as backbone, everything else joined to it (see pelvis.ts)
  {
    console.log('\nFemale lesser pelvis (Wu et al. 2015 backbone)')
    const pelvis = reconcilePelvis({ parts, extras: input.wuExtras, hraReplaced: input.hraReplaced, log: (l) => console.log(`  ${l}`) })
    const gone: { id: string; name: string }[] = []
    for (let i = parts.length - 1; i >= 0; i--) if (pelvis.drop.has(parts[i]!.id)) gone.push(...parts.splice(i, 1).map((p) => ({ id: p.id, name: p.name })))
    report.pelvis = { ...pelvis.report, dropped: gone.sort((a, b) => a.id.localeCompare(b.id)) }
  }
  lap('female lesser pelvis reconciled')

  // ── 5b. 皮肤：形变后的男性表面，在乳房处抬升为平滑包络 / 5b. Skin: the warped male surface, raised into a smooth envelope over the breasts ───────
  // 皮肤是一层薄的双壁壳，所以“在体内”不能用射线奇偶性来判断。
  // 从一个点正向前（+Z）发出的射线若完全碰不到皮肤三角形，就算该点在皮肤前方。
  // The skin is a thin double-walled shell, so "inside the body" cannot be tested by ray parity.
  // A point is counted as in front of the skin when a ray from it straight forwards (+Z) meets
  // no skin triangle at all.
  const inFrontOfSkin = (skin: Mesh, pts: Float32Array): number => {
    const p = skin.positions
    const idx = skin.indices
    let b = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < pts.length; i += 3) b = [Math.min(b[0]!, pts[i]!), Math.min(b[1]!, pts[i + 1]!), Math.max(b[2]!, pts[i]!), Math.max(b[3]!, pts[i + 1]!)]
    const tris: number[] = []
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t]!
      const c = 3 * idx[t + 1]!
      const d = 3 * idx[t + 2]!
      if (Math.max(p[a]!, p[c]!, p[d]!) < b[0]! || Math.min(p[a]!, p[c]!, p[d]!) > b[2]! || Math.max(p[a + 1]!, p[c + 1]!, p[d + 1]!) < b[1]! || Math.min(p[a + 1]!, p[c + 1]!, p[d + 1]!) > b[3]!) continue
      tris.push(a, c, d)
    }
    let front = 0
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]! + 1.3e-7
      const y = pts[i + 1]! + 0.7e-7
      const z = pts[i + 2]!
      let hit = false
      for (let t = 0; t < tris.length && !hit; t += 3) {
        const a = tris[t]!
        const c = tris[t + 1]!
        const d = tris[t + 2]!
        const w0 = (p[c]! - x) * (p[d + 1]! - y) - (p[c + 1]! - y) * (p[d]! - x)
        const w1 = (p[d]! - x) * (p[a + 1]! - y) - (p[d + 1]! - y) * (p[a]! - x)
        const w2 = (p[a]! - x) * (p[c + 1]! - y) - (p[a + 1]! - y) * (p[c]! - x)
        if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue
        const hz = (w0 * p[a + 2]! + w1 * p[c + 2]! + w2 * p[d + 2]!) / (w0 + w1 + w2)
        if (hz > z) hit = true
      }
      if (!hit) front++
    }
    return pts.length ? front / (pts.length / 3) : 0
  }
  // 皮肤包只读一次。包若声明是为女性体拟合的，占位皮肤多半会被换掉：胸部抬升先不做，
  // 等到 5e 确认指纹不符、占位皮肤要留下时再做。
  // The skin package is read once. When it says it was fitted to the female body the placeholder will
  // most likely be replaced, so the chest raise is put off until step 5e finds that the fingerprint
  // does not match and the placeholder stays.
  const skinPackage = loadSkinPackage(join(ROOT, SKIN_PACKAGE_DIR))
  const raiseSkinOverBreasts = () => {
    const skin = parts.find((p) => p.name === 'Skin' && p.tissue === 'skin')
    const breastParts = (side: 'L' | 'R') => parts.filter((p) => p.provenance === 'curated' && p.system === 'integumentary' && p.side === side)
    const skinReport: Record<string, unknown> = {}
    if (skin && breastParts('L').length) {
      const pos = Float32Array.from(skin.mesh.positions)
      const idx = skin.mesh.indices
      const nv = pos.length / 3
      const before = { L: inFrontOfSkin(skin.mesh, concat(breastParts('L').map((p) => samplesOf(p.mesh, 0.004)))), R: inFrontOfSkin(skin.mesh, concat(breastParts('R').map((p) => samplesOf(p.mesh, 0.004)))) }
      // 顶点的邻居 / vertex neighbours
      const nb: number[][] = Array.from({ length: nv }, () => [])
      for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
        const a = idx[t + k]!
        const c = idx[t + ((k + 1) % 3)]!
        if (!nb[a]!.includes(c)) nb[a]!.push(c)
        if (!nb[c]!.includes(a)) nb[c]!.push(a)
      }
      const MARGIN = 0.003
      let raised = 0
      let maxLift = 0
      for (const side of ['L', 'R'] as const) {
        const bp = thinPoints(concat(breastParts(side).map((p) => samplesOf(p.mesh, 0.003))), 0.003)
        const c = [0, 0, 0]
        let zMin = Infinity
        for (let i = 0; i < bp.length; i += 3) {
          c[0] = c[0]! + bp[i]! / (bp.length / 3)
          c[1] = c[1]! + bp[i + 1]! / (bp.length / 3)
          zMin = Math.min(zMin, bp[i + 2]!)
        }
        // 乳房后方、胸壁上的极点：包络自此点沿径向展开
        // pole behind the breast, on the chest wall: the envelope is radial from here
        const base = [c[0]!, c[1]!, zMin - 0.02]
        const dirs: number[][] = []
        const radii: number[] = []
        let rMax = 0
        for (let i = 0; i < bp.length; i += 3) {
          const d = [bp[i]! - base[0]!, bp[i + 1]! - base[1]!, bp[i + 2]! - base[2]!]
          const r = Math.hypot(d[0]!, d[1]!, d[2]!)
          dirs.push([d[0]! / r, d[1]! / r, d[2]! / r])
          radii.push(r)
          rMax = Math.max(rMax, r)
        }
        const COS = Math.cos((8 * Math.PI) / 180)
        const lift = new Float32Array(nv)
        const dirOf = new Float32Array(nv * 3)
        for (let v = 0; v < nv; v++) {
          const d = [pos[3 * v]! - base[0]!, pos[3 * v + 1]! - base[1]!, pos[3 * v + 2]! - base[2]!]
          const r = Math.hypot(d[0]!, d[1]!, d[2]!)
          if (r > rMax + 0.12 || d[2]! < -0.01) continue
          const u = [d[0]! / r, d[1]! / r, d[2]! / r]
          dirOf.set(u, 3 * v)
          let rb = 0
          for (let k = 0; k < dirs.length; k++) {
            const q = dirs[k]!
            if (q[0]! * u[0]! + q[1]! * u[1]! + q[2]! * u[2]! >= COS && radii[k]! > rb) rb = radii[k]!
          }
          if (rb > 0 && rb + MARGIN > r) lift[v] = rb + MARGIN - r
        }
        // 平滑的裙边：每个顶点的抬升量至少为其邻居平均抬升量的 0.8 倍
        // smooth skirt: every vertex is lifted at least 0.8 × the mean lift of its neighbours
        for (let it = 0; it < 30; it++) {
          for (let v = 0; v < nv; v++) {
            if (dirOf[3 * v] === 0 && dirOf[3 * v + 1] === 0 && dirOf[3 * v + 2] === 0) continue
            const n = nb[v]!
            if (!n.length) continue
            let m = 0
            for (const j of n) m += lift[j]!
            const want = (0.8 * m) / n.length
            if (want > lift[v]!) lift[v] = want
          }
        }
        for (let v = 0; v < nv; v++) {
          if (lift[v]! < 1e-4) continue
          pos[3 * v] = pos[3 * v]! + dirOf[3 * v]! * lift[v]!
          pos[3 * v + 1] = pos[3 * v + 1]! + dirOf[3 * v + 1]! * lift[v]!
          pos[3 * v + 2] = pos[3 * v + 2]! + dirOf[3 * v + 2]! * lift[v]!
          raised++
          maxLift = Math.max(maxLift, lift[v]!)
        }
      }
      skin.mesh = { positions: pos, indices: idx }
      skin.note = 'male skin deformed to her skeleton, then raised into a smooth envelope over the breasts: a synthetic surface'
      const after = { L: inFrontOfSkin(skin.mesh, concat(breastParts('L').map((p) => samplesOf(p.mesh, 0.004)))), R: inFrontOfSkin(skin.mesh, concat(breastParts('R').map((p) => samplesOf(p.mesh, 0.004)))) }
      Object.assign(skinReport, { method: 'radial envelope over the HRA breasts with a smooth skirt', verticesRaised: raised, ofVertices: nv, maxLiftMm: round(maxLift * 1000, 1), breastSurfaceInFrontOfSkin: { before: { left: round(before.L, 3), right: round(before.R, 3) }, after: { left: round(after.L, 3), right: round(after.R, 3) } } })
      console.log(`\nSkin: ${raised} of ${nv} vertices raised (max ${mm(maxLift)} mm) to enclose the breasts; breast surface in front of the skin: left ${(before.L * 100).toFixed(0)}% → ${(after.L * 100).toFixed(0)}%, right ${(before.R * 100).toFixed(0)}% → ${(after.R * 100).toFixed(0)}%`)
    }
    report.skin = skinReport
  }
  const raiseDeferred = skinPackage?.fittedTo?.body === 'female'
  if (!raiseDeferred) raiseSkinOverBreasts()

  // ── 5d. 手：男性的手经形变场贴到她成组的手骨上，手指偏长；绕腕中心均匀缩放到目标手长
  // ── 5d. Hands: the male hands, carried by the field onto her grouped hand bones, come out long in
  // the fingers; scaled uniformly about the wrist centre to the target hand length
  if (standard) {
    const boneVerts = (name: string) => {
      const list = parts.filter((p) => p.tissue === 'bone' && p.name === name)
      if (!list.length) throw new Error(`standardisation: no bone named ${name}`)
      return concat(list.map((p) => p.mesh.positions))
    }
    const floorAndVertex = () => {
      const feet = parts.filter((p) => p.tissue === 'bone' && FOOT_BONE.test(p.name)).map((p) => measure(p.mesh).bbox[1])
      const skull = parts.filter((p) => p.tissue === 'bone' && /parietal|frontal/i.test(p.name)).map((p) => measure(p.mesh).bbox[4])
      return [Math.min(...feet) - SOLE_PAD, Math.max(...skull) + SCALP] as const
    }
    const [f0, v0] = floorAndVertex()
    const L = boneLandmarks(boneVerts, f0, v0)
    const m = skeletalMeasures(L)
    const want = standard.targets.handlengthBone!
    const k = Math.min(1.1, Math.max(0.8, want / m.handlengthBone!))
    const from: Float32Array[] = []
    const to: Float32Array[] = []
    const handMap = (p: FPart): PointMap | null => {
      const side = /\bleft\b/i.test(p.name) ? 'L' : /\bright\b/i.test(p.name) ? 'R' : null
      if (!side || !HAND_BONE.test(p.name)) return null
      const w = L[`wrist_${side}`]!
      return (q) => [w[0] + k * (q[0] - w[0]), w[1] + k * (q[1] - w[1]), w[2] + k * (q[2] - w[2])]
    }
    for (const p of parts) {
      if (p.tissue !== 'bone') continue
      const a = thinPoints(surfacePoints(p.mesh, ANCHOR_SPACING), ANCHOR_SPACING)
      const hm = handMap(p)
      from.push(a)
      to.push(hm ? mapPoints(hm, a) : a)
    }
    const fieldH = buildTwoLevelDeformation(concat(from), concat(to), TWO_LEVEL)
    // 只动前臂中段以远的部分 / only what lies beyond the middle of the forearm moves
    const near = (p: FPart) => {
      const b = measure(p.mesh).bbox
      return ['L', 'R'].some((sd) => {
        const w = L[`wrist_${sd}`]!
        return b[0] < w[0] + 0.15 && b[3] > w[0] - 0.15 && b[1] < w[1] + 0.15 && b[4] > w[1] - 0.3 && b[2] < w[2] + 0.2 && b[5] > w[2] - 0.2
      })
    }
    let moved = 0
    for (const p of parts) {
      const hm = p.tissue === 'bone' ? handMap(p) : null
      if (p.tissue === 'bone' && !hm) continue
      if (!hm && !near(p)) continue
      p.mesh = { positions: hm ? mapPoints(hm, p.mesh.positions) : fieldH.apply(p.mesh.positions), indices: p.mesh.indices }
      if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: fieldH.apply(l.points), radius: l.radius }))
      moved++
    }
    standard.scales.hand = round(k, 4)
    // 标准化后的骨架实测 / the standardised skeleton, measured
    const [f1, v1] = floorAndVertex()
    const m1 = skeletalMeasures(boneLandmarks(boneVerts, f1, v1))
    const rows = Object.keys(m1).filter((key) => standard.rows[key] || key === 'handlengthBone').map((key) => {
      const t = standard.rows[key] ?? { donor: m.handlengthBone!, target: want, mean: want, sd: standard.handSd }
      return { measure: key, donorMm: round(t.donor, 1), targetMm: round(t.target, 1), afterMm: round(m1[key]!, 1), populationMeanMm: round(t.mean, 1), sdMm: round(t.sd, 1), zDonor: Number.isFinite(t.sd) ? round((t.donor - t.mean) / t.sd, 2) : null, zAfter: Number.isFinite(t.sd) ? round((m1[key]! - t.mean) / t.sd, 2) : null }
    })
    console.log(`\nStandardised skeleton as built (bony landmarks; floor ${SOLE_PAD * 1000} mm below the lowest foot bone, vertex ${SCALP * 1000} mm above the skull); hands scaled ${k.toFixed(3)} about the wrists (${moved} parts)`)
    console.log(`  (hand: the 'donor' column is the male hand as warped onto her hand bones)`)
    console.log(`  ${pad('measure (mm)', 34)}${pad('donor', 9)}${pad('target', 9)}${pad('built', 9)}${pad('z donor', 10)}z built`)
    for (const r of rows) console.log(`  ${pad(r.measure, 34)}${pad(r.donorMm ?? '', 9)}${pad(r.targetMm, 9)}${pad(r.afterMm, 9)}${pad(r.zDonor ?? '', 10)}${r.zAfter ?? ''}`)
    const out = rows.filter((r) => r.zAfter !== null && Math.abs(r.zAfter) > 1)
    console.log(`  outside ±1 SD: ${out.map((r) => `${r.measure} ${r.zAfter}`).join(', ') || 'none'}`)
    report.standard = { ...standard.report, scales: standard.scales, measures: rows, outsideOneSd: out.map((r) => r.measure) }
    lap('hands scaled, skeleton measured')
  }

  // ── 5f. 肌肉包络收到 BMI 22 女性的围度以内 / the muscle envelope brought inside the girths of a BMI-22 woman
  // 每个部位：围度目标（人体测量模型，取她现在的身高和默认 BMI）减去应有的皮下脂肪和皮肤，
  // 得到肌肉包络应有的围度；实测包络大于它时，把软组织朝最近的骨面收拢（见 slim.ts）。
  // 长度和附着点不动；肌肉之间的血管、神经随同一个场移动。
  // Per region: the girth target (anthropometric model at her present stature and the default BMI)
  // minus the subcutaneous fat and skin that belong there gives the girth the muscle envelope should
  // have; where the measured envelope is larger, soft tissue is drawn towards the nearest bone
  // surface (see slim.ts). Lengths and attachments stay; vessels and nerves between the muscles move
  // with the same field.
  if (standard && existsSync(SHAPE_MODEL) && !process.env.SOMA_NO_SLIM) {
    const model = JSON.parse(readFileSync(ANTHRO_MODEL, 'utf8')) as AnthroModel
    const shape = JSON.parse(readFileSync(SHAPE_MODEL, 'utf8')) as { fatSites: { id: string; thicknessMm: { F: { a: number; b: number }; min: number } }[] }
    const S = STANDARD.statureMm
    const B = STANDARD.bmi
    const fat = (site: string) => {
      const f = shape.fatSites.find((x) => x.id === site)
      if (!f) throw new Error(`shape model has no fat site ${site}`)
      return Math.max(f.thicknessMm.min, f.thicknessMm.F.a + f.thicknessMm.F.b * B)
    }
    const SKIN_MM = 2
    const boneVerts = (name: string) => concat(parts.filter((p) => p.tissue === 'bone' && p.name === name).map((p) => p.mesh.positions))
    const feet = parts.filter((p) => p.tissue === 'bone' && FOOT_BONE.test(p.name)).map((p) => measure(p.mesh).bbox[1])
    const L = boneLandmarks(boneVerts, Math.min(...feet) - SOLE_PAD, Math.max(...parts.filter((p) => p.tissue === 'bone').map((p) => measure(p.mesh).bbox[4])) + SCALP)
    const xMid = (L.hip_L![0] + L.hip_R![0]) / 2
    const isEnvelope = (p: FPart) => p.tissue === 'muscle' || p.tissue === 'tendon' || p.tissue === 'bone' || p.tissue === 'cartilage'
    const envelope = () => parts.filter(isEnvelope).map((p) => p.mesh)
    const bonesOnly = () => parts.filter((p) => p.tissue === 'bone').map((p) => p.mesh)
    const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]
    const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const UP: Vec3 = [0, 1, 0]
    // 上肢轴线在高度 y 处的 x：躯干截面只保留它内侧的点 / x of the arm's axis at height y: trunk sections keep only points medial of it
    const armX = (sgn: number, y: number) => {
      const S2 = sgn > 0 ? 'L' : 'R'
      const sh = L[`shoulder_${S2}`]!
      const el = L[`elbow_${S2}`]!
      const wr = L[`wrist_${S2}`]!
      const [a, b] = y > el[1] ? [sh, el] : [el, wr]
      const t = Math.max(0, Math.min(1.3, (a[1] - y) / (a[1] - b[1] || 1)))
      return Math.abs(a[0] + t * (b[0] - a[0]) - xMid)
    }
    type Region = { id: string; target: number; fatMm: number; girth: (meshes: Mesh[]) => number }
    const both = (f: (S2: 'L' | 'R', sgn: number) => number) => (f('L', 1) + f('R', -1)) / 2
    // 肢体截面只保留“最近的骨属于本肢段”的截点，把紧挨着的躯干或另一条腿排除在外
    // limb sections keep only cut points whose nearest bone belongs to the segment, which leaves out the trunk or the other leg lying against it
    const ownerNames: string[] = []
    const ownerPts: number[] = []
    for (const p of parts) {
      if (p.tissue !== 'bone') continue
      const sp = thinPoints(surfacePoints(p.mesh, 0.004), 0.004)
      for (let i = 0; i < sp.length; i += 3) {
        ownerPts.push(sp[i]!, sp[i + 1]!, sp[i + 2]!)
        ownerNames.push(p.name)
      }
    }
    const ownerIndex = new PointIndex(Float32Array.from(ownerPts), 0.015)
    const NI = new Int32Array(1)
    const ND = new Float64Array(1)
    // 躯干截面：去掉上肢（最近的骨是肱骨、前臂骨或手骨的截点），并限制在上肢轴线内侧
    // trunk sections: without the upper limbs (cut points whose nearest bone is the humerus, a forearm bone or a hand bone) and medial of the arm's axis
    const ARM_BONE = /humerus|\bradius\b|\bulna\b/i
    const trunkKeep = (y: number) => (q: Vec3) => Math.abs(q[0] - xMid) < armX(q[0] > xMid ? 1 : -1, y) - 0.02 && ownerIndex.nearest(q[0], q[1], q[2], 1, NI, ND) > 0 && !ARM_BONE.test(ownerNames[NI[0]!]!) && !HAND_BONE.test(ownerNames[NI[0]!]!)
    const around = (c: Vec3, r: number, bones: RegExp) => (q: Vec3) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) < r && ownerIndex.nearest(q[0], q[1], q[2], 1, NI, ND) > 0 && bones.test(ownerNames[NI[0]!]!)
    const maxOver = (ts: number[], f: (t: number) => number) => Math.max(...ts.map(f))
    const crestY = (L.iliocristale_L![1] + L.iliocristale_R![1]) / 2
    const hipY = (L.hip_L![1] + L.hip_R![1]) / 2
    const regions: Region[] = [
      { id: 'upperArm', target: anthroNhanes(model, 'F', 'armcirc', S, B), fatMm: 0.75 * fat('upperArmPosterior'), girth: (ms) => both((S2) => { const a = L[`shoulder_${S2}`]!; const b = L[`elbow_${S2}`]!; const c = lerp(a, b, 0.5); return sectionGirth(ms, c, sub3(b, a), around(c, 0.1, /humerus/i)) }) },
      { id: 'forearm', target: anthro(model, 'F', 'forearmcircumferenceflexed', S, B), fatMm: fat('forearm'), girth: (ms) => both((S2) => { const a = L[`elbow_${S2}`]!; const b = L[`wrist_${S2}`]!; return maxOver([0.15, 0.2, 0.25, 0.3, 0.35, 0.4], (t) => { const c = lerp(a, b, t); return sectionGirth(ms, c, sub3(b, a), around(c, 0.09, /radius|ulna/i)) }) }) },
      { id: 'waist', target: anthro(model, 'F', 'waistcircumference', S, B), fatMm: (fat('abdomen') + fat('back')) / 2, girth: (ms) => sectionGirth(ms, [xMid, crestY + 0.035, 0], UP, trunkKeep(crestY + 0.035)) },
      { id: 'buttock', target: anthro(model, 'F', 'buttockcircumference', S, B), fatMm: (fat('buttock') + fat('abdomen')) / 2, girth: (ms) => maxOver([-0.06, -0.03, 0, 0.03, 0.06], (dy) => sectionGirth(ms, [xMid, hipY + dy, 0], UP, trunkKeep(hipY + dy))) },
      { id: 'thighMid', target: anthroNhanes(model, 'F', 'thigh', S, B), fatMm: fat('thighAnterior'), girth: (ms) => both((S2) => { const c = lerp(L[`hip_${S2}`]!, L[`knee_${S2}`]!, 0.5); return sectionGirth(ms, c, UP, around(c, 0.14, new RegExp(`${S2 === 'L' ? 'Left' : 'Right'} femur`))) }) },
      { id: 'calf', target: anthro(model, 'F', 'calfcircumference', S, B), fatMm: fat('calf'), girth: (ms) => both((S2) => maxOver([0.2, 0.25, 0.3, 0.35, 0.4, 0.45], (t) => { const c = lerp(L[`knee_${S2}`]!, L[`ankle_${S2}`]!, t); return sectionGirth(ms, c, UP, around(c, 0.11, new RegExp(`${S2 === 'L' ? 'Left' : 'Right'} (tibia|fibula)`))) })) },
    ]
    const measureAll = () => Object.fromEntries(regions.map((r) => [r.id, { envelope: r.girth(envelope()) * 1000, bone: r.girth(bonesOnly()) * 1000 }]))
    const before = measureAll()
    const want = (r: Region) => r.target - 2 * Math.PI * (r.fatMm + SKIN_MM)
    // λ：软组织到骨的深度应乘的系数，使包络围度降到目标（以包络和骨的等效半径估算）
    // λ: the factor on the depth of soft tissue over bone that brings the envelope girth down to the target (from the equivalent radii of envelope and bone)
    const lambda: Record<string, number> = {}
    for (const r of regions) {
      const R = before[r.id]!.envelope / (2 * Math.PI)
      const rb = Math.min(before[r.id]!.bone / (2 * Math.PI), 0.8 * R)
      const k = want(r) / before[r.id]!.envelope
      lambda[r.id] = k >= 1 ? 1 : Math.max(SLIM_MIN_LAMBDA, (k * R - rb) / (R - rb))
    }
    // 躯干上部（胸壁、肩带）没有不含乳房的围度目标：沿用上臂的系数（同是由男性形变而来的上身肌肉）
    // the upper trunk (chest wall, shoulder girdle) has no girth target free of the breasts: it takes the
    // upper arm's factor (the same upper-body musculature warped from the male)
    const lUa = lambda.upperArm!
    const lFa = lambda.forearm!
    const lEl = (lUa + lFa) / 2
    const pts = (rx: RegExp) => concat(parts.filter((p) => p.tissue === 'bone' && rx.test(p.name)).map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.0025)))
    const thoraxPts = pts(/\brib\b|sternum|Manubrium|Xiphoid|thoracic vertebra/i)
    let zc = 0
    for (let i = 2; i < thoraxPts.length; i += 3) zc += thoraxPts[i]! / (thoraxPts.length / 3)
    const segs: SlimSegment[] = [
      { id: 'thorax', bonePoints: thoraxPts, mode: 'trunk', lambda: [[0, lUa]], saturate: 0.03, centre: [xMid, zc] },
      { id: 'pelvis and lumbar spine', bonePoints: pts(/hip bone|Sacrum|Coccyx|lumbar vertebra/i), mode: 'trunk', lambda: [[0, 1]], centre: [xMid, zc] },
      { id: 'head and neck', bonePoints: pts(/cervical vertebra|^Atlas$|^Axis$|hyoid|frontal|parietal|occipital|temporal|sphenoid|ethmoid|vomer|mandible|maxilla|zygomatic|nasal|lacrimal|palatine|concha/i), mode: 'trunk', lambda: [[0, 1]], centre: [xMid, zc] },
    ]
    for (const [S2, Name] of [['L', 'Left'], ['R', 'Right']] as const) {
      const J = (k: string) => L[`${k}_${S2}`]!
      segs.push(
        { id: `shoulder girdle ${S2}`, bonePoints: pts(new RegExp(`^${Name} (scapula|clavicle)$`)), mode: 'trunk', lambda: [[0, lUa]], saturate: 0.03, centre: [xMid, zc] },
        { id: `upper arm ${S2}`, bonePoints: pts(new RegExp(`^${Name} humerus$`)), mode: 'limb', axis: [J('shoulder'), J('elbow')], lambda: [[0, lUa], [0.6, lUa], [1, lEl]] },
        { id: `forearm ${S2}`, bonePoints: pts(new RegExp(`^${Name} (radius|ulna)$`)), mode: 'limb', axis: [J('elbow'), J('wrist')], lambda: [[0, lEl], [0.3, lFa], [1, 1]] },
        { id: `hand ${S2}`, bonePoints: concat(parts.filter((p) => p.tissue === 'bone' && HAND_BONE.test(p.name) && new RegExp(Name, 'i').test(p.name)).map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.0025))), mode: 'limb', axis: [J('wrist'), J('wrist')], lambda: [[0, 1]] },
        { id: `thigh ${S2}`, bonePoints: pts(new RegExp(`^${Name} (femur|patella)$`)), mode: 'limb', axis: [J('hip'), J('knee')], lambda: [[0, 1], [0.25, lambda.thighMid!], [0.7, lambda.thighMid!], [1, 1]] },
        { id: `shank ${S2}`, bonePoints: pts(new RegExp(`^${Name} (tibia|fibula)$`)), mode: 'limb', axis: [J('knee'), J('ankle')], lambda: [[0, 1], [0.25, lambda.calf!], [0.5, lambda.calf!], [1, 1]] },
        { id: `foot ${S2}`, bonePoints: concat(parts.filter((p) => p.tissue === 'bone' && /calcane|talus|cuboid|cuneiform|navicular|metatarsal|toe/i.test(p.name) && new RegExp(Name, 'i').test(p.name)).map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.0025))), mode: 'limb', axis: [J('ankle'), J('ankle')], lambda: [[0, 1]] },
      )
    }
    const slimmer = buildSlimmer(segs.filter((sg) => sg.bonePoints.length > 0))
    let moved = 0
    let maxMove = 0
    for (const p of parts) {
      if (p.tissue === 'bone' || p.tissue === 'tooth') continue
      const out = slimmer.apply(p.mesh.positions)
      let d = 0
      for (let i = 0; i < out.length; i += 3) d = Math.max(d, Math.hypot(out[i]! - p.mesh.positions[i]!, out[i + 1]! - p.mesh.positions[i + 1]!, out[i + 2]! - p.mesh.positions[i + 2]!))
      if (d > 1e-5) moved++
      maxMove = Math.max(maxMove, d)
      p.mesh = { positions: out, indices: p.mesh.indices }
      if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: slimmer.apply(l.points), radius: l.radius }))
    }
    const after = measureAll()
    const rows = regions.map((r) => ({ region: r.id, girthTargetMm: round(r.target, 0), fatMm: round(r.fatMm, 1), skinMm: SKIN_MM, envelopeTargetMm: round(want(r), 0), envelopeBeforeMm: round(before[r.id]!.envelope, 0), envelopeAfterMm: round(after[r.id]!.envelope, 0), boneHullMm: round(before[r.id]!.bone, 0), lambda: round(lambda[r.id]!, 3), roomForFatAfterMm: round((r.target - after[r.id]!.envelope) / (2 * Math.PI) - SKIN_MM, 1) }))
    console.log(`\nMuscle envelope against the girths of a woman of ${S} mm, BMI ${B} (girth of muscles + bones, convex hull; mm). λ = factor applied to the depth of soft tissue over bone (floor ${SLIM_MIN_LAMBDA}); chest wall and shoulder girdle take the upper arm's λ`)
    console.log(`  ${pad('region', 10)}${pad('girth target', 14)}${pad('fat+skin', 10)}${pad('envelope target', 17)}${pad('before', 8)}${pad('after', 8)}${pad('λ', 7)}room left for fat after (mm; wanted ${'fat'})`)
    for (const r of rows) console.log(`  ${pad(r.region, 10)}${pad(r.girthTargetMm, 14)}${pad((r.fatMm + r.skinMm).toFixed(1), 10)}${pad(r.envelopeTargetMm, 17)}${pad(r.envelopeBeforeMm, 8)}${pad(r.envelopeAfterMm, 8)}${pad(r.lambda, 7)}${r.roomForFatAfterMm} (${r.fatMm})`)
    console.log(`  ${moved} parts moved, largest displacement ${mm(maxMove)} mm`)
    report.envelope = { statureMm: S, bmi: B, minLambda: SLIM_MIN_LAMBDA, regions: rows, partsMoved: moved, maxDisplacementMm: round(maxMove * 1000, 1) }
    lap('muscle envelope slimmed')
  }

  // 调试用：把进入体形重塑之前的全部部件存盘（SOMA_SHAPE_SNAPSHOT=<目录>），便于单独重跑这一步；构建到此为止，不写输出
  // debugging aid: all parts as they enter the body-shape stage are dumped (SOMA_SHAPE_SNAPSHOT=<dir>), so that this step can be rerun alone; the build stops there and writes no output
  if (process.env.SOMA_SHAPE_SNAPSHOT) {
    writePartSnapshot(process.env.SOMA_SHAPE_SNAPSHOT, parts.map((p) => ({ p, kind: 'part' })))
    console.log(`  shape snapshot written to ${process.env.SOMA_SHAPE_SNAPSHOT}; stopping here`)
    return
  }

  // ── 5g. 体形：把软的深部结构收进目标体表之下的深层包络（见 shape.ts）
  // 目标包存在、且是按本次的骨架做的，才执行；否则什么都不做，构建结果与没有这一步时完全一样。
  // 不动的：骨、软骨、牙；贴着关节的韧带；Wu 的盆底各部；HRA 的器官；她自己 CT 里的内脏；眼球和脑。
  // 决定位移场的：肌、腱和形变来的器官（含淋巴结）。跟着场走的：血管、神经（连同中心线）、筋膜、游离的韧带。
  // 占位皮肤、乳腺不动：最终的皮肤要按这一步之后的内部结构另行拟合。
  // ── 5g. Body shape: the soft deep parts brought inside the deep envelope under the target body surface (see shape.ts)
  // Runs only when the target package is there and was made for this skeleton; otherwise nothing
  // happens and the build is exactly what it is without this step.
  // Not moved: bone, cartilage, teeth; ligaments lying on joints; the Wu pelvic parts; the HRA organs;
  // viscera from her own CT; the eyes and the brain. Driving the field: muscles, tendons and warped
  // organs (lymph nodes included). Carried by it: vessels, nerves (centrelines too), fasciae, ligaments
  // that span free. The placeholder skin and the breasts stay: the final skin is to be fitted to the
  // internals as they are after this step.
  if (!process.env.SOMA_NO_SHAPE) {
    const target = loadShapeTarget(join(ROOT, SHAPE_TARGET_DIR))
    if (target) {
      const key = internalsKey(parts.filter((p) => p.tissue === 'bone').map((p) => ({ name: p.name, bbox: measure(p.mesh).bbox })))
      const head = { dir: SHAPE_TARGET_DIR, basedOn: target.basedOn, internalsKeyBeforeShape: key, envelopeSha1: target.envelopeSha1 }
      if (target.basedOn?.body !== 'female' || target.basedOn.key !== key) {
        const reason = !target.basedOn ? 'the package does not say which internals it was made for (manifest.basedOn missing)' : 'made for other internals'
        console.log(`\nBody shape: target package ${SHAPE_TARGET_DIR} not used (${reason}); this build's internals key is ${key}`)
        report.bodyShape = { ...head, applied: false, reason }
      } else {
        console.log(`\nBody shape: soft deep parts into the deep envelope of ${SHAPE_TARGET_DIR} (envelope ${target.envelopeSha1})`)
        const hard = (p: FPart) => p.tissue === 'bone' || p.tissue === 'tooth' || p.tissue === 'cartilage'
        const DRIVING = new Set<string>(['muscle', 'tendon', 'organ', 'gland', 'heart', 'brain'])
        const toBone = medianDistanceToBone(parts.filter((p) => p.tissue === 'ligament' && p.system !== 'integumentary' && p.source !== SOURCE_WU.name && p.source !== SOURCE_HRA.name), parts.filter(hard))
        const freeLigaments = parts.filter((p) => (toBone.get(p.id) ?? 0) > FREE_LIGAMENT).map((p) => p.name).sort()
        const byId = new Map(parts.map((p) => [p.id, p]))
        const roleOf = (q: { id: string }): ShapeRole => {
          const p = byId.get(q.id)!
          if (hard(p)) return 'bone'
          if (p.system === 'integumentary') return 'ignored'
          if (p.source === SOURCE_WU.name || p.source === SOURCE_HRA.name) return 'fixed'
          if (p.tissue === 'ligament') return (toBone.get(p.id) ?? 0) > FREE_LIGAMENT ? 'follower' : 'fixed'
          if (p.source === SOURCE_VHF.name && p.tissue !== 'muscle' && p.tissue !== 'tendon') return 'fixed'
          if (p.system === 'nervous' && p.tissue !== 'nerve') return 'fixed'
          // 淋巴结随场走，每个结整体平移，不参与决定位移场 / lymph nodes go with the field, each translated whole, and do not drive it
          if (p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)) return 'rigid'
          return DRIVING.has(p.tissue) ? 'driver' : 'follower'
        }
        // 体积下限：由男性形变而来的肌，按部位合计不低于“性别比 × 男性原肌体积”
        // volume floor: muscles warped from the male keep, summed per region, at least "sex ratio × the male muscle's volume"
        const crestTop = Math.max(...parts.filter((p) => /hip bone/i.test(p.name) && p.tissue === 'bone').map((p) => measure(p.mesh).bbox[4]))
        const referenceVolumeMl = (q: { id: string }): number | null => {
          const p = byId.get(q.id)!
          if (!p.male || p.source === SOURCE_VHF.name || p.source === SOURCE_DENVER.name || p.source === SOURCE_WU.name) return null
          const m = male.meshes.get(p.male)
          if (!m) return null
          return (measure(p.mesh).centroid[1] > crestTop ? MUSCLE_SEX_RATIO.upperBody : MUSCLE_SEX_RATIO.lowerBody) * Math.abs(signedVolume(m)) * 1e6
        }
        const shape = reshapeIntoEnvelope(parts, roleOf, target.envelope, { referenceVolumeMl }, (l) => console.log(`  ${l}`))
        console.log(`  ${pad('region', 10)}${pad('outside before', 16)}${pad('after', 8)}${pad('p95 mm before', 15)}${pad('after', 8)}muscle volume ml before → after`)
        for (const [k, b] of Object.entries(shape.outside.before)) {
          const a = shape.outside.after[k]!
          const v = shape.volume.byRegion[k]
          console.log(`  ${pad(k, 10)}${pad(`${(b.outside * 100).toFixed(1)} %`, 16)}${pad(`${(a.outside * 100).toFixed(1)} %`, 8)}${pad(b.p95Mm, 15)}${pad(a.p95Mm, 8)}${v ? `${v.beforeMl} → ${v.afterMl} (${(v.change * 100).toFixed(1)} %)` : ''}`)
        }
        console.log(`  worst after: ${shape.worstAfter.slice(0, 8).map((w) => `${w.name} ${(w.outside * 100).toFixed(0)} % (p95 ${w.p95Mm} mm)`).join(', ')}`)
        console.log(`  muscles that lost more than 25 % of their volume (${shape.volume.flagged.length}; kept, noted in the report): ${shape.volume.flagged.slice(0, 12).map((m) => `${m.name} ${(m.change * 100).toFixed(0)} %`).join(', ')}${shape.volume.flagged.length > 12 ? ', …' : ''}`)
        console.log(`  not moved, outside the envelope: bone ${((shape.notMoved.bone.byRegion.all?.outside ?? 0) * 100).toFixed(2)} % of surface (${shape.notMoved.bone.parts.slice(0, 6).map((w) => `${w.name} ${(w.outside * 100).toFixed(0)} %, ${w.maxMm} mm`).join('; ')}); other fixed parts ${(shape.notMoved.fixed.all.outside * 100).toFixed(2)} % (${shape.notMoved.fixed.parts.slice(0, 6).map((w) => `${w.name} ${(w.outside * 100).toFixed(0)} %`).join('; ')})`)
        report.bodyShape = { ...head, applied: true, stageVersion: SHAPE_STAGE_VERSION, muscleSexRatio: MUSCLE_SEX_RATIO, freeLigaments, ...shape }
        lap('soft deep parts reshaped into the target envelope')
      }
    }
  }

  // ── 5e. 外部皮肤包：与本次内部结构匹配时装入，替换占位皮肤（见 skinPackage.ts）
  // ── 5e. External skin package: installed when it matches these internals, replacing the placeholder skin (see skinPackage.ts)
  let installedSkin: SkinPackage | null = null
  {
    // 指纹：骨的名称和包围盒；做过体形重塑时再并入它的版本、所用包络和参数——软组织变了，按旧软组织拟合的皮肤也就失效
    // fingerprint: names and bounding boxes of the bones; when the body-shape stage ran, its version, the envelope it used and its options are mixed in — the soft tissue changed, and a skin fitted to the old one is no longer valid
    const boneKey = internalsKey(parts.filter((p) => p.tissue === 'bone').map((p) => ({ name: p.name, bbox: measure(p.mesh).bbox })))
    const shaped = report.bodyShape as { applied?: boolean; envelopeSha1?: string; options?: unknown } | undefined
    const key = shaped?.applied ? createHash('sha1').update(`${boneKey}\nbody-shape v${SHAPE_STAGE_VERSION}\n${shaped.envelopeSha1}\n${JSON.stringify(shaped.options)}\n${JSON.stringify(MUSCLE_SEX_RATIO)}`).digest('hex').slice(0, 16) : boneKey
    const pkg = skinPackage
    const skin = parts.find((p) => p.name === 'Skin' && p.tissue === 'skin')
    const deepOf = () => parts.filter((p) => FAT_DEEP_TISSUES.has(p.tissue) && p.system !== 'integumentary').map((p) => ({ name: p.name, mesh: p.mesh }))
    const row: Record<string, unknown> = { dir: SKIN_PACKAGE_DIR, internalsKey: key, ...(shaped?.applied ? { internalsKeyBeforeShape: boneKey } : {}), present: !!pkg, fittedTo: pkg?.fittedTo ?? null, installed: false }
    if (pkg && skin && pkg.fittedTo?.body === 'female' && pkg.fittedTo.key === key) {
      // 占位皮肤（形变来的男性皮肤）整个换掉，胸部抬升也不再做
      // the placeholder (the warped male skin) is replaced outright, and the chest raise is not made
      skin.mesh = pkg.mesh
      skin.id = EXTERNAL_SKIN_ID
      skin.provenance = 'curated'
      skin.source = pkg.source.name
      skin.note = 'external skin package fitted to these internals'
      installedSkin = pkg
      report.skin = { method: 'external skin package', placeholderDiscarded: true, chestRaise: false }
      // 面部区域（距表情肌 ≤ FACE_REGION_RADIUS 的皮肤顶点）在简化时原样保留，见第 6 步
      // the face region (skin vertices within FACE_REGION_RADIUS of a muscle of facial expression) is left as it is by the simplifier, see step 6
      const facial = parts.filter((p) => p.tissue === 'muscle' && FACE_MUSCLE_NAME.test(p.name))
      skin.lockVertices = faceRegionOfSkin(pkg.mesh, facial.map((p) => p.mesh))
      row.faceRegion = { rule: `skin vertices within ${FACE_REGION_RADIUS * 1000} mm of the surface of a muscle of facial expression`, radiusM: FACE_REGION_RADIUS, muscles: facial.length }
      // 乳房的摆放（可选）：皮肤包里的 breast-placement.json 给出每侧 HRA 乳房部件的变换 p' = A + T + s·(p − A)；
      // nippleAndAreola.parts 所列的部件（乳晕、乳晕腺、乳头）再加一个平移 extraTranslationM
      // breast placement (optional): breast-placement.json in the skin package gives, per side, the transform p' = A + T + s·(p − A) of the HRA breast parts;
      // the parts listed under nippleAndAreola.parts (areola, areolar tubercles, nipple) then get one more translation, extraTranslationM
      const bpFile = join(ROOT, SKIN_PACKAGE_DIR, 'breast-placement.json')
      if (existsSync(bpFile)) {
        const bp = JSON.parse(readFileSync(bpFile, 'utf8')) as { sides?: Record<string, { aboutPoint?: number[]; translationM?: number[]; scale?: number; nippleAndAreola?: { parts?: string[]; extraTranslationM?: number[] } }> }
        const vec3 = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
        const tester = new InsideTester(pkg.mesh, 256)
        const surface = new SurfaceDistance(pkg.mesh)
        const placed: Record<string, unknown> = {}
        for (const side of ['L', 'R'] as const) {
          const t = bp.sides?.[side]
          const A = t?.aboutPoint
          const T = t?.translationM
          const sc = t?.scale
          if (!vec3(A) || !vec3(T) || typeof sc !== 'number' || !(sc > 0) || !Number.isFinite(sc)) continue
          const list = parts.filter((p) => p.source === SOURCE_HRA.name && p.system === 'integumentary' && p.side === side)
          for (const p of list) p.mesh = { positions: Float32Array.from(p.mesh.positions, (v, i) => A[i % 3]! + T[i % 3]! + sc * (v - A[i % 3]!)), indices: p.mesh.indices }
          // 只接受本侧的乳晕、乳晕腺、乳头；别的 id 一律不动并记入报告
          // only this side's areola, areolar tubercles and nipple are accepted; any other id is left alone and reported
          const E = t?.nippleAndAreola?.extraTranslationM
          const wanted = t?.nippleAndAreola?.parts ?? []
          const NIPPLE_AREOLA = new RegExp(`^HRA_(areola|areolar_tubercles|nipple)_${side}$`)
          const extra = vec3(E) ? list.filter((p) => wanted.includes(p.id) && NIPPLE_AREOLA.test(p.id)) : []
          if (vec3(E)) for (const p of extra) p.mesh = { positions: Float32Array.from(p.mesh.positions, (v, i) => v + E[i % 3]!), indices: p.mesh.indices }
          // 摆放后相对于皮肤的位置（有符号距离，正 = 在皮肤外）
          // where the parts end up against the skin (signed distance, positive = outside)
          const isNA = (p: FPart) => NIPPLE_AREOLA.test(p.id)
          const against = (ps: FPart[]) => signedDistanceToSkin(tester, surface, concat(ps.map((p) => concat([usedVertices(p.mesh), samplesOf(p.mesh, 0.002)]))))
          const lobes = list.filter((p) => p.id === `HRA_mammary_lobes_${side}`)
          const nipple = list.find((p) => p.id === `HRA_nipple_${side}`)
          let tip: number[] | null = null
          if (nipple) {
            const nv = usedVertices(nipple.mesh)
            for (let i = 0; i < nv.length; i += 3) if (!tip || nv[i + 2]! > tip[2]!) tip = [nv[i]!, nv[i + 1]!, nv[i + 2]!]
          }
          placed[side] = {
            parts: list.length, aboutPoint: A, translationM: T, scale: sc,
            nippleAndAreola: { parts: extra.map((p) => p.id), extraTranslationM: vec3(E) ? E : null, ignoredIds: wanted.filter((id) => !extra.some((p) => p.id === id)) },
            againstSkin: {
              mammaryLobes: against(lobes),
              allPartsButNippleAndAreola: against(list.filter((p) => !isNA(p))),
              areola: against(list.filter((p) => p.id === `HRA_areola_${side}`)),
              nipple: nipple ? against([nipple]) : null,
              nippleTip: tip ? { position: tip.map((v) => round(v, 4)), signedDistanceMm: signedDistanceToSkin(tester, surface, Float32Array.from(tip)).maxMm } : null,
            },
          }
        }
        row.breastPlacement = { file: `${SKIN_PACKAGE_DIR}/breast-placement.json`, signedDistances: 'mm from the installed skin at source resolution; positive = outside', sides: placed }
        console.log(`  breast placement from the skin package: ${JSON.stringify(placed)}`)
      }
      const fit = checkSkinFit(pkg.mesh, deepOf())
      // 面部几处结构在皮肤下的深度，以及皮肤模型的眼关节与眼球中心的偏差
      // how deep a few facial structures lie under the skin, and how far the skin model's eye joints are from the centres of the globes
      row.face = faceAgainstSkin(pkg.mesh, parts.map((p) => ({ name: p.name, mesh: p.mesh })), pkg.eyeJoints)
      row.author = pkg.author
      Object.assign(row, { installed: true, triangles: pkg.mesh.indices.length / 3, fit })
      console.log(`\nSkin package ${SKIN_PACKAGE_DIR} installed (${pkg.source.name}, ${pkg.mesh.indices.length / 3} triangles, ${fit.closed ? 'closed' : 'NOT closed'}); deep-part surface outside the skin ${(fit.outside * 100).toFixed(2)}% (${(fit.outside5mm * 100).toFixed(2)}% by more than 5 mm); worst: ${fit.worst.slice(0, 6).map((w) => `${w.name} ${(w.outside * 100).toFixed(1)}% (${w.maxMm} mm)`).join(', ') || '-'}`)
    } else {
      row.reason = !pkg ? 'no package' : !pkg.fittedTo ? 'the package does not say which internals it was fitted to (manifest.fittedTo missing)' : 'fitted to other internals'
      console.log(`\nSkin: placeholder kept (${row.reason}); a skin package for these internals must carry "fittedTo": {"body": "female", "key": "${key}"} in its manifest.json`)
      // 占位皮肤留下：补做先前推迟的胸部抬升 / the placeholder stays: the chest raise that was put off is made now
      if (raiseDeferred) raiseSkinOverBreasts()
    }
    report.skinPackage = row
  }

  // ── 5c. 皮下脂肪：在她的皮肤与深部结构之间重新推导 / subcutaneous fat, derived again between her skin and her deep parts
  {
    const skin = parts.find((p) => p.name === 'Skin' && p.tissue === 'skin')
    const maleFat = male.data.parts.filter((m) => isFatPart(m.id))
    if (skin && maleFat.length) {
      // 乳腺各部（HRA）也算深部，脂肪包在其外 / the HRA breast parts count as deep too; the fat lies around them
      const deep = parts.filter((p) => (FAT_DEEP_TISSUES.has(p.tissue) || p.tissue === 'fat') && p.tissue !== 'skin' && p !== skin)
      const byRegion = new Map<string, number[]>()
      for (const p of parts) {
        if (p.tissue !== 'bone') continue
        const r = fatRegionOfBone(p.name)
        const a = byRegion.get(r) ?? []
        for (const v of thinPoints(surfacePoints(p.mesh, 0.006), 0.006)) a.push(v)
        byRegion.set(r, a)
      }
      const fat = deriveFat(skin.mesh, deep.map((p) => p.mesh), FAT_REGIONS.filter((r) => byRegion.has(r.key)).map((r) => ({ region: r.key, bonePoints: Float32Array.from(byRegion.get(r.key)!) })), FAT_OPTIONS)
      const rows: Record<string, unknown>[] = []
      for (const r of fat.regions) {
        const m = maleFat.find((x) => x.id === `SOMA_fat_${r.region}`)
        if (!m || r.mesh.indices.length < 300) continue
        parts.push({ id: `W_${m.id}`, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, provenance: 'curated', source: m.source ?? 'soma (derived)', male: m.id, mesh: r.mesh, note: 'derived from her own skin and deep parts, not warped from the male' })
        rows.push({ id: `W_${m.id}`, name: m.name, volumeMl: round(r.volume * 1e6, 0), thicknessMm: { p10: round(r.thickness.p10 * 1000, 0), median: round(r.thickness.median * 1000, 0), p90: round(r.thickness.p90 * 1000, 0), max: round(r.thickness.max * 1000, 0) }, skinCovered: round(r.skinCovered, 3) })
      }
      console.log(`\nSubcutaneous fat (derived on her body; skin taken as ${fat.skinSingleWalled ? 'single-walled' : 'double-walled'}): volume inside the skin ${(fat.bodyVolume * 1000).toFixed(1)} l, fat ${(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000).toFixed(1)} l`)
      for (const r of rows) {
        const t = r.thicknessMm as Record<string, number>
        console.log(`  ${pad(r.name as string, 44)}${pad(`${r.volumeMl} ml`, 10)}thickness p10 ${t.p10} / median ${t.median} / p90 ${t.p90} / max ${t.max} mm; fat under ${((r.skinCovered as number) * 100).toFixed(0)}% of the region's skin`)
      }
      report.fat = { options: FAT_OPTIONS, skinSingleWalled: fat.skinSingleWalled, bodyVolumeL: round(fat.bodyVolume * 1000, 1), fatVolumeL: round(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000, 1), regions: rows }
      lap('subcutaneous fat')
    }
  }

  // ── 6. 最终几何 / 6. Final geometry ───────────────────────────────────────────────────────────────────────
  const final: { p: FPart; mesh: Mesh; stats: MeshStats }[] = []
  let trianglesIn = 0
  for (const p of parts) {
    let mesh = p.mesh
    trianglesIn += mesh.indices.length / 3
    if (p.lockVertices) {
      // 装入的皮肤：面部区域保持原始分辨率，其余按与其他部件相同的规则简化（不焊接：包里的网格已是封闭流形，
      // 焊接会打乱掩码所依的顶点次序）；同时记下整张简化时面部会剩下多少
      // the installed skin: the face region keeps its source resolution and the rest is simplified by the rule every other part gets
      // (no welding: the package mesh is already a closed manifold, and welding would upset the vertex order the mask relies on);
      // what a simplification of the whole would leave in the face is recorded too
      const st = measure(mesh)
      const thickness = st.area > 0 ? (3 * Math.abs(st.signedVolume)) / st.area : 0
      const err = Math.min(SIMPLIFY.max, Math.max(SIMPLIFY.min, SIMPLIFY.perThickness * thickness))
      const facial = parts.filter((q) => q.tissue === 'muscle' && FACE_MUSCLE_NAME.test(q.name)).map((q) => q.mesh)
      const plain = await simplifyMesh(mesh, err, Math.max(SIMPLIFY.minTriangles, st.area / (0.433 * SIMPLIFY.maxEdge ** 2)))
      const whole: Mesh = { positions: plain.positions, indices: plain.indices }
      const kf = await simplifySkinKeepingFace(mesh, p.lockVertices, err, SIMPLIFY.maxEdge, SIMPLIFY.minTriangles)
      const row = report.skinPackage as Record<string, unknown>
      row.resolution = { source: skinResolution(mesh, p.lockVertices), simplifiedWhole: skinResolution(whole, faceRegionOfSkin(whole, facial)), shipped: skinResolution(kf.mesh, kf.inFace), shippedTopology: edgeTopology(kf.mesh) }
      row.fitShipped = checkSkinFit(kf.mesh, parts.filter((q) => FAT_DEEP_TISSUES.has(q.tissue) && q.system !== 'integumentary').map((q) => ({ name: q.name, mesh: q.mesh })))
      // 不在拟合之列的薄结构和旧体表部件露出多少（见 skinPackage.ts） / how far the thin structures and old surface parts that the fit did not cover come through (see skinPackage.ts)
      row.notFitted = notFittedAgainstSkin(
        kf.mesh,
        parts.filter((q) => !FAT_DEEP_TISSUES.has(q.tissue) && q.system !== 'integumentary').map((q) => ({ name: q.name, mesh: q.mesh })),
        parts.filter((q) => q.system === 'integumentary' && q !== p && !isFatPart(q.id) && q.source !== SOURCE_HRA.name).map((q) => ({ name: q.name, mesh: q.mesh })),
      )
      const rs = row.resolution as { simplifiedWhole: { face: { vertices: number; meanEdgeMm: number } }; shipped: { vertices: number; triangles: number; face: { vertices: number; meanEdgeMm: number } }; shippedTopology: { boundaryEdges: number; nonManifoldEdges: number } }
      console.log(`\nSkin: face region kept at source resolution — ${rs.shipped.face.vertices} vertices, mean edge ${rs.shipped.face.meanEdgeMm} mm (simplified as a whole it would keep ${rs.simplifiedWhole.face.vertices} vertices, mean edge ${rs.simplifiedWhole.face.meanEdgeMm} mm); shipped skin ${rs.shipped.vertices} vertices, ${rs.shipped.triangles} triangles, boundary edges ${rs.shippedTopology.boundaryEdges}, non-manifold edges ${rs.shippedTopology.nonManifoldEdges}; deep-part surface outside the shipped skin ${((row.fitShipped as { outside: number }).outside * 100).toFixed(2)}%`)
      mesh = kf.mesh
    } else if (!p.keepGeometry) {
      const w = weld(mesh.positions, mesh.indices)
      mesh = { positions: w.positions, indices: w.indices }
      const st = measure(mesh)
      const thickness = st.area > 0 ? (3 * Math.abs(st.signedVolume)) / st.area : 0
      const err = Math.min(SIMPLIFY.max, Math.max(SIMPLIFY.min, SIMPLIFY.perThickness * thickness))
      const simp = await simplifyMesh(mesh, err, Math.max(SIMPLIFY.minTriangles, st.area / (0.433 * SIMPLIFY.maxEdge ** 2)))
      mesh = { positions: simp.positions, indices: simp.indices }
    }
    final.push({ p, mesh, stats: measure(mesh) })
  }
  const trianglesOut = final.reduce((s, f) => s + f.mesh.indices.length / 3, 0)
  lap(`final geometry: ${trianglesIn} → ${trianglesOut} triangles`)

  // 邻接 / adjacency
  const adj = computeAdjacency(final.map((f) => f.mesh), { threshold: ADJACENCY.threshold, spacing: ADJACENCY.spacing })
  // 皮肤按角色算作包络，不按邻居数：贴合得好的单层皮肤邻居数可能低于阈值，那样会留下左右不对称的邻接
  // the skin is an envelope by role, not by neighbour count: a well-fitted single-walled skin can fall under the threshold and would leave asymmetric adjacency
  const envelopes = new Set(adj.neighbours.map((l, i) => (l.length > ADJACENCY.maxDegree || isFatPart(final[i]!.p.id) || (final[i]!.p.tissue === 'skin' && final[i]!.p.name === 'Skin') ? i : -1)).filter((i) => i >= 0))
  const neighbours = adj.neighbours.map((l, i) => (envelopes.has(i) ? [] : l.filter((j) => !envelopes.has(j))))
  {
    const deg = neighbours.map((l) => l.length).filter((_, i) => !envelopes.has(i))
    console.log(`\nAdjacency: ${neighbours.reduce((s, l) => s + l.length, 0) / 2} pairs; degree median ${quantile(deg, 0.5)}, p90 ${quantile(deg, 0.9)}, p99 ${quantile(deg, 0.99)}, max ${Math.max(...deg)}; envelopes excluded: ${[...envelopes].map((i) => `${final[i]!.p.name} (${adj.neighbours[i]!.length})`).join(', ') || 'none'}`)
    report.adjacency = { pairs: neighbours.reduce((s, l) => s + l.length, 0) / 2, degree: { median: quantile(deg, 0.5), p90: quantile(deg, 0.9), p99: quantile(deg, 0.99), max: Math.max(...deg) }, envelopes: [...envelopes].map((i) => final[i]!.p.name) }
  }
  lap('adjacency')

  const outParts: Part[] = final.map((f, i) => ({
    id: f.p.id,
    fma: f.p.fma,
    name: f.p.name,
    system: f.p.system,
    tissue: f.p.tissue,
    depth: f.p.depth,
    side: f.p.side,
    // 标准化之后，她的真实部件已不是供体的原样：标为 warped，来源不变
    // after the standardisation her real parts are no longer as the donor's: labelled warped, source unchanged
    provenance: standard && f.p.provenance === 'scanned' ? 'warped' : f.p.provenance,
    source: f.p.source,
    bbox: f.stats.bbox.map((v) => round(v)) as Part['bbox'],
    centroid: f.stats.centroid.map((v) => round(v)) as Part['centroid'],
    ...(f.p.volume ? { volume: f.p.volume } : {}),
    triangles: f.mesh.indices.length / 3,
    adjacent: neighbours[i]!.map((j) => final[j]!.p.id),
  }))

  // ── 7. 树：男性的树，部件 id 已转换，剪掉男性特有的概念，加入女性的概念 /
  // ── 7. Trees: the male trees with part ids translated, male-only concepts pruned, female ones added
  const toFemale = new Map<string, string>()
  for (const p of parts) if (p.male) toFemale.set(p.male, p.id)
  const fallbackIsa = (name: string) => male.data.trees.isa.find((c) => c.name === name)?.id ?? null
  const rebuild = (tree: Concept[], extras: { part: string; path: [string, string][]; anchor: string | null }[]): Concept[] => {
    const nodes = new Map<string, Concept>(tree.map((c) => [c.id, { ...c, parts: c.parts.map((id) => toFemale.get(id)).filter((id): id is string => !!id) }]))
    const order = tree.map((c) => c.id)
    for (const e of extras) {
      if (!e.anchor || !nodes.has(e.anchor)) continue
      const chain = [...e.path.map(([id]) => id), e.anchor]
      // 先创建父节点再创建子节点，使列表保持父在前
      // create parents before children so the list stays parent-first
      for (let k = e.path.length - 1; k >= 0; k--) {
        const [id, label] = e.path[k]!
        if (nodes.has(id)) continue
        nodes.set(id, { id, name: label, parent: chain[k + 1]!, parts: [] })
        order.push(id)
      }
      nodes.get(chain[0]!)!.parts.push(e.part)
    }
    // 剪掉其下没有任何内容的概念
    // prune concepts with nothing beneath them
    const children = new Map<string, string[]>()
    for (const id of order) {
      const c = nodes.get(id)!
      if (c.parent) children.set(c.parent, [...(children.get(c.parent) ?? []), id])
    }
    const alive = new Map<string, boolean>()
    const isAlive = (id: string): boolean => {
      if (alive.has(id)) return alive.get(id)!
      const v = nodes.get(id)!.parts.length > 0 || (children.get(id) ?? []).some(isAlive)
      alive.set(id, v)
      return v
    }
    // 父在前的顺序：原有节点本来就是；新节点按每条链以父在前的方式追加，但某个新节点的
    // 父节点可能是之后才追加的另一个新节点 → 做一遍稳定的拓扑排序
    // parent-first order: originals already are; new nodes were appended parent-first per chain,
    // but a new node's parent may be another new node appended later → stable topological pass
    const out: Concept[] = []
    const emitted = new Set<string>()
    const emit = (id: string) => {
      if (emitted.has(id) || !isAlive(id)) return
      const c = nodes.get(id)!
      if (c.parent) emit(c.parent)
      emitted.add(id)
      out.push(c)
    }
    for (const id of order) emit(id)
    return out
  }
  const isaExtras: { part: string; path: [string, string][]; anchor: string | null }[] = []
  const partOfExtras: { part: string; path: [string, string][]; anchor: string | null }[] = []
  const inIsa = new Set(male.data.trees.isa.map((c) => c.id))
  const placement: Record<string, number> = {}
  const partOfByName = (n: string) => male.data.trees.partOf.find((c) => c.name === n)?.id ?? null
  const inMalePartOf = new Set(male.data.trees.partOf.flatMap((c) => c.parts))
  for (const p of parts) {
    // 沿用男性部件身份的 Wu 部件在 is-a 树里随它走；若该男性部件不在 part-of 树里，仍按目录的分组挂上
    // a Wu part with a male part's identity follows it in the is-a tree; when that male part is not in the part-of tree it is still attached by its catalogue group
    if (p.male && !(p.wu && !inMalePartOf.has(p.male))) continue
    if (p.id === 'VF_vertebrae_L1') {
      const own: [string, string][] = [[p.fma, 'supernumerary lumbar vertebra (first of six)']]
      isaExtras.push({ part: p.id, path: own, anchor: input.lumbarConcept })
      partOfExtras.push({ part: p.id, path: own, anchor: partOfByName('vertebral column') ?? partOfByName('skeletal system') })
      continue
    }
    // HRA 器官和 Wu 盆底结构 / HRA organs and Wu pelvic-floor structures
    const fallback = (p.tissue === 'cartilage' ? fallbackIsa('articular cartilage') : p.tissue === 'ligament' ? fallbackIsa('ligament') : null) ?? fallbackIsa(p.tissue === 'artery' ? 'artery' : p.tissue === 'vein' ? 'vein' : 'anatomical structure')
    let tp
    const lower = p.name[0]!.toLowerCase() + p.name.slice(1)
    const sidedOf = /^(.*)_[LR]$/.exec(p.fma)
    const base = sidedOf ? sidedOf[1]! : p.fma
    if (p.wu) {
      // 分侧部件：自己的（分侧）概念挂在不分侧的概念之下；不分侧的概念是 FMA 类时沿 FMA is-a 链上溯，
      // 是合成概念时挂在目录给出的 FMA 父类之下（没有则挂在兜底节点下）
      // a sided part: its own (sided) concept under the unsided one; the unsided concept follows the FMA
      // is-a chain when it is an FMA class, and hangs under the FMA parent named in the catalogue when it
      // is synthetic (under the fallback when none is given)
      const spec = p.wu
      const chainOf = (id: string, label: string) => isaPathFromFma(id, fmaNames?.label.get(id) ?? label, (x) => fmaNames?.parents.get(x), (x) => fmaNames?.label.get(x), (x) => inIsa.has(x), fallback)
      const up = /^FMA\d+$/.test(spec.concept) ? chainOf(spec.concept, spec.name) : spec.isaParent ? chainOf(spec.isaParent, spec.isaParent) : { path: [] as [string, string][], anchor: fallback, how: 'by hand' as const }
      const unsided: [string, string][] = /^FMA\d+$/.test(spec.concept) ? [] : [[spec.concept, spec.name[0]!.toLowerCase() + spec.name.slice(1)]]
      const own: [string, string][] = p.side === 'M' ? [] : [[p.fma, lower]]
      const path = [...own, ...unsided, ...up.path]
      const how = /^FMA\d+$/.test(spec.concept) ? up.how : 'by hand'
      if (!p.male) {
        placement[`Wu: ${how}`] = (placement[`Wu: ${how}`] ?? 0) + 1
        isaExtras.push({ part: p.id, path, anchor: up.anchor })
      }
      const perineum = male.data.trees.partOf.find((c) => c.name === 'perineum')
      const holderOf = (maleId: string) => male.data.trees.partOf.find((c) => c.parts.includes(maleId))?.id ?? null
      const me: [string, string] = [p.fma, lower]
      const po: { path: [string, string][]; anchor: string | null } =
        spec.group === 'pelvicDiaphragm' ? { path: [me, ['FMA19726', 'pelvic diaphragm']], anchor: perineum?.parent ?? partOfByName('muscular system') }
        : spec.group === 'analPerineum' ? { path: [me, ['FMA20347', 'anal part of perineum']], anchor: perineum?.id ?? null }
        : spec.group === 'urogenitalPerineum' ? { path: [me, ['FMA20348', 'urogenital part of perineum']], anchor: perineum?.id ?? null }
        : spec.group === 'urethra' ? { path: [me, ['FMA19669', 'female urethra']], anchor: partOfByName('urinary system') }
        : spec.group === 'rectum' ? { path: [me], anchor: holderOf('FJ2571') ?? partOfByName('large intestine') }
        : { path: [me], anchor: partOfByName('genital system') }
      partOfExtras.push({ part: p.id, ...po })
      continue
    }
    if (/^FMA\d+$/.test(base) && fmaNames) tp = isaPathFromFma(base, fmaNames.label.get(base) ?? p.name, (id) => fmaNames.parents.get(id), (id) => fmaNames.label.get(id), (id) => inIsa.has(id), fallback)
    else tp = { path: [[base, lower.replace(/^(left|right) /, '')]] as [string, string][], anchor: fallback, how: 'by hand' as const }
    if (sidedOf) tp = { ...tp, path: [[p.fma, lower], ...tp.path] as [string, string][], anchor: tp.path.length ? tp.anchor : base }
    placement[tp.how] = (placement[tp.how] ?? 0) + 1
    isaExtras.push({ part: p.id, path: tp.path, anchor: tp.anchor })
    // part-of：手工指定，挂在部件所属的系统之下
    // part-of: by hand, under the system the part belongs to
    const sys = p.system === 'reproductive' ? partOfByName('genital system') : p.system === 'integumentary' ? (partOfByName('integument') ?? partOfByName('integumentary system')) : p.system === 'skeletal' ? (partOfByName('skeletal system') ?? partOfByName('musculoskeletal system')) : p.system === 'muscular' ? (partOfByName('muscular system') ?? partOfByName('musculoskeletal system')) : partOfByName('cardiovascular system')
    partOfExtras.push({ part: p.id, path: [[p.fma, lower]], anchor: sys })
  }
  // 男性特有的 "genital system" 分支会在女性部件挂上之前被剪掉：保留该节点
  // the male-only "genital system" branch would be pruned before the female parts are attached: keep the node
  const isaTree = rebuild(male.data.trees.isa, isaExtras)
  const partOfTree = rebuild(male.data.trees.partOf, partOfExtras)
  const reach = (t: Concept[]) => new Set(t.flatMap((c) => c.parts))
  console.log(`\nTrees: isa ${isaTree.length} concepts covering ${reach(isaTree).size}/${parts.length} parts; partOf ${partOfTree.length} concepts covering ${reach(partOfTree).size} parts; HRA isa placement: ${JSON.stringify(placement)} (partOf: by hand under genital system / integument / cardiovascular system)`)
  report.trees = { isa: { concepts: isaTree.length, parts: reach(isaTree).size }, partOf: { concepts: partOfTree.length, parts: reach(partOfTree).size }, hraIsaPlacement: placement }

  // ── 8. 检查 / 8. Checks ───────────────────────────────────────────────────────────────────────────────
  const meshByName = new Map<string, Mesh>()
  const nerveByName = new Map<string, Polyline[]>()
  for (const f of final) {
    if (!meshByName.has(f.p.name)) meshByName.set(f.p.name, f.p.mesh)
    if (f.p.centrelines && !nerveByName.has(f.p.name)) nerveByName.set(f.p.name, f.p.centrelines)
  }
  const landmarks = runLandmarkChecks({ mesh: (n) => meshByName.get(n) ?? null, nerve: (n) => nerveByName.get(n) ?? null })
  console.log('\nNerve landmark checks (same definitions as the male)')
  for (const r of landmarks) console.log(`  ${r.evaluated ? (r.pass ? 'PASS' : 'FAIL') : 'n/a '} ${r.side} ${pad(r.id, 20)}${r.measured.slice(0, 230)}`)
  console.log(`  ${landmarks.filter((r) => r.pass).length} pass, ${landmarks.filter((r) => r.evaluated && !r.pass).length} fail, ${landmarks.filter((r) => !r.evaluated).length} not evaluated`)
  report.landmarks = landmarks

  // 肌的附着：长肌的两端是否仍在正确的骨上？
  // muscle attachments: both ends of long muscles still on the right bones?
  const maleMeshByName = new Map<string, Mesh>()
  for (const p of male.data.parts) if (!maleMeshByName.has(p.name)) maleMeshByName.set(p.name, male.meshes.get(p.id)!)
  const endDistance = (muscle: Mesh, bone: Mesh, end: 'top' | 'bottom'): number => {
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 1; i < muscle.positions.length; i += 3) {
      y0 = Math.min(y0, muscle.positions[i]!)
      y1 = Math.max(y1, muscle.positions[i]!)
    }
    const cut = end === 'top' ? y1 - 0.04 * (y1 - y0) : y0 + 0.04 * (y1 - y0)
    const idx = new PointIndex(samplesOf(bone, 0.002), 0.01)
    const d: number[] = []
    for (let i = 0; i < muscle.positions.length; i += 3) {
      const y = muscle.positions[i + 1]!
      if (end === 'top' ? y < cut : y > cut) continue
      d.push(idx.distance(muscle.positions[i]!, y, muscle.positions[i + 2]!))
    }
    return quantile(d, 0.5)
  }
  const ATTACH: [string, 'top' | 'bottom', string][] = [
    ['Long head of {s} biceps femoris', 'top', '{S} hip bone'], ['Long head of {s} biceps femoris', 'bottom', '{S} fibula'],
    ['{S} rectus femoris', 'top', '{S} hip bone'], ['{S} rectus femoris', 'bottom', '{S} patella'],
    ['Acromial part of {s} deltoid', 'top', '{S} scapula'], ['Acromial part of {s} deltoid', 'bottom', '{S} humerus'],
    ['Medial head of {s} gastrocnemius', 'top', '{S} femur'], ['{S} calcaneal tendon', 'bottom', '{S} calcaneus'],
    ['{S} sartorius', 'top', '{S} hip bone'], ['{S} sartorius', 'bottom', '{S} tibia'],
    ['{S} semimembranosus', 'top', '{S} hip bone'], ['{S} semimembranosus', 'bottom', '{S} tibia'],
    ['Long head of {s} triceps brachii', 'top', '{S} scapula'], ['{S} brachioradialis', 'bottom', '{S} radius'],
  ]
  const attachments: { muscle: string; end: string; bone: string; maleMm: number; femaleMm: number; ok: boolean }[] = []
  for (const side of ['Left', 'Right']) {
    for (const [mT, end, bT] of ATTACH) {
      const mn = mT.replace('{S}', side).replace('{s}', side.toLowerCase())
      const bn = bT.replace('{S}', side).replace('{s}', side.toLowerCase())
      const fm = meshByName.get(mn)
      const fb = meshByName.get(bn)
      const mm0 = maleMeshByName.get(mn)
      const mb = maleMeshByName.get(bn)
      if (!fm || !fb || !mm0 || !mb) continue
      const a = endDistance(mm0, mb, end)
      const b = endDistance(fm, fb, end)
      attachments.push({ muscle: mn, end, bone: bn, maleMm: round(a * 1000, 1), femaleMm: round(b * 1000, 1), ok: b <= a + 0.005 })
    }
  }
  console.log(`\nMuscle attachments (median distance of the muscle's end to the bone, male → female, mm): ${attachments.filter((a) => a.ok).length}/${attachments.length} within 5 mm of the male value`)
  for (const a of attachments) console.log(`  ${a.ok ? 'ok  ' : 'OFF '}${pad(a.muscle, 40)}${pad(a.end, 7)}${pad(a.bone, 20)}${pad(a.maleMm, 7)}→ ${a.femaleMm}`)
  report.attachments = attachments
  // Denver 的肌和韧带：两端到所附着的骨的最近距离，现在的值对比扫描时的值（按该处骨架的缩放折算不了，
  // 只报告差值）。肌腹模型本来就够不到骨的（腘绳肌、股直肌等）单独列出。
  // Denver muscles and ligaments: closest approach of each end to the bone it attaches to, now
  // against the scan. Belly-only models that never reach their bones (hamstrings, rectus femoris, …)
  // are listed separately.
  {
    const rows = ((report.denver ?? []) as { id: string; name: string; kind: string; ends?: Record<string, { bones: string[]; scannedGapMm: number; posedGapMm: number; finalGapMm?: number }> }[]).filter((r) => r.ends)
    let checked = 0
    let moved = 0
    const short: string[] = []
    for (const r of rows) {
      const part = parts.find((p) => p.id === r.id)
      if (!part) continue
      for (const [end, e] of Object.entries(r.ends!)) {
        const bones = e.bones.map((id) => parts.find((p) => p.id === id)).filter((p): p is FPart => !!p)
        if (!bones.length) continue
        const ix = new PointIndex(concat(bones.map((b) => thinPoints(surfacePoints(b.mesh, 0.002), 0.0015))), 0.006)
        let d = Infinity
        for (let i = 0; i < part.mesh.positions.length; i += 3) d = Math.min(d, ix.distance(part.mesh.positions[i]!, part.mesh.positions[i + 1]!, part.mesh.positions[i + 2]!, d))
        e.finalGapMm = round(d * 1000, 1)
        checked++
        if (Math.abs(e.finalGapMm - e.scannedGapMm) > 3) moved++
        if (r.kind === 'muscle' && e.finalGapMm > 10) short.push(`${r.name} ${end} ${e.finalGapMm}`)
      }
    }
    console.log(`\nDenver muscle and ligament ends against their bones: ${checked} ends, ${moved} whose gap changed by more than 3 mm from the scan; ${short.length} muscle ends are still more than 10 mm short of their bone after the tendons were attached: ${short.join(', ')}`)
    report.denverEnds = { checked, changedMoreThan3mm: moved, stillShort: short }
  }

  // 性别特有结构的放置
  // sex-specific placement
  const cz = (n: string) => measure(byName(n)!.mesh).centroid
  const sexChecks: Record<string, unknown> = {}
  {
    const uterus = byName('Uterus') ?? byName('Body of uterus') ?? parts.find((p) => /uterus/i.test(p.name) && p.provenance === 'curated')!
    const u = measure(uterus.mesh).centroid
    const bladder = cz('Urinary bladder')
    const rectum = cz('Rectum')
    sexChecks.uterusBetweenBladderAndRectum = { pass: bladder[2] > u[2] && u[2] > rectum[2], zMm: { bladder: round(bladder[2] * 1000, 1), uterus: round(u[2] * 1000, 1), rectum: round(rectum[2] * 1000, 1) }, bladderIs: byName('Urinary bladder')!.provenance, rectumIs: byName('Rectum')!.provenance }
    const hips = ['Left hip bone', 'Right hip bone'].map((n) => measure(byName(n)!.mesh).bbox)
    const sac = measure(byName('Sacrum')!.mesh).bbox
    for (const side of ['left', 'right']) {
      const o = measure((byName(`${side === 'left' ? 'Left' : 'Right'} ovary`) ?? parts.find((p) => p.id === `HRA_${side}_ovary`)!).mesh).centroid
      const insideBox = o[0] > Math.min(hips[0]![0], hips[1]![0]) && o[0] < Math.max(hips[0]![3], hips[1]![3]) && o[1] > Math.min(hips[0]![1], hips[1]![1]) && o[1] < Math.max(hips[0]![4], hips[1]![4]) && o[2] > sac[2] && o[2] < Math.max(hips[0]![5], hips[1]![5])
      sexChecks[`${side}OvaryInPelvis`] = { pass: insideBox && (side === 'left' ? o[0] > 0.01 : o[0] < -0.01) && Math.abs(o[0]) < 0.09, centroidMm: o.map((v) => round(v * 1000, 1)) }
    }
    for (const [side, S] of [['L', 'left'], ['R', 'right']] as const) {
      const breast = parts.find((p) => p.id === `HRA_mammary_lobes_${side}`)!
      const pec = byName(`Sternocostal part of ${S} pectoralis major`)!
      const b = measure(breast.mesh)
      const pm = measure(pec.mesh)
      const skin = parts.find((p) => p.tissue === 'skin' && p.name === 'Skin')
      const outside = skin ? inFrontOfSkin(skin.mesh, samplesOf(breast.mesh, 0.004)) : NaN
      sexChecks[`${S}BreastAnteriorToPectoralis`] = { pass: b.centroid[2] > pm.centroid[2] && b.bbox[5] > pm.bbox[5], breastCentroidZMm: round(b.centroid[2] * 1000, 1), pectoralisCentroidZMm: round(pm.centroid[2] * 1000, 1), pectoralisFrontZMm: round(pm.bbox[5] * 1000, 1), fractionInFrontOfSkin: round(outside, 3) }
      // 高度：乳腺应盖在胸大肌上（腺体中心落在胸肋部的上下缘之间），乳头不低于剑突下端太多。
      // 按皮肤包摆放后的乳腺通不过这一项（皮肤模型的乳房位置偏低）：如实记为不通过，并写进说明。
      // Level: the gland should lie over pectoralis major (its centre between the upper and lower border of the
      // sternocostal part), the nipple not far below the lower end of the xiphoid process. The gland as placed
      // by the skin package fails this (the skin model's breasts sit low): recorded as a failure and stated in the cautions.
      const xiphoid = byName('Xiphoid process')
      const nipple = parts.find((p) => p.id === `HRA_nipple_${side}`)
      const xLow = xiphoid ? measure(xiphoid.mesh).bbox[1] : NaN
      const nY = nipple ? measure(nipple.mesh).centroid[1] : NaN
      sexChecks[`${S}BreastLevel`] = {
        pass: b.centroid[1] > pm.bbox[1] && b.centroid[1] < pm.bbox[4],
        glandYMm: [round(b.bbox[1] * 1000, 1), round(b.bbox[4] * 1000, 1)], glandCentroidYMm: round(b.centroid[1] * 1000, 1),
        pectoralisSternocostalYMm: [round(pm.bbox[1] * 1000, 1), round(pm.bbox[4] * 1000, 1)], pectoralisCentroidYMm: round(pm.centroid[1] * 1000, 1),
        glandCentroidBelowPectoralisCentroidMm: round((pm.centroid[1] - b.centroid[1]) * 1000, 1),
        glandCentroidBelowPectoralisLowerBorderMm: round((pm.bbox[1] - b.centroid[1]) * 1000, 1),
        glandTopBelowPectoralisLowerBorderMm: round((pm.bbox[1] - b.bbox[4]) * 1000, 1),
        nippleBelowXiphoidLowerEndMm: round((xLow - nY) * 1000, 1),
      }
    }
    const maleOnly = parts.filter((p) => p.provenance === 'warped' && (p.system === 'reproductive' || MALE_ONLY_NAME.test(p.name)))
    sexChecks.noMaleOnlyParts = { pass: maleOnly.length === 0, found: maleOnly.map((p) => p.name) }
    const twin = (n: string) => n.replace(/\b(left|right)\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? (m.toLowerCase() === 'left' ? 'Right' : 'Left') : m === 'left' ? 'right' : 'left'))
    const names = new Set(parts.map((p) => p.name))
    const lonely = parts.filter((p) => /\b(left|right)\b/i.test(p.name) && twin(p.name) !== p.name && !names.has(twin(p.name))).map((p) => p.name)
    const maleNames = new Set(male.data.parts.map((p) => p.name))
    const newLonely = lonely.filter((n) => !maleNames.has(n) || maleNames.has(twin(n)))
    sexChecks.leftRightPresence = { pass: newLonely.length === 0, unpairedOnlyInFemale: newLonely, unpairedAlsoInMale: lonely.length - newLonely.length }
    console.log('\nSex-specific checks')
    for (const [k, v] of Object.entries(sexChecks)) console.log(`  ${(v as { pass: boolean }).pass ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(v).slice(0, 260)}`)
    report.sexChecks = sexChecks
  }
  // 盆腔检查：对最终（简化后）的几何，与测试对输出 GLB 所做的是同一套（见 pelvis.ts）
  // pelvic checks: on the final (simplified) geometry, the same set the tests run on the written GLBs (see pelvis.ts)
  {
    const byKey = new Map<string, Mesh>()
    for (const f of final) {
      byKey.set(f.p.id, f.mesh)
      if (!byKey.has(f.p.name)) byKey.set(f.p.name, f.mesh)
    }
    const get = (k: string) => byKey.get(k) ?? null
    const ids = final.map((f) => f.p.id)
    const pc = pelvisChecks(get, ids)
    console.log('\nPelvic checks (final geometry)')
    for (const c of pc.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${JSON.stringify(c.measured).slice(0, 420)}`)
    console.log(`  minimum gaps (mm): ${Object.entries(pc.gapsMm).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    report.pelvisChecks = { checks: pc.checks, gapsMm: pc.gapsMm, pairs: pc.pairs }
    const skin = final.find((f) => f.p.tissue === 'skin' && f.p.name === 'Skin')
    const sk = perineumAgainstSkin(get, ids, skin?.mesh ?? null, input.wuExtras.get('skin') ?? null)
    report.perineumAgainstSkin = { skin: skin ? (skin.p.id === EXTERNAL_SKIN_ID ? 'external skin package' : 'placeholder (warped male skin)') : null, ...sk }
    const st = (sk.structures ?? {}) as Record<string, { closestToPresentSkinMm: number | null; lowestPointBelowOutletPlaneMm: number }>
    console.log(`  perineal structures against the present skin (${(report.perineumAgainstSkin as { skin: string }).skin}): ${Object.keys(st).length} structures, ${sk.structuresWithNoSkinBelow} with no skin below their lowest point; lowest reach below the outlet plane ${Math.max(...Object.values(st).map((x) => x.lowestPointBelowOutletPlaneMm))} mm; specimen outline vs present skin ${JSON.stringify(sk.specimenPerinealOutline)}`)
  }

  // 形变后的部件与她的骨的关系
  // warped parts against her bones
  {
    const before = insideBone.filter((x) => x.before > 0)
    const worst = [...insideBone].sort((a, b) => b.after - a.after).slice(0, 10)
    const st = { warpedSoftParts: insideBone.length, touchingBoneBefore: before.length, meanInsideBefore: round(insideBone.reduce((s, x) => s + x.before, 0) / Math.max(1, insideBone.length), 4), meanInsideAfter: round(insideBone.reduce((s, x) => s + x.after, 0) / Math.max(1, insideBone.length), 4), over10pctBefore: insideBone.filter((x) => x.before > 0.1).length, over10pctAfter: insideBone.filter((x) => x.after > 0.1).length, partsWithVerticesMoved: pushedParts }
    console.log(`\nWarped soft parts against her real bones (share of surface inside bone or cartilage): mean ${(st.meanInsideBefore * 100).toFixed(2)}% → ${(st.meanInsideAfter * 100).toFixed(2)}% after the slide-out; parts above 10%: ${st.over10pctBefore} → ${st.over10pctAfter}; worst after: ${worst.map((x) => `${x.name} ${(x.after * 100).toFixed(0)}%`).join(', ')}`)
    const n = nerveStats
    console.log(`  nerves (${(n.length).toFixed(1)} m): in bone ${((n.boneBefore / n.length) * 100).toFixed(2)}% → ${((n.boneAfter / n.length) * 100).toFixed(2)}% (canals ${((n.canal / n.length) * 100).toFixed(2)}%); > 3 mm deep in her real muscles ${((n.muscleBefore / n.length) * 100).toFixed(2)}% → ${((n.muscleAfter / n.length) * 100).toFixed(2)}%; ${((n.moved / Math.max(1, n.points)) * 100).toFixed(1)}% of centreline points moved`)
    report.interpenetration = { ...st, worstAfter: worst.map((x) => ({ name: x.name, inside: round(x.after, 3) })), nerves: { lengthM: round(n.length, 2), inBoneBefore: round(n.boneBefore / n.length, 5), inBoneAfter: round(n.boneAfter / n.length, 5), inCanal: round(n.canal / n.length, 5), deepInRealMuscleBefore: round(n.muscleBefore / n.length, 5), deepInRealMuscleAfter: round(n.muscleAfter / n.length, 5), pointsMoved: round(n.moved / Math.max(1, n.points), 4) } }
  }

  // 她的骨就是她的骨：只做刚性移动（做了标准化时，这项检查已在标准化之前完成）
  // her bones are her bones: rigidly moved (with the standardisation, this check ran before it)
  if (!standard) {
    let worst = 0
    let count = 0
    for (const p of parts) {
      if (p.provenance !== 'scanned' || p.tissue !== 'bone') continue
      const it = fa.byId.get(p.id)
      if (!it) continue
      const src = fa.scanned(it).positions
      const fit = fitRigid(src, p.mesh.positions)
      const back = applyRigid(fit, src)
      for (let i = 0; i < back.length; i += 3) worst = Math.max(worst, Math.hypot(back[i]! - p.mesh.positions[i]!, back[i + 1]! - p.mesh.positions[i + 1]!, back[i + 2]! - p.mesh.positions[i + 2]!))
      count++
    }
    console.log(`\nHer scanned bones: ${count} parts, largest deviation from a rigid motion of the scan ${(worst * 1e6).toFixed(1)} µm (shapes and lengths unchanged)`)
    report.scannedBones = { parts: count, maxNonRigidDeviationM: worst }
  }

  // ── 9. 说明与输出 / 9. Notes and output ─────────────────────────────────────────────────────────────────────
  const count = (f: (p: FPart) => boolean) => parts.filter(f).length
  const maleNamesDropped = dropped.map((p) => p.name)
  // 盂肱关节的吻合度：肱骨已绕肱骨头中心重新摆位，肩胛骨则完全没有动
  // glenohumeral congruency: the humeri were re-posed about the head centre, the scapulae not at all
  const shoulder: Record<string, unknown> = {}
  for (const side of ['left', 'right'] as const) {
    const S = side === 'left' ? 'Left' : 'Right'
    const jc = fa.jointCentres[`shoulder_${side}`]!
    // 肩关节中心随上半身下移，再随肩胛骨的标准化映射走
    // the joint centre moves down with the upper body, then with the scapula's standardisation map
    const posedCentre: [number, number, number] = [jc.reposed[0] + restack.t[0], jc.reposed[1] + dy + restack.t[1], jc.reposed[2] + restack.t[2]]
    const her = standard ? (standard.plan.boneMap(`${S} scapula`) ?? standard.plan.axial)(posedCentre) : posedCentre
    const gap = (centre: number[], scapula: Mesh, humerus: Mesh) => {
      const r = new PointIndex(samplesOf(humerus, 0.002), 0.01).distance(centre[0]!, centre[1]!, centre[2]!)
      const d = new PointIndex(samplesOf(scapula, 0.002), 0.01).distance(centre[0]!, centre[1]!, centre[2]!)
      return { headRadiusMm: round(r * 1000, 1), centreToScapulaMm: round(d * 1000, 1), gapMm: round((d - r) * 1000, 1) }
    }
    const f = gap(her, byName(`${S} scapula`)!.mesh, byName(`${S} humerus`)!.mesh)
    const m = gap(jc.male, maleMeshByName.get(`${S} scapula`)!, maleMeshByName.get(`${S} humerus`)!)
    shoulder[side] = { female: f, male: m, differenceMm: round(f.gapMm - m.gapMm, 1) }
  }
  console.log(`\nGlenohumeral joint (distance from the humeral head centre to the scapula minus head radius): ${JSON.stringify(shoulder)}`)
  report.shoulder = shoulder

  const nWarped = count((p) => p.provenance === 'warped')
  const nOwn = count((p) => p.source === SOURCE_VHF.name || p.source === SOURCE_DENVER.name)
  const nMale = count((p) => p.id.startsWith('W_') && !isFatPart(p.id))
  const nWu = count((p) => p.source === SOURCE_WU.name)
  const pv = (report.pelvis ?? {}) as { bladder?: { volumeMl: { before: number }; neckMovedMm: number; baseToVaginaMm: { before: number; after: number } }; rectosigmoid?: { lowerEndOfSigmoidMovedMm?: number }; bowel?: { shifts: { shiftMm: number }[] }; warpedDropped?: { parts: string[] } }
  const HRA_ZH: [RegExp, string][] = [[/uterine artery/i, '子宫动脉'], [/uterine vein/i, '子宫静脉'], [/suspensory ligament of .*ovary/i, '卵巢悬韧带'], [/uterovesical pouch/i, '膀胱子宫陷凹'], [/uterosacral/i, '骶子宫韧带'], [/cardinal/i, '主韧带'], [/broad ligament/i, '子宫阔韧带'], [/mesosalpinx/i, '输卵管系膜'], [/mesovarium/i, '卵巢系膜'], [/ovarian ligament/i, '卵巢固有韧带']]
  const hraPelvic = parts.filter((p) => p.source === SOURCE_HRA.name && p.system !== 'integumentary').map((p) => p.name.replace(/^(Left|Right) /i, '').replace(/ of (left|right) /i, ' of '))
  const hraKept = [...new Set(hraPelvic.map((n) => n[0]!.toUpperCase() + n.slice(1)))]
  const hraKeptZh = [...new Set(hraPelvic.map((n) => HRA_ZH.find(([rx]) => rx.test(n))?.[1] ?? n))].join('、')
  const bare = (n: string) => n.replace(/^(Left|Right) /i, '').replace(/ of (left|right) /i, ' of ')
  const hraGoneNames = [...new Set(((report.pelvis as { dropped?: { id: string; name: string }[] } | undefined)?.dropped ?? []).filter((x) => x.id.startsWith('HRA_')).map((x) => bare(x.name)))]
  const hraGone = hraGoneNames.map((n) => n[0]!.toUpperCase() + n.slice(1))
  const hraGoneZh = [...new Set(hraGoneNames.map((n) => HRA_ZH.find(([rx]) => rx.test(n))?.[1] ?? n))].join('、')
  const warpedGone = [...new Set((pv.warpedDropped?.parts ?? []).map((n) => n.replace(/^(Left|Right) /, '').toLowerCase()))]
  // 体表的说明：装入了皮肤包时，数值取自本次构建的测量（report.skinPackage）；量不了的（BMI、肩宽、腋窝处皮肤相穿）引用皮肤作者的数
  // cautions about the body surface: with a skin package installed the figures are this build's measurements (report.skinPackage);
  // what cannot be measured here (BMI, shoulder breadth, skin running into skin at the axilla) quotes the skin's author
  const skinCautions: { zh: string; en: string }[] = []
  if (installedSkin) {
    const pkg = installedSkin as SkinPackage
    const row = report.skinPackage as {
      face?: { cover: Record<string, { minMm: number; medianMm: number } | null>; eyeJoint: Record<'L' | 'R', { lateralMm: number }> | null }
      resolution?: { shipped: { face: { vertices: number; meanEdgeMm: number } } }
      breastPlacement?: { sides: Record<string, { scale: number; translationM: number[] } | undefined> }
    }
    const au = pkg.author
    const bmi = au.bmiByVolume !== null && au.targetBmi !== null ? { en: ` It is heavier than intended: BMI ${au.bmiByVolume} by enclosed volume against a target of ${au.targetBmi}.`, zh: `它比设定的要胖：按所围体积算 BMI 为 ${au.bmiByVolume}，目标是 ${au.targetBmi}。` } : { en: '', zh: '' }
    const bd = au.bideltoidMm ? { en: ` The shoulders and upper arms are fuller than the target (bideltoid breadth ${Math.round(au.bideltoidMm.final)} mm against ${Math.round(au.bideltoidMm.target)} mm).`, zh: `肩部和上臂比目标粗（两侧三角肌间宽 ${Math.round(au.bideltoidMm.final)} mm，目标 ${Math.round(au.bideltoidMm.target)} mm）。` } : { en: '', zh: '' }
    const ax = SKIN_AUTHOR_NOTES[pkg.fittedTo?.key ?? ''] ?? { en: '', zh: '' }
    skinCautions.push({
      en: `The body surface is a parametric model skin (${pkg.source.name}), not a scan and not her own skin: a surface shaped as a standard female body and then relaxed outwards over her muscles until it encloses them.${bmi.en}${bd.en}${ax.en} The toes are one block, and the perineum is a smooth surface without vulvar anatomy.`,
      zh: `体表是参数化模型皮肤（${pkg.source.name}），不是扫描所得，也不是她本人的皮肤：先做成标准女性体形的表面，再向外松弛到把她的肌肉包住。${bmi.zh}${bd.zh}${ax.zh}足趾连成一块；会阴是一片光滑的表面，没有外阴的解剖结构。`,
    })
    const cov = row.face?.cover ?? {}
    const through = (k: string) => (cov[k] && cov[k]!.minMm < 0 ? (-cov[k]!.minMm).toFixed(1) : null)
    const ring = through('palpebralOrbicularisOculi')
    const cornea = through('cornea')
    const lip = through('lip')
    const thr = [ring ? `the inner (palpebral) ring of orbicularis oculi by up to ${ring} mm` : '', cornea ? `the cornea by ${cornea} mm` : '', lip ? `the lips by ${lip} mm` : ''].filter(Boolean)
    const thrZh = [ring ? `眼轮匝肌内环（睑部）最多 ${ring} mm` : '', cornea ? `角膜 ${cornea} mm` : '', lip ? `唇 ${lip} mm` : ''].filter(Boolean)
    const oris = cov.orbicularisOris ? Math.round(cov.orbicularisOris.medianMm) : null
    const eye = row.face?.eyeJoint ? (row.face.eyeJoint.L.lateralMm + row.face.eyeJoint.R.lateralMm) / 2 : null
    const fv = row.resolution?.shipped.face
    skinCautions.push({
      en: `Her head is the skin model's average head scaled to her skull, not a face of her own; the surface there has faults of its own: horizontal steps across the face at the level of the nose, the mouth and the chin, a crumpled knot of skin at the inner corner of each eye and a rough rim round the nostrils.${oris !== null ? ` The soft tissue of the lower face is too thick (about ${oris} mm of cover over orbicularis oris).` : ''}${eye !== null && Math.abs(eye) >= 1 ? ` The model's eyes sit about ${Math.abs(eye).toFixed(0)} mm ${eye > 0 ? 'further from' : 'nearer to'} the midline on each side than her eyeballs.` : ''} The eyes and the mouth are not openings: the lids are one sheet of skin over the globe and the lips meet in a crease; there the skin was deliberately not pushed out${thr.length ? `, and what lies under it comes through: ${thr.join(', ')}` : ''}.${fv ? ` The face keeps the full resolution of the surface (${fv.vertices} vertices, mean edge ${fv.meanEdgeMm} mm); the rest of the skin is simplified.` : ''}`,
      zh: `她的头是皮肤模型的平均头按她的颅骨缩放得到的，不是她本人的面孔；这块表面自身也有毛病：面部在鼻、口、颏的高度各有一道横向的台阶，两眼内眦处各有一团皱起的皮肤，鼻孔缘粗糙。${oris !== null ? `下面部的软组织偏厚（口轮匝肌外约有 ${oris} mm 的覆盖）。` : ''}${eye !== null && Math.abs(eye) >= 1 ? `模型的眼比她的眼球每侧${eye > 0 ? '偏外' : '偏内'}约 ${Math.abs(eye).toFixed(0)} mm。` : ''}眼和口都不是开口：眼睑是盖在眼球前的一整片皮肤，上下唇在口裂处相贴成一道褶；这些地方的皮肤有意不外推${thrZh.length ? `，因此有结构露出皮肤：${thrZh.join('、')}` : ''}。${fv ? `面部保留体表的原始分辨率（${fv.vertices} 个顶点，平均边长 ${fv.meanEdgeMm} mm），其余皮肤经过简化。` : ''}`,
    })
    const bl = row.breastPlacement?.sides.L
    const br = row.breastPlacement?.sides.R
    if (bl && br) {
      const down = Math.round((-(bl.translationM[1]! + br.translationM[1]!) / 2) * 100)
      // 高度检查不通过时如实说明（数值取自 sexChecks） / when the level check fails it is said so (figures from sexChecks)
      type Level = { pass: boolean; glandCentroidBelowPectoralisLowerBorderMm: number; nippleBelowXiphoidLowerEndMm: number }
      const lv = ['left', 'right'].map((k) => (report.sexChecks as Record<string, Level | undefined>)[`${k}BreastLevel`]).filter((x): x is Level => !!x && !x.pass)
      const low = lv.length ? {
        en: ` They sit too low: the centre of the gland is ${lv.map((x) => Math.round(x.glandCentroidBelowPectoralisLowerBorderMm)).join(' and ')} mm below the lower border of the sternocostal part of pectoralis major (it lies over the abdominal part of the muscle only), and the nipple about ${Math.round(lv.reduce((a, x) => a + x.nippleBelowXiphoidLowerEndMm, 0) / lv.length / 10)} cm below the tip of the xiphoid process.`,
        zh: `它们的位置偏低：腺体中心在胸大肌胸肋部下缘以下 ${lv.map((x) => Math.round(x.glandCentroidBelowPectoralisLowerBorderMm)).join(' 和 ')} mm（只盖在该肌的腹部之上）；乳头在剑突尖以下约 ${Math.round(lv.reduce((a, x) => a + x.nippleBelowXiphoidLowerEndMm, 0) / lv.length / 10)} cm。`,
      } : { en: '', zh: '' }
      skinCautions.push({
        en: `The breasts on the surface are the skin model's. The gland, ducts, fat, areola and nipple inside them are an artist model (Human Reference Atlas) of a larger breast in standing shape, scaled to ${bl.scale.toFixed(2)} (left) and ${br.scale.toFixed(2)} (right) of its size and moved about ${down} cm down to fit under that skin.${low.en} Their size, their place on the chest wall and the difference between left and right are therefore not anatomical data.`,
        zh: `体表上的乳房是皮肤模型的。其内的腺体、导管、脂肪、乳晕和乳头是美术模型（Human Reference Atlas），原本是更大的站立位乳房，被缩小到原大小的 ${bl.scale.toFixed(2)}（左）和 ${br.scale.toFixed(2)}（右），并下移约 ${down} cm，才放得进这层皮肤。${low.zh}因此它们的大小、在胸壁上的位置和左右差别都不是解剖数据。`,
      })
    } else {
      skinCautions.push({
        en: 'The breasts on the surface are the skin model\'s; the gland parts inside them are a standing-shape artist model (Human Reference Atlas) that was not fitted to that skin.',
        zh: '体表上的乳房是皮肤模型的；其内的腺体各部是站立位形态的美术模型（Human Reference Atlas），没有按这层皮肤调整过。',
      })
    }
    const nf = (report.skinPackage as { notFitted?: { caution: { zh: string; en: string } } }).notFitted
    if (nf) skinCautions.push(nf.caution)
  } else {
    skinCautions.push({
      en: 'The body surface is a PLACEHOLDER: male skin deformed to this skeleton and raised into a smooth envelope over the breasts. It still carries male external genitalia and does not show female body shape or fat distribution; a standard female skin is to replace it. The breasts themselves are a standing-shape artist model.',
      zh: '体表是占位用的：男性皮肤按这副骨架形变后，再在乳房处抬高成平滑包络，仍带有男性外生殖器，并不反映女性的体形和脂肪分布，之后将换成标准女性皮肤。乳房本身是站立位形态的美术模型。',
    })
  }
  const cautions: { zh: string; en: string }[] = [
    {
      en: standard
        ? `This is a constructed standard female, not a scan of one person. Bones, leg and pelvis muscles and some organs come from one donor (Visible Human Female: CT and the University of Denver cryosection models, ${nOwn} parts), but they were re-posed and then scaled segment by segment to the proportions of an average young woman (stature ${(STANDARD.statureMm / 10).toFixed(1)} cm), so no part keeps the donor's true size or proportions; all are labelled "warped". The other ${nMale} parts are male anatomy deformed onto that skeleton.`
        : `This body is a construction, not a scan of one person: her real skeleton (Visible Human Female CT) carries male soft tissue deformed to fit it. Only the ${count((p) => p.provenance === 'scanned')} parts marked "scanned" are her own anatomy; ${nWarped} parts are warped male anatomy.`,
      zh: standard
        ? `本模型是构建出来的“标准女性”，并非某一位女性的扫描。骨骼、下肢和骨盆的肌以及部分器官来自同一位供体（Visible Human Female：CT 和丹佛大学的冰冻切片模型，共 ${nOwn} 个部件），但都重新摆过姿势，并逐肢段缩放到年轻女性的平均比例（身高 ${(STANDARD.statureMm / 10).toFixed(1)} cm），因此没有任何部件保留供体的真实大小和比例，一律标为“形变”。其余 ${nMale} 个部件是形变贴合到这副骨架上的男性结构。`
        : `本模型是拼合构建的，并非某一位女性的完整扫描：骨骼来自女性真实 CT（Visible Human Female），其上的软组织则由男性模型形变贴合而成。只有标为“扫描”的 ${count((p) => p.provenance === 'scanned')} 个部件是她本人的解剖结构，另有 ${nWarped} 个部件是形变后的男性结构。`,
    },
    ...(standard ? [{
      en: `Proportions are imposed, not measured: segment lengths follow regressions fitted to US Army and US civilian surveys, evaluated at the mean stature of Chinese women aged 20–24. The trunk was shortened, the shoulder girdle lowered by about 7 cm, the forearms and lower legs lengthened, the pelvis narrowed by about 11 % and the feet flattened by about 20 %; the muscle envelope of the arms, chest wall, thighs and calves was thinned to fit the girths of a woman of BMI ${STANDARD.bmi}. Do not read individual bone shape, joint congruency or muscle bulk from this model.`,
      zh: `比例是设定的，不是测得的：各肢段长度按美国陆军和美国平民测量数据拟合的回归式取值，身高取中国 20–24 岁女性的均值。躯干被缩短，肩带下移约 7 cm，前臂和小腿被加长，骨盆收窄约 11 %，足被压低约 20 %；上肢、胸壁、大腿和小腿的肌肉包络被收薄，以符合 BMI ${STANDARD.bmi} 女性的围度。不要据此模型判断单块骨的形状、关节的吻合程度或肌肉的粗细。`,
    }, {
      en: 'Most leg and pelvis muscles are spliced: the belly is the donor\'s (Denver cryosection model, bellies only) and the tendons are cut from the male muscle and moved to meet it, so the junction between belly and tendon is a join, not anatomy. Where no clean join was possible (gastrocnemius, gracilis, sartorius, semimembranosus, semitendinosus, gluteus minimus) the male muscle is shown instead. Vessels and nerves of the leg are male structures pushed out of these muscles afterwards; some still run through them.',
      zh: '下肢和骨盆的肌大多是拼接的：肌腹来自供体（Denver 冰冻切片模型，只有肌腹），肌腱则取自男性的同名肌并移到与肌腹对齐，所以肌腹与肌腱的交界是拼接出来的，不是真实解剖。无法干净拼接的肌（腓肠肌、股薄肌、缝匠肌、半膜肌、半腱肌、臀小肌）仍用男性的肌。下肢的血管和神经是男性结构，事后被推出这些肌之外，仍有一部分从肌中穿过。',
    }] : []),
    {
      en: 'Warped parts are anchored by bone only. Between bones their position is extrapolated: expect errors of 1–3 cm for limb muscles, vessels and nerves, and more in the abdomen and pelvis.',
      zh: '形变部件仅以骨骼为锚点，骨与骨之间的位置靠外推得到：四肢的肌肉、血管和神经误差约 1–3 cm，腹部和盆腔更大。',
    },
    {
      en: `The pelvic floor, the anal and urethral sphincters, the perineal muscles, clitoris and vestibular bulbs, the urethra, vagina, rectum and anal canal, uterus, tubes and ovaries (${nWu} parts) are real female anatomy, but of ANOTHER woman, not of the donor of the skeleton (Wu et al. 2015: a young adult of the Chinese Visible Human series). Her structures were reconstructed from cryosections and smoothed by the authors of that study, enlarged 1.096 times and fitted to this pelvis by its bones (to about 2 mm), then narrowed by 11 % together with the pelvis. Left and right halves were separated by this project, and where neighbouring structures overlapped the less important one was reshaped by up to 8 mm. Do not read sizes, exact positions or left–right differences from these parts.`,
      zh: `盆底肌、肛门括约肌和尿道括约肌、会阴肌、阴蒂和前庭球、尿道、阴道、直肠和肛管、子宫、输卵管和卵巢（共 ${nWu} 个部件）是真实的女性解剖结构，但来自另一位女性，不是这副骨架的供体（Wu 等 2015 年的研究：中国可视化人体数据集中的一位年轻成年女性）。这些结构由该研究的作者根据冰冻切片重建并做过平滑，本模型把它们放大 1.096 倍，按骨性标志配准到这个骨盆上（误差约 2 mm），又随骨盆一起横向收窄 11 %。左右两半是本项目切分的；相邻结构有重叠的地方，次要的一方被重新塑形，最多移动 8 mm。不要据此判断这些结构的大小、精确位置或左右差异。`,
    },
    {
      en: `Three sources meet in the lesser pelvis, and where they meet the model is a join, not anatomy. The bladder, bones and obturator internus are the donor's; her bladder is almost empty (${pv.bladder?.volumeMl?.before ?? '?'} ml), its neck was drawn ${pv.bladder?.neckMovedMm ?? '?'} mm onto the upper end of the other woman's urethra and its base ${pv.bladder ? round(pv.bladder.baseToVaginaMm.before - pv.bladder.baseToVaginaMm.after, 0) : '?'} mm back onto the anterior vaginal wall. The uterus stands as it did in the other woman, whose bladder was full, so an unnatural gap remains between bladder and uterus. The sigmoid colon, ureters, vessels, nerves and lymph nodes are male structures: the end of the sigmoid colon was moved ${pv.rectosigmoid?.lowerEndOfSigmoidMovedMm ?? '?'} mm to meet the upper end of the rectum (which is cut off at the top of the specimen), the bowel was shifted by up to ${Math.max(0, ...(pv.bowel?.shifts ?? []).map((x) => x.shiftMm))} mm to clear the uterus, left tube and left ovary, and vessels that ran through these organs were pushed to their surface; some still cut through them.${hraKept.length ? ` ${hraKept.join(', ')} are artist models (Human Reference Atlas) moved 2–4 cm onto these organs.` : ''}`,
      zh: `小骨盆里有三个来源的结构，它们相接的地方是拼接出来的，不是真实解剖。膀胱、骨和闭孔内肌来自骨架的供体；她的膀胱几乎是空的（${pv.bladder?.volumeMl?.before ?? '?'} ml），膀胱颈被拉动 ${pv.bladder?.neckMovedMm ?? '?'} mm 接到另一位女性的尿道上端，膀胱底向后移了 ${pv.bladder ? round(pv.bladder.baseToVaginaMm.before - pv.bladder.baseToVaginaMm.after, 0) : '?'} mm 贴近阴道前壁。子宫保持它在另一位女性体内的位置，而那位女性的膀胱是充盈的，所以膀胱与子宫之间留有一段不自然的空隙。乙状结肠、输尿管、血管、神经和淋巴结是男性结构：乙状结肠末端被移动 ${pv.rectosigmoid?.lowerEndOfSigmoidMovedMm ?? '?'} mm 去对接直肠上端（直肠在标本上缘处被截断），肠管整体移动了最多 ${Math.max(0, ...(pv.bowel?.shifts ?? []).map((x) => x.shiftMm))} mm 以避开子宫、左输卵管和左卵巢，原本穿过这些器官的血管被推到器官表面，仍有少数从中穿过。${hraKept.length ? `${hraKeptZh}是美术建模（Human Reference Atlas），被移动 2–4 cm 贴到这些器官上。` : ''}`,
    },
    ...skinCautions,
    ...((report.bodyShape as { applied?: boolean } | undefined)?.applied ? [{
      en: `Muscle bulk and position were then changed again to fit a target body surface: a parametric female skin (stature ${(STANDARD.statureMm / 10).toFixed(1)} cm, BMI ${STANDARD.bmi}) less the subcutaneous fat expected at each place. Muscles, tendons, warped organs, vessels and nerves were pushed in, and in places pulled out, by up to ${(report.bodyShape as { displacementMm: { max: number } }).displacementMm.max} mm with one smooth field that is zero on bone; ${(report.bodyShape as { volume: { flagged: unknown[] } }).volume.flagged.length} muscles lost more than a quarter of their volume (calf, abdominal wall, forearm extensors, neck). ${(((report.bodyShape as { outside: { after: { all: { outside: number } } } }).outside.after.all.outside) * 100).toFixed(0)} % of the muscle and organ surface still lies outside that target, mostly thin muscle lying directly on bone. Muscle thickness, cross-section and volume in this model are therefore not anatomical data.`,
      zh: `之后又按一个目标体表改动了肌肉的粗细和位置：目标是参数化的女性皮肤（身高 ${(STANDARD.statureMm / 10).toFixed(1)} cm，BMI ${STANDARD.bmi}）向内减去各处应有的皮下脂肪。肌、腱、形变来的器官、血管和神经被一个在骨面上为零的平滑位移场推入（个别地方拉出），最多 ${(report.bodyShape as { displacementMm: { max: number } }).displacementMm.max} mm；${(report.bodyShape as { volume: { flagged: unknown[] } }).volume.flagged.length} 块肌的体积减少了四分之一以上（小腿、腹壁、前臂伸肌、颈部）。仍有 ${(((report.bodyShape as { outside: { after: { all: { outside: number } } } }).outside.after.all.outside) * 100).toFixed(0)} % 的肌和器官表面在目标之外，主要是直接贴在骨上的薄肌。因此本模型中肌肉的厚度、横截面和体积都不是解剖数据。`,
    }] : []),
    ...(parts.some((p) => isFatPart(p.id)) ? [{
      zh: '皮下脂肪层是在上述合成体表与她的肌肉、骨骼、器官外包络之间按 3 mm 体素填充得到的（最深只算到皮下 3 cm），并非扫描所得；其厚度取决于合成的皮肤，不代表女性真实的脂肪分布。',
      en: 'The subcutaneous fat layer fills the gap between that synthetic body surface and the outer envelope of her muscles, bones and organs at 3 mm voxels (no deeper than 3 cm below the skin); it is not scanned, and its thickness follows the synthetic skin rather than a real female fat distribution.',
    }] : []),
    {
      en: `Absent from the pelvis: labia, vestibule and the skin of the vulva (${installedSkin ? 'the body surface there is smooth' : 'the body surface there is not female'}); the mucosa and lumen of the urethra; ${hraGone.length ? `${hraGone.join(', ').toLowerCase()} (the artist models of these did not fit the organs shown and were left out); ` : ''}ovarian and vaginal vessels; the autonomic pelvic plexuses. The iliococcygeus is not a separate part: the source describes the pubococcygeus and iliococcygeus together as a "pubovisceral muscle" with an inner and an external layer. Male-only parts (prostate, testes, penis, seminal vesicles, testicular vessels, male urethra) and the male pelvic floor and rectum were removed${warpedGone.length ? `, as were male structures that would lie inside the female organs (${warpedGone.join(', ')})` : ''}.`,
      zh: `盆腔中缺失的结构：阴唇、阴道前庭和外阴皮肤（${installedSkin ? '该处的体表是光滑的' : '该处的体表不是女性的'}）；尿道的黏膜和管腔；${hraGone.length ? `${hraGoneZh}（这些结构的美术模型与这里显示的器官对不上，没有采用）；` : ''}卵巢血管和阴道血管；盆腔自主神经丛。髂尾肌不是单独的部件：数据来源把耻尾肌和髂尾肌合称“耻骨内脏肌”，分为内层和外层。男性特有结构（前列腺、睾丸、阴茎、精囊、睾丸血管、男性尿道）以及男性的盆底肌和直肠已删除${warpedGone.length ? `，落在女性器官内部的男性结构（${warpedGone.join('、')}）也已删除` : ''}。`,
    },
    {
      en: 'Pose is reconstructed: the donor was scanned lying down with bent elbows and pointed feet, and each bone was moved rigidly into a standing pose. Joint spaces at the elbow, knee, ankle and shoulder are approximate, and the scapulae and clavicles keep their lying-down position.',
      zh: '姿势是重建的：供体扫描时为仰卧、屈肘、足跖屈，各骨被逐一刚性移动到站立姿势。肘、膝、踝、肩的关节间隙只是近似，肩胛骨和锁骨仍保持仰卧时的位置。',
    },
    {
      en: 'Right radius, ulna and the bones of both hands and feet are not her scanned bones: the right forearm is a mirrored copy of the left (the scan cut it off), and hand and foot bones are warped male bones with extended fingers.',
      zh: '右侧桡骨、尺骨以及双手、双足的骨并非她的扫描骨：右前臂是左前臂的镜像（扫描视野将其截断），手骨和足骨是形变后的男性骨，手指呈伸直状。',
    },
    {
      en: report.lumbar
        ? 'The donor had six lumbar vertebrae. A standard five-lumbar spine is shown: her first lumbar vertebra was removed and everything above it moved down by one segment, so the thoracolumbar junction is a join, not anatomy. Rib numbering comes from automatic segmentation and is unreliable for left ribs 5–9.'
        : 'She has six lumbar vertebrae. The first is shown as "Supernumerary lumbar vertebra"; her second to sixth carry the names of the first to fifth. Rib numbering comes from automatic segmentation and is unreliable for left ribs 5–9.',
      zh: report.lumbar
        ? '供体有六节腰椎。这里显示的是标准的五节腰椎：去掉了她的第一腰椎，其上方的全部结构下移一个椎节，因此胸腰交界处是拼接出来的，不是真实解剖。肋骨编号来自自动分割，左侧第 5–9 肋的编号不可靠。'
        : '她有六节腰椎：第一节显示为“额外腰椎”，第二至第六节沿用第一至第五腰椎的名称。肋骨编号来自自动分割，左侧第 5–9 肋的编号不可靠。',
    },
    {
      en: 'Her scanned organs (kidneys, spleen, pancreas, adrenals, gallbladder, bladder, gluteal muscles) are in lying-down, post-mortem position and do not always meet the warped vessels and ducts that should connect to them. Lungs, heart, liver, stomach and bowel are warped male organs.',
      zh: '她的扫描器官（肾、脾、胰、肾上腺、胆囊、膀胱、臀肌）处于仰卧、死后的位置，与本应相连的形变血管和管道不一定对得上。肺、心、肝、胃和肠是形变后的男性器官。',
    },
    {
      en: 'Everything said about the male model also applies to the warped parts: nerves, ligaments and lymph nodes are artist-modelled with schematic nerve thickness; phrenic nerve, pleura, pericardium, spinal cord, menisci and cruciate ligaments are absent.',
      zh: '男性模型的各项注意事项同样适用于形变部件：神经、韧带和淋巴结为美术建模，神经粗细仅为示意；膈神经、胸膜、心包、脊髓、半月板和交叉韧带缺失。',
    },
  ]
  notes.push(...cautions.map((c) => c.en))
  report.cautions = cautions
  report.notes = notes
  report.counts = {
    parts: parts.length,
    byProvenance: Object.fromEntries(['scanned', 'warped', 'curated'].map((k) => [k, count((p) => p.provenance === k)])),
    bySource: Object.fromEntries([...new Set(parts.map((p) => p.source))].map((s) => [s, count((p) => p.source === s)])),
    bySystem: Object.fromEntries([...new Set(parts.map((p) => p.system))].sort().map((s) => [s, Object.fromEntries(['scanned', 'warped', 'curated'].map((k) => [k, count((p) => p.system === s && p.provenance === k)]))])),
    droppedMaleOnly: maleNamesDropped,
    realPartsAvailableButNotUsed: notUsed,
    realPartsNotes: realNotes,
  }
  console.log(`\nParts: ${parts.length} — ${JSON.stringify((report.counts as { byProvenance: unknown }).byProvenance)}; by source ${JSON.stringify((report.counts as { bySource: unknown }).bySource)}`)
  for (const [s, v] of Object.entries((report.counts as { bySystem: Record<string, Record<string, number>> }).bySystem)) console.log(`  ${pad(s, 16)}scanned ${pad(v.scanned!, 5)}warped ${pad(v.warped!, 6)}curated ${v.curated}`)
  console.log(`  male-only parts dropped (${dropped.length}): ${maleNamesDropped.join('; ')}`)
  console.log(`  her real parts available one-to-one but not used (${notUsed.length}): ${notUsed.map((n) => `${n.id} (${n.reason})`).join('; ')}`)
  console.log(`  HRA parts (${hra.length}): ${hra.map((p) => p.name).join('; ').slice(0, 900)}`)

  const stage = `${outDir.replace(/\/+$/, '')}.tmp-${process.pid}`
  mkdirSync(outDir, { recursive: true })
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const systemDefs = JSON.parse(readFileSync(join(ROOT, 'data/curated/systems.json'), 'utf8')) as Omit<SystemDef, 'glb' | 'partCount'>[]
  const systems: SystemDef[] = []
  const glbSizes: Record<string, number> = {}
  for (const def of systemDefs) {
    const list: GlbPart[] = final.filter((f) => f.p.system === def.id).map((f) => ({ id: f.p.id, positions: f.mesh.positions, normals: computeNormals(f.mesh), indices: f.mesh.indices }))
    let glb: string | null = null
    if (list.length) {
      glb = `${def.id}.glb`
      glbSizes[glb] = await writeSystemGlb(join(stage, glb), def.id, def.color, list)
    }
    systems.push({ id: def.id, name: def.name, color: def.color, glb, partCount: list.length })
  }
  const usedSources = new Set(parts.map((p) => p.source))
  const data: AnatomyData = {
    schema: 1,
    body: 'female',
    cautions: report.cautions as { zh: string; en: string }[],
    sources: [...male.data.sources.filter((s) => usedSources.has(s.name)), SOURCE_VHF, ...(usedSources.has(SOURCE_DENVER.name) ? [SOURCE_DENVER] : []), ...(usedSources.has(SOURCE_HRA.name) ? [SOURCE_HRA] : []), ...(usedSources.has(SOURCE_WU.name) ? [SOURCE_WU] : []), ...(installedSkin ? [(installedSkin as SkinPackage).source] : [])].filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i),
    systems,
    layers: LAYERS.map((l) => ({ name: l.name })),
    parts: outParts,
    trees: { isa: isaTree, partOf: partOfTree },
  }
  const json = JSON.stringify(data)
  writeFileSync(join(stage, 'anatomy.json'), json)
  const nervePaths: NervePath[] = parts.filter((p) => p.centrelines?.length).map((p) => ({ part: p.id, branches: p.centrelines!.map((b) => ({ points: Array.from(b.points, (v) => round(v)), radius: Array.from(b.radius, (v) => round(v)) })) }))
  if (nervePaths.length) writeFileSync(join(stage, 'nerves.json'), JSON.stringify(nervePaths))
  const all = outParts.reduce((b, p) => [Math.min(b[0]!, p.bbox[0]), Math.min(b[1]!, p.bbox[1]), Math.min(b[2]!, p.bbox[2]), Math.max(b[3]!, p.bbox[3]), Math.max(b[4]!, p.bbox[4]), Math.max(b[5]!, p.bbox[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  report.output = { parts: outParts.length, triangles: trianglesOut, glbBytes: glbSizes, anatomyJsonBytes: json.length, nerves: nervePaths.length, bounds: all.map((v) => round(v, 4)) }
  writeFileSync(join(stage, 'pipeline-report.json'), JSON.stringify(report, null, 1))
  const staged = readdirSync(stage).sort((a, b) => Number(a === 'anatomy.json') - Number(b === 'anatomy.json') || a.localeCompare(b))
  for (const f of staged) renameSync(join(stage, f), join(outDir, f))
  for (const f of readdirSync(outDir)) if ((f.endsWith('.glb') || f === 'nerves.json') && !staged.includes(f)) rmSync(join(outDir, f))
  rmSync(stage, { recursive: true, force: true })
  console.log(`\nOutput: public/anatomy/female — ${outParts.length} parts, ${trianglesOut} triangles, anatomy.json ${(json.length / 1024).toFixed(0)} KB, nerves.json ${nervePaths.length} nerves`)
  let total = 0
  for (const s of systems) {
    if (!s.glb) continue
    total += glbSizes[s.glb]!
    console.log(`  ${pad(s.glb, 22)}${pad((glbSizes[s.glb]! / 1024).toFixed(0) + ' KB', 10)}${s.partCount} parts`)
  }
  console.log(`  GLB total ${(total / 1024 / 1024).toFixed(2)} MB; body bounds (m): x ${all[0]!.toFixed(3)}…${all[3]!.toFixed(3)}, y ${all[1]!.toFixed(3)}…${all[4]!.toFixed(3)}, z ${all[2]!.toFixed(3)}…${all[5]!.toFixed(3)}`)
  lap('done')
}

if (import.meta.main) await main()
