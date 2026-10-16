// GPU 求解器的"计划"：把 CPU 参考（SoftSolver）准备好的状态摊平成内核要的数组。GPU（gpu.ts）和它的 CPU 镜像
// （mirror.ts）读的是同一份计划，所以两边的输入逐位相同，差别只在算术（f32 对 f64）和求和顺序。
// The "plan" of the GPU solver: the state the CPU reference (SoftSolver) has prepared, flattened into the arrays the
// kernels read. The GPU (gpu.ts) and its CPU mirror (mirror.ts) read the same plan, so their inputs are identical bit
// for bit; they differ only in arithmetic (f32 against f64) and in the order of sums.
//
// ── 算法：着色的 Gauss–Seidel / The algorithm: coloured Gauss–Seidel ───────────────────────────────────────────
// CPU 参考按四面体的顺序做 Gauss–Seidel：一个约束改了位置，下一个立刻看到。GPU 上把约束按"着色"分组：同一种颜色里
// 的约束不共用结点（四面体：不共用顶点；结点体积约束：一环不重叠；点约束按所在四面体分组，组之间不共用结点），所以
// 一种颜色可以同时求解、结果与按任何顺序逐个求解相同；颜色之间依次派发。每条约束的公式、子步数、阻尼都与 CPU 相同，
// 只有求解的顺序不同（颜色的顺序代替下标的顺序）。把每个约束单独算一种颜色、按 CPU 的顺序排，就是 CPU 参考本身
// （`sequential`，镜像用它检查内核的数学）。
// 为什么不用 Jacobi（SoftSolver 的 'jacobi' 模式，质量分摊）：在 ν = 0.49 的悬臂梁上，4 倍子步时不稳定，8 倍时挠度
// 仍差 1.5 %，16 倍才到 0.01 %；本机上 WebGPU 一次派发约 3–5 µs、与线程数几乎无关，8 倍子步的 Jacobi 与 13 个子步的
// 着色 Gauss–Seidel（全身笼子四面体 28 种、结点体积 22 种、点约束 18 种颜色）派发次数相当，而后者与 CPU 的差别只来自顺序。
// The CPU reference runs Gauss–Seidel in tetrahedron order: a constraint moves positions and the next one sees it at
// once. On the GPU the constraints are grouped by "colour": constraints of one colour share no node (tetrahedra: no
// vertex; nodal volume constraints: no overlap of their one-rings; point constraints are grouped by tetrahedron and
// groups share no node), so a colour can be solved at once and the result equals solving them one by one in any order;
// colours are dispatched one after another. Every constraint's formula, the substeps and the damping are the CPU's;
// only the order of solving differs (colour order instead of index order). Giving every constraint a colour of its own,
// in the CPU's order, is the CPU reference itself (`sequential`; the mirror uses it to check the kernels' mathematics).
// Why not Jacobi (the 'jacobi' mode of SoftSolver, mass splitting): on a ν = 0.49 cantilever it is unstable with 4×
// the substeps, still 1.5 % off in deflection with 8× and within 0.01 % only with 16×; on this machine a WebGPU dispatch
// costs about 3–5 µs almost whatever its size, so Jacobi with 8× the substeps takes about as many dispatches as coloured
// Gauss–Seidel with 13 substeps (on the whole-body cage 28 colours of tetrahedra, 22 of nodal volumes, 18 of point constraints), and the latter differs from the CPU only in order.
//
// ── 静止的参考构形 / A static reference ───────────────────────────────────────────────────────────────────────
// 按压和体位都在静止姿势里算，参考构形不动（ref = refPrev）。于是状态可以写成相对参考的位移 u = x − ref：u 只有毫米到
// 厘米，f32 的分辨率约 1e-9 m（绝对坐标在 1 m 处只有 6e-8 m，速度 (x − p)/h 会被舍入噪声淹掉）。形变梯度写成
// F = I + E，E = E₀ + ΔU·B，约束值都按 E 展开（见 mirror.ts 的 kinematics），避免 1 − 1 式的相消。
// Pressing and posture are both computed in the rest pose, so the reference does not move (ref = refPrev). The state
// can therefore be written as the displacement from the reference, u = x − ref: u is millimetres to centimetres and its
// f32 resolution about 1e-9 m (absolute coordinates near 1 m resolve only 6e-8 m, and the velocity (x − p)/h would
// drown in rounding noise). The deformation gradient is written F = I + E, E = E₀ + ΔU·B, and the constraint values are
// expanded in E (see `kinematics` in mirror.ts) to avoid cancellations of the 1 − 1 kind.

