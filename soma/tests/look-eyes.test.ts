// 写实的眼：拟合到扫描眼球上的球心和半径、构造的角膜、注视的限幅与集合、睑随注视、地址参数 iris / gaze。
// The lifelike eyes: centre and radius fitted to the scanned eyeball, the constructed cornea, gaze clamping and vergence,
// lids following gaze, and the iris / gaze URL parameters.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../src/face/types.ts'
import { addBlink, applyLidDrop, lidGains, lidGazeChannels } from '../src/face/driver.ts'
import { displacePart, indexFace } from '../src/pain/face.ts'
import { BLINK, BLINK_SECONDS, EyeLife, MICROSACCADE, blinkCurve, pupilForPain, pupilTarget } from '../src/look/eyesLife.ts'
import { EYE, GAZE_LIMITS, clampGaze, eyeAngles, eyeShape, fitEye, fitSphere, fixedTarget, gazeAngles, gazeDirection, gazeRotation, lidTravel, m3apply, surfaceRadius, type V3 } from '../src/look/eyesFit.ts'
import { buildEyeGeometry, lidCurves } from '../src/look/eyes.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'

const ROOT = resolve(import.meta.dirname, '..')
const MM = 0.001
const BODIES = ['male', 'female'] as const

async function scannedEyes(body: string) {
  const dir = resolve(ROOT, 'public/anatomy', body)
  const data = JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData
  const pick = (side: string, re: RegExp) => data.parts.find((p) => p.side === side && re.test(p.name))
  const wanted = (['L', 'R'] as const).map((side) => ({ side, sclera: pick(side, /^(left|right) sclera$/i)!, cornea: pick(side, /^(left|right) cornea$/i)! }))
  const meshes = await readGlbParts(resolve(dir, 'nervous.glb'), new Set(wanted.flatMap((w) => [w.sclera.id, w.cornea.id])))
  return wanted.map((w) => ({ ...w, scleraMesh: meshes.get(w.sclera.id)!, corneaMesh: meshes.get(w.cornea.id)! }))
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

describe('sphere fit', () => {
  it('recovers an exact sphere', () => {
    const c: V3 = [0.03, 1.5, 0.15], r = 0.012
    const p: number[] = []
    for (let i = 0; i < 200; i++) {
      const u = Math.acos(1 - (2 * (i + 0.5)) / 200), v = i * 2.399963
      p.push(c[0] + r * Math.sin(u) * Math.cos(v), c[1] + r * Math.sin(u) * Math.sin(v), c[2] + r * Math.cos(u))
    }
    const f = fitSphere(p)
    expect(dist(f.centre, c)).toBeLessThan(1e-9)
    expect(Math.abs(f.radius - r)).toBeLessThan(1e-9)
    expect(f.rms).toBeLessThan(1e-9)
  })
})

describe.each(BODIES)('eyes fitted to the scanned eyeballs (%s)', (body) => {
  it('centres lie inside the scanned sclera and radii in the literature range', async () => {
    for (const e of await scannedEyes(body)) {
      const f = fitEye(e.side, e.scleraMesh.positions, e.corneaMesh.positions)
      const b = e.sclera.bbox
      // 球心在巩膜的包围盒里，离每个巩膜顶点都远远大于零（在壳里面）/ the centre is inside the sclera's bounding box and well away from every scleral vertex (inside the shell)
      for (let k = 0; k < 3; k++) {
        expect(f.centre[k]).toBeGreaterThan(b[k]!)
        expect(f.centre[k]).toBeLessThan(b[k + 3]!)
      }
      let nearest = Infinity
      const p = e.scleraMesh.positions
      for (let i = 0; i < p.length; i += 3) nearest = Math.min(nearest, dist([p[i]!, p[i + 1]!, p[i + 2]!], f.centre))
      expect(nearest).toBeGreaterThan(0.6 * f.radius)
      // 半径：横径 21–27 mm（Bekerman 2014），离平均 24.2 mm 不超过 1 mm / radius: transverse diameter 21–27 mm (Bekerman 2014), within 1 mm of the 24.2 mm mean
      expect(f.scanRadius).toBeGreaterThan(EYE.radiusRange[0])
      expect(f.scanRadius).toBeLessThan(EYE.radiusRange[1])
      expect(Math.abs(f.radius - EYE.radiusMean)).toBeLessThan(1 * MM)
      // 光轴大致朝前 / the axis points roughly forward
      expect(f.axis[2]).toBeGreaterThan(0.95)
      // 构造的角膜顶点离扫描的角膜顶点不超过 2 mm / the constructed corneal apex is within 2 mm of the scanned one
      const s = eyeShape(f.radius)
      const apex = f.axis.map((a, k) => f.centre[k]! + a * s.apex)
      expect(dist(apex, f.apex!)).toBeLessThan(2 * MM)
    }
  })

  it('the lid margins of the openings data give four curves', () => {
    const o = JSON.parse(readFileSync(resolve(ROOT, 'public/anatomy', body, 'face/openings.json'), 'utf8')) as FaceOpenings
    const curves = lidCurves(o)
    expect(curves.map((c) => `${c.side}${c.upper ? 'u' : 'l'}`).sort()).toEqual(['Ll', 'Lu', 'Rl', 'Ru'])
    // 睑缘顶点都换成了内卷顶点 / every margin vertex was replaced by its rim vertex
    const rim = new Set(o.lidRims.flatMap((r) => r.vertices))
    for (const c of curves) expect(c.vertices.every((v) => rim.has(v))).toBe(true)
  })
})

describe('the constructed eye', () => {
  it('the cornea meets the sclera at the limbus and bulges by about a millimetre', () => {
    const s = eyeShape(12 * MM)
    expect(s.limbus).toBeCloseTo(11.71 / 2 * MM, 6)
    expect(surfaceRadius(s, s.thetaLimbus - 1e-6)).toBeCloseTo(s.radius, 6)
    expect(s.apex - s.radius).toBeGreaterThan(0.5 * MM)
    expect(s.apex - s.radius).toBeLessThan(2.5 * MM)
    // 瞳孔离转动中心约 10 mm / the pupil sits about 10 mm from the centre of rotation
    expect(s.pupilDistance).toBeGreaterThan(9 * MM)
    expect(s.pupilDistance).toBeLessThan(11.5 * MM)
  })

  it('the mesh stays small', () => {
    const g = buildEyeGeometry({ side: 'L', centre: [0, 0, 0], radius: 12 * MM, scanRadius: 12 * MM, rms: 0, axis: [0, 0, 1], apex: null }, eyeShape(12 * MM))
    const tris = g.index!.count / 3
    expect(tris).toBeGreaterThan(1000)
    expect(tris).toBeLessThan(5000)
  })
})

describe('gaze', () => {
  const centres: V3[] = [[0.03, 1.5, 0.15], [-0.03, 1.5, 0.15]]

  it('angles and directions agree, and the rotation turns the axis onto the gaze', () => {
    const d = gazeDirection(20, -10)
    const g = gazeAngles(d)
    expect(g.yaw).toBeCloseTo(20, 6)
    expect(g.pitch).toBeCloseTo(-10, 6)
    const axis: V3 = [0.1, -0.05, 0.99]
    const r = m3apply(gazeRotation(20, -10, axis), [axis[0] / Math.hypot(...axis), axis[1] / Math.hypot(...axis), axis[2] / Math.hypot(...axis)])
    for (let k = 0; k < 3; k++) expect(r[k]).toBeCloseTo(d[k]!, 6)
  })

  it('is clamped to the physiological range', () => {
    expect(clampGaze({ yaw: 80, pitch: 50 })).toEqual({ yaw: GAZE_LIMITS.yaw, pitch: GAZE_LIMITS.up })
    expect(clampGaze({ yaw: -80, pitch: -60 })).toEqual({ yaw: -GAZE_LIMITS.yaw, pitch: -GAZE_LIMITS.down })
    // 稍稍超出范围：停在极限 / a little beyond the range: held at the limit
    const side = eyeAngles(centres, [1.0, 1.5, 0.8])
    for (const a of side) expect(a.yaw).toBe(GAZE_LIMITS.yaw)
    // 在头后：回到正前方 / behind the head: back to straight ahead
    expect(eyeAngles(centres, [0, 1.5, -1])).toEqual([{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }])
  })

  it('both eyes converge on a near target', () => {
    const d = 0.3
    const [l, r] = eyeAngles(centres, [0, 1.5, 0.15 + d])
    // 左眼（+x）向内看 = 负的 yaw；右眼相反；大小 = atan(半瞳距 / 距离) / the left eye (+x) turns in = negative yaw; the right the opposite; size = atan(half the separation / distance)
    const want = (Math.atan(0.03 / d) * 180) / Math.PI
    expect(l!.yaw).toBeCloseTo(-want, 6)
    expect(r!.yaw).toBeCloseTo(want, 6)
    // 固定角度：双眼都差不多朝那个方向，集合很小 / fixed angles: both eyes point about that way, with little vergence
    const t = fixedTarget(centres, 20, 10)
    for (const a of eyeAngles(centres, t)) {
      expect(Math.abs(a.yaw - 20)).toBeLessThan(1.5)
      expect(Math.abs(a.pitch - 10)).toBeLessThan(0.5)
    }
  })

  it('the lids follow vertical gaze', () => {
    const pd = 10 * MM
    expect(lidTravel(0, pd)).toEqual({ upper: 0, lower: 0 })
    // −30°：瞳孔下移 5 mm，上睑到瞳孔的距离又少了 1 mm / −30°: the pupil drops 5 mm and the upper margin closes 1 mm more on it
    expect(lidTravel(-30, pd).upper).toBeCloseTo(-5 - 1.0, 6)
    // +30°：上睑跟着上去，但比瞳孔少 1.55 mm / +30°: the upper lid goes up, 1.55 mm less than the pupil
    expect(lidTravel(30, pd).upper).toBeCloseTo(5 - 1.55, 6)
    expect(lidTravel(30, pd).lower).toBeCloseTo(5 - 2.4, 6)
    const face = JSON.parse(readFileSync(resolve(ROOT, 'public/anatomy/male/face.json'), 'utf8')) as FaceData
    const up = lidGazeChannels(face, [{ side: 'L', pitch: 20, pupilDistance: pd }])
    expect(up['levator_palpebrae_L']).toBeGreaterThan(0)
    expect(up['levator_palpebrae_L']).toBeLessThanOrEqual(1)
    expect(up['orbicularis_oculi_palpebral_lower_L']).toBeGreaterThan(0)
    const down = lidGazeChannels(face, [{ side: 'R', pitch: -20, pupilDistance: pd }])
    // 向下看：上睑用闭合通道，下睑用反过来的下睑场（伪通道）/ looking down: the closing channel for the upper lid, the lower-lid field reversed (a pseudo-channel) for the lower
    expect(Object.keys(down).sort()).toEqual(['drop:orbicularis_oculi_palpebral_lower_R', 'orbicularis_oculi_palpebral_upper_R'])
    expect(lidGazeChannels(face, [{ side: 'L', pitch: 0, pupilDistance: pd }])).toEqual({})
  })
})

describe('iris and gaze in the URL', () => {
  it('round-trips and leaves the defaults out', () => {
    const p = parseUrl('?skin=1&iris=blue&gaze=20,-10')
    expect(p.warnings).toEqual([])
    expect(p.state.iris).toBe('blue')
    expect(p.state.gaze).toEqual({ yaw: 20, pitch: -10 })
    const q = formatUrl(p.state, [])
    expect(q).toContain('iris=blue')
    expect(q).toContain('gaze=20,-10')
    expect(parseUrl(`?${q}`).state).toMatchObject({ iris: 'blue', gaze: { yaw: 20, pitch: -10 } })
    expect(formatUrl({ skin: true, iris: 'brown', gaze: 'camera' }, [])).toBe('skin=1')
    expect(parseUrl('?gaze=c').state.gaze).toBe('camera')
  })

  it('clamps out-of-range angles and warns on bad values', () => {
    expect(parseUrl('?gaze=90,-80').state.gaze).toEqual({ yaw: GAZE_LIMITS.yaw, pitch: -GAZE_LIMITS.down })
    expect(parseUrl('?gaze=left').warnings.length).toBe(1)
    expect(parseUrl('?iris=purple').warnings.length).toBe(1)
  })
})

describe.each(BODIES)('the fissure follows vertical gaze (%s)', (body) => {
  it('narrows in down-gaze about as Mastropietro et al. 2009 measured', async () => {
    const dir = resolve(ROOT, 'public/anatomy', body)
    const data = JSON.parse(readFileSync(resolve(dir, 'face.json'), 'utf8')) as FaceData
    const face = indexFace(data, new Uint8Array(readFileSync(resolve(dir, 'face.bin'))))
    const o = JSON.parse(readFileSync(resolve(dir, 'face/openings.json'), 'utf8')) as FaceOpenings
    const skin = (await readGlbParts(resolve(dir, 'integumentary.glb'), new Set([o.skin]))).get(o.skin)!
    for (const e of await scannedEyes(body)) {
      const fit = fitEye(e.side, e.scleraMesh.positions, e.corneaMesh.positions)
      const gains = lidGains(face, o.skin, o.margins, skin.positions, [{ side: e.side, x: fit.centre[0] }])
      const fissure = (pitch: number): number => {
        const ch = lidGazeChannels(data, [{ side: e.side, pitch, pupilDistance: eyeShape(fit.radius).pupilDistance }], gains)
        const out = new Float32Array(skin.positions.length)
        displacePart(face, o.skin, skin.positions, ch, out)
        applyLidDrop(face, o.skin, ch, out)
        const near = (list: number[]) => list.reduce((b, v) => (Math.abs(out[v * 3]! - fit.centre[0]) < Math.abs(out[b * 3]! - fit.centre[0]) ? v : b), list[0]!)
        return out[near(o.margins[`upperLid${e.side}`]) * 3 + 1]! - out[near(o.margins[`lowerLid${e.side}`]) * 3 + 1]!
      }
      const f0 = fissure(0)
      // 文献：睑裂 10.8 mm → −20° 时 8.7 mm、−30° 时 7.8 mm / literature: fissure 10.8 mm → 8.7 mm at −20°, 7.8 mm at −30°
      expect(Math.abs(fissure(-20) / f0 - 8.7 / 10.8)).toBeLessThan(0.06)
      // 女性下睑的场每单位只动约 1.3 mm，反用到两倍（LID_DROP_MAX）还差一点：−30° 时比文献窄约 15% / the female lower-lid field moves only about 1.3 mm per unit, and reversed up to twice (LID_DROP_MAX) it falls a little short: about 15% narrower than the literature at −30°
      if (body === 'male') expect(Math.abs(fissure(-30) / f0 - 7.8 / 10.8)).toBeLessThan(0.05)
      else expect(fissure(-30) / f0).toBeGreaterThan(0.58)
      // 向上看时睑裂变大 / looking up the fissure widens
      expect(fissure(20)).toBeGreaterThan(f0)
    }
  })
})

describe('blinks, microsaccades and the pupil', () => {
  it('the blink schedule is deterministic for a seed', () => {
    const a = new EyeLife(7), b = new EyeLife(7), c = new EyeLife(8)
    const ts = Array.from({ length: 400 }, (_, i) => i * 0.3)
    expect(ts.map((t) => a.blinkAt(t))).toEqual(ts.map((t) => b.blinkAt(t)))
    expect(ts.map((t) => a.offsetAt(t))).toEqual(ts.map((t) => b.offsetAt(t)))
    expect(c.blinkAt(119)).toBeGreaterThanOrEqual(0)
    expect(c.blinks.slice(0, 5)).not.toEqual(a.blinks.slice(0, 5))
    // 查询的次序不改变结果 / the order of queries does not change the result
    const d = new EyeLife(7)
    d.blinkAt(100)
    expect(ts.map((t) => d.blinkAt(t))).toEqual(ts.map((t) => a.blinkAt(t)))
  })

  it('blinks come at the cited rate, never closer than the minimum interval', () => {
    const life = new EyeLife(1)
    life.blinkAt(1200)
    const n = life.blinks.filter((t) => t < 1200).length
    expect(n / 20).toBeGreaterThan(BLINK.ratePerMin - 2)
    expect(n / 20).toBeLessThan(BLINK.ratePerMin + 2)
    for (let i = 1; i < life.blinks.length; i++) expect(life.blinks[i]! - life.blinks[i - 1]!).toBeGreaterThanOrEqual(BLINK.minInterval)
  })

  it('a blink closes faster than it opens and lasts about 0.3 s', () => {
    expect(blinkCurve(0)).toBe(0)
    expect(blinkCurve(BLINK.close + BLINK.closed / 2)).toBe(1)
    expect(blinkCurve(BLINK_SECONDS + 0.01)).toBe(0)
    expect(BLINK_SECONDS).toBeCloseTo(0.3, 6)
    const speed = (t0: number, t1: number): number => {
      let m = 0
      for (let t = t0; t < t1; t += 0.001) m = Math.max(m, Math.abs(blinkCurve(t + 0.001) - blinkCurve(t)) / 0.001)
      return m
    }
    // Kwon 2013：峰速 243 对 157 mm/s，约 1.5 倍 / Kwon 2013: peak speeds 243 against 157 mm/s, about 1.5 times
    expect(speed(0, BLINK.close) / speed(BLINK.close + BLINK.closed, BLINK_SECONDS)).toBeCloseTo(1.5, 1)
  })

  it('microsaccades stay within half a degree', () => {
    const life = new EyeLife(3)
    for (let t = 0; t < 60; t += 0.05) {
      const o = life.offsetAt(t)
      expect(Math.hypot(o.yaw, o.pitch)).toBeLessThanOrEqual(MICROSACCADE.bound + 1e-9)
    }
    expect(life.saccades.filter((s) => s.t < 60).length / 60).toBeGreaterThan(0.6)
  })

  it('a blink merges with the expression by maximum', () => {
    const face = JSON.parse(readFileSync(resolve(ROOT, 'public/anatomy/male/face.json'), 'utf8')) as FaceData
    const ch = addBlink({ orbicularis_oculi_palpebral_upper_L: 0.9 }, face, 0.5)
    expect(ch['orbicularis_oculi_palpebral_upper_L']).toBe(0.9)
    expect(ch['orbicularis_oculi_palpebral_upper_R']).toBe(0.5)
    expect(addBlink({}, face, 1)['orbicularis_oculi_palpebral_upper_L']).toBe(1)
    expect(addBlink({}, face, 0)).toEqual({})
  })

  it('the pupil follows the pain model', () => {
    expect(pupilForPain(0)).toBeCloseTo(4 * MM, 9)
    // 参考强度 6 时扩大 28% / 28% wider at the reference intensity 6
    expect(pupilForPain(6)).toBeCloseTo(4 * 1.28 * MM, 9)
    expect(pupilForPain(100)).toBe(EYE.pupilRange[1])
    expect(pupilTarget({ pain: { level: 7, hold: true }, stimNow: null })).toEqual({ target: pupilForPain(7), direct: false })
    expect(pupilTarget({ pain: { level: 7, hold: false }, stimNow: null }).target).toBeCloseTo(4 * MM, 9)
    expect(pupilTarget({ pain: { level: 0, hold: false }, stimNow: { running: true, sample: { autonomic: { pupil: 4.6 } } } })).toEqual({ target: 4.6 * MM, direct: true })
    // 扩大快、回缩慢 / widening is fast, narrowing slow
    const life = new EyeLife(1)
    const up = life.stepPupil(0.3, 6 * MM)
    const life2 = new EyeLife(1)
    life2.stepPupil(0, 6 * MM)
    const down = life2.stepPupil(0.3, 4 * MM)
    expect((up - 4 * MM) / (2 * MM)).toBeGreaterThan((6 * MM - down) / (2 * MM))
  })

  it('blink=0 round-trips', () => {
    const p = parseUrl('?skin=1&blink=0')
    expect(p.state.blink).toBe(false)
    expect(formatUrl(p.state, [])).toBe('skin=1&blink=0')
    expect(parseUrl('?blink=1').state.blink).toBeUndefined()
    expect(parseUrl('?blink=x').warnings.length).toBe(1)
  })
})
