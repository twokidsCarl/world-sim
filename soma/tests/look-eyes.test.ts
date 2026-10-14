// 写实的眼：拟合到扫描眼球上的球心和半径、构造的角膜、注视的限幅与集合、睑随注视、地址参数 iris / gaze。
// The lifelike eyes: centre and radius fitted to the scanned eyeball, the constructed cornea, gaze clamping and vergence,
// lids following gaze, and the iris / gaze URL parameters.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../src/face/types.ts'
import { lidGazeChannels } from '../src/face/driver.ts'
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
    expect(Object.keys(down)).toEqual(['orbicularis_oculi_palpebral_upper_R'])
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
