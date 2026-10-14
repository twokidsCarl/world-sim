// 软组织求解器的验证：在当前几何上跑一组算例，结果写到 data/raw/softbody/out/validation/（不入库），
// 汇总（只有我们的数和文献的数）写到 data/curated/softbody/validation-report.json。
// Validation of the soft-tissue solver: runs a set of cases on the current geometry, writes results to
// data/raw/softbody/out/validation/ (not committed) and a summary (our numbers and the literature's only) to
// data/curated/softbody/validation-report.json.
//
//   bun tools/softbody/validate.ts [numerics|body|forearm|abdomen|breast|all]
//
// 每一组都从 GLB 重新建笼子，不依赖以前的输出。一次只跑一组重的。
// Every group rebuilds its cage from the GLBs and depends on no earlier output. Run one heavy group at a time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import { type LoadedSoft, type MixOptions, SoftBody, decodeSoft, embedPoints } from '../../src/softbody/body.ts'
import type { PointSet, SolverOptions } from '../../src/softbody/solver.ts'
import { computeNormals } from '../pipeline/geometry.ts'
import type { Body, RawMesh } from '../rig/io.ts'
import { jointFrames } from '../rig/pose.ts'
import { type RenderItem, render, sheet } from '../rig/render.ts'
import { couple, press, surfaceSamples } from '../../src/softbody/press.ts'
import { OUT, ROOT, build, loadBody, readMaterials, withRest0 } from './build.ts'
import { bodyInside } from './cage.ts'
import { block, blockDomain, cantilever, framesToWithin, punch } from './numerics.ts'
import { type PhantomCase, buildPhantom, phantom, settlePosture } from './phantom.ts'
import { type Site, buildSite, linkToCoarse } from './site.ts'

const DIR = join(OUT, 'validation')
const REPORT = join(ROOT, 'data', 'curated', 'softbody', 'validation-report.json')
const DT = 1 / 60
const mm = (x: number): number => Math.round(x * 1e5) / 100
const r3 = (x: number): number => Math.round(x * 1000) / 1000

interface Loaded {
  body: Body
  rig: Rig
  soft: LoadedSoft
  skin: RawMesh
  skinPoints: PointSet
  normals: Float32Array
  area: Float32Array
  stats: unknown
}

async function load(bodyId: string, cell: number, region?: string, rest0 = false): Promise<Loaded & { rest0?: { residualsMm: number[]; converged: boolean } }> {
  const { body, rig, rigBin } = await loadBody(bodyId)
  let r = build(body, rig, rigBin, cell, region)
  let info: { residualsMm: number[]; converged: boolean } | undefined
  if (rest0) {
    const z = withRest0(r, console.log)
    r = z.result
    info = { residualsMm: z.residuals.map(mm), converged: z.converged }
  }
  const soft = decodeSoft(r.json, r.bin)
  const skin = body.meshes.get(soft.data.skin.part)!
  const area = new Float32Array(skin.positions.length / 3)
  const p = skin.positions
  for (let t = 0; t < skin.indices.length; t += 3) {
    const a = skin.indices[t]! * 3, b = skin.indices[t + 1]! * 3, c = skin.indices[t + 2]! * 3
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!, vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6
    area[a / 3] = area[a / 3]! + ar
    area[b / 3] = area[b / 3]! + ar
    area[c / 3] = area[c / 3]! + ar
  }
  return { body, rig, soft, skin, skinPoints: soft.embedded.get(soft.data.skin.part)!, normals: computeNormals(skin), area, stats: r.stats, ...(info ? { rest0: info } : {}) }
}

// 不给子步数时用 SoftBody 的规则（刚度比，第四阶段；男性全身 27 mm 笼子上是 13）。第三阶段固定 10 个：皮肤补上以后，
// 髋屈 40° 一帧内弹回的那一步在 10 个子步时发散（速度 56 m/s，然后 NaN），13 个时不发散。
// Without a substep count, the rule of SoftBody (stiffness ratio, phase 4; 13 on the male whole-body 27 mm cage). Phase 3
// fixed 10: with the skin restored, the one-frame snap back from 40° of hip flexion diverges at 10 substeps (56 m/s,
// then NaN) and not at 13.
const newBody = (L: Loaded, substeps?: number, mix: MixOptions = {}, opts: SolverOptions = {}): SoftBody => new SoftBody(L.soft, { ...(substeps ? { substeps } : {}), damping: readMaterials().damping.rate, ...opts }, mix)
/** 第一阶段的做法，留作对照：逐单元体积约束、硬锚点、没有硬化和粘弹性 / phase 1, kept for comparison: per-tetrahedron volume constraints, hard anchors, no stiffening, no viscoelasticity */
const PHASE1: [MixOptions, SolverOptions] = [{ anchors: 'hard', stiffening: false, viscous: false }, { volume: 'tet', damping: 6 }]

/** 皮肤顶点的子集（仍是嵌入点）/ a subset of the skin vertices (still embedded points) */
function subset(L: Loaded, keep: (i: number, x: number, y: number, z: number) => boolean): { points: PointSet; verts: number[] } {
  const verts: number[] = []
  const sp = L.skinPoints, p = L.skin.positions
  for (let i = 0; i < sp.tet.length; i++) {
    // 没有嵌入的顶点（区域笼子之外）权重全零 / vertices not embedded (outside a regional cage) have all-zero weights
    if (sp.bary[i * 4]! === 0 && sp.bary[i * 4 + 1]! === 0 && sp.bary[i * 4 + 2]! === 0 && sp.bary[i * 4 + 3]! === 0) continue
    if (keep(i, p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!)) verts.push(i)
  }
  const points: PointSet = { tet: Uint32Array.from(verts, (v) => sp.tet[v]!), bary: new Float32Array(verts.length * 4) }
  verts.forEach((v, k) => points.bary.set(sp.bary.subarray(v * 4, v * 4 + 4), k * 4))
  return { points, verts }
}

function nearestSkinVertex(L: Loaded, t: [number, number, number], prefer?: [number, number, number]): number {
  let best = -1, bd = Infinity
  const p = L.skin.positions, sp = L.skinPoints
  for (let i = 0; i < p.length / 3; i++) {
    if (sp.bary[i * 4]! === 0 && sp.bary[i * 4 + 1]! === 0 && sp.bary[i * 4 + 2]! === 0 && sp.bary[i * 4 + 3]! === 0) continue
    // prefer：只要法线大致朝这个方向的顶点 / prefer: only vertices whose normal points roughly this way
    if (prefer && L.normals[i * 3]! * prefer[0] + L.normals[i * 3 + 1]! * prefer[1] + L.normals[i * 3 + 2]! * prefer[2] < 0.7) continue
    const d = Math.hypot(p[i * 3]! - t[0], p[i * 3 + 1]! - t[1], p[i * 3 + 2]! - t[2])
    if (d < bd) (bd = d), (best = i)
  }
  return best
}

/**
 * 压头下的接触点：皮肤网格在这里可能很稀（前臂上顶点间距超过 1 cm），所以把附近的三角形细分到约 `spacing`，
 * 取小三角形的重心作为接触点，各带自己的面积。
 * Contact points under a probe: the skin mesh can be sparse here (over 1 cm between vertices on the forearm), so
 * nearby triangles are subdivided to about `spacing` and the centroids of the pieces become contact points, each with
 * its own area.
 */
function contactSamples(L: Loaded, c: [number, number, number], radius: number, spacing = 0.002): { points: PointSet; area: Float32Array } {
  const p = L.skin.positions, idx = L.skin.indices
  const pos: number[] = [], area: number[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3
    const cx = (p[a]! + p[b]! + p[d]!) / 3, cy = (p[a + 1]! + p[b + 1]! + p[d + 1]!) / 3, cz = (p[a + 2]! + p[b + 2]! + p[d + 2]!) / 3
    const e = Math.max(Math.hypot(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!), Math.hypot(p[d]! - p[a]!, p[d + 1]! - p[a + 1]!, p[d + 2]! - p[a + 2]!), Math.hypot(p[d]! - p[b]!, p[d + 1]! - p[b + 1]!, p[d + 2]! - p[b + 2]!))
    if (Math.hypot(cx - c[0], cy - c[1], cz - c[2]) > radius + e) continue
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!, vx = p[d]! - p[a]!, vy = p[d + 1]! - p[a + 1]!, vz = p[d + 2]! - p[a + 2]!
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    const k = Math.max(1, Math.ceil(e / spacing))
    // k² 个小三角形的重心 / the centroids of the k² pieces
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) for (let up = 0; up < 2; up++) {
      if (up && j >= k - i - 1) continue
      const s = (i + (up ? 2 : 1) / 3) / k, r = (j + (up ? 2 : 1) / 3) / k
      const x = p[a]! + ux * s + vx * r, y = p[a + 1]! + uy * s + vy * r, z = p[a + 2]! + uz * s + vz * r
      if (Math.hypot(x - c[0], y - c[1], z - c[2]) > radius) continue
      pos.push(x, y, z)
      area.push(ar / (k * k))
    }
  }
  const em = embedPoints(L.soft.data.lattice, L.soft.slotTet, L.soft.nodes, L.soft.tets, pos)
  return { points: em, area: Float32Array.from(area) }
}

interface IndentRow {
  depthMm: number
  forceN: number
  /** 贴在压头端面上的皮肤面积（几何判断，0.1 mm 以内）/ skin area lying on the probe face (geometric, within 0.1 mm) */
  contactAreaMm2: number
  /** 平均接触压强 = 力 ÷ 接触面积。压强的分布只在笼子单元的尺度上有意义，这里不报。 */
  /** Mean contact pressure = force ÷ contact area. The distribution of pressure is meaningful at the scale of a cage cell only and is not reported here. */
  meanKPa: number
}

/** 平头压头沿皮肤法线逐级压入，每一级等到力稳定。 A flat punch is pressed along the skin normal in stages, each held until the force is steady. */
function indent(L: Loaded, sb: SoftBody, vertex: number, radius: number, depthsMm: number[]): IndentRow[] {
  const p = L.skin.positions
  const site: [number, number, number] = [p[vertex * 3]!, p[vertex * 3 + 1]!, p[vertex * 3 + 2]!]
  const n: [number, number, number] = [L.normals[vertex * 3]!, L.normals[vertex * 3 + 1]!, L.normals[vertex * 3 + 2]!]
  const axis: [number, number, number] = [-n[0], -n[1], -n[2]]
  const { points, area } = contactSamples(L, site, radius * 2.5)
  const s = sb.solver
  s.probe = { shape: { kind: 'flat', center: [...site], axis, radius }, points }
  const rows: IndentRow[] = []
  for (const d of depthsMm) {
    const c = s.probe.shape.center
    for (let k = 0; k < 3; k++) c[k] = site[k]! + axis[k]! * d * 1e-3
    let prev = -1, f = 0
    for (let frame = 0; frame < 240; frame++) {
      sb.step(DT)
      f = Math.hypot(s.probeForce[0], s.probeForce[1], s.probeForce[2])
      if (frame > 20 && Math.abs(f - prev) < 1e-4 * Math.max(0.05, f)) break
      prev = f
    }
    let areaSum = 0
    const q = [0, 0, 0]
    for (let k = 0; k < area.length; k++) {
      s.pointPosition(points, k, q)
      const rx = q[0]! - c[0], ry = q[1]! - c[1], rz = q[2]! - c[2]
      const along = rx * axis[0] + ry * axis[1] + rz * axis[2]
      if (along < 1e-4 && Math.hypot(rx - along * axis[0], ry - along * axis[1], rz - along * axis[2]) < radius) areaSum += area[k]!
    }
    rows.push({ depthMm: d, forceN: r3(f), contactAreaMm2: Math.round(areaSum * 1e7) / 10, meanKPa: areaSum ? r3(f / areaSum / 1000) : 0 })
  }
  s.probe = null
  return rows
}

