// 肩带姿势校正（男性）：把仰卧成像留下的“耸肩、后缩”的肩带重新摆成站立位的静息姿势。
// 这里只有运动学：标志点、ISB 关节角、约束求解。软组织如何跟随见 shoulderTissue.ts。
//   · 肩带是一条闭链：锁骨绕胸锁关节转（前伸/后缩、上提/下降），肩胛骨绕肩锁关节转并贴着胸廓滑动
//     （肩胛骨肋面各点到胸廓的间距保持静息时的数值），肱骨头中心随关节盂走，上肢整体只做平移。
//   · 不缩放任何骨；每块骨的运动都是纯刚体变换，可以逆变换回到“扫描原样”。
//   · 静息姿势的参考值取自 Ludewig 等 2009（站立、手臂自然下垂，12 人，骨钉传感器，ISB 坐标系）。
// Shoulder girdle posture correction (male): re-poses the shrugged, retracted girdle left by supine
// imaging into a standing resting posture. Kinematics only: landmarks, ISB joint angles, the
// constrained solve. How the soft tissue follows is in shoulderTissue.ts.
//   · The girdle is a closed chain: the clavicle turns at the sternoclavicular joint (protraction /
//     retraction, elevation / depression), the scapula turns at the acromioclavicular joint and
//     glides on the thorax (every point of its costal surface keeps its resting stand-off from the
//     chest wall), the humeral head centre goes with the glenoid, the upper limb is only translated.
//   · No bone is scaled; every bone moves by a pure rigid transform, which can be inverted to get
//     the as-scanned posture back.
//   · Reference resting posture: Ludewig et al. 2009 (standing, arms relaxed at the side, 12
//     subjects, bone-pin sensors, ISB coordinate systems).

import type { Mesh } from './geometry.ts'
import { PointIndex, surfacePoints, thinPoints } from './register.ts'

export type V3 = [number, number, number]
/** 刚体变换 x ↦ r·x + t（r 按行存放） / rigid transform x ↦ r·x + t (r row-major) */
export interface RigidT { r: number[]; t: V3 }

export const IDENTITY_T: RigidT = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1))
const DEG = 180 / Math.PI

/** 轴角 → 旋转矩阵（罗德里格斯公式） / axis-angle vector → rotation matrix (Rodrigues) */
export function rotationFromVector(w: V3): number[] {
  const a = len(w)
  if (a < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const [x, y, z] = mul(w, 1 / a)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const k = 1 - c
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k]
}

export const matMul = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!
  return o
}
export const transpose = (a: number[]): number[] => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!]
const rot = (r: number[], v: V3): V3 => [r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2], r[3]! * v[0] + r[4]! * v[1] + r[5]! * v[2], r[6]! * v[0] + r[7]! * v[1] + r[8]! * v[2]]
/** 旋转角（弧度） / rotation angle (rad) */
export const rotationAngleOf = (r: number[]) => Math.acos(Math.max(-1, Math.min(1, (r[0]! + r[4]! + r[8]! - 1) / 2)))

/** 绕定点 `pivot` 的旋转 / rotation about the fixed point `pivot` */
export const aboutPoint = (r: number[], pivot: V3, pivotTo: V3 = pivot): RigidT => ({ r, t: sub(pivotTo, rot(r, pivot)) })
export const applyT = (m: RigidT, p: V3): V3 => add(rot(m.r, p), m.t)
export const invertT = (m: RigidT): RigidT => {
  const r = transpose(m.r)
  return { r, t: mul(rot(r, m.t), -1) }
}
export const isIdentityT = (m: RigidT) => m.t.every((v) => v === 0) && m.r.every((v, i) => v === (i % 4 === 0 ? 1 : 0))
export const isTranslationT = (m: RigidT) => m.r.every((v, i) => v === (i % 4 === 0 ? 1 : 0))

/** 对一串 xyz 应用刚体变换，返回新数组（float32） / applies a rigid transform to xyz triples, returns a new float32 array */
export function applyToPoints(m: RigidT, pts: ArrayLike<number>): Float32Array {
  const out = new Float32Array(pts.length)
  const r = m.r
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]!
    const y = pts[i + 1]!
    const z = pts[i + 2]!
    out[i] = r[0]! * x + r[1]! * y + r[2]! * z + m.t[0]
    out[i + 1] = r[3]! * x + r[4]! * y + r[5]! * z + m.t[1]
    out[i + 2] = r[6]! * x + r[7]! * y + r[8]! * z + m.t[2]
  }
  return out
}

