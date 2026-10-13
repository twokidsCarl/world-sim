// 女性下肢和腹股沟的校验：腱的拼接封口、腹股沟的修剪和落底、神经在肌内走行的分类与移出（单元测试），
// 以及对构建输出的数值检查（没有构建或构建早于这些步骤时跳过）。
// Checks of the female leg and groin work: capping of spliced tendons, trimming and seating in the
// groin, classification and clearing of nerve courses inside muscles (unit tests), and numeric checks
// on a build's output (skipped when there is no build or it predates these steps).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { elevationDeg, TOES } from '../tools/pipeline/foot.ts'
import { buildFemoralSeat, pubicTubercle, trimLabialRun } from '../tools/pipeline/groin.ts'
import { classifyCourse, isRealPart, nerveCourseReport, SolidTester, trunkIndex } from '../tools/pipeline/nerveCourse.ts'
import { PointIndex, surfacePoints, thinPoints } from '../tools/pipeline/register.ts'
import { capOpenLoops, spliceTendons } from '../tools/pipeline/splice.ts'
import type { Polyline } from '../tools/pipeline/tube.ts'

const ROOT = join(import.meta.dirname, '..')
// SOMA_FEMALE_DIR：改为校验另一个目录里的构建（管线的 --out） / SOMA_FEMALE_DIR: validate a build in another directory instead (the pipeline's --out)
const DIR = process.env.SOMA_FEMALE_DIR ?? join(ROOT, 'public/anatomy/female')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))
const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : {}) as Record<string, any>
const built = present && !!report.groin && !!report.nerveCourse

/** 沿 Y 轴的管，两端可选封口 / a tube along Y, optionally capped at either end */
function tube(r: number, y0: number, y1: number, cx = 0, cz = 0, caps: [boolean, boolean] = [true, true], seg = 24, rings = 30): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let j = 0; j <= rings; j++) for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg
    pos.push(cx + r * Math.cos(a), y0 + ((y1 - y0) * j) / rings, cz + r * Math.sin(a))
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * seg + i
    const b = j * seg + ((i + 1) % seg)
    idx.push(a, a + seg, b, b, a + seg, b + seg)
  }
  const c0 = pos.length / 3
  pos.push(cx, y0, cz, cx, y1, cz)
  for (let i = 0; i < seg; i++) {
    if (caps[0]) idx.push(c0, i, (i + 1) % seg)
    if (caps[1]) idx.push(c0 + 1, rings * seg + ((i + 1) % seg), rings * seg + i)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** 只属于一个三角形的边数（按位置合并顶点后）/ edges used by one triangle only (vertices merged by position) */
function openEdges(m: Mesh): number {
  const key = new Map<string, number>()
  const id: number[] = []
  for (let i = 0; i < m.positions.length; i += 3) {
    const k = `${Math.round(m.positions[i]! * 1e5)},${Math.round(m.positions[i + 1]! * 1e5)},${Math.round(m.positions[i + 2]! * 1e5)}`
    if (!key.has(k)) key.set(k, key.size)
    id.push(key.get(k)!)
  }
  const e = new Map<string, number>()
  for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = id[m.indices[t + k]!]!
    const b = id[m.indices[t + ((k + 1) % 3)]!]!
    if (a === b) continue
    const kk = a < b ? `${a}_${b}` : `${b}_${a}`
    e.set(kk, (e.get(kk) ?? 0) + 1)
  }
  let open = 0
  for (const c of e.values()) if (c === 1) open++
  return open
}

const line = (pts: number[][], r = 0.001): Polyline => ({ points: Float32Array.from(pts.flat()), radius: Float32Array.from(pts.map(() => r)) })

