/**
 * 流感病毒颗粒的内部：按已知的结构和 Goodsell 的画法推断着补上。
 *
 * 模拟数据（Amaro 实验室）里只有包膜和膜上的蛋白，里面是空的。真实的病毒里面有：
 * 贴着膜内侧的一层基质蛋白 M1，八条核糖核蛋白（RNP，核蛋白把基因组 RNA 裹成双螺旋的杆），
 * 每条的一端有一个聚合酶。Goodsell 2024 年的《Influenza Virus》就是这样画的（M1 蓝色，核蛋白橙色，
 * RNA 黄色，聚合酶红色，八条 RNP 平行成束）。
 *
 * 这里每一种都用真实的结构，只有“放在哪”是推断的：
 * - M1：PDB 7JM3，它自带 60 个拷贝的螺旋排布。从这 60 个拷贝量出每个 M1 占多大面积、哪一面朝膜，
 *   再按这个密度铺满膜的内侧。
 * - RNP：PDB 4BBL，从病毒颗粒里分离出的 RNP 的一段螺旋（24 个核蛋白，两条各 308 nt 的 RNA）。
 *   每条 RNP 由这样的段首尾相接而成，段数按该片段的核苷酸数算；八条平行，一条在中间、七条围着。
 * - 聚合酶：PDB 6RR7，每条 RNP 的同一端各一个。
 * 放不下的地方如实截短：杆比它所在位置的弦长时，只画放得下的那几段。
 *
 * The inside of an influenza virion, filled in by inference from known structures and from the
 * way Goodsell paints it.
 *
 * The simulation data (Amaro Lab) holds the envelope and its proteins only and is empty inside.
 * A real virion contains a layer of matrix protein M1 against the inner face of the membrane and
 * eight ribonucleoproteins (RNPs, rods in which nucleoprotein winds the genomic RNA into a double
 * helix), each with a polymerase at one end. Goodsell's "Influenza Virus" (2024) paints exactly
 * that (M1 blue, nucleoprotein orange, RNA yellow, polymerase red, the eight RNPs in a parallel
 * bundle).
 *
 * Every component here is a real structure; only where it is put is inferred:
 * - M1: PDB 7JM3, which carries a helical arrangement of 60 copies. From those copies the area
 *   one M1 takes and the side it turns to the membrane are measured, and the inner face of the
 *   membrane is covered at that density.
 * - RNP: PDB 4BBL, a helical stretch of RNP isolated from virions (24 nucleoproteins and two RNA
 *   strands of 308 nt each). Each RNP is such stretches end to end, as many as the segment's
 *   nucleotide count calls for; the eight lie parallel, one in the middle and seven around it.
 * - Polymerase: PDB 6RR7, one at the same end of every RNP.
 * What does not fit is cut short, and said to be: a rod longer than the chord where it stands
 * gets only the stretches that fit.
 */
import type { Molecule } from '../mol/types'

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mulS = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** A 型流感八个基因组片段的长度（nt）：NCBI 参考序列 A/Puerto Rico/8/1934(H1N1)，NC_002016–NC_002023 / lengths in nt of the eight genome segments of influenza A: NCBI reference sequences of A/Puerto Rico/8/1934(H1N1), NC_002016–NC_002023 */
export const SEGMENTS = [2341, 2341, 2233, 1778, 1565, 1413, 1027, 890]

/** 点集的质心和主轴（幂迭代）/ centroid and principal axis of a point set (power iteration) */
export function principalAxis(points: Float32Array | number[], stride = 3): { centre: V3; axis: V3; min: number; max: number } {
  const n = points.length / stride
  const c: V3 = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k]! += points[i * stride + k]! / n
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const d = [points[i * stride]! - c[0], points[i * stride + 1]! - c[1], points[i * stride + 2]! - c[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a * 3 + b]! += d[a]! * d[b]!
  }
  let v: V3 = norm([1, 0.7, 0.3])
  for (let it = 0; it < 60; it++) v = norm([m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]])
  let min = Infinity, max = -Infinity
  for (let i = 0; i < n; i++) {
    const t = (points[i * stride]! - c[0]) * v[0] + (points[i * stride + 1]! - c[1]) * v[1] + (points[i * stride + 2]! - c[2]) * v[2]
    if (t < min) min = t
    if (t > max) max = t
  }
  return { centre: c, axis: v, min, max }
}

