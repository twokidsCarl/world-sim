// 骨架绑定的运行时：打包约定与着色器公式对照 CPU 参考实现（tools/rig/pose.ts），以及姿势工具和 store 流程。
// Rig runtime: the packing convention and the shader formulas against the CPU reference
// (tools/rig/pose.ts), plus pose utilities and the store flows.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Poser, jointFrames, type Pose } from '../tools/rig/pose.ts'
import { standardPostures } from '../tools/rig/postures.ts'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import {
  JOINT_TEXELS,
  anatomicalPose,
  breathingPose,
  dofAxisWorld,
  indexRig,
  jointGroup,
  lerpPose,
  mirrorJointId,
  packJoints,
  packMuscles,
  partJoints,
  poseIsRest,
  posePresets,
  posedBox,
  scalesAreIdentity,
  skinLikeShader,
  taperCoefficient,
  validateRig,
  withDof,
  writeInfluences,
  type LoadedRig,
  type Scales,
} from '../src/anatomy/rig.ts'
import type { AnatomyData, Joint, Part, Rig } from '../src/anatomy/types.ts'
import { setRigLoader, useApp } from '../src/state/store.ts'

const src = { name: 'test', url: '', license: 'CC0' }
const dof = (axis: 0 | 1 | 2, min: number, max: number, extra: Partial<Joint['dofs'][number]> = {}): Joint['dofs'][number] => ({ axis, name: { zh: `轴${axis}`, en: `axis ${axis}` }, min, max, source: src, ...extra })
const joint = (id: string, parent: string | null, center: [number, number, number], tail: [number, number, number], dofs: Joint['dofs'], axes?: Joint['axes']): Joint => ({
  id, name: { zh: id, en: id }, parent, center, tail,
  axes: axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  dofs, basis: { zh: '测试', en: 'test' },
})

/** 一条三节的"手臂"加左右一对关节；非右手系的轴也包含在内。 A three-segment "arm" plus a left/right pair; one joint has a left-handed frame. */
function makeRig(): { rig: LoadedRig; rest: Float32Array; n: number } {
  const joints: Joint[] = [
    joint('root', null, [0, 1, 0], [0, 1.4, 0], []),
    joint('gh_L', 'root', [0.2, 1.4, 0], [0.25, 1.1, 0], [dof(0, -1, 2.5, { neutral: 0.2 }), dof(1, -0.5, 2.5), dof(2, -1.2, 1.2, { sourced: false })]),
    joint('elbow_L', 'gh_L', [0.25, 1.1, 0], [0.27, 0.85, 0.02], [dof(0, -0.1, 2.4)], [[-0.98, -0.15, 0.13], [-0.1, -0.2, -0.97], [0.17, -0.97, 0.18]].map((a) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!); return [a[0]! / l, a[1]! / l, a[2]! / l] }) as Joint['axes']),
    joint('wrist_L', 'elbow_L', [0.27, 0.85, 0.02], [0.28, 0.75, 0.03], [dof(0, -1.2, 1.2), dof(2, -1.4, 1.4, { driver: { joint: 'elbow_L', dof: 0, ratio: 0.25 } })]),
    joint('gh_R', 'root', [-0.2, 1.4, 0], [-0.25, 1.1, 0], [dof(0, -1, 2.5), dof(1, -0.5, 2.5), dof(2, -1.2, 1.2)]),
    joint('rib5_L', 'root', [0, 1.3, -0.06], [0.13, 1.3, 0.02], [dof(0, -0.05, 0.3)]),
  ]
  const n = 400
  let seed = 7
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const rest = new Float32Array(n * 3)
  const bin = new Uint8Array(n * 12)
  const dv = new DataView(bin.buffer)
  for (let i = 0; i < n; i++) {
    rest[i * 3] = 0.15 + rnd() * 0.18
    rest[i * 3 + 1] = 0.7 + rnd() * 0.8
    rest[i * 3 + 2] = (rnd() - 0.5) * 0.1
    // 1–4 个影响，权重降序、和为 255 / one to four influences, weights descending and summing to 255
    const k = 1 + Math.floor(rnd() * 4)
    const js = [0, 1, 2, 3, 4].sort(() => rnd() - 0.5).slice(0, k)
    const raw = js.map(() => 0.05 + rnd())
    const sum = raw.reduce((a, b) => a + b, 0)
    const w = raw.map((x) => Math.max(1, Math.round((x / sum) * 255))).sort((a, b) => b - a)
    w[0]! += 255 - w.reduce((a, b) => a + b, 0)
    for (let c = 0; c < 4; c++) {
      dv.setUint16(i * 12 + c * 2, js[c] ?? 0, true)
      bin[i * 12 + 8 + c] = w[c] ?? 0
    }
  }
  const rig: Rig = {
    joints,
    bindings: [{ part: 'soft', offset: 0, vertexCount: n }, { part: 'muscle', offset: 0, vertexCount: n }, { part: 'bone', joint: 'elbow_L' }],
    muscles: [{ part: 'muscle', origin: { point: [0.21, 1.38, 0.01], joint: 'gh_L' }, insertion: { point: [0.26, 0.95, 0.02], joint: 'elbow_L' }, gain: 0.8 }],
    cautions: [{ zh: '测试', en: 'test' }],
  }
  return { rig: indexRig(rig, bin), rest, n }
}