const displacedSkin = (L: Loaded, sb: SoftBody): Float32Array => {
  const out = new Float32Array(L.skin.positions.length)
  sb.displace(L.skinPoints, L.skin.positions, out)
  return out
}

/** 按位移大小给皮肤上色：0 = 肤色，scale 米 = 红 / colours the skin by displacement: 0 = skin tone, `scale` metres = red */
function skinItem(L: Loaded, pos: Float32Array, scale: number): RenderItem {
  const n = pos.length / 3
  const col = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const d = Math.min(1, Math.hypot(pos[i * 3]! - L.skin.positions[i * 3]!, pos[i * 3 + 1]! - L.skin.positions[i * 3 + 1]!, pos[i * 3 + 2]! - L.skin.positions[i * 3 + 2]!) / scale)
    col.set([222 + 33 * d, 190 - 150 * d, 170 - 140 * d], i * 3)
  }
  return { positions: pos, indices: L.skin.indices, color: [222, 190, 170], vertexColors: col }
}

function maxDisplacement(sb: SoftBody): number {
  let m = 0
  const d = sb.displacement
  for (let i = 0; i < d.length; i += 3) m = Math.max(m, Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!))
  return m
}

function volumesByMaterial(L: Loaded, sb: SoftBody): Record<string, number> {
  const out: Record<string, number> = {}
  L.soft.data.materials.forEach((m, mi) => {
    if (m.rigid) return
    const of = (e: number): boolean => L.soft.tetMaterial[e] === mi
    const v0 = sb.solver.referenceVolume(of)
    if (v0 > 0) out[m.id] = Math.round((sb.solver.volume(of) / v0) * 1e4) / 1e4
  })
  return out
}

/** 仰卧：重力沿 −Z，背部最低点处有一张支撑面 / supine: gravity along −Z with a support plane at the lowest point of the back */
function lieSupine(L: Loaded, sb: SoftBody): void {
  let minZ = Infinity
  const p = L.skin.positions
  const all = subset(L, () => true)
  for (const v of all.verts) minZ = Math.min(minZ, p[v * 3 + 2]!)
  const { points } = subset(L, (_i, _x, _y, z) => z < minZ + 0.05)
  sb.solver.planes = [{ n: [0, 0, 1], d: minZ, points }]
  sb.solver.gravity = [0, 0, -9.81]
}

// ── 全身 / whole body ────────────────────────────────────────────────────────────────────────
async function wholeBody(): Promise<Record<string, unknown>> {
  const L = await load('male', 0.027)
  const out: Record<string, unknown> = { cage: L.stats }
  const sb = newBody(L)
  // 1. 站立平衡：开着物理站 2 秒，结点不应该动 / standing equilibrium: two seconds with physics on, nodes must not move
  let t0 = performance.now()
  for (let f = 0; f < 120; f++) sb.step(DT)
  const perFrame = (performance.now() - t0) / 120
  out.standing = { residualMm: mm(maxDisplacement(sb)), maxSpeed: sb.solver.maxSpeed() }
  out.timing = { substeps: sb.solver.substeps, msPerFrame: r3(perFrame), msPerSubstep: r3(perFrame / sb.solver.substeps), tets: L.soft.data.tetCount, nodes: L.soft.data.nodeCount }
  console.log('standing', JSON.stringify(out.standing), JSON.stringify(out.timing))

  // 2. 惯性：左髋 0.15 秒内屈 40°，随后保持。先不带重力（纯惯性：必须回到零），再带重力（新姿势下组织相对骨的下垂是应有的，不是漂移）。
  // inertia: left hip flexes 40° within 0.15 s, then holds. First without gravity (pure inertia: it must return to zero), then with
  // gravity (in the new pose tissue sags relative to bone as it should; that is not drift).
  const pose = (a: number): ReturnType<typeof jointFrames> => jointFrames(L.rig.joints, { hip_L: [a, 0, 0] })
  // 量两样：皮肤顶点的位移（看得见的），和笼子结点的位移（含几乎全在体外的结点，那些只是数值上的东西）
  // two measures: displacement of skin vertices (what is seen) and of cage nodes (including nodes almost wholly outside the body, which are numerical only)
  const skinMax = (b: SoftBody): number => {
    const pos = displacedSkin(L, b)
    let m = 0
    for (let i = 0; i < pos.length; i += 3) m = Math.max(m, Math.hypot(pos[i]! - L.skin.positions[i]!, pos[i + 1]! - L.skin.positions[i + 1]!, pos[i + 2]! - L.skin.positions[i + 2]!))
    return m
  }
  const p99 = (b: SoftBody): number => {
    const d = b.displacement, mags = new Float32Array(d.length / 3)
    for (let i = 0; i < mags.length; i++) mags[i] = Math.hypot(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!)
    return mags.sort()[Math.floor(mags.length * 0.99)]!
  }
  const swing = (b: SoftBody): { skin: number[]; node: number[]; node99: number[] } => {
    const skin: number[] = [], node: number[] = [], node99: number[] = []
    for (let f = 0; f < 240; f++) {
      b.step(DT, pose(Math.min(1, (f + 1) / 9) * (40 * Math.PI) / 180))
      skin.push(mm(skinMax(b)))
      node.push(mm(maxDisplacement(b)))
      node99.push(mm(p99(b)))
    }
    return { skin, node, node99 }
  }
  const noG = (b: SoftBody): SoftBody => {
    b.solver.gravity = [0, 0, 0]
    b.solver.prestressGravity = null
    return b
  }
  const lag0 = swing(noG(newBody(L))), lagP1 = swing(noG(newBody(L, 10, PHASE1[0], PHASE1[1]))), lagNoBranch = swing(noG(newBody(L, undefined, { viscous: false }))), lag1 = swing(sb)
  const row = (l: { skin: number[]; node: number[]; node99: number[] }): unknown => ({ skinPeak: Math.max(...l.skin), skinAt0_5s: l.skin[29], skinAt1s: l.skin[59], skinAt2s: l.skin[119], skinAt4s: l.skin[239], nodePeak: Math.max(...l.node), node99thPercentilePeak: Math.max(...l.node99), nodeAt4s: l.node[239] })
  out.jiggle = {
    motion: 'hip_L flexion 40° in 0.15 s, then held; corrective displacement in mm: of skin vertices (largest), of cage nodes (largest and 99th percentile)',
    withoutGravity: row(lag0), withoutGravityNoMaxwellBranch: row(lagNoBranch), withoutGravityPhase1Solver: row(lagP1),
    withGravity: { ...(row(lag1) as object), settledSpeed: sb.solver.maxSpeed() },
  }
  console.log('jiggle', JSON.stringify(out.jiggle))
  for (let f = 0; f < 30; f++) sb.step(DT, pose(0))

  // 3. 一万个子步的稳定性：姿势来回摆动、重力方向同时转动 / stability over ten thousand substeps: the pose swings while gravity turns
  let worst = 0, finite = true
  t0 = performance.now()
  for (let f = 0; f < 1000; f++) {
    const t = f * DT
    const g = 2 * Math.PI * t / 7
    sb.step(DT, jointFrames(L.rig.joints, { hip_L: [0.6 * Math.sin(3 * t), 0, 0], elbow_R: [0.9 * (1 - Math.cos(4 * t)), 0], knee_L: [0.5 * (1 - Math.cos(3 * t))] }), [9.81 * Math.sin(g) * 0.7, -9.81 * Math.cos(g), 9.81 * Math.sin(g) * 0.7])
    const m = maxDisplacement(sb)
    if (!Number.isFinite(m)) finite = false
    worst = Math.max(worst, m)
  }
  out.stability = { substeps: 1000 * sb.solver.substeps, finite, largestDisplacementMm: mm(worst), seconds: r3((performance.now() - t0) / 1000) }
  console.log('stability', JSON.stringify(out.stability))

  // 4. 阻尼下的能量衰减：回到站立、静止姿势，能量应单调下降到零附近 / energy decay under damping: back to standing at rest, the energy must fall towards zero
  sb.solver.gravity = [0, -9.81, 0]
  const energy: number[] = []
  for (let f = 0; f < 180; f++) {
    sb.step(DT, jointFrames(L.rig.joints, {}))
    if (f % 15 === 14) energy.push(sb.solver.energy().total)
  }
  let rises = 0
  for (let i = 3; i < energy.length; i++) if (energy[i]! > energy[i - 1]! * 1.001 + 1e-9) rises++
  out.energyDecay = { joulesEveryQuarterSecond: energy.map((e) => Number(e.toExponential(3))), risesAfterFirstHalfSecond: rises, residualMm: mm(maxDisplacement(sb)) }
  console.log('energy', JSON.stringify(out.energyDecay))

  // 5. 仰卧 / supine
  const sup = newBody(L)
  lieSupine(L, sup)
  for (let f = 0; f < 240; f++) sup.step(DT)
  const pos = displacedSkin(L, sup)
  const front = subset(L, (i, x, y, z) => Math.abs(x) < 0.08 && y > 0.95 && y < 1.12 && L.normals[i * 3 + 2]! > 0.8 && z > 0)
  let dz = 0, dy = 0
  for (const v of front.verts) (dz += pos[v * 3 + 2]! - L.skin.positions[v * 3 + 2]!), (dy += pos[v * 3 + 1]! - L.skin.positions[v * 3 + 1]!)
  out.supine = {
    abdomenFrontMeanDisplacementMm: { anterior: mm(dz / front.verts.length), cranial: mm(dy / front.verts.length), vertices: front.verts.length },
    largestDisplacementMm: mm(maxDisplacement(sup)), volumeRatioByMaterial: volumesByMaterial(L, sup), supportForceN: r3(sup.solver.planeForce[0] ?? 0), settledSpeed: sup.solver.maxSpeed(),
  }
  console.log('supine', JSON.stringify(out.supine))
  const base = skinItem(L, L.skin.positions, 0.02), lying = skinItem(L, pos, 0.02)
  const view = { yaw: 90, center: [0, 1.05, 0.05] as [number, number, number], halfHeight: 0.42, width: 420, height: 560 }
  sheet([render([base], view), render([lying], view), render([base], { ...view, yaw: 0 }), render([lying], { ...view, yaw: 0 })], 4).save(join(DIR, 'male-standing-vs-supine.png'))

  // 6. 全身粗笼子上的压入（与细笼子上的 press() 对照，看网格依赖）；第二行是第一阶段的硬锚点
  // indentation on the coarse whole-body cage (against press() on a fine cage, to see the mesh dependence); the second line uses the hard anchors of phase 1
  const sites = forearmSites(L)
  out.forearmCoarse = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, indent(L, newBody(L), v, 0.013, [3.2, 4.5])]))
  out.forearmCoarsePhase1 = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, indent(L, newBody(L, 10, PHASE1[0], PHASE1[1]), v, 0.013, [3.2, 4.5])]))
  console.log('forearm coarse', JSON.stringify(out.forearmCoarse), JSON.stringify(out.forearmCoarsePhase1))

  // 7. 肌肉激活：左肱二头肌 / muscle activation: left biceps
  const mb = newBody(L)
  const names = new Map(L.body.data.parts.map((p) => [p.id, p.name]))
  const act = new Float32Array(L.soft.data.muscles.length)
  const hit: string[] = []
  L.soft.data.muscles.forEach((m, i) => {
    if (/biceps brachii/i.test(names.get(m.part) ?? '') && /left/i.test(names.get(m.part) ?? '') && m.fibre) (act[i] = 1), hit.push(names.get(m.part)!)
  })
  mb.solver.setActivation(act)
  for (let f = 0; f < 120; f++) mb.step(DT)
  const mi = new Set(hit.length ? L.soft.data.muscles.map((m, i) => (act[i] ? i : -1)).filter((i) => i >= 0) : [])
  const ofMuscle = (e: number): boolean => mi.has(L.soft.tetMuscle[e]!)
  const mpos = displacedSkin(L, mb)
  let bulge = 0
  for (let i = 0; i < mpos.length / 3; i++) {
    const d = (mpos[i * 3]! - L.skin.positions[i * 3]!) * L.normals[i * 3]! + (mpos[i * 3 + 1]! - L.skin.positions[i * 3 + 1]!) * L.normals[i * 3 + 1]! + (mpos[i * 3 + 2]! - L.skin.positions[i * 3 + 2]!) * L.normals[i * 3 + 2]!
    bulge = Math.max(bulge, d)
  }
  // 子步加到 40 再算一次体积：看体积误差是不是求解没收敛造成的 / the volume once more with 40 substeps: is the volume error a matter of convergence?
  const mb2 = newBody(L, 40)
  const mbP1 = newBody(L, 10, PHASE1[0], PHASE1[1])
  mbP1.solver.setActivation(act)
  for (let f = 0; f < 120; f++) mbP1.step(DT)
  out.muscleVolumeRatioPhase1Solver = hit.length ? Math.round((mbP1.solver.volume(ofMuscle) / mbP1.solver.referenceVolume(ofMuscle)) * 1e4) / 1e4 : null
  mb2.solver.setActivation(act)
  for (let f = 0; f < 60; f++) mb2.step(DT)
  out.muscleVolumeRatio40Substeps = hit.length ? Math.round((mb2.solver.volume(ofMuscle) / mb2.solver.referenceVolume(ofMuscle)) * 1e4) / 1e4 : null
  out.muscle = { activated: hit, tets: L.soft.tetMuscle.reduce((s, m) => s + (mi.has(m) ? 1 : 0), 0), largestOutwardSkinDisplacementMm: mm(bulge), muscleVolumeRatio: hit.length ? Math.round((mb.solver.volume(ofMuscle) / mb.solver.referenceVolume(ofMuscle)) * 1e4) / 1e4 : null }
  console.log('muscle', JSON.stringify(out.muscle))
  return out
}

