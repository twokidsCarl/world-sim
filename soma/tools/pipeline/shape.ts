// 体形重塑：把软的深部结构（肌、腱、筋膜、血管、神经、淋巴结、形变来的内脏）用一个平滑位移场
// 收进“深层包络”之内。深层包络 = 目标体表（按标准女性体型生成的参数化皮肤）向内减去该处应有的
// 皮下脂肪和皮肤厚度；肌、腱、骨和器官应当都在它里面。
//
// 与 slim.ts 的区别：slim 让软组织朝最近的骨面各向同性地收拢，只能变细；这里的位移是有方向的——
// 包络之外的表面被推进去，同一部位里包络之内还有空余的地方，最外层的肌被等量地拉出来，
// 于是一组肌可以绕着骨整体挪一个位置，而不只是被压扁。
//
// 位移场的构成（每一轮）：
//   零锚点   骨、软骨、牙和其他不许动的部件（韧带、Wu 的盆底、CT/HRA 的内脏）的表面：位移为 0
//   推入     可动的深部软组织表面上，位于“包络内 margin”以外的采样点：移到包络内 margin 处；
//            朝骨方向的压缩有上限（到骨的深度不低于原来的 minDepthShare）
//   拉出     最外层的肌表面上、离包络还有空余的采样点：朝包络移动，幅度按部位配平——
//            一个部位拉出的总量不超过它被推入的总量
//   贴骨处   离骨面不到 attachDistance 的采样点（附着端）：位移为 0
// 这些条件之间的位移由体素网格上的调和插值给出（每个分量解 ∇²u = 0）：零锚点是硬约束，推和拉是
// 带权的软约束，网格之外按零梯度延伸。于是从体表到骨之间位移线性过渡，压缩均匀地分摊在整个深度上。
// 试过 register.ts 的 buildTwoLevelDeformation（核回归）：锚点之间隔着几厘米的肌腹时，它在两组
// 锚点的中间面上突然换值，空间发生折叠（4 万个采样点里 509 个雅可比行列式 ≤ 0，最小 −1.2），所以没有用它。
// 推和拉的锚点可以镜像到对侧（两侧骨性条件相近的地方），使左右的位移大体对称。做 2 轮，后一轮按前一轮的结果重算。
// 骨、软骨、韧带和其他不许动的部件不经过这个场；它们在包络之外的比例只报告，不处理。
// 淋巴结不变形：每个结按其质心处的位移整体平移，也不参与决定位移场。
// 体积下限（可选）：调用方可以给一部分肌各一个参考体积（女性体形里是“性别比 × 男性原肌的体积”）；
// 这些肌按部位合计，本步之后不低于参考体积之和——为此按部位标定压缩上限 minDepthShare。包络之外还剩多少，如实报告。
//
// Body-shape stage: brings the soft deep parts (muscles, tendons, fasciae, vessels, nerves, lymph
// nodes, warped viscera) inside the "deep envelope" with one smooth displacement field. The deep
// envelope is the target body surface (a parametric skin generated for a standard female build)
// moved in by the subcutaneous fat and skin that belong at each place; muscle, tendon, bone and
// organs should all lie inside it.
//
// How it differs from slim.ts: slimming draws soft tissue isotropically towards the nearest bone
// surface and can only make things thinner. Here the displacement is directional — surfaces outside
// the envelope are pushed in, and where the same region still has room inside the envelope the
// outermost muscles are pulled out by an equal amount, so a muscle group can shift round its bone as
// a whole instead of only being squeezed.
//
// What the field is made of (each pass):
//   zero anchors  surfaces of bone, cartilage, teeth and the other parts that must not move
//                 (ligaments, the Wu pelvic floor, CT/HRA viscera): displacement 0
//   push          samples on movable deep soft tissue that lie beyond "margin inside the envelope":
//                 moved to margin inside it; compression towards bone is capped (depth over bone
//                 never falls below minDepthShare of the original)
//   pull          samples on the outermost muscle surface that still have room under the envelope:
//                 moved towards it, balanced per region — a region is never pulled out by more than
//                 it is pushed in
//   on bone       samples closer than attachDistance to bone (attachment ends): displacement 0
// Between these conditions the displacement is the harmonic interpolant on a voxel grid (∇²u = 0 for
// each component): zero anchors are hard constraints, pushes and pulls weighted soft ones, and the
// field continues with zero gradient beyond the grid's support. The displacement therefore ramps
// linearly from the body surface to the bone, and the compression is spread evenly over the whole
// depth. buildTwoLevelDeformation of register.ts (kernel regression) was tried first: where
// centimetres of muscle belly separate two sets of anchors it switches value abruptly on the surface
// midway between them and folds space (509 of 40,000 samples with a Jacobian determinant ≤ 0, minimum
// −1.2), so it is not used. Push and pull anchors can be mirrored to the other side (where the bony
// conditions of both sides are alike), which makes the displacement roughly symmetric. Two passes,
// the second computed on the result of the first. Bone, cartilage, ligaments and the other fixed
// parts never pass through the field; their share outside the envelope is reported, not treated.
// Lymph nodes do not deform: each node is translated whole by the displacement at its centroid, and
// they do not drive the field.
// Volume floor (optional): the caller may give some muscles a reference volume each (for the female
// body: sex ratio × the volume of the male muscle); summed per region these muscles keep at least
// the sum of their references after the stage — the compression cap minDepthShare is calibrated per
// region to that end. What then remains outside the envelope is reported as it is.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeNormals, type Mesh } from './geometry.ts'
import { signedVolume } from './meshRepair.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'
import { parseSkinObj } from './skinPackage.ts'
import { jacobianStats } from './standard.ts'
import type { Polyline } from './tube.ts'

// ── 目标包 / the target package ────────────────────────────────────────────────────────────

export interface ShapeTarget {
  /** 深层包络：单层封闭曲面 / the deep envelope: a closed single-walled surface */
  envelope: Mesh
  /** 包声明它所依据的内部结构指纹；缺省表示未声明 / the internals fingerprint the package says it was made for; null when it does not say */
  basedOn: { body: string; key: string } | null
  /** deep-envelope.obj 的 SHA-1 前 16 位：报告里记下用的是哪一版包络 / first 16 hex digits of the SHA-1 of deep-envelope.obj: the report records which envelope was used */
  envelopeSha1: string
  manifest: Record<string, unknown>
}

/**
 * 读目标包（manifest.json + deep-envelope.obj）；目录或任一文件不存在时返回 null。
 * Reads a target package (manifest.json + deep-envelope.obj); null when the directory or either file is missing.
 */
export function loadShapeTarget(dir: string): ShapeTarget | null {
  const mf = join(dir, 'manifest.json')
  const obj = join(dir, 'deep-envelope.obj')
  if (!existsSync(mf) || !existsSync(obj)) return null
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as Record<string, unknown>
  const based = manifest.basedOn as { body?: string; key?: string } | undefined
  const text = readFileSync(obj, 'utf8')
  return { envelope: parseSkinObj(text), basedOn: based?.body && based.key ? { body: based.body, key: based.key } : null, envelopeSha1: createHash('sha1').update(text).digest('hex').slice(0, 16), manifest }
}

// ── 部位 / regions ─────────────────────────────────────────────────────────────────────────

export const SHAPE_REGIONS = ['head', 'neck', 'shoulder', 'chest', 'abdomen', 'pelvis', 'thigh', 'knee', 'calf', 'foot', 'upperArm', 'forearm', 'hand'] as const
export type ShapeRegion = (typeof SHAPE_REGIONS)[number]

/**
 * 骨（或软骨、牙）按名称归属的部位。喉软骨里有“楔状软骨”，要先于足的楔骨判断。
 * The region a bone (or cartilage, tooth) belongs to, by name. The larynx has a "cuneiform cartilage", which must be tested before the cuneiform bones of the foot.
 */
export function regionOfBone(name: string): ShapeRegion {
  if (/cervical|^Atlas$|^Axis$|disk of axis|hyoid|cricoid|thyroid cartilage|arytenoid|corniculate|cuneiform cartilage|epiglottis/i.test(name)) return 'neck'
  if (/metacarpal|finger|thumb|scaphoid|lunate|triquetr|pisiform|trapezi|trapezoid|capitate|hamate/i.test(name)) return 'hand'
  if (/\btoe\b|metatarsal|calcane|talus|cuboid|cuneiform|navicular|sesamoid/i.test(name)) return 'foot'
  if (/humerus/i.test(name)) return 'upperArm'
  if (/\bradius\b|\bulna\b/i.test(name)) return 'forearm'
  if (/patella|menisc|distal femur|tibial condyle/i.test(name)) return 'knee'
  if (/head of femur|acetabulum|hip bone|sacrum|coccyx/i.test(name)) return 'pelvis'
  if (/femur/i.test(name)) return 'thigh'
  if (/tibia|fibula/i.test(name)) return 'calf'
  if (/scapula|clavicle/i.test(name)) return 'shoulder'
  if (/lumbar/i.test(name)) return 'abdomen'
  if (/\brib\b|costal|sternum|manubrium|xiphoid|thoracic|intervertebral/i.test(name)) return 'chest'
  return 'head'
}

