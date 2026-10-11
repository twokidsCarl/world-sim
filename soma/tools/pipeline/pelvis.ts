// 盆腔的几何协调：围绕一个管状器官（阴道）在邻近组织中开出一条通道。
// 女性的盆底肌、直肠和盆腔血管神经来自男性模型，其中没有阴道通过的裂孔；这里用一个光滑的、
// 单调的径向位移场，把落在该器官周围“半径 + 间隙”以内的邻近组织沿径向推到这个范围之外。
// Making the pelvis geometrically consistent: a tunnel is opened in neighbouring tissue round a
// tubular organ (the vagina). The female's pelvic floor, rectum and pelvic vessels and nerves come
// from the male model, which has no hiatus for a vagina; a smooth, monotone radial displacement
// field moves neighbouring tissue that lies within "radius + clearance" of the organ out of that range.

import type { Mesh } from './geometry.ts'
import { surfacePoints } from './register.ts'
import { axisParam, type Vec3 } from './standard.ts'

export interface Tunnel {
  /** 把通道内的点沿径向推出去；通道以外的点基本不动 / pushes points inside the tunnel out radially; points outside hardly move */
  apply(points: Float32Array): Float32Array
  /**
   * 分侧的结构（左、右肛提肌各部）：只沿左右方向推向自己一侧（side = +1 左，−1 右），使其内侧缘位于器官
   * 该侧表面之外；在器官前后范围之外平滑收到零，所以绕到直肠后方的肌束不受影响。
   * Sided structures (the left and right parts of levator ani): pushed sideways only, towards their own
   * side (side = +1 left, −1 right), so that their medial border lies outside the organ's surface on that
   * side; fades to zero beyond the organ's front-to-back extent, so the sling behind the rectum is not affected.
   */
  applyLateral(points: Float32Array, side: 1 | -1): Float32Array
  /** 器官沿长轴的长度（米）和长轴方向（指向上） / the organ's length along its long axis (m) and the axis direction (pointing up) */
  length: number
  axis: Vec3
  /** 点到器官表面的带符号径向距离（米，负值在器官半径以内） / signed radial distance of a point to the organ's surface (m, negative inside the organ's radius) */
  clearanceOf(p: Vec3): number
}

const AXIAL = 16
const ANGULAR = 16

/**
 * 由管状器官的网格建立通道场。器官沿主轴分成若干段，每段取质心为中心线点，并按方位角记录表面的径向范围。
 * `clearance`：器官表面之外保留的间隙；`soft`：位移过渡的宽度（softplus），保证场光滑且单调。
 * Builds the tunnel field from the mesh of a tubular organ. The organ is cut into slabs along its
 * principal axis; each slab's centroid is a centreline point and the radial reach of the surface is
 * recorded per direction. `clearance`: gap kept outside the organ's surface; `soft`: width of the
 * transition (a softplus), which keeps the field smooth and monotone.
 */