describe('tendon splice: the cut is closed', () => {
  it('caps an open tube', () => {
    const t = tube(0.01, 0, 0.1, 0, 0, [true, false])
    expect(openEdges(t)).toBeGreaterThan(0)
    const pos = Array.from(t.positions)
    const idx = Array.from(t.indices)
    expect(capOpenLoops(pos, idx)).toBe(24)
    expect(openEdges({ positions: Float32Array.from(pos), indices: Uint32Array.from(idx) })).toBe(0)
  })

  it('leaves a spliced muscle a set of closed shells, and the space beyond the tendon outside it', () => {
    // 肌腹 y 0.10…0.30；男性肌（带腱）y 0…0.40，偏开 5 mm / belly y 0.10…0.30; the male muscle with its tendons y 0…0.40, 5 mm off
    const belly = tube(0.02, 0.1, 0.3)
    const male = tube(0.008, 0, 0.4, 0.005, 0, [true, true], 24, 80)
    const sp = spliceTendons(belly, male)
    expect(sp.ends.every((e) => e.attached && e.capTriangles > 0)).toBe(true)
    expect(openEdges(sp.mesh)).toBe(0)
    const inside = new SolidTester(sp.mesh)
    expect(inside.contains(0, 0.2, 0)).toBe(true)
    // 腱伸入肌腹的重叠段：奇偶为偶，仍应判为内 / the overlap of tendon and belly: even parity, still inside
    expect(inside.contains(0.004, 0.105, 0)).toBe(true)
    // 腱的正下方、正上方：不在肌内 / straight below and above the tendons: not inside the muscle
    expect(inside.contains(0.005, -0.02, 0)).toBe(false)
    expect(inside.contains(0.005, 0.42, 0)).toBe(false)
    expect(inside.contains(0.05, 0.2, 0)).toBe(false)
  })
})

describe('nerve courses inside muscles: the rule', () => {
  it('classifies motor branches, passages and the rest', () => {
    expect(classifyCourse('Left inferior gluteal nerve', 'Left gluteus maximus', true)).toBe('motor')
    expect(classifyCourse('Left tibial nerve', 'Left soleus', false)).toBe('motor')
    expect(classifyCourse('Left tibial nerve', 'Left soleus', true)).toBe('unexplained')
    expect(classifyCourse('Right genitofemoral nerve', 'Right psoas major', true)).toBe('passage')
    expect(classifyCourse('Right superficial fibular nerve', 'Right fibularis longus', true)).toBe('passage')
    expect(classifyCourse('Right sciatic nerve', 'Right piriformis', true)).toBe('unexplained')
    expect(classifyCourse('Left posterior femoral cutaneous nerve', 'Long head of left biceps femoris', false)).toBe('unexplained')
    expect(classifyCourse('Left saphenous nerve', 'Left vastus medialis', false)).toBe('unexplained')
  })

  it('takes the thickest polyline as the trunk', () => {
    expect(trunkIndex([line([[0, 0, 0], [0, 1, 0]], 0.0005), line([[0, 0, 0], [0, 1, 0]], 0.003), line([[0, 0, 0], [1, 0, 0]], 0.001)])).toBe(1)
  })

  it('measures a trunk through a belly as unexplained and a branch into its own muscle as motor', () => {
    const soleus = { id: 'm', name: 'Left soleus', mesh: tube(0.03, 0, 0.2) }
    const nerve = { id: 'n', name: 'Left tibial nerve', lines: [line([[0, -0.1, 0], [0, 0.3, 0]], 0.003), line([[0.1, 0.1, 0], [0.01, 0.1, 0]], 0.0005)] }
    const r = nerveCourseReport([nerve], [soleus])
    const total = 0.4 + 0.09
    expect(r.unexplainedShare).toBeCloseTo((0.2 - 0.006) / total, 2)
    expect(r.motorShare).toBeCloseTo((0.03 - 0.01 - 0.003) / total, 2)
    expect(r.rawShare).toBeCloseTo(r.unexplainedShare + r.motorShare + r.passageShare, 4)
  })
})

