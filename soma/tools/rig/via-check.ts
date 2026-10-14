// 经过点对网格影响的客观检查：同一姿势下，有经过点与去掉经过点（纯蒙皮）的肌肉网格相比。
// 现在网格不随经过点变形，两者应当相同；这个工具留着，用来衡量以后任何随路径变形的网格。
//   bun tools/rig/via-check.ts [male|female ...]
// An objective check of what via points do to the meshes: in the same pose, the muscle meshes with via points against the
// same rig with the via points removed (plain skinning). The meshes no longer deform along the via points, so the two
// should be the same; the tool stays to measure any future mesh that follows the path.
//   bun tools/rig/via-check.ts [male|female ...]
//
// 三个量 / three quantities
//   · 边的拉伸比（当前长度 / 静止长度）的 p99 和最大值 / edge stretch ratio (current / rest length), p99 and max
//   · 翻转的三角形：法线与按最大权重关节转过去的静止法线方向相反 / inverted triangles: normal opposite to the rest normal turned by the joint of largest weight
//   · 骨面覆盖：股骨远端前面、髌骨和股骨髁后面的采样点，沿外法线的射线 6 cm 之内碰到肌肉的比例
//     bone coverage: the fraction of samples on the anterior distal femur, the patella and the posterior condyles whose outward ray meets muscle within 6 cm
// 门槛：有经过点时拉伸和翻转不多于没有时，覆盖不少于没有时（见 tests/rig-via-check.test.ts）。
// Gate: with via points, stretch and inversions no more than without, coverage no less (see tests/rig-via-check.test.ts).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuscleLine, Rig } from '../../src/anatomy/types.ts'
import { type Body, readBody } from './io.ts'
import { type V3, cross, dot, m3apply, norm, sub } from './math.ts'
import { BYTES_PER_VERTEX, Poser, clampPose, type Pose } from './pose.ts'
import { standardPostures } from './postures.ts'
import { kneeFrame, readViaFile, toKnee } from './via.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const RAY = 0.06

export interface CheckRow {
  body: string
  pose: string
  stretchP99: [number, number]
  stretchMax: [number, number]
  inverted: [number, number]
  coverage: { anteriorFemur: [number, number]; patella: [number, number]; posteriorCondyles: [number, number] }
}

export function checkPoses(rig: Rig): { id: string; pose: Pose }[] {
  const squat = standardPostures(rig.joints).find((p) => p.id === 'squat')!
  const k = (deg: number): Pose => ({ knee_R: [(deg * Math.PI) / 180], knee_L: [(deg * Math.PI) / 180] })
  return [{ id: 'flex90', pose: clampPose(rig.joints, k(90)) }, { id: 'flex135', pose: clampPose(rig.joints, k(135)) }, { id: 'squat', pose: clampPose(rig.joints, squat.pose) }]
}

function rayHitsTriangle(o: V3, d: V3, a: V3, b: V3, c: V3): number | null {
  const e1 = sub(b, a), e2 = sub(c, a)
  const p = cross(d, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-12) return null
  const t0 = sub(o, a)
  const u = dot(t0, p) / det
  if (u < 0 || u > 1) return null
  const q = cross(t0, e1)
  const v = dot(d, q) / det
  if (v < 0 || u + v > 1) return null
  const t = dot(e2, q) / det
  return t > 1e-4 ? t : null
}