/** 前臂上的两个压入点：近端三分之一（肌腹）和中段，掌侧。 Two sites on the forearm: the proximal third (muscle bellies) and mid-forearm, volar side. */
function forearmSites(L: Loaded): Record<string, number> {
  const c = (id: string): [number, number, number] => L.rig.joints.find((j) => j.id === id)!.center
  const e = c('elbow_L'), w = c('wrist_L')
  const at = (t: number): [number, number, number] => [e[0] + (w[0] - e[0]) * t, e[1] + (w[1] - e[1]) * t, e[2] + (w[2] - e[2]) * t]
  // 静止姿势下前臂掌侧朝前（+Z）/ in the rest pose the volar side of the forearm faces forward (+Z)
  return { proximalThird: nearestSkinVertex(L, at(0.3), [0, 0, 1]), middle: nearestSkinVertex(L, at(0.5), [0, 0, 1]) }
}

// ── 解析算例：锁死、收敛、Jacobi / analytic cases: locking, convergence, Jacobi ───────────────
async function numerics(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const locking: unknown[] = []
  for (const cells of [2, 4]) for (const nu of [0.3, 0.49]) for (const volume of ['tet', 'node'] as const) locking.push({ cellsAcross: cells, poisson: nu, volume, deflectionOverBeamTheory: r3(cantilever(cells, nu, volume).ratio) })
  out.cantilever = { what: 'tip deflection of a cantilever under its own weight over Euler–Bernoulli theory (which has no ν in it)', rows: locking }
  console.log('locking', JSON.stringify(locking))
  // 平头压头，a = 12 mm，方块 72 × 48 × 72 mm（a/h = 0.25），F ÷ 2·E·a·δ/(1 − ν²)
  const rows: unknown[] = []
  for (const [cell, substeps, volume] of [[0.012, 16, 'node'], [0.012, 32, 'node'], [0.008, 32, 'node'], [0.006, 32, 'node'], [0.006, 64, 'node'], [0.012, 16, 'tet'], [0.012, 32, 'tet'], [0.006, 32, 'tet'], [0.006, 64, 'tet']] as const) {
    const p = punch(cell, { substeps, volume, size: 0.072, depth: 0.048, maxFrames: 600 })
    rows.push({ cellMm: cell * 1000, substeps, volume, forceOverHalfSpace: r3(p.ratio), frames: p.frames })
  }
  out.punchDynamicSolver = { what: 'flat punch a = 12 mm on a bonded block 72 × 48 × 72 mm, ν = 0.49, real density: F ÷ 2·E·a·δ/(1 − ν²)', rows }
  console.log('punch', JSON.stringify(rows))
  // press()：质量缩放的准静态解，有无边缘补偿 / press(): the mass-scaled quasi-static solve, with and without edge compensation
  const pr: unknown[] = []
  for (const cell of [0.008, 0.006, 0.004, 0.003]) for (const edge of [true, false]) {
    const { d, young, nu, nodes } = blockDomain(cell, 0.072, 0.048, 0.012)
    const t0 = performance.now()
    const r = press(d, { kind: 'flat', radiusMm: 12 }, { depthMm: 1 }, { edgeCompensation: edge })
    pr.push({ cellMm: cell * 1000, radiusOverCell: 12 / (cell * 1000), edgeCompensation: edge, forceOverHalfSpace: r3(r.forceN / ((2 * young * 0.012 * 1e-3) / (1 - nu * nu))), frames: r.frames, seconds: r3((performance.now() - t0) / 1000), nodes, centrePressureOverMean: r3(r.pressureProfile[0]!.kPa / r.meanPressureKPa) })
  }
  out.pressOnBlock = { what: 'the same case through press(); the half-space centre pressure is half the mean', rows: pr }
  console.log('press', JSON.stringify(pr))
  // Jacobi（质量分摊）与 Gauss–Seidel：悬臂梁的静力解随子步数的变化；压入算例里到最终值 ±2% 要多少遍
  // Jacobi (mass splitting) against Gauss–Seidel: the static cantilever answer against the number of substeps; sweeps needed in the punch case to stay within ±2 % of the final value
  const gsBeam = cantilever(2, 0.49, 'node', 20)
  const jb: unknown[] = [{ mode: 'gs', substeps: 20, deflectionOverBeamTheory: r3(gsBeam.ratio), sweeps: gsBeam.frames * 20 }]
  for (const sub of [20, 40, 80, 160]) {
    const j = cantilever(2, 0.49, 'node', sub, 0, 2, 'jacobi', 6000)
    jb.push({ mode: 'jacobi', substeps: sub, deflectionOverBeamTheory: r3(j.ratio), errorAgainstGs: r3(j.ratio / gsBeam.ratio - 1), sweeps: j.frames * sub })
  }
  const jac: unknown[] = []
  for (const [mode, substeps] of [['gs', 32], ['jacobi', 32], ['jacobi', 128]] as const) {
    const p = punch(0.008, { substeps, mode, size: 0.072, depth: 0.048, maxFrames: mode === 'gs' ? 600 : 1500 })
    jac.push({ mode, substeps, forceOverHalfSpace: r3(p.ratio), frames: p.frames, sweepsToWithin2PercentOfOwnFinal: framesToWithin(p.history) * substeps, msPerSweep: r3(p.msPerFrame / substeps) })
  }
  out.jacobi = { what: 'the Jacobi mode with mass splitting against Gauss–Seidel: (a) static cantilever, cell = half the depth, ν = 0.49; (b) flat punch, cell 8 mm (700 nodes)', cantilever: jb, punch: jac }
  console.log('jacobi', JSON.stringify(out.jacobi))
  return out
}

/** 压入点周围细分过的一片皮肤（三角形汤），画凹痕用 / a subdivided patch of skin round a site (a triangle soup), for drawing the dent */
function dentPatch(S: Site, skin: RawMesh, radius: number, spacing: number): { rest: Float32Array; pos: Float32Array; indices: Uint32Array } {
  const p = skin.positions, idx = skin.indices, site = S.domain.site
  const rest: number[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3
    const far = [a, b, d].every((v) => Math.hypot(p[v]! - site[0], p[v + 1]! - site[1], p[v + 2]! - site[2]) > radius * 1.6)
    if (far) continue
    const e = Math.max(Math.hypot(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!), Math.hypot(p[d]! - p[a]!, p[d + 1]! - p[a + 1]!, p[d + 2]! - p[a + 2]!))
    const k = Math.max(1, Math.ceil(e / spacing))
    const at = (i: number, j: number): [number, number, number] => [0, 1, 2].map((c) => p[a + c]! + ((p[b + c]! - p[a + c]!) * i + (p[d + c]! - p[a + c]!) * j) / k) as [number, number, number]
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      rest.push(...at(i, j), ...at(i + 1, j), ...at(i, j + 1))
      if (j < k - i - 1) rest.push(...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j + 1))
    }
  }
  const R = Float32Array.from(rest), em = S.domain.embed(R), s = S.domain.solver
  const pos = Float32Array.from(R)
  for (let i = 0; i < R.length / 3; i++) {
    if (!em.inside[i]) continue
    for (let k = 0; k < 4; k++) {
      const n = s.tets[em.tet[i]! * 4 + k]! * 3, w = em.bary[i * 4 + k]!
      for (let c = 0; c < 3; c++) pos[i * 3 + c] = pos[i * 3 + c]! + w * (s.x[n + c]! - s.ref[n + c]!)
    }
  }
  return { rest: R, pos, indices: Uint32Array.from({ length: R.length / 3 }, (_, i) => i) }
}