/** 列主序 4x4：把以 (x, y, z) 为轴、原点在 from 的局部坐标系，搬到以 (X, Y, Z) 为轴、原点在 to 的地方 / a column-major 4x4 taking the local frame with axes (x, y, z) and origin `from` to the frame with axes (X, Y, Z) and origin `to` */
export function frameToFrame(from: V3, x: V3, y: V3, z: V3, to: V3, X: V3, Y: V3, Z: V3): Float32Array {
  // R = [X Y Z] · [x y z]ᵀ
  const R = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const A = [X, Y, Z], B = [x, y, z]
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[r * 3 + c] = A[0]![r]! * B[0]![c]! + A[1]![r]! * B[1]![c]! + A[2]![r]! * B[2]![c]!
  const t: V3 = [to[0] - (R[0]! * from[0] + R[1]! * from[1] + R[2]! * from[2]), to[1] - (R[3]! * from[0] + R[4]! * from[1] + R[5]! * from[2]), to[2] - (R[6]! * from[0] + R[7]! * from[1] + R[8]! * from[2])]
  return new Float32Array([R[0]!, R[3]!, R[6]!, 0, R[1]!, R[4]!, R[7]!, 0, R[2]!, R[5]!, R[8]!, 0, t[0], t[1], t[2], 1])
}

const apply = (m: Float32Array, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]

/** 一个结构全部球的质心 / the centroid of all the spheres of a structure */
function centroid(mol: Molecule): V3 {
  const c: V3 = [0, 0, 0]
  for (let i = 0; i < mol.atomCount; i++) for (let k = 0; k < 3; k++) c[k]! += mol.pos[i * 3 + k]! / mol.atomCount
  return c
}

/**
 * 从一个螺旋排布的组装体量出：一个拷贝占的面积（Å²），以及它在自己坐标系里的“朝外”方向和“沿螺旋”方向。
 * 做法：各拷贝质心的主轴是螺旋轴；质心到轴的垂线是朝外的方向；面积 = 圆柱侧面积 ÷ 拷贝数。
 * From an assembly arranged as a helix, measure the area one copy takes (Å²) and, in the copy's
 * own frame, its "outward" direction and its "along the helix" direction. The principal axis of
 * the copies' centroids is the helix axis, the perpendicular from it to a centroid points
 * outward, and the area is the side of the cylinder divided by the number of copies.
 */
