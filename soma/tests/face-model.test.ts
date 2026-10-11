// 面部表情参考实现（tools/face/model.ts）在合成数据上的单元测试。
// Unit tests of the facial expression reference (tools/face/model.ts) on synthetic data.

import { describe, expect, it } from 'vitest'
import type { FaceAU, FaceChannel, PainModel } from '../src/face/types.ts'
import { AU_MAX, Q, activations, deform, displacement, envelope, painAUs, painExpression, pspi, readField } from '../tools/face/model.ts'

const BASIS = { source: null, note: { zh: '', en: '' } }
const PAIN: PainModel = {
  pspi: { terms: ['AU4', ['AU6', 'AU7'], ['AU9', 'AU10'], 'AU43'], binary: ['AU43'], max: 16, basis: BASIS },
  keyframes: [
    { level: 0, aus: {} },
    { level: 5, aus: { AU4: 2, AU7: 3 } },
    { level: 10, aus: { AU4: 5, AU6: 5, AU7: 4, AU9: 2, AU10: 5, AU43: 5 } },
  ],
  mapping: BASIS,
  timing: { latency: 0.2, onset: 0.5, offset: 1, basis: BASIS },
}

/** 两个顶点上的一个场：顶点 1 位移 (1, −2, 0.5) mm，顶点 3 位移 (0, 2, 0) mm。 A field on two vertices: vertex 1 moves (1, −2, 0.5) mm and vertex 3 moves (0, 2, 0) mm. */
function fixture(): { channels: FaceChannel[]; bin: Uint8Array } {
  const bin = new Uint8Array(40)
  const dv = new DataView(bin.buffer)
  const scale = 0.002
  dv.setUint32(0, 1, true)
  dv.setUint32(4, 3, true)
  const comp = [1, -2, 0.5, 0, 2, 0].map((mm) => Math.round(((mm / 1000) / scale) * Q))
  comp.forEach((c, i) => dv.setInt16(8 + i * 2, c, true))
  // 第二个通道，同一顶点 1：(0, 0, 1) mm / a second channel on the same vertex 1: (0, 0, 1) mm
  dv.setUint32(20, 1, true)
  ;[0, 0, Q].forEach((c, i) => dv.setInt16(24 + i * 2, c, true))
  const line = { origin: [0, 0, 0] as [number, number, number], insertion: [0, 0, 0] as [number, number, number], originOnSkin: [0, 0, 0] as [number, number, number], insertionOnSkin: [0, 0, 0] as [number, number, number] }
  const ch = (id: string, offset: number, count: number, s: number): FaceChannel => ({ id, muscle: id, name: { zh: id, en: id }, kind: 'linear', side: 'L', parts: [], line, basis: 'geometry', excursion: s, fields: [{ part: 'skin', offset, count, scale: s }] })
  return { channels: [ch('a', 0, 2, scale), ch('b', 20, 1, 0.001)], bin }
}

describe('pain → AU intensities', () => {
  it('interpolates linearly between keyframes and clamps outside them', () => {
    expect(painAUs(PAIN, 0)).toEqual({})
    expect(painAUs(PAIN, 2.5)).toEqual({ AU4: 1, AU7: 1.5 })
    expect(painAUs(PAIN, 5)).toEqual({ AU4: 2, AU7: 3 })
    expect(painAUs(PAIN, 7.5).AU6).toBeCloseTo(2.5, 12)
    expect(painAUs(PAIN, 7.5).AU7).toBeCloseTo(3.5, 12)
    expect(painAUs(PAIN, 99)).toEqual(painAUs(PAIN, 10))
    expect(painAUs(PAIN, -3)).toEqual({})
  })
})

describe('PSPI', () => {
  it('is AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43 with AU43 counted 0 or 1', () => {
    expect(pspi(PAIN, {})).toBe(0)
    expect(pspi(PAIN, { AU4: 3, AU6: 1, AU7: 4, AU9: 2, AU10: 1 })).toBe(3 + 4 + 2)
    expect(pspi(PAIN, { AU43: 5 })).toBe(1)
    expect(pspi(PAIN, { AU43: 2 })).toBe(0)
    expect(pspi(PAIN, { AU43: 2 }, true)).toBeCloseTo(0.4, 12)
    expect(pspi(PAIN, { AU4: 5, AU6: 5, AU7: 5, AU9: 5, AU10: 5, AU43: 5 })).toBe(16)
    // 不在公式里的 AU 不计分；超出量程的强度被截断 / AUs outside the formula do not count; intensities beyond the scale are clamped
    expect(pspi(PAIN, { AU25: 5, AU26: 5, AU12: 5 })).toBe(0)
    expect(pspi(PAIN, { AU4: 9 })).toBe(5)
  })
})

