import { gaussian, uniform } from '../../../core/rng'
import type { PairField } from '../potential'
import { computeForces, createState, kineticEnergy, type MdState } from './step'

export interface LatticeInit {
  dim: 2 | 3
  /** 每个轴上的粒子数；n = perSide^dim。 / Particles per axis; n = perSide^dim. */
  perSide: number
  /**
   * 数密度 n / V。
   * Number density n / V.
   */
  density: number
  temperature: number
  seed: number
}

/**
 * 高斯分布的速度，净动量为零，并重标到精确的温度；随后计算受力。
 * Gaussian velocities with zero net momentum, rescaled to the exact temperature; then forces.
 */
function thermalise(s: MdState, temperature: number, seed: number, pair: PairField): MdState {
  const { dim, n } = s
  for (let k = 0; k < n * dim; k++) s.vel[k] = gaussian(seed, k)
  for (let d = 0; d < dim; d++) {
    let p = 0
    for (let i = 0; i < n; i++) p += s.vel[i * dim + d]
    for (let i = 0; i < n; i++) s.vel[i * dim + d] -= p / n
  }
  const target = 0.5 * dim * (n - 1) * temperature
  const scale = Math.sqrt(target / kineticEnergy(s))
  for (let k = 0; k < n * dim; k++) s.vel[k] *= scale
  computeForces(s, pair)
  return s
}

/** 正方/立方晶格。 / Square/cubic lattice. */
export function initLattice(o: LatticeInit, pair: PairField): MdState {
  const { dim, perSide } = o
  const n = Math.pow(perSide, dim)
  const L = Math.pow(n / o.density, 1 / dim)
  const s = createState(dim, n, [L, L, L])
  const a = L / perSide
  for (let i = 0; i < n; i++) {
    let rem = i
    for (let d = 0; d < dim; d++) {
      s.pos[i * dim + d] = ((rem % perSide) + 0.5) * a
      rem = Math.floor(rem / perSide)
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}

/**
 * 有 nx 列的二维三角晶格。行数取偶数，
 * 并使周期性盒子最接近所要求的宽高比（默认为正方形），
 * 这样晶格与盒子是公度的。
 * 2D triangular lattice with nx columns. The row count is the even number that brings the
 * periodic box closest to the requested aspect ratio (square by default), so the lattice
 * is commensurate with the box.
 */
export function initTriangular(
  o: {
    nx: number
    density: number
    temperature: number
    seed: number
    fractionB?: number
    aspect?: number
    /**
     * 把组分 B 放在横贯盒子中部的一条带内，而不是随机混入。
     * Put species B in a band across the middle of the box instead of mixing it at random.
     */
    stripe?: boolean
    /**
     * 圆盘障碍物，位置用盒子宽高的分数给出，半径用 σ。圆盘内及紧贴表面处不放粒子。
     * A disc obstacle: its position as fractions of the box width and height, its radius in σ.
     * No particles are placed inside the disc or right against its surface.
     */
    obstacle?: { fx: number; fy: number; r: number }
  },
  pair: PairField,
): MdState {
  // `aspect` 是盒子的宽除以高。 / `aspect` is the box's width over its height.
  const ny = Math.max(2, 2 * Math.round(o.nx / Math.sqrt(3) / (o.aspect ?? 1)))
  const a = Math.sqrt(2 / (Math.sqrt(3) * o.density))
  const box = [o.nx * a, (ny * a * Math.sqrt(3)) / 2]
  const disc = o.obstacle && { x: o.obstacle.fx * box[0]!, y: o.obstacle.fy * box[1]!, r: o.obstacle.r }
  const sites: { x: number; y: number; species: number }[] = []
  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < o.nx; col++) {
      const i = row * o.nx + col
      const x = (col + 0.25 + 0.5 * (row % 2)) * a
      const y = ((row + 0.5) * a * Math.sqrt(3)) / 2
      if (disc && Math.hypot(x - disc.x, y - disc.y) < disc.r + 0.6) continue
      const fractionB = o.fractionB ?? 0
      // 要么是横贯中部的一条带，要么各粒子独立随机指定（理想混合物）。
      // Either a band across the middle, or independently at random (an ideal mixture).
      const species = (o.stripe ? Math.abs((row + 0.5) / ny - 0.5) < fractionB / 2 : uniform(o.seed ^ 0x51ec1e5, i) < fractionB) ? 1 : 0
      sites.push({ x, y, species })
    }
  }
  const s = createState(2, sites.length, box)
  sites.forEach((site, i) => {
    s.pos[2 * i] = site.x
    s.pos[2 * i + 1] = site.y
    s.species[i] = site.species
  })
  if (disc) s.obstacle = disc
  return thermalise(s, o.temperature, o.seed, pair)
}

/**
 * 三维面心立方晶格，每边 `cells` 个惯用晶胞（每个晶胞 4 个粒子），置于立方周期性盒子中。
 * 3D face-centred cubic lattice of `cells` conventional cells per side (4 particles each)
 * in a cubic periodic box.
 */
export function initFcc(
  o: { cells: number; density: number; temperature: number; seed: number; fractionB?: number },
  pair: PairField,
): MdState {
  const n = 4 * o.cells ** 3
  const L = Math.cbrt(n / o.density)
  const a = L / o.cells
  const s = createState(3, n, [L, L, L])
  const basis = [
    [0, 0, 0],
    [0.5, 0.5, 0],
    [0.5, 0, 0.5],
    [0, 0.5, 0.5],
  ]
  let i = 0
  for (let z = 0; z < o.cells; z++) {
    for (let y = 0; y < o.cells; y++) {
      for (let x = 0; x < o.cells; x++) {
        for (const b of basis) {
          s.pos[3 * i] = (x + b[0]! + 0.25) * a
          s.pos[3 * i + 1] = (y + b[1]! + 0.25) * a
          s.pos[3 * i + 2] = (z + b[2]! + 0.25) * a
          s.species[i] = uniform(o.seed ^ 0x51ec1e5, i) < (o.fractionB ?? 0) ? 1 : 0
          i++
        }
      }
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}