export function helicalLayer(mol: Molecule, assembly: string): { area: number; origin: V3; outward: V3; along: V3; radius: number } {
  const asm = mol.assemblies.find((a) => a.id === assembly) ?? mol.assemblies[mol.assemblies.length - 1]!
  const ops = asm.groups.flatMap((g) => g.operators)
  const c0 = centroid(mol)
  const centres = ops.map((m) => apply(m, c0))
  // 螺旋轴：两个拷贝之间的相对变换是一个绕螺旋轴的螺旋运动，它的转轴就是螺旋轴。
  // （各拷贝质心的主轴不行：螺旋短而粗时，方差最大的方向是横着的。）
  // The helix axis: the relative transform between two copies is a screw about it, so the screw's
  // rotation axis is the helix axis. (The principal axis of the centroids will not do: for a short,
  // wide helix the direction of greatest variance lies across it.)
  let axis: V3 = principalAxis(centres.flat()).axis
  let centre: V3 = principalAxis(centres.flat()).centre
  if (ops.length > 1) {
    const A = ops[0]!, B = ops[1]!
    // M = B · A⁻¹，A 是刚体变换，逆是转置 / M = B · A⁻¹; A is rigid, so its inverse is its transpose
    const R: number[] = []
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R.push(B[r]! * A[c]! + B[4 + r]! * A[4 + c]! + B[8 + r]! * A[8 + c]!)
    const tA: V3 = [A[12]!, A[13]!, A[14]!]
    const t: V3 = [B[12]! - (R[0]! * tA[0] + R[1]! * tA[1] + R[2]! * tA[2]), B[13]! - (R[3]! * tA[0] + R[4]! * tA[1] + R[5]! * tA[2]), B[14]! - (R[6]! * tA[0] + R[7]! * tA[1] + R[8]! * tA[2])]
    const w: V3 = [R[7]! - R[5]!, R[2]! - R[6]!, R[3]! - R[1]!]
    if (Math.hypot(...w) > 1e-4) {
      axis = norm(w)
      // 轴上的一点 c 满足 (I − R) c = t 去掉沿轴的分量；在垂直于轴的平面里解这个 2×2 方程
      // a point c on the axis satisfies (I − R) c = t less its component along the axis; the 2x2 system is solved in the plane across the axis
      const e1 = norm(cross(Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], axis)), e2 = cross(axis, e1)
      const Rv = (v: V3): V3 => [R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2], R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2], R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2]]
      const m11 = 1 - dot(e1, Rv(e1)), m12 = -dot(e1, Rv(e2)), m21 = -dot(e2, Rv(e1)), m22 = 1 - dot(e2, Rv(e2))
      const b1 = dot(e1, t), b2 = dot(e2, t), det = m11 * m22 - m12 * m21
      if (Math.abs(det) > 1e-9) centre = add(mulS(e1, (b1 * m22 - b2 * m12) / det), mulS(e2, (m11 * b2 - m21 * b1) / det))
    }
  }
  let min = Infinity, max = -Infinity
  for (const p of centres) {
    const h = dot(sub(p, centre), axis)
    if (h < min) min = h
    if (h > max) max = h
  }
  const radial = (p: V3): V3 => {
    const d = sub(p, centre)
    return sub(d, mulS(axis, dot(d, axis)))
  }
  const radius = centres.reduce((s, p) => s + Math.hypot(...radial(p)), 0) / centres.length
  // 轴向的跨度按“每个拷贝的升距 × 拷贝数”算，比 max − min 多出一个拷贝的升距 / the axial span is taken as rise per copy times copies, one rise more than max − min
  const span = ((max - min) * centres.length) / Math.max(1, centres.length - 1)
  const area = (2 * Math.PI * radius * span) / centres.length
  // 找出单位变换的那个拷贝（它的坐标就是文件里的坐标）；没有就用第一个，并把方向转回它的局部系
  // find the copy under the identity (whose coordinates are the file's own); failing that take the first and turn directions back into its local frame
  let k = ops.findIndex((m) => Math.abs(m[0]! - 1) + Math.abs(m[5]! - 1) + Math.abs(m[10]! - 1) + Math.abs(m[12]!) + Math.abs(m[13]!) + Math.abs(m[14]!) < 1e-4)
  if (k < 0) k = 0
  const m = ops[k]!
  const toLocal = (v: V3): V3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2], m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2]]
  const out = norm(radial(centres[k]!))
  return { area, origin: c0, outward: norm(toLocal(out)), along: norm(toLocal(norm(cross(axis, out)))), radius }
}

/** 球面上大致均匀的 n 个点（斐波那契格点）/ n roughly even points on a sphere (a Fibonacci lattice) */
export function fibonacciSphere(n: number): V3[] {
  const out: V3[] = []
  const g = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    out.push([Math.cos(g * i) * r, y, Math.sin(g * i) * r])
  }
  return out
}

/** 在半径 R 的球面内侧铺一层：每个拷贝“朝外”的方向对着球面的法线 / a layer on the inside of a sphere of radius R, each copy turning its "outward" direction to the sphere's normal */
export function layerOnSphere(layer: ReturnType<typeof helicalLayer>, centre: V3, R: number): Float32Array[] {
  const n = Math.max(1, Math.round((4 * Math.PI * R * R) / layer.area))
  const y = norm(cross(layer.outward, layer.along))
  return fibonacciSphere(n).map((d) => {
    // 切向取沿纬线的方向；极点附近换一个参考 / the tangent runs along the parallel; near a pole another reference is used
    const ref: V3 = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
    const t = norm(cross(ref, d))
    return frameToFrame(layer.origin, layer.outward, layer.along, y, add(centre, mulS(d, R)), d, t, norm(cross(d, t)))
  })
}

export interface RnpBundle {
  /** 每一段 RNP 螺旋的变换 / the transform of each stretch of RNP helix */
  stretches: Float32Array[]
  /** 每个聚合酶的变换 / the transform of each polymerase */
  polymerases: Float32Array[]
  /** 每条杆：按核苷酸数该有几段，实际放了几段 / for each rod: stretches called for by its nucleotide count, and stretches placed */
  rods: { wanted: number; placed: number }[]
  /** 填满时：每一段沿杆方向允许到多高（相对空腔中心），超过的部分截掉，给聚合酶让位 / when filling: how high along the rod each stretch may reach (relative to the cavity's centre); what lies above is cut off, leaving room for the polymerase */
  tops?: number[]
}

