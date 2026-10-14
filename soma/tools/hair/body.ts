// 胡须、阴毛、腋毛：在每个人体自己的皮肤上划出区域，按文献（或标明的假设）密度撒根，长成贴着皮肤的短毛或卷毛。
// Beard, pubic and axillary hair: regions marked out on each body's own skin, roots scattered at the literature's (or the
// marked assumed) density, grown into short hairs or curls lying along the skin.

import { type HeadFrame, azimuth, fromHeadDir, hairlineAt, toHead } from './frame.ts'
import { lieAlong } from './face.ts'
import { type Surface, type V3, add, at, cross, dot, gauss, len, mix, norm, rng, rotate, scale, sub, tangential } from './geom.ts'
import { type Root, scatter } from './sample.ts'
import type { Params, Scalp } from './scalp.ts'
import type { BodyData } from './skin.ts'
import type { Strand } from './strands.ts'

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 头附近的三角形（加快撒点）/ triangles near a box (to speed up scattering) */
function trianglesWhere(b: BodyData, keep: (p: V3) => boolean): [number, number, number][] {
  const I = b.skin.indices, P = b.skin.positions
  const out: [number, number, number][] = []
  for (let t = 0; t < I.length; t += 3) {
    const tri: [number, number, number] = [I[t]!, I[t + 1]!, I[t + 2]!]
    if (tri.some((v) => keep(at(P, v)))) out.push(tri)
  }
  return out
}

export interface BeardRegion {
  /** 一点的胡须密度（毛囊单位每平方米），区域外为 0 / beard density at a point (follicular units per m²), 0 outside */
  density: (p: V3) => number
  /** 0–1 的相对密度（头皮底色那样的遮罩用）/ relative density 0–1 (for a tint-like mask) */
  weight: (p: V3) => number
  /** 一点属于哪一区（统计用）/ which region a point belongs to (for statistics) */
  label: (p: V3) => 'moustache' | 'chin' | 'cheek' | 'neck' | null
  triangles: [number, number, number][]
}

/**
 * 胡须区：颊线（从鬓角斜向口角上方）以下，下颌缘下 3.5 厘米的颈线以上；唇红（口裂周围的椭圆）和鼻不算。
 * 密度：上唇中部最密，上唇两侧、颏次之，颊最稀（Dua 等 2021），颈部为假设。
 * The beard region: below the cheek line (running from the sideburn down towards the mouth corner) and above a neck
 * line 3.5 cm below the jaw; the vermilion (an ellipse around the mouth opening) and the nose are left out. Density:
 * highest in the middle of the upper lip, then the sides of the moustache and the chin, lowest on the cheeks (Dua et al.
 * 2021); the neck value is assumed.
 */
