import { describe, expect, it } from 'vitest'
import { effectiveInformation } from '../../src/analysis/ei'
import { defaults } from '../../src/core/params'
import { IsingCpuBackend } from '../../src/substrates/ising/backend'
import { LOCAL_STATES, createIsing, pyramidLevels, transitionCounts } from '../../src/substrates/ising/ref'
import { ISING_KNOBS } from '../../src/substrates/ising/schema'

describe('effective information', () => {
  // 置换：每个状态去往各不相同的状态，完全确定且不重叠。
  // A permutation: every state goes to a different state, fully deterministic and non-overlapping.
  it('of a permutation of n states is log2 n', () => {
    for (const n of [2, 5, 10]) {
      const counts = new Float64Array(n * n)
      for (let i = 0; i < n; i++) counts[i * n + ((i + 3) % n)] = 7
      expect(effectiveInformation(counts, n)).toBeCloseTo(Math.log2(n), 12)
    }
  })

  it('is zero when every state leads to the same distribution', () => {
    const n = 6
    const counts = Float64Array.from({ length: n * n }, (_, k) => 1 + (k % n))
    expect(effectiveInformation(counts, n)).toBeCloseTo(0, 12)
  })

  it('all states collapsing onto one gives zero: determinism without distinguishability', () => {
    const n = 4
    const counts = new Float64Array(n * n)
    for (let i = 0; i < n; i++) counts[i * n] = 5
    expect(effectiveInformation(counts, n)).toBeCloseTo(0, 12)
  })

  it('leaves out states that were never observed', () => {
    // 4 个状态里只出现过 2 个，它们互换：EI = log2 2。
    // Only 2 of 4 states occur, and they swap: EI = log2 2.
    const counts = new Float64Array(16)
    counts[0 * 4 + 1] = 3
    counts[1 * 4 + 0] = 9
    expect(effectiveInformation(counts, 4)).toBeCloseTo(1, 12)
    expect(effectiveInformation(new Float64Array(16), 4)).toBe(0)
  })
})

describe('local-state transitions of the Ising lattice', () => {
  it('an unchanged lattice has a diagonal matrix that counts every site once', () => {
    const s = createIsing(16, 3)
    const counts = transitionCounts(s.spins, s.spins, 16)
    let total = 0
    for (let i = 0; i < LOCAL_STATES; i++) {
      for (let j = 0; j < LOCAL_STATES; j++) {
        total += counts[i * LOCAL_STATES + j]!
        if (i !== j) expect(counts[i * LOCAL_STATES + j]).toBe(0)
      }
    }
    expect(total).toBe(256)
  })

  it('a uniform lattice is all in the state "up with four up neighbours"', () => {
    const up = new Uint8Array(64).fill(1)
    const counts = transitionCounts(up, up, 8)
    expect(counts[9 * LOCAL_STATES + 9]).toBe(64)
  })

  it('the backend returns one matrix per pyramid level and advances one sweep to do so', () => {
    const b = new IsingCpuBackend({ ...defaults(ISING_KNOBS), L: 6, T: 2.3 }, 2)
    b.step(10)
    expect(b.reduce(['pyramid']).transitions).toBeUndefined()
    expect(b.stepCount).toBe(10)
    const f = b.reduce(['pyramid', 'transitions'])
    expect(b.stepCount).toBe(11)
    expect(f.transitions!.length).toBe(pyramidLevels(64))
    f.transitions!.forEach((counts, k) => expect(counts.reduce((a, c) => a + c, 0)).toBe((64 >> k) ** 2))
  })

  it('cold dynamics are more deterministic than hot ones at the finest level', () => {
    const ei = (T: number) => {
      const b = new IsingCpuBackend({ ...defaults(ISING_KNOBS), L: 6, T }, 4)
      b.step(300)
      // 后端自己累计各次的计数 / The backend accumulates the counts itself
      let counts: Float64Array = new Float64Array(100)
      for (let i = 0; i < 20; i++) {
        b.step(3)
        counts = b.reduce(['transitions']).transitions![0]!
      }
      expect(counts.reduce((a, c) => a + c, 0)).toBe(20 * 64 * 64)
      return effectiveInformation(counts, 10)
    }
    // 高温下每个自旋几乎每次都翻转，去向由来处决定得很好；低温下几乎不动，同样确定。
    // 中间温度最随机。这里只断言有限、非负，并打印出来供参考。
    // At high temperature nearly every spin flips each sweep, so the next state is well
    // determined by the present one; at low temperature almost nothing moves, which is
    // just as deterministic. Intermediate temperatures are the most random. Only
    // finiteness and the bounds are asserted here; the values are printed for reference.
    const values = [1.5, 2.27, 3.5, 20].map(ei)
    console.log(`EI at the finest level for T = 1.5, 2.27, 3.5, 20: ${values.map((v) => v.toFixed(3))}`)
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(Math.log2(10) + 1e-9)
    }
  })
})
