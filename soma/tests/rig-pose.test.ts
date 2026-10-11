// 摆姿势参考实现（tools/rig/pose.ts）在合成骨架上的单元测试。
// Unit tests of the pose reference (tools/rig/pose.ts) on a synthetic skeleton.

import { describe, expect, it } from 'vitest'
import type { Joint, MuscleLine, Rig } from '../src/anatomy/types.ts'
import { meshVolume } from '../tools/rig/geom.ts'
import { type V3, dqFromXf, rotateAbout, axisAngle, xfApply, xfFromDq, xfMul } from '../tools/rig/math.ts'
import { type DofWithDriver, BYTES_PER_VERTEX, Poser, clampPose, correctMuscleVolume, effectiveAngles, jointFrames, jointTransforms, mergePoses, muscleLength, segmentAxis, shoulderElevation, skin, transformRigid } from '../tools/rig/pose.ts'
import { PoseBuilder } from '../tools/rig/postures.ts'

const SRC = { name: 'test', url: '', license: '' }
const dof = (axis: 0 | 1 | 2, min: number, max: number, extra: Partial<DofWithDriver> = {}): DofWithDriver => ({ axis, name: { zh: '屈 / 伸', en: 'flexion / extension' }, min, max, source: SRC, ...extra })
const joint = (id: string, parent: string | null, center: V3, dofs: DofWithDriver[]): Joint => ({ id, name: { zh: id, en: id }, parent, center, axes: [[1, 0, 0], [0, 0, 1], [0, 1, 0]], dofs, basis: { zh: '', en: '' } })

/** 竖直的两节“手臂”：肩在原点，肘在 y = −0.3，另有一个被肘带动的“髌骨”关节。 A vertical two-segment "arm": shoulder at the origin, elbow at y = −0.3, plus a "patella" joint driven by the elbow. */
const JOINTS: Joint[] = [
  joint('root', null, [0, 0, 0], []),
  joint('shoulder', 'root', [0, 0, 0], [dof(0, -1, 3), dof(1, -0.5, 3), dof(2, -1.5, 1.5)]),
  joint('elbow', 'shoulder', [0, -0.3, 0], [dof(0, 0, 2.5)]),
  joint('follower', 'shoulder', [0, -0.3, 0], [dof(0, -3, 3, { driver: { joint: 'elbow', dof: 0, ratio: 0.5 } })]),
]

/** 沿 −y 的圆管网格，n 圈。 A tube mesh along −y with n rings. */
function tube(y0: number, y1: number, r: number, rings = 30, sides = 12): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [], idx: number[] = []
  for (let i = 0; i <= rings; i++) {
    const y = y0 + ((y1 - y0) * i) / rings
    for (let k = 0; k < sides; k++) pos.push(r * Math.cos((2 * Math.PI * k) / sides), y, r * Math.sin((2 * Math.PI * k) / sides))
  }
  for (let i = 0; i < rings; i++) for (let k = 0; k < sides; k++) {
    const a = i * sides + k, b = i * sides + ((k + 1) % sides), c = a + sides, d = b + sides
    idx.push(a, c, b, b, c, d)
  }
  // 两端封口 / caps
  const top = pos.length / 3
  pos.push(0, y0, 0, 0, y1, 0)
  for (let k = 0; k < sides; k++) {
    idx.push(top, k, (k + 1) % sides)
    idx.push(top + 1, rings * sides + ((k + 1) % sides), rings * sides + k)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** 肘上下各 5 cm 内线性过渡的权重。 Weights blending linearly within 5 cm either side of the elbow. */
function tubeBin(positions: Float32Array, upper: number, lower: number): Uint8Array {
  const n = positions.length / 3
  const bin = new Uint8Array(n * BYTES_PER_VERTEX)
  const dv = new DataView(bin.buffer)
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (-0.25 - positions[i * 3 + 1]!) / 0.1))
    const w = Math.round(t * 255)
    dv.setUint16(i * BYTES_PER_VERTEX, upper, true)
    dv.setUint16(i * BYTES_PER_VERTEX + 2, lower, true)
    bin[i * BYTES_PER_VERTEX + 8] = 255 - w
    bin[i * BYTES_PER_VERTEX + 9] = w
  }
  return bin
}

