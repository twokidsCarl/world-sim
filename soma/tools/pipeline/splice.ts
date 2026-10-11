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
}

export interface SpliceOptions {
  /** 男性肌至少超出肌腹这么多才接腱（米） / the male muscle must extend beyond the belly by at least this much for a tendon to be attached (m) */
  minBeyond?: number
  /** 腱伸入肌腹的重叠长度（米），用来遮住切口 / overlap of the tendon into the belly (m), which hides the cut */
  overlap?: number
  /** 切口处的移动超过此值即认为拼接不干净，放弃这一端（米） / a shift at the cut larger than this means the splice is not clean; the end is left alone (m) */
  maxShift?: number
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
    const row: SpliceEnd = { end, beyond, attached: false, shift: 0, triangles: 0 }
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
    for (let t = 0; t < male.indices.length; t += 3) {
      const a = male.indices[t]!
      const b = male.indices[t + 1]!
      const c = male.indices[t + 2]!
      if (!inPiece(tMale[a]!) || !inPiece(tMale[b]!) || !inPiece(tMale[c]!)) continue
      for (const v of [a, b, c]) {
        if (remap[v]! >= 0) continue
        // 位移在切口处为全量，线性减到骨端为零：附着点不动
        // the displacement is full at the cut and falls linearly to zero at the bony end: the attachment stays
        const w = Math.max(0, Math.min(1, (tMale[v]! - tip) / (cut - tip)))
        remap[v] = positions.length / 3
        positions.push(male.positions[3 * v]! + w * d[0], male.positions[3 * v + 1]! + w * d[1], male.positions[3 * v + 2]! + w * d[2])
      }
      indices.push(remap[a]!, remap[b]!, remap[c]!)
      tris++
    }
    row.triangles = tris
    row.attached = tris > 0
  }
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, ends }
}
