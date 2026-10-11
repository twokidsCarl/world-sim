// 肌肉包络的围度测量与“瘦身”：把贴在骨上的软组织朝最近的骨面收拢，使肌肉包络的横截面变小，
// 长度和附着点不变。用来把由男性形变而来的肌肉包络收到参考女性（BMI 22）的围度以内。
// Girths of the muscle envelope, and its slimming: soft tissue lying on bone is drawn towards the
// nearest bone surface, which shrinks the cross-section of the muscle envelope and leaves lengths
// and attachments alone. Used to bring a muscle envelope warped from the male inside the girths of
// the reference female (BMI 22).

import type { Mesh } from './geometry.ts'
import { PointIndex } from './register.ts'
import type { Vec3 } from './standard.ts'

// ── 围度 / girths ──────────────────────────────────────────────────────────────────────────

/** 二维凸包的周长（单调链） / perimeter of the 2D convex hull (monotone chain) */
export function hullPerimeter(pts: [number, number][]): number {
  if (pts.length < 3) return 0
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  let s = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    s += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return s
}

/**
 * 一组网格被平面（过 origin、法向 normal）所截轮廓的凸包周长——即皮尺绕一圈量到的围度。
 * `keep` 筛掉平面上不属于该肢段的截点（例如量大腿时的另一条腿）。
 * Perimeter of the convex hull of the cut of a set of meshes by a plane (through origin, normal
 * `normal`): what a tape measure reads. `keep` drops cut points that do not belong to the segment
 * (the other leg when a thigh is measured, for instance).
 */
export function sectionGirth(meshes: Mesh[], origin: Vec3, normal: Vec3, keep?: (p: Vec3) => boolean): number {
  const l = Math.hypot(normal[0], normal[1], normal[2])
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l]
  // 平面内的一组正交基 / an orthonormal basis of the plane
  const a: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u: Vec3 = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]]
  const ul = Math.hypot(u[0], u[1], u[2])
  u[0] /= ul
  u[1] /= ul
  u[2] /= ul
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const pts: [number, number][] = []
  for (const m of meshes) {
    const p = m.positions
    const nv = p.length / 3
    const d = new Float32Array(nv)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < nv; i++) {
      d[i] = (p[3 * i]! - origin[0]) * n[0] + (p[3 * i + 1]! - origin[1]) * n[1] + (p[3 * i + 2]! - origin[2]) * n[2]
      if (d[i]! < lo) lo = d[i]!
      if (d[i]! > hi) hi = d[i]!
    }
    if (lo > 0 || hi < 0) continue
    for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const i = m.indices[t + k]!
      const j = m.indices[t + ((k + 1) % 3)]!
      if (d[i]! > 0 === d[j]! > 0) continue
      const f = d[i]! / (d[i]! - d[j]!)
      const q: Vec3 = [p[3 * i]! + f * (p[3 * j]! - p[3 * i]!), p[3 * i + 1]! + f * (p[3 * j + 1]! - p[3 * i + 1]!), p[3 * i + 2]! + f * (p[3 * j + 2]! - p[3 * i + 2]!)]
      if (keep && !keep(q)) continue
      const r: Vec3 = [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]]
      pts.push([r[0] * u[0] + r[1] * u[1] + r[2] * u[2], r[0] * v[0] + r[1] * v[1] + r[2] * v[2]])
    }
  }
  return hullPerimeter(pts)
}

// ── 瘦身场 / the slimming field ────────────────────────────────────────────────────────────

export interface SlimSegment {
  id: string
  /** 本段骨表面的采样点 / surface samples of the segment's bones */
  bonePoints: Float32Array
  /**
   * limb：软组织到最近骨面的距离整体乘以 λ（整段肢体，含皮肤）。
   * trunk：只动骨性胸廓之外的组织，向最近骨面收拢 (1 − λ)·min(d, saturate)。
   * limb: the distance of soft tissue to the nearest bone surface is multiplied by λ (the whole limb, skin included).
   * trunk: only tissue outside the bony cage moves, by (1 − λ)·min(d, saturate) towards the nearest bone surface.
   */
  mode: 'limb' | 'trunk'
  /** limb：近端、远端关节中心，λ 沿两者之间的位置 t ∈ [0, 1] 变化 / limb: proximal and distal joint centres; λ varies with the position t ∈ [0, 1] between them */
  axis?: [Vec3, Vec3]
  /** λ 的折线节点 [t, λ]（trunk 只用第一个节点的 λ） / nodes [t, λ] of the piecewise-linear λ (trunk uses the first node's λ only) */
  lambda: [number, number][]
  /** trunk：位移饱和的深度（米） / trunk: depth at which the displacement saturates (m) */
  saturate?: number
  /** trunk：躯干轴在 XZ 平面的位置，用来判断组织在骨的外侧还是内侧 / trunk: the trunk axis in the XZ plane, to tell tissue outside the bone from tissue inside */
  centre?: [number, number]
}