describe('joint transforms', () => {
  it('are the identity in the rest pose', () => {
    for (const m of jointTransforms(JOINTS, {})) {
      expect(m.r).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
      expect(Math.hypot(...m.t)).toBe(0)
    }
  })

  it('compose down the chain: the hand follows shoulder and elbow', () => {
    const xf = jointTransforms(JOINTS, { shoulder: [Math.PI / 2, 0, 0], elbow: [Math.PI / 2] })
    // 手在 (0, −0.6, 0)。肘屈 90°（绕 +x）把它转到 (0, −0.3, −0.3)；肩再屈 90° 转到 (0, 0.3, −0.3)。
    // the hand at (0, −0.6, 0): 90° at the elbow (about +x) takes it to (0, −0.3, −0.3), then 90° at the shoulder to (0, 0.3, −0.3)
    const hand = xfApply(xf[2]!, [0, -0.6, 0])
    expect(hand[0]).toBeCloseTo(0, 9)
    expect(hand[1]).toBeCloseTo(0.3, 9)
    expect(hand[2]).toBeCloseTo(-0.3, 9)
  })

  it('apply the dofs of a joint in order, the first about the proximal-fixed axis', () => {
    // 先屈 90°（轴 0），再绕长轴旋转（轴 2）：长轴随屈曲一起转，所以肘的位置不受旋转影响
    // flex 90° (axis 0) then rotate about the long axis (axis 2): the long axis turns with the flexion, so the elbow does not move with the rotation
    const a = xfApply(jointTransforms(JOINTS, { shoulder: [Math.PI / 2, 0, 0] })[1]!, [0, -0.3, 0])
    const b = xfApply(jointTransforms(JOINTS, { shoulder: [Math.PI / 2, 0, 1.0] })[1]!, [0, -0.3, 0])
    for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k]!, 9)
  })

  it('drive a coupled dof by its ratio', () => {
    const ang = effectiveAngles(JOINTS, { elbow: [1.2], follower: [0.1] })
    expect(ang[3]![0]).toBeCloseTo(0.1 + 0.6, 12)
    const xf = jointTransforms(JOINTS, { elbow: [1.0] })
    const direct = rotateAbout(axisAngle([1, 0, 0], 0.5), [0, -0.3, 0])
    const p = xfApply(xf[3]!, [0, -0.35, 0.02]), q = xfApply(direct, [0, -0.35, 0.02])
    for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(q[k]!, 9)
  })

  it('clamp and merge poses', () => {
    expect(clampPose(JOINTS, { elbow: [9], shoulder: [-9, 0, 0] })).toEqual({ elbow: [2.5], shoulder: [-1, 0, 0] })
    expect(mergePoses({ elbow: [0.5] }, { elbow: [0.25], shoulder: [0, 1, 0] })).toEqual({ elbow: [0.75], shoulder: [0, 1, 0] })
    const s = shoulderElevation('L', Math.PI / 2)
    expect(s.gh_L![1]! + s.ac_L![0]! + s.sc_L![1]!).toBeCloseTo(Math.PI / 2, 9)
    expect(s.gh_L![1]! / (Math.PI / 2)).toBeCloseTo(2 / 3, 9)
  })

  it('convert anatomical angles through a dof neutral and report clamping', () => {
    const js = [joint('j', null, [0, 0, 0], [dof(0, -0.2, 1.0, { neutral: -0.3 } as Partial<DofWithDriver>)])]
    const b = new PoseBuilder(js).anat('j', 0, 90)
    expect(b.pose.j![0]).toBeCloseTo(1.0, 9)
    expect(b.clamped.length).toBe(1)
    expect(new PoseBuilder(js).anat('j', 0, 30).pose.j![0]).toBeCloseTo(Math.PI / 6 - 0.3, 9)
  })
})

