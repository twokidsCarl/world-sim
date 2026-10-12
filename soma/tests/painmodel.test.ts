// 疼痛输入模型（src/painmodel/）在两个体型的已生成数据上的检验。数据不全时跳过该体型。
// 这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。
// The pain input model (src/painmodel/) checked on the generated data of both bodies; a body
// whose data is incomplete is skipped. This is a computational model of pain physiology and
// behaviour for teaching: the simulated body has no subjective experience.

import { beforeAll, describe, expect, it } from 'vitest'
import type { BodyId } from '../src/anatomy/types.ts'
import { AUTONOMIC, NOCICEPTION, REFLEX, REGIONS, evaluateStimulus, locate, painMapWeights, prepareStimulus, stimulusDrive } from '../src/painmodel/index.ts'
import type { PainBody, Stimulus, StimulusKind } from '../src/painmodel/types.ts'
import { hasPainBody, loadPainBody } from '../tools/pain/load.ts'
import { SCENARIOS, mirrorSite, segmentTip, territoryCentre, type Site } from '../tools/pain/scenarios.ts'

const at = (site: Site, rest: Omit<Stimulus, 'site'>): Stimulus => ({ site: { position: site.position, vertex: site.vertex }, ...rest })
const vA = NOCICEPTION.fibres.Adelta.velocity.value
const vC = NOCICEPTION.fibres.C.velocity.value