const POSES: Record<string, Pose> = {
  elbow: { elbow_L: [1.6] },
  twist: { gh_L: [0.4, 0.9, 1.1], elbow_L: [2.0], wrist_L: [0.5, -1.2] },
  far: { gh_L: [2.4, 2.3, -1.1], elbow_L: [2.4], wrist_L: [-1.2, 1.4], gh_R: [1, 1, 1] },
}

/** 用打包后的纹理数据按着色器的算法算一个部件，与参考实现比较，返回最大偏差（米）。 */
/** Compute a part the way the shader does from the packed textures and return the largest deviation (m) from the reference. */
function maxDeviation(r: LoadedRig, rest: Float32Array, partId: string, pose: Pose, scales?: Scales): number {
  const n = rest.length / 3
  const frames = jointFrames(r.rig.joints, pose, scales)
  const jd = packJoints(frames)
  const md = packMuscles(r, frames)
  const idx = new Uint16Array(n * 4)
  const wt = new Uint8Array(n * 4)
  writeInfluences(r, partId, n, idx, wt, 0)
  const ref = new Poser(r.rig, r.bin, pose, scales).part(partId, rest, 'dqs', { mode: 'tapered' })
  const line = r.muscleOf.get(partId)
  let worst = 0
  for (let i = 0; i < n; i++) {
    const got = skinLikeShader(
      rest.subarray(i * 3, i * 3 + 3),
      idx.subarray(i * 4, i * 4 + 4),
      [...wt.subarray(i * 4, i * 4 + 4)].map((w) => w / 255),
      jd,
      !!frames.shape,
      line === undefined ? undefined : { data: md, line },
    )
    worst = Math.max(worst, Math.hypot(got[0] - ref[i * 3]!, got[1] - ref[i * 3 + 1]!, got[2] - ref[i * 3 + 2]!))
  }
  return worst
}