function patchItem(rest: Float32Array, pos: Float32Array, indices: Uint32Array, scale: number): RenderItem {
  const n = pos.length / 3, col = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const d = Math.min(1, Math.hypot(pos[i * 3]! - rest[i * 3]!, pos[i * 3 + 1]! - rest[i * 3 + 1]!, pos[i * 3 + 2]! - rest[i * 3 + 2]!) / scale)
    col.set([222 + 33 * d, 190 - 150 * d, 170 - 140 * d], i * 3)
  }
  return { positions: pos, indices, color: [222, 190, 170], vertexColors: col }
}

const pressRow = (r: ReturnType<typeof press>): Record<string, unknown> => ({ depthMm: r.depthMm, forceN: r.forceN, meanPressureKPa: r.meanPressureKPa, peakPressureKPa: r.peakPressureKPa, contactAreaMm2: r.contactAreaMm2, peakStrain: r.peakStrain, strainAt2_5_10mm: [2, 5, 10].map((z) => r3(r.strainAtDepth(z))), valid: r.valid, flags: r.flags, frames: r.frames })

// ── 前臂：细笼子上的 press()，对照 forearm2026 / the forearm: press() on a fine cage against forearm2026 ──────────
async function forearm(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const L = await load('male', 0.027)
  const { body, rig } = L
  const rigBin = (await loadBody('male')).rigBin
  let t0 = performance.now()
  const inBody = bodyInside(L.skin)
  out.insideTestBuildMs = Math.round(performance.now() - t0)
  const sites = forearmSites(L)
  const at = (v: number): { site: [number, number, number]; normal: [number, number, number] } => ({ site: [L.skin.positions[v * 3]!, L.skin.positions[v * 3 + 1]!, L.skin.positions[v * 3 + 2]!], normal: [L.normals[v * 3]!, L.normals[v * 3 + 1]!, L.normals[v * 3 + 2]!] })
  const published: Record<string, [number, number]> = { proximalThird: [3.2, 1.43], middle: [4.5, 2.83] }
  for (const [name, v] of Object.entries(sites)) {
    const { site, normal } = at(v)
    const res: Record<string, unknown> = { published: { depthMm: published[name]![0], forceN: published[name]![1] } }
    for (const cell of name === 'proximalThird' ? [0.0065, 0.0043] : [0.0043]) {
      const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell, inBody })
      t0 = performance.now()
      const rows = [1.6, 3.2, 4.5].map((d) => pressRow(press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: d })))
      res[`cell${(cell * 1000).toFixed(2)}mm`] = { tets: S.stats.tets, nodes: S.stats.nodes, buildMs: S.ms, massScale: r3(S.massScale), tissueThicknessMm: mm(S.domain.thickness ?? 0), solveSeconds: r3((performance.now() - t0) / 1000), rows }
      console.log(name, cell, JSON.stringify(res[`cell${(cell * 1000).toFixed(2)}mm`]))
      if (cell === 0.0043 && name === 'proximalThird') {
        // 两级耦合：细笼子的反力加到粗笼子上，粗笼子的位移回到细笼子的切口 / two-level coupling: the fine reaction goes to the coarse cage, whose displacement returns to the cuts of the fine one
        const coarse = newBody(L).solver
        coarse.gravity = [0, 0, 0]
        coarse.prestressGravity = null
        const link = linkToCoarse(S, L.soft)
        const before = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: 3.2 })
        const shift = couple(S.domain, coarse, link, before.forceN)
        const after = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: 3.2 })
        res.twoLevel = { cutNodes: link.nodes.length, forceBeforeN: before.forceN, largestCutNodeDisplacementMm: mm(shift), forceAfterN: after.forceN }
        console.log('two-level', JSON.stringify(res.twoLevel))
        S.domain.solver.pinOffset = null
        // 渲染：压到 8 mm / render: pressed to 8 mm
        const s = S.domain.solver, a = 0.013, n = S.domain.inward
        s.probe = { shape: { kind: 'flat', center: [site[0] + n[0] * 0.008, site[1] + n[1] * 0.008, site[2] + n[2] * 0.008], axis: [...n], radius: a }, points: S.domain.samples.points }
        for (let f = 0; f < 200; f++) s.step(DT)
        const patch = dentPatch(S, L.skin, 0.045, 0.003)
        const view = { yaw: 60, pitch: 10, center: site, halfHeight: 0.07, width: 520, height: 520 }
        const base = skinItem(L, L.skin.positions, 0.006)
        sheet([render([base], view), render([base, patchItem(patch.rest, patch.pos, patch.indices, 0.008)], view), render([patchItem(patch.rest, patch.pos, patch.indices, 0.008)], { ...view, yaw: 150, halfHeight: 0.05 })], 3).save(join(DIR, 'forearm-pressed-8mm.png'))
        s.probe = null
        const back: number[] = []
        for (let f = 0; f < 90; f++) {
          s.step(DT)
          if (f % 15 === 14) {
            let m = 0
            for (let i = 0; i < s.nodeCount * 3; i++) m = Math.max(m, Math.abs(s.x[i]! - s.ref[i]!))
            back.push(mm(m))
          }
        }
        res.reboundMmEveryQuarterSecondPseudoTime = back
      }
    }
    // 表 4 里皮肤的另一组候选参数：neo-Hookean C10 = 120 kPa（E = 720 kPa），以及没有皮肤刚度的情形，看皮肤的影响有多大
    // the other skin candidate of Table 4: neo-Hookean C10 = 120 kPa (E = 720 kPa), and no skin stiffness at all, to see how much the skin matters
    for (const [vn, mix] of [['skinNeoHookean720kPa', { scale: { skin: 720000 / 56400 }, kappa: { skin: 0 } }], ['withoutSkinStiffness', { skin: 'none' }]] as [string, MixOptions][]) {
      const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell: 0.0065, inBody, mix })
      res[vn] = { cellMm: 6.5, rows: [3.2, 4.5].map((d) => pressRow(press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: d }))) }
      console.log(name, vn, JSON.stringify((res[vn] as { rows: { depthMm: number; forceN: number }[] }).rows.map((r) => [r.depthMm, r.forceN])))
    }
    out[name] = res
  }
  // 疼痛工具的小压头：半径 5.64 mm（100 mm²），5 N 和 50 N / the pain tool's small probe: radius 5.64 mm (100 mm²), 5 N and 50 N
  {
    const { site, normal } = at(sites.proximalThird!)
    const S = buildSite(body, rig, rigBin, site, normal, 0.00564, { inBody })
    t0 = performance.now()
    const r5 = press(S.domain, { kind: 'flat', radiusMm: 5.64 }, { forceN: 5 })
    const patch = dentPatch(S, L.skin, 0.02, 0.0012)
    const r50 = press(S.domain, { kind: 'flat', radiusMm: 5.64 }, { forceN: 50 })
    out.painProbe = { radiusMm: 5.64, cellMm: mm(S.domain.cell), tets: S.stats.tets, buildMs: S.ms, tissueThicknessMm: mm(S.domain.thickness ?? 0), solveSeconds: r3((performance.now() - t0) / 1000), at5N: { ...pressRow(r5), pressureProfile: r5.pressureProfile }, at50N: { ...pressRow(r50), pressureProfile: r50.pressureProfile } }
    console.log('pain probe', JSON.stringify(out.painProbe))
    // 5 N 时的凹痕特写：左 = 静止，中 = 压入后斜看，右 = 沿前臂轴向看剖面 / close-up of the dent at 5 N: rest, pressed (oblique), pressed (looking along the forearm)
    const view = { yaw: 40, pitch: 35, center: site, halfHeight: 0.022, width: 520, height: 520 }
    const flat = patchItem(patch.rest, patch.rest, patch.indices, 0.004), dent = patchItem(patch.rest, patch.pos, patch.indices, 0.004)
    sheet([render([flat], view), render([dent], view), render([dent], { ...view, yaw: 90, pitch: 2 })], 3).save(join(DIR, 'probe-dent-closeup.png'))
  }
  return out
}

// ── 腹部：半球头压头对照 Remus 2024 / the abdomen: a hemispherical tip against Remus 2024 ────────────────
async function abdomen(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const L = await load('male', 0.027)
  const rigBin = (await loadBody('male')).rigBin
  const inBody = bodyInside(L.skin)
  // 该文表 4 的平均力–位移多项式（牛，毫米）/ the mean force–displacement polynomials of its Table 4 (N, mm)
  const fits: Record<string, { max: number; f: (d: number) => number; rmse: number }> = {
    R2: { max: 30, rmse: 0.963, f: (d) => -2.937e-6 * d ** 4 + 2.59e-4 * d ** 3 + 2.479e-3 * d * d + 0.2163 * d },
    R3: { max: 30, rmse: 0.512, f: (d) => 8.604e-3 * d * d + 0.126 * d },
  }
  const c = (id: string): [number, number, number] => L.rig.joints.find((j) => j.id === id)!.center
  // R2：腹直肌中央、脐的高度；R3：再往下约 6 cm（结节间平面以下 1 cm）。位置按关节高度估计。
  // R2: centre of the rectus abdominis at the level of the umbilicus; R3: about 6 cm lower (1 cm below the intertubercular plane). Heights estimated from joints.
  const yUmb = (c('L3')[1] + c('L5')[1]) / 2
  const sitesAt: Record<string, [number, number, number]> = { R2: [-0.04, yUmb, c('L3')[2] + 0.15], R3: [-0.04, yUmb - 0.06, c('L3')[2] + 0.15] }
  const depths = [5, 10, 15, 20, 25, 30]
  for (const [name, target] of Object.entries(sitesAt)) {
    const v = nearestSkinVertex(L, target, [0, 0, 1])
    const site: [number, number, number] = [L.skin.positions[v * 3]!, L.skin.positions[v * 3 + 1]!, L.skin.positions[v * 3 + 2]!]
    const normal: [number, number, number] = [L.normals[v * 3]!, L.normals[v * 3 + 1]!, L.normals[v * 3 + 2]!]
    const variants: [string, MixOptions][] = name === 'R2' ? [['default', {}], ['withoutStiffening', { stiffening: false }], ['softerWallAndContents', { scale: { abdomen: 7500 / 10500 }, kappa: { abdomen: 5.8 } }]] : [['default', {}]]
    const res: Record<string, unknown> = { site }
    for (const [vn, mix] of variants) {
      const S = buildSite(L.body, L.rig, rigBin, site, normal, 0.01, { cell: 0.007, extent: 0.065, inBody, mix })
      const t0 = performance.now()
      const rows = depths.map((d) => {
        const r = press(S.domain, { kind: 'hemisphere', radiusMm: 10 }, { depthMm: d }, { maxFrames: 300 })
        console.log(name, vn, d, r.forceN, r3(fits[name]!.f(d)), r.flags.join('+'))
        return { ...pressRow(r), publishedMeanN: r3(fits[name]!.f(d)), ratio: r3(r.forceN / fits[name]!.f(d)) }
      })
      res[vn] = { tets: S.stats.tets, buildMs: S.ms, tissueThicknessMm: mm(S.domain.thickness ?? 0), byMaterial: S.stats.byMaterial, solveSeconds: r3((performance.now() - t0) / 1000), rows }
    }
    res.publishedRmse = fits[name]!.rmse
    out[name] = res
  }
  return out
}