describe.each(['male', 'female'] as BodyId[])('pain model on the %s body', (bodyId) => {
  const present = hasPainBody(bodyId)
  let body: PainBody
  beforeAll(async () => {
    if (present) body = await loadPainBody(bodyId)
  }, 120_000)

  it.runIf(present)('runs every reference scenario with finite outputs in range', () => {
    for (const sc of SCENARIOS) {
      const e = prepareStimulus(body, sc.build(body, 'L'))
      expect(e.trace.dermatome, `${sc.id} dermatome`).not.toBeNull()
      expect(e.trace.territory, `${sc.id} territory`).not.toBeNull()
      expect(e.horizon).toBeGreaterThan(e.stimulusEnd)
      for (let t = -1; t <= e.stimulusEnd + 20; t += 0.25) {
        const s = e.sample(t)
        expect(s.intensity, `${sc.id} t=${t}`).toBeGreaterThanOrEqual(0)
        expect(s.intensity, `${sc.id} t=${t}`).toBeLessThanOrEqual(10)
        // 两个成分之和就是强度，且不超过刺激–反应函数的值 / the components add up to the intensity, which never exceeds the drive
        expect(s.firstPain + s.secondPain).toBeCloseTo(s.intensity, 9)
        for (const v of Object.values(s.autonomic)) expect(Number.isFinite(v), `${sc.id} autonomic`).toBe(true)
      }
      const most = Math.max(e.drive, ...(sc.id === 'windup-hand' ? [e.drive + NOCICEPTION.temporal.temporalSummation.gain.hand.value] : []))
      expect(e.peak.intensity, `${sc.id} peak`).toBeLessThanOrEqual(most + 1e-9)
    }
  })

  it.runIf(present)('locates the stimulus in the expected region, segment and nerve territory', () => {
    const tip = locate(body, at(segmentTip(body, 'dip2_L'), { kind: 'pinprick', forceN: 0.1, duration: 1 }))
    expect(tip.region).toBe('fingertip')
    expect(tip.side).toBe('L')
    // 示指尖：正中神经，C6 或 C7（各家图谱不一）/ index fingertip: median nerve, C6 or C7 (maps differ)
    expect(tip.territory?.key).toBe('median')
    expect(['C6', 'C7']).toContain(tip.dermatome?.key)
    const sole = locate(body, at(territoryCentre(body, 'medialPlantar', 'R'), { kind: 'pinch', forceN: 10, duration: 1 }))
    expect(sole.region).toBe('sole')
    expect(sole.side).toBe('R')
    expect(['L4', 'L5', 'S1']).toContain(sole.dermatome?.key)
    const cheek = locate(body, at(territoryCentre(body, 'infraorbital', 'L'), { kind: 'heat', temperatureC: 45, duration: 1 }))
    expect(cheek.region).toBe('face')
    expect(cheek.dermatome?.key).toBe('V2')
    // 没给顶点时按位置找到同一个顶点 / without a vertex the same one is found from the position
    const site = territoryCentre(body, 'saphenous', 'L')
    expect(locate(body, { kind: 'pressure', forceN: 10, duration: 1, site: { position: site.position } }).vertex).toBe(site.vertex)
  })

  it.runIf(present)('respects the thresholds: nothing below, something above', () => {
    const forearm = territoryCentre(body, 'lateralAntebrachial', 'L')
    const thr = REGIONS.thresholds.heat.sites.forearm as { value: number }
    const below = prepareStimulus(body, at(forearm, { kind: 'heat', temperatureC: thr.value - 0.5, duration: 8 }))
    expect(below.drive).toBe(0)
    expect(below.peak.intensity).toBe(0)
    expect(below.reflex.withdraws).toBe(false)
    const base = below.sample(-1).autonomic
    for (const t of [0, 1, 5, 9, 30]) {
      const s = below.sample(t)
      expect(s.intensity).toBe(0)
      expect(s.reflexPose).toEqual({})
      expect(s.autonomic).toEqual(base)
    }
    expect(base.heartRate).toBe(AUTONOMIC.signs.heartRate.baseline.value)
    expect(base.systolic).toBe(AUTONOMIC.signs.systolic.baseline.value)
    const above = prepareStimulus(body, at(forearm, { kind: 'heat', temperatureC: thr.value + 0.5, duration: 8 }))
    expect(above.drive).toBeGreaterThan(0)
    expect(above.peak.intensity).toBeGreaterThan(0)
    // 针刺：阈值是 64 mN × 部位系数 / pinprick: the threshold is 64 mN × the regional multiplier
    const tip = segmentTip(body, 'dip2_L')
    const pin = NOCICEPTION.modalities.pinprick.threshold!.value * (REGIONS.thresholds.pinprick.factors.map.fingertip ?? 1)
    expect(prepareStimulus(body, at(tip, { kind: 'pinprick', forceN: (pin * 0.9) / 1000, duration: 2 })).drive).toBe(0)
    expect(prepareStimulus(body, at(tip, { kind: 'pinprick', forceN: (pin * 1.1) / 1000, duration: 2 })).drive).toBeGreaterThan(0)
    // 冷：低于阈值才痛 / cold: pain only below the threshold
    const palm = territoryCentre(body, 'median', 'L')
    const cold = (REGIONS.thresholds.cold.sites.hand as { value: number }).value
    expect(prepareStimulus(body, at(palm, { kind: 'cold', temperatureC: cold + 1, duration: 5 })).drive).toBe(0)
    expect(prepareStimulus(body, at(palm, { kind: 'cold', temperatureC: cold - 1, duration: 5 })).drive).toBeGreaterThan(0)
  })

  it.runIf(present)('is monotonic in magnitude for every kind of stimulus', () => {
    const cases: { kind: StimulusKind; site: Site; values: number[]; make: (x: number) => Omit<Stimulus, 'site'> }[] = [
      { kind: 'pinprick', site: segmentTip(body, 'dip2_L'), values: [8, 16, 32, 64, 128, 256, 512, 2000], make: (x) => ({ kind: 'pinprick', forceN: x / 1000, duration: 2 }) },
      { kind: 'pressure', site: territoryCentre(body, 'saphenous', 'L'), values: [10, 20, 40, 60, 80, 100, 150, 300], make: (x) => ({ kind: 'pressure', forceN: x, areaMm2: 100, duration: 3 }) },
      { kind: 'pinch', site: territoryCentre(body, 'medialPlantar', 'L'), values: [1, 5, 10, 15, 20, 30, 60], make: (x) => ({ kind: 'pinch', forceN: x, areaMm2: 25, duration: 1 }) },
      { kind: 'heat', site: territoryCentre(body, 'lateralAntebrachial', 'L'), values: [36, 40, 43, 45, 46, 48, 50, 55, 70], make: (x) => ({ kind: 'heat', temperatureC: x, duration: 8 }) },
      // 冷：温度越低越强，所以按降序排列 / cold: colder is stronger, so the values go down
      { kind: 'cold', site: territoryCentre(body, 'median', 'L'), values: [25, 15, 12, 10, 8, 4, 0, -10], make: (x) => ({ kind: 'cold', temperatureC: x, duration: 20 }) },
    ]
    for (const c of cases) {
      let lastDrive = -1
      let lastPeak = -1
      let lastHr = -1
      let positive = 0
      for (const x of c.values) {
        const e = prepareStimulus(body, at(c.site, c.make(x)))
        const hr = Math.max(...[2, 5, 10, 20, 30].map((t) => e.sample(t).autonomic.heartRate))
        expect(e.drive, `${c.kind} ${x} drive`).toBeGreaterThanOrEqual(lastDrive)
        expect(e.peak.intensity, `${c.kind} ${x} peak`).toBeGreaterThanOrEqual(lastPeak - 1e-9)
        expect(hr, `${c.kind} ${x} heart rate`).toBeGreaterThanOrEqual(lastHr - 1e-6)
        if (e.drive > lastDrive && lastDrive >= 0) positive++
        lastDrive = e.drive
        lastPeak = e.peak.intensity
        lastHr = hr
      }
      // 至少有两级是严格增加的；最强的一级到顶（针刺按对数增长，在这个范围内到不了顶）
      // at least two steps strictly increase; the strongest saturates (pinprick grows with the logarithm and does not within this range)
      expect(positive, c.kind).toBeGreaterThanOrEqual(2)
      if (c.kind === 'pinprick') expect(lastDrive, 'pinprick strongest').toBeLessThan(10)
      else expect(lastDrive, `${c.kind} strongest`).toBe(10)
    }
    // 同样的力，接触面积越小压强越大 / the same force on a smaller area is a larger pressure
    const shin = territoryCentre(body, 'saphenous', 'L')
    const wide = stimulusDrive({ kind: 'pressure', forceN: 60, areaMm2: 200, duration: 1, site: { position: shin.position } }, 'leg', bodyId)
    const narrow = stimulusDrive({ kind: 'pressure', forceN: 60, areaMm2: 50, duration: 1, site: { position: shin.position } }, 'leg', bodyId)
    expect(narrow.magnitude).toBeCloseTo(wide.magnitude * 4, 6)
    expect(narrow.drive).toBeGreaterThan(wide.drive)
  })

  it.runIf(present)('gives latencies consistent with distance and conduction velocity', () => {
    const sites: Record<string, Site> = {
      fingertip: segmentTip(body, 'dip2_L'),
      forearm: territoryCentre(body, 'lateralAntebrachial', 'L'),
      thigh: territoryCentre(body, 'femoralAnterior', 'L'),
      leg: territoryCentre(body, 'saphenous', 'L'),
      sole: territoryCentre(body, 'medialPlantar', 'L'),
    }
    const length: Record<string, number> = {}
    for (const [name, site] of Object.entries(sites)) {
      const e = prepareStimulus(body, at(site, { kind: 'heat', temperatureC: 49, duration: 2 }))
      const p = e.trace.path
      length[name] = p.lengthM
      expect(p.method, name).toBe('centreline')
      expect(e.trace.latency.adelta, name).toBeCloseTo(p.lengthM / vA, 12)
      expect(e.trace.latency.c, name).toBeCloseTo(p.lengthM / vC, 12)
      expect(e.trace.latency.c).toBeGreaterThan(e.trace.latency.adelta)
      // 沿神经的路径不短于直线，也不会长得离谱 / a path along nerves is no shorter than the straight line and not absurdly longer
      const straight = Math.hypot(site.position[0] - p.end[0], site.position[1] - p.end[1], site.position[2] - p.end[2])
      expect(p.lengthM, `${name} against the straight line`).toBeGreaterThanOrEqual(straight * 0.999)
      expect(p.lengthM, `${name} against the straight line`).toBeLessThan(straight * 1.8)
      expect(p.bridgedM, `${name} bridged`).toBeLessThan(p.lengthM * 0.35)
      expect(p.polyline.length / 3).toBeGreaterThan(10)
      // 折线的长度就是路径长度 / the polyline's length is the path length
      let sum = 0
      for (let i = 3; i < p.polyline.length; i += 3) sum += Math.hypot(p.polyline[i]! - p.polyline[i - 3]!, p.polyline[i + 1]! - p.polyline[i - 2]!, p.polyline[i + 2]! - p.polyline[i - 1]!)
      expect(sum, `${name} polyline`).toBeCloseTo(p.lengthM, 6)
      // 强度在第一痛的潜伏期之前为 0，之后才出现；第二痛更晚 / nothing before the first-pain latency; second pain later still
      const l = e.trace.latency
      expect(e.sample(l.firstPain - 0.005).intensity, name).toBe(0)
      expect(e.sample(l.firstPain + 0.05).firstPain, name).toBeGreaterThan(0)
      expect(e.sample(l.secondPain - 0.005).secondPain, name).toBe(0)
      expect(e.sample(l.secondPain + 0.2).secondPain, name).toBeGreaterThan(0)
    }
    // 越远越晚：指尖晚于前臂，足底晚于小腿，小腿晚于大腿 / further is later
    expect(length.fingertip!).toBeGreaterThan(length.forearm!)
    expect(length.sole!).toBeGreaterThan(length.leg!)
    expect(length.leg!).toBeGreaterThan(length.thigh!)
    // 量级：指尖到颈髓 0.6–1.1 m，足底到腰骶髓 0.9–1.5 m / order of magnitude
    expect(length.fingertip!).toBeGreaterThan(0.6)
    expect(length.fingertip!).toBeLessThan(1.1)
    expect(length.sole!).toBeGreaterThan(0.9)
    expect(length.sole!).toBeLessThan(1.5)
    // 手部第二痛的潜伏期与文献所述（1–1.5 s）同量级 / second pain from the hand is of the reported order (1-1.5 s)
    const hand = prepareStimulus(body, at(sites.fingertip!, { kind: 'heat', temperatureC: 49, duration: 2 }))
    expect(hand.trace.latency.secondPain).toBeGreaterThan(0.7)
    expect(hand.trace.latency.secondPain).toBeLessThan(1.6)
  })

  it.runIf(present)('is left-right symmetric', () => {
    const pairs: [Site, Site, Omit<Stimulus, 'site'>][] = [
      [segmentTip(body, 'dip2_L'), segmentTip(body, 'dip2_R'), { kind: 'pinprick', forceN: 0.512, duration: 2 }],
      [territoryCentre(body, 'lateralAntebrachial', 'L'), territoryCentre(body, 'lateralAntebrachial', 'R'), { kind: 'heat', temperatureC: 50, duration: 5 }],
      [territoryCentre(body, 'saphenous', 'L'), territoryCentre(body, 'saphenous', 'R'), { kind: 'pressure', forceN: 100, areaMm2: 100, duration: 3 }],
      [territoryCentre(body, 'medialPlantar', 'L'), territoryCentre(body, 'medialPlantar', 'R'), { kind: 'pinch', forceN: 25, areaMm2: 25, duration: 1 }],
    ]
    for (const [l, r, rest] of pairs) {
      const a = prepareStimulus(body, at(l, rest))
      const b = prepareStimulus(body, at(r, rest))
      expect(a.trace.side).toBe('L')
      expect(b.trace.side).toBe('R')
      expect(b.trace.region.id).toBe(a.trace.region.id)
      expect(b.trace.territory?.key).toBe(a.trace.territory?.key)
      expect(b.drive).toBe(a.drive)
      expect(b.reflex.withdraws).toBe(a.reflex.withdraws)
      // 两侧的几何不完全对称：路径长度相差不超过 15% / the two sides are not exact mirrors: lengths within 15 %
      expect(Math.abs(b.trace.path.lengthM - a.trace.path.lengthM) / a.trace.path.lengthM, `${rest.kind} path`).toBeLessThan(0.15)
      expect(b.reflex.targets.map((t) => [t.joint.replace(/_R$/, '_L'), t.dof, t.angle])).toEqual(a.reflex.targets.map((t) => [t.joint, t.dof, t.angle]))
      // 左右两侧的神经部件不同 / the nerve parts differ between the sides
      if (a.trace.highlightParts.length) expect(a.trace.highlightParts.some((p) => b.trace.highlightParts.includes(p))).toBe(false)
    }
    // 把左侧的点镜像过去，落在右侧同一部位 / a left point mirrored lands in the same region on the right
    const left = territoryCentre(body, 'femoralAnterior', 'L')
    const mirrored = prepareStimulus(body, at(mirrorSite(body, left), { kind: 'heat', temperatureC: 48, duration: 3 }))
    const original = prepareStimulus(body, at(left, { kind: 'heat', temperatureC: 48, duration: 3 }))
    expect(mirrored.trace.side).toBe('R')
    expect(mirrored.trace.region.id).toBe(original.trace.region.id)
    expect(mirrored.drive).toBe(original.drive)
  })

  it.runIf(present)('is deterministic', () => {
    for (const sc of SCENARIOS) {
      const a = prepareStimulus(body, sc.build(body, 'L'))
      const b = prepareStimulus(body, sc.build(body, 'L'))
      for (const t of [0, 0.1, 0.5, 1.3, 4, 12, 70]) expect(JSON.stringify(b.at(t)), `${sc.id} t=${t}`).toBe(JSON.stringify(a.at(t)))
      // 取值的顺序不影响结果 / the order of evaluation does not matter
      const again = [70, 4, 0.1].map((t) => JSON.stringify(a.sample(t)))
      expect(again).toEqual([70, 4, 0.1].map((t) => JSON.stringify(b.sample(t))))
    }
    const stimulus = SCENARIOS[0]!.build(body, 'L')
    expect(JSON.stringify(evaluateStimulus(body, stimulus, 2.5))).toBe(JSON.stringify(prepareStimulus(body, stimulus).at(2.5)))
  })

  it.runIf(present)('decides the withdrawal reflex and proposes a pose inside the joint ranges', () => {
    const sole = territoryCentre(body, 'medialPlantar', 'L')
    const e = prepareStimulus(body, at(sole, { kind: 'pinch', forceN: 30, areaMm2: 25, duration: 1 }))
    expect(e.reflex.withdraws).toBe(true)
    expect(e.reflex.limb).toBe('lower')
    expect(e.reflex.targets.map((t) => t.joint).sort()).toEqual(['ankle_L', 'hip_L', 'knee_L'])
    // 髋、膝屈曲，踝背屈（足底中前部）/ hip and knee flexion, ankle dorsiflexion (mid- and forefoot sole)
    for (const t of e.reflex.targets) expect(t.angle, t.joint).toBeGreaterThan(0)
    for (const t of e.reflex.targets) expect(t.movement.en, t.joint).toMatch(t.joint.startsWith('ankle') ? /^dorsiflexion/ : /^flexion/)
    // 肌电潜伏期 = Aδ 传入 + 中枢 + 传出，落在实测反射的时间窗内 / EMG latency inside the measured reflex window
    const [lo, hi] = REFLEX.reference.lower.window.value
    expect(e.reflex.emgLatency!).toBeGreaterThan(e.trace.latency.adelta)
    expect(e.reflex.emgLatency!).toBeGreaterThan(lo)
    expect(e.reflex.emgLatency!).toBeLessThan(hi)
    expect(e.reflex.movementLatency!).toBeGreaterThan(e.reflex.emgLatency!)
    // 姿势：开始移动之前没有，之后出现，最后回到原位 / pose: none before movement onset, then present, finally gone
    expect(e.sample(e.reflex.movementLatency! - 0.01).reflexPose).toEqual({})
    const mid = e.sample(e.reflex.movementLatency! + 0.6).reflexPose
    expect(Object.keys(mid).sort()).toEqual(['ankle_L', 'hip_L', 'knee_L'])
    const knee = body.joints!.find((j) => j.id === 'knee_L')!
    expect(mid.knee_L!.length).toBe(knee.dofs.length)
    expect(mid.knee_L![0]!).toBeGreaterThan(0.2)
    for (let t = 0; t < 20; t += 0.05) {
      for (const [id, angles] of Object.entries(e.sample(t).reflexPose)) {
        const joint = body.joints!.find((j) => j.id === id)!
        angles.forEach((a, k) => {
          expect(a, `${id}.${k}`).toBeGreaterThanOrEqual(joint.dofs[k]!.min - 1e-9)
          expect(a, `${id}.${k}`).toBeLessThanOrEqual(joint.dofs[k]!.max + 1e-9)
        })
      }
    }
    expect(e.sample(e.reflex.releaseAt! + 10).reflexPose).toEqual({})
    // 更强的刺激，幅度更大 / a stronger stimulus, a larger amplitude
    const weaker = prepareStimulus(body, at(sole, { kind: 'pinch', forceN: 18, areaMm2: 25, duration: 1 }))
    if (weaker.reflex.withdraws) expect(e.reflex.amplitude).toBeGreaterThan(weaker.reflex.amplitude)
    // 足跟：踝改为跖屈 / heel: the ankle plantar-flexes instead
    const heel = prepareStimulus(body, at(territoryCentre(body, 'medialCalcaneal', 'L'), { kind: 'pinch', forceN: 30, areaMm2: 25, duration: 1 }))
    expect(heel.reflex.withdraws).toBe(true)
    expect(heel.reflex.targets.find((t) => t.joint === 'ankle_L')!.angle).toBeLessThan(0)
    // 上肢：屈肘、肩后伸；右侧的刺激动右侧的关节 / upper limb: elbow flexion, shoulder extension; a right stimulus moves right joints
    const palm = prepareStimulus(body, at(territoryCentre(body, 'median', 'R'), { kind: 'heat', temperatureC: 55, duration: 2 }))
    expect(palm.reflex.withdraws).toBe(true)
    expect(palm.reflex.limb).toBe('upper')
    expect(palm.reflex.targets.find((t) => t.joint === 'elbow_R')!.angle).toBeGreaterThan(0)
    expect(palm.reflex.targets.find((t) => t.joint === 'gh_R' && /^flexion/.test(t.movement.en))!.angle).toBeLessThan(0)
    expect(palm.reflex.emgLatency!).toBeLessThan(e.reflex.emgLatency!)
    // 躯干和面部：不模拟肢体退缩 / trunk and face: no limb withdrawal is modelled
    const cheek = prepareStimulus(body, at(territoryCentre(body, 'infraorbital', 'L'), { kind: 'heat', temperatureC: 55, duration: 2 }))
    expect(cheek.drive).toBeGreaterThan(REFLEX.threshold.value)
    expect(cheek.reflex.withdraws).toBe(false)
    // 没有 rig 数据时仍然判定，但不给姿势 / without rig data the decision stands but no pose is given
    const bare = prepareStimulus({ ...body, joints: undefined }, at(sole, { kind: 'pinch', forceN: 30, areaMm2: 25, duration: 1 }))
    expect(bare.reflex.withdraws).toBe(true)
    expect(bare.reflex.targets).toEqual([])
    expect(bare.sample(1).reflexPose).toEqual({})
  })

  it.runIf(present)('adds temporal summation only at or above 0.33 Hz', () => {
    const hand = territoryCentre(body, 'superficialRadial', 'L')
    const single = prepareStimulus(body, at(hand, { kind: 'pinprick', forceN: 0.256, duration: 0.5 }))
    const fast = prepareStimulus(body, at(hand, { kind: 'pinprick', forceN: 0.256, duration: 0.5, repeat: { count: 10, hz: 1 } }))
    const slow = prepareStimulus(body, at(hand, { kind: 'pinprick', forceN: 0.256, duration: 0.5, repeat: { count: 10, hz: 0.2 } }))
    expect(fast.peak.intensity).toBeGreaterThan(single.peak.intensity + 1)
    expect(slow.peak.intensity).toBeCloseTo(single.peak.intensity, 6)
    // 增量不超过实测的时间总和 / the gain does not exceed the measured summation
    expect(fast.peak.intensity - single.peak.intensity).toBeLessThanOrEqual(NOCICEPTION.temporal.temporalSummation.gain.hand.value + 1e-9)
    // 阈下的重复刺激不会凭空产生疼痛 / repeating a sub-threshold stimulus creates nothing
    const none = prepareStimulus(body, at(hand, { kind: 'pinprick', forceN: 0.02, duration: 0.5, repeat: { count: 10, hz: 1 } }))
    expect(none.peak.intensity).toBe(0)
  })

  it.runIf(present)('moves the autonomic signs with the intensity and brings them back', () => {
    const palm = territoryCentre(body, 'median', 'L')
    const e = prepareStimulus(body, at(palm, { kind: 'cold', temperatureC: 4, duration: 60 }))
    const base = e.sample(-1).autonomic
    const during = e.sample(60).autonomic
    const after = e.sample(e.horizon).autonomic
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      expect(during[k], k).toBeGreaterThan(base[k])
      expect(Math.abs(after[k] - base[k]) / base[k], `${k} back at baseline`).toBeLessThan(0.02)
    }
    // 血压上升慢于瞳孔 / pressure rises more slowly than the pupil
    const early = e.sample(3).autonomic
    expect((early.pupil - base.pupil) / (during.pupil - base.pupil)).toBeGreaterThan((early.systolic - base.systolic) / (during.systolic - base.systolic))
    // 量级：冷加压样的刺激使收缩压升高几到三十 mmHg / order: a cold-pressor-like stimulus raises systolic pressure by a few to thirty mmHg
    expect(during.systolic - base.systolic).toBeGreaterThan(3)
    expect(during.systolic - base.systolic).toBeLessThan(30)
    expect(during.heartRate - base.heartRate).toBeLessThan(15)
  })

  it.runIf(present)('paints a skin map of the contact area with its territory and dermatome', () => {
    const forearm = territoryCentre(body, 'lateralAntebrachial', 'L')
    const e = prepareStimulus(body, at(forearm, { kind: 'heat', temperatureC: 48, areaMm2: 900, duration: 5 }))
    const map = e.map
    expect(map.vertexCount).toBe(body.skinMaps.vertexCount)
    expect(map.vertex).toBe(forearm.vertex)
    expect(map.radiusM).toBeCloseTo(Math.sqrt(900 / Math.PI) / 1000, 9)
    expect(map.focus.vertices).toContain(forearm.vertex)
    expect(map.focus.weights[map.focus.vertices.indexOf(forearm.vertex)]).toBe(1)
    const w = painMapWeights(body, map)
    expect(w.length).toBe(body.skinMaps.vertexCount)
    expect(w[forearm.vertex]).toBe(1)
    const territory = body.skinMaps.maps.find((m) => m.id === 'cutaneousNerve')!
    const dermatome = body.skinMaps.maps.find((m) => m.id === 'dermatome')!
    const p = body.skin.positions
    let inTerritory = 0
    let inDermatome = 0
    for (let i = 0; i < w.length; i++) {
      expect(w[i]!).toBeGreaterThanOrEqual(0)
      expect(w[i]!).toBeLessThanOrEqual(1)
      const left = p[i * 3]! >= 0
      if (!left) expect(w[i], 'the other side stays clear').toBe(0)
      else if (territory.data[i] === map.territory!.region) {
        expect(w[i]!).toBeGreaterThanOrEqual(0.35 - 1e-6)
        inTerritory++
      } else if (dermatome.data[i] === map.dermatome!.region) {
        if (!map.focus.vertices.includes(i)) expect(w[i]!).toBeCloseTo(0.2, 6)
        inDermatome++
      } else if (!map.focus.vertices.includes(i)) expect(w[i]).toBe(0)
    }
    expect(inTerritory).toBeGreaterThan(10)
    expect(inTerritory + inDermatome).toBeGreaterThan(map.focus.vertices.length)
  })

  it.runIf(present)('explains itself: parts to highlight, numbers with sources, and what it is not', () => {
    const ids = new Set(body.parts.map((p) => p.id))
    for (const sc of SCENARIOS) {
      const e = prepareStimulus(body, sc.build(body, 'L'))
      const tr = e.trace
      expect(tr.disclaimer.en).toMatch(/no subjective experience/)
      expect(tr.disclaimer.zh).toMatch(/没有主观体验/)
      expect(tr.steps.map((s) => s.id)).toEqual(['stimulus', 'receptor', 'site', 'nerve', 'segment', 'conduction', 'perception', 'reflex', 'autonomic'])
      expect(tr.highlightParts.length, `${sc.id} highlight`).toBeGreaterThan(0)
      for (const id of [...tr.highlightParts, ...tr.path.parts, ...tr.steps.flatMap((s) => s.parts)]) expect(ids.has(id), `${sc.id} part ${id}`).toBe(true)
      // 路径经过的部件都在高亮列表里 / every part on the path is in the highlight list
      for (const id of tr.path.parts) expect(tr.highlightParts, `${sc.id} path part`).toContain(id)
      // 前根是运动根，不在感觉通路里 / the anterior root is motor and not on the sensory pathway
      for (const r of tr.roots) expect(r.name).not.toMatch(/anterior root/i)
      const known = new Set(tr.sources.map((s) => s.id))
      for (const step of tr.steps) {
        expect(step.text.zh.length).toBeGreaterThan(0)
        expect(step.text.en.length).toBeGreaterThan(0)
        for (const n of step.numbers) {
          // 每个数：有出处、或是假设、或由模型算出 / every number: sourced, an assumption, or computed by the model
          const kinds = [n.sources.length > 0, n.assumption, n.computed === true].filter(Boolean).length
          expect(kinds, `${sc.id} ${step.id} ${n.label.en}`).toBe(1)
          for (const s of n.sources) expect(known.has(s), `${sc.id} source ${s}`).toBe(true)
          if (n.assumption) expect(n.note?.en.length ?? 0, `${sc.id} ${n.label.en} needs its reason`).toBeGreaterThan(0)
        }
      }
      expect(tr.segments.length).toBeGreaterThan(0)
      expect(e.output.level).toBeCloseTo(e.peak.intensity, 1)
    }
  })

  it.runIf(present)('rejects incomplete stimuli and mismatched body data', () => {
    const site = territoryCentre(body, 'saphenous', 'L')
    expect(() => prepareStimulus(body, at(site, { kind: 'heat', duration: 1 }))).toThrow(/temperatureC/)
    expect(() => prepareStimulus(body, at(site, { kind: 'pressure', duration: 1 }))).toThrow(/forceN/)
    expect(() => prepareStimulus(body, at(site, { kind: 'pressure', forceN: 10, areaMm2: 0, duration: 1 }))).toThrow()
    // 皮肤被别的工具重建后顶点数变了：要报错而不是悄悄用错的顶点
    // a skin rebuilt by another tool has a different vertex count: fail loudly rather than use wrong vertices
    const stale: PainBody = { ...body, skin: { part: body.skin.part, positions: new Float32Array(30) } }
    expect(() => prepareStimulus(stale, at(site, { kind: 'heat', temperatureC: 48, duration: 1 }))).toThrow(/顶点数|vertex count/)
  })
})