describe('shader formulas against the CPU reference', () => {
  const { rig, rest } = makeRig()
  // 纹理是 32 位浮点：允许约 1 微米 / the textures are 32-bit floats: about a micrometre is allowed
  const TOL = 2e-6

  it.each(Object.keys(POSES))('skinned part, pose %s', (name) => {
    expect(maxDeviation(rig, rest, 'soft', POSES[name]!)).toBeLessThan(TOL)
  })

  it.each(Object.keys(POSES))('rigid part, pose %s', (name) => {
    expect(maxDeviation(rig, rest, 'bone', POSES[name]!)).toBeLessThan(TOL)
  })

  it.each(Object.keys(POSES))('muscle with tapered volume correction, pose %s', (name) => {
    expect(maxDeviation(rig, rest, 'muscle', POSES[name]!)).toBeLessThan(TOL)
    // 修正确实在起作用（否则这项测试没有意义）/ the correction really is active, or this test would prove nothing
    const frames = jointFrames(rig.rig.joints, POSES[name]!)
    expect(Math.abs(packMuscles(rig, frames)[7]!)).toBeGreaterThan(1e-3)
  })

  it('with segment scales (shape) on skinned, rigid and muscle parts', () => {
    const scales: Scales = { gh_L: { along: 1.12, across: 0.94 }, elbow_L: { along: 0.9, across: 1.05 }, root: { along: 1.05, across: 1.05 } }
    for (const part of ['soft', 'bone', 'muscle']) {
      expect(maxDeviation(rig, rest, part, POSES.twist!, scales)).toBeLessThan(TOL)
      expect(maxDeviation(rig, rest, part, {}, scales)).toBeLessThan(TOL)
    }
  })

  it('unbound parts point at the identity row and do not move', () => {
    expect(maxDeviation(rig, rest, 'nobody', POSES.far!)).toBe(0)
    const idx = new Uint16Array(8)
    const wt = new Uint8Array(8)
    writeInfluences(rig, 'nobody', 2, idx, wt, 0)
    expect([...idx]).toEqual(new Array(8).fill(rig.rig.joints.length))
    expect([...wt]).toEqual([255, 0, 0, 0, 255, 0, 0, 0])
  })

  it('packs one row per joint plus identity, quaternions as (x, y, z, w)', () => {
    const d = packJoints(jointFrames(rig.rig.joints, {}))
    expect(d.length).toBe((rig.rig.joints.length + 1) * JOINT_TEXELS * 4)
    for (let j = 0; j <= rig.rig.joints.length; j++) {
      expect([...d.subarray(j * 32, j * 32 + 8)]).toEqual([0, 0, 0, 1, 0, 0, 0, 0])
      expect([...d.subarray(j * 32 + 8, j * 32 + 20)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    }
  })

  it('taper coefficient is zero at rest length and bounded in extreme poses', () => {
    expect(taperCoefficient(0.3, 0.3, 1)).toBe(0)
    expect(taperCoefficient(0.3, 0.2, 1)).toBeGreaterThan(0)
    expect(taperCoefficient(0.3, 0.4, 1)).toBeLessThan(0)
    expect(taperCoefficient(0.3, 0.001, 1)).toBeCloseTo(taperCoefficient(0.3, 0.01, 1))
    expect(taperCoefficient(0, 0.3, 1)).toBe(0)
  })
})

describe('rig validation and bounds', () => {
  const { rig, rest, n } = makeRig()
  it('accepts a matching rig and rejects mismatched vertex counts or joints', () => {
    const counts: Record<string, number> = { soft: n, muscle: n, bone: 10 }
    expect(validateRig(rig, (id) => counts[id])).toEqual([])
    expect(validateRig(rig, (id) => (id === 'soft' ? n - 1 : counts[id])).join(' ')).toMatch(/绑定有 400 个顶点，网格有 399 个/)
    expect(validateRig(rig, () => undefined)).toEqual([]) // 没有几何的部件不检查 / parts without geometry are not checked
    const broken = indexRig({ ...rig.rig, bindings: [{ part: 'bone', joint: 'nope' }] }, rig.bin)
    expect(validateRig(broken, () => 5).length).toBeGreaterThan(0)
    const short = indexRig(rig.rig, rig.bin.slice(0, 100))
    expect(validateRig(short, (id) => counts[id]).length).toBeGreaterThan(0)
  })

  it('lists the joints of a part and gives a posed box that contains every linear blend of its joints', () => {
    expect(partJoints(rig, 'bone', 10)).toEqual([2])
    const js = partJoints(rig, 'soft', n)
    expect([...js].sort()).toEqual([0, 1, 2, 3, 4])
    const box0: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      box0[c] = Math.min(box0[c]!, rest[i * 3 + c]!)
      box0[c + 3] = Math.max(box0[c + 3]!, rest[i * 3 + c]!)
    }
    for (const pose of Object.values(POSES)) {
      const frames = jointFrames(rig.rig.joints, pose)
      const box = posedBox(box0, js, frames.xfs)
      // 线性混合是各关节结果的凸组合，必在盒内；对偶四元数混合可能略微越出（运行时改用精确包围盒）
      // a linear blend is a convex combination of the per-joint results and must lie inside; a dual-quaternion blend can stray slightly (the runtime then switches to exact bounds)
      const out = new Poser(rig.rig, rig.bin, pose).part('soft', rest, 'lbs', false)
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
        expect(out[i * 3 + c]!).toBeGreaterThanOrEqual(box[c]!)
        expect(out[i * 3 + c]!).toBeLessThanOrEqual(box[c + 3]!)
      }
    }
    expect(posedBox(box0, [], [])).toEqual(box0)
  })
})

