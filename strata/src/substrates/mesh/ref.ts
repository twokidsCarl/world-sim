// 粒子网格法（PM）引力的 CPU 参考实现：周期盒子里的等质量粒子，密度用云在格中（CIC）
// 分配到网格上，用快速傅里叶变换解泊松方程，势的中心差分给出加速度，再插值回粒子。
// 均匀背景被减掉（只有密度的涨落产生引力），这是静态背景上的 “Jeans 骗局”。
// 单位：盒子边长 1，总质量 1，G = 1。
// CPU reference for particle-mesh (PM) gravity: equal-mass particles in a periodic box,
// their density deposited on a grid by cloud-in-cell (CIC), Poisson's equation solved by
// fast Fourier transform, accelerations from central differences of the potential and
// interpolated back to the particles. The uniform background is subtracted (only density
// fluctuations gravitate), the "Jeans swindle" on a static background.
// Units: box side 1, total mass 1, G = 1.

import { uniform } from '../../core/rng'
import { JEANS_RATE } from '../../theory/jeans'

/**
 * 一个 Stockham 基 2 蝶形阶段，沿 `axis` 作用于 M³ 的复数网格（实部、虚部交错存放）。
 * 按输出下标“收集”的写法，每个输出元素只依赖输入的两个元素，GPU 内核照抄这一段。
 * `stride` 取 1、2、4……M/2，依次做完 log₂M 个阶段后结果已是自然顺序。
 * One Stockham radix-2 butterfly stage along `axis` of an M³ complex grid (interleaved
 * real and imaginary parts). Written as a gather over output indices, each output
 * depending on two inputs, which the GPU kernel copies verbatim. With `stride` running
 * through 1, 2, 4, … M/2, the log₂M stages leave the result in natural order.
 */
export function fftStage(src: Float64Array, dst: Float64Array, M: number, axis: number, stride: number, sign: number): void {
  const length = M / stride
  const half = length / 2
  const step = axis === 0 ? 1 : axis === 1 ? M : M * M
  const total = M * M * M
  for (let i = 0; i < total; i++) {
    const j = Math.floor(i / step) % M
    const base = i - j * step
    const q = j % stride
    const t = (j - q) / stride
    const p = t >> 1
    const a = 2 * (base + (q + stride * p) * step)
    const b = 2 * (base + (q + stride * (p + half)) * step)
    if ((t & 1) === 0) {
      dst[2 * i] = src[a]! + src[b]!
      dst[2 * i + 1] = src[a + 1]! + src[b + 1]!
    } else {
      const angle = (sign * 2 * Math.PI * p) / length
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      const re = src[a]! - src[b]!
      const im = src[a + 1]! - src[b + 1]!
      dst[2 * i] = re * c - im * s
      dst[2 * i + 1] = re * s + im * c
    }
  }
}

/**
 * 三维复数 FFT（不归一化），sign = −1 为正变换。在 a 与 b 之间来回倒腾，返回存有结果的那个。
 * 3D complex FFT (unnormalised), sign = −1 for the forward transform. Ping-pongs between
 * a and b and returns whichever holds the result.
 */
export function fft3d(a: Float64Array, b: Float64Array, M: number, sign: number): Float64Array {
  let src = a
  let dst = b
  for (let axis = 0; axis < 3; axis++) {
    for (let stride = 1; stride < M; stride *= 2) {
      fftStage(src, dst, M, axis, stride, sign)
      ;[src, dst] = [dst, src]
    }
  }
  return src
}

export interface MeshState {
  n: number
  /** 每边的网格点数，2 的幂。 / Grid points per side, a power of two. */
  M: number
  /** 3n，取值在 [0, 1)。 / 3n, in [0, 1). */
  pos: Float64Array
  vel: Float64Array
  acc: Float64Array
  /** 网格上的密度涨落 δ = ρ/ρ̄ − 1（最近一次求力时的）。 / Density contrast δ = ρ/ρ̄ − 1 on the grid, from the last force evaluation. */
  delta: Float64Array
  /** 网格上的引力势。 / Gravitational potential on the grid. */
  phi: Float64Array
  /** 加速度的三个分量，各 M³。 / The three acceleration components, M³ each. */
  field: Float64Array
  /** 引力常数。 / The gravitational constant. */
  G: number
  step: number
  time: number
  work: [Float64Array, Float64Array]
}

