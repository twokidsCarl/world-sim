// 头颈的肌和腱在新头的皮肤下留够覆盖：体形重塑之后的一道局部收尾。
// 为什么要有：头换成参数化头模型自己的女性头之后，皮肤包的外推（reissue_head.py）要求深部结构在皮肤下至少 2.5 mm；
// 体形重塑的包络在骨浅的地方只留 1.5 mm，唇的搬运又把口周的肌整体前移，结果下唇下方、鼻旁、内眦旁、颞部和颈侧的肌
// 离皮肤不足 2.5 mm 甚至在皮肤外，皮肤只好被顶出去，脸上留下一道道棱。这里反过来动肌：
//   覆盖不足的顶点沿离开皮肤的方向内移，移到覆盖够为止；位移先沿网格向邻点铺开（每圈取邻点均值的 keep 倍与自己的较大者），
//   所以一片肌是成片下沉，不是被戳出一个坑；位移还穿过厚度传给背面的顶点（整层一起走，体积不变）；不许移进骨、牙和眼球里。
//   最后一遍才逐顶点移动（最多 thinMax）：背面贴着骨的地方肌被压薄，仍不够的留给皮肤包去外推。
// 只动顶点位置，不改拓扑；体积逐部件报告（在凸的头面上整层内移几毫米，面积本身就按几何比例缩小）。淋巴结同样处理。
// 假定：2.7 mm（外推规则的 2.5 mm 加 0.2 mm 余量）不是文献里的皮肤厚度，是与外推规则对齐的工程值。
//
// Enough cover for the muscles and tendons of head and neck under the skin of the new head: a local finishing pass after
// the body-shape stage. Why: with the parametric model's own female head, the enclosure of the skin package
// (reissue_head.py) wants every deep part at least 2.5 mm under the skin; the envelope of the body-shape stage leaves
// 1.5 mm where bone is shallow and the lip carry translates the perioral muscles forwards, so under the lower lip, beside
// the nose and the medial canthi, at the temples and on the side of the neck muscle lay closer than 2.5 mm or outside,
// and the skin was pushed out over it, leaving ridges on the face. Here the muscle moves instead:
//   vertices short of cover move away from the skin until they have it; the displacement is first spread to neighbours
//   along the mesh (each round the larger of a vertex's own value and `keep` x the mean of its neighbours), so a sheet
//   sinks as a patch and is not dented; the move also passes through the thickness to the vertices at the back (the whole
//   layer goes together and keeps its volume); nothing moves into bone, teeth or a globe. Only the last pass moves vertex
//   by vertex (by at most thinMax): where the back lies on bone the muscle is thinned, and what is still short is left to
//   the enclosure of the skin package.
// Only vertex positions change; volumes are reported per part (a layer moved a few millimetres inwards on the convex head
// shrinks in area by geometry alone). Lymph nodes are treated the same way.
// ASSUMPTION: 2.7 mm (the 2.5 mm of the enclosure rule plus 0.2 mm) is not a published skin thickness; it is an
// engineering value matched to the enclosure rule.

import { measure, type Mesh } from './geometry.ts'
import { InsideTester, PointIndex } from './register.ts'
import { SurfaceDistance } from './skinPackage.ts'

export interface CoverOptions {
  /** 皮肤下至少这么深（米） / the least depth under the skin (m) */
  cover: number
  /** 一个顶点最多内移这么远（米） / the largest inward move of a vertex (m) */
  maxMove: number
  /** 离骨、牙、眼球至少这么远（米） / the least distance kept from bone, teeth and the globes (m) */
  clearance: number
  /** 位移向邻点铺开的圈数和每圈的保留比例 / rounds of spreading the displacement to neighbours, and the share kept each round */
  spreadRounds: number
  keep: number
  /** 遍数：前几遍整层下沉，最后一遍逐顶点（压薄） / passes: the whole thickness sinks in all but the last, which moves vertex by vertex (thinning) */
  passes: number
  /** 最后一遍一个顶点最多移这么远（米）：压薄的上限 / the largest move of a vertex in the last pass (m): the bound on thinning */
  thinMax: number
}

export const COVER_DEFAULTS: CoverOptions = { cover: 0.0027, maxMove: 0.012, clearance: 0.0003, spreadRounds: 6, keep: 0.8, passes: 4, thinMax: 0.0015 }
/** 需要量穿过厚度传递的范围（米）：throughMin + 需要量以内全额，再过 throughFade 收到零 / how far a need reaches through the thickness (m): in full within throughMin + the need, fading to zero over throughFade */
const THROUGH_MIN = 0.003
const THROUGH_FADE = 0.006
/** 算法或参数一改就加一（并入内部结构指纹） / raised whenever the algorithm changes (mixed into the internals fingerprint) */
export const COVER_VERSION = 2

/**
 * 把逐顶点的“需要量”沿网格的边铺开（纯函数）：每圈 m[i] = max(m[i], keep × 邻点 m 的均值)。只增不减。
 * Spreads a per-vertex need along the edges of a mesh (pure): each round m[i] = max(m[i], keep x mean of the neighbours' m). Never decreases.
 */