describe('pose utilities', () => {
  const { rig } = makeRig()
  const joints = rig.rig.joints
  it('rest detection, interpolation and the anatomical position', () => {
    expect(poseIsRest({})).toBe(true)
    expect(poseIsRest({ a: [0, 0] })).toBe(true)
    expect(poseIsRest({ a: [0, 1e-3] })).toBe(false)
    expect(lerpPose({ a: [1] }, { a: [3, 2], b: [4] }, 0.5)).toEqual({ a: [2, 1], b: [2] })
    expect(anatomicalPose(joints)).toEqual({ gh_L: [0.2, 0, 0] })
    expect(scalesAreIdentity(null)).toBe(true)
    expect(scalesAreIdentity({ a: { along: 1 } })).toBe(true)
    expect(scalesAreIdentity({ a: { across: 1.1 } })).toBe(false)
  })

  it('sets one dof clamped to its range, mirrored to the other side when asked', () => {
    expect(withDof(joints, {}, 'gh_L', 1, 9)).toEqual({ gh_L: [0, 2.5, 0] })
    expect(withDof(joints, { gh_L: [0.1, 0, 0] }, 'gh_L', 2, -0.4, true)).toEqual({ gh_L: [0.1, 0, -0.4], gh_R: [0, 0, -0.4] })
    expect(withDof(joints, {}, 'elbow_L', 0, 1, true)).toEqual({ elbow_L: [1] }) // 对侧没有这个关节 / no such joint on the other side
    expect(withDof(joints, {}, 'nope', 0, 1)).toEqual({})
    expect(mirrorJointId('knee_R')).toBe('knee_L')
    expect(mirrorJointId('L5')).toBeNull()
  })

  it('sorts joints into UI groups', () => {
    const g = (id: string) => jointGroup(id)
    expect([g('L5'), g('skull'), g('pelvis'), g('si_L')]).toEqual(['spine', 'spine', 'spine', 'spine'])
    expect([g('rib7_R'), g('tmj'), g('sc_L'), g('ac_R')]).toEqual(['ribs', 'jaw', 'shoulder', 'shoulder'])
    expect([g('gh_L'), g('radioulnar_R'), g('wrist_L')]).toEqual(['arm', 'arm', 'arm'])
    expect([g('cmc1_L'), g('mcp3_R'), g('pip2_L'), g('dip5_L'), g('ip1_R')]).toEqual(['hand', 'hand', 'hand', 'hand', 'hand'])
    expect([g('hip_L'), g('patella_R'), g('ankle_L'), g('mtp1_L'), g('tdip4_R'), g('tip1_L')]).toEqual(['leg', 'leg', 'foot', 'foot', 'foot', 'foot'])
  })

  it('breathing raises the ribs in proportion to the phase', () => {
    expect(breathingPose(joints, 0)).toEqual({ rib5_L: [0] })
    expect(breathingPose(joints, 1)).toEqual({ rib5_L: [0.3] })
  })

  it('gives each dof its world axis: rest axis for the first, turned by earlier dofs and parents after that', () => {
    const rest = jointFrames(joints, {})
    expect(dofAxisWorld(rig, rest, {}, 'gh_L', 1)!.axis).toEqual([0, 1, 0])
    expect(dofAxisWorld(rig, rest, {}, 'gh_L', 0)!.center).toEqual([0.2, 1.4, 0])
    // 第一个自由度（绕 x）转 90° 后，第二个自由度的轴（原为 y）转到 z
    // after 90° on the first dof (about x) the second dof's axis (y at rest) points along z
    const pose: Pose = { gh_L: [Math.PI / 2, 0, 0] }
    const a = dofAxisWorld(rig, jointFrames(joints, pose), pose, 'gh_L', 1)!.axis
    expect(a[0]).toBeCloseTo(0)
    expect(a[1]).toBeCloseTo(0)
    expect(a[2]).toBeCloseTo(1)
    // 肘的中心随肩转动 / the elbow centre follows the shoulder
    const c = dofAxisWorld(rig, jointFrames(joints, pose), pose, 'elbow_L', 0)!.center
    expect(c[1]).toBeCloseTo(1.4)
    expect(c[2]).toBeCloseTo(-0.3)
    expect(dofAxisWorld(rig, rest, {}, 'gh_L', 7)).toBeNull()
  })

  it('offers rest, anatomical and the validation postures as presets, clamped to range', () => {
    const p = posePresets(joints)
    expect(p.slice(0, 2).map((x) => x.id)).toEqual(['rest', 'anatomical'])
    expect(p.map((x) => x.id)).toEqual(expect.arrayContaining(standardPostures(joints).filter((x) => x.id !== 'rest').map((x) => x.id)))
    expect(p.find((x) => x.id === 'elbow140')!.pose.elbow_L![0]).toBeLessThanOrEqual(2.4)
  })
})

