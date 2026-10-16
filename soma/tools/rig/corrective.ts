// 姿势校正形（pose-corrective shapes）的构建：在几个关键姿势下把皮肤放松成拉伸更均匀、贴着身体、盖住深部结构的形状，
// 再把与普通蒙皮之差换回静止空间存下来；运行时按驱动角在关键姿势之间插值，加在蒙皮之前（tools/rig/pose.ts 的
// correctiveOffsets，查看器在 src/viewer/Viewer.ts 里把它和表情、体型一起写进静止几何）。
// Building pose-corrective shapes: at a few key poses the skin is relaxed into a shape whose stretch is more even, that
// stays on the body and covers the deep parts; the difference from plain skinning is taken back to rest space and
// stored. At run time it is interpolated between the key poses by a driver angle and added before skinning
// (correctiveOffsets in tools/rig/pose.ts; the viewer writes it into the rest geometry together with the expression and
// the body shape, in src/viewer/Viewer.ts).
//
// 放松（每个关键姿势、每侧各一次；投影动力学，确定性）/ the relaxation (once per key pose and side; projective dynamics, deterministic)
//   · 只动区域里的皮肤顶点：离腋窝中心（盂肱关节中心加一个偏移）inner 以内全动，到 outer 渐渐不动（迁移率 α）。
//     only the skin vertices of the region move: fully within `inner` of the centre of the axilla (the glenohumeral centre
//     plus an offset), less and less towards `outer` (mobility α).
//   · 拉长的边向静止长度收（单向：被压缩的边不推开，免得鼓包）；位移场按拉普拉斯平滑，形状的细节跟着普通蒙皮。
//     stretched edges are drawn towards their rest length (one-sided: compressed edges are not pushed apart, which would
//     make bulges); the displacement field is Laplacian-smoothed, so the shape's detail follows plain skinning.
//   · 不浮起：到深层（肌、骨、腱、软骨、脂肪）的距离不超过静止时的距离加 lift。
//     no lifting: the distance to the deep layer (muscle, bone, tendon, cartilage, fat) stays within its rest value plus `lift`.
//   · 盖住：每隔 inner 步，在皮肤外（广义环绕数 < ½）或盖得不足 cover 的深部顶点给它最近的皮肤三角形一个沿外法线的目标点（每轮至多 8 mm）。
//     covering: every `inner` steps, deep-part vertices outside the skin (generalised winding number < ½) or covered by less
//     than `cover` give the nearest skin triangle a target along its outward normal (at most 8 mm per round).
// 这是几何上的放松，不是皮肤的力学模型：没有摩擦、没有真实的弹性模量；它只决定关键姿势下皮肤落在哪里。
// This is a geometric relaxation, not a mechanical model of skin: no friction and no real elastic moduli; it only decides
// where the skin lies in the key poses.

import type { Rig, RigCorrective } from '../../src/anatomy/types.ts'
import { weld, weldByIndex } from './bind.ts'
import type { Body } from './io.ts'
import { type V3 } from './math.ts'
import { BYTES_PER_VERTEX, Poser, jointFrames, vertexBlend, type Pose } from './pose.ts'
import { PoseBuilder, raiseArm } from './postures.ts'
import { Surface, Winding } from './solid.ts'

export interface CorrectiveSolver {
  /** 外层轮数（每轮先“盖住”一次）/ outer rounds (each starts with one covering pass) */
  outer: number
  /** 每轮里的放松步数 / relaxation steps per round */
  inner: number
  /** 深部顶点至少盖住这么深（米）/ deep-part vertices are covered by at least this much (m) */
  cover: number
  /** 离深层的距离最多比静止时多这么多（米）/ the distance to the deep layer may exceed its rest value by at most this (m) */
  lift: number
  /** 位移场平滑的权重（相对边的平均权重）/ weight of the smoothing of the displacement field (relative to the mean edge weight) */
  smooth: number
  /** “盖住”目标点的权重（相对边的平均权重）/ weight of the "cover" targets (relative to the mean edge weight) */
  coverWeight: number
  /** “不浮起”目标点的权重（相对边的平均权重）/ weight of the "no lift" targets (relative to the mean edge weight) */
  liftWeight: number
}

