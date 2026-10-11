// 把整理好的分区图定义（种子、屏障）变成每个皮肤顶点一个标签。
//
// 每个分区列出种子：皮肤上的体表标志曲线，或投影到皮肤的神经中心线。标签自全部种子同时沿皮肤表面扩散（外壁网格上的测地距离），身体两侧分别计算，且不越过屏障曲线（轴线）。结果经清理（多数平滑、吸收小岛）后复制到皮肤壳的内壁。
// Turns a curated map definition (seeds, barriers) into one label per skin vertex.
//
// Every region lists seeds: landmark curves on the skin, or nerve centrelines projected to the
// skin. Labels then spread from all seeds at once along the skin surface (geodesic distance over
// mesh edges of the outer wall), each side of the body separately, and never across a barrier
// curve (axial lines). The result is cleaned (majority smoothing, small islands absorbed) and
// copied to the inner wall of the skin shell.

import type { Body } from './io.ts'
import { grow, path, type Seed } from './geodesic.ts'
import type { Dir, Landmarks, PointExpr, SideLR, SkinExpr } from './landmarks.ts'
import { add, dist, dot, mul, nrm, pos, sub, type Skin, type V3 } from './mesh.ts'

export type CurveItem =
  | SkinExpr
  /**
   * 投影到皮肤的神经中心线；clip 只保留沿某方向位于某点远侧的点。
   * A nerve's centreline projected to the skin; `clip` keeps the points on the far side of a point along a direction.
   */
  | { nerve: string; project: 'trunkRadial' | 'beneath'; maxDepthMm?: number; clip?: { dir: Dir; beyond?: PointExpr; before?: PointExpr } }
  /**
   * 神经中心线沿某方向最远的一端，投影到皮肤。
   * The end of a nerve's centreline that lies furthest along a direction, projected to the skin.
   */
  | { nerveEnd: string; dir: Dir; project: 'trunkRadial' | 'beneath' }

export interface SeedDef {
  /**
   * 以皮肤上最短路径相连的体表标志；只有一项时为点状种子。
   * Landmarks joined by shortest paths on the skin; a single item is a point seed.
   */
  curve?: CurveItem[]
  /**
   * 神经部件名称（“{side}” 代入 left/right）；其中心线投影到皮肤。
   * Nerve part name(s) ("{side}" = left/right); their centrelines projected to the skin.
   */
  nerve?: string | string[]
  /**
   * 只保留距皮肤不超过此深度的中心线点（默认 15 mm）。
   * Keep only centreline points at most this deep under the skin (default 15 mm).
   */
  maxDepthMm?: number
  /**
   * 只保留沿某肢体坐标架轴线的位置落在给定范围内的中心线点。
   * Keep only centreline points whose position along a limb frame's axis lies in the range.
   */
  where?: { frame: string; t: [number, number] }
  /**
   * 只保留投影到朝向某方向的皮肤上的点（坐标架绕轴角度，如手的 180 = 手背）：指背神经的中心线离掌侧皮肤可能更近。
   * Keep only points that project onto skin facing a direction (angle round a frame's axis, e.g.
   * 180 on the hand = dorsal): a dorsal digital nerve's centreline may lie nearer the palmar skin.
   */
  facing?: { frame: string; deg: number }
  /**
   * 距种子测地距离在此值以内的皮肤，起始距离均为 0（有宽度的种子）。
   * All skin within this geodesic distance of the seed starts at distance 0 (a seed with width).
   */
  widthMm?: number
  /**
   * 相对其他种子的让先（负值）或让后（正值），单位 mm。
   * Head start (negative) or handicap (positive) in mm against the other seeds.
   */
  offsetMm?: number
  /**
   * 关键点：其顶点在平滑中保持本标签。
   * Key point: its vertex keeps this label through smoothing.
   */
  pin?: boolean
  sides?: SideLR[]
  note?: { zh: string; en: string }
}

export interface RegionDef {
  key: string
  name: { zh: string; en: string }
  color: string
  seeds: SeedDef[]
  [extra: string]: unknown
}

export interface MapDef {
  regions: RegionDef[]
  barriers?: { name: string; curve: CurveItem[]; note?: { zh: string; en: string } }[]
  smoothIterations?: number
  minIslandCm2?: number
}