// 包络配对用的肢体分组：一个采样点只和“自己这条肢体”的包络表面配对，免得腋下的上臂被推进胸壁、
// 大腿内侧被推进另一条腿。
// Limb groups for matching against the envelope: a sample is only matched to the envelope surface of
// its own limb, so that the arm is not pushed into the chest wall at the axilla, nor a thigh into the other.
const CORE = 0
const GIRDLE = 1 // +0 左 / left, +1 右 / right
const ARM = 3
const LEG = 5
const groupOf = (region: ShapeRegion, name: string, left: boolean): number => {
  const s = left ? 0 : 1
  if (region === 'shoulder') return GIRDLE + s
  if (region === 'upperArm' || region === 'forearm' || region === 'hand') return ARM + s
  if (region === 'thigh' || region === 'knee' || region === 'calf' || region === 'foot') return LEG + s
  void name
  return CORE
}
const bit = (g: number) => 1 << g
/** 每个分组的采样点可以配对的包络分组 / the envelope groups a sample of each group may be matched to */
const ALLOWED: number[] = [
  bit(CORE) | bit(GIRDLE) | bit(GIRDLE + 1) | bit(LEG) | bit(LEG + 1),
  bit(CORE) | bit(GIRDLE) | bit(ARM),
  bit(CORE) | bit(GIRDLE + 1) | bit(ARM + 1),
  bit(ARM) | bit(GIRDLE),
  bit(ARM + 1) | bit(GIRDLE + 1),
  bit(LEG) | bit(CORE),
  bit(LEG + 1) | bit(CORE),
]

/**
 * 各部件表面到骨面距离的中位数（米）。用来分辨“跨在骨与骨之间的游离韧带”（腹股沟韧带、项韧带、骶结节韧带）
 * 和贴着关节的韧带：前者随软组织一起动，后者不动。
 * Median distance (m) of each part's surface from bone. It tells ligaments that span free between
 * bones (inguinal, nuchal, sacrotuberous) from those lying on a joint: the former move with the soft
 * tissue, the latter stay.
 */
export function medianDistanceToBone(parts: ShapePart[], bones: ShapePart[]): Map<string, number> {
  const index = new PointIndex(concat(bones.map((b) => thinPoints(surfacePoints(b.mesh, 0.003), 0.003))), 0.01)
  const out = new Map<string, number>()
  for (const p of parts) {
    const s = thinPoints(surfacePoints(p.mesh, 0.004), 0.004)
    const d: number[] = []
    for (let i = 0; i < s.length; i += 3) d.push(index.distance(s[i]!, s[i + 1]!, s[i + 2]!))
    d.sort((a, b) => a - b)
    out.set(p.id, d.length ? d[Math.floor(d.length / 2)]! : 0)
  }
  return out
}

// ── 选项 / options ─────────────────────────────────────────────────────────────────────────

export type ShapeRole =
  /** 骨、软骨、牙：零锚点，不动 / bone, cartilage, tooth: zero anchors, never moved */
  | 'bone'
  /** 其他不许动的部件：零锚点，不动，只报告 / other parts that must not move: zero anchors, never moved, reported only */
  | 'fixed'
  /** 可动的深部软组织：由它们的表面决定位移场 / movable deep soft tissue: its surfaces drive the field */
  | 'driver'
  /** 随场移动、但不参与决定位移场（血管、神经、筋膜） / carried by the field without driving it (vessels, nerves, fasciae) */
  | 'follower'
  /** 随场移动但不变形：每个连通块按其质心处的位移整体平移（淋巴结） / carried by the field without deforming: every connected piece is translated by the displacement at its centroid (lymph nodes) */
  | 'rigid'
  /** 既不动也不作锚点（皮肤、皮下脂肪、乳腺） / neither moved nor anchored (skin, subcutaneous fat, breast) */
  | 'ignored'

export interface ShapePart {
  id: string
  name: string
  tissue: string
  mesh: Mesh
  centrelines?: Polyline[]
}

export interface ShapeOptions {
  /** 推入的目标：包络之内这么深（米） / where a push ends: this far inside the envelope (m) */
  margin: number
  passes: number
  /** 可动部件表面采样间距、包络采样间距（米） / spacing of samples on movable parts and of envelope samples (m) */
  sampleSpacing: number
  envelopeSpacing: number
  /** 离骨面不到这个距离的采样点视为附着端，位移为 0 / samples closer to bone than this count as attachment ends and get displacement 0 */
  attachDistance: number
  /** 压缩的上限：一个表面点的总位移不超过它到最近的零位移表面（骨或不许动的部件）原距离的 (1 − minDepthShare)，拉出同此 / cap on compression: the total displacement of a surface point never exceeds (1 − minDepthShare) of its original distance to the nearest zero-displacement surface (bone or a fixed part); pulls likewise */
  minDepthShare: number
  /** 一次推入的最大位移（米） / largest displacement of one push (m) */
  maxPush: number
  /** 拉出：cap 单点最大位移，maxGap 超过它就不算最外层，weight 锚点权重；null 表示只推不拉 / pull: cap = largest displacement of one sample, maxGap = beyond this a surface is not counted as outermost, weight = anchor weight; null for push only */
  pull: { cap: number; maxGap: number; weight: number } | null
  /** 把推、拉的锚点镜像到 x = xMid 的另一侧（权重乘以它；0 表示不镜像） / mirror push and pull anchors to the other side of x = xMid (their weight times this; 0 for none) */
  mirror: number
  xMid: number
  /** 位移场的网格间距（米）、软约束的强度、每层的松弛扫描次数 / grid spacing of the field (m), strength of the soft constraints, relaxation sweeps per level */
  grid: number
  stiffness: number
  sweeps: number
  /** 每一轮的场分成这么多小步施加 / each pass's field is applied in this many small steps */
  substeps: number
  /** 拉出的配平按高度分段，每段这么厚（米） / pulls are balanced in slabs of this height (m) */
  balanceSlab: number
  /** 体积损失超过这个比例的肌在报告里标出 / muscles losing more than this share of their volume are flagged in the report */
  flagVolumeLoss: number
  /**
   * 体积下限（可选）：对给出参考体积（毫升）的肌，按部位汇总，本步之后该部位这些肌的总体积不低于参考体积之和。
   * 做法是按部位标定 minDepthShare（在 depthFloor 与 1 之间二分，在粗一倍的网格上试 calibrationTrials 次）。
   * 返回 null 的部件沿用 minDepthShare。
   * Volume floor (optional): muscles for which a reference volume (ml) is given are summed per region,
   * and after the stage those muscles of a region together keep at least the sum of their reference
   * volumes. This is done by calibrating minDepthShare per region (bisection between depthFloor and
   * 1, calibrationTrials trials on a grid twice as coarse). Parts for which it returns null keep minDepthShare.
   */
  referenceVolumeMl?: (p: ShapePart) => number | null
  depthFloor: number
  calibrationTrials: number
}

export const SHAPE_DEFAULTS: ShapeOptions = {
  margin: 0.0015,
  passes: 2,
  sampleSpacing: 0.005,
  envelopeSpacing: 0.0025,
  attachDistance: 0.003,
  minDepthShare: 0.6,
  maxPush: 0.03,
  pull: { cap: 0.015, maxGap: 0.03, weight: 0.5 },
  mirror: 1,
  xMid: 0,
  grid: 0.005,
  stiffness: 20,
  sweeps: 60,
  substeps: 4,
  balanceSlab: 0.04,
  flagVolumeLoss: 0.25,
  depthFloor: 0.4,
  calibrationTrials: 5,
}

// ── 包络查询 / envelope queries ────────────────────────────────────────────────────────────

/** 网格表面的采样点和各点处的外法线（由顶点法线插值） / surface samples of a mesh with the outward normal at each (interpolated vertex normals) */
function sampleWithNormals(mesh: Mesh, spacing: number): { points: Float32Array; normals: Float32Array } {
  const p = mesh.positions
  const idx = mesh.indices
  const vn = computeNormals(mesh)
  // 绕向朝内的网格：法线取反 / a mesh wound inwards: normals are negated
  const flip = signedVolume(mesh) < 0 ? -1 : 1
  const pts: number[] = []
  const nor: number[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!
    const b = 3 * idx[t + 1]!
    const c = 3 * idx[t + 2]!
    const longest = Math.sqrt(Math.max((p[b]! - p[a]!) ** 2 + (p[b + 1]! - p[a + 1]!) ** 2 + (p[b + 2]! - p[a + 2]!) ** 2, (p[c]! - p[b]!) ** 2 + (p[c + 1]! - p[b + 1]!) ** 2 + (p[c + 2]! - p[b + 2]!) ** 2, (p[a]! - p[c]!) ** 2 + (p[a + 1]! - p[c + 1]!) ** 2 + (p[a + 2]! - p[c + 2]!) ** 2))
    const n = Math.max(1, Math.min(8, Math.ceil(longest / spacing)))
    // n×n 细分后各小三角形的重心 / centroids of the small triangles of an n×n split
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) for (let k = 0; k < (j < n - i - 1 ? 2 : 1); k++) {
      const u = (3 * i + 1 + k) / (3 * n)
      const v = (3 * j + 1 + k) / (3 * n)
      const w = 1 - u - v
      pts.push(w * p[a]! + u * p[b]! + v * p[c]!, w * p[a + 1]! + u * p[b + 1]! + v * p[c + 1]!, w * p[a + 2]! + u * p[b + 2]! + v * p[c + 2]!)
      let nx = w * vn[a]! + u * vn[b]! + v * vn[c]!
      let ny = w * vn[a + 1]! + u * vn[b + 1]! + v * vn[c + 1]!
      let nz = w * vn[a + 2]! + u * vn[b + 2]! + v * vn[c + 2]!
      const l = (Math.hypot(nx, ny, nz) || 1) * flip
      nx /= l
      ny /= l
      nz /= l
      nor.push(nx, ny, nz)
    }
  }
  return { points: Float32Array.from(pts), normals: Float32Array.from(nor) }
}

