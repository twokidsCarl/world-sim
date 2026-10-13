// 口部的几何检验：口角（AU12 / AU20 / AU25）、说话的视位、协同发音、原始声学特征路线、表情与说话的合成。
// 依赖几何的断言只在 face.json 存在且不过期时执行：先运行 `bun tools/face/run.ts male`（和 female）。
// Geometric checks of the mouth: the corners (AU12 / AU20 / AU25), the visemes of speech, co-articulation, the raw-feature route,
// and the blend of expression and speech. Assertions that depend on the geometry run only while face.json is present and not
// stale: run `bun tools/face/run.ts male` (and female) first.
//
// 这里陈述的容差 / Tolerances stated here
//   · AU12 = 5：口角上移 ≥ 3 mm、外移 ≥ 1 mm；上唇缘折线对 4 次多项式（y 对 x、z 对 x）的偏差 ≤ max(0.6 mm, 静止时的偏差 + 0.3 mm)；
//     口角 16 mm 内的皮肤三角形没有翻折（法线不反向；静止和变形后的高都不到 0.1 mm 的退化三角形不算），AU20 = 5 亦然。
//     AU12 = 5: the corner rises ≥ 3 mm and moves ≥ 1 mm laterally; the upper lip-margin polyline deviates from a quartic (y on x, z on x)
//     by ≤ max(0.6 mm, its deviation at rest + 0.3 mm); no skin triangle within 16 mm of a corner is folded (normal reversed; degenerate triangles under 0.1 mm of height both at rest and deformed excepted); the same for AU20 = 5.
//   · AU25：口角以外每一对唇缘顶点之间的间隙都 > 0（紧挨口角的三对：交叉不超过 0.1 mm），正中 ≥ 2 mm。
//     AU25: the gap between every pair of margin vertices other than the corners is > 0 (the three pairs next to a corner: crossing by no more than 0.1 mm), and ≥ 2 mm at the midline.
//   · 双唇音（下颌张开时）：口裂中间 60% 的间隙 ≤ 0.3 mm，下唇缘越过上唇缘不超过 0.3 mm。
//     Bilabials (with the jaw open): over the middle 60% of the fissure the gap is ≤ 0.3 mm and the lower margin passes the upper by no more than 0.3 mm.
//   · 唇齿音：下唇缘中点离上切牙切缘 ≤ 1 mm，且不在切缘之后（不进牙）。 Labiodentals: the middle of the lower margin is within 1 mm of the upper incisal edge and not behind it (not inside the tooth).
//   · 圆唇元音（u、w；o 为 6%）：口宽缩短 ≥ 20%，唇缘中点前移 ≥ 2 mm。 Rounded vowels (u, w; 6% for o): mouth width shortens by ≥ 20% and the middle of the margin moves forward by ≥ 2 mm.
//   · 唇齿音在下颌闭合、参考角的一半、参考角三处：下唇缘中点离切缘 ≤ 1 mm，不在唇面之后，高出切缘不超过 0.2 mm；0.2 × 上限处 ≤ 2 mm。
//     Labiodentals with the jaw closed, at half the reference angle and at the reference: the middle of the lower margin within 1 mm of the edge, not behind the labial face and no more than 0.2 mm above the edge; within 2 mm at 0.2 × the limit.
//   · baseJaw：下颌从别处张开 0.1、0.2 × 上限时，双唇音口裂中间 60% 的间隙 ≤ 0.3 mm。 baseJaw: with the jaw opened from elsewhere by 0.1 and 0.2 × its limit, a bilabial leaves ≤ 0.3 mm over the middle 60% of the fissure.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Rig } from '../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../src/face/types.ts'
import type { MouthFrame } from '../src/voice/mouth.ts'
import { isLipPart } from '../tools/face/build.ts'
import { AU_MAX, type Activations, type MouthState, UPPER_FACE_AUS, activations, blendFace, coarticulate, deform, mouthChannels, mouthFrameToChannels, painAUs, visemeAUs } from '../tools/face/model.ts'
import { stale } from '../tools/face/run.ts'
import { type Body, readBody } from '../tools/rig/io.ts'
import { Poser } from '../tools/rig/pose.ts'

const MM = 0.001

