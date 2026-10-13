// 生成 public/anatomy/<body>/activity.json：节段质量、肌肉的作用路径和最大等长力、足底接触点。
//   bun tools/activity/build.ts male        （female 同理；--check 只检查是否过期）
// Writes public/anatomy/<body>/activity.json: segment masses, the muscles' paths of action and maximum isometric
// forces, and the sole contact points.
//   bun tools/activity/build.ts male        (likewise female; --check only tests staleness)
//
// 输入全部是已发布的文件：anatomy.json、各系统的 GLB、rig.json、rig.bin、shape.json，加上 data/curated/activity/ 的参数、
// data/curated/rig/opensim/ 的两个模型文件和 data/curated/calibration/ 的两张力臂对照表。绑定或几何重新生成之后，
// 重新运行这一条命令即可；activity.json 里记着各输入的哈希（activityStale）和绑定的签名（运行时核对）。
// Every input is a published file: anatomy.json, the system GLBs, rig.json, rig.bin, shape.json, plus the
// parameters under data/curated/activity/, the two model files under data/curated/rig/opensim/ and the two
// moment-arm tables under data/curated/calibration/. After the rig or the geometry is rebuilt, run this one
// command again; activity.json records a hash of every input (activityStale) and the rig's signature (checked
// at run time).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Joint, Rig } from '../../src/anatomy/types.ts'
import { rigSignature } from '../../src/activity/model.ts'
import type { ActivityData, ActivityMuscle, AnchoredPoint, Bilingual, ContactPoint, MassSegment, MuscleFlag } from '../../src/activity/types.ts'
import { meshVolume } from '../rig/geom.ts'
import { hashInput, inputFile, readBody, type Body } from '../rig/io.ts'
import { axisAngle, m3apply, type V3, type Xf, add, sub, xfApply } from '../rig/math.ts'
import { jointFrames, type Pose } from '../rig/pose.ts'
import { skinSegments } from './mass.ts'

// import.meta.dir 只有 Bun 有；测试在 Node 下跑 / import.meta.dir exists in Bun only; the tests run under Node
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CURATED = ['data/curated/activity/params.json#data', 'data/curated/activity/fibre-map.json#data', 'data/curated/calibration/muscle-curves-opensim.json#data', 'data/curated/calibration/muscle-curves-myo.json#data']
const RAW = ['data/curated/rig/opensim/gait2392_thelen2003muscle.osim', 'data/curated/rig/opensim/arm26.osim']

interface Density {
  kgm3: number
}
interface Params {
  densities: Record<string, Density>
  regions: Record<string, string>
  massMerge: { toParent: string[] }
  lockedJoints: { match: string[] }
  dofGroups: { groups: { id: string; name: Bilingual; joints: string[] }[] }
  specificTension: { ncm2: number }
  quadriceps: { match: string; patellaJoint: string; femurJoint: string; backDeg: number }
  wrap: { match: string; zh: string; en: string }[]
  retinacula: { rules: { match: string; joint: string; fixTo: string }[] }
  noLoad: { rules: { match: string; zh: string; en: string }[] }
  solver: { g: number; reservePenalty: number; limitToleranceDeg: number; contactToleranceMm: number; nearCentreMm: number }
  display: { bulgeMax: number; displayFull: number }
  sources: Record<string, { name: string; url: string; licence: string; opened: string }>
}

interface OsimMuscle {
  fiso: number
  lopt: number
  lslack: number
}

/** .osim 里每条肌肉的三个数 / Three numbers of every muscle in an .osim. */
export function readOsimMuscles(xml: string): Map<string, OsimMuscle> {
  const out = new Map<string, OsimMuscle>()
  const re = /<(Thelen2003Muscle|Schutte1993Muscle[^\s>]*|Millard2012EquilibriumMuscle)\s+name="([^"]+)">([\s\S]*?)<\/\1>/g
  const num = (body: string, tag: string): number => Number(new RegExp(`<${tag}>\\s*([-0-9.eE+]+)\\s*</${tag}>`).exec(body)?.[1] ?? NaN)
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const o = { fiso: num(m[3]!, 'max_isometric_force'), lopt: num(m[3]!, 'optimal_fiber_length'), lslack: num(m[3]!, 'tendon_slack_length') }
    if (Number.isFinite(o.fiso) && Number.isFinite(o.lopt) && Number.isFinite(o.lslack)) out.set(m[2]!, o)
  }
  return out
}

const sideOf = (name: string): 'L' | 'R' | null => (/\bleft\b/i.test(name) ? 'L' : /\bright\b/i.test(name) ? 'R' : null)
/** 去掉左右的小写名称 / Lower-case name without the side. */
const bare = (name: string): string => name.toLowerCase().replace(/\b(left|right)\s+/g, '').replace(/\s+/g, ' ').trim()
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}

