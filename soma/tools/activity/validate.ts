// 第二层的检验：在有已知答案的姿势上运行模型，打印每个姿势的数字，并写 data/curated/activity/validation.json。
//   bun tools/activity/validate.ts            （两副人体；加 --quiet 只写文件）
// Validation of layer 2: run the model on the poses with known answers, print the numbers of every case and
// write data/curated/activity/validation.json.
//   bun tools/activity/validate.ts            (both bodies; --quiet only writes the file)

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Rig } from '../../src/anatomy/types.ts'
import { ActivityModel, DofStatus, FLAG_FLIP, FLAG_NEAR } from '../../src/activity/model.ts'
import type { ActivityData } from '../../src/activity/types.ts'
import { SANITY_CASES, type SanityCase } from './cases.ts'

// import.meta.dir 只有 Bun 有；测试在 Node 下跑 / import.meta.dir exists in Bun only; the tests run under Node
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const r1 = (v: number): number => Math.round(v * 10) / 10
const r2 = (v: number): number => Math.round(v * 100) / 100

export function loadModel(bodyId: string): { rig: Rig; data: ActivityData; model: ActivityModel } {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const data = JSON.parse(readFileSync(join(dir, 'activity.json'), 'utf8')) as ActivityData
  return { rig, data, model: new ActivityModel(rig, data) }
}

export function unitLabel(model: ActivityModel, u: number): string {
  const unit = model.units[u]!
  const d = model.dofs[unit.dofs[0]!]!
  return unit.group ? `${unit.group.id}.axis${model.joints[d.joint]!.dofs[d.k]!.axis}` : `${model.joints[d.joint]!.id}.${d.k}`
}

export interface CaseOutcome {
  id: string
  body: string
  /** 应当用力的各组里激活度最高的那条及其名次 / For every expected-active group, its most active muscle and that muscle's rank. */
  active: { pattern: string; muscle: string; activationPct: number; rank: number; unreliable: boolean }[]
  silent: { pattern: string; muscle: string; activationPct: number }[]
  torques: { dof: string; requiredNm: number; deliveredNm: number; residualNm: number; expectedSign: number }[]
  top: { muscle: string; activationPct: number; flags: string }[]
  /** 残差最大的自由度 / The dofs with the largest residual. */
  worst: { dof: string; requiredNm: number; residualNm: number; noMuscle: boolean }[]
  balance: { feet: string; offsetCm: number } | null
  residualPct: number
  pass: boolean
  failures: string[]
}