// ── 标志点 / Landmarks ───────────────────────────────────────────────────────────────────────

const extreme = (p: Float32Array, f: (x: number, y: number, z: number) => number): V3 => {
  let best = -Infinity
  let bi = 0
  for (let i = 0; i < p.length; i += 3) {
    const v = f(p[i]!, p[i + 1]!, p[i + 2]!)
    if (v > best) {
      best = v
      bi = i
    }
  }
  return [p[bi]!, p[bi + 1]!, p[bi + 2]!]
}

/**
 * 两个面之间的接触区：A 上距 B 不超过（最小间隙 + `band`）的点及其在 B 上的最近点。
 * 返回接触区中心（两侧点的均值）和间隙统计（米）。只在 `reach` 以内找最近点。
 * Contact zone between two surfaces: the points of A within (smallest gap + `band`) of B and their
 * nearest points on B. Returns the zone's centre (mean over both sides) and gap statistics (m).
 * Nearest points are looked for within `reach` only.
 */
export function contactZone(a: Float32Array, b: PointIndex, band = 0.003, reach = 0.012): { centre: V3; min: number; median: number; points: Float32Array } {
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  const d = new Float64Array(a.length / 3)
  let min = Infinity
  for (let i = 0; i < a.length; i += 3) {
    d[i / 3] = b.nearest(a[i]!, a[i + 1]!, a[i + 2]!, 1, I, D, reach) ? Math.sqrt(D[0]!) : Infinity
    if (d[i / 3]! < min) min = d[i / 3]!
  }
  const c: V3 = [0, 0, 0]
  const pts: number[] = []
  const gaps: number[] = []
  for (let i = 0; i < a.length; i += 3) {
    if (d[i / 3]! > min + band) continue
    b.nearest(a[i]!, a[i + 1]!, a[i + 2]!, 1, I, D)
    const q = 3 * I[0]!
    for (let k = 0; k < 3; k++) c[k] = c[k]! + (a[i + k]! + b.points[q + k]!) / 2
    pts.push(a[i]!, a[i + 1]!, a[i + 2]!)
    gaps.push(d[i / 3]!)
  }
  gaps.sort((x, y) => x - y)
  const n = gaps.length
  return { centre: [c[0] / n, c[1] / n, c[2] / n], min, median: gaps[Math.floor(n / 2)]!, points: Float32Array.from(pts) }
}

/**
 * 最小二乘球面拟合（代数法），再只保留贴近球面的点迭代两次。
 * Least-squares sphere fit (algebraic), re-fitted twice on the points that lie close to the sphere.
 */
export function fitSphere(pts: number[]): { centre: V3; radius: number; rms: number; n: number } {
  let use = pts
  let centre: V3 = [0, 0, 0]
  let radius = 0
  let rms = 0
  for (let pass = 0; pass < 3; pass++) {
    // 解 |p|² = 2c·p + (R² − |c|²) / solve |p|² = 2c·p + (R² − |c|²)
    const A = new Float64Array(16)
    const B = new Float64Array(4)
    for (let i = 0; i < use.length; i += 3) {
      const row = [2 * use[i]!, 2 * use[i + 1]!, 2 * use[i + 2]!, 1]
      const rhs = use[i]! ** 2 + use[i + 1]! ** 2 + use[i + 2]! ** 2
      for (let a = 0; a < 4; a++) {
        B[a] = B[a]! + row[a]! * rhs
        for (let b = 0; b < 4; b++) A[4 * a + b] = A[4 * a + b]! + row[a]! * row[b]!
      }
    }
    const s = solveLinear(A, B, 4)
    centre = [s[0]!, s[1]!, s[2]!]
    radius = Math.sqrt(Math.max(0, s[3]! + dot(centre, centre)))
    const keep: number[] = []
    let e = 0
    for (let i = 0; i < use.length; i += 3) {
      const r = Math.hypot(use[i]! - centre[0], use[i + 1]! - centre[1], use[i + 2]! - centre[2]) - radius
      e += r * r
      if (Math.abs(r) < 0.0015) keep.push(use[i]!, use[i + 1]!, use[i + 2]!)
    }
    rms = Math.sqrt(e / (use.length / 3))
    if (keep.length < 60 || pass === 2) break
    use = keep
  }
  return { centre, radius, rms, n: use.length / 3 }
}

