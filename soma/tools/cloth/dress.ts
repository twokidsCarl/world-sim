// 离线穿衣：裁片 → 网格 → 卷到身体外面 → 缝合 → 重力下落定 → 从穿衣姿势回到静止姿势 → 再落定，
// 写出 public/anatomy/<body>/cloth/<garment>.{json,bin} 和 index.json。
// Offline dressing: pattern → mesh → wrapped around the body → sewn → settled under gravity → brought
// from the dressing pose back to the rest pose → settled again; writes
// public/anatomy/<body>/cloth/<garment>.{json,bin} and index.json.
//
//   bun tools/cloth/dress.ts [body …] [--only garment,…] [--debug]
//
// 穿衣姿势：双臂外展 50°、髋外展 0.15 rad，袖子和裤腿在手臂与躯干、两腿之间有地方放；然后用 90 帧把姿势
// 线性收回静止，皮肤碰撞体每帧更新。
// Dressing pose: both arms abducted 50° and the hips by 0.15 rad, so sleeves and trouser legs have room
// between arm and trunk and between the legs; the pose is then blended back to rest over 90 frames, the
// skin collider updated every frame.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClothSolver, type FabricMechanics } from '../../src/cloth/solver.ts'
import { MeshCollider, SkinVertexCollider } from '../../src/cloth/collider.ts'
import { SelfCollision } from '../../src/cloth/selfcollide.ts'
import { SkinAttachment, geodesicToAnchors, planeBinding } from '../../src/cloth/attach.ts'
import { Poser, armElevation, mergePoses, type Pose } from '../rig/pose.ts'
import { BODIES, ROOT, loadSkinBody, type BodyId, type SkinBody } from './body.ts'
import { EDGE_KINDS, meshGarment, type GarmentMesh, type GcSpec } from './pattern.ts'
import { placeGarment } from './place.ts'
import { buriedVertices } from './buried.ts'
import { SkinQuery, writeGarment, type DressReport } from './output.ts'
import type { Closest } from '../../src/cloth/collider.ts'

export const WARDROBE: Record<BodyId, string[]> = {
  male: ['tee', 'pants', 'compression-top', 'tights'],
  female: ['tee', 'pants', 'skirt', 'sports-bra', 'tights'],
}

/** 每件衣服的网格间距（米）/ Mesh spacing per garment (metres). */
export const SPACING: Record<string, number> = {
  tee: 0.011, pants: 0.013, skirt: 0.012, 'compression-top': 0.011, 'sports-bra': 0.009, tights: 0.012,
}

const FPS = 60
const DT = 1 / FPS

export function readFabrics(): Record<string, FabricMechanics> {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'cloth', 'fabrics.json'), 'utf8')) as { fabrics: Record<string, { solver: FabricMechanics }> }
  return Object.fromEntries(Object.entries(j.fabrics).map(([k, v]) => [k, v.solver]))
}

export function readPattern(body: BodyId, garment: string): GcSpec {
  return JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'cloth', 'patterns', `${body}-${garment}.json`), 'utf8')) as GcSpec
}

function scalePose(p: Pose, s: number): Pose {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.map((a) => a * s)]))
}

export function dressingPose(b: SkinBody): Pose {
  const a = (50 * Math.PI) / 180
  return mergePoses(armElevation(b.rig.joints, 'L', a), armElevation(b.rig.joints, 'R', a), { hip_L: [0, 0.15, 0], hip_R: [0, 0.15, 0] })
}

/** 每个顶点到最近缝线顶点的裁片距离（同一裁片内，网格边上的最短路）/ Each vertex's pattern distance to the nearest seam vertex (shortest path over mesh edges within its panel). */
function seamDistance(g: GarmentMesh): Float64Array {
  const n = g.uv.length / 2
  const d = new Float64Array(n).fill(Infinity)
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (let t = 0; t < g.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = g.triangles[t + k]!, b = g.triangles[t + ((k + 1) % 3)]!
      adj[a]!.push(b)
      adj[b]!.push(a)
    }
  }
  const queue: number[] = []
  for (let s = 0; s < g.stitches.length; s++) {
    const v = g.stitches[s]!
    if (d[v] !== 0) {
      d[v] = 0
      queue.push(v)
    }
  }
  // 简单的 Bellman–Ford 式松弛（图小）/ simple Bellman–Ford style relaxation (small graphs)
  for (let it = 0; it < queue.length; it++) {
    const v = queue[it]!
    for (const u of adj[v]!) {
      const w = Math.hypot(g.uv[u * 2]! - g.uv[v * 2]!, g.uv[u * 2 + 1]! - g.uv[v * 2 + 1]!)
      if (d[v]! + w < d[u]! - 1e-12) {
        d[u] = d[v]! + w
        queue.push(u)
      }
    }
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(d[i]!)) d[i] = 1
  return d
}

