/**
 * Fills a slab with rigid copies of molecules so that none overlap: random
 * sequential placement, largest first, with each molecule stood in for by a
 * handful of coarse spheres. Deterministic for a given seed.
 */

/** Small fast seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A molecule reduced to spheres (x, y, z, r in Å) around its own centre. */
export interface Coarse {
  spheres: Float32Array
  /** the centre that was subtracted; atoms must be shifted by its negative */
  center: [number, number, number]
  radius: number
}

/**
 * One sphere per occupied cell of a grid laid over the atoms. `points` are
 * x,y,z triples; each sphere covers its cell's atoms with a little to spare.
 */
export function coarsen(points: Float32Array | number[], cell = 11): Coarse {
  const n = points.length / 3
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < n; i++) {
    cx += points[i * 3]!
    cy += points[i * 3 + 1]!
    cz += points[i * 3 + 2]!
  }
  cx /= n
  cy /= n
  cz /= n
  const cells = new Map<string, [number, number, number, number]>()
  for (let i = 0; i < n; i++) {
    const x = points[i * 3]! - cx, y = points[i * 3 + 1]! - cy, z = points[i * 3 + 2]! - cz
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
    const c = cells.get(key)
    if (c) {
      c[0] += x
      c[1] += y
      c[2] += z
      c[3]++
    } else cells.set(key, [x, y, z, 1])
  }
  const spheres = new Float32Array(cells.size * 4)
  let k = 0, radius = 0
  const r = cell * 0.62
  for (const c of cells.values()) {
    const x = c[0] / c[3], y = c[1] / c[3], z = c[2] / c[3]
    spheres.set([x, y, z, r], k)
    k += 4
    radius = Math.max(radius, Math.hypot(x, y, z) + r)
  }
  return { spheres, center: [cx, cy, cz], radius }
}

/** Uniformly random rotation as a column-major 3x3. */
export function randomRotation(rand: () => number): Float32Array {
  const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1)
  const x = a * Math.sin(u2), y = a * Math.cos(u2), z = b * Math.sin(u3), w = b * Math.cos(u3)
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ])
}

export interface Region {
  min: [number, number, number]
  max: [number, number, number]
}

/** Everything placed so far, searchable by position. */
export class Occupied {
  private grid = new Map<number, number[]>()
  private data: number[] = []
  constructor(private cell = 24) {}

  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512)
  }

  add(x: number, y: number, z: number, r: number): void {
    const i = this.data.length
    this.data.push(x, y, z, r)
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell))
    const l = this.grid.get(k)
    if (l) l.push(i)
    else this.grid.set(k, [i])
  }

  /** True if a sphere here would overlap one already placed. Spheres up to the cell size are supported. */
  hits(x: number, y: number, z: number, r: number): boolean {
    const c = this.cell
    const ix = Math.floor(x / c), iy = Math.floor(y / c), iz = Math.floor(z / c)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const l = this.grid.get(this.key(ix + dx, iy + dy, iz + dz))
          if (!l) continue
          for (const i of l) {
            const d = this.data[i + 3]! + r
            const ex = this.data[i]! - x, ey = this.data[i + 1]! - y, ez = this.data[i + 2]! - z
            if (ex * ex + ey * ey + ez * ez < d * d) return true
          }
        }
    return false
  }

  get count(): number {
    return this.data.length / 4
  }
}

/** rot (3x3, column-major) and a position, as a column-major 4x4 that first removes `center`. */
export function placement(rot: Float32Array, pos: [number, number, number], center: [number, number, number]): Float32Array {
  const t = [0, 1, 2].map((a) => pos[a]! - (rot[a]! * center[0] + rot[3 + a]! * center[1] + rot[6 + a]! * center[2]))
  return new Float32Array([rot[0]!, rot[1]!, rot[2]!, 0, rot[3]!, rot[4]!, rot[5]!, 0, rot[6]!, rot[7]!, rot[8]!, 0, t[0]!, t[1]!, t[2]!, 1])
}

/** Would this molecule, turned and moved, overlap anything? */
export function collides(occ: Occupied, c: Coarse, rot: Float32Array, pos: [number, number, number], slack = 0): boolean {
  const s = c.spheres
  for (let i = 0; i < s.length; i += 4) {
    const x = rot[0]! * s[i]! + rot[3]! * s[i + 1]! + rot[6]! * s[i + 2]! + pos[0]
    const y = rot[1]! * s[i]! + rot[4]! * s[i + 1]! + rot[7]! * s[i + 2]! + pos[1]
    const z = rot[2]! * s[i]! + rot[5]! * s[i + 1]! + rot[8]! * s[i + 2]! + pos[2]
    if (occ.hits(x, y, z, s[i + 3]! - slack)) return true
  }
  return false
}

export function occupy(occ: Occupied, c: Coarse, rot: Float32Array, pos: [number, number, number]): void {
  const s = c.spheres
  for (let i = 0; i < s.length; i += 4) {
    occ.add(
      rot[0]! * s[i]! + rot[3]! * s[i + 1]! + rot[6]! * s[i + 2]! + pos[0],
      rot[1]! * s[i]! + rot[4]! * s[i + 1]! + rot[7]! * s[i + 2]! + pos[1],
      rot[2]! * s[i]! + rot[5]! * s[i + 1]! + rot[8]! * s[i + 2]! + pos[2],
      s[i + 3]!,
    )
  }
}

/**
 * Try to place `copies` of a molecule at random in `region` (which bounds
 * the molecule's centre). Returns the transforms of those that fitted; fewer
 * than asked for means the region is full.
 */
export function scatter(occ: Occupied, c: Coarse, copies: number, region: Region, rand: () => number, orient: (rand: () => number) => Float32Array = randomRotation, tries = 60): Float32Array[] {
  const out: Float32Array[] = []
  for (let k = 0; k < copies; k++) {
    for (let t = 0; t < tries; t++) {
      const pos: [number, number, number] = [
        region.min[0] + rand() * (region.max[0] - region.min[0]),
        region.min[1] + rand() * (region.max[1] - region.min[1]),
        region.min[2] + rand() * (region.max[2] - region.min[2]),
      ]
      const rot = orient(rand)
      if (collides(occ, c, rot, pos)) continue
      occupy(occ, c, rot, pos)
      out.push(placement(rot, pos, c.center))
      break
    }
  }
  return out
}
