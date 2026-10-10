import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import { buildTable, tablePair, type PairEval, type PotentialSpec } from './potential'
import { initTriangular } from './ref/init'
import { rdf, scalars, speedHistogram, type Hist, type MdScalars } from './ref/reducers'
import { computeForces, kineticEnergy, step, temperature, type MdState } from './ref/step'
import { potentialSpec } from './schema'

export interface MdFrame extends Frame {
  time: number
  spec: PotentialSpec
  /**
   * Change in conserved energy per particle since the last parameter change, in units of
   * epsilon: (E - heat exchanged with the bath - E0) / N. Not divided by |E0|, which can be
   * near zero when kinetic and potential energy cancel.
   */
  drift: number
  /** A neighbour cell held more particles than its table has room for; forces are incomplete. */
  overflow?: boolean
  scalars?: MdScalars
  speedHist?: Hist
  rdf?: Hist
}

export interface MdBackend extends RunBackend<MdFrame> {
  readonly n: number
  readonly dim: 2 | 3
  readonly box: Float64Array
}

/** The reference implementation is single-threaded; larger systems belong on the GPU backend. */
export const CPU_MAX_NX = 70

const THERMOSTAT_TAU = 0.5

export class MdCpuBackend implements MdBackend {
  readonly kind = 'cpu'
  state: MdState
  spec: PotentialSpec
  private pair: PairEval
  private p: Params
  private time = 0
  private heat = 0
  private e0 = 0

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    this.spec = potentialSpec(p)
    this.pair = tablePair(buildTable(this.spec))
    this.state = initTriangular({ nx: Math.min(p.nx, CPU_MAX_NX), density: p.density, temperature: p.temperature, seed }, this.pair)
    this.rebase()
  }

  get n(): number {
    return this.state.n
  }

  get dim(): 2 | 3 {
    return this.state.dim
  }

  get box(): Float64Array {
    return this.state.box
  }

  get stepCount(): number {
    return this.state.step
  }

  private energy(): number {
    return kineticEnergy(this.state) + this.state.pe
  }

  /** Restart the conservation meter from the current state. */
  private rebase(): void {
    this.heat = 0
    this.e0 = this.energy()
  }

  setParams(p: Params): void {
    const spec = potentialSpec(p)
    if (JSON.stringify(spec) !== JSON.stringify(this.spec)) {
      this.spec = spec
      this.pair = tablePair(buildTable(spec))
      computeForces(this.state, this.pair)
      this.rebase()
    }
    // Without a bath, moving the temperature knob is a one-off intervention: rescale the
    // velocities to that temperature and let the isolated system evolve from there.
    if (!p.thermostat && p.temperature !== this.p.temperature) {
      const scale = Math.sqrt(p.temperature / Math.max(temperature(this.state), 1e-12))
      for (let k = 0; k < this.state.vel.length; k++) this.state.vel[k] *= scale
      this.rebase()
    }
    this.p = { ...p }
  }

  step(n: number): void {
    const { dt, thermostat, temperature: target } = this.p
    for (let i = 0; i < n; i++) {
      step(this.state, this.pair, dt)
      this.time += dt
      if (thermostat) {
        // Berendsen weak coupling; the kinetic energy it adds is tracked as heat.
        const ke = kineticEnergy(this.state)
        const lambda2 = 1 + (dt / THERMOSTAT_TAU) * (target / Math.max(temperature(this.state), 1e-12) - 1)
        const lambda = Math.sqrt(Math.max(lambda2, 0.25))
        for (let k = 0; k < this.state.vel.length; k++) this.state.vel[k] *= lambda
        this.heat += (lambda * lambda - 1) * ke
      }
    }
  }

  reduce(ids: readonly string[]): MdFrame {
    const s = this.state
    const frame: MdFrame = {
      step: s.step,
      time: this.time,
      spec: this.spec,
      drift: (this.energy() - this.heat - this.e0) / s.n,
    }
    const sc = scalars(s)
    if (ids.includes('scalars')) frame.scalars = sc
    if (ids.includes('speedHist')) frame.speedHist = speedHistogram(s, 40, 4 * Math.sqrt(sc.temperature))
    if (ids.includes('rdf')) frame.rdf = rdf(s, 120, 4)
    return frame
  }

  dispose(): void {}
}
