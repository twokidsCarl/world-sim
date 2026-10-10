import type { QuantityDef } from '../core/quantity'
import type { IsingFrame } from '../substrates/ising/backend'
import { onsagerEnergy, onsagerMagnetisation } from '../theory/onsager'

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
