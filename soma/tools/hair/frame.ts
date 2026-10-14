// 头部坐标系和头皮区域：从每个人体自己的皮肤（眦点、额部、头顶、耳）定出，所以女性的发际线和额头形状来自她自己的头。
// The head frame and the scalp region: set from each body's own skin (canthi, forehead, vertex, ears), so the
// female hairline and forehead shape come from her own head.
//
// 头部坐标：原点在两眼之间、颅前后径的中点；x 向身体左侧，y 向上，z 向前。
// 方位角 φ（度）：0 正前，+90 身体左侧，±180 正后。发际线是 φ 的函数：发际线以上（并离耳朵够远）的皮肤是头皮。
// Head coordinates: origin between the eyes, mid-way front to back of the cranium; x to the body's left, y up, z forward.
// Azimuth φ (degrees): 0 straight ahead, +90 the body's left, ±180 straight behind. The hairline is a function of φ:
// skin above it (and far enough from the ears) is scalp.

import type { BodyData } from './skin.ts'
import { type Surface, type V3, at, cross, dot, len, norm, sub } from './geom.ts'

export interface Ear {
  /** +1 身体左侧，−1 右侧 / +1 the body's left, −1 the right */
  side: number
  phi: [number, number]
  h: [number, number]
  n: number
}

export interface HeadFrame {
  origin: V3
  x: V3
  y: V3
  z: V3
  /** 两眼内外眦的中点 / mid-point of the four canthi */
  eye: V3
  /** 头顶（颅顶点）离原点的高度（米）/ height of the vertex above the origin (m) */
  top: number
  /** 鼻根点（中线上两眼之间最凹处）的头部坐标 / the nasion in head coordinates */
  nasion: V3
  /** 两耳：方位角范围（度，取绝对值）和高度范围（头部坐标 y）/ the ears: azimuth range (degrees, absolute) and height range (head y) */
  ears: Ear[]
}

export const toHead = (f: HeadFrame, p: V3): V3 => {
  const d = sub(p, f.origin)
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)]
}
export const fromHeadDir = (f: HeadFrame, d: V3): V3 => [
  f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2],
  f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2],
  f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2],
]
export const fromHead = (f: HeadFrame, l: V3): V3 => {
  const d = fromHeadDir(f, l)
  return [f.origin[0] + d[0], f.origin[1] + d[1], f.origin[2] + d[2]]
}
/** 方位角（度）/ azimuth (degrees) */
export const azimuth = (l: V3): number => (Math.atan2(l[0], l[2]) * 180) / Math.PI

/** 头部坐标系 / the head frame */
export function headFrame(b: BodyData, surface: Surface): HeadFrame {
  const P = b.skin.positions
  const c = ['medialCanthusL', 'lateralCanthusL', 'medialCanthusR', 'lateralCanthusR'].map((k) => at(P, b.points[k]!))
  const eye: V3 = [0, 1, 2].map((k) => (c[0]![k]! + c[1]![k]! + c[2]![k]! + c[3]![k]!) / 4) as V3
  const x = norm(sub(c[1]!, c[3]!))
  let y: V3 = [0, 1, 0]
  y = norm(sub(y, [x[0] * dot(y, x), x[1] * dot(y, x), x[2] * dot(y, x)]))
  const z = cross(x, y)
  // 额部最前点与枕部最后点（眼上 4 厘米，中线上）定出前后中点 / the front of the forehead and the back of the occiput (4 cm above the eyes, on the midline) set the mid-point
  const probe: V3 = [eye[0] + y[0] * 0.04, eye[1] + y[1] * 0.04, eye[2] + y[2] * 0.04]
  const back: V3 = [probe[0] - z[0] * 0.3, probe[1] - z[1] * 0.3, probe[2] - z[2] * 0.3]
  const behind = surface.ray(back, z, 0.6)
  const front = surface.ray([probe[0] + z[0] * 0.3, probe[1] + z[1] * 0.3, probe[2] + z[2] * 0.3], [-z[0], -z[1], -z[2]], 0.6)
  if (!isFinite(front) || !isFinite(behind)) throw new Error('head frame: the midline rays missed the head')
  const zFront = 0.3 - front, zBack = -(0.3 - behind) // 相对 probe 的 z / z relative to probe
  const zMid = (zFront + zBack) / 2
  const origin: V3 = [eye[0] + z[0] * zMid, eye[1] + z[1] * zMid, eye[2] + z[2] * zMid]
  const f: HeadFrame = { origin, x, y, z, eye, top: 0, nasion: [0, 0, 0], ears: [] }
  // 头顶：从原点往上 / the vertex: straight up from the origin
  const up = surface.ray(origin, y, 0.4)
  f.top = up
  // 鼻根：中线上眼高附近最靠后的皮肤点 / the nasion: the most posterior skin point on the midline near eye height
  let nas: V3 = [0, 0, 0], best = Infinity
  for (let h = -0.01; h <= 0.03; h += 0.001) {
    const o = fromHead(f, [0, h, 0.3])
    const d = surface.ray(o, [-z[0], -z[1], -z[2]], 0.5)
    if (isFinite(d) && 0.3 - d < best + 1e-9 && h > -0.005) {
      // 鼻根是眼高以上中线轮廓的最凹点 / the nasion is the deepest point of the midline profile above eye height
      if (0.3 - d < best) {
        best = 0.3 - d
        nas = [0, h, 0.3 - d]
      }
    }
  }
  f.nasion = nas
  f.ears = findEars(b, f)
  return f
}