export function createMesh(n: number, M: number): MeshState {
  const cells = M * M * M
  return {
    n,
    M,
    pos: new Float64Array(3 * n),
    vel: new Float64Array(3 * n),
    acc: new Float64Array(3 * n),
    delta: new Float64Array(cells),
    phi: new Float64Array(cells),
    field: new Float64Array(3 * cells),
    G: 1,
    step: 0,
    time: 0,
    work: [new Float64Array(2 * cells), new Float64Array(2 * cells)],
  }
}

const wrap = (i: number, M: number) => (i + M) % M

/** 把粒子按 CIC 分配到网格上，得到密度涨落 δ。 / Deposit the particles on the grid by CIC, giving the density contrast δ. */
export function deposit(s: MeshState): void {
  const { n, M, pos, delta } = s
  delta.fill(0)
  for (let i = 0; i < n; i++) {
    const gx = pos[3 * i]! * M
    const gy = pos[3 * i + 1]! * M
    const gz = pos[3 * i + 2]! * M
    const ix = Math.floor(gx)
    const iy = Math.floor(gy)
    const iz = Math.floor(gz)
    const fx = gx - ix
    const fy = gy - iy
    const fz = gz - iz
    for (let c = 0; c < 8; c++) {
      const dx = c & 1
      const dy = (c >> 1) & 1
      const dz = c >> 2
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
      delta[wrap(ix + dx, M) + M * (wrap(iy + dy, M) + M * wrap(iz + dz, M))]! += w
    }
  }
  // 每个格点的平均粒子数是 n / M³。 / The mean number of particles per grid point is n / M³.
  const mean = n / (M * M * M)
  for (let c = 0; c < delta.length; c++) delta[c] = delta[c]! / mean - 1
}

/** 整数波数折到 [−M/2, M/2)。 / Fold an integer wave number into [−M/2, M/2). */
const fold = (k: number, M: number) => (k < M / 2 ? k : k - M)

/**
 * 由 δ 解 ∇²φ = 4πG ρ̄ δ：φ_k = −4πG δ_k / k²，k = 2π ×（折叠后的整数波数）；k = 0 的分量置零。
 * 再由中心差分得到加速度 −∇φ。
 * Solve ∇²φ = 4πG ρ̄ δ from δ: φ_k = −4πG δ_k / k² with k = 2π × (folded integer wave
 * number), the k = 0 component set to zero; then accelerations −∇φ by central differences.
 */
export function solveField(s: MeshState): void {
  const { M, delta, phi, field, G } = s
  const cells = M * M * M
  const [a, b] = s.work
  for (let c = 0; c < cells; c++) {
    a[2 * c] = delta[c]!
    a[2 * c + 1] = 0
  }
  const spectrum = fft3d(a, b, M, -1)
  const other = spectrum === a ? b : a
  for (let z = 0; z < M; z++) {
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < M; x++) {
        const c = x + M * (y + M * z)
        const k2 = fold(x, M) ** 2 + fold(y, M) ** 2 + fold(z, M) ** 2
        // −4πG / ((2π)² k²)，再除以 M³ 完成逆变换的归一化。 / −4πG / ((2π)² k²), divided by M³ to normalise the inverse transform.
        const g = k2 === 0 ? 0 : -G / (Math.PI * k2 * cells)
        spectrum[2 * c] = spectrum[2 * c]! * g
        spectrum[2 * c + 1] = spectrum[2 * c + 1]! * g
      }
    }
  }
  const real = fft3d(spectrum, other, M, 1)
  for (let c = 0; c < cells; c++) phi[c] = real[2 * c]!
  const scale = M / 2
  for (let z = 0; z < M; z++) {
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < M; x++) {
        const c = x + M * (y + M * z)
        field[3 * c] = -scale * (phi[wrap(x + 1, M) + M * (y + M * z)]! - phi[wrap(x - 1, M) + M * (y + M * z)]!)
        field[3 * c + 1] = -scale * (phi[x + M * (wrap(y + 1, M) + M * z)]! - phi[x + M * (wrap(y - 1, M) + M * z)]!)
        field[3 * c + 2] = -scale * (phi[x + M * (y + M * wrap(z + 1, M))]! - phi[x + M * (y + M * wrap(z - 1, M))]!)
      }
    }
  }
}

