// 女性盆腔韧带的校验：两端重配（pelvicLigaments.ts）的单元测试，以及对输出 GLB 中成品几何的检查。
// 尚未构建时后者跳过。
// Checks of the female pelvic ligaments: unit tests of the two-end re-fit (pelvicLigaments.ts) and
// checks on the finished geometry in the written GLBs. The latter are skipped when the body has not
// been built.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { signedVolume, topology } from '../tools/pipeline/meshRepair.ts'
import { endVertices, ligamentAxis, obstacleOf, pathLength, relayAlongPath, resamplePath, rotationBetween, tautPath, type Vec3 } from '../tools/pipeline/pelvicLigaments.ts'
import { LIGAMENT_MIN_LENGTH_RATIO, minGap, PERITONEAL_SHEET, TWO_END_LIGAMENT } from '../tools/pipeline/pelvis.ts'

// SOMA_FEMALE_DIR：改为校验另一个目录里的构建（管线的 --out） / SOMA_FEMALE_DIR: validate a build in another directory instead (the pipeline's --out)
const DIR = process.env.SOMA_FEMALE_DIR ?? join(import.meta.dirname, '../public/anatomy/female')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))

/** 沿 x 轴的一条封闭的带：长 L，截面 w × h，分成 n 段 / a closed strap along x: length L, cross-section w × h, in n segments */
function strap(L: number, w: number, h: number, n = 40): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const x = (L * i) / n
    pos.push(x, -h / 2, -w / 2, x, h / 2, -w / 2, x, h / 2, w / 2, x, -h / 2, w / 2)
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) {
    const a = 4 * i + k
    const b = 4 * i + ((k + 1) % 4)
    idx.push(a, b, a + 4, b, b + 4, a + 4)
  }
  idx.push(0, 2, 1, 0, 3, 2)
  const e = 4 * n
  idx.push(e, e + 1, e + 2, e, e + 2, e + 3)
  const m: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
  if (signedVolume(m) < 0) for (let t = 0; t < m.indices.length; t += 3) [m.indices[t + 1], m.indices[t + 2]] = [m.indices[t + 2]!, m.indices[t + 1]!]
  return m
}

