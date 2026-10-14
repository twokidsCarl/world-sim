// Worker 里的计算：按压（细笼子上的 press()）和体位（全身笼子在转动的重力下走到平衡）。不碰 DOM，也不碰
// Worker 的全局对象，所以测试里可以直接调用（tests/softbody-ui.test.ts）；src/softbody/worker.ts 只是外壳。
// The computations inside the worker: pressing (press() on a fine cage) and posture (the whole-body cage run to
// equilibrium under turned gravity). It touches neither the DOM nor the worker's globals, so tests call it directly
// (tests/softbody-ui.test.ts); src/softbody/worker.ts is just the shell.

import MATERIALS_JSON from '../../data/curated/softbody/materials.json'
import type { AnatomyData, Part } from '../anatomy/types.ts'
import type { Body, RawMesh } from '../../tools/rig/io.ts'
import { bodyInside, buildCage } from '../../tools/softbody/cage.ts'
import { type LoadedSoft, SoftBody, decodeSoft, embedPoints } from './body.ts'
import { type MaterialsFile, skinThickness, solverMaterials } from './materials.ts'
import { type PressRequest, type PressResult, press } from './press.ts'
import { dentMesh } from './dentmesh.ts'
import { type BodyPayload, type MeshPayload, type PartDent, type PartOffsets, type PatchUpdate, type PostureStats, type PressSite, type PressSummary, type PressTarget, type PressTiming, type ProbeSpec, type Posture, type Reply, type SparseOffsets, type Vec3, POSTURE_GRAVITY, denseDisplacement, embeddedDisplacement, supportPlane } from './protocol.ts'
import { buildSiteFrom } from './site.ts'
import type { PointSet } from './solver.ts'

const MATERIALS = MATERIALS_JSON as unknown as MaterialsFile
const DT = 1 / 60
/** 全身笼子的单元（验证用的就是这个）/ the cell of the whole-body cage (the one validated) */
export const WHOLE_CELL = 0.027
/** 体位走到平衡的判据：最大结点速度低于它（m/s；第四阶段全身仰卧的稳态速度约 2e-4）/ the posture's equilibrium test: the largest node speed below this (m/s; the steady supine speed of phase 4 was about 2e-4) */
export const POSTURE_TOL = 2e-4
export const POSTURE_MAX_FRAMES = 2400

/** 按角度加权的顶点法线（与 tools/pipeline/geometry.ts 的 computeNormals 同一算法）/ angle-weighted vertex normals (the algorithm of computeNormals in tools/pipeline/geometry.ts) */
export function vertexNormals(p: ArrayLike<number>, idx: ArrayLike<number>): Float32Array {
  const n = new Float32Array(p.length)
  const clamp = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v)
  for (let t = 0; t < idx.length; t += 3) {
    const ia = 3 * idx[t]!, ib = 3 * idx[t + 1]!, ic = 3 * idx[t + 2]!
    const abx = p[ib]! - p[ia]!, aby = p[ib + 1]! - p[ia + 1]!, abz = p[ib + 2]! - p[ia + 2]!
    const acx = p[ic]! - p[ia]!, acy = p[ic + 1]! - p[ia + 1]!, acz = p[ic + 2]! - p[ia + 2]!
    const bcx = p[ic]! - p[ib]!, bcy = p[ic + 1]! - p[ib + 1]!, bcz = p[ic + 2]! - p[ib + 2]!
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
    const nl = Math.hypot(nx, ny, nz)
    if (nl === 0) continue
    nx /= nl
    ny /= nl
    nz /= nl
    const lab = Math.hypot(abx, aby, abz), lac = Math.hypot(acx, acy, acz), lbc = Math.hypot(bcx, bcy, bcz)
    if (lab === 0 || lac === 0 || lbc === 0) continue
    const wa = Math.acos(clamp((abx * acx + aby * acy + abz * acz) / (lab * lac)))
    const wb = Math.acos(clamp(-(abx * bcx + aby * bcy + abz * bcz) / (lab * lbc)))
    const wc = Math.PI - wa - wb
    for (const [i, w] of [[ia, wa], [ib, wb], [ic, wc]] as const) {
      n[i] = n[i]! + nx * w
      n[i + 1] = n[i + 1]! + ny * w
      n[i + 2] = n[i + 2]! + nz * w
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)
    if (l > 0) (n[i] = n[i]! / l), (n[i + 1] = n[i + 1]! / l), (n[i + 2] = n[i + 2]! / l)
    else n[i + 1] = 1
  }
  return n
}