/**
 * 皮肤上的一条线：网格顶点及各自的精确表面点；gap[i] 表示 i-1 到 i 之间不连线。
 * A line on the skin: mesh vertices with the exact surface point of each; `gap[i]` = no segment from i-1 to i.
 */
export interface Line { verts: number[]; pts: V3[]; gap?: boolean[] }

export interface BuiltMap {
  /**
   * 每个皮肤顶点的分区序号（含内壁在内的全部顶点）；255 = 未分配。
   * Region index per skin vertex (all vertices, inner wall included); 255 = unassigned.
   */
  labels: Uint8Array
  /**
   * 按分区 key 和侧别列出的种子顶点（供预览和测试用）。
   * Seed vertices per region key and side (for previews and tests).
   */
  seedVerts: Map<string, number[]>
  barrierVerts: Map<string, number[]>
  pinned: { vertex: number; region: number; side: SideLR }[]
  /**
   * 未能使用的神经种子及原因。
   * Nerve seeds that could not be used and why.
   */
  notes: string[]
  /**
   * 清理后在某一侧仍分成多块的分区。
   * Regions that remain in more than one piece on a side after cleaning.
   */
  splits: { region: string; side: SideLR; pieces: number; smallerCm2: number[] }[]
}

export class Builder {
  private readonly nerveByPart = new Map<string, V3[][]>()
  constructor(readonly body: Body, readonly skin: Skin, readonly lm: Landmarks) {
    for (const n of body.nerves) {
      this.nerveByPart.set(n.part, n.branches.map((b) => {
        const pts: V3[] = []
        for (let i = 0; i < b.points.length; i += 3) pts.push([b.points[i]!, b.points[i + 1]!, b.points[i + 2]!])
        return pts
      }))
    }
  }

  private sameSide(side: SideLR) {
    const s = this.skin
    return (a: number, b: number) => {
      const xa = s.positions[a * 3]! - s.midX, xb = s.positions[b * 3]! - s.midX
      return side === 'L' ? xa >= 0 && xb >= 0 : xa < 0 && xb < 0
    }
  }

  nerveBranches(pattern: string, side: SideLR): V3[][] | null {
    if (!this.lm.hasPart(pattern, side)) return null
    return this.nerveByPart.get(this.lm.partId(pattern, side)) ?? null
  }

  /**
   * 神经中心线下方的皮肤顶点（按顺序），及各自的精确表面点。
   * Skin vertices under a nerve's centreline, in order, with the exact surface point of each.
   */
  private projectNerve(branch: V3[], mode: 'trunkRadial' | 'beneath', side: SideLR, maxDepth: number, where?: SeedDef['where'], facing?: SeedDef['facing']): Line {
    const out: Line = { verts: [], pts: [] }
    for (const p of branch) {
      if (where) {
        const t = this.lm.frameT(where.frame, p, side)
        if (t < where.t[0] || t > where.t[1]) continue
      }
      let v: number
      let q: V3
      if (mode === 'trunkRadial') {
        v = this.lm.trunkRadial(p, side)
        if (v < 0) continue
        q = this.lm.lastHit ?? pos(this.skin, v)
      } else {
        v = this.lm.nearestVertex(p, true, maxDepth)
        if (v < 0) continue
        q = pos(this.skin, v)
        // 最近表面点若落在该顶点所属的三角形上则取之（比顶点更精细）。
        // Closest surface point when it lies on a triangle of that vertex (finer than the vertex).
        const c = this.skin.outerBvh.closest(p)
        if (this.skin.outerBvh.faceVerts(c.face).includes(v)) q = c.point
      }
      if ((side === 'L') !== this.skin.positions[v * 3]! >= this.skin.midX) continue
      if (facing && dot(nrm(this.skin, v), this.lm.frameDir(facing.frame, this.lm.frameT(facing.frame, p, side), facing.deg, side)) < 0) continue
      if (out.verts[out.verts.length - 1] === v) continue
      out.verts.push(v)
      out.pts.push(q)
    }
    return out
  }