/**
 * 八条平行的 RNP：一条在中间，七条围着（围着的半径取杆的直径）。杆沿 `up` 方向，聚合酶都在上端。
 * `cavity` 是能放东西的球形空腔的半径。每段螺旋含 `ntPerStretch` 个核苷酸。
 * Eight parallel RNPs, one in the middle and seven around it (at a radius of one rod diameter).
 * Rods run along `up` with every polymerase at the upper end. `cavity` is the radius of the
 * spherical space available. Each helical stretch holds `ntPerStretch` nucleotides.
 */
export function rnpBundle(rnp: Molecule, polymerase: Molecule, centre: V3, cavity: number, up: V3, ntPerStretch: number, segments = SEGMENTS, fill = false): RnpBundle {
  const ax = principalAxis(rnp.pos)
  const length = ax.max - ax.min
  // 杆的半径：各球到轴的距离的第 95 百分位 / the rod's radius: the 95th percentile of sphere distances from the axis
  const ds: number[] = []
  for (let i = 0; i < rnp.atomCount; i += 7) {
    const d = sub([rnp.pos[i * 3]!, rnp.pos[i * 3 + 1]!, rnp.pos[i * 3 + 2]!], ax.centre)
    ds.push(Math.hypot(...sub(d, mulS(ax.axis, dot(d, ax.axis)))))
  }
  ds.sort((a, b) => a - b)
  const rodR = ds[Math.floor(ds.length * 0.95)]!
  const u = norm(up)
  const e1 = norm(cross(Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], u))
  const e2 = cross(u, e1)
  const lx = norm(cross(Math.abs(ax.axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], ax.axis))
  const ly = cross(ax.axis, lx)
  const pc = centroid(polymerase)
  const pr = principalAxis(polymerase.pos)
  const polyHalf = (pr.max - pr.min) / 2
  const out: RnpBundle = { stretches: [], polymerases: [], rods: [] }
  // 最长的放中间，其余按长短交替排在周围，免得长的挤在一边 / the longest goes in the middle, the rest alternate long and short around it so that the long ones do not crowd one side
  const order = segments.map((nt, i) => ({ nt, i })).sort((a, b) => b.nt - a.nt)
  const ring = order.slice(1)
  const around = ring.map((_, k) => ring[k % 2 === 0 ? k / 2 : ring.length - 1 - (k - 1) / 2]!)
  const spots: { nt: number; x: number; y: number }[] = [{ nt: order[0]!.nt, x: 0, y: 0 }]
  around.forEach((s, k) => {
    const a = (k / around.length) * 2 * Math.PI
    // 填满时把周围七条摊开到贴着内壁，从侧面看它们铺满整个圆；否则紧挨着中间那条
    // when filling, the seven around are spread out to the wall, so that seen from the side they cover the whole circle; otherwise they hug the middle one
    const ringR = fill ? Math.max(rodR * 2.05, cavity - rodR * 1.05) : rodR * 2.05
    spots.push({ nt: s.nt, x: Math.cos(a + 0.22) * ringR, y: Math.sin(a + 0.22) * ringR })
  })
  // 填满时也用 7+1 的排法（周围七条摊开到贴着内壁）。原来换成“整条排在切面后面”的排法，只有正面一个视角是满的，转到背后杆全被切掉
  // filling also uses the 7+1 layout (the seven around spread out to the wall). A layout that put every rod behind the cut plane was full from the front only, and turned to the back all the rods were cut away
  for (const s of spots) {
    const off = Math.hypot(s.x, s.y)
    // 这个位置上沿杆方向放得下多长：弦长，再给杆的粗细和顶端的聚合酶留出余地
    // how much length fits along the rod here: the chord, less room for the rod's own thickness and for the polymerase on top
    const reach = Math.sqrt(Math.max(0, (cavity - rodR * 0.6) ** 2 - off * off))
    const room = 2 * reach - polyHalf * 1.2
    const wanted = Math.max(1, Math.round(s.nt / ntPerStretch))
    const placed = Math.max(1, Math.min(wanted, Math.floor(room / length)))
    const base = add(centre, add(mulS(e1, s.x), mulS(e2, s.y)))
    if (fill) {
      // 填满：从这个位置的弦的下端一段接一段往上摆，直到顶上留给聚合酶的地方；超出空腔的部分之后截掉。
      // Goodsell 的画就是这样：每条杆都画到贴着内壁为止。
      // filling: stretches are stacked from the lower end of the chord here up to the room left for the polymerase on top; what falls outside the cavity is cut off afterwards. This is what Goodsell paints: every rod runs right up to the inner wall.
      const full = Math.sqrt(Math.max(0, cavity * cavity - off * off))
      const limit = full - polyHalf * 1.5
      const n = Math.max(1, Math.ceil((limit + full) / length))
      const from = add(ax.centre, mulS(ax.axis, (ax.min + ax.max) / 2))
      for (let k = 0; k < n; k++) {
        out.stretches.push(frameToFrame(from, lx, ly, ax.axis, add(base, mulS(u, limit - (k + 0.5) * length)), e1, e2, u))
        ;(out.tops ??= []).push(limit)
      }
      const px = norm(cross(Math.abs(pr.axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], pr.axis))
      out.polymerases.push(frameToFrame(pc, px, cross(pr.axis, px), pr.axis, add(base, mulS(u, limit + polyHalf * 0.75)), e1, e2, u))
      out.rods.push({ wanted, placed: n })
      continue
    }
    const total = placed * length
    const top = (total + polyHalf * 1.2) / 2 - polyHalf * 1.2
    for (let k = 0; k < placed; k++) {
      const mid = add(base, mulS(u, top - (k + 0.5) * length))
      // 把这一段的中点（轴上 min、max 的中间）搬到 mid / move the middle of the stretch (halfway between min and max on its axis) to mid
      const from = add(ax.centre, mulS(ax.axis, (ax.min + ax.max) / 2))
      out.stretches.push(frameToFrame(from, lx, ly, ax.axis, mid, e1, e2, u))
    }
    const px = norm(cross(Math.abs(pr.axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], pr.axis))
    out.polymerases.push(frameToFrame(pc, px, cross(pr.axis, px), pr.axis, add(base, mulS(u, top + polyHalf * 0.9)), e1, e2, u))
    out.rods.push({ wanted, placed })
  }
  return out
}