interface Whole {
  soft: LoadedSoft
  sb: SoftBody
  skinPoints: PointSet
  cageMs: number
}

/** 正在走的一个体位 / A posture being solved */
export interface PostureJob {
  id: number
  posture: Posture
  frames: number
  solveMs: number
  /** 走到这一步为止（最多 budgetMs）；结束时返回 posture-done，否则返回进度 / steps for up to budgetMs; returns posture-done when finished, progress otherwise */
  step(budgetMs: number): Reply
}

export class SoftEngine {
  private payload: BodyPayload | null = null
  private body: Body | null = null
  private normals: Float32Array | null = null
  private inside: ((x: number, y: number, z: number) => boolean) | null = null
  insideMs = 0
  private whole: Whole | null = null
  private readonly postureCache = new Map<Posture, { offsets: Float32Array; parts: PartOffsets[]; stats: PostureStats }>()

  constructor(private readonly now: () => number = () => performance.now()) {}

  init(b: BodyPayload): void {
    this.payload = b
    const parts = b.parts as unknown as Part[]
    const data = { body: b.body, parts } as unknown as AnatomyData
    const meshes = new Map<string, RawMesh>([[b.skin.id, { positions: b.skin.positions, indices: b.skin.indices }]])
    this.body = { dir: '', data, byId: new Map(parts.map((p) => [p.id, p])), meshes, nerves: new Map(), relations: [], patches: [], skinSource: null, inputs: {} }
    this.normals = vertexNormals(b.skin.positions, b.skin.indices)
    this.inside = null
    this.whole = null
    this.postureCache.clear()
  }

  addMeshes(meshes: MeshPayload[]): void {
    const body = this.need()
    for (const m of meshes) body.meshes.set(m.id, { positions: m.positions, indices: m.indices })
    // 换了网格，全身笼子要重建 / new meshes: the whole-body cage is rebuilt
    if (meshes.length) {
      this.whole = null
      this.postureCache.clear()
    }
  }

  meshIds(): string[] {
    return this.body ? [...this.body.meshes.keys()] : []
  }

  private need(): Body {
    if (!this.body || !this.payload) throw new Error('softbody worker: 还没有收到 init / no init received yet')
    return this.body
  }

  /** "是否在体内"的判断：建一次，按压和全身笼子共用 / the inside-the-body test: built once, shared by presses and the whole cage */
  ensureInside(): (x: number, y: number, z: number) => boolean {
    if (!this.inside) {
      const t0 = this.now()
      const s = this.payload!.skin
      this.inside = bodyInside({ positions: s.positions, indices: s.indices })
      this.insideMs = Math.round(this.now() - t0)
    }
    return this.inside
  }

