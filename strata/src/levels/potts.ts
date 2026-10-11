import type { QuantityDef } from '../core/quantity'
import type { PottsFrame } from '../substrates/potts/backend'
import { pottsCoexistence } from '../theory/potts'

export const POTTS_QUANTITIES: QuantityDef<PottsFrame>[] = [
  {
    id: 'energy',
    level: 'thermo',
    label: '每格点能量',
    kind: 'scalar',
    reducers: ['pyramid'],
    // 每个格点两条键，同态的键各贡献 −1。 / Two bonds per site, each like bond contributing −1.
    compute: (f) => -2 * f.levels[0]!.like,
    // 只在相变点上有严格值。q > 4 时两相共存，取与初始状态相同的那一相。
    // An exact value exists only at the transition. For q > 4 two phases coexist; take the one the run started in.
    theory: (f, p) => (p.tau === 1 ? pottsCoexistence(f.q)[p.start === 1 ? 'ordered' : 'disordered'] : null),
    theoryLabel:
      '只在相变点（T / Tc = 1）上有严格值。q ≤ 4：−(1 + 1/√q)（无限大晶格）。q > 4：有序相与无序相各有一个值，相差一份潜热（Baxter 1973）；虚线画的是与初始状态相同的那一相。',
    tolerance: { abs: 0.04 },
  },
  {
    id: 'order',
    level: 'thermo',
    label: '序参量 m = (q ρ_max − 1) / (q − 1)',
    kind: 'scalar',
    reducers: ['pyramid'],
    compute: (f) => f.levels[0]!.order,
    theoryLabel: 'ρ_max 是占比最大的那种状态的比例。各态均分时 m = 0，全在一个态时 m = 1。',
  },
  {
    id: 'fractions',
    level: 'thermo',
    label: '各状态所占的比例',
    kind: 'curve',
    mark: 'bars',
    smooth: 1,
    xLabel: '状态编号',
    reducers: ['pyramid'],
    compute: (f) => ({ x: f.fractions.map((_, k) => k), y: f.fractions }),
    theoryLabel: '规则对 q 种状态一视同仁；低温下系统自己挑出一种，对称性自发破缺。',
  },
  {
    id: 'binder',
    level: 'meta',
    label: 'Binder 累积量 U₄ = 1 − ⟨m⁴⟩ / 3⟨m²⟩²',
    kind: 'scalar',
    reducers: ['pyramid'],
    compute: (f) => f.binder,
    theoryLabel: '有序相趋于 2/3，无序相趋于 0。自参数上次改动起累计。',
  },
  {
    id: 'rgOrder',
    level: 'meta',
    label: '重整化流：各尺度的序参量',
    kind: 'curve',
    mark: 'line',
    xLabel: '粗粒化次数 k（块边长 2ᵏ）',
    reducers: ['pyramid'],
    compute: (f) => ({ x: f.levels.map((_, k) => k), y: f.levels.map((l) => l.order) }),
  },
  {
    id: 'rgLike',
    level: 'meta',
    label: '重整化流：各尺度上同态近邻的比例',
    kind: 'curve',
    mark: 'line',
    xLabel: '粗粒化次数 k（块边长 2ᵏ）',
    reducers: ['pyramid'],
    compute: (f) => ({ x: f.levels.map((_, k) => k), y: f.levels.map((l) => l.like) }),
  },
]