/** 一批球（x, y, z…）的质心，以及到质心距离的若干百分位 / the centroid of a set of spheres (x, y, z...) and percentiles of their distance from it */
export function shell(pos: Float32Array, start: number, count: number): { centre: V3; inner: number; outer: number; mid: number } {
  const c: V3 = [0, 0, 0]
  const step = Math.max(1, Math.floor(count / 200_000))
  let n = 0
  for (let i = start; i < start + count; i += step) {
    c[0] += pos[i * 3]!
    c[1] += pos[i * 3 + 1]!
    c[2] += pos[i * 3 + 2]!
    n++
  }
  c[0] /= n
  c[1] /= n
  c[2] /= n
  const r: number[] = []
  for (let i = start; i < start + count; i += step) r.push(Math.hypot(pos[i * 3]! - c[0], pos[i * 3 + 1]! - c[1], pos[i * 3 + 2]! - c[2]))
  r.sort((a, b) => a - b)
  // mid：半径的中位数，也就是膜的中面；起伏的膜的内外百分位之差比膜的真实厚度大得多
  // mid: the median radius, that is the membrane's mid-plane; in an undulating membrane the spread between inner and outer percentiles is far more than its true thickness
  return { centre: c, inner: r[Math.floor(r.length * 0.02)]!, outer: r[Math.floor(r.length * 0.98)]!, mid: r[r.length >> 1]! }
}

/**
 * 把一段 RNP 结构里 RNA 的走向画成一条线：取 RNA 链上的磷原子，每 `every` 个取一个、做一点平滑，
 * 再从杆的轴线往外推 `lift` Å（否则它埋在核蛋白的沟里看不见），然后按每一段的变换搬到位。
 * 返回球（x, y, z）和把相邻的球连起来的线段。Goodsell 把基因组 RNA 画成核蛋白上一条明显的黄色波浪线。
 *
 * Draw the course of the RNA in a stretch of RNP as a line: the phosphorus atoms of the RNA
 * chains, one in every `every` and lightly smoothed, pushed `lift` Å out from the rod's axis (or
 * it lies hidden in the nucleoprotein's groove), then carried into place by each stretch's
 * transform. Returns spheres (x, y, z) and the segments joining neighbours. Goodsell paints the
 * genomic RNA as a clear yellow wavy line on the nucleoprotein.
 */
