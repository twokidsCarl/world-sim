// The ladder of descriptions derived from the particle state, each with the theory it
// is checked against.

import type { QuantityDef } from '../core/quantity'
import type { MdFrame } from '../substrates/md/backend-cpu'
import { shiftedPotential } from '../substrates/md/potential'
import { profiles } from '../substrates/md/ref/reducers'
import { speedPdf } from '../theory/maxwell'
import { virialPressure } from '../theory/virial'

/** Why a conservation law of the isolated, reciprocal system does not apply, or null if it does. */
const nonreciprocal = (p: Record<string, number>) =>
  p.walls
    ? '有壁面换热和外力做功：系统是开放的，这条守恒律不适用'
    : p.fractionB! > 0 && p.nonreciprocal! > 0
      ? '作用力不再等于反作用力：这条守恒律已失效'
      : null

const BINS = 24

export const MD_QUANTITIES: QuantityDef<MdFrame>[] = [
  {
    id: 'drift',
    level: 'micro',
    label: '能量守恒：每粒子漂移（ε）',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.drift,
    theory: () => 0,
    theoryLabel: '守恒律：0',
    tolerance: { abs: 5e-3 },
    voided: nonreciprocal,
  },
  {
    id: 'momentum',
    level: 'micro',
    label: '动量守恒：每粒子 |P|',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.momentum,
    theory: () => 0,
    theoryLabel: '守恒律：0',
    tolerance: { abs: 1e-5 },
    voided: nonreciprocal,
  },
  {
    id: 'speedDist',
    level: 'kinetic',
    label: '速率分布',
    kind: 'curve',
    xLabel: '速率 v',
    reducers: ['scalars', 'speedHist'],
    compute: (f) => f.speedHist!,
    theory: (f) => {
      const { x } = f.speedHist!
      const { dim, temperature } = f.scalars!
      return { x, y: Float64Array.from(x, (v) => speedPdf(dim, temperature, v)) }
    },
    theoryLabel: '麦克斯韦–玻尔兹曼分布（取实测温度）',
    tolerance: { rel: 0.08 },
  },
  {
    id: 'rdf',
    level: 'kinetic',
    label: '径向分布函数 g(r)',
    kind: 'curve',
    xLabel: '距离 r',
    reducers: ['scalars', 'rdf'],
    compute: (f) => f.rdf!,
    theory: (f) => {
      const { x } = f.rdf!
      const T = f.scalars!.temperature
      return { x, y: Float64Array.from(x, (r) => Math.exp(-shiftedPotential(f.spec, r).u / T)) }
    },
    theoryLabel: '低密度极限 exp(−u(r)/T)',
    tolerance: { rel: 0.1 },
  },
  {
    id: 'temperature',
    level: 'thermo',
    label: '温度 T',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.temperature,
    theory: (_f, p) => (p.thermostat ? p.temperature : null),
    theoryLabel: '热浴温度',
    tolerance: { abs: 0.02, rel: 0.03 },
  },
  {
    id: 'pressure',
    level: 'thermo',
    label: '压强 P',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.pressure,
    theory: (f) => virialPressure(f.spec, f.scalars!.density, f.scalars!.temperature, f.scalars!.dim),
    theoryLabel: '维里展开 ρT(1 + B₂ρ)，仅低密度有效',
    tolerance: { abs: 1e-3, rel: 0.05 },
  },
  {
    id: 'densityField',
    level: 'hydro',
    label: '密度场 ρ(x, y)',
    kind: 'field',
    reducers: ['field'],
    compute: (f) => {
      const { g, count } = f.field!
      const cell = (f.box[0]! * f.box[1]!) / (g * g)
      return { nx: g, ny: g, data: Float64Array.from(count, (c) => c / cell), aspect: f.box[0]! / f.box[1]! }
    },
  },
  {
    id: 'concentration',
    level: 'hydro',
    label: 'B 的浓度剖面 c(y)',
    kind: 'curve',
    mark: 'line',
    smooth: 1,
    record: true,
    xLabel: '横向位置 y / σ',
    reducers: ['field'],
    when: (p) => p.fractionB! > 0,
    compute: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      return { x: Float64Array.from(pr.y, (s) => s * f.box[1]!), y: pr.fractionB }
    },
  },
  {
    id: 'flowProfile',
    level: 'hydro',
    label: '流速剖面 uₓ(y)',
    kind: 'curve',
    mark: 'line',
    smooth: 0.03,
    xLabel: '横向位置 y / 管宽',
    reducers: ['field'],
    when: (p) => p.walls === 1,
    compute: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      return { x: pr.y, y: pr.ux }
    },
    theory: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      let mean = 0
      for (const u of pr.ux) mean += u / BINS
      // Plane Poiseuille flow with no slip: u(s) = 6 ū s (1 - s).
      return { x: pr.y, y: Float64Array.from(pr.y, (s) => 6 * mean * s * (1 - s)) }
    },
    theoryLabel: 'Navier–Stokes 无滑移解：抛物线（幅度取实测平均流速，只检验形状）',
    tolerance: { rel: 0.12 },
  },
  {
    id: 'viscosity',
    level: 'hydro',
    label: '粘度 η（由流量反推）',
    kind: 'scalar',
    reducers: ['field', 'scalars'],
    when: (p) => p.walls === 1,
    compute: (f, p) => {
      const pr = profiles(f.field!, f.box, BINS)
      let mean = 0
      for (const u of pr.ux) mean += u / BINS
      // ū = ρ g W² / (12 η) for plane Poiseuille flow of width W.
      return mean > 0 ? (f.scalars!.density * p.drive! * f.box[1]! * f.box[1]!) / (12 * mean) : NaN
    },
  },
  {
    id: 'temperatureProfile',
    level: 'hydro',
    label: '温度剖面 T(y)',
    kind: 'curve',
    mark: 'line',
    smooth: 0.03,
    xLabel: '横向位置 y / 管宽',
    reducers: ['field'],
    when: (p) => p.walls === 1,
    compute: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      return { x: pr.y, y: pr.temperature }
    },
    theory: (f, p) => {
      const pr = profiles(f.field!, f.box, BINS)
      return { x: pr.y, y: Float64Array.from(pr.y, () => p.temperature!) }
    },
    theoryLabel: '壁面温度（参照）：粘性生热使管道中央更热',
  },
  {
    id: 'psi6Local',
    level: 'structure',
    label: '局域六角序 ⟨|ψ₆|⟩',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.psi6Local,
    theory: () => 1,
    theoryLabel: '完美三角晶格：1（参照，不是预言）',
  },
  {
    id: 'psi6Global',
    level: 'structure',
    label: '全局六角序 |⟨ψ₆⟩|',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.psi6Global,
    theory: () => 1,
    theoryLabel: '单一取向的完美晶体：1（参照）；多晶或液体趋于 0',
  },
  {
    id: 'demix',
    level: 'structure',
    label: '分相程度',
    kind: 'scalar',
    reducers: ['scalars'],
    when: (p) => p.fractionB! > 0,
    compute: (f) => f.scalars!.demix,
    theory: () => 0,
    theoryLabel: '随机混合：0（参照）；两种粒子完全分开时趋于 1',
  },
]
