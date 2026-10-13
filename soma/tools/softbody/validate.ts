// 软组织求解器的验证：在当前几何上跑一组算例，结果写到 data/raw/softbody/out/validation/（不入库），
// 汇总（只有我们的数和文献的数）写到 data/curated/softbody/validation-report.json。
// Validation of the soft-tissue solver: runs a set of cases on the current geometry, writes results to
// data/raw/softbody/out/validation/ (not committed) and a summary (our numbers and the literature's only) to
// data/curated/softbody/validation-report.json.
//
//   bun tools/softbody/validate.ts [body|forearm|sites|breast|all]
//
// 每一组都从 GLB 重新建笼子，不依赖以前的输出。一次只跑一组重的。
// Every group rebuilds its cage from the GLBs and depends on no earlier output. Run one heavy group at a time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import { type LoadedSoft, SoftBody, decodeSoft, embedPoints } from '../../src/softbody/body.ts'
import type { PointSet } from '../../src/softbody/solver.ts'
import { computeNormals } from '../pipeline/geometry.ts'
import type { Body, RawMesh } from '../rig/io.ts'
import { jointFrames } from '../rig/pose.ts'
import { type RenderItem, render, sheet } from '../rig/render.ts'
import { OUT, ROOT, build, loadBody, readMaterials, withRest0 } from './build.ts'

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

const newBody = (L: Loaded, substeps = 10, useRest0 = false, skin: 'voigt' | 'none' = 'voigt'): SoftBody => new SoftBody(L.soft, { substeps, damping: readMaterials().damping.rate }, { useRest0, skin })

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
  const swing = (b: SoftBody): number[] => {
    const lag: number[] = []
    for (let f = 0; f < 240; f++) {
      b.step(DT, pose(Math.min(1, (f + 1) / 9) * (40 * Math.PI) / 180))
      lag.push(mm(maxDisplacement(b)))
    }
    return lag
  }
  const free = newBody(L)
  free.solver.gravity = [0, 0, 0]
  free.solver.prestressGravity = null
  const lag0 = swing(free), lag1 = swing(sb)
  out.jiggle = {
    motion: 'hip_L flexion 40° in 0.15 s, then held; largest corrective displacement of any cage node, mm',
    withoutGravity: { peak: Math.max(...lag0), at0_25s: lag0[14], at0_5s: lag0[29], at1s: lag0[59], at2s: lag0[119], at4s: lag0[239] },
    withGravity: { peak: Math.max(...lag1), at1s: lag1[59], at4s: lag1[239], settledSpeed: sb.solver.maxSpeed() },
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

  // 6. 全身粗笼子上的压入（与区域细笼子对照，看网格依赖）/ indentation on the coarse whole-body cage (against the fine regional cage, to see the mesh dependence)
  const fb = newBody(L)
  const sites = forearmSites(L)
  out.forearmCoarse = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, indent(L, fb, v, 0.013, [1, 2, 3.2, 4.5])]))
  console.log('forearm coarse', JSON.stringify(out.forearmCoarse))

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

// ── 前臂区域（细笼子）/ the forearm region (fine cage) ────────────────────────────────────────
async function forearm(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const depths = [0.5, 1, 1.6, 2.4, 3.2, 4.5]
  for (const cell of [0.012, 0.008]) {
    const L = await load('male', cell, 'forearm_L')
    const sites = forearmSites(L)
    const res: Record<string, unknown> = { cage: L.stats }
    for (const [name, v] of Object.entries(sites)) {
      const sb = newBody(L, 16)
      res[name] = indent(L, sb, v, 0.013, depths)
      console.log(cell, name, JSON.stringify(res[name]))
      if (cell === 0.008 && name === 'proximalThird') {
        // 渲染：压到 4.5 mm 时的前臂 / render: the forearm pressed to 4.5 mm
        const p = L.skin.positions
        sb.solver.probe = { shape: { kind: 'flat', center: [p[v * 3]! - L.normals[v * 3]! * 0.008, p[v * 3 + 1]! - L.normals[v * 3 + 1]! * 0.008, p[v * 3 + 2]! - L.normals[v * 3 + 2]! * 0.008], axis: [-L.normals[v * 3]!, -L.normals[v * 3 + 1]!, -L.normals[v * 3 + 2]!], radius: 0.013 }, points: contactSamples(L, [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!], 0.035).points }
        for (let f = 0; f < 90; f++) sb.step(DT)
        const pos = displacedSkin(L, sb)
        const view = { yaw: 60, pitch: 10, center: [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!] as [number, number, number], halfHeight: 0.11, width: 520, height: 520 }
        sheet([render([skinItem(L, L.skin.positions, 0.006)], view), render([skinItem(L, pos, 0.006)], view), render([skinItem(L, pos, 0.006)], { ...view, yaw: 150 })], 3).save(join(DIR, 'forearm-pressed-8mm.png'))
        res.renderDepthMm = 8
        res.renderForceN = r3(Math.hypot(...sb.solver.probeForce))
        // 松手后的回弹 / rebound after release
        sb.solver.probe = null
        const back: number[] = []
        for (let f = 0; f < 90; f++) {
          sb.step(DT)
          if (f % 15 === 14) back.push(mm(maxDisplacement(sb)))
        }
        res.reboundMmEveryQuarterSecond = back
      }
    }
    // 子步收敛：同一个压入，子步数不同 / convergence in substeps: the same press with different substep counts
    if (cell === 0.012) res.substepConvergence = [4, 8, 16, 32].map((n) => ({ substeps: n, forceAt3_2mm: indent(L, newBody(L, n), sites.proximalThird!, 0.013, [3.2])[0]!.forceN }))
    out[`cell${cell * 1000}mm`] = res
  }
  return out
}