export function spreadNeed(need: ArrayLike<number>, indices: ArrayLike<number>, rounds: number, keep: number): Float32Array {
  const n = need.length
  let m = Float32Array.from(need)
  const nb: number[][] = Array.from({ length: n }, () => [])
  for (let t = 0; t + 2 < indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = indices[t + k]!
    const b = indices[t + ((k + 1) % 3)]!
    nb[a]!.push(b)
    nb[b]!.push(a)
  }
  for (let r = 0; r < rounds; r++) {
    const next = Float32Array.from(m)
    for (let i = 0; i < n; i++) {
      const l = nb[i]!
      if (!l.length) continue
      let s = 0
      for (const j of l) s += m[j]!
      const v = (keep * s) / l.length
      if (v > next[i]!) next[i] = v
    }
    m = next
  }
  return m
}

export interface CoverPart {
  id: string
  name: string
  mesh: Mesh
}

export interface CoverRow {
  id: string
  name: string
  vertices: number
  movedVertices: number
  maxMoveMm: number
  /** 最浅处在皮肤下多深（毫米；负 = 在皮肤外），之前和之后 / depth of the shallowest vertex under the skin (mm; negative = outside), before and after */
  leastCoverBeforeMm: number
  leastCoverAfterMm: number
  /** 被骨、牙或眼球挡住而没移够的顶点数 / vertices held short by bone, teeth or a globe */
  heldByBone: number
  volumeMl: { before: number; after: number; change: number }
}

/**
 * 见文件头。`fade(y)` 给出高度 y 处位移的比例（颈根以下为 0）；`obstacles` 是骨和牙表面的采样点；`globes` 是眼球（球心、半径）。
 * 返回动过的部件的新顶点位置和逐部件的报告；不改写输入。
 * See the head of this file. `fade(y)` is the share of the displacement at height y (0 below the root of the neck);
 * `obstacles` are samples of the bone and tooth surfaces; `globes` the eyeballs (centre, radius). Returns the new vertex
 * positions of the parts that moved and a row per part; the input is not modified.
 */