/** 一副身体、一个姿势：两种网格的三个量 / One body, one pose: the three quantities for both meshes. */
export function checkPose(body: Body, rig: Rig, bin: Uint8Array, pose: Pose, viaParts: Set<string>): Omit<CheckRow, 'body' | 'pose'> {
  const plainRig: Rig = { ...rig, muscles: rig.muscles.map((m) => { const { via: _v, ...rest } = m as MuscleLine; return rest }) }
  const posers = [new Poser(plainRig, bin, pose), new Poser(rig, bin, pose)]
  const jointIndex = posers[1]!.jointIndex
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
  const stretch: number[][] = [[], []], inverted = [0, 0]
  // 膝周的全部肌肉（含没有经过点的）都参与覆盖 / every muscle round the knee (with or without via points) takes part in coverage
  const vf = readViaFile()
  const frames = (['L', 'R'] as const).map((s) => kneeFrame(rig, s, vf)!)
  const nearKnee = (p: V3): boolean => frames.some((f) => Math.hypot(p[0] - f.C[0], p[1] - f.C[1], p[2] - f.C[2]) < 0.15)
  const coverParts = body.data.parts.filter((p) => p.tissue === "muscle" && body.meshes.has(p.id) && nearKnee(p.centroid as V3)).map((p) => p.id)
  const tris: { a: V3; b: V3; c: V3 }[][] = [[], []]
  for (const id of new Set([...coverParts, ...viaParts])) {
    const mesh = body.meshes.get(id)
    if (!mesh) continue
    const b = bindingOf.get(id)
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    posers.forEach((poser, v) => {
      const out = poser.part(id, mesh.positions, 'dqs', { mode: 'tapered' })
      const P = (i: number): V3 => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!]
      const R = (i: number): V3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]
      const idx = mesh.indices
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!
        const a = P(i0), bb = P(i1), c = P(i2)
        if (coverParts.includes(id)) tris[v]!.push({ a, b: bb, c })
        if (!viaParts.has(id)) continue
        for (const [x, y] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
          const r = Math.hypot(...sub(R(x), R(y)))
          if (r > 1e-6) stretch[v]!.push(Math.hypot(...sub(P(x), P(y))) / r)
        }
        // 静止法线按顶点 0 权重最大的关节转动 / rest normal turned by the joint of largest weight at vertex 0
        let j = b?.joint !== undefined ? jointIndex.get(b.joint)! : 0
        if (b?.offset !== undefined) {
          const o = b.offset + i0 * BYTES_PER_VERTEX
          let best = -1
          for (let k = 0; k < 4; k++) if (bin[o + 8 + k]! > best) (best = bin[o + 8 + k]!), (j = dv.getUint16(o + k * 2, true))
        }
        const n0 = m3apply(poser.xfs[j]!.r, cross(sub(R(i1), R(i0)), sub(R(i2), R(i0))))
        if (dot(n0, cross(sub(bb, a), sub(c, a))) < 0) inverted[v]!++
      }
    })
  }
  // 骨面采样：股骨远端前面、髌骨、股骨髁后面（按膝关节坐标）/ bone samples: anterior distal femur, patella, posterior condyles (in knee coordinates)
  const cov = { anteriorFemur: [0, 0] as [number, number], patella: [0, 0] as [number, number], posteriorCondyles: [0, 0] as [number, number] }
  const counts = { anteriorFemur: 0, patella: 0, posteriorCondyles: 0 }
  for (const side of ['L', 'R'] as const) {
    const f = frames[side === 'L' ? 0 : 1]!
    const s = side === 'L' ? 'left' : 'right'
    for (const part of body.data.parts) {
      const which = new RegExp(`^${s} femur$`, 'i').test(part.name) ? 'femur' : new RegExp(`^${s} patella$`, 'i').test(part.name) ? 'patella' : null
      const mesh = which && body.meshes.get(part.id)
      if (!which || !mesh) continue
      const xf = posers[0]!.xfs[jointIndex.get(bindingOf.get(part.id)?.joint ?? '') ?? -1]
      if (!xf) continue
      // 顶点法线（面积加权）/ vertex normals (area weighted)
      const n = new Float64Array(mesh.positions.length)
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [i0, i1, i2] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]
        const p = (i: number): V3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]
        const fn = cross(sub(p(i1), p(i0)), sub(p(i2), p(i0)))
        for (const i of [i0, i1, i2]) for (let q = 0; q < 3; q++) n[i * 3 + q] = n[i * 3 + q]! + fn[q]!
      }
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const p: V3 = [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]
        const q = toKnee(f, p)
        const key = which === 'patella' ? 'patella' : q.down > -0.06 && q.down < 0.01 && q.post < -0.005 ? 'anteriorFemur' : Math.abs(q.down) < 0.025 && q.post > 0.012 ? 'posteriorCondyles' : null
        if (!key) continue
        const o: V3 = [xf.r[0] * p[0] + xf.r[1] * p[1] + xf.r[2] * p[2] + xf.t[0], xf.r[3] * p[0] + xf.r[4] * p[1] + xf.r[5] * p[2] + xf.t[1], xf.r[6] * p[0] + xf.r[7] * p[1] + xf.r[8] * p[2] + xf.t[2]]
        const d = norm(m3apply(xf.r, [n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!]))
        counts[key]++
        for (let v = 0; v < 2; v++) if (tris[v]!.some((t) => { const h = rayHitsTriangle(o, d, t.a, t.b, t.c); return h !== null && h < RAY })) cov[key][v] = cov[key][v]! + 1
      }
    }
  }
  const q = (a: number[], f: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 1 }
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const frac = (k: keyof typeof counts): [number, number] => [r3(cov[k][0] / Math.max(1, counts[k])), r3(cov[k][1] / Math.max(1, counts[k]))]
  return {
    stretchP99: [r3(q(stretch[0]!, 0.99)), r3(q(stretch[1]!, 0.99))],
    stretchMax: [r3(q(stretch[0]!, 1)), r3(q(stretch[1]!, 1))],
    inverted: [inverted[0]!, inverted[1]!],
    coverage: { anteriorFemur: frac('anteriorFemur'), patella: frac('patella'), posteriorCondyles: frac('posteriorCondyles') },
  }
}

export async function checkBody(bodyId: 'male' | 'female', dir = join(ROOT, 'public', 'anatomy', bodyId)): Promise<CheckRow[]> {
  const body = await readBody(join(ROOT, 'public', 'anatomy', bodyId))
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const bin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  const viaParts = new Set(rig.muscles.filter((m) => m.via?.length).map((m) => m.part))
  return checkPoses(rig).map(({ id, pose }) => ({ body: bodyId, pose: id, ...checkPose(body, rig, bin, pose, viaParts) }))
}

if (import.meta.main) {
  const bodies = (process.argv.slice(2).filter((a) => !a.startsWith('--')) as ('male' | 'female')[])
  for (const b of bodies.length ? bodies : (['male', 'female'] as const)) for (const row of await checkBody(b)) console.log(JSON.stringify(row))
}
