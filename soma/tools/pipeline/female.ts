// 女性身体：把男性模型配准到真实的女性锚点上。
//   bun tools/pipeline/female.ts [--out <dir>]
// 读取已构建的男性身体（public/anatomy/male —— 先运行男性管线）和女性锚点包
// （data/raw/female/out/anchors），写出 public/anatomy/female。
//
// 哪些是真实的、哪些不是（同时写入 pipeline-report.json 的 `notes`）：
//   scanned  她自己的骨（Visible Human Female CT），逐块骨做刚性移动，从仰卧扫描姿势变到
//            男性的站立姿势；以及来自同一 CT 的少数质量好的器官和躯干肌
//   curated  子宫、卵巢、输卵管、阴道、盆腔韧带、子宫血管、乳房（HRA）
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
//   curated  uterus, ovaries, tubes, vagina, pelvic ligaments, uterine vessels, breasts (HRA)
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
import { buildTunnel } from './pelvis.ts'
import { spliceTendons } from './splice.ts'
import { depthOf, LAYERS } from './layers.ts'
import { applyRigid, buildDeformation, buildTwoLevelDeformation, fitRigid, fitSimilarity, icp, InsideTester, PointIndex, surfaceDistance, surfacePoints, thinPoints, type Deformation, type Rigid } from './register.ts'
import { checkSkinFit, internalsKey, loadSkinPackage, type SkinPackage } from './skinPackage.ts'
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
/** 阴道表面与周围形变结构之间保留的间隙（米） / gap kept between the vaginal surface and the warped structures round it (m) */
const HIATUS_CLEARANCE = 0.002
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
  /**
   * 几何已是最终形态（已简化的男性网格、重建的神经管）
   * geometry is final (already simplified male mesh, rebuilt nerve tube)
   */
  keepGeometry?: boolean
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
  {
    const usable = (i: FemaleItem) => i.id.startsWith('VF_') || (i.id.startsWith('HRA_') && !/skin/i.test(i.name) && i.kind !== 'surface')
    const unused = fa.items.filter((i) => !usable(i) && !denver.includes(i))
    console.log(`  anchor package: ${denver.length} Denver items used as parts; ${unused.length} items not used (${unused.filter((i) => i.source === 'denver').length} Denver bones that duplicate CT bones, ${unused.filter((i) => i.source !== 'denver').map((i) => i.id).join(', ')})`)
    report.anchorItems = { denverUsed: denver.length, unused: unused.map((i) => i.id) }
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
  for (const it of fa.items) {
    if (it.source !== 'hra') continue
    const cls = hraClass(it)
    const base = hraConcept(it)
    const fma = it.side !== 'M' && (hraSides.get(base)?.size ?? 0) > 1 ? `${base}_${it.side}` : base
    const w = weld(posed(it).positions, fa.scanned(it).indices)
    parts.push({ id: it.id, fma, name: hraName(it), system: cls.system, tissue: cls.tissue, depth: depthOf(cls.system, cls.tissue), side: it.side, provenance: 'curated', source: SOURCE_HRA.name, mesh: { positions: w.positions, indices: w.indices }, volume: it.volume_ml || undefined })
  }
  const hra = parts.filter((p) => p.provenance === 'curated')
  lap(`${hra.length} HRA parts added`)
  await finish({ parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed, lumbarConcept, dy, standard, restack: RESTACK })
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
}

