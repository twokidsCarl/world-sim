// 从粒子状态导出的各层描述构成的阶梯，每一层都附有用来检验它的理论。
// The ladder of descriptions derived from the particle state, each with the theory it
// is checked against.

import type { QuantityDef } from '../core/quantity'
import type { MdFrame } from '../substrates/md/backend-cpu'
import { shiftedPotential } from '../substrates/md/potential'
import { profiles, structureFactor } from '../substrates/md/ref/reducers'
import { speedPdf } from '../theory/maxwell'
import { cutoffPressureCorrection2d, ljFluid2d, ljFluid2dApplies } from '../theory/ljEos'
import { virialPressure } from '../theory/virial'

/**
 * 孤立、互易体系的某条守恒律为何不适用；适用时为 null。
 * Why a conservation law of the isolated, reciprocal system does not apply, or null if it does.
 */
const nonreciprocal = (p: Record<string, number>) =>
  p.walls && p.dim !== 3
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
    id: 'distance',
    level: 'micro',
    label: '时间可逆性：离起点的最大位移（σ）',
    kind: 'scalar',
    reducers: ['distance'],
    when: (p) => p.backend === 0,
    compute: (f) => f.distance ?? NaN,
    theory: (f) => (f.clock === 0 && f.step > 0 ? 0 : null),
    theoryLabel: '倒放回到第 0 步时：应当恰好为 0',
    tolerance: { abs: 0 },
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
    theory: (f, p) => {
      const { density, temperature, dim } = f.scalars!
      // 已发表的状态方程只针对二维、单组分、完整的 12-6 势；截断半径够大时加上截断修正即可对照。
      // The published equation of state is for the 2D, one-component, full 12-6 potential;
      // with a long enough cutoff it can be compared after adding the cutoff correction.
      const published =
        dim === 2 &&
        f.spec.kind === 'mie' &&
        f.spec.n === 12 &&
        f.spec.m === 6 &&
        f.spec.rc >= 4 &&
        !p.fractionB &&
        !p.walls &&
        ljFluid2dApplies(density, temperature)
      return published
        ? ljFluid2d(density, temperature).pressure + cutoffPressureCorrection2d(f.spec, density)
        : virialPressure(f.spec, density, temperature, dim)
    },
    theoryLabel:
      '二维 12-6 势、rc ≥ 4、T ≥ 0.6、ρ ≤ 0.8 时：Homes 等 (2025) 的状态方程加截断修正；其余情况：维里展开 ρT(1 + B₂ρ)，仅低密度有效',
    tolerance: { abs: 1e-3, rel: 0.05 },
  },
  {
    id: 'densityField',
    level: 'hydro',
    label: '密度场 ρ(x, y)（三维时沿 z 累加）',
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
    when: (p) => p.fractionB! > 0 && p.dim !== 3,
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
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      return { x: pr.y, y: pr.ux }
    },
    theory: (f) => {
      const pr = profiles(f.field!, f.box, BINS)
      let mean = 0
      for (const u of pr.ux) mean += u / BINS
      // 无滑移的平面 Poiseuille 流：u(s) = 6 ū s (1 - s)。
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
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f, p) => {
      const pr = profiles(f.field!, f.box, BINS)
      let mean = 0
      for (const u of pr.ux) mean += u / BINS
      // 宽度为 W 的平面 Poiseuille 流：ū = ρ g W² / (12 η)。
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
    when: (p) => p.walls === 1 && p.dim !== 3,
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
    id: 'soundMode',
    level: 'hydro',
    label: '最长密度波的振幅 Re ρₖ / N',
    kind: 'scalar',
    record: true,
    reducers: ['modes', 'scalars'],
    when: (p) => !p.walls,
    compute: (f) => f.modes!.data[0]! / f.scalars!.n,
    theory: () => 0,
    theoryLabel: '平衡时在 0 附近涨落；点“敲一下”后按声波的频率振荡',
  },
  {
    id: 'structureFactor',
    level: 'structure',
    label: '结构因子 S(k)',
    kind: 'curve',
    mark: 'line',
    smooth: 0.05,
    xLabel: '波数 k（沿 x 与沿 y）',
    reducers: ['modes', 'scalars'],
    compute: (f) => structureFactor(f.modes!, f.scalars!.n, f.box),
    theory: (f) => {
      const sk = structureFactor(f.modes!, f.scalars!.n, f.box)
      return { x: sk.x, y: Float64Array.from(sk.x, () => 1) }
    },
    theoryLabel: '理想气体：1（参照）。晶体在倒格矢处出现尖峰',
  },
  {
    id: 'coordination',
    level: 'structure',
    label: '配位数（1.35σ 内的近邻数）',
    kind: 'scalar',
    reducers: ['scalars'],
    compute: (f) => f.scalars!.coordination,
    theory: (f) => (f.scalars!.dim === 3 ? 12 : 6),
    theoryLabel: '密堆积晶体：二维三角晶格 6，三维面心立方 12（参照）',
  },
  {
    id: 'psi6Local',
    level: 'structure',
    label: '局域六角序 ⟨|ψ₆|⟩',
    kind: 'scalar',
    reducers: ['scalars'],
    when: (p) => p.dim !== 3,
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
    when: (p) => p.dim !== 3,
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
