// 把微观状态归约为构建各层级所用的少量摘要。在 GPU 上，这些归约变成计算通道，其输出被回读。
// Reductions of the micro state to the small summaries the levels are built from.
// On the GPU these become compute passes whose output is read back.

import { buildCells, makeGrid } from './cells'
import { kineticEnergy, momentum, pressure, temperature, volume, type MdState } from './step'

/** 粗粒化场每个轴上的单元数。 / Cells per axis of the coarse-grained fields. */
export const FIELD_G = 48

/**
 * 粗粒化网格的格数：y 方向固定 FIELD_G 格，x 方向按盒子的宽高比取 1 到 4 倍，使格子大致为正方。
 * Cells of the coarse-graining grid: FIELD_G along y, and 1 to 4 times that along x
 * following the box's aspect ratio, so that cells are roughly square.
 */
export function fieldGrid(box: ArrayLike<number>): [number, number] {
  return [FIELD_G * Math.max(1, Math.min(4, Math.round(box[0]! / box[1]!))), FIELD_G]
}

/**
 * g × g 网格中各单元内粒子的逐单元求和，按行主序存储，y 为行。
 * Per-cell sums over the particles in each cell of a g × g grid, row-major with y as the row.
 */
export interface FieldSums {
  /** 沿 x 与沿 y 的格数 / Cells along x and along y */
  gx: number
  gy: number
  count: Float64Array
  vx: Float64Array
  vy: Float64Array
  /** Σ |v|² */
  v2: Float64Array
  /** 组分 B 的粒子数。 / Number of species-B particles. */
  countB: Float64Array
}

export interface MdScalars {
  n: number
  dim: 2 | 3
  ke: number
  pe: number
  density: number
  temperature: number
  pressure: number
  /** 每粒子总动量的大小。 / Magnitude of total momentum per particle. */
  momentum: number
  /**
   * |ψ6| 对粒子的平均：局域六角序，对晶粒取向不敏感。
   * Mean of |ψ6| over particles: local hexatic order, insensitive to grain orientation.
   */
  psi6Local: number
  /** |ψ6 的平均|：在整个盒子内相干的六角序。 / |mean of ψ6|: hexatic order coherent across the whole box. */
  psi6Global: number
  /**
   * COORDINATION_RADIUS 以内的平均近邻数：三角晶格为 6，fcc 为 12。
   * Mean number of neighbours within COORDINATION_RADIUS: 6 for a triangular lattice, 12 for fcc.
   */
  coordination: number
  /** 组分 B 的粒子所占比例。 / Fraction of particles that are species B. */
  fractionB: number
  /**
   * 分相序参量：1 - (异类近邻键所占比例) / (2 xA xB)。
   * 随机混合时为 0，两种组分分离时趋近 1；单组分时为 0。
   * Demixing order parameter: 1 - (fraction of unlike neighbour bonds) / (2 xA xB).
   * 0 for a random mixture, approaching 1 as the species separate; 0 for one component.
   */
  demix: number
}

/**
 * 六角序参量所用的近邻位于此距离之内。
 * Neighbours for the hexatic order parameter lie within this distance.
 */
export const PSI_RADIUS = 1.5

/**
 * 配位数所用的最近邻位于此距离之内：超出密堆积固体的第一壳层而不及第二壳层，二维和三维都如此。
 * Nearest neighbours for the coordination number lie within this distance: beyond the
 * first shell of a close-packed solid and short of the second, in 2D and in 3D.
 */
export const COORDINATION_RADIUS = 1.35

export interface Hist {
  /** 各分箱的中心。 / Bin centres. */
  x: Float64Array
  y: Float64Array
}

/**
 * 每个粒子的六角键取向序（二维）：ψ6 = Σ exp(6 i θ) / max(n, 6)，
 * 对 PSI_RADIUS 以内的 n 个近邻求和。除数至少取 6，可避免孤立的粒子对或表面粒子被算作完全有序。
 * 返回交错排列的 (Re, Im)。
 * Hexatic bond-orientational order per particle (2D): ψ6 = Σ exp(6 i θ) / max(n, 6) over
 * the n neighbours within PSI_RADIUS. Dividing by at least 6 keeps an isolated pair or a
 * surface particle from counting as perfectly ordered. Returns interleaved (Re, Im).
 */
