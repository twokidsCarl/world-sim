// 校验体型控制的数据（public/anatomy/<body>/shape.json、shape.bin）与 CPU 参考实现（tools/rig/shape.ts）。
// 尚未生成时跳过：请先运行 `bun tools/rig/run.ts male` 再运行 `bun tools/rig/shape-build.ts male`。
// Validates the body-shape data (public/anatomy/<body>/shape.json, shape.bin) and the CPU reference
// (tools/rig/shape.ts). Skipped when not built: run `bun tools/rig/run.ts male`, then
// `bun tools/rig/shape-build.ts male`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rig } from '../src/anatomy/types.ts'
import type { ShapeData } from '../src/shape/types.ts'
import { type V3, xfApply } from '../tools/rig/math.ts'
import { type Scales, jointFrames } from '../tools/rig/pose.ts'
import { Shaper, bmiUnits, factorValues, jointScales, resolveControls, skinDisplacement } from '../tools/rig/shape.ts'
import { shapeStale } from '../tools/rig/shape-build.ts'

/** 合成的最小体型数据：一个因子、一个关节、两个皮肤顶点、一个跟随部件。 A minimal synthetic shape: one factor, one joint, two skin vertices, one follower. */
function synthetic(): { shape: ShapeData; bin: Uint8Array } {
  const bin = new Uint8Array(24 + 8 + 8 + 4)
  const dv = new DataView(bin.buffer)
  ;[0.001, 0, 0, 0, 0.002, 0].forEach((v, i) => dv.setFloat32(i * 4, v, true))
  dv.setFloat32(24, 1, true)
  dv.setFloat32(28, 0.003, true)
  dv.setUint32(32, 1, true)
  dv.setUint32(36, 0, true)
  bin[40] = 255
  bin[41] = 0
  const ctl = (id: ShapeData['controls'][number]['id'], min: number, max: number, def: number, vmin = min, vmax = max): ShapeData['controls'][number] => ({ id, name: { zh: id, en: id }, unit: '', min, max, default: def, valid: { min: vmin, max: vmax, why: { zh: '', en: '' } } })
  const shape: ShapeData = {
    schema: 1, body: 'male',
    controls: [ctl('stature', 1.4, 2, 1.7), ctl('bmi', 16, 40, 24, 20, 40), ctl('legLength', -3, 2, -1), ctl('centralBuild', -2, 2, 0)],
    factors: [{ id: 'thigh', name: { zh: '大腿', en: 'thigh' }, kind: 'length', exponents: { stature: 1.2, legLength: 0.02, centralBuild: 0 } }],
    joints: [{ joint: 'hip_L', along: [{ factor: 'thigh', gain: 1 }], across: [] }],
    skin: { part: 'skin', vertexCount: 2, fatOffset: 0, limitOffset: 24, bmiToUnits: [[20, -4], [24, 0], [30, 6]] },
    followers: [{ part: 'fat', vertexCount: 2, skinIndexOffset: 32, followOffset: 40 }],
    rules: [], cautions: [], sources: [],
  }
  return { shape, bin }
}