  /**
   * 把曲线定义展开为某一侧皮肤上的一条连通的线。
   * Expands a curve definition into a connected line on the skin of one side.
   */
  curve(items: CurveItem[], side: SideLR): Line {
    const stops: Line[] = []
    for (const it of items) {
      if (typeof it === 'object' && 'nerve' in it) {
        const br = this.nerveBranches(it.nerve, side)
        if (!br) throw new Error(`curve: no centreline for "${it.nerve}"`)
        // 只取最长的分支：曲线是单线。
        // Longest branch only: curves are single lines.
        let main = [...br].sort((a, b) => b.length - a.length)[0]!
        if (it.clip) {
          const d = this.lm.dir(it.clip.dir, side)
          const lo = it.clip.beyond ? dot(this.lm.point(it.clip.beyond, side), d) : -Infinity
          const hi = it.clip.before ? dot(this.lm.point(it.clip.before, side), d) : Infinity
          main = main.filter((p) => dot(p, d) >= lo && dot(p, d) <= hi)
        }
        stops.push(this.projectNerve(main, it.project, side, (it.maxDepthMm ?? 1e6) / 1000))
      } else if (typeof it === 'object' && 'nerveEnd' in it) {
        const br = this.nerveBranches(it.nerveEnd, side)
        if (!br) throw new Error(`curve: no centreline for "${it.nerveEnd}"`)
        const d = this.lm.dir(it.dir, side)
        let best: V3 | null = null
        for (const b of br) for (const p of b) if (!best || dot(p, d) > dot(best, d)) best = p
        stops.push(this.projectNerve([best!], it.project, side, 1e6))
      } else {
        const v = this.lm.vertex(it as SkinExpr, side)
        stops.push({ verts: [v], pts: [this.lm.surfacePoint(it as SkinExpr, side)] })
      }
    }
    const ok = this.sameSide(side)
    const out: Line = { verts: [], pts: [], gap: [] }
    const rev = (l: Line): Line => ({ verts: [...l.verts].reverse(), pts: [...l.pts].reverse() })
    const push = (seq: Line) => {
      if (!seq.verts.length) return
      if (out.verts.length && seq.verts.length > 1) {
        const last = out.pts[out.pts.length - 1]!
        // 调整神经段的方向，使其从曲线当前末端接续。
        // Orient a nerve run so that it continues from where the curve currently ends.
        if (dist(last, seq.pts[seq.pts.length - 1]!) < dist(last, seq.pts[0]!)) seq = rev(seq)
      }
      for (let i = 0; i < seq.verts.length; i++) {
        const v = seq.verts[i]!
        let gap = false
        if (out.verts.length) {
          const from = out.verts[out.verts.length - 1]!
          if (v === from) continue
          // 神经段内跳跃超过 5 cm，说明该处神经上方没有皮肤（上臂与胸壁粘连）：留出缺口，而不是绕过肩部去连接。
          // Inside a nerve run a jump of more than 5 cm means the nerve has no skin over it there
          // (arm fused to the chest): leave a gap instead of bridging it over the shoulder.
          gap = i > 0 && dist(out.pts[out.pts.length - 1]!, seq.pts[i]!) > 0.05
          if (!gap) {
            const p = path(this.skin, from, v, ok, [out.pts[out.pts.length - 1]!, seq.pts[i]!])
            for (const u of p.slice(1, -1)) { out.verts.push(u); out.pts.push(pos(this.skin, u)); out.gap!.push(false) }
          }
        }
        out.verts.push(v)
        out.pts.push(seq.pts[i]!)
        out.gap!.push(gap)
      }
    }
    // 位于开头的神经段则按其后一个停靠点定向。
    // A leading nerve run is oriented against the following stop instead.
    if (stops.length > 1 && stops[0]!.verts.length > 1 && stops[1]!.verts.length) {
      const nxt = stops[1]!.pts[0]!
      const a = stops[0]!
      if (dist(a.pts[0]!, nxt) < dist(a.pts[a.pts.length - 1]!, nxt)) stops[0] = rev(a)
    }
    for (const s of stops) push(s)
    return out
  }