// ── 其他部位的压入：只有我们的数 / indentation elsewhere: our numbers only ────────────────────
async function otherSites(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const depths = [2, 5, 10]
  {
    const L = await load('male', 0.014, 'thigh_L')
    const c = (id: string): [number, number, number] => L.rig.joints.find((j) => j.id === id)!.center
    const h = c('hip_L'), k = c('knee_L')
    const v = nearestSkinVertex(L, [(h[0] + k[0]) / 2, (h[1] + k[1]) / 2, (h[2] + k[2]) / 2 + 0.1], [0, 0, 1])
    out.thighAnteriorMid = { cage: L.stats, punchRadiusMm: 13, rows: indent(L, newBody(L, 16), v, 0.013, depths) }
    console.log('thigh', JSON.stringify(out.thighAnteriorMid))
  }
  {
    const L = await load('male', 0.016, 'abdomen')
    const c = L.rig.joints.find((j) => j.id === 'L3')!.center
    const v = nearestSkinVertex(L, [0.04, c[1], c[2] + 0.15], [0, 0, 1])
    out.abdomenParaumbilical = { cage: L.stats, punchRadiusMm: 13, rows: indent(L, newBody(L, 16), v, 0.013, [...depths, 20]) }
    console.log('abdomen', JSON.stringify(out.abdomenParaumbilical))
  }
  return out
}

// ── 女性胸部：乳房的重力位移，预应力与零重力参考两种做法 / female chest: gravity displacement of the breast, by pre-stress and by the zero-gravity reference ──
async function breast(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const L = await load('female', 0.014, 'chest', true)
  out.cage = L.stats
  out.rest0 = L.rest0
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
  const images = []
  // 第三种：不把皮肤刚度混进边界四面体，看皮肤的贡献有多大 / a third variant without skin stiffness in the boundary tetrahedra, to see how much the skin contributes
  for (const variant of ['prestress', 'zeroGravityReference', 'prestressWithoutSkinStiffness'] as const) {
    const useRest0 = variant === 'zeroGravityReference'
    const key = variant
    const sb = newBody(L, 12, useRest0, variant === 'prestressWithoutSkinStiffness' ? 'none' : 'voigt')
    for (let f = 0; f < 240; f++) sb.step(DT)
    const standing = mm(maxDisplacement(sb))
    const pos0 = displacedSkin(L, sb)
    lieSupine(L, sb)
    for (let f = 0; f < 360; f++) sb.step(DT)
    const pos = displacedSkin(L, sb)
    const d = nipples.map((v) => [pos[v * 3]! - pos0[v * 3]!, pos[v * 3 + 1]! - pos0[v * 3 + 1]!, pos[v * 3 + 2]! - pos0[v * 3 + 2]!])
    out[key] = {
      standingResidualMm: standing,
      nippleDisplacementMm: d.map((u, i) => ({ side: i === 0 ? 'L' : 'R', lateral: mm(u[0]! * (i === 0 ? 1 : -1)), cranial: mm(u[1]!), anterior: mm(u[2]!), magnitude: mm(Math.hypot(u[0]!, u[1]!, u[2]!)) })),
      breastVolumeRatio: Math.round((sb.solver.volume(ofBreast) / sb.solver.referenceVolume(ofBreast)) * 1e4) / 1e4,
      volumeRatioByMaterial: volumesByMaterial(L, sb), settledSpeed: sb.solver.maxSpeed(),
    }
    console.log(key, JSON.stringify(out[key]))
    const view = { yaw: 90, center: [0, 1.18, 0.08] as [number, number, number], halfHeight: 0.2, width: 380, height: 420 }
    images.push(render([skinItem(L, pos0, 0.03)], view), render([skinItem(L, pos, 0.03)], view), render([skinItem(L, pos, 0.03)], { ...view, yaw: 0 }))
  }
  sheet(images, 3).save(join(DIR, 'female-chest-standing-vs-supine.png'))
  out.breastTets = L.soft.tetMaterial.reduce((s, m) => s + (breastMat.has(m) ? 1 : 0), 0)
  return out
}

if (import.meta.main) {
  mkdirSync(DIR, { recursive: true })
  const which = process.argv[2] ?? 'all'
  const groups: Record<string, () => Promise<Record<string, unknown>>> = { body: wholeBody, forearm, sites: otherSites, breast }
  for (const [name, run] of Object.entries(groups)) {
    if (which !== 'all' && which !== name) continue
    const t0 = performance.now()
    const res = await run()
    writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ ...res, seconds: Math.round((performance.now() - t0) / 1000) }, null, 1))
  }
  // 汇总：把已有的各组结果和文献数值并到一个文件里 / summary: merges the group results present with the literature numbers
  const got: Record<string, unknown> = {}
  for (const name of Object.keys(groups)) if (existsSync(join(DIR, `${name}.json`))) got[name] = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'))
  const lit = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'softbody', 'validation.json'), 'utf8')) as { indentation: unknown[]; posture: unknown[] }
  writeFileSync(REPORT, JSON.stringify({ _doc: { zh: '软组织求解器在当前几何上的验证结果（tools/softbody/validate.ts 生成）；literature 是 validation.json 里对应的已发表数值。几何还会改，改后要重跑。', en: 'Validation results of the soft-tissue solver on the current geometry (written by tools/softbody/validate.ts); `literature` holds the matching published numbers of validation.json. The geometry will change, after which this must be rerun.' }, literature: { indentation: lit.indentation, posture: lit.posture }, ours: got }, null, 1))
  console.log('wrote', REPORT.slice(ROOT.length + 1))
}
