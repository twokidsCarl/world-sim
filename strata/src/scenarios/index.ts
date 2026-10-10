// Guided experiments as data: each step sets parameters, runs for a while, and may state
// an expectation that is checked against the measured quantity.

import type { Params } from '../core/params'

export interface Expectation {
  quantity: string
  min?: number
  max?: number
  /** Require the quantity to agree with its theory overlay instead of bounding its value. */
  agree?: boolean
  /** Judge the single latest sample instead of the average of the last ten. */
  latest?: boolean
  /** What the user should see, in words. */
  text: string
}

export interface ScenarioStep {
  text: string
  set?: Params
  /** Simulation steps (or sweeps) to run before moving on. */
  run: number
  /** Something to do on entering the step, after `set`. */
  action?: 'reverse'
  expect?: Expectation
}

export interface Scenario {
  id: string
  title: string
  substrate: string
  steps: ScenarioStep[]
}

// Thresholds for ⟨|ψ₆|⟩ sit between the two measured plateaus at this state point:
// about 0.52 in the liquid and 0.76 in the void-riddled crystal at density 0.8.
export const SCENARIOS: Scenario[] = [
  {
    id: 'freeze',
    title: '冷却液体直到结晶，再把它熔化',
    substrate: 'md',
    steps: [
      {
        text: '稠密液体接上热浴，温度 1.0。粒子挤在一起但没有固定位置，局域六角序低。',
        set: { nx: 120, density: 0.8, temperature: 1, thermostat: 1 },
        run: 3000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '液体：⟨|ψ₆|⟩ 低于 0.62' },
      },
      {
        text: '把热浴降到 0.3。规则没有变，只是能量被抽走：粒子自己排成三角晶格。',
        set: { temperature: 0.3 },
        run: 8000,
        expect: { quantity: 'psi6Local', min: 0.7, text: '晶体：⟨|ψ₆|⟩ 高于 0.7' },
      },
      {
        text: '再把热浴升到 1.2，晶体熔化，六角序消失。',
        set: { temperature: 1.2 },
        run: 5000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '回到液体：⟨|ψ₆|⟩ 低于 0.62' },
      },
    ],
  },
  {
    id: 'poiseuille',
    title: '粒子在管道里流成抛物线',
    substrate: 'md',
    steps: [
      {
        text: '上下两面热壁，中间是温度 1.0 的稠密流体。没有驱动力时，平均流速处处为零。',
        set: { walls: 1, nx: 120, density: 0.7, temperature: 1, thermostat: 0, drive: 0, fractionB: 0 },
        run: 4000,
      },
      {
        text: '给每个粒子加一个沿管道的小力。粒子之间只有两体碰撞，没有人告诉它们粘性是什么；流速剖面自己长成 Navier–Stokes 方程预言的抛物线。',
        set: { drive: 0.006 },
        run: 30000,
        expect: { quantity: 'flowProfile', agree: true, text: '流速剖面与抛物线吻合' },
      },
    ],
  },
  {
    id: 'dimension',
    title: '同一条势，换一个维度',
    substrate: 'md',
    steps: [
      {
        text: '二维的稀薄气体。速率分布是 v·exp(−v²/2T) 的形状：小速率的粒子很少，因为平面上速率为 v 的状态数正比于 v。',
        set: {
          dim: 2,
          nx: 120,
          density: 0.03,
          temperature: 2.5,
          thermostat: 0,
          walls: 0,
          fractionB: 0,
          integrator: 0,
        },
        run: 3000,
        expect: { quantity: 'speedDist', agree: true, text: '二维：速率分布与理论吻合' },
      },
      {
        text: '压强对理想气体的偏离由第二维里系数给出，它是对两体势在平面上的积分。',
        run: 1500,
        expect: { quantity: 'pressure', agree: true, text: '二维：压强与 ρT(1 + B₂ρ) 吻合' },
      },
      {
        text: '势、温度、密度都不变，只把空间换成三维。速率分布变成 v²·exp(−v²/2T)：状态数现在正比于 v²。',
        set: { dim: 3, nx: 96 },
        run: 3000,
        expect: { quantity: 'speedDist', agree: true, text: '三维：速率分布与理论吻合' },
      },
      {
        text: '同一条势的第二维里系数，在三维里是另一个数（积分的体积元变了）。',
        run: 1500,
        expect: { quantity: 'pressure', agree: true, text: '三维：压强与 ρT(1 + B₂ρ) 吻合' },
      },
      {
        text: '压密、降温：三维的密堆积是面心立方，每个粒子有 12 个近邻；二维的三角晶格只有 6 个。',
        set: { nx: 64, density: 0.95, temperature: 0.3, thermostat: 1 },
        run: 1500,
        expect: { quantity: 'coordination', min: 11.5, text: '三维晶体：配位数接近 12' },
      },
      {
        text: '加热到 2.5，晶体熔化，第一近邻壳层散开。',
        set: { temperature: 2.5 },
        run: 4000,
        expect: { quantity: 'coordination', max: 11, text: '三维液体：配位数降到 11 以下' },
      },
    ],
  },
  {
    id: 'diffusion',
    title: '让机器从粒子数据里发现扩散方程',
    substrate: 'md',
    steps: [
      {
        text: '两种粒子，相互作用完全相同，只是颜色不同。B 一开始集中在中间一条带里。右侧“元”一栏会从浓度剖面的时间序列里做稀疏回归：5 个候选项，看它留下哪几个。',
        set: {
          walls: 0,
          nx: 180,
          density: 0.6,
          temperature: 2,
          thermostat: 1,
          fractionB: 0.3,
          layoutB: 1,
          epsAB: 1,
          epsBB: 1,
          nonreciprocal: 0,
        },
        run: 16000,
      },
    ],
  },
  {
    id: 'reverse',
    title: '把时间倒过来：晶体熔化，再自己拼回去',
    substrate: 'md',
    steps: [
      {
        text: '整数坐标的积分器，从一块完美的晶格出发。温度够高，它很快熔成无序的液体：熵增加了。',
        set: {
          backend: 0,
          integrator: 1,
          nx: 30,
          density: 0.7,
          temperature: 1.2,
          thermostat: 0,
          walls: 0,
          fractionB: 0,
        },
        run: 3000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '已经熔化：⟨|ψ₆|⟩ 低于 0.62' },
      },
      {
        text: '现在把时间方向反过来。运动方程本身不分过去和未来，所以每个粒子沿原路退回，液体自己重新拼成晶格。',
        action: 'reverse',
        run: 3000,
        expect: { quantity: 'distance', max: 0, latest: true, text: '回到第 0 步：每个粒子都恰好在起点' },
      },
      {
        text: '换成普通的浮点积分器重做一遍：熔化 3000 步后倒放。',
        set: { integrator: 0 },
        run: 3000,
      },
      {
        text: '这一次回不去。舍入误差只有 10⁻¹⁶，但混沌把它每个时间单位放大好几倍。宏观上的不可逆，就藏在对初始条件的这种敏感里。',
        action: 'reverse',
        run: 3000,
        expect: { quantity: 'distance', min: 0.1, latest: true, text: '回不到起点：最大偏离超过 0.1 σ' },
      },
    ],
  },
  {
    id: 'collapse',
    title: '一团静止的天体坍缩，然后自己找到平衡',
    substrate: 'gravity',
    steps: [
      {
        text: '均匀的球，所有天体静止。没有压强撑着，整团物质向中心下落；位力比从 0 开始上升。',
        set: { initial: 0, virial0: 0, n: 12, eps: 0.03, dt: 0.002 },
        run: 700,
      },
      {
        text: '穿过中心后反弹、振荡几次。没有碰撞，也没有摩擦，但系统仍然弛豫到一个稳定的核与晕，同时把一部分天体甩了出去。留下来的那部分满足位力定理：两倍动能等于力的位力。',
        run: 2800,
        expect: { quantity: 'virial', min: 0.85, max: 1.15, text: '束缚部分的位力比回到 1 附近' },
      },
    ],
  },
  {
    id: 'quench',
    title: '把 Ising 晶格淬火穿过临界温度',
    substrate: 'ising',
    steps: [
      {
        text: '高温 T = 3.0：自旋几乎独立翻转，没有净磁化。',
        set: { L: 8, T: 3, h: 0, j2: 0 },
        run: 400,
        expect: { quantity: 'magnetisation', max: 0.1, text: '无序：|m| 低于 0.1' },
      },
      {
        text: '停在临界温度 T = 2.27：各种大小的团簇同时存在，粗粒化后的图看起来和原图一样。',
        set: { T: 2.27 },
        run: 3000,
      },
      {
        text: '降到 T = 1.8：上下对称被自发打破，畴不断长大；能量先接近精确解，磁化强度要等畴壁消失。',
        set: { T: 1.8 },
        run: 4000,
        expect: { quantity: 'energy', max: -1.8, text: '能量降到 −1.8 以下（Onsager 精确解为 −1.86）' },
      },
    ],
  },
]