  /**
   * 线周围的起始距离：链上的顶点及其两环以内的顶点，取到精确线的直线距离；这样边界的位置比把线吸附到网格顶点更精细。
   * Starting distances around a line: the chain's vertices and everything within two rings of
   * them get their straight distance to the exact line, which places the boundary more finely
   * than snapping the line to mesh vertices would.
   */
  private lineField(line: Line, side: SideLR, blocked: Uint8Array, into: Map<number, number>) {
    const ok = this.sameSide(side)
    const s = this.skin
    const segDist = (p: V3, a: V3, b: V3) => {
      const ab = sub(b, a), l2 = dot(ab, ab)
      const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0
      return dist(p, add(a, mul(ab, t)))
    }
    const put = (v: number, d: number) => { if (d < (into.get(v) ?? Infinity)) into.set(v, d) }
    for (let i = 0; i < line.verts.length; i++) {
      const v = line.verts[i]!
      // 顶点周围两环，但不穿过屏障。
      // Two rings around the vertex, never stepping through a barrier.
      const cand = new Set<number>([v])
      for (let k = s.adjStart[v]!; k < s.adjStart[v + 1]!; k++) {
        const u = s.adj[k]!
        if (!s.outer[u] || blocked[u] || !ok(v, u)) continue
        cand.add(u)
        for (let q = s.adjStart[u]!; q < s.adjStart[u + 1]!; q++) {
          const w = s.adj[q]!
          if (s.outer[w] && !blocked[w] && ok(u, w) && w !== v) cand.add(w)
        }
      }
      for (const u of cand) {
        const p = pos(s, u)
        let d = dist(p, line.pts[i]!)
        if (i > 0 && !line.gap?.[i]) d = Math.min(d, segDist(p, line.pts[i - 1]!, line.pts[i]!))
        if (i + 1 < line.verts.length && !line.gap?.[i + 1]) d = Math.min(d, segDist(p, line.pts[i]!, line.pts[i + 1]!))
        put(u, d)
      }
    }
  }

  /**
   * 某一种子定义在某一侧各顶点的起始距离；core 为种子本身所在的顶点。
   * Starting distance per vertex for one seed definition on one side; `core` = vertices on the seed itself.
   */
  private seedField(def: SeedDef, side: SideLR, blocked: Uint8Array, notes: string[], region: string): { field: Map<number, number>; core: number[] } {
    const field = new Map<number, number>()
    const core: number[] = []
    const ok = this.sameSide(side)
    if (def.curve) {
      const line = this.curve(def.curve, side)
      this.lineField(line, side, blocked, field)
      core.push(...line.verts)
    } else if (def.nerve) {
      for (const pattern of Array.isArray(def.nerve) ? def.nerve : [def.nerve]) {
        const br = this.nerveBranches(pattern, side)
        if (!br) { notes.push(`${region}: nerve "${this.lm.partName(pattern, side)}" has no centreline; seed skipped`); continue }
        let used = 0
        for (const b of br) {
          const raw = this.projectNerve(b, 'beneath', side, (def.maxDepthMm ?? 15) / 1000, def.where, def.facing)
          used += raw.verts.length
          const line: Line = { verts: [], pts: [], gap: [] }
          for (let i = 0; i < raw.verts.length; i++) {
            const joined = i > 0 && dist(raw.pts[i - 1]!, raw.pts[i]!) < 0.04
            if (joined)
              for (const u of path(this.skin, raw.verts[i - 1]!, raw.verts[i]!, ok, [raw.pts[i - 1]!, raw.pts[i]!]).slice(1, -1)) { line.verts.push(u); line.pts.push(pos(this.skin, u)); line.gap!.push(false) }
            line.verts.push(raw.verts[i]!)
            line.pts.push(raw.pts[i]!)
            line.gap!.push(!joined)
          }
          this.lineField(line, side, blocked, field)
          core.push(...line.verts)
        }
        if (!used) notes.push(`${region}: nerve "${this.lm.partName(pattern, side)}" never comes within ${def.maxDepthMm ?? 15} mm of the skin${def.where ? ' in the requested range' : ''}; seed skipped`)
      }
    }
    if (def.widthMm && core.length) {
      const f = grow(this.skin, core.map((v) => ({ vertex: v, label: 0, d0: 0 })), undefined, ok)
      for (let i = 0; i < this.skin.n; i++) if (f.dist[i]! <= def.widthMm / 1000) { field.set(i, 0); core.push(i) }
    }
    if (def.pin) for (const v of core) field.set(v, 0)
    return { field, core: [...new Set(core)] }
  }