export function psi6(s: MdState): Float64Array {
  const out = new Float64Array(2 * s.n)
  const count = new Float64Array(s.n)
  const { pos, box, dim } = s
  forEachPair(s, PSI_RADIUS, (i, j) => {
    let dx = pos[i * dim] - pos[j * dim]
    let dy = pos[i * dim + 1] - pos[j * dim + 1]
    dx -= box[0] * Math.round(dx / box[0])
    if (!s.walls) dy -= box[1] * Math.round(dy / box[1])
    // 同一条键无论从哪一端看，exp(6 i θ) 都相同。 / exp(6 i θ) is the same for the bond seen from either end.
    const theta = 6 * Math.atan2(dy, dx)
    const re = Math.cos(theta)
    const im = Math.sin(theta)
    out[2 * i] += re
    out[2 * i + 1] += im
    out[2 * j] += re
    out[2 * j + 1] += im
    count[i]++
    count[j]++
  })
  for (let i = 0; i < s.n; i++) {
    const norm = Math.max(count[i], 6)
    out[2 * i] /= norm
    out[2 * i + 1] /= norm
  }
  return out
}

/**
 * PSI_RADIUS 以内的近邻键：总数，以及连接不同组分的键数。
 * Neighbour bonds within PSI_RADIUS: total, and those joining different species.
 */
export function bondCounts(s: MdState): { total: number; unlike: number } {
  let total = 0
  let unlike = 0
  forEachPair(s, PSI_RADIUS, (i, j) => {
    total++
    if (s.species[i] !== s.species[j]) unlike++
  })
  return { total, unlike }
}

/** COORDINATION_RADIUS 以内的平均近邻数。 / Mean number of neighbours within COORDINATION_RADIUS. */
export function coordination(s: MdState): number {
  let bonds = 0
  forEachPair(s, COORDINATION_RADIUS, () => bonds++)
  return (2 * bonds) / s.n
}

export function demixing(fractionB: number, bonds: { total: number; unlike: number }): number {
  const random = 2 * fractionB * (1 - fractionB)
  if (random === 0 || bonds.total === 0) return 0
  return 1 - bonds.unlike / bonds.total / random
}

export function scalars(s: MdState): MdScalars {
  const p = momentum(s)
  let psiRe = 0
  let psiIm = 0
  let psiAbs = 0
  if (s.dim === 2) {
    const psi = psi6(s)
    for (let i = 0; i < s.n; i++) {
      psiRe += psi[2 * i]
      psiIm += psi[2 * i + 1]
      psiAbs += Math.hypot(psi[2 * i], psi[2 * i + 1])
    }
  }
  let nB = 0
  for (let i = 0; i < s.n; i++) nB += s.species[i]
  const fractionB = nB / s.n
  return {
    n: s.n,
    dim: s.dim,
    ke: kineticEnergy(s),
    pe: s.pe,
    density: s.n / volume(s),
    temperature: temperature(s),
    pressure: pressure(s),
    momentum: Math.hypot(...p) / s.n,
    psi6Local: psiAbs / s.n,
    psi6Global: Math.hypot(psiRe, psiIm) / s.n,
    coordination: coordination(s),
    fractionB,
    demix: nB > 0 ? demixing(fractionB, bondCounts(s)) : 0,
  }
}

export function speeds(s: MdState): Float64Array {
  const out = new Float64Array(s.n)
  for (let i = 0; i < s.n; i++) {
    let v2 = 0
    for (let d = 0; d < s.dim; d++) v2 += s.vel[i * s.dim + d] * s.vel[i * s.dim + d]
    out[i] = Math.sqrt(v2)
  }
  return out
}

/**
 * 速率直方图，归一化为 [0, vmax] 上的概率密度。
 * Speed histogram normalised as a probability density on [0, vmax].
 */
export function speedHistogram(s: MdState, bins: number, vmax: number): Hist {
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  const w = vmax / bins
  for (const v of speeds(s)) {
    const b = Math.floor(v / w)
    if (b < bins) y[b]++
  }
  for (let b = 0; b < bins; b++) {
    x[b] = (b + 0.5) * w
    y[b] /= s.n * w
  }
  return { x, y }
}

/**
 * 对每个间距小于 r 的无序粒子对恰好访问一次。r 以最短盒边的一半为上限。
 * Visit each unordered pair closer than r once. r is capped at half the shortest box side.
 */