import { J_MIN, type Plane, type PointSet, type Probe, type SoftSolver } from '../solver.ts'

/** 体积约束里一个结点的邻居（含自己）和一环四面体的上限（BCC 格子是 15 和 24；GPU 的体积内核每个结点一个 32 线程的工作组）
 * the most neighbours (itself included) and ring tetrahedra of one node's volume constraint (15 and 24 in a BCC lattice; the GPU's volume kernel uses a 32-thread workgroup per node) */
export const MAX_RING_NODES = 32
export { J_MIN }

/** 一组点约束（锚点、压头采样点或支撑面采样点），未分组 / A set of point constraints (anchors, probe samples or support-plane samples), not grouped */
export interface PointPlan {
  count: number
  /** 每点 4 个结点（不是四面体下标）/ four nodes per point (not a tetrahedron index) */
  nodes: Uint32Array
  bary: Float64Array
  /** 每点的基准量（含义按组：压头 = 静止位置 − 原点；支撑面 = n·P₀ − d；锚点不用）/ a per-point base (by set: probe = rest position − origin; plane = n·P₀ − d; anchors: unused) */
  base: Float64Array
  /** 每点的 1/k（锚点的柔度，乘 1/h² 即 α̃；0 = 硬约束；< 0 = 不起作用）/ 1/k per point (anchor compliance; times 1/h² gives α̃; 0 = hard; < 0 = inactive) */
  invK: Float64Array
  /** 每点所在的四面体（分组用）/ the tetrahedron of each point (for grouping) */
  tet: Uint32Array
}

/**
 * 所有点约束合在一起：锚点、压头、各支撑面首尾相接，按所在四面体分组（组里按这个顺序：先锚点、再压头、再支撑面，与 CPU 里
 * 各组的先后相同），组再着色；一个线程按顺序逐个解一组。`sequential` = 每个点一组一种颜色（CPU 的顺序）。
 * All point constraints together: anchors, probe and each plane end to end, grouped by tetrahedron (within a group in
 * that order: anchors, then the probe, then planes, the order of the sets on the CPU), groups coloured; one thread solves
 * a group point by point. `sequential` = a group and a colour per point (the CPU's order).
 */
export interface ContactPlan {
  count: number
  nodes: Uint32Array
  bary: Float64Array
  base: Float64Array
  invK: Float64Array
  /** 每点的约束种类（mirror.ts 的 SHAPE）和形状编号 / per point: the kind of constraint (SHAPE of mirror.ts) and the shape index */
  kind: Uint8Array
  shape: Uint8Array
  order: Uint32Array
  groupStart: Uint32Array
  colourStart: Uint32Array
  /** 各组在合并后的点里的位置 / where each set sits among the merged points */
  sets: { offset: number; count: number }[]
}

/** 一种调度：items 按颜色排好，colourStart[c]..colourStart[c+1] 是颜色 c / A schedule: items sorted by colour, colourStart[c]..colourStart[c+1] being colour c */
export interface Schedule {
  order: Uint32Array
  colourStart: Uint32Array
}

/**
 * 着色（DSATUR，Brélaz 1979）：每次取"邻居已用颜色最多"的约束（相同时取最早的），给它邻居没用过的最小颜色；
 * 两个约束有共同结点即为冲突。全身笼子上比按顺序的贪心少：四面体 28 种对 32 种，结点体积约束 22 种对 29 种。
 * `sequential` = 每个一种颜色（就是原来的顺序）。同一颜色里保持原来的顺序。
 * Colouring (DSATUR, Brélaz 1979): repeatedly take the constraint whose neighbours already use the most colours (ties:
 * the earliest) and give it the smallest colour none of its neighbours uses; two constraints conflict when they
 * share a node. On the whole-body cage it needs fewer than greedy in order: 28 against 32 for tetrahedra, 22 against
 * 29 for nodal volume constraints. `sequential` = a colour each (the original order itself). Within a colour the
 * original order is kept.
 */