export interface CorrectiveSet {
  id: string
  /** 驱动：关节（{S} 换成侧别）和自由度所在的轴号 / driver: the joint ({S} becomes the side) and the axis of its dof */
  driver: { joint: string; axis: number }
  sides: ('L' | 'R')[]
  /** 关键姿势：上臂抬到这些胸肱角（度，tools/rig/postures.ts 的 raiseArm，plane 0 = 冠状面外展）/ key poses: the arm raised to these thoracohumeral angles (degrees, raiseArm of tools/rig/postures.ts, plane 0 = abduction in the frontal plane) */
  keys: number[]
  plane: 0 | 1
  /** 区域：中心 = 盂肱关节中心 + centre（米，左侧；右侧 x 取反），inner 以内全动，outer 以外不动 / region: centre = glenohumeral centre + `centre` (m, left side; x mirrored on the right), fully mobile within `inner`, fixed beyond `outer` */
  region: { centre: V3; inner: number; outer: number }
  why?: { zh: string; en: string }
}

export interface CorrectiveConfig {
  solver: CorrectiveSolver
  sets: CorrectiveSet[]
}

export interface CorrectiveReport {
  id: string
  side: string
  part: string
  vertices: number
  keys: { degrees: number; driverRad: number; maxMm: number; meanMm: number; stillOutside: number }[]
}

/** 深部：会从皮肤里穿出来、要被盖住的组织 / Deep: the tissues that may come through the skin and must be covered. */
const DEEP = new Set(['muscle', 'tendon', 'ligament', 'fascia', 'fat', 'artery', 'vein', 'nerve', 'bone', 'cartilage', 'gland'])
/** 深层：皮肤贴着的那一层（不浮起的参照）/ The deep layer: what the skin lies on (the reference for not lifting). */
const LAYER = new Set(['muscle', 'tendon', 'bone', 'cartilage', 'fat'])

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** 上臂抬到给定角度的姿势（只这一侧）/ The pose with the arm raised to a given angle (this side only). */
export function keyPose(rig: Rig, side: 'L' | 'R', degrees: number, plane: 0 | 1): Pose {
  const b = new PoseBuilder(rig.joints)
  raiseArm(b, side, degrees, plane)
  return b.pose
}

/**
 * 一个关键姿势下的放松（见文件开头），按投影动力学（Bouaziz 等 2014）求：局部一步把拉长的边投到静止长度、算出“盖住”和“不浮起”的目标点，
 * 全局一步解一个对称正定的稀疏线性方程组（共轭梯度，三个坐标同一个矩阵）。x0：普通蒙皮的位置（合并后的顶点），返回放松后的位置。
 * The relaxation at one key pose (see the head of the file), solved by projective dynamics (Bouaziz et al. 2014): a local
 * step projects stretched edges onto their rest length and finds the "cover" and "no lift" targets, a global step solves
 * one sparse symmetric positive-definite linear system (conjugate gradients, one matrix for all three coordinates).
 * x0: plain skinning (merged vertices); returns the relaxed positions.
 */