/** 高斯消元（部分选主元）解 n×n 线性方程组 / n×n linear solve by Gaussian elimination with partial pivoting */
export function solveLinear(A: Float64Array, B: Float64Array, n: number): Float64Array {
  const a = Float64Array.from(A)
  const b = Float64Array.from(B)
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[n * r + c]!) > Math.abs(a[n * p + c]!)) p = r
    if (p !== c) {
      for (let k = 0; k < n; k++) [a[n * c + k], a[n * p + k]] = [a[n * p + k]!, a[n * c + k]!]
      ;[b[c], b[p]] = [b[p]!, b[c]!]
    }
    const d = a[n * c + c]! || 1e-30
    for (let r = c + 1; r < n; r++) {
      const f = a[n * r + c]! / d
      if (!f) continue
      for (let k = c; k < n; k++) a[n * r + k] = a[n * r + k]! - f * a[n * c + k]!
      b[r] = b[r]! - f * b[c]!
    }
  }
  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!
    for (let k = r + 1; k < n; k++) s -= a[n * r + k]! * x[k]!
    x[r] = s / (a[n * r + r]! || 1e-30)
  }
  return x
}

/** ISB 胸廓标志点 / the ISB thorax landmarks */
export interface ThoraxLandmarks {
  /** 颈静脉切迹 / incisura jugularis */
  ij: V3
  /** 剑突尖 / tip of the xiphoid process */
  px: V3
  /** 第 7 颈椎、第 8 胸椎棘突尖 / tips of the spinous processes of C7 and T8 */
  c7: V3
  t8: V3
}

/** 一侧肩带的标志点（全局坐标，米） / landmarks of one side of the girdle (global frame, m) */
export interface GirdleLandmarks {
  /** 胸锁、肩锁关节接触区中心 / centres of the sternoclavicular and acromioclavicular contact zones */
  sc: V3
  ac: V3
  /** 肱骨头球心与半径 / centre and radius of the humeral head sphere */
  gh: V3
  ghRadius: number
  /** 肩峰角、肩胛冈根（内侧缘）、下角 / angulus acromialis, trigonum spinae (root of the spine on the medial border), angulus inferior */
  aa: V3
  ts: V3
  ai: V3
}

/**
 * 从骨网格自动取 ISB 胸廓标志点。
 * The ISB thorax landmarks, picked automatically from the bone meshes.
 */
export function thoraxLandmarks(manubrium: Mesh, xiphoid: Mesh, c7: Mesh, t8: Mesh): ThoraxLandmarks {
  return {
    // 切迹：胸骨柄上缘在中线处的最低点，这里取“高且靠中线”的极值点 / the notch: taken as the extreme of "high and near the midline"
    ij: extreme(manubrium.positions, (x, y) => y - 5 * Math.abs(x)),
    px: extreme(xiphoid.positions, (_x, y) => -y),
    c7: extreme(c7.positions, (_x, _y, z) => -z),
    t8: extreme(t8.positions, (_x, _y, z) => -z),
  }
}

/**
 * 一侧肩带的标志点。`lat` = +1（左，外侧为 +X）或 −1（右）。
 * 肩胛冈根取内侧缘上最靠内的点（在本模型上它正落在冈根水平）；肩峰角取肩峰后外角。
 * Landmarks of one side. `lat` = +1 (left, lateral is +X) or −1 (right).
 * The root of the spine is the most medial point of the medial border (on this model it lies at the
 * level of the spine); the angulus acromialis is the posterolateral corner of the acromion.
 */
