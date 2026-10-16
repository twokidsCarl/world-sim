// 肌肉活动在两副真实人体上：数据没有过期、力臂与有限差分一致、有已知答案的姿势（只判名次和符号）、力矩与独立估计的对照。
// Muscle activity on the two real bodies: the data is current, moment arms agree with finite differences, the
// poses with known answers (ranks and signs only), and torques against independent estimates.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DofStatus } from '../src/activity/model.ts'
import { activityStale } from '../tools/activity/build.ts'
import { SANITY_CASES, squatPose } from '../tools/activity/cases.ts'
import { loadModel, runCase } from '../tools/activity/validate.ts'
import { xfApply, type V3 } from '../tools/rig/math.ts'
import { jointFrames, type Pose } from '../tools/rig/pose.ts'
import { standardPostures } from '../tools/rig/postures.ts'

const ROOT = join(import.meta.dirname, '..')
const deleva = JSON.parse(readFileSync(join(ROOT, 'data/curated/activity/segments-deleva.json'), 'utf8')) as Record<string, Record<string, { mass: number; cm: number }>>

/**
 * 已知不通过的检验，写明原因。这里列出的检验必须按所写的方式失败：模型改好之后这条测试会报错，提醒把它从清单里拿掉。
 * Sanity cases known to fail, with the reason. A case listed here must fail in the way stated: once the model is
 * fixed this test breaks, as a reminder to take the entry off the list.
 */
const EXPECTED_FAILURES: Record<string, { muscle: RegExp; reason: string; bodies: string[] }> = {
  abduction90: {
    muscle: /supraspinatus/i,
    // 男性的冈上肌在 2026-10 的肩部皮肤权重改动之后刚好过 0.5% 的门槛（皮肤的权重决定节段质量的切分），这里不再算作已知不通过，按普通的条件检验
    // the male's supraspinatus just clears the 0.5 % threshold after the shoulder skin-weight change of 2026-10 (skin weights decide how segment
    // masses are cut), so for him it is no longer a known failure and is checked by the ordinary conditions
    bodies: ['female'],
    reason:
      'supraspinatus stays silent at 90° of abduction: its line of action is a straight line from the supraspinous fossa to the greater tubercle, which at 90° passes over the joint centre with almost no abduction moment arm (the real tendon wraps over the humeral head). The deltoid, which the model does load, carries the torque alone. The muscle is flagged `wrap` in activity.json.',
  },
}