export function beardRegion(b: BodyData, f: HeadFrame, scalp: Scalp, P: Params): BeardRegion {
  const Pp = b.skin.positions
  const mL = toHead(f, at(Pp, b.points.mouthCornerL!)), mR = toHead(f, at(Pp, b.points.mouthCornerR!))
  const mouth: V3 = [(mL[0] + mR[0]) / 2, (mL[1] + mR[1]) / 2, (mL[2] + mR[2]) / 2]
  const halfW = Math.abs(mL[0] - mR[0]) / 2
  const D = P.beardDensity
  const weight = (p: V3): number => {
    const l = toHead(f, p)
    const phi = Math.abs(azimuth(l))
    if (phi > 100 || l[1] > 0) return 0
    const dy = l[1] - mouth[1]
    // 颊线：口角上方 2 厘米，向外斜升到鬓角底（头皮发际线）/ cheek line: 2 cm above the mouth corner, rising outward to the bottom of the sideburn (the scalp hairline)
    const sideburn = hairlineAt(scalp.knots, 78) + 0.004
    const top = phi < 20 ? mouth[1] + 0.019 : mouth[1] + 0.019 + (sideburn - mouth[1] - 0.019) * smooth(20, 78, phi)
    if (l[1] > top) return 0
    // 颈线：口下 6 厘米（下颌下约 2.5 厘米），向两侧升到下颌角 / neck line: 6 cm below the mouth (about 2.5 cm under the jaw), rising at the sides to the jaw angle
    const bottom = mouth[1] - 0.062 + 0.025 * smooth(40, 90, phi)
    if (l[1] < bottom) return 0
    // 唇红和口裂：口周的椭圆 / vermilion and fissure: an ellipse round the mouth
    const ex = (l[0] - mouth[0]) / (halfW + 0.003), ey = dy / (dy > 0 ? 0.009 : 0.011)
    if (l[2] > mouth[2] - 0.02 && ex * ex + ey * ey < 1) return 0
    // 鼻：口上 1.9 厘米以上、中线附近已被颊线排除；鼻翼两侧 / the nose: above 1.9 cm over the mouth near the midline is already out by the cheek line; beside the alae
    const edge = Math.min(smooth(0, 0.005, top - l[1]), smooth(0, 0.006, l[1] - bottom))
    // 区域里的相对密度 / relative density within the region
    let rel: number
    if (dy > 0 && Math.abs(l[0] - mouth[0]) < halfW + 0.008) rel = mix1(D.moustacheLateral, D.moustacheCentral, 1 - smooth(0.004, 0.012, Math.abs(l[0] - mouth[0])))
    else if (l[1] < mouth[1] - 0.042) rel = D.neck
    else if (phi < 30) rel = D.chin
    else rel = mix1(D.chin, D.cheek, smooth(30, 50, phi))
    return (rel / D.moustacheCentral) * edge
  }
  const density = (p: V3): number => weight(p) * D.moustacheCentral * 1e4
  const label = (p: V3): 'moustache' | 'chin' | 'cheek' | 'neck' | null => {
    if (weight(p) <= 0) return null
    const l = toHead(f, p)
    const dy = l[1] - mouth[1]
    if (dy > 0 && Math.abs(l[0] - mouth[0]) < halfW + 0.008) return 'moustache'
    if (l[1] < mouth[1] - 0.042) return 'neck'
    return Math.abs(azimuth(l)) < 30 ? 'chin' : 'cheek'
  }
  const triangles = trianglesWhere(b, (p) => {
    const l = toHead(f, p)
    return l[1] < 0.01 && l[1] > mouth[1] - 0.1 && l[2] > -0.07
  })
  return { density, weight, label, triangles }
}

const mix1 = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 胡须的毛：颊和颏朝下、上唇朝下并偏向两侧、颈部朝前上（朝下巴）；以 20° 出皮肤后贴着长。
 * Beard hairs: down on the cheeks and chin, down and outward on the upper lip, forward and up (towards the chin) on the
 * neck; they leave the skin at 20° and lie along it.
 */
export function beardGroom(b: BodyData, f: HeadFrame, surface: Surface, region: BeardRegion, lengthMm: number, P: Params, seed: number): Strand[] {
  const roots = scatter(b.skin.positions, b.normals, region.triangles, region.density, seed, 5)
  const r = rng(seed + 1)
  const Pp = b.skin.positions
  const mouthY = (toHead(f, at(Pp, b.points.mouthCornerL!))[1] + toHead(f, at(Pp, b.points.mouthCornerR!))[1]) / 2
  return roots.map((root, i) => {
    const l = toHead(f, root.p)
    let dirH: V3
    if (l[1] > mouthY) dirH = [Math.sign(l[0]) * 0.5, -1, 0] // 上唇 / upper lip
    else if (l[1] < mouthY - 0.045) dirH = [0, 0.4, 1] // 颈 / neck
    else dirH = [Math.sign(l[0]) * 0.15, -1, 0.15] // 颊、颏 / cheeks, chin
    const dir = norm(tangential(fromHeadDir(f, norm(dirH)), root.n))
    const L = (lengthMm / 1000) * (1 + 0.15 * gauss(r))
    return lieAlong(surface, root, dir, Math.max(0.0008, L), (20 * Math.PI) / 180, 4, 0.0002, i)
  })
}

export interface BodyRegion {
  density: (p: V3) => number
  /** 长度倍数（男性沿白线向上的一条短一些）/ length factor (the male band up the linea alba is shorter) */
  lengthScale?: (p: V3) => number
  triangles: [number, number, number][]
  area: number
}