async function finish(input: FinishInput) {
  const { parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed, dy, standard, restack } = input
  const byName = (name: string) => parts.find((p) => p.name === name)
  const samplesOf = (m: Mesh, spacing = 0.003) => thinPoints(surfacePoints(m, spacing), spacing * 0.8)

  // ── 5. 性别特有的碰撞 / 5. Sex-specific collisions ──────────────────────────────────────────────────────────────
  const collisions: Record<string, unknown> = {}
  {
    // 右卵巢与髂血管：（刚性地）移动卵巢，直到两者不再相交
    // right ovary against the iliac vessels: move the ovary (rigidly) until it is clear
    for (const side of ['left', 'right']) {
      const ovary = parts.find((p) => p.id === `HRA_${side}_ovary`)
      if (!ovary) continue
      const vessels = parts.filter((p) => (p.tissue === 'artery' || p.tissue === 'vein') && /iliac/i.test(p.name))
      const insideAny = (m: Mesh) => {
        const pts = samplesOf(m, 0.002)
        const b = measure(m).bbox
        let inside = 0
        let worst = ''
        let worstN = 0
        for (const v of vessels) {
          const vb = measure(v.mesh).bbox
          if (vb[0] > b[3] || vb[3] < b[0] || vb[1] > b[4] || vb[4] < b[1] || vb[2] > b[5] || vb[5] < b[2]) continue
          const n = new InsideTester(v.mesh).fractionInside(pts)
          inside += n
          if (n > worstN) {
            worstN = n
            worst = v.name
          }
        }
        return { inside, worst }
      }
      const before = insideAny(ovary.mesh)
      let moved = 0
      if (before.inside > 0.02) {
        const vein = parts.find((p) => p.name === before.worst)!
        const oc = measure(ovary.mesh).centroid
        const idx = new PointIndex(samplesOf(vein.mesh, 0.002), 0.006)
        const I = new Int32Array(1)
        const D = new Float64Array(1)
        idx.nearest(oc[0], oc[1], oc[2], 1, I, D)
        // 离开血管上的最近点，水平地朝向盆腔（向内侧）
        // away from the nearest point of the vessel, horizontally towards the pelvic cavity (medially)
        let dir = [oc[0] - idx.points[3 * I[0]!]!, oc[1] - idx.points[3 * I[0]! + 1]!, oc[2] - idx.points[3 * I[0]! + 2]!]
        const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
        dir = len > 1e-6 ? dir.map((v) => v / len) : [side === 'left' ? -1 : 1, 0, 0]
        for (let step = 1; step <= 25; step++) {
          const trial: Mesh = { positions: Float32Array.from(ovary.mesh.positions, (v, i) => v + dir[i % 3]! * 0.001 * step), indices: ovary.mesh.indices }
          moved = step
          if (insideAny(trial).inside <= 0.02) {
            ovary.mesh = trial
            break
          }
          if (step === 25) ovary.mesh = trial
        }
      }
      const after = insideAny(ovary.mesh)
      collisions[`${side} ovary vs iliac vessels`] = { insideBefore: round(before.inside, 3), vessel: before.worst || null, movedMm: moved, insideAfter: round(after.inside, 3) }
    }
    const female = parts.filter((p) => p.provenance === 'curated' && p.system === 'reproductive' && (p.tissue === 'organ' || p.tissue === 'gland'))
    const insideOf = (container: Mesh, m: Mesh) => new InsideTester(container, 96).fractionInside(samplesOf(m, 0.002))
    const measureGroup = (re: RegExp, container: FPart | undefined) => {
      const ms = female.filter((p) => re.test(p.name))
      if (!container || !ms.length) return 0
      const pts = concat(ms.map((p) => samplesOf(p.mesh, 0.002)))
      return new InsideTester(container.mesh, 96).fractionInside(pts)
    }
    const GROUPS: [string, RegExp][] = [
      ['uterus', /uterus|cervix|cornua|cervical os|uterine segment/i],
      ['left ovary', /^Left ovary$/],
      ['left uterine tube', /left uterine tube|left fallopian tube/i],
      ['right ovary', /^Right ovary$/],
      ['right uterine tube', /right uterine tube|right fallopian tube/i],
      ['vagina', /^Vagina$|cervicovaginal/i],
    ]
    const isGroup = (re: RegExp) => (p: FPart) => re.test(p.name) && !/ligament|meso/i.test(p.name)
    const colon = () => parts.find((p) => p.name === 'Descending colon')
    const bladder = parts.find((p) => p.name === 'Urinary bladder')
    const beforeColon = Object.fromEntries(GROUPS.map(([n, re]) => [n, round(measureGroup(re, colon()), 3)]))
    const beforeBladder = Object.fromEntries(GROUPS.map(([n, re]) => [n, round(measureGroup(re, bladder), 3)]))

    // (1) HRA 器官与她扫描得到的膀胱：膀胱是实测的，HRA 器官则是由骨驱动的拟合放置的
    // 美术模型，所以由 HRA 这一组让位。整套内生殖器（子宫、阴道、输卵管、卵巢及其韧带和血管）
    // 作为一个刚体整体向后移动，直到阴道和子宫颈离开膀胱。
    // (1) HRA organs against her scanned bladder: the bladder is measured, the HRA organs are an
    // artist's model placed by a bone-driven fit, so the HRA set gives way. The whole internal
    // genital set (uterus, vagina, tubes, ovaries, their ligaments and vessels) is moved back
    // as one rigid piece until the vagina and cervix clear the bladder.
    const genital = parts.filter((p) => p.provenance === 'curated' && (p.system === 'reproductive' || p.system === 'cardiovascular'))
    let nudge = 0
    if (bladder) {
      const front = female.filter((p) => /^Vagina$|cervicovaginal|cervix|wall of uterus|Body of uterus/i.test(p.name))
      const overlap = (dz: number) => {
        const pts = concat(front.map((p) => samplesOf(p.mesh, 0.002)))
        for (let i = 2; i < pts.length; i += 3) pts[i] = pts[i]! + dz
        return new InsideTester(bladder.mesh, 96).fractionInside(pts)
      }
      while (nudge < 0.012 && overlap(-nudge) > 0.005) nudge += 0.001
      if (nudge > 0) for (const p of genital) p.mesh = { positions: Float32Array.from(p.mesh.positions, (v, i) => (i % 3 === 2 ? v - nudge : v)), indices: p.mesh.indices }
    }
    collisions.hraSetMovedPosteriorMm = round(nudge * 1000, 1)

    // (2) 形变后的男性乙状结肠穿过她的左侧附件和子宫。一个包住了器官的封闭管，无法靠把
    // 管壁向外推来解除相交，所以改为把肠管横向移开：一个以该器官为中心的平滑平移场，方向
    // 从器官指向肠管的局部中心，逐步增大直到器官位于管外。所有形变后的消化系统部件都经过
    // 同一个场，所以结肠、结肠带和结肠系膜保持在一起。
    // (2) The warped male sigmoid colon runs through her left adnexa and uterus. A closed tube
    // that contains an organ cannot be cleared by pushing its surface outward, so the bowel is
    // shifted sideways instead: a smooth translation field centred on the organ, pointing from
    // the organ to the bowel's local centre, grown until the organ is outside. Every warped
    // digestive part goes through the same field, so the colon, its taeniae and the mesocolon
    // stay together.
    const shifts: Record<string, unknown>[] = []
    // 肠管不得被推入的结构：她的盆骨、腰椎和膀胱
    // what the bowel must not be pushed into: her pelvic bones, lumbar spine and bladder
    const pelvicObstacles = parts.filter((p) => p.provenance === 'scanned' && (/hip bone|Sacrum|lumbar vertebra/i.test(p.name) || p.name === 'Urinary bladder')).map((p) => new InsideTester(p.mesh, 64))
    const colonVolumeBefore = colon() ? Math.abs(measure(colon()!.mesh).signedVolume) : 0
    // 容器只考虑实体肠管（organ）；网膜等薄膜不是封闭实体 / containers are solid bowel only; omenta are open sheets
    const bowelAll = () => parts.filter((p) => p.provenance === 'warped' && p.system === 'digestive' && p.tissue !== 'tooth')
    const bowel = () => bowelAll().filter((p) => p.tissue === 'organ')
    // 把肠管从一个器官上移开，可能使它压到下一个器官上：重复直到不再有变化
    // moving the bowel off one organ can bring it onto the next: repeat until nothing changes
    for (let pass = 0; pass < 4; pass++) {
    const done = shifts.length
    for (const [name, re] of [['left adnexa', /^Left ovary$|left uterine tube|left fallopian tube/i], ['right adnexa', /^Right ovary$|right uterine tube|right fallopian tube/i], ['uterus', GROUPS[0]![1]]] as [string, RegExp][]) {
      const members = female.filter(isGroup(re))
      if (!members.length) continue
      const pts = concat(members.map((p) => samplesOf(p.mesh, 0.002)))
      const c = [0, 0, 0]
      for (let i = 0; i < pts.length; i++) c[i % 3] = c[i % 3]! + pts[i]! / (pts.length / 3)
      let ro = 0
      for (let i = 0; i < pts.length; i += 3) ro = Math.max(ro, Math.hypot(pts[i]! - c[0]!, pts[i + 1]! - c[1]!, pts[i + 2]! - c[2]!))
      for (const container of bowel()) {
        const tester = () => new InsideTester(container.mesh, 96)
        const before = tester().fractionInside(pts)
        if (before < 0.03) continue
        // 往哪个方向？尝试各水平方向、向上以及它们之间的斜向；对每个方向，逐步增大位移直到
        // 器官位于管外，并按肠管需要移动多远、最终有多少落入她的骨或膀胱来打分。代价最小者胜出。
        // Which way? Try the horizontal directions, upwards and the diagonals between; for each,
        // grow the shift until the organ is outside, and score it by how far the bowel had to
        // move and how much of it ends up in her bones or bladder. The cheapest wins.
        const sigma = ro + 0.03
        const movedBy = (arr: Float32Array, d: number[], sft: number) => {
          const out = Float32Array.from(arr)
          for (let i = 0; i < out.length; i += 3) {
            const w = Math.exp(-((out[i]! - c[0]!) ** 2 + (out[i + 1]! - c[1]!) ** 2 + (out[i + 2]! - c[2]!) ** 2) / (2 * sigma * sigma))
            out[i] = out[i]! + d[0]! * sft * w
            out[i + 1] = out[i + 1]! + d[1]! * sft * w
            out[i + 2] = out[i + 2]! + d[2]! * sft * w
          }
          return out
        }
        const dirs: number[][] = []
        for (let a8 = 0; a8 < 8; a8++) {
          const ang = (a8 * Math.PI) / 4
          dirs.push([Math.cos(ang), 0, Math.sin(ang)], [Math.cos(ang) * 0.7, 0.7, Math.sin(ang) * 0.7])
        }
        dirs.push([0, 1, 0])
        const obstacles = pelvicObstacles
        let best: { d: number[]; shift: number; after: number; cost: number; inBone: number } | null = null
        for (const d of dirs) {
          let shift = 0
          let after = before
          while (after > 0.01 && shift < 0.06) {
            shift += 0.004
            after = new InsideTester({ positions: movedBy(container.mesh.positions, d, shift), indices: container.mesh.indices }, 96).fractionInside(pts)
          }
          const trial: Mesh = { positions: movedBy(container.mesh.positions, d, shift), indices: container.mesh.indices }
          const sp = samplesOf(trial, 0.004)
          let inBone = 0
          for (const o of obstacles) inBone += o.fractionInside(sp)
          const cost = shift + 0.5 * inBone + 0.2 * after
          if (!best || cost < best.cost) best = { d, shift, after, cost, inBone }
        }
        const d = best!.d
        const shift = best!.shift
        const after = best!.after
        const moved = (arr: Float32Array, sft: number) => movedBy(arr, d, sft)
        for (const p of bowelAll()) {
          p.mesh = { positions: moved(p.mesh.positions, shift), indices: p.mesh.indices }
        }
        // 挂在肠管上的结构随它一起移动：结肠血管和直肠血管及其淋巴结
        // what hangs on the bowel moves with it: colic and rectal vessels, their nodes
        for (const p of parts) {
          if (p.provenance !== 'warped' || p.system === 'digestive') continue
          if (!/colic|sigmoid|rectal|mesenteric|colon/i.test(p.name)) continue
          p.mesh = { positions: moved(p.mesh.positions, shift), indices: p.mesh.indices }
          if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: moved(l.points, shift), radius: l.radius }))
        }
        shifts.push({ organ: name, bowel: container.name, insideBefore: round(before, 3), insideAfter: round(after, 3), shiftMm: round(shift * 1000, 0), direction: d.map((v) => round(v, 2)), bowelInBoneOrBladder: round(best!.inBone, 3) })
      }
    }
    if (shifts.length === done) break
    }
    collisions.bowelShifts = shifts
    const solids: ExistingPart[] = female.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: 'bone' as TissueId }))
    const field = new SurfaceField(solids)
    const fb = solids.reduce((b, s) => [Math.min(b[0]!, s.stats.bbox[0]), Math.min(b[1]!, s.stats.bbox[1]), Math.min(b[2]!, s.stats.bbox[2]), Math.max(b[3]!, s.stats.bbox[3]), Math.max(b[4]!, s.stats.bbox[4]), Math.max(b[5]!, s.stats.bbox[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    // 先腾出空间：男性盆腔中，她的子宫和卵巢所在之处是肠管。每个器官附近的形变部件沿径向
    // 移出包围该器官的椭球（半轴 = 包围盒的一半 + 3 mm）；位移在 1.7 倍半轴处衰减到零，
    // 所以不会撕裂。
    // Make room first: the male pelvis has bowel where her uterus and ovaries are. Warped parts
    // near each organ are moved radially out of an ellipsoid around it (semi-axes = half its
    // bounds + 3 mm); the displacement fades to zero at 1.7 semi-axes, so nothing tears.
    const groups: { name: string; members: FPart[] }[] = [
      { name: 'uterus', members: female.filter((p) => /uterus|cervix|cornua|cervical os|uterine segment/i.test(p.name) && !/tube|ligament/i.test(p.name)) },
      { name: 'left ovary', members: female.filter((p) => p.id === 'HRA_left_ovary') },
      { name: 'right ovary', members: female.filter((p) => p.id === 'HRA_right_ovary') },
    ]
    const roomFor: Record<string, number> = {}
    for (const g of groups) {
      if (!g.members.length) continue
      const b = g.members.map((p) => measure(p.mesh).bbox).reduce((a, c) => [Math.min(a[0]!, c[0]), Math.min(a[1]!, c[1]), Math.min(a[2]!, c[2]), Math.max(a[3]!, c[3]), Math.max(a[4]!, c[4]), Math.max(a[5]!, c[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
      const c = [(b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2]
      const r = [(b[3]! - b[0]!) / 2 + 0.003, (b[4]! - b[1]!) / 2 + 0.003, (b[5]! - b[2]!) / 2 + 0.003]
      const OUTER = 1.7
      let movedParts = 0
      for (const p of parts) {
        if (p.provenance !== 'warped' || p.tissue === 'skin' || HARD_TISSUES.includes(p.tissue) || p.tissue === 'muscle') continue
        const pos = p.mesh.positions
        let out: Float32Array | null = null
        const moveAll = (arr: Float32Array): Float32Array | null => {
          let res: Float32Array | null = null
          for (let i = 0; i < arr.length; i += 3) {
            const d = [(arr[i]! - c[0]!) / r[0]!, (arr[i + 1]! - c[1]!) / r[1]!, (arr[i + 2]! - c[2]!) / r[2]!]
            const rho = Math.hypot(d[0]!, d[1]!, d[2]!)
            if (rho >= OUTER || rho < 1e-6) continue
            // 单调映射 [0, OUTER] → [1.05, OUTER]
            // monotone map [0, OUTER] → [1.05, OUTER]
            const k = (1.05 + (rho * (OUTER - 1.05)) / OUTER) / rho
            if (!res) res = Float32Array.from(arr)
            res[i] = c[0]! + d[0]! * k * r[0]!
            res[i + 1] = c[1]! + d[1]! * k * r[1]!
            res[i + 2] = c[2]! + d[2]! * k * r[2]!
          }
          return res
        }
        out = moveAll(pos)
        if (out) {
          p.mesh = { positions: out, indices: p.mesh.indices }
          movedParts++
        }
        if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: moveAll(l.points) ?? l.points, radius: l.radius }))
      }
      roomFor[g.name] = movedParts
    }
    collisions.roomMade = roomFor
    // 结肠必须仍是一条位置合理、形状合理的管
    // the colon must still be a sensible tube somewhere sensible
    {
      const col = colon()
      const afterColon = Object.fromEntries(GROUPS.map(([n, re]) => [n, round(measureGroup(re, col), 3)]))
      const afterBladder = Object.fromEntries(GROUPS.map(([n, re]) => [n, round(measureGroup(re, bladder), 3)]))
      let inBone = 0
      let inBladder = 0
      if (col) {
        const pts = samplesOf(col.mesh, 0.004)
        const bones = parts.filter((p) => p.provenance === 'scanned' && p.tissue === 'bone' && /hip bone|Sacrum|lumbar|femur/i.test(p.name))
        for (const b of bones) inBone += new InsideTester(b.mesh, 64).fractionInside(pts)
        if (bladder) inBladder = insideOf(bladder.mesh, col.mesh)
      }
      const vol = col ? Math.abs(measure(col.mesh).signedVolume) : 0
      collisions.pelvis = { insideDescendingColon: { before: beforeColon, after: afterColon }, insideBladder: { before: beforeBladder, after: afterBladder }, colon: { volumeMlBefore: round(colonVolumeBefore * 1e6, 1), volumeMlAfter: round(vol * 1e6, 1), surfaceInsideBone: round(inBone, 4), surfaceInsideBladder: round(inBladder, 4) } }
      console.log(`\nPelvis: HRA genital set moved ${mm(nudge)} mm posteriorly off her scanned bladder; bowel shifts ${JSON.stringify(shifts)}`)
      console.log(`  share of surface inside the warped descending/sigmoid colon, before → after: ${GROUPS.map(([n]) => `${n} ${(beforeColon[n]! * 100).toFixed(0)}% → ${(afterColon[n]! * 100).toFixed(0)}%`).join(', ')}`)
      console.log(`  share of surface inside her scanned bladder, before → after: ${GROUPS.map(([n]) => `${n} ${(beforeBladder[n]! * 100).toFixed(0)}% → ${(afterBladder[n]! * 100).toFixed(0)}%`).join(', ')}`)
      console.log(`  colon after the shift: volume ${(colonVolumeBefore * 1e6).toFixed(0)} → ${(vol * 1e6).toFixed(0)} ml, ${(inBone * 100).toFixed(1)}% of its surface inside her pelvic bones, ${(inBladder * 100).toFixed(1)}% inside her bladder`)
    }
    const rows: { name: string; before: number; after: number; movable: boolean }[] = []
    for (const p of parts) {
      if (p.provenance === 'curated' || p.tissue === 'skin' || HARD_TISSUES.includes(p.tissue) || p.tissue === 'nerve') continue
      const st = measure(p.mesh)
      if (st.bbox[0] > fb[3]! || st.bbox[3] < fb[0]! || st.bbox[1] > fb[4]! || st.bbox[4] < fb[1]! || st.bbox[2] > fb[5]! || st.bbox[5] < fb[2]!) continue
      const frac = (m: Mesh) => overlapWith(samplesOf(m, 0.003), measure(m).bbox, field, 0.002, 0.004, () => true).insideAny
      const before = frac(p.mesh)
      if (before < 0.005) continue
      // 她自己扫描得到的器官（膀胱）不改变形状；形变后的男性部件则会
      // her own scanned organs (bladder) are not reshaped; warped male parts are
      const movable = p.provenance === 'warped'
      if (movable) p.mesh = { positions: pushOutOfSolids(p.mesh.positions, st.bbox, field, () => true, { clearance: 0.0005, maxPush: 0.03, radius: 0.012, step: 0.0005 }).positions, indices: p.mesh.indices }
      rows.push({ name: p.name, before, after: movable ? frac(p.mesh) : before, movable })
    }
    rows.sort((a, b) => b.before - a.before)
    console.log(`\nFemale pelvic organs (HRA) against other parts: ${rows.length} parts had surface inside the uterus, vagina, tubes or ovaries; warped ones were slid out (≤ 30 mm)`)
    for (const r of rows.slice(0, 14)) console.log(`  ${pad(r.name, 44)}${(r.before * 100).toFixed(1)}% → ${(r.after * 100).toFixed(1)}%${r.movable ? '' : '  (her scanned part: not moved)'}`)
    for (const [k, v] of Object.entries(collisions)) console.log(`  ${k}: ${JSON.stringify(v)}`)
    collisions.pelvicViscera = rows.map((r) => ({ ...r, before: round(r.before, 4), after: round(r.after, 4) }))
    // (3) 泌尿生殖裂孔：男性的肛提肌、直肠和盆腔血管神经里没有阴道的位置。围绕阴道建立一个径向通道场
    // （见 pelvis.ts），把这些形变来的男性结构推到阴道表面 2 mm 之外；她扫描得到的膀胱不动。
    // 肌的体积、裂孔的横径和前后径、阴道的长度和轴向都写入报告。这是为了几何上自洽而做的构造，不是测量。
    // (3) Urogenital hiatus: the male levator ani, rectum and pelvic vessels and nerves leave no room
    // for a vagina. A radial tunnel field round the vagina (see pelvis.ts) moves these warped male
    // structures to 2 mm outside the vaginal surface; her scanned bladder is not touched. Muscle
    // volumes, the transverse and anteroposterior size of the hiatus and the length and direction of
    // the vagina go into the report. This is a construction for geometric consistency, not a measurement.
    {
      const vagina = parts.find((p) => p.name === 'Vagina' && p.provenance === 'curated')
      if (vagina && !process.env.SOMA_NO_HIATUS) {
        const NEIGHBOURS = /puborectalis|pubococcygeus|iliococcygeus|coccygeus|External anal sphincter|Tendinous arch of levator ani|^Rectum$|^Urinary bladder$/
        const pair = () => {
          const pts = samplesOf(vagina.mesh, 0.002)
          const out: Record<string, number> = {}
          for (const p of parts) if (NEIGHBOURS.test(p.name)) out[p.name] = round((out[p.name] ?? 0) + new InsideTester(p.mesh, 96).fractionInside(pts), 4)
          return out
        }
        const vol = () => Object.fromEntries(parts.filter((p) => NEIGHBOURS.test(p.name) && p.name !== 'Urinary bladder').map((p) => [`${p.name} (${p.id})`, round(Math.abs(measure(p.mesh).signedVolume) * 1e6, 1)]))
        const insideBefore = pair()
        const volBefore = vol()
        // 阴道前壁与她的膀胱：膀胱是她自己的、不动；阴道是美术模型，把陷入膀胱的那部分壁面沿最近的出口方向推出（留 1.5 mm 间隙）
        // anterior vaginal wall against her bladder: the bladder is hers and stays; the vagina is an artist's model, and the part of its wall sunk into the bladder is slid out along the nearest way out (1.5 mm gap)
        const bladderPart = parts.find((p) => p.name === 'Urinary bladder')
        let vaginaReshapedMm = 0
        if (bladderPart) {
          const bf = new SurfaceField([{ id: bladderPart.id, fma: bladderPart.fma, name: bladderPart.name, mesh: bladderPart.mesh, stats: measure(bladderPart.mesh), system: bladderPart.system, tissue: bladderPart.tissue }])
          for (const p of parts) {
            if (p.provenance !== 'curated' || !/^Vagina$|Cervicovaginal junction/.test(p.name)) continue
            const res = pushOutOfSolids(p.mesh.positions, measure(p.mesh).bbox, bf, () => true, { clearance: 0.0015, maxPush: 0.012, radius: 0.012, step: 0.0005 })
            for (let i = 0; i < res.positions.length; i += 3) vaginaReshapedMm = Math.max(vaginaReshapedMm, Math.hypot(res.positions[i]! - p.mesh.positions[i]!, res.positions[i + 1]! - p.mesh.positions[i + 1]!, res.positions[i + 2]! - p.mesh.positions[i + 2]!) * 1000)
            p.mesh = { positions: res.positions, indices: p.mesh.indices }
          }
        }
        const tunnel = buildTunnel(vagina.mesh, HIATUS_CLEARANCE)
        const vb = measure(vagina.mesh).bbox
        let moved = 0
        let maxMove = 0
        for (const p of parts) {
          // 只动形变来的男性软组织；她自己的部件（膀胱）、HRA 器官、骨和皮肤不动
          // only warped male soft tissue moves; her own parts (bladder), the HRA organs, bones and skin stay
          if (!p.id.startsWith('W_') || HARD_TISSUES.includes(p.tissue) || p.tissue === 'skin' || isFatPart(p.id)) continue
          const b = measure(p.mesh).bbox
          if (b[0] > vb[3] + 0.03 || b[3] < vb[0] - 0.03 || b[1] > vb[4] + 0.03 || b[4] < vb[1] - 0.03 || b[2] > vb[5] + 0.03 || b[5] < vb[2] - 0.03) continue
          // 分侧的肛提肌各部只向自己一侧让开（否则越过中线的那一块会被撑成一个套住阴道的环）
          // the sided parts of levator ani give way to their own side only (a part lying across the midline would otherwise be blown up into a ring round the vagina)
          const sided = /^(Left|Right) (puborectalis|pubococcygeus|iliococcygeus|coccygeus)$/.exec(p.name)
          const move = (q: Float32Array) => (sided ? tunnel.applyLateral(q, sided[1] === 'Left' ? 1 : -1) : tunnel.apply(q))
          const out = move(p.mesh.positions)
          let d = 0
          for (let i = 0; i < out.length; i += 3) d = Math.max(d, Math.hypot(out[i]! - p.mesh.positions[i]!, out[i + 1]! - p.mesh.positions[i + 1]!, out[i + 2]! - p.mesh.positions[i + 2]!))
          if (d < 1e-5) continue
          p.mesh = { positions: out, indices: p.mesh.indices }
          if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: move(l.points), radius: l.radius }))
          moved++
          maxMove = Math.max(maxMove, d)
        }
        // 裂孔尺寸：在阴道下 40 % 的高度范围内，左右肛提肌内侧缘之间的横径；耻骨联合后缘到直肠前壁的前后径
        // hiatus size: within the height of the lower 40 % of the vagina, the transverse distance between the medial borders of the left and right levator parts; anteroposterior from the back of the pubic symphysis to the anterior wall of the rectum
        const y0 = vb[1]
        const y1 = vb[1] + 0.4 * (vb[4] - vb[1])
        const ext = (rx: RegExp, k: number, pick: (a: number, b: number) => number, start: number, keep: (x: number) => boolean = () => true) => {
          let v = start
          for (const p of parts) {
            if (!rx.test(p.name)) continue
            const q = p.mesh.positions
            for (let i = 0; i < q.length; i += 3) if (q[i + 1]! >= y0 && q[i + 1]! <= y1 && keep(q[i]!)) v = pick(v, q[i + k]!)
          }
          return v
        }
        const xL = ext(/^Left (puborectalis|pubococcygeus)$/, 0, Math.min, Infinity)
        const xR = ext(/^Right (puborectalis|pubococcygeus)$/, 0, Math.max, -Infinity)
        const zPubis = ext(/hip bone$/, 2, Math.min, Infinity, (x) => Math.abs(x) < 0.012)
        const zRectum = ext(/^Rectum$/, 2, Math.max, -Infinity)
        const a = tunnel.axis
        const row = {
          clearanceMm: HIATUS_CLEARANCE * 1000,
          vaginalWallMovedOffBladderMm: round(vaginaReshapedMm, 1),
          vaginaInside: { before: insideBefore, after: pair() },
          volumesMl: { before: volBefore, after: vol() },
          partsMoved: moved,
          maxDisplacementMm: round(maxMove * 1000, 1),
          hiatus: { transverseMm: Number.isFinite(xL - xR) ? round((xL - xR) * 1000, 1) : null, pubisToRectumMm: Number.isFinite(zPubis - zRectum) ? round((zPubis - zRectum) * 1000, 1) : null, levelMm: [round(y0 * 1000, 0), round(y1 * 1000, 0)] },
          vagina: { lengthMm: round(tunnel.length * 1000, 1), axisToHorizontalDeg: round((Math.atan2(Math.abs(a[1]), Math.hypot(a[0], a[2])) * 180) / Math.PI, 1), upperEndIsPosterior: a[2] < 0 },
          norms: 'not opened in this work (assumptions from memory, to be verified): vaginal length about 6–9 cm; levator hiatus at rest in nulliparous women about 3.5–4.5 cm transverse and 4.5–5.5 cm anteroposterior',
        }
        console.log(`\nUrogenital hiatus: ${moved} warped parts moved off the vagina (≤ ${mm(maxMove)} mm, clearance ${HIATUS_CLEARANCE * 1000} mm); vagina surface inside neighbours before → after: ${Object.keys(insideBefore).map((k) => `${k} ${(insideBefore[k]! * 100).toFixed(1)}% → ${(row.vaginaInside.after[k]! * 100).toFixed(1)}%`).join(', ')}`)
        console.log(`  hiatus ${JSON.stringify(row.hiatus)}; vagina ${JSON.stringify(row.vagina)}; volumes ml ${Object.keys(volBefore).map((k) => `${k} ${volBefore[k]} → ${row.volumesMl.after[k]}`).join(', ')}`)
        collisions.hiatus = row
      }
    }
    // 反过来也要看：之后子宫有多少位于其他软组织器官内
    // and the other way round: how much of the uterus is inside other soft organs afterwards
    const others: ExistingPart[] = parts.filter((p) => p.provenance !== 'curated' && SOLID_TISSUES.includes(p.tissue)).map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: p.tissue }))
    const near = others.filter((o) => !(o.stats.bbox[0] > fb[3]! || o.stats.bbox[3] < fb[0]! || o.stats.bbox[1] > fb[4]! || o.stats.bbox[4] < fb[1]! || o.stats.bbox[2] > fb[5]! || o.stats.bbox[5] < fb[2]!))
    const of = new SurfaceField(near)
    const uterine: Record<string, unknown> = {}
    for (const p of female) {
      const ov = overlapWith(samplesOf(p.mesh, 0.002), measure(p.mesh).bbox, of, 0.002, 0.004, () => true)
      if (ov.insideAny > 0.02) uterine[p.name] = { inside: round(ov.insideAny, 3), in: [...ov.inside].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, f]) => `${near[i]!.name} ${(f * 100).toFixed(0)}%`) }
    }
    console.log(`  HRA organs still inside other solids (> 2% of surface): ${Object.entries(uterine).map(([k, v]) => `${k} ${((v as { inside: number }).inside * 100).toFixed(0)}% (${(v as { in: string[] }).in.join(', ')})`).join('; ') || 'none'}`)
    collisions.hraInsideOthers = uterine
    report.collisions = collisions
  }
  lap('sex-specific collisions')

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
  {
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

  // ── 5e. 外部皮肤包：与本次内部结构匹配时装入，替换占位皮肤（见 skinPackage.ts）
  // ── 5e. External skin package: installed when it matches these internals, replacing the placeholder skin (see skinPackage.ts)
  let installedSkin: SkinPackage | null = null
  {
    const key = internalsKey(parts.filter((p) => p.tissue === 'bone').map((p) => ({ name: p.name, bbox: measure(p.mesh).bbox })))
    const pkg = loadSkinPackage(join(ROOT, SKIN_PACKAGE_DIR))
    const skin = parts.find((p) => p.name === 'Skin' && p.tissue === 'skin')
    const deepOf = () => parts.filter((p) => FAT_DEEP_TISSUES.has(p.tissue) && p.system !== 'integumentary').map((p) => ({ name: p.name, mesh: p.mesh }))
    const row: Record<string, unknown> = { dir: SKIN_PACKAGE_DIR, internalsKey: key, present: !!pkg, fittedTo: pkg?.fittedTo ?? null, installed: false }
    if (pkg && skin && pkg.fittedTo?.body === 'female' && pkg.fittedTo.key === key) {
      skin.mesh = pkg.mesh
      skin.id = EXTERNAL_SKIN_ID
      skin.provenance = 'curated'
      skin.source = pkg.source.name
      skin.keepGeometry = true
      skin.note = 'external skin package fitted to these internals'
      installedSkin = pkg
      const fit = checkSkinFit(pkg.mesh, deepOf())
      Object.assign(row, { installed: true, triangles: pkg.mesh.indices.length / 3, fit })
      console.log(`\nSkin package ${SKIN_PACKAGE_DIR} installed (${pkg.source.name}, ${pkg.mesh.indices.length / 3} triangles, ${fit.closed ? 'closed' : 'NOT closed'}); deep-part surface outside the skin ${(fit.outside * 100).toFixed(1)}% (${(fit.outside5mm * 100).toFixed(1)}% by more than 5 mm); worst: ${fit.worst.slice(0, 5).map((w) => `${w.name} ${(w.outside * 100).toFixed(0)}%`).join(', ') || '-'}`)
    } else {
      row.reason = !pkg ? 'no package' : !pkg.fittedTo ? 'the package does not say which internals it was fitted to (manifest.fittedTo missing)' : 'fitted to other internals'
      console.log(`\nSkin: placeholder kept (${row.reason}); a skin package for these internals must carry "fittedTo": {"body": "female", "key": "${key}"} in its manifest.json`)
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
      console.log(`\nSubcutaneous fat (derived on her body): volume inside the skin ${(fat.bodyVolume * 1000).toFixed(1)} l, fat ${(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000).toFixed(1)} l`)
      for (const r of rows) {
        const t = r.thicknessMm as Record<string, number>
        console.log(`  ${pad(r.name as string, 44)}${pad(`${r.volumeMl} ml`, 10)}thickness p10 ${t.p10} / median ${t.median} / p90 ${t.p90} / max ${t.max} mm; fat under ${((r.skinCovered as number) * 100).toFixed(0)}% of the region's skin`)
      }
      report.fat = { options: FAT_OPTIONS, bodyVolumeL: round(fat.bodyVolume * 1000, 1), fatVolumeL: round(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000, 1), regions: rows }
      lap('subcutaneous fat')
    }
  }

  // ── 6. 最终几何 / 6. Final geometry ───────────────────────────────────────────────────────────────────────
  const final: { p: FPart; mesh: Mesh; stats: MeshStats }[] = []
  let trianglesIn = 0
  for (const p of parts) {
    let mesh = p.mesh
    trianglesIn += mesh.indices.length / 3
    if (!p.keepGeometry) {
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
  const envelopes = new Set(adj.neighbours.map((l, i) => (l.length > ADJACENCY.maxDegree || isFatPart(final[i]!.p.id) ? i : -1)).filter((i) => i >= 0))
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
  for (const p of parts) {
    if (p.male) continue
    if (p.id === 'VF_vertebrae_L1') {
      const own: [string, string][] = [[p.fma, 'supernumerary lumbar vertebra (first of six)']]
      isaExtras.push({ part: p.id, path: own, anchor: input.lumbarConcept })
      partOfExtras.push({ part: p.id, path: own, anchor: partOfByName('vertebral column') ?? partOfByName('skeletal system') })
      continue
    }
    // HRA 器官 / HRA
    const fallback = (p.tissue === 'cartilage' ? fallbackIsa('articular cartilage') : p.tissue === 'ligament' ? fallbackIsa('ligament') : null) ?? fallbackIsa(p.tissue === 'artery' ? 'artery' : p.tissue === 'vein' ? 'vein' : 'anatomical structure')
    let tp
    const lower = p.name[0]!.toLowerCase() + p.name.slice(1)
    const sidedOf = /^(.*)_[LR]$/.exec(p.fma)
    const base = sidedOf ? sidedOf[1]! : p.fma
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
    const uterus = byName('Body of uterus') ?? parts.find((p) => /uterus/i.test(p.name) && p.provenance === 'curated')!
    const u = measure(uterus.mesh).centroid
    const bladder = cz('Urinary bladder')
    const rectum = cz('Rectum')
    sexChecks.uterusBetweenBladderAndRectum = { pass: bladder[2] > u[2] && u[2] > rectum[2], zMm: { bladder: round(bladder[2] * 1000, 1), uterus: round(u[2] * 1000, 1), rectum: round(rectum[2] * 1000, 1) }, bladderIs: byName('Urinary bladder')!.provenance, rectumIs: byName('Rectum')!.provenance }
    const hips = ['Left hip bone', 'Right hip bone'].map((n) => measure(byName(n)!.mesh).bbox)
    const sac = measure(byName('Sacrum')!.mesh).bbox
    for (const side of ['left', 'right']) {
      const o = measure(parts.find((p) => p.id === `HRA_${side}_ovary`)!.mesh).centroid
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

  const overlaps = Object.entries((report.collisions as { hraInsideOthers: Record<string, { inside: number; in: string[] }> }).hraInsideOthers).filter(([, v]) => v.inside > 0.05).map(([k, v]) => `${k} ${(v.inside * 100).toFixed(0)}% (${v.in[0]!.replace(/ \d+%$/, '')})`)
  const nWarped = count((p) => p.provenance === 'warped')
  const nOwn = count((p) => p.source === SOURCE_VHF.name || p.source === SOURCE_DENVER.name)
  const nMale = count((p) => p.id.startsWith('W_') && !isFatPart(p.id))
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
      en: 'The arrangement of the pelvic organs is constructed, not measured: a passage for the vagina was opened in the male-derived levator ani by moving its medial borders sideways (the right puborectalis lost about a third of its volume in the process), the rectum and nearby vessels and nerves were moved off the vagina, and the anterior vaginal wall was reshaped against the bladder; the vagina still overlaps the bladder slightly. There is no female urethra, perineal body, perineal muscle or external genitalia.',
      zh: '盆腔器官的排列是构造出来的，不是测量所得：在由男性形变来的肛提肌上，把内侧缘向两侧推开，为阴道开出通道（右侧耻骨直肠肌因此损失约三分之一体积）；直肠及附近的血管神经被推离阴道，阴道前壁按膀胱重新塑形，但阴道与膀胱仍有少量重叠。没有女性尿道、会阴体、会阴肌和外生殖器。',
    },
    {
      en: 'Pelvic soft tissue is not female anatomy: the uterus, ovaries, tubes and vagina are artist-modelled (Human Reference Atlas), while the bowel, vessels, nerves and pelvic floor around them are male structures moved aside. The sigmoid colon was shifted up to 5 cm to clear the uterus and left ovary' + (overlaps.length ? `; still overlapping: ${overlaps.join(', ')}.` : '.'),
      zh: '盆腔软组织并非真实的女性解剖：子宫、卵巢、输卵管和阴道为美术建模（Human Reference Atlas），其周围的肠管、血管、神经和盆底肌则是被推移开的男性结构。乙状结肠为避让子宫和左卵巢被移动了最多约 5 cm' + (overlaps.length ? `；目前仍有重叠：${overlaps.join('、')}。` : '。'),
    },
    {
      en: installedSkin
        ? `The body surface is a parametric model skin (${(installedSkin as SkinPackage).source.name}) fitted to this skeleton and muscle envelope; it is not a scan. The breasts inside it are a standing-shape artist model.`
        : 'The body surface is a PLACEHOLDER: male skin deformed to this skeleton and raised into a smooth envelope over the breasts. It still carries male external genitalia and does not show female body shape or fat distribution; a standard female skin is to replace it. The breasts themselves are a standing-shape artist model.',
      zh: installedSkin
        ? `体表是按这副骨架和肌肉包络拟合的参数化模型皮肤（${(installedSkin as SkinPackage).source.name}），不是扫描所得。其内的乳房是站立位形态的美术模型。`
        : '体表是占位用的：男性皮肤按这副骨架形变后，再在乳房处抬高成平滑包络，仍带有男性外生殖器，并不反映女性的体形和脂肪分布，之后将换成标准女性皮肤。乳房本身是站立位形态的美术模型。',
    },
    ...(parts.some((p) => isFatPart(p.id)) ? [{
      zh: '皮下脂肪层是在上述合成体表与她的肌肉、骨骼、器官外包络之间按 3 mm 体素填充得到的（最深只算到皮下 3 cm），并非扫描所得；其厚度取决于合成的皮肤，不代表女性真实的脂肪分布。',
      en: 'The subcutaneous fat layer fills the gap between that synthetic body surface and the outer envelope of her muscles, bones and organs at 3 mm voxels (no deeper than 3 cm below the skin); it is not scanned, and its thickness follows the synthetic skin rather than a real female fat distribution.',
    }] : []),
    {
      en: 'Missing: external genitalia and perineum, female urethra, ovarian and vaginal vessels. Male-only parts (prostate, testes, penis, seminal vesicles, testicular vessels, male urethra) were removed, not replaced.',
      zh: '缺失：外生殖器和会阴、女性尿道、卵巢血管和阴道血管。男性特有结构（前列腺、睾丸、阴茎、精囊、睾丸血管、男性尿道）已删除，但未以对应的女性结构替代。',
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
    sources: [...male.data.sources.filter((s) => usedSources.has(s.name)), SOURCE_VHF, ...(usedSources.has(SOURCE_DENVER.name) ? [SOURCE_DENVER] : []), SOURCE_HRA, ...(installedSkin ? [(installedSkin as SkinPackage).source] : [])],
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
