import { describe, expect, it } from 'vitest'
import { coarsen, collides, Occupied, occupy, placement, randomRotation, rng, scatter } from '../src/landscape/pack'

/** A lumpy blob of points about `size` Å across. */
function blob(size: number, n: number, seed: number): Float32Array {
  const r = rng(seed)
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    p[i * 3] = 100 + (r() - 0.5) * size
    p[i * 3 + 1] = -40 + (r() - 0.5) * size * 0.6
    p[i * 3 + 2] = 7 + (r() - 0.5) * size * 0.4
  }
  return p
}

describe('coarsen', () => {
  it('covers every atom with a sphere, about the molecule’s own centre', () => {
    const pts = blob(60, 2000, 1)
    const c = coarsen(pts)
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]! - c.center[0], y = pts[i + 1]! - c.center[1], z = pts[i + 2]! - c.center[2]
      let covered = false
      for (let k = 0; k < c.spheres.length && !covered; k += 4) {
        covered = Math.hypot(x - c.spheres[k]!, y - c.spheres[k + 1]!, z - c.spheres[k + 2]!) <= c.spheres[k + 3]! + 3
      }
      expect(covered).toBe(true)
    }
    expect(c.spheres.length / 4).toBeLessThan(200)
  })
})

describe('randomRotation', () => {
  it('is a proper rotation', () => {
    const r = rng(3)
    for (let k = 0; k < 20; k++) {
      const m = randomRotation(r)
      const det = m[0]! * (m[4]! * m[8]! - m[7]! * m[5]!) - m[3]! * (m[1]! * m[8]! - m[7]! * m[2]!) + m[6]! * (m[1]! * m[5]! - m[4]! * m[2]!)
      expect(det).toBeCloseTo(1, 5)
      expect(m[0]! * m[3]! + m[1]! * m[4]! + m[2]! * m[5]!).toBeCloseTo(0, 5)
    }
  })
})

describe('scatter', () => {
  const region = { min: [-200, -200, -80] as [number, number, number], max: [200, 200, 0] as [number, number, number] }

  it('places copies that do not overlap one another', () => {
    const c = coarsen(blob(50, 1500, 2))
    const occ = new Occupied()
    const mats = scatter(occ, c, 40, region, rng(7))
    expect(mats.length).toBeGreaterThan(20)
    // re-check every pair of placed molecules sphere by sphere
    const world = mats.map((m) => {
      const out: number[] = []
      for (let i = 0; i < c.spheres.length; i += 4) {
        const p = [c.spheres[i]! + c.center[0], c.spheres[i + 1]! + c.center[1], c.spheres[i + 2]! + c.center[2]]
        for (let a = 0; a < 3; a++) out.push(m[a]! * p[0]! + m[4 + a]! * p[1]! + m[8 + a]! * p[2]! + m[12 + a]!)
        out.push(c.spheres[i + 3]!)
      }
      return out
    })
    for (let a = 0; a < world.length; a++)
      for (let b = a + 1; b < world.length; b++)
        for (let i = 0; i < world[a]!.length; i += 4)
          for (let j = 0; j < world[b]!.length; j += 4) {
            const d = Math.hypot(world[a]![i]! - world[b]![j]!, world[a]![i + 1]! - world[b]![j + 1]!, world[a]![i + 2]! - world[b]![j + 2]!)
            expect(d).toBeGreaterThanOrEqual(world[a]![i + 3]! + world[b]![j + 3]! - 1e-3)
          }
    // 逐对检查很慢，机器忙时会超过默认的 5 秒 / the pairwise check is slow and can pass the default 5 s on a busy machine
  }, 20_000)

  it('keeps every centre inside the region', () => {
    const c = coarsen(blob(40, 800, 5))
    for (const m of scatter(new Occupied(), c, 30, region, rng(11))) {
      // the matrix maps the molecule's own centre to where it was put
      const p = [0, 1, 2].map((a) => m[a]! * c.center[0] + m[4 + a]! * c.center[1] + m[8 + a]! * c.center[2] + m[12 + a]!)
      for (let a = 0; a < 3; a++) {
        expect(p[a]!).toBeGreaterThanOrEqual(region.min[a]! - 1e-3)
        expect(p[a]!).toBeLessThanOrEqual(region.max[a]! + 1e-3)
      }
    }
  })

  it('gives up when the region is full instead of overlapping', () => {
    const c = coarsen(blob(80, 3000, 9))
    const small = { min: [-60, -60, -40] as [number, number, number], max: [60, 60, 0] as [number, number, number] }
    expect(scatter(new Occupied(), c, 200, small, rng(1)).length).toBeLessThan(30)
  })

  it('is repeatable for a seed and different for another', () => {
    const c = coarsen(blob(40, 800, 5))
    const a = scatter(new Occupied(), c, 10, region, rng(42)), b = scatter(new Occupied(), c, 10, region, rng(42)), d = scatter(new Occupied(), c, 10, region, rng(43))
    expect(Array.from(a[3]!)).toEqual(Array.from(b[3]!))
    expect(Array.from(a[3]!)).not.toEqual(Array.from(d[3]!))
  })
})

describe('collides / occupy', () => {
  it('sees a molecule placed on top of another and not one far away', () => {
    const c = coarsen(blob(40, 800, 5))
    const occ = new Occupied()
    const id = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    occupy(occ, c, id, [0, 0, 0])
    expect(collides(occ, c, id, [5, 0, 0])).toBe(true)
    expect(collides(occ, c, id, [300, 0, 0])).toBe(false)
    expect(placement(id, [1, 2, 3], [10, 20, 30])[12]).toBe(-9)
  })
})
