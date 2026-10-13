// 肌腹与肌腱的拼接：Denver 的肌模型只有肌腹；形变后的男性同名肌带有肌腱和腱膜、一直连到骨。
// 沿肌的长轴，把男性肌超出肌腹两端的部分（腱）切下来，移到与肌腹端面对齐，再与肌腹合成一个部件。
// Splicing bellies and tendons: the Denver muscle models are bellies only; the warped male muscle of
// the same name has its tendons and aponeuroses and reaches the bone. Along the muscle's long axis
// the parts of the male muscle beyond the two ends of the belly (the tendons) are cut off, moved so
// that they meet the end of the belly, and joined with the belly into one part.

import type { Mesh } from './geometry.ts'
import { axisParam, type Vec3 } from './standard.ts'

export interface SpliceEnd {
  /** 'low'：长轴参数较小的一端；'high'：较大的一端 / 'low': the end with the smaller axis parameter; 'high': the larger */
  end: 'low' | 'high'
  /** 男性肌超出肌腹的长度（米） / how far the male muscle extends beyond the belly (m) */
  beyond: number
  /** 是否接上了腱 / was a tendon attached */
  attached: boolean
  /** 为与肌腹端面对齐，腱在切口处被移动的距离（米） / how far the tendon was moved at the cut to meet the belly (m) */
  shift: number
  triangles: number
  /** 封住腱在切口处的开口所加的三角形数 / triangles added to close the tendon's opening at the cut */
  capTriangles: number
}

export interface SpliceOptions {
  /** 男性肌至少超出肌腹这么多才接腱（米） / the male muscle must extend beyond the belly by at least this much for a tendon to be attached (m) */
  minBeyond?: number
  /** 腱伸入肌腹的重叠长度（米），用来遮住切口 / overlap of the tendon into the belly (m), which hides the cut */
  overlap?: number
  /** 切口处的移动超过此值即认为拼接不干净，放弃这一端（米） / a shift at the cut larger than this means the splice is not clean; the end is left alone (m) */
  maxShift?: number
  /**
   * 到她的骨面的距离（米）。给出时，已经贴在骨上的腱（2 mm 以内）不随切口移动，到 10 mm 处才完全跟着移：
   * 止点紧挨着切口的肌（股内、外侧肌和股中间肌止于髌骨）否则会被整段拉离它的骨。
   * Distance to her bone surface (m). When given, tendon already lying on bone (within 2 mm) does not
   * move with the cut and only tendon 10 mm or more from bone moves in full: a muscle whose insertion
   * is right at the cut (the vasti on the patella) would otherwise be dragged off its bone.
   */
  boneDistance?: (x: number, y: number, z: number) => number
}

/**
 * 把形变后男性肌的腱接到肌腹上。返回合成网格（肌腹顶点在前，顺序不变）和两端的处理结果。
 * Attaches the tendons of the warped male muscle to a belly. Returns the joined mesh (belly vertices
 * first, order unchanged) and what was done at each end.
 */
