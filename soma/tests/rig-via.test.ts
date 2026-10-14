// 肌肉经过点：路径（含缠绕条件），以及“网格不受经过点影响”（有经过点的肌肉网格、着色器打包与去掉经过点时逐位相同）。
// Muscle via points: the path (wrapping condition included), and "the mesh is not affected by via points" (the mesh and
// the shader packing of a muscle with via points are bit for bit those without them).
import { describe, expect, it } from 'vitest'
import { rigSignature } from '../src/activity/model.ts'
import { indexRig, packJoints, packMuscles, skinLikeShader, writeInfluences } from '../src/anatomy/rig.ts'
import type { Joint, MuscleLine, Rig } from '../src/anatomy/types.ts'
import { type V3, XF_ID } from '../tools/rig/math.ts'
import { musclePath, polylineLength, projectOnPolyline, wrapPoint } from '../tools/rig/musclepath.ts'
import { BYTES_PER_VERTEX, Poser, jointFrames, muscleLength, straightLine, type Pose } from '../tools/rig/pose.ts'

const src = { name: 'test', url: '', license: 'CC0' }
const flex = (min: number, max: number): Joint['dofs'][number] => ({ axis: 0, name: { zh: '屈', en: 'flexion' }, min, max, source: src })
const joint = (id: string, parent: string | null, center: V3, tail: V3, dofs: Joint['dofs']): Joint => ({
  id, name: { zh: id, en: id }, parent, center, tail, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], dofs, basis: { zh: '测试', en: 'test' },
})

// 一条腿：骨盆（根）、股骨（髋）、胫骨（膝）。绕 +x 转正角时远端向后（−z）摆，即“屈膝”。
// A leg: pelvis (root), femur (hip), tibia (knee). A positive turn about +x swings the distal end backwards (−z), i.e. "knee flexion".
const JOINTS: Joint[] = [
  joint('pelvis', null, [0, 1, 0], [0, 1.1, 0], []),
  joint('hip', 'pelvis', [0, 0.9, 0], [0, 0.5, 0], [flex(-0.5, 2)]),
  joint('knee', 'hip', [0, 0.5, 0], [0, 0.1, 0], [flex(-0.1, 2.4)]),
]
const KNEE = [0, 0.5, 0] as V3
const flexKnee = (deg: number): Pose => ({ knee: [(deg * Math.PI) / 180] })

/** 一块在膝后跨过膝关节的“肌肉”：沿 y 的一串环，离轴 1.5 cm（太靠近关节轴），权重从股骨渐变到胫骨。 */
/** A "muscle" crossing the back of the knee: rings along y, 1.5 cm behind the axis (too close to it), weights shading from femur to tibia. */
function makeMesh(): { rest: Float32Array; bin: Uint8Array; n: number } {
  const rings = 30, per = 8
  const n = rings * per
  const rest = new Float32Array(n * 3)
  const bin = new Uint8Array(n * BYTES_PER_VERTEX)
  const dv = new DataView(bin.buffer)
  for (let r = 0; r < rings; r++) {
    const y = 0.88 - (r / (rings - 1)) * 0.5
    // 膝上 5 cm 起到膝下 5 cm 由股骨过渡到胫骨 / from 5 cm above to 5 cm below the knee the weight passes from femur to tibia
    const wT = Math.min(1, Math.max(0, (0.55 - y) / 0.1))
    for (let k = 0; k < per; k++) {
      const i = r * per + k, a = (k / per) * 2 * Math.PI
      rest.set([0.012 * Math.cos(a), y, 0.015 * -1 + 0.012 * Math.sin(a)], i * 3)
      const wt = Math.round(wT * 255)
      dv.setUint16(i * 12, wt >= 128 ? 2 : 1, true)
      dv.setUint16(i * 12 + 2, wt >= 128 ? 1 : 2, true)
      bin[i * 12 + 8] = wt >= 128 ? wt : 255 - wt
      bin[i * 12 + 9] = wt >= 128 ? 255 - wt : wt
    }
  }
  return { rest, bin, n }
}

