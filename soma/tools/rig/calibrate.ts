// 肌肉体积修正的标定：作用线变长时，蒙皮后的网格体积到底变了多少？
// Calibration of the muscle volume correction: when the line of action changes length, by how much
// does the volume of the skinned mesh actually change?
//
// 契约里的修正假设“体积 ∝ 作用线长度”，于是把横截面缩放 sqrt(L0 / L)。这只对两端各跟一块骨、
// 中间被均匀拉伸的肌肉成立；贴着一块骨走、只在跨关节处变形的肌肉（股四头肌、三头肌……）蒙皮
// 后体积几乎不变，再修正反而出错。这里对每条作用线摆几个探测姿势，拟合
//     ln(V / V0) ≈ gain · ln(L / L0)
// 把 gain 写进 MuscleLine（提议的扩展字段），运行时把横截面缩放 (L0 / L)^(gain / 2)。
// gain 接近 0 的作用线对体积不起作用，但仍然保留（gain 写成 0）：它记录了肌–腱单位的起止点和长度，
// 肌腹网格自己不跨关节的肌肉（比目鱼肌经跟腱止于跟骨）只有靠它才量得出长度变化。只有探测姿势下长度根本不变的作用线才去掉。
// The contract's correction assumes volume ∝ line length and scales the cross-section by
// sqrt(L0 / L). That holds only for a muscle that follows one bone at each end and is stretched
// evenly in between; a muscle lying along one bone and deforming only where it crosses a joint
// (quadriceps, triceps …) keeps its volume under skinning, and correcting it does harm. For every
// line a few probe poses are set and ln(V / V0) ≈ gain · ln(L / L0) is fitted; `gain` is written
// into the MuscleLine (a proposed extension field) and the runtime scales the cross-section by
// (L0 / L)^(gain / 2). A line whose gain is near zero does nothing to the volume but is kept, with gain 0:
// it records the ends and the length of the muscle–tendon unit, and for a muscle whose belly mesh does
// not itself cross the joint (soleus, inserting through the calcaneal tendon) it is the only thing the
// length change can be read from. Only lines whose length does not change in any probe pose are dropped.

import type { Joint, Rig } from '../../src/anatomy/types.ts'
import { meshVolume } from './geom.ts'
import type { Body } from './io.ts'
import { type MuscleLineExt, type Pose, Poser, muscleLength, straightLine } from './pose.ts'

export interface Calibration {
  part: string
  gain: number
  /** 探测姿势数与拟合后的体积误差均方根（%）；修正前的误差。 Probe poses, RMS volume error after the fit (%), and before any correction. */
  probes: number
  rmsAfterPct: number
  rmsBeforePct: number
  kept: boolean
}

export function calibrateMuscles(rig: Rig, bin: Uint8Array, body: Body): Calibration[] {
  const index = new Map(rig.joints.map((j, i) => [j.id, i]))
  const chain = (id: string): string[] => {
    const out: string[] = []
    for (let j: Joint | undefined = rig.joints[index.get(id)!]; j; j = j.parent === null ? undefined : rig.joints[index.get(j.parent)!]) out.push(j.id)
    return out
  }
  const out: Calibration[] = []
  const kept: MuscleLineExt[] = []
  for (const line of rig.muscles as MuscleLineExt[]) {
    const mesh = body.meshes.get(line.part)
    if (!mesh) continue
    const v0 = Math.abs(meshVolume(mesh.positions, mesh.indices))
    // 起止点之间的关节链（去掉公共祖先以上的部分） / the joints between the two ends (without what lies above their common ancestor)
    const a = chain(line.origin.joint), b = chain(line.insertion.joint)
    const common = new Set(a.filter((j) => b.includes(j)))
    const path = [...a.filter((j) => !common.has(j)), ...b.filter((j) => !common.has(j))]
    const xs: number[] = [], ys: number[] = []
    for (const id of path) {
      const j = rig.joints[index.get(id)!]!
      j.dofs.forEach((d, k) => {
        for (const frac of [0.5, 1]) {
          for (const lim of [d.min, d.max]) {
            if (Math.abs(lim) < 0.05) continue
            const pose: Pose = { [id]: j.dofs.map((_, q) => (q === k ? lim * frac : 0)) }
            const poser = new Poser(rig, bin, pose)
            // 直线长度：运行时的体积修正按直线算（tools/rig/pose.ts 的 straightLine）/ straight-line length: the run-time volume correction uses the straight line (straightLine in tools/rig/pose.ts)
            const L = muscleLength(straightLine(line), poser.xfs, poser.jointIndex)
            const x = Math.log(L.length / L.rest)
            if (!(Math.abs(x) > 0.03) || !Number.isFinite(x)) continue
            const v = Math.abs(meshVolume(poser.part(line.part, mesh.positions, 'dqs', false), mesh.indices))
            if (!(v > 0) || !(v0 > 0)) continue
            xs.push(x)
            ys.push(Math.log(v / v0))
          }
        }
      })
    }
    let gain = 0
    if (xs.length >= 2) {
      let sxy = 0, sxx = 0
      for (let i = 0; i < xs.length; i++) (sxy += xs[i]! * ys[i]!), (sxx += xs[i]! * xs[i]!)
      gain = Math.min(1.25, Math.max(0, sxy / sxx))
    }
    const rms = (g: number): number => (xs.length ? 100 * Math.sqrt(xs.reduce((s, x, i) => s + (Math.exp(ys[i]! - g * x) - 1) ** 2, 0) / xs.length) : 0)
    const keep = xs.length >= 2
    // 小于 0.2 的 gain 与噪声分不开：写成 0，运行时不修正 / a gain below 0.2 cannot be told from noise: written as 0, no correction at run time
    gain = gain >= 0.2 ? Math.round(gain * 100) / 100 : 0
    out.push({ part: line.part, gain, probes: xs.length, rmsAfterPct: Math.round(rms(gain) * 10) / 10, rmsBeforePct: Math.round(rms(0) * 10) / 10, kept: keep })
    if (keep) kept.push({ ...line, gain })
  }
  rig.muscles = kept
  return out
}
