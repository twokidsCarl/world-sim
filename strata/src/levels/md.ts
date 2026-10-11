// 从粒子状态导出的各层描述构成的阶梯，每一层都附有用来检验它的理论。
// The ladder of descriptions derived from the particle state, each with the theory it
// is checked against.

import type { QuantityDef } from '../core/quantity'
import type { MdFrame } from '../substrates/md/backend-cpu'
import { shiftedPotential } from '../substrates/md/potential'
import { runningIntegral } from '../analysis/autocorrelation'
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

/**
 * 紧贴圆盘背风面的一小块区域里的平均 uₓ：沿流向从圆心后 1.15 到 1.9 个半径，横向 ±0.35 个半径。
 * 回流涡就在这里；再往下游或再宽一些，平均值就被尾迹外的正向流动盖过了。
 * 障碍物在上游四分之一处的正中。
 *
 * Mean uₓ in a small box hugging the lee side of the disc: from 1.15 to 1.9 radii behind
 * its centre along the flow, and ±0.35 radii across. The recirculating eddies sit here;
 * further downstream or wider, the average is swamped by the forward flow outside the wake.
 * The obstacle sits mid-height, a quarter of the way along the channel.
 */
function wakeVelocity(f: MdFrame, radius: number): number {
  return boxMean(f, radius, [1.15, 1.9], 0.35, 'vx')
}

/**
 * 圆盘下游一个矩形里的平均流速分量。矩形沿流向从圆心后 along[0] 到 along[1] 个半径，
 * 横向 ± across 个半径。
 * Mean of one velocity component in a rectangle downstream of the disc, running from
 * along[0] to along[1] radii behind its centre and ± across radii to either side.
 */
function boxMean(f: MdFrame, radius: number, along: [number, number], across: number, component: 'vx' | 'vy'): number {
  const { gx, gy, count } = f.field!
  const v = f.field![component]
  const [lx, ly] = [f.box[0]!, f.box[1]!]
  let n = 0
  let sum = 0
  for (let cy = 0; cy < gy; cy++) {
    const y = ((cy + 0.5) / gy) * ly - 0.5 * ly
    if (Math.abs(y) > across * radius) continue
    for (let cx = 0; cx < gx; cx++) {
      const x = ((cx + 0.5) / gx) * lx - 0.25 * lx
      if (x < along[0] * radius || x > along[1] * radius) continue
      n += count[cy * gx + cx]!
      sum += v[cy * gx + cx]!
    }
  }
  return n > 0 ? sum / n : NaN
}

/**
 * 由累计的切应力自相关算粘度的累积积分 η(τ) = (V/T) ∫₀^τ C(t) dt。
 * 累计的步数还不到最长时间差的四倍时返回空曲线。
 * The running integral of the viscosity, η(τ) = (V/T) ∫₀^τ C(t) dt, from the accumulated
 * shear-stress autocorrelation. Returns an empty curve until at least four times the
 * longest lag has been accumulated.
 */
function greenKubo(f: MdFrame): { x: Float64Array; y: Float64Array } {
  const t = f.transport
  if (!t || t.samples < 4 * t.acf.length) return { x: new Float64Array(0), y: new Float64Array(0) }
  const integral = runningIntegral(t.acf, t.dt)
  // 每 5 步取一个点，够画曲线了。 / Every fifth lag is enough for the plot.
  const every = 5
  const count = Math.floor((t.acf.length - 1) / every) + 1
  return {
    x: Float64Array.from({ length: count }, (_, k) => k * every * t.dt),
    y: Float64Array.from({ length: count }, (_, k) => (t.volume / t.temperature) * integral[k * every]!),
  }
}

/**
 * 由分箱的平均速度用中心差分得到涡量；x 方向周期，y 方向在壁面处用单侧差分。
 * Vorticity from the binned mean velocity by central differences; periodic along x,
 * one-sided at the walls along y.
 */
function vorticity(f: MdFrame): { nx: number; ny: number; data: Float64Array; aspect: number; signed: boolean } {
  const { gx, gy, count, vx, vy } = f.field!
  const dx = f.box[0]! / gx
  const dy = f.box[1]! / gy
  const u = (cx: number, cy: number, v: Float64Array) => {
    const c = cy * gx + ((cx + gx) % gx)
    return count[c]! > 0 ? v[c]! / count[c]! : 0
  }
  const data = new Float64Array(gx * gy)
  for (let cy = 0; cy < gy; cy++) {
    const up = Math.max(cy - 1, 0)
    const down = Math.min(cy + 1, gy - 1)
    for (let cx = 0; cx < gx; cx++) {
      data[cy * gx + cx] =
        (u(cx + 1, cy, vy) - u(cx - 1, cy, vy)) / (2 * dx) - (u(cx, down, vx) - u(cx, up, vx)) / ((down - up) * dy)
    }
  }
  return { nx: gx, ny: gy, data, aspect: f.box[0]! / f.box[1]!, signed: true }
}

