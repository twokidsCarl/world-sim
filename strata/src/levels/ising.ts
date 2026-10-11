import { effectiveInformation } from '../analysis/ei'
import type { QuantityDef } from '../core/quantity'
import type { IsingFrame } from '../substrates/ising/backend'
import { BINDER_CRITICAL, onsagerEnergy, onsagerMagnetisation } from '../theory/onsager'

/**
 * 严格解只适用于零外场下的最近邻模型。
 * The exact solution applies only to the nearest-neighbour model in zero field.
 */
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
    id: 'effectiveInformation',
    level: 'meta',
    label: '有效信息随尺度的变化（实验性）',
    kind: 'curve',
    mark: 'line',
    // 后端已对计数做了累计，这里不再做滑动平均。 / The backend accumulates the counts, so no running average here.
    smooth: 1,
    xLabel: '粗粒化次数 k（块边长 2ᵏ）',
    reducers: ['pyramid', 'transitions'],
    compute: (f) => ({
      x: f.transitions!.map((_, k) => k),
      y: f.transitions!.map((counts) => effectiveInformation(counts, 10)),
    }),
    theoryLabel:
      '单位：比特，上限 log₂10 ≈ 3.32。每一层把格点的局部状态取为（自旋，四邻之和）共 10 种，统计一次扫描前后的转移。计数自参数上次改动起累计；刚改完参数时最粗的几层样本太少，估计偏高，要等它收敛。结果依赖状态的这种取法，没有理论值可对照。',
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