/** 带部位标记的骨表面采样 / bone surface samples labelled with their region */
class BoneLabels {
  readonly index: PointIndex
  private readonly region: Uint8Array
  private readonly group: Uint8Array
  private readonly I = new Int32Array(1)
  private readonly D = new Float64Array(1)
  /** 胸、腹、盆三段按高度划分的界线 / the heights that divide chest, abdomen and pelvis */
  readonly chestBottomY: number
  readonly crestY: number

  constructor(bones: ShapePart[], readonly xMid: number, spacing = 0.005) {
    const pts: number[] = []
    const reg: number[] = []
    const grp: number[] = []
    let chestBottom = Infinity
    let crest = -Infinity
    for (const b of bones) {
      const r = regionOfBone(b.name)
      const ri = SHAPE_REGIONS.indexOf(r)
      const sided = /\bleft\b/i.test(b.name) ? 1 : /\bright\b/i.test(b.name) ? -1 : 0
      if (/sternum|xiphoid/i.test(b.name)) for (let i = 1; i < b.mesh.positions.length; i += 3) chestBottom = Math.min(chestBottom, b.mesh.positions[i]!)
      if (/hip bone/i.test(b.name)) for (let i = 1; i < b.mesh.positions.length; i += 3) crest = Math.max(crest, b.mesh.positions[i]!)
      const sp = thinPoints(surfacePoints(b.mesh, spacing), spacing * 0.8)
      for (let i = 0; i < sp.length; i += 3) {
        pts.push(sp[i]!, sp[i + 1]!, sp[i + 2]!)
        reg.push(ri)
        grp.push(groupOf(r, b.name, sided ? sided > 0 : sp[i]! > xMid))
      }
    }
    this.index = new PointIndex(Float32Array.from(pts), 0.015)
    this.region = Uint8Array.from(reg)
    this.group = Uint8Array.from(grp)
    this.chestBottomY = chestBottom
    this.crestY = crest
  }

  /**
   * 最近的骨采样点：返回它的下标（没有骨时为 −1），out = [部位, 分组, 到骨的距离]。
   * 躯干的三段（胸、腹、盆）改按高度划分：腹前壁最近的骨可能是肋，也可能是髋骨。
   * The nearest bone sample: returns its index (−1 without bones), out = [region, group, distance to bone].
   * The three trunk regions (chest, abdomen, pelvis) are divided by height instead: the nearest bone of the anterior abdominal wall may be a rib or a hip bone.
   */
  label(x: number, y: number, z: number, out: Float64Array): number {
    if (!this.index.nearest(x, y, z, 1, this.I, this.D)) return -1
    const i = this.I[0]!
    let r = this.region[i]!
    if (r === 3 || r === 4 || r === 5) r = y > this.chestBottomY ? 3 : y > this.crestY ? 4 : 5
    out[0] = r
    out[1] = this.group[i]!
    out[2] = Math.sqrt(this.D[0]!)
    return i
  }
}

/** 深层包络：按分组的表面采样，回答“带符号的距离”和“最近的表面点” / the deep envelope: surface samples by group, answering signed distance and nearest surface point */
class Envelope {
  private readonly groups: { index: PointIndex; normals: Float32Array }[] = []
  private readonly I = new Int32Array(1)
  private readonly D = new Float64Array(1)
  /** 最近一次查询的结果：最近点 q 和该处外法线 n / result of the last query: nearest point q and the outward normal n there */
  readonly q = new Float64Array(3)
  readonly n = new Float64Array(3)
  static readonly REACH = 0.05
  private readonly tester: InsideTester

  constructor(mesh: Mesh, labels: BoneLabels, spacing: number) {
    this.tester = new InsideTester(mesh, 256)
    const s = sampleWithNormals(mesh, spacing)
    const count = s.points.length / 3
    const g = new Uint8Array(count)
    const sizes = new Array<number>(7).fill(0)
    const lab = new Float64Array(3)
    for (let i = 0; i < count; i++) {
      labels.label(s.points[3 * i]!, s.points[3 * i + 1]!, s.points[3 * i + 2]!, lab)
      g[i] = lab[1]!
      sizes[g[i]!] = sizes[g[i]!]! + 1
    }
    for (let k = 0; k < 7; k++) {
      const pts = new Float32Array(sizes[k]! * 3)
      const nor = new Float32Array(sizes[k]! * 3)
      let o = 0
      for (let i = 0; i < count; i++) {
        if (g[i] !== k) continue
        for (let c = 0; c < 3; c++) {
          pts[o + c] = s.points[3 * i + c]!
          nor[o + c] = s.normals[3 * i + c]!
        }
        o += 3
      }
      this.groups.push({ index: new PointIndex(pts, 0.01), normals: nor })
    }
  }

  /**
   * 到包络的带符号距离（外正内负；超过 REACH 时截断）。只在 allowed 允许的分组里找最近点，先找 own 这一组。
   * “在外”要两种判断都同意：最近点处的法线朝着查询点，并且射线奇偶性也说在外。包络在腋下、腹股沟处
   * 自相重叠，奇偶性在那里把体内算成体外；最近的采样点落在棱上时法线又会判错。
   * Signed distance to the envelope (positive outside, negative inside; clamped beyond REACH). The
   * nearest point is sought in the groups of `allowed` only, group `own` first. "Outside" needs both
   * tests to agree: the normal at the nearest point faces the query point, and ray parity says outside
   * too. The envelope overlaps itself at the axilla and the groin, where parity takes inside for
   * outside; and the normal misjudges when the nearest sample sits on a ridge.
   */
  signed(x: number, y: number, z: number, own: number, allowed: number): number {
    let best = Envelope.REACH
    let hit = -1
    let at = -1
    for (let j = 0; j < 7; j++) {
      const k = j === 0 ? own : j <= own ? j - 1 : j
      if (!(allowed & (1 << k)) || !this.groups[k]!.index.count) continue
      if (!this.groups[k]!.index.nearest(x, y, z, 1, this.I, this.D, best)) continue
      const d = Math.sqrt(this.D[0]!)
      if (d < best) {
        best = d
        hit = k
        at = this.I[0]!
      }
    }
    if (hit < 0) {
      this.q[0] = NaN
      return -Envelope.REACH
    }
    const g = this.groups[hit]!
    for (let c = 0; c < 3; c++) {
      this.q[c] = g.index.points[3 * at + c]!
      this.n[c] = g.normals[3 * at + c]!
    }
    const dot = (x - this.q[0]!) * this.n[0]! + (y - this.q[1]!) * this.n[1]! + (z - this.q[2]!) * this.n[2]!
    if (dot >= 0 && this.tester.contains(x, y, z)) return -best
    // 贴近表面时用到切平面的距离（采样点不一定正对着查询点）；远处用欧氏距离
    // close to the surface the distance to the tangent plane is used (the sample is not exactly under the query point); far away the Euclidean distance
    return best < 0.004 ? dot : dot >= 0 ? best : -best
  }
}

// ── 网格上的调和位移场 / the harmonic displacement field on a grid ─────────────────────────

const FREE = 1
const HARD = 2

/** 规则网格：节点状态（0 不参与、FREE 待解、HARD 位移恒为 0）和待解节点的列表 / a regular grid: node state (0 not part of it, FREE solved for, HARD displacement fixed at 0) and the list of solved nodes */
interface Grid {
  h: number
  o: [number, number, number]
  nx: number
  ny: number
  nz: number
  state: Uint8Array
  free: Int32Array
}

/**
 * 建网格：`support` 中每个点所在体素的 8 个角点为待解节点，再向外膨胀 `dilate` 层；`hard` 中每个点最近的节点为硬零点。
 * Builds a grid: the 8 corners of the voxel of every point of `support` are solved nodes, dilated by `dilate` layers; the node nearest to every point of `hard` is a hard zero.
 */
function makeGrid(h: number, box: number[], support: Float32Array[], hard: Float32Array[], dilate: number): Grid {
  const pad = dilate + 2
  const o: [number, number, number] = [box[0]! - pad * h, box[1]! - pad * h, box[2]! - pad * h]
  const nx = Math.ceil((box[3]! - o[0]) / h) + pad + 1
  const ny = Math.ceil((box[4]! - o[1]) / h) + pad + 1
  const nz = Math.ceil((box[5]! - o[2]) / h) + pad + 1
  let state = new Uint8Array(nx * ny * nz)
  const sxy = nx * ny
  for (const pts of support) for (let i = 0; i < pts.length; i += 3) {
    const c = Math.floor((pts[i]! - o[0]) / h) + nx * Math.floor((pts[i + 1]! - o[1]) / h) + sxy * Math.floor((pts[i + 2]! - o[2]) / h)
    state[c] = state[c + 1] = state[c + nx] = state[c + nx + 1] = state[c + sxy] = state[c + sxy + 1] = state[c + sxy + nx] = state[c + sxy + nx + 1] = FREE
  }
  for (let d = 0; d < dilate; d++) {
    const next = Uint8Array.from(state)
    for (let c = sxy; c < state.length - sxy; c++) if (!state[c] && (state[c - 1] || state[c + 1] || state[c - nx] || state[c + nx] || state[c - sxy] || state[c + sxy])) next[c] = FREE
    state = next
  }
  for (const pts of hard) for (let i = 0; i < pts.length; i += 3) {
    const c = Math.round((pts[i]! - o[0]) / h) + nx * Math.round((pts[i + 1]! - o[1]) / h) + sxy * Math.round((pts[i + 2]! - o[2]) / h)
    if (state[c]) state[c] = HARD
  }
  let n = 0
  for (let c = 0; c < state.length; c++) if (state[c] === FREE) n++
  const free = new Int32Array(n)
  n = 0
  for (let c = 0; c < state.length; c++) if (state[c] === FREE) free[n++] = c
  return { h, o, nx, ny, nz, state, free }
}