describe('dual quaternions', () => {
  it('round-trip a rigid transform', () => {
    const m = xfMul(rotateAbout(axisAngle([0.6, 0, 0.8], 1.1), [0.2, -0.1, 0.4]), { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0.01, 0.02, -0.03] })
    const back = xfFromDq(dqFromXf(m))
    const p = xfApply(m, [0.3, 0.2, 0.1]), q = xfApply(back, [0.3, 0.2, 0.1])
    for (let k = 0; k < 3; k++) expect(q[k]).toBeCloseTo(p[k]!, 9)
  })
})

describe('skinning', () => {
  const mesh = tube(0, -0.6, 0.03)
  const bin = tubeBin(mesh.positions, 1, 2)

  it('reproduces the rest mesh exactly with both blend modes', () => {
    const xf = jointTransforms(JOINTS, {})
    expect(Array.from(skin(mesh.positions, bin, 0, xf, 'lbs'))).toEqual(Array.from(mesh.positions))
    expect(Array.from(skin(mesh.positions, bin, 0, xf, 'dqs'))).toEqual(Array.from(mesh.positions))
  })

  it('moves fully weighted vertices rigidly', () => {
    const xf = jointTransforms(JOINTS, { elbow: [1.3] })
    const out = skin(mesh.positions, bin, 0, xf, 'dqs')
    const rigid = transformRigid(mesh.positions, xf[2]!)
    const last = mesh.positions.length / 3 - 1
    for (let k = 0; k < 3; k++) expect(out[last * 3 + k]).toBeCloseTo(rigid[last * 3 + k]!, 6)
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(mesh.positions[k]!, 6)
  })

  it('keeps the tube round at a twisting joint with dual quaternions where linear blending collapses it', () => {
    // 前臂旋转：绕长轴扭 150°。线性混合在过渡带中点把横截面压扁；对偶四元数保持半径。
    // forearm rotation: 150° of twist about the long axis. Linear blending flattens the cross-section half-way; dual quaternions keep the radius.
    const twist: Joint[] = [joint('a', null, [0, 0, 0], []), joint('b', 'a', [0, -0.3, 0], [dof(2, -3, 3)])]
    const xf = jointTransforms(twist, { b: [(150 * Math.PI) / 180] })
    const tb = tubeBin(mesh.positions, 0, 1)
    const radiusAt = (p: Float32Array): number => {
      let best = 1
      for (let i = 0; i < p.length / 3; i++) if (Math.abs(p[i * 3 + 1]! + 0.3) < 0.011) best = Math.min(best, Math.hypot(p[i * 3]!, p[i * 3 + 2]!))
      return best
    }
    expect(radiusAt(skin(mesh.positions, tb, 0, xf, 'lbs'))).toBeLessThan(0.012)
    expect(radiusAt(skin(mesh.positions, tb, 0, xf, 'dqs'))).toBeGreaterThan(0.0295)
  })
})