/** 一个检验姿势的结果：名次和符号（不是数值大小）决定通过与否 / Outcome of one sanity case: ranks and signs (not magnitudes) decide a pass. */
export function runCase(c: SanityCase, bodyId: string, model: ActivityModel, data: ActivityData): CaseOutcome {
  const pose = c.pose(model.joints)
  const res = model.evaluate(pose, null, { gravity: c.gravity, load: c.load ?? null, cold: true })
  const left = (i: number): boolean => !/\bright\b/i.test(model.muscles[i]!.name)
  const order = [...res.activation.keys()].filter(left).sort((a, b) => res.activation[b]! - res.activation[a]!)
  const rankOf = new Map(order.map((i, k) => [i, k + 1]))
  const flagText = (i: number): string => [...(data.muscles.find((m) => m.part === model.muscles[i]!.part)?.flags ?? []), ...(res.flags[i]! & FLAG_NEAR ? ['near'] : []), ...(res.flags[i]! & FLAG_FLIP ? ['flip'] : [])].join(',')
  const failures: string[] = []
  const pick = (pattern: string): number[] => order.filter((i) => new RegExp(pattern, 'i').test(model.muscles[i]!.name))
  const silentMax = Math.max(0, ...c.silent.flatMap((p) => pick(p).map((i) => res.activation[i]!)))
  const active = c.active.map((pattern) => {
    const i = pick(pattern)[0]
    if (i === undefined) {
      failures.push(`no muscle matches /${pattern}/`)
      return { pattern, muscle: '—', activationPct: 0, rank: 0, unreliable: true }
    }
    const a = res.activation[i]!
    // 通过的条件：在用力（> 0.5%），且高于所有"应当安静"的肌肉 / pass: active (> 0.5 %) and above every muscle expected to be silent
    if (!(a > 0.005)) failures.push(`${model.muscles[i]!.name} is not active (${r1(a * 100)} %)`)
    else if (!(a > silentMax)) failures.push(`${model.muscles[i]!.name} (${r1(a * 100)} %) is not above the muscles expected to be silent (${r1(silentMax * 100)} %)`)
    return { pattern, muscle: model.muscles[i]!.name, activationPct: r1(a * 100), rank: rankOf.get(i)!, unreliable: flagText(i).length > 0 }
  })
  const silent = c.silent.map((pattern) => {
    const i = pick(pattern)[0]
    if (i === undefined) return { pattern, muscle: '—', activationPct: 0 }
    return { pattern, muscle: model.muscles[i]!.name, activationPct: r1(res.activation[i]! * 100) }
  })
  const torques = Object.entries(c.torque ?? {}).map(([key, sign]) => {
    const [joint, k] = key.split('.')
    const d = model.unitIndex(joint!, Number(k))
    const req = d >= 0 ? res.required[d]! : 0
    if (d < 0) failures.push(`no dof ${key}`)
    else if (Math.sign(req) !== sign) failures.push(`required torque at ${key} is ${r2(req)} N·m, expected sign ${sign > 0 ? '+' : '−'}`)
    else if (res.status[d] !== DofStatus.Active) failures.push(`${key} is not balanced by muscles (status ${res.status[d]})`)
    return { dof: key, requiredNm: r2(req), deliveredNm: r2(d >= 0 ? res.delivered[d]! : 0), residualNm: r2(d >= 0 ? res.residual[d]! : 0), expectedSign: sign }
  })
  return {
    id: c.id,
    body: bodyId,
    active,
    silent,
    torques,
    top: order.slice(0, 8).map((i) => ({ muscle: model.muscles[i]!.name, activationPct: r1(res.activation[i]! * 100), flags: flagText(i) })),
    worst: [...res.residual.keys()]
      .filter((d) => Math.abs(res.residual[d]!) > 0.05)
      .sort((a, b) => Math.abs(res.residual[b]!) - Math.abs(res.residual[a]!))
      .slice(0, 6)
      .map((d) => ({ dof: unitLabel(model, d), requiredNm: r2(res.required[d]!), residualNm: r2(res.residual[d]!), noMuscle: res.status[d] === DofStatus.NoMuscle })),
    balance: res.balance ? { feet: res.balance.feet.join('+'), offsetCm: r1(res.balance.offsetM * 100) } : null,
    residualPct: res.requiredSum > 0 ? r1((100 * res.residualSum) / res.requiredSum) : 0,
    pass: failures.length === 0,
    failures,
  }
}

