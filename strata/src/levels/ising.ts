import type { QuantityDef } from '../core/quantity'
import type { IsingFrame } from '../substrates/ising/backend'
import { BINDER_CRITICAL, onsagerEnergy, onsagerMagnetisation } from '../theory/onsager'

/** The exact solution applies only to the nearest-neighbour model in zero field. */
const exact = (p: Record<string, number>) => p.j2 === 0 && p.h === 0

export const ISING_QUANTITIES: QuantityDef<IsingFrame>[] = [
  {
    id: 'magnetisation',
    level: 'thermo',
    label: '磁化强度 |m|',
    kind: 'scalar',
    reducers: ['pyramid'],
    compute: (f) => Math.abs(f.levels[0]!.m),
    theory: (f, p) => (exact(p) ? onsagerMagnetisation(f.T) : null),
    theoryLabel: 'Onsager–Yang 精确解（无限大晶格，J₂=0，h=0）',
    tolerance: { abs: 0.03 },
  },
  {
    id: 'energy',
    level: 'thermo',
    label: '每自旋能量',
    kind: 'scalar',
    reducers: ['pyramid'],
    compute: (f, p) => -(2 * f.levels[0]!.nn + 2 * p.j2! * f.levels[0]!.nnn + p.h! * f.levels[0]!.m),
    theory: (f, p) => (exact(p) ? onsagerEnergy(f.T) : null),
    theoryLabel: 'Onsager 精确解（J₂=0，h=0）',
    tolerance: { abs: 0.02 },
  },
  {
    id: 'binder',
    level: 'meta',
    label: 'Binder 累积量 U₄ = 1 − ⟨m⁴⟩ / 3⟨m²⟩²',
    kind: 'scalar',
    reducers: ['pyramid'],
    compute: (f) => f.binder,
    theory: (_f, p) => (exact(p) ? BINDER_CRITICAL : null),
    theoryLabel:
      '临界点上的值 0.6107（各向同性方格、周期边界）。有序相趋于 2/3，无序相趋于 0；只有在 Tc，它才与晶格大小无关。自参数上次改动起累计。',
  },
  {
    id: 'rgMagnetisation',
    level: 'meta',
    label: '重整化流：各尺度的 |m|',
    kind: 'curve',
    mark: 'line',
    xLabel: '粗粒化次数 k（块边长 2ᵏ）',
    reducers: ['pyramid'],
    compute: (f) => ({ x: f.levels.map((_, k) => k), y: f.levels.map((l) => Math.abs(l.m)) }),
  },
  {
    id: 'rgCorrelation',
    level: 'meta',
    label: '重整化流：各尺度的近邻关联',
    kind: 'curve',
    mark: 'line',
    xLabel: '粗粒化次数 k（块边长 2ᵏ）',
    reducers: ['pyramid'],
    compute: (f) => ({ x: f.levels.map((_, k) => k), y: f.levels.map((l) => l.nn) }),
  },
]
