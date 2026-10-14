// 肌肉经过点：路径（含缠绕条件），以及有经过点的肌肉网格的变形（横截面蒙皮 + 推出骨面，tools/rig/musclepath.ts）：
// 没有经过点的肌肉逐位不变、静止姿势精确、结果确定、着色器镜像与 CPU 参考相差不到 2 微米，烘焙确实把网格推出骨外。
// Muscle via points: the path (wrapping condition included), and the deformation of the mesh of a muscle with via points
// (cross-section skinning + push out of the bone, tools/rig/musclepath.ts): muscles without via points are bit for bit
// unchanged, the rest pose is exact, the result is deterministic, the shader mirror is within 2 µm of the CPU reference,
// and the bake really pushes the mesh out of the bone.
import { describe, expect, it } from 'vitest'
import { rigSignature } from '../src/activity/model.ts'
import { MUSCLE_TEXELS, VIA_ROWS, indexRig, packJoints, packMuscles, packVia, skinLikeShader, writeInfluences, writeMuscleThin } from '../src/anatomy/rig.ts'
import type { Joint, MuscleLine, MuscleViaPush, Rig } from '../src/anatomy/types.ts'
import { type V3, XF_ID, axisAngle } from '../tools/rig/math.ts'
import { VIA_ANCHOR, VIA_BEYOND, VIA_SAMPLES, musclePath, polylineLength, projectOnPolyline, viaParams, viaPushAt, wrapPoint } from '../tools/rig/musclepath.ts'
import { BYTES_PER_VERTEX, Poser, correctMuscleVolume, jointFrames, muscleLength, skin, straightLine, viaPrepFor, type Pose, type Scales } from '../tools/rig/pose.ts'
import { Solid } from '../tools/rig/solid.ts'
import { PUSH_MARGIN, pushOut } from '../tools/rig/viapush.ts'

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
    // 止点在 y = 0.4：最后两个环落在止点之外 3–5 cm / the insertion is at y = 0.4: the last two rings lie 3–5 cm beyond it
    const y = r < rings - 2 ? 0.88 - (r / (rings - 3)) * 0.48 : 0.4 - 0.03 - (r - (rings - 2)) * 0.02
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

/**
 * 一张合成的推出表：4 行（0°、45°、90°、135°），样本 k 在股骨坐标里向后（−z）推 2 mm × 行号 × sin(πk/(K−1))，另加一点侧向分量。
 * A synthetic push table: 4 rows (0°, 45°, 90°, 135°); sample k is pushed backwards (−z) in the femur's frame by
 * 2 mm × row × sin(πk/(K−1)), with a little sideways component too.
 */
function makePush(): MuscleViaPush {
  const K = VIA_SAMPLES
  const d: number[] = []
  for (let r = 0; r < 4; r++) for (let k = 0; k < K; k++) {
    const b = Math.sin((Math.PI * k) / (K - 1))
    d.push(0.0005 * r * b, 0, -0.002 * r * b)
  }
  return { joint: 'knee', dof: 0, frame: 'hip', stepDeg: 45, samples: K, d }
}

