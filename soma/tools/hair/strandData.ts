// 近景真发丝的数据：引导发丝（重采样到固定点数、按根量化）和每个点的自遮挡。运行时按引导发丝插值出渲染发丝。
// Data for the close-up real strands: guide strands (resampled to a fixed point count, quantised relative to the root)
// and a self-occlusion value per point. At run time the render strands are interpolated from the guides.
//
// 自遮挡：从每个点沿"向外"方向数这根射线附近（3 毫米内、2–30 毫米远）有多少别的引导点——外面的头发越多越暗。
// 与光的方向无关（光随相机走），相当于一张预先算好的、沿外法线的深度不透明度图。
// Self-occlusion: from each point, count the other guide points near a ray in the "outward" direction (within 3 mm,
// 2–30 mm away) — the more hair outside, the darker. It does not depend on the light (the key light travels with the
// camera); it amounts to a precomputed deep-opacity map along the outward normal.

import type { HeadFrame } from './frame.ts'
import { type V3, add, dot, len, scale, sub } from './geom.ts'
import { outward, resample, type Strand } from './strands.ts'

const pad = (n: number): number => (n + 3) & ~3

/** 每根引导发丝的点的自遮挡（0 无 … 1 全遮）/ self-occlusion per guide point (0 none … 1 full) */
export function selfOcclusion(f: HeadFrame, pts: V3[][]): Float32Array[] {
  const cell = 0.004
  const grid = new Map<string, V3[]>()
  const key = (p: V3): string => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`
  for (const s of pts) {
    for (const p of s) {
      const k = key(p)
      const l = grid.get(k)
      if (l) l.push(p)
      else grid.set(k, [p])
    }
  }
  return pts.map((s) =>
    Float32Array.from(
      s.map((p) => {
        const o = outward(f, p)
        let n = 0
        const seen = new Set<string>()
        for (let t = 0.002; t <= 0.03; t += 0.003) {
          const q = add(p, scale(o, t))
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -1; dz <= 1; dz++) {
                const k = `${Math.floor(q[0] / cell) + dx},${Math.floor(q[1] / cell) + dy},${Math.floor(q[2] / cell) + dz}`
                if (seen.has(k)) continue
                seen.add(k)
                for (const r of grid.get(k) ?? []) {
                  const d = sub(r, p)
                  const along = dot(d, o)
                  if (along < 0.002 || along > 0.03) continue
                  if (len(sub(d, scale(o, along))) < 0.003) n++
                }
              }
            }
          }
        }
        // 每个引导点代表约十几根头发；8 个就算遮得差不多了 / each guide point stands for a dozen or so hairs; 8 of them is near full cover
        return 1 - Math.exp(-n / 8)
      }),
    ),
  )
}

/** 打包引导发丝 / pack the guide strands */
export function packStrands(f: HeadFrame, guides: Strand[], points: number, unit: number): Uint8Array {
  const G = guides.length, P = points
  const res = guides.map((g) => resample(g.pts, P))
  const occ = selfOcclusion(f, res)
  const sizes = [G * 12, pad(G * 4), pad(G * P * 6), pad(G * P), pad(G)]
  const buf = new Uint8Array(sizes.reduce((a, b) => a + b, 0))
  let o = 0
  const rootVerts = new Uint32Array(buf.buffer, o, G * 3)
  o += sizes[0]!
  const rootBary = new Uint16Array(buf.buffer, o, G * 2)
  o += sizes[1]!
  const offset = new Int16Array(buf.buffer, o, G * P * 3)
  o += sizes[2]!
  const occlusion = new Uint8Array(buf.buffer, o, G * P)
  o += sizes[3]!
  const layer = new Uint8Array(buf.buffer, o, G)
  const q = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v / unit)))
  guides.forEach((g, i) => {
    rootVerts.set(g.root.verts, i * 3)
    rootBary[i * 2] = Math.round(g.root.bary[1] * 65535)
    rootBary[i * 2 + 1] = Math.round(g.root.bary[2] * 65535)
    res[i]!.forEach((p, k) => {
      for (let d = 0; d < 3; d++) offset[(i * P + k) * 3 + d] = q(p[d]! - g.root.p[d]!)
      occlusion[i * P + k] = Math.round(occ[i]![k]! * 255)
    })
    layer[i] = Math.round(g.layer * 255)
  })
  return buf
}
