// 绑定：每个部件如何跟随骨架。骨骼刚性跟随一个关节；软组织按组织类型用不同的方法求逐顶点权重。
// Bindings: how every part follows the skeleton. Bones follow one joint rigidly; soft parts get
// per-vertex weights by a method chosen for their tissue.
//
//   rigid       整个部件跟随一个关节 / the whole part follows one joint
//   field       体内距离场 → 紧支撑权重 → 沿网格平滑 / in-body distance field → compact-support weights → smoothing over the mesh
//   attach      肌肉、肌腱、韧带：附着处锁定在所附着的骨上，其余顶点只在附着骨之间的关节链上取权重
//               muscles, tendons, ligaments: attachment sites are locked to their bone, every other vertex takes its weights among the joints on the chain between the attachments
//               肌肉的两端落在一条关节链上时（多数四肢肌），权重不看“最近的骨”，而按顶点沿肌肉（起点 → 止点）的位置给：
//               在肌肉经过每个关节的地方从近端节段过渡到远端节段（见 bindAttach 里的 pathRows）
//               where a muscle's attachments lie on one chain of joints (most limb muscles) the weights do not come from the nearest bone
//               but from the vertex's position along the muscle (origin → insertion): the muscle passes from the proximal to the distal
//               segment where it crosses each joint (see pathRows in bindAttach)
//   centreline  神经：在中心线上取权重并沿线平滑，再按最近的中心线段传给管壁顶点
//               nerves: weights on the centreline, smoothed along it, then handed to tube vertices by their nearest centreline segment
//   wall        空腔器官的腔（id 为 LUMEN_… 的部件，见 tools/pipeline/lumenStage.ts）：每个顶点取壁的表面上离它最近一点的权重，
//               腔就随它的壁运动，不会在某个姿势下跑到器官外面（见 lumenWallIds 和 bindAll 末尾的那一遍）
//               the lumina of the hollow organs (parts with a LUMEN_… id, see tools/pipeline/lumenStage.ts): every vertex takes the weights
//               at the closest point of the wall's surface, so a lumen moves with its wall and cannot leave its organ in a pose
//               (see lumenWallIds and the last pass of bindAll)

import type { MuscleLine, NervePath, Part, Vec3 } from '../../src/anatomy/types.ts'
import type { ExternalRule, ExternalWeights } from './external.ts'
import { type BodyField, weightsFromDistances } from './field.ts'
import { pca } from './fits.ts'
import { Surface } from './geom.ts'
import type { Body } from './io.ts'
import type { BuiltJoint } from './joints.ts'
import type { V3 } from './math.ts'

export interface Policy {
  method: 'rigid' | 'field' | 'attach' | 'centreline'
  beta?: number
  smooth?: number
  allow?: string
  /** 禁止的关节 id（正则）：该部件不得附着或跟随这些关节。 Forbidden joint ids (regular expression): the part must neither attach to nor follow them. */
  deny?: string
}

/**
 * 铰链处的角度混合：在关节中心 radius 以内，“跟随远端一侧”的份额不按距离、而按该点绕屈伸轴的
 * 方位角决定（近端方向 0 → 远端方向 1，屈侧与伸侧正中各 0.5）。这样跨过关节屈侧的血管、神经、
 * 皮肤在对偶四元数混合下绕轴转过一半角度，而不是被远端骨“吞掉”。
 * Angular blending at a hinge: within `radius` of the joint centre the share that follows the distal
 * side is set by the point's angular position about the flexion axis rather than by distance
 * (0 towards the proximal bone, 1 towards the distal bone, 0.5 straight in front of and behind the
 * joint). Vessels, nerves and skin crossing the flexor side then turn through half the angle under
 * dual-quaternion blending instead of being swallowed by the distal bone.
 */
export interface HingeBlend {
  match: string
  /** 米。 Metres. */
  radius: number
  /** 度：方位角小于它完全跟随近端，大于 180° − 它完全跟随远端。 Degrees: below it the point follows the proximal side fully, above 180° minus it the distal side. */
  theta0: number
  /** 近端方向：parent = 指向父关节中心；straight = 远端节段的反向延长线。 Proximal direction: towards the parent joint's centre, or the distal segment prolonged backwards. */
  proximal?: 'parent' | 'straight'
}

/**
 * 权重变陡：在口周把关节 joint（下颌）与 to（颅骨）之间逐渐过渡的份额变成陡的分界，使上唇不跟下颌。
 * 作用区域以 above、below 所指部件（上牙、下牙）的中心为圆心。
 * Weight steepening: around the mouth the gradual split between `joint` (the jaw) and `to` (the skull)
 * is turned into a steep one, so that the upper lip does not follow the jaw. The region is centred on
 * the parts matching `above` and `below` (upper and lower teeth).
 */
export interface WeightCap {
  joint: string
  to: string
  /** 部件英文名的正则。 Regular expressions on part names. */
  above: string
  below: string
  /** 作用半径（米，距 above 与 below 全部部件的中心）；外半圈淡出。 Radius of action (metres, from the centre of all `above` and `below` parts), fading over its outer half. */
  radius: number
  /** [lo, hi]：joint 在 (joint + to) 中的份额 ≤ lo 时全归 to，≥ hi 时全归 joint，其间平滑过渡。 [lo, hi]: where the share of `joint` in (joint + to) is ≤ lo all of it goes to `to`, ≥ hi all to `joint`, blending in between. */
  sharpen: [number, number]
  why?: { zh: string; en: string }
}

/** 胸壁皮肤随肋骨的设置。 Settings for chest skin following the ribs. */
export interface RibFollow {
  /** 肋关节 id 的正则；被转走份额的关节（胸椎）id 的正则。 Regular expressions: the rib joints, and the joints (thoracic vertebrae) whose share is handed over. */
  ribs: string
  from: string
  /** 到肋骨的距离（米）：near 以内全额，far 以外不转。 Distance to the ribs (metres): full effect within `near`, none beyond `far`. */
  near: number
  far: number
  /** 最多转走的份额（0–1）。 The largest share handed over (0–1). */
  share: number
  beta: number
  /** 改过的顶点上沿网格平滑的遍数。 Smoothing passes over the mesh on the vertices that were changed. */
  smooth?: number
  why?: { zh: string; en: string }
}

export interface BindRules {
  defaults: Record<string, Policy>
  rules: (Policy & { match: string })[]
  attachmentExcludes?: AttachmentExclude[]
  hingeBlend?: HingeBlend[]
  /** 自带外部蒙皮权重的皮肤（见 external.ts）：部件的 Part.source 与权重包 manifest 的 source.name 一致时采用。 Skins that come with external weights (see external.ts): used when the part's Part.source equals source.name of the package manifest. */
  externalWeights?: { body: string; dir: string; openDir?: string; ribFollow?: RibFollow; map?: ExternalRule[]; caps?: WeightCap[]; generic?: string; genericWhy?: { zh: string; en: string }; keepInfluence?: string; keepInfluenceWhy?: { zh: string; en: string }; why?: { zh: string; en: string } }[]
}

export interface BoundPart {
  part: string
  method: string
  /** 刚性：关节下标。 Rigid: joint index. */
  joint?: number
  /** 逐顶点：每顶点 4 个关节下标和 4 个权重（和为 255）。 Per vertex: 4 joint indices and 4 weights summing to 255. */
  idx?: Uint16Array
  w?: Uint8Array
}

export interface AttachReport {
  part: string
  name: string
  tissue: string
  /** 知识给出的附着骨数：来自关系 / 来自 Z-Anatomy 斑块。 Attachment bones given by knowledge: from relations / from Z-Anatomy patches. */
  fromRelations: number
  fromPatches: number
  /** 其中网格确实到达的骨数。 How many of them the mesh actually reaches. */
  knowledgeReached: number
  /** 知识说附着、但网格没有到达的骨（mm = 最近距离；via = 经相邻肌腱或按最近点补上的方式）。 Bones knowledge names but the mesh does not reach (mm = closest distance; via = how the gap was bridged, if it was). */
  knowledgeMissed: { bone: string; kind: string; mm: number; via?: string }[]
  /** 网格接触、但知识未列为附着的骨（途经骨）。 Bones the mesh touches that knowledge does not list as attachments (bones it passes). */
  touchedOnly: string[]
  /** 附着所在的关节。 Joints of the attachments. */
  joints: string[]
  /** 两端如何确定。 How the two ends were established. */
  ends: 'knowledge' | 'knowledge+geometry' | 'geometry' | 'none'
  line: boolean
  /** 权重的求法：path = 沿肌肉的位置（各关节处过渡）；nearest = 关节链上最近的骨；field = 距离场。 How the weights were found: path = position along the muscle (a transition at every joint crossed); nearest = nearest bone on the chain of joints; field = the distance field. */
  weights?: 'path' | 'nearest' | 'field'
  /** path 时：各关节处过渡带在肌肉上的位置（毫米，自起点沿中心线）与到关节中心的最近距离。 For `path`: where along the muscle each joint's transition lies (mm from the origin along the centreline) and the closest approach to the joint centre. */
  crossings?: { joint: string; fromMm: number; toMm: number; passMm: number }[]
  /** 作用线两端的来源。 Where the two ends of the line of action come from. */
  lineEnds?: [string, string]
  why?: string
}

export interface BindResult {
  parts: BoundPart[]
  muscles: MuscleLine[]
  attach: AttachReport[]
  /** 各方法的部件数与顶点数。 Parts and vertices per method. */
  byMethod: Record<string, { parts: number; vertices: number; rigid: number }>
  notes: string[]
}

// ── 网格工具 / mesh helpers ───────────────────────────────────────────────────────────────────

export interface Welded {
  /** 去重后的顶点坐标。 Unique vertex positions. */
  pos: Float32Array
  n: number
  /** 原顶点 → 去重顶点。 Original vertex → unique vertex. */
  map: Uint32Array
  adjStart: Uint32Array
  adj: Uint32Array
}