export function girdleLandmarks(lat: 1 | -1, clavicle: Mesh, scapula: Mesh, humerus: Mesh, manubrium: Mesh): GirdleLandmarks {
  const sp = surfacePoints(scapula, 0.001)
  const cp = surfacePoints(clavicle, 0.001)
  const sc = contactZone(cp, new PointIndex(surfacePoints(manubrium, 0.001), 0.004)).centre
  const ac = contactZone(cp, new PointIndex(sp, 0.004)).centre
  // 肱骨头：近端 14 % 中朝内上方的那部分表面 / humeral head: the part of the proximal 14 % that faces medially and upwards
  const hp = humerus.positions
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 1; i < hp.length; i += 3) {
    if (hp[i]! < y0) y0 = hp[i]!
    if (hp[i]! > y1) y1 = hp[i]!
  }
  const top = y1 - 0.14 * (y1 - y0)
  const cap: number[] = []
  const c0: V3 = [0, 0, 0]
  let n0 = 0
  for (let i = 0; i < hp.length; i += 3) if (hp[i + 1]! > top) {
    c0[0] += hp[i]!
    c0[1] += hp[i + 1]!
    c0[2] += hp[i + 2]!
    n0++
  }
  const hs = surfacePoints(humerus, 0.0015)
  for (let i = 0; i < hs.length; i += 3) {
    if (hs[i + 1]! <= top) continue
    // 朝内、朝上、略朝后：关节面一侧 / medial, upward, slightly posterior: the articular side
    if (-lat * (hs[i]! - c0[0] / n0) + (hs[i + 1]! - c0[1] / n0) - 0.3 * (hs[i + 2]! - c0[2] / n0) > 0) cap.push(hs[i]!, hs[i + 1]!, hs[i + 2]!)
  }
  const head = fitSphere(cap)
  const s = scapula.positions
  return {
    sc, ac, gh: head.centre, ghRadius: head.radius,
    aa: extreme(s, (x, _y, z) => lat * x - z),
    ts: meanNear(sp, extreme(s, (x) => -lat * x), (p, e) => Math.abs(p[0] - e[0]) < 0.002 && Math.abs(p[1] - e[1]) < 0.015),
    ai: extreme(s, (_x, y) => -y),
  }
}

/** 满足条件的表面点的均值（让取在一条缘上的标志点不随网格细节跳动） / mean of the surface points that satisfy `near` (keeps a landmark taken on a border from jumping with mesh detail) */
function meanNear(pts: Float32Array, e: V3, near: (p: V3, e: V3) => boolean): V3 {
  const c: V3 = [0, 0, 0]
  let n = 0
  for (let i = 0; i < pts.length; i += 3) {
    const p: V3 = [pts[i]!, pts[i + 1]!, pts[i + 2]!]
    if (!near(p, e)) continue
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
    n++
  }
  return n ? [c[0] / n, c[1] / n, c[2] / n] : e
}

/**
 * 四肢其余大关节的中心，按简单的几何定义（供皮肤拟合定位用；精确的转动中心和转轴以 rig.json 为准）：
 *   髋 = 股骨头拟合球心；膝 = 股骨远端 11 % 表面的质心；踝 = 距骨表面的质心；
 *   肘 = 肱骨远端 8 % 表面的质心；腕 = 头状骨近端四分之一表面的质心。
 * 与绑定工具在未校正的男性上拟合的中心相比：髋 0.2 mm，肘约 2 mm，腕约 5 mm，膝、踝 6–8 mm。
 * Centres of the other large limb joints by simple geometric definitions (for placing a fitted skin;
 * rig.json has the exact centres and axes): hip = centre of the sphere fitted to the femoral head;
 * knee = centroid of the surface of the distal 11 % of the femur; ankle = centroid of the surface of
 * the talus; elbow = centroid of the surface of the distal 8 % of the humerus; wrist = centroid of
 * the surface of the proximal quarter of the capitate. Against the centres the rig tool fitted on the
 * uncorrected male: hip 0.2 mm, elbow about 2 mm, wrist about 5 mm, knee and ankle 6–8 mm.
 */
