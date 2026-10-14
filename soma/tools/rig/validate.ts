// 骨架绑定的数值与图像验证：摆出一组标准姿势，逐项量化，并离线渲染 PNG。
// Numeric and visual validation of the rig: pose a set of standard postures, measure, and render PNGs offline.
//
//   rest        静止姿势必须与输入完全一致 / the rest pose must reproduce the input
//   bones       活动关节处骨与骨的穿入和关节间隙 / bone-to-bone penetration and joint gap at the moving joints
//   softInBone  肌肉、血管、神经落在骨内的比例（与静止时对比） / share of muscle, vessel and nerve surface inside bone (against rest)
//   volume      肌肉体积在修正前后的变化 / muscle volume before and after the volume correction
//   stretch     各部件的最大边长拉伸比（是否撕裂） / largest edge stretch ratio per part (tearing)
//   corridors   尺神经、腘血管、坐骨神经是否仍在关节的正确一侧 / do the ulnar nerve, popliteal vessels and sciatic nerve stay on the right side of their joint
//   skin        皮肤三角形翻转、塌缩、自相交采样；手臂皮肤是否粘在躯干上 / flipped or collapsed skin triangles, self-intersection sampling, arm skin welded to the trunk
//   opensim     肌肉长度—关节角曲线与 OpenSim 模型对比 / muscle length versus joint angle against OpenSim models

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Part, TissueId } from '../../src/anatomy/types.ts'
import type { BuildResult } from './build.ts'
import { Surface, meshVolume } from './geom.ts'
import type { Body } from './io.ts'
import { type V3, dist, rad, sub, xfApply, xfInv, xfMul } from './math.ts'
import { OsimModel } from './opensim.ts'
import { type Pose, BYTES_PER_VERTEX, Poser, correctMuscleVolume, muscleLength, straightLine } from './pose.ts'
import { PoseBuilder, standardPostures } from './postures.ts'
import { type RenderItem, type Rgb, render, sheet } from './render.ts'

export interface BonePairStat {
  a: string
  b: string
  /** a 的采样点落在 b 内部的比例与最大深度（mm）；取两个方向中较大者。 Share of samples of one bone inside the other and the deepest penetration (mm); the worse of both directions. */
  insidePct: number
  /** 静止姿势下（即输入数据本身）已有的穿入比例。 Share already inside in the rest pose, i.e. in the input data. */
  insideRestPct: number
  maxDepthMm: number
  /** 接触面平均间隙（mm）：静止 / 当前。 Mean gap of the contact patch (mm): rest / posed. */
  gapRestMm: number
  gapPosedMm: number
}

export interface PostureReport {
  id: string
  name: { zh: string; en: string }
  bones: BonePairStat[]
  /** 各组织：落在骨内的顶点比例（%）与深于 1 mm 的比例（%）。 Per tissue: share of vertices inside bone (%) and deeper than 1 mm (%). */
  softInBone: Record<string, { insidePct: number; deepPct: number; sampled: number }>
  /** 各组织：全部边的拉伸比（当前长度 / 静止长度）的第 99、99.9 百分位，超过 2 倍的边所占比例（%），最大值及其所在部件。 Per tissue, over all edges: 99th and 99.9th percentile of the stretch ratio (posed / rest length), share of edges stretched more than 2× (%), the maximum and the part it occurs in. */
  stretch: Record<string, { p99: number; p999: number; over2Pct: number; max: number; worst: string }>
  volume: { muscles: number; lengthChanged: number; medianAbsErrSkinnedPct: number; medianAbsErrUniformPct: number; medianAbsErrTaperedPct: number; p90AbsErrSkinnedPct: number; p90AbsErrUniformPct: number; p90AbsErrTaperedPct: number }
  skin: { flippedPct: number; collapsedPct: number; selfInsidePct: number; minAreaRatio: number; maxEdgeStretch: number; stretchedAreaCm2: number }
  /** 深部结构（骨、肌、腱、韧带、软骨、血管、神经）穿出当前皮肤的顶点比例（%）与最深穿出量（mm）；皮肤不是单层闭合曲面时为 null。 Share of deep-part vertices (bone, muscle, tendon, ligament, cartilage, vessels, nerves) outside the posed skin (%) and the farthest one (mm); null when the skin is not a closed single wall. */
  poke: { sampled: number; outsidePct: number; over2mmPct: number; worstMm: number; worstPart: string } | null
  corridors: { what: string; ok: boolean; behindMm: number; axisDistanceMm: number; axisDistanceRestMm: number; insideBonePct: number; detail: string }[]
}

export interface OpenSimRow {
  muscle: string
  part: string
  model: string
  coordinate: string
  /** 关节角范围内 OpenSim 的长度变化（mm）与平均力臂（mm）。 OpenSim's length change over the sweep (mm) and mean moment arm (mm). */
  osRangeMm: number
  osArmMm: number
  /** 本骨架：直线作用线 / 变形后网格的路径（起点 → 各段质心 → 止点）。 This rig: straight line of action / path through the deformed mesh (origin → slice centroids → insertion). */
  lineRangeMm: number | null
  lineR: number | null
  lineRmsMm: number | null
  meshRangeMm: number
  meshR: number
  meshRmsMm: number
  /** 归一化均方根差 = rms / OpenSim 长度变化范围。 Normalised RMS difference = rms / OpenSim's range. */
  meshNrms: number
  note?: string
}

export interface ValidationReport {
  rest: { maxDisplacementLbsMm: number; maxDisplacementDqsMm: number }
  weights: { partsWithoutBinding: number; partsWithTwoBindings: number; badWeightSums: number; badJointIndices: number }
  armSkin: { forearmVerts: number; maxTrunkWeightForearm: number; upperArmVerts: number; maxTrunkWeightDistalUpperArm: number; trunkVerts: number; maxArmWeightTrunkBelowAxilla: number }
  postures: PostureReport[]
  opensim: OpenSimRow[]
  opensimNote: string
  renders: string[]
  clamped: Record<string, string[]>
}