export function forEachPair(s: MdState, r: number, fn: (i: number, j: number, r2: number) => void): void {
  const { dim, n, pos, box } = s
  let half = Infinity
  for (let d = 0; d < dim; d++) half = Math.min(half, box[d] / 2)
  r = Math.min(r, half)
  const r2max = r * r
  const dist2 = (i: number, j: number) => {
    let r2 = 0
    for (let d = 0; d < dim; d++) {
      let dx = pos[i * dim + d] - pos[j * dim + d]
      if (!(s.walls && d === 1)) dx -= box[d] * Math.round(dx / box[d])
      r2 += dx * dx
    }
    return r2
  }
  const grid = makeGrid(dim, box, r, n)
  if (!grid) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r2 = dist2(i, j)
        if (r2 < r2max) fn(i, j, r2)
      }
    }
    return
  }
  buildCells(grid, dim, pos, box, n)
  const [nx, ny, nz] = grid.nc
  const zr = dim === 3 ? 1 : 0
  for (let i = 0; i < n; i++) {
    const c = grid.cellOf[i]
    const cx = c % nx
    const cy = Math.floor(c / nx) % ny
    const cz = Math.floor(c / (nx * ny))
    for (let oz = -zr; oz <= zr; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cc = ((cx + ox + nx) % nx) + nx * (((cy + oy + ny) % ny) + ny * ((cz + oz + nz) % nz))
          for (let k = grid.start[cc]; k < grid.start[cc + 1]; k++) {
            const j = grid.items[k]
            if (j <= i) continue
            const r2 = dist2(i, j)
            if (r2 < r2max) fn(i, j, r2)
          }
        }
      }
    }
  }
}

/**
 * 把当前构型的粒子对间距计数累加到 `counts`；返回实际使用的 rmax。
 * Add this configuration's pair-distance counts to `counts`; returns the rmax actually used.
 */
export function rdfCounts(s: MdState, rmax: number, counts: Float64Array): number {
  const bins = counts.length
  let half = Infinity
  for (let d = 0; d < s.dim; d++) half = Math.min(half, s.box[d] / 2)
  const used = Math.min(rmax, half)
  forEachPair(s, used, (_i, _j, r2) => {
    const b = Math.floor((Math.sqrt(r2) / used) * bins)
    if (b < bins) counts[b]++
  })
  return used
}

/**
 * 把累积的粒子对计数换算成 g(r)：即相对于同密度理想气体的计数。
 * Turn accumulated pair counts into g(r): counts relative to an ideal gas at the same density.
 */
export function rdfNormalise(
  counts: Float64Array,
  rmax: number,
  n: number,
  vol: number,
  dim: 2 | 3,
  samples = 1,
): Hist {
  const bins = counts.length
  const w = rmax / bins
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    const r0 = b * w
    const r1 = r0 + w
    const shell = dim === 2 ? Math.PI * (r1 * r1 - r0 * r0) : (4 / 3) * Math.PI * (r1 * r1 * r1 - r0 * r0 * r0)
    x[b] = r0 + 0.5 * w
    y[b] = counts[b] / (samples * 0.5 * n * (n / vol) * shell)
  }
  return { x, y }
}

export function rdf(s: MdState, bins: number, rmax: number): Hist {
  const counts = new Float64Array(bins)
  const used = rdfCounts(s, rmax, counts)
  return rdfNormalise(counts, used, s.n, volume(s), s.dim)
}

/**
 * 用礼帽（top-hat）核把粒子粗粒化到网格上：
 * 这是 Irving–Kirkwood/Hardy 构造的最简情形，
 * 场的质量和动量与粒子的严格相等。
 * Coarse-grain the particles onto a grid with a top-hat kernel: the simplest case of the
 * Irving–Kirkwood/Hardy construction, in which mass and momentum of the fields equal
 * those of the particles exactly.
 */
export function fieldSums(s: MdState): FieldSums {
  const [gx, gy] = fieldGrid(s.box)
  const out: FieldSums = {
    gx,
    gy,
    count: new Float64Array(gx * gy),
    vx: new Float64Array(gx * gy),
    vy: new Float64Array(gx * gy),
    v2: new Float64Array(gx * gy),
    countB: new Float64Array(gx * gy),
  }
  const { dim, pos, vel, box } = s
  for (let i = 0; i < s.n; i++) {
    const cx = Math.min(gx - 1, Math.floor((pos[i * dim] / box[0]) * gx))
    const cy = Math.min(gy - 1, Math.floor((pos[i * dim + 1] / box[1]) * gy))
    const c = cy * gx + cx
    const vx = vel[i * dim]
    const vy = vel[i * dim + 1]
    out.count[c]++
    out.vx[c] += vx
    out.vy[c] += vy
    out.v2[c] += vx * vx + vy * vy
    out.countB[c] += s.species[i]
  }
  return out
}