export function colourItems(nodeCount: number, items: number, nodesOf: (i: number, out: number[]) => void, sequential = false): Schedule {
  if (sequential) return { order: Uint32Array.from({ length: items }, (_, i) => i), colourStart: Uint32Array.from({ length: items + 1 }, (_, i) => i) }
  // 结点 → 约束（CSR），约束 → 结点 / node → constraints (CSR), constraint → nodes
  const ns: number[] = [], nStart = new Uint32Array(items + 1)
  const tmp: number[] = []
  for (let i = 0; i < items; i++) {
    tmp.length = 0
    nodesOf(i, tmp)
    for (const j of tmp) ns.push(j)
    nStart[i + 1] = ns.length
  }
  const byStart = new Uint32Array(nodeCount + 1)
  for (const j of ns) byStart[j + 1]!++
  for (let j = 0; j < nodeCount; j++) byStart[j + 1] = byStart[j + 1]! + byStart[j]!
  const by = new Uint32Array(ns.length), at = Uint32Array.from(byStart.subarray(0, nodeCount))
  let adjList = new Uint32Array(0)
  for (let i = 0; i < items; i++) for (let q = nStart[i]!; q < nStart[i + 1]!; q++) by[at[ns[q]!]!++] = i
  // 冲突的约束（去重），两遍：先数再填 / conflicting constraints (deduplicated), two passes: count, then fill
  const adjStart = new Uint32Array(items + 1)
  const mark = new Int32Array(items).fill(-1)
  for (let pass = 0; pass < 2; pass++) {
    mark.fill(-1)
    for (let i = 0; i < items; i++) {
      let n = 0
      for (let q = nStart[i]!; q < nStart[i + 1]!; q++) {
        const j = ns[q]!
        for (let r = byStart[j]!; r < byStart[j + 1]!; r++) {
          const k = by[r]!
          if (k !== i && mark[k] !== i) {
            mark[k] = i
            if (pass === 1) adjList[adjStart[i]! + n] = k
            n++
          }
        }
      }
      if (pass === 0) adjStart[i + 1] = adjStart[i]! + n
    }
    if (pass === 0) adjList = new Uint32Array(adjStart[items]!)
  }
  const colour = new Int32Array(items).fill(-1)
  // 每个约束邻居已用的颜色（位集，最多 64 种）和饱和度；按饱和度分桶，桶是先进先出的双向链表
  // colours used by each constraint's neighbours (bit set, up to 64) and saturation; buckets by saturation, each a first-in-first-out doubly linked list
  const lo = new Uint32Array(items), hi = new Uint32Array(items), sat = new Uint8Array(items)
  const next = new Int32Array(items).fill(-1), prev = new Int32Array(items).fill(-1)
  const head = new Int32Array(66).fill(-1), tail = new Int32Array(66).fill(-1)
  const push = (b: number, i: number): void => {
    prev[i] = tail[b]!
    next[i] = -1
    if (tail[b]! >= 0) next[tail[b]!] = i
    else head[b] = i
    tail[b] = i
  }
  const unlink = (b: number, i: number): void => {
    if (prev[i]! >= 0) next[prev[i]!] = next[i]!
    else head[b] = next[i]!
    if (next[i]! >= 0) prev[next[i]!] = prev[i]!
    else tail[b] = prev[i]!
  }
  for (let i = 0; i < items; i++) push(0, i)
  let top = 0, count = 0
  const has = (i: number, c: number): boolean => (c < 32 ? (lo[i]! >>> c) & 1 : (hi[i]! >>> (c - 32)) & 1) === 1
  for (let step = 0; step < items; step++) {
    while (top > 0 && head[top]! < 0) top--
    // 同饱和度里取最早进桶的 / within a saturation, the earliest into the bucket
    const best = head[top]!
    unlink(top, best)
    let c = 0
    while (has(best, c)) c++
    if (c >= 64) throw new Error('softbody gpu: 着色超过 64 种 / more than 64 colours')
    colour[best] = c
    count = Math.max(count, c + 1)
    for (let r = adjStart[best]!; r < adjStart[best + 1]!; r++) {
      const k = adjList[r]!
      if (colour[k] !== -1 || has(k, c)) continue
      if (c < 32) lo[k] = lo[k]! | (1 << c)
      else hi[k] = hi[k]! | (1 << (c - 32))
      unlink(sat[k]!, k)
      sat[k] = sat[k]! + 1
      push(sat[k]!, k)
      if (sat[k]! > top) top = sat[k]!
    }
  }
  const colourStart = new Uint32Array(count + 1)
  for (let i = 0; i < items; i++) colourStart[colour[i]! + 1]!++
  for (let c = 0; c < count; c++) colourStart[c + 1] = colourStart[c + 1]! + colourStart[c]!
  const fill = Uint32Array.from(colourStart.subarray(0, count))
  const order = new Uint32Array(items)
  for (let i = 0; i < items; i++) order[fill[colour[i]!]!++] = i
  return { order, colourStart }
}

