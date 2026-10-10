import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import { speciesField, speciesTables, type PairField, type PotentialSpec } from './potential'
import { initTriangular } from './ref/init'
import { fieldSums, rdf, scalars, speedHistogram, type FieldSums, type Hist, type MdScalars } from './ref/reducers'
import { reverseTime, stepReversible, toReversible, type ReversibleState } from './ref/reversible'
import { computeForces, kineticEnergy, step, temperature, type MdState } from './ref/step'
import { boxAspect, fieldKey, potentialSpec, strengthMatrix } from './schema'

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
  field?: FieldSums
  /** Steps since the start, counted backwards while time is reversed. */
  clock?: number
  /** Largest displacement of any particle from where it started, in σ. CPU backend only. */
  distance?: number
  /** Box lengths, for turning cell sums into densities. */
  box: ArrayLike<number>
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
  private pair: PairField
  private key: string
  private p: Params
  private time = 0
  private heat = 0
  private e0 = 0
  private reversible: ReversibleState | null = null
  private start: Float64Array
  private direction = 1
  private clock = 0

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    this.spec = potentialSpec(p)
    this.key = fieldKey(p)
    this.pair = speciesField(speciesTables(this.spec, strengthMatrix(p)))
    this.state = initTriangular(
      {
        nx: Math.min(p.nx, CPU_MAX_NX),
        density: p.density,
        temperature: p.temperature,
        seed,
        fractionB: p.fractionB,
        aspect: boxAspect(p),
        stripe: p.layoutB === 1,
      },
      this.pair,
    )
    this.state.walls = p.walls === 1
    this.state.seed = seed
    this.applyDrive()
    // Forces were computed before the walls were switched on.
    if (this.state.walls) computeForces(this.state, this.pair)
    if (p.integrator === 1 && !p.walls) this.reversible = toReversible(this.state, this.pair, p.dt)
    this.start = this.state.pos.slice()
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

  private applyDrive(): void {
    this.state.drive = this.p.walls ? this.p.drive : 0
    this.state.wallTemperature = this.p.temperature
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
    if (fieldKey(p) !== this.key) {
      this.key = fieldKey(p)
      this.spec = potentialSpec(p)
      this.pair = speciesField(speciesTables(this.spec, strengthMatrix(p)))
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
    this.applyDrive()
  }

  /** Reverse time: exactly with the integer integrator, by negating velocities otherwise. */
  reverse(): void {
    if (this.reversible) reverseTime(this.reversible, this.pair, this.p.dt)
    else for (let k = 0; k < this.state.vel.length; k++) this.state.vel[k] *= -1
    this.direction *= -1
  }

  /** Largest minimum-image displacement of any particle from its starting position. */
  private distance(): number {
    const { pos, box, dim, walls } = this.state
    let worst = 0
    for (let k = 0; k < pos.length; k++) {
      let d = pos[k] - this.start[k]
      if (!(walls && k % dim === 1)) d -= box[k % dim] * Math.round(d / box[k % dim])
      worst = Math.max(worst, Math.abs(d))
    }
    return worst
  }

  step(n: number): void {
    const { dt, thermostat, temperature: target } = this.p
    this.clock += n * this.direction
    if (this.reversible) {
      stepReversible(this.reversible, this.pair, dt, n)
      this.time += n * dt
      return
    }
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
      box: s.box,
      clock: this.clock,
      drift: (this.energy() - this.heat - this.e0) / s.n,
    }
    const sc = scalars(s)
    if (ids.includes('scalars')) frame.scalars = sc
    if (ids.includes('speedHist')) frame.speedHist = speedHistogram(s, 40, 4 * Math.sqrt(sc.temperature))
    if (ids.includes('rdf')) frame.rdf = rdf(s, 120, 4)
    if (ids.includes('field')) frame.field = fieldSums(s)
    if (ids.includes('distance')) frame.distance = this.distance()
    return frame
  }

  dispose(): void {}
}