export function relax(
  mesh: { pos: Float32Array; n: number; adjStart: Uint32Array; adj: Uint32Array },
  tri: Uint32Array,
  x0: Float64Array,
  alpha: Float64Array,
  deepPts: Float64Array,
  layer: Surface,
  dRest: Float64Array,
  inside: V3,
  s: CorrectiveSolver,
): { x: Float64Array; stillOutside: number } {
  const n = mesh.n
  const x = Float64Array.from(x0)
  // 可动顶点的编号 / numbering of the mobile vertices
  const slot = new Int32Array(n).fill(-1)
  const free: number[] = []
  for (let v = 0; v < n; v++) if (alpha[v]! > 0) (slot[v] = free.length), free.push(v)
  const F = free.length
  if (!F) return { x, stillOutside: 0 }
  // 边：两端至少一端可动；w = 1 / 静止长度 / edges with at least one mobile end; w = 1 / rest length
  const eu: number[] = [], ev: number[] = [], eL: number[] = [], ew: number[] = []
  for (const v of free) {
    for (let e = mesh.adjStart[v]!; e < mesh.adjStart[v + 1]!; e++) {
      const w = mesh.adj[e]!
      if (alpha[w]! > 0 && w < v) continue
      const L = Math.hypot(mesh.pos[v * 3]! - mesh.pos[w * 3]!, mesh.pos[v * 3 + 1]! - mesh.pos[w * 3 + 1]!, mesh.pos[v * 3 + 2]! - mesh.pos[w * 3 + 2]!)
      if (!(L > 1e-6)) continue
      eu.push(v), ev.push(w), eL.push(L), ew.push(1 / L)
    }
  }
  const E = eu.length
  let wMean = 0
  for (const w of ew) wMean += w
  wMean /= Math.max(1, E)
  // 各项的权重：位移场平滑 λ（相对边）、区域边缘的锚 K·(1 − α)、目标点 μ / weights: displacement smoothing λ (relative to the edges), the anchor K·(1 − α) at the edge of the region, targets μ
  const lam = s.smooth * wMean, K = 20 * wMean, mu = s.liftWeight * wMean, muCover = s.coverWeight * wMean
  const anchor = new Float64Array(F)
  for (let k = 0; k < F; k++) anchor[k] = K * (1 - alpha[free[k]!]!)
  const tgtW = new Float64Array(F), tgt = new Float64Array(F * 3)
  // 矩阵（只与权重有关）：对角和边 / the matrix (depends on the weights only): diagonal and edges
  const diag0 = new Float64Array(F)
  for (let e = 0; e < E; e++) {
    const a = slot[eu[e]!]!, b = slot[ev[e]!]!, w = ew[e]! + lam
    if (a >= 0) diag0[a] = diag0[a]! + w
    if (b >= 0) diag0[b] = diag0[b]! + w
  }
  const apply = (p: Float64Array, out: Float64Array): void => {
    for (let k = 0; k < F; k++) out[k] = (diag0[k]! + anchor[k]! + tgtW[k]!) * p[k]!
    for (let e = 0; e < E; e++) {
      const a = slot[eu[e]!]!, b = slot[ev[e]!]!
      if (a < 0 || b < 0) continue
      const w = ew[e]! + lam
      out[a] = out[a]! - w * p[b]!
      out[b] = out[b]! - w * p[a]!
    }
  }
  const r = new Float64Array(F), d = new Float64Array(F), q = new Float64Array(F), rhs = new Float64Array(F), sol = new Float64Array(F)
  const cg = (c: number): void => {
    for (let k = 0; k < F; k++) sol[k] = x[free[k]! * 3 + c]!
    apply(sol, q)
    let rr = 0
    for (let k = 0; k < F; k++) (r[k] = rhs[k]! - q[k]!), (d[k] = r[k]!), (rr += r[k]! * r[k]!)
    let b2 = 0
    for (let k = 0; k < F; k++) b2 += rhs[k]! * rhs[k]!
    for (let it = 0; it < 400 && rr > 1e-20 * b2; it++) {
      apply(d, q)
      let dq = 0
      for (let k = 0; k < F; k++) dq += d[k]! * q[k]!
      const al = rr / dq
      let rr2 = 0
      for (let k = 0; k < F; k++) (sol[k] = sol[k]! + al * d[k]!), (r[k] = r[k]! - al * q[k]!), (rr2 += r[k]! * r[k]!)
      const be = rr2 / rr
      rr = rr2
      for (let k = 0; k < F; k++) d[k] = r[k]! + be * d[k]!
    }
    for (let k = 0; k < F; k++) x[free[k]! * 3 + c] = sol[k]!
  }
  let stillOutside = 0
  /** 盖住：在皮肤外或盖得不足的深部顶点，给它上方最近的皮肤三角形的顶点一个沿外法线的目标 / covering: a deep-part vertex outside or covered too thinly gives the vertices of the nearest skin triangle above it a target along the outward normal */
  const coverTargets = (count: boolean): { need: Float64Array; dir: Float64Array } => {
    const surf = new Surface([{ positions: Float32Array.from(x), indices: tri }])
    const wind = new Winding(x, tri)
    const sign = wind.at(inside[0], inside[1], inside[2]) < 0 ? -1 : 1
    const need = new Float64Array(n), dir = new Float64Array(n * 3)
    let out = 0
    for (let k = 0; k < deepPts.length; k += 3) {
      const px = deepPts[k]!, py = deepPts[k + 1]!, pz = deepPts[k + 2]!
      const f = surf.nearestFace(px, py, pz)
      if (f.distance > 0.06) continue
      const isIn = sign * wind.at(px, py, pz) >= 0.5
      if (!isIn) out++
      // 每轮至多推 8 mm：环绕数在自身相交的皮肤附近会判错，推得太猛会越推越远 / at most 8 mm per round: the winding number can be wrong near self-intersecting skin, and pushing too hard runs away
      const push = Math.min(0.008, isIn ? s.cover - f.distance : f.distance + s.cover)
      if (push <= 0) continue
      const [a, b, c] = surf.faceVerts(f.face)
      const ux = x[b * 3]! - x[a * 3]!, uy = x[b * 3 + 1]! - x[a * 3 + 1]!, uz = x[b * 3 + 2]! - x[a * 3 + 2]!
      const vx = x[c * 3]! - x[a * 3]!, vy = x[c * 3 + 1]! - x[a * 3 + 1]!, vz = x[c * 3 + 2]! - x[a * 3 + 2]!
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const nl = Math.hypot(nx, ny, nz)
      if (nl < 1e-14) continue
      // 外法线（sign 为负时网格朝里）/ the outward normal (the mesh faces inwards when sign is negative)
      ;(nx = (sign * nx) / nl), (ny = (sign * ny) / nl), (nz = (sign * nz) / nl)
      for (const v of [a, b, c]) {
        if (push > need[v]!) need[v] = push
        dir[v * 3] = dir[v * 3]! + nx * push
        dir[v * 3 + 1] = dir[v * 3 + 1]! + ny * push
        dir[v * 3 + 2] = dir[v * 3 + 2]! + nz * push
      }
    }
    if (count) stillOutside = out
    return { need, dir }
  }
  // 不浮起的上限：静止时的距离加 lift，但不低于普通蒙皮已有的距离（不比普通蒙皮更浮起）
  // the no-lift bound: the rest distance plus `lift`, but never below what plain skinning already has (never more lifted than plain skinning)
  const lim = new Float64Array(F)
  for (let k = 0; k < F; k++) {
    const v = free[k]!
    lim[k] = Math.max(dRest[v]! + s.lift, layer.nearestFace(x0[v * 3]!, x0[v * 3 + 1]!, x0[v * 3 + 2]!).distance)
  }
  let cov: { need: Float64Array; dir: Float64Array } | null = null
  const dEdge = new Float64Array(E * 3)
  const coverOn = new Uint8Array(F), coverAt = new Float64Array(F * 3)
  const rounds = s.outer * s.inner
  for (let it = 0; it < rounds; it++) {
    if (it % s.inner === 0) {
      cov = coverTargets(false)
      // 目标点在这一刻定下，之后几步不再随顶点移动 / the targets are fixed now and do not move with the vertices in the following steps
      for (let k = 0; k < F; k++) {
        const v = free[k]!
        const need = cov.need[v]!
        const l = Math.hypot(cov.dir[v * 3]!, cov.dir[v * 3 + 1]!, cov.dir[v * 3 + 2]!)
        coverOn[k] = need > 0 && l > 1e-14 ? 1 : 0
        if (coverOn[k]) for (let c = 0; c < 3; c++) coverAt[k * 3 + c] = x[v * 3 + c]! + (cov.dir[v * 3 + c]! / l) * need
      }
    }
    // 局部一步：目标点 / local step: the targets
    tgtW.fill(0)
    for (let k = 0; k < F; k++) {
      const v = free[k]!
      if (coverOn[k]) {
        tgtW[k] = muCover
        for (let c = 0; c < 3; c++) tgt[k * 3 + c] = coverAt[k * 3 + c]!
        continue
      }
      const f = layer.nearestFace(x[v * 3]!, x[v * 3 + 1]!, x[v * 3 + 2]!)
      if (f.distance > lim[k]!) {
        const m = (f.distance - lim[k]!) / f.distance
        tgtW[k] = mu
        for (let c = 0; c < 3; c++) tgt[k * 3 + c] = x[v * 3 + c]! + (f.point[c]! - x[v * 3 + c]!) * m
      }
    }
    // 局部一步：拉长的边投到静止长度，被压缩的边保持现状（三个坐标都按解之前的位置算）/ local step: stretched edges projected onto their rest length, compressed edges kept as they are (for all three coordinates from the positions before the solve)
    for (let e = 0; e < E; e++) {
      const i = eu[e]!, j = ev[e]!
      const l = Math.hypot(x[i * 3]! - x[j * 3]!, x[i * 3 + 1]! - x[j * 3 + 1]!, x[i * 3 + 2]! - x[j * 3 + 2]!)
      const sc = l > eL[e]! ? eL[e]! / l : 1
      for (let c = 0; c < 3; c++) dEdge[e * 3 + c] = (x[i * 3 + c]! - x[j * 3 + c]!) * sc
    }
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < F; k++) rhs[k] = anchor[k]! * x0[free[k]! * 3 + c]! + tgtW[k]! * tgt[k * 3 + c]!
      for (let e = 0; e < E; e++) {
        const i = eu[e]!, j = ev[e]!
        const dc = dEdge[e * 3 + c]!
        // 位移场平滑：λ·((xi − xj) − (x0i − x0j)) 的目标是 x0 的边向量 / displacement smoothing: λ's target is the edge vector of x0
        const d0 = x0[i * 3 + c]! - x0[j * 3 + c]!
        const a = slot[i]!, b = slot[j]!
        const t = ew[e]! * dc + lam * d0
        if (a >= 0) rhs[a] = rhs[a]! + t
        if (b >= 0) rhs[b] = rhs[b]! - t
        // 固定端搬到右边 / a fixed end goes to the right-hand side
        if (a >= 0 && b < 0) rhs[a] = rhs[a]! + (ew[e]! + lam) * x[j * 3 + c]!
        if (b >= 0 && a < 0) rhs[b] = rhs[b]! + (ew[e]! + lam) * x[i * 3 + c]!
      }
      cg(c)
    }
  }
  coverTargets(true)
  return { x, stillOutside }
}