/**
 * 沿 y 的剖面（对 x 平均）：数密度、流速 u_x、温度以及组分 B 所占比例。
 * Profiles across y (averaged over x): number density, flow velocity u_x, temperature, and the fraction of species B.
 */
export function profiles(
  f: FieldSums,
  box: ArrayLike<number>,
  bins = 24,
): { y: Float64Array; density: Float64Array; ux: Float64Array; temperature: Float64Array; fractionB: Float64Array } {
  const per = f.gy / bins
  const y = new Float64Array(bins)
  const density = new Float64Array(bins)
  const ux = new Float64Array(bins)
  const temperature = new Float64Array(bins)
  const fractionB = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    let nB = 0
    let n = 0
    let px = 0
    let py = 0
    let v2 = 0
    for (let row = b * per; row < (b + 1) * per; row++) {
      for (let cx = 0; cx < f.gx; cx++) {
        const c = row * f.gx + cx
        n += f.count[c]
        px += f.vx[c]
        py += f.vy[c]
        v2 += f.v2[c]
        nB += f.countB[c]
      }
    }
    y[b] = (b + 0.5) / bins
    // 二维时 box[2] 为 1。 / box[2] is 1 in 2D.
    density[b] = n / ((box[0]! * box[1]! * (box[2] ?? 1)) / bins)
    ux[b] = n > 0 ? px / n : 0
    // 相对于局域平均流的运动的动理学温度；场里只累计了 x、y 两个分量，三维时也按这两个分量算。
    // Kinetic temperature of the motion relative to the local mean flow; the field holds only the
    // x and y components, so in 3D too it is the temperature of those two.
    temperature[b] = n > 1 ? (v2 - (px * px + py * py) / n) / (2 * n) : 0
    fractionB[b] = n > 0 ? nB / n : 0
  }
  return { y, density, ux, temperature, fractionB }
}

/** 结构因子在每个轴上采样的波矢数。 / Wave vectors sampled per axis for the structure factor. */
export const MODE_COUNT = 48
/**
 * 结构因子采样到大约这个波数为止，已越过它的头几个峰。
 * The structure factor is sampled out to about this wave number, past its first peaks.
 */
const MODE_K_TARGET = 12

/**
 * 对边长为 L 的盒子每隔 `stride` 个波矢采样一个，使 MODE_COUNT 个波矢能达到 MODE_K_TARGET。
 * Sample every `stride`-th wave vector of a box of length L, so MODE_COUNT of them reach MODE_K_TARGET.
 */
export function modeStride(L: number): number {
  return Math.max(1, Math.ceil((L * MODE_K_TARGET) / (2 * Math.PI * MODE_COUNT)))
}

/**
 * 密度的傅里叶模 ρ_k = Σ exp(-i k·r)，波矢分别沿 x 和沿 y。布局为 (Re, Im) 对：
 * 先是沿 x 的最长波（n = 1）；然后是沿 x 的 MODE_COUNT 个模，n = stride, 2 stride, …；
 * 再是沿 y 的同样一组。
 * Fourier modes of the density, ρ_k = Σ exp(-i k·r), on wave vectors along x and along y.
 * Layout, as (Re, Im) pairs: the longest wave along x (n = 1); then MODE_COUNT modes along
 * x with n = stride, 2 stride, …; then the same along y.
 */
export interface DensityModes {
  data: Float64Array
  strideX: number
  strideY: number
}

export function densityModes(s: MdState): DensityModes {
  const strideX = modeStride(s.box[0])
  const strideY = modeStride(s.box[1])
  const data = new Float64Array(2 + 4 * MODE_COUNT)
  for (let i = 0; i < s.n; i++) {
    const tx = (2 * Math.PI * s.pos[i * s.dim]) / s.box[0]
    const ty = (2 * Math.PI * s.pos[i * s.dim + 1]) / s.box[1]
    data[0] += Math.cos(tx)
    data[1] -= Math.sin(tx)
    for (let j = 1; j <= MODE_COUNT; j++) {
      data[2 * j] += Math.cos(j * strideX * tx)
      data[2 * j + 1] -= Math.sin(j * strideX * tx)
      data[2 * (MODE_COUNT + j)] += Math.cos(j * strideY * ty)
      data[2 * (MODE_COUNT + j) + 1] -= Math.sin(j * strideY * ty)
    }
  }
  return { data, strideX, strideY }
}