describe('time envelope', () => {
  const T = PAIN.timing
  it('is 0 before the latency, 1 at the apex and 0 again after the offset', () => {
    expect(envelope(T, 0, 3)).toBe(0)
    expect(envelope(T, 0.2, 3)).toBe(0)
    expect(envelope(T, 0.7, 3)).toBe(1)
    expect(envelope(T, 2.5, 3)).toBe(1)
    expect(envelope(T, 3.2 + 1, 3)).toBe(0)
    expect(envelope(T, 3.2 + 0.5, 3)).toBeCloseTo(0.5, 12)
  })
  it('rises and falls monotonically and stays within 0–1', () => {
    let prev = 0
    for (let t = 0; t <= 3.2; t += 0.01) {
      const e = envelope(T, t, 3)
      expect(e).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(e).toBeLessThanOrEqual(1)
      prev = e
    }
    for (let t = 3.2; t <= 5; t += 0.01) {
      const e = envelope(T, t, 3)
      expect(e).toBeLessThanOrEqual(prev + 1e-12)
      expect(e).toBeGreaterThanOrEqual(0)
      prev = e
    }
  })
  it('does not reach the apex for a stimulus shorter than the onset, and is continuous at its end', () => {
    const peak = envelope(T, 0.2 + 0.25, 0.25)
    expect(peak).toBeCloseTo(0.5, 12)
    expect(envelope(T, 0.2 + 0.25 + 1e-9, 0.25)).toBeCloseTo(peak, 6)
  })
})

describe('AU → channel activations', () => {
  const aus: FaceAU[] = [
    { id: 'AU4', name: { zh: '', en: '' }, channels: { a: 1, b: 0.5 }, basis: BASIS },
    { id: 'AU7', name: { zh: '', en: '' }, channels: { a: 0.6 }, basis: BASIS },
    { id: 'AU26', name: { zh: '', en: '' }, channels: {}, jaw: 0.2, basis: BASIS },
    { id: 'AU27', name: { zh: '', en: '' }, channels: {}, jaw: 0.5, basis: BASIS },
  ]
  const face = { aus, jaw: { joint: 'tmj', dof: 0, max: 0.5, closers: [], openers: [] } }
  it('scales with intensity / 5, adds over AUs and clamps to 1', () => {
    expect(activations(face, {})).toEqual({ channels: {}, jaw: 0 })
    const one = activations(face, { AU4: 2.5 })
    expect(one.channels.a).toBeCloseTo(0.5, 12)
    expect(one.channels.b).toBeCloseTo(0.25, 12)
    const both = activations(face, { AU4: AU_MAX, AU7: AU_MAX })
    expect(both.channels.a).toBe(1)
    expect(both.channels.b).toBe(0.5)
  })
  it('adds the jaw angles and clamps them to the range of the joint', () => {
    expect(activations(face, { AU26: 5 }).jaw).toBeCloseTo(0.2, 12)
    expect(activations(face, { AU26: 5, AU27: 5 }).jaw).toBe(0.5)
  })
  it('painExpression chains the steps', () => {
    const r = painExpression({ ...face, pain: PAIN }, 5)
    expect(r.aus).toEqual({ AU4: 2, AU7: 3 })
    expect(r.pspi).toBe(5)
    expect(r.channels.a).toBeCloseTo(0.4 + 0.36, 12)
  })
})

describe('displacement fields', () => {
  const { channels, bin } = fixture()
  it('decode from face.bin', () => {
    const f = readField(bin, channels[0]!.fields[0]!)
    expect([...f.index]).toEqual([1, 3])
    const mm = [...f.delta].map((x) => x * 1000)
    ;[1, -2, 0.5, 0, 2, 0].forEach((v, i) => expect(mm[i]).toBeCloseTo(v, 3))
  })
  it('are zero at zero activation and scale linearly', () => {
    expect([...displacement(channels, bin, 'skin', 4, {})].every((x) => x === 0)).toBe(true)
    const full = displacement(channels, bin, 'skin', 4, { a: 1 }), half = displacement(channels, bin, 'skin', 4, { a: 0.5 })
    for (let i = 0; i < full.length; i++) expect(half[i]).toBeCloseTo(full[i]! / 2, 9)
    expect(full[3]! * 1000).toBeCloseTo(1, 3)
    expect(full[4]! * 1000).toBeCloseTo(-2, 3)
  })
  it('add over channels, clamp activations to 0–1 and leave other parts alone', () => {
    const d = displacement(channels, bin, 'skin', 4, { a: 1, b: 7 })
    expect(d[5]! * 1000).toBeCloseTo(0.5 + 1, 3)
    expect([...displacement(channels, bin, 'other', 4, { a: 1, b: 1 })].every((x) => x === 0)).toBe(true)
    expect([...displacement(channels, bin, 'skin', 4, { a: -1 })].every((x) => x === 0)).toBe(true)
  })
  it('deform adds the displacement to the rest vertices', () => {
    const rest = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
    const out = deform(channels, bin, 'skin', rest, { a: 1 })
    expect(out[0]).toBe(0)
    expect(out[3]).toBeCloseTo(1.001, 6)
    expect(out[10]).toBeCloseTo(3.002, 6)
    expect([...deform(channels, bin, 'skin', rest, {})]).toEqual([...rest])
  })
})