describe('groin: trimming and seating', () => {
  it('cuts a nerve below the pubic tubercle near the midline and keeps a thigh branch', () => {
    const pt = [0.02, 0.7, 0.12]
    const trunk = line([[0.05, 0.75, 0.12], [0.03, 0.71, 0.125], [0.025, 0.69, 0.125], [0.02, 0.67, 0.13], [0.02, 0.62, 0.14]])
    const thigh = line([[0.03, 0.71, 0.125], [0.045, 0.68, 0.125], [0.05, 0.64, 0.125]])
    const scrotal = line([[0.02, 0.66, 0.13], [0.015, 0.63, 0.14]])
    const t = trimLabialRun([trunk, thigh, scrotal], pt)
    expect(t.lines.length).toBe(2)
    expect(t.lines[0]!.radius.length).toBe(3)
    expect(t.lines[1]!.radius.length).toBe(3)
    expect(t.removedMm).toBeGreaterThan(70)
  })

  it('moves a vessel hanging in front of the floor back onto it, and nothing into the floor', () => {
    // 底：z = 0 的一块厚板（用扁管代替：轴沿 y 的大圆柱的前表面）；血管：其前方 20 mm 处的细管
    // floor: the front of a big cylinder along y (front surface at z = 0.05); vessel: a thin tube 20 mm in front of it
    const floor = tube(0.05, 0.5, 0.75, 0.03, 0)
    const vessel = tube(0.004, 0.52, 0.74, 0.03, 0.05 + 0.02 + 0.004)
    const seat = buildFemoralSeat([floor], [vessel], [0.02, 0.7, 0.05])
    expect(seat.report.clearanceBeforeMm.median).toBeGreaterThan(17)
    const moved = Float32Array.from(vessel.positions)
    seat.apply(moved)
    let back = Infinity
    for (let i = 0; i < moved.length; i += 3) if (moved[i + 1]! > 0.6 && moved[i + 1]! < 0.68) back = Math.min(back, moved[i + 2]!)
    expect(back).toBeGreaterThan(0.05)
    expect(back).toBeLessThan(0.05 + 0.006)
    // 底后方的点不动 / a point behind the floor stays
    expect(seat.shiftAt(0.03, 0.65, 0.0)).toBe(0)
  })
})