export function limbJointCentres(lat: 1 | -1, bones: { femur?: Mesh; talus?: Mesh; humerus?: Mesh; capitate?: Mesh }): Partial<Record<'hip' | 'knee' | 'ankle' | 'elbow' | 'wrist', V3>> {
  const out: Partial<Record<'hip' | 'knee' | 'ankle' | 'elbow' | 'wrist', V3>> = {}
  const span = (p: Float32Array): [number, number] => {
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 1; i < p.length; i += 3) {
      if (p[i]! < y0) y0 = p[i]!
      if (p[i]! > y1) y1 = p[i]!
    }
    return [y0, y1]
  }
  const slab = (p: Float32Array, y0: number, y1: number): V3 => {
    const c: V3 = [0, 0, 0]
    let n = 0
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1]! < y0 || p[i + 1]! > y1) continue
      c[0] += p[i]!
      c[1] += p[i + 1]!
      c[2] += p[i + 2]!
      n++
    }
    return [c[0] / n, c[1] / n, c[2] / n]
  }
  if (bones.femur) {
    const f = surfacePoints(bones.femur, 0.002)
    const [y0, y1] = span(f)
    const top = y1 - 0.12 * (y1 - y0)
    const c0 = slab(f, top, y1)
    const cap: number[] = []
    for (let i = 0; i < f.length; i += 3) if (f[i + 1]! > top && -lat * (f[i]! - c0[0]) + 0.5 * (f[i + 1]! - c0[1]) > 0.01) cap.push(f[i]!, f[i + 1]!, f[i + 2]!)
    out.hip = fitSphere(cap).centre
    out.knee = slab(f, y0, y0 + 0.11 * (y1 - y0))
  }
  if (bones.talus) out.ankle = slab(surfacePoints(bones.talus, 0.002), -Infinity, Infinity)
  if (bones.humerus) {
    const h = surfacePoints(bones.humerus, 0.002)
    const [y0, y1] = span(h)
    out.elbow = slab(h, y0, y0 + 0.08 * (y1 - y0))
  }
  if (bones.capitate) {
    const c = surfacePoints(bones.capitate, 0.002)
    const [y0, y1] = span(c)
    out.wrist = slab(c, y1 - 0.25 * (y1 - y0), y1)
  }
  return out
}

// ── ISB 关节角 / ISB joint angles ────────────────────────────────────────────────────────────

/** 胸廓坐标系（ISB）：行向量依次为 X（向前）、Y（向上）、Z（向右），均以全局坐标表示 / thorax frame (ISB): rows are X (forwards), Y (upwards), Z (to the right) in global coordinates */
export function thoraxFrame(t: ThoraxLandmarks): number[] {
  const up = unit(sub(mul(add(t.ij, t.c7), 0.5), mul(add(t.px, t.t8), 0.5)))
  // Z 垂直于 IJ、C7 与 (PX+T8)/2 所在的平面，指向右（全局 −X） / Z is normal to the plane of IJ, C7 and (PX+T8)/2, pointing right (global −X)
  let z = unit(cross(sub(t.ij, mul(add(t.px, t.t8), 0.5)), sub(t.c7, mul(add(t.px, t.t8), 0.5))))
  if (z[0] > 0) z = mul(z, -1)
  const x = unit(cross(up, z))
  return [...x, ...up, ...unit(cross(x, up))]
}

export interface GirdleAngles {
  /** 锁骨相对胸廓：后缩、上提（度） / clavicle relative to the thorax: retraction, elevation (degrees) */
  clavicleRetraction: number
  clavicleElevation: number
  /** 肩胛骨相对胸廓：内旋、上回旋、前倾（度） / scapula relative to the thorax: internal rotation, upward rotation, anterior tilt (degrees) */
  scapulaInternalRotation: number
  scapulaUpwardRotation: number
  scapulaAnteriorTilt: number
}

/**
 * ISB 定义的肩带角（Wu 等 2005）：锁骨 Y-X-Z、肩胛骨 Y-X-Z 欧拉角，相对胸廓坐标系。
 * 左侧先镜像成右侧再算，所以两侧的正负号含义相同。
 * Girdle angles by the ISB definitions (Wu et al. 2005): Y-X-Z Euler angles of the clavicle and of
 * the scapula relative to the thorax frame. The left side is mirrored to a right side first, so the
 * signs mean the same on both sides.
 */
export function girdleAngles(frame: number[], lat: 1 | -1, lm: Pick<GirdleLandmarks, 'sc' | 'ac' | 'aa' | 'ts' | 'ai'>): GirdleAngles {
  // 全局向量 → 胸廓坐标（X 前、Y 上、Z 外侧） / global vector → thorax coordinates (X forwards, Y up, Z lateral)
  const toT = (v: V3): V3 => {
    const q = rot(frame, v)
    return [q[0], q[1], -lat * q[2]]
  }
  const c = unit(toT(sub(lm.ac, lm.sc)))
  const zs = unit(toT(sub(lm.aa, lm.ts)))
  // X_s：AI、AA、TS 所在平面的法线，指向前 / X_s: normal of the plane of AI, AA and TS, pointing forwards
  let xs = unit(cross(toT(sub(lm.ai, lm.ts)), toT(sub(lm.aa, lm.ts))))
  if (xs[0] < 0) xs = mul(xs, -1)
  const ys = unit(cross(zs, xs))
  // R = Ry(a)·Rx(b)·Rz(c)，列为肩胛骨各轴：R[1][2] = −sin b，R[1][0] = cos b·sin c，R[1][1] = cos b·cos c
  // R = Ry(a)·Rx(b)·Rz(c) with the scapular axes as columns: R[1][2] = −sin b, R[1][0] = cos b·sin c, R[1][1] = cos b·cos c
  return {
    clavicleRetraction: -Math.atan2(c[0], c[2]) * DEG,
    clavicleElevation: Math.asin(c[1]) * DEG,
    scapulaInternalRotation: Math.atan2(zs[0], zs[2]) * DEG,
    scapulaUpwardRotation: Math.asin(zs[1]) * DEG,
    scapulaAnteriorTilt: -Math.atan2(xs[1], ys[1]) * DEG,
  }
}

