// 肌肉活动：求解器在有解析解的小问题上的结果、确定性；模型在合成骨架上的力矩和力臂；显示标度；地址参数。
// Muscle activity: the solver on toy problems with analytic answers and its determinism; torques and moment arms
// of the model on a synthetic skeleton; display scales; URL parameters.

import { describe, expect, it } from 'vitest'
import type { Joint } from '../src/anatomy/types.ts'
import { LENGTH_RAMP, LOAD_RAMP, bulgeAmount, lengthLevel, loadLevel, rampColor } from '../src/activity/display.ts'
import { ActivityModel, DofStatus, rigSignature } from '../src/activity/model.ts'
import { Workspace, solveBounded, type BoundedLsq } from '../src/activity/solver.ts'
import { formatLoad, parseActivityParams, parseLoad } from '../src/activity/state.ts'
import type { ActivityData } from '../src/activity/types.ts'
import { jointFrames, muscleLength } from '../tools/rig/pose.ts'

/** 由稠密矩阵（行 = 自由度，列 = 肌肉）构造问题 / Build a problem from a dense matrix (rows = dofs, columns = muscles). */
function problem(A: number[][], tau: number[], kappa = 1e6): BoundedLsq {
  const m = A.length, n = A[0]!.length
  const colStart = new Int32Array(n + 1)
  const row: number[] = [], val: number[] = []
  for (let i = 0; i < n; i++) {
    colStart[i] = row.length
    for (let j = 0; j < m; j++) {
      if (A[j]![i] !== 0) {
        row.push(j)
        val.push(A[j]![i]!)
      }
    }
  }
  colStart[n] = row.length
  const weight = new Float64Array(m)
  for (let j = 0; j < m; j++) {
    const cap = A[j]!.reduce((s, v) => s + Math.abs(v), 0)
    weight[j] = kappa / (cap * cap)
  }
  return { n, m, colStart, row: Int32Array.from(row), val: Float64Array.from(val), cost: new Float64Array(n).fill(1), upper: new Float64Array(n).fill(1), weight, rhs: Float64Array.from(tau) }
}

function solve(A: number[][], tau: number[], start?: number[]): { x: number[]; res: number[]; converged: boolean } {
  const p = problem(A, tau)
  const x = Float64Array.from(start ?? new Array<number>(p.n).fill(0))
  const ws = new Workspace()
  const s = solveBounded(p, x, ws)
  return { x: [...x], res: [...ws.res.subarray(0, p.m)], converged: s.converged }
}

describe('bounded least-squares solver', () => {
  it('one joint, two antagonists: only the agonist works', () => {
    // 屈肌满激活给 +30 N·m，伸肌给 −20 N·m / flexor gives +30 N·m at full activation, extensor −20 N·m
    const flex = solve([[30, -20]], [6])
    expect(flex.x[0]).toBeCloseTo(0.2, 3)
    expect(flex.x[1]).toBe(0)
    const ext = solve([[30, -20]], [-5])
    expect(ext.x[0]).toBe(0)
    expect(ext.x[1]).toBeCloseTo(0.25, 3)
  })

  it('two synergists share in proportion to their capacity (min Σa²)', () => {
    // a_i = M_i·τ / Σ M²
    const r = solve([[30, 10]], [10])
    expect(r.x[0]).toBeCloseTo((30 * 10) / 1000, 3)
    expect(r.x[1]).toBeCloseTo((10 * 10) / 1000, 3)
    expect(Math.abs(r.res[0]!)).toBeLessThan(0.01)
  })

  it('saturates and reports the residual when the muscles cannot deliver', () => {
    const r = solve([[30, 10, -20]], [55])
    expect(r.x[0]).toBe(1)
    expect(r.x[1]).toBe(1)
    expect(r.x[2]).toBe(0)
    expect(r.res[0]).toBeCloseTo(15, 6)
  })

  it('a biarticular chain: the two-joint muscle is used where it helps both joints and avoided where it hurts', () => {
    // 列：单关节屈肌 1、双关节肌（两个关节都屈）、单关节屈肌 2、关节 2 的伸肌
    // columns: one-joint flexor of joint 1, biarticular muscle (flexes both), one-joint flexor of joint 2, extensor of joint 2
    const A = [
      [20, 20, 0, 0],
      [0, 20, 20, -20],
    ]
    // 两个关节都要屈：解析解（拉格朗日）a = Aᵀ(AAᵀ)⁻¹τ = [0.1, 0.2, 0.0667, −0.0667] 中伸肌为负，截到 0 后重新求解
    // both joints need flexion: the unconstrained solution has a negative extensor; with it at zero the KKT solution follows
    const both = solve(A, [6, 6])
    expect(both.x[3]).toBe(0)
    expect(both.x[1]).toBeGreaterThan(both.x[0]!)
    expect(both.x[1]).toBeGreaterThan(both.x[2]!)
    // 在自由变量上：a = A_Fᵀ(A_F A_Fᵀ)⁻¹τ，A_F = [[20,20,0],[0,20,20]] → a = [0.1, 0.2, 0.1]
    expect(both.x[0]).toBeCloseTo(0.1, 3)
    expect(both.x[1]).toBeCloseTo(0.2, 3)
    expect(both.x[2]).toBeCloseTo(0.1, 3)
    // 关节 1 要屈、关节 2 要伸：双关节肌帮了关节 1 却害了关节 2，应当用得比单关节屈肌少
    // joint 1 needs flexion and joint 2 extension: the biarticular muscle helps one and hurts the other and is used less than the one-joint flexor
    const opp = solve(A, [6, -6])
    expect(opp.x[0]).toBeGreaterThan(opp.x[1]!)
    expect(opp.x[2]).toBe(0)
    expect(opp.x[3]).toBeGreaterThan(0.25)
    for (const r of [both, opp]) for (const v of r.res) expect(Math.abs(v)).toBeLessThan(0.01)
  })

  it('is deterministic, and a warm start changes nothing but the time', () => {
    const A = [
      [20, 20, 0, 0, 5, -8],
      [0, 20, 20, -20, -3, 2],
      [4, 0, -6, 3, 9, 0],
    ]
    const tau = [6, -2, 1.5]
    const a = solve(A, tau), b = solve(A, tau)
    expect(a.x).toEqual(b.x)
    expect(a.converged).toBe(true)
    const warm = solve(A, tau, [0.9, 0, 0.4, 1, 0.2, 0.7])
    warm.x.forEach((v, i) => expect(v).toBeCloseTo(a.x[i]!, 5))
  })
})

