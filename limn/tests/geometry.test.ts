import { describe, expect, it } from 'vitest'
import { fitRigid } from '../src/mol/superpose'
import { axisAngle, euler, identity3 } from '../src/render/camera'
import type { Bounds } from '../src/render/Renderer'
import { gridLayout } from '../src/scene/layout'
import { principalFrame } from '../src/refine/views'

describe('fitRigid', () => {
  it('recovers a known rotation and translation', () => {
    const R = euler(30, -50, 110)
    const t = [5, -7, 12]
    const from: number[] = [], to: number[] = []
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 40 - 20
    for (let i = 0; i < 60; i++) {
      const p = [rnd(), rnd(), rnd()]
      from.push(...p)
      for (let a = 0; a < 3; a++) to.push(R[a]! * p[0]! + R[3 + a]! * p[1]! + R[6 + a]! * p[2]! + t[a]!)
    }
    const { matrix, rmsd } = fitRigid(from, to)
    expect(rmsd).toBeLessThan(1e-3)
    expect(matrix[12]).toBeCloseTo(5, 2)
    expect(matrix[13]).toBeCloseTo(-7, 2)
    expect(matrix[14]).toBeCloseTo(12, 2)
    for (let k = 0; k < 9; k++) expect(matrix[Math.floor(k / 3) * 4 + (k % 3)]).toBeCloseTo(R[k]!, 3)
  })
  it('never returns a mirror image', () => {
    // a chiral set of points and its mirror: the best rigid fit must leave a residual
    const from = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 3, 4, 5]
    const to = from.map((v, i) => (i % 3 === 0 ? -v : v))
    const { matrix, rmsd } = fitRigid(from, to)
    const m = matrix
    const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
    expect(det).toBeCloseTo(1, 4)
    expect(rmsd).toBeGreaterThan(1)
  })
})

const ball = (cx: number, cy: number, cz: number, r: number): Bounds => ({ center: [cx, cy, cz], radius: r, spheres: new Float32Array([cx, cy, cz, r]), subunitSize: 30 })

describe('gridLayout', () => {
  const four = [ball(0, 0, 0, 20), ball(100, 5, 3, 20), ball(-40, 9, 9, 20), ball(7, 7, 7, 20)]
  it('puts four equal panels in one row for a wide frame and 2x2 for a square one', () => {
    const wide = gridLayout(four, identity3(), 4)
    expect(new Set(wide.slots.map((s) => Math.round(s.y))).size).toBe(1)
    const square = gridLayout(four, identity3(), 1)
    expect(new Set(square.slots.map((s) => Math.round(s.y))).size).toBe(2)
  })
  it('keeps panels from overlapping and in reading order', () => {
    const l = gridLayout(four, identity3(), 4)
    for (let i = 1; i < 4; i++) expect(l.slots[i]!.x - l.slots[i]!.halfW).toBeGreaterThan(l.slots[i - 1]!.x + l.slots[i - 1]!.halfW)
  })
  it('places each panel so its own centre lands on its slot, under any rotation', () => {
    const rot = axisAngle(0, 1, 0, 1.1)
    const l = gridLayout(four, rot, 2)
    four.forEach((b, i) => {
      const m = l.mats[i]!
      const w = [b.center[0] + m[12]!, b.center[1] + m[13]!, b.center[2] + m[14]!]
      const x = rot[0]! * w[0]! + rot[3]! * w[1]! + rot[6]! * w[2]!
      const y = rot[1]! * w[0]! + rot[4]! * w[1]! + rot[7]! * w[2]!
      expect(x).toBeCloseTo(l.slots[i]!.x, 3)
      expect(y).toBeCloseTo(l.slots[i]!.y, 3)
    })
  })
})

describe('principalFrame', () => {
  it('stands the long axis of a rod upright on screen', () => {
    const pts: number[] = []
    for (let i = -10; i <= 10; i++) pts.push(i * 5, i * 5, 0.3 * (i % 3), 2) // a rod along (1,1,0)
    const f = principalFrame({ center: [0, 0, 0], radius: 80, spheres: new Float32Array(pts), subunitSize: 30 })
    // screen y of the rod's direction should be its full length
    const d = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const y = f[1]! * d[0]! + f[4]! * d[1]! + f[7]! * d[2]!
    expect(Math.abs(y)).toBeCloseTo(1, 2)
    // and the frame is a proper rotation
    const det = f[0]! * (f[4]! * f[8]! - f[7]! * f[5]!) - f[3]! * (f[1]! * f[8]! - f[7]! * f[2]!) + f[6]! * (f[1]! * f[5]! - f[4]! * f[2]!)
    expect(det).toBeCloseTo(1, 4)
  })
})
