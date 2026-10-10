// The ladder of descriptions derived from the particle state, each with the theory it
// is checked against.

import type { QuantityDef } from '../core/quantity'
import type { MdFrame } from '../substrates/md/backend-cpu'
import { shiftedPotential } from '../substrates/md/potential'
import { speedPdf } from '../theory/maxwell'
import { virialPressure } from '../theory/virial'

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
  },
]