describe('muscle volume', () => {
  // 一块沿 −y 的肌肉，上端跟“a”，下端跟“b”，权重沿全长线性过渡。b 的转轴在肌肉前方 33 cm，
  // 所以 b 转动时下端几乎沿肌肉长轴移动：肌肉被压短而不是被弯折。
  // A muscle along −y whose upper end follows "a" and lower end "b", weights blending along its whole
  // length. The axis of b lies 33 cm in front of the muscle, so turning b moves the lower end almost
  // along the muscle: it is compressed rather than bent.
  const MJ: Joint[] = [joint('a', null, [0, 0, 0], []), joint('b', 'a', [0, -0.45, 0.3], [dof(0, -1, 1)])]
  const mesh = tube(-0.05, -0.45, 0.02, 40, 16)
  const n = mesh.positions.length / 3
  for (let i = 0; i < n; i++) mesh.positions[i * 3 + 2] = mesh.positions[i * 3 + 2]! - 0.03
  const bin = new Uint8Array(n * BYTES_PER_VERTEX)
  const dv = new DataView(bin.buffer)
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (-0.05 - mesh.positions[i * 3 + 1]!) / 0.4))
    const w = Math.round(t * 255)
    dv.setUint16(i * BYTES_PER_VERTEX, 0, true)
    dv.setUint16(i * BYTES_PER_VERTEX + 2, 1, true)
    bin[i * BYTES_PER_VERTEX + 8] = 255 - w
    bin[i * BYTES_PER_VERTEX + 9] = w
  }
  const line: MuscleLine = { part: 'm', origin: { point: [0, -0.05, -0.03], joint: 'a' }, insertion: { point: [0, -0.45, -0.03], joint: 'b' } }
  const index = new Map(MJ.map((j, i) => [j.id, i]))
  const v0 = Math.abs(meshVolume(mesh.positions, mesh.indices))
  const POSE = { b: [0.3] }

  it('measures the line of action', () => {
    const L = muscleLength(line, jointTransforms(MJ, POSE), index)
    expect(L.rest).toBeCloseTo(0.4, 9)
    expect(L.length).toBeLessThan(0.33)
    expect(L.length).toBeGreaterThan(0.28)
  })

  it('restores most of the volume lost by shortening, in both modes', () => {
    const xf = jointTransforms(MJ, POSE)
    const skinned = skin(mesh.positions, bin, 0, xf, 'lbs')
    const err = (p: Float32Array): number => Math.abs(Math.abs(meshVolume(p, mesh.indices)) / v0 - 1)
    const before = err(skinned)
    expect(before).toBeGreaterThan(0.15)
    for (const mode of ['uniform', 'tapered'] as const) {
      const c = Float32Array.from(skinned)
      const s = correctMuscleVolume(c, line, xf, index, { mode })
      expect(s).toBeGreaterThan(1)
      expect(err(c)).toBeLessThan(0.35 * before)
    }
  })

  it('leaves the attachment ends in place when tapered', () => {
    const xf = jointTransforms(MJ, POSE)
    const skinned = skin(mesh.positions, bin, 0, xf, 'lbs')
    const u = Float32Array.from(skinned), t = Float32Array.from(skinned)
    correctMuscleVolume(u, line, xf, index, { mode: 'uniform' })
    correctMuscleVolume(t, line, xf, index, { mode: 'tapered' })
    const move = (p: Float32Array, i: number): number => Math.hypot(p[i * 3]! - skinned[i * 3]!, p[i * 3 + 1]! - skinned[i * 3 + 1]!, p[i * 3 + 2]! - skinned[i * 3 + 2]!)
    expect(move(t, 0)).toBeLessThan(1e-4)
    expect(move(u, 0)).toBeGreaterThan(5e-4)
  })

  it('poses parts through a rig: rigid binding, skinned binding, and the volume gain', () => {
    const rig: Rig = { joints: MJ, bindings: [{ part: 'bone', joint: 'b' }, { part: 'm', offset: 0, vertexCount: n }], muscles: [{ ...line, gain: 0 } as MuscleLine], cautions: [] }
    const poser = new Poser(rig, bin, POSE)
    const bone = poser.part('bone', Float32Array.from([0, -0.6, 0]))
    const expected = xfApply(poser.xfs[1]!, [0, -0.6, 0])
    for (let k = 0; k < 3; k++) expect(bone[k]).toBeCloseTo(expected[k]!, 6)
    // gain = 0：不作体积修正 / gain 0: no volume correction
    expect(Array.from(poser.part('m', mesh.positions))).toEqual(Array.from(poser.part('m', mesh.positions, 'dqs', false)))
    expect(poser.jointCenter('b')[1]).toBeCloseTo(-0.45, 9)
    expect(Array.from(poser.part('unbound', Float32Array.from([1, 2, 3])))).toEqual([1, 2, 3])
  })
})

