import { describe, expect, it } from 'vitest'
import { LJ, speciesField, speciesTables } from '../../src/substrates/md/potential'
import { initChains } from '../../src/substrates/md/ref/init'
import { aggregates } from '../../src/substrates/md/ref/reducers'
import { kineticEnergy, step, type MdState } from '../../src/substrates/md/ref/step'
import { BOND_K, BOND_R0 } from '../../src/substrates/md/schema'

const field = speciesField(speciesTables(LJ, [[1, 1], [1, 3]], 2048, [[true, true], [true, false]]))

/** 把动能缩放到温度 T（每 20 步一次）。 / Rescale the kinetic energy to temperature T (every 20 steps). */
function run(s: MdState, T: number, steps: number): void {
  for (let k = 0; k < steps / 20; k++) {
    step(s, field, 0.005, 20)
    const scale = Math.sqrt((T * s.n) / kineticEnergy(s))
    for (let i = 0; i < s.vel.length; i++) s.vel[i] = s.vel[i]! * scale
  }
}

describe('amphiphiles with attracting tails', () => {
  it('stay mostly single when hot and gather into finite aggregates when cold', () => {
    const make = (T: number) => initChains({ nx: 45, density: 0.15, temperature: T, seed: 3, chain: 3, bondK: BOND_K, bondR0: BOND_R0 }, field)
    const hot = make(3)
    run(hot, 3, 10000)
    const a = aggregates(hot.pos, 2, hot.n, 3, hot.box)
    const cold = make(0.7)
    run(cold, 0.7, 30000)
    const b = aggregates(cold.pos, 2, cold.n, 3, cold.box)
    console.log(`hot: free ${a.free.toFixed(2)}, mean ${a.mean.toFixed(1)}, largest ${a.largest}; cold: free ${b.free.toFixed(2)}, mean ${b.mean.toFixed(1)}, largest ${b.largest} of ${b.molecules}`)
    expect(a.free).toBeGreaterThan(0.5)
    expect(a.mean).toBeLessThan(2.5)
    expect(b.free).toBeLessThan(0.1)
    expect(b.mean).toBeGreaterThan(5)
    // 聚集体是有限大小的，不是一整块。 / The aggregates are finite, not one lump.
    expect(b.largest).toBeLessThan(b.molecules / 4)
  }, 300_000)
})