// ── 合成骨架：骨盆（根）— 肩 — 肘，两个铰链，轴沿 X；上臂沿 −Y，前臂沿 −Y ─────────────────────────────
// a synthetic skeleton: pelvis (root) — shoulder — elbow, two hinges about X; upper arm and forearm along −Y
const src = { name: 'test', url: '', license: '' }
const hinge = (id: string, parent: string | null, center: [number, number, number], range: [number, number]): Joint => ({
  id,
  name: { zh: id, en: id },
  parent,
  center,
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  dofs: parent === null ? [] : [{ axis: 0, name: { zh: '屈 / 伸', en: 'flexion / extension' }, min: range[0], max: range[1], source: src }],
  basis: { zh: '', en: '' },
})
const toyJoints: Joint[] = [hinge('pelvis', null, [0, 1, 0], [0, 0]), hinge('shoulder', 'pelvis', [0, 1.4, 0], [-3, 3]), hinge('elbow', 'shoulder', [0, 1.1, 0], [-3, 3])]
const muscle = (part: string, path: [string, [number, number, number]][], fmaxN: number): ActivityData['muscles'][number] => ({ part, name: part, line: -1, path: path.map(([joint, point]) => ({ joint, point })), volumeCm3: 0, fibreM: 0.1, fibreBasis: '', pcsaCm2: 0, fmaxN, flags: [] })
const toyData: ActivityData = {
  schema: 1,
  body: 'male',
  inputs: {},
  rigSignature: '',
  mass: {
    bodyKg: 5,
    statureM: 1.7,
    bmi: 22,
    computedKg: 5,
    segments: [
      { joint: 'shoulder', kg: 2, com: [0, 1.25, 0] },
      { joint: 'elbow', kg: 1, com: [0, 0.95, 0] },
      { joint: 'pelvis', kg: 2, com: [0, 1, 0] },
    ],
  },
  muscles: [
    // 屈肘肌：上臂前面 → 前臂前面；伸肘肌在后面；双关节肌从躯干到前臂（跨肩和肘）
    // elbow flexor: front of the upper arm → front of the forearm; the extensor behind; a biarticular muscle from trunk to forearm (spans shoulder and elbow)
    muscle('flexor', [['shoulder', [0, 1.3, 0.03]], ['elbow', [0, 1.05, 0.03]]], 500),
    muscle('extensor', [['shoulder', [0, 1.3, -0.03]], ['elbow', [0, 1.05, -0.03]]], 500),
    muscle('biarticular', [['pelvis', [0, 1.45, 0.04]], ['elbow', [0, 1.05, 0.03]]], 500),
    muscle('shoulderFlexor', [['pelvis', [0, 1.45, 0.05]], ['shoulder', [0, 1.3, 0.03]]], 800),
    muscle('shoulderExtensor', [['pelvis', [0, 1.45, -0.05]], ['shoulder', [0, 1.3, -0.03]]], 800),
  ],
  excluded: [],
  contacts: [],
  hands: { L: { joint: 'elbow', point: [0, 0.8, 0] } },
  lockedJoints: [],
  dofGroups: [],
  params: { specificTensionNcm2: 61, g: 9.81, reservePenalty: 1e4, limitTolerance: 0.05, contactTolerance: 0.015, nearCentre: 0.005, bulgeMax: 0.1, displayFull: 0.5 },
  sources: [],
  cautions: [],
}