/**
 * 站立静息位的肩带角：均值与标准差（度）。Ludewig PM 等，J Bone Joint Surg Am 2009;91:378–389，表 I
 * （PMC2657311；12 人，均值 ± 标准误，这里把标准误乘 √12 换成标准差）。
 * Girdle angles in relaxed standing: mean and SD (degrees). Ludewig PM et al., J Bone Joint Surg Am
 * 2009;91:378–389, table I (PMC2657311; 12 subjects, mean ± SE; the SE is turned into an SD by √12 here).
 */
export const RESTING_POSTURE: Record<keyof GirdleAngles, { mean: number; sd: number }> = {
  clavicleRetraction: { mean: 19.2, sd: 2 * Math.sqrt(12) },
  clavicleElevation: { mean: 5.9, sd: 1 * Math.sqrt(12) },
  scapulaInternalRotation: { mean: 41.1, sd: 2 * Math.sqrt(12) },
  scapulaUpwardRotation: { mean: 5.4, sd: 1 * Math.sqrt(12) },
  scapulaAnteriorTilt: { mean: 13.5, sd: 2 * Math.sqrt(12) },
}
export const RESTING_POSTURE_SOURCE = {
  name: 'Ludewig PM, Phadke V, Braman JP, Hassett DR, Cieminski CJ, LaPrade RF. Motion of the shoulder complex during multiplanar humeral elevation. J Bone Joint Surg Am 2009;91(2):378–389, table I',
  url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2657311',
}

// ── 约束求解 / The constrained solve ─────────────────────────────────────────────────────────

export interface GirdleSolveInput {
  lat: 1 | -1
  lm: GirdleLandmarks
  /** 胸廓坐标系（thoraxFrame） / the thorax frame (thoraxFrame) */
  frame: number[]
  /** 肩胛骨肋面的采样点及其静息时到胸廓的间距（米） / samples of the costal surface of the scapula and their resting stand-off from the chest wall (m) */
  costal: Float32Array
  standOff: Float64Array
  /** 胸廓表面（肋、肋间肌、胸椎）的点索引 / point index of the chest wall (ribs, intercostal muscles, thoracic vertebrae) */
  thorax: PointIndex
  /** 目标：肱骨头中心到正中面的距离（米） / target: distance of the humeral head centre from the median plane (m) */
  ghLateral: number
  midX: number
}

export interface GirdleSolveOptions {
  /** 肱骨头外移目标的容差（米）：很小 = 硬约束 / tolerance of the lateral target (m): small = a hard constraint */
  sigmaGh: number
  /** 肩胛骨–胸廓间距偏差的容差（均方根，米） / tolerance of the scapulothoracic stand-off deviation (RMS, m) */
  sigmaStandOff: number
  /** 间距变小时的额外权重倍数（不许肩胛骨压向肋骨） / extra weight when the stand-off shrinks (the scapula must not close on the ribs) */
  closerPenalty: number
  /** 肩锁关节相对转动的容差（弧度） / tolerance of the relative rotation at the acromioclavicular joint (rad) */
  sigmaAc: number
  /** 姿势项的权重（1 = 每偏离文献均值一个标准差记 1） / weight of the posture terms (1 = one unit per SD away from the literature mean) */
  posture: number
}

export const GIRDLE_SOLVE_DEFAULTS: GirdleSolveOptions = { sigmaGh: 0.0003, sigmaStandOff: 0.001, closerPenalty: 3, sigmaAc: (15 * Math.PI) / 180, posture: 1 }