export function buildTunnel(organ: Mesh, clearance = 0.002, soft = 0.0015): Tunnel {
  const pts = surfacePoints(organ, 0.0015)
  const ax = axisParam(pts)
  const a = ax.axis
  // 垂直于长轴的一组正交基 / an orthonormal basis across the axis
  const h: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
  const d0 = h[0] * a[0] + h[1] * a[1] + h[2] * a[2]
  let u: Vec3 = [h[0] - d0 * a[0], h[1] - d0 * a[1], h[2] - d0 * a[2]]
  const ul = Math.hypot(u[0], u[1], u[2])
  u = [u[0] / ul, u[1] / ul, u[2] / ul]
  const v: Vec3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]
  let lo = Infinity
  let hi = -Infinity
  const n = pts.length / 3
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s[i] = (pts[3 * i]! - ax.c[0]) * a[0] + (pts[3 * i + 1]! - ax.c[1]) * a[1] + (pts[3 * i + 2]! - ax.c[2]) * a[2]
    lo = Math.min(lo, s[i]!)
    hi = Math.max(hi, s[i]!)
  }
  const length = hi - lo
  const bin = (t: number) => Math.max(0, Math.min(AXIAL - 1, Math.floor(((t - lo) / length) * AXIAL)))
  const centre = Array.from({ length: AXIAL }, () => [0, 0, 0, 0])
  for (let i = 0; i < n; i++) {
    const c = centre[bin(s[i]!)]!
    c[0] = c[0]! + pts[3 * i]!
    c[1] = c[1]! + pts[3 * i + 1]!
    c[2] = c[2]! + pts[3 * i + 2]!
    c[3] = c[3]! + 1
  }
  for (const c of centre) if (c[3]! > 0) {
    c[0] = c[0]! / c[3]!
    c[1] = c[1]! / c[3]!
    c[2] = c[2]! / c[3]!
  }
  const radius = new Float32Array(AXIAL * ANGULAR)
  const polar = (p: Vec3, b: number): [number, number, Vec3] => {
    const c = centre[b]!
    const dx = p[0] - c[0]!
    const dy = p[1] - c[1]!
    const dz = p[2] - c[2]!
    const al = dx * a[0] + dy * a[1] + dz * a[2]
    const r: Vec3 = [dx - al * a[0], dy - al * a[1], dz - al * a[2]]
    const rho = Math.hypot(r[0], r[1], r[2])
    const ang = Math.atan2(r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2])
    return [rho, ang, rho > 1e-9 ? [r[0] / rho, r[1] / rho, r[2] / rho] : u]
  }
  const abin = (ang: number) => ((Math.floor(((ang + Math.PI) / (2 * Math.PI)) * ANGULAR) % ANGULAR) + ANGULAR) % ANGULAR
  for (let i = 0; i < n; i++) {
    const b = bin(s[i]!)
    const [rho, ang] = polar([pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!], b)
    const k = b * ANGULAR + abin(ang)
    if (rho > radius[k]!) radius[k] = rho
  }
  // 取相邻段、相邻方位的最大值，使半径函数平缓并偏保守 / the maximum over neighbouring slabs and directions: a gentle, conservative radius
  const reach = (b: number, ang: number) => {
    let r = 0
    const k = abin(ang)
    for (let db = -1; db <= 1; db++) for (let dk = -1; dk <= 1; dk++) {
      const bb = Math.max(0, Math.min(AXIAL - 1, b + db))
      r = Math.max(r, radius[bb * ANGULAR + ((k + dk + ANGULAR) % ANGULAR)]!)
    }
    return r
  }
  const evalAt = (p: Vec3) => {
    const t = (p[0] - ax.c[0]) * a[0] + (p[1] - ax.c[1]) * a[1] + (p[2] - ax.c[2]) * a[2]
    const b = bin(t)
    const [rho, ang, dir] = polar(p, b)
    // 两端之外 8 mm 内平滑收到零 / fades to zero within 8 mm beyond either end
    const out = t < lo ? lo - t : t > hi ? t - hi : 0
    const end = Math.max(0, 1 - out / 0.008)
    return { rho, dir, R: reach(b, ang), end }
  }
  // 每段在左右（X）方向的范围和前后（Z）方向的范围 / each slab's extent left-right (X) and front-back (Z)
  const xLo = new Float32Array(AXIAL).fill(Infinity)
  const xHi = new Float32Array(AXIAL).fill(-Infinity)
  const zLo = new Float32Array(AXIAL).fill(Infinity)
  const zHi = new Float32Array(AXIAL).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    const b = bin(s[i]!)
    xLo[b] = Math.min(xLo[b]!, pts[3 * i]!)
    xHi[b] = Math.max(xHi[b]!, pts[3 * i]!)
    zLo[b] = Math.min(zLo[b]!, pts[3 * i + 2]!)
    zHi[b] = Math.max(zHi[b]!, pts[3 * i + 2]!)
  }
  const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
  return {
    length,
    axis: a,
    applyLateral(points, side) {
      const out = Float32Array.from(points)
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i]!
        const z = points[i + 2]!
        const t = (x - ax.c[0]) * a[0] + (points[i + 1]! - ax.c[1]) * a[1] + (z - ax.c[2]) * a[2]
        const outAx = t < lo ? lo - t : t > hi ? t - hi : 0
        if (outAx >= 0.008) continue
        const b0 = bin(t)
        let limit = side > 0 ? -Infinity : Infinity
        let z0 = Infinity
        let z1 = -Infinity
        for (let db = -1; db <= 1; db++) {
          const b = Math.max(0, Math.min(AXIAL - 1, b0 + db))
          limit = side > 0 ? Math.max(limit, xHi[b]!) : Math.min(limit, xLo[b]!)
          z0 = Math.min(z0, zLo[b]!)
          z1 = Math.max(z1, zHi[b]!)
        }
        const outZ = z < z0 ? z0 - z : z > z1 ? z - z1 : 0
        const w = smoothstep(1 - outAx / 0.008) * smoothstep(1 - outZ / 0.008)
        if (w <= 0) continue
        // 需要到达的位置：器官该侧表面之外 clearance 处 / where the point must get to: `clearance` beyond the organ's surface on that side
        const need = side > 0 ? limit + clearance - x : x - (limit - clearance)
        const q = need / soft
        if (q < -12) continue
        out[i] = x + side * w * soft * (q > 30 ? q : Math.log1p(Math.exp(q)))
      }
      return out
    },
    clearanceOf(p) {
      const e = evalAt(p)
      return e.end > 0 ? e.rho - e.R : Infinity
    },
    apply(points) {
      const out = Float32Array.from(points)
      for (let i = 0; i < points.length; i += 3) {
        const e = evalAt([points[i]!, points[i + 1]!, points[i + 2]!])
        if (e.end <= 0) continue
        const x = (e.R + clearance - e.rho) / soft
        if (x < -12) continue
        // softplus：ρ′ = ρ + soft·ln(1 + e^x)，对 ρ 单调递增 / softplus: ρ′ = ρ + soft·ln(1 + e^x), increasing in ρ
        const push = soft * (x > 30 ? x : Math.log1p(Math.exp(x))) * e.end * e.end * (3 - 2 * e.end)
        out[i] = points[i]! + push * e.dir[0]
        out[i + 1] = points[i + 1]! + push * e.dir[1]
        out[i + 2] = points[i + 2]! + push * e.dir[2]
      }
      return out
    },
  }
}