/**
 * 阴毛区：以发布的阴毛外壳在皮肤上的投影定上缘高度和中心（每个人体自己的），按 Tanner 第 5 期的形状：倒三角、上缘水平；
 * 男性再向两侧大腿内侧稍展开，并加沿白线向上的一条（第 6 期）。只取朝前的皮肤。密度为假设。
 * The pubic region: the top border and centre from the shipped pubic shell projected onto the skin (each body's own), in
 * Tanner stage 5's shape: an inverted triangle with a horizontal top; for the male a little spread onto the medial
 * thighs, plus a band up the linea alba (stage 6). Only forward-facing skin. The density is assumed.
 */
export function pubicRegion(b: BodyData, P: Params): BodyRegion {
  const S = b.pubicShell.positions
  let top = -Infinity, bottom = Infinity, xMax = 0, zMid = 0
  for (let i = 0; i < S.length; i += 3) {
    top = Math.max(top, S[i + 1]!)
    bottom = Math.min(bottom, S[i + 1]!)
    xMax = Math.max(xMax, Math.abs(S[i]!))
    zMid += S[i + 2]! / (S.length / 3)
  }
  const male = b.body === 'male'
  const halfTop = xMax + (male ? 0.012 : 0.006)
  const low = bottom - (male ? 0.01 : 0.03)
  const rho = P.pubicDensity.value * 1e4
  const N = b.normals
  const density = (p: V3, v = -1): number => {
    if (p[1] > top + (male ? 0.06 : 0) || p[1] < low || p[2] < zMid - 0.08) return 0
    void v
    const t = (p[1] - low) / (top - low)
    // 倒三角：上缘最宽，向下收 / inverted triangle: widest at the top, narrowing downward
    const half = male ? halfTop * (0.45 + 0.55 * Math.min(1, t)) + 0.015 * smooth(0.2, 0.6, t) * (1 - smooth(0.8, 1, t)) : halfTop * Math.min(1, Math.max(0.15, t))
    if (p[1] <= top) {
      const edge = smooth(0, 0.008, half - Math.abs(p[0])) * smooth(0, 0.006, top - p[1])
      return rho * edge
    }
    // 男性：沿白线向上的一条，越往上越稀 / male: a band up the linea alba, thinning upward
    const up = p[1] - top
    return Math.abs(p[0]) < 0.009 ? rho * 0.25 * (1 - smooth(0.015, 0.06, up)) * smooth(0, 0.003, 0.009 - Math.abs(p[0])) : 0
  }
  const triangles = trianglesWhere(b, (p) => p[1] > low - 0.01 && p[1] < top + 0.1 && Math.abs(p[0]) < halfTop + 0.04 && p[2] > zMid - 0.08)
  // 只取朝前的面 / forward-facing only
  const facing = triangles.filter(([a, c, d]) => (N[a * 3 + 2]! + N[c * 3 + 2]! + N[d * 3 + 2]!) / 3 > 0.2)
  let area = 0
  for (const [a, c, d] of facing) {
    const pa = at(b.skin.positions, a), pc = at(b.skin.positions, c), pd = at(b.skin.positions, d)
    const cen = scale(add(add(pa, pc), pd), 1 / 3)
    if (density(cen) > 0) area += len(cross(sub(pc, pa), sub(pd, pa))) / 2
  }
  return { density, triangles: facing, area, lengthScale: (p) => (p[1] > top ? 0.45 : 1) }
}

/**
 * 腋毛区：从盂肱关节中心朝正下方射线碰到的皮肤点是腋窝顶，取它周围前后 5.6、上下与内外 4.4 厘米的椭球里朝下或朝内的皮肤。
 * The axillary region: the skin point hit by a ray from the glenohumeral centre going straight down is the apex of
 * the axilla; the region is the downward- or inward-facing skin within an ellipsoid of 5.6 cm front to back and 4.4 cm
 * across around it.
 */