describe('store: rig and pose flows', () => {
  const S = () => useApp.getState()
  const part = (id: string): Part => ({ id, fma: `F${id}`, name: id, system: 'skeletal', tissue: 'bone', depth: 0, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0, 0, 0], triangles: 1, adjacent: [] })
  const data: AnatomyData = {
    schema: 1, body: 'male', sources: [], systems: [{ id: 'skeletal', name: { en: 'S', zh: 'S' }, color: '#fff', glb: 's.glb', partCount: 2 }],
    layers: [{ name: { en: 'a', zh: 'a' } }], parts: [part('bone'), part('other')],
    trees: { isa: [{ id: 'R', name: 'R', parent: null, parts: ['bone', 'other'] }], partOf: [] },
  }
  let loads = 0
  beforeEach(() => {
    loads = 0
    setRigLoader(async (_d, onProgress) => {
      loads++
      onProgress(0.5)
      return { ok: true, rig: makeRig().rig }
    })
    useApp.setState({ pose: {}, leftTab: 'display', breathing: false, poseMirror: true })
    S().init(new AnatomyGraph(data), 'male')
  })

  it('loads the rig lazily, once, when the Pose panel is first opened', async () => {
    expect(S().rigStatus).toBe('idle')
    expect(loads).toBe(0)
    S().setLeftTab('pose')
    expect(S().rigStatus).toBe('loading')
    await S().ensureRig()
    expect(S().rigStatus).toBe('ready')
    expect(S().rigProgress).toBe(1)
    S().setLeftTab('display')
    S().setLeftTab('pose')
    await S().ensureRig()
    expect(loads).toBe(1)
  })

  it('reports a missing or stale rig, and a rig the viewer rejects, as posing unavailable', async () => {
    setRigLoader(async () => ({ ok: false, reason: 'stale', message: '旧' }))
    expect(await S().ensureRig()).toBeNull()
    expect([S().rigStatus, S().rigMessage]).toEqual(['stale', '旧'])
    S().init(new AnatomyGraph(data), 'male')
    setRigLoader(async () => ({ ok: true, rig: makeRig().rig }))
    await S().ensureRig()
    S().rejectRig('顶点数不符')
    expect([S().rig, S().rigStatus, S().rigMessage]).toEqual([null, 'stale', '顶点数不符'])
    expect(await S().ensureRig()).toBeNull()
  })

  it('sets dofs (mirrored and clamped), applies presets with a transition, and resets', async () => {
    await S().ensureRig()
    S().setDof('gh_L', 0, 9)
    expect(S().pose).toEqual({ gh_L: [2.5, 0, 0], gh_R: [2.5, 0, 0] })
    S().setPoseMirror(false)
    S().setDof('gh_L', 1, 0.3)
    expect(S().pose.gh_R).toEqual([2.5, 0, 0])
    const n = S().poseAnimate
    S().applyPosePreset('elbow90')
    expect(S().poseAnimate).toBe(n + 1)
    expect(S().pose.elbow_L![0]).toBeCloseTo(Math.PI / 2)
    S().resetPose()
    expect(S().pose).toEqual({})
    expect(S().poseAnimate).toBe(n + 2)
  })

  it('selecting a joint selects the parts rigidly bound to it', async () => {
    await S().ensureRig()
    S().selectJoint('elbow_L')
    expect(S().poseJoint).toBe('elbow_L')
    expect(S().selection.ids).toEqual(['bone'])
    S().selectJoint(null)
    expect(S().poseJoint).toBeNull()
  })

  it('a body switch keeps the pose by joint id and reloads the rig for the new body', async () => {
    await S().ensureRig()
    S().setDof('elbow_L', 0, 1)
    S().init(new AnatomyGraph({ ...data, body: 'female' }), 'female')
    expect(S().rig).toBeNull()
    expect(S().pose).toEqual({ elbow_L: [1] })
    await S().ensureRig() // init 已因姿势非静止而开始加载 / init already started loading because the pose is not rest
    expect(S().rigStatus).toBe('ready')
    expect(loads).toBe(2)
  })
})

