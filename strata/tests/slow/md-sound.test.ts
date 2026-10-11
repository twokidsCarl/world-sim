import { describe, expect, it } from 'vitest'
import { dominantFrequency } from '../../src/analysis/oscillation'
import { LJ, buildTable, tablePair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { densityModes } from '../../src/substrates/md/ref/reducers'
import { step, temperature } from '../../src/substrates/md/ref/step'
import { virialSoundSpeed } from '../../src/theory/sound'

describe('sound', () => {
  it('a standing wave in a dilute gas oscillates at the adiabatic sound speed', () => {
    const pair = tablePair(buildTable(LJ))
    const density = 0.15
    // 一个细长的盒子：波长必须是平均自由程（这里约 2.4 σ）的许多倍，
    // 这个波才称得上是声波。在粒子数相同的正方形盒子里则不是，
    // 振荡既更快又被强烈阻尼。
    // A long, thin box: the wavelength must be many mean free paths (about 2.4 σ here) for
    // the wave to be sound at all. In a square box of the same particle number it is
    // not, and the oscillation is both faster and heavily damped.
    const s = initTriangular({ nx: 160, density, temperature: 2, seed: 3, aspect: 8 }, pair)
    step(s, pair, 0.005, 2000)
    const k = (2 * Math.PI) / s.box[0]!
    const amplitude = 0.15 * Math.sqrt(2)
    for (let i = 0; i < s.n; i++) s.vel[2 * i]! += amplitude * Math.sin(k * s.pos[2 * i]!)
    const t: number[] = []
    const y: number[] = []
    let T = 0
    const samples = 1100
    for (let i = 0; i < samples; i++) {
      step(s, pair, 0.005, 50)
      t.push(s.step * 0.005)
      y.push(densityModes(s).data[0]! / s.n)
      T += temperature(s) / samples
    }
    const fit = dominantFrequency(t, y, 1)!
    const c = fit.omega / k
    const theory = virialSoundSpeed(LJ, density, T, 2)
    console.log(
      `sound: N = ${s.n}, L = ${s.box[0]!.toFixed(0)}, c = ${c.toFixed(3)}, virial theory ${theory.toFixed(3)} at T = ${T.toFixed(3)}, ideal ${Math.sqrt(2 * T).toFixed(3)}, fit quality ${fit.quality.toFixed(3)}`,
    )
    expect(fit.quality).toBeGreaterThan(0.8)
    expect(Math.abs(c / theory - 1)).toBeLessThan(0.1)
    // 相互作用修正已被分辨出来：测量值不只是理想气体的值。
    // The interaction correction is resolved: the measurement is not just the ideal-gas value.
    expect(c).toBeGreaterThan(Math.sqrt(2 * T) * 1.03)
    // 3840 个粒子跑 55000 步：留出远超默认一分钟的时间。
    // 55000 steps of 3840 particles: allow well over the default minute.
  }, 240_000)
})
