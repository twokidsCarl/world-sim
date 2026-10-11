// 关节局部配准（通用版）：跨骨部件（韧带、半月板、关节囊）只依据它所连的骨来放置。
// 与 importZa.ts 中的 localJointWarp 思路相同，但不依赖图谱包的数据结构：调用方给出源空间里
// 的骨、每块骨去向何处（映射函数），以及可选的目标骨表面（用于局部 ICP 和贴合）。
// 女性构建用它把男性的跨骨部件挂到她自己的骨上；男性构建仍用 importZa.ts 的版本。
// Joint-local registration (generic): a part that spans bones (a ligament, a meniscus, a capsule)
// is placed by its bones alone. Same idea as localJointWarp in importZa.ts, but free of the atlas
// package's data structures: the caller gives the bones in source space, where each bone goes
// (a mapping function) and, optionally, the target bone surface (for a local ICP and snapping).
// The female build uses it to hang the male's two-bone parts on her own bones; the male build
// keeps the importZa.ts version.

import type { Mesh } from './geometry.ts'
import { applyRigid, fitSimilarity, icp, PointIndex, thinPoints, type Rigid } from './register.ts'

export interface JointBone {
  id: string
  /** 源空间中骨表面的采样点（间距约 1 mm）及其包围盒 / surface samples of the bone in source space (about 1 mm apart) and their bbox */
  points: () => Float32Array
  bbox: number[]
  /** 这块骨上的点去向何处（全身形变场，或骨自己的变换） / where points of this bone go (the body-wide field, or the bone's own transform) */
  map: (points: Float32Array) => Float32Array
  /** 目标骨的表面；有则先做局部 ICP 再贴合，无则 `map` 即为准确去向 / the target bone's surface: with it a local ICP and a snap follow; without it `map` is exact */
  target?: PointIndex
}

export interface JointLocalOptions {
  /** 部件距骨在此距离以内才算附着（米） / a part is attached to a bone within this distance (m) */
  attachDistance?: number
  /** 局部拟合后，距目标骨表面在此距离以内的点贴到表面上（米） / after the local fit, points within this distance of the target surface are snapped onto it (m) */
  snapDistance?: number
  /** 局部拟合所用骨表面的范围：部件包围盒向外这么远（米） / extent of bone surface used for the local fit: this far beyond the part's bbox (m) */
  local?: number
  /** 最多混合几块骨 / blend at most this many bones */
  maxBones?: number
}

export interface JointLocalResult {
  mesh: Mesh
  /** 所挂的骨及其在源空间中与部件的最近距离（米） / the bones used and their closest approach to the part in source space (m) */
  bones: { id: string; sourceGap: number }[]
}

interface CacheEntry { index: PointIndex; mapped: Float32Array; r: number[] }

/**
 * 把跨骨部件从源空间搬到目标空间：每个顶点保持它相对于各附着骨上最近表面点的位置，
 * 各骨的结果按 1/(d + 1 mm)² 混合。附近没有骨时返回 null。
 * Carries a two-bone part from source to target space: every vertex keeps its position relative
 * to the nearest surface point of each bone it is attached to, the bones' answers blended by
 * 1/(d + 1 mm)². Returns null when no bone is near.
 */