/**
 * 由这些模得到静态结构因子 S(k) = |ρ_k|² / N，按波数排序。
 * Static structure factor S(k) = |ρ_k|² / N from the modes, sorted by wave number.
 */
export function structureFactor(m: DensityModes, n: number, box: ArrayLike<number>): { x: Float64Array; y: Float64Array } {
  const points: [number, number][] = []
  for (let j = 1; j <= MODE_COUNT; j++) {
    for (const [offset, k] of [
      [j, (2 * Math.PI * j * m.strideX) / box[0]!],
      [MODE_COUNT + j, (2 * Math.PI * j * m.strideY) / box[1]!],
    ] as const) {
      points.push([k, (m.data[2 * offset]! ** 2 + m.data[2 * offset + 1]! ** 2) / n])
    }
  }
  points.sort((a, b) => a[0] - b[0])
  return { x: Float64Array.from(points, (p) => p[0]), y: Float64Array.from(points, (p) => p[1]) }
}

/**
 * 选区内粒子的统计（仅二维）。g(r) 以区内每个粒子为中心统计它的所有邻居，
 * 并用选区自己的密度归一化。
 * Statistics over the particles inside a rectangle; in 3D the rectangle is extruded through the box along z. g(r) is centred on each
 * particle inside and counts all of its neighbours, normalised by the region's own density.
 */
export function regionFrame(
  s: MdState,
  region: readonly [number, number, number, number],
  ids: readonly string[],
  vmax: number,
): {
  n: number
  density: number
  temperature: number
  psi6Local: number
  coordination: number
  speedHist?: Hist
  rdf?: Hist
} {
  const [x0, y0, x1, y1] = region
  const dim = s.dim
  const inside = (i: number) => {
    const x = s.pos[dim * i]
    const y = s.pos[dim * i + 1]
    return x >= x0 && x < x1 && y >= y0 && y < y1
  }
  const speed2 = (i: number) => {
    let v2 = 0
    for (let d = 0; d < dim; d++) v2 += s.vel[dim * i + d] ** 2
    return v2
  }
  // 六角序参量只在二维有定义。 / The hexatic order parameter is defined in 2D only.
  const psi = dim === 2 ? psi6(s) : null
  let n = 0
  let ke = 0
  let psiAbs = 0
  for (let i = 0; i < s.n; i++) {
    if (!inside(i)) continue
    n++
    ke += 0.5 * speed2(i)
    if (psi) psiAbs += Math.hypot(psi[2 * i], psi[2 * i + 1])
  }
  let neighbours = 0
  forEachPair(s, COORDINATION_RADIUS, (i, j) => {
    neighbours += (inside(i) ? 1 : 0) + (inside(j) ? 1 : 0)
  })
  const measure = (x1 - x0) * (y1 - y0) * s.box[2]
  const out: ReturnType<typeof regionFrame> = {
    n,
    density: n / measure,
    // 选区不是孤立系统，不扣除质心自由度。 / The region is not isolated, so no centre-of-mass degrees of freedom are removed.
    temperature: n > 0 ? (2 * ke) / (dim * n) : 0,
    psi6Local: n > 0 ? psiAbs / n : 0,
    coordination: n > 0 ? neighbours / n : 0,
  }
  if (ids.includes('speedHist')) {
    const bins = 40
    const w = vmax / bins
    const x = new Float64Array(bins)
    const y = new Float64Array(bins)
    for (let i = 0; i < s.n; i++) {
      if (!inside(i)) continue
      const b = Math.floor(Math.sqrt(speed2(i)) / w)
      if (b < bins) y[b]++
    }
    for (let b = 0; b < bins; b++) {
      x[b] = (b + 0.5) * w
      y[b] /= Math.max(n, 1) * w
    }
    out.speedHist = { x, y }
  }
  if (ids.includes('rdf')) {
    const bins = 120
    let half = Infinity
    for (let d = 0; d < dim; d++) half = Math.min(half, s.box[d] / 2)
    const rmax = Math.min(4, half)
    const counts = new Float64Array(bins)
    forEachPair(s, rmax, (i, j, r2) => {
      const b = Math.floor((Math.sqrt(r2) / rmax) * bins)
      if (b < bins) counts[b] += (inside(i) ? 1 : 0) + (inside(j) ? 1 : 0)
    })
    out.rdf = regionRdf(counts, rmax, n, measure, dim)
  }
  return out
}