describe.skipIf(!built)('female build: groin, nerve courses and the quadriceps tendon', () => {
  let load: ReturnType<typeof loadBuiltBody> | null = null
  const byName = async () => {
    const body = await (load ??= loadBuiltBody(DIR))
    const meshes = new Map<string, Mesh>()
    const lines = new Map<string, Polyline[]>()
    for (const p of body.data.parts) {
      if (body.meshes.has(p.id) && !meshes.has(p.name)) meshes.set(p.name, body.meshes.get(p.id)!)
      if (body.nerves.has(p.id) && !lines.has(p.name)) lines.set(p.name, body.nerves.get(p.id)!)
    }
    return { body, meshes, lines }
  }
  /** 一个部件在某一高度附近的顶点质心 / centroid of a part's vertices near one height */
  const at = (m: Mesh, y: number, half = 0.006): number[] | null => {
    const c = [0, 0, 0]
    let n = 0
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1]! - y) > half) continue
      for (let k = 0; k < 3; k++) c[k] = c[k]! + m.positions[i + k]!
      n++
    }
    return n ? c.map((v) => v / n) : null
  }
  const lineAt = (ls: Polyline[], y: number): number[] | null => at({ positions: Float32Array.from(ls.flatMap((l) => Array.from(l.points))), indices: new Uint32Array() }, y, 0.008)

  it('reports what was trimmed and seated', () => {
    expect(report.groin.trimmed.length).toBe(4)
    for (const t of report.groin.trimmed) {
      expect(t.removedMm, t.nerve).toBeGreaterThan(20)
      expect(t.keptMm, t.nerve).toBeGreaterThan(250)
    }
    expect(report.groin.seat.length).toBe(2)
    for (const s of report.groin.seat) {
      expect(s.floorParts, s.side).toBeGreaterThanOrEqual(6)
      expect(s.maxShiftMm, s.side).toBeLessThanOrEqual(25)
      expect(s.partsMoved, s.side).toBeGreaterThan(10)
    }
  })

  it('orders nerve, artery and vein from lateral to medial under the inguinal ligament, the vein lateral to the pubic tubercle', async () => {
    const { meshes, lines } = await byName()
    for (const side of ['Left', 'Right']) {
      const sx = side === 'Left' ? 1 : -1
      const pt = pubicTubercle(meshes.get(`${side} hip bone`)!)
      const y = pt[1] + 0.005
      const nerve = lineAt(lines.get(`${side} femoral nerve`)!, y)!
      const artery = at(meshes.get(`${side} femoral artery`)!, y)!
      const vein = at(meshes.get(`${side} femoral vein`)!, y)!
      expect(sx * nerve[0]!, `${side} nerve lateral of artery`).toBeGreaterThan(sx * artery[0]! + 0.005)
      expect(sx * artery[0]!, `${side} artery lateral of vein`).toBeGreaterThan(sx * vein[0]! + 0.003)
      expect(sx * vein[0]!, `${side} vein lateral of the tubercle`).toBeGreaterThan(sx * pt[0])
    }
  })

  it('keeps the femoral vessels on the floor of the femoral triangle', async () => {
    const { body, meshes } = await byName()
    for (const side of ['Left', 'Right']) {
      const pt = pubicTubercle(meshes.get(`${side} hip bone`)!)
      const floor = body.data.parts.filter((p) => isRealPart(p) && new RegExp(`^${side} (hip bone|femur|iliacus|psoas major|pectineus|adductor longus|adductor brevis|adductor magnus)$`).test(p.name)).map((p) => body.meshes.get(p.id)!)
      const ix = new PointIndex(thinPoints(new Float32Array(floor.flatMap((m) => Array.from(surfacePoints(m, 0.002)))), 0.0015), 0.01)
      for (const v of ['femoral artery', 'femoral vein']) {
        const m = meshes.get(`${side} ${v}`)!
        // 结节以下 10–90 mm：血管壁到底的最近距离，逐层取最小，再取各层的最大
        // 10–90 mm below the tubercle: per level the closest approach of the vessel wall to the floor, then the largest over the levels
        let worst = 0
        for (let dy = 0.01; dy <= 0.09; dy += 0.01) {
          let d = Infinity
          for (let i = 0; i < m.positions.length; i += 3) if (Math.abs(m.positions[i + 1]! - (pt[1] - dy)) < 0.006) d = Math.min(d, ix.distance(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!, 0.05))
          if (Number.isFinite(d)) worst = Math.max(worst, d)
        }
        expect(worst, `${side} ${v}: largest gap to the floor`).toBeLessThan(0.012)
      }
    }
  })

  it('ends the ilio-inguinal nerve and the genital branch in the mons, not where the scrotum would be', async () => {
    const { meshes, lines } = await byName()
    for (const side of ['Left', 'Right']) {
      const pt = pubicTubercle(meshes.get(`${side} hip bone`)!)
      for (const n of ['ilio-inguinal nerve', 'genital branch of genitofemoral nerve']) {
        let low = Infinity
        for (const l of lines.get(`${side} ${n}`)!) for (let i = 0; i < l.points.length; i += 3) if (Math.abs(l.points[i]!) < Math.abs(pt[0]) + 0.015) low = Math.min(low, l.points[i + 1]!)
        // 修剪在形变之后、落底和体形重塑之前（两者都会再移动它），走向大腿的分支也贴着这个区的边：留 20 mm 余量（修剪前是 54–87 mm）
        // trimmed after the warp and before the seating and the body-shape stage (both move it again), and the thigh branch skirts the zone: 20 mm of slack (54–87 mm before the trim)
        expect(low, `${side} ${n}`).toBeGreaterThan(pt[1] - 0.04)
      }
    }
  })

  it('leaves under 0.5 % of nerve length unexplained inside her real muscles, measured again on the output', async () => {
    const c = report.nerveCourse
    expect(c.after.unexplainedShare).toBeLessThan(0.005)
    expect(c.after.unexplainedShare).toBeLessThanOrEqual(c.before.unexplainedShare)
    expect(c.after.rawShare).toBeCloseTo(c.after.motorShare + c.after.passageShare + c.after.unexplainedShare, 4)
    const { body } = await byName()
    const muscles = body.data.parts.filter((p) => p.tissue === 'muscle' && isRealPart(p)).map((p) => ({ id: p.id, name: p.name, mesh: body.meshes.get(p.id)! }))
    const nerves = body.data.parts.filter((p) => body.nerves.has(p.id)).map((p) => ({ id: p.id, name: p.name, lines: body.nerves.get(p.id)! }))
    const again = nerveCourseReport(nerves, muscles)
    // 输出的网格经过简化，数字略有出入 / the written meshes are simplified, so the figures differ a little
    expect(again.unexplainedShare).toBeLessThan(0.006)
    expect(again.rawShare).toBeLessThan(0.04)
  })

  it('carries rectus femoris over the patella to the tibial tuberosity', async () => {
    const { meshes } = await byName()
    for (const side of ['Left', 'Right']) {
      const rf = meshes.get(`${side} rectus femoris`)!
      const patella = new PointIndex(thinPoints(surfacePoints(meshes.get(`${side} patella`)!, 0.002), 0.0015), 0.01)
      const tibia = new PointIndex(thinPoints(surfacePoints(meshes.get(`${side} tibia`)!, 0.002), 0.0015), 0.01)
      let toPatella = Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (let i = 0; i < rf.positions.length; i += 3) {
        toPatella = Math.min(toPatella, patella.distance(rf.positions[i]!, rf.positions[i + 1]!, rf.positions[i + 2]!, 0.05))
        y0 = Math.min(y0, rf.positions[i + 1]!)
        y1 = Math.max(y1, rf.positions[i + 1]!)
      }
      const d: number[] = []
      for (let i = 0; i < rf.positions.length; i += 3) if (rf.positions[i + 1]! <= y0 + 0.04 * (y1 - y0)) d.push(tibia.distance(rf.positions[i]!, rf.positions[i + 1]!, rf.positions[i + 2]!, 0.05))
      d.sort((a, b) => a - b)
      expect(toPatella, `${side}: closest approach to the patella`).toBeLessThan(0.003)
      expect(d[d.length >> 1]!, `${side}: lower end to the tibia`).toBeLessThan(0.005)
    }
  })

  // 足趾（构建早于 foot.ts 时跳过）/ toes (skipped for a build that predates foot.ts)
  it.skipIf(!report.toes)('lays the toes on the floor with the phalanges at about the male foot\'s angles', async () => {
    expect(report.toes.rows.length).toBe(10)
    for (const r of report.toes.rows) {
      const tag = `${r.side} ${r.toe}`
      // 男性近节趾骨为 −6…−10°；她外侧几趾的跖骨头离地 8–9 mm，落地需要多转一些
      // the male's proximal phalanges are at −6…−10°; her lateral metatarsal heads sit 8–9 mm above the floor, so those toes need a larger turn to reach it
      expect(r.proximalElevationDeg.after, tag).toBeLessThan(0)
      expect(r.proximalElevationDeg.after, tag).toBeGreaterThan(-22)
      expect(r.aboveFloorMm.after, tag).toBeLessThan(1.5)
      for (const g of r.jointSpaceMm.after) {
        expect(g, tag).toBeGreaterThan(0.05)
        expect(g, tag).toBeLessThan(1.5)
      }
    }
    const { meshes } = await byName()
    for (const side of ['Left', 'Right']) {
      let floor = Infinity
      for (const [name, m] of meshes) if (name.includes(side) || name.includes(side.toLowerCase())) if (/calcaneus|metatarsal bone|Sesamoid bone of (left|right) foot/.test(name)) for (let i = 1; i < m.positions.length; i += 3) floor = Math.min(floor, m.positions[i]!)
      for (const toe of TOES) {
        const prox = meshes.get(`Proximal phalanx of ${side.toLowerCase()} ${toe} toe`)!
        const dist = meshes.get(`Distal phalanx of ${side.toLowerCase()} ${toe} toe`)!
        const e = elevationDeg(prox.positions)
        expect(e, `${side} ${toe}`).toBeLessThan(2)
        expect(e, `${side} ${toe}`).toBeGreaterThan(-24)
        let low = Infinity
        for (let i = 1; i < dist.positions.length; i += 3) low = Math.min(low, dist.positions[i]!)
        expect(low - floor, `${side} ${toe}: tip above the foot's floor`).toBeLessThan(0.004)
        expect(low - floor, `${side} ${toe}: tip not below the foot's floor`).toBeGreaterThan(-0.001)
      }
    }
  })
})