export interface GirdlePose {
  /** 锁骨、肩胛骨、上肢（肱骨及其以远各骨）的刚体变换 / rigid transforms of the clavicle, the scapula and the upper limb (humerus and everything distal) */
  clavicle: RigidT
  scapula: RigidT
  arm: RigidT
  /** 求解后的标志点 / landmarks after the solve */
  lm: GirdleLandmarks
  angles: GirdleAngles
  /** 肩锁关节处肩胛骨相对锁骨的转动（度） / rotation of the scapula relative to the clavicle at the acromioclavicular joint (degrees) */
  acRotationDeg: number
  /** 锁骨绕胸锁关节的转动（度） / rotation of the clavicle about the sternoclavicular joint (degrees) */
  scRotationDeg: number
  /** 肩胛骨–胸廓间距的变化（毫米）：均方根、最大变近、最大变远 / change of the scapulothoracic stand-off (mm): RMS, largest closing, largest opening */
  standOff: { rmsMm: number; maxCloserMm: number; maxFurtherMm: number }
  cost: number
  iterations: number
}

/** 由 5 个参数构造一侧的姿势 / builds the pose of one side from the 5 parameters */
function poseFrom(inp: GirdleSolveInput, p: ArrayLike<number>): { clavicle: RigidT; scapula: RigidT; arm: RigidT; lm: GirdleLandmarks } {
  const { lm, frame } = inp
  const c0 = unit(sub(lm.ac, lm.sc))
  const up: V3 = [frame[3]!, frame[4]!, frame[5]!]
  // 锁骨的转轴都垂直于锁骨长轴：没有绕长轴的自转 / both axes of the clavicle's rotation are normal to its long axis: no axial spin
  const e1 = unit(cross(up, c0))
  const e2 = cross(c0, e1)
  const rc = rotationFromVector(add(mul(e1, p[0]!), mul(e2, p[1]!)))
  const clavicle = aboutPoint(rc, lm.sc)
  const ac1 = applyT(clavicle, lm.ac)
  const rs = matMul(rotationFromVector([p[2]!, p[3]!, p[4]!]), rc)
  const scapula = aboutPoint(rs, lm.ac, ac1)
  const gh1 = applyT(scapula, lm.gh)
  const arm: RigidT = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: sub(gh1, lm.gh) }
  return { clavicle, scapula, arm, lm: { sc: lm.sc, ac: ac1, gh: gh1, ghRadius: lm.ghRadius, aa: applyT(scapula, lm.aa), ts: applyT(scapula, lm.ts), ai: applyT(scapula, lm.ai) } }
}

/** 右侧取左侧的镜像姿势时各参数的符号（旋转向量是赝矢量） / signs of the parameters when one side takes the mirror image of the other's pose (rotation vectors are pseudovectors) */
const MIRROR_SIGNS = [1, -1, 1, -1, -1]

/**
 * 求肩带的姿势：在肱骨头外移到目标、肩胛骨贴胸廓滑动、肩锁关节不脱开的前提下，
 * 使五个 ISB 角偏离站立静息均值（以标准差计）最小。Levenberg–Marquardt，数值雅可比。
 * 给出两侧时两侧共用一组参数：姿势互为镜像（左右两侧的骨在静息位本来就对称到 1 mm 以内，
 * 而自动取的标志点左右会差几度，分开求解会把这点噪声变成不对称的姿势）。
 * Solves the girdle pose: the five ISB angles deviate as little as possible (in SDs) from the
 * standing resting means while the humeral head reaches its lateral target, the scapula glides on
 * the thorax and the acromioclavicular joint stays together. Levenberg–Marquardt, numeric Jacobian.
 * Given both sides, they share one set of parameters and the poses are mirror images (the bones of
 * the two sides are symmetric to within 1 mm at rest, whereas the automatically picked landmarks
 * differ by a few degrees between sides; solving the sides apart would turn that noise into an
 * asymmetric posture).
 */