/**
 * 对流的度量：取高度居中的三分之一，把 x 方向分成 16 段，各段的平均竖直流速的均方根。
 * 同时给出没有对流时仅由热运动造成的期望值 √(T / 每段粒子数)。
 * A measure of convection: in the middle third of the height, split x into 16 segments
 * and take the root mean square of each segment's mean vertical velocity. Also returns
 * what thermal motion alone would give without convection, √(T / particles per segment).
 */
function convection(f: MdFrame): { rms: number; noise: number } {
  const { gx, gy, count, vy, v2 } = f.field!
  const segments = 16
  const per = gx / segments
  let rms = 0
  let n = 0
  let energy = 0
  for (let seg = 0; seg < segments; seg++) {
    let m = 0
    let py = 0
    for (let cy = Math.floor(gy / 3); cy < Math.ceil((2 * gy) / 3); cy++) {
      for (let cx = seg * per; cx < (seg + 1) * per; cx++) {
        m += count[cy * gx + cx]!
        py += vy[cy * gx + cx]!
        energy += v2[cy * gx + cx]!
      }
    }
    n += m
    rms += m > 0 ? (py / m) ** 2 / segments : 0
  }
  // 二维下每个速度分量的方差是 T ≈ ⟨v²⟩ / 2。 / In 2D each velocity component has variance T ≈ ⟨v²⟩ / 2.
  const T = n > 0 ? energy / (2 * n) : 0
  return { rms: Math.sqrt(rms), noise: n > 0 ? Math.sqrt(T / (n / segments)) : 0 }
}

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
    id: 'msd',
    level: 'kinetic',
    label: '均方位移 ⟨Δr²⟩',
    kind: 'scalar',
    record: true,
    reducers: ['transport'],
    when: (p) => p.backend === 0 && !p.walls && p.integrator !== 1,
    compute: (f) => f.transport?.msd ?? NaN,
  },
  {
    id: 'speedDist',
    level: 'kinetic',
    label: '速率分布',
    kind: 'curve',
    xLabel: '速率 v',
    reducers: ['scalars', 'speedHist'],
    compute: (f) => f.speedHist!,
    regional: (f) => f.region?.speedHist ?? null,
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
    hoverRadius: true,
    regional: (f) => f.region?.rdf ?? null,
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
    regional: (f) => f.region?.temperature ?? null,
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
      const { gx, gy, count } = f.field!
      const cell = (f.box[0]! * f.box[1]!) / (gx * gy)
      return { nx: gx, ny: gy, data: Float64Array.from(count, (c) => c / cell), aspect: f.box[0]! / f.box[1]! }
    },
  },
  {
    id: 'flowField',
    level: 'hydro',
    label: '沿管道的流速场 uₓ(x, y)',
    kind: 'field',
    smooth: 0.02,
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f) => {
      const { gx, gy, count, vx } = f.field!
      return { nx: gx, ny: gy, data: Float64Array.from(vx, (v, c) => (count[c]! > 0 ? v / count[c]! : 0)), aspect: f.box[0]! / f.box[1]!, signed: true }
    },
  },
  {
    id: 'crossField',
    level: 'hydro',
    label: '横向流速场 u_y(x, y)',
    kind: 'field',
    smooth: 0.02,
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f) => {
      const { gx, gy, count, vy } = f.field!
      return { nx: gx, ny: gy, data: Float64Array.from(vy, (v, c) => (count[c]! > 0 ? v / count[c]! : 0)), aspect: f.box[0]! / f.box[1]!, signed: true }
    },
  },
  {
    id: 'gkViscosity',
    level: 'hydro',
    label: 'Green–Kubo：粘度的累积积分 η(τ)',
    kind: 'curve',
    mark: 'line',
    smooth: 1,
    xLabel: '积分上限 τ',
    reducers: ['transport'],
    when: (p) => p.backend === 0 && !p.walls && p.integrator !== 1,
    compute: (f) => greenKubo(f),
    theoryLabel:
      'η(τ) = (V/T) ∫₀^τ ⟨σ_xy(0) σ_xy(t)⟩ dt，由平衡态下切应力的自发涨落算出，不需要让流体流动。自参数上次改动起累计，收敛很慢：60 个时间单位的记录给出的值可以相差一倍，要上千个时间单位才稳定到一两成。二维里这个积分还会随 τ 缓慢地对数增长，不会停在一个平台上。只有 CPU 后端提供。',
  },
  {
    id: 'vorticity',
    level: 'hydro',
    label: '涡量场 ω = ∂u_y/∂x − ∂uₓ/∂y',
    kind: 'field',
    smooth: 0.02,
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f) => vorticity(f),
  },
  {
    id: 'wakeVelocity',
    level: 'hydro',
    label: '圆盘背风面的流速（瞬时值，噪声大）',
    kind: 'scalar',
    record: true,
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.obstacle! > 0 && p.dim !== 3,
    compute: (f, p) => wakeVelocity(f, p.obstacle!),
    theory: () => 0,
    theoryLabel: '0：时间平均后低于它，说明圆盘后面有回流；见下面的分析卡片',
  },
  {
    id: 'wakeProbe',
    level: 'hydro',
    label: '尾迹里一个探测区的横向流速（瞬时值）',
    kind: 'scalar',
    record: true,
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.obstacle! > 0 && p.dim !== 3,
    compute: (f, p) => boxMean(f, p.obstacle!, [2.5, 3.5], 0.5, 'vy'),
    theory: () => 0,
    theoryLabel: '0：定常的尾迹里它只在 0 附近涨落；周期性脱落时它来回摆动',
  },
  {
    id: 'meanFlow',
    level: 'hydro',
    label: '管道里的平均流速',
    kind: 'scalar',
    reducers: ['field'],
    when: (p) => p.walls === 1 && p.dim !== 3,
    compute: (f) => {
      const { count, vx } = f.field!
      let n = 0
      let sum = 0
      for (let c = 0; c < count.length; c++) {
        n += count[c]!
        sum += vx[c]!
      }
      return n > 0 ? sum / n : NaN
    },
  },
  {
    id: 'convection',
    level: 'hydro',
    label: '对流强度：中间一层竖直流速沿 x 的起伏',
    kind: 'scalar',
    reducers: ['field', 'scalars'],
    when: (p) => p.walls === 1 && p.gravity! > 0 && p.dim !== 3,
    compute: (f) => convection(f).rms,
    theory: (f) => convection(f).noise,
    theoryLabel: '没有对流时的热噪声水平（由粒子数与温度估计）；明显高出它才是对流',
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
    when: (p) => p.walls === 1 && p.drive! > 0 && p.dim !== 3,
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
    // 反推公式只对没有障碍物的管道流成立。 / The formula holds only for channel flow without an obstacle.
    when: (p) => p.walls === 1 && p.drive! > 0 && !p.obstacle && p.dim !== 3,
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
      // 两壁温度不同时没有一条简单的参照线。 / With walls at different temperatures there is no simple reference line.
      if (p.deltaT) return null
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
    id: 'lowK',
    level: 'structure',
    label: '最长波处的结构因子（瞬时值，噪声大）',
    kind: 'scalar',
    record: true,
    reducers: ['modes', 'scalars'],
    when: (p) => !p.walls,
    // 沿 x 最长的那个波：单个模的 |ρ_k|²/N 服从指数分布，要靠时间平均。
    // The longest wave along x: |ρ_k|²/N of a single mode is exponentially distributed, so it needs time averaging.
    compute: (f) => (f.modes!.data[0]! ** 2 + f.modes!.data[1]! ** 2) / f.scalars!.n,
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
    regional: (f) => f.region?.coordination ?? null,
    theory: (f) => (f.scalars!.dim === 3 ? 12 : 6),
    theoryLabel: '密堆积晶体：二维三角晶格 6，三维面心立方 12（参照）',
  },
  {
    id: 'q6Averaged',
    level: 'structure',
    label: '近邻平均的键取向序 ⟨q̄₆⟩',
    kind: 'scalar',
    reducers: ['q6'],
    when: (p) => p.dim === 3,
    compute: (f) => f.q6?.averaged ?? NaN,
    theory: () => 0.5745,
    theoryLabel: '完美面心立方晶体：0.575（参照）；液体约 0.15 到 0.2',
  },
  {
    id: 'crystalFraction',
    level: 'structure',
    label: '处在晶体环境里的粒子比例（q̄₆ > 0.3）',
    kind: 'scalar',
    reducers: ['q6'],
    when: (p) => p.dim === 3,
    compute: (f) => f.q6?.crystalFraction ?? NaN,
  },
  {
    id: 'psi6Local',
    level: 'structure',
    label: '局域六角序 ⟨|ψ₆|⟩',
    kind: 'scalar',
    reducers: ['scalars'],
    when: (p) => p.dim !== 3,
    compute: (f) => f.scalars!.psi6Local,
    regional: (f) => f.region?.psi6Local ?? null,
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