// ── 女性胸部：乳房在站立、仰卧、俯卧之间的重力位移 / female chest: gravity displacement of the breast between standing, supine and prone ──
async function breast(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const images: ReturnType<typeof render>[] = [], chest: ReturnType<typeof render>[] = []
  for (const cell of [0.014]) {
    const L = await load('female', cell, 'chest')
    // 乳头处：每侧乳房最靠前的皮肤顶点 / at the nipple: the most anterior skin vertex of each breast
    const nip = (side: number): number => {
      let best = -1, bz = -Infinity
      const p = L.skin.positions
      for (const v of subset(L, (_i, x, y) => x * side > 0.04 && x * side < 0.16 && y > 1.05 && y < 1.3).verts) if (p[v * 3 + 2]! > bz) (bz = p[v * 3 + 2]!), (best = v)
      return best
    }
    const nipples = [nip(1), nip(-1)]
    const breastMat = new Set(L.soft.data.materials.map((m, i) => (m.id.startsWith('breast') ? i : -1)).filter((i) => i >= 0))
    const ofBreast = (e: number): boolean => breastMat.has(L.soft.tetMaterial[e]!)
    // 乳房内的"标志点"：乳房四面体的结点，按所属乳房四面体的体积加权 / "landmarks" inside the breast: nodes of breast tetrahedra, weighted by the breast volume they carry
    const weight = new Float64Array(L.soft.data.nodeCount)
    let breastTets = 0, litres = 0
    for (let e = 0; e < L.soft.data.tetCount; e++) if (ofBreast(e)) {
      breastTets++
      litres += ((cell ** 3 / 12) * L.soft.tetFill[e]!) / 255 * 1000
      for (let k = 0; k < 4; k++) weight[L.soft.tets[e * 4 + k]!] = weight[L.soft.tets[e * 4 + k]!]! + L.soft.tetFill[e]! / 255
    }
    const res: Record<string, unknown> = { cage: L.stats, breastTets, breastLitresBothSides: r3(litres) }
    const softest = 166.6 / 357.1
    const variants: [string, MixOptions, SolverOptions][] = [
      ['phase2', {}, {}],
      ['phase2SoftestPublished', { scale: { breast_fat: softest, breast_gland: softest } }, {}],
      ['phase2WithoutSkinStiffness', { skin: 'none' }, {}],
      ['phase1NumericsAndModuli', { ...PHASE1[0], scale: { breast_fat: 2550 / 1071, breast_gland: 2880 / 1071 } }, PHASE1[1]],
    ]
    for (const [name, mix, opts] of variants) {
      if (cell !== 0.014 && name !== 'phase2') continue
      const sb = newBody(L, 12, mix, opts)
      const settle = (g: [number, number, number]): Float64Array => {
        sb.solver.gravity = g
        let prev = Infinity
        for (let f = 0; f < 600; f++) {
          sb.step(DT)
          if (f % 30 === 29) {
            const m = maxDisplacement(sb)
            if (Math.abs(m - prev) < 2e-5) break
            prev = m
          }
        }
        return Float64Array.from(sb.solver.x)
      }
      const stand = settle([0, -9.81, 0]), pos0 = displacedSkin(L, sb)
      const standing = mm(maxDisplacement(sb))
      const sup = settle([0, 0, -9.81]), posS = displacedSkin(L, sb)
      const volSup = sb.solver.volume(ofBreast) / sb.solver.referenceVolume(ofBreast)
      const pro = settle([0, 0, 9.81]), posP = displacedSkin(L, sb)
      const meanShift = (a: Float64Array, b: Float64Array): number => {
        let s = 0, w = 0
        for (let i = 0; i < weight.length; i++) if (weight[i]! > 0) (s += weight[i]! * Math.hypot(a[i * 3]! - b[i * 3]!, a[i * 3 + 1]! - b[i * 3 + 1]!, a[i * 3 + 2]! - b[i * 3 + 2]!)), (w += weight[i]!)
        return mm(s / w)
      }
      const nipShift = (a: Float32Array, b: Float32Array): unknown => nipples.map((v, i) => ({ side: i === 0 ? 'L' : 'R', lateral: mm((b[v * 3]! - a[v * 3]!) * (i === 0 ? 1 : -1)), cranial: mm(b[v * 3 + 1]! - a[v * 3 + 1]!), anterior: mm(b[v * 3 + 2]! - a[v * 3 + 2]!), magnitude: mm(Math.hypot(b[v * 3]! - a[v * 3]!, b[v * 3 + 1]! - a[v * 3 + 1]!, b[v * 3 + 2]! - a[v * 3 + 2]!)) }))
      res[name] = {
        standingResidualMm: standing,
        standingToSupine: { nipple: nipShift(pos0, posS), meanBreastTissueMm: meanShift(stand, sup) },
        standingToProne: { nipple: nipShift(pos0, posP), meanBreastTissueMm: meanShift(stand, pro) },
        proneToSupine: { nipple: nipShift(posP, posS), meanBreastTissueMm: meanShift(pro, sup) },
        breastVolumeRatioSupine: Math.round(volSup * 1e4) / 1e4,
      }
      console.log(cell, name, JSON.stringify(res[name]))
      if (cell === 0.014 && (name === 'phase2' || name === 'phase2SoftestPublished')) {
        const view = { yaw: 90, center: [0, 1.18, 0.08] as [number, number, number], halfHeight: 0.2, width: 380, height: 420 }
        const row = [pos0, posS, posP].flatMap((p) => [render([skinItem(L, p, 0.03)], view), render([skinItem(L, p, 0.03)], { ...view, yaw: 0 })])
        images.push(...row)
        if (name === 'phase2') chest.push(row[0]!, row[2]!, row[3]!)
      }
    }
    out[`cell${cell * 1000}mm`] = res
  }
  // 每行：站立、仰卧、俯卧，各有侧面和正面；第一行是缺省材料，第二行是文献里最软的乳房 / each row: standing, supine, prone, side and front; row 1 the default material, row 2 the softest published breast
  sheet(images, 6).save(join(DIR, 'female-breast-standing-supine-prone.png'))
  sheet(chest, 3).save(join(DIR, 'female-chest-standing-vs-supine.png'))
  return out
}

// ── 第三阶段：站立平衡（零重力参考的反解）/ phase 3: standing equilibrium (the inverse solve for the zero-gravity reference) ──
async function equilibrium(): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const L = await load('male', 0.027, undefined, true)
  const out: Record<string, unknown> = { cell: 0.027, nodes: L.soft.data.nodeCount, tets: L.soft.data.tetCount, inverseSolve: L.rest0, inverseSeconds: r3((performance.now() - t0) / 1000) }
  // 以反解出来的无重力形状为参考、加完整重力，走到静止：结点和皮肤顶点离发布的网格多远
  // with the solved unloaded shape as reference and full gravity, run to rest: how far nodes and skin vertices end up from the shipped mesh
  const sb = newBody(L, 12, { useRest0: true }, { damping: 12 })
  const frames = sb.solver.settle(DT, 2e-5, 3000)
  let worst = 0, sum = 0, cnt = 0
  for (let i = 0; i < L.soft.data.nodeCount; i++) {
    if (sb.solver.isPinned(i)) continue
    const d = Math.hypot(sb.solver.x[i * 3]! - L.soft.nodes[i * 3]!, sb.solver.x[i * 3 + 1]! - L.soft.nodes[i * 3 + 1]!, sb.solver.x[i * 3 + 2]! - L.soft.nodes[i * 3 + 2]!)
    worst = Math.max(worst, d)
    sum += d
    cnt++
  }
  // 皮肤顶点：x 插值到嵌入点，与发布的位置比 / skin vertices: x interpolated to the embedded points, against the shipped positions
  const q = [0, 0, 0]
  let skinWorst = 0, skinSum = 0, skinCnt = 0
  const sp = L.skinPoints
  for (let i = 0; i < sp.tet.length; i++) {
    if (sp.bary[i * 4]! === 0 && sp.bary[i * 4 + 1]! === 0 && sp.bary[i * 4 + 2]! === 0 && sp.bary[i * 4 + 3]! === 0) continue
    // 嵌入是对发布的笼子算的：用 x 插值得到的就是该顶点此刻的位置 / the embedding is against the shipped cage: interpolating x gives the vertex's present position
    sb.solver.pointPosition(sp, i, q)
    let rx = 0, ry = 0, rz = 0
    for (let k = 0; k < 4; k++) {
      const n = L.soft.tets[sp.tet[i]! * 4 + k]! * 3, w = sp.bary[i * 4 + k]!
      rx += w * L.soft.nodes[n]!
      ry += w * L.soft.nodes[n + 1]!
      rz += w * L.soft.nodes[n + 2]!
    }
    const d = Math.hypot(q[0]! - rx, q[1]! - ry, q[2]! - rz)
    skinWorst = Math.max(skinWorst, d)
    skinSum += d
    skinCnt++
  }
  let restShift = 0
  for (let i = 0; i < L.soft.nodes.length; i += 3) restShift = Math.max(restShift, Math.hypot(L.soft.rest0![i]! - L.soft.nodes[i]!, L.soft.rest0![i + 1]! - L.soft.nodes[i + 1]!, L.soft.rest0![i + 2]! - L.soft.nodes[i + 2]!))
  out.forwardUnderGravity = { frames, nodeLargestMm: mm(worst), nodeMeanMm: mm(sum / cnt), skinLargestMm: mm(skinWorst), skinMeanMm: mm(skinSum / skinCnt), largestReferenceShiftMm: mm(restShift), volumeRatioByMaterial: volumesByMaterial(L, sb), maxSpeed: sb.solver.maxSpeed() }
  console.log('equilibrium', JSON.stringify(out))
  return out
}

/** 渲染用的球面（经纬网格）/ a sphere for rendering (latitude–longitude mesh) */
function sphereItem(c: [number, number, number], r: number, color: [number, number, number]): RenderItem {
  const pos: number[] = [], idx: number[] = []
  const nu = 24, nv = 12
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const th = (j / nv) * Math.PI, ph = (i / nu) * 2 * Math.PI
    pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.cos(th), c[2] + r * Math.sin(th) * Math.sin(ph))
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + nu + 1
    idx.push(a, b, a + 1, a + 1, b, b + 1)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), color }
}

