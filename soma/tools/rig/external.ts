// 外部提供的蒙皮权重：某个部件（男性换用的 MHR 拓扑皮肤）自带按别的骨架给出的关节权重时，
// 把那些关节映射到本骨架的关节，并按“原始表面上的最近点”把权重传给部件的顶点。
// Externally supplied skin weights: when a part (the male's replacement skin in MHR topology) comes
// with joint weights for another skeleton, those joints are mapped onto the joints of this rig and
// the weights are handed to the part's vertices by closest point on the original surface.
//
// 为什么按最近点而不按顶点下标：发布的 GLB 皮肤是原始表面简化后的版本，顶点数和顺序都不同。
// Why by closest point and not by index: the shipped GLB skin is a simplified version of the
// original surface, with other vertices in another order.
//
// 目录格式（tools/bodyshape 写出，见其 manifest.json）/ directory layout (written by tools/bodyshape, see its manifest.json):
//   skin.obj      原始表面：v x y z / f a b c（下标从 1 起）/ the original surface (1-based faces)
//   weights.bin   记录 (uint32 顶点, uint32 关节, float32 权重)，小端 / records (uint32 vertex, uint32 joint, float32 weight), little endian
//   joints.json   names、parents、positions、mapping[i].anatomical = 本骨架的关节 id 或 null / this rig's joint id, or null
//   manifest.json source.name = 部件的 Part.source；fittedTo.body = 适用的人体 / the Part.source of the part; the body it was fitted to

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Surface } from './geom.ts'
import type { V3 } from './math.ts'

/** 外部关节 → 本骨架关节的规则（按外部关节名的正则，自上而下取第一条）。 A rule mapping external joints onto this rig (regular expression on the external joint's name; the first match from the top wins). */
export interface ExternalRule {
  match: string
  /** 固定份额：{S} 换成 L / R（取自正则第 1 组的 l / r）；{n} 是第 2 组的数字，share 里可写 "n/5" 这样的式子。 Fixed shares: {S} becomes L / R (from group 1, l / r); a share may be a number or "n/5" / "1-n/5" with n = group 2. */
  to?: { joint: string; share: number | string }[]
  /** 沿脊柱按顶点高度分配到 rigChain 上相邻的两个关节；范围限制在该外部关节与 mhrChain 中下一个关节的高度之间。 Spread along the spine by vertex height onto the two neighbouring joints of rigChain, within the heights of this external joint and the next one in mhrChain. */
  axial?: { mhrChain: string[]; rigChain: string[]; as?: string }
  /** 给最近的那个关节（按顶点到“关节中心—tail”线段的距离），候选为匹配该正则的关节。 To the nearest joint (by the vertex's distance to the segment centre–tail) among those matching this expression. */
  nearest?: string
  why?: { zh: string; en: string }
}

export interface RigJointGeom {
  id: string
  center: V3
  tail: V3
}

export interface ExternalWeights {
  dir: string
  /** 适用部件的 Part.source。 The Part.source of the part these weights belong to. */
  sourceName: string
  body: string | null
  vertexCount: number
  /** 原始表面每个顶点：本骨架的关节下标 → 权重（和为 1）。 Per vertex of the original surface: joint index of this rig → weight (summing to 1). */
  rows: Map<number, number>[]
  /** 每个外部关节用的是哪条规则、落到哪些关节。 For every external joint: the rule used and the joints it lands on. */
  mapped: { external: string; rule: string; joints: string[] }[]
  notes: string[]
  /** 把权重按最近点传到给定顶点（flat xyz）；同时返回到原始表面的距离统计。 Transfers the weights to the given vertices (flat xyz) by closest point, with distance statistics to the original surface. */
  transfer(positions: Float32Array): { rows: Map<number, number>[]; meanMm: number; maxMm: number }
}

interface JointsFile {
  names: string[]
  parents: number[]
  positions: number[][]
  mapping: { anatomical: string | null }[]
}

function share(expr: number | string, n: number): number {
  if (typeof expr === 'number') return expr
  const m = /^\s*(1\s*-\s*)?n\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(expr)
  if (!m) throw new Error(`rig: cannot read share "${expr}" (use a number, "n/5" or "1-n/5")`)
  const v = n / Number(m[2])
  return m[1] ? 1 - v : v
}