describe('shape reference on synthetic data', () => {
  const { shape, bin } = synthetic()

  it('is the identity at the default controls', () => {
    expect(factorValues(shape).thigh).toBe(1)
    expect(jointScales(shape)).toEqual({})
    expect(Array.from(skinDisplacement(shape, bin))).toEqual([0, 0, 0, 0, 0, 0])
    const s = new Shaper(shape, bin)
    const rest = Float32Array.from([1, 2, 3, 4, 5, 6])
    expect(Array.from(s.shapedRest('skin', rest))).toEqual(Array.from(rest))
    expect(Array.from(s.shapedRest('fat', rest))).toEqual(Array.from(rest))
    expect(s.shapedRest('bone', rest)).toBe(rest)
  })

  it('evaluates factors, the BMI table and the per-vertex cap', () => {
    expect(factorValues(shape, { stature: 1.87 }).thigh).toBeCloseTo((1.87 / 1.7) ** 1.2, 12)
    expect(factorValues(shape, { legLength: 1 }).thigh).toBeCloseTo(Math.exp(0.04), 12)
    expect(jointScales(shape, { stature: 1.87 }).hip_L!.along).toBeCloseTo((1.87 / 1.7) ** 1.2, 12)
    expect(bmiUnits(shape, 27)).toBeCloseTo(3, 12)
    expect(bmiUnits(shape, 50)).toBe(6)
    const d = skinDisplacement(shape, bin, { bmi: 30 })
    // 顶点 0：6 × 1 mm，不受限；顶点 1：6 × 2 mm = 12 mm，被限制到 3 mm
    // vertex 0: 6 × 1 mm, not capped; vertex 1: 6 × 2 mm = 12 mm, capped at 3 mm
    expect(d[0]).toBeCloseTo(0.006, 7)
    expect(d[4]).toBeCloseTo(0.003, 7)
  })

  it('clamps controls to the valid range and moves followers by their share of the skin displacement', () => {
    expect(resolveControls(shape, { bmi: 17 }).bmi).toBe(20)
    expect(resolveControls(shape, { bmi: 17 }, false).bmi).toBe(17)
    const s = new Shaper(shape, bin, { bmi: 30 })
    const out = s.shapedRest('fat', Float32Array.from([0, 0, 0, 0, 0, 0]))
    // 跟随顶点 0：最近皮肤顶点 1，份额 1 → (0, 3 mm, 0)；顶点 1：份额 0，不动
    // follower vertex 0: nearest skin vertex 1, share 1 → (0, 3 mm, 0); vertex 1: share 0, does not move
    expect(out[1]).toBeCloseTo(0.003, 7)
    expect(Array.from(out.subarray(3))).toEqual([0, 0, 0])
    expect(Array.from(new Shaper(shape, bin, { bmi: 30 }).skin)).toEqual(Array.from(s.skin))
  })
})

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = ['shape.json', 'shape.bin', 'shape.report.json', 'rig.json'].every((f) => existsSync(join(DIR, f)))

  describe.skipIf(!present)(`shape output (public/anatomy/${bodyId})`, () => {
    const shape = (present ? JSON.parse(readFileSync(join(DIR, 'shape.json'), 'utf8')) : null) as ShapeData
    const bin = present ? new Uint8Array(readFileSync(join(DIR, 'shape.bin'))) : new Uint8Array(0)
    const rig = (present ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : null) as Rig
    const report = (present ? JSON.parse(readFileSync(join(DIR, 'shape.report.json'), 'utf8')) : null) as { binBytes: number; calibration: { factor: string; from: string; to: string; gain: number }[]; measures: { label: string; skinHeightM: number; deep: { over2mmPct: number } }[] }
    const fresh = present && shapeStale(DIR).length === 0
    const index = new Map<string, number>(present ? rig.joints.map((j, i) => [j.id, i]) : [])
    const dist = (scales: Scales, a: string, b: string): number => {
      const f = jointFrames(rig.joints, {}, scales).xfs
      const p = xfApply(f[index.get(a)!]!, rig.joints[index.get(a)!]!.center as V3), q = xfApply(f[index.get(b)!]!, rig.joints[index.get(b)!]!.center as V3)
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    }

    it('has four controls whose defaults lie inside their valid ranges', () => {
      expect(shape.schema).toBe(1)
      expect(shape.body).toBe(bodyId)
      expect(shape.controls.map((c) => c.id)).toEqual(['stature', 'bmi', 'legLength', 'centralBuild'])
      for (const c of shape.controls) {
        expect(c.valid.min).toBeGreaterThanOrEqual(c.min)
        expect(c.valid.max).toBeLessThanOrEqual(c.max)
        expect(c.default).toBeGreaterThanOrEqual(c.valid.min)
        expect(c.default).toBeLessThanOrEqual(c.valid.max)
        expect(c.valid.why.zh.length).toBeGreaterThan(5)
        expect(c.valid.why.en.length).toBeGreaterThan(5)
      }
      expect(shape.rules.length).toBeGreaterThanOrEqual(4)
      expect(shape.cautions.length).toBeGreaterThanOrEqual(3)
    })

    it('is the identity at the default controls', () => {
      for (const v of Object.values(factorValues(shape))) expect(v).toBe(1)
      expect(jointScales(shape)).toEqual({})
      const d = skinDisplacement(shape, bin)
      let mx = 0
      for (const v of d) mx = Math.max(mx, Math.abs(v))
      expect(mx).toBeLessThan(1e-5)
    })

    it('refers only to joints and factors that exist', () => {
      const factors = new Set(shape.factors.map((f) => f.id))
      expect(factors.size).toBe(shape.factors.length)
      for (const j of shape.joints) {
        expect(index.has(j.joint), j.joint).toBe(true)
        for (const t of [...j.along, ...j.across]) {
          expect(factors.has(t.factor), t.factor).toBe(true)
          expect(Number.isFinite(t.gain) && t.gain > 0 && t.gain < 20, `${j.joint} ${t.factor} gain ${t.gain}`).toBe(true)
        }
      }
    })

    it('reproduces the model’s segment lengths and breadths through the joint scales', () => {
      for (const controls of [{ stature: shape.controls[0]!.default + 0.1 }, { stature: shape.controls[0]!.default - 0.12, legLength: 1 }, { legLength: -2.5, centralBuild: 1.5 }]) {
        const f = factorValues(shape, controls)
        const scales = jointScales(shape, controls)
        // 容差 1%：增益是逐因子单独标定的，因子之间有少量耦合（胸椎横向缩放会带动胸锁关节，影响肩宽）
        // 1 % tolerance: gains are calibrated one factor at a time and the factors couple slightly (the transverse scale of the thoracic vertebrae carries the sternoclavicular joints and so touches shoulder width)
        for (const c of report.calibration) {
          const got = dist(scales, c.from, c.to) / dist({}, c.from, c.to)
          expect(Math.abs(got / f[c.factor]! - 1), `${c.factor} at ${JSON.stringify(controls)}: ${got} vs ${f[c.factor]}`).toBeLessThan(0.01)
        }
      }
      // 身高 +10 cm：大腿比躯干拉长得多（指数 > 1 与 < 1）
      // stature +10 cm: the thigh lengthens more than the trunk (exponents above and below 1)
      const f = factorValues(shape, { stature: shape.controls[0]!.default + 0.1 })
      expect(f.thigh).toBeGreaterThan(f.trunk!)
      expect(f.trunk).toBeGreaterThan(1)
    })

    it('has finite, bounded skin fields and valid follower references', () => {
      expect(bin.length).toBe(report.binBytes)
      const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
      const n = shape.skin.vertexCount
      let maxFat = 0
      for (let i = 0; i < n * 3; i++) {
        const v = dv.getFloat32(shape.skin.fatOffset + i * 4, true)
        if (!Number.isFinite(v)) throw new Error(`fat field value ${i} is not finite`)
        maxFat = Math.max(maxFat, Math.abs(v))
      }
      // 每个 BMI 点的位移不到 2 cm / less than 2 cm of displacement per BMI point
      expect(maxFat).toBeGreaterThan(0.0003)
      expect(maxFat).toBeLessThan(0.02)
      for (let i = 0; i < n; i++) {
        const v = dv.getFloat32(shape.skin.limitOffset + i * 4, true)
        if (!(v >= 0) || !Number.isFinite(v)) throw new Error(`limit ${i} = ${v}`)
      }
      const bmi = shape.controls[1]!
      for (const b of [bmi.valid.min, bmi.valid.max]) {
        const d = skinDisplacement(shape, bin, { bmi: b })
        let mx = 0
        for (let i = 0; i < n; i++) mx = Math.max(mx, Math.hypot(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!))
        expect(mx).toBeGreaterThan(0.002)
        expect(mx).toBeLessThan(0.2)
      }
      // 范围以外的值被截到可用范围 / values outside the range are clamped to it
      expect(Array.from(skinDisplacement(shape, bin, { bmi: bmi.valid.min - 5 }))).toEqual(Array.from(skinDisplacement(shape, bin, { bmi: bmi.valid.min })))
      expect(shape.skin.bmiToUnits.every((r, i, a) => i === 0 || (r[0] > a[i - 1]![0] && r[1] > a[i - 1]![1]))).toBe(true)
      expect(shape.followers.length).toBeGreaterThan(5)
      for (const f of shape.followers) {
        expect(f.followOffset + f.vertexCount).toBeLessThanOrEqual(bin.length)
        for (let i = 0; i < f.vertexCount; i++) if (bin[f.followOffset + i]! > 0 && dv.getUint32(f.skinIndexOffset + i * 4, true) >= n) throw new Error(`${f.part}: skin index out of range`)
      }
    })

    it('is deterministic', () => {
      const a = new Shaper(shape, bin, { stature: 1.8, bmi: 28, legLength: 0.5, centralBuild: -1 }), b = new Shaper(shape, bin, { stature: 1.8, bmi: 28, legLength: 0.5, centralBuild: -1 })
      expect(a.scales).toEqual(b.scales)
      expect(Array.from(a.skin)).toEqual(Array.from(b.skin))
    })

    it('measured what it claims at the control extremes', () => {
      if (!fresh) return
      const m = new Map(report.measures.map((x) => [x.label, x]))
      const def = m.get('default')!
      expect(m.get('stature +2 SD')!.skinHeightM).toBeGreaterThan(def.skinHeightM + 0.09)
      expect(m.get('stature −2 SD')!.skinHeightM).toBeLessThan(def.skinHeightM - 0.09)
      // 身高和比例的缩放对皮肤与深部结构一视同仁：穿出皮肤的比例几乎不变
      // stature and proportion scales treat skin and deep parts alike: hardly any more of them comes through the skin
      for (const l of ['stature +2 SD', 'stature −2 SD', 'leg length 1.5', 'central build -1.5']) expect(m.get(l)!.deep.over2mmPct, l).toBeLessThan(def.deep.over2mmPct + 1)
      expect(m.get('BMI 30')!.deep.over2mmPct).toBeLessThanOrEqual(def.deep.over2mmPct + 0.5)
    })
  })
}