export interface GpuPlan {
  nodeCount: number
  /** 参与求解的四面体个数 / number of solved tetrahedra */
  tetCount: number
  /** 局部坐标的原点（参考构形包围盒的中心，米，f64）/ origin of the local coordinates (centre of the reference's bounding box, metres, f64) */
  origin: [number, number, number]
  /** 每个参与求解的四面体：4 个结点 / per solved tetrahedron: its four nodes */
  tetNodes: Uint32Array
  /** 原四面体下标 / the original tetrahedron index */
  tetId: Uint32Array
  /** B（行主序 9 个）/ B (row-major, 9) */
  tetB: Float64Array
  /** E₀ = Dm(ref)·B − I（9 个；没有肌肉激活时全零）/ E₀ = Dm(ref)·B − I (9; all zero without muscle activation) */
  tetE0: Float64Array
  /** 8 个参数：μ、λ·份额、κ、G₁、τ、纤维模量、q·V_ref、V_rest（已乘激活倍数和参考质量 q）/ eight parameters: μ, λ·share, κ, G₁, τ, fibre modulus, q·V_ref, V_rest (activation factor and reference quality q applied) */
  tetPar: Float64Array
  /** 纤维方向（4 个，第 4 个不用）/ fibre direction (4, the fourth unused) */
  tetFib: Float64Array
  /** 结点 → 四面体角的 CSR：项 = 参与求解的四面体 × 4 + 角 / node → tetrahedron corner CSR: entry = solved tetrahedron × 4 + corner */
  ringStart: Uint32Array
  ringEntry: Uint32Array
  /** 与 ringEntry 对齐：该四面体 4 个结点在本结点邻居表里的位置（每个 8 位）/ aligned with ringEntry: the slots of the tetrahedron's four nodes in this node's neighbour list (8 bits each) */
  ringSlots: Uint32Array
  /** 结点的邻居表（体积约束碰到的结点，含自己）/ the neighbour list of each node (the nodes its volume constraint touches, itself included) */
  nbrStart: Uint32Array
  nbr: Uint32Array
  /**
   * 每个结点、每个邻居：它的梯度由一环里哪些"四面体 × 角"相加（r·4 + c，按 r、c 递增，与镜像的求和顺序相同）。
   * vlStart[n] 指向 vl 里结点 n 的一段：先 cnt + 1 个相对偏移，再是每 4 个打包进一个 u32 的项（每项 8 位）。
   * For each node and each neighbour: which "tetrahedron × corner" of the ring add up to its gradient (r·4 + c, in
   * increasing r then c, the mirror's order of summation). vlStart[n] points at node n's run in vl: first cnt + 1
   * relative offsets, then the items packed four to a u32 (8 bits each).
   */
  vlStart: Uint32Array
  vl: Uint32Array
  /** 逆质量、体积刚度 K（已乘份额）、参考体积 V / inverse mass, bulk stiffness K (share applied), reference volume V */
  w: Float64Array
  K: Float64Array
  V: Float64Array
  /** 体积约束是否在结点上 / whether the volume constraint lives on the nodes */
  nodal: boolean
  hasBranch: boolean
  hasFibre: boolean
  hasKappa: boolean
  volumeCap: number
  damping: number
  anchors: PointPlan | null
  /** 四面体（参与求解的下标）和结点体积约束的着色 / colouring of the tetrahedra (solved indices) and of the nodal volume constraints */
  tetSched: Schedule
  volSched: Schedule
  /** 每个约束一种颜色、CPU 的顺序 / a colour per constraint, in the CPU's order */
  sequential: boolean
  /** 骨的胶囊：每个结点的项（CSR）；每项 = 胶囊下标、(x₀ − a)、ab、|ab|²、有效半径 / bone capsules per node (CSR); each entry = capsule, (x₀ − a), ab, |ab|², effective radius */
  capStart: Uint32Array
  capData: Float64Array
}