/**
 * 找耳朵：头两侧（方位角 72°–125°、眼高上下）网格细密的地方就是耳廓——头皮的三角形边长约 1 厘米，耳廓的只有几毫米
 * （耳廓在这张皮肤上是浅浮雕，从头中心射线找"被挡住的顶点"找不到它）。
 * Finding the ears: on either side of the head (azimuth 72°–125°, around eye height) the finely meshed patch is the
 * auricle — scalp triangles have edges of about 1 cm, the auricle's only a few millimetres (on this skin the auricle
 * is a low relief, so looking for vertices occluded from the head centre does not find it).
 */
function findEars(b: BodyData, f: HeadFrame): Ear[] {
  const P = b.skin.positions, I = b.skin.indices, n = P.length / 3
  const sum = new Float32Array(n), cnt = new Uint16Array(n)
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = I[t + k]!, c = I[t + ((k + 1) % 3)]!
      const e = len(sub(at(P, a), at(P, c)))
      sum[a] = sum[a]! + e
      sum[c] = sum[c]! + e
      cnt[a] = cnt[a]! + 1
      cnt[c] = cnt[c]! + 1
    }
  }
  // 带里网格边长的中位数 × 1.6 作为阈值：两个人体的网格疏密不同（男性耳廓边长约 5 毫米，女性约 1 毫米）
  // threshold = 1.6 × the median edge length in the band: the two bodies are meshed differently (male auricle edges about 5 mm, female about 1 mm)
  const band: { i: number; a: number; l: V3; e: number }[] = []
  for (let i = 0; i < n; i++) {
    const l = toHead(f, at(P, i))
    const a = azimuth(l)
    if (Math.abs(a) < 76 || Math.abs(a) > 125 || l[1] < -0.07 || l[1] > 0.03 || !cnt[i]) continue
    band.push({ i, a, l, e: sum[i]! / cnt[i]! })
  }
  const sorted = band.map((x) => x.e).sort((x, y) => x - y)
  const threshold = 1.6 * sorted[Math.floor(sorted.length * 0.5)]!
  const ears: Ear[] = [1, -1].map((side) => ({ side, phi: [Infinity, -Infinity], h: [Infinity, -Infinity], n: 0 }))
  for (const { a, l, e: edge } of band) {
    if (edge > threshold) continue
    const e = ears[a > 0 ? 0 : 1]!
    e.phi = [Math.min(e.phi[0], Math.abs(a)), Math.max(e.phi[1], Math.abs(a))]
    e.h = [Math.min(e.h[0], l[1]), Math.max(e.h[1], l[1])]
    e.n++
  }
  for (const e of ears) if (e.n < 30) throw new Error(`ear detection found only ${e.n} vertices on one side`)
  return ears
}

/** 发际线的一个控制点：方位角（度）和发际线高度（头部坐标 y，米）/ a hairline knot: azimuth (degrees) and hairline height (head y, m) */
export type Knot = [number, number]

/** 发际线高度：控制点间按方位角做余弦插值，左右对称 / hairline height: cosine interpolation between knots in azimuth, mirrored left-right */
export function hairlineAt(knots: Knot[], phiDeg: number): number {
  const a = Math.abs(phiDeg)
  if (a <= knots[0]![0]) return knots[0]![1]
  for (let i = 1; i < knots.length; i++) {
    const [p1, h1] = knots[i]!, [p0, h0] = knots[i - 1]!
    if (a <= p1) {
      const t = (a - p0) / (p1 - p0)
      const s = (1 - Math.cos(Math.PI * t)) / 2
      return h0 + (h1 - h0) * s
    }
  }
  return knots[knots.length - 1]![1]
}

/** 离耳廓的距离（米，近似：方位角差按头的半径换成弧长）；在耳廓上为 0 / distance from the auricle (m, approximately: the azimuth difference turned into arc length by the head radius); 0 on it */
export function earDistance(f: HeadFrame, l: V3): number {
  const a = azimuth(l)
  const r = Math.hypot(l[0], l[2])
  let best = Infinity
  for (const e of f.ears) {
    if (Math.sign(a) !== e.side) continue
    const dPhi = Math.max(e.phi[0] - Math.abs(a), 0, Math.abs(a) - e.phi[1])
    const dh = Math.max(e.h[0] - l[1], 0, l[1] - e.h[1])
    best = Math.min(best, Math.hypot((dPhi * Math.PI * r) / 180, dh))
  }
  return best
}