/** 网格上的场在一点的三线性插值（只用参与的角点）；没有参与的角点时返回 false / trilinear interpolation of a grid field at a point (corners that are part of the grid only); false when none is */
function sampleGrid(g: Grid, u: Float32Array, x: number, y: number, z: number, out: Float64Array): boolean {
  const fx = (x - g.o[0]) / g.h
  const fy = (y - g.o[1]) / g.h
  const fz = (z - g.o[2]) / g.h
  let ix = Math.floor(fx)
  let iy = Math.floor(fy)
  let iz = Math.floor(fz)
  if (ix < 0) ix = 0
  else if (ix > g.nx - 2) ix = g.nx - 2
  if (iy < 0) iy = 0
  else if (iy > g.ny - 2) iy = g.ny - 2
  if (iz < 0) iz = 0
  else if (iz > g.nz - 2) iz = g.nz - 2
  const tx = Math.min(1, Math.max(0, fx - ix))
  const ty = Math.min(1, Math.max(0, fy - iy))
  const tz = Math.min(1, Math.max(0, fz - iz))
  const c0 = ix + g.nx * (iy + g.ny * iz)
  let w = 0
  let ux = 0
  let uy = 0
  let uz = 0
  for (let k = 0; k < 8; k++) {
    const c = c0 + (k & 1) + (k & 2 ? g.nx : 0) + (k & 4 ? g.nx * g.ny : 0)
    if (!g.state[c]) continue
    const wk = (k & 1 ? tx : 1 - tx) * (k & 2 ? ty : 1 - ty) * (k & 4 ? tz : 1 - tz)
    w += wk
    ux += wk * u[3 * c]!
    uy += wk * u[3 * c + 1]!
    uz += wk * u[3 * c + 2]!
  }
  if (w < 1e-9) {
    out[0] = out[1] = out[2] = 0
    return false
  }
  out[0] = ux / w
  out[1] = uy / w
  out[2] = uz / w
  return true
}

interface SoftAnchors {
  /** 位置、位移（各为 xyz 三元组）和权重 / positions, displacements (xyz triples each) and weights */
  at: number[]
  d: number[]
  w: number[]
}

/**
 * 在网格上解带约束的拉普拉斯方程：硬零点为 0；软锚点摊到最近的节点上，以 stiffness·Σw 的强度把该节点拉向
 * 锚点位移的加权平均；其余节点取邻居的平均（不参与的邻居不计，即零梯度边界）。逐次超松弛，正反交替扫描；
 * `init` 给出初值（较粗一层的解）。
 * Solves the constrained Laplace equation on a grid: hard zeros stay 0; soft anchors are gathered at
 * their nearest node and draw it towards their weighted mean displacement with strength
 * stiffness·Σw; every other node takes the mean of its neighbours (neighbours outside the grid do
 * not count: a zero-gradient boundary). Successive over-relaxation, sweeping forwards and backwards
 * in turn; `init` supplies the starting values (the solution of the coarser level).
 */
function solveHarmonic(g: Grid, soft: SoftAnchors, stiffness: number, sweeps: number, init: ((x: number, y: number, z: number, out: Float64Array) => boolean) | null): { u: Float32Array; lastChange: number } {
  const n = g.state.length
  const sxy = g.nx * g.ny
  const W = new Float32Array(n)
  const D = new Float32Array(3 * n)
  for (let i = 0; i < soft.w.length; i++) {
    const c = Math.round((soft.at[3 * i]! - g.o[0]) / g.h) + g.nx * Math.round((soft.at[3 * i + 1]! - g.o[1]) / g.h) + sxy * Math.round((soft.at[3 * i + 2]! - g.o[2]) / g.h)
    if (c < 0 || c >= n || g.state[c] !== FREE) continue
    const w = soft.w[i]!
    W[c] = W[c]! + w
    D[3 * c] = D[3 * c]! + w * soft.d[3 * i]!
    D[3 * c + 1] = D[3 * c + 1]! + w * soft.d[3 * i + 1]!
    D[3 * c + 2] = D[3 * c + 2]! + w * soft.d[3 * i + 2]!
  }
  const u = new Float32Array(3 * n)
  if (init) {
    const t = new Float64Array(3)
    for (let k = 0; k < g.free.length; k++) {
      const c = g.free[k]!
      const iz = Math.floor(c / sxy)
      const iy = Math.floor((c - iz * sxy) / g.nx)
      const ix = c - iz * sxy - iy * g.nx
      if (init(g.o[0] + ix * g.h, g.o[1] + iy * g.h, g.o[2] + iz * g.h, t)) {
        u[3 * c] = t[0]!
        u[3 * c + 1] = t[1]!
        u[3 * c + 2] = t[2]!
      }
    }
  }
  const OMEGA = 1.7
  const st = g.state
  const nb = [-1, 1, -g.nx, g.nx, -sxy, sxy]
  let lastChange = 0
  for (let sweep = 0; sweep < sweeps; sweep++) {
    lastChange = 0
    const m = g.free.length
    for (let k = 0; k < m; k++) {
      const c = g.free[sweep & 1 ? m - 1 - k : k]!
      let cnt = 0
      let sx = 0
      let sy = 0
      let sz = 0
      for (let j = 0; j < 6; j++) {
        const b = c + nb[j]!
        if (!st[b]) continue
        cnt++
        sx += u[3 * b]!
        sy += u[3 * b + 1]!
        sz += u[3 * b + 2]!
      }
      const k2 = stiffness * W[c]!
      const den = cnt + k2
      if (den === 0) continue
      const dx = OMEGA * ((sx + stiffness * D[3 * c]!) / den - u[3 * c]!)
      const dy = OMEGA * ((sy + stiffness * D[3 * c + 1]!) / den - u[3 * c + 1]!)
      const dz = OMEGA * ((sz + stiffness * D[3 * c + 2]!) / den - u[3 * c + 2]!)
      u[3 * c] = u[3 * c]! + dx
      u[3 * c + 1] = u[3 * c + 1]! + dy
      u[3 * c + 2] = u[3 * c + 2]! + dz
      const ch = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
      if (ch > lastChange) lastChange = ch
    }
  }
  return { u, lastChange }
}

// ── 报告 / report ──────────────────────────────────────────────────────────────────────────

export interface OutsideRow {
  samples: number
  /** 表面采样点在包络之外的比例 / share of surface samples outside the envelope */
  outside: number
  /** 在外的那些点超出的距离（毫米） / how far the outside ones stick out (mm) */
  p50Mm: number
  p95Mm: number
  maxMm: number
}
export interface PartOutside extends OutsideRow {
  id: string
  name: string
  tissue: string
}
export interface VolumeRow {
  id: string
  name: string
  region: ShapeRegion
  beforeMl: number
  afterMl: number
  change: number
}

export interface VolumeFloorRow {
  muscles: number
  /** 参考体积之和、进入本步时的体积、本步之后的体积（毫升） / sum of reference volumes, volume entering the stage, volume after it (ml) */
  referenceMl: number
  beforeMl: number
  afterMl: number
  /** 允许的体积系数 = 参考 / 进入时；实际达到的系数 = 之后 / 进入时 / allowed volume factor = reference / entering; achieved factor = after / entering */
  allowedFactor: number
  achievedFactor: number
  /** 标定出的 minDepthShare / the calibrated minDepthShare */
  minDepthShare: number
}

export interface ShapeReport {
  options: Omit<ShapeOptions, 'referenceVolumeMl'>
  parts: { bone: number; fixed: number; driver: number; follower: number; rigid: number; ignored: number; moved: number }
  /** 给了参考体积的肌：按部位的体积下限和标定结果；以及个别低于自己参考体积的肌 / muscles with a reference volume: the floor per region and the calibration; and the single muscles that ended below their own reference */
  volumeFloor: { byRegion: Record<string, VolumeFloorRow>; belowOwnReference: (VolumeRow & { referenceMl: number })[] } | null
  /** 整体平移的部件（淋巴结）在包络之外的比例，前后 / share outside the envelope of the parts translated whole (lymph nodes), before and after */
  rigid: { before: OutsideRow; after: OutsideRow; worstAfter: PartOutside[] }
  grid: { spacingMm: number; solvedNodes: number; hardZeroNodes: number }
  passes: { pass: number; pushAnchors: number; pullAnchors: number; mirroredAnchors: number; onAttachments: number; cappedByDepth: number; meanPushMm: number; maxPushMm: number; pullBalance: Record<string, number>; solverLastChangeMm: number; outsideAfter: number }[]
  /** 可动的深部软组织：各部位在包络外的比例，前后 / movable deep soft tissue: share outside the envelope by region, before and after */
  outside: { before: Record<string, OutsideRow>; after: Record<string, OutsideRow> }
  worstBefore: PartOutside[]
  worstAfter: PartOutside[]
  /** 没有动的部件在包络之外的情况 / what the parts that were not moved have outside the envelope */
  notMoved: { bone: { byRegion: Record<string, OutsideRow>; parts: PartOutside[] }; fixed: { all: OutsideRow; parts: PartOutside[] } }
  displacementMm: { median: number; p95: number; max: number }
  /** 骨表面上的位移（应接近 0） / displacement on bone surfaces (should be close to 0) */
  onBoneMm: { p95: number; max: number }
  jacobian: ReturnType<typeof jacobianStats>
  volume: { muscles: number; totalBeforeMl: number; totalAfterMl: number; byRegion: Record<string, { muscles: number; beforeMl: number; afterMl: number; change: number }>; flagged: VolumeRow[]; perMuscle: VolumeRow[] }
  /** 形变来的内脏（随场移动的器官）体积变化 / volume change of the warped viscera carried by the field */
  organs: { parts: number; totalBeforeMl: number; totalAfterMl: number; flagged: VolumeRow[] }
}