export function axillaRegions(b: BodyData, surface: Surface, P: Params): BodyRegion[] {
  const rho = P.axillaryDensity.value * 1e4
  const N = b.normals
  return b.shoulders.map((gh, side) => {
    const s = side === 0 ? 1 : -1
    // 关节中心正下方第一个碰到的皮肤点：上臂和胸壁之间的腋窝顶 / the first skin hit straight below the joint centre: the axillary vault between the arm and the chest wall
    const d: V3 = [0, -1, 0]
    const hit = surface.ray(gh, d, 0.3)
    void s
    const apex: V3 = isFinite(hit) ? add(gh, scale(d, hit)) : add(gh, [0, -0.11, 0])
    const density = (p: V3): number => {
      const q = sub(p, apex)
      const e = (q[2] / 0.028) ** 2 + (q[1] / 0.022) ** 2 + (q[0] / 0.022) ** 2
      return e < 1 ? rho * smooth(0, 0.3, 1 - e) : 0
    }
    const triangles = trianglesWhere(b, (p) => len(sub(p, apex)) < 0.05).filter(([a, c, dd]) => (N[a * 3 + 1]! + N[c * 3 + 1]! + N[dd * 3 + 1]!) / 3 < 0.35)
    let area = 0
    for (const [a, c, dd] of triangles) {
      const pa = at(b.skin.positions, a), pc = at(b.skin.positions, c), pd = at(b.skin.positions, dd)
      if (density(scale(add(add(pa, pc), pd), 1 / 3)) > 0) area += len(cross(sub(pc, pa), sub(pd, pa))) / 2
    }
    return { density, triangles, area }
  })
}

/**
 * 卷毛：出皮肤后在皮肤切平面里一圈圈转（半径约 `curl`），离皮肤的距离沿发丝增加（蓬松）。
 * Curly hair: after leaving the skin it turns round and round in the skin's tangent plane (radius about `curl`), its
 * distance from the skin growing along the strand (fluff).
 */
export function curlyGroom(b: BodyData, surface: Surface, region: BodyRegion, lengthMm: number, curlMm: number, down: V3, seed: number): Strand[] {
  const roots = scatter(b.skin.positions, b.normals, region.triangles, region.density, seed, 5)
  const r = rng(seed + 1)
  return roots.map((root, i) => {
    const k = region.lengthScale ? region.lengthScale(root.p) : 1
    return curl(surface, root, down, (lengthMm / 1000) * k * (0.75 + 0.5 * r()), (curlMm / 1000) * Math.sqrt(k) * (0.7 + 0.6 * r()), r() < 0.5 ? 1 : -1, i, r)
  })
}

function curl(surface: Surface, root: Root, down: V3, L: number, R: number, sign: number, seed: number, r: () => number): Strand {
  const points = 8
  const seg = L / (points - 1)
  const turn = (seg / R) * sign
  let d = norm(add(norm(tangential(add(down, scale([r() - 0.5, r() - 0.5, r() - 0.5], 0.8)), root.n)), scale(root.n, 0.6)))
  const pts: V3[] = [root.p]
  let n = root.n
  for (let k = 1; k < points; k++) {
    let p = add(pts[k - 1]!, scale(d, seg))
    const gap = 0.0005 + 0.004 * (k / (points - 1)) * (0.5 + r())
    const c = surface.closest(p, 0.02)
    if (c) {
      n = c.normal
      const h = dot(sub(p, c.point), c.normal)
      if (h < gap) p = add(c.point, scale(c.normal, gap))
    }
    pts.push(p)
    d = norm(mix(rotate(d, n, turn), norm(tangential(d, n)), 0.3))
  }
  // 窄的皱襞（腋窝）里，推出一面皮肤可能进了对面那一面：到第一个仍在皮肤里的点为止
  // in a narrow fold (the axilla) pushing out of one skin surface can land inside the opposite one: stop at the first point still inside
  const inside = (p: V3): boolean => {
    const c = surface.closest(p, 0.006)
    return !!c && c.distance <= 0.006 && dot(sub(p, c.point), c.smoothNormal) < 0.0002
  }
  for (let k = 1; k < pts.length; k++) {
    if (!inside(pts[k]!)) continue
    const c = surface.closest(pts[k]!, 0.006)!
    const q = add(c.point, scale(c.normal, 0.0004))
    if (k < 3 && !inside(q)) {
      pts[k] = q
      continue
    }
    pts.length = Math.max(2, k)
    if (k < 2) pts[1] = q
    break
  }
  void gauss
  return { root, pts, layer: 0, phase: (seed * 0.618) % 1 }
}