if (import.meta.main) {
  const quiet = process.argv.includes('--quiet')
  const outcomes: CaseOutcome[] = []
  const timing: Record<string, unknown> = {}
  const torqueChecks: Record<string, unknown>[] = []
  const deleva = JSON.parse(readFileSync(join(ROOT, 'data/curated/activity/segments-deleva.json'), 'utf8')) as Record<string, Record<string, { mass: number; cm: number }>>
  for (const bodyId of ['male', 'female']) {
    const { data, model } = loadModel(bodyId)
    for (const c of SANITY_CASES) {
      const o = runCase(c, bodyId, model, data)
      outcomes.push(o)
      if (quiet) continue
      console.log(`\n── ${bodyId} · ${c.id} · ${c.name.en} ── ${o.pass ? 'PASS' : 'FAIL'}${o.balance ? ` · feet ${o.balance.feet}, COM ${o.balance.offsetCm} cm outside support` : ''} · residual ${o.residualPct} % of required`)
      for (const f of o.failures) console.log(`   ✗ ${f}`)
      console.log('   torque  ' + o.torques.map((t) => `${t.dof}: required ${t.requiredNm} N·m, delivered ${t.deliveredNm}, residual ${t.residualNm}`).join('; '))
      console.log('   active  ' + o.active.map((a) => `${a.muscle} ${a.activationPct}% (#${a.rank}${a.unreliable ? ' ⚠' : ''})`).join('; '))
      console.log('   silent  ' + o.silent.map((a) => `${a.muscle} ${a.activationPct}%`).join('; '))
      console.log('   worst   ' + o.worst.map((w) => `${w.dof}: ${w.residualNm} of ${w.requiredNm}${w.noMuscle ? ' (no muscle)' : ''}`).join('; '))
      console.log('   top     ' + o.top.map((a) => `${a.muscle} ${a.activationPct}%${a.flags ? ` [${a.flags}]` : ''}`).join('; '))
    }
    // 力矩对照 / torque checks
    {
      const c = (id: string): number[] => model.joints[model.jointIndex.get(id)!]!.center
      const dist = (p: number[], q: number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
      const forearm = dist(c('elbow_L'), c('wrist_L')), hand = dist(c('wrist_L'), c('mcp3_L'))
      const ref = deleva[bodyId]!
      const expected = data.mass.bodyKg * 9.81 * (ref.forearm!.mass * ref.forearm!.cm * forearm + ref.hand!.mass * (forearm + ref.hand!.cm * hand))
      const elbow = model.evaluate(SANITY_CASES.find((x) => x.id === 'elbow90')!.pose(model.joints), null, { cold: true }).required[model.unitIndex('elbow_L', 0)]!
      torqueChecks.push({ body: bodyId, check: 'elbow torque, forearm horizontal', oursNm: r2(elbow), referenceNm: r2(expected), ratio: r2(elbow / expected), reference: 'm·g·d with de Leva 1996 forearm and hand mass fractions and centre-of-mass positions (as tabulated in BMClab/BMC, CC BY 4.0), our joint distances and body mass' })
      const sq = model.evaluate(SANITY_CASES.find((x) => x.id === 'squat')!.pose(model.joints), null, { cold: true })
      const knee = Math.abs(sq.required[model.unitIndex('knee_L', 0)]!), hip = Math.abs(sq.required[model.unitIndex('hip_L', 0)]!)
      torqueChecks.push({ body: bodyId, check: 'knee extensor moment, shallow squat (knee 60°, trunk leaning 45°)', oursNm: r2(knee), oursNmPerKg: r2(knee / data.mass.bodyKg), oursPctBwHt: r2((100 * knee) / (data.mass.bodyKg * 9.81 * data.mass.statureM)), hipExtensorNm: r2(hip), referencePctBwHt: '5.7 ± 1.92 (peak knee flexion moment of an unloaded neutral squat)', reference: 'Alterations in Three-dimensional Knee Kinematics and Kinetics during Neutral, Squeeze and Outward Squat, J Hum Kinet 2013, https://europepmc.org/article/PMC/PMC3916928 (CC BY 3.0), Table 2; opened 2026-10-13', note: 'not like for like: the published figure is the peak over a full squat, ours a static shallow squat with the trunk leaning forward (load shifted to the hips); expected below the peak and of the same order' })
    }
    // 用时：冷启动，以及像拖动滑块那样的小步热启动 / timing: cold, and warm in small steps as when a slider is dragged
    const squat = SANITY_CASES.find((c) => c.id === 'squat')!
    const elbow = SANITY_CASES.find((c) => c.id === 'elbow90')!
    const cold: number[] = [], warm: number[] = []
    for (let k = 0; k < 30; k++) cold.push(model.evaluate(squat.pose(model.joints), null, { cold: true }).ms)
    const base = elbow.pose(model.joints)
    for (let k = 0; k < 200; k++) {
      const pose = { ...base, elbow_L: [(base.elbow_L?.[0] ?? 0) * (0.2 + 0.004 * k)] }
      const r = model.evaluate(pose, null, {})
      warm.push(r.ms)
    }
    const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
    const p95 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]!
    timing[bodyId] = { coldMedianMs: r2(med(cold)), coldP95Ms: r2(p95(cold)), warmMedianMs: r2(med(warm)), warmP95Ms: r2(p95(warm)), muscles: model.muscles.length, dofs: model.dofs.length }
    if (!quiet) console.log(`\n${bodyId} timing`, timing[bodyId], torqueChecks.filter((t) => t.body === bodyId))
  }
  const passed = outcomes.filter((o) => o.pass).length
  console.log(`\n${passed} / ${outcomes.length} cases pass`)
  writeFileSync(
    join(ROOT, 'data/curated/activity/validation.json'),
    JSON.stringify(
      {
        _doc: {
          zh: '第二层（负荷估计）在有已知答案的姿势上的结果，由 tools/activity/validate.ts 生成。判定只看名次和符号：应当用力的肌肉激活度 > 0.5% 且高于应当安静的肌肉，要求力矩的符号正确。激活度的数值本身不可信（见 params.json 里的假设）。',
          en: 'Results of layer 2 (the load estimate) on the poses with known answers, written by tools/activity/validate.ts. Only ranks and signs are judged: muscles expected to work are above 0.5 % and above those expected to stay silent, and the required torque has the right sign. The activation numbers themselves are not to be trusted (see the assumptions in params.json).',
        },
        cases: SANITY_CASES.map((c) => ({ id: c.id, name: c.name, gravity: c.gravity, load: c.load ?? null, basis: c.basis })),
        outcomes,
        torqueChecks,
        emgRanks: { compared: false, why: 'no open source with published EMG ranks for these static postures was opened; the expectations of the cases are textbook functional anatomy' },
        timing,
      },
      null,
      1,
    ),
  )
}
