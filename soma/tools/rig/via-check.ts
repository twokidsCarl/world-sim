// 经过点对网格影响的客观检查：同一姿势下，有经过点（网格随路径变形）与去掉经过点（纯蒙皮）的肌肉网格相比。
//   bun tools/rig/via-check.ts [male|female ...]
// An objective check of what via points do to the meshes: in the same pose, the muscle meshes with via points (the mesh
// following the path) against the same rig with the via points removed (plain skinning).
//   bun tools/rig/via-check.ts [male|female ...]
//
// 各量 / the quantities
//   · 边的拉伸比（当前长度 / 静止长度）的 p99 和最大值（有经过点的肌肉）
//     edge stretch ratio (current / rest length), p99 and max (muscles with via points)
//   · 翻转的三角形：法线与按最大权重关节转过去的静止法线方向相反（有经过点的肌肉）
//     inverted triangles: normal opposite to the rest normal turned by the joint of largest weight (muscles with via points)
//   · 肌肉入骨：有经过点的肌肉落在膝周骨（股骨、胫骨、髌骨、腓骨，两侧）里面的顶点数，以及按这些顶点分摊的三角形面积（cm²）。
//     内外用封闭骨网格上的射线奇偶判断（三个坐标轴方向投票）；骨网格先检查是否封闭（每条边恰好两个三角形、方向一致）。
//     muscle in bone: the number of vertices of the muscles with via points that lie inside a bone of the knee region
//     (femur, tibia, patella, fibula, both sides), and the triangle area shared out to those vertices (cm²). Inside is
//     decided by ray parity on the closed bone meshes (a vote of three axis directions); the bone meshes are first
//     checked to be closed (every edge in exactly two triangles, consistently oriented).
//   · 骨面覆盖：股骨远端前面、髌骨和股骨髁后面的采样点，沿外法线的射线 6 cm 之内碰到的第一个面（肌肉或膝周骨）
//     是在骨外的肌肉：命中点不在任何膝周骨里，所命中的三角形也没有顶点在骨里。膝周肌肉 = 部件中心离膝 15 cm 以内的肌肉
//     加上全部有经过点的肌肉。
//     bone coverage: the fraction of samples on the anterior distal femur, the patella and the posterior condyles
//     whose outward ray, within 6 cm, first meets a surface (muscle or knee bone) that is muscle lying outside the bone:
//     the hit point is inside no knee bone, and no vertex of the triangle hit is inside one. Knee-region muscles = the
//     muscles whose part centre is within 15 cm of a knee, plus every muscle with via points.
//   · 皮肤外：有经过点的肌肉落在摆好姿势的皮肤外面的顶点数和最远距离（毫米）。皮肤网格有开口（不封闭），所以不用奇偶判断，
//     而取皮肤上最近的点、按该处插值的顶点法线定内外。深屈时皮肤自身在腘窝折叠，纯蒙皮也有不少“皮肤外”的顶点；比的是有无经过点之差。
//     outside the skin: the vertices of the muscles with via points that lie outside the posed skin, their number and the
//     largest distance (mm). The skin mesh has openings (it is not closed), so instead of parity the nearest point of the
//     skin is taken and its interpolated vertex normal decides the side. In deep flexion the skin itself folds in the
//     popliteal fossa and plain skinning has many such vertices too; what is compared is the difference.
//   · 悬空（stand-off）：膝心 12 cm 之内、有经过点的肌肉顶点到最近“支撑面”的最大距离（毫米）。支撑面 = 膝周骨、皮肤、膝周没有经过点的
//     肌肉，以及同一种网格里其余有经过点的肌肉（腘绳肌、股肌彼此贴着；只有离开所有组织的才算悬空）。脱离组织、悬在空处的细条离所有支撑面都远；贴着骨、别的肌肉或皮下的网格离得近。
//     纯蒙皮的肌腹本身就有离支撑面 15–30 mm 的地方，最大值容易被它们盖住，所以另计离支撑面超过 DETACHED（15 mm）的顶点数。
//     Plain muscle bellies are 15–30 mm from any support in places, which can hide a strip in the maximum, so the
//     vertices farther than DETACHED (15 mm) from any support are counted as well.
//     不用“到自身纯蒙皮表面的距离”：纯蒙皮对自身恒为 0，“不多于纯蒙皮”无从谈起。
//     stand-off: the largest distance (mm) from a vertex of a muscle with via points, within 12 cm of a knee centre, to the
//     nearest supporting surface. The supporting surfaces are the knee bones, the skin, the muscles of the knee region
//     without via points, and the other muscles with via points of the same mesh (the hamstrings lie on one another, as
//     do the vasti; only geometry away from all tissue is detached). A strip hanging free of
//     the tissue is far from all of them; mesh lying on bone, on other muscle or under the skin is near one. The distance
//     to the muscle's own plainly skinned surface is not used: for plain skinning it is always 0, so "no more than plain"
//     would mean nothing.
//   · 旧的覆盖（只报告，不进门槛）：射线 6 cm 之内碰到任何一块部件中心离膝 15 cm 以内的肌肉就算，不管先碰到骨、
//     也不管肌肉是否穿在骨里。穿进骨里的肌肉和拉长的碎片都被算成了覆盖。
//     the old coverage (reported, not gated): the ray meeting any muscle whose part centre is within 15 cm of a knee,
//     within 6 cm, counted — whether a bone came first or the muscle ran through the bone. Muscle passing inside the
//     bone and stretched shards counted as coverage.
// 门槛（tests/rig-via-check.test.ts）：每个姿势、每副身体，有经过点的翻转、拉伸 p99 和最大值、肌肉入骨、皮肤外（个数和最远距离）、
// 悬空都不多于纯蒙皮，覆盖不少于纯蒙皮。
// The gate (tests/rig-via-check.test.ts): for every pose and body, with via points, no more inversions, stretch (p99 and
// max), muscle in bone, outside the skin (count and largest distance) or stand-off than plain skinning, and no less
// coverage.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuscleLine, Rig } from '../../src/anatomy/types.ts'
import { type Body, readBody } from './io.ts'
import { type V3, cross, dot, m3apply, norm, sub } from './math.ts'
import { BYTES_PER_VERTEX, Poser, clampPose, type Pose } from './pose.ts'
import { standardPostures } from './postures.ts'
import { Solid, Surface, closedProblem } from './solid.ts'
import { kneeFrame, readViaFile, toKnee } from './via.ts'
import { KNEE_BONES } from './viapush.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const RAY = 0.06
export { Solid, closedProblem }
/** 膝周骨的名称 / Names of the bones of the knee region. */
export const KNEE_BONE = KNEE_BONES

