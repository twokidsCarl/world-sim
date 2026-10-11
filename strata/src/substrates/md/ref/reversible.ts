// 位可逆动力学（Levesque & Verlet 1993）。位置取整数，每一步加上一个只依赖于
// 当前位置的整数增量：
//
//   x(n+1) = 2 x(n) - x(n-1) + round(F(x(n)) dt² S)
//
// 对 x(n-1) 求解得到同一公式，只是相邻两个时刻互换；因此把二者交换后继续步进，
// 就能逐位精确地沿原轨迹返回，无论它多么混沌。
//
// Bit-reversible dynamics (Levesque & Verlet 1993). Positions are integers, and each step
// adds an integer increment that depends only on the current positions:
//
//   x(n+1) = 2 x(n) - x(n-1) + round(F(x(n)) dt² S)
//
// Solving for x(n-1) gives the same formula with the two neighbours swapped, so swapping
// them and stepping on retraces the trajectory exactly, bit for bit, however chaotic it is.

import type { PairField } from '../potential'
import { computeForces, type MdState } from './step'

/**
 * 每单位长度对应的整数单位数。位置远小于 2^53，所以 f64 能精确表示它们。
 * Integer units per unit length. Positions stay far below 2^53, so f64 holds them exactly.
 */
export const FIXED = 2 ** 32

export interface ReversibleState {
  /**
   * 携带盒子、组分和受力；其位置为 x / FIXED。
   * Carries box, species and forces; its positions are x / FIXED.
   */
  md: MdState
  x: Float64Array
  xPrev: Float64Array
  /** 以整数单位表示的盒子边长。 / Box lengths in integer units. */
  period: Float64Array
}

const wrap = (v: number, m: number) => ((v % m) + m) % m

/** 周长为 m 的环上的最短有符号间距。 / Shortest signed separation on a ring of circumference m. */
function shortest(d: number, m: number): number {
  if (d > m / 2) return d - m
  if (d < -m / 2) return d + m
  return d
}

function syncPositions(r: ReversibleState): void {
  for (let k = 0; k < r.x.length; k++) r.md.pos[k] = r.x[k] / FIXED
}

/**
 * 接管一个状态：把它对齐到整数网格，并由速度构造 x(n-1)。
 * Take over a state: snap it to the integer grid and build x(n-1) from the velocities.
 */
export function toReversible(md: MdState, pair: PairField, dt: number): ReversibleState {
  const { dim, n } = md
  const period = new Float64Array(dim)
  for (let d = 0; d < dim; d++) {
    period[d] = Math.round(md.box[d] * FIXED)
    md.box[d] = period[d] / FIXED
  }
  const x = new Float64Array(n * dim)
  const xPrev = new Float64Array(n * dim)
  for (let k = 0; k < n * dim; k++) x[k] = wrap(Math.round(md.pos[k] * FIXED), period[k % dim])
  const r: ReversibleState = { md, x, xPrev, period }
  syncPositions(r)
  computeForces(md, pair)
  // x(n-1) = x(n) - v dt + a dt² / 2，与积分器同阶。
  // x(n-1) = x(n) - v dt + a dt² / 2, to the same order as the integrator.
  for (let k = 0; k < n * dim; k++) {
    const back = Math.round((-md.vel[k] * dt + 0.5 * md.force[k] * dt * dt) * FIXED)
    xPrev[k] = wrap(x[k] + back, period[k % dim])
  }
  return r
}

/**
 * 前进 n 步。之后 md.pos 为 x(n)，而 md.vel、md.force 和 md.pe
 * 描述的是它的前一步：中心差分速度 (x(n) - x(n-2)) / 2dt 要到那时才能知道。
 * Advance n steps. Afterwards md.pos is x(n), while md.vel, md.force and md.pe describe
 * the step before it: the centred velocity (x(n) - x(n-2)) / 2dt is only known then.
 */
export function stepReversible(r: ReversibleState, pair: PairField, dt: number, n = 1): void {
  const { md, period } = r
  const { dim } = md
  for (let it = 0; it < n; it++) {
    computeForces(md, pair)
    const next = r.xPrev
    for (let k = 0; k < r.x.length; k++) {
      const m = period[k % dim]
      const d = shortest(r.x[k] - r.xPrev[k], m)
      const a = Math.round(md.force[k] * dt * dt * FIXED)
      md.vel[k] = (2 * d + a) / (2 * dt * FIXED)
      next[k] = wrap(r.x[k] + d + a, m)
    }
    r.xPrev = r.x
    r.x = next
    syncPositions(r)
    md.step++
  }
}

/**
 * 在保持当前位置不变的前提下反转时间方向：此后每一步都精确撤销先前的一步。
 * 为此 (x(n), x(n-1)) 须变成 (x(n), x(n+1))，所以交换之前要再向前走一步以得到 x(n+1)。
 * Reverse the direction of time while staying at the current positions: from here on,
 * each step undoes one earlier step exactly. The pair (x(n), x(n-1)) has to become
 * (x(n), x(n+1)), so one more forward step is taken to obtain x(n+1) before swapping.
 */
export function reverseTime(r: ReversibleState, pair: PairField, dt: number): void {
  stepReversible(r, pair, dt, 1)
  r.md.step--
  const x = r.x
  r.x = r.xPrev
  r.xPrev = x
  syncPositions(r)
}