/** 按位置合并顶点（GLB 在法线接缝处拆开了顶点），并建立邻接表。 Welds vertices by position (the GLB splits them at normal seams) and builds adjacency. */
export function weld(positions: Float32Array, indices: Uint32Array): Welded {
  const nv = positions.length / 3
  const map = new Uint32Array(nv)
  const key = new Map<string, number>()
  const pos: number[] = []
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(positions[i * 3]! * 2e5)},${Math.round(positions[i * 3 + 1]! * 2e5)},${Math.round(positions[i * 3 + 2]! * 2e5)}`
    let u = key.get(k)
    if (u === undefined) {
      u = pos.length / 3
      key.set(k, u)
      pos.push(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
    }
    map[i] = u
  }
  const n = pos.length / 3
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  for (let t = 0; t < indices.length; t += 3) {
    const a = map[indices[t]!]!, b = map[indices[t + 1]!]!, c = map[indices[t + 2]!]!
    if (a !== b) sets[a]!.add(b), sets[b]!.add(a)
    if (b !== c) sets[b]!.add(c), sets[c]!.add(b)
    if (a !== c) sets[a]!.add(c), sets[c]!.add(a)
  }
  const adjStart = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i]! + sets[i]!.size
  const adj = new Uint32Array(adjStart[n]!)
  for (let i = 0; i < n; i++) {
    let o = adjStart[i]!
    for (const v of [...sets[i]!].sort((x, y) => x - y)) adj[o++] = v
  }
  return { pos: Float32Array.from(pos), n, map, adjStart, adj }
}

const SKIN_SOURCE_NAME = 'skin-source.u32'

/**
 * 按来源下标定义唯一顶点（不看位置），并建立邻接表。source[i] 相同的顶点是同一个顶点。
 * Unique vertices defined by source index (positions are not consulted), with adjacency. Vertices
 * sharing a source index are one vertex.
 */
export function weldByIndex(positions: Float32Array, indices: Uint32Array, source: Uint32Array): Welded & { source: Uint32Array } {
  const nv = positions.length / 3
  const map = new Uint32Array(nv)
  const first = new Map<number, number>()
  const pos: number[] = [], src: number[] = []
  for (let i = 0; i < nv; i++) {
    let u = first.get(source[i]!)
    if (u === undefined) {
      u = src.length
      first.set(source[i]!, u)
      src.push(source[i]!)
      pos.push(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
    }
    map[i] = u
  }
  const n = src.length
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  for (let t = 0; t < indices.length; t += 3) {
    const a = map[indices[t]!]!, b = map[indices[t + 1]!]!, c = map[indices[t + 2]!]!
    if (a !== b) sets[a]!.add(b), sets[b]!.add(a)
    if (b !== c) sets[b]!.add(c), sets[c]!.add(b)
    if (a !== c) sets[a]!.add(c), sets[c]!.add(a)
  }
  const adjStart = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i]! + sets[i]!.size
  const adj = new Uint32Array(adjStart[n]!)
  for (let i = 0; i < n; i++) {
    let o = adjStart[i]!
    for (const v of [...sets[i]!].sort((x, y) => x - y)) adj[o++] = v
  }
  return { pos: Float32Array.from(pos), n, map, adjStart, adj, source: Uint32Array.from(src) }
}

/** 稠密权重表：n 个顶点 × 调色板中的 m 个关节。 Dense weight table: n vertices × m palette joints. */
interface Dense {
  palette: number[]
  W: Float32Array
}

function densify(rows: Map<number, number>[]): Dense {
  const set = new Set<number>()
  for (const r of rows) for (const j of r.keys()) set.add(j)
  const palette = [...set].sort((a, b) => a - b)
  const col = new Map(palette.map((j, i) => [j, i]))
  const m = palette.length
  const W = new Float32Array(rows.length * m)
  rows.forEach((r, i) => {
    for (const [j, w] of r) W[i * m + col.get(j)!] = w
  })
  return { palette, W }
}

/** 沿网格平滑权重；locked 的顶点保持不变；空行（无权重）由邻居填充。 Smooths weights over the mesh; locked vertices are kept; empty rows are filled from their neighbours. */
function smooth(d: Dense, mesh: Welded, iterations: number, locked?: Uint8Array, lambda = 0.5): void {
  const m = d.palette.length, n = mesh.n
  if (m <= 1) return
  let cur: Float32Array = d.W
  let next: Float32Array = new Float32Array(cur.length)
  const sum = new Float32Array(m)
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const a = mesh.adjStart[i]!, b = mesh.adjStart[i + 1]!
      let own = 0
      for (let k = 0; k < m; k++) own += cur[i * m + k]!
      if ((locked && locked[i]) || a === b) {
        for (let k = 0; k < m; k++) next[i * m + k] = cur[i * m + k]!
        continue
      }
      sum.fill(0)
      let cnt = 0
      for (let e = a; e < b; e++) {
        const v = mesh.adj[e]!
        let s = 0
        for (let k = 0; k < m; k++) s += cur[v * m + k]!
        if (s <= 0) continue
        for (let k = 0; k < m; k++) sum[k] = sum[k]! + cur[v * m + k]!
        cnt++
      }
      const l = own > 0 ? lambda : 1
      for (let k = 0; k < m; k++) next[i * m + k] = (own > 0 ? (1 - l) * cur[i * m + k]! : 0) + (cnt ? (l * sum[k]!) / cnt : own > 0 ? l * cur[i * m + k]! : 0)
    }
    ;[cur, next] = [next, cur]
  }
  if (cur !== d.W) d.W.set(cur)
}

/** 沿网格的边到一组顶点的最短路程（Dijkstra）；到不了的顶点为 Infinity。 Shortest way along the mesh edges to a set of vertices (Dijkstra); Infinity where unreachable. */
export function geodesic(mesh: Welded, seeds: number[]): Float32Array {
  const d = new Float32Array(mesh.n).fill(Infinity)
  // 二叉堆：(距离, 顶点) / binary heap of (distance, vertex)
  const hd: number[] = [], hv: number[] = []
  const push = (dist: number, v: number): void => {
    let i = hd.length
    hd.push(dist)
    hv.push(v)
    while (i > 0) {
      const q = (i - 1) >> 1
      if (hd[q]! <= hd[i]!) break
      ;[hd[q], hd[i]] = [hd[i]!, hd[q]!]
      ;[hv[q], hv[i]] = [hv[i]!, hv[q]!]
      i = q
    }
  }
  const pop = (): [number, number] => {
    const top: [number, number] = [hd[0]!, hv[0]!]
    const ld = hd.pop()!, lv = hv.pop()!
    if (hd.length) {
      hd[0] = ld
      hv[0] = lv
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < hd.length && hd[l]! < hd[m]!) m = l
        if (r < hd.length && hd[r]! < hd[m]!) m = r
        if (m === i) break
        ;[hd[m], hd[i]] = [hd[i]!, hd[m]!]
        ;[hv[m], hv[i]] = [hv[i]!, hv[m]!]
        i = m
      }
    }
    return top
  }
  for (const v of seeds) {
    if (d[v] === 0) continue
    d[v] = 0
    push(0, v)
  }
  while (hd.length) {
    const [dist, v] = pop()
    if (dist > d[v]!) continue
    for (let e = mesh.adjStart[v]!; e < mesh.adjStart[v + 1]!; e++) {
      const w = mesh.adj[e]!
      const nd = dist + Math.hypot(mesh.pos[w * 3]! - mesh.pos[v * 3]!, mesh.pos[w * 3 + 1]! - mesh.pos[v * 3 + 1]!, mesh.pos[w * 3 + 2]! - mesh.pos[v * 3 + 2]!)
      if (nd < d[w]!) {
        d[w] = nd
        push(nd, w)
      }
    }
  }
  return d
}

/** 取最大的 4 个权重并量化为和为 255 的 uint8。 Keeps the 4 largest weights and quantises them to uint8 summing to 255. */
export function quantise(row: ArrayLike<number>, palette: number[], outIdx: Uint16Array, outW: Uint8Array, o: number): void {
  const top: [number, number][] = []
  for (let k = 0; k < palette.length; k++) {
    const w = row[k]!
    if (w > 0) top.push([w, palette[k]!])
  }
  top.sort((a, b) => b[0] - a[0] || a[1] - b[1])
  top.length = Math.min(4, top.length)
  let s = 0
  for (const t of top) s += t[0]
  if (!top.length || s <= 0) {
    outIdx[o] = palette[0] ?? 0
    outW[o] = 255
    for (let k = 1; k < 4; k++) (outIdx[o + k] = 0), (outW[o + k] = 0)
    return
  }
  const q = top.map((t) => Math.floor((t[0] / s) * 255))
  let rem = 255 - q.reduce((a, b) => a + b, 0)
  // 余数按小数部分从大到小分配 / hand the remainder out by largest fractional part
  const frac = top.map((t, k) => [(t[0] / s) * 255 - q[k]!, k] as [number, number]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; rem > 0; k = (k + 1) % frac.length, rem--) q[frac[k]![1]] = q[frac[k]![1]]! + 1
  for (let k = 0; k < 4; k++) {
    const w = k < top.length ? q[k]! : 0
    outIdx[o + k] = w > 0 ? top[k]![1] : 0
    outW[o + k] = w
  }
}

// ── 知识：肌肉的起止点 / knowledge: muscle origins and insertions ─────────────────────────────

/** Z-Anatomy 的附着斑块记录（data/raw/z-anatomy/out/import/attachments.json，可选）。 A Z-Anatomy attachment patch record (optional input). */
export interface AttachmentPatch {
  muscle: string
  side: 'L' | 'R' | 'M' | null
  kind: 'origin' | 'insertion'
  muscleFma: string | null
  muscleFmaUnsided: string | null
  onBone: boolean
  bones: { name: string; side: string | null; fma: string | null; bp3dIds?: string[]; share: number }[]
}

export interface AttachmentExclude {
  muscle: string
  bone: string
  why: { zh: string; en: string }
}

class Knowledge {
  private readonly bySubject = new Map<string, { kind: 'origin' | 'insertion'; object: string }[]>()
  private readonly partsOfConcept = new Map<string, Set<string>>()
  private readonly parentOf = new Map<string, string | null>()
  private readonly patchesByMuscle = new Map<string, AttachmentPatch[]>()
  private readonly partsByFma = new Map<string, string[]>()
  excludedPatches = 0

  constructor(private readonly body: Body, patches: AttachmentPatch[], private readonly excludes: AttachmentExclude[]) {
    for (const r of body.relations) {
      if ((r.kind !== 'origin' && r.kind !== 'insertion') || !r.object) continue
      let l = this.bySubject.get(r.subject)
      if (!l) this.bySubject.set(r.subject, (l = []))
      l.push({ kind: r.kind, object: r.object })
    }
    const add = (c: string, p: string): void => {
      let s = this.partsOfConcept.get(c)
      if (!s) this.partsOfConcept.set(c, (s = new Set()))
      s.add(p)
    }
    for (const p of body.data.parts) {
      add(p.fma, p.id)
      let l = this.partsByFma.get(p.fma)
      if (!l) this.partsByFma.set(p.fma, (l = []))
      l.push(p.id)
    }
    for (const tree of [body.data.trees.isa, body.data.trees.partOf]) {
      const parent = new Map(tree.map((c) => [c.id, c.parent]))
      for (const c of tree) {
        // 部件归入它自己的概念及全部祖先 / a part belongs to its concept and to every ancestor
        for (const pid of c.parts) {
          let cur: string | null = c.id
          for (let guard = 0; cur && guard < 64; guard++) {
            add(cur, pid)
            cur = parent.get(cur) ?? null
          }
        }
      }
    }
    for (const c of body.data.trees.isa) this.parentOf.set(c.id, c.parent)
    for (const pt of patches) {
      if (!pt.onBone) continue
      for (const key of new Set([pt.muscleFma, pt.muscleFmaUnsided && pt.side ? `${pt.muscleFmaUnsided}/${pt.side}` : null])) {
        if (!key) continue
        let l = this.patchesByMuscle.get(key)
        if (!l) this.patchesByMuscle.set(key, (l = []))
        l.push(pt)
      }
    }
  }

  /**
   * 部件的起点骨与止点骨（部件 id）。来源：知识关系（relations.json）加上 Z-Anatomy 附着斑块所在的骨。
   * 斑块的“起点/止点”标签在躯干和颈部肌肉上常与教科书相反，但位置可信：绑定只用位置，标签只决定
   * 作用线哪一端叫起点。落在邻近骨上的错误斑块按 bindings.json 的 attachmentExcludes 剔除。
   * Origin and insertion bones (part ids) of a muscle part. Sources: the knowledge relations plus the
   * bones under Z-Anatomy's attachment patches. The patches' origin/insertion labels are often the
   * reverse of the textbook for trunk and neck muscles but the sites are sound: the binding uses the
   * site only, the label merely decides which end of the line of action is called the origin.
   * Patches that landed on a neighbouring bone are removed by `attachmentExcludes` of bindings.json.
   */
  attachments(part: Part): { origin: Set<string>; insertion: Set<string>; fromRelations: number; fromPatches: number } {
    const origin = new Set<string>(), insertion = new Set<string>()
    let fromRelations = 0, fromPatches = 0
    // 关系可能写在不分侧的上位概念上：沿 is-a 向上两级 / relations may be stated on the unsided parent concept: go up two is-a levels
    const subjects: string[] = [part.fma]
    let cur = this.parentOf.get(part.fma) ?? null
    for (let k = 0; k < 2 && cur; k++) {
      subjects.push(cur)
      cur = this.parentOf.get(cur) ?? null
    }
    const okBone = (pid: string): boolean => {
      const b = this.body.byId.get(pid)
      if (!b || (b.tissue !== 'bone' && b.tissue !== 'cartilage')) return false
      return part.side === 'M' || b.side === 'M' || b.side === part.side
    }
    for (const s of subjects) {
      const rels = this.bySubject.get(s)
      if (!rels) continue
      for (const r of rels) {
        for (const pid of this.partsOfConcept.get(r.object) ?? []) {
          if (!okBone(pid)) continue
          ;(r.kind === 'origin' ? origin : insertion).add(pid)
          fromRelations++
        }
      }
      // 部件自身概念上已有关系时不再向上找 / stop at the first level that states anything
      if (origin.size || insertion.size) break
    }
    const seen = new Set<AttachmentPatch>()
    for (const key of [part.fma, ...subjects.map((s) => `${s}/${part.side}`)]) {
      for (const pt of this.patchesByMuscle.get(key) ?? []) {
        if (seen.has(pt)) continue
        seen.add(pt)
        for (const bn of pt.bones) {
          if (bn.share < 0.25) continue
          if (this.excludes.some((x) => pt.muscle.toLowerCase().includes(x.muscle.toLowerCase()) && bn.name.toLowerCase().includes(x.bone.toLowerCase()))) {
            this.excludedPatches++
            continue
          }
          const ids = new Set<string>([...(bn.fma ? (this.partsByFma.get(bn.fma) ?? []) : []), ...(bn.bp3dIds ?? []).filter((id) => this.body.byId.has(id))])
          for (const pid of ids) {
            if (!okBone(pid)) continue
            const set = pt.kind === 'origin' ? origin : insertion
            if (!origin.has(pid) && !insertion.has(pid)) fromPatches++
            if (!(pt.kind === 'origin' ? insertion : origin).has(pid)) set.add(pid)
          }
        }
      }
    }
    return { origin, insertion, fromRelations, fromPatches }
  }
}

// ── 绑定 / binding ────────────────────────────────────────────────────────────────────────────

export interface BindContext {
  body: Body
  joints: BuiltJoint[]
  field: BodyField
  /** 每个关节的混合半径（米）。 Blend radius per joint, metres. */
  radius: number[]
  rules: BindRules
  /** 已读入的外部蒙皮权重包；byIndexFor 是按下标取权重的皮肤部件 id（没有下标对照时不设）。 External skin-weight packages already loaded; byIndexFor is the skin part bound by index (unset without the sidecar). */
  external?: (ExternalWeights & { byIndexFor?: string })[]
  /** 皮肤的下标对照（没有时为 null）。 The skin's index sidecar (null when absent). */
  skinSource?: Uint32Array | null
  /** Z-Anatomy 附着斑块（没有该文件时为空）。 Z-Anatomy attachment patches (empty when the file is absent). */
  patches?: AttachmentPatch[]
  log?: (msg: string) => void
}

const TOUCH = 0.003
/**
 * 游离端补全：长度不小于 FREE_END_MIN_LENGTH 的肌肉只找到一端的附着时，另一端在 FREE_END_REACH（且不超过肌长的 20%）以内
 * 最近的骨上取一个附着点——它的腱或腱膜不在网格里（腹直肌下端到耻骨、阔筋膜张肌经髂胫束到大腿）。短肌不补：面肌等止于皮肤。
 * Free-end completion: a muscle at least FREE_END_MIN_LENGTH long with an attachment found at one end only gets a site on the
 * nearest bone within FREE_END_REACH (and 20 % of its length) of the other end — its tendon or aponeurosis is not in the mesh
 * (rectus abdominis to the pubis, tensor fasciae latae through the iliotibial tract to the thigh). Short muscles are left alone:
 * facial muscles and their like end in skin.
 */
const FREE_END_MIN_LENGTH = 0.08
const FREE_END_REACH = 0.04
/** 过渡带半宽 = PASS_FACTOR × 肌肉中心线到关节中心的最近距离，限制在 [RAMP_MIN, RAMP_MAX]（米）。 Half-width of a transition = PASS_FACTOR × the closest approach of the muscle's centreline to the joint centre, within [RAMP_MIN, RAMP_MAX] metres. */
const PASS_FACTOR = 1.5
const RAMP_MIN = 0.015
const RAMP_MAX = 0.06
const PATH_SLICES = 24

/** 腔部件：腔这一步（tools/pipeline/lumenStage.ts）给出的部件，id 以 LUMEN_ 开头（女性的带 W_ 前缀）。 A lumen part: one made by the lumen stage (tools/pipeline/lumenStage.ts); its id starts with LUMEN_ (with the W_ prefix on the female body). */
export const isLumenPart = (p: Pick<Part, 'id'>): boolean => /^(W_)?LUMEN_/.test(p.id)

/** 没有同名壁部件的腔（口腔、咽、肛管）以相邻的这些组织为壁。 A lumen with no wall part of its own name (mouth, pharynx, anal canal) takes its neighbours of these tissues as its wall. */
const LUMEN_NEIGHBOUR_TISSUES = new Set<string>(['muscle', 'tendon', 'bone', 'tooth', 'cartilage', 'organ', 'gland'])

/**
 * 腔的壁是哪些部件。按英文名匹配：“Lumen of X”“Cavity of X”的壁是名为 X 或“… part of X”的非腔部件
 * （小肠在数据里是许多名为“Proximal part of jejunum”之类的短段）。没有这样的部件时（Oral cavity proper、Cavity of pharynx、
 * Lumen of anal canal），取它的相邻部件中属于肌、腱、骨、牙、软骨、器官、腺的那些。
 * 返回所有腔的壁合在一起的集合：权重只由顶点的位置决定，相邻两个腔部件共用的那一圈顶点于是得到相同的权重，整条管在姿势下不会裂开。
 * Which parts are the walls of the lumina. Matched by English name: the wall of "Lumen of X" or "Cavity of X" is
 * every non-lumen part named X or "… part of X" (the small intestine is many short pieces named "Proximal part of
 * jejunum" and the like). Where there is none (Oral cavity proper, Cavity of pharynx, Lumen of anal canal) the
 * lumen's adjacent parts that are muscle, tendon, bone, tooth, cartilage, organ or gland are taken.
 * The result is the walls of ALL lumina pooled: the weights then depend on a vertex's position only, so the ring of
 * vertices two neighbouring lumen parts share gets the same weights and the canal does not come apart in a pose.
 */
export function lumenWallIds(parts: readonly Pick<Part, 'id' | 'name' | 'tissue' | 'adjacent'>[]): { pool: string[]; byLumen: Map<string, { walls: string[]; how: 'name' | 'neighbours' | 'none' }> } {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const real = parts.filter((p) => !isLumenPart(p) && p.tissue !== 'space')
  const pool = new Set<string>()
  const byLumen = new Map<string, { walls: string[]; how: 'name' | 'neighbours' | 'none' }>()
  for (const l of parts) {
    if (!isLumenPart(l)) continue
    const organ = /^(?:lumen|cavity) of (.+)$/i.exec(l.name)?.[1]?.toLowerCase()
    let walls = organ ? real.filter((p) => p.name.toLowerCase() === organ || p.name.toLowerCase().endsWith(` part of ${organ}`)).map((p) => p.id) : []
    let how: 'name' | 'neighbours' | 'none' = 'name'
    if (!walls.length) {
      walls = l.adjacent.filter((id) => {
        const q = byId.get(id)
        return !!q && !isLumenPart(q) && LUMEN_NEIGHBOUR_TISSUES.has(q.tissue)
      })
      how = walls.length ? 'neighbours' : 'none'
    }
    byLumen.set(l.id, { walls, how })
    for (const id of walls) pool.add(id)
  }
  return { pool: [...pool].sort(), byLumen }
}

export function bindAll(ctx: BindContext): BindResult {
  const { body, joints, field } = ctx
  const jointIndex = new Map(joints.map((j, i) => [j.def.id, i]))
  const parentIdx = joints.map((j) => (j.def.parent ? jointIndex.get(j.def.parent)! : -1))
  const depth = joints.map((_, i) => {
    let d = 0
    for (let p = parentIdx[i]!; p >= 0; p = parentIdx[p]!) d++
    return d
  })
  const boneJoint = new Map<string, number>()
  joints.forEach((j, i) => j.boneIds.forEach((b) => boneJoint.set(b, i)))
  const radius = (j: number): number => ctx.radius[j]!
  const notes: string[] = []
  const know = new Knowledge(body, ctx.patches ?? [], ctx.rules.attachmentExcludes ?? [])
  const surfaces = new Map<string, Surface>()
  const surf = (id: string): Surface => {
    let s = surfaces.get(id)
    if (!s) surfaces.set(id, (s = new Surface(body.meshes.get(id)!)))
    return s
  }
  const policyOf = (p: Part): Policy & { rule?: boolean } => {
    for (const r of ctx.rules.rules) if (new RegExp(r.match, 'i').test(p.name)) return { ...(ctx.rules.defaults[p.tissue] ?? {}), ...r, rule: true }
    return ctx.rules.defaults[p.tissue] ?? { method: 'field', beta: 0.6, smooth: 6 }
  }
  const allowFn = (allow?: string): ((j: number) => boolean) | undefined => {
    if (!allow) return undefined
    const re = new RegExp(allow)
    const ok = joints.map((j) => re.test(j.def.id))
    return (j) => ok[j]!
  }

  // 铰链角度混合的预处理 / precomputed hinge blends
  const hinges = joints.flatMap((j, i) => {
    const hb = (ctx.rules.hingeBlend ?? []).find((h) => new RegExp(h.match).test(j.def.id))
    const p = parentIdx[i]!
    if (!hb || p < 0) return []
    const axis = j.axes[0]
    const raw: V3 = hb.proximal === 'straight' ? [j.center[0] - j.tail[0], j.center[1] - j.tail[1], j.center[2] - j.tail[2]] : [joints[p]!.center[0] - j.center[0], joints[p]!.center[1] - j.center[1], joints[p]!.center[2] - j.center[2]]
    const k = raw[0] * axis[0] + raw[1] * axis[1] + raw[2] * axis[2]
    const u: V3 = [raw[0] - k * axis[0], raw[1] - k * axis[1], raw[2] - k * axis[2]]
    const ul = Math.hypot(u[0], u[1], u[2])
    if (ul < 1e-6) return []
    const sub = new Set<number>()
    joints.forEach((_, q) => {
      for (let a = q; a >= 0; a = parentIdx[a]!) if (a === i) sub.add(q)
    })
    return [{ joint: i, parent: p, c: j.center, axis, u: [u[0] / ul, u[1] / ul, u[2] / ul] as V3, radius: hb.radius, t0: (hb.theta0 * Math.PI) / 180, sub }]
  })
  /** 对一行权重施加铰链角度混合。 Applies the hinge blends to one row of weights. */
  const hingeResplit = (row: Map<number, number>, x: number, y: number, z: number): void => {
    for (const h of hinges) {
      const dx = x - h.c[0], dy = y - h.c[1], dz = z - h.c[2]
      const r = Math.hypot(dx, dy, dz)
      if (r >= h.radius) continue
      let s = 0
      for (const [j, w] of row) if (h.sub.has(j)) s += w
      const wp = row.get(h.parent) ?? 0
      const m = s + wp
      if (m < 0.05) continue
      // 垂直于轴的平面内，相对近端方向的方位角 / angle from the proximal direction in the plane perpendicular to the axis
      const k = dx * h.axis[0] + dy * h.axis[1] + dz * h.axis[2]
      const px = dx - k * h.axis[0], py = dy - k * h.axis[1], pz = dz - k * h.axis[2]
      const pl = Math.hypot(px, py, pz)
      if (pl < 0.002) continue
      const th = Math.acos(Math.max(-1, Math.min(1, (px * h.u[0] + py * h.u[1] + pz * h.u[2]) / pl)))
      let f = (th - h.t0) / (Math.PI - 2 * h.t0)
      f = f < 0 ? 0 : f > 1 ? 1 : f
      f = f * f * (3 - 2 * f)
      // 区域内圈完全按角度，向外圈过渡回按距离；离轴很近时方位角不可靠，也淡出
      // fully angular in the inner half of the zone, fading back to distance-based outside; also faded close to the axis where the angle is unreliable
      let zf = (r - h.radius / 2) / (h.radius / 2)
      zf = zf < 0 ? 0 : zf
      const zone = (1 - zf * zf * (3 - 2 * zf)) * Math.min(1, pl / 0.006)
      const sNew = m * ((s / m) * (1 - zone) + f * zone)
      if (s > 1e-6) {
        const g = sNew / s
        for (const [j, w] of row) if (h.sub.has(j)) row.set(j, w * g)
      } else if (sNew > 0) row.set(h.joint, sNew)
      const pNew = m - sNew
      if (pNew > 1e-6) row.set(h.parent, pNew)
      else row.delete(h.parent)
    }
  }

  const results = new Map<string, BoundPart>()
  /** 部件的主要关节（按权重总和，≥ 15%）。 Main joints of a bound part (by total weight, ≥ 15 %). */
  const mainJoints = new Map<string, number[]>()
  const muscles: MuscleLine[] = []
  const attach: AttachReport[] = []
  const tmp = new Map<number, number>()

  const finish = (p: Part, method: string, mesh: Welded, d: Dense, nv: number, forceRigid = false): void => {
    const m = d.palette.length
    // 统计各关节的总权重 / total weight per joint
    const tot = new Float64Array(m)
    for (let i = 0; i < mesh.n; i++) for (let k = 0; k < m; k++) tot[k] = tot[k]! + d.W[i * m + k]!
    const all = tot.reduce((a, b) => a + b, 0)
    const order = [...tot.keys()].sort((a, b) => tot[b]! - tot[a]! || a - b)
    mainJoints.set(p.id, order.filter((k) => tot[k]! >= 0.15 * all).map((k) => d.palette[k]!))
    if (forceRigid || m === 1 || (all > 0 && tot[order[0]!]! >= 0.9995 * all)) {
      results.set(p.id, { part: p.id, method, joint: d.palette[order[0] ?? 0] ?? 0 })
      return
    }
    const idx = new Uint16Array(nv * 4), w = new Uint8Array(nv * 4)
    let single = true
    for (let i = 0; i < nv; i++) {
      const u = mesh.map[i]!
      quantise(d.W.subarray(u * m, u * m + m), d.palette, idx, w, i * 4)
      if (w[i * 4] !== 255 || idx[i * 4] !== idx[0]) single = false
    }
    if (single) results.set(p.id, { part: p.id, method, joint: idx[0]! })
    else results.set(p.id, { part: p.id, method, idx, w })
  }

  /** 距离场权重：每个去重顶点一行。 Field weights: one row per unique vertex. */
  const fieldRows = (mesh: Welded, beta: number, allow?: (j: number) => boolean): Map<number, number>[] => {
    const rows: Map<number, number>[] = []
    for (let i = 0; i < mesh.n; i++) {
      const p: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
      const c = field.query(p, allow)
      const row = new Map<number, number>()
      weightsFromDistances(c, beta, radius, tmp)
      for (const [j, w] of tmp) row.set(j, w)
      if (!allow) hingeResplit(row, p[0], p[1], p[2])
      rows.push(row)
    }
    return rows
  }
  /** 整个部件都没有候选关节时：在允许的关节中取欧氏最近。 When nothing is in reach of the whole part: Euclidean nearest among the allowed joints. */
  const euclidRows = (mesh: Welded, beta: number, list: number[]): Map<number, number>[] => {
    const rows: Map<number, number>[] = []
    for (let i = 0; i < mesh.n; i++) {
      const p: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
      const row = new Map<number, number>()
      weightsFromDistances(field.euclid(p, list), beta, radius, tmp)
      for (const [j, w] of tmp) row.set(j, w)
      rows.push(row)
    }
    return rows
  }
  const allJoints = joints.map((_, i) => i).filter((i) => joints[i]!.boneIds.length > 0)

  const bindField = (p: Part, pol: Policy, method = 'field'): void => {
    const raw = body.meshes.get(p.id)!
    const mesh = weld(raw.positions, raw.indices)
    let allow = allowFn(pol.allow)
    if (pol.deny) {
      const re = new RegExp(pol.deny), inner = allow
      allow = (j) => !re.test(joints[j]!.def.id) && (!inner || inner(j))
    }
    let rows = fieldRows(mesh, pol.beta ?? 0.6, allow)
    if (rows.every((r) => r.size === 0)) {
      rows = euclidRows(mesh, pol.beta ?? 0.6, allow ? allJoints.filter(allow) : allJoints)
      notes.push(`${p.id} "${p.name}": outside the reach of the distance field; bound by straight-line distance`)
    }
    const d = densify(rows)
    smooth(d, mesh, pol.method === 'rigid' ? 0 : (pol.smooth ?? 6))
    finish(p, pol.method === 'rigid' ? 'rigid' : method, mesh, d, raw.positions.length / 3, pol.method === 'rigid')
  }

  const bindCentreline = (p: Part, pol: Policy, path: NervePath): void => {
    const raw = body.meshes.get(p.id)!
    const mesh = weld(raw.positions, raw.indices)
    const beta = pol.beta ?? 0.6
    // 每条分支：各点取权重，沿线平滑 / per branch: weights at the points, smoothed along the line
    const segs: { a: V3; b: V3; wa: Map<number, number>; wb: Map<number, number> }[] = []
    for (const br of path.branches) {
      const n = br.points.length / 3
      if (n === 0) continue
      const rows: Map<number, number>[] = []
      for (let i = 0; i < n; i++) {
        const c = field.query([br.points[i * 3]!, br.points[i * 3 + 1]!, br.points[i * 3 + 2]!])
        const row = new Map<number, number>()
        weightsFromDistances(c, beta, radius, tmp)
        for (const [j, w] of tmp) row.set(j, w)
        hingeResplit(row, br.points[i * 3]!, br.points[i * 3 + 1]!, br.points[i * 3 + 2]!)
        rows.push(row)
      }
      const d = densify(rows)
      const m = d.palette.length
      // 折线上的 1-2-1 平滑，按弧长约 1.5 cm / 1-2-1 smoothing along the polyline, about 1.5 cm of arc length
      let len = 0
      for (let i = 1; i < n; i++) len += Math.hypot(br.points[i * 3]! - br.points[i * 3 - 3]!, br.points[i * 3 + 1]! - br.points[i * 3 - 2]!, br.points[i * 3 + 2]! - br.points[i * 3 - 1]!)
      const stepLen = n > 1 ? len / (n - 1) : 1
      const its = Math.min(60, Math.max(2, Math.round((0.015 / Math.max(1e-4, stepLen)) ** 2)))
      let cur: Float32Array = d.W, nxt: Float32Array = new Float32Array(cur.length)
      for (let it = 0; it < its && m > 1; it++) {
        for (let i = 0; i < n; i++) {
          const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
          for (let k = 0; k < m; k++) nxt[i * m + k] = 0.25 * cur[a * m + k]! + 0.5 * cur[i * m + k]! + 0.25 * cur[b * m + k]!
        }
        ;[cur, nxt] = [nxt, cur]
      }
      const rowOf = (i: number): Map<number, number> => {
        const r = new Map<number, number>()
        for (let k = 0; k < m; k++) if (cur[i * m + k]! > 1e-4) r.set(d.palette[k]!, cur[i * m + k]!)
        return r
      }
      const maps = Array.from({ length: n }, (_, i) => rowOf(i))
      const P = (i: number): V3 => [br.points[i * 3]!, br.points[i * 3 + 1]!, br.points[i * 3 + 2]!]
      if (n === 1) segs.push({ a: P(0), b: P(0), wa: maps[0]!, wb: maps[0]! })
      for (let i = 0; i + 1 < n; i++) segs.push({ a: P(i), b: P(i + 1), wa: maps[i]!, wb: maps[i + 1]! })
    }
    if (!segs.length) return bindField(p, { ...pol, method: 'field' })
    // 管壁顶点：投影到最近的中心线段，按参数线性插值 / tube vertices: project on the nearest centreline segment and interpolate
    const rows: Map<number, number>[] = []
    for (let i = 0; i < mesh.n; i++) {
      const x = mesh.pos[i * 3]!, y = mesh.pos[i * 3 + 1]!, z = mesh.pos[i * 3 + 2]!
      let best = Infinity, bs = segs[0]!, bt = 0
      for (const s of segs) {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], dz = s.b[2] - s.a[2]
        const l2 = dx * dx + dy * dy + dz * dz
        let t = l2 > 0 ? ((x - s.a[0]) * dx + (y - s.a[1]) * dy + (z - s.a[2]) * dz) / l2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const d2 = (x - s.a[0] - t * dx) ** 2 + (y - s.a[1] - t * dy) ** 2 + (z - s.a[2] - t * dz) ** 2
        if (d2 < best) (best = d2), (bs = s), (bt = t)
      }
      const row = new Map<number, number>()
      for (const [j, w] of bs.wa) row.set(j, (1 - bt) * w)
      for (const [j, w] of bs.wb) row.set(j, (row.get(j) ?? 0) + bt * w)
      rows.push(row)
    }
    const d = densify(rows)
    smooth(d, mesh, 2)
    finish(p, 'centreline', mesh, d, raw.positions.length / 3)
  }

  /** 关节树上连接一组关节的最小子树。 The minimal subtree of the joint tree spanning a set of joints. */
  const spanning = (set: number[]): Set<number> => {
    const out = new Set<number>(set)
    if (set.length < 2) return out
    const chain = (j: number): number[] => {
      const c = [j]
      for (let p = parentIdx[j]!; p >= 0; p = parentIdx[p]!) c.push(p)
      return c
    }
    const first = chain(set[0]!)
    for (let k = 1; k < set.length; k++) {
      const other = chain(set[k]!)
      const pos = new Map(other.map((j, i) => [j, i]))
      // 最近公共祖先 / lowest common ancestor
      const ai = first.findIndex((j) => pos.has(j))
      if (ai < 0) continue
      for (let i = 0; i <= ai; i++) out.add(first[i]!)
      for (let i = 0; i <= pos.get(first[ai]!)!; i++) out.add(other[i]!)
    }
    return out
  }

  const jointsOfBone = (b: string): number[] => (boneJoint.has(b) ? [boneJoint.get(b)!] : (mainJoints.get(b) ?? []))
  interface Site {
    bone: string
    kind: 'origin' | 'insertion' | 'end'
    /** 本部件上贴附该骨的顶点（经肌腱或按最近点补上的附着为空）。 Own vertices attached to the bone (empty for a site bridged by a tendon or by closest point). */
    verts: number[]
    point: V3
    how: string
  }
  /** 肌腱部件在各刚性骨上的附着点（缓存）。 Attachment points of a tendon part on rigid bones (cached). */
  const tendonCache = new Map<string, { bone: string; point: V3 }[]>()
  const tendonSites = (tid: string): { bone: string; point: V3 }[] => {
    let out = tendonCache.get(tid)
    if (out) return out
    out = []
    const t = body.byId.get(tid)!
    const pos = body.meshes.get(tid)!.positions
    for (const b of [...t.adjacent].sort()) {
      if (!boneJoint.has(b)) continue
      const sb = surf(b)
      const c: V3 = [0, 0, 0]
      let n = 0
      for (let i = 0; i < pos.length; i += 3) {
        if (sb.distance(pos[i]!, pos[i + 1]!, pos[i + 2]!, TOUCH) > TOUCH) continue
        ;(c[0] += pos[i]!), (c[1] += pos[i + 1]!), (c[2] += pos[i + 2]!)
        n++
      }
      if (n >= 3) out.push({ bone: b, point: [c[0] / n, c[1] / n, c[2] / n] })
    }
    tendonCache.set(tid, out)
    return out
  }

  const bindAttach = (p: Part, pol: Policy): void => {
    const raw = body.meshes.get(p.id)!
    const mesh = weld(raw.positions, raw.indices)
    const nU = mesh.n
    const beta = pol.beta ?? 0.5
    const isMuscle = p.tissue === 'muscle'
    const K = isMuscle ? know.attachments(p) : { origin: new Set<string>(), insertion: new Set<string>(), fromRelations: 0, fromPatches: 0 }
    const rep: AttachReport = { part: p.id, name: p.name, tissue: p.tissue, fromRelations: K.fromRelations, fromPatches: K.fromPatches, knowledgeReached: 0, knowledgeMissed: [], touchedOnly: [], joints: [], ends: 'none', line: false }
    attach.push(rep)
    const isBoneLike = (id: string): boolean => {
      const b = body.byId.get(id)
      return !!b && (boneJoint.has(id) || ((b.tissue === 'bone' || b.tissue === 'cartilage') && mainJoints.has(id)))
    }
    // 候选骨：邻接表中的骨与软骨，加上知识给出的骨 / candidate bones: adjacent bones and cartilages plus the knowledge bones
    const deny = pol.deny ? new RegExp(pol.deny) : null
    const denied = (b: string): boolean => !!deny && jointsOfBone(b).some((j) => deny.test(joints[j]!.def.id))
    const cand = new Set<string>()
    for (const a of p.adjacent) if (isBoneLike(a) && !denied(a)) cand.add(a)
    for (const b of [...K.origin, ...K.insertion]) if (isBoneLike(b) && !denied(b)) cand.add(b)
    // 每块候选骨：各顶点到骨面的距离 / per candidate bone: distance of every vertex to its surface
    const dist = new Map<string, Float32Array>()
    const minD = new Map<string, number>()
    const minAt = new Map<string, number>()
    for (const b of [...cand].sort()) {
      const sb = surf(b)
      const far = K.origin.has(b) || K.insertion.has(b) ? 0.08 : 0.02
      const d = new Float32Array(nU)
      let mn = Infinity, at = 0
      for (let i = 0; i < nU; i++) {
        const v = sb.distance(mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!, far)
        d[i] = v
        if (v < mn) (mn = v), (at = i)
      }
      dist.set(b, d)
      minD.set(b, mn)
      minAt.set(b, at)
    }
    const touching = (b: string, tol: number): number[] => {
      const d = dist.get(b)!
      const out: number[] = []
      for (let i = 0; i < nU; i++) if (d[i]! <= tol) out.push(i)
      return out
    }
    const centroidOf = (verts: number[]): V3 => {
      const c: V3 = [0, 0, 0]
      for (const i of verts) (c[0] += mesh.pos[i * 3]!), (c[1] += mesh.pos[i * 3 + 1]!), (c[2] += mesh.pos[i * 3 + 2]!)
      return [c[0] / verts.length, c[1] / verts.length, c[2] / verts.length]
    }
    const sites = new Map<string, Site>()
    /**
     * 网格没到骨面时的附着点：从肌肉末端沿主轴向外延长（最多 8 cm），取延长线离骨面最近处在骨面上的最近点。
     * 直接取“离末端最近的骨面点”会偏向关节一侧（肱二头肌止点会落在桡骨头而不是桡骨粗隆）。axisOf 在主轴算出之后才可用。
     * The attachment point where the mesh stops short of the bone: the muscle's end is prolonged outwards along its principal
     * axis (by at most 8 cm) and the point of the bone nearest to where that line comes closest is taken. The bone point nearest
     * to the end itself is biased towards the joint (the biceps would insert on the radial head, not the tuberosity).
     */
    const bridgePoint = (b: string, i: number, axisOf: { dir: V3; t: (q: V3) => number; tMin: number; tMax: number } | null): V3 | null => {
      const sb = surf(b)
      const end: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
      const direct = sb.closest(end)
      if (!axisOf || !direct) return direct ? direct.point : null
      const ti = axisOf.t(end), sp = Math.max(1e-6, axisOf.tMax - axisOf.tMin)
      const high = ti > (axisOf.tMin + axisOf.tMax) / 2
      const c: V3 = [0, 0, 0]
      let n = 0
      for (let v = 0; v < nU; v++) {
        const q: V3 = [mesh.pos[v * 3]!, mesh.pos[v * 3 + 1]!, mesh.pos[v * 3 + 2]!]
        if ((high ? axisOf.tMax - axisOf.t(q) : axisOf.t(q) - axisOf.tMin) / sp > 0.12) continue
        ;(c[0] += q[0]), (c[1] += q[1]), (c[2] += q[2])
        n++
      }
      if (!n) return direct.point
      const sg = high ? 1 : -1
      let best = Infinity, bq: V3 | null = null
      for (let t = 0; t <= 0.0801; t += 0.004) {
        const q: V3 = [c[0] / n + sg * axisOf.dir[0] * t, c[1] / n + sg * axisOf.dir[1] * t, c[2] / n + sg * axisOf.dir[2] * t]
        const dd = sb.distance(q[0], q[1], q[2], 0.15)
        if (dd < best - 1e-5) (best = dd), (bq = q)
      }
      const cp = bq ? sb.closest(bq) : null
      return cp ? cp.point : direct.point
    }
    const tendons = isMuscle ? [...p.adjacent].filter((a) => body.byId.get(a)?.tissue === 'tendon').sort() : []

    // 主轴 / the principal axis
    const pts: V3[] = []
    for (let i = 0; i < nU; i++) pts.push([mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!])
    const pc = pca(pts)
    const tOf = (q: V3): number => (q[0] - pc.center[0]) * pc.axes[0][0] + (q[1] - pc.center[1]) * pc.axes[0][1] + (q[2] - pc.center[2]) * pc.axes[0][2]
    const tAx = pts.map(tOf)
    let tMin = Infinity, tMax = -Infinity
    for (const t of tAx) (tMin = Math.min(tMin, t)), (tMax = Math.max(tMax, t))
    const span = Math.max(1e-6, tMax - tMin)
    const axisOf = { dir: pc.axes[0] as V3, t: tOf, tMin, tMax }

    // 1. 知识给出的附着骨 / attachment bones named by knowledge
    for (const [set, kind] of [[K.origin, 'origin'], [K.insertion, 'insertion']] as const) {
      for (const b of [...set].sort()) {
        if (!cand.has(b) || sites.has(b)) continue
        const mn = minD.get(b) ?? Infinity
        const name = body.byId.get(b)!.name
        if (mn <= 0.008) {
          // 网格离骨面可能有一两毫米的空隙：取“最近距离 + 2 mm”以内的顶点
          // the mesh may stop a millimetre or two short of the bone: take the vertices within closest approach + 2 mm
          const verts = touching(b, Math.max(TOUCH, mn + 0.002))
          sites.set(b, { bone: b, kind, verts, point: centroidOf(verts), how: 'knowledge, mesh on bone' })
          rep.knowledgeReached++
          continue
        }
        // 没到达：先看相邻的肌腱部件是否附着在这块骨上（腓肠肌 → 跟腱 → 跟骨）
        // not reached: does an adjacent tendon part attach to this bone (gastrocnemius → calcaneal tendon → calcaneus)?
        const viaTendon = boneJoint.has(b) ? tendons.flatMap((t) => tendonSites(t).filter((x) => x.bone === b).map((x) => ({ ...x, t })))[0] : undefined
        if (viaTendon) {
          sites.set(b, { bone: b, kind, verts: [], point: viaTendon.point, how: `knowledge, through ${body.byId.get(viaTendon.t)!.name}` })
          rep.knowledgeMissed.push({ bone: name, kind, mm: Number.isFinite(mn) ? Math.round(mn * 1000) : -1, via: body.byId.get(viaTendon.t)!.name })
        } else if (boneJoint.has(b) && mn <= 0.06) {
          // 网格在骨前 6 cm 以内就结束了（腱被并入别的部件）：在骨面上取离肌肉末端最近的点
          // the mesh ends within 6 cm of the bone (its tendon belongs to another part): take the point of the bone nearest to the muscle's end
          sites.set(b, { bone: b, kind, verts: [], point: bridgePoint(b, minAt.get(b)!, axisOf)!, how: `knowledge, mesh ends ${Math.round(mn * 1000)} mm short of the bone` })
          rep.knowledgeMissed.push({ bone: name, kind, mm: Math.round(mn * 1000), via: 'closest point on the bone' })
        } else rep.knowledgeMissed.push({ bone: name, kind, mm: Number.isFinite(mn) ? Math.round(mn * 1000) : -1 })
      }
    }
    const haveK = sites.size > 0
    const kinds = new Set([...sites.values()].map((x) => x.kind))
    const kJoints = new Set<number>()
    for (const b of sites.keys()) for (const j of jointsOfBone(b)) kJoints.add(j)

    // 2. 几何补充 / completion by geometry
    const needGeometry = !haveK || kJoints.size < 2 || !(kinds.has('origin') && kinds.has('insertion'))
    if (needGeometry) {
      for (const b of [...cand].sort()) {
        if (sites.has(b)) continue
        const verts = touching(b, TOUCH)
        if (verts.length < 3) continue
        if (haveK && isMuscle) {
          // 知识只给出一端：另一端只在主轴两端各 15% 范围内找，以免把途经的骨当成附着
          // knowledge gives one end only: look for the other within the outer 15 % at either end of the principal axis, so that a bone merely passed is not taken for an attachment
          const atEnd = verts.filter((i) => (tAx[i]! - tMin) / span < 0.15 || (tMax - tAx[i]!) / span < 0.15)
          if (atEnd.length < 3) continue
          sites.set(b, { bone: b, kind: 'end', verts: atEnd, point: centroidOf(atEnd), how: 'geometry, end of the muscle on bone' })
        } else sites.set(b, { bone: b, kind: 'end', verts, point: centroidOf(verts), how: 'geometry, mesh on bone' })
      }
      // 仍然只有一个关节：经相邻肌腱找另一端（比目鱼肌 → 跟腱）
      // still one joint only: look for the other end through an adjacent tendon (soleus → calcaneal tendon)
      const js = new Set<number>()
      for (const b of sites.keys()) for (const j of jointsOfBone(b)) js.add(j)
      if (isMuscle && js.size < 2) {
        for (const t of tendons) {
          for (const x of tendonSites(t)) {
            if (sites.has(x.bone) || js.has(boneJoint.get(x.bone)!)) continue
            sites.set(x.bone, { bone: x.bone, kind: 'end', verts: [], point: x.point, how: `geometry, through ${body.byId.get(t)!.name}` })
          }
        }
      }
    }
    // 2b. 游离端补全（见 FREE_END_MIN_LENGTH）/ free-end completion (see FREE_END_MIN_LENGTH)
    // 条件：某一端 25% 的范围内没有任何附着，且知识没有点名一块网格够不着的骨（那样最近的骨就不是它的附着）
    // condition: no attachment at all within 25 % of the length from one end, and knowledge names no bone the mesh fails to reach (the nearest bone would then not be its attachment)
    if (isMuscle && span >= FREE_END_MIN_LENGTH && !rep.knowledgeMissed.some((m) => !m.via)) {
      const js = new Set<number>()
      for (const b of sites.keys()) for (const j of jointsOfBone(b)) js.add(j)
      const lowFree = ![...sites.values()].some((st) => (tOf(st.point) - tMin) / span < 0.25 || st.verts.some((i) => (tAx[i]! - tMin) / span < 0.25))
      const highFree = ![...sites.values()].some((st) => (tMax - tOf(st.point)) / span < 0.25 || st.verts.some((i) => (tMax - tAx[i]!) / span < 0.25))
      if (lowFree || highFree) {
        const reach = Math.min(FREE_END_REACH, 0.2 * span)
        const tryEnd = (high: boolean): void => {
          const ev: number[] = []
          for (let i = 0; i < nU; i++) if ((high ? tMax - tAx[i]! : tAx[i]! - tMin) / span < 0.12) ev.push(i)
          if (!ev.length) return
          const c = centroidOf(ev)
          let best: { bone: string; d: number; at: number } | null = null
          for (const b of [...boneJoint.keys()].sort()) {
            if (sites.has(b) || js.has(boneJoint.get(b)!) || denied(b)) continue
            const bp = body.byId.get(b)
            if (!bp || !(p.side === 'M' || bp.side === 'M' || bp.side === p.side)) continue
            const sb = surf(b)
            if (sb.boxDistance(c[0], c[1], c[2]) > reach + 0.12 * span) continue
            let mn: number = best ? (best as { d: number }).d : reach, at = -1
            for (const i of ev) {
              const dd = sb.distance(mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!, mn)
              if (dd < mn) (mn = dd), (at = i)
            }
            if (at >= 0) best = { bone: b, d: mn, at }
          }
          if (!best) return
          const cp = bridgePoint(best.bone, best.at, axisOf)
          if (!cp) return
          sites.set(best.bone, { bone: best.bone, kind: 'end', verts: [], point: cp, how: `geometry, free end of the muscle ${Math.round(best.d * 1000)} mm from the bone` })
        }
        if (lowFree) tryEnd(false)
        if (highFree) tryEnd(true)
      }
    }
    const geo = [...sites.values()].some((x) => x.kind === 'end')
    rep.ends = haveK ? (geo ? 'knowledge+geometry' : 'knowledge') : sites.size ? 'geometry' : 'none'
    for (const b of [...cand].sort()) if (!sites.has(b) && (minD.get(b) ?? 1) <= TOUCH && touching(b, TOUCH).length >= 5) rep.touchedOnly.push(body.byId.get(b)!.name)

    const attJoints = new Set<number>()
    for (const b of sites.keys()) for (const j of jointsOfBone(b)) attJoints.add(j)
    rep.joints = [...attJoints].sort((a, b) => a - b).map((j) => joints[j]!.def.id)
    if (attJoints.size < 2) {
      // 只附着在一个关节的骨上（或没有找到附着）：按一般软组织处理，但锁定附着处
      // attached to the bones of one joint only (or no attachment found): treated as generic soft tissue, attachment sites locked
      const rows = fieldRows(mesh, beta)
      const locked = new Uint8Array(nU)
      for (const [b, st] of sites) {
        if (!boneJoint.has(b)) continue
        for (const i of st.verts) (rows[i] = new Map([[boneJoint.get(b)!, 1]])), (locked[i] = 1)
      }
      if (rows.every((r) => r.size === 0)) euclidRows(mesh, beta, allJoints).forEach((r, i) => (rows[i] = r))
      const d = densify(rows)
      smooth(d, mesh, pol.smooth ?? 3, locked)
      finish(p, 'attach→field', mesh, d, raw.positions.length / 3)
      rep.weights = 'field'
      rep.why = attJoints.size === 1 ? 'all attachments on one joint' : 'no attachment to bone found'
      return
    }
    // 允许的关节：附着关节之间的关节链，加上网格接触到的、与链相邻的关节（如髌骨）
    // allowed joints: the chain between the attachment joints, plus joints next to the chain whose bone the mesh touches (e.g. the patella)
    const allowed = spanning([...attJoints])
    for (const b of cand) {
      if (!boneJoint.has(b) || (minD.get(b) ?? 1) > TOUCH) continue
      const j = boneJoint.get(b)!
      if (allowed.has(j)) continue
      const par = parentIdx[j]!
      if ((par >= 0 && allowed.has(par)) || [...allowed].some((a) => parentIdx[a] === j)) if (touching(b, TOUCH).length >= 5) allowed.add(j)
    }
    const list = [...allowed].filter((j) => joints[j]!.boneIds.length > 0).sort((a, b) => a - b)

    // 肌肉作用线：起点侧与止点侧各取贴附面积最大的那块刚性骨；标签不全时取沿主轴相距最远的两处
    // line of action: on the origin and on the insertion side the rigid bone with the largest attached patch; with incomplete labels the two sites farthest apart along the principal axis
    const rigid = [...sites.values()].filter((x) => boneJoint.has(x.bone)).map((x) => ({ ...x, joint: boneJoint.get(x.bone)!, size: Math.max(1, x.verts.length), t: tOf(x.point) }))
    type RS = (typeof rigid)[number]
    const largest = (c: RS[]): RS | undefined => [...c].sort((a, b) => b.size - a.size || (a.bone < b.bone ? -1 : 1))[0]
    const farthest = (c: RS[], from: RS): RS | undefined => [...c].filter((x) => x.joint !== from.joint).sort((a, b) => Math.abs(b.t - from.t) - Math.abs(a.t - from.t) || (a.bone < b.bone ? -1 : 1))[0]
    let o = isMuscle ? largest(rigid.filter((x) => x.kind === 'origin')) : undefined
    let ins = isMuscle ? largest(rigid.filter((x) => x.kind === 'insertion' && x.joint !== o?.joint)) : undefined
    if (isMuscle) {
      if (o && !ins) ins = farthest(rigid, o)
      else if (!o && ins) o = farthest(rigid, ins)
      else if (!o && !ins) {
        let best = -1
        for (const a of rigid) {
          for (const b of rigid) {
            if (a.joint === b.joint || Math.abs(a.t - b.t) <= best) continue
            best = Math.abs(a.t - b.t)
            o = a
            ins = b
          }
        }
        // 靠近骨架根部的一端作起点 / the end nearer the root of the skeleton is called the origin
        if (o && ins && (depth[o.joint]! > depth[ins.joint]! || (depth[o.joint] === depth[ins.joint] && o.bone > ins.bone))) [o, ins] = [ins, o]
      }
    }

    /**
     * 沿肌肉的位置定权重。条件：作用线两端已定，且全部附着关节（以及允许的关节）都在两端之间的那条关节链上。
     *   1. 位置：u = dO / (dO + dI)，dO、dI 是沿网格（边的图）到起点处、止点处顶点的最短路程；网格不连通时退回到
     *      起点 → 止点直线上的投影。按 u 切成 PATH_SLICES 片，各片质心连成中心线（网格没到骨面的一端延长到附着点），
     *      每个顶点得到沿中心线的弧长 s。这样绕过踝、腕的肌腱也按它自己的走向编号，而不是按直线。
     *   2. 每个关节一条过渡带：中心取中心线离关节中心最近处 s_b，半宽 PASS_FACTOR × 最近距离（限 RAMP_MIN…RAMP_MAX），
     *      并裁剪到游离段内（近端一侧附着区之后、远端一侧附着区之前）。绕节段长轴旋转的关节（桡尺关节）没有“经过处”：
     *      过渡带放在肌肉离远端一侧的骨比离近端一侧的骨更近的地方。没有自由度的关节不设过渡带。
     *   3. 顶点依次越过各过渡带，从链上的一个节段换到下一个。同一横截面上的顶点权重相同，肌肉不会被斜着剪开。
     * 不再做铰链角度混合：过渡带本身就在关节处。
     * Weights from the position along the muscle. Condition: both ends of the line of action are known and every attachment
     * joint (and every allowed joint) lies on the chain of joints between them.
     *   1. Position: u = dO / (dO + dI), with dO and dI the shortest way over the mesh (its edge graph) to the vertices at the
     *      origin and at the insertion; for a mesh in several pieces, the projection on the straight line origin → insertion
     *      instead. The mesh is cut into PATH_SLICES slices by u and the slice centroids form a centreline (prolonged to the
     *      attachment point at an end where the mesh stops short of the bone); every vertex gets its arc length s along it.
     *      A tendon turning round the ankle or the wrist is thus numbered along its own course, not along a straight line.
     *   2. One transition per joint, centred where the centreline comes closest to the joint centre, s_b, with half-width
     *      PASS_FACTOR × that distance (within RAMP_MIN…RAMP_MAX) and clipped to the free span (after the attachment area on
     *      the proximal side, before the one on the distal side). A joint turning about the long axis of its segment (the
     *      radioulnar joint) has no place of crossing: its transition lies where the muscle is nearer to the bones of the distal
     *      side than to those of the proximal side. A joint without degrees of freedom gets no transition.
     *   3. A vertex moves from one segment of the chain to the next as it passes each transition. Vertices of one cross-section
     *      get the same weights, so the muscle is not sheared obliquely.
     * No hinge blend is applied on top: the transition already sits at the joint.
     */
    const pathRows = (): Map<number, number>[] | null => {
      if (!isMuscle || !o || !ins || o.joint === ins.joint) return null
      // 关节树上 o.joint → ins.joint 的路径，及相邻两节点之间的关节 / the tree path o.joint → ins.joint and the joint between consecutive nodes
      const up = [o.joint]
      for (let q = parentIdx[o.joint]!; q >= 0; q = parentIdx[q]!) up.push(q)
      const down = [ins.joint]
      for (let q = parentIdx[ins.joint]!; q >= 0; q = parentIdx[q]!) down.push(q)
      const ai = up.findIndex((j) => down.includes(j))
      if (ai < 0) return null
      const bi = down.indexOf(up[ai]!)
      const nodes = [...up.slice(0, ai + 1), ...down.slice(0, bi).reverse()]
      const between = nodes.slice(1).map((n, k) => (k < ai ? nodes[k]! : n))
      const onPath = new Set(nodes)
      for (const j of attJoints) if (!onPath.has(j)) return null
      for (const j of list) if (!onPath.has(j)) return null
      const O = o.point, I = ins.point
      // 1. 沿肌肉的位置 u / the position u along the muscle
      const seeds = (st: RS): number[] => {
        if (st.verts.length) return st.verts
        let mn = Infinity
        const d = new Float32Array(nU)
        for (let i = 0; i < nU; i++) {
          d[i] = Math.hypot(mesh.pos[i * 3]! - st.point[0], mesh.pos[i * 3 + 1]! - st.point[1], mesh.pos[i * 3 + 2]! - st.point[2])
          if (d[i]! < mn) mn = d[i]!
        }
        const out: number[] = []
        for (let i = 0; i < nU; i++) if (d[i]! <= mn + 0.008) out.push(i)
        return out
      }
      const dO = geodesic(mesh, seeds(o)), dI = geodesic(mesh, seeds(ins))
      const u = new Float32Array(nU)
      let connected = true
      for (let i = 0; i < nU && connected; i++) if (!Number.isFinite(dO[i]!) || !Number.isFinite(dI[i]!)) connected = false
      if (connected) {
        for (let i = 0; i < nU; i++) u[i] = dO[i]! + dI[i]! > 0 ? dO[i]! / (dO[i]! + dI[i]!) : 0
      } else {
        const dx = I[0] - O[0], dy = I[1] - O[1], dz = I[2] - O[2]
        const l2 = dx * dx + dy * dy + dz * dz
        if (l2 < 1e-8) return null
        let lo = Infinity, hi = -Infinity
        for (let i = 0; i < nU; i++) {
          u[i] = ((mesh.pos[i * 3]! - O[0]) * dx + (mesh.pos[i * 3 + 1]! - O[1]) * dy + (mesh.pos[i * 3 + 2]! - O[2]) * dz) / l2
          if (u[i]! < lo) lo = u[i]!
          if (u[i]! > hi) hi = u[i]!
        }
        for (let i = 0; i < nU; i++) u[i] = (u[i]! - lo) / Math.max(1e-9, hi - lo)
      }
      const slice = new Int32Array(nU)
      const acc = new Float64Array(PATH_SLICES * 4), cnt = new Int32Array(PATH_SLICES)
      for (let i = 0; i < nU; i++) {
        const k = Math.min(PATH_SLICES - 1, Math.floor(u[i]! * PATH_SLICES))
        slice[i] = k
        acc[k * 4] = acc[k * 4]! + mesh.pos[i * 3]!
        acc[k * 4 + 1] = acc[k * 4 + 1]! + mesh.pos[i * 3 + 1]!
        acc[k * 4 + 2] = acc[k * 4 + 2]! + mesh.pos[i * 3 + 2]!
        acc[k * 4 + 3] = acc[k * 4 + 3]! + u[i]!
        cnt[k] = cnt[k]! + 1
      }
      // 中心线的节点：(u, 点)；网格没到骨面的一端加上附着点 / centreline nodes (u, point); the attachment point is added at an end where the mesh stops short
      const cl: { u: number; p: V3; k: number }[] = []
      for (let k = 0; k < PATH_SLICES; k++) if (cnt[k]) cl.push({ u: acc[k * 4 + 3]! / cnt[k]!, p: [acc[k * 4]! / cnt[k]!, acc[k * 4 + 1]! / cnt[k]!, acc[k * 4 + 2]! / cnt[k]!], k })
      if (cl.length < 2) return null
      const pre = o.verts.length ? 0 : Math.hypot(O[0] - cl[0]!.p[0], O[1] - cl[0]!.p[1], O[2] - cl[0]!.p[2])
      const S = [pre]
      for (let k = 1; k < cl.length; k++) S.push(S[k - 1]! + Math.hypot(cl[k]!.p[0] - cl[k - 1]!.p[0], cl[k]!.p[1] - cl[k - 1]!.p[1], cl[k]!.p[2] - cl[k - 1]!.p[2]))
      const last = cl[cl.length - 1]!
      const total = S[S.length - 1]! + (ins.verts.length ? 0 : Math.hypot(I[0] - last.p[0], I[1] - last.p[1], I[2] - last.p[2]))
      const sOf = (x: number): number => {
        if (x <= cl[0]!.u) return S[0]!
        for (let k = 1; k < cl.length; k++) if (x <= cl[k]!.u) return S[k - 1]! + ((S[k]! - S[k - 1]!) * (x - cl[k - 1]!.u)) / Math.max(1e-9, cl[k]!.u - cl[k - 1]!.u)
        return S[S.length - 1]!
      }
      const line: { p: V3; s: number }[] = [...(pre > 0 ? [{ p: O, s: 0 }] : []), ...cl.map((c, k) => ({ p: c.p, s: S[k]! })), ...(total > S[S.length - 1]! ? [{ p: I, s: total }] : [])]
      // 各附着处在中心线上的位置，按所在关节在链上的序号归组 / where each attachment sits along the centreline, grouped by the position of its joint on the chain
      const order = new Map(nodes.map((j, k) => [j, k]))
      const siteS: number[][] = nodes.map(() => [])
      for (const [b, st] of sites) {
        for (const j of jointsOfBone(b)) {
          const k = order.get(j)
          if (k === undefined) continue
          if (st.verts.length) for (const i of st.verts) siteS[k]!.push(sOf(u[i]!))
          // 网格没到骨面的附着：算在离它近的那一端 / an attachment the mesh does not reach counts at the end it is nearer to
          else siteS[k]!.push(Math.hypot(st.point[0] - I[0], st.point[1] - I[1], st.point[2] - I[2]) < Math.hypot(st.point[0] - O[0], st.point[1] - O[1], st.point[2] - O[2]) ? total : 0)
        }
      }
      const pct = (a: number[], f: number): number => {
        const b = [...a].sort((x, y) => x - y)
        return b[Math.min(b.length - 1, Math.max(0, Math.round(f * (b.length - 1))))]!
      }
      // 2. 各关节的过渡带 / the transition of every joint
      const ramps: { a: number; e: number }[] = []
      rep.crossings = []
      between.forEach((jb, k) => {
        const J = joints[jb]!
        if (!J.def.dofs.length) {
          // 没有自由度：两侧永远一起动，不设过渡带 / no degree of freedom: both sides always move as one, no transition
          ramps.push({ a: -Infinity, e: -Infinity })
          return
        }
        const c = J.center
        let bestD = Infinity, sb = 0
        const seg: V3 = [J.tail[0] - c[0], J.tail[1] - c[1], J.tail[2] - c[2]]
        const sl = Math.hypot(seg[0], seg[1], seg[2])
        const twist = sl > 1e-6 && J.def.dofs.every((d) => Math.abs((J.axes[d.axis]![0] * seg[0] + J.axes[d.axis]![1] * seg[1] + J.axes[d.axis]![2] * seg[2]) / sl) > 0.8)
        let h: number
        if (twist) {
          // 远端一侧的骨比近端一侧的骨更近的第一片 / the first slice nearer to the bones of the distal side than to those of the proximal side
          const proxJ = nodes.slice(0, k + 1).filter((j) => joints[j]!.boneIds.length > 0), distJ = nodes.slice(k + 1).filter((j) => joints[j]!.boneIds.length > 0)
          const nearer = new Int32Array(PATH_SLICES)
          if (proxJ.length && distJ.length) {
            for (let i = 0; i < nU; i++) {
              const q: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
              const a = Math.min(Infinity, ...field.euclid(q, proxJ).dist), b = Math.min(Infinity, ...field.euclid(q, distJ).dist)
              if (b < a) nearer[slice[i]!] = nearer[slice[i]!]! + 1
            }
          }
          sb = total
          for (let q = 0; q < cl.length; q++) {
            if (nearer[cl[q]!.k]! * 2 < cnt[cl[q]!.k]!) continue
            sb = q > 0 ? (S[q - 1]! + S[q]!) / 2 : S[0]!
            break
          }
          bestD = 0
          h = 2 * RAMP_MIN
        } else {
          // 中心线离关节中心最近处 / the closest approach of the centreline to the joint centre
          for (let q = 1; q < line.length; q++) {
            const A = line[q - 1]!.p, B = line[q]!.p
            const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2]
            const l2 = ex * ex + ey * ey + ez * ez
            let f = l2 > 0 ? ((c[0] - A[0]) * ex + (c[1] - A[1]) * ey + (c[2] - A[2]) * ez) / l2 : 0
            f = f < 0 ? 0 : f > 1 ? 1 : f
            const dd = Math.hypot(c[0] - A[0] - f * ex, c[1] - A[1] - f * ey, c[2] - A[2] - f * ez)
            if (dd < bestD) (bestD = dd), (sb = line[q - 1]!.s + f * (line[q]!.s - line[q - 1]!.s))
          }
          h = Math.min(RAMP_MAX, Math.max(RAMP_MIN, PASS_FACTOR * bestD))
        }
        // 游离段：近端一侧附着区的末尾到远端一侧附着区的开头 / the free span: from the end of the attachments on the proximal side to the start of those on the distal side
        const prox = siteS.slice(0, k + 1).flat(), dist2 = siteS.slice(k + 1).flat()
        let sA = prox.length ? pct(prox, 0.9) : 0
        const sB = dist2.length ? pct(dist2, 0.1) : total
        // 过渡带不得早于前一个关节的过渡带 / a transition may not start before that of the joint before it
        for (const r of ramps) if (Number.isFinite(r.a)) sA = Math.max(sA, r.a)
        let a = Math.max(sA, sb - h), e = Math.min(sB, sb + h)
        if (e - a < 0.012) {
          const m = sB > sA ? Math.min(sB, Math.max(sA, sb)) : (sA + sB) / 2
          a = m - 0.006
          e = m + 0.006
        }
        ramps.push({ a, e })
        rep.crossings!.push({ joint: J.def.id, fromMm: Math.round(a * 1000), toMm: Math.round(e * 1000), passMm: Math.round(bestD * 1000) })
      })
      // 3. 权重 / the weights
      const out: Map<number, number>[] = []
      for (let i = 0; i < nU; i++) {
        const sv = sOf(u[i]!)
        const row = new Map<number, number>()
        let passed = 1
        for (let k = 0; k < ramps.length; k++) {
          const r = ramps[k]!
          let f = Number.isFinite(r.a) ? (sv - r.a) / (r.e - r.a) : 1
          f = f < 0 ? 0 : f > 1 ? 1 : f
          const next = Math.min(passed, f * f * (3 - 2 * f))
          if (passed - next > 1e-4) row.set(nodes[k]!, (row.get(nodes[k]!) ?? 0) + passed - next)
          passed = next
        }
        if (passed > 1e-4) row.set(nodes[nodes.length - 1]!, passed)
        out.push(row)
      }
      return out
    }
    const byPath = pathRows()
    const rows = byPath ?? euclidRows(mesh, beta, list)
    if (!byPath) for (let i = 0; i < nU; i++) hingeResplit(rows[i]!, mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!)
    rep.weights = byPath ? 'path' : 'nearest'
    const locked = new Uint8Array(nU)
    // 锁定附着处：贴在刚性骨上的顶点完全跟随该骨 / lock the attachment sites: vertices on a rigid bone follow it fully
    const lockDist = new Float32Array(nU).fill(Infinity)
    for (const [b, st] of sites) {
      if (!boneJoint.has(b)) continue
      const d = dist.get(b)
      if (!d) continue
      for (const i of st.verts) {
        if (d[i]! >= lockDist[i]!) continue
        lockDist[i] = d[i]!
        rows[i] = new Map([[boneJoint.get(b)!, 1]])
        locked[i] = 1
      }
    }
    const dense = densify(rows)
    smooth(dense, mesh, pol.smooth ?? 3, locked)
    finish(p, 'attach', mesh, dense, raw.positions.length / 3)

    if (!isMuscle) return
    if (!o || !ins || o.joint === ins.joint) {
      rep.why = 'both ends not established on rigid bones of different joints'
      return
    }
    const r5 = (v: V3): Vec3 => [Math.round(v[0] * 1e5) / 1e5, Math.round(v[1] * 1e5) / 1e5, Math.round(v[2] * 1e5) / 1e5]
    muscles.push({ part: p.id, origin: { point: r5(o.point), joint: joints[o.joint]!.def.id }, insertion: { point: r5(ins.point), joint: joints[ins.joint]!.def.id } })
    rep.line = true
    rep.lineEnds = [`${body.byId.get(o.bone)!.name}: ${o.how}`, `${body.byId.get(ins.bone)!.name}: ${ins.how}`]
  }

  // 第一遍：刚性骨、距离场、中心线。第二遍：需要引用它们的附着类部件。
  // First pass: rigid bones, field and centreline parts. Second pass: attached parts, which refer to them.
  const later: [Part, Policy][] = []
  // 第三遍：腔部件，权重取自已经绑好的壁（见 lumenWallIds） / third pass: lumen parts, whose weights are taken from their walls once those are bound (see lumenWallIds)
  const lumina: Part[] = []
  const lumenWalls = lumenWallIds(body.data.parts)
  let done = 0
  for (const p of body.data.parts) {
    if (!body.meshes.has(p.id)) continue
    const bj = boneJoint.get(p.id)
    if (bj !== undefined) {
      results.set(p.id, { part: p.id, method: 'bone', joint: bj })
      mainJoints.set(p.id, [bj])
      continue
    }
    // 外部权重：部件的 source 与权重包的来源一致时，按最近点从原始表面传入
    // external weights: when the part's source is that of a weight package, transferred from the original surface by closest point
    const ext = (ctx.external ?? []).find((e) => e.sourceName !== '' && p.source === e.sourceName && p.tissue === 'skin')
    if (ext) {
      const raw = body.meshes.get(p.id)!
      const nv = raw.positions.length / 3
      // 有下标对照时：唯一顶点按皮肤包的顶点下标定义，权重按下标取——不按位置焊接、不找最近点，
      // 所以重合的上下唇缘顶点各是各的，平滑和填补也不会跨过口裂。没有对照文件时照旧。
      // With the index sidecar: unique vertices are defined by package vertex index and weights are
      // taken by index — no welding by position, no closest point — so coincident upper and lower
      // lip-margin vertices stay apart and neither smoothing nor filling can cross the oral fissure.
      // Without the sidecar: as before.
      const src = ctx.skinSource && ext.byIndexFor === p.id ? ctx.skinSource : null
      if (src && src.length !== nv) throw new Error(`rig: ${SKIN_SOURCE_NAME} has ${src.length} entries but skin part ${p.id} has ${nv} vertices`)
      const mesh: Welded & { source?: Uint32Array } = src ? weldByIndex(raw.positions, raw.indices, src) : weld(raw.positions, raw.indices)
      const t = src ? { rows: ext.byIndex(mesh.source!), meanMm: 0, maxMm: 0 } : ext.transfer(mesh.pos)
      // 按区域选择：外部权重落在 generic 所列关节上的那部分份额 m，改用距离场的权重（两者按 m 混合，过渡连续）
      // choice by region: for the share m of the external weight that sits on the joints named by `generic`, the distance-field weights are used instead (blended by m, so the transition is continuous)
      const cfg = (ctx.rules.externalWeights ?? []).find((e) => e.dir === ext.dir || e.openDir === ext.dir)
      let blended = 0
      if (cfg?.generic) {
        const re = new RegExp(cfg.generic)
        const isGen = joints.map((j) => re.test(j.def.id))
        const pol0 = ctx.rules.defaults[p.tissue] ?? { method: 'field', beta: 0.4 }
        t.rows.forEach((row, i) => {
          let m = 0
          for (const [j, w] of row) if (isGen[j]) m += w
          if (m < 0.02) return
          const q: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
          weightsFromDistances(field.query(q), pol0.beta ?? 0.4, radius, tmp)
          if (!tmp.size) return
          hingeResplit(tmp, q[0], q[1], q[2])
          for (const [j, w] of row) row.set(j, w * (1 - m))
          for (const [j, w] of tmp) row.set(j, (row.get(j) ?? 0) + m * w)
          blended++
        })
      }
      // 权重上限（上唇不跟下颌）/ weight caps (the upper lip does not follow the jaw)
      let capped = 0
      for (const cap of cfg?.caps ?? []) {
        const jf = jointIndex.get(cap.joint), jt = jointIndex.get(cap.to)
        const ra = new RegExp(cap.above, 'i'), rb = new RegExp(cap.below, 'i')
        const A = body.data.parts.filter((q) => ra.test(q.name) && body.meshes.has(q.id)), B = body.data.parts.filter((q) => rb.test(q.name) && body.meshes.has(q.id))
        if (jf === undefined || jt === undefined || !A.length || !B.length) continue
        const c: V3 = [0, 0, 0]
        for (const q of [...A, ...B]) (c[0] += q.centroid[0]), (c[1] += q.centroid[1]), (c[2] += q.centroid[2])
        const nAB = A.length + B.length
        ;(c[0] /= nAB), (c[1] /= nAB), (c[2] /= nAB)
        t.rows.forEach((row, i) => {
          const w = row.get(jf)
          if (!w) return
          const x = mesh.pos[i * 3]!, y = mesh.pos[i * 3 + 1]!, z = mesh.pos[i * 3 + 2]!
          const r = Math.hypot(x - c[0], y - c[1], z - c[2])
          if (r >= cap.radius) return
          // 把 joint 与 to 之间的份额变陡：份额 ≤ lo 的归 to，≥ hi 的归 joint
          // steepen the split between `joint` and `to`: a share ≤ lo goes to `to`, ≥ hi to `joint`
          const wt = row.get(jt) ?? 0
          const share = w / (w + wt)
          let k = (share - cap.sharpen[0]) / (cap.sharpen[1] - cap.sharpen[0])
          k = k < 0 ? 0 : k > 1 ? 1 : k
          k = k * k * (3 - 2 * k)
          let zf = (r - cap.radius / 2) / (cap.radius / 2)
          zf = zf < 0 ? 0 : zf
          const zone = 1 - zf * zf * (3 - 2 * zf)
          const target = share + zone * (k - share)
          if (Math.abs(target - share) < 0.004) return
          row.set(jf, (w + wt) * target)
          row.set(jt, (w + wt) * (1 - target))
          capped++
        })
      }
      // 胸壁皮肤随肋骨：外部骨架没有肋关节，胸部皮肤全挂在胸椎上，吸气时不动。把贴近肋骨的皮肤顶点
      // 挂在胸椎上的份额，按到肋骨的距离转给距离场给出的肋骨权重。只用顶点位置和距离场，与取权重的方式无关。
      // Chest skin follows the ribs: the external skeleton has no rib joints, so chest skin hangs on the
      // thoracic vertebrae and does not move in inspiration. For skin close to the ribs, the share on
      // the thoracic vertebrae is handed to the rib weights of the distance field according to the
      // distance to the ribs. Only positions and the field are used, whichever way the weights came.
      let ribbed = 0
      const ribFlag = new Uint8Array(mesh.n)
      if (cfg?.ribFollow) {
        const rf = cfg.ribFollow
        const reFrom = new RegExp(rf.from), reRib = new RegExp(rf.ribs)
        const isFrom = joints.map((j) => reFrom.test(j.def.id)), isRib = joints.map((j) => reRib.test(j.def.id))
        t.rows.forEach((row, i) => {
          let m = 0
          for (const [j, w] of row) if (isFrom[j]) m += w
          if (m < 0.02) return
          const q: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
          const c = field.query(q, (j) => isRib[j]!)
          let dmin = Infinity
          for (const dd of c.dist) dmin = Math.min(dmin, dd)
          if (!(dmin < rf.far)) return
          let fall = dmin <= rf.near ? 1 : 1 - (dmin - rf.near) / (rf.far - rf.near)
          fall = fall * fall * (3 - 2 * fall) * rf.share
          weightsFromDistances(c, rf.beta, radius, tmp)
          if (!tmp.size) return
          for (const [j, w] of row) if (isFrom[j]) row.set(j, w * (1 - fall))
          for (const [j, w] of tmp) row.set(j, (row.get(j) ?? 0) + m * fall * w)
          ribFlag[i] = 1
          ribbed++
        })
      }
      // 每个顶点只存 4 个影响（quantise 取最大的 4 个）。keepInfluence 所列的关节不许被这个上限丢掉：一行超过 4 个而它不在前 4 个里时，
      // 把最小的其他关节逐个并到行里沿骨架树最近的那个关节上（例如 C5 并到 C4），直到剩 4 个。否则下颌角一带下颌的份额（约 0.1）
      // 在相邻顶点之间时有时无，张口到上限时那里的小三角形翻过来。只动本来会丢掉保留关节的那些行。
      // Each vertex stores 4 influences (quantise keeps the 4 largest). The joints named by keepInfluence must not be dropped by that
      // limit: where a row has more than 4 and one of them is not among the top 4, the smallest other joints are merged one by one into
      // the joint of the row nearest along the skeleton tree (C5 into C4, say) until 4 are left. Otherwise the jaw's share (about 0.1)
      // round the angle of the mandible is there on one vertex and gone on the next, and small triangles there turn over with the
      // jaw fully open. Only the rows that would have lost a kept joint are touched.
      let keptRows = 0
      if (cfg?.keepInfluence) {
        const reK = new RegExp(cfg.keepInfluence)
        const isKeep = joints.map((j) => reK.test(j.def.id))
        const chain = (j: number): number[] => {
          const out: number[] = []
          for (let q = j; q >= 0; q = parentIdx[q]!) out.push(q)
          return out
        }
        const treeDist = (a: number, b: number): number => {
          const ca = chain(a), cb = chain(b)
          for (let i = 0; i < ca.length; i++) {
            const k = cb.indexOf(ca[i]!)
            if (k >= 0) return i + k
          }
          return Infinity
        }
        // 与 quantise 相同的次序：权重大的在前，相等时下标小的在前 / the same order as quantise: larger weight first, smaller index on ties
        const order = (row: Map<number, number>) => [...row].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0])
        for (const row of t.rows) {
          const ent = order(row)
          if (ent.length <= 4 || !ent.slice(4).some(([j]) => isKeep[j])) continue
          while (order(row).length > 4) {
            const now = order(row)
            const drop = [...now].reverse().find(([j]) => !isKeep[j])
            if (!drop) break
            row.delete(drop[0])
            let to = -1, best = Infinity
            for (const [j, w] of order(row)) {
              const dd = treeDist(drop[0], j)
              if (dd < best || (dd === best && w > (row.get(to) ?? 0))) (best = dd), (to = j)
            }
            if (to >= 0) row.set(to, row.get(to)! + drop[1])
          }
          keptRows++
        }
      }
      const d = densify(t.rows)
      // 不做整体平滑：外部权重本身是连续的，按 m 的混合也连续；只有个别顶点没取到权重时才由邻居填充
      // no overall smoothing: the external weights are continuous as they are and so is the blend by m; neighbours only fill vertices that got no weight
      smooth(d, mesh, t.rows.some((r) => r.size === 0) ? 2 : 0)
      // 相邻的肋各转各的，距离场给出的肋权重在肋间有棱：只在改过的胸壁顶点上沿网格平滑几遍，其余顶点锁定不动
      // neighbouring ribs each turn on their own and the field's rib weights are ridged between them: a few smoothing passes over the mesh on the chest vertices that were changed, every other vertex locked
      if (ribbed && cfg?.ribFollow?.smooth) {
        const locked = new Uint8Array(mesh.n)
        for (let i = 0; i < mesh.n; i++) locked[i] = ribFlag[i] ? 0 : 1
        smooth(d, mesh, cfg.ribFollow.smooth, locked)
      }
      finish(p, 'external', mesh, d, nv)
      notes.push(`${p.id} "${p.name}": bound with external weights from ${ext.dir}, ${src ? `taken by package vertex index (${SKIN_SOURCE_NAME})` : `transferred by closest point on the original surface (mean ${t.meanMm.toFixed(2)} mm, max ${t.maxMm.toFixed(1)} mm away)`}${ribbed ? `; ${ribbed} chest vertices handed part of their thoracic weight to the ribs` : ''}${blended ? `; ${blended} vertices blended with distance-field weights (generic: ${cfg!.generic})` : ''}${capped ? `; ${capped} vertices had jaw weight handed to the skull (upper lip)` : ''}${keptRows ? `; on ${keptRows} vertices the smallest influences were merged into their neighbours on the skeleton so that ${cfg!.keepInfluence} stays among the 4 kept` : ''}`)
      if (++done % 400 === 0) ctx.log?.(`bound ${done} field parts`)
      continue
    }
    // 腔部件留到最后：它的权重取自壁，壁要先绑好 / lumen parts wait until the end: their weights come from their walls, which must be bound first
    if (lumenWalls.pool.length && isLumenPart(p)) {
      lumina.push(p)
      continue
    }
    const pol = policyOf(p)
    if (pol.method === 'attach') {
      later.push([p, pol])
      continue
    }
    const path = body.nerves.get(p.id)
    if (pol.method === 'centreline' && path) bindCentreline(p, pol, path)
    else bindField(p, pol)
    if (++done % 400 === 0) ctx.log?.(`bound ${done} field parts`)
  }
  for (const [p, pol] of later) {
    bindAttach(p, pol)
    if (++done % 400 === 0) ctx.log?.(`bound ${done} parts`)
  }

  // 腔随壁：每个腔顶点在所有壁的表面上找最近的一点，取那个三角形三个顶点的权重按重心坐标混合。不再平滑：权重是位置的连续函数。
  // 壁是刚性部件（骨、牙）时就是它的那个关节。一个壁也没有绑上时（不应发生）退回距离场。
  // Lumina follow their walls: every lumen vertex finds the closest point on the surfaces of all walls and takes the
  // weights of that triangle's three vertices, mixed by the barycentric coordinates. No smoothing afterwards: the
  // weights are a continuous function of position. A rigid wall (bone, tooth) gives its one joint. Should no wall be
  // bound at all (not expected), the part falls back to the distance field.
  if (lumina.length) {
    const walls = lumenWalls.pool.filter((id) => results.has(id) && body.meshes.has(id)).map((id) => ({ id, s: surf(id), r: results.get(id)! }))
    let far = 0, farPart = ''
    for (const p of lumina) {
      if (!walls.length) {
        bindField(p, policyOf(p))
        notes.push(`${p.id} "${p.name}": no wall part is bound; bound by the distance field`)
        continue
      }
      const raw = body.meshes.get(p.id)!
      const mesh = weld(raw.positions, raw.indices)
      const rows: Map<number, number>[] = []
      for (let i = 0; i < mesh.n; i++) {
        const q: V3 = [mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!]
        let best = Infinity, at = -1
        for (let k = 0; k < walls.length; k++) {
          const d = walls[k]!.s.distance(q[0], q[1], q[2], best)
          if (d < best) (best = d), (at = k)
        }
        const row = new Map<number, number>()
        const wall = walls[at]!
        if (wall.r.joint !== undefined) row.set(wall.r.joint, 1)
        else {
          const f = wall.s.closestFace(q)!
          for (let c = 0; c < 3; c++) {
            const v = f.verts[c]!, b = Math.max(0, f.bary[c]!)
            for (let k = 0; k < 4; k++) {
              const w = wall.r.w![v * 4 + k]!
              if (w) row.set(wall.r.idx![v * 4 + k]!, (row.get(wall.r.idx![v * 4 + k]!) ?? 0) + (b * w) / 255)
            }
          }
          // 重心坐标退化时取最近的那个顶点 / with degenerate barycentric coordinates, the nearest of the three vertices
          if (!row.size) for (let k = 0; k < 4; k++) if (wall.r.w![f.verts[0] * 4 + k]) row.set(wall.r.idx![f.verts[0] * 4 + k]!, wall.r.w![f.verts[0] * 4 + k]! / 255)
        }
        if (best > far) (far = best), (farPart = p.id)
        rows.push(row)
      }
      finish(p, 'wall', mesh, densify(rows), raw.positions.length / 3)
      if (++done % 400 === 0) ctx.log?.(`bound ${done} parts`)
    }
    const named = [...lumenWalls.byLumen.values()].filter((x) => x.how === 'name').length, nb = [...lumenWalls.byLumen.values()].filter((x) => x.how === 'neighbours').length
    notes.push(`${lumina.length} lumen parts follow their walls (weights at the closest point of ${walls.length} wall parts; ${named} lumina matched to wall parts by name, ${nb} to neighbouring parts; farthest lumen vertex from a wall surface ${(far * 1000).toFixed(1)} mm, in ${farPart})`)
  }

  const byMethod: BindResult['byMethod'] = {}
  const parts: BoundPart[] = []
  for (const p of body.data.parts) {
    const r = results.get(p.id)
    if (!r) continue
    parts.push(r)
    const m = (byMethod[r.method] ??= { parts: 0, vertices: 0, rigid: 0 })
    m.parts++
    if (r.joint !== undefined) m.rigid++
    else m.vertices += r.w!.length / 4
  }
  if (know.excludedPatches) notes.push(`${know.excludedPatches} Z-Anatomy attachment patch bones excluded as wrong sites (attachmentExcludes)`)
  return { parts, muscles, attach, byMethod, notes }
}