for (const bodyId of ['male', 'female'] as const) {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  describe.skipIf(!existsSync(join(dir, 'activity.json')))(`muscle activity: ${bodyId}`, () => {
    const { data, model, rig } = loadModel(bodyId)
    const index = new Map(rig.joints.map((j, i) => [j.id, i]))

    it('activity.json is current for the rig and geometry on disk', () => {
      expect(activityStale(dir)).toEqual([])
    })

    it('data is complete and every assumption is visible', () => {
      expect(data.muscles.length).toBeGreaterThan(300)
      expect(data.mass.segments.reduce((s, x) => s + x.kg, 0)).toBeCloseTo(data.mass.bodyKg, 1)
      // 由几何和密度直接算出的体重与 BMI × 身高² 相差不到 10% / mass from geometry and densities within 10 % of BMI × stature²
      expect(Math.abs(data.mass.computedKg / data.mass.bodyKg - 1)).toBeLessThan(0.1)
      for (const m of data.muscles) {
        expect(m.fibreM).toBeGreaterThan(0)
        expect(m.fibreBasis.length).toBeGreaterThan(0)
        // 用默认比例的肌肉必须带 fibre 标记 / a muscle on the default ratio must carry the fibre flag
        expect(m.flags.includes('fibre')).toBe(m.fibreBasis.startsWith('assumption'))
        if (m.flags.length) expect(m.why?.length ?? 0).toBeGreaterThan(0)
      }
      expect(data.contacts.filter((c) => c.kind === 'heel')).toHaveLength(2)
      expect(data.sources.every((s) => s.name && s.url && s.licence && s.opened)).toBe(true)
    })

    it('moment arms equal −dL/dθ by finite differences on the reference posing, driven patella included', () => {
      const pose: Pose = { ...squatPose(rig.joints, 50, 8, 20), ...standardPostures(rig.joints).find((p) => p.id === 'elbow90')!.pose }
      model.evaluate(pose, null, { lengthsOnly: true })
      const length = (p: Pose, path: { point: number[]; joint: string }[]): number => {
        const xfs = jointFrames(rig.joints, p).xfs
        let L = 0, prev: V3 | null = null
        for (const q of path) {
          const w = xfApply(xfs[index.get(q.joint)!]!, q.point as V3)
          if (prev) L += Math.hypot(w[0] - prev[0], w[1] - prev[1], w[2] - prev[2])
          prev = w
        }
        return L
      }
      const h = 1e-5
      let checked = 0
      for (const [name, joint, k] of [['vastus lateralis', 'knee_L', 0], ['rectus femoris', 'knee_L', 0], ['rectus femoris', 'hip_L', 0], ['biceps femoris', 'knee_L', 0], ['brachialis', 'elbow_L', 0], ['long head of left biceps brachii', 'gh_L', 0], ['tibialis anterior', 'ankle_L', 0], ['soleus', 'ankle_L', 0], ['iliacus', 'hip_L', 1]] as const) {
        const i = model.muscles.findIndex((m) => new RegExp(name, 'i').test(m.name) && /left/i.test(m.name))
        if (i < 0) continue
        const path = data.muscles.find((m) => m.part === model.muscles[i]!.part)!.path
        const bump = (s: number): Pose => ({ ...pose, [joint]: rig.joints[index.get(joint)!]!.dofs.map((_, q) => (pose[joint]?.[q] ?? 0) + (q === k ? s : 0)) })
        const fd = -(length(bump(h), path) - length(bump(-h), path)) / (2 * h)
        expect(model.momentArm(i, model.dofIndex(joint, k)), `${name} at ${joint}.${k}`).toBeCloseTo(fd, 5)
        checked++
      }
      expect(checked).toBeGreaterThanOrEqual(7)
    })

    it('the quadriceps extend the knee with an arm of a few centimetres', () => {
      model.evaluate(squatPose(rig.joints), null, { lengthsOnly: true })
      for (const name of ['vastus lateralis', 'vastus medialis', 'vastus intermedius', 'rectus femoris']) {
        const i = model.muscles.findIndex((m) => new RegExp(name, 'i').test(m.name) && /left/i.test(m.name))
        const arm = model.momentArm(i, model.dofIndex('knee_L', 0))
        // 膝的正方向是屈：伸膝肌的力臂为负；参照模型约 32–37 mm / knee positive = flexion, so an extensor's arm is negative; the reference models give about 32–37 mm
        expect(arm, name).toBeLessThan(-0.015)
        expect(arm, name).toBeGreaterThan(-0.05)
      }
    })

    for (const c of SANITY_CASES) {
      const known = EXPECTED_FAILURES[c.id]?.bodies.includes(bodyId) ? EXPECTED_FAILURES[c.id] : undefined
      it(`${known ? 'EXPECTED FAILURE — ' : ''}${c.id}: ${c.name.en}`, () => {
        const o = runCase(c, bodyId, model, data)
        // 力矩的符号在任何情况下都必须对 / the sign of the required torque must be right in any case
        for (const t of o.torques) expect(Math.sign(t.requiredNm), `${t.dof}`).toBe(t.expectedSign)
        if (!known) {
          expect(o.failures, JSON.stringify(o.active)).toEqual([])
          return
        }
        // 已知不通过：失败的只能是清单里写的那条肌肉，其余的仍要成立
        // known failure: only the muscle named in the list may fail; everything else must still hold
        expect(o.failures.length, known.reason).toBeGreaterThan(0)
        for (const f of o.failures) expect(f, known.reason).toMatch(known.muscle)
        expect(o.active.some((a) => !known.muscle.test(a.muscle) && a.activationPct > 0.5)).toBe(true)
      })
    }

    it('holding 2 kg raises the elbow flexors; overhead the triceps takes over from them', () => {
      const elbow = SANITY_CASES.find((c) => c.id === 'elbow90')!, loaded = SANITY_CASES.find((c) => c.id === 'elbow90load')!, over = SANITY_CASES.find((c) => c.id === 'overhead')!
      const sum = (r: { activation: Float32Array }, re: RegExp): number => model.muscles.reduce((s, m, i) => s + (re.test(m.name) && /left/i.test(m.name) ? r.activation[i]! : 0), 0)
      const flexors = /biceps brachii|brachialis|brachioradialis/i, triceps = /triceps brachii/i
      const a = sum(model.evaluate(elbow.pose(rig.joints), null, { cold: true }), flexors)
      const r2 = model.evaluate(loaded.pose(rig.joints), null, { cold: true, load: loaded.load })
      expect(sum(r2, flexors)).toBeGreaterThan(1.5 * a)
      expect(sum(r2, triceps)).toBeLessThan(0.01)
      const r3 = model.evaluate(over.pose(rig.joints), null, { cold: true })
      expect(sum(r3, triceps)).toBeGreaterThan(sum(r3, flexors))
    })

    it('elbow torque for the horizontal forearm is near m·g·d from published segment parameters', () => {
      // 独立估计：de Leva 1996 的前臂和手的质量比例、质心位置，配我们的关节间距和体重
      // independent estimate: de Leva's 1996 mass fractions and centre-of-mass positions of forearm and hand, with our joint distances and body mass
      const c = (id: string): V3 => rig.joints[index.get(id)!]!.center as V3
      const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      const forearm = dist(c('elbow_L'), c('wrist_L')), hand = dist(c('wrist_L'), c('mcp3_L'))
      const ref = deleva[bodyId]!
      const expected = data.mass.bodyKg * 9.81 * (ref.forearm!.mass * ref.forearm!.cm * forearm + ref.hand!.mass * (forearm + ref.hand!.cm * hand))
      const r = model.evaluate(SANITY_CASES.find((x) => x.id === 'elbow90')!.pose(rig.joints), null, { cold: true })
      const ours = r.required[model.unitIndex('elbow_L', 0)]!
      // 容差 40%：我们的前臂和手比 de Leva 的平均值轻（见 activity.report.json 的 mass.regions）
      // tolerance 40 %: our forearm and hand are lighter than de Leva's averages (see mass.regions in activity.report.json)
      expect(ours / expected).toBeGreaterThan(0.6)
      expect(ours / expected).toBeLessThan(1.4)
    })

    it('standing: weight is on both feet, the knee extensor moment of the shallow squat is of the published order', () => {
      const r = model.evaluate(squatPose(rig.joints), null, { cold: true })
      expect(r.balance?.feet).toEqual(['L', 'R'])
      expect(r.balance!.offsetM).toBeLessThan(0.02)
      expect(r.balance!.weightN).toBeCloseTo(data.mass.bodyKg * 9.81, 0)
      // 以"体重 × 身高"的百分数计：公开的徒手深蹲峰值约 5.7 ± 1.9 %BW·Ht（Alterations in three-dimensional knee kinematics
      // and kinetics during neutral, squeeze and outward squat, J Hum Kinet 2013, PMC3916928, 表 2）。我们的是屈膝 60°、
      // 躯干前倾的浅蹲，应当低于那个峰值但在同一量级。
      // In per cent of body weight × height: a published peak for unloaded squats is about 5.7 ± 1.9 %BW·Ht (PMC3916928,
      // Table 2). Ours is a shallow squat at 60° with the trunk leaning forward: below that peak, of the same order.
      const knee = Math.abs(r.required[model.unitIndex('knee_L', 0)]!)
      const pctBwHt = (100 * knee) / (data.mass.bodyKg * 9.81 * data.mass.statureM)
      expect(pctBwHt).toBeGreaterThan(1)
      expect(pctBwHt).toBeLessThan(5.7)
      expect(r.status[model.unitIndex('knee_L', 0)]).toBe(DofStatus.Active)
    })

    it('one evaluation with a warm start gives the cold result', () => {
      const pose = SANITY_CASES.find((x) => x.id === 'squat')!.pose(rig.joints)
      const cold = Float32Array.from(model.evaluate(pose, null, { cold: true }).activation)
      model.evaluate(SANITY_CASES.find((x) => x.id === 'abduction90')!.pose(rig.joints), null, {})
      const warm = model.evaluate(pose, null, {}).activation
      for (let i = 0; i < cold.length; i++) expect(Math.abs(warm[i]! - cold[i]!)).toBeLessThan(1e-4)
    })
  })
}