export function spliceTendons(belly: Mesh, male: Mesh, opts: SpliceOptions = {}): { mesh: Mesh; ends: SpliceEnd[] } {
  const { minBeyond = 0.01, overlap = 0.008, maxShift = 0.04 } = opts
  // 长轴取男性肌的主轴（它包含腱，方向更可靠） / the long axis is the male muscle's principal axis (it includes the tendons, so its direction is the more reliable)
  const ax = axisParam(male.positions)
  const proj = (p: Float32Array, i: number) => (p[3 * i]! - ax.c[0]) * ax.axis[0] + (p[3 * i + 1]! - ax.c[1]) * ax.axis[1] + (p[3 * i + 2]! - ax.c[2]) * ax.axis[2]
  const range = (p: Float32Array): [number, number] => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < p.length / 3; i++) {
      const t = proj(p, i)
      if (t < lo) lo = t
      if (t > hi) hi = t
    }
    return [lo, hi]
  }
  const [b0, b1] = range(belly.positions)
  const [m0, m1] = range(male.positions)
  // 某一轴向薄片内顶点的质心 / centroid of the vertices in a slab along the axis
  const slab = (p: Float32Array, lo: number, hi: number): Vec3 | null => {
    const c: Vec3 = [0, 0, 0]
    let n = 0
    for (let i = 0; i < p.length / 3; i++) {
      const t = proj(p, i)
      if (t < lo || t > hi) continue
      c[0] += p[3 * i]!
      c[1] += p[3 * i + 1]!
      c[2] += p[3 * i + 2]!
      n++
    }
    return n >= 3 ? [c[0] / n, c[1] / n, c[2] / n] : null
  }
  const positions: number[] = Array.from(belly.positions)
  const indices: number[] = Array.from(belly.indices)
  const ends: SpliceEnd[] = []
  const tMale = new Float32Array(male.positions.length / 3)
  for (let i = 0; i < tMale.length; i++) tMale[i] = proj(male.positions, i)
  for (const end of ['low', 'high'] as const) {
    const beyond = end === 'low' ? b0 - m0 : m1 - b1
    const row: SpliceEnd = { end, beyond, attached: false, shift: 0, triangles: 0, capTriangles: 0 }
    ends.push(row)
    if (beyond < minBeyond) continue
    // 切口位置（伸入肌腹 overlap）和腱的骨端 / the cut (reaching `overlap` into the belly) and the tendon's bony end
    const cut = end === 'low' ? b0 + overlap : b1 - overlap
    const tip = end === 'low' ? m0 : m1
    const inPiece = (t: number) => (end === 'low' ? t <= cut : t >= cut)
    const cb = end === 'low' ? slab(belly.positions, b0, b0 + 0.015) : slab(belly.positions, b1 - 0.015, b1)
    const cm = end === 'low' ? slab(male.positions, b0 - 0.008, b0 + 0.008) : slab(male.positions, b1 - 0.008, b1 + 0.008)
    if (!cb || !cm) continue
    // 只取垂直于长轴的分量：腱沿轴向不动 / the component across the axis only: the tendon does not move along it
    const d: Vec3 = [cb[0] - cm[0], cb[1] - cm[1], cb[2] - cm[2]]
    const along = d[0] * ax.axis[0] + d[1] * ax.axis[1] + d[2] * ax.axis[2]
    d[0] -= along * ax.axis[0]
    d[1] -= along * ax.axis[1]
    d[2] -= along * ax.axis[2]
    row.shift = Math.hypot(d[0], d[1], d[2])
    if (row.shift > maxShift) continue
    const remap = new Int32Array(tMale.length).fill(-1)
    let tris = 0
    const pieceStart = indices.length
    for (let t = 0; t < male.indices.length; t += 3) {
      const a = male.indices[t]!
      const b = male.indices[t + 1]!
      const c = male.indices[t + 2]!
      if (!inPiece(tMale[a]!) || !inPiece(tMale[b]!) || !inPiece(tMale[c]!)) continue
      for (const v of [a, b, c]) {
        if (remap[v]! >= 0) continue
        // 位移在切口处为全量，线性减到骨端为零：附着点不动
        // the displacement is full at the cut and falls linearly to zero at the bony end: the attachment stays
        let w = Math.max(0, Math.min(1, (tMale[v]! - tip) / (cut - tip)))
        if (opts.boneDistance) w *= Math.max(0, Math.min(1, (opts.boneDistance(male.positions[3 * v]!, male.positions[3 * v + 1]!, male.positions[3 * v + 2]!) - 0.002) / 0.008))
        remap[v] = positions.length / 3
        positions.push(male.positions[3 * v]! + w * d[0], male.positions[3 * v + 1]! + w * d[1], male.positions[3 * v + 2]! + w * d[2])
      }
      indices.push(remap[a]!, remap[b]!, remap[c]!)
      tris++
    }
    row.triangles = tris
    row.attached = tris > 0
    // 封口：切下来的腱在切口处是敞开的。敞着的话，沿射线数交点的内外判定（InsideTester）在腱的延长线上
    // 整段都判成“在肌内”，神经和血管会被从并不存在的实体里推出去。把每一圈边界边向其质心连成扇面；
    // 扇面在肌腹内部（切口伸入肌腹 `overlap`），看不见。
    // Capping: the cut-off tendon is open at the cut. Left open, an inside test that counts ray
    // crossings (InsideTester) reads the whole prolongation of the tendon as "inside the muscle", and
    // nerves and vessels get pushed out of a solid that is not there. Every loop of boundary edges is
    // closed with a fan to its centroid; the fans lie inside the belly (the cut reaches `overlap` into
    // it) and are not visible.
    if (tris > 0) row.capTriangles = capOpenLoops(positions, indices, pieceStart)
  }
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, ends }
}