/**
 * 构建一副身体的全部校正形。返回 rig.json 的条目（offset 相对于返回的块的开头）和要接在 rig.bin 后面的块。
 * Builds every corrective shape of a body. Returns the rig.json entries (offsets relative to the start of the returned
 * block) and the block to be appended to rig.bin.
 */
export function buildCorrectives(rig: Rig, bin: Uint8Array, body: Body, cfg: CorrectiveConfig, log: (m: string) => void = () => {}): { correctives: RigCorrective[]; block: Uint8Array; report: CorrectiveReport[] } {
  const skinPart = body.data.parts.filter((p) => p.tissue === 'skin' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles)[0]
  if (!skinPart) return { correctives: [], block: new Uint8Array(0), report: [] }
  const binding = rig.bindings.find((b) => b.part === skinPart.id)
  if (!binding || binding.offset === undefined) return { correctives: [], block: new Uint8Array(0), report: [] }
  const raw = body.meshes.get(skinPart.id)!
  const nGlb = raw.positions.length / 3
  const W = body.skinSource && body.skinSource.length === nGlb ? weldByIndex(raw.positions, raw.indices, body.skinSource) : weld(raw.positions, raw.indices)
  const first = new Int32Array(W.n).fill(-1)
  for (let i = 0; i < nGlb; i++) if (first[W.map[i]!]! < 0) first[W.map[i]!] = i
  const triL: number[] = []
  for (let t = 0; t < raw.indices.length; t += 3) {
    const a = W.map[raw.indices[t]!]!, b = W.map[raw.indices[t + 1]!]!, c = W.map[raw.indices[t + 2]!]!
    if (a !== b && b !== c && a !== c) triL.push(a, b, c)
  }
  const tri = Uint32Array.from(triL)
  const jointIndex = new Map(rig.joints.map((j, i) => [j.id, i]))
  const entries: RigCorrective[] = []
  const chunks: Uint8Array[] = []
  let off = 0
  const report: CorrectiveReport[] = []
  for (const set of cfg.sets) {
    for (const side of set.sides) {
      const jid = set.driver.joint.replace('{S}', side)
      const ji = jointIndex.get(jid)
      const joint = ji === undefined ? undefined : rig.joints[ji]
      const dof = joint ? joint.dofs.findIndex((d) => d.axis === set.driver.axis) : -1
      if (!joint || dof < 0) {
        log(`corrective ${set.id} ${side}: no driver ${jid} axis ${set.driver.axis}; skipped`)
        continue
      }
      const m = side === 'L' ? 1 : -1
      const G = joint.center as V3
      const A: V3 = [G[0] + m * set.region.centre[0], G[1] + set.region.centre[1], G[2] + set.region.centre[2]]
      const alpha = new Float64Array(W.n)
      for (let v = 0; v < W.n; v++) {
        const x = W.pos[v * 3]!, y = W.pos[v * 3 + 1]!, z = W.pos[v * 3 + 2]!
        if (m * x <= 0) continue
        const r = Math.hypot(x - A[0], y - A[1], z - A[2])
        alpha[v] = 1 - smoothstep((r - set.region.inner) / (set.region.outer - set.region.inner))
      }
      // 深部顶点（静止时离区域中心不远、离皮肤 3 cm 以内）和深层部件 / deep-part vertices (near the region at rest, within 3 cm of the skin) and the deep-layer parts
      const restSkin = new Surface([{ positions: raw.positions, indices: raw.indices }])
      const deepSel: { id: string; verts: number[] }[] = []
      const layerParts: string[] = []
      for (const p of body.data.parts) {
        if (!DEEP.has(p.tissue) || !body.meshes.has(p.id)) continue
        const P = body.meshes.get(p.id)!.positions
        const verts: number[] = []
        for (let v = 0; v < P.length / 3; v++) {
          const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!
          if (Math.hypot(x - A[0], y - A[1], z - A[2]) > set.region.outer + 0.02) continue
          if (restSkin.distance(x, y, z) > 0.03) continue
          verts.push(v)
        }
        if (verts.length) {
          deepSel.push({ id: p.id, verts })
          if (LAYER.has(p.tissue)) layerParts.push(p.id)
        }
      }
      const restLayer = new Surface(layerParts.map((id) => body.meshes.get(id)!))
      const dRest = new Float64Array(W.n)
      for (let v = 0; v < W.n; v++) if (alpha[v]! > 0) dRest[v] = restLayer.distance(W.pos[v * 3]!, W.pos[v * 3 + 1]!, W.pos[v * 3 + 2]!)
      const keyDeltas: Float64Array[] = []
      const keyRads: number[] = []
      const rep: CorrectiveReport = { id: set.id, side, part: skinPart.id, vertices: 0, keys: [] }
      for (const deg of set.keys) {
        const pose = keyPose(rig, side, deg, set.plane)
        const frames = jointFrames(rig.joints, pose)
        const driver = frames.angles[ji!]![dof]!
        const poser = new Poser(rig, bin, pose)
        const posed = poser.part(skinPart.id, raw.positions, 'dqs', false)
        const x0 = new Float64Array(W.n * 3)
        for (let v = 0; v < W.n; v++) for (let k = 0; k < 3; k++) x0[v * 3 + k] = posed[first[v]! * 3 + k]!
        const pts: number[] = []
        for (const d of deepSel) {
          const q = poser.part(d.id, body.meshes.get(d.id)!.positions, 'dqs', { mode: 'tapered' })
          for (const v of d.verts) pts.push(q[v * 3]!, q[v * 3 + 1]!, q[v * 3 + 2]!)
        }
        const layer = new Surface(layerParts.map((id) => ({ positions: poser.part(id, body.meshes.get(id)!.positions, 'dqs', { mode: 'tapered' }), indices: body.meshes.get(id)!.indices })))
        const t0 = performance.now()
        const { x, stillOutside } = relax(W, tri, x0, alpha, Float64Array.from(pts), layer, dRest, poser.jointCenter('T4'), cfg.solver)
        // 换回静止空间：δ = Rᵀ(x − t) − p / back to rest space: δ = Rᵀ(x − t) − p
        const delta = new Float64Array(W.n * 3)
        let mx = 0, sum = 0, cntv = 0
        for (let v = 0; v < W.n; v++) {
          if (!(alpha[v]! > 0)) continue
          const xf = vertexBlend(bin, binding.offset!, first[v]!, poser.dqs)
          const r = xf.r
          const dx = x[v * 3]! - xf.t[0], dy = x[v * 3 + 1]! - xf.t[1], dz = x[v * 3 + 2]! - xf.t[2]
          for (let k = 0; k < 3; k++) delta[v * 3 + k] = r[k]! * dx + r[3 + k]! * dy + r[6 + k]! * dz - W.pos[v * 3 + k]!
          const l = Math.hypot(delta[v * 3]!, delta[v * 3 + 1]!, delta[v * 3 + 2]!)
          mx = Math.max(mx, l)
          if (l > 1e-4) (sum += l), cntv++
        }
        keyDeltas.push(delta)
        keyRads.push(driver)
        rep.keys.push({ degrees: deg, driverRad: Math.round(driver * 1e5) / 1e5, maxMm: Math.round(mx * 1e4) / 10, meanMm: cntv ? Math.round((sum / cntv) * 1e4) / 10 : 0, stillOutside })
        log(`corrective ${set.id} ${side} ${deg}°: driver ${((driver * 180) / Math.PI).toFixed(1)}°, moved up to ${(mx * 1000).toFixed(1)} mm (mean ${cntv ? ((sum / cntv) * 1000).toFixed(1) : 0} mm over ${cntv}), ${stillOutside} deep-part vertices still outside, ${Math.round(performance.now() - t0)} ms`)
      }
      // 关键角必须为正、递增 / key angles must be positive and increasing
      if (keyRads.some((k, i) => !(k > 0) || (i > 0 && !(k > keyRads[i - 1]!)))) {
        log(`corrective ${set.id} ${side}: key driver angles ${keyRads.map((k) => k.toFixed(3)).join(', ')} are not positive and increasing; skipped`)
        continue
      }
      // 存下来：动过的顶点（发布网格的下标，升序）和每个关键姿势的 float32 位移 / stored: the vertices that moved (indices of the shipped mesh, ascending) and a float32 displacement per key pose
      const verts: number[] = []
      for (let i = 0; i < nGlb; i++) {
        const v = W.map[i]!
        if (keyDeltas.some((d) => Math.hypot(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!) > 1e-5)) verts.push(i)
      }
      if (!verts.length) continue
      const bytes = new Uint8Array(verts.length * 4 * (1 + 3 * keyDeltas.length))
      const dv = new DataView(bytes.buffer)
      verts.forEach((i, k) => dv.setUint32(k * 4, i, true))
      let o = verts.length * 4
      for (const d of keyDeltas) {
        for (const i of verts) {
          const v = W.map[i]!
          for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, d[v * 3 + k]!, true)
          o += 12
        }
      }
      entries.push({ part: skinPart.id, joint: jid, dof, keys: keyRads.map((k) => Math.round(k * 1e6) / 1e6), offset: off, count: verts.length, ...(set.why ? { why: set.why } : {}) })
      chunks.push(bytes)
      off += bytes.length
      rep.vertices = verts.length
      report.push(rep)
    }
  }
  const block = new Uint8Array(off)
  let at = 0
  for (const c of chunks) (block.set(c, at), (at += c.length))
  return { correctives: entries, block, report }
}

export { BYTES_PER_VERTEX }