  build(def: MapDef): BuiltMap {
    const skin = this.skin
    const notes: string[] = []
    const seedVerts = new Map<string, number[]>()
    const barrierVerts = new Map<string, number[]>()
    const pinned: BuiltMap['pinned'] = []
    const label = new Int16Array(skin.n).fill(-1)
    const pinMask = new Uint8Array(skin.n)
    // 每个顶点若位于某分区的种子曲线（curve 种子）上，记下该分区（先到先得）。神经种子分支多而密，不在此列。
    // The region whose seed curve a vertex lies on, if any (first come, first served). Nerve
    // seeds, with their many close branches, are not included.
    const coreOf = new Int16Array(skin.n).fill(-1)
    for (const side of ['L', 'R'] as SideLR[]) {
      const ok = this.sameSide(side)
      const blocked = new Uint8Array(skin.n)
      for (const b of def.barriers ?? []) {
        const vs = this.curve(b.curve, side).verts
        barrierVerts.set(`${b.name}|${side}`, vs)
        // 屏障向两侧各加厚一环，使二环直连无法跨越。
        // The barrier is one ring thick on each side so that second-ring links cannot jump it.
        for (const v of vs) {
          blocked[v] = 1
          for (let k = skin.adjStart[v]!; k < skin.adjStart[v + 1]!; k++) blocked[skin.adj[k]!] = 1
        }
      }
      const seeds: Seed[] = []
      const isCore = new Uint8Array(skin.n)
      def.regions.forEach((r, ri) => {
        const mine: number[] = []
        for (const s of r.seeds) {
          if (s.sides && !s.sides.includes(side)) continue
          const { field, core } = this.seedField(s, side, blocked, notes, r.key)
          for (const [v, d] of [...field].sort((a, b) => a[0] - b[0])) seeds.push({ vertex: v, label: ri, d0: d + (s.offsetMm ?? 0) / 1000 })
          if (s.pin) for (const v of core) { pinned.push({ vertex: v, region: ri, side }); pinMask[v] = 1 }
          for (const v of core) isCore[v] = 1
          if (s.curve) for (const v of core) if (coreOf[v]! < 0) coreOf[v] = ri
          mine.push(...core)
        }
        seedVerts.set(`${r.key}|${side}`, mine)
      })
      // 种子与屏障落在同一顶点时，种子优先。
      // Seeds win over barriers where both lie on the same vertex.
      for (let i = 0; i < skin.n; i++) if (isCore[i]) blocked[i] = 0
      const f = grow(skin, seeds, blocked, ok)
      // 屏障顶点及被围住的部分：取最近的已标注皮肤的标签。
      // Barrier vertices and anything walled in: take the label of the nearest labelled skin.
      const rest: Seed[] = []
      for (let i = 0; i < skin.n; i++) if (f.label[i]! >= 0) rest.push({ vertex: i, label: f.label[i]!, d0: 0 })
      const g = grow(skin, rest, undefined, ok)
      for (let i = 0; i < skin.n; i++) {
        if (!skin.outer[i] || g.label[i]! < 0) continue
        if ((side === 'L') === skin.positions[i * 3]! >= skin.midX) label[i] = g.label[i]!
      }
    }
    for (const p of pinned) label[p.vertex] = p.region

    // 多数平滑：被邻点否决的顶点改取邻点中最常见的标签。
    // Majority smoothing: a vertex outvoted by its neighbours takes their commonest label.
    const count = new Map<number, number>()
    for (let it = 0; it < (def.smoothIterations ?? 6); it++) {
      const next = label.slice()
      for (let i = 0; i < skin.n; i++) {
        if (!skin.outer[i] || pinMask[i] || label[i]! < 0) continue
        // 种子线上的顶点只要仍属本区就不参与平滑：在粗网格上，细带的种子链会被邻点多数否决而断开。
        // A vertex on a seed line keeps its own region's label through smoothing: on the coarse
        // parts of the mesh the seed chain of a narrow band is otherwise outvoted and broken.
        if (coreOf[i] === label[i]) continue
        count.clear()
        let total = 0, same = 0
        for (let k = skin.adjStart[i]!; k < skin.adjStart[i + 1]!; k++) {
          const u = skin.adj[k]!
          if (!skin.outer[u] || label[u]! < 0) continue
          if ((skin.positions[u * 3]! >= skin.midX) !== (skin.positions[i * 3]! >= skin.midX)) continue
          total++
          if (label[u] === label[i]) same++
          count.set(label[u]!, (count.get(label[u]!) ?? 0) + 1)
        }
        if (same * 2 >= total) continue
        let best = label[i]!, bc = same
        for (const [l, c] of [...count].sort((a, b) => a[0] - b[0])) if (c > bc) { bc = c; best = l }
        next[i] = best
      }
      label.set(next)
    }

    // 小岛：分区中小于阈值的碎块并入与其接触最多的相邻分区。
    // Islands: any piece of a region smaller than the threshold joins the neighbour it touches most.
    const splits: BuiltMap['splits'] = []
    const minIsland = (def.minIslandCm2 ?? 6) / 1e4
    for (let round = 0; round < 3; round++) {
      const comp = new Int32Array(skin.n).fill(-1)
      const comps: { label: number; side: SideLR; verts: number[]; area: number }[] = []
      for (let i = 0; i < skin.n; i++) {
        if (!skin.outer[i] || comp[i]! >= 0 || label[i]! < 0) continue
        const side: SideLR = skin.positions[i * 3]! >= skin.midX ? 'L' : 'R'
        const c = { label: label[i]!, side, verts: [i], area: 0 }
        comp[i] = comps.length
        for (let h = 0; h < c.verts.length; h++) {
          const v = c.verts[h]!
          c.area += skin.area[v]!
          for (let k = skin.adjStart[v]!; k < skin.adjStart[v + 1]!; k++) {
            const u = skin.adj[k]!
            if (!skin.outer[u] || comp[u]! >= 0 || label[u] !== c.label) continue
            if ((skin.positions[u * 3]! >= skin.midX) !== (side === 'L')) continue
            comp[u] = comps.length
            c.verts.push(u)
          }
        }
        comps.push(c)
      }
      const largest = new Map<string, number>()
      comps.forEach((c) => { const k = `${c.label}|${c.side}`; if (c.area > (largest.get(k) ?? 0)) largest.set(k, c.area) })
      let changed = false
      splits.length = 0
      const groups = new Map<string, number[]>()
      for (const c of comps) {
        const k = `${c.label}|${c.side}`
        if (c.area >= largest.get(k)!) continue
        const hasPin = c.verts.some((v) => pinMask[v])
        if (c.area < minIsland && !hasPin) {
          const votes = new Map<number, number>()
          for (const v of c.verts)
            for (let kk = skin.adjStart[v]!; kk < skin.adjStart[v + 1]!; kk++) {
              const u = skin.adj[kk]!
              if (skin.outer[u] && label[u]! >= 0 && label[u] !== c.label && (skin.positions[u * 3]! >= skin.midX) === (c.side === 'L')) votes.set(label[u]!, (votes.get(label[u]!) ?? 0) + 1)
            }
          const win = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
          if (win) { for (const v of c.verts) label[v] = win[0]; changed = true; continue }
        }
        groups.set(k, [...(groups.get(k) ?? []), c.area * 1e4])
      }
      for (const [k, areas] of groups) {
        const [l, side] = k.split('|') as [string, SideLR]
        splits.push({ region: def.regions[+l]!.key, side, pieces: areas.length + 1, smallerCm2: areas.map((a) => +a.toFixed(1)).sort((a, b) => b - a) })
      }
      if (!changed) break
    }

    const labels = new Uint8Array(skin.n).fill(255)
    for (let i = 0; i < skin.n; i++) {
      const l = label[skin.outerOf[i]!]!
      labels[i] = l >= 0 ? l : 255
    }
    return { labels, seedVerts, barrierVerts, pinned, notes, splits }
  }
}