/** 读入外部权重包并映射到本骨架；目录或必需文件不存在时返回 null。 Reads an external weight package and maps it onto this rig; null when the directory or a required file is absent. */
export function loadExternalWeights(dir: string, joints: RigJointGeom[], rules: ExternalRule[] = []): ExternalWeights | null {
  const need = ['weights.bin', 'joints.json', 'skin.obj', 'manifest.json'].map((f) => join(dir, f))
  if (!need.every((f) => existsSync(f))) return null
  const jf = JSON.parse(readFileSync(need[1]!, 'utf8')) as JointsFile
  const manifest = JSON.parse(readFileSync(need[3]!, 'utf8')) as { source?: { name?: string }; fittedTo?: { body?: string } }
  const index = new Map(joints.map((j, i) => [j.id, i]))
  const notes: string[] = []

  // 原始表面 / the original surface
  const pos: number[] = [], idx: number[] = []
  for (const line of readFileSync(need[2]!, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const t = line.split(/\s+/)
      pos.push(Number(t[1]), Number(t[2]), Number(t[3]))
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1)
      for (let k = 1; k + 1 < t.length; k++) idx.push(t[0]!, t[k]!, t[k + 1]!)
    }
  }
  const positions = Float32Array.from(pos), indices = Uint32Array.from(idx)
  const vertexCount = positions.length / 3

  // 每个外部关节的去向：一个函数（顶点位置 → [关节下标, 份额][]）
  // where every external joint goes: a function (vertex position → [joint index, share][])
  type Spread = (x: number, y: number, z: number) => [number, number][]
  const spread: (Spread | null)[] = jf.names.map(() => null)
  const mapped: ExternalWeights['mapped'] = jf.names.map((n) => ({ external: n, rule: 'none', joints: [] }))
  const byName = new Map(jf.names.map((n, i) => [n, i]))
  const compiled = rules.map((r) => ({ r, re: new RegExp(r.match) }))
  const resolve = (i: number, depth: number): Spread | null => {
    if (spread[i]) return spread[i]!
    const name = jf.names[i]!
    let out: Spread | null = null
    const hit = compiled.find((c) => c.re.test(name))
    if (hit) {
      const m = hit.re.exec(name)!
      const S = m[1] === 'l' ? 'L' : m[1] === 'r' ? 'R' : ''
      const n = Number(m[2] ?? 0)
      if (hit.r.to) {
        const fixed: [number, number][] = []
        for (const t of hit.r.to) {
          const id = t.joint.replace('{S}', S)
          const j = index.get(id)
          if (j === undefined) notes.push(`external joint ${name}: rule names "${id}", which is not a joint of this rig`)
          else fixed.push([j, share(t.share, n)])
        }
        if (fixed.length) {
          out = () => fixed
          mapped[i] = { external: name, rule: `shares (${hit.r.match})`, joints: fixed.map(([j, s]) => `${joints[j]!.id}×${Math.round(s * 100) / 100}`) }
        }
      } else if (hit.r.axial) {
        const ax = hit.r.axial
        const chain = ax.rigChain.map((id) => index.get(id)).filter((j): j is number => j !== undefined)
        const k = ax.mhrChain.indexOf(ax.as ?? name)
        const yOf = (nm: string | undefined): number | null => (nm !== undefined && byName.has(nm) ? jf.positions[byName.get(nm)!]![1]! : null)
        const lo = k <= 0 ? -Infinity : (yOf(ax.mhrChain[k]) ?? -Infinity), hi = yOf(ax.mhrChain[k + 1]) ?? Infinity
        // 各节段的中点高度：顶点在某椎骨中部时完全跟它，在椎间盘高度时上下各半
        // mid-heights of the segments: a vertex level with the middle of a vertebra follows it fully, one level with a disc half and half
        const cy = chain.map((j) => joints[j]!.center[1])
        const mid = cy.map((y, q) => (q + 1 < cy.length ? (y + cy[q + 1]!) / 2 : y + 0.05))
        if (chain.length >= 2 && k >= 0) {
          out = (_x, y) => {
            const h = Math.min(hi, Math.max(lo, y))
            if (h <= mid[0]!) return [[chain[0]!, 1]]
            for (let q = 0; q + 1 < mid.length; q++) {
              if (h < mid[q + 1]!) {
                const t = (h - mid[q]!) / (mid[q + 1]! - mid[q]!)
                return [[chain[q]!, 1 - t], [chain[q + 1]!, t]]
              }
            }
            return [[chain[chain.length - 1]!, 1]]
          }
          const owned = chain.filter((_, q) => mid[q]! >= lo - 0.03 && (q === 0 ? -Infinity : mid[q - 1]!) <= hi)
          mapped[i] = { external: name, rule: `by height along the spine (${hit.r.match})`, joints: [joints[owned[0] ?? chain[0]!]!.id, '…', joints[owned[owned.length - 1] ?? chain[0]!]!.id] }
        }
      } else if (hit.r.nearest) {
        const re = new RegExp(hit.r.nearest.replace('{S}', S))
        const cand = joints.map((j, q) => ({ j, q })).filter((c) => re.test(c.j.id))
        if (cand.length) {
          out = (x, y, z) => {
            let best = cand[0]!.q, bd = Infinity
            for (const c of cand) {
              const a = c.j.center, b = c.j.tail
              const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
              const l2 = dx * dx + dy * dy + dz * dz
              let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / l2 : 0
              t = t < 0 ? 0 : t > 1.5 ? 1.5 : t
              const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy, z - a[2] - t * dz)
              if (d < bd) (bd = d), (best = c.q)
            }
            return [[best, 1]]
          }
          mapped[i] = { external: name, rule: `nearest of (${hit.r.nearest.replace('{S}', S)})`, joints: cand.map((c) => c.j.id) }
        }
      }
    }
    if (!out) {
      const a = jf.mapping[i]?.anatomical ?? null
      if (a !== null && index.has(a)) {
        const fixed: [number, number][] = [[index.get(a)!, 1]]
        out = () => fixed
        mapped[i] = { external: name, rule: 'joints.json mapping', joints: [a] }
      } else {
        if (a !== null) notes.push(`external joint ${name}: joints.json maps it to "${a}", which is not a joint of this rig; its parent's joint is used`)
        const p = jf.parents[i]!
        out = p >= 0 && depth < jf.names.length ? resolve(p, depth + 1) : null
        mapped[i] = { external: name, rule: out ? `as its parent ${jf.names[p]}` : 'no counterpart (weight dropped)', joints: out ? mapped[p]!.joints : [] }
      }
    }
    spread[i] = out
    return out
  }
  jf.names.forEach((_, i) => resolve(i, 0))

  const buf = readFileSync(need[0]!)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const records = Math.floor(buf.byteLength / 12)
  const rows: Map<number, number>[] = Array.from({ length: vertexCount }, () => new Map<number, number>())
  let dropped = 0
  for (let r = 0; r < records; r++) {
    const v = dv.getUint32(r * 12, true), j = dv.getUint32(r * 12 + 4, true), w = dv.getFloat32(r * 12 + 8, true)
    if (!(w > 0) || v >= vertexCount) continue
    const f = spread[j]
    if (!f) {
      dropped += w
      continue
    }
    for (const [q, s] of f(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!)) if (s > 0) rows[v]!.set(q, (rows[v]!.get(q) ?? 0) + w * s)
  }
  let empty = 0
  for (const row of rows) {
    let s = 0
    for (const w of row.values()) s += w
    if (s <= 0) empty++
    else for (const [j, w] of row) row.set(j, w / s)
  }
  if (dropped > 0) notes.push(`external weights: total weight ${dropped.toFixed(1)} on joints with no counterpart in this rig was dropped and the rest renormalised`)
  if (empty > 0) notes.push(`external weights: ${empty} vertices of the original surface have no usable weight`)

  let surface: Surface | null = null
  return {
    dir, sourceName: manifest.source?.name ?? '', body: manifest.fittedTo?.body ?? null, vertexCount, rows, mapped, notes,
    transfer(target: Float32Array) {
      surface ??= new Surface({ positions, indices })
      const n = target.length / 3
      const out: Map<number, number>[] = []
      let sum = 0, max = 0
      for (let i = 0; i < n; i++) {
        const p: V3 = [target[i * 3]!, target[i * 3 + 1]!, target[i * 3 + 2]!]
        const c = surface.closestFace(p)
        const row = new Map<number, number>()
        if (c) {
          sum += c.distance
          if (c.distance > max) max = c.distance
          for (let k = 0; k < 3; k++) {
            if (c.bary[k]! <= 0) continue
            for (const [j, w] of rows[c.verts[k]!]!) row.set(j, (row.get(j) ?? 0) + c.bary[k]! * w)
          }
        }
        out.push(row)
      }
      return { rows: out, meanMm: n ? (1000 * sum) / n : 0, maxMm: 1000 * max }
    },
  }
}
