// f64 的 CPU 参考分子动力学。它是校验 GPU 内核时所依据的规范。
// 约化单位、单位质量、周期性盒子，维数为 2 或 3。
// CPU reference molecular dynamics in f64. This is the specification the GPU kernels
// are checked against. Reduced units, unit mass, periodic box, dimension 2 or 3.

import { gaussian, uniform } from '../../../core/rng'
import type { PairField, PairOut } from '../potential'
import { buildCells, makeGrid, type CellGrid } from './cells'

export interface MdState {
  dim: 2 | 3
  n: number
  /** 盒子边长，长度为 3；未使用的轴为 1。 / Box lengths, length 3; unused axes are 1. */
  box: Float64Array
  /** n * dim，已折回到 [0, box)。 / n * dim, wrapped into [0, box). */
  pos: Float64Array
  vel: Float64Array
  force: Float64Array
  /**
   * 每个粒子的组分索引；单组分体系全为零。
   * Species index per particle; all zero for a one-component system.
   */
  species: Uint8Array
  /** 当前位置下的总势能。 / Total potential energy for the current positions. */
  pe: number
  /** 对粒子对求 r · f 之和，用于位力压强。 / Sum over pairs of r · f, for the virial pressure. */
  virial: number
  /**
   * 位力张量的 xy 分量：对所有粒子对求 Σ x_ij f_ij,y，用于切应力。
   * The xy component of the virial tensor, Σ over pairs of x_ij f_ij,y, for the shear stress.
   */
  virialXY: number
  /**
   * 不折回周期边界的累计位移（n * dim），用于均方位移；null 表示不记录。
   * Displacement accumulated without wrapping at the periodic boundaries (n * dim), for
   * the mean-square displacement; null when not being recorded.
   */
  disp: Float64Array | null
  step: number
  grid: CellGrid | null
  /**
   * 在 y = 0 和 y = box[1] 处设热壁，取代周期性的 y 轴：
   * 越过壁面的粒子被放回盒内，并以按壁面温度抽取的速度重新出射。
   * Thermal walls at y = 0 and y = box[1] instead of a periodic y axis: a particle that
   * crosses is put back and re-emitted with a velocity drawn from the wall temperature.
   */
  walls: boolean
  /** y = 0 处壁面的温度 / Temperature of the wall at y = 0 */
  wallTemperature: number
  /** y = box[1] 处壁面的温度 / Temperature of the wall at y = box[1] */
  wallTemperatureFar: number
  /** 每个粒子沿 +y 方向受到的均匀体力（重力）。 / Uniform body force per particle along +y (gravity). */
  gravity: number
  /**
   * 固定的圆盘障碍物：圆心与半径。粒子受到来自圆盘表面的短程排斥。
   * A fixed disc obstacle: centre and radius. Particles feel a short-range repulsion from its surface.
   */
  obstacle: { x: number; y: number; r: number } | null
  /** 每个粒子沿 x 方向受到的均匀体力。 / Uniform body force per particle along x. */
  drive: number
  /**
   * 每个分子的珠子数；0 或 1 表示不成键。分子 m 的珠子是下标 m·chain 到 (m+1)·chain − 1，
   * 相邻下标的两个珠子之间有一根弹簧。
   * Beads per molecule; 0 or 1 means no bonds. Molecule m owns indices m·chain to
   * (m+1)·chain − 1, and beads with consecutive indices are joined by a spring.
   */
  chain: number
  /** 键的劲度系数与平衡长度：U = ½ k (r − r₀)²。 / Stiffness and rest length of a bond: U = ½ k (r − r₀)². */
  bondK: number
  bondR0: number
  seed: number
}

export function createState(dim: 2 | 3, n: number, box: ArrayLike<number>): MdState {
  const b = new Float64Array([1, 1, 1])
  for (let d = 0; d < dim; d++) b[d] = box[d]
  return {
    dim,
    n,
    box: b,
    pos: new Float64Array(n * dim),
    vel: new Float64Array(n * dim),
    force: new Float64Array(n * dim),
    species: new Uint8Array(n),
    pe: 0,
    virial: 0,
    virialXY: 0,
    disp: null,
    step: 0,
    grid: null,
    walls: false,
    wallTemperature: 1,
    wallTemperatureFar: 1,
    gravity: 0,
    obstacle: null,
    drive: 0,
    chain: 0,
    bondK: 0,
    bondR0: 1,
    seed: 0,
  }
}