/**
 * 腰头顶点（边类型 waistband）绑到最近的皮肤三角形；没有腰头的衣服返回 null。
 * The waistband vertices (edge kind waistband) bound to their nearest skin triangles; null for a garment without one.
 */
function waistAttachment(mesh: GarmentMesh, x: Float64Array, skin: Float64Array, index: Uint32Array): SkinAttachment | null {
  const k = EDGE_KINDS.indexOf('waistband')
  // 整个腰头片（wb 开头的裁片）都绑上：只绑上沿时，腰头会绕着上沿翻折 / the whole waistband panel (panels named wb…) is bound: bound by its top edge only, the band folds over it
  const wb = new Set(mesh.panels.flatMap((p, pi) => (p.name.startsWith('wb') ? [pi] : [])))
  const verts: number[] = []
  for (let i = 0; i < mesh.edgeKind.length; i++) if (mesh.edgeKind[i] === k || wb.has(mesh.panelOf[i]!)) verts.push(i)
  return verts.length ? bindToSkin(verts, x, skin, index) : null
}

/**
 * 上衣：肩缝（前后躯干片之间、高于 minY 的缝线顶点）绑到皮肤上——上衣挂在肩上，就像裤子挂在腰上。
 * Tops: the shoulder seams (stitched vertices between front and back torso panels above minY) bound to the
 * skin; a top hangs from the shoulders as trousers hang from the waist.
 */
function shoulderAttachment(mesh: GarmentMesh, x: Float64Array, skin: Float64Array, index: Uint32Array, minY: number): SkinAttachment | null {
  const torso = (v: number): boolean => mesh.panels[mesh.panelOf[v]!]!.name.includes('torso')
  const verts = new Set<number>()
  for (let s = 0; s < mesh.stitches.length; s += 2) {
    const a = mesh.stitches[s]!, c = mesh.stitches[s + 1]!
    if (!torso(a) || !torso(c) || mesh.panels[mesh.panelOf[a]!]!.front === mesh.panels[mesh.panelOf[c]!]!.front) continue
    if (x[a * 3 + 1]! < minY || x[c * 3 + 1]! < minY) continue
    verts.add(a)
    verts.add(c)
  }
  return verts.size ? bindToSkin([...verts].sort((p, q) => p - q), x, skin, index) : null
}

function bindToSkin(verts: number[], x: Float64Array, skin: Float64Array, index: Uint32Array): SkinAttachment {
  const q = new SkinQuery(Float32Array.from(skin), index)
  const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
  const tri = new Uint32Array(verts.length), bary = new Float64Array(verts.length * 2), off = new Float64Array(verts.length)
  verts.forEach((v, j) => {
    q.closest(x[v * 3]!, x[v * 3 + 1]!, x[v * 3 + 2]!, c)
    const [b1, b2, h] = planeBinding(skin, index, c.tri, x[v * 3]!, x[v * 3 + 1]!, x[v * 3 + 2]!)
    tri[j] = c.tri
    bary[j * 2] = b1
    bary[j * 2 + 1] = b2
    off[j] = h
  })
  return new SkinAttachment(Uint32Array.from(verts), tri, bary, off)
}

/**
 * 收尾：缝在一起的顶点本来就是同一点，把每组移到它们的平均位置（绑在皮肤上的顶点优先），再把落进皮肤的推出去；
 * 重复几遍。缝隙从模拟剩下的几毫米变成 0。
 * Finishing: stitched vertices are one point, so each group is moved to its mean (a vertex bound to the skin wins),
 * then anything that fell into the skin is pushed out; a few rounds. The seams go from the few millimetres the
 * simulation leaves to zero.
 */