/** 细分的八面体（近似球） / a subdivided octahedron (a rough sphere) */
function ball(c: Vec3, r: number, levels = 3): Mesh {
  let pos = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]
  let idx = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>()
    const m = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`
      let v = mid.get(k)
      if (v === undefined) {
        v = pos.length / 3
        const p = [0, 1, 2].map((i) => pos[3 * a + i]! + pos[3 * b + i]!)
        const n = Math.hypot(p[0]!, p[1]!, p[2]!)
        pos.push(p[0]! / n, p[1]! / n, p[2]! / n)
        mid.set(k, v)
      }
      return v
    }
    const next: number[] = []
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, d] = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
      const [ab, bd, da] = [m(a, b), m(b, d), m(d, a)]
      next.push(a, ab, da, ab, b, bd, da, bd, d, ab, bd, da)
    }
    idx = next
  }
  pos = pos.map((v, i) => c[i % 3]! + r * v)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

describe('two-end re-fit of a ligament (pelvicLigaments.ts)', () => {
  it('finds the axis, the ends and the length of a strap', () => {
    const s = strap(0.08, 0.009, 0.001)
    const ax = ligamentAxis(s)
    expect(Math.abs(ax.axis[0])).toBeGreaterThan(0.999)
    expect(ax.length).toBeCloseTo(0.08, 3)
    expect(ax.hi - ax.lo).toBeCloseTo(0.08, 3)
    const lo = endVertices(s, ax, 'lo')
    expect(lo.length).toBeGreaterThan(0)
    const lowEndX = ax.axis[0] > 0 ? 0 : 0.08
    for (let i = 0; i < lo.length; i += 3) expect(Math.abs(lo[i]! - lowEndX)).toBeLessThan(0.08 * 0.081)
  })

  it('rotates one direction onto another and resamples a path evenly', () => {
    const R = rotationBetween([1, 0, 0], [0, 0.6, 0.8])
    expect(R[0]).toBeCloseTo(0, 9)
    expect(R[3]).toBeCloseTo(0.6, 9)
    expect(R[6]).toBeCloseTo(0.8, 9)
    const p = resamplePath([[0, 0, 0], [0.01, 0, 0], [0.01, 0.03, 0]], 9)
    expect(pathLength(p)).toBeCloseTo(0.04, 6)
    for (let i = 1; i < p.length; i++) expect(Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1])).toBeLessThan(0.0051)
  })

  it('shortens a strap to a shorter span without folding, both ends where they were asked to be', () => {
    const s = strap(0.08, 0.009, 0.001)
    const ax = ligamentAxis(s)
    const start: 'lo' | 'hi' = ax.axis[0] > 0 ? 'lo' : 'hi'
    const to: Vec3 = [0.02, 0.03, 0.01]
    const fit = relayAlongPath(s, ax, start, [[0, 0, 0], to])
    expect(fit.nativeLength).toBeCloseTo(0.08, 3)
    expect(fit.newLength).toBeCloseTo(Math.hypot(...to), 6)
    expect(fit.lengthRatio).toBeCloseTo(Math.hypot(...to) / 0.08, 2)
    expect(fit.foldedAreaShare).toBe(0)
    expect(topology(fit.mesh).watertight).toBe(true)
    expect(signedVolume(fit.mesh)).toBeGreaterThan(0)
    // 截面不变，所以体积按长度比例缩小 / the cross-section is kept, so the volume shrinks with the length
    expect(signedVolume(fit.mesh) / signedVolume(s)).toBeCloseTo(fit.lengthRatio, 1)
    const p = fit.mesh.positions
    let nearStart = Infinity
    let nearEnd = Infinity
    for (let i = 0; i < p.length; i += 3) {
      nearStart = Math.min(nearStart, Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!))
      nearEnd = Math.min(nearEnd, Math.hypot(p[i]! - to[0], p[i + 1]! - to[1], p[i + 2]! - to[2]))
    }
    expect(nearStart).toBeLessThan(0.006)
    expect(nearEnd).toBeLessThan(0.006)
  })

  it('reports a fold when a wide sheet is re-laid round too tight a bend', () => {
    const s = strap(0.06, 0.04, 0.001, 60)
    const ax = ligamentAxis(s)
    const fit = relayAlongPath(s, ax, 'lo', [[0, 0, 0], [0.004, 0, 0], [0.004, 0, 0.004], [0, 0, 0.004], [0, 0, 0.008]])
    expect(fit.foldedAreaShare).toBeGreaterThan(0.02)
  })

  it('draws a taut path round an obstacle on the side it is told to take', () => {
    const b = ball([0, 0, 0], 0.01)
    const from: Vec3 = [-0.03, 0, 0.001]
    const to: Vec3 = [0.03, 0, 0.001]
    for (const side of [1, -1]) {
      const path = tautPath(from, to, [obstacleOf(b)], { clearance: 0.002, escape: [0, 0, side] })
      expect(path.nodesInside).toBe(0)
      expect(path.straight).toBeCloseTo(0.06, 6)
      expect(path.length).toBeGreaterThan(0.061)
      expect(path.length).toBeLessThan(0.075)
      const mid = path.points[Math.floor(path.points.length / 2)]!
      expect(Math.sign(mid[2])).toBe(side)
      // 最后的平滑允许回到一半间隙处 / the last smoothing may come back to half the clearance
      expect(Math.hypot(mid[0], mid[1], mid[2])).toBeGreaterThan(0.0108)
    }
    // 没有障碍时就是直线 / a straight line when nothing is in the way
    const free = tautPath(from, to, [], { clearance: 0.002, escape: [0, 0, 1] })
    expect(free.length).toBeCloseTo(0.06, 6)
  })
})

describe.skipIf(!present)('female pelvic ligaments as shipped', async () => {
  const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : null) as Record<string, any>
  const body = present ? await loadBuiltBody(DIR) : null
  const idOf = new Map<string, string>()
  if (present) for (const p of data.parts) if (!idOf.has(p.name)) idOf.set(p.name, p.id)
  const get = (k: string): Mesh | null => body!.meshes.get(k) ?? body!.meshes.get(idOf.get(k) ?? '') ?? null
  const lig = present ? report.pelvis.pelvicLigaments : null
  const rows: any[] = lig?.parts ?? []
  const shipped = rows.filter((r) => r.shipped)

  it('judges every HRA ligament of the uterus and ovaries, and ships exactly those it accepted', () => {
    expect(rows.filter((r) => TWO_END_LIGAMENT.test(r.id)).length).toBe(6)
    expect(rows.filter((r) => PERITONEAL_SHEET.test(r.id)).length).toBe(3)
    const ids = new Set(data.parts.map((p) => p.id))
    for (const r of rows) {
      expect(ids.has(r.id), r.id).toBe(!!r.shipped)
      if (!r.shipped) expect(String(r.reason).length, r.id).toBeGreaterThan(20)
    }
    expect(lig.shipped.slice().sort()).toEqual(shipped.map((r) => r.id).sort())
    // 没有输出的都列在 dropped 里（最后的说明文字由它生成） / what is not shipped is listed under dropped (the cautions are written from it)
    const gone = new Set(report.pelvis.dropped.map((d: { id: string }) => d.id))
    for (const r of rows) expect(gone.has(r.id), r.id).toBe(!r.shipped)
    expect(shipped.length).toBeGreaterThanOrEqual(1)
  })

  it('has both ends of every shipped ligament on what it attaches to, at a length it can defend', () => {
    const uterus = get('WU_uterine_wall')!
    for (const r of shipped) {
      const m = get(r.id)!
      expect(m, r.id).toBeTruthy()
      const part = data.parts.find((p) => p.id === r.id)!
      expect(part.provenance).toBe('curated')
      expect(r.lengthRatio, r.id).toBeGreaterThanOrEqual(LIGAMENT_MIN_LENGTH_RATIO)
      expect(r.lengthRatio, r.id).toBeLessThanOrEqual(1.5)
      expect(r.newLengthMm, r.id).toBeGreaterThanOrEqual(r.spanMm - 0.2)
      expect(r.foldedAreaPct, r.id).toBeLessThanOrEqual(2)
      expect(r.pathNodesInsideOrgans, r.id).toBe(0)
      expect(r.insideSolidsPct, r.id).toBeLessThanOrEqual(5)
      for (const e of Object.values(r.ends) as { gapAfterMm: number }[]) expect(e.gapAfterMm, r.id).toBeLessThanOrEqual(3)
      expect(String(r.note)).toMatch(/re-fitted by its two ends/)
      // 成品几何上再量一遍：到子宫、到骶骨或同侧盆壁 / measured again on the shipped geometry: to the uterus, and to the sacrum or the pelvic wall of its side
      if (r.kind !== 'ovarian') expect(minGap(m, uterus, 0.001) * 1000, `${r.id} to uterus`).toBeLessThan(3)
      if (r.kind === 'uterosacral') expect(minGap(m, get('Sacrum')!, 0.0015) * 1000, `${r.id} to sacrum`).toBeLessThan(4)
      if (r.kind === 'cardinal') {
        const side = /left/.test(r.id) ? 'Left' : 'Right'
        expect(Math.min(minGap(m, get(`${side} hip bone`)!, 0.0015), minGap(m, get(`${side} obturator internus`)!, 0.0015)) * 1000, `${r.id} to wall`).toBeLessThan(4)
      }
      // 长度：成品的主轴长度不短于两个附着点之间的直线距离的九成 / length: the shipped part's axis is not shorter than nine tenths of the straight span between its attachments
      expect(ligamentAxis(m).length * 1000, r.id).toBeGreaterThan(0.9 * r.spanMm)
      // 左侧的韧带在左（+X） / a left ligament lies on the left (+X)
      if (r.kind === 'cardinal') expect(Math.sign(part.centroid[0] - uterusX(uterus)), r.id).toBe(/left/.test(r.id) ? 1 : -1)
    }
  })

  it('leaves out the broad ligament and mesosalpinges with the measured reason, and records why the uterus stays', () => {
    const per = lig.peritoneum
    expect(per).toBeTruthy()
    for (const side of ['L', 'R']) {
      const s = per.sides[side]
      expect(s.areaCm2).toBeGreaterThan(20)
      // 子宫外侧的腹膜面大半贴在输卵管、卵巢等器官上 / most of the peritoneal surface lateral to the uterus lies on tube, ovary and the like
      expect(s.freePct).toBeLessThan(50)
      expect(s.tubeToOvaryGapMm).toBeLessThan(2)
    }
    const names = new Set(data.parts.map((p) => p.name))
    expect(names.has('Broad ligament of uterus')).toBe(false)
    const ub = report.pelvis.uterusBladder
    expect(ub.gapMm).toBeCloseTo(report.pelvisChecks.gapsMm['uterus–bladder'], 0)
    expect(ub.trialAnteversionAboutIsthmus.length).toBe(3)
    expect(ub.nearestPointAtUterineHeightFraction).toBeLessThan(ub.isthmusTakenAtHeightFraction)
    const rv = report.pelvis.rectovaginal
    expect(rv.septumPresent).toBe(true)
    expect(rv.rectalWallAreaMm2.within1mm).toBeLessThan(rv.rectalWallAreaMm2.within2mm / 10)
  })
})

function uterusX(m: Mesh): number {
  let s = 0
  for (let i = 0; i < m.positions.length; i += 3) s += m.positions[i]!
  return s / (m.positions.length / 3)
}