const out: PairOut = { g: 0, u: 0 }
const back: PairOut = { g: 0, u: 0 }

/**
 * 重新计算受力、势能和位力。每个粒子扫描完整的 3^dim 模板。
 * Recompute forces, potential energy and virial. Each particle scans the full 3^dim stencil.
 */
export function computeForces(s: MdState, pair: PairField, allPairs = false): void {
  const { dim, n, pos, force, box, species } = s
  const bx = box[0]
  const by = box[1]
  // 有壁面时 y 轴不是周期性的，因此沿该方向不取最小镜像。
  // With walls the y axis is not periodic, so no minimum image is taken along it.
  const wrapY = !s.walls
  const bz = box[2]
  const rc2 = pair.rc2
  force.fill(0)
  let pe = 0
  let virial = 0
  let virialXY = 0

  const rc = Math.sqrt(rc2)
  if (!allPairs && (!s.grid || s.grid.rc !== rc)) s.grid = makeGrid(dim, box, rc, n)
  const grid = allPairs ? null : s.grid

  if (!grid) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * dim] - pos[j * dim]
        let dy = pos[i * dim + 1] - pos[j * dim + 1]
        let dz = dim === 3 ? pos[i * dim + 2] - pos[j * dim + 2] : 0
        dx -= bx * Math.round(dx / bx)
        if (wrapY) dy -= by * Math.round(dy / by)
        dz -= bz * Math.round(dz / bz)
        const r2 = dx * dx + dy * dy + dz * dz
        if (r2 >= rc2) continue
        // j 所受的力单独计算：相互作用非互易时它与前者不同。
        // The force on j is evaluated separately: it differs when the interaction is not reciprocal.
        pair.eval(r2, out, species[i], species[j])
        pair.eval(r2, back, species[j], species[i])
        force[i * dim] += out.g * dx
        force[i * dim + 1] += out.g * dy
        force[j * dim] -= back.g * dx
        force[j * dim + 1] -= back.g * dy
        if (dim === 3) {
          force[i * dim + 2] += out.g * dz
          force[j * dim + 2] -= back.g * dz
        }
        pe += 0.5 * (out.u + back.u)
        virial += 0.5 * (out.g + back.g) * r2
        virialXY += 0.5 * (out.g + back.g) * dx * dy
      }
    }
  } else {
    buildCells(grid, dim, pos, box, n)
    const [nx, ny, nz] = grid.nc
    const { start, items, cellOf } = grid
    const zr = dim === 3 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]
      const cx = c % nx
      const cy = Math.floor(c / nx) % ny
      const cz = Math.floor(c / (nx * ny))
      const xi = pos[i * dim]
      const yi = pos[i * dim + 1]
      const zi = dim === 3 ? pos[i * dim + 2] : 0
      const si = species[i]
      let fx = 0
      let fy = 0
      let fz = 0
      for (let oz = -zr; oz <= zr; oz++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const cc = ((cx + ox + nx) % nx) + nx * (((cy + oy + ny) % ny) + ny * ((cz + oz + nz) % nz))
            for (let k = start[cc]; k < start[cc + 1]; k++) {
              const j = items[k]
              if (j === i) continue
              let dx = xi - pos[j * dim]
              let dy = yi - pos[j * dim + 1]
              let dz = dim === 3 ? zi - pos[j * dim + 2] : 0
              dx -= bx * Math.round(dx / bx)
              if (wrapY) dy -= by * Math.round(dy / by)
              dz -= bz * Math.round(dz / bz)
              const r2 = dx * dx + dy * dy + dz * dz
              if (r2 >= rc2) continue
              pair.eval(r2, out, si, species[j])
              fx += out.g * dx
              fy += out.g * dy
              fz += out.g * dz
              pe += 0.5 * out.u
              virial += 0.5 * out.g * r2
              virialXY += 0.5 * out.g * dx * dy
            }
          }
        }
      }
      force[i * dim] = fx
      force[i * dim + 1] = fy
      if (dim === 3) force[i * dim + 2] = fz
    }
  }
  if (s.obstacle) pe += obstacleForces(s)
  s.pe = pe
  s.virial = virial
  s.virialXY = virialXY
  if (s.chain > 1) bondForces(s)
}