function makeRig(withVia: boolean, withPush = withVia): { rig: Rig; rest: Float32Array; bin: Uint8Array; n: number } {
  const { rest, bin, n } = makeMesh()
  const plain: MuscleLine = { part: 'plain', origin: ORIGIN, insertion: INSERTION, gain: 0.7 }
  const viaLine: MuscleLine = { part: 'via', origin: ORIGIN, insertion: INSERTION, gain: 0.7, ...(withVia ? { via: WRAPS } : {}), ...(withVia && withPush ? { viaPush: makePush() } : {}) }
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

const same = (a: Float32Array, b: Float32Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
const VOLUMES = [false, { mode: 'uniform' }, { mode: 'tapered' }] as const

describe('muscles without via points are unchanged', () => {
  const plain = makeRig(false), via = makeRig(true)

  it('a muscle without via points is skinned and volume-corrected bit for bit as before', () => {
    for (const deg of [0, 45, 120]) for (const volume of VOLUMES) {
      const poser = new Poser(via.rig, via.bin, flexKnee(deg))
      const got = poser.part('plain', via.rest, 'dqs', volume)
      // 独立算一遍：普通蒙皮 + 直线体积修正 / computed independently: plain skinning + straight-line volume correction
      const ref = skin(via.rest, via.bin, 0, poser.xfs, 'dqs', poser.dqs, poser.shape)
      if (volume) correctMuscleVolume(ref, via.rig.muscles[0]!, poser.xfs, poser.jointIndex, volume)
      expect(same(got, ref)).toBe(true)
      expect(same(got, new Poser(plain.rig, plain.bin, flexKnee(deg)).part('plain', plain.rest, 'dqs', volume))).toBe(true)
    }
  })

  it('via points without viaPush leave the mesh as it was (only the path changes)', () => {
    const pathOnly = makeRig(true, false)
    for (const deg of [0, 45, 120]) for (const volume of VOLUMES) {
      const a = new Poser(plain.rig, plain.bin, flexKnee(deg)).part('via', plain.rest, 'dqs', volume)
      const b = new Poser(pathOnly.rig, pathOnly.bin, flexKnee(deg)).part('via', pathOnly.rest, 'dqs', volume)
      expect(same(a, b)).toBe(true)
    }
    expect(straightLine(plain.rig.muscles[0]!)).toBe(plain.rig.muscles[0])
  })

  it('the shader attributes and the muscle texture of a line without via points are as before', () => {
    const r = indexRig(via.rig, via.bin), ri = indexRig(plain.rig, plain.bin)
    const n = via.n
    const idx = new Uint16Array(n * 4), wt = new Uint8Array(n * 4), idx0 = new Uint16Array(n * 4), wt0 = new Uint8Array(n * 4)
    writeInfluences(r, 'plain', n, idx, wt, 0, via.rest)
    writeInfluences(ri, 'plain', n, idx0, wt0, 0)
    expect([...idx]).toEqual([...idx0])
    expect([...wt]).toEqual([...wt0])
    const aux = new Float32Array(n)
    writeMuscleThin(r, 'plain', n, aux, 0, via.rest)
    expect([...aux].every((x) => x === -1)).toBe(true)
    const frames = jointFrames(r.rig.joints, flexKnee(70))
    const md = packMuscles(r, frames), md0 = packMuscles(ri, frames)
    const T = MUSCLE_TEXELS * 4
    // 第 0 行（没有经过点）：三个纹素都一样，纹素 2 为 0 / row 0 (no via points): all three texels the same, texel 2 zero
    expect([...md.subarray(0, T)]).toEqual([...md0.subarray(0, T)])
    expect(md[8]).toBe(0)
    // 第 1 行：前两个纹素（体积修正）一样，纹素 2 指向经过点纹理第 0 行 / row 1: the first two texels (volume correction) the same, texel 2 points at row 0 of the via texture
    expect([...md.subarray(T, T + 8)]).toEqual([...md0.subarray(T, T + 8)])
    expect(md[T + 8]).toBe(1)
    expect(md0[T + 8]).toBe(0)
  })
})

describe('mesh with via points: cross-section skinning and push out of the bone', () => {
  const via = makeRig(true)
  const line = via.rig.muscles[1]!
  const index = new Map(via.rig.joints.map((j, i) => [j.id, i]))
  const binding = via.rig.bindings[1]!

  it('the rest pose is exact', () => {
    const zeroRig: Rig = { ...via.rig, muscles: [via.rig.muscles[0]!, { ...line, viaPush: { ...line.viaPush!, d: line.viaPush!.d.map(() => 0) } }] }
    for (const mode of ['dqs', 'lbs'] as const) for (const volume of VOLUMES) {
      expect(same(new Poser(via.rig, via.bin, {}).part('via', via.rest, mode, volume), via.rest)).toBe(true)
      // 轻微过伸（角度小于 0）取表的第 0 行：推出量恰为 0，与全 0 的表逐位相同 / slight hyperextension (angle below 0) takes row 0 of the table: the push is exactly 0, bit for bit as with an all-zero table
      const hyper = { knee: [-0.08] }
      expect(same(new Poser(via.rig, via.bin, hyper).part('via', via.rest, mode, volume), new Poser(zeroRig, via.bin, hyper).part('via', via.rest, mode, volume))).toBe(true)
    }
    expect([...viaPushAt(line.viaPush!, 0, XF_ID.r)].every((x) => x === 0)).toBe(true)
    expect([...viaPushAt(line.viaPush!, -0.05, XF_ID.r)].every((x) => x === 0)).toBe(true)
  })

  it('is deterministic: the same input gives the same bytes', () => {
    const a = viaPrepFor(line, Float32Array.from(via.rest), via.bin, binding, index)!
    const b = viaPrepFor(line, Float32Array.from(via.rest), via.bin, binding, index)!
    expect(a).not.toBe(b)
    expect(same(a.s, b.s)).toBe(true)
    expect(Buffer.from(a.samples).equals(Buffer.from(b.samples))).toBe(true)
    expect(Buffer.from(a.vertices).equals(Buffer.from(b.vertices))).toBe(true)
    const p1 = new Poser(via.rig, via.bin, flexKnee(100)).part('via', Float32Array.from(via.rest), 'dqs', { mode: 'tapered' })
    const p2 = new Poser(via.rig, via.bin, flexKnee(100)).part('via', Float32Array.from(via.rest), 'dqs', { mode: 'tapered' })
    expect(same(p1, p2)).toBe(true)
  })

  it('every vertex of a cross-section takes the same influences, the ends ride with their bones, and beyond the ends the mesh is skinned plainly', () => {
    const prep = viaPrepFor(line, via.rest, via.bin, binding, index)!
    const beyond = new Float32Array(via.n)
    viaParams(line, via.rest, beyond)
    // 参数 s 相同、在两端之内的顶点（同一横截面）影响完全相同；网格本来的权重沿环并不都一样
    // vertices with the same parameter s inside the ends (one cross-section) have exactly the same influences, though the mesh's own weights are not all alike along a ring
    const first = new Map<number, number>()
    let groups = 0, plain = 0
    for (let i = 0; i < via.n; i++) {
      const got = [...prep.vertices.subarray(i * 12, i * 12 + 12)]
      // 端点之外 VIA_BEYOND 以上：就是它自己的权重 / VIA_BEYOND or more beyond an end: the vertex's own weights
      if (beyond[i]! >= VIA_BEYOND) {
        plain++
        const own = [...via.bin.subarray(i * 12, i * 12 + 12)]
        const asMap = (b: number[]): Map<number, number> => new Map([0, 1, 2, 3].filter((q) => b[8 + q]! > 0).map((q) => [b[q * 2]! | (b[q * 2 + 1]! << 8), b[8 + q]!]))
        expect(asMap(got)).toEqual(asMap(own))
      }
      if (beyond[i]! > 0) continue
      const j = first.get(prep.s[i]!)
      if (j === undefined) {
        first.set(prep.s[i]!, i)
        continue
      }
      groups++
      expect(got).toEqual([...prep.vertices.subarray(j * 12, j * 12 + 12)])
    }
    expect(groups).toBeGreaterThan(100)
    expect(plain).toBe(16)
    // 两端的样本完全随附着端的关节（起点在骨盆，止点在胫骨）/ the end samples follow the joint of their attachment entirely (origin on the pelvis, insertion on the tibia)
    const dv = new DataView(prep.samples.buffer)
    expect([dv.getUint16(0, true), prep.samples[8]]).toEqual([index.get('pelvis'), 255])
    const last = (VIA_SAMPLES - 1) * 12
    expect([dv.getUint16(last, true), prep.samples[last + 8]]).toEqual([index.get('knee'), 255])
    expect(VIA_ANCHOR).toBeGreaterThan(0)
  })

  it('the push table: rows at their angles, linear in between, clamped at the ends, turned with the frame', () => {
    const p = line.viaPush!, K = VIA_SAMPLES
    const row = (r: number, k: number): V3 => [p.d[(r * K + k) * 3]!, p.d[(r * K + k) * 3 + 1]!, p.d[(r * K + k) * 3 + 2]!]
    const at = (deg: number, rot = XF_ID.r): Float64Array => viaPushAt(p, (deg * Math.PI) / 180, rot)
    for (const k of [0, 5, 11, 23]) {
      for (let q = 0; q < 3; q++) {
        expect(at(90)[k * 3 + q]).toBeCloseTo(row(2, k)[q]!, 12)
        expect(at(67.5)[k * 3 + q]).toBeCloseTo((row(1, k)[q]! + row(2, k)[q]!) / 2, 12)
        expect(at(200)[k * 3 + q]).toBeCloseTo(row(3, k)[q]!, 12)
      }
    }
    const R = axisAngle([0, 1, 0], 0.7)
    const turned = at(90, R), plainRow = at(90)
    for (let k = 0; k < K; k++) {
      const v: V3 = [plainRow[k * 3]!, plainRow[k * 3 + 1]!, plainRow[k * 3 + 2]!]
      expect(turned[k * 3]).toBeCloseTo(R[0] * v[0] + R[1] * v[1] + R[2] * v[2], 12)
      expect(turned[k * 3 + 2]).toBeCloseTo(R[6] * v[0] + R[7] * v[1] + R[8] * v[2], 12)
    }
  })

  it('the mesh moves by the interpolated push on top of cross-section skinning', () => {
    const noPush = makeRig(true, false)
    const withZero: MuscleLine = { ...line, viaPush: { ...line.viaPush!, d: line.viaPush!.d.map(() => 0) } }
    const zeroRig: Rig = { ...via.rig, muscles: [via.rig.muscles[0]!, withZero] }
    for (const deg of [45, 90, 135]) {
      const a = new Poser(zeroRig, via.bin, flexKnee(deg)).part('via', via.rest, 'dqs', { mode: 'tapered' })
      const b = new Poser(via.rig, via.bin, flexKnee(deg)).part('via', via.rest, 'dqs', { mode: 'tapered' })
      const c = new Poser(noPush.rig, noPush.bin, flexKnee(deg)).part('via', noPush.rest, 'dqs', { mode: 'tapered' })
      // 推出量 = 表里的值（随股骨转动；这里股骨不动）/ the push = the table's value (turned with the femur, which does not move here)
      let most = 0
      for (let i = 0; i < via.n; i++) most = Math.max(most, Math.hypot(b[i * 3]! - a[i * 3]!, b[i * 3 + 1]! - a[i * 3 + 1]!, b[i * 3 + 2]! - a[i * 3 + 2]!))
      expect(most).toBeGreaterThan(0.0019 * (deg / 45))
      expect(most).toBeLessThan(0.0021 * (deg / 45) * Math.hypot(1, 0.25) + 1e-6)
      // 横截面蒙皮确实与普通蒙皮不同 / cross-section skinning really differs from plain skinning
      expect(same(a, c)).toBe(false)
    }
  })

  it('the shader mirror matches the CPU reference within 2 µm', () => {
    const r = indexRig(via.rig, via.bin)
    const n = via.n
    const idx = new Uint16Array(n * 4), wt = new Uint8Array(n * 4), aux = new Float32Array(n)
    writeInfluences(r, 'via', n, idx, wt, 0, via.rest)
    writeMuscleThin(r, 'via', n, aux, 0, via.rest)
    // 有 viaPush 的部件：aThin 带上了 s / a part with viaPush: aThin carries s
    expect(aux.every((x) => x < -2 - 0.12 && x >= -2.25)).toBe(true)
    const scales: Scales = { hip: { along: 1.08, across: 0.95 }, knee: { along: 0.94, across: 1.03 } }
    for (const [deg, sc] of [[0, undefined], [30, undefined], [45, undefined], [100, undefined], [135, undefined], [150, undefined], [80, scales]] as const) {
      const frames = jointFrames(r.rig.joints, flexKnee(deg), sc)
      const md = packMuscles(r, frames), vd = packVia(r, frames), jd = packJoints(frames)
      expect(vd.length).toBe(VIA_ROWS * VIA_SAMPLES * 4)
      const ref = new Poser(r.rig, r.bin, flexKnee(deg), sc).part('via', via.rest, 'dqs', { mode: 'tapered' })
      let worst = 0
      for (let i = 0; i < n; i++) {
        const got = skinLikeShader(via.rest.subarray(i * 3, i * 3 + 3), idx.subarray(i * 4, i * 4 + 4), [...wt.subarray(i * 4, i * 4 + 4)].map((w) => w / 255), jd, !!frames.shape, { data: md, line: 1, via: vd, thin: aux[i]! })
        worst = Math.max(worst, Math.hypot(got[0] - ref[i * 3]!, got[1] - ref[i * 3 + 1]!, got[2] - ref[i * 3 + 2]!))
      }
      expect(worst, `${deg}°${sc ? ' with scales' : ''}`).toBeLessThan(2e-6)
    }
  })
})

describe('the bake pushes cross-sections out of a closed bone', () => {
  it('no vertex that was outside stays inside, and the push is one translation per cross-section', () => {
    // 一块 4 cm 的立方“骨”和一根沿 x 穿过它上部的“肌肉”（半径 5 mm 的环，中心高 1.5 cm）
    // a 4 cm cube of "bone" and a "muscle" running along x through its top (rings of radius 5 mm, centred 1.5 cm up)
    const h = 0.02
    const P = new Float64Array([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h])
    const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]
    const bone = new Solid(P, I)
    const rings = 41, per = 8, n = rings * per
    const out = new Float32Array(n * 3), s = new Float32Array(n)
    for (let r = 0; r < rings; r++) for (let k = 0; k < per; k++) {
      const a = (k / per) * 2 * Math.PI, i = r * per + k
      out.set([-0.1 + (0.2 * r) / (rings - 1), 0.015 + 0.005 * Math.cos(a), 0.005 * Math.sin(a)], i * 3)
      s[i] = Math.round((r / (rings - 1)) * 1024) / 1024
    }
    const inside = (o: Float32Array): number => { let c = 0; for (let i = 0; i < n; i++) if (bone.contains(o[i * 3]!, o[i * 3 + 1]!, o[i * 3 + 2]!)) c++; return c }
    expect(inside(out)).toBeGreaterThan(50)
    const D = pushOut(out, s, new Uint8Array(n), [bone])
    const moved = Float32Array.from(out)
    for (let i = 0; i < n; i++) {
      const f = s[i]! * (VIA_SAMPLES - 1), k = Math.min(VIA_SAMPLES - 2, Math.floor(f)), a = f - k
      for (let q = 0; q < 3; q++) moved[i * 3 + q] = moved[i * 3 + q]! + D[k * 3 + q]! + (D[k * 3 + 3 + q]! - D[k * 3 + q]!) * a
    }
    expect(inside(moved)).toBe(0)
    // 推的方向朝上（离骨面最近的方向），不超过穿入深度加余量太多 / the push points up (the nearest way out), not much beyond the depth plus the margin
    let most = 0
    for (let k = 0; k < VIA_SAMPLES; k++) most = Math.max(most, D[k * 3 + 1]!)
    expect(most).toBeGreaterThan(0.01)
    expect(most).toBeLessThan(0.01 + 2 * PUSH_MARGIN)
    // 静止时在骨里的顶点（skip）不推 / vertices inside at rest (skip) are not pushed
    expect([...pushOut(out, s, new Uint8Array(n).fill(1), [bone])].every((x) => x === 0)).toBe(true)
  })
})

describe('rig signature', () => {
  it('is unchanged by an empty via list and changes when via points are added', () => {
    const a = makeRig(false).rig, b = makeRig(true).rig
    expect(rigSignature({ ...a, muscles: a.muscles.map((m) => ({ ...m, via: [] })) })).toBe(rigSignature(a))
    expect(rigSignature(b)).not.toBe(rigSignature(a))
  })
})