/** 用同样的 CIC 权重把网格上的加速度插值到各粒子。 / Interpolate the grid accelerations to the particles with the same CIC weights. */
export function interpolate(s: MeshState): void {
  const { n, M, pos, acc, field } = s
  for (let i = 0; i < n; i++) {
    const gx = pos[3 * i]! * M
    const gy = pos[3 * i + 1]! * M
    const gz = pos[3 * i + 2]! * M
    const ix = Math.floor(gx)
    const iy = Math.floor(gy)
    const iz = Math.floor(gz)
    const fx = gx - ix
    const fy = gy - iy
    const fz = gz - iz
    let ax = 0
    let ay = 0
    let az = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1
      const dy = (c >> 1) & 1
      const dz = c >> 2
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
      const cell = 3 * (wrap(ix + dx, M) + M * (wrap(iy + dy, M) + M * wrap(iz + dz, M)))
      ax += w * field[cell]!
      ay += w * field[cell + 1]!
      az += w * field[cell + 2]!
    }
    acc[3 * i] = ax
    acc[3 * i + 1] = ay
    acc[3 * i + 2] = az
  }
}

export function computeAccelerations(s: MeshState): void {
  deposit(s)
  solveField(s)
  interpolate(s)
}

/** 蛙跳（踢–漂–踢）。进入和退出时加速度都是最新的。 / Leapfrog (kick–drift–kick). Accelerations are current on entry and on exit. */
export function step(s: MeshState, dt: number, nSteps = 1): void {
  const { n, pos, vel, acc } = s
  for (let it = 0; it < nSteps; it++) {
    for (let k = 0; k < 3 * n; k++) {
      vel[k] = vel[k]! + 0.5 * dt * acc[k]!
      const x = pos[k]! + dt * vel[k]!
      pos[k] = x - Math.floor(x)
    }
    computeAccelerations(s)
    for (let k = 0; k < 3 * n; k++) vel[k] = vel[k]! + 0.5 * dt * acc[k]!
    s.step++
    s.time += dt
  }
}

export interface MeshScalars {
  /** 动能（总质量为 1）。 / Kinetic energy (total mass 1). */
  ke: number
  /** 势能 ½ ∫ δ φ dV。 / Potential energy ½ ∫ δ φ dV. */
  pe: number
  /** 总动量的大小。 / Magnitude of the total momentum. */
  momentum: number
  /** 沿 x 的基频密度模的幅度 2 |⟨exp(−2πi x)⟩|。 / Amplitude of the fundamental density mode along x, 2 |⟨exp(−2πi x)⟩|. */
  mode: number
  /** 网格上密度涨落的均方根。 / Root-mean-square density contrast on the grid. */
  sigma: number
  /** 网格上最大的密度（以平均密度为单位）。 / Largest density on the grid, in units of the mean. */
  peak: number
}

export function meshScalars(s: MeshState): MeshScalars {
  const { n, pos, vel, delta, phi } = s
  let ke = 0
  let re = 0
  let im = 0
  const p = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 3; d++) {
      ke += 0.5 * vel[3 * i + d]! ** 2
      p[d]! += vel[3 * i + d]!
    }
    re += Math.cos(2 * Math.PI * pos[3 * i]!)
    im -= Math.sin(2 * Math.PI * pos[3 * i]!)
  }
  let pe = 0
  let variance = 0
  let peak = 0
  for (let c = 0; c < delta.length; c++) {
    pe += 0.5 * delta[c]! * phi[c]!
    variance += delta[c]! ** 2
    peak = Math.max(peak, delta[c]! + 1)
  }
  return {
    ke: ke / n,
    pe: pe / delta.length,
    momentum: Math.hypot(p[0]!, p[1]!, p[2]!) / n,
    mode: (2 * Math.hypot(re, im)) / n,
    sigma: Math.sqrt(variance / delta.length),
    peak,
  }
}