export function jointLocalWarp(mesh: Mesh, bones: JointBone[], cache: Map<string, CacheEntry>, opts: JointLocalOptions = {}): JointLocalResult | null {
  const { attachDistance = 0.004, snapDistance = 0.006, local = 0.04, maxBones = 3 } = opts
  const v = mesh.positions
  const nv = v.length / 3
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) {
    if (v[i + k]! < b[k]!) b[k] = v[i + k]!
    if (v[i + k]! > b[k + 3]!) b[k + 3] = v[i + k]!
  }
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  const candidates: { bone: JointBone; gap: number; entry: CacheEntry }[] = []
  for (const bone of bones) {
    const ab = bone.bbox
    if (ab[0]! > b[3]! + attachDistance || ab[3]! < b[0]! - attachDistance || ab[1]! > b[4]! + attachDistance || ab[4]! < b[1]! - attachDistance || ab[2]! > b[5]! + attachDistance || ab[5]! < b[2]! - attachDistance) continue
    // 按骨和部件所在位置缓存 / cached per bone and place
    const key = `${bone.id}|${Math.round(((b[0]! + b[3]!) / 2) * 50)}|${Math.round(((b[1]! + b[4]!) / 2) * 50)}|${Math.round(((b[2]! + b[5]!) / 2) * 50)}`
    let entry = cache.get(key)
    if (!entry) {
      const near: number[] = []
      const all = bone.points()
      for (let i = 0; i < all.length; i += 3) {
        if (all[i]! < b[0]! - local || all[i]! > b[3]! + local || all[i + 1]! < b[1]! - local || all[i + 1]! > b[4]! + local || all[i + 2]! < b[2]! - local || all[i + 2]! > b[5]! + local) continue
        near.push(all[i]!, all[i + 1]!, all[i + 2]!)
      }
      const src = Float32Array.from(near)
      if (src.length < 90) continue
      const viaMap = bone.map(src)
      if (!viaMap.every(Number.isFinite)) continue
      // 局部相似变换（旋转 × 均匀缩放）：既是 ICP 的初值，也给出顶点相对偏移的变换
      // the local similarity (rotation × uniform scale): the ICP's start, and the transform of a vertex's offset
      let fit: Rigid = fitSimilarity(src, viaMap)
      let mapped = viaMap
      if (bone.target) {
        const local = icp(thinPoints(src, 0.003), bone.target, { maxIterations: 30, initial: fit, scale: true }).transform
        // 局部 ICP 退化（配对太少）时保留初值 / a degenerate local ICP (too few pairs) keeps the starting transform
        if ([...local.r, ...local.t].every(Number.isFinite)) fit = local
        mapped = applyRigid(fit, src)
        for (let i = 0; i < mapped.length; i += 3) {
          if (!bone.target.nearest(mapped[i]!, mapped[i + 1]!, mapped[i + 2]!, 1, I, D, snapDistance)) continue
          const q = I[0]!
          mapped[i] = bone.target.points[3 * q]!
          mapped[i + 1] = bone.target.points[3 * q + 1]!
          mapped[i + 2] = bone.target.points[3 * q + 2]!
        }
      }
      cache.set(key, (entry = { index: new PointIndex(src, 0.004), mapped, r: fit.r }))
    }
    let gap = Infinity
    for (let i = 0; i < v.length; i += 3) gap = Math.min(gap, entry.index.distance(v[i]!, v[i + 1]!, v[i + 2]!, attachDistance * 4))
    if (gap <= attachDistance) candidates.push({ bone, gap, entry })
  }
  if (!candidates.length) return null
  candidates.sort((x, y) => x.gap - y.gap || (x.bone.id < y.bone.id ? -1 : 1))
  const used = candidates.slice(0, maxBones)
  const out = new Float32Array(v.length)
  for (let i = 0; i < nv; i++) {
    const x = v[3 * i]!
    const y = v[3 * i + 1]!
    const z = v[3 * i + 2]!
    let wSum = 0
    let ox = 0
    let oy = 0
    let oz = 0
    for (const c of used) {
      c.entry.index.nearest(x, y, z, 1, I, D)
      const q = I[0]!
      const d = Math.sqrt(D[0]!)
      const w = 1 / (d + 0.001) ** 2
      const src = c.entry.index.points
      const dx = x - src[3 * q]!
      const dy = y - src[3 * q + 1]!
      const dz = z - src[3 * q + 2]!
      const r = c.entry.r
      ox += w * (c.entry.mapped[3 * q]! + r[0]! * dx + r[1]! * dy + r[2]! * dz)
      oy += w * (c.entry.mapped[3 * q + 1]! + r[3]! * dx + r[4]! * dy + r[5]! * dz)
      oz += w * (c.entry.mapped[3 * q + 2]! + r[6]! * dx + r[7]! * dy + r[8]! * dz)
      wSum += w
    }
    out[3 * i] = ox / wSum
    out[3 * i + 1] = oy / wSum
    out[3 * i + 2] = oz / wSum
  }
  if (!out.every(Number.isFinite)) return null
  return { mesh: { positions: out, indices: mesh.indices }, bones: used.map((c) => ({ id: c.bone.id, sourceGap: c.gap })) }
}