export function solveGirdle(inputs: GirdleSolveInput[], opts: GirdleSolveOptions = GIRDLE_SOLVE_DEFAULTS): GirdlePose[] {
  const keys = Object.keys(RESTING_POSTURE) as (keyof GirdleAngles)[]
  const P = 5
  const sideParams = (p: ArrayLike<number>, k: number): number[] => Array.from({ length: P }, (_, j) => p[j]! * (inputs[k]!.lat === inputs[0]!.lat ? 1 : MIRROR_SIGNS[j]!))
  const dist = (inp: GirdleSolveInput, q: ArrayLike<number>) => {
    const n = inp.costal.length / 3
    const { scapula } = poseFrom(inp, q)
    const pts = applyToPoints(scapula, inp.costal)
    const d = new Float64Array(n)
    for (let i = 0; i < n; i++) d[i] = inp.thorax.distance(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!, 0.2) - inp.standOff[i]!
    return d
  }
  const residuals = (p: ArrayLike<number>): Float64Array => {
    const r: number[] = []
    inputs.forEach((inp, k) => {
      const q = sideParams(p, k)
      const pose = poseFrom(inp, q)
      const a = girdleAngles(inp.frame, inp.lat, pose.lm)
      for (const key of keys) r.push((opts.posture * (a[key] - RESTING_POSTURE[key].mean)) / RESTING_POSTURE[key].sd)
      r.push((inp.lat * (pose.lm.gh[0] - inp.midX) - inp.ghLateral) / opts.sigmaGh)
      r.push(q[2]! / opts.sigmaAc, q[3]! / opts.sigmaAc, q[4]! / opts.sigmaAc)
      const d = dist(inp, q)
      const s = 1 / (opts.sigmaStandOff * Math.sqrt(d.length))
      for (let i = 0; i < d.length; i++) r.push(d[i]! * s * (d[i]! < 0 ? opts.closerPenalty : 1))
    })
    return Float64Array.from(r)
  }
  const cost = (r: Float64Array) => r.reduce((s, v) => s + v * v, 0)
  let p = new Float64Array(P)
  let r = residuals(p)
  let c = cost(r)
  let lambda = 1e-3
  let it = 0
  for (; it < 200; it++) {
    const J = new Float64Array(r.length * P)
    for (let k = 0; k < P; k++) {
      const h = 1e-4
      const q = Float64Array.from(p)
      q[k] = q[k]! + h
      const r1 = residuals(q)
      q[k] = p[k]! - h
      const r0 = residuals(q)
      for (let i = 0; i < r.length; i++) J[i * P + k] = (r1[i]! - r0[i]!) / (2 * h)
    }
    const A = new Float64Array(P * P)
    const g = new Float64Array(P)
    for (let i = 0; i < r.length; i++) for (let a = 0; a < P; a++) {
      g[a] = g[a]! - J[i * P + a]! * r[i]!
      for (let b = 0; b < P; b++) A[a * P + b] = A[a * P + b]! + J[i * P + a]! * J[i * P + b]!
    }
    let improved = false
    for (let tries = 0; tries < 12; tries++) {
      const Al = Float64Array.from(A)
      for (let a = 0; a < P; a++) Al[a * P + a] = Al[a * P + a]! * (1 + lambda) + 1e-12
      const dp = solveLinear(Al, g, P)
      const q = p.map((v, k) => v + dp[k]!)
      const rq = residuals(q)
      const cq = cost(rq)
      if (cq < c) {
        const gain = c - cq
        p = q
        r = rq
        c = cq
        lambda = Math.max(1e-9, lambda / 3)
        improved = gain > 1e-10 * (1 + c)
        break
      }
      lambda *= 4
    }
    if (!improved) break
  }
  return inputs.map((inp, k) => {
    const q = sideParams(p, k)
    const pose = poseFrom(inp, q)
    const d = dist(inp, q)
    let sq = 0
    let closer = 0
    let further = 0
    for (const v of d) {
      sq += v * v
      if (-v > closer) closer = -v
      if (v > further) further = v
    }
    const rs = matMul(pose.scapula.r, transpose(pose.clavicle.r))
    return {
      ...pose, angles: girdleAngles(inp.frame, inp.lat, pose.lm),
      acRotationDeg: rotationAngleOf(rs) * DEG, scRotationDeg: rotationAngleOf(pose.clavicle.r) * DEG,
      standOff: { rmsMm: Math.sqrt(sq / d.length) * 1000, maxCloserMm: closer * 1000, maxFurtherMm: further * 1000 },
      cost: c, iterations: it,
    }
  })
}

export { surfacePoints, thinPoints, sub as vsub, add as vadd, mul as vmul, dot as vdot, cross as vcross, len as vlen, unit as vunit, rot as rotate }