/**
 * 分子内相邻珠子之间的弹簧力，加到受力、势能和位力上。
 * Spring forces between consecutive beads of a molecule, added to the forces, the potential energy and the virial.
 */
function bondForces(s: MdState): void {
  const { dim, n, pos, force, box, chain } = s
  for (let i = 0; i + 1 < n; i++) {
    if ((i + 1) % chain === 0) continue
    const j = i + 1
    let r2 = 0
    const d = [0, 0, 0]
    for (let k = 0; k < dim; k++) {
      let x = pos[i * dim + k] - pos[j * dim + k]
      if (!(s.walls && k === 1)) x -= box[k] * Math.round(x / box[k])
      d[k] = x
      r2 += x * x
    }
    const r = Math.sqrt(r2)
    // g = f / r，与对相互作用的约定相同。 / g = f / r, the same convention as for the pair interaction.
    const g = (-s.bondK * (r - s.bondR0)) / r
    for (let k = 0; k < dim; k++) {
      force[i * dim + k] += g * d[k]!
      force[j * dim + k] -= g * d[k]!
    }
    s.pe += 0.5 * s.bondK * (r - s.bondR0) ** 2
    s.virial += g * r2
    s.virialXY += g * d[0]! * d[1]!
  }
}

/** 圆盘表面排斥势的作用范围：Lennard-Jones 势阱的位置。 / Range of the disc's surface repulsion: the Lennard-Jones minimum. */
const OBSTACLE_RANGE = Math.pow(2, 1 / 6)

/**
 * 把固定圆盘的排斥力加到各粒子上，返回它贡献的势能。以到圆盘表面的距离加 1 为自变量 s，
 * 用截断在势阱处并上移的 Lennard-Jones 排斥 u = 4 (s⁻¹² − s⁻⁶) + 1：表面正好在 s = 1。
 *
 * Add the repulsion of the fixed disc to the particles and return the potential energy it
 * contributes. With s the distance to the disc's surface plus 1, the force is the
 * Lennard-Jones repulsion cut at its minimum and shifted up, u = 4 (s⁻¹² − s⁻⁶) + 1, so
 * that the surface sits at s = 1.
 */
function obstacleForces(s: MdState): number {
  const { dim, n, pos, force, box } = s
  const o = s.obstacle!
  let pe = 0
  for (let i = 0; i < n; i++) {
    let dx = pos[i * dim] - o.x
    let dy = pos[i * dim + 1] - o.y
    dx -= box[0] * Math.round(dx / box[0])
    if (!s.walls) dy -= box[1] * Math.round(dy / box[1])
    const d = Math.hypot(dx, dy)
    // 钳在 0.5 以上，深入圆盘内部的粒子受到的力很大但有限。
    // Clamped at 0.5, so a particle deep inside the disc feels a large but finite force.
    const t = Math.max(d - o.r + 1, 0.5)
    if (t >= OBSTACLE_RANGE || d === 0) continue
    const i6 = Math.pow(t, -6)
    const f = (24 * (2 * i6 * i6 - i6)) / t
    force[i * dim] += (f * dx) / d
    force[i * dim + 1] += (f * dy) / d
    pe += 4 * (i6 * i6 - i6) + 1
  }
  return pe
}

/**
 * 速度 Verlet 算法。进入时受力必须是最新的，退出时也是最新的。
 * Velocity Verlet. Forces must be current on entry and are current on exit.
 */