/** 胶囊项的长度（f64 个数）/ length of a capsule entry (f64 values) */
export const CAP_STRIDE = 8

/** 一组嵌入点 → 点约束计划（base、invK 由调用者填）/ a set of embedded points → a point-constraint plan (base and invK filled by the caller) */
export function pointPlan(s: SoftSolver, set: PointSet): PointPlan {
  const m = set.tet.length
  const nodes = new Uint32Array(m * 4), bary = new Float64Array(m * 4)
  for (let p = 0; p < m; p++) for (let k = 0; k < 4; k++) {
    nodes[p * 4 + k] = s.tets[set.tet[p]! * 4 + k]!
    bary[p * 4 + k] = set.bary[p * 4 + k]!
  }
  return { count: m, nodes, bary, base: new Float64Array(m * 4), invK: new Float64Array(m), tet: Uint32Array.from(set.tet) }
}

/** 把几组点约束合成一个计划并着色（见 ContactPlan）/ merges point-constraint sets into one plan and colours it (see ContactPlan) */
export function contactPlan(nodeCount: number, sets: { plan: PointPlan; kind: number; shape: number }[], sequential = false): ContactPlan {
  let m = 0
  const where = sets.map((q) => {
    const w = { offset: m, count: q.plan.count }
    m += q.plan.count
    return w
  })
  const nodes = new Uint32Array(m * 4), bary = new Float64Array(m * 4), base = new Float64Array(m * 4), invK = new Float64Array(m), kind = new Uint8Array(m), shape = new Uint8Array(m), tet = new Uint32Array(m)
  sets.forEach((q, k) => {
    const o = where[k]!.offset, pl = q.plan
    nodes.set(pl.nodes, o * 4)
    bary.set(pl.bary, o * 4)
    base.set(pl.base, o * 4)
    invK.set(pl.invK, o)
    kind.fill(q.kind, o, o + pl.count)
    shape.fill(q.shape, o, o + pl.count)
    tet.set(pl.tet, o)
  })
  // 分组：按四面体，组的顺序 = 该四面体第一次出现的顺序 / groups by tetrahedron, in order of first appearance
  const groupOf = new Map<number, number[]>()
  const groups: number[][] = []
  for (let p = 0; p < m; p++) {
    const key = sequential ? p : tet[p]!
    let g = groupOf.get(key)
    if (!g) groupOf.set(key, (g = [])), groups.push(g)
    g.push(p)
  }
  const sched = colourItems(nodeCount, groups.length, (g, out) => {
    const p = groups[g]![0]!
    for (let k = 0; k < 4; k++) out.push(nodes[p * 4 + k]!)
  }, sequential)
  const order = new Uint32Array(m), groupStart = new Uint32Array(groups.length + 1)
  let at = 0
  for (let k = 0; k < groups.length; k++) {
    groupStart[k] = at
    for (const p of groups[sched.order[k]!]!) order[at++] = p
  }
  groupStart[groups.length] = at
  return { count: m, nodes, bary, base, invK, kind, shape, order, groupStart, colourStart: sched.colourStart, sets: where }
}

/** 压头采样点的基准：静止位置 − 原点 / the base of probe samples: rest position − origin */
export function probePlan(s: SoftSolver, plan: GpuPlan, probe: Probe): PointPlan {
  const pp = pointPlan(s, probe.points)
  const o = plan.origin, ref = s.ref
  for (let p = 0; p < pp.count; p++) for (let r = 0; r < 3; r++) {
    let v = 0
    for (let k = 0; k < 4; k++) v += pp.bary[p * 4 + k]! * ref[pp.nodes[p * 4 + k]! * 3 + r]!
    pp.base[p * 4 + r] = v - o[r]!
  }
  return pp
}

/** 支撑面采样点的基准：n·P₀ − d（在参考构形上离面多远）/ the base of plane samples: n·P₀ − d (how far off the plane in the reference) */
export function planePlan(s: SoftSolver, plane: Plane): PointPlan {
  const pp = pointPlan(s, plane.points)
  const ref = s.ref
  for (let p = 0; p < pp.count; p++) {
    let g = -plane.d
    for (let k = 0; k < 4; k++) {
      const b = pp.bary[p * 4 + k]!, n = pp.nodes[p * 4 + k]! * 3
      g += b * (plane.n[0] * ref[n]! + plane.n[1] * ref[n + 1]! + plane.n[2] * ref[n + 2]!)
    }
    pp.base[p * 4] = g
  }
  return pp
}