export function coverUnderSkin(parts: CoverPart[], skin: Mesh, obstacles: Float32Array, globes: { centre: readonly number[]; radius: number }[], fade: (y: number) => number, opts: CoverOptions = COVER_DEFAULTS): { moved: Map<string, Float32Array>; rows: CoverRow[] } {
  const tester = new InsideTester(skin, 256)
  const surface = new SurfaceDistance(skin)
  const bone = new PointIndex(obstacles, 0.01)
  const depthAt = (x: number, y: number, z: number) => (tester.contains(x, y, z) ? 1 : -1) * surface.distance(x, y, z, 0.05)
  const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d
  const moved = new Map<string, Float32Array>()
  const rows: CoverRow[] = []
  const H = 0.0005
  for (const p of parts) {
    const src = p.mesh.positions
    const n = src.length / 3
    let pos = Float32Array.from(src)
    const total = new Float32Array(n)
    let leastBefore = Infinity
    let held = 0
    let any = false
    for (let pass = 0; pass < opts.passes; pass++) {
      const need = new Float32Array(n)
      const dep = new Float32Array(n)
      let some = false
      for (let i = 0; i < n; i++) {
        const y = pos[3 * i + 1]!
        const f = fade(y)
        if (f <= 0) {
          dep[i] = Infinity
          continue
        }
        const d = depthAt(pos[3 * i]!, y, pos[3 * i + 2]!)
        dep[i] = d
        if (pass === 0 && d < leastBefore) leastBefore = d
        if (d < opts.cover) {
          need[i] = Math.min(opts.maxMove - total[i]!, (opts.cover + 0.0002 - d) * f)
          some = true
        }
      }
      if (!some) break
      any = true
      const m = spreadNeed(need, p.mesh.indices, opts.spreadRounds, opts.keep)
      // 离骨、牙还有多少余地（保守：不管方向） / the room left before bone and teeth (conservative: whatever the direction)
      const room = new Float32Array(n)
      for (let i = 0; i < n; i++) room[i] = fade(pos[3 * i + 1]!) > 0 ? Math.max(0, bone.distance(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!, opts.maxMove + 0.004) - opts.clearance) : 0
      const amount = new Float32Array(n)
      if (pass < opts.passes - 1) {
        // 整层下沉：一个顶点的位移取它周围（空间里，不只沿网格）各顶点需要量的最大者——需要量 mⱼ 在 throughMin + mⱼ 以内全额、再过
        // throughFade 收到零——于是薄片的背面跟着正面走，厚的肌整个截面一起走，体积不变；再取 3 mm 以内各顶点余地的最小值，
        // 背面贴着骨的地方整层都不动（留给最后一遍）。
        // The whole thickness sinks: a vertex takes the largest need of the vertices around it (in space, not only along the mesh) - a
        // need m_j counts in full within throughMin + m_j and fades to zero over throughFade - so the back of a sheet goes with its front
        // and a thick belly moves as a whole cross-section, keeping its volume; then the least room of the vertices within 3 mm is
        // taken, so where the back lies on bone the whole thickness stays (left to the last pass).
        const srcs: number[] = []
        for (let j = 0; j < n; j++) if (m[j]! > 1e-6) srcs.push(j)
        for (let i = 0; i < n; i++) {
          if (!(fade(pos[3 * i + 1]!) > 0)) continue
          let a = 0
          let least = room[i]!
          for (const j of srcs) {
            const d = Math.hypot(pos[3 * i]! - pos[3 * j]!, pos[3 * i + 1]! - pos[3 * j + 1]!, pos[3 * i + 2]! - pos[3 * j + 2]!)
            const r0 = THROUGH_MIN + m[j]!
            if (d >= r0 + THROUGH_FADE) continue
            const t = d <= r0 ? 1 : 1 - (d - r0) / THROUGH_FADE
            const v = m[j]! * t * t * (3 - 2 * t)
            if (v > a) a = v
          }
          if (!(a > 1e-6)) continue
          for (let j = 0; j < n; j++) {
            if (room[j]! >= least) continue
            if (Math.hypot(pos[3 * i]! - pos[3 * j]!, pos[3 * i + 1]! - pos[3 * j + 1]!, pos[3 * i + 2]! - pos[3 * j + 2]!) < 0.003) least = room[j]!
          }
          amount[i] = Math.min(a, least, opts.maxMove - total[i]!) * fade(pos[3 * i + 1]!)
        }
      } else {
        // 最后一遍：仍不够的顶点各自内移到骨前为止——这里肌被压薄（逐部件报告体积） / the last pass: vertices still short move on their own as far as bone allows - here the muscle is thinned (volumes are reported per part)
        for (let i = 0; i < n; i++) {
          const a = Math.min(m[i]!, opts.maxMove - total[i]!, opts.thinMax) * fade(pos[3 * i + 1]!)
          if (a > room[i]! && need[i]! > room[i]! + 1e-5) held++
          amount[i] = Math.min(a, room[i]!)
        }
      }
      const next = Float32Array.from(pos)
      for (let i = 0; i < n; i++) {
        let a = amount[i]!
        if (!(a > 1e-6)) continue
        const x = pos[3 * i]!
        const y = pos[3 * i + 1]!
        const z = pos[3 * i + 2]!
        // 离开皮肤的方向：皮肤内是无符号距离的梯度，皮肤外反号 / the direction away from the skin: the gradient of the unsigned distance inside it, its negative outside
        const inside = tester.contains(x, y, z)
        const g = [surface.distance(x + H, y, z, 0.05) - surface.distance(x - H, y, z, 0.05), surface.distance(x, y + H, z, 0.05) - surface.distance(x, y - H, z, 0.05), surface.distance(x, y, z + H, 0.05) - surface.distance(x, y, z - H, 0.05)]
        const gl = (Math.hypot(g[0]!, g[1]!, g[2]!) || 1) * (inside ? 1 : -1)
        let q: [number, number, number] = [x + (a * g[0]!) / gl, y + (a * g[1]!) / gl, z + (a * g[2]!) / gl]
        for (const sp of globes) {
          const r = Math.hypot(q[0] - sp.centre[0]!, q[1] - sp.centre[1]!, q[2] - sp.centre[2]!)
          if (r < sp.radius + 0.0005) {
            if (need[i]! > 1e-5) held++
            q = [x, y, z]
            a = 0
          }
        }
        next.set(q, 3 * i)
        total[i] = total[i]! + a
      }
      pos = next
    }
    if (!any) continue
    let movedVertices = 0
    let maxMove = 0
    let leastAfter = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pos[3 * i]! - src[3 * i]!, pos[3 * i + 1]! - src[3 * i + 1]!, pos[3 * i + 2]! - src[3 * i + 2]!)
      if (d > 1e-6) movedVertices++
      if (d > maxMove) maxMove = d
      if (fade(pos[3 * i + 1]!) > 0) leastAfter = Math.min(leastAfter, depthAt(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!))
    }
    if (!movedVertices) continue
    const vb = Math.abs(measure(p.mesh).signedVolume) * 1e6
    const va = Math.abs(measure({ positions: pos, indices: p.mesh.indices }).signedVolume) * 1e6
    moved.set(p.id, pos)
    rows.push({ id: p.id, name: p.name, vertices: n, movedVertices, maxMoveMm: r1(maxMove * 1000), leastCoverBeforeMm: r1(leastBefore * 1000), leastCoverAfterMm: r1(leastAfter * 1000), heldByBone: held, volumeMl: { before: r1(vb, 3), after: r1(va, 3), change: vb > 0 ? r1(va / vb - 1, 4) : 0 } })
  }
  rows.sort((a, b) => b.maxMoveMm - a.maxMoveMm || (a.id < b.id ? -1 : 1))
  return { moved, rows }
}