describe('segment scales (body shape)', () => {
  // 肩关节带上臂（tail 在肘），肘关节带前臂（tail 在手）
  // the shoulder moves the upper arm (tail at the elbow), the elbow the forearm (tail at the hand)
  const SJ = JOINTS.map((j) => ({ ...j, tail: j.id === 'shoulder' ? [0, -0.3, 0] : j.id === 'elbow' ? [0, -0.6, 0] : j.center })) as Joint[]
  const mesh = tube(0, -0.6, 0.03)
  const bin = tubeBin(mesh.positions, 1, 2)

  it('finds the segment axis from the tail', () => {
    expect(segmentAxis(SJ[1]!)).toEqual([0, -1, 0])
    expect(segmentAxis(JOINTS[1]!)).toEqual([0, 1, 0])
  })

  it('changes nothing when every scale is 1', () => {
    const f = jointFrames(SJ, { elbow: [0.7] }, { shoulder: { along: 1, across: 1 } })
    expect(f.shape).toBeNull()
    const a = skin(mesh.positions, bin, 0, f.xfs, 'dqs'), b = skin(mesh.positions, bin, 0, jointTransforms(SJ, { elbow: [0.7] }), 'dqs')
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('lengthens a segment, carries the child joint along and leaves the child unscaled', () => {
    const f = jointFrames(SJ, {}, { shoulder: { along: 1.2 } })
    // 肘从 y = −0.3 移到 −0.36；前臂长度不变，手到 −0.66
    // the elbow goes from y = −0.3 to −0.36; the forearm keeps its length, so the hand is at −0.66
    const elbow = xfApply(f.xfs[2]!, [0, -0.3, 0]), hand = xfApply(f.xfs[2]!, [0, -0.6, 0])
    expect(elbow[1]).toBeCloseTo(-0.36, 9)
    expect(hand[1]).toBeCloseTo(-0.66, 9)
    // 上臂中点按比例移动，粗细不变 / the middle of the upper arm moves in proportion, its thickness is unchanged
    const mid = xfApply(f.xfs[1]!, [0.03, -0.15, 0])
    expect(mid[1]).toBeCloseTo(-0.18, 9)
    expect(mid[0]).toBeCloseTo(0.03, 9)
  })

  it('thickens a segment in cross-section only', () => {
    const f = jointFrames(SJ, {}, { elbow: { across: 1.5 } })
    const p = xfApply(f.xfs[2]!, [0.02, -0.45, 0.01])
    expect(p[0]).toBeCloseTo(0.03, 9)
    expect(p[1]).toBeCloseTo(-0.45, 9)
    expect(p[2]).toBeCloseTo(0.015, 9)
  })

  it('poses the scaled skeleton about the scaled joint centres, in both blend modes', () => {
    const scales = { shoulder: { along: 1.2 }, elbow: { along: 0.9, across: 1.1 } }
    const pose = { elbow: [Math.PI / 2] }
    const f = jointFrames(SJ, pose, scales)
    // 肘在 −0.36；前臂长 0.27，屈 90° 后手在肘前方（−z）0.27 处
    // the elbow is at −0.36; the forearm is 0.27 long and at 90° the hand lies 0.27 in front (−z) of the elbow
    const hand = xfApply(f.xfs[2]!, [0, -0.6, 0])
    expect(hand[1]).toBeCloseTo(-0.36, 9)
    expect(hand[2]).toBeCloseTo(-0.27, 9)
    const rig: Rig = { joints: SJ, bindings: [{ part: 'arm', offset: 0, vertexCount: mesh.positions.length / 3 }], muscles: [], cautions: [] }
    const poser = new Poser(rig, bin, pose, scales)
    const last = mesh.positions.length / 3 - 1
    for (const mode of ['lbs', 'dqs'] as const) {
      const out = poser.part('arm', mesh.positions, mode)
      // 完全跟随前臂的顶点（末端封口中心）与刚体结果一致；完全跟随上臂的顶点只被拉长
      // a vertex fully on the forearm (the centre of the far cap) agrees with the rigid result; one fully on the upper arm is only lengthened
      for (let k = 0; k < 3; k++) expect(out[last * 3 + k]).toBeCloseTo(hand[k]!, 6)
      expect(out[1]).toBeCloseTo(0, 6)
      expect(Math.hypot(out[0]!, out[2]!)).toBeCloseTo(0.03, 6)
    }
    expect(poser.jointCenter('elbow')[1]).toBeCloseTo(-0.36, 9)
  })
})