// ── 第三阶段：接触（球形压头、平板）、左右对称、渲染 / phase 3: contact (spherical probe, flat plate), left–right symmetry, renders ──
async function contact(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const L = await load('male', 0.027)
  const { body, rig } = L
  const rigBin = (await loadBody('male')).rigBin
  const inBody = bodyInside(L.skin)
  const at = (v: number): { site: [number, number, number]; normal: [number, number, number] } => ({ site: [L.skin.positions[v * 3]!, L.skin.positions[v * 3 + 1]!, L.skin.positions[v * 3 + 2]!], normal: [L.normals[v * 3]!, L.normals[v * 3 + 1]!, L.normals[v * 3 + 2]!] })
  const fa = forearmSites(L).proximalThird!
  // 男性胸部：乳头区，按 T4 的高度、离中线 10 cm 估计 / male chest, nipple region, estimated from the height of T4 and 10 cm from the midline
  const t4 = L.rig.joints.find((j) => j.id === 'T4')!.center
  let chestV = -1, bz = -Infinity
  for (const v of subset(L, (i, x, y) => Math.abs(x - 0.1) < 0.01 && Math.abs(y - t4[1]) < 0.015 && L.normals[i * 3 + 2]! > 0.6).verts) if (L.skin.positions[v * 3 + 2]! > bz) (bz = L.skin.positions[v * 3 + 2]!), (chestV = v)
  const views: ReturnType<typeof render>[] = []
  const probeRow = (name: string, v: number, R: number, forces: number[], cells: (number | undefined)[]): Record<string, unknown> => {
    const { site, normal } = at(v)
    const res: Record<string, unknown> = { site, normal }
    for (const cell of cells) {
      const S = buildSite(body, rig, rigBin, site, normal, R, { ...(cell ? { cell } : {}), inBody })
      const t0 = performance.now()
      const rows = forces.map((f) => pressRow(press(S.domain, { kind: 'sphere', radiusMm: R * 1000 }, { forceN: f })) as { depthMm: number; forceN: number; peakPressureKPa: number; flags: string[] })
      res[`sphere${R * 1000}mmCell${mm(S.domain.cell)}mm`] = { tissueThicknessMm: mm(S.domain.thickness ?? 0), tets: S.stats.tets, solveSeconds: r3((performance.now() - t0) / 1000), rows }
      console.log(name, R, cell, JSON.stringify(rows.map((r) => [r.depthMm, r.forceN, r.peakPressureKPa, r.flags])))
    }
    return res
  }
  out.forearmSphere = probeRow('forearm', fa, 0.005, [1, 2, 5], [undefined, 0.0025])
  out.chestSphere = probeRow('chest', chestV, 0.005, [1, 2, 5], [undefined])
  // 平板：半径 30 mm，力控 / the plate: radius 30 mm, force control
  {
    const { site, normal } = at(fa)
    const S = buildSite(body, rig, rigBin, site, normal, 0.03, { cell: 0.006, inBody })
    out.forearmPlate = { cellMm: 6, rows: [2, 5].map((f) => pressRow(press(S.domain, { kind: 'plate', radiusMm: 30 }, { forceN: f }))) }
    console.log('plate', JSON.stringify(out.forearmPlate))
  }
  // 左右对称：右前臂是左前臂的镜像（README），镜像点上的力应当相同 / left–right symmetry: the right forearm is a mirrored left (README), so mirrored sites must give the same force
  {
    const { site } = at(fa)
    const v = nearestSkinVertex(L, [-site[0], site[1], site[2]], [0, 0, 1])
    const r = at(v)
    const SL = buildSite(body, rig, rigBin, site, at(fa).normal, 0.005, { inBody }), SR = buildSite(body, rig, rigBin, r.site, r.normal, 0.005, { inBody })
    const fl = press(SL.domain, { kind: 'sphere', radiusMm: 5 }, { depthMm: 3 }), fr = press(SR.domain, { kind: 'sphere', radiusMm: 5 }, { depthMm: 3 })
    out.leftRight = { siteL: site, siteR: r.site, mirrorMismatchMm: mm(Math.hypot(r.site[0] + site[0], r.site[1] - site[1], r.site[2] - site[2])), forceL: fl.forceN, forceR: fr.forceN, peakKPaL: fl.peakPressureKPa, peakKPaR: fr.peakPressureKPa }
    console.log('left-right', JSON.stringify(out.leftRight))
  }
  // 渲染：压入前、压入后（5 N），压头画成灰球 / renders: before and after pressing (5 N), the probe drawn as a grey sphere
  for (const [name, v] of [['forearm', fa], ['chest', chestV]] as const) {
    const { site, normal } = at(v)
    const S = buildSite(body, rig, rigBin, site, normal, 0.005, { inBody })
    const r = press(S.domain, { kind: 'sphere', radiusMm: 5 }, { forceN: 5 })
    // press() 结束时压头已撤掉，状态仍是压着的：按最终深度重新放一个球画出来 / press() removes the probe at the end but the state is still pressed: draw a sphere at the final depth
    const n = S.domain.inward, dep = r.depthMm * 1e-3 - 0.005
    const centre: [number, number, number] = [site[0] + n[0] * dep, site[1] + n[1] * dep, site[2] + n[2] * dep]
    const patch = dentPatch(S, L.skin, 0.03, 0.0015)
    const view = { yaw: 35, pitch: 25, center: site, halfHeight: 0.035, width: 520, height: 520 }
    const side = { ...view, yaw: name === 'forearm' ? 90 : 90, pitch: 0 }
    const flat = patchItem(patch.rest, patch.rest, patch.indices, 0.004), dent = patchItem(patch.rest, patch.pos, patch.indices, 0.004)
    const ball = sphereItem(centre, 0.005, [150, 150, 160])
    views.push(render([flat], view), render([dent, ball], view), render([dent, ball], side))
    out[`${name}Render`] = { depthMm: r.depthMm, forceN: r.forceN, peakPressureKPa: r.peakPressureKPa }
  }
  const RENDERS = join(ROOT, 'data', 'raw', 'pipeline-scratch', 'softbody4')
  mkdirSync(RENDERS, { recursive: true })
  sheet(views.slice(0, 3), 3).save(join(RENDERS, 'forearm-sphere-5N-before-after.png'))
  sheet(views.slice(3, 6), 3).save(join(RENDERS, 'male-chest-sphere-5N-before-after.png'))
  return out
}

// ── 第三阶段：一万帧的稳定性和各区域体积 / phase 3: ten thousand frames of stability and volume by region ──
async function stability(): Promise<Record<string, unknown>> {
  const L = await load('male', 0.027)
  const sb = newBody(L)
  const frames = Number(process.env.SOFTBODY_FRAMES ?? 10000)
  let worst = 0, finite = true, worstVolume = 0
  const t0 = performance.now()
  const volDev = (): number => Math.max(...Object.values(volumesByMaterial(L, sb)).map((v) => Math.abs(v - 1)))
  for (let f = 0; f < frames; f++) {
    const t = f * DT
    const g = (2 * Math.PI * t) / 7
    sb.step(DT, jointFrames(L.rig.joints, { hip_L: [0.6 * Math.sin(3 * t), 0, 0], elbow_R: [0.9 * (1 - Math.cos(4 * t)), 0], knee_L: [0.5 * (1 - Math.cos(3 * t))] }), [9.81 * Math.sin(g) * 0.7, -9.81 * Math.cos(g), 9.81 * Math.sin(g) * 0.7])
    const m = maxDisplacement(sb)
    if (!Number.isFinite(m)) {
      finite = false
      break
    }
    worst = Math.max(worst, m)
    if (f % 100 === 99) worstVolume = Math.max(worstVolume, volDev())
  }
  const seconds = (performance.now() - t0) / 1000
  // 回到站立、静止姿势：位移应回到零附近，体积回到原值 / back to standing in the rest pose: displacement returns near zero, volumes to their values
  for (let f = 0; f < 600; f++) sb.step(DT, jointFrames(L.rig.joints, {}), [0, -9.81, 0])
  const out = { frames, substeps: frames * sb.solver.substeps, finite, largestDisplacementMm: mm(worst), largestVolumeDeviationDuringRun: r3(worstVolume), afterReturn: { residualMm: mm(maxDisplacement(sb)), volumeRatioByMaterial: volumesByMaterial(L, sb), maxSpeed: sb.solver.maxSpeed() }, seconds: r3(seconds), msPerFrame: r3((seconds * 1000) / frames) }
  console.log('stability', JSON.stringify(out))
  return out
}

// ── 第三阶段：CPU 上每帧的耗时 / phase 3: milliseconds per frame on the CPU ──
async function timing(): Promise<Record<string, unknown>> {
  const rows: unknown[] = []
  const { body, rig, rigBin } = await loadBody('male')
  const time = (label: string, sb: { step: (dt: number) => void }, nodes: number, tets: number, substeps: number): void => {
    for (let f = 0; f < 5; f++) sb.step(DT)
    const t0 = performance.now(), n = 60
    for (let f = 0; f < n; f++) sb.step(DT)
    const ms = (performance.now() - t0) / n
    rows.push({ cage: label, nodes, tets, substeps, msPerFrame: r3(ms), msPerSubstep: r3(ms / substeps) })
    console.log('timing', JSON.stringify(rows[rows.length - 1]))
  }
  for (const [label, cell, region] of [['whole body 27 mm', 0.027, undefined], ['whole body 20 mm', 0.02, undefined], ['chest region 14 mm', 0.014, 'chest'], ['forearm region 12 mm', 0.012, 'forearm_L']] as const) {
    const r = build(body, rig, rigBin, cell, region)
    const soft = decodeSoft(r.json, r.bin)
    time(label, new SoftBody(soft, { substeps: 10, damping: readMaterials().damping.rate }), soft.data.nodeCount, soft.data.tetCount, 10)
  }
  const L = await load('male', 0.027)
  const inBody = bodyInside(L.skin)
  const v = forearmSites(L).proximalThird!
  for (const [R, cell] of [[0.013, 0.0043], [0.005, undefined]] as const) {
    const S = buildSite(body, rig, rigBin, [L.skin.positions[v * 3]!, L.skin.positions[v * 3 + 1]!, L.skin.positions[v * 3 + 2]!], [L.normals[v * 3]!, L.normals[v * 3 + 1]!, L.normals[v * 3 + 2]!], R, { ...(cell ? { cell } : {}), inBody })
    time(`press() site cage, probe ${R * 1000} mm, cell ${mm(S.domain.cell)} mm`, S.domain.solver, S.stats.nodes, S.stats.tets, S.domain.solver.substeps)
  }
  return { cpu: 'Bun, one thread, machine shared with other jobs', rows }
}