type Trio = { anteriorFemur: [number, number]; patella: [number, number]; posteriorCondyles: [number, number] }

export interface CheckRow {
  body: string
  pose: string
  stretchP99: [number, number]
  stretchMax: [number, number]
  inverted: [number, number]
  /** 修正后的覆盖（进门槛）/ Corrected coverage (gated). */
  coverage: Trio
  /** 旧的覆盖（只报告）/ The old coverage (reported only). */
  coverageOld: Trio
  /** 有经过点的肌肉在膝周骨里面的顶点数 / Vertices of the muscles with via points inside a knee bone. */
  inBone: [number, number]
  /** 同上，按顶点分摊的三角形面积（cm²）/ The same as triangle area shared out to those vertices (cm²). */
  inBoneArea: [number, number]
  /** 有经过点的肌肉在皮肤外的顶点数 / Vertices of the muscles with via points outside the skin. */
  outsideSkin: [number, number]
  /** 其中最远的距离（毫米）/ The largest distance of those outside (mm). */
  outsideSkinMm: [number, number]
  /** 膝周有经过点的肌肉顶点到最近支撑面的最大距离（毫米）/ The largest distance (mm) from a vertex of a knee-region muscle with via points to the nearest supporting surface. */
  standOffMm: [number, number]
  /** 其中离支撑面超过 DETACHED 的顶点数 / Of those, the vertices farther than DETACHED from any supporting surface. */
  detached: [number, number]
}

/** 悬空计数的界（米）：比皮下脂肪和肌间隙都厚 / The bound (m) for the detached count: thicker than the subcutaneous fat and the gaps between muscles. */
export const DETACHED = 0.015

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