const COLORS: Partial<Record<TissueId, Rgb>> = {
  bone: [228, 218, 192], cartilage: [160, 205, 230], muscle: [178, 62, 58], tendon: [226, 222, 204], ligament: [205, 205, 180], artery: [214, 40, 40], vein: [52, 84, 190], nerve: [236, 200, 60], skin: [228, 180, 150],
}

const pct = (a: number, b: number): number => (b ? Math.round((1000 * a) / b) / 10 : 0)
const r2 = (x: number): number => Math.round(x * 100) / 100
const quantile = (v: number[], q: number): number => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

export function validate(body: Body, build: BuildResult, outDir: string | null, log: (m: string) => void = () => {}): ValidationReport {
  const { rig, bin } = build
  const parts = body.data.parts.filter((p) => body.meshes.has(p.id))
  const byName = new Map<string, Part>()
  for (const p of parts) if (!byName.has(p.name)) byName.set(p.name, p)
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
  const jointIndex = new Map(rig.joints.map((j, i) => [j.id, i]))
  const boneJoint = new Map<string, number>()
  build.built.forEach((j, i) => j.boneIds.forEach((b) => boneJoint.set(b, i)))
  const surfaces = new Map<string, Surface>()
  const surf = (id: string): Surface => {
    let s = surfaces.get(id)
    if (!s) surfaces.set(id, (s = new Surface(body.meshes.get(id)!)))
    return s
  }
  const postures = standardPostures(rig.joints)
  const clamped: Record<string, string[]> = {}

  // ── 权重完整性 / integrity of the bindings ─────────────────────────────────────────────────
  const count = new Map<string, number>()
  for (const b of rig.bindings) count.set(b.part, (count.get(b.part) ?? 0) + 1)
  let badSums = 0, badIdx = 0
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (const b of rig.bindings) {
    if (b.offset === undefined) continue
    for (let i = 0; i < b.vertexCount!; i++) {
      const o = b.offset + i * BYTES_PER_VERTEX
      let s = 0
      for (let k = 0; k < 4; k++) {
        s += bin[o + 8 + k]!
        if (bin[o + 8 + k]! > 0 && dv.getUint16(o + k * 2, true) >= rig.joints.length) badIdx++
      }
      if (s !== 255) badSums++
    }
  }
  const weights = { partsWithoutBinding: parts.filter((p) => !count.has(p.id)).length, partsWithTwoBindings: [...count.values()].filter((c) => c > 1).length, badWeightSums: badSums, badJointIndices: badIdx }

  // ── 静止姿势 / rest pose ───────────────────────────────────────────────────────────────────
  const restPoser = new Poser(rig, bin, {})
  let maxL = 0, maxD = 0
  for (const p of parts) {
    const rest = body.meshes.get(p.id)!.positions
    for (const [mode, set] of [['lbs', (v: number) => (maxL = Math.max(maxL, v))], ['dqs', (v: number) => (maxD = Math.max(maxD, v))]] as const) {
      const out = restPoser.part(p.id, rest, mode)
      let m = 0
      for (let i = 0; i < out.length; i++) m = Math.max(m, Math.abs(out[i]! - rest[i]!))
      set(m)
    }
  }
  const rest = { maxDisplacementLbsMm: maxL * 1000, maxDisplacementDqsMm: maxD * 1000 }
  log(`rest pose: max displacement ${rest.maxDisplacementLbsMm.toExponential(2)} mm (LBS), ${rest.maxDisplacementDqsMm.toExponential(2)} mm (DQS)`)

  // ── 手臂皮肤是否粘在躯干上 / is the arm skin welded to the trunk ───────────────────────────
  const skinPart = parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]
  const armSkin = { forearmVerts: 0, maxTrunkWeightForearm: 0, upperArmVerts: 0, maxTrunkWeightDistalUpperArm: 0, trunkVerts: 0, maxArmWeightTrunkBelowAxilla: 0 }
  if (skinPart) {
    const b = bindingOf.get(skinPart.id)!
    const isTrunk = rig.joints.map((j) => /^(rib\d+_[LR]|[TL]\d+|pelvis|si_[LR])$/.test(j.id))
    const isFore = rig.joints.map((j) => /^(elbow|radioulnar|wrist|mcp\d|pip\d|dip\d|cmc1|ip1)_[LR]$/.test(j.id))
    const isUpper = rig.joints.map((j) => /^gh_[LR]$/.test(j.id))
    const pos = body.meshes.get(skinPart.id)!.positions
    const elbowY = (rig.joints[jointIndex.get('elbow_L')!]!.center[1] + rig.joints[jointIndex.get('elbow_R')!]!.center[1]) / 2
    const shoulderY = rig.joints[jointIndex.get('gh_L')!]!.center[1]
    const distalY = elbowY + 0.3 * (shoulderY - elbowY)
    if (b.offset !== undefined) {
      for (let i = 0; i < b.vertexCount!; i++) {
        const o = b.offset + i * BYTES_PER_VERTEX
        let trunk = 0, fore = 0, upper = 0, dom = -1, domW = 0
        for (let k = 0; k < 4; k++) {
          const w = bin[o + 8 + k]! / 255, j = dv.getUint16(o + k * 2, true)
          if (w === 0) continue
          if (isTrunk[j]) trunk += w
          if (isFore[j]) fore += w
          if (isUpper[j]) upper += w
          if (w > domW) (domW = w), (dom = j)
        }
        const y = pos[i * 3 + 1]!
        if (dom >= 0 && isFore[dom]) (armSkin.forearmVerts++, (armSkin.maxTrunkWeightForearm = Math.max(armSkin.maxTrunkWeightForearm, trunk)))
        if (dom >= 0 && isUpper[dom] && y < distalY) (armSkin.upperArmVerts++, (armSkin.maxTrunkWeightDistalUpperArm = Math.max(armSkin.maxTrunkWeightDistalUpperArm, trunk)))
        if (dom >= 0 && isTrunk[dom] && y < distalY) (armSkin.trunkVerts++, (armSkin.maxArmWeightTrunkBelowAxilla = Math.max(armSkin.maxArmWeightTrunkBelowAxilla, fore + upper)))
      }
    }
    armSkin.maxTrunkWeightForearm = r2(armSkin.maxTrunkWeightForearm)
    armSkin.maxTrunkWeightDistalUpperArm = r2(armSkin.maxTrunkWeightDistalUpperArm)
    armSkin.maxArmWeightTrunkBelowAxilla = r2(armSkin.maxArmWeightTrunkBelowAxilla)
  }

  // ── 各姿势 / per posture ───────────────────────────────────────────────────────────────────
  const softTissues: TissueId[] = ['muscle', 'tendon', 'artery', 'vein', 'nerve']
  const rigidBones = parts.filter((p) => boneJoint.has(p.id))
  /** 软组织部件可能碰到的骨：邻接的骨。 Bones a soft part may run into: its adjacent bones. */
  const nearBones = new Map<string, string[]>()
  for (const p of parts) if (softTissues.includes(p.tissue)) nearBones.set(p.id, p.adjacent.filter((a) => boneJoint.has(a)))
  // 扩大候选：按包围盒再加上附近的骨（姿势改变后才靠近的骨由此覆盖不到，但邻接的骨是主要风险）
  // candidates are widened by bounding box below; bones that only come near after posing are not covered, adjacent bones being the main risk
  const restVolume = new Map<string, number>()
  const lineOf = new Map(build.allLines.map((m) => [m.part, m]))
  for (const m of rig.muscles) {
    const mesh = body.meshes.get(m.part)
    if (mesh) restVolume.set(m.part, Math.abs(meshVolume(mesh.positions, mesh.indices)))
  }

  const softInBone = (poser: Poser, posedOf: (p: Part) => Float32Array): PostureReport['softInBone'] => {
    const out: PostureReport['softInBone'] = {}
    const inv = poser.xfs.map(xfInv)
    for (const p of parts) {
      const bones = nearBones.get(p.id)
      if (!bones || !bones.length) continue
      const pos = posedOf(p)
      const o = (out[p.tissue] ??= { insidePct: 0, deepPct: 0, sampled: 0 })
      const n = pos.length / 3
      for (let i = (p.id.charCodeAt(p.id.length - 1) & 3) % 4; i < n; i += 4) {
        const v: V3 = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]
        let inside = false, deep = false
        for (const b of bones) {
          const q = xfApply(inv[boneJoint.get(b)!]!, v)
          const s = surf(b)
          if (s.boxDistance(q[0], q[1], q[2]) > 0 || !s.contains(q[0], q[1], q[2])) continue
          inside = true
          if (s.distance(q[0], q[1], q[2], 0.05) > 0.001) deep = true
          if (deep) break
        }
        o.sampled++
        if (inside) o.insidePct++
        if (deep) o.deepPct++
      }
    }
    for (const o of Object.values(out)) (o.insidePct = pct(o.insidePct, o.sampled)), (o.deepPct = pct(o.deepPct, o.sampled))
    return out
  }

  const bonePairs = (poser: Poser, focus: string[]): BonePairStat[] => {
    const out: BonePairStat[] = []
    const seen = new Set<string>()
    for (const jid of focus) {
      const ji = jointIndex.get(jid)
      if (ji === undefined) continue
      for (const a of build.built[ji]!.boneIds) {
        for (const b of body.byId.get(a)!.adjacent) {
          const bj = boneJoint.get(b)
          if (bj === undefined || bj === ji) continue
          const key = a < b ? `${a}|${b}` : `${b}|${a}`
          if (seen.has(key)) continue
          seen.add(key)
          const one = (x: string, y: string): { inside: number; inside0: number; depth: number; gap0: number; gap1: number } => {
            const sx = surf(x).samples(0.002), sy = surf(y)
            const toY = xfMul(xfInv(poser.xfs[boneJoint.get(y)!]!), poser.xfs[boneJoint.get(x)!]!)
            const d0: number[] = [], d1: number[] = []
            let inside = 0, depth = 0, inside0 = 0
            for (const s of sx) {
              const r = sy.distance(s.p[0], s.p[1], s.p[2], 0.03)
              if (Number.isFinite(r)) {
                d0.push(r)
                if (r < 0.01 && sy.contains(s.p[0], s.p[1], s.p[2])) inside0++
              }
              const q = xfApply(toY, s.p)
              const d = sy.distance(q[0], q[1], q[2], 0.03)
              if (!Number.isFinite(d)) continue
              if (sy.contains(q[0], q[1], q[2])) {
                inside++
                depth = Math.max(depth, d)
              } else d1.push(d)
            }
            // 接触面：静止时 3 mm 以内的采样数；两种状态都取最近的这么多个采样求平均
            // contact patch: as many samples as lie within 3 mm at rest; the nearest that many are averaged in both states
            d0.sort((u, v) => u - v)
            d1.sort((u, v) => u - v)
            const n = Math.max(20, d0.filter((v) => v <= 0.003).length)
            const mean = (v: number[]): number => (v.length ? v.slice(0, n).reduce((s, x2) => s + x2, 0) / Math.min(n, v.length) : NaN)
            return { inside: inside / sx.length, inside0: inside0 / sx.length, depth, gap0: mean(d0), gap1: mean(d1) }
          }
          const ab = one(a, b), ba = one(b, a)
          out.push({ a: body.byId.get(a)!.name, b: body.byId.get(b)!.name, insidePct: r2(100 * Math.max(ab.inside, ba.inside)), insideRestPct: r2(100 * Math.max(ab.inside0, ba.inside0)), maxDepthMm: r2(1000 * Math.max(ab.depth, ba.depth)), gapRestMm: r2(1000 * Math.min(ab.gap0, ba.gap0)), gapPosedMm: r2(1000 * Math.min(ab.gap1, ba.gap1)) })
        }
      }
    }
    return out.sort((x, y) => y.maxDepthMm - x.maxDepthMm)
  }

  const stretchOf = (posedOf: (p: Part) => Float32Array): PostureReport['stretch'] => {
    // 每种组织把所有边的拉伸比汇成直方图（步长 0.02，上限 20）
    // per tissue a histogram of the stretch ratio of every edge (step 0.02, capped at 20)
    const per: Record<string, { h: Uint32Array; n: number; worst: string; max: number }> = {}
    for (const p of parts) {
      if (bindingOf.get(p.id)?.offset === undefined) continue
      const mesh = body.meshes.get(p.id)!
      const a = mesh.positions, b = posedOf(p), idx = mesh.indices
      const o = (per[p.tissue] ??= { h: new Uint32Array(1001), n: 0, worst: '', max: 0 })
      let mx = 1
      for (let t = 0; t < idx.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const i = idx[t + e]! * 3, j = idx[t + ((e + 1) % 3)]! * 3
          const l0 = Math.hypot(a[i]! - a[j]!, a[i + 1]! - a[j + 1]!, a[i + 2]! - a[j + 2]!)
          if (l0 < 0.0005) continue
          const r = Math.hypot(b[i]! - b[j]!, b[i + 1]! - b[j + 1]!, b[i + 2]! - b[j + 2]!) / l0
          o.h[Math.min(1000, Math.floor(r / 0.02))] = o.h[Math.min(1000, Math.floor(r / 0.02))]! + 1
          o.n++
          if (r > mx) mx = r
        }
      }
      if (mx > o.max) (o.max = mx), (o.worst = p.name)
    }
    const out: PostureReport['stretch'] = {}
    for (const [t, o] of Object.entries(per)) {
      const q = (f: number): number => {
        let c = 0
        for (let k = 0; k <= 1000; k++) {
          c += o.h[k]!
          if (c >= f * o.n) return r2((k + 0.5) * 0.02)
        }
        return 20
      }
      let over2 = 0
      for (let k = 100; k <= 1000; k++) over2 += o.h[k]!
      out[t] = { p99: q(0.99), p999: q(0.999), over2Pct: Math.round((1e4 * over2) / Math.max(1, o.n)) / 100, max: r2(o.max), worst: o.worst }
    }
    return out
  }

  const volumeOf = (poser: Poser): PostureReport['volume'] => {
    const eS: number[] = [], eU: number[] = [], eT: number[] = []
    let changed = 0
    for (const m of rig.muscles) {
      const mesh = body.meshes.get(m.part)
      const v0 = restVolume.get(m.part)
      if (!mesh || !v0 || v0 < 1e-7) continue
      // 体积修正按直线长度（见 straightLine）/ the volume correction follows the straight-line length (see straightLine)
      const L = muscleLength(straightLine(m), poser.xfs, poser.jointIndex)
      if (Math.abs(L.length / L.rest - 1) < 0.03) continue
      changed++
      const skinned = poser.part(m.part, mesh.positions, 'dqs', false)
      eS.push(Math.abs(Math.abs(meshVolume(skinned, mesh.indices)) / v0 - 1))
      for (const [mode, arr] of [['uniform', eU], ['tapered', eT]] as const) {
        const c = Float32Array.from(skinned)
        correctMuscleVolume(c, m, poser.xfs, poser.jointIndex, { mode })
        arr.push(Math.abs(Math.abs(meshVolume(c, mesh.indices)) / v0 - 1))
      }
    }
    const f = (v: number[], q: number): number => r2(100 * quantile(v, q))
    return { muscles: rig.muscles.length, lengthChanged: changed, medianAbsErrSkinnedPct: f(eS, 0.5), medianAbsErrUniformPct: f(eU, 0.5), medianAbsErrTaperedPct: f(eT, 0.5), p90AbsErrSkinnedPct: f(eS, 0.9), p90AbsErrUniformPct: f(eU, 0.9), p90AbsErrTaperedPct: f(eT, 0.9) }
  }

  // 皮肤：静止时“法线方向外侧 5 cm 内没有背面”的顶点作为基线，姿势下若出现背面则视为陷入另一处皮肤
  // skin: vertices whose outward ray meets no back face within 5 cm at rest form the baseline; meeting one when posed counts as lying inside another fold of skin
  const skinNormals = (pos: Float32Array, idx: Uint32Array): Float32Array => {
    const n = new Float32Array(pos.length)
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
      const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!
      const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      for (const k of [a, b, c]) (n[k] = n[k]! + nx), (n[k + 1] = n[k + 1]! + ny), (n[k + 2] = n[k + 2]! + nz)
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1
      ;(n[i] = n[i]! / l), (n[i + 1] = n[i + 1]! / l), (n[i + 2] = n[i + 2]! / l)
    }
    return n
  }
  const insideSkin = (pos: Float32Array, idx: Uint32Array, sample: number[]): boolean[] => {
    const s = new Surface({ positions: pos, indices: idx })
    const nrm = skinNormals(pos, idx)
    return sample.map((i) => {
      const o: V3 = [pos[i * 3]! + nrm[i * 3]! * 0.0008, pos[i * 3 + 1]! + nrm[i * 3 + 1]! * 0.0008, pos[i * 3 + 2]! + nrm[i * 3 + 2]! * 0.0008]
      const e: V3 = [o[0] + nrm[i * 3]! * 0.05, o[1] + nrm[i * 3 + 1]! * 0.05, o[2] + nrm[i * 3 + 2]! * 0.05]
      const h = s.firstHit(o, e)
      return !!h && h.backFace
    })
  }
  let skinSample: number[] = []
  if (skinPart) {
    const m = body.meshes.get(skinPart.id)!
    const all = Array.from({ length: Math.floor(m.positions.length / 3 / 5) }, (_, k) => k * 5)
    const base = insideSkin(m.positions, m.indices, all)
    skinSample = all.filter((_, k) => !base[k])
  }
  const skinOf = (posed: Float32Array): PostureReport['skin'] => {
    if (!skinPart) return { flippedPct: 0, collapsedPct: 0, selfInsidePct: 0, minAreaRatio: 1, maxEdgeStretch: 1, stretchedAreaCm2: 0 }
    const m = body.meshes.get(skinPart.id)!
    const a = m.positions, idx = m.indices
    let flipped = 0, collapsed = 0, minRatio = Infinity, total = 0
    const n1 = skinNormals(posed, idx)
    for (let t = 0; t < idx.length; t += 3) {
      const i = idx[t]! * 3, j = idx[t + 1]! * 3, k = idx[t + 2]! * 3
      const area = (p: Float32Array): [number, number, number, number] => {
        const ux = p[j]! - p[i]!, uy = p[j + 1]! - p[i + 1]!, uz = p[j + 2]! - p[i + 2]!
        const vx = p[k]! - p[i]!, vy = p[k + 1]! - p[i + 1]!, vz = p[k + 2]! - p[i + 2]!
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        const l = Math.hypot(nx, ny, nz)
        return [l / 2, nx / (l || 1), ny / (l || 1), nz / (l || 1)]
      }
      const [a0] = area(a)
      const [a1, nx, ny, nz] = area(posed)
      if (a0 < 1e-9) continue
      total++
      const ratio = a1 / a0
      if (ratio < minRatio) minRatio = ratio
      if (ratio < 0.2) collapsed++
      // 翻转：三角形法线与它三个顶点的平均顶点法线相反 / flipped: the face normal opposes the mean of its three vertex normals
      const mx = n1[i]! + n1[j]! + n1[k]!, my = n1[i + 1]! + n1[j + 1]! + n1[k + 1]!, mz = n1[i + 2]! + n1[j + 2]! + n1[k + 2]!
      if (nx * mx + ny * my + nz * mz < 0) flipped++
    }
    const ins = insideSkin(posed, idx, skinSample)
    // “蹼”的量度：有任一条边被拉长到 2 倍以上的三角形，在当前姿势下的总面积
    // measure of webbing: total posed area of the triangles with any edge stretched beyond 2×
    let mxStretch = 1, webArea = 0
    for (let t = 0; t < idx.length; t += 3) {
      let worst = 1
      for (let e = 0; e < 3; e++) {
        const i = idx[t + e]! * 3, j = idx[t + ((e + 1) % 3)]! * 3
        const l0 = Math.hypot(a[i]! - a[j]!, a[i + 1]! - a[j + 1]!, a[i + 2]! - a[j + 2]!)
        if (l0 < 0.001) continue
        worst = Math.max(worst, Math.hypot(posed[i]! - posed[j]!, posed[i + 1]! - posed[j + 1]!, posed[i + 2]! - posed[j + 2]!) / l0)
      }
      mxStretch = Math.max(mxStretch, worst)
      if (worst > 2) {
        const i = idx[t]! * 3, j = idx[t + 1]! * 3, k = idx[t + 2]! * 3
        const ux = posed[j]! - posed[i]!, uy = posed[j + 1]! - posed[i + 1]!, uz = posed[j + 2]! - posed[i + 2]!
        const vx = posed[k]! - posed[i]!, vy = posed[k + 1]! - posed[i + 1]!, vz = posed[k + 2]! - posed[i + 2]!
        webArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
      }
    }
    return { flippedPct: pct(flipped, total), collapsedPct: pct(collapsed, total), selfInsidePct: pct(ins.filter(Boolean).length, skinSample.length), minAreaRatio: r2(minRatio), maxEdgeStretch: r2(mxStretch), stretchedAreaCm2: Math.round(webArea * 1e5) / 10 }
  }

  // 深部结构穿出皮肤：皮肤是单层闭合曲面时，用射线奇偶性判断顶点在皮肤内外
  // deep parts through the skin: with a closed single-walled skin, ray parity tells inside from outside
  const DEEP: TissueId[] = ['bone', 'muscle', 'tendon', 'ligament', 'cartilage', 'artery', 'vein', 'nerve']
  const pokeOf = (posedSkin: Float32Array, posedOf: (p: Part) => Float32Array): NonNullable<PostureReport['poke']> => {
    const s = new Surface({ positions: posedSkin, indices: body.meshes.get(skinPart!.id)!.indices })
    let n = 0, out = 0, over = 0, worst = 0, worstPart = ''
    for (const p of parts) {
      if (!DEEP.includes(p.tissue)) continue
      const pos = posedOf(p)
      for (let i = (p.id.charCodeAt(p.id.length - 1) & 7) * 3; i < pos.length; i += 24) {
        n++
        if (s.contains(pos[i]!, pos[i + 1]!, pos[i + 2]!)) continue
        out++
        const d = s.distance(pos[i]!, pos[i + 1]!, pos[i + 2]!, 0.2)
        if (d > 0.002) over++
        if (Number.isFinite(d) && d > worst) (worst = d), (worstPart = p.name)
      }
    }
    return { sampled: n, outsidePct: pct(out, n), over2mmPct: pct(over, n), worstMm: r2(worst * 1000), worstPart }
  }

  // 走行通道：静止时位于关节中心某半径内的那一段，摆姿势后应仍在关节的屈侧（后方）。屈侧方向取
  // 近端骨与远端骨各自“后方”的角平分线，这样屈膝 90° 时指向腘窝。
  // Corridors: the stretch of a structure lying within a radius of the joint centre at rest must
  // still be on the flexor (posterior) side of the joint when posed. That side is the bisector of
  // the "posterior" directions of the proximal and the distal bone, which points into the
  // popliteal fossa when the knee is at 90°.
  const corridor = (poser: Poser, posedOf: (p: Part) => Float32Array, what: string, nameRe: RegExp, jointId: string, radius: number, minBehindMm: number): PostureReport['corridors'][number] | null => {
    const ps = parts.filter((p) => nameRe.test(p.name))
    const ji = jointIndex.get(jointId)
    if (!ps.length || ji === undefined) return null
    const parentId = rig.joints[ji]!.parent
    const pi = parentId === null ? undefined : jointIndex.get(parentId)
    if (pi === undefined) return null
    const c = rig.joints[ji]!.center as V3
    const cPosed = poser.jointCenter(jointId)
    const back = (i: number): V3 => {
      const r = poser.xfs[i]!.r
      return [-r[2], -r[5], -r[8]]
    }
    const b0 = back(pi), b1 = back(ji)
    const bl = Math.hypot(b0[0] + b1[0], b0[1] + b1[1], b0[2] + b1[2]) || 1
    const dir: V3 = [(b0[0] + b1[0]) / bl, (b0[1] + b1[1]) / bl, (b0[2] + b1[2]) / bl]
    // 关节轴在当前姿势下的方向 / the joint axis as posed
    const ax0 = rig.joints[ji]!.axes[0] as V3
    const rj = poser.xfs[ji]!.r
    const ax: V3 = [rj[0] * ax0[0] + rj[1] * ax0[1] + rj[2] * ax0[2], rj[3] * ax0[0] + rj[4] * ax0[1] + rj[5] * ax0[2], rj[6] * ax0[0] + rj[7] * ax0[1] + rj[8] * ax0[2]]
    let nearest = Infinity, nearest0 = Infinity, behind = 0, n = 0, inside = 0
    const bones = [...build.built[ji]!.boneIds, ...build.built[pi]!.boneIds]
    const inv = poser.xfs.map(xfInv)
    for (const p of ps) {
      const rest0 = body.meshes.get(p.id)!.positions, pos = posedOf(p)
      for (let i = 0; i < pos.length; i += 3) {
        const r0: V3 = [rest0[i]! - c[0], rest0[i + 1]! - c[1], rest0[i + 2]! - c[2]]
        if (Math.hypot(r0[0], r0[1], r0[2]) > radius) continue
        n++
        // 到关节轴的距离：静止 / 当前 / distance from the joint axis: rest / posed
        const k0 = r0[0] * ax0[0] + r0[1] * ax0[1] + r0[2] * ax0[2]
        nearest0 = Math.min(nearest0, Math.hypot(r0[0] - k0 * ax0[0], r0[1] - k0 * ax0[1], r0[2] - k0 * ax0[2]))
        const r1: V3 = [pos[i]! - cPosed[0], pos[i + 1]! - cPosed[1], pos[i + 2]! - cPosed[2]]
        const k1 = r1[0] * ax[0] + r1[1] * ax[1] + r1[2] * ax[2]
        const d1 = Math.hypot(r1[0] - k1 * ax[0], r1[1] - k1 * ax[1], r1[2] - k1 * ax[2])
        if (d1 < nearest) {
          nearest = d1
          behind = r1[0] * dir[0] + r1[1] * dir[1] + r1[2] * dir[2]
        }
        for (const b of bones) {
          const qb = xfApply(inv[boneJoint.get(b)!]!, [pos[i]!, pos[i + 1]!, pos[i + 2]!])
          const sb = surf(b)
          if (sb.boxDistance(qb[0], qb[1], qb[2]) === 0 && sb.contains(qb[0], qb[1], qb[2]) && sb.distance(qb[0], qb[1], qb[2], 0.05) > 0.001) {
            inside++
            break
          }
        }
      }
    }
    if (!n) return null
    // 通过：离关节轴最近的那一点仍在屈侧；没有贴向关节轴（距离不小于静止时的 60%）；陷入骨内的不超过 5%
    // passes when the point nearest the joint axis is still on the flexor side, the structure has not closed in on the axis (at least 60 % of its rest distance), and at most 5 % of it lies inside bone
    const ok = behind * 1000 >= minBehindMm && nearest >= 0.6 * nearest0 && inside / n <= 0.05
    return { what, ok, behindMm: Math.round(behind * 1000), axisDistanceMm: Math.round(nearest * 1000), axisDistanceRestMm: Math.round(nearest0 * 1000), insideBonePct: pct(inside, n), detail: `${ps.length} part(s), ${n} vertices within ${Math.round(radius * 1000)} mm of the joint at rest. The point nearest the joint axis lies ${Math.round(behind * 1000)} mm to the flexor side (required ≥ ${minBehindMm}) and ${Math.round(nearest * 1000)} mm from the axis (${Math.round(nearest0 * 1000)} mm at rest); ${pct(inside, n)} % of the vertices are deeper than 1 mm inside bone (allowed 5).` }
  }

  const reports: PostureReport[] = []
  const renders: string[] = []
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  for (const post of postures) {
    const t0 = performance.now()
    const poser = new Poser(rig, bin, post.pose)
    const cache = new Map<string, Float32Array>()
    const posedOf = (p: Part): Float32Array => {
      let v = cache.get(p.id)
      if (!v) cache.set(p.id, (v = poser.part(p.id, body.meshes.get(p.id)!.positions, 'dqs', { mode: 'tapered' })))
      return v
    }
    const corridors = [
      corridor(poser, posedOf, 'ulnar nerve behind the elbow (left)', /^Left ulnar nerve$/i, 'elbow_L', 0.03, 0),
      corridor(poser, posedOf, 'popliteal artery and vein behind the knee (left)', /^Left popliteal (artery|vein)$/i, 'knee_L', 0.05, 0),
      corridor(poser, posedOf, 'sciatic nerve behind the hip joint (left)', /^Left sciatic nerve$/i, 'hip_L', 0.07, 0),
    ].filter((x): x is NonNullable<typeof x> => !!x)
    const rep: PostureReport = {
      id: post.id,
      name: post.name,
      bones: bonePairs(poser, post.focus),
      softInBone: softInBone(poser, posedOf),
      stretch: stretchOf(posedOf),
      volume: volumeOf(poser),
      skin: skinPart ? skinOf(posedOf(skinPart)) : { flippedPct: 0, collapsedPct: 0, selfInsidePct: 0, minAreaRatio: 1, maxEdgeStretch: 1, stretchedAreaCm2: 0 },
      poke: skinPart && build.fieldStats.skinWalls === 1 && !build.skinOpen ? pokeOf(posedOf(skinPart), posedOf) : null,
      corridors,
    }
    reports.push(rep)
    if (outDir) {
      const items = (pred: (p: Part) => boolean): RenderItem[] => parts.filter(pred).map((p) => ({ positions: posedOf(p), indices: body.meshes.get(p.id)!.indices, color: COLORS[p.tissue] ?? [200, 200, 200] }))
      const skinItems = items((p) => p === skinPart)
      const deep = items((p) => p.tissue === 'bone' || p.tissue === 'muscle' || p.tissue === 'tendon' || (p.tissue === 'cartilage' && p.system === 'skeletal'))
      const wires = items((p) => p.tissue === 'bone' || p.tissue === 'artery' || p.tissue === 'vein' || p.tissue === 'nerve' || p.tissue === 'ligament')
      const full = (it: RenderItem[], yaw: number) => render(it, { yaw, center: [0, 0.82, 0.1], halfHeight: 0.95, width: 480, height: 720 })
      const tiles = [full(skinItems, 20), full(skinItems, 100), full(deep, 20), full(deep, 100)]
      if (post.closeUp) {
        const cs = post.closeUp.joints.filter((j) => jointIndex.has(j)).map((j) => poser.jointCenter(j))
        if (cs.length) {
          const c: V3 = [cs.reduce((s, v) => s + v[0], 0) / cs.length, cs.reduce((s, v) => s + v[1], 0) / cs.length, cs.reduce((s, v) => s + v[2], 0) / cs.length]
          const close = (it: RenderItem[], yaw: number) => render(it, { yaw, center: c, halfHeight: post.closeUp!.halfHeight, width: 480, height: 720 })
          tiles.push(close(skinItems, post.closeUp.yaw), close(deep, post.closeUp.yaw), close(wires, post.closeUp.yaw), close(items((p) => p.tissue === 'bone'), post.closeUp.yaw))
        }
      }
      const file = join(outDir, `${post.id}.png`)
      sheet(tiles, 4).save(file)
      renders.push(file)
    }
    log(`posture ${post.id}: ${Math.round(performance.now() - t0)} ms`)
  }
  for (const post of postures) if (post.clamped.length) clamped[post.id] = post.clamped

  // ── OpenSim 对比 / comparison with OpenSim ─────────────────────────────────────────────────
  const opensim: OpenSimRow[] = []
  let opensimNote = ''
  const osDir = join(import.meta.dirname, '..', '..', 'data', 'curated', 'rig', 'opensim')
  const gaitPath = join(osDir, 'gait2392_thelen2003muscle.osim'), armPath = join(osDir, 'arm26.osim')
  if (existsSync(gaitPath) && existsSync(armPath)) {
    const gait = new OsimModel(readFileSync(gaitPath, 'utf8')), arm = new OsimModel(readFileSync(armPath, 'utf8'))
    const restOf = (id: string, axis: number): number => {
      const j = rig.joints[jointIndex.get(id)!]!
      const d = j.dofs.find((x) => x.axis === axis) as { neutral?: number } | undefined
      return -(d?.neutral ?? 0)
    }
    interface Sweep { model: OsimModel; modelName: string; coord: string; sign: number; joint: string; axis: number; from: number; to: number; fixed?: Pose }
    const sweeps: Record<string, Sweep> = {
      knee: { model: gait, modelName: 'gait2392', coord: 'knee_angle_r', sign: -1, joint: 'knee_R', axis: 0, from: 0, to: 120 },
      hip: { model: gait, modelName: 'gait2392', coord: 'hip_flexion_r', sign: 1, joint: 'hip_R', axis: 0, from: -10, to: 90 },
      hipAdd: { model: gait, modelName: 'gait2392', coord: 'hip_adduction_r', sign: -1, joint: 'hip_R', axis: 1, from: -10, to: 40 },
      ankle: { model: gait, modelName: 'gait2392', coord: 'ankle_angle_r', sign: 1, joint: 'ankle_R', axis: 0, from: -40, to: 12 },
      elbow: { model: arm, modelName: 'arm26', coord: 'r_elbow_flex', sign: 1, joint: 'elbow_R', axis: 0, from: 15, to: 130 },
    }
    const cases: [string, string[], keyof typeof sweeps][] = [
      ['Right rectus femoris', ['rect_fem_r'], 'knee'], ['Right rectus femoris', ['rect_fem_r'], 'hip'],
      ['Right vastus lateralis', ['vas_lat_r'], 'knee'], ['Right vastus medialis', ['vas_med_r'], 'knee'], ['Right vastus intermedius', ['vas_int_r'], 'knee'],
      ['Long head of right biceps femoris', ['bifemlh_r'], 'knee'], ['Long head of right biceps femoris', ['bifemlh_r'], 'hip'],
      ['Right semitendinosus', ['semiten_r'], 'knee'], ['Right semitendinosus', ['semiten_r'], 'hip'],
      ['Right semimembranosus', ['semimem_r'], 'knee'], ['Right semimembranosus', ['semimem_r'], 'hip'],
      ['Medial head of right gastrocnemius', ['med_gas_r'], 'knee'], ['Medial head of right gastrocnemius', ['med_gas_r'], 'ankle'],
      ['Lateral head of right gastrocnemius', ['lat_gas_r'], 'knee'], ['Lateral head of right gastrocnemius', ['lat_gas_r'], 'ankle'],
      ['Right soleus', ['soleus_r'], 'ankle'], ['Right tibialis anterior', ['tib_ant_r'], 'ankle'],
      ['Right gluteus maximus', ['glut_max1_r', 'glut_max2_r', 'glut_max3_r'], 'hip'],
      ['Right gluteus medius', ['glut_med1_r', 'glut_med2_r', 'glut_med3_r'], 'hipAdd'],
      ['Right iliacus', ['iliacus_r'], 'hip'], ['Right psoas major', ['psoas_r'], 'hip'],
      ['Long head of right biceps brachii', ['BIClong'], 'elbow'], ['Short head of right biceps brachii', ['BICshort'], 'elbow'],
      ['Long head of right triceps brachii', ['TRIlong'], 'elbow'], ['Lateral head of right triceps brachii', ['TRIlat'], 'elbow'], ['Medial head of right triceps brachii', ['TRImed'], 'elbow'],
      ['Right brachialis', ['BRA'], 'elbow'],
    ]
    const corr = (x: number[], y: number[]): number => {
      const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length
      let sxy = 0, sxx = 0, syy = 0
      for (let i = 0; i < x.length; i++) (sxy += (x[i]! - mx) * (y[i]! - my)), (sxx += (x[i]! - mx) ** 2), (syy += (y[i]! - my) ** 2)
      return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
    }
    const rms = (x: number[], y: number[]): number => Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]!) ** 2, 0) / x.length)
    for (const [partName, osNames, sweepKey] of cases) {
      const sw = sweeps[sweepKey]!
      const part = byName.get(partName)
      if (!part || !jointIndex.has(sw.joint) || !osNames.every((n) => sw.model.muscles.has(n))) continue
      const mesh = body.meshes.get(part.id)!
      const line = lineOf.get(part.id)
      const restAngle = restOf(sw.joint, sw.axis)
      const angles: number[] = []
      for (let k = 0; k <= 10; k++) angles.push(sw.from + ((sw.to - sw.from) * k) / 10)
      const os: number[] = [], ln: number[] = [], ms: number[] = []
      // 网格中心线：按静止时沿主方向的参数把顶点分成 14 段，逐段取质心连成折线
      // mesh centreline: vertices binned in 14 slices by their rest parameter along the muscle's main direction; slice centroids form a polyline
      const o0 = line ? (line.origin.point as V3) : null, i0 = line ? (line.insertion.point as V3) : null
      let dir: V3, base: V3, span: number
      if (o0 && i0) {
        base = o0
        const d = sub(i0, o0)
        span = Math.hypot(d[0], d[1], d[2])
        dir = [d[0] / span, d[1] / span, d[2] / span]
      } else {
        // 没有作用线：取包围盒最长轴 / no line of action: the longest axis of the bounding box
        const bb = part.bbox
        const ext = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]]
        const k = ext.indexOf(Math.max(...ext))
        dir = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]
        base = [bb[0], bb[1], bb[2]]
        span = ext[k]!
      }
      const nb = 14
      const bin2 = new Int32Array(mesh.positions.length / 3)
      for (let i = 0; i < bin2.length; i++) {
        const t = ((mesh.positions[i * 3]! - base[0]) * dir[0] + (mesh.positions[i * 3 + 1]! - base[1]) * dir[1] + (mesh.positions[i * 3 + 2]! - base[2]) * dir[2]) / span
        bin2[i] = Math.min(nb - 1, Math.max(0, Math.floor(t * nb)))
      }
      const centreline = (pos: Float32Array, ends: [V3, V3] | null): number => {
        const c = new Float64Array(nb * 3), n = new Int32Array(nb)
        for (let i = 0; i < bin2.length; i++) {
          const b2 = bin2[i]!
          ;(c[b2 * 3] = c[b2 * 3]! + pos[i * 3]!), (c[b2 * 3 + 1] = c[b2 * 3 + 1]! + pos[i * 3 + 1]!), (c[b2 * 3 + 2] = c[b2 * 3 + 2]! + pos[i * 3 + 2]!)
          n[b2] = n[b2]! + 1
        }
        let L = 0, prev: V3 | null = ends ? ends[0] : null
        for (let b2 = 0; b2 < nb; b2++) {
          if (!n[b2]) continue
          const p: V3 = [c[b2 * 3]! / n[b2]!, c[b2 * 3 + 1]! / n[b2]!, c[b2 * 3 + 2]! / n[b2]!]
          if (prev) L += dist(prev, p)
          prev = p
        }
        if (ends && prev) L += dist(prev, ends[1])
        return L
      }
      for (const a of angles) {
        const q: Record<string, number> = { [sw.coord]: sw.sign * rad(a) }
        os.push((1000 * osNames.reduce((s, n) => s + sw.model.length(n, q), 0)) / osNames.length)
        const pb = new PoseBuilder(rig.joints).rel(sw.joint, sw.axis, rad(a) - restAngle)
        const poser = new Poser(rig, bin, pb.pose)
        const ml = line ? muscleLength(line, poser.xfs, poser.jointIndex) : null
        if (ml) ln.push(1000 * ml.length)
        // 路径：起点 → 各段质心 → 止点 / path: origin → slice centroids → insertion
        ms.push(1000 * centreline(poser.part(part.id, mesh.positions, 'dqs', false), ml ? [ml.origin, ml.insertion] : null))
      }
      // 以扫过范围的中点为参照，比较长度变化 / length change relative to the middle of the sweep
      const rel = (v: number[]): number[] => v.map((x) => x - v[5]!)
      const dOs = rel(os), dMs = rel(ms), dLn = ln.length ? rel(ln) : null
      const range = (v: number[]): number => v[v.length - 1]! - v[0]!
      const osRange = range(os)
      opensim.push({
        muscle: osNames.join('+'), part: partName, model: sw.modelName, coordinate: `${sw.coord} ${sw.from}…${sw.to}°`,
        osRangeMm: r2(osRange), osArmMm: r2(Math.abs(osRange) / rad(sw.to - sw.from)),
        lineRangeMm: dLn ? r2(range(ln)) : null, lineR: dLn ? r2(corr(dOs, dLn)) : null, lineRmsMm: dLn ? r2(rms(dOs, dLn)) : null,
        meshRangeMm: r2(range(ms)), meshR: r2(corr(dOs, dMs)), meshRmsMm: r2(rms(dOs, dMs)), meshNrms: r2(rms(dOs, dMs) / Math.max(1, Math.abs(osRange))),
        note: osNames.some((n) => sw.model.muscles.get(n)!.ignoredWraps.length) ? `OpenSim wrap surfaces ignored: ${osNames.flatMap((n) => sw.model.muscles.get(n)!.ignoredWraps).join(', ')}` : undefined,
      })
    }
    opensimNote = `gait2392 (${gait.credits.split('License')[0]!.trim().slice(0, 80)}…; CC BY 3.0) for the lower limb, arm26 (CC BY 3.0) for the elbow. Lengths come from the path points (conditional and moving points, cylinder wraps) read from the .osim files; OpenSim itself was not run. Curves are compared as length change about the middle of the sweep, in mm, without scaling for body size.`
    log(`opensim: ${opensim.length} muscle × coordinate curves compared`)
  } else opensimNote = 'OpenSim model files not found under data/curated/rig/opensim; comparison skipped.'

  return { rest, weights, armSkin, postures: reports, opensim, opensimNote, renders, clamped }
}