// ── 第四阶段：小压头（疼痛工具的球、zheng1999 的 9 mm 平头），第三阶段对第四阶段的皮肤表示 / phase 4: small probes (the pain tool's sphere, the 9 mm flat punch of zheng1999), phase-3 against phase-4 skin ──
/** 射线与皮肤的第一个交点及该处的外法线 / the first hit of a ray on the skin, with the outward normal there */
function skinHit(L: Loaded, o: [number, number, number], d: [number, number, number]): { site: [number, number, number]; normal: [number, number, number] } | null {
  const p = L.skin.positions, idx = L.skin.indices
  let best = Infinity, hit: { site: [number, number, number]; normal: [number, number, number] } | null = null
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!], e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!]
    const q = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!]
    const det = e1[0]! * q[0]! + e1[1]! * q[1]! + e1[2]! * q[2]!
    if (Math.abs(det) < 1e-14) continue
    const sv = [o[0] - p[a]!, o[1] - p[a + 1]!, o[2] - p[a + 2]!]
    const u = (sv[0]! * q[0]! + sv[1]! * q[1]! + sv[2]! * q[2]!) / det
    if (u < 0 || u > 1) continue
    const r = [sv[1]! * e1[2]! - sv[2]! * e1[1]!, sv[2]! * e1[0]! - sv[0]! * e1[2]!, sv[0]! * e1[1]! - sv[1]! * e1[0]!]
    const v = (d[0] * r[0]! + d[1] * r[1]! + d[2] * r[2]!) / det
    if (v < 0 || u + v > 1) continue
    const dist = (e2[0]! * r[0]! + e2[1]! * r[1]! + e2[2]! * r[2]!) / det
    if (dist <= 0 || dist >= best) continue
    best = dist
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const l = Math.hypot(n[0]!, n[1]!, n[2]!)
    hit = { site: [o[0] + d[0] * dist, o[1] + d[1] * dist, o[2] + d[2] * dist], normal: [n[0]! / l, n[1]! / l, n[2]! / l] }
  }
  return hit
}

/**
 * zheng1999 的部位：盖在左桡骨上、肘关节以远约 10 cm 的软组织，探头垂直于骨面。这里取桡骨在该高度的截面中心，从前臂轴线
 * 指向它的方向（垂直于轴线）向外打到皮肤。
 * The site of zheng1999: the soft tissue over the left radius about 10 cm distal to the elbow joint, the probe
 * perpendicular to the bone. Here: the centre of the radius's cross-section at that level, and the direction from the
 * forearm axis to it (perpendicular to the axis), cast outward to the skin.
 */
function radiusSite(L: Loaded): { site: [number, number, number]; normal: [number, number, number]; radiusCentre: [number, number, number] } {
  const c = (id: string): [number, number, number] => L.rig.joints.find((j) => j.id === id)!.center
  const e = c('elbow_L'), w = c('wrist_L')
  const ax = [w[0] - e[0], w[1] - e[1], w[2] - e[2]], len = Math.hypot(ax[0]!, ax[1]!, ax[2]!)
  const u = ax.map((x) => x / len) as [number, number, number]
  const part = L.body.data.parts.find((p) => /^left radius$/i.test(p.name))
  const bone = part ? L.body.meshes.get(part.id) : undefined
  if (!bone) throw new Error('softbody: the male body has no part named "Left radius"')
  const s = [0, 0, 0]
  let n = 0
  for (let i = 0; i < bone.positions.length; i += 3) {
    const t = (bone.positions[i]! - e[0]) * u[0] + (bone.positions[i + 1]! - e[1]) * u[1] + (bone.positions[i + 2]! - e[2]) * u[2]
    if (Math.abs(t - 0.1) > 0.01) continue
    for (let k = 0; k < 3; k++) s[k] = s[k]! + bone.positions[i + k]!
    n++
  }
  if (n < 3) throw new Error(`softbody: only ${n} vertices of the radius lie 10 cm from the elbow`)
  const rc = s.map((x) => x / n) as [number, number, number]
  const t = (rc[0] - e[0]) * u[0] + (rc[1] - e[1]) * u[1] + (rc[2] - e[2]) * u[2]
  const off = [rc[0] - e[0] - u[0] * t, rc[1] - e[1] - u[1] * t, rc[2] - e[2] - u[2] * t], ol = Math.hypot(off[0]!, off[1]!, off[2]!)
  const dir = off.map((x) => x / ol) as [number, number, number]
  const h = skinHit(L, rc, dir)
  if (!h) throw new Error('softbody: no skin found outward of the radius')
  return { ...h, radiusCentre: rc }
}

async function smallProbe(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const L = await load('male', 0.027)
  const { body, rig } = L
  const rigBin = (await loadBody('male')).rigBin
  const inBody = bodyInside(L.skin)
  const fa = forearmSites(L).proximalThird!
  const z = radiusSite(L)
  const sites: Record<string, { site: [number, number, number]; normal: [number, number, number] }> = {
    zhengRadius10cm: { site: z.site, normal: z.normal },
    painProximalThird: { site: [L.skin.positions[fa * 3]!, L.skin.positions[fa * 3 + 1]!, L.skin.positions[fa * 3 + 2]!], normal: [L.normals[fa * 3]!, L.normals[fa * 3 + 1]!, L.normals[fa * 3 + 2]!] },
  }
  const variants = [['phase3', 'vertex', 'phase3'], ['phase4', 'area', 'phase4']] as const
  const views: ReturnType<typeof render>[] = []
  for (const [name, { site, normal }] of Object.entries(sites)) {
    const res: Record<string, unknown> = { site, normal }
    for (const [label, share, blend] of variants) {
      const t0 = performance.now()
      // zheng1999：9 mm 平头，先加 0.5 N 预载，再到 1、2、3.75 N（该文只用 0.5 N 到 5 N 的 75 % 之间的数据）
      // zheng1999: 9 mm flat punch, a 0.5 N preload, then 1, 2 and 3.75 N (that paper used data between 0.5 N and 75 % of 5 N)
      const SF = buildSite(body, rig, rigBin, site, normal, 0.0045, { cell: 0.0018, inBody, skinShare: share, mix: { skinBlend: blend } })
      const flat = [0.5, 1, 2, 3.75].map((f) => pressRow(press(SF.domain, { kind: 'flat', radiusMm: 4.5 }, { forceN: f })) as { depthMm: number; forceN: number; flags: string[] })
      const pre = flat[0]!, okRows = flat.filter((r) => !r.flags.includes('force-not-reached:tissue-crushed-or-bottomed-out'))
      const last = okRows[okRows.length - 1]!
      const slope = last !== pre && last.depthMm > pre.depthMm ? r3((last.forceN - pre.forceN) / (last.depthMm - pre.depthMm)) : null
      // 疼痛工具：半径 5 mm 的球 / the pain tool: a 5 mm sphere
      const SS = buildSite(body, rig, rigBin, site, normal, 0.005, { inBody, skinShare: share, mix: { skinBlend: blend } })
      const sphere = [1, 2, 5].map((f) => pressRow(press(SS.domain, { kind: 'sphere', radiusMm: 5 }, { forceN: f })))
      res[label] = { tissueThicknessMm: mm(SF.domain.thickness ?? 0), flat9mm: { cellMm: 1.8, rows: flat, slopeNPerMmFromPreload: slope }, sphere5mm: { cellMm: mm(SS.domain.cell), rows: sphere }, seconds: r3((performance.now() - t0) / 1000) }
      console.log(name, label, JSON.stringify(res[label]))
      if (name === 'painProximalThird') {
        // 渲染：只画压入点周围细分过的皮肤（颜色 = 位移），斜看和侧看；同样 0.17 N（第三阶段压溃前的最大力），第四阶段另加它能到的最大力
        // renders: only the subdivided skin round the site (colour = displacement), oblique and side-on; both at 0.17 N (the largest force of phase 3 before the crush), phase 4 also at the most it reaches
        for (const req of label === 'phase3' ? [0.17] : [0.17, 2]) {
          const r = press(SS.domain, { kind: 'sphere', radiusMm: 5 }, { forceN: req })
          const n = SS.domain.inward, dep = r.depthMm * 1e-3 - 0.005
          const centre: [number, number, number] = [site[0] + n[0] * dep, site[1] + n[1] * dep, site[2] + n[2] * dep]
          const patch = dentPatch(SS, L.skin, 0.02, 0.0008)
          const dent = patchItem(patch.rest, patch.pos, patch.indices, 0.004), ball = sphereItem(centre, 0.005, [150, 150, 160])
          const view = { yaw: 35, pitch: 25, center: site, halfHeight: 0.02, width: 420, height: 420 }
          // 侧看：视线垂直于压入方向 / side-on: looking across the pressing direction
          const side = { yaw: (Math.atan2(n[0], n[2]) * 180) / Math.PI + 90, pitch: 0, center: site, halfHeight: 0.015, width: 420, height: 420 }
          views.push(render([dent, ball], view), render([dent, ball], side))
          res[`${label}Render${req}N`] = { depthMm: r.depthMm, forceN: r.forceN, flags: r.flags }
        }
      }
    }
    out[name] = res
  }
  out.zhengSite = { radiusCentre: z.radiusCentre }
  const RENDERS = join(ROOT, 'data', 'raw', 'pipeline-scratch', 'softbody4')
  mkdirSync(RENDERS, { recursive: true })
  // 一行一种：第三阶段 0.17 N、第四阶段 0.17 N、第四阶段的最大力（请求 2 N）；左斜看，右侧看 / one row each: phase 3 at 0.17 N, phase 4 at 0.17 N, phase 4 at the most it reaches (2 N requested); oblique left, side-on right
  sheet(views, 2).save(join(RENDERS, 'forearm-sphere5mm-phase3-vs-phase4.png'))
  return out
}

