import type { QuantityDef } from '../core/quantity'
import { RADIAL_BINS, RADIAL_MAX, type GravityFrame } from '../substrates/gravity/backend'
import { PLUMMER_HALF_MASS, plummerDensity } from '../theory/plummer'

const shellWidth = RADIAL_MAX / RADIAL_BINS
const shellCentre = (b: number) => (b + 0.5) * shellWidth
const shellVolume = (b: number) => (4 / 3) * Math.PI * (((b + 1) * shellWidth) ** 3 - (b * shellWidth) ** 3)

export const GRAVITY_QUANTITIES: QuantityDef<GravityFrame>[] = [
  {
    id: 'drift',
    level: 'micro',
    label: '能量守恒：相对漂移',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.drift,
    theory: () => 0,
    theoryLabel: '守恒律：0',
    tolerance: { abs: 0.02 },
  },
  {
    id: 'momentum',
    level: 'micro',
    label: '动量守恒：总动量',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.momentum,
    theory: () => 0,
    theoryLabel: '守恒律：0',
    tolerance: { abs: 1e-4 },
  },
  {
    id: 'virial',
    level: 'thermo',
    label: '束缚部分的位力比 2K / |Σ m x·a|',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.virialBound,
    theory: () => 1,
    theoryLabel: '位力定理：弛豫后的束缚系统为 1，对软化后的引力同样成立',
    tolerance: { abs: 0.1 },
  },
  {
    id: 'virialAll',
    level: 'thermo',
    label: '全体的 2K / |U|',
    kind: 'scalar',
    reducers: [],
    compute: (f) => (2 * f.ke) / Math.abs(f.pe),
    theory: () => 1,
    theoryLabel: '参照：1。有天体逃逸时偏高；软化明显时 |U| 也不等于力的位力',
  },
  {
    id: 'boundFraction',
    level: 'structure',
    label: '仍被束缚的天体比例',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.boundFraction,
  },
  {
    id: 'density',
    level: 'structure',
    label: '径向质量密度 ρ(r)',
    kind: 'curve',
    mark: 'line',
    xLabel: '到团块中心的距离 r',
    reducers: [],
    compute: (f) => ({
      x: Float64Array.from({ length: RADIAL_BINS }, (_, b) => shellCentre(b)),
      y: Float64Array.from(f.radial, (count, b) => count / f.n / shellVolume(b)),
    }),
    theory: (_f, p) =>
      p.initial === 1
        ? {
            x: Float64Array.from({ length: RADIAL_BINS }, (_, b) => shellCentre(b)),
            y: Float64Array.from({ length: RADIAL_BINS }, (_, b) => plummerDensity(shellCentre(b))),
          }
        : null,
    theoryLabel: 'Plummer 模型（仅对 Plummer 初始状态）',
    tolerance: { rel: 0.25 },
  },
  {
    id: 'halfMass',
    level: 'structure',
    label: '半质量半径',
    kind: 'scalar',
    reducers: [],
    compute: (f) => {
      // Interpolate within the shell where the cumulative count crosses half.
      let inside = 0
      for (let b = 0; b < RADIAL_BINS; b++) {
        if (inside + f.radial[b]! >= f.n / 2) return (b + (f.n / 2 - inside) / f.radial[b]!) * shellWidth
        inside += f.radial[b]!
      }
      return NaN
    },
    theory: (_f, p) => (p.initial === 1 ? PLUMMER_HALF_MASS : null),
    theoryLabel: 'Plummer 模型：1.305（仅对 Plummer 初始状态）',
    tolerance: { rel: 0.1 },
  },
]
