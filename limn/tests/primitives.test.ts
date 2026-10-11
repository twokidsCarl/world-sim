import { describe, expect, it } from 'vitest'
import { roundConeSideZ } from '../src/render/capsule'
import { meshMeasure, pad, surfaceMesh, surfacePoints, type Volume } from '../src/volume/mrc'

/** 圆台胶囊的有向距离（Inigo Quilez）/ signed distance to a round cone (Inigo Quilez) */
function sdRoundCone(p: number[], a: number[], b: number[], r1: number, r2: number): number {
  const ba = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const l2 = ba[0]! ** 2 + ba[1]! ** 2 + ba[2]! ** 2
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  const pa = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!]
  const y = pa[0]! * ba[0]! + pa[1]! * ba[1]! + pa[2]! * ba[2]!
  const z = y - l2
  const xv = [pa[0]! * l2 - ba[0]! * y, pa[1]! * l2 - ba[1]! * y, pa[2]! * l2 - ba[2]! * y]
  const x2 = xv[0]! ** 2 + xv[1]! ** 2 + xv[2]! ** 2
  const y2 = y * y * l2, z2 = z * z * l2
  const k = Math.sign(rr) * rr * rr * x2
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
}

/** 沿 -z 步进，找到表面的第一个 z / march along -z to the first z on the surface */
function marchZ(x: number, y: number, a: number[], b: number[], r1: number, r2: number): number | null {
  let z = Math.max(a[2]! + r1, b[2]! + r2) + 1
  for (let i = 0; i < 400; i++) {
    const d = sdRoundCone([x, y, z], a, b, r1, r2)
    if (d < 1e-7) return z
    z -= d
    if (z < Math.min(a[2]! - r1, b[2]! - r2) - 1) return null
  }
  return null
}

describe('capsules', () => {
  it('the side of a round cone is where marching its distance field arrives', () => {
    const cases: [number[], number, number[], number][] = [
      [[0, 0, 0], 1, [5, 0, 0], 1],
      [[0, 0, 0], 2, [6, 1, 0.5], 0.5],
      [[1, -2, 3], 0.4, [-3, 2, 6], 1.5],
      // 几乎正对着看 / seen almost end-on
      [[0, 0, 0], 1, [0.3, 0.1, 6], 0.4],
      [[0, 0, 0], 0.4, [0.3, 0.1, 6], 1],
    ]
    let onSide = 0, checked = 0
    for (const [a, ra, b, rb] of cases) {
      for (let i = 0; i <= 40; i++)
        for (let j = 0; j <= 40; j++) {
          const x = Math.min(a[0]! - ra, b[0]! - rb) + (i / 40) * (Math.max(a[0]! + ra, b[0]! + rb) - Math.min(a[0]! - ra, b[0]! - rb))
          const y = Math.min(a[1]! - ra, b[1]! - rb) + (j / 40) * (Math.max(a[1]! + ra, b[1]! + rb) - Math.min(a[1]! - ra, b[1]! - rb))
          const truth = marchZ(x, y, a, b, ra, rb)
          const side = roundConeSideZ(x, y, a as [number, number, number], ra, b as [number, number, number], rb)
          // 两端球的最高点 / the tops of the two end spheres
          const cap = Math.max(...[[a, ra] as const, [b, rb] as const].map(([c, r]) => {
            const h = r * r - (x - c[0]!) ** 2 - (y - c[1]!) ** 2
            return h >= 0 ? c[2]! + Math.sqrt(h) : -Infinity
          }))
          const drawn = Math.max(side ?? -Infinity, cap)
          checked++
          if (truth === null) {
            // 掠过边缘的视线上，步进法可能差一点点没碰到 / on a grazing line the march may just miss
            if (drawn > -Infinity) expect(Math.abs(sdRoundCone([x, y, drawn], a, b, ra, rb))).toBeLessThan(1e-3)
            continue
          }
          expect(drawn).toBeGreaterThan(-Infinity)
          expect(Math.abs(drawn - truth)).toBeLessThan(2e-3)
          if (side !== null && side > cap + 1e-6) onSide++
        }
    }
    expect(checked).toBe(5 * 41 * 41)
    // 确实测到了侧面，而不只是两端的球 / the side really was exercised, not just the end spheres
    expect(onSide).toBeGreaterThan(500)
  })

  it('has no side when one sphere holds the other', () => {
    expect(roundConeSideZ(0, 0, [0, 0, 0], 3, [1, 0, 0], 1)).toBeNull()
  })
})