function weldSeams(solver: ClothSolver, mesh: GarmentMesh, collider: MeshCollider): void {
  const n = solver.n
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!
    return a
  }
  for (let s = 0; s < mesh.stitches.length; s += 2) {
    const a = find(mesh.stitches[s]!), b = find(mesh.stitches[s + 1]!)
    if (a !== b) parent[a] = b
  }
  const groups = new Map<number, number[]>()
  for (let s = 0; s < mesh.stitches.length; s++) {
    const v = mesh.stitches[s]!
    const r = find(v)
    const g = groups.get(r) ?? []
    if (!g.includes(v)) g.push(v)
    groups.set(r, g)
  }
  const x = solver.x
  for (let round = 0; round < 3; round++) {
    for (const g of groups.values()) {
      const fixed = g.filter((v) => solver.w[v] === 0)
      const use = fixed.length ? fixed : g
      const m = [0, 0, 0]
      for (const v of use) for (let k = 0; k < 3; k++) m[k] = m[k]! + x[v * 3 + k]! / use.length
      for (const v of g) for (let k = 0; k < 3; k++) x[v * 3 + k] = m[k]!
    }
    solver.prev.set(x)
    collider.resolve(x, solver.prev, solver.w, solver.collisionMargin, 0)
  }
  // 腋窝处皮肤自身有重叠（两层皮相贴），夹在中间的顶点一次推不干净：再推几遍
  // at the axillae the skin overlaps itself (two layers pressed together) and a vertex caught between them is not
  // cleared in one pass: a few more passes
  for (let round = 0; round < 12; round++) collider.resolve(x, solver.prev, solver.w, solver.collisionMargin, 0)
  solver.v.fill(0)
}

const buriedCache = new Map<string, Uint8Array>()
/** 埋在身体里或夹在两层皮之间（< 15 mm）的皮肤顶点（每副人体算一次）/ Skin vertices buried in the body or caught in a pinch under 15 mm (once per body). */
export function buried(b: SkinBody): Uint8Array {
  let m = buriedCache.get(b.id)
  if (!m) buriedCache.set(b.id, (m = buriedVertices(b.rest, b.indices, 0.015)))
  return m
}

export interface DressResult {
  mesh: GarmentMesh
  positions: Float64Array
  solver: ClothSolver
  report: DressReport
}

/** 给一副人体穿一件衣服 / Dress one body in one garment. */
export interface Levels { crotchY: number; armpitY: number; sideNeckY: number }