/**
 * 封住一段三角形（`indices` 自 `from` 起）的开口：只属于一个三角形的边为边界边，按连通分量分圈，
 * 每圈向其顶点质心连成扇面（朝向与原三角形一致）。按位置合并重合顶点后再数边，源网格在接缝处的重复顶点
 * 不算边界。返回所加的三角形数。
 * Closes the openings of a run of triangles (`indices` from `from` on): an edge used by one triangle
 * only is a boundary edge; boundary edges are grouped into connected loops and each loop is closed
 * with a fan to the centroid of its vertices (wound like the triangles it closes). Edges are counted
 * after merging coincident vertices by position, so duplicated vertices along a seam of the source
 * mesh are not boundaries. Returns the number of triangles added.
 */
export function capOpenLoops(positions: number[], indices: number[], from = 0): number {
  const keyOf = new Map<string, number>()
  const canon = new Map<number, number>()
  const id = (v: number): number => {
    let c = canon.get(v)
    if (c === undefined) {
      const k = `${Math.round(positions[3 * v]! * 1e6)},${Math.round(positions[3 * v + 1]! * 1e6)},${Math.round(positions[3 * v + 2]! * 1e6)}`
      c = keyOf.get(k)
      if (c === undefined) keyOf.set(k, (c = v))
      canon.set(v, c)
    }
    return c
  }
  // 有向边 a→b 的出现次数减去 b→a 的：闭合且朝向一致的面上处处为 0
  // occurrences of the directed edge a→b minus those of b→a: zero everywhere on a closed, consistently wound surface
  const count = new Map<string, { a: number; b: number; n: number }>()
  for (let t = from; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = id(indices[t + k]!)
      const b = id(indices[t + ((k + 1) % 3)]!)
      if (a === b) continue
      const fwd = a < b
      const key = fwd ? `${a}_${b}` : `${b}_${a}`
      const e = count.get(key) ?? { a: fwd ? a : b, b: fwd ? b : a, n: 0 }
      e.n += fwd ? 1 : -1
      count.set(key, e)
    }
  }
  const open: [number, number][] = []
  for (const e of count.values()) {
    // n = +1：只有 a→b；补上的三角形要含 b→a / n = +1: only a→b exists; the closing triangle must carry b→a
    if (e.n === 1) open.push([e.b, e.a])
    else if (e.n === -1) open.push([e.a, e.b])
  }
  if (!open.length) return 0
  const parent = new Map<number, number>()
  const find = (v: number): number => {
    let r = v
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!
    parent.set(v, r)
    return r
  }
  for (const [a, b] of open) parent.set(find(a), find(b))
  const loops = new Map<number, { sum: [number, number, number]; n: number; edges: [number, number][]; seen: Set<number> }>()
  for (const [a, b] of open) {
    const r = find(a)
    const l = loops.get(r) ?? { sum: [0, 0, 0], n: 0, edges: [], seen: new Set<number>() }
    for (const v of [a, b]) {
      if (l.seen.has(v)) continue
      l.seen.add(v)
      l.sum[0] += positions[3 * v]!
      l.sum[1] += positions[3 * v + 1]!
      l.sum[2] += positions[3 * v + 2]!
      l.n++
    }
    l.edges.push([a, b])
    loops.set(r, l)
  }
  let added = 0
  for (const l of loops.values()) {
    if (l.edges.length < 3) continue
    const c = positions.length / 3
    positions.push(l.sum[0] / l.n, l.sum[1] / l.n, l.sum[2] / l.n)
    for (const [a, b] of l.edges) {
      indices.push(a, b, c)
      added++
    }
  }
  return added
}