const r1 = (v: number, d = 1) => Number(v.toFixed(d))
const quant = (sorted: number[], f: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))]! : 0)
const rowOf = (signed: number[]): OutsideRow => {
  const o = signed.filter((s) => s > 0).sort((a, b) => a - b)
  return { samples: signed.length, outside: signed.length ? r1(o.length / signed.length, 4) : 0, p50Mm: r1(quant(o, 0.5) * 1000), p95Mm: r1(quant(o, 0.95) * 1000), maxMm: r1((o[o.length - 1] ?? 0) * 1000) }
}

/**
 * 一组部件的表面采样点落在包络之外的比例（与主过程用同一套判断），供测试在成品几何上复核。
 * Share of the surface samples of some parts that lie outside the envelope (same test as the stage uses), for the tests to recheck on shipped geometry.
 */
export function outsideShare(parts: ShapePart[], bones: ShapePart[], envelopeMesh: Mesh, xMid = 0, spacing = 0.005): number {
  const labels = new BoneLabels(bones, xMid)
  const env = new Envelope(envelopeMesh, labels, SHAPE_DEFAULTS.envelopeSpacing)
  const lab = new Float64Array(3)
  let n = 0
  let out = 0
  for (const p of parts) {
    const s = thinPoints(surfacePoints(p.mesh, spacing), spacing * 0.8)
    for (let i = 0; i < s.length; i += 3) {
      labels.label(s[i]!, s[i + 1]!, s[i + 2]!, lab)
      n++
      if (env.signed(s[i]!, s[i + 1]!, s[i + 2]!, lab[1]!, ALLOWED[lab[1]!]!) > 0) out++
    }
  }
  return n ? out / n : 0
}

// ── 主过程 / the stage ─────────────────────────────────────────────────────────────────────

/**
 * 把 `parts` 中可动的部件收进包络（就地改写它们的网格和中心线），返回报告。
 * Brings the movable ones of `parts` inside the envelope (their meshes and centrelines are rewritten in place) and returns the report.
 */