// 真实的男性绑定（未提交到仓库的大文件，缺失时跳过）：抽样顶点，着色器公式对照参考实现
// The real male rig (a large file that may be absent; skipped then): sampled vertices, shader formulas against the reference
const maleDir = resolve(__dirname, '../public/anatomy/male')
describe.skipIf(!existsSync(resolve(maleDir, 'rig.bin')))('real male rig', () => {
  it('matches the reference on sampled skinned vertices in the validation postures', () => {
    const rigJson = JSON.parse(readFileSync(resolve(maleDir, 'rig.json'), 'utf8')) as Rig
    const raw = readFileSync(resolve(maleDir, 'rig.bin'))
    const r = indexRig(rigJson, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    const skinned = rigJson.bindings.filter((b) => b.offset !== undefined && (b.vertexCount ?? 0) > 50)
    let seed = 11
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    let worst = 0
    for (const posture of standardPostures(rigJson.joints).filter((p) => ['squat', 'elbow140', 'shoulderAbd90', 'fist', 'pronation'].includes(p.id))) {
      for (let s = 0; s < 40; s++) {
        const b = skinned[Math.floor(rnd() * skinned.length)]!
        const n = b.vertexCount!
        // 顶点位置随机即可：这里检验的是混合公式，不是几何 / random positions suffice: the blend is under test, not the geometry
        const rest = new Float32Array(n * 3).map((_, i) => (i % 3 === 1 ? rnd() * 1.7 : (rnd() - 0.5) * 0.6))
        worst = Math.max(worst, maxDeviation(r, rest, b.part, posture.pose))
      }
    }
    expect(worst).toBeLessThan(5e-6)
  })
})

const fixtureDir = resolve(__dirname, '../public/anatomy/fixture')
describe.skipIf(!existsSync(resolve(fixtureDir, 'rig.json')))('fixture rig', () => {
  it('is consistent with the fixture body and its skin maps, and poses with the reference', () => {
    const rigJson = JSON.parse(readFileSync(resolve(fixtureDir, 'rig.json'), 'utf8')) as Rig
    const raw = readFileSync(resolve(fixtureDir, 'rig.bin'))
    const r = indexRig(rigJson, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    const body = JSON.parse(readFileSync(resolve(fixtureDir, 'anatomy.json'), 'utf8')) as AnatomyData
    const skin = JSON.parse(readFileSync(resolve(fixtureDir, 'skinmaps.json'), 'utf8')) as { part: string; vertexCount: number }
    expect(new Set(rigJson.bindings.map((b) => b.part))).toEqual(new Set(body.parts.map((p) => p.id)))
    expect(r.bindingOf.get(skin.part)!.vertexCount).toBe(skin.vertexCount)
    expect(validateRig(r, (id) => r.bindingOf.get(id)?.vertexCount ?? 10)).toEqual([])
    expect(rigJson.muscles).toHaveLength(1)
    expect(rigJson.cautions.length).toBeGreaterThan(0)
    expect(posePresets(rigJson.joints).map((p) => p.id)).toEqual(expect.arrayContaining(['rest', 'anatomical', 'elbow90', 'inspiration']))
    const n = skin.vertexCount
    const rest = new Float32Array(n * 3).map((_, i) => (i % 3 === 0 ? 0.25 : i % 3 === 1 ? 0.9 + (i / (n * 3)) * 0.5 : 0))
    expect(maxDeviation(r, rest, skin.part, { gh_L: [0.6, 0.8], elbow_L: [1.9] })).toBeLessThan(2e-6)
  })
})