/**
 * 把以区内粒子为中心的有序对计数化为 g(r)：除以 n · ρ_区 · 环面积（三维是球壳体积）。
 * `measure` 是选区的面积（三维是体积）。
 * Turn ordered pair counts centred on the region's particles into g(r): divide by
 * n · ρ_region · ring area (shell volume in 3D). `measure` is the region's area (volume in 3D).
 */
export function regionRdf(counts: ArrayLike<number>, rmax: number, n: number, measure: number, dim: 2 | 3 = 2): Hist {
  const bins = counts.length
  const w = rmax / bins
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    const r0 = b * w
    const r1 = (b + 1) * w
    const ring = dim === 2 ? Math.PI * (r1 * r1 - r0 * r0) : (4 / 3) * Math.PI * (r1 ** 3 - r0 ** 3)
    x[b] = (b + 0.5) * w
    y[b] = n > 0 ? counts[b]! / (n * (n / measure) * ring) : 0
  }
  return { x, y }
}

/** 每个粒子的 q₆ 向量的实分量个数：m = 0 一个，m = 1..6 各两个。 / Real components of a particle's q₆ vector: one for m = 0, two each for m = 1..6. */
export const Q6_COMPONENTS = 13

/** q̄₆ 高于此值的粒子算作处在晶体环境里；液体约 0.15–0.2，面心立方约 0.57。 / A particle with q̄₆ above this counts as crystalline; a liquid has about 0.15–0.2, fcc about 0.57. */
export const Q6_CRYSTAL = 0.3

// g_m = 2 (6 − m)! / (6 + m)!（m = 0 时为 1）的平方根：乘上它之后，q₆² 就是各分量的平方和。
// Square roots of g_m = 2 (6 − m)! / (6 + m)! (1 for m = 0): scaled by these, q₆² is the plain sum of squares of the components.
const Q6_WEIGHT = (() => {
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))
  return Array.from({ length: 7 }, (_, m) => Math.sqrt(m === 0 ? 1 : (2 * factorial(6 - m)) / factorial(6 + m)))
})()

/**
 * 把单位键矢量 (x, y, z) 的 l = 6 球谐分量累加到 out[offset..offset+13)。
 * 用 Y₆ₘ ∝ (dᵐP₆/dzᵐ)(z) · (x + iy)ᵐ，其中 P₆(z) = (231 z⁶ − 315 z⁴ + 105 z² − 5) / 16。
 *
 * Add the l = 6 spherical-harmonic components of a unit bond vector (x, y, z) to
 * out[offset..offset+13), using Y₆ₘ ∝ (dᵐP₆/dzᵐ)(z) · (x + iy)ᵐ with
 * P₆(z) = (231 z⁶ − 315 z⁴ + 105 z² − 5) / 16.
 */
export function addQ6(out: Float64Array, offset: number, x: number, y: number, z: number): void {
  const z2 = z * z
  const d = [
    (231 * z2 * z2 * z2 - 315 * z2 * z2 + 105 * z2 - 5) / 16,
    (1386 * z2 * z2 * z - 1260 * z2 * z + 210 * z) / 16,
    (6930 * z2 * z2 - 3780 * z2 + 210) / 16,
    (27720 * z2 * z - 7560 * z) / 16,
    (83160 * z2 - 7560) / 16,
    (166320 * z) / 16,
    166320 / 16,
  ]
  out[offset] += Q6_WEIGHT[0]! * d[0]!
  // (x + iy)ᵐ 逐次相乘得到。 / (x + iy)ᵐ by repeated multiplication.
  let re = 1
  let im = 0
  for (let m = 1; m <= 6; m++) {
    const r = re * x - im * y
    im = re * y + im * x
    re = r
    out[offset + 2 * m - 1] += Q6_WEIGHT[m]! * d[m]! * re
    out[offset + 2 * m] += Q6_WEIGHT[m]! * d[m]! * im
  }
}