const lambdaAt = (nodes: [number, number][], t: number): number => {
  if (t <= nodes[0]![0]) return nodes[0]![1]
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!
    const b = nodes[i]!
    if (t <= b[0]) return a[1] + ((t - a[0]) / (b[0] - a[0] || 1)) * (b[1] - a[1])
  }
  return nodes[nodes.length - 1]![1]
}

export interface Slimmer {
  /** 对一组点施加瘦身位移；bbox 用来跳过与之无关的肢段 / applies the slimming displacement to points; the bbox lets unrelated segments be skipped */
  apply(points: Float32Array): Float32Array
}

/**
 * 由若干肢段建立瘦身场。每个点对其附近（`reach` 以内）的每个肢段各算一个位移，再按
 * 1/(d + 2 mm)⁴ 加权平均，使相邻肢段之间（腋窝、肘、腹股沟）平滑过渡。
 * Builds the slimming field from segments. A point gets one displacement from every segment near
 * it (within `reach`), averaged with weights 1/(d + 2 mm)⁴ so that neighbouring segments (axilla,
 * elbow, groin) pass smoothly into each other.
 */
export function buildSlimmer(segments: SlimSegment[], reach = 0.12): Slimmer {
  const idx = segments.map((s) => new PointIndex(s.bonePoints, 0.012))
  const boxes = segments.map((s) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < s.bonePoints.length; i += 3) for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k]!, s.bonePoints[i + k]! - reach)
      b[k + 3] = Math.max(b[k + 3]!, s.bonePoints[i + k]! + reach)
    }
    return b
  })
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  return {
    apply(points) {
      const out = Float32Array.from(points)
      const pb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
        pb[k] = Math.min(pb[k]!, points[i + k]!)
        pb[k + 3] = Math.max(pb[k + 3]!, points[i + k]!)
      }
      const active = segments.map((_, s) => !(boxes[s]![0]! > pb[3]! || boxes[s]![3]! < pb[0]! || boxes[s]![1]! > pb[4]! || boxes[s]![4]! < pb[1]! || boxes[s]![2]! > pb[5]! || boxes[s]![5]! < pb[2]!))
      if (!active.some(Boolean)) return out
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i]!
        const y = points[i + 1]!
        const z = points[i + 2]!
        let ws = 0
        let ux = 0
        let uy = 0
        let uz = 0
        for (let s = 0; s < segments.length; s++) {
          if (!active[s]) continue
          const bx = boxes[s]!
          if (x < bx[0]! || x > bx[3]! || y < bx[1]! || y > bx[4]! || z < bx[2]! || z > bx[5]!) continue
          if (!idx[s]!.nearest(x, y, z, 1, I, D, reach)) continue
          const seg = segments[s]!
          const q = 3 * I[0]!
          const d = Math.sqrt(D[0]!)
          const vx = seg.bonePoints[q]! - x
          const vy = seg.bonePoints[q + 1]! - y
          const vz = seg.bonePoints[q + 2]! - z
          let f = 0
          if (seg.mode === 'limb') {
            const [a, b] = seg.axis!
            const ax = b[0] - a[0]
            const ay = b[1] - a[1]
            const az = b[2] - a[2]
            const t = ((x - a[0]) * ax + (y - a[1]) * ay + (z - a[2]) * az) / (ax * ax + ay * ay + az * az)
            f = 1 - lambdaAt(seg.lambda, t)
          } else if (d > 1e-6) {
            const c = seg.centre!
            const rp = Math.hypot(x - c[0], z - c[1])
            const rb = Math.hypot(seg.bonePoints[q]! - c[0], seg.bonePoints[q + 2]! - c[1])
            // 只动骨外侧的组织；紧贴骨的那一层按到骨的距离平滑起步
            // only tissue outside the bone moves, starting smoothly with the distance from the bone
            if (rp > rb) f = ((1 - seg.lambda[0]![1]) * Math.min(d, seg.saturate ?? 0.03)) / d
          }
          const w = 1 / (d + 0.002) ** 4
          ws += w
          ux += w * f * vx
          uy += w * f * vy
          uz += w * f * vz
        }
        if (ws > 0) {
          out[i] = x + ux / ws
          out[i + 1] = y + uy / ws
          out[i + 2] = z + uz / ws
        }
      }
      return out
    },
  }
}