describe('activity model on a synthetic two-joint arm', () => {
  const model = new ActivityModel({ joints: toyJoints }, toyData)
  const half = Math.PI / 2
  const unit = (id: string): number => model.unitIndex(id, 0)
  const act = (r: { activation: Float32Array }, part: string): number => r.activation[model.muscles.findIndex((m) => m.part === part)]!

  it('gravitational torque equals m·g·d', () => {
    // 屈肘 90°：前臂水平向前（绕 +X 转 90° 把 −Y 变成 −Z？）——取使前臂水平的方向，力矩大小为 1 kg × 9.81 × 0.15 m
    // elbow at 90°: the forearm is horizontal; the torque is 1 kg × 9.81 × 0.15 m whichever way it points
    const r = model.evaluate({ elbow: [half] }, null, { cold: true })
    expect(Math.abs(r.required[unit('elbow')]!)).toBeCloseTo(1 * 9.81 * 0.15, 4)
    // 肩上的力矩：只有前臂的质心偏离了肩的铅垂线 / at the shoulder only the forearm's centre of mass is off the vertical through the joint
    expect(Math.abs(r.required[unit('shoulder')]!)).toBeCloseTo(1 * 9.81 * 0.15, 4)
    // 手上加 2 kg（作用点离肘 0.3 m）/ 2 kg in the hand (0.3 m from the elbow)
    const loaded = model.evaluate({ elbow: [half] }, null, { cold: true, load: { kg: 2, side: 'L' } })
    expect(Math.abs(loaded.required[unit('elbow')]!)).toBeCloseTo(9.81 * (0.15 + 2 * 0.3), 4)
  })

  it('the muscle on the side gravity pulls away from works; its antagonist is silent', () => {
    // 用 ±0.6 rad：直线作用线在 90° 时会穿过关节，两条肌肉的力臂同号 / ±0.6 rad: at 90° the straight lines cut through the joint and both arms have the same sign
    for (const angle of [0.6, -0.6]) {
      const r = model.evaluate({ elbow: [angle] }, null, { cold: true })
      const need = r.required[unit('elbow')]!
      const flexorArm = model.momentArm(model.muscles.findIndex((m) => m.part === 'flexor'), model.dofIndex('elbow', 0))
      // 力臂与所需力矩同号的那条在用力 / the muscle whose moment arm has the sign of the required torque works
      const agonist = Math.sign(flexorArm) === Math.sign(need) ? 'flexor' : 'extensor'
      const antagonist = agonist === 'flexor' ? 'extensor' : 'flexor'
      expect(act(r, agonist)).toBeGreaterThan(0.01)
      expect(act(r, antagonist)).toBe(0)
      expect(r.status[unit('elbow')]).toBe(DofStatus.Active)
      expect(Math.abs(r.residual[unit('elbow')]!)).toBeLessThan(0.02 * Math.abs(need))
    }
  })

  it('more load means more activation, and gravity along another axis changes the answer', () => {
    const a = act(model.evaluate({ elbow: [half] }, null, { cold: true }), 'flexor') + act(model.evaluate({ elbow: [half] }, null, { cold: true }), 'extensor')
    const r2 = model.evaluate({ elbow: [half] }, null, { cold: true, load: { kg: 2, side: 'L' } })
    expect(act(r2, 'flexor') + act(r2, 'extensor')).toBeGreaterThan(2 * a)
    // 卧位、没有摆动过的肢体由床面托住 / lying, an unmoved limb rests on the couch
    const rest = model.evaluate({}, null, { cold: true, gravity: 'supine' })
    expect(rest.status[unit('elbow')]).toBe(DofStatus.Supported)
    expect(rest.activation.every((v) => v === 0)).toBe(true)
    const lifted = model.evaluate({ shoulder: [0.5] }, null, { cold: true, gravity: 'supine' })
    expect(lifted.status[unit('shoulder')]).toBe(DofStatus.Active)
    expect(lifted.status[unit('elbow')]).toBe(DofStatus.Active)
  })

  it('moment arms equal −dL/dθ by finite differences on the reference posing', () => {
    const index = new Map(toyJoints.map((j, i) => [j.id, i]))
    const pose = { shoulder: [0.4], elbow: [0.9] }
    model.evaluate(pose, null, { lengthsOnly: true })
    const h = 1e-6
    toyData.muscles.forEach((m, i) => {
      const line = { part: m.part, origin: m.path[0]!, insertion: m.path[1]! }
      for (const id of ['shoulder', 'elbow']) {
        const plus = { ...pose, [id]: [pose[id as 'elbow'][0]! + h] }, minus = { ...pose, [id]: [pose[id as 'elbow'][0]! - h] }
        const fd = -(muscleLength(line, jointFrames(toyJoints, plus).xfs, index).length - muscleLength(line, jointFrames(toyJoints, minus).xfs, index).length) / (2 * h)
        expect(model.momentArm(i, model.dofIndex(id, 0))).toBeCloseTo(fd, 6)
      }
    })
  })

  it('length change is reported relative to rest', () => {
    const r = model.evaluate({ elbow: [0.6] }, null, { lengthsOnly: true })
    const i = model.muscles.findIndex((m) => m.part === 'flexor'), j = model.muscles.findIndex((m) => m.part === 'extensor')
    // 一条变短，另一条变长 / one shortens and the other lengthens
    expect(Math.sign(r.dRest[i]!)).toBe(-Math.sign(r.dRest[j]!))
    expect(r.solved).toBe(false)
  })

  it('the rig signature follows the joints and the lines', () => {
    const rig = { joints: toyJoints, muscles: [{ part: 'a', origin: { point: [0, 1.3, 0.03] as [number, number, number], joint: 'shoulder' }, insertion: { point: [0, 1.05, 0.03] as [number, number, number], joint: 'elbow' } }] }
    const s = rigSignature(rig)
    expect(rigSignature(JSON.parse(JSON.stringify(rig)) as typeof rig)).toBe(s)
    const moved = JSON.parse(JSON.stringify(rig)) as typeof rig
    moved.muscles[0]!.insertion.point[1] = 1.06
    expect(rigSignature(moved)).not.toBe(s)
    const shifted = JSON.parse(JSON.stringify(rig)) as typeof rig
    shifted.joints[2]!.center[1] = 1.11
    expect(rigSignature(shifted)).not.toBe(s)
  })
})