/**
 * Steinhardt 键取向序参量（Steinhardt, Nelson & Ronchetti 1983），三维。对每个粒子，把它到
 * `radius` 内各近邻的键方向的 l = 6 球谐分量取平均，得到 13 维向量 q₆ₘ；其模长就是局域的 q₆。
 * 再把自己和各近邻的向量取平均、取模，得到 q̄₆（Lechner & Dellago 2008）：它把液体和晶体分得开得多。
 *
 * Steinhardt bond-orientational order (Steinhardt, Nelson & Ronchetti 1983), in 3D. For
 * each particle the l = 6 spherical-harmonic components of the bond directions to its
 * neighbours within `radius` are averaged into a 13-component vector q₆ₘ, whose length is
 * the local q₆. Averaging that vector over the particle and its neighbours and taking the
 * length gives q̄₆ (Lechner & Dellago 2008), which separates liquid from crystal far better.
 */
export function steinhardt(s: MdState, radius = COORDINATION_RADIUS): { local: Float64Array; averaged: Float64Array } {
  const n = s.n
  const vectors = new Float64Array(n * Q6_COMPONENTS)
  const count = new Float64Array(n)
  const pairs: number[] = []
  const { pos, box } = s
  forEachPair(s, radius, (i, j, r2) => {
    const r = Math.sqrt(r2)
    let dx = pos[3 * j] - pos[3 * i]
    let dy = pos[3 * j + 1] - pos[3 * i + 1]
    let dz = pos[3 * j + 2] - pos[3 * i + 2]
    dx -= box[0] * Math.round(dx / box[0])
    dy -= box[1] * Math.round(dy / box[1])
    dz -= box[2] * Math.round(dz / box[2])
    // l 为偶数，键从哪一端看都一样。 / l is even, so the bond looks the same from either end.
    addQ6(vectors, i * Q6_COMPONENTS, dx / r, dy / r, dz / r)
    addQ6(vectors, j * Q6_COMPONENTS, dx / r, dy / r, dz / r)
    count[i]++
    count[j]++
    pairs.push(i, j)
  })
  const local = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < Q6_COMPONENTS; c++) {
      if (count[i] > 0) vectors[i * Q6_COMPONENTS + c] /= count[i]
      sum += vectors[i * Q6_COMPONENTS + c] ** 2
    }
    local[i] = Math.sqrt(sum)
  }
  const mean = Float64Array.from(vectors)
  for (let k = 0; k < pairs.length; k += 2) {
    const i = pairs[k]!
    const j = pairs[k + 1]!
    for (let c = 0; c < Q6_COMPONENTS; c++) {
      mean[i * Q6_COMPONENTS + c] += vectors[j * Q6_COMPONENTS + c]
      mean[j * Q6_COMPONENTS + c] += vectors[i * Q6_COMPONENTS + c]
    }
  }
  const averaged = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < Q6_COMPONENTS; c++) sum += (mean[i * Q6_COMPONENTS + c] / (count[i] + 1)) ** 2
    averaged[i] = Math.sqrt(sum)
  }
  return { local, averaged }
}

/** 全体的平均 q₆、平均 q̄₆，以及 q̄₆ 超过 Q6_CRYSTAL 的粒子比例。 / Mean q₆, mean q̄₆ and the fraction of particles with q̄₆ above Q6_CRYSTAL. */
export interface Q6Summary {
  local: number
  averaged: number
  crystalFraction: number
}

export function q6Summary(s: MdState): Q6Summary {
  const { local, averaged } = steinhardt(s)
  let a = 0
  let b = 0
  let c = 0
  for (let i = 0; i < s.n; i++) {
    a += local[i]
    b += averaged[i]
    if (averaged[i] > Q6_CRYSTAL) c++
  }
  return { local: a / s.n, averaged: b / s.n, crystalFraction: c / s.n }
}

/** 两个分子的尾珠相距不到这个距离，就算在同一个聚集体里。 / Two molecules belong to one aggregate when tail beads of theirs are closer than this. */
export const AGGREGATE_RADIUS = 1.5
/** 聚集数分布画到这个大小为止，更大的并入最后一格。 / The aggregation-number distribution is drawn up to this size; larger ones go in the last bin. */
export const AGGREGATE_BINS = 60