function pathLength(path: AnchoredPoint[], xfs: Xf[], index: Map<string, number>): number {
  let L = 0
  let prev: V3 | null = null
  for (const p of path) {
    const w = xfApply(xfs[index.get(p.joint)!]!, p.point as V3)
    if (prev) L += Math.hypot(w[0] - prev[0], w[1] - prev[1], w[2] - prev[2])
    prev = w
  }
  return L
}

export interface BuildResult {
  data: ActivityData
  report: Record<string, unknown>
}

export async function computeActivity(bodyId: 'male' | 'female', log: (m: string) => void = () => {}): Promise<BuildResult> {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const body: Body = await readBody(dir)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const bin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const params = JSON.parse(readFileSync(join(ROOT, 'data/curated/activity/params.json'), 'utf8')) as Params
  const fibreMap = (JSON.parse(readFileSync(join(ROOT, 'data/curated/activity/fibre-map.json'), 'utf8')) as { map: { match: string; model: string; osim: string[] }[] }).map
  const deleva = JSON.parse(readFileSync(join(ROOT, 'data/curated/activity/segments-deleva.json'), 'utf8')) as Record<string, Record<string, { mass: number; cm: number }>>
  const osim: Record<string, Map<string, OsimMuscle>> = {
    gait2392: readOsimMuscles(readFileSync(join(ROOT, RAW[0]!), 'utf8')),
    arm26: readOsimMuscles(readFileSync(join(ROOT, RAW[1]!), 'utf8')),
  }
  const shape = existsSync(join(dir, 'shape.json')) ? (JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')) as { controls: { id: string; default: number }[] }) : null

  // 只记本工具真正用到的输入：部件表和各系统的几何 / only what this tool really uses: the part table and the system geometry
  const inputs: Record<string, string> = {}
  for (const [k, v] of Object.entries(body.inputs)) if (k === 'anatomy.json#parts' || k.endsWith('.glb')) inputs[k] = v
  for (const name of ['rig.json', 'rig.bin', 'shape.json']) if (existsSync(join(dir, name))) inputs[name] = hashInput(name, join(dir, name))
  for (const key of [...CURATED, ...RAW, 'data/curated/activity/segments-deleva.json#data']) inputs[key] = hashInput(key, join(ROOT, inputFile(key)))

  const joints = rig.joints
  const nJ = joints.length
  const index = new Map(joints.map((j, i) => [j.id, i]))
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))

  // ── 质量关节与身体区域 / mass joints and body regions ─────────────────────────────────────
  const toParent = params.massMerge.toParent.map((s) => new RegExp(s))
  const massJoint = joints.map((j, i) => {
    let k = i
    while (toParent.some((re) => re.test(joints[k]!.id)) && joints[k]!.parent !== null) k = index.get(joints[k]!.parent!)!
    return k
  })
  const regionNames = Object.keys(params.regions).filter((k) => !k.startsWith('_'))
  const regionOf = joints.map((j) => regionNames.find((r) => new RegExp(params.regions[r]!).test(j.id)) ?? 'trunk')

  /** 部件在各质量关节上的权重份额 / A part's share of weight on every mass joint. */
  const shares = (partId: string, n: number): Float64Array => {
    const out = new Float64Array(nJ)
    const b = bindingOf.get(partId)
    if (!b) return out
    if (b.joint !== undefined) {
      const j = index.get(b.joint)
      if (j !== undefined) out[massJoint[j]!] = 1
      return out
    }
    if (b.offset === undefined || b.vertexCount !== n) return out
    for (let i = 0; i < n; i++) {
      const o = b.offset + i * 12
      for (let k = 0; k < 4; k++) {
        const w = bin[o + 8 + k]!
        if (w) out[massJoint[dv.getUint16(o + k * 2, true)]!] = out[massJoint[dv.getUint16(o + k * 2, true)]!]! + w / (255 * n)
      }
    }
    return out
  }

  // ── 皮肤切段 / the skin cut into segments ───────────────────────────────────────────────
  const skin = body.data.parts.filter((p) => p.tissue === 'skin' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles)[0]
  if (!skin) throw new Error('activity: the body has no skin part')
  const sm = body.meshes.get(skin.id)!
  const sb = bindingOf.get(skin.id)
  if (!sb || sb.offset === undefined || sb.vertexCount !== sm.positions.length / 3) throw new Error('activity: the skin has no per-vertex binding matching its mesh')
  const nSkin = sm.positions.length / 3
  const seg = new Int32Array(nSkin)
  const acc = new Float64Array(nJ)
  for (let i = 0; i < nSkin; i++) {
    const o: number = sb.offset + i * 12
    const used: number[] = []
    for (let k = 0; k < 4; k++) {
      const w = bin[o + 8 + k]!
      if (!w) continue
      const j = massJoint[dv.getUint16(o + k * 2, true)]!
      if (acc[j] === 0) used.push(j)
      acc[j] = acc[j]! + w
    }
    let best = used[0] ?? 0
    for (const j of used) if (acc[j]! > acc[best]!) best = j
    for (const j of used) acc[j] = 0
    seg[i] = best
  }
  const segs = skinSegments(sm.positions, sm.indices, seg, nJ)
  log(`skin ${skin.id}: ${(segs.total * 1e3).toFixed(2)} L in ${[...segs.volume].filter((v) => v > 1e-6).length} segments`)

  // ── 区域成分与密度 / regional composition and density ────────────────────────────────────
  const dens = params.densities
  const tissueDensity = (tissue: string, name: string): number | null => {
    if (tissue === 'organ') return /\blung\b|lobe of (left|right) lung/i.test(name) ? dens.lung!.kgm3 : dens.organ!.kgm3
    return dens[tissue]?.kgm3 ?? null
  }
  const regionVol: Record<string, number> = {}, regionParts: Record<string, number> = {}, regionPartMass: Record<string, number> = {}
  for (const r of regionNames) regionVol[r] = regionParts[r] = regionPartMass[r] = 0
  for (let j = 0; j < nJ; j++) if (segs.volume[j]! > 0) regionVol[regionOf[j]!] = regionVol[regionOf[j]!]! + segs.volume[j]!
  const tissueVol: Record<string, number> = {}
  for (const p of body.data.parts) {
    const mesh = body.meshes.get(p.id)
    if (!mesh || p.tissue === 'skin') continue
    const rho = tissueDensity(p.tissue, p.name)
    if (rho === null) continue
    const v = Math.abs(meshVolume(mesh.positions, mesh.indices))
    const sh = shares(p.id, mesh.positions.length / 3)
    tissueVol[p.tissue] = (tissueVol[p.tissue] ?? 0) + v
    for (let j = 0; j < nJ; j++) {
      if (!sh[j]) continue
      regionParts[regionOf[j]!] = regionParts[regionOf[j]!]! + v * sh[j]!
      regionPartMass[regionOf[j]!] = regionPartMass[regionOf[j]!]! + v * sh[j]! * rho
    }
  }
  const regionDensity: Record<string, number> = {}
  for (const r of regionNames) {
    const V = regionVol[r]!, Vp = regionParts[r]!
    regionDensity[r] = V > 0 || Vp > 0 ? (regionPartMass[r]! + Math.max(0, V - Vp) * dens.fill!.kgm3) / Math.max(V, Vp) : dens.fill!.kgm3
  }
  const stature = shape?.controls.find((c) => c.id === 'stature')?.default
  const bmi = shape?.controls.find((c) => c.id === 'bmi')?.default
  if (!stature || !bmi) throw new Error('activity: shape.json with stature and bmi defaults is needed for the body mass')
  const bodyKg = bmi * stature * stature
  let computedKg = 0
  const rawSeg: { j: number; kg: number }[] = []
  for (let j = 0; j < nJ; j++) {
    if (!(segs.volume[j]! > 1e-7)) continue
    const kg = segs.volume[j]! * regionDensity[regionOf[j]!]!
    rawSeg.push({ j, kg })
    computedKg += kg
  }
  const norm = bodyKg / computedKg
  const segments: MassSegment[] = rawSeg.map(({ j, kg }) => ({ joint: joints[j]!.id, kg: Math.round(kg * norm * 1e4) / 1e4, com: [r5(segs.centroid[j * 3]!), r5(segs.centroid[j * 3 + 1]!), r5(segs.centroid[j * 3 + 2]!)] }))
  log(`mass: ${computedKg.toFixed(1)} kg from geometry and densities, normalised to ${bodyKg.toFixed(1)} kg (BMI ${bmi} × ${stature} m²), factor ${norm.toFixed(3)}`)

  // 与 de Leva 对照 / comparison with de Leva
  const ref = deleva[bodyId] ?? {}
  const paired = new Set(['upperArm', 'forearm', 'hand', 'thigh', 'shank', 'foot'])
  const regionKg: Record<string, number> = {}
  const regionCom: Record<string, [number, number, number]> = {}
  for (const s of segments) {
    const j = index.get(s.joint)!
    // 成对的区域只统计左侧 / paired regions are tallied on the left side only
    if (paired.has(regionOf[j]!) && !/_L$/.test(s.joint)) continue
    const r = regionOf[j]!
    regionKg[r] = (regionKg[r] ?? 0) + s.kg
    const c = (regionCom[r] ??= [0, 0, 0])
    for (let k = 0; k < 3; k++) c[k] = c[k]! + s.kg * s.com[k]!
  }
  const along = (a: string, b: string, c: [number, number, number]): number | null => {
    const ja = joints[index.get(a) ?? -1], jb = joints[index.get(b) ?? -1]
    if (!ja || !jb) return null
    const d = sub(jb.center as V3, ja.center as V3)
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    return ((c[0] - ja.center[0]) * d[0] + (c[1] - ja.center[1]) * d[1] + (c[2] - ja.center[2]) * d[2]) / l2
  }
  const ends: Record<string, [string, string]> = { upperArm: ['gh_L', 'elbow_L'], forearm: ['elbow_L', 'wrist_L'], thigh: ['hip_L', 'knee_L'], shank: ['knee_L', 'ankle_L'] }
  const massTable = regionNames.map((r) => {
    const kg = regionKg[r] ?? 0
    const c = regionCom[r]
    const com: [number, number, number] | null = c && kg > 0 ? [c[0] / kg, c[1] / kg, c[2] / kg] : null
    const e = ends[r]
    return {
      region: r,
      volumeL: r3((regionVol[r] ?? 0) * 1e3 * (paired.has(r) ? 0.5 : 1)),
      densityKgM3: Math.round(regionDensity[r]!),
      kg: r3(kg),
      fraction: r3(kg / bodyKg),
      deLevaFraction: ref[r]?.mass ?? null,
      comAlong: e && com ? r3(along(e[0], e[1], com) ?? NaN) : null,
      deLevaCom: e ? (ref[r]?.cm ?? null) : null,
    }
  })

  // ── 肌肉 / muscles ───────────────────────────────────────────────────────────────────────
  const neutral: Pose = {}
  for (const j of joints) if (j.dofs.some((d) => (d.neutral ?? 0) !== 0)) neutral[j.id] = j.dofs.map((d) => Math.min(d.max, Math.max(d.min, d.neutral ?? 0)))
  const xfsNeutral = jointFrames(joints, neutral).xfs
  const quadRe = new RegExp(params.quadriceps.match, 'i')
  const wrap = params.wrap.map((w) => ({ re: new RegExp(w.match, 'i'), why: { zh: w.zh, en: w.en } }))
  const calibRows: { body: string; parts: string[]; movement: string; refArmMm: number; ourLineArmMm: number | null; ref: string }[] = []
  for (const key of CURATED.slice(2)) {
    const j = JSON.parse(readFileSync(join(ROOT, inputFile(key)), 'utf8')) as { references: { id: string }[]; rows: { body: string; parts: string[]; movement: string; refArmMm: number; ourLineArmMm: number | null }[] }
    for (const r of j.rows) calibRows.push({ ...r, ref: j.references[0]?.id ?? '' })
  }
  // 每侧髌骨上的点：该侧股肌止点的平均 / the patella point per side: the mean of that side's vasti insertions
  const patellaPoint: Partial<Record<'L' | 'R', V3>> = {}
  for (const side of ['L', 'R'] as const) {
    const pj = params.quadriceps.patellaJoint.replace('{S}', side)
    const pts = rig.muscles.filter((m) => m.insertion.joint === pj && quadRe.test(body.byId.get(m.part)?.name ?? '')).map((m) => m.insertion.point as V3)
    if (pts.length) patellaPoint[side] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length]
  }
  interface Draft {
    m: ActivityMuscle
    neutralLen: number
    belly: number
    matched: { lopt: number; mtu: number; fiso: number; names: string[]; model: string } | null
    noLoad: boolean
  }
  const drafts: Draft[] = []
  rig.muscles.forEach((line, li) => {
    const part = body.byId.get(line.part)
    const mesh = body.meshes.get(line.part)
    if (!part || !mesh || !index.has(line.origin.joint) || !index.has(line.insertion.joint)) return
    const side = part.side === 'L' || part.side === 'R' ? part.side : sideOf(part.name)
    const flags: MuscleFlag[] = []
    const why: Bilingual[] = []
    let path: AnchoredPoint[] = [line.origin, line.insertion]
    const isQuad = quadRe.test(part.name) && side !== null
    if (isQuad) {
      const pj = joints[index.get(params.quadriceps.patellaJoint.replace('{S}', side!)) ?? -1]
      const fj = params.quadriceps.femurJoint.replace('{S}', side!)
      const P: V3 | undefined = line.insertion.joint === pj?.id ? (line.insertion.point as V3) : patellaPoint[side!]
      if (pj && P && index.has(fj) && pj.dofs[0]) {
        // 经过点：髌骨点绕髌骨轴往近侧（与屈膝时髌骨的运动方向相反）转 backDeg 度，固定在股骨上
        // via point: the patella point turned backDeg degrees proximally (against the patella's motion in knee flexion) about the patellar axis, fixed to the femur
        const axis = pj.axes[pj.dofs[0].axis] as V3
        const sign = (pj.dofs[0].driver?.ratio ?? 1) >= 0 ? -1 : 1
        const T = add(pj.center as V3, m3apply(axisAngle(axis, (sign * params.quadriceps.backDeg * Math.PI) / 180), sub(P, pj.center as V3)))
        path = [line.origin, { point: T.map(r5) as V3, joint: fj }, { point: P.map(r5) as V3, joint: pj.id }]
        flags.push('via')
        why.push({ zh: '路径经股骨上的经过点到髌骨（不是绑定里的直线）；膝关节力臂 ≈ 髌骨轨道半径 × 髌骨/膝传动比', en: 'path runs through a via point on the femur to the patella (not the rig’s straight line); knee moment arm ≈ patellar track radius × patella/knee ratio' })
      }
    }
    // 支持带：静止作用线上离关节中心最近的点，固定在近端节段上 / retinaculum: the point of the rest line nearest the joint centre, fixed to the proximal segment
    if (!isQuad && side !== null) {
      for (const rule of params.retinacula.rules) {
        if (!new RegExp(rule.match, 'i').test(bare(part.name))) continue
        const J = joints[index.get(rule.joint.replace('{S}', side)) ?? -1]
        const fix = rule.fixTo.replace('{S}', side)
        const oj = index.get(line.origin.joint)!, ij = index.get(line.insertion.joint)!
        const ji = J ? index.get(J.id)! : -1
        // 作用线必须跨过这个关节：一端在它的子树里，另一端不在 / the line must span the joint: one end in its subtree, the other not
        const below = (j: number): boolean => {
          for (let k: number | undefined = j; k !== undefined && k >= 0; k = joints[k]!.parent === null ? undefined : index.get(joints[k]!.parent!)) if (k === ji) return true
          return false
        }
        if (!J || !index.has(fix) || below(oj) === below(ij)) continue
        const a = line.origin.point as V3, b = line.insertion.point as V3, c = J.center as V3
        const ab = sub(b, a)
        const t = Math.min(0.98, Math.max(0.02, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2])))
        const via: V3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
        path = [line.origin, { point: via.map(r5) as V3, joint: fix }, line.insertion]
        flags.push('via')
        why.push({ zh: `路径在${J.name.zh}处加了一个固定在近端的经过点（支持带 / 踝后滑车的近似），不是绑定里的直线`, en: `path has a via point fixed proximally at the ${J.name.en} (standing for a retinaculum or malleolar pulley), not the rig's straight line` })
        break
      }
    }
    let noLoad = false
    for (const rule of params.noLoad.rules) {
      if (!new RegExp(rule.match, 'i').test(part.name)) continue
      noLoad = true
      flags.push('noload')
      why.push({ zh: `不参与负荷估计：${rule.zh}`, en: `left out of the load estimate: ${rule.en}` })
      break
    }
    for (const w of wrap) {
      if (w.re.test(part.name)) {
        flags.push('wrap')
        why.push(w.why)
        break
      }
    }
    const seenMove = new Set<string>()
    for (const r of calibRows) {
      if (r.body !== bodyId || !r.parts.includes(line.part) || r.ourLineArmMm === null) continue
      if (flags.includes('via') && /knee/i.test(r.movement)) continue
      if (Math.abs(r.ourLineArmMm - r.refArmMm) <= Math.max(8, 0.35 * Math.abs(r.refArmMm))) continue
      if (seenMove.has(r.movement)) continue
      seenMove.add(r.movement)
      if (!flags.includes('arm')) flags.push('arm')
      why.push({ zh: `${r.movement}：作用线的平均力臂 ${r.ourLineArmMm} mm，参照模型 ${r.refArmMm} mm（${r.ref}）`, en: `${r.movement}: mean moment arm of the line ${r.ourLineArmMm} mm, reference model ${r.refArmMm} mm (${r.ref})` })
    }
    const volumeCm3 = Math.abs(meshVolume(mesh.positions, mesh.indices)) * 1e6
    if (!(volumeCm3 > 0.05)) {
      flags.push('volume')
      why.push({ zh: '肌肉网格的体积接近零（不封闭或太薄），PCSA 不可靠', en: 'the muscle mesh has almost no volume (open or too thin); PCSA unreliable' })
    }
    // 肌腹长度：网格沿起止点连线方向的延伸 / belly length: extent of the mesh along the origin–insertion direction
    const o = line.origin.point as V3, ins = line.insertion.point as V3
    const d = sub(ins, o)
    const dl = Math.hypot(d[0], d[1], d[2]) || 1
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const t = ((mesh.positions[i]! - o[0]) * d[0] + (mesh.positions[i + 1]! - o[1]) * d[1] + (mesh.positions[i + 2]! - o[2]) * d[2]) / dl
      if (t < lo) lo = t
      if (t > hi) hi = t
    }
    const neutralLen = pathLength(path, xfsNeutral, index)
    const entry = fibreMap.find((f) => new RegExp(f.match).test(bare(part.name)))
    let matched: Draft['matched'] = null
    if (entry) {
      const ms = entry.osim.map((n) => osim[entry.model]?.get(`${n}_${(side ?? 'R').toLowerCase()}`) ?? osim[entry.model]?.get(n)).filter((x): x is OsimMuscle => !!x)
      if (ms.length) matched = { lopt: ms.reduce((s, x) => s + x.lopt, 0) / ms.length, mtu: ms.reduce((s, x) => s + x.lopt + x.lslack, 0) / ms.length, fiso: ms.reduce((s, x) => s + x.fiso, 0), names: entry.osim, model: entry.model }
    }
    drafts.push({ m: { part: line.part, name: part.name, line: li, path: path.map((p) => ({ point: (p.point as V3).map(r5) as V3, joint: p.joint })), volumeCm3: r3(volumeCm3), fibreM: 0, fibreBasis: '', pcsaCm2: 0, fmaxN: 0, flags, why }, neutralLen, belly: Math.max(0.005, hi - lo), matched, noLoad })
  })
  const ratios = drafts.filter((d) => d.matched).map((d) => (d.matched!.lopt * d.neutralLen) / d.matched!.mtu / d.belly)
  const defaultRatio = median(ratios)
  const sigma = params.specificTension.ncm2
  const strength: { muscle: string; oursN: number; modelN: number; ratio: number; model: string }[] = []
  for (const d of drafts) {
    if (d.matched) {
      d.m.fibreM = (d.matched.lopt * d.neutralLen) / d.matched.mtu
      d.m.fibreBasis = `${d.matched.model}: ${d.matched.names.join('+')} optimal fibre length ${r3(d.matched.lopt * 1e3)} mm × (our length ${r3(d.neutralLen * 1e3)} mm / model muscle-tendon length ${r3(d.matched.mtu * 1e3)} mm)`
    } else {
      d.m.fibreM = d.belly * defaultRatio
      d.m.fibreBasis = `assumption: belly length ${r3(d.belly * 1e3)} mm × default ratio ${r3(defaultRatio)}`
      d.m.flags.push('fibre')
      d.m.why!.push({ zh: '纤维长度用默认比例（假设）', en: 'fibre length from the default ratio (an assumption)' })
    }
    d.m.fibreM = Math.max(0.005, r5(d.m.fibreM))
    d.m.pcsaCm2 = r3(d.m.volumeCm3 / (d.m.fibreM * 100))
    d.m.fmaxN = d.noLoad ? 0 : Math.round(sigma * d.m.pcsaCm2 * 10) / 10
    if (d.matched && d.m.name.toLowerCase().includes('left')) strength.push({ muscle: d.m.name, oursN: d.m.fmaxN, modelN: Math.round(d.matched.fiso), ratio: r3(d.m.fmaxN / d.matched.fiso), model: d.matched.model })
    if (!d.m.why!.length) delete d.m.why
  }
  const muscles = drafts.map((d) => d.m)
  const withLine = new Set(muscles.map((m) => m.part))
  const excluded = body.data.parts.filter((p) => p.tissue === 'muscle' && !withLine.has(p.id)).map((p) => ({ part: p.id, name: p.name, why: 'no line of action in the rig' }))
  log(`muscles: ${muscles.length} with a path (${muscles.filter((m) => m.flags.includes('via')).length} through a via point, ${drafts.filter((d) => d.matched).length} with a model fibre length; default fibre/belly ratio ${defaultRatio.toFixed(3)}), ${excluded.length} excluded`)

  // ── 足底接触点和手 / sole contacts and hands ───────────────────────────────────────────────
  const contacts: ContactPoint[] = []
  const lowest = (re: RegExp, near?: { c: V3; r: number }): { p: V3; joint: string } | null => {
    let best: { p: V3; joint: string } | null = null
    for (const part of body.data.parts) {
      if (part.tissue !== 'bone' || !re.test(part.name)) continue
      const mesh = body.meshes.get(part.id), b = bindingOf.get(part.id)
      if (!mesh || !b?.joint) continue
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const p: V3 = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]
        if (near && Math.hypot(p[0] - near.c[0], p[1] - near.c[1], p[2] - near.c[2]) > near.r) continue
        if (!best || p[1] < best.p[1]) best = { p, joint: b.joint }
      }
    }
    return best
  }
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 'left' : 'right'
    const centre = (id: string): V3 | undefined => joints[index.get(id) ?? -1]?.center as V3 | undefined
    const put = (kind: ContactPoint['kind'], hit: { p: V3; joint: string } | null): void => {
      if (hit) contacts.push({ side, kind, joint: hit.joint, point: hit.p.map(r5) as V3 })
    }
    put('heel', lowest(new RegExp(`^${s} calcaneus$`, 'i')))
    const c1 = centre(`mtp1_${side}`), c5 = centre(`mtp5_${side}`)
    if (c1) put('ball', lowest(new RegExp(`^${s} first metatarsal`, 'i'), { c: c1, r: 0.025 }))
    if (c5) put('ball', lowest(new RegExp(`^${s} fifth metatarsal`, 'i'), { c: c5, r: 0.025 }))
    // 脚趾不作接触点：否则地面反力经趾骨传递，足内在肌会被算成满负荷（真实的脚由足底腱膜和脂肪垫分担）
    // toes are not contact points: the reaction would pass through the phalanges and saturate the intrinsic foot muscles (a real foot shares it through the plantar aponeurosis and fat pads)
  }
  const hands: ActivityData['hands'] = {}
  for (const side of ['L', 'R'] as const) {
    const palm = joints[index.get(`mcp3_${side}`) ?? -1]
    if (palm && index.has(`wrist_${side}`)) hands[side] = { point: (palm.center as V3).map(r5) as V3, joint: `wrist_${side}` }
  }
  log(`contacts: ${contacts.length} sole points; hands: ${Object.keys(hands).join(', ')}`)

  const locked = params.lockedJoints.match.map((s) => new RegExp(s))
  const data: ActivityData = {
    schema: 1,
    body: bodyId,
    inputs,
    rigSignature: rigSignature(rig),
    mass: { bodyKg: r3(bodyKg), statureM: stature, bmi, computedKg: r3(computedKg), segments },
    muscles,
    excluded,
    contacts,
    hands,
    lockedJoints: joints.filter((j: Joint) => locked.some((re) => re.test(j.id))).map((j) => j.id),
    dofGroups: params.dofGroups.groups.map((g) => ({ id: g.id, name: g.name, joints: g.joints.filter((id) => index.has(id)) })),
    params: {
      specificTensionNcm2: sigma,
      g: params.solver.g,
      reservePenalty: params.solver.reservePenalty,
      limitTolerance: r5((params.solver.limitToleranceDeg * Math.PI) / 180),
      contactTolerance: params.solver.contactToleranceMm / 1000,
      nearCentre: params.solver.nearCentreMm / 1000,
      bulgeMax: params.display.bulgeMax,
      displayFull: params.display.displayFull,
    },
    sources: Object.entries(params.sources).map(([id, s]) => ({ id, ...s })),
    cautions: [
      { zh: '“长度变化”是几何：作用线（起点到止点的直线，股四头肌经髌骨）在当前姿势下的长度与静止姿势相比。它不说明肌肉是否在用力。', en: '"Length change" is geometry: the length of the line of action (a straight line from origin to insertion; the quadriceps through the patella) in this pose against the rest pose. It does not say whether the muscle is working.' },
      { zh: '“负荷”是估计：静力优化（最小化激活度平方和）给出的、抵抗重力保持这个姿势所需的肌肉激活度。它不是肌电图，也不是测量值。', en: '"Load" is an estimate: the activations that static optimisation (least sum of squared activations) needs to hold this pose against gravity. It is neither an EMG nor a measurement.' },
      { zh: '简化：静止不动（没有惯性）；只有重力和可选的手持重物；没有协同收缩（真人为了稳定关节会让拮抗肌一起用力）；没有韧带和关节囊的被动力，只有关节到达活动范围极限时算作被动承担。', en: 'Simplifications: static (no inertia); gravity and an optional hand-held load only; no co-contraction (people co-activate antagonists to stabilise joints); no passive force of ligaments or capsules, except that a joint at the end of its range is taken to be held passively.' },
      { zh: '作用线是直线，不绕过骨和关节：三角肌、臀大肌、髂腰肌、屈膝较深时的股四头肌、手和足的长肌腱都因此不可靠，列表里带 ⚠。力臂与参照模型不符的肌肉同样带 ⚠。', en: 'Lines of action are straight and do not wrap round bone or joints: the deltoid, gluteus maximus, iliopsoas, the quadriceps in deeper knee flexion and the long tendons of hand and foot are unreliable for that reason and carry ⚠ in the list, as do muscles whose moment arms disagree with the reference models.' },
      { zh: `最大肌力 = PCSA × 比张力（${sigma} N/cm²，假设）；PCSA = 我们的肌肉体积 / 纤维长度；${muscles.filter((m) => m.flags.includes('fibre')).length} / ${muscles.length} 条肌肉的纤维长度用的是默认比例（假设）。激活度的绝对值因此不可信，可以看的是谁在用力、谁没有。`, en: `Maximum force = PCSA × specific tension (${sigma} N/cm², an assumption); PCSA = our muscle volume / fibre length; ${muscles.filter((m) => m.flags.includes('fibre')).length} of ${muscles.length} muscles use the default fibre-length ratio (an assumption). Absolute activations are therefore not to be trusted; what can be read is which muscles work and which do not.` },
      { zh: `${excluded.length} 个肌肉部件没有作用线，不参与计算（多裂肌、腹内斜肌等）；它们跨过的关节上的力矩会由别的肌肉或残差承担。`, en: `${excluded.length} muscle parts have no line of action and take no part (multifidus, internal oblique and others); torque at the joints they span falls to other muscles or to the residual.` },
      { zh: '节段质量由皮肤围出的体积乘以区域平均密度得到，再归一化到 BMI × 身高²；改变体型时所有节段按同一比例变重。站立时两脚的受力按足底接触点分配，重心投影落在支撑面外时会注明。', en: 'Segment masses are the volume enclosed by the skin times a regional mean density, normalised to BMI × stature²; changing body shape scales every segment alike. When standing, load is shared between the sole contact points, and a centre of mass outside the support is stated.' },
    ],
  }
  const report = {
    schema: 1,
    body: bodyId,
    inputs,
    mass: { bodyKg: data.mass.bodyKg, computedKg: data.mass.computedKg, normalisation: r3(norm), skinVolumeL: r3(segs.total * 1e3), tissueVolumeL: Object.fromEntries(Object.entries(tissueVol).map(([k, v]) => [k, r3(v * 1e3)])), regions: massTable, note: 'paired regions: left side only; deLevaFraction and deLevaCom are de Leva 1996 values as tabulated in BMClab/BMC (see data/curated/activity/segments-deleva.json)' },
    fibre: { matched: drafts.filter((d) => d.matched).length, defaultBellyRatio: r3(defaultRatio) },
    strengthCheck: { specificTensionNcm2: sigma, medianRatio: r3(median(strength.map((s) => s.ratio))), rows: strength, note: 'ours = PCSA × specific tension; model = max_isometric_force summed over the mapped fascicles (left side shown)' },
    flags: Object.fromEntries((['wrap', 'arm', 'fibre', 'via', 'volume', 'noload'] as MuscleFlag[]).map((f) => [f, muscles.filter((m) => m.flags.includes(f)).length])),
    excluded: excluded.length,
  }
  return { data, report }
}