describe('display scales and URL parameters', () => {
  it('colour level rises with activation and saturates', () => {
    expect(loadLevel(0, 0.5)).toBe(0)
    expect(loadLevel(0.05, 0.5)).toBeGreaterThan(0.2)
    expect(loadLevel(0.2, 0.5)).toBeGreaterThan(loadLevel(0.05, 0.5))
    expect(loadLevel(0.9, 0.5)).toBe(1)
    expect(bulgeAmount(1, 0.5, 0.1)).toBeCloseTo(0.1, 9)
    expect(lengthLevel(-0.1)).toBeLessThan(0)
    expect(lengthLevel(0.5)).toBe(1)
    // 色带：不用力是灰的，满激活更亮；缩短偏红，拉长偏蓝
    // ramps: idle is grey, full activation brighter; shortened is redder, lengthened bluer
    const idle = rampColor(LOAD_RAMP, 0), full = rampColor(LOAD_RAMP, 1)
    expect(full[0] + full[1]).toBeGreaterThan(idle[0] + idle[1])
    const short = rampColor(LENGTH_RAMP, -1), long = rampColor(LENGTH_RAMP, 1)
    expect(short[0]).toBeGreaterThan(short[2])
    expect(long[2]).toBeGreaterThan(long[0])
  })

  it('the bulge profile keeps volume to first order', () => {
    // s(τ) = 1 + b·5u(u − 0.8)，u = 4τ(1−τ)：∫₀¹ 5u(u − 0.8) dτ = 0，中点为 1
    let sum = 0
    const n = 20000
    for (let k = 0; k < n; k++) {
      const tau = (k + 0.5) / n, u = 4 * tau * (1 - tau)
      sum += 5 * u * (u - 0.8)
    }
    expect(Math.abs(sum / n)).toBeLessThan(1e-6)
    expect(5 * 1 * (1 - 0.8)).toBeCloseTo(1, 12)
  })

  it('parses act, load and grav', () => {
    expect(parseActivityParams('?act=load&load=2L&grav=supine')).toEqual({ mode: 'load', gravity: 'supine', load: { kg: 2, side: 'L' } })
    expect(parseActivityParams('?act=len')).toEqual({ mode: 'len', gravity: 'stand', load: null })
    expect(parseActivityParams('?act=nonsense&load=abc&grav=up')).toEqual({ mode: 'off', gravity: 'stand', load: null })
    expect(parseLoad('5')).toEqual({ kg: 5, side: 'B' })
    expect(formatLoad({ kg: 2, side: 'B' })).toBe('2')
    expect(formatLoad({ kg: 2.5, side: 'R' })).toBe('2.5R')
    expect(formatLoad(null)).toBeNull()
  })
})