export interface Aggregates {
  /** 分子总数。 / Number of molecules. */
  molecules: number
  /** 独自一个、没有和别的分子聚在一起的分子所占的比例。 / Fraction of molecules on their own, aggregated with no other. */
  free: number
  /** 按分子加权的平均聚集数：随机挑一个分子，它所在聚集体的平均大小。 / Weight-average aggregation number: the mean size of the aggregate a randomly chosen molecule is in. */
  mean: number
  largest: number
  /** sizes[k] 是处在大小为 k + 1 的聚集体里的分子所占的比例。 / sizes[k] is the fraction of molecules in aggregates of size k + 1. */
  sizes: Float64Array
}

/**
 * 两亲分子的聚集体统计（二维）。位置数组每个粒子占 `stride` 个数，前两个是 x、y；
 * 分子 m 的珠子是下标 m·chain 起的 chain 个，第一个是头，其余是尾。用并查集把尾珠靠近的分子并到一起。
 * Aggregate statistics for amphiphiles (2D). The position array holds `stride` numbers per
 * particle, x and y first; molecule m owns the chain beads from index m·chain, the first a
 * head and the rest tails. A union–find merges molecules whose tail beads are close.
 */
export function aggregates(
  pos: ArrayLike<number>,
  stride: number,
  n: number,
  chain: number,
  box: ArrayLike<number>,
  radius = AGGREGATE_RADIUS,
): Aggregates {
  const molecules = Math.floor(n / chain)
  const parent = Int32Array.from({ length: molecules }, (_, m) => m)
  const find = (m: number): number => {
    while (parent[m] !== m) {
      parent[m] = parent[parent[m]!]!
      m = parent[m]!
    }
    return m
  }
  const [lx, ly] = [box[0]!, box[1]!]
  const nx = Math.max(1, Math.floor(lx / radius))
  const ny = Math.max(1, Math.floor(ly / radius))
  // 尾珠按元胞排成链表。 / Tail beads threaded into per-cell linked lists.
  const head = new Int32Array(nx * ny).fill(-1)
  const next = new Int32Array(n).fill(-1)
  const cellOf = (i: number) => {
    const cx = Math.min(nx - 1, Math.floor((pos[stride * i]! / lx) * nx))
    const cy = Math.min(ny - 1, Math.floor((pos[stride * i + 1]! / ly) * ny))
    return [cx, cy] as const
  }
  for (let i = 0; i < molecules * chain; i++) {
    if (i % chain === 0) continue
    const [cx, cy] = cellOf(i)
    next[i] = head[cy * nx + cx]!
    head[cy * nx + cx] = i
  }
  const r2max = radius * radius
  for (let i = 0; i < molecules * chain; i++) {
    if (i % chain === 0) continue
    const mi = Math.floor(i / chain)
    const [cx, cy] = cellOf(i)
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        // 盒子不足三个元胞宽时，同一个元胞会被访问多次，无妨。
        // With fewer than three cells across, a cell is visited more than once, which is harmless.
        const c = ((cy + oy + ny) % ny) * nx + ((cx + ox + nx) % nx)
        for (let j = head[c]!; j >= 0; j = next[j]!) {
          const mj = Math.floor(j / chain)
          if (mj <= mi) continue
          let dx = pos[stride * i]! - pos[stride * j]!
          let dy = pos[stride * i + 1]! - pos[stride * j + 1]!
          dx -= lx * Math.round(dx / lx)
          dy -= ly * Math.round(dy / ly)
          if (dx * dx + dy * dy < r2max) {
            const a = find(mi)
            const b = find(mj)
            if (a !== b) parent[a] = b
          }
        }
      }
    }
  }
  const count = new Int32Array(molecules)
  for (let m = 0; m < molecules; m++) count[find(m)]!++
  const sizes = new Float64Array(AGGREGATE_BINS)
  let free = 0
  let mean = 0
  let largest = 0
  for (let m = 0; m < molecules; m++) {
    const size = count[m]!
    if (size === 0) continue
    if (size === 1) free += 1
    mean += size * size
    largest = Math.max(largest, size)
    sizes[Math.min(size, AGGREGATE_BINS) - 1]! += size
  }
  for (let k = 0; k < AGGREGATE_BINS; k++) sizes[k] = sizes[k]! / Math.max(molecules, 1)
  return { molecules, free: free / Math.max(molecules, 1), mean: mean / Math.max(molecules, 1), largest, sizes }
}