/** 一副身体、一个姿势：两种网格的各量 / One body, one pose: the quantities for both meshes. */
export function checkPose(body: Body, rig: Rig, bin: Uint8Array, pose: Pose, viaParts: Set<string>): Omit<CheckRow, 'body' | 'pose'> {
  const plainRig: Rig = { ...rig, muscles: rig.muscles.map((m) => { const { via: _v, viaPush: _p, ...rest } = m as MuscleLine; return rest }) }
  const posers = [new Poser(plainRig, bin, pose), new Poser(rig, bin, pose)]
  const jointIndex = posers[1]!.jointIndex
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
  const stretch: number[][] = [[], []], inverted = [0, 0]
  const vf = readViaFile()
  const frames = (['L', 'R'] as const).map((s) => kneeFrame(rig, s, vf)!)
  const nearKnee = (p: V3): boolean => frames.some((f) => Math.hypot(p[0] - f.C[0], p[1] - f.C[1], p[2] - f.C[2]) < 0.15)
  // 旧覆盖的肌肉：部件中心离膝 15 cm 以内 / muscles of the old coverage: part centre within 15 cm of a knee
  const coverParts = new Set(body.data.parts.filter((p) => p.tissue === 'muscle' && body.meshes.has(p.id) && nearKnee(p.centroid as V3)).map((p) => p.id))
  // 膝周骨（摆好姿势，刚体）/ the knee bones (posed, rigid)
  const bones: Solid[] = []
  for (const part of body.data.parts) {
    const mesh = KNEE_BONE.test(part.name) ? body.meshes.get(part.id) : undefined
    if (!mesh) continue
    const problem = closedProblem(mesh.indices)
    if (problem) throw new Error(`via-check: the bone mesh of ${part.name} is not closed (${problem}); the inside test needs closed meshes`)
    bones.push(new Solid(Float64Array.from(posers[0]!.part(part.id, mesh.positions, 'dqs', false)), mesh.indices))
  }
  if (bones.length !== 8) throw new Error(`via-check: expected 8 knee bones, found ${bones.length}`)
  const inBoneAt = (x: number, y: number, z: number): boolean => bones.some((b) => b.contains(x, y, z))
  // 皮肤（三角形最多的皮肤部件）和支撑面（膝周骨、皮肤、膝周没有经过点的肌肉）；两种网格相同 / the skin (the skin part with most triangles) and the supporting surfaces (knee bones, skin, knee-region muscles without via points); the same for both meshes
  const skinPart = body.data.parts.filter((p) => p.tissue === 'skin' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles)[0]
  if (!skinPart) throw new Error('via-check: the body has no skin mesh')
  const skinMesh = { positions: posers[0]!.part(skinPart.id, body.meshes.get(skinPart.id)!.positions, 'dqs', false), indices: body.meshes.get(skinPart.id)!.indices }
  const skin = new Surface([skinMesh])
  const support = new Surface([skinMesh, ...bones.map((b) => ({ positions: b.p, indices: b.idx })), ...[...coverParts].filter((id) => !viaParts.has(id)).map((id) => ({ positions: posers[0]!.part(id, body.meshes.get(id)!.positions, 'dqs', { mode: 'tapered' }), indices: body.meshes.get(id)!.indices }))])
  const knees = ['knee_L', 'knee_R'].filter((j) => jointIndex.has(j)).map((j) => posers[0]!.jointCenter(j))
  const KNEE_NEAR = 0.12
  const outside = [0, 0], outsideMax = [0, 0], standOff = [0, 0], detached = [0, 0]
  const viaOut: Map<string, { positions: Float32Array; indices: Uint32Array }>[] = [new Map(), new Map()]

  // 每个变体：肌肉三角形（坐标、是否有顶点在骨里、是否属于旧覆盖）/ per variant: muscle triangles (coordinates, whether a vertex is in bone, whether part of the old coverage)
  type Tris = { xyz: number[]; inBone: boolean[]; old: boolean[] }
  const tris: Tris[] = [{ xyz: [], inBone: [], old: [] }, { xyz: [], inBone: [], old: [] }]
  const inBone = [0, 0], inBoneArea = [0, 0]
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (const id of new Set([...coverParts, ...viaParts])) {
    const mesh = body.meshes.get(id)
    if (!mesh) continue
    const b = bindingOf.get(id)
    const isVia = viaParts.has(id)
    let shared: { out: Float32Array; inside: Uint8Array } | null = null
    posers.forEach((poser, v) => {
      // 没有经过点的肌肉两种网格相同，只算一次 / a muscle without via points is the same in both, computed once
      if (!isVia && shared) return void pushTris(v, shared.out, shared.inside)
      const out = poser.part(id, mesh.positions, 'dqs', { mode: 'tapered' })
      const n = out.length / 3
      const inside = new Uint8Array(n)
      for (let i = 0; i < n; i++) inside[i] = inBoneAt(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!) ? 1 : 0
      if (!isVia) shared = { out, inside }
      pushTris(v, out, inside)
      if (!isVia) return
      viaOut[v]!.set(id, { positions: out, indices: mesh.indices })
      const P = (i: number): V3 => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!]
      const R = (i: number): V3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]
      for (let i = 0; i < n; i++) {
        inBone[v]! += inside[i]!
        const x = out[i * 3]!, y = out[i * 3 + 1]!, z = out[i * 3 + 2]!
        const d = skin.signed(x, y, z)
        if (d > 0) (outside[v] = outside[v]! + 1), (outsideMax[v] = Math.max(outsideMax[v]!, d))
      }
      const idx = mesh.indices
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!
        const a = P(i0), bb = P(i1), c = P(i2)
        const k = inside[i0]! + inside[i1]! + inside[i2]!
        if (k) inBoneArea[v]! += (Math.hypot(...cross(sub(bb, a), sub(c, a))) / 2) * (k / 3) * 1e4
        for (const [x, y] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
          const r = Math.hypot(...sub(R(x), R(y)))
          if (r > 1e-6) stretch[v]!.push(Math.hypot(...sub(P(x), P(y))) / r)
        }
        // 静止法线按顶点 0 权重最大的关节转动 / rest normal turned by the joint of largest weight at vertex 0
        let j = b?.joint !== undefined ? jointIndex.get(b.joint)! : 0
        if (b?.offset !== undefined) {
          const o = b.offset + i0 * BYTES_PER_VERTEX
          let best = -1
          for (let q = 0; q < 4; q++) if (bin[o + 8 + q]! > best) (best = bin[o + 8 + q]!), (j = dv.getUint16(o + q * 2, true))
        }
        const n0 = m3apply(poser.xfs[j]!.r, cross(sub(R(i1), R(i0)), sub(R(i2), R(i0))))
        if (dot(n0, cross(sub(bb, a), sub(c, a))) < 0) inverted[v]!++
      }
    })
    function pushTris(v: number, out: Float32Array, inside: Uint8Array): void {
      const idx = mesh!.indices
      const T = tris[v]!
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!
        for (const i of [i0, i1, i2]) T.xyz.push(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!)
        T.inBone.push(!!(inside[i0]! | inside[i1]! | inside[i2]!))
        T.old.push(coverParts.has(id))
      }
    }
  }
  // 悬空：支撑面再加上同一种网格里其余有经过点的肌肉（腘绳肌彼此贴着）/ stand-off: the supporting surfaces plus the other muscles with via points of the same mesh (the hamstrings lie on one another)
  for (let v = 0; v < 2; v++) {
    for (const [id, m] of viaOut[v]!) {
      const others = new Surface([...viaOut[v]!].filter(([o]) => o !== id).map(([, x]) => x))
      const p = m.positions
      for (let i = 0; i < p.length / 3; i++) {
        const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!
        if (!knees.some((c) => Math.hypot(x - c[0], y - c[1], z - c[2]) < KNEE_NEAR)) continue
        const sd = Math.min(support.distance(x, y, z), others.distance(x, y, z))
        standOff[v] = Math.max(standOff[v]!, sd)
        if (sd > DETACHED) detached[v] = detached[v]! + 1
      }
    }
  }
  const boneTris: number[] = []
  for (const s of bones) for (let t = 0; t < s.idx.length; t += 3) for (let k = 0; k < 3; k++) boneTris.push(s.p[s.idx[t + k]! * 3]!, s.p[s.idx[t + k]! * 3 + 1]!, s.p[s.idx[t + k]! * 3 + 2]!)
  const triAt = (a: ArrayLike<number>, t: number): [V3, V3, V3] => [[a[t * 9]!, a[t * 9 + 1]!, a[t * 9 + 2]!], [a[t * 9 + 3]!, a[t * 9 + 4]!, a[t * 9 + 5]!], [a[t * 9 + 6]!, a[t * 9 + 7]!, a[t * 9 + 8]!]]
  // 射线线段的包围盒以外的三角形不用试 / triangles outside the bounding box of the ray's segment need no test
  const missesBox = (a: ArrayLike<number>, t: number, lo: V3, hi: V3): boolean => {
    for (let c = 0; c < 3; c++) {
      const x = a[t * 9 + c]!, y = a[t * 9 + 3 + c]!, z = a[t * 9 + 6 + c]!
      if (Math.max(x, y, z) < lo[c]! || Math.min(x, y, z) > hi[c]!) return true
    }
    return false
  }

  // 骨面采样：股骨远端前面、髌骨、股骨髁后面（按膝关节坐标）/ bone samples: anterior distal femur, patella, posterior condyles (in knee coordinates)
  const zero = (): Trio => ({ anteriorFemur: [0, 0], patella: [0, 0], posteriorCondyles: [0, 0] })
  const cov = zero(), covOld = zero()
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
        const e: V3 = [o[0] + d[0] * RAY, o[1] + d[1] * RAY, o[2] + d[2] * RAY]
        const lo: V3 = [Math.min(o[0], e[0]), Math.min(o[1], e[1]), Math.min(o[2], e[2])], hi: V3 = [Math.max(o[0], e[0]), Math.max(o[1], e[1]), Math.max(o[2], e[2])]
        counts[key]++
        // 最近的骨面（两种网格相同）/ the nearest bone surface (the same for both meshes)
        let boneT = Infinity
        for (let t = 0; t < boneTris.length / 9; t++) {
          if (missesBox(boneTris, t, lo, hi)) continue
          const h = rayHitsTriangle(o, d, ...triAt(boneTris, t))
          if (h !== null && h < boneT) boneT = h
        }
        for (let v = 0; v < 2; v++) {
          const T = tris[v]!
          let old = false, best = Infinity, bestTri = -1
          for (let t = 0; t < T.inBone.length; t++) {
            if (missesBox(T.xyz, t, lo, hi)) continue
            const h = rayHitsTriangle(o, d, ...triAt(T.xyz, t))
            if (h === null || h >= RAY) continue
            if (T.old[t]) old = true
            if (h < best) (best = h), (bestTri = t)
          }
          if (old) covOld[key][v] = covOld[key][v]! + 1
          // 第一个面必须是肌肉、三角形没有顶点在骨里、命中点不在骨里 / the first surface must be muscle, with no vertex of the triangle in bone and the hit point not in bone
          if (bestTri >= 0 && best < boneT && !T.inBone[bestTri] && !inBoneAt(o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best)) cov[key][v] = cov[key][v]! + 1
        }
      }
    }
  }
  const q = (a: number[], f: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 1 }
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const r1 = (x: number): number => Math.round(x * 10) / 10
  const frac = (c: Trio): Trio => {
    const g = (k: keyof Trio): [number, number] => [r3(c[k][0] / Math.max(1, counts[k])), r3(c[k][1] / Math.max(1, counts[k]))]
    return { anteriorFemur: g('anteriorFemur'), patella: g('patella'), posteriorCondyles: g('posteriorCondyles') }
  }
  return {
    stretchP99: [r3(q(stretch[0]!, 0.99)), r3(q(stretch[1]!, 0.99))],
    stretchMax: [r3(q(stretch[0]!, 1)), r3(q(stretch[1]!, 1))],
    inverted: [inverted[0]!, inverted[1]!],
    coverage: frac(cov),
    coverageOld: frac(covOld),
    inBone: [inBone[0]!, inBone[1]!],
    inBoneArea: [r3(inBoneArea[0]!), r3(inBoneArea[1]!)],
    outsideSkin: [outside[0]!, outside[1]!],
    outsideSkinMm: [r1(outsideMax[0]! * 1000), r1(outsideMax[1]! * 1000)],
    standOffMm: [r1(standOff[0]! * 1000), r1(standOff[1]! * 1000)],
    detached: [detached[0]!, detached[1]!],
  }
}

