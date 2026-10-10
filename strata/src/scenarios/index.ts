// Guided experiments as data: each step sets parameters, runs for a while, and may state
// an expectation that is checked against the measured quantity.

import type { Params } from '../core/params'

export interface Expectation {
  quantity: string
  min?: number
  max?: number
  /** Require the quantity to agree with its theory overlay instead of bounding its value. */
  agree?: boolean
  /** What the user should see, in words. */
  text: string
}

export interface ScenarioStep {
  text: string
  set?: Params
  /** Simulation steps (or sweeps) to run before moving on. */
  run: number
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