export function step(s: MdState, pair: PairField, dt: number, nSteps = 1): void {
  const { dim, n, pos, vel, force, box } = s
  const len = n * dim
  const half = 0.5 * dt
  for (let it = 0; it < nSteps; it++) {
    for (let k = 0; k < len; k++) {
      const d = k % dim
      vel[k] += half * (force[k] + (d === 0 ? s.drive : d === 1 ? s.gravity : 0))
      const L = box[d]
      const x = pos[k] + dt * vel[k]
      if (s.disp) s.disp[k] += dt * vel[k]
      if (s.walls && d === 1) {
        pos[k] = x
        if (x < 0 || x >= L) hitWall(s, (k - 1) / dim, x < 0)
      } else pos[k] = x - L * Math.floor(x / L)
    }
    computeForces(s, pair)
    for (let k = 0; k < len; k++) {
      const d = k % dim
      vel[k] += half * (force[k] + (d === 0 ? s.drive : d === 1 ? s.gravity : 0))
    }
    s.step++
  }
}

/**
 * 漫反射：把粒子镜像折回盒内，并从壁面的麦克斯韦分布中重新抽取速度
 * （法向分量服从瑞利分布，切向分量服从高斯分布）。
 * Diffuse reflection: mirror the particle back inside and draw a fresh velocity from the
 * wall's Maxwellian (Rayleigh-distributed normal component, Gaussian tangential ones).
 */
function hitWall(s: MdState, i: number, lower: boolean): void {
  const { dim, pos, vel, box } = s
  const L = box[1]
  const y = pos[i * dim + 1]
  // 加以钳制，使极端的越界也仍落在盒内。 / Clamped so that an extreme overshoot still lands inside the box.
  pos[i * dim + 1] = Math.min(Math.max(lower ? -y : 2 * L - y, 0), L * (1 - 1e-12))
  const key = s.seed ^ Math.imul(s.step + 1, 0x632be5ab)
  const sd = Math.sqrt(lower ? s.wallTemperature : s.wallTemperatureFar)
  const normal = sd * Math.sqrt(-2 * Math.log(uniform(key, 4 * i)))
  vel[i * dim] = sd * gaussian(key, 4 * i + 1)
  vel[i * dim + 1] = lower ? normal : -normal
  if (dim === 3) vel[i * dim + 2] = sd * gaussian(key, 4 * i + 3)
}

export function kineticEnergy(s: MdState): number {
  let ke = 0
  for (let k = 0; k < s.n * s.dim; k++) ke += s.vel[k] * s.vel[k]
  return 0.5 * ke
}

/**
 * 动理学温度：只算相对于质心的运动，并扣除质心的 dim 个自由度。整体流动的动能不是热。
 * Kinetic temperature: of the motion relative to the centre of mass only, with the dim
 * centre-of-mass degrees of freedom removed. The kinetic energy of bulk flow is not heat.
 */
export function temperature(s: MdState): number {
  const p = momentum(s)
  let bulk = 0
  for (const c of p) bulk += (c * c) / (2 * s.n)
  return (2 * (kineticEnergy(s) - bulk)) / (s.dim * (s.n - 1))
}

export function momentum(s: MdState): number[] {
  const p = new Array<number>(s.dim).fill(0)
  for (let k = 0; k < s.n * s.dim; k++) p[k % s.dim] += s.vel[k]
  return p
}

export function volume(s: MdState): number {
  return s.box[0] * s.box[1] * s.box[2]
}

/**
 * 位力压强 P = (N T + W / dim) / V。
 * Virial pressure P = (N T + W / dim) / V.
 */
export function pressure(s: MdState): number {
  return (s.n * temperature(s) + s.virial / s.dim) / volume(s)
}

/**
 * 切应力 σ_xy = (Σ v_x v_y + Σ_对 x_ij f_ij,y) / V（单位质量）。
 * Shear stress σ_xy = (Σ v_x v_y + Σ_pairs x_ij f_ij,y) / V (unit mass).
 */
export function shearStress(s: MdState): number {
  let kinetic = 0
  for (let i = 0; i < s.n; i++) kinetic += s.vel[i * s.dim] * s.vel[i * s.dim + 1]
  return (kinetic + s.virialXY) / volume(s)
}

/** 均方位移，需要 s.disp 在记录。 / Mean-square displacement; needs s.disp to be recording. */
export function meanSquareDisplacement(s: MdState): number {
  if (!s.disp) return NaN
  let sum = 0
  for (let k = 0; k < s.disp.length; k++) sum += s.disp[k] * s.disp[k]
  return sum / s.n
}