export async function checkBody(bodyId: 'male' | 'female', dir = join(ROOT, 'public', 'anatomy', bodyId)): Promise<CheckRow[]> {
  const body = await readBody(join(ROOT, 'public', 'anatomy', bodyId))
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const bin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  const viaParts = new Set(rig.muscles.filter((m) => m.via?.length).map((m) => m.part))
  return checkPoses(rig).map(({ id, pose }) => ({ body: bodyId, pose: id, ...checkPose(body, rig, bin, pose, viaParts) }))
}

/** 门槛不过的项（空 = 通过）/ The checks of the gate that fail (empty = pass). */
export function gateFailures(r: CheckRow): string[] {
  const out: string[] = []
  const le = (name: string, x: [number, number]): void => void (x[1] > x[0] && out.push(`${name} ${x[1]} > ${x[0]}`))
  const ge = (name: string, x: [number, number]): void => void (x[1] < x[0] && out.push(`${name} ${x[1]} < ${x[0]}`))
  le('inverted', r.inverted)
  le('stretchP99', r.stretchP99)
  le('stretchMax', r.stretchMax)
  le('inBone', r.inBone)
  le('outsideSkin', r.outsideSkin)
  le('outsideSkinMm', r.outsideSkinMm)
  le('standOffMm', r.standOffMm)
  le('detached', r.detached)
  for (const k of ['anteriorFemur', 'patella', 'posteriorCondyles'] as const) ge(`coverage.${k}`, r.coverage[k])
  return out
}

if (import.meta.main) {
  const bodies = (process.argv.slice(2).filter((a) => !a.startsWith('--')) as ('male' | 'female')[])
  for (const b of bodies.length ? bodies : (['male', 'female'] as const)) {
    for (const row of await checkBody(b)) {
      console.log(JSON.stringify(row))
      const fails = gateFailures(row)
      console.log(`  ${row.body} ${row.pose}: ${fails.length ? `FAIL ${fails.join('; ')}` : 'pass'}`)
    }
  }
}