const ORIGIN = { point: [0, 0.92, -0.02] as V3, joint: 'pelvis' }
const INSERTION = { point: [0, 0.4, -0.012] as V3, joint: 'knee' }
/** 股骨髁后面的缠绕点（半径 3 cm，正后方和后上方）/ wrapping points behind the femoral condyles (radius 3 cm, straight back and back-up). */
const WRAPS = [30, 0].map((deg) => ({
  point: [0, 0.5 + 0.03 * Math.sin((deg * Math.PI) / 180), -0.03 * Math.cos((deg * Math.PI) / 180)] as V3,
  joint: 'hip',
  wrap: { centre: KNEE, axis: [1, 0, 0] as V3 },
}))

function makeRig(withVia: boolean): { rig: Rig; rest: Float32Array; bin: Uint8Array; n: number } {
  const { rest, bin, n } = makeMesh()
  const plain: MuscleLine = { part: 'plain', origin: ORIGIN, insertion: INSERTION, gain: 0.7 }
  const viaLine: MuscleLine = { part: 'via', origin: ORIGIN, insertion: INSERTION, gain: 0.7, ...(withVia ? { via: WRAPS } : {}) }
  const rig: Rig = {
    joints: JOINTS,
    bindings: [{ part: 'plain', offset: 0, vertexCount: n }, { part: 'via', offset: 0, vertexCount: n }],
    muscles: [plain, viaLine],
    cautions: [],
  }
  return { rig, rest, bin, n }
}

describe('muscle path', () => {
  it('is the straight line without via points, and the same length as before', () => {
    const { rig } = makeRig(false)
    const index = new Map(rig.joints.map((j, i) => [j.id, i]))
    const xfs = jointFrames(rig.joints, flexKnee(70)).xfs
    const line = rig.muscles[0]!
    const m = muscleLength(line, xfs, index)
    expect(m.path).toBeUndefined()
    const o = m.origin, i = m.insertion
    expect(m.length).toBe(Math.hypot(i[0] - o[0], i[1] - o[1], i[2] - o[2]))
    expect(musclePath(line, () => XF_ID)).toEqual([ORIGIN.point, INSERTION.point])
    expect(muscleLength({ ...line, via: [] }, xfs, index)).toEqual(m)
  })

  it('wrapping points stay out of the way until the line would cut into the bone', () => {
    const { rig } = makeRig(true)
    const index = new Map(rig.joints.map((j, i) => [j.id, i]))
    const line = rig.muscles[1]!
    const at = (deg: number): V3[] => musclePath(line, (j) => jointFrames(rig.joints, flexKnee(deg)).xfs[index.get(j)!]!)
    // 伸直时直线离轴 1.5–2 cm，比 3 cm 的缠绕点更靠里：缠绕点起作用，路径绕到后面
    // straight, the line runs 1.5–2 cm from the axis, inside the 3 cm wrapping points: they are used and the path goes round behind
    expect(at(0).length).toBeGreaterThan(2)
    for (const p of at(90).slice(1, -1)) expect(Math.hypot(p[1] - KNEE[1], p[2] - KNEE[2])).toBeGreaterThanOrEqual(0.03 - 1e-9)
    // 路径长度随屈膝连续变化：相邻 0.5° 的差不超过 0.5° × 止点离轴的距离（约 10 cm；跳变会是厘米级）
    // the path length changes continuously with flexion: 0.5° apart, no more than 0.5° × the insertion's distance from the axis (about 10 cm; a jump would be centimetres)
    let prev = polylineLength(at(0))
    for (let d = 0.5; d <= 140; d += 0.5) {
      const L = polylineLength(at(d))
      expect(Math.abs(L - prev)).toBeLessThan(((0.5 * Math.PI) / 180) * 0.101)
      prev = L
    }
    // 屈膝缩短这条屈肌，平均力臂不小于缠绕点的一半半径、不大于止点离轴的距离 / knee flexion shortens this flexor, with a mean moment arm of at least half the wrapping radius and at most the insertion's distance from the axis
    const arm = (polylineLength(at(0)) - polylineLength(at(90))) / (Math.PI / 2)
    expect(arm).toBeGreaterThan(0.015)
    expect(arm).toBeLessThan(0.101)
  })

  it('a single wrapping point: inactive outside, on the line at the boundary', () => {
    const c: V3 = [0, 0, 0], n: V3 = [1, 0, 0], P: V3 = [0, 0, -0.03]
    expect(wrapPoint([0, 1, -0.05], [0, -1, -0.05], P, c, n)).toBeNull()
    const used = wrapPoint([0.01, 1, -0.01], [0.02, -1, -0.01], P, c, n)!
    expect(used[1]).toBeCloseTo(0, 12)
    expect(used[2]).toBeCloseTo(-0.03, 12)
    // 刚好擦过时，取直线上的点（沿轴向坐标也取直线的）：路径不跳 / exactly grazing, the point taken is the line's own (its coordinate along the axis too): the path does not jump
    const graze = wrapPoint([0.01, 1, -0.03 + 1e-9], [0.03, -1, -0.03 + 1e-9], P, c, n)!
    expect(graze[0]).toBeCloseTo(0.02, 6)
    // 与半径方向平行的直线不触发 / a line parallel to the radius never triggers it
    expect(wrapPoint([0, 0.01, 0], [0, 0.01, -1], P, c, n)).toBeNull()
  })

  it('projects onto a polyline by arc length', () => {
    const pts: V3[] = [[0, 0, 0], [0, 1, 0], [1, 1, 0]]
    expect(projectOnPolyline(pts, [0.5, 1.2, 0])).toBeCloseTo(0.75, 12)
    expect(polylineLength(pts)).toBe(2)
  })
})

