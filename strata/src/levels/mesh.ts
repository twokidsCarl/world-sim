import type { QuantityDef } from '../core/quantity'
import type { MeshFrame } from '../substrates/mesh/backend'
import { JEANS_RATE, meshForceFactor, zeldovichMode } from '../theory/jeans'

const rate = (p: Record<string, number>) => JEANS_RATE * Math.sqrt(p.G!)

export const MESH_QUANTITIES: QuantityDef<MeshFrame>[] = [
  {
    id: 'momentum',
    level: 'micro',
    label: '动量守恒：总动量',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.momentum,
    theory: () => 0,
    theoryLabel: '守恒律：0。分配和插值用同一组权重，粒子对之间作用力等于反作用力。',
    tolerance: { abs: 1e-4 },
  },
  {
    id: 'drift',
    level: 'micro',
    label: '能量：相对变化 ΔE / (K + |W|)',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.drift,
    theory: () => 0,
    theoryLabel:
      '参照：0。从纯增长模出发时动能恰好等于势能的大小，总能量 K + W = 0，之后一直如此。网格上的力不是某个势的严格梯度，能量只是近似守恒；团块缩到两三个格距以下时偏差变大。',
    tolerance: { abs: 0.05 },
  },
  {
    id: 'mode',
    level: 'hydro',
    label: '沿 x 的基频密度模的幅度',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.mode,
    theory: (f, p) => {
      if (p.initial !== 0) return null
      const z = zeldovichMode(p.amplitude!, rate(p) * Math.sqrt(meshForceFactor(1, f.M)), f.time)
      return z.crossed ? null : z.amplitude
    },
    theoryLabel:
      '只对“一个平面波”画：Zel’dovich 严格解 2 J₁(A₀ e^{γt})，γ = √(4πG)（乘上网格对这个波长的力的折扣，64 格时为 0.998）。到壳层交叉（A₀ e^{γt} = 1）为止；之后粒子流互相穿过，没有解析解。',
    tolerance: { rel: 0.05 },
  },
  {
    id: 'sigma',
    level: 'hydro',
    label: '网格上密度涨落的均方根 σ',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.sigma,
    theory: (f, p) => {
      const linear = f.sigma0 * Math.exp(rate(p) * (f.time - f.time0))
      // 线性理论只在涨落还小的时候成立。 / Linear theory holds only while the fluctuations are small.
      return p.initial === 1 && linear < 0.3 ? linear : null
    },
    theoryLabel: '只对“随机场”画：线性理论 σ ∝ e^{γt}，γ = √(4πG)，与波长无关。σ 超过 0.3 之后不再是线性的，虚线停止。',
    tolerance: { rel: 0.15 },
  },
  {
    id: 'peak',
    level: 'structure',
    label: '最高密度 / 平均密度',
    kind: 'scalar',
    reducers: [],
    compute: (f) => f.peak,
    theoryLabel: '均匀时为 1。平面波在壳层交叉处出现一张薄片；随机场先长出薄片和丝，再在交汇处长出团块。数值受网格分辨率限制。',
  },
]