/**
 * 初始条件。粒子先排在 side³ 的立方格点上，再按位移场 ψ 挪动，速度取纯增长模 v = γψ。
 * kind 0：沿 x 的一个平面波，ψ_x = A sin(2πq_x) / 2π（A 是基频密度模的初始幅度）。
 * G 是引力常数，增长率为 √(4πG)。
 * kind 1：随机场，由 |k| ≤ 4 的若干平面波叠加而成，各波的位移沿各自的波矢，幅度 ∝ 1/|k|，
 *         相位随机；整体缩放到网格上密度涨落的线性理论均方根约为 A。
 * Initial conditions. Particles start on a side³ cubic lattice and are moved by a
 * displacement field ψ, with velocities in the pure growing mode v = γψ.
 * kind 0: one plane wave along x, ψ_x = A sin(2πq_x) / 2π (A is the initial amplitude of
 *         the fundamental density mode).
 * G is the gravitational constant; the growth rate is √(4πG).
 * kind 1: a random field, a superposition of the plane waves with |k| ≤ 4, each displacing
 *         along its own wave vector with amplitude ∝ 1/|k| and a random phase; scaled so
 *         the linear-theory rms density contrast is about A.
 */
export function initMesh(side: number, M: number, kind: number, amplitude: number, seed: number, G = 1, solve = true): MeshState {
  const n = side ** 3
  const s = createMesh(n, M)
  s.G = G
  const rate = JEANS_RATE * Math.sqrt(G)
  const waves: { k: [number, number, number]; a: number; phase: number }[] = []
  if (kind === 0) waves.push({ k: [1, 0, 0], a: amplitude, phase: 0 })
  else {
    const CUT = 4
    let counter = 0
    let power = 0
    for (let kz = -CUT; kz <= CUT; kz++) {
      for (let ky = -CUT; ky <= CUT; ky++) {
        for (let kx = -CUT; kx <= CUT; kx++) {
          const k2 = kx * kx + ky * ky + kz * kz
          // 只取半个 k 空间：k 与 −k 是同一个实波。 / Half of k-space only: k and −k are the same real wave.
          const upper = kz > 0 || (kz === 0 && (ky > 0 || (ky === 0 && kx > 0)))
          if (!upper || k2 > CUT * CUT) continue
          // 密度幅度 ∝ 1/|k|，瑞利分布的随机幅度。 / Density amplitude ∝ 1/|k|, Rayleigh-distributed.
          const a = Math.sqrt(-Math.log(uniform(seed, 2 * counter))) / Math.sqrt(k2)
          waves.push({ k: [kx, ky, kz], a, phase: 2 * Math.PI * uniform(seed, 2 * counter + 1) })
          power += 0.5 * a * a
          counter++
        }
      }
    }
    const scale = amplitude / Math.sqrt(power)
    for (const w of waves) w.a *= scale
  }
  for (let i = 0; i < n; i++) {
    const q = [((i % side) + 0.5) / side, ((Math.floor(i / side) % side) + 0.5) / side, (Math.floor(i / (side * side)) + 0.5) / side]
    const psi = [0, 0, 0]
    for (const w of waves) {
      const k2 = w.k[0] ** 2 + w.k[1] ** 2 + w.k[2] ** 2
      // δ = a cos(2π k·q + φ) 对应 ψ = −a k sin(2π k·q + φ) / (2π k²)。
      // δ = a cos(2π k·q + φ) corresponds to ψ = −a k sin(2π k·q + φ) / (2π k²).
      const amp = (-w.a * Math.sin(2 * Math.PI * (w.k[0] * q[0]! + w.k[1] * q[1]! + w.k[2] * q[2]!) + w.phase)) / (2 * Math.PI * k2)
      for (let d = 0; d < 3; d++) psi[d]! += amp * w.k[d]!
    }
    for (let d = 0; d < 3; d++) {
      const x = q[d]! + psi[d]!
      s.pos[3 * i + d] = x - Math.floor(x)
      s.vel[3 * i + d] = rate * psi[d]!
    }
  }
  // GPU 后端自己求初始加速度，不必在 CPU 上再算一遍。 / The GPU backend finds the initial accelerations itself.
  if (solve) computeAccelerations(s)
  return s
}