function ball(n: number, r: number): Volume {
  const data = new Float32Array(n * n * n)
  const c = (n - 1) / 2
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[x + n * (y + n * z)] = r - Math.hypot(x - c, y - c, z - c)
  return { nx: n, ny: n, nz: n, data, voxel: [1, 1, 1], origin: [0, 0, 0] }
}

describe('surface mesh', () => {
  const vol = ball(48, 17)
  const mesh = surfaceMesh(vol, 0)

  it('uses exactly the points of the sphere drawing, in the same order', () => {
    expect(Array.from(mesh.positions)).toEqual(Array.from(surfacePoints(vol, 0)))
    expect(Math.max(...mesh.triangles)).toBe(mesh.positions.length / 3 - 1)
  })

  it('is closed: every edge is shared by two triangles, in opposite directions', () => {
    const count = new Map<number, number>()
    const n = mesh.positions.length / 3
    for (let t = 0; t < mesh.triangles.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = mesh.triangles[t + e]!, b = mesh.triangles[t + ((e + 1) % 3)]!
        count.set(a * n + b, (count.get(a * n + b) ?? 0) + 1)
      }
    for (const [key, c] of count) {
      expect(c).toBe(1)
      const a = Math.floor(key / n), b = key % n
      expect(count.get(b * n + a)).toBe(1)
    }
  })

  it('has the area and the volume of the ball, with normals pointing out', () => {
    const { area, volume } = meshMeasure(mesh.positions, mesh.triangles)
    expect(volume).toBeGreaterThan(0)
    expect(Math.abs(volume / ((4 / 3) * Math.PI * 17 ** 3) - 1)).toBeLessThan(0.01)
    expect(Math.abs(area / (4 * Math.PI * 17 ** 2) - 1)).toBeLessThan(0.02)
  })

  it('is open where the object touches the border of the data, and closed once the volume is padded', () => {
    // 一个填满整个盒子的方块 / a block that fills the whole box
    const n = 6
    const block: Volume = { nx: n, ny: n, nz: n, data: new Uint8Array(n * n * n).fill(1), voxel: [2, 2, 2], origin: [10, 0, 0] }
    expect(surfaceMesh(block, 0.5).triangles.length).toBe(0)
    const padded = pad(block)
    expect([padded.nx, padded.origin[0]]).toEqual([n + 2, 8])
    const m = surfaceMesh(padded, 0.5)
    const edges = new Map<string, number>()
    for (let t = 0; t < m.triangles.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.triangles[t + e]!, b = m.triangles[t + ((e + 1) % 3)]!
        edges.set(`${Math.min(a, b)}-${Math.max(a, b)}`, (edges.get(`${Math.min(a, b)}-${Math.max(a, b)}`) ?? 0) + 1)
      }
    expect(edges.size).toBeGreaterThan(0)
    for (const c of edges.values()) expect(c).toBe(2)
    // 围住的体积接近方块本身（角被表面网削掉一点）/ the enclosed volume is close to the block's own (surface nets shave the corners a little)
    const { volume } = meshMeasure(m.positions, m.triangles)
    expect(volume / (n * 2) ** 3).toBeGreaterThan(0.85)
    expect(volume / (n * 2) ** 3).toBeLessThan(1.01)
  })
})