/**
 * 由一个 CPU 求解器建计划。要求参考构形静止（ref = refPrev，按压和体位都是）；有 Ogden 能或力控压头时 GPU 不支持，抛错（调用者退回 CPU）。
 * Builds the plan from a CPU solver. The reference must be static (ref = refPrev, as for presses and postures); Ogden
 * energy and a force-controlled probe are not supported on the GPU and throw (the caller falls back to the CPU).
 */
export function buildPlan(s: SoftSolver, o: { sequential?: boolean } = {}): GpuPlan {
  const sequential = !!o.sequential
  const q = s.internals()
  if (q.ogden) throw new Error('softbody gpu: Ogden 型能量没有 GPU 内核 / no GPU kernel for the Ogden-type energy')
  if (s.volumeMode !== 'node') throw new Error("softbody gpu: 只支持结点体积约束（volume: 'node'）/ only nodal volume constraints are supported")
  const N = s.nodeCount, T = s.tets
  for (let i = 0; i < N * 3; i++) if (q.refPrev[i] !== s.ref[i]) throw new Error('softbody gpu: 参考构形在动（姿势变化）；GPU 求解器只支持静止的参考 / the reference is moving (a pose change); the GPU solver supports a static reference only')
  const act = q.active, Ta = act.length
  const local = new Int32Array(s.tetCount).fill(-1)
  act.forEach((e, k) => (local[e] = k))
  const share = s.volumeBlend
  // 原点：参考构形包围盒的中心 / origin: the centre of the reference's bounding box
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < N; i++) for (let r = 0; r < 3; r++) (lo[r] = Math.min(lo[r]!, s.ref[i * 3 + r]!)), (hi[r] = Math.max(hi[r]!, s.ref[i * 3 + r]!))
  const origin: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
  const tetNodes = new Uint32Array(Ta * 4), tetB = new Float64Array(Ta * 9), tetE0 = new Float64Array(Ta * 9), tetPar = new Float64Array(Ta * 8), tetFib = new Float64Array(Ta * 4)
  const ref = s.ref
  for (let k = 0; k < Ta; k++) {
    const e = act[k]!
    for (let c = 0; c < 4; c++) tetNodes[k * 4 + c] = T[e * 4 + c]!
    const o = e * 9
    for (let j = 0; j < 9; j++) tetB[k * 9 + j] = q.B[o + j]!
    // E₀ = Dm(ref)·B − I / E₀ = Dm(ref)·B − I
    const a = T[e * 4]! * 3
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let v = 0
      for (let m = 0; m < 3; m++) v += (ref[T[e * 4 + m + 1]! * 3 + r]! - ref[a + r]!) * q.B[o + m * 3 + c]!
      tetE0[k * 9 + r * 3 + c] = v - (r === c ? 1 : 0)
    }
    // 没有激活时 Dm(ref)·B 就是 I（B = Dm(ref)⁻¹），舍入的残差清零 / without activation Dm(ref)·B is I (B = Dm(ref)⁻¹); the rounding residue is cleared
    let big = 0
    for (let j = 0; j < 9; j++) big = Math.max(big, Math.abs(tetE0[k * 9 + j]!))
    if (big < 1e-9) tetE0.fill(0, k * 9, k * 9 + 9)
    const qe = q.qual[e]!, as = q.actScale[e]!
    const db = det9(q.B, o)
    const vref = db > 0 && Number.isFinite(db) ? 1 / (6 * db) : 0
    tetPar[k * 8] = q.mu[e]! * as * qe
    tetPar[k * 8 + 1] = q.lam[e]! * as * share * qe
    tetPar[k * 8 + 2] = q.kappa ? q.kappa[e]! : 0
    tetPar[k * 8 + 3] = q.branchG ? q.branchG[e]! * qe : 0
    tetPar[k * 8 + 4] = q.branchTau ? q.branchTau[e]! : 1
    tetPar[k * 8 + 5] = q.fibreK && q.fibre ? q.fibreK[e]! * as * qe : 0
    // kdet·det Ds = (q/6)·det Ds = q·V_ref·J（det Ds = J / det B）/ kdet·det Ds = (q/6)·det Ds = q·V_ref·J (det Ds = J / det B)
    tetPar[k * 8 + 6] = qe * vref
    tetPar[k * 8 + 7] = q.restVolume[e]!
    if (q.fibre) for (let r = 0; r < 3; r++) tetFib[k * 4 + r] = q.fibre[e * 3 + r]!
  }
  // 结点 → 四面体角 / node → tetrahedron corners
  const ringStart = Uint32Array.from(q.ringStart)
  const ringEntry = new Uint32Array(ringStart[N]!), ringSlots = new Uint32Array(ringStart[N]!)
  const nbrStart = new Uint32Array(N + 1)
  const nbrList: number[] = []
  const slot = new Int32Array(N).fill(-1)
  let maxNbr = 0
  for (let i = 0; i < N; i++) {
    const from = ringStart[i]!, to = ringStart[i + 1]!
    const mine: number[] = []
    // 与 solveVolumes 同样的顺序：按环里的四面体、每个四面体按角，第一次碰到就排进去 / the order of solveVolumes: by ring tetrahedron, then corner, appended on first encounter
    for (let r = from; r < to; r++) {
      const e = q.ringTets[r]!, k = local[e]!
      let corner = -1
      let packed = 0
      for (let c = 0; c < 4; c++) {
        const j = T[e * 4 + c]!
        if (j === i) corner = c
        if (slot[j] === -1) (slot[j] = mine.length), mine.push(j)
        packed |= slot[j]! << (8 * c)
      }
      ringEntry[r] = k * 4 + corner
      ringSlots[r] = packed >>> 0
    }
    for (const j of mine) slot[j] = -1
    maxNbr = Math.max(maxNbr, mine.length)
    nbrStart[i + 1] = nbrStart[i]! + mine.length
    for (const j of mine) nbrList.push(j)
  }
  let maxRing = 0
  for (let i = 0; i < N; i++) maxRing = Math.max(maxRing, ringStart[i + 1]! - ringStart[i]!)
  if (maxRing > MAX_RING_NODES) throw new Error(`softbody gpu: 一个结点周围有 ${maxRing} 个四面体，内核最多 ${MAX_RING_NODES} 个 / a node has ${maxRing} tetrahedra round it; the kernel allows ${MAX_RING_NODES}`)
  // 每个邻居的梯度由哪些"四面体 × 角"相加 / which "tetrahedron × corner" add up to each neighbour's gradient
  const vlStart = new Uint32Array(N + 1), vlList: number[] = []
  for (let i = 0; i < N; i++) {
    vlStart[i] = vlList.length
    const from = ringStart[i]!, ring = ringStart[i + 1]! - from, cnt = nbrStart[i + 1]! - nbrStart[i]!
    const lists: number[][] = Array.from({ length: cnt }, () => [])
    for (let r = 0; r < ring; r++) for (let c = 0; c < 4; c++) lists[(ringSlots[from + r]! >>> (8 * c)) & 255]!.push(r * 4 + c)
    let off = 0
    const head: number[] = [0]
    for (const l of lists) head.push((off += l.length))
    const items = lists.flat()
    for (const h of head) vlList.push(h)
    for (let k = 0; k < items.length; k += 4) vlList.push((items[k]! | ((items[k + 1] ?? 0) << 8) | ((items[k + 2] ?? 0) << 16) | ((items[k + 3] ?? 0) << 24)) >>> 0)
  }
  vlStart[N] = vlList.length
  if (maxNbr > MAX_RING_NODES) throw new Error(`softbody gpu: 一个结点的体积约束碰到 ${maxNbr} 个结点，内核最多 ${MAX_RING_NODES} 个 / a node's volume constraint touches ${maxNbr} nodes; the kernel allows ${MAX_RING_NODES}`)
  const w = Float64Array.from(q.invMass)
  const K = Float64Array.from(q.ringK, (v) => v * (1 - share)), V = Float64Array.from(q.ringVolume)
  const anchors = q.anchors ? pointPlan(s, q.anchors) : null
  if (anchors) for (let p = 0; p < anchors.count; p++) {
    const k = q.anchorK ? q.anchorK[p]! : Infinity
    anchors.invK[p] = Number.isFinite(k) && k > 0 ? 1 / k : k > 0 ? 0 : -1
  }
  // 胶囊：每个结点按胶囊的顺序列出它的项 / capsules: every node lists its entries in capsule order
  const capStart = new Uint32Array(N + 1)
  for (const cp of s.capsules) for (const n of cp.nodes) capStart[n + 1]!++
  for (let i = 0; i < N; i++) capStart[i + 1] = capStart[i + 1]! + capStart[i]!
  const capData = new Float64Array(capStart[N]! * CAP_STRIDE)
  const at = Uint32Array.from(capStart.subarray(0, N))
  s.capsules.forEach((cp) => {
    const { a, b, radius } = cp.capsule
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
    const l2 = abx * abx + aby * aby + abz * abz || 1
    for (const n of cp.nodes) {
      const qx = ref[n * 3]! - a[0], qy = ref[n * 3 + 1]! - a[1], qz = ref[n * 3 + 2]! - a[2]
      const tr = Math.min(1, Math.max(0, (qx * abx + qy * aby + qz * abz) / l2))
      const lim = Math.min(radius, 0.999 * Math.hypot(qx - tr * abx, qy - tr * aby, qz - tr * abz))
      const o = at[n]!++ * CAP_STRIDE
      capData.set([qx, qy, qz, abx, aby, abz, l2, lim], o)
    }
  })
  return {
    nodeCount: N, tetCount: Ta, origin, tetNodes, tetId: Uint32Array.from(act), tetB, tetE0, tetPar, tetFib, ringStart, ringEntry, ringSlots, nbrStart, nbr: Uint32Array.from(nbrList), vlStart, vl: Uint32Array.from(vlList),
    w, K, V, nodal: share < 1, hasBranch: !!q.branchG, hasFibre: !!(q.fibreK && q.fibre), hasKappa: !!q.kappa, volumeCap: s.volumeCap, damping: s.damping, anchors, capStart, capData,
    tetSched: colourItems(N, Ta, (k, out) => { for (let c = 0; c < 4; c++) out.push(tetNodes[k * 4 + c]!) }, sequential),
    // 结点体积约束碰到它的一环：一环重叠的两个结点不同色 / a nodal volume constraint touches its one-ring: nodes with overlapping rings get different colours
    volSched: colourItems(N, N, (n, out) => { for (let j = nbrStart[n]!; j < nbrStart[n + 1]!; j++) out.push(nbrList[j]!) }, sequential),
    sequential,
  }
}