export function rnaPath(rnp: Molecule, stretches: Float32Array[], lift: number, every = 3): { pos: Float32Array; segments: Uint32Array } {
  const ax = principalAxis(rnp.pos)
  // 杆的表面：各球到轴的距离的第 95 百分位 / the rod's surface: the 95th percentile of sphere distances from the axis
  const ds: number[] = []
  for (let i = 0; i < rnp.atomCount; i += 7) {
    const d = sub([rnp.pos[i * 3]!, rnp.pos[i * 3 + 1]!, rnp.pos[i * 3 + 2]!], ax.centre)
    ds.push(Math.hypot(...sub(d, mulS(ax.axis, dot(d, ax.axis)))))
  }
  ds.sort((x, y) => x - y)
  const surface = ds[Math.floor(ds.length * 0.95)] ?? 0
  const strands: V3[][] = []
  for (const c of rnp.chains) {
    if (rnp.entities[c.entity]!.kind !== 'rna') continue
    const p: V3[] = []
    for (let i = c.start; i < c.start + c.count; i++) if (rnp.isTrace[i]) p.push([rnp.pos[i * 3]!, rnp.pos[i * 3 + 1]!, rnp.pos[i * 3 + 2]!])
    if (p.length < 4) continue
    const line: V3[] = []
    for (let i = 0; i < p.length; i += every) {
      // 前后各两个点的平均 / the mean of two points either side
      const q: V3 = [0, 0, 0]
      let n = 0
      for (let k = Math.max(0, i - 2); k <= Math.min(p.length - 1, i + 2); k++) {
        q[0] += p[k]![0]
        q[1] += p[k]![1]
        q[2] += p[k]![2]
        n++
      }
      const m: V3 = [q[0] / n, q[1] / n, q[2] / n]
      const d = sub(m, ax.centre)
      const radial = sub(d, mulS(ax.axis, dot(d, ax.axis)))
      // 至少推到杆的表面上，线才整条露在外面 / pushed at least onto the rod's surface, so that the whole line shows
      const r = Math.hypot(...radial)
      line.push(add(m, mulS(norm(radial), Math.max(lift, surface - r))))
    }
    strands.push(line)
  }
  const pos: number[] = [], seg: number[] = []
  for (const m of stretches)
    for (const line of strands) {
      line.forEach((p, i) => {
        const q = apply(m, p)
        if (i > 0) seg.push(pos.length / 3 - 1, pos.length / 3)
        pos.push(q[0], q[1], q[2])
      })
    }
  return { pos: new Float32Array(pos), segments: new Uint32Array(seg) }
}

/**
 * 把一个结构按若干变换摆好之后，只留下落在球形空腔里（并且沿 `up` 不高于各自上限）的球，合成一个显式的结构。
 * 每个变换下的每条链各成一条链，这样每一份仍然单独描边。返回结构和留下的球占全部的比例。
 * Lay a structure out under several transforms and keep only the spheres that fall inside a
 * spherical cavity (and no higher along `up` than each one's limit), gathered into one explicit
 * structure. Every chain under every transform is a chain of its own, so each copy is still
 * outlined separately. Returns the structure and the share of spheres kept.
 */
export function clipToCavity(mol: Molecule, transforms: Float32Array[], centre: V3, radius: number, up: V3, tops: number[] | undefined, id: string): { mol: Molecule; kept: number } {
  const u = norm(up)
  const pos: number[] = [], element: number[] = [], isTrace: number[] = [], residue: number[] = [], rad: number[] = []
  const chains: Molecule['chains'] = []
  let seen = 0
  transforms.forEach((m, t) => {
    const top = tops?.[t] ?? Infinity
    for (const c of mol.chains) {
      const start = pos.length / 3
      for (let i = c.start; i < c.start + c.count; i++) {
        const p = apply(m, [mol.pos[i * 3]!, mol.pos[i * 3 + 1]!, mol.pos[i * 3 + 2]!])
        const d = sub(p, centre)
        seen++
        if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > radius * radius || dot(d, u) > top) continue
        pos.push(p[0], p[1], p[2])
        element.push(mol.element[i]!)
        isTrace.push(mol.isTrace[i]!)
        residue.push(mol.residue[i]!)
        if (mol.radius) rad.push(mol.radius[i]!)
      }
      const count = pos.length / 3 - start
      if (count > 0) chains.push({ ...c, asymId: `${c.asymId}.${t}`, start, count })
    }
  })
  const n = pos.length / 3
  const chainOf = new Uint32Array(n)
  chains.forEach((c, i) => chainOf.fill(i, c.start, c.start + c.count))
  return {
    kept: seen ? n / seen : 0,
    mol: { id, title: mol.title, atomCount: n, pos: new Float32Array(pos), element: new Uint8Array(element), ...(mol.radius ? { radius: new Float32Array(rad) } : {}), chainOf, isTrace: new Uint8Array(isTrace), residue: new Int32Array(residue), chains, entities: mol.entities.map((e) => ({ ...e })), assemblies: [] },
  }
}