describe('lip parts are found by name, one part or two', () => {
  it('accepts Lip, Upper lip and Lower lip, and rejects muscles and teeth', () => {
    for (const name of ['Lip', 'Upper lip', 'Lower lip', 'lips']) expect(isLipPart({ name, tissue: 'organ' }), name).toBe(true)
    expect(isLipPart({ name: 'Orbicularis oris', tissue: 'muscle' })).toBe(false)
    expect(isLipPart({ name: 'Lip', tissue: 'muscle' })).toBe(false)
    expect(isLipPart({ name: 'Left depressor labii inferioris', tissue: 'muscle' })).toBe(false)
    expect(isLipPart({ name: 'Frenulum of upper lip', tissue: 'organ' })).toBe(false)
  })
})

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'face.json')) && existsSync(join(DIR, 'face.bin')) && existsSync(join(DIR, 'face', 'openings.json')) && existsSync(join(DIR, 'rig.bin'))
  const fresh = present && stale(DIR).length === 0

  describe.skipIf(!fresh)(`mouth (public/anatomy/${bodyId})`, () => {
    const face = (present ? JSON.parse(readFileSync(join(DIR, 'face.json'), 'utf8')) : {}) as FaceData
    const bin = present ? new Uint8Array(readFileSync(join(DIR, 'face.bin'))) : new Uint8Array(0)
    const O = (present ? JSON.parse(readFileSync(join(DIR, 'face', 'openings.json'), 'utf8')) : {}) as FaceOpenings
    const rig = (present ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : {}) as Rig
    const rigBin = present ? new Uint8Array(readFileSync(join(DIR, 'rig.bin'))) : new Uint8Array(0)
    let body: Body
    let rest: Float32Array
    let indices: Uint32Array
    beforeAll(async () => {
      body = await readBody(DIR)
      rest = body.meshes.get(face.skin)!.positions
      indices = body.meshes.get(face.skin)!.indices
    }, 120_000)

    /** 变形并摆好下颌后的皮肤顶点 / skin vertices deformed and with the jaw posed. */
    const posed = (channels: Activations, jaw: number): Float32Array => {
      const pose = jaw > 0 ? { [face.jaw.joint]: Array.from({ length: face.jaw.dof + 1 }, (_, k) => (k === face.jaw.dof ? jaw : 0)) } : {}
      return new Poser(rig, rigBin, pose).part(face.skin, deform(face.channels, bin, face.skin, rest, channels), 'dqs', false)
    }
    const ofAUs = (aus: Record<string, number>): Float32Array => {
      const a = activations(face, aus)
      return posed(a.channels, a.jaw)
    }
    const P = (a: Float32Array, v: number): [number, number, number] => [a[v * 3]!, a[v * 3 + 1]!, a[v * 3 + 2]!]
    const dist = (p: number[], q: number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
    /** 最小二乘多项式拟合的最大残差 / largest residual of a least-squares polynomial fit. */
    const polyResidual = (xs: number[], ys: number[], degree: number): number => {
      const n = degree + 1, x0 = xs.reduce((a, b) => a + b, 0) / xs.length, sc = Math.max(...xs.map((x) => Math.abs(x - x0))) || 1
      const A = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0))
      for (let k = 0; k < xs.length; k++) {
        const t = (xs[k]! - x0) / sc, pw = Array.from({ length: n }, (_, i) => t ** i)
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) A[i]![j] = A[i]![j]! + pw[i]! * pw[j]!
          A[i]![n] = A[i]![n]! + pw[i]! * ys[k]!
        }
      }
      for (let c = 0; c < n; c++) {
        let piv = c
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r
        ;[A[c], A[piv]] = [A[piv]!, A[c]!]
        for (let r = 0; r < n; r++) {
          if (r === c) continue
          const f = A[r]![c]! / A[c]![c]!
          for (let k = c; k <= n; k++) A[r]![k] = A[r]![k]! - f * A[c]![k]!
        }
      }
      const coef = A.map((row, i) => row[n]! / row[i]!)
      return Math.max(...xs.map((x, k) => Math.abs(ys[k]! - coef.reduce((s, c, i) => s + c * ((x - x0) / sc) ** i, 0))))
    }
    const folded = (pos: Float32Array): number => {
      const cl = P(rest, O.points.mouthCornerL), cr = P(rest, O.points.mouthCornerR)
      const aid = new Set([...O.oralPouch.upper, ...O.oralPouch.lower, ...O.oralPouch.seam])
      const near = (v: number): boolean => !aid.has(v) && Math.min(dist(P(rest, v), cl), dist(P(rest, v), cr)) < 16 * MM
      const nrm = (a: Float32Array, i: number, j: number, k: number): number[] => {
        const p = P(a, i), q = P(a, j), r = P(a, k)
        const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
        return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      }
      let count = 0
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
        if (!near(a) || !near(b) || !near(c)) continue
        const n0 = nrm(rest, a, b, c), n1 = nrm(pos, a, b, c)
        // 高 = 2 × 面积 / 最长边；静止和变形后的高都不到 0.1 mm 的是唇缘上三点共线的退化三角形，不算（理由见 face-corner.test.ts）
        // height = 2 × area / longest edge; a triangle under 0.1 mm both at rest and deformed is a degenerate one with three collinear points on the margin and is not counted (reasons in face-corner.test.ts)
        const height = (x: Float32Array, n: number[]): number => Math.hypot(n[0]!, n[1]!, n[2]!) / Math.max(1e-12, dist(P(x, a), P(x, b)), dist(P(x, b), P(x, c)), dist(P(x, c), P(x, a)))
        if (Math.max(height(rest, n0), height(pos, n1)) < 0.1 * MM) continue
        if (n0[0]! * n1[0]! + n0[1]! * n1[1]! + n0[2]! * n1[2]! <= 0) count++
      }
      return count
    }
    const midI = (): number => O.margins.upperLip.length >> 1
    const gaps = (pos: Float32Array): number[] => O.margins.upperLip.map((u, i) => pos[u * 3 + 1]! - pos[O.margins.lowerLip[i]! * 3 + 1]!)

    it('AU12 raises the mouth corners up and out, keeps the lip margin smooth and folds nothing', () => {
      const pos = ofAUs({ AU12: AU_MAX })
      for (const [v, sgn] of [[O.points.mouthCornerL, 1], [O.points.mouthCornerR, -1]] as const) {
        expect((pos[v * 3 + 1]! - rest[v * 3 + 1]!) / MM).toBeGreaterThan(3)
        expect((sgn * (pos[v * 3]! - rest[v * 3]!)) / MM).toBeGreaterThan(1)
      }
      // 静止的唇缘本身就不是多项式（女性的偏差约 0.5 mm）：变形后的偏差不得超过 0.6 mm 和“静止偏差 + 0.3 mm”中较大的一个
      // the rest margin is no polynomial itself (the female's deviates by about 0.5 mm): after deformation the deviation may not exceed the larger of 0.6 mm and rest deviation + 0.3 mm
      const xs = O.margins.upperLip.map((v) => pos[v * 3]!), xr = O.margins.upperLip.map((v) => rest[v * 3]!)
      for (const c of [1, 2]) {
        const r0 = polyResidual(xr, O.margins.upperLip.map((v) => rest[v * 3 + c]!), 4), r1 = polyResidual(xs, O.margins.upperLip.map((v) => pos[v * 3 + c]!), 4)
        expect(r1 / MM, `component ${c}, rest ${(r0 / MM).toFixed(2)}`).toBeLessThanOrEqual(Math.max(0.6, r0 / MM + 0.3))
      }
      // 口角比唇缘中点高：向上弯的笑 / the corners end above the middle of the margin: an upward curve
      const mid = O.margins.upperLip[midI()]!
      expect(pos[O.points.mouthCornerL * 3 + 1]! - pos[mid * 3 + 1]!).toBeGreaterThan(rest[O.points.mouthCornerL * 3 + 1]! - rest[mid * 3 + 1]! + 3 * MM)
      expect(folded(pos)).toBe(0)
      expect(folded(ofAUs({ AU12: 3 }))).toBe(0)
      // 两唇缘仍然合着 / the margins still coincide
      expect(Math.max(...gaps(pos).map(Math.abs)) / MM).toBeLessThan(0.05)
    })

    it('AU20 stretches the mouth sideways without folding the corner', () => {
      const pos = ofAUs({ AU20: AU_MAX })
      const w0 = dist(P(rest, O.points.mouthCornerL), P(rest, O.points.mouthCornerR)), w1 = dist(P(pos, O.points.mouthCornerL), P(pos, O.points.mouthCornerR))
      expect((w1 - w0) / MM).toBeGreaterThan(3)
      expect(folded(pos)).toBe(0)
    })

    it('AU25 parts the lips along the whole fissure', () => {
      for (const i of [3, AU_MAX]) {
        const g = gaps(ofAUs({ AU25: i }))
        // 紧挨口角的三对间隙只有几微米，那里只要求交叉不超过 0.1 mm / the three pairs right at a corner are only microns apart; there the margins may cross by no more than 0.1 mm
        for (let k = 1; k + 1 < g.length; k++) expect(g[k]!, `AU25 ${i}, pair ${k}`).toBeGreaterThan(k < 4 || k > g.length - 5 ? -0.1 * MM : 0)
      }
      expect(gaps(ofAUs({ AU25: AU_MAX }))[midI()]! / MM).toBeGreaterThanOrEqual(2)
    })

    it('ships the viseme table with the channels both routes drive', () => {
      const vs = face.visemes!.visemes
      expect(vs.length).toBeGreaterThanOrEqual(15)
      const auIds = new Set(face.aus.map((a) => a.id)), chIds = new Set(face.channels.map((c) => c.id))
      for (const v of vs) {
        for (const au of Object.keys(v.aus)) expect(auIds.has(au), `${v.id} ${au}`).toBe(true)
        expect(v.jaw >= 0 && v.jaw <= 1, v.id).toBe(true)
        const out = visemeAUs(face, { [v.id]: 1 })
        for (const c of Object.keys(out.channels)) expect(chIds.has(c), `${v.id} ${c}`).toBe(true)
      }
      for (const id of ['lip_seal', 'lip_dental', 'lip_protrusion', 'lip_roll_upper', 'lip_roll_lower', 'lip_press', 'lip_upper_depress', 'tongue_tip_up', 'tongue_front_up', 'tongue_back_up', 'tongue_low']) expect(chIds.has(id), id).toBe(true)
      expect(face.channels.find((c) => c.id === 'lip_seal')!.refJaw).toBeGreaterThan(0)
      // JA、LI 两个轴：JA 只缩放下颌和舌，LI 只缩放唇的 AU / the two axes: JA scales jaw and tongue only, LI the lip AUs only
      const full = visemeAUs(face, { OW: 1 }), ja = visemeAUs(face, { OW: 1 }, { jaw: 0.5 }), li = visemeAUs(face, { OW: 1 }, { lip: 0.5 })
      expect(ja.jaw).toBeCloseTo(full.jaw / 2, 9)
      expect(ja.aus).toEqual(full.aus)
      expect(li.jaw).toBeCloseTo(full.jaw, 9)
      expect(li.aus.AU22).toBeCloseTo(full.aus.AU22! / 2, 9)
    })

    it('closes the lips for bilabials with the teeth apart', () => {
      for (const jawFraction of [0.06, 0.15, 0.25]) {
        const pose = visemeAUs(face, { PBM: 1 })
        expect(pose.closure).toBe(1)
        const jaw = jawFraction * face.jaw.max
        // 同一个口形，下颌张到不同的角度 / the same shape with the jaw opened to different angles
        const out = mouthChannels(face, { ...pose, jaw })
        expect(out.jaw).toBeCloseTo(jaw, 9)
        const pos = posed(out.channels, jaw)
        const open = gaps(posed({ mouth_corner: jawFraction }, jaw))
        const g = gaps(pos), n = g.length
        // 不闭唇时这个下颌角确实把唇分开了 / without the seal this jaw angle does part the lips
        expect(open[midI()]! / MM).toBeGreaterThan(2)
        for (let k = Math.round(n * 0.2); k < Math.round(n * 0.8); k++) {
          expect(Math.abs(g[k]!) / MM, `jaw ${jawFraction}, pair ${k}`).toBeLessThanOrEqual(0.3)
          expect(dist(P(pos, O.margins.upperLip[k]!), P(pos, O.margins.lowerLip[k]!)) / MM).toBeLessThanOrEqual(0.5)
        }
      }
    })

    it('brings the lower lip to the upper incisal edge for labiodentals', () => {
      const out = visemeAUs(face, { FV: 1 })
      expect(out.dental).toBe(1)
      const pos = posed(out.channels, out.jaw)
      const teeth = body.data.parts.filter((p) => p.tissue === 'tooth' && /upper (central|lateral).*incisor/i.test(p.name) && body.meshes.has(p.id))
      expect(teeth.length).toBeGreaterThanOrEqual(2)
      const v = O.margins.lowerLip[midI()]!
      const x = pos[v * 3]!
      const near: number[][] = []
      for (const t of teeth) {
        const m = body.meshes.get(t.id)!.positions
        for (let i = 0; i < m.length; i += 3) if (Math.abs(m[i]! - x) < 1.5 * MM) near.push([m[i]!, m[i + 1]!, m[i + 2]!])
      }
      const yEdge = Math.min(...near.map((q) => q[1]!)), zLab = Math.max(...near.filter((q) => q[1]! < yEdge + 2 * MM).map((q) => q[2]!))
      expect(dist(P(pos, v), [x, yEdge, zLab]) / MM).toBeLessThanOrEqual(1)
      expect(pos[v * 3 + 2]!).toBeGreaterThanOrEqual(zLab)
      // 静止时下唇缘离切缘更远 / at rest the lower margin is further from the edge
      expect(dist(P(rest, v), [x, yEdge, zLab])).toBeGreaterThan(dist(P(pos, v), [x, yEdge, zLab]) + 1 * MM)
    })

    it('lands the lower lip on the incisal edge across the jaw range, by mixing two references', () => {
      const dent = face.channels.find((c) => c.id === 'lip_dental')!, closed = face.channels.find((c) => c.id === 'lip_dental_closed')!
      expect(closed.refJaw).toBe(0)
      expect(dent.refJaw!).toBeGreaterThan(0)
      const teeth = body.data.parts.filter((p) => p.tissue === 'tooth' && /upper (central|lateral).*incisor/i.test(p.name) && body.meshes.has(p.id))
      const v = O.margins.lowerLip[midI()]!
      const pose = visemeAUs(face, { FV: 1 })
      const report: string[] = []
      // 下颌闭合、参考角的一半、参考角：都应正好到位；再大（0.2 × 上限）由 lip_seal 抵消，是近似的
      // jaw closed, half the reference, the reference: exact at all three; wider (0.2 × the limit) is undone with lip_seal and approximate
      for (const [jaw, tol] of [[0, 1], [dent.refJaw! / 2, 1], [dent.refJaw!, 1], [0.2 * face.jaw.max, 2]] as const) {
        const out = mouthChannels(face, { ...pose, aus: {}, jaw })
        expect(out.totalJaw).toBeCloseTo(jaw, 9)
        expect((out.channels.lip_dental ?? 0) + (out.channels.lip_dental_closed ?? 0)).toBeCloseTo(1, 9)
        const pos = posed(out.channels, jaw)
        const x = pos[v * 3]!
        const near: number[][] = []
        for (const t of teeth) {
          const m = body.meshes.get(t.id)!.positions
          for (let i = 0; i < m.length; i += 3) if (Math.abs(m[i]! - x) < 1.5 * MM) near.push([m[i]!, m[i + 1]!, m[i + 2]!])
        }
        const yEdge = Math.min(...near.map((q) => q[1]!)), zLab = Math.max(...near.filter((q) => q[1]! < yEdge + 2 * MM).map((q) => q[2]!))
        report.push(`jaw ${(jaw / face.jaw.max).toFixed(2)}: ${(dist(P(pos, v), [x, yEdge, zLab]) / MM).toFixed(2)} mm, above edge ${((pos[v * 3 + 1]! - yEdge) / MM).toFixed(2)}`)
        expect(dist(P(pos, v), [x, yEdge, zLab]) / MM, `jaw ${jaw}`).toBeLessThanOrEqual(tol)
        // 不进牙：不在唇面之后，也不高出切缘 0.2 mm 以上 / not inside the tooth: not behind the labial face and no more than 0.2 mm above the edge
        expect(pos[v * 3 + 2]!, `jaw ${jaw}`).toBeGreaterThanOrEqual(zLab)
        if (tol === 1) expect((pos[v * 3 + 1]! - yEdge) / MM, `jaw ${jaw}`).toBeLessThanOrEqual(0.2)
      }
      if (process.env.FACE_STATS) console.log(report.join('\n'))
    })

    it('seals the lips for the total jaw angle when the jaw is opened from elsewhere (baseJaw)', () => {
      const speech = visemeAUs(face, { PBM: 1 })
      const refJaw = face.channels.find((c) => c.id === 'lip_seal')!.refJaw!
      for (const baseFraction of [0.1, 0.2]) {
        const base = baseFraction * face.jaw.max
        const out = blendFace(face, { speech, baseJaw: base })
        const total = base + out.jaw
        expect(total).toBeLessThanOrEqual(refJaw)
        expect(out.channels.mouth_corner ?? 0).toBeCloseTo(total / face.jaw.max, 9)
        const g = gaps(posed(out.channels, total)), n = g.length
        for (let k = Math.round(n * 0.2); k < Math.round(n * 0.8); k++) expect(Math.abs(g[k]!) / MM, `base ${baseFraction}, pair ${k}`).toBeLessThanOrEqual(0.3)
        // 不告诉它下颌已经张开，唇就合不上 / without being told that the jaw is open already, the lips do not meet
        const blind = blendFace(face, { speech })
        expect(gaps(posed(blind.channels, base + blind.jaw))[midI()]! / MM).toBeGreaterThan(2)
      }
      // 缺省与原来一致；增量不超过剩余的范围 / the default is unchanged; the increment stays within what is left of the range
      expect(blendFace(face, { speech, baseJaw: 0 })).toEqual(blendFace(face, { speech }))
      const wide = blendFace(face, { emotion: { AU27: 5 }, baseJaw: 0.6 * face.jaw.max })
      expect(wide.jaw).toBeCloseTo(0.4 * face.jaw.max, 9)
      expect(wide.channels.mouth_corner).toBeCloseTo(1, 9)
      // 只有 baseJaw、没有表情：口角成形仍按总角 / baseJaw alone, no expression: corner shaping still follows the total
      expect(blendFace(face, { baseJaw: 0.3 * face.jaw.max }).channels.mouth_corner).toBeCloseTo(0.3, 9)
      // 超过 refJaw 时合不上，激活封顶 / beyond refJaw the lips cannot meet and the activation saturates
      expect(blendFace(face, { speech, baseJaw: 0.6 * face.jaw.max }).channels.lip_seal).toBe(1)
    })

    it('narrows and protrudes the lips for rounded vowels, and opens with the jaw for open vowels', () => {
      const w0 = dist(P(rest, O.points.mouthCornerL), P(rest, O.points.mouthCornerR))
      const mid = O.margins.upperLip[midI()]!
      for (const id of ['UW', 'W', 'OW']) {
        const out = visemeAUs(face, { [id]: 1 })
        const pos = posed(out.channels, out.jaw)
        // o 的口比 u 开得大、收得少：只要求收窄 6% / the o is more open and less narrowed than the u: only 6% of narrowing is asked of it
        const narrowing = 1 - dist(P(pos, O.points.mouthCornerL), P(pos, O.points.mouthCornerR)) / w0
        expect(narrowing, id).toBeGreaterThanOrEqual(id === 'OW' ? 0.06 : 0.2)
        expect((pos[mid * 3 + 2]! - rest[mid * 3 + 2]!) / MM, id).toBeGreaterThanOrEqual(2)
      }
      const gapOf = (id: string, ja: number): number => {
        const out = visemeAUs(face, { [id]: 1 }, { jaw: ja })
        return gaps(posed(out.channels, out.jaw))[midI()]!
      }
      // 开口度随下颌角单调增大 / the aperture grows monotonically with the jaw angle
      const g = [0.25, 0.5, 0.75, 1].map((ja) => gapOf('AA', ja))
      for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]! + 1 * MM)
      expect(gapOf('AA', 1)).toBeGreaterThan(gapOf('EH', 1))
      expect(gapOf('EH', 1)).toBeGreaterThan(gapOf('IY', 1))
      expect(visemeAUs(face, { AA: 1 }).jaw).toBeCloseTo(0.5 * face.jaw.max, 6)
      // 展唇的 i 比圆唇的 u 宽 / the spread i is wider than the rounded u
      const wide = (id: string): number => {
        const out = visemeAUs(face, { [id]: 1 })
        const pos = posed(out.channels, out.jaw)
        return dist(P(pos, O.points.mouthCornerL), P(pos, O.points.mouthCornerR))
      }
      expect(wide('IY')).toBeGreaterThan(wide('UW') + 4 * MM)
    })

    it('moves only the tongue with the tongue poses (schematic)', () => {
      for (const id of ['tongue_tip_up', 'tongue_front_up', 'tongue_back_up', 'tongue_low']) {
        const ch = face.channels.find((c) => c.id === id)!
        expect(ch.kind).toBe('tongue')
        expect(ch.fields.length).toBe(1)
        expect(body.byId.get(ch.fields[0]!.part)!.name).toMatch(/^tongue$/i)
      }
      const t = visemeAUs(face, { TDN: 1 })
      expect(t.channels.tongue_tip_up).toBe(1)
      expect(visemeAUs(face, { KG: 1 }).channels.tongue_back_up).toBe(1)
    })

    it('co-articulates a viseme timeline as a pure function following the JALI habits', () => {
      const V = face.visemes!
      // "moot"：M UW T，然后停顿 / "moot": M UW T, then a pause
      const tl = [{ viseme: 'PBM', start: 0.2, end: 0.28 }, { viseme: 'UW', start: 0.28, end: 0.5 }, { viseme: 'TDN', start: 0.5, end: 0.58 }, { viseme: 'SIL', start: 0.58, end: 0.9 }]
      const a = coarticulate(tl, V), b = coarticulate(tl, V)
      expect(a).toEqual(b)
      const at = (t: number): (typeof a.frames)[number] => a.frames[Math.round((t - a.t0) * a.fps)]!
      // 约束：双唇音的时段里闭合为 1，即使圆唇的 UW 已经提前开始 / the constraint: closure is 1 during the bilabial although the rounded UW has already started
      expect(at(0.24).closure).toBe(1)
      expect(at(0.24).lips.UW).toBeGreaterThan(0.9)
      expect(at(0.24).lips.PBM).toBeGreaterThan(0.9)
      // 提前：UW 的唇形在它的音开始之前就有了，下颌的权重还没有到 1 / anticipation: the lip shape of UW is there before its sound starts, while its jaw weight is not yet 1
      expect(at(0.12).lips.UW ?? 0).toBeGreaterThan(0)
      expect(at(0.2).jaw.UW ?? 0).toBeLessThan(0.5)
      // 只动舌的 TDN 不出现在唇的权重里，那段时间唇保持 UW 的形状 / the tongue-only TDN never appears among the lip weights; the lips keep the shape of UW meanwhile
      for (const f of a.frames) expect(f.lips.TDN).toBeUndefined()
      expect(at(0.54).lips.UW).toBe(1)
      expect(at(0.54).jaw.TDN).toBe(1)
      // 相邻的相同视位并成一个 / adjacent identical visemes merge
      const merged = coarticulate([{ viseme: 'AA', start: 0, end: 0.1 }, { viseme: 'AA', start: 0.1, end: 0.2 }], V), single = coarticulate([{ viseme: 'AA', start: 0, end: 0.2 }], V)
      expect(merged).toEqual(single)
      // 很短的塞音不影响下颌 / a very short stop leaves the jaw alone
      const short = coarticulate([{ viseme: 'AA', start: 0, end: 0.2 }, { viseme: 'KG', start: 0.2, end: 0.22 }, { viseme: 'AA', start: 0.22, end: 0.4 }], V)
      for (const f of short.frames) expect(f.jaw.KG).toBeUndefined()
      // 协同发音的输出可以直接交给 visemeAUs / the output goes straight into visemeAUs
      const out = visemeAUs(face, at(0.24))
      expect(out.closure).toBe(1)
      expect(out.channels.lip_seal ?? 0).toBeGreaterThan(0)
      expect(out.channels.lip_protrusion ?? 0).toBeGreaterThan(0.2)
    })

    it('drives the same channels from raw audio features, by the stated rule', () => {
      const frame = (o: Partial<MouthFrame>): MouthFrame => ({ t: 0, open: 0, round: 0, closure: 0, dental: 0, tongue: { low: 0, front: 0, back: 0, tip: 0 }, voiced: true, level: 0.5, confidence: { open: 1, round: 1, closure: 1, dental: 0.1, tongue: 1 }, f1: 0, f2: 0, f3: 0, ...o })
      const chIds = new Set(face.channels.map((c) => c.id))
      const F = face.visemes!.features
      // open → 下颌 / open → jaw
      const open = mouthFrameToChannels(face, frame({ open: 1 }))
      expect(open.jaw).toBeCloseTo(F.openJaw * face.jaw.max, 6)
      for (const c of Object.keys(open.channels)) expect(chIds.has(c), c).toBe(true)
      // 置信度低，幅度按比例减小 / low confidence scales the amplitude down
      const unsure = mouthFrameToChannels(face, frame({ open: 1, confidence: { open: 0.3, round: 1, closure: 1, dental: 0.1, tongue: 1 } }))
      expect(unsure.jaw).toBeCloseTo((0.3 / F.confidenceRef) * F.openJaw * face.jaw.max, 6)
      // round：正为圆唇（前突），负为展唇 / round: positive rounds (protrusion), negative spreads
      const round = mouthFrameToChannels(face, frame({ round: 1 })), spread = mouthFrameToChannels(face, frame({ round: -1 }))
      expect(round.channels.lip_protrusion ?? 0).toBeGreaterThan(0.2)
      expect(spread.channels.lip_protrusion ?? 0).toBe(0)
      expect(spread.channels.risorius_L ?? 0).toBeGreaterThan(0)
      // closure ≥ 0.5：一般的闭唇，幅度 = 置信度比例；低于阈值不闭 / closure ≥ 0.5: a generic lip seal with amplitude = the confidence ratio; nothing below the threshold
      const closed = mouthFrameToChannels(face, frame({ open: 0.3, closure: 0.6, confidence: { open: 1, round: 1, closure: 0.3, dental: 0.1, tongue: 1 } }))
      expect(closed.pose.closure).toBeCloseTo(0.3 / F.confidenceRef, 9)
      expect(closed.channels.lip_seal ?? 0).toBeGreaterThan(0)
      expect(mouthFrameToChannels(face, frame({ open: 0.3, closure: 0.45 })).pose.closure).toBe(0)
      // dental 不使用 / dental is ignored
      const dental = mouthFrameToChannels(face, frame({ dental: 1, confidence: { open: 1, round: 1, closure: 1, dental: 1, tongue: 1 } }))
      expect(dental.pose.dental).toBe(0)
      expect(dental.channels.lip_dental).toBeUndefined()
      // 咝音：下颌收小 / sibilance narrows the jaw
      expect(mouthFrameToChannels(face, frame({ open: 1, tongue: { low: 0, front: 0, back: 0, tip: 1 } })).jaw).toBeCloseTo(0.2 * F.openJaw * face.jaw.max, 6)
      // 一阶平滑：50 ms 后走完约 63% / one-pole smoothing: about 63% of the way after 50 ms
      let state: MouthState | undefined
      state = mouthFrameToChannels(face, frame({ t: 0, open: 0 })).state
      for (let k = 1; k <= 5; k++) state = mouthFrameToChannels(face, frame({ t: k * 0.01, open: 1 }), state).state
      expect(state.open).toBeGreaterThan(0.55)
      expect(state.open).toBeLessThan(0.72)
      // 没有声音时回到静止 / silence returns to rest
      expect(mouthFrameToChannels(face, frame({ open: 1, level: 0 })).jaw).toBe(0)
    })

    it('blends speech over emotion and pain: upper face from the expression, speech constraints win', () => {
      const pain = painAUs(face.pain, 10)
      const speech = visemeAUs(face, { PBM: 1 })
      const alone = activations(face, pain), both = blendFace(face, { speech, pain })
      const upper = new Set(face.aus.filter((a) => UPPER_FACE_AUS.includes(a.id)).flatMap((a) => Object.keys(a.channels)))
      const lower = new Set(face.aus.filter((a) => !UPPER_FACE_AUS.includes(a.id)).flatMap((a) => Object.keys(a.channels)))
      for (const c of upper) if (!lower.has(c)) expect(both.channels[c] ?? 0, c).toBeCloseTo(alone.channels[c] ?? 0, 9)
      expect(both.channels.lip_seal ?? 0).toBeGreaterThan(0)
      expect(both.channels.depressor_labii_inferioris_L ?? 0).toBe(0)
      // 不说话时就是表情本身 / without speech it is the expression itself
      expect(blendFace(face, { pain })).toEqual(alone)
      // 带着疼痛表情说 p：下颌角不超过 lip_seal 的 refJaw 时唇合上 / saying p under the pain face: the lips meet while the jaw stays within lip_seal's refJaw
      const refJaw = face.channels.find((c) => c.id === 'lip_seal')!.refJaw!
      if (both.jaw <= refJaw) {
        const g = gaps(posed(both.channels, both.jaw)), n = g.length
        for (let k = Math.round(n * 0.3); k < Math.round(n * 0.7); k++) expect(Math.abs(g[k]!) / MM, `pair ${k}`).toBeLessThanOrEqual(1.5)
      }
    })
  })
}