  /** 压入点处的外法线：点击时按三角形插值，否则取最近顶点的法线 / the outward normal at the site: interpolated over the triangle when clicked, else the nearest vertex's */
  outward(site: PressSite): Vec3 {
    const n = this.normals!
    const out: Vec3 = [0, 0, 0]
    if (site.triangle && site.barycentric) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) out[c] = out[c]! + site.barycentric[k]! * n[site.triangle[k]! * 3 + c]!
    else for (let c = 0; c < 3; c++) out[c] = n[site.vertex * 3 + c]!
    const l = Math.hypot(out[0], out[1], out[2]) || 1
    return [out[0] / l, out[1] / l, out[2] / l]
  }

  /**
   * 一次按压。`emit` 收到进度（每隔约 `everyMs` 一次，带此刻的凹陷）。返回 press-done。
   * One press. `emit` receives progress (about every `everyMs`, with the dent as it is then). Returns press-done.
   */
  press(id: number, site: PressSite, probe: ProbeSpec, target: PressTarget, emit: (r: Reply) => void = () => {}, everyMs = 120): Reply {
    const body = this.need()
    const b = this.payload!
    const t0 = this.now()
    const inBody = this.ensureInside()
    const outward = this.outward(site)
    const R = probe.radiusMm / 1000
    emit({ type: 'progress', id, stage: 'cage', frames: 0, elapsedMs: Math.round(this.now() - t0) })
    const S = buildSiteFrom(MATERIALS, body, b.rig, b.rigBin, site.position, outward, R, { inBody })
    // 区域里的皮肤顶点在细笼子里的嵌入：凹陷就是它们的位移 / the skin vertices inside the region, embedded in the fine cage: their displacement is the dent
    const sp = b.skin.positions, reg = S.region
    const verts: number[] = [], pos: number[] = []
    for (let i = 0; i < sp.length / 3; i++) {
      const x = sp[i * 3]!, y = sp[i * 3 + 1]!, z = sp[i * 3 + 2]!
      if (x >= reg[0] && y >= reg[1] && z >= reg[2] && x <= reg[3] && y <= reg[4] && z <= reg[5]) (verts.push(i), pos.push(x, y, z))
    }
    const emb = S.domain.embed(pos)
    const s = S.domain.solver
    const dent = (): SparseOffsets => embeddedDisplacement(emb, verts, s.tets, s.x, S.soft.nodes, 0.005)
    // 细分的显示网格：覆盖半径取区域半边长的 1.2 倍；间距 1.5 mm，但不细于半个单元（细笼子的位移在单元内是线性的，再细没有用）
    // the subdivided display mesh: covering radius 1.2 × the region's half-size; spacing 1.5 mm, but no finer than half a cell
    // (the fine cage's displacement is linear within a cell, so finer would show nothing more)
    const hideRadius = 0.6 * (reg[3] - reg[0])
    const dm = dentMesh(sp, b.skin.indices, site.position, hideRadius, Math.max(0.0015, S.domain.cell / 2), 60000)
    const dmEmb = dm ? S.domain.embed(dm.position) : null
    // 皮肤面上的细分点可能落在被丢弃的表面四面体里（九个采样点都在体外）：沿内法线往里挪一点再嵌入，取那里的位移
    // （粗皮肤顶点在 cage.ts 里用相邻四面体外推，这里是同一个意思）；否则凹陷上会出现位移为零的坑和折痕
    // a subdivided point on the skin can fall in a dropped surface tetrahedron (all nine samples outside): it is moved a
    // little inward along the normal and embedded there, taking the displacement there (cage.ts extrapolates the coarse
    // skin vertices from a neighbouring tetrahedron to the same end); otherwise the dent gets zero-displacement pits and creases
    if (dm && dmEmb) {
      const n = this.normals!, c = S.domain.cell, q = [0, 0, 0]
      for (let i = 0; i < dmEmb.inside.length; i++) {
        if (dmEmb.inside[i]) continue
        q[0] = q[1] = q[2] = 0
        for (let k = 0; k < 3; k++) for (let r = 0; r < 3; r++) q[r] = q[r]! + dm.weights[i * 3 + k]! * n[dm.corners[i * 3 + k]! * 3 + r]!
        const l = Math.hypot(q[0]!, q[1]!, q[2]!) || 1
        for (const step of [0.25, 0.5, 0.75, 1, 1.5]) {
          const e = S.domain.embed([dm.position[i * 3]! - (q[0]! / l) * step * c, dm.position[i * 3 + 1]! - (q[1]! / l) * step * c, dm.position[i * 3 + 2]! - (q[2]! / l) * step * c])
          if (!e.inside[0]) continue
          dmEmb.tet[i] = e.tet[0]!
          dmEmb.bary.set(e.bary.subarray(0, 4), i * 4)
          dmEmb.inside[i] = 1
          break
        }
      }
    }
    let meshSent = false
    let push = 0
    // 皮肤系统里的其他部件（皮下脂肪、皮肤的其他片）在区域里的顶点也跟着细笼子走，否则凹陷一深它们就露出来
    // the vertices inside the region of the integumentary system's other parts (subcutaneous fat, other skin pieces)
    // follow the fine cage too; otherwise they show through once the dent is deep
    const others: { id: string; count: number; verts: number[]; near: Uint8Array; emb: ReturnType<typeof S.domain.embed> }[] = []
    for (const [pid, m] of body.meshes) {
      if (pid === b.skin.id || body.byId.get(pid)?.system !== 'integumentary') continue
      const vs: number[] = [], ps: number[] = []
      for (let i = 0; i < m.positions.length / 3; i++) {
        const x = m.positions[i * 3]!, y = m.positions[i * 3 + 1]!, z = m.positions[i * 3 + 2]!
        if (x >= reg[0] && y >= reg[1] && z >= reg[2] && x <= reg[3] && y <= reg[4] && z <= reg[5]) (vs.push(i), ps.push(x, y, z))
      }
      if (!vs.length) continue
      const near = Uint8Array.from({ length: vs.length }, (_, k) => (Math.hypot(ps[k * 3]! - site.position[0], ps[k * 3 + 1]! - site.position[1], ps[k * 3 + 2]! - site.position[2]) <= hideRadius ? 1 : 0))
      others.push({ id: pid, count: m.positions.length / 3, verts: vs, near, emb: S.domain.embed(ps) })
    }
    // 这些部件的网格和皮肤一样粗，跟不上凹陷的形状，会从凹陷底下露出来：凹陷网格覆盖的范围里，再沿压入方向往里收
    // （与被盖住的皮肤顶点同样的量，只为显示）
    // these parts' meshes are as coarse as the skin's and cannot follow the dent's shape, so they would show through its
    // bottom: within the dent mesh's reach they are also drawn inward along the pressing direction (by the amount the
    // covered skin vertices are; for display only)
    const inward = S.domain.inward
    const partDents = (): PartDent[] =>
      others.map((o) => {
        const d = denseDisplacement(o.emb, s.tets, s.x, S.soft.nodes)
        if (dm) o.near.forEach((f, k) => {
          if (f) for (let r = 0; r < 3; r++) d[k * 3 + r] = d[k * 3 + r]! + inward[r]! * push
        })
        return { id: o.id, count: o.count, vertices: Uint32Array.from(o.verts), offsets: d }
      })
    const patch = (final: boolean): PatchUpdate | undefined => {
      if (!dm || !dmEmb) return undefined
      const d = denseDisplacement(dmEmb, s.tets, s.x, S.soft.nodes)
      let max = 0
      for (let i = 0; i < d.length; i += 3) max = Math.max(max, Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!))
      // 被盖住的皮肤顶点向里收：比凹陷深三倍加 4 mm，最多 3 cm（只为不挡住凹陷）/ covered skin vertices drawn inward: three times the dent plus 4 mm, at most 3 cm (only so they do not hide it)
      push = Math.min(0.03, 3 * max + 0.004)
      const n = this.normals!
      const hide = new Float32Array(dm.hidden.length * 3)
      dm.hidden.forEach((v, k) => {
        for (let r = 0; r < 3; r++) hide[k * 3 + r] = -n[v * 3 + r]! * push
      })
      const withMesh = final || !meshSent
      meshSent = true
      return { ...(withMesh ? { mesh: { position: dm.position, index: dm.index, corners: dm.corners, weights: dm.weights, hidden: dm.hidden } } : {}), dent: d, hide }
    }
    let last = this.now(), first: number | null = null
    const tSolve = this.now()
    const onFrame = (frames: number, depth: number): void => {
      const t = this.now()
      if (t - last < everyMs) return
      last = t
      if (first === null) first = Math.round(t - t0)
      const pu = patch(false)
      emit({ type: 'progress', id, stage: 'solve', frames, elapsedMs: Math.round(t - t0), depthMm: Math.round(depth * 1e5) / 100, msPerFrame: Math.round(((t - tSolve) / frames) * 100) / 100, dent: dent(), ...(pu ? { patch: pu } : {}), parts: partDents() })
    }
    const req: PressRequest = 'forceN' in target ? { forceN: target.forceN } : { depthMm: target.depthMm }
    const r: PressResult = press(S.domain, { kind: probe.kind, radiusMm: probe.radiusMm }, req, { onFrame })
    const solveMs = this.now() - tSolve
    const finalDent = dent()
    if (first === null) first = Math.round(this.now() - t0)
    const result: PressSummary = {
      depthMm: r.depthMm, forceN: r.forceN, meanPressureKPa: r.meanPressureKPa, peakPressureKPa: r.peakPressureKPa, contactAreaMm2: r.contactAreaMm2, peakStrain: r.peakStrain,
      valid: r.valid, flags: r.flags, stoppedBy: r.stoppedBy, gate: r.gate, cellMm: r.cellMm, tissueThicknessMm: S.domain.thickness !== undefined ? Math.round(S.domain.thickness * 1e5) / 100 : null,
      frames: r.frames, converged: r.converged, target, probe, outward,
    }
    const timing: PressTiming = { insideMs: this.insideMs, cageMs: S.ms.cage, solverMs: S.ms.solver, solveMs: Math.round(solveMs), firstDentMs: first, totalMs: Math.round(this.now() - t0), msPerFrame: Math.round((solveMs / Math.max(1, r.frames)) * 100) / 100, nodes: S.stats.nodes, tets: S.stats.tets }
    const pu = patch(true)
    return { type: 'press-done', id, result, dent: finalDent, ...(pu ? { patch: pu } : {}), parts: partDents(), timing }
  }

  /** 全身笼子：第一次用时由已收到的网格建 / the whole-body cage: built from the meshes received, on first use */
  private ensureWhole(): Whole {
    if (this.whole) return this.whole
    const body = this.need()
    const b = this.payload!
    const t0 = this.now()
    const inBody = this.ensureInside()
    const r = buildCage(body, b.rig, b.rigBin, { cell: WHOLE_CELL, gravity: MATERIALS.gravity, materials: solverMaterials(MATERIALS), skinThickness: skinThickness(MATERIALS), inBody })
    const soft = decodeSoft(r.json, r.bin)
    // 与验证时同样的设置：阻尼取材料表，子步数按刚度比的规则（男性全身 13）
    // the settings of the validation: damping from the material table, substeps by the stiffness-ratio rule (13 on the male whole body)
    const sb = new SoftBody(soft, { damping: MATERIALS.damping.rate })
    const skinPoints = soft.embedded.get(soft.data.skin.part)!
    if (skinPoints.tet.length * 3 !== b.skin.positions.length) throw new Error(`softbody worker: 笼子嵌入了 ${skinPoints.tet.length} 个皮肤顶点，皮肤有 ${b.skin.positions.length / 3} 个 / the cage embeds ${skinPoints.tet.length} skin vertices, the skin has ${b.skin.positions.length / 3}`)
    this.whole = { soft, sb, skinPoints, cageMs: Math.round(this.now() - t0) }
    return this.whole
  }

  /** 开始一个体位（缓存里有就直接给出）/ starts a posture (served at once from the cache when present) */
  startPosture(id: number, posture: Posture): PostureJob {
    const engine = this
    const cached = this.postureCache.get(posture)
    if (cached || posture === 'standing') {
      const skinN = this.payload!.skin.positions.length
      const stats: PostureStats = cached ? { ...cached.stats, cached: true } : { posture, frames: 0, converged: true, maxSpeed: 0, msPerFrame: 0, substeps: 0, cageMs: 0, solveMs: 0, nodes: 0, tets: 0, skinMeanMm: 0, skinMaxMm: 0, supportForceN: null, cached: false }
      const offsets = cached ? cached.offsets : new Float32Array(skinN)
      const parts = cached ? cached.parts : []
      return { id, posture, frames: stats.frames, solveMs: 0, step: () => ({ type: 'posture-done', id, posture, offsets: offsets.slice(), parts: parts.map((p) => ({ id: p.id, offsets: p.offsets.slice() })), stats }) }
    }
    const W = this.ensureWhole()
    const s = W.sb.solver
    s.reset()
    s.gravity = [...POSTURE_GRAVITY[posture]]
    const plane = supportPlane(posture, this.payload!.skin.positions)
    s.planes = plane ? [{ n: plane.n, d: plane.d, points: { tet: Uint32Array.from(plane.vertices, (v) => W.skinPoints.tet[v]!), bary: (() => { const o = new Float32Array(plane.vertices.length * 4); plane.vertices.forEach((v, k) => o.set(W.skinPoints.bary.subarray(v * 4, v * 4 + 4), k * 4)); return o })() } }] : []
    const job: PostureJob = {
      id, posture, frames: 0, solveMs: 0,
      step(budgetMs: number): Reply {
        const t0 = engine.now()
        let speed = Infinity
        while (engine.now() - t0 < budgetMs && job.frames < POSTURE_MAX_FRAMES) {
          W.sb.step(DT)
          job.frames++
          if (job.frames >= 30 && job.frames % 5 === 0) {
            speed = s.maxSpeed()
            if (speed < POSTURE_TOL) break
          }
        }
        job.solveMs += engine.now() - t0
        const done = speed < POSTURE_TOL || job.frames >= POSTURE_MAX_FRAMES
        const msPerFrame = Math.round((job.solveMs / Math.max(1, job.frames)) * 100) / 100
        if (!done) return { type: 'progress', id, stage: 'solve', frames: job.frames, elapsedMs: Math.round(job.solveMs), maxSpeed: s.maxSpeed(), msPerFrame }
        const n = W.skinPoints.tet.length
        const all = new Uint32Array(n).map((_, i) => i)
        const d = embeddedDisplacement(W.skinPoints, all, s.tets, s.x, W.soft.nodes)
        const offsets = new Float32Array(n * 3)
        d.vertices.forEach((v, k) => offsets.set(d.offsets.subarray(k * 3, k * 3 + 3), v * 3))
        let sum = 0, max = 0
        for (let i = 0; i < n; i++) {
          const m = Math.hypot(offsets[i * 3]!, offsets[i * 3 + 1]!, offsets[i * 3 + 2]!)
          sum += m
          max = Math.max(max, m)
        }
        const stats: PostureStats = {
          posture, frames: job.frames, converged: speed < POSTURE_TOL, maxSpeed: s.maxSpeed(), msPerFrame, substeps: s.substeps, cageMs: W.cageMs, solveMs: Math.round(job.solveMs),
          nodes: W.soft.data.nodeCount, tets: W.soft.data.tetCount, skinMeanMm: Math.round((sum / n) * 1e5) / 100, skinMaxMm: Math.round(max * 1e5) / 100, supportForceN: plane ? Math.round((s.planeForce[0] ?? 0) * 100) / 100 : null, cached: false,
        }
        // 皮肤的其他片和皮下脂肪（皮肤系统里的部件）也跟着笼子走，否则皮肤一动，它们就从皮肤里露出来
        // the other skin pieces and the subcutaneous fat (parts of the integumentary system) follow the cage too; otherwise they show through as soon as the skin moves
        const parts: PartOffsets[] = []
        const byId = engine.body!.byId
        for (const [pid, m] of engine.body!.meshes) {
          if (pid === engine.payload!.skin.id || byId.get(pid)?.system !== 'integumentary') continue
          const em = embedPoints(W.soft.data.lattice, W.soft.slotTet, W.soft.nodes, W.soft.tets, m.positions)
          parts.push({ id: pid, offsets: denseDisplacement(em, s.tets, s.x, W.soft.nodes) })
        }
        engine.postureCache.set(posture, { offsets, parts, stats })
        return { type: 'posture-done', id, posture, offsets: offsets.slice(), parts: parts.map((p) => ({ id: p.id, offsets: p.offsets.slice() })), stats }
      },
    }
    return job
  }
}