export function dress(b: SkinBody, levels: Levels, garment: string, fabrics: Record<string, FabricMechanics>, log = (s: string) => console.log(s)): DressResult {
  const spec = readPattern(b.id, garment)
  const fabric = fabrics[spec.soma.fabric]
  if (!fabric) throw new Error(`cloth: unknown fabric ${spec.soma.fabric}`)
  const mesh = meshGarment(spec, SPACING[garment] ?? 0.01)
  if (mesh.missingSegments) throw new Error(`cloth: ${b.id}/${garment}: ${mesh.missingSegments} boundary segments missing in the triangulation`)
  const pose = dressingPose(b)
  const poser = new Poser(b.rig, b.rigBin, pose)
  const skin0 = poser.part(b.skinId, b.rest, 'dqs', false)
  const placed = placeGarment(mesh, { skin: skin0, index: b.indices, floorY: b.floorY, ...levels, joint: (id) => poser.jointCenter(id) as [number, number, number] }, { gap: 0.012 })
  const solver = new ClothSolver({ positions: placed, uv: mesh.uv, triangles: mesh.triangles, panel: mesh.panelOf, stitches: mesh.stitches, fabric })
  const collider = new MeshCollider(skin0, b.indices, 0.02, 0.03)
  solver.colliders.push(collider)
  solver.collisionMargin = Math.max(0.002, fabric.thickness)
  solver.stitchCompliance = 1e-8
  const seam = seamDistance(mesh)
  solver.self = new SelfCollision(solver.n, 0.6 * (SPACING[garment] ?? 0.01), mesh.uv, mesh.panelOf, seam, 0.1)
  solver.enable.self = false

  // 缝合：每对缝合的目标长度从起始距离线性收到 0 / sewing: every stitch's target shrinks linearly from its initial gap to 0
  const ns = mesh.stitches.length / 2
  const gap0 = new Float64Array(ns)
  for (let s = 0; s < ns; s++) {
    const a = mesh.stitches[s * 2]! * 3, c = mesh.stitches[s * 2 + 1]! * 3
    gap0[s] = Math.hypot(placed[a]! - placed[c]!, placed[a + 1]! - placed[c + 1]!, placed[a + 2]! - placed[c + 2]!)
  }
  solver.stitchRest = new Float64Array(ns)
  log(`  ${b.id}/${garment}: ${solver.n} vertices, ${mesh.triangles.length / 3} triangles, ${ns} stitch pairs, initial max gap ${(Math.max(...gap0) * 100).toFixed(1)} cm`)
  const t0 = performance.now()
  // CLOTH_DEBUG=1：每个阶段结束写一份 OBJ 到 data/raw/cloth/work/obj/ / CLOTH_DEBUG=1: an OBJ per phase into data/raw/cloth/work/obj/
  const snap = (phase: string): void => {
    if (!process.env.CLOTH_DEBUG) return
    const dir = join(ROOT, 'data', 'raw', 'cloth', 'work', 'obj')
    mkdirSync(dir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < solver.x.length; i += 3) lines.push(`v ${solver.x[i]!.toFixed(5)} ${solver.x[i + 1]!.toFixed(5)} ${solver.x[i + 2]!.toFixed(5)}`)
    for (let t = 0; t < mesh.triangles.length; t += 3) lines.push(`f ${mesh.triangles[t]! + 1} ${mesh.triangles[t + 1]! + 1} ${mesh.triangles[t + 2]! + 1}`)
    writeFileSync(join(dir, `${b.id}-${garment}-${phase}.obj`), lines.join('\n'))
  }
  snap('0placed')
  const SEW = 150, HOLD = 50, POSE = 90, SETTLE = 120
  const noG = { gravity: [0, 0, 0] as [number, number, number], substeps: 15, damping: 6, maxSpeed: 1 }
  // 缝合时不要摩擦：布要能滑过肩、胯 / no friction while sewing: the cloth must slide over shoulders and hips
  const mu = solver.fabric.friction
  solver.fabric.friction = 0
  for (let f = 0; f < SEW; f++) {
    const k = Math.max(0, 1 - (f + 1) / (SEW * 0.8))
    for (let s = 0; s < ns; s++) solver.stitchRest[s] = gap0[s]! * k
    solver.step(DT, noG)
  }
  snap('1sewn')
  log(`    sewn: max stitch gap ${(solver.maxStitchGap() * 1000).toFixed(1)} mm (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  solver.fabric.friction = mu
  solver.enable.self = true
  // 腰头：缝好后绑到皮肤上，此后跟着皮肤走；其余顶点用长程附着拴在最近的腰头顶点上
  // the waistband: bound to the skin once sewn and moved with it from then on; every other vertex is tethered to
  // the nearest waistband vertex by a long-range attachment
  // 无袖上衣的肩带窄，会从肩上滑下去：把肩缝绑住；有袖的上衣靠袖山挂得住
  // a sleeveless top has narrow straps that slide off the shoulders: its shoulder seams are bound; a top with sleeves hangs by its sleeve caps
  const sleeveless = !mesh.panels.some((p) => p.part.startsWith('arm'))
  const attach = waistAttachment(mesh, solver.x, collider.pos, b.indices) ?? (sleeveless ? shoulderAttachment(mesh, solver.x, collider.pos, b.indices, levels.armpitY + 0.12) : null)
  if (attach) {
    for (const v of attach.vertices) solver.w[v] = 0
    const geo = geodesicToAnchors(solver.n, mesh.triangles, mesh.uv, mesh.stitches, attach.vertices)
    const tv: number[] = [], ta: number[] = [], tl: number[] = []
    for (let i = 0; i < solver.n; i++) {
      if (solver.w[i] === 0 || geo.anchor[i]! < 0) continue
      tv.push(i)
      ta.push(geo.anchor[i]!)
      tl.push(geo.dist[i]! * 1.02)
    }
    solver.setTethers(tv, ta, tl)
    log(`    attached: ${attach.vertices.length} vertices bound to the skin, ${tv.length} tethers`)
  }
  const follow = (skin: ArrayLike<number>): void => {
    if (attach) attach.apply(skin, b.indices, solver.x)
  }
  for (let f = 0; f < HOLD; f++) solver.step(DT, { gravity: [0, -9.81, 0], substeps: 15, damping: 3, maxSpeed: 1 })
  snap('2hold')
  log(`    settled in the dressing pose: gap ${(solver.maxStitchGap() * 1000).toFixed(1)} mm`)
  for (let f = 0; f < POSE; f++) {
    const s = 1 - (f + 1) / POSE
    collider.update(new Poser(b.rig, b.rigBin, scalePose(pose, s)).part(b.skinId, b.rest, 'dqs', false))
    follow(collider.pos)
    solver.step(DT, { gravity: [0, -9.81, 0], substeps: 20, damping: 3, maxSpeed: 1 })
  }
  collider.update(b.rest)
  follow(collider.pos)
  // 静止姿势下再加反向检查：皮肤顶点不能从布的三角形中间穿出 / at rest, add the reverse check: no skin vertex may come out through a cloth triangle
  const reverse = new SkinVertexCollider(mesh.triangles, collider, solver.x)
  reverse.every = 4
  reverse.skip = buried(b)
  solver.colliders.push(reverse)
  // 最后 40 帧每个子步多迭代几遍，把缝线收紧 / more iterations per substep over the last 40 frames, pulling the seams shut
  for (let f = 0; f < SETTLE; f++) {
    // 最后 40 帧反向检查更勤 / the reverse check runs more often over the last 40 frames
    if (f === SETTLE - 40) reverse.every = 2
    solver.step(DT, { gravity: [0, -9.81, 0], substeps: 20, damping: 4, maxSpeed: 1, iterations: f < SETTLE - 40 ? 1 : 4 })
  }
  log(`    at rest: gap ${(solver.maxStitchGap() * 1000).toFixed(1)} mm (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  weldSeams(solver, mesh, collider)
  // 静态收尾：皮肤从布的三角形中间钻出来的地方把布推开（每个顶点累计最多 2 cm），再保证顶点都在皮肤外
  // static clean-up: where skin pokes out between cloth vertices the cloth is pushed off (at most 2 cm per vertex in
  // total), then every vertex is made to sit outside the skin again
  reverse.every = 1
  reverse.maxShift = 0.02
  // 每轮推开后马上把缝线两边合回一点（缝线常常正好压在突起上，例如前裆缝）
  // after every push the two sides of each seam are merged again at once (a seam often lies right over a protrusion,
  // such as the front crotch seam)
  for (let r = 0; r < 30; r++) {
    reverse.resolve(solver.x, solver.prev, solver.w, solver.collisionMargin)
    collider.resolve(solver.x, solver.prev, solver.w, solver.collisionMargin, 0)
    weldSeams(solver, mesh, collider)
  }
  // 诊断：最大缝隙和最大应变的位置 / diagnostics: where the largest gap and strain are
  {
    let gi = 0, gm = 0
    for (let s = 0; s < ns; s++) {
      const a = mesh.stitches[s * 2]! * 3, c = mesh.stitches[s * 2 + 1]! * 3
      const d = Math.hypot(solver.x[a]! - solver.x[c]!, solver.x[a + 1]! - solver.x[c + 1]!, solver.x[a + 2]! - solver.x[c + 2]!)
      if (d > gm) {
        gm = d
        gi = mesh.stitches[s * 2]!
      }
    }
    const st = solver.strains()
    let ti = 0
    for (let t = 0; t < st.warp.length; t++) if (Math.max(st.warp[t]!, st.weft[t]!) > Math.max(st.warp[ti]!, st.weft[ti]!)) ti = t
    const at = (i: number): string => `(${[0, 1, 2].map((k) => solver.x[i * 3 + k]!.toFixed(3)).join(', ')}) ${mesh.panels[mesh.panelOf[i]!]!.name}`
    log(`    largest gap ${(gm * 1000).toFixed(1)} mm at ${at(gi)}; largest strain ${(Math.max(st.warp[ti]!, st.weft[ti]!) * 100).toFixed(0)}% at ${at(mesh.triangles[ti * 3]!)}`)
  }
  const report = writeGarment(b, garment, spec, mesh, solver, fabric, buried(b))
  return { mesh, positions: solver.x, solver, report }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null
  const bodies = args.filter((a) => (BODIES as readonly string[]).includes(a)) as BodyId[]
  const jobs = (bodies.length ? bodies : [...BODIES]).flatMap((id) => WARDROBE[id].filter((g) => !only || only.has(g)).map((g) => [id, g] as const))
  if (args.includes('--parallel') && jobs.length > 1) {
    // 每件衣服一个进程（互不相关，结果相同）/ one process per garment (independent; identical results)
    const procs = jobs.map(([id, g]) => Bun.spawn(['bun', import.meta.path, id, '--only', g], { stdout: 'pipe', stderr: 'inherit' }))
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
    const codes = await Promise.all(procs.map((p) => p.exited))
    for (const o of outs) process.stdout.write(o)
    if (codes.some((c) => c !== 0)) process.exit(1)
  } else {
    const fabrics = readFabrics()
    for (const id of new Set(jobs.map(([b]) => b))) {
      const b = await loadSkinBody(id)
      const levels = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'cloth', 'bodies', `${id}.json`), 'utf8')) as { levelsY: Levels }
      console.log(id)
      for (const [, g] of jobs.filter(([bb]) => bb === id)) {
        const r = dress(b, levels.levelsY, g, fabrics)
        console.log(`    ${JSON.stringify(r.report)}`)
      }
    }
  }
}