// ── 第四阶段：子步数与稳态偏软 / phase 4: substep count and the too-soft steady state ──
async function substeps(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  // (a) 自重悬臂梁（截面 4 个单元，E = 20 kPa，ρ = 1000）：刚度比 Π 与挠度 / (a) self-weight cantilever (4 cells across, E = 20 kPa, ρ = 1000): stiffness ratio Π and deflection
  const E = 20e3, rho = 1000, g = 0.5, h = 0.04, Lb = 0.24
  const cant = (nA: number, sub: number): { pi: number; tip: number } => {
    const cell = h / nA
    const b = block([Math.round(Lb / cell), nA, nA], cell, E, 0.49, rho, (x) => x < 1e-6, { gravity: [0, -g, 0], substeps: sub, damping: 8, volume: 'node' })
    const pi = b.solver.stiffnessRatio(0, 0.99) * (DT / sub) ** 2
    b.solver.settle(DT, 2e-6, 8000)
    let sum = 0, c = 0
    for (let i = 0; i < b.nodes.length / 3; i++) if (Math.abs(b.nodes[i * 3]! - Lb) < 1e-6) (sum += b.solver.x[i * 3 + 1]! - b.nodes[i * 3 + 1]!), c++
    return { pi, tip: -sum / c }
  }
  const rows: unknown[] = []
  for (const nA of [4, 8]) {
    const ref = cant(nA, nA === 4 ? 256 : 128).tip
    for (const sub of nA === 4 ? [2, 4, 8, 16, 32] : [8, 16, 32]) {
      const r = cant(nA, sub)
      rows.push({ cellsAcross: nA, substeps: sub, stiffnessRatioP99: r3(r.pi), deflectionOverConverged: r3(r.tip / ref) })
    }
  }
  out.cantilever = { what: 'self-weight cantilever, ν = 0.49, nodal volume; deflection over the run with 256 (4 across) or 128 (8 across) substeps; Π = h²·μ̃·V·Σw‖∇N‖² (99th percentile over tetrahedra)', rows }
  console.log('cantilever', JSON.stringify(out.cantilever))
  // (b) 全身笼子 27 mm：仰卧（预应力下重力从站立转到仰卧）时皮肤的位移 / (b) whole-body cage 27 mm: skin displacement on lying supine (gravity turned from standing to supine under the pre-stress)
  const L = await load('male', 0.027)
  const wb: unknown[] = []
  let ratio: Record<string, number> = {}
  for (const sub of [2, 4, 8, 10, 20]) {
    const sb = newBody(L, sub)
    const s = sb.solver
    if (sub === 10) ratio = { p50: r3(s.stiffnessRatio(0, 0.5) * (DT / 10) ** 2), p99: r3(s.stiffnessRatio(0, 0.99) * (DT / 10) ** 2), max: r3(s.stiffnessRatio(0, 1) * (DT / 10) ** 2), p99MusclesFullyActive: r3(s.stiffnessRatio(1, 0.99) * (DT / 10) ** 2), substepsForP99Within0_5: s.substepsFor(DT), substepsForP99Within0_5MusclesActive: s.substepsFor(DT, 0.5, 1) }
    s.gravity = [0, 0, -9.81]
    let frames = 0
    for (; frames < 3000; frames++) {
      sb.step(DT)
      if (frames > 60 && s.maxSpeed() < 2e-4) break
    }
    const pts = L.skinPoints, d = sb.displacement
    let mean = 0, max = 0
    for (let i = 0; i < pts.tet.length; i++) {
      let x = 0, y = 0, z = 0
      for (let k = 0; k < 4; k++) {
        const nn = L.soft.tets[pts.tet[i]! * 4 + k]! * 3, b = pts.bary[i * 4 + k]!
        x += b * d[nn]!
        y += b * d[nn + 1]!
        z += b * d[nn + 2]!
      }
      const m = Math.hypot(x, y, z)
      mean += m / pts.tet.length
      max = Math.max(max, m)
    }
    wb.push({ substeps: sub, frames, skinMeanMm: mm(mean), skinMaxMm: mm(max), maxSpeed: s.maxSpeed() })
    console.log('whole body supine', JSON.stringify(wb[wb.length - 1]))
  }
  out.wholeBodySupine = { what: 'male whole-body cage 27 mm, pre-stress, gravity turned to supine without a support plane; steady skin displacement by substep count; stiffness ratios at 10 substeps', stiffnessRatioAt10Substeps: ratio, rows: wb }
  return out
}

// ── 乳房体模（不读女性数据）：底面边界条件、三维的体位重力、体积 / the breast phantom (no female data read): base condition, 3D posture gravity, volume ──
async function breastPhantom(): Promise<Record<string, unknown>> {
  const sk = readMaterials().materials.find((m) => m.id === 'skin')!
  const skin = { young: sk.young, thickness: sk.basis.thickness?.value ?? 0.00113, stiffening: sk.stiffening ?? 0 }
  // mira2018：浅筋膜深层 0.1 mm 厚，模量的搜索区间 80–250 kPa / mira2018: deep layer of the superficial fascia 0.1 mm thick, modulus searched over 80–250 kPa
  const f80 = { young: 80e3, thickness: 1e-4 }, f250 = { young: 250e3, thickness: 1e-4 }
  const base: PhantomCase = { volumeMl: 262, cell: 0.01, base: 'bonded', shear: 357.1 }
  // mira2018 拟合到的乳房皮肤（连同浅筋膜浅层）：2 mm 厚的壳，E = 4 kPa / the breast skin fitted by mira2018 (with the superficial layer of the superficial fascia): a 2 mm shell, E = 4 kPa
  const bskin = { young: 4000, thickness: 0.002 }
  const big = { volumeMl: 1140, cell: 0.014 }
  const cases: [string, Partial<PhantomCase>][] = [
    ['262 mL, bonded, no skin (phases 2–3)', {}],
    ['262 mL, bonded, no skin, cell 7 mm', { cell: 0.007 }],
    ['262 mL, sliding with a central patch pinned, no skin (phase-3 upper bound)', { base: 'slidingCentre' }],
    ['262 mL, sliding, rim pinned, no skin', { base: 'sliding' }],
    ['262 mL, sliding, forearm skin of materials.json', { base: 'sliding', skin }],
    ['262 mL, bonded, mira2018 breast skin', { skin: bskin }],
    ['262 mL, sliding, mira2018 breast skin', { base: 'sliding', skin: bskin }],
    ['262 mL, sliding, mira2018 breast skin, cell 7 mm', { base: 'sliding', skin: bskin, cell: 0.007 }],
    ['262 mL, fascia 80 kPa × 0.1 mm, mira2018 breast skin', { base: 'fascia', fascia: f80, skin: bskin }],
    ['262 mL, fascia 250 kPa × 0.1 mm, mira2018 breast skin', { base: 'fascia', fascia: f250, skin: bskin }],
    ['262 mL, sliding, mira2018 breast skin, wall turned 30° outward', { base: 'sliding', skin: bskin, wallTiltDeg: 30 }],
    ['262 mL, sliding, mira2018 breast skin, shear 166.6 Pa', { base: 'sliding', skin: bskin, shear: 166.6 }],
    ['1140 mL, bonded, no skin', { ...big }],
    ['1140 mL, bonded, mira2018 breast skin', { ...big, skin: bskin }],
    ['1140 mL, sliding, mira2018 breast skin', { ...big, base: 'sliding', skin: bskin }],
    ['1140 mL, fascia 80 kPa, mira2018 breast skin', { ...big, base: 'fascia', fascia: f80, skin: bskin }],
    ['1140 mL, sliding, mira2018 breast skin, wall turned 30° outward', { ...big, base: 'sliding', skin: bskin, wallTiltDeg: 30 }],
    ['1140 mL, sliding, mira2018 breast skin, shear 166.6 Pa', { ...big, base: 'sliding', skin: bskin, shear: 166.6 }],
  ]
  const rows = cases.map(([label, c]) => {
    const r = phantom({ ...base, ...c })
    console.log('phantom', label, JSON.stringify(r))
    return { label, ...r }
  })
  // 渲染：俯卧、仰卧、站立、外侧卧，从外侧看（身体坐标系，y 向头、z 向前）/ renders: prone, supine, standing, lateral, seen from the side (body frame, y cranial, z anterior)
  const images: ReturnType<typeof render>[] = []
  for (const c of [{ ...base }, { ...base, base: 'sliding' as const, skin: bskin }, { ...base, ...big, base: 'sliding' as const, skin: bskin, wallTiltDeg: 30 }]) {
    const m = buildPhantom(c)
    const surf = phantomSurface(m)
    for (const p of ['prone', 'supine', 'standing', 'lateral'] as const) {
      const { x } = settlePosture(m, p)
      const pos = new Float32Array(surf.length * 3)
      const half = m.nodes[m.nipple * 3]!
      surf.forEach((i, k) => pos.set(m.toBody([x[i * 3]! - half, x[i * 3 + 1]!, x[i * 3 + 2]! - m.nodes[m.nipple * 3 + 2]!]), k * 3))
      images.push(render([{ positions: pos, indices: Uint32Array.from({ length: surf.length }, (_, i) => i), color: [230, 190, 170] }], { yaw: 90, pitch: 10, center: [0, 0, 0.05], halfHeight: 0.13, width: 360, height: 360 }))
    }
  }
  const RENDERS = join(ROOT, 'data', 'raw', 'pipeline-scratch', 'softbody4')
  mkdirSync(RENDERS, { recursive: true })
  sheet(images, 4).save(join(RENDERS, 'breast-phantom-prone-supine-standing-lateral.png'))
  return {
    what: 'hemisphere of breast tissue on a rigid wall; postures by a 3D gravity vector in the body frame (x lateral, y cranial, z anterior); each posture solved from the unloaded shape; pairs give nipple / mean tissue displacement in mm',
    published: { meanMm: 69.7, source: 'proneSupine2016', ownPhantomInitialTreMm: 19.3, ownPhantomVolumeL: 1.14 },
    rows,
  }
}

/** 体模表面的三角形汤（只出现一次的面）/ the phantom's surface as a triangle soup (faces used once) */
function phantomSurface(m: ReturnType<typeof buildPhantom>): number[] {
  const count = new Map<string, number[]>()
  const T = m.tets.length / 4
  for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
    const f = [0, 1, 2, 3].filter((c) => c !== k).map((c) => m.tets[e * 4 + c]!)
    const key = [...f].sort((a, b) => a - b).join(',')
    if (count.has(key)) count.set(key, [])
    else count.set(key, f)
  }
  const out: number[] = []
  for (const f of count.values()) out.push(...f)
  return out
}

if (import.meta.main) {
  mkdirSync(DIR, { recursive: true })
  const which = process.argv[2] ?? 'all'
  // 'breast' 读女性身体：女性身体在重建时不要跑它（'all' 也会跑它）/ 'breast' reads the female body: do not run it while the female body is being rebuilt ('all' runs it too)
  const groups: Record<string, () => Promise<Record<string, unknown>>> = { numerics, body: wholeBody, forearm, abdomen, breast, equilibrium, contact, stability, timing, breastPhantom, smallProbe, substeps }
  for (const [name, run] of Object.entries(groups)) {
    if (which !== 'all' && which !== name) continue
    const t0 = performance.now()
    const res = await run()
    writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ ...res, seconds: Math.round((performance.now() - t0) / 1000) }, null, 1))
  }
  // 汇总：把已有的各组结果和文献数值并到一个文件里 / summary: merges the group results present with the literature numbers
  const got: Record<string, unknown> = {}
  for (const name of Object.keys(groups)) if (existsSync(join(DIR, `${name}.json`))) got[name] = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'))
  const lit = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'softbody', 'validation.json'), 'utf8')) as Record<string, unknown>
  const report = {
    _doc: {
      zh: '软组织求解器在当前几何上的验证结果（tools/softbody/validate.ts 生成）；literature 是 validation.json 里对应的已发表数值；phase1 是第一阶段报告过的数（当时的求解器和笼子），留作前后对照。几何还会改，改后要重跑。',
      en: 'Validation results of the soft-tissue solver on the current geometry (written by tools/softbody/validate.ts); `literature` holds the matching published numbers of validation.json; `phase1` holds the numbers reported in phase 1 (the solver and cages of that time), kept for comparison. The geometry will change, after which this must be rerun.',
    },
    literature: { indentation: lit.indentation, posture: lit.posture, analytic: lit.analytic, softTissueMotion: lit.softTissueMotion },
    phase1: {
      forearmFlatPunch3_2mmForceN: { published: 1.43, cell12mmBySubsteps: { 4: 0.43, 8: 0.84, 16: 1.2, 32: 1.36 }, cell8mmAt16Substeps: 0.8, wholeBodyCell27mm: [2.3, 2.5] },
      breastStandingToSupineNippleMm: [2.5, 4.1],
      hipFlexionLargestNodeDisplacementMm: 188,
      muscleVolumeErrorAt10Substeps: 0.062,
      msPerFrameAt10Substeps: 32,
    },
    ours: got,
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 1))
  console.log('wrote', REPORT.slice(ROOT.length + 1))
}