function det9(m: ArrayLike<number>, o: number): number {
  return m[o]! * (m[o + 4]! * m[o + 8]! - m[o + 5]! * m[o + 7]!) - m[o + 1]! * (m[o + 3]! * m[o + 8]! - m[o + 5]! * m[o + 6]!) + m[o + 2]! * (m[o + 3]! * m[o + 7]! - m[o + 4]! * m[o + 6]!)
}

/**
 * 每个结点的加速度项：重力（减去预应力的那部分）+ 外力 × 逆质量（xyz + 填充）。
 * The per-node acceleration term: gravity (less the pre-stressed part) + external force × inverse mass (xyz + padding).
 */
export function accelerations(s: SoftSolver, w: ArrayLike<number>): Float64Array {
  const N = s.nodeCount, out = new Float64Array(N * 4)
  const g = s.gravity, g0 = s.prestressGravity, R = s.rotations
  for (let i = 0; i < N; i++) {
    let ax = g[0], ay = g[1], az = g[2]
    if (g0) {
      if (R) {
        const q = i * 9
        ax -= R[q]! * g0[0] + R[q + 1]! * g0[1] + R[q + 2]! * g0[2]
        ay -= R[q + 3]! * g0[0] + R[q + 4]! * g0[1] + R[q + 5]! * g0[2]
        az -= R[q + 6]! * g0[0] + R[q + 7]! * g0[1] + R[q + 8]! * g0[2]
      } else (ax -= g0[0]), (ay -= g0[1]), (az -= g0[2])
    }
    out[i * 4] = ax + s.force[i * 3]! * w[i]!
    out[i * 4 + 1] = ay + s.force[i * 3 + 1]! * w[i]!
    out[i * 4 + 2] = az + s.force[i * 3 + 2]! * w[i]!
  }
  return out
}