/** activity.json 记录的输入是否仍与磁盘上的文件一致；返回不一致的项（空 = 没有过期）。 */
/** Whether the inputs recorded in activity.json still match the files on disk; returns the mismatches (empty = current). */
export function activityStale(bodyDir: string): string[] {
  const p = join(bodyDir, 'activity.json')
  if (!existsSync(p)) return ['activity.json is missing']
  const data = JSON.parse(readFileSync(p, 'utf8')) as ActivityData
  const out: string[] = []
  for (const [name, hash] of Object.entries(data.inputs)) {
    const file = inputFile(name)
    const path = file.startsWith('data/') ? join(ROOT, file) : join(bodyDir, file)
    if (!existsSync(path)) out.push(`${name}: missing`)
    else if (hashInput(name, path) !== hash) out.push(`${name}: changed`)
  }
  const rigPath = join(bodyDir, 'rig.json')
  if (existsSync(rigPath) && rigSignature(JSON.parse(readFileSync(rigPath, 'utf8')) as Rig) !== data.rigSignature) out.push('rig signature: changed')
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const bodyId = (args.find((a) => !a.startsWith('--')) ?? 'male') as 'male' | 'female'
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  if (args.includes('--check')) {
    const s = activityStale(dir)
    console.log(s.length ? `activity.json of ${bodyId} is stale:\n  ${s.join('\n  ')}` : `activity.json of ${bodyId} is current`)
    process.exit(s.length ? 1 : 0)
  }
  const t0 = performance.now()
  const { data, report } = await computeActivity(bodyId, (m) => console.log(`[activity ${bodyId} ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`))
  const json = JSON.stringify(data)
  writeFileSync(join(dir, 'activity.json'), json)
  writeFileSync(join(dir, 'activity.report.json'), JSON.stringify(report, null, 1))
  console.log(`activity.json ${(json.length / 1024).toFixed(0)} KB, activity.report.json written`)
  console.table((report.mass as { regions: unknown[] }).regions)
  console.table((report.strengthCheck as { rows: unknown[] }).rows)
}