export function reshapeIntoEnvelope(parts: ShapePart[], roleOf: (p: ShapePart) => ShapeRole, envelopeMesh: Mesh, options: Partial<ShapeOptions> = {}, log: (line: string) => void = () => {}): ShapeReport {
  const opts: ShapeOptions = { ...SHAPE_DEFAULTS, ...options }
  const roles = parts.map(roleOf)
  const of = (role: ShapeRole) => parts.filter((_, i) => roles[i] === role)
  const bones = of('bone')
  const fixed = of('fixed')
  const drivers = of('driver')
  const movable = parts.filter((_, i) => roles[i] === 'driver' || roles[i] === 'follower')
  const rigid = of('rigid')
  if (!bones.length) throw new Error('shape: no bones to anchor the field')

  const t0 = performance.now()
  const lapse = () => `[${((performance.now() - t0) / 1000).toFixed(1)} s]`
  const labels = new BoneLabels(bones, opts.xMid)
  const env = new Envelope(envelopeMesh, labels, opts.envelopeSpacing)
  const lab = new Float64Array(3)

  // 可动的深部软组织的表面采样；每个点记下所属部件、部位、分组和原来到骨的深度
  // surface samples of the movable deep soft tissue; each remembers its part, region, group and original depth over bone
  const owner: number[] = []
  const chunks: Float32Array[] = []
  drivers.forEach((p, k) => {
    const s = thinPoints(surfacePoints(p.mesh, opts.sampleSpacing), opts.sampleSpacing * 0.8)
    chunks.push(s)
    for (let i = 0; i < s.length; i += 3) owner.push(k)
  })
  const cur0 = concat(chunks)
  let cur = cur0
  const ns = cur.length / 3
  // 零位移表面（骨和不许动的部件）的采样：量“深度” / samples of the zero-displacement surfaces (bone and fixed parts), to measure depth
  const hardIndex = new PointIndex(concat([...bones, ...fixed].map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.0025))), 0.01)
  const region = new Uint8Array(ns)
  const group = new Uint8Array(ns)
  const depth0 = new Float32Array(ns)
  for (let i = 0; i < ns; i++) {
    labels.label(cur[3 * i]!, cur[3 * i + 1]!, cur[3 * i + 2]!, lab)
    region[i] = lab[0]!
    group[i] = lab[1]!
    depth0[i] = hardIndex.distance(cur[3 * i]!, cur[3 * i + 1]!, cur[3 * i + 2]!)
  }
  const signedOf = (pts: Float32Array): Float32Array => {
    const s = new Float32Array(pts.length / 3)
    for (let i = 0; i < s.length; i++) s[i] = env.signed(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!, group[i]!, ALLOWED[group[i]!]!)
    return s
  }
  const byRegion = (s: Float32Array): Record<string, OutsideRow> => {
    const rows: Record<string, number[]> = { all: [] }
    for (const r of SHAPE_REGIONS) rows[r] = []
    for (let i = 0; i < ns; i++) {
      rows[SHAPE_REGIONS[region[i]!]!]!.push(s[i]!)
      rows.all!.push(s[i]!)
    }
    return Object.fromEntries(Object.entries(rows).filter(([, v]) => v.length >= 30).map(([k, v]) => [k, rowOf(v)]))
  }
  const byPart = (s: Float32Array, list: ShapePart[], own: number[]): PartOutside[] => {
    const per: number[][] = list.map(() => [])
    for (let i = 0; i < own.length; i++) per[own[i]!]!.push(s[i]!)
    return per
      .map((v, k) => ({ id: list[k]!.id, name: list[k]!.name, tissue: list[k]!.tissue, ...rowOf(v) }))
      .filter((r) => r.outside > 0 && r.samples >= 5)
      .sort((a, b) => b.outside * b.p95Mm - a.outside * a.p95Mm || (a.id < b.id ? -1 : 1))
  }

  // 没有动的部件：它们在包络之外的情况 / the parts that are not moved: what they have outside the envelope
  const staticOutside = (list: ShapePart[]) => {
    const own: number[] = []
    const sig: number[] = []
    const reg: number[] = []
    list.forEach((p, k) => {
      const s = thinPoints(surfacePoints(p.mesh, opts.sampleSpacing), opts.sampleSpacing * 0.8)
      for (let i = 0; i < s.length; i += 3) {
        labels.label(s[i]!, s[i + 1]!, s[i + 2]!, lab)
        own.push(k)
        reg.push(lab[0]!)
        sig.push(env.signed(s[i]!, s[i + 1]!, s[i + 2]!, lab[1]!, ALLOWED[lab[1]!]!))
      }
    })
    const rows: Record<string, number[]> = { all: [] }
    for (let i = 0; i < sig.length; i++) {
      ;(rows[SHAPE_REGIONS[reg[i]!]!] ??= []).push(sig[i]!)
      rows.all!.push(sig[i]!)
    }
    return { byRegion: Object.fromEntries(Object.entries(rows).filter(([, v]) => v.length >= 30).map(([k, v]) => [k, rowOf(v)])), parts: byPart(Float32Array.from(sig), list, own) }
  }

  // 最外层：从采样点沿包络的外法线向外走 40 mm（离开自身 6 mm 之后），不再碰到别的深部表面。只按原始几何判断一次。
  // 只有最外层的表面受推、拉；它下面的各层不设条件，由调和插值在体表和骨之间线性过渡——否则整块位于
  // 包络之外的肌，两个面会被推到同一张曲面上，压成一张纸。
  // outermost: walking 40 mm outwards from a sample along the envelope's outward normal (beyond 6 mm
  // from the sample) no other deep surface is met. Decided once, on the original geometry. Only the
  // outermost surface is pushed or pulled; the layers under it carry no condition and the harmonic
  // interpolant ramps linearly between body surface and bone — otherwise a muscle lying wholly outside
  // the envelope would have both its faces pushed onto the same surface and be pressed flat.
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const p of [...bones, ...fixed, ...movable, ...rigid]) for (let i = 0; i < p.mesh.positions.length; i += 3) for (let c = 0; c < 3; c++) {
    const v = p.mesh.positions[i + c]!
    if (v < box[c]!) box[c] = v
    if (v > box[c + 3]!) box[c + 3] = v
  }
  const s0 = signedOf(cur)
  const outermost = new Uint8Array(ns)
  {
    const VOX = 0.004
    const dims = [0, 1, 2].map((c) => Math.floor((box[c + 3]! - box[c]!) / VOX) + 1)
    // 每个体素记下第一个占据它的部件，以及是否还有别的部件 / each voxel remembers the first part in it and whether another one is there too
    const first = new Int32Array(dims[0]! * dims[1]! * dims[2]!)
    const shared = new Uint8Array(first.length)
    const cell = (x: number, y: number, z: number) => {
      const ix = Math.floor((x - box[0]!) / VOX)
      const iy = Math.floor((y - box[1]!) / VOX)
      const iz = Math.floor((z - box[2]!) / VOX)
      return ix < 0 || iy < 0 || iz < 0 || ix >= dims[0]! || iy >= dims[1]! || iz >= dims[2]! ? -1 : ix + dims[0]! * (iy + dims[1]! * iz)
    }
    const mark = (list: ShapePart[], base: number) => list.forEach((p, k) => {
      const s = surfacePoints(p.mesh, 0.003)
      for (let i = 0; i < s.length; i += 3) {
        const c = cell(s[i]!, s[i + 1]!, s[i + 2]!)
        if (c < 0) continue
        if (!first[c]) first[c] = base + k + 1
        else if (first[c] !== base + k + 1) shared[c] = 1
      }
    })
    mark(drivers, 0)
    mark([...bones, ...fixed], drivers.length)
    for (let i = 0; i < ns; i++) {
      if (s0[i]! < -(opts.pull?.maxGap ?? 0) - opts.margin) continue
      const x = cur[3 * i]!
      const y = cur[3 * i + 1]!
      const z = cur[3 * i + 2]!
      env.signed(x, y, z, group[i]!, ALLOWED[group[i]!]!)
      if (Number.isNaN(env.q[0]!)) continue
      const me = owner[i]! + 1
      let free = true
      // 别的部件从 4 mm 起算（跳过自己所在的体素），自己的另一面从 8 mm 起算
      // another part counts from 4 mm on (the sample's own voxel is skipped), the part's own far face from 8 mm on
      for (let t = 0.004; t < 0.04; t += 0.002) {
        const c = cell(x + env.n[0]! * t, y + env.n[1]! * t, z + env.n[2]! * t)
        if (c < 0 || !first[c]) continue
        if (first[c] !== me || shared[c] || t >= 0.008) {
          free = false
          break
        }
      }
      if (free) outermost[i] = 1
    }
  }

  const before = { regions: byRegion(s0), parts: byPart(s0, drivers, owner) }
  const boneOutside = staticOutside(bones)
  const fixedOutside = staticOutside(fixed)
  log(`${lapse()} movable deep soft tissue outside the envelope before: ${(before.regions.all!.outside * 100).toFixed(1)} % of ${ns} samples (of those: median ${before.regions.all!.p50Mm} mm, p95 ${before.regions.all!.p95Mm} mm, max ${before.regions.all!.maxMm} mm)`)

  const rigidBefore = staticOutside(rigid)
  const volumeOf = (p: ShapePart) => Math.abs(signedVolume(p.mesh)) * 1e6
  const majorityIndex = new Int32Array(drivers.length)
  {
    const votes = drivers.map(() => new Array<number>(SHAPE_REGIONS.length).fill(0))
    for (let i = 0; i < ns; i++) votes[owner[i]!]![region[i]!] = votes[owner[i]!]![region[i]!]! + 1
    votes.forEach((v, k) => (majorityIndex[k] = v.indexOf(Math.max(...v))))
  }
  const volBefore = new Map<ShapePart, number>(drivers.map((p) => [p, volumeOf(p)]))

  // ── 网格：由粗到细的三层；硬零点取自骨和其他不许动的部件的表面 / the grids: three levels, coarse to fine; hard zeros from the surfaces of bone and the other fixed parts
  const support = [...[...movable, ...rigid].map((p) => p.mesh.positions), ...movable.flatMap((p) => (p.centrelines ?? []).map((l) => l.points))]
  const hardAt = (h: number) => [...bones, ...fixed].map((p) => surfacePoints(p.mesh, h / 2))
  const levelsAt = (finest: number) => [4, 2, 1].map((f) => makeGrid(finest * f, box, support, hardAt(finest * f), Math.ceil(opts.maxPush / (finest * f)) + 1))
  const tmp = new Float64Array(3)
  const applyWith = (G: Grid, U: Float32Array, pts: Float32Array): Float32Array => {
    const out = new Float32Array(pts.length)
    for (let i = 0; i < pts.length; i += 3) {
      sampleGrid(G, U, pts[i]!, pts[i + 1]!, pts[i + 2]!, tmp)
      out[i] = pts[i]! + tmp[0]!
      out[i + 1] = pts[i + 1]! + tmp[1]!
      out[i + 2] = pts[i + 2]! + tmp[2]!
    }
    return out
  }
  /** 每个采样点的 minDepthShare / minDepthShare of every sample */
  const share = new Float32Array(ns).fill(opts.minDepthShare)

  // ── 逐轮 / the passes
  const run = (levels: Grid[], say: (line: string) => void): { G: Grid; U: Float32Array; rows: ShapeReport['passes']; cur: Float32Array } => {
  const G = levels[2]!
  // 总位移：定义在原始空间的节点上 / the total displacement, defined at the nodes of the original space
  const U = new Float32Array(3 * G.state.length)
  let cur = cur0
  const passRows: ShapeReport['passes'] = []
  for (let pass = 0; pass < opts.passes; pass++) {
    const soft: SoftAnchors = { at: [], d: [], w: [] }
    let mirrored = 0
    const add = (x: number, y: number, z: number, dx: number, dy: number, dz: number, w: number, db: number, reg: number) => {
      soft.at.push(x, y, z)
      soft.d.push(dx, dy, dz)
      soft.w.push(w)
      if (opts.mirror <= 0) return
      // 镜像到对侧：只在对侧同一部位、到骨的距离相近的地方 / mirrored to the other side: only where that is the same region at a similar distance from bone
      const mx = 2 * opts.xMid - x
      if (labels.label(mx, y, z, lab) < 0 || lab[0] !== reg || Math.abs(hardIndex.distance(mx, y, z) - db) > 0.004) return
      soft.at.push(mx, y, z)
      soft.d.push(-dx, dy, dz)
      soft.w.push(w * opts.mirror)
      mirrored++
    }
    let nPush = 0
    let nAttach = 0
    let capped = 0
    let pushSum = 0
    let pushMax = 0
    const pushBy = new Map<string, number>()
    const pullBy = new Map<string, number>()
    const pulls: { i: number; g: number; key: string; dir: [number, number, number]; db: number }[] = []
    for (let i = 0; i < ns; i++) {
      const x = cur[3 * i]!
      const y = cur[3 * i + 1]!
      const z = cur[3 * i + 2]!
      const db = hardIndex.distance(x, y, z)
      // 附着端：贴着骨的表面不推也不拉（骨面是硬零点） / attachment ends: surface lying on bone is neither pushed nor pulled (the bone surface is a hard zero)
      if (db < opts.attachDistance) {
        nAttach++
        continue
      }
      const s = env.signed(x, y, z, group[i]!, ALLOWED[group[i]!]!)
      if (Number.isNaN(env.q[0]!)) continue
      const key = `${region[i]}_${x > opts.xMid ? 'L' : 'R'}_${Math.floor(y / opts.balanceSlab)}`
      if (!outermost[i]) continue
      if (s > -opts.margin) {
        // 推入：贴近表面时沿内法线，远处朝“最近点内侧 margin”走
        // push: along the inward normal near the surface, towards "margin inside the nearest point" from far away
        let dx = -env.n[0]!
        let dy = -env.n[1]!
        let dz = -env.n[2]!
        let need = s + opts.margin
        if (s > 0.004) {
          dx = env.q[0]! - opts.margin * env.n[0]! - x
          dy = env.q[1]! - opts.margin * env.n[1]! - y
          dz = env.q[2]! - opts.margin * env.n[2]! - z
          need = Math.hypot(dx, dy, dz)
          dx /= need
          dy /= need
          dz /= need
        }
        need = Math.min(need, opts.maxPush)
        // 总位移不超过原深度的 (1 − minDepthShare)：已经走过的算在内
        // the total displacement stays within (1 − minDepthShare) of the original depth, what has been travelled already included
        const room = Math.max(0, (1 - share[i]!) * depth0[i]! - Math.hypot(x - cur0[3 * i]!, y - cur0[3 * i + 1]!, z - cur0[3 * i + 2]!))
        if (need > room) {
          need = room
          capped++
        }
        if (need < 0.0003) continue
        add(x, y, z, need * dx, need * dy, need * dz, 1, db, region[i]!)
        nPush++
        pushSum += need
        pushMax = Math.max(pushMax, need)
        pushBy.set(key, (pushBy.get(key) ?? 0) + need)
      } else if (opts.pull && (drivers[owner[i]!]!.tissue === 'muscle' || drivers[owner[i]!]!.tissue === 'tendon')) {
        const gap = Math.min(-s - opts.margin, opts.pull.cap, Math.max(0, (1 - share[i]!) * depth0[i]! - Math.hypot(x - cur0[3 * i]!, y - cur0[3 * i + 1]!, z - cur0[3 * i + 2]!)))
        if (gap < 0.001) continue
        let dx = env.q[0]! - x
        let dy = env.q[1]! - y
        let dz = env.q[2]! - z
        const l = Math.hypot(dx, dy, dz) || 1
        dx /= l
        dy /= l
        dz /= l
        pulls.push({ i, g: gap, key, dir: [dx, dy, dz], db })
        pullBy.set(key, (pullBy.get(key) ?? 0) + gap)
      }
    }
    // 配平：同一部位、同一侧、同一高度段里，拉出的总量不超过推入的总量
    // balance: within one region, side and height slab, the pulls never add up to more than the pushes
    let nPull = 0
    const pulledBy: Record<string, [number, number]> = {}
    for (const pl of pulls) {
      const f = Math.min(1, (pushBy.get(pl.key) ?? 0) / pullBy.get(pl.key)!)
      const acc = (pulledBy[SHAPE_REGIONS[region[pl.i]!]!] ??= [0, 0])
      acc[0] += f * pl.g
      acc[1] += pl.g
      const g = pl.g * f
      if (g < 0.0005) continue
      add(cur[3 * pl.i]!, cur[3 * pl.i + 1]!, cur[3 * pl.i + 2]!, g * pl.dir[0], g * pl.dir[1], g * pl.dir[2], opts.pull!.weight, pl.db, region[pl.i]!)
      nPull++
    }
    const pullBalance = Object.fromEntries(Object.entries(pulledBy).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, r1(v[0] / (v[1] || 1), 3)]))
    // 由粗到细求解，粗一层的解作细一层的初值 / solved coarse to fine, each level starting from the one before
    let prev: { g: Grid; u: Float32Array } | null = null
    let lastChange = 0
    for (const g of levels) {
      const from = prev
      const sol = solveHarmonic(g, soft, opts.stiffness, opts.sweeps, from ? (x, y, z, out) => sampleGrid(from.g, from.u, x, y, z, out) : null)
      prev = { g, u: sol.u }
      lastChange = sol.lastChange
    }
    const u = prev!.u
    // 与前几轮复合：原始节点 x0 现在位于 x0 + U(x0)，在那里取本轮的位移
    // composed with the passes before: an original node x0 now sits at x0 + U(x0), where this pass's displacement is read
    const sxy = G.nx * G.ny
    for (let k = 0; k < G.free.length; k++) {
      const c = G.free[k]!
      const iz = Math.floor(c / sxy)
      const iy = Math.floor((c - iz * sxy) / G.nx)
      const ix = c - iz * sxy - iy * G.nx
      // 分 substeps 小步沿本轮的场走：每一小步的梯度只有 1/substeps，复合起来不会折叠
      // walked along this pass's field in `substeps` small steps: each carries 1/substeps of the gradient, and their composition does not fold
      for (let q = 0; q < opts.substeps; q++) {
        sampleGrid(G, u, G.o[0] + ix * G.h + U[3 * c]!, G.o[1] + iy * G.h + U[3 * c + 1]!, G.o[2] + iz * G.h + U[3 * c + 2]!, tmp)
        U[3 * c] = U[3 * c]! + tmp[0]! / opts.substeps
        U[3 * c + 1] = U[3 * c + 1]! + tmp[1]! / opts.substeps
        U[3 * c + 2] = U[3 * c + 2]! + tmp[2]! / opts.substeps
      }
    }
    cur = applyWith(G, U, cur0)
    const sNow = signedOf(cur)
    let out = 0
    for (let i = 0; i < ns; i++) if (sNow[i]! > 0) out++
    passRows.push({ pass: pass + 1, pushAnchors: nPush, pullAnchors: nPull, mirroredAnchors: mirrored, onAttachments: nAttach, cappedByDepth: capped, meanPushMm: r1((pushSum / Math.max(1, nPush)) * 1000), maxPushMm: r1(pushMax * 1000), pullBalance, solverLastChangeMm: r1(lastChange * 1000, 3), outsideAfter: r1(out / ns, 4) })
    say(`${lapse()} pass ${pass + 1}: ${nPush} pushes (mean ${((pushSum / Math.max(1, nPush)) * 1000).toFixed(1)} mm, max ${(pushMax * 1000).toFixed(1)} mm, ${capped} capped by depth over bone), ${nPull} pulls, ${mirrored} mirrored, ${nAttach} samples on attachments left alone; solver last change ${(lastChange * 1000).toFixed(3)} mm → outside ${((out / ns) * 100).toFixed(1)} %`)
  }

  return { G, U, rows: passRows, cur }
  }

  // ── 体积下限：按部位标定 minDepthShare / the volume floor: minDepthShare calibrated per region
  const refOf = opts.referenceVolumeMl
  const governed: { k: number; ref: number }[] = []
  if (refOf) drivers.forEach((p, k) => {
    const ref = (p.tissue === 'muscle' || p.tissue === 'tendon') && volBefore.get(p)! >= 0.05 ? refOf(p) : null
    if (ref !== null && ref > 0) governed.push({ k, ref })
  })
  const NR = SHAPE_REGIONS.length
  const refSum = new Float64Array(NR)
  const preSum = new Float64Array(NR)
  for (const g of governed) {
    refSum[majorityIndex[g.k]!] = refSum[majorityIndex[g.k]!]! + g.ref
    preSum[majorityIndex[g.k]!] = preSum[majorityIndex[g.k]!]! + volBefore.get(drivers[g.k]!)!
  }
  const capOf = new Float64Array(NR).fill(opts.minDepthShare)
  const isGoverned = new Uint8Array(drivers.length)
  for (const g of governed) isGoverned[g.k] = 1
  const setShares = () => {
    for (let i = 0; i < ns; i++) share[i] = isGoverned[owner[i]!] ? capOf[majorityIndex[owner[i]!]!]! : opts.minDepthShare
  }
  const achieved = (G: Grid, U: Float32Array): Float64Array => {
    const a = new Float64Array(NR)
    for (const g of governed) a[majorityIndex[g.k]!] = a[majorityIndex[g.k]!]! + Math.abs(signedVolume({ positions: applyWith(G, U, drivers[g.k]!.mesh.positions), indices: drivers[g.k]!.mesh.indices })) * 1e6
    return a
  }
  if (governed.length) {
    const lo = new Float64Array(NR).fill(opts.depthFloor)
    const hi = new Float64Array(NR).fill(1)
    const coarse = levelsAt(opts.grid * 2)
    for (let trial = 0; trial < opts.calibrationTrials; trial++) {
      for (let r = 0; r < NR; r++) capOf[r] = preSum[r]! > 0 ? (refSum[r]! >= preSum[r]! ? 1 : (lo[r]! + hi[r]!) / 2) : opts.minDepthShare
      setShares()
      const t = run(coarse, () => {})
      const a = achieved(t.G, t.U)
      for (let r = 0; r < NR; r++) {
        if (!(preSum[r]! > 0) || refSum[r]! >= preSum[r]!) continue
        // 体积低于下限：压得太狠，提高 minDepthShare；否则还可以再放开
        // volume under the floor: squeezed too hard, minDepthShare goes up; otherwise it may be relaxed further
        // （留 1 % 余量：标定用的网格比正式的粗一倍） / (with a 1 % margin: the calibration grid is twice as coarse as the final one)
        if (a[r]! < 1.01 * refSum[r]!) lo[r] = capOf[r]!
        else hi[r] = capOf[r]!
      }
      log(`${lapse()} volume-floor calibration ${trial + 1}/${opts.calibrationTrials}: ${SHAPE_REGIONS.map((n, r) => (preSum[r]! > 0 ? `${n} ${capOf[r]!.toFixed(2)}→${(a[r]! / preSum[r]!).toFixed(2)} (≥ ${(refSum[r]! / preSum[r]!).toFixed(2)})` : '')).filter(Boolean).join(', ')}`)
    }
    // 取已知守得住下限的一侧 / the side known to keep the floor
    for (let r = 0; r < NR; r++) if (preSum[r]! > 0) capOf[r] = refSum[r]! >= preSum[r]! ? 1 : hi[r]!
    setShares()
  }
  const levels = levelsAt(opts.grid)
  const { G, U, rows: passRows, cur: curEnd } = run(levels, log)
  cur = curEnd
  const hardNodes = G.state.reduce((s, v) => s + (v === HARD ? 1 : 0), 0)
  log(`${lapse()} field grid ${opts.grid * 1000} mm: ${G.free.length} solved nodes, ${hardNodes} hard zeros on bone and fixed parts`)
  const applyAll = (pts: Float32Array): Float32Array => applyWith(G, U, pts)

  // ── 施加到全部可动部件 / applied to every movable part
  const sAfter = signedOf(cur)
  const after = { regions: byRegion(sAfter), parts: byPart(sAfter, drivers, owner) }
  const majority = new Map<number, ShapeRegion>(drivers.map((_, k) => [k, SHAPE_REGIONS[majorityIndex[k]!]!]))
  const disp: number[] = []
  let moved = 0
  for (const p of movable) {
    const out = applyAll(p.mesh.positions)
    let m = 0
    for (let i = 0; i < out.length; i += 3) {
      const d = Math.hypot(out[i]! - p.mesh.positions[i]!, out[i + 1]! - p.mesh.positions[i + 1]!, out[i + 2]! - p.mesh.positions[i + 2]!)
      if (d > m) m = d
    }
    if (m > 1e-5) moved++
    disp.push(m)
    p.mesh = { positions: out, indices: p.mesh.indices }
    if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: applyAll(l.points), radius: l.radius }))
  }
  // 整体平移的部件：每个连通块按质心处的位移平移 / parts translated whole: every connected piece by the displacement at its centroid
  for (const p of rigid) {
    const nv = p.mesh.positions.length / 3
    const parent = Int32Array.from({ length: nv }, (_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!
        i = parent[i]!
      }
      return i
    }
    // 先把重合的顶点并起来（网格可能没有焊接） / coincident vertices are merged first (the mesh may be unwelded)
    const seen = new Map<string, number>()
    for (let i = 0; i < nv; i++) {
      const key = `${Math.round(p.mesh.positions[3 * i]! * 1e5)},${Math.round(p.mesh.positions[3 * i + 1]! * 1e5)},${Math.round(p.mesh.positions[3 * i + 2]! * 1e5)}`
      const j = seen.get(key)
      if (j === undefined) seen.set(key, i)
      else parent[find(i)] = find(j)
    }
    for (let t = 0; t < p.mesh.indices.length; t += 3) {
      const a = find(p.mesh.indices[t]!)
      parent[find(p.mesh.indices[t + 1]!)] = a
      parent[find(p.mesh.indices[t + 2]!)] = a
    }
    const acc = new Map<number, [number, number, number, number]>()
    for (let i = 0; i < nv; i++) {
      const c = find(i)
      const a = acc.get(c) ?? [0, 0, 0, 0]
      a[0] += p.mesh.positions[3 * i]!
      a[1] += p.mesh.positions[3 * i + 1]!
      a[2] += p.mesh.positions[3 * i + 2]!
      a[3]++
      acc.set(c, a)
    }
    const shift = new Map<number, [number, number, number]>()
    let m = 0
    for (const [c, a] of acc) {
      sampleGrid(G, U, a[0] / a[3], a[1] / a[3], a[2] / a[3], tmp)
      shift.set(c, [tmp[0]!, tmp[1]!, tmp[2]!])
      m = Math.max(m, Math.hypot(tmp[0]!, tmp[1]!, tmp[2]!))
    }
    const out = new Float32Array(p.mesh.positions.length)
    for (let i = 0; i < nv; i++) {
      const d = shift.get(find(i))!
      out[3 * i] = p.mesh.positions[3 * i]! + d[0]
      out[3 * i + 1] = p.mesh.positions[3 * i + 1]! + d[1]
      out[3 * i + 2] = p.mesh.positions[3 * i + 2]! + d[2]
    }
    if (m > 1e-5) moved++
    disp.push(m)
    p.mesh = { positions: out, indices: p.mesh.indices }
  }
  const rigidAfter = staticOutside(rigid)
  disp.sort((a, b) => a - b)
  const rows: VolumeRow[] = drivers.map((p, k) => {
    const b = volBefore.get(p)!
    const a = volumeOf(p)
    return { id: p.id, name: p.name, region: majority.get(k)!, beforeMl: r1(b, 2), afterMl: r1(a, 2), change: b > 0 ? r1(a / b - 1, 4) : 0 }
  })
  const isMuscle = (k: number) => drivers[k]!.tissue === 'muscle' || drivers[k]!.tissue === 'tendon'
  const muscles = rows.filter((_, k) => isMuscle(k))
  const organs = rows.filter((_, k) => !isMuscle(k))
  const volRegions: ShapeReport['volume']['byRegion'] = {}
  for (const r of SHAPE_REGIONS) {
    const list = muscles.filter((m) => m.region === r)
    if (!list.length) continue
    const b = list.reduce((s, m) => s + m.beforeMl, 0)
    const a = list.reduce((s, m) => s + m.afterMl, 0)
    volRegions[r] = { muscles: list.length, beforeMl: r1(b), afterMl: r1(a), change: b > 0 ? r1(a / b - 1, 4) : 0 }
  }
  const flag = (list: VolumeRow[]) => list.filter((m) => m.beforeMl >= 0.05 && m.change < -opts.flagVolumeLoss).sort((a, b) => a.change - b.change || (a.id < b.id ? -1 : 1))
  const sum = (list: VolumeRow[], k: 'beforeMl' | 'afterMl') => r1(list.reduce((s, m) => s + m[k], 0))

  let volumeFloor: ShapeReport['volumeFloor'] = null
  if (governed.length) {
    const byRegionFloor: Record<string, VolumeFloorRow> = {}
    const post = new Float64Array(NR)
    const count = new Int32Array(NR)
    for (const g of governed) {
      post[majorityIndex[g.k]!] = post[majorityIndex[g.k]!]! + volumeOf(drivers[g.k]!)
      count[majorityIndex[g.k]!] = count[majorityIndex[g.k]!]! + 1
    }
    for (let r = 0; r < NR; r++) if (count[r]) byRegionFloor[SHAPE_REGIONS[r]!] = { muscles: count[r]!, referenceMl: r1(refSum[r]!), beforeMl: r1(preSum[r]!), afterMl: r1(post[r]!), allowedFactor: r1(refSum[r]! / preSum[r]!, 3), achievedFactor: r1(post[r]! / preSum[r]!, 3), minDepthShare: r1(capOf[r]!, 3) }
    const below = governed.filter((g) => volumeOf(drivers[g.k]!) < g.ref).map((g) => ({ ...rows[g.k]!, referenceMl: r1(g.ref, 2) })).sort((a, b) => a.afterMl / a.referenceMl - b.afterMl / b.referenceMl || (a.id < b.id ? -1 : 1))
    volumeFloor = { byRegion: byRegionFloor, belowOwnReference: below }
    log(`volume floor (reference = sex ratio × the male muscle): ${Object.entries(byRegionFloor).map(([k, v]) => `${k} allowed ${v.allowedFactor}, achieved ${v.achievedFactor}, minDepthShare ${v.minDepthShare}`).join('; ')}; ${below.length} muscles below their own reference`)
  }

  // 骨表面上的位移、雅可比行列式 / displacement on bone surfaces, Jacobian determinant
  const boneSamples = thinPoints(concat(bones.map((p) => surfacePoints(p.mesh, 0.006))), 0.006)
  const onBone: number[] = []
  {
    const w = applyAll(boneSamples)
    for (let i = 0; i < w.length; i += 3) onBone.push(Math.hypot(w[i]! - boneSamples[i]!, w[i + 1]! - boneSamples[i + 1]!, w[i + 2]! - boneSamples[i + 2]!))
    onBone.sort((a, b) => a - b)
  }
  const jacobian = jacobianStats(applyAll, thinPoints(cur0, 0.008), 0.002)
  log(`${lapse()} after ${opts.passes} passes: outside ${(after.regions.all!.outside * 100).toFixed(1)} % (of those: median ${after.regions.all!.p50Mm} mm, p95 ${after.regions.all!.p95Mm} mm, max ${after.regions.all!.maxMm} mm); ${moved} parts moved, largest displacement ${(disp[disp.length - 1]! * 1000).toFixed(1)} mm; on bone p95 ${(quant(onBone, 0.95) * 1000).toFixed(2)} mm, max ${(onBone[onBone.length - 1]! * 1000).toFixed(2)} mm`)
  log(`Jacobian determinant at ${jacobian.samples} samples: min ${jacobian.min}, p01 ${jacobian.p01}, median ${jacobian.median}, p99 ${jacobian.p99}, max ${jacobian.max}; folded ${jacobian.folded}`)
  log(`muscle volume ${sum(muscles, 'beforeMl')} → ${sum(muscles, 'afterMl')} ml; ${flag(muscles).length} of ${muscles.length} muscles lost more than ${opts.flagVolumeLoss * 100} %`)

  const { referenceVolumeMl: _ref, ...plainOptions } = opts
  void _ref
  return {
    options: plainOptions,
    parts: { bone: bones.length, fixed: fixed.length, driver: drivers.length, follower: movable.length - drivers.length, rigid: rigid.length, ignored: of('ignored').length, moved },
    volumeFloor,
    rigid: { before: rigidBefore.byRegion.all ?? rowOf([]), after: rigidAfter.byRegion.all ?? rowOf([]), worstAfter: rigidAfter.parts.slice(0, 15) },
    grid: { spacingMm: r1(opts.grid * 1000), solvedNodes: G.free.length, hardZeroNodes: hardNodes },
    passes: passRows,
    outside: { before: before.regions, after: after.regions },
    worstBefore: before.parts.slice(0, 25),
    worstAfter: after.parts.slice(0, 25),
    notMoved: { bone: { byRegion: boneOutside.byRegion, parts: boneOutside.parts.slice(0, 40) }, fixed: { all: fixedOutside.byRegion.all ?? rowOf([]), parts: fixedOutside.parts.slice(0, 40) } },
    displacementMm: { median: r1(quant(disp, 0.5) * 1000), p95: r1(quant(disp, 0.95) * 1000), max: r1(disp[disp.length - 1]! * 1000) },
    onBoneMm: { p95: r1(quant(onBone, 0.95) * 1000, 2), max: r1(onBone[onBone.length - 1]! * 1000, 2) },
    jacobian,
    volume: { muscles: muscles.length, totalBeforeMl: sum(muscles, 'beforeMl'), totalAfterMl: sum(muscles, 'afterMl'), byRegion: volRegions, flagged: flag(muscles), perMuscle: muscles },
    organs: { parts: organs.length, totalBeforeMl: sum(organs, 'beforeMl'), totalAfterMl: sum(organs, 'afterMl'), flagged: flag(organs) },
  }
}

function concat(arrays: Float32Array[]): Float32Array {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}