describe('the mesh is not affected by via points', () => {
  const plain = makeRig(false), via = makeRig(true)
  const poseOf = (deg: number): Pose => flexKnee(deg)

  it('a muscle with via points is skinned and volume-corrected bit for bit as without them', () => {
    for (const deg of [0, 45, 120]) for (const volume of [false, { mode: 'uniform' }, { mode: 'tapered' }] as const) {
      const a = new Poser(plain.rig, plain.bin, poseOf(deg)).part('via', plain.rest, 'dqs', volume)
      const b = new Poser(via.rig, via.bin, poseOf(deg)).part('via', via.rest, 'dqs', volume)
      expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true)
    }
    // 但长度按折线：屈膝缩短这条屈肌比直线多 / but the length follows the polyline: knee flexion shortens this flexor more than the straight line does
    const index = new Map(via.rig.joints.map((j, i) => [j.id, i]))
    const xfs = jointFrames(via.rig.joints, poseOf(90)).xfs
    const line = via.rig.muscles[1]!
    const m = muscleLength(line, xfs, index), s = muscleLength(straightLine(line), xfs, index)
    expect(m.rest - m.length).toBeGreaterThan(s.rest - s.length)
    expect(straightLine(plain.rig.muscles[0]!)).toBe(plain.rig.muscles[0])
  })

  it('packs the same muscle texture, and the shader mirror matches the CPU reference', () => {
    const r = indexRig(via.rig, via.bin), ri = indexRig(plain.rig, plain.bin)
    const n = via.n
    for (const deg of [0, 40, 100, 135]) {
      const frames = jointFrames(r.rig.joints, poseOf(deg))
      const md = packMuscles(r, frames)
      expect(Array.from(md)).toEqual(Array.from(packMuscles(ri, frames)))
      const ref = new Poser(r.rig, r.bin, poseOf(deg)).part('via', via.rest, 'dqs', { mode: 'tapered' })
      const idx = new Uint16Array(n * 4), wt = new Uint8Array(n * 4)
      writeInfluences(r, 'via', n, idx, wt, 0)
      let worst = 0
      for (let i = 0; i < n; i++) {
        const got = skinLikeShader(via.rest.subarray(i * 3, i * 3 + 3), idx.subarray(i * 4, i * 4 + 4), [...wt.subarray(i * 4, i * 4 + 4)].map((w) => w / 255), packJoints(frames), false, { data: md, line: 1 })
        worst = Math.max(worst, Math.hypot(got[0] - ref[i * 3]!, got[1] - ref[i * 3 + 1]!, got[2] - ref[i * 3 + 2]!))
      }
      expect(worst).toBeLessThan(2e-6)
    }
  })
})

describe('rig signature', () => {
  it('is unchanged by an empty via list and changes when via points are added', () => {
    const a = makeRig(false).rig, b = makeRig(true).rig
    expect(rigSignature({ ...a, muscles: a.muscles.map((m) => ({ ...m, via: [] })) })).toBe(rigSignature(a))
    expect(rigSignature(b)).not.toBe(rigSignature(a))
  })
})
